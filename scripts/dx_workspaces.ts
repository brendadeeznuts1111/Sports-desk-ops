#!/usr/bin/env bun
/**
 * @file scripts/dx_workspaces.ts
 * @description Monorepo Workspace Dev Control CLI (`./bin/dx workspaces` / `bun run workspaces`).
 *
 * Implements Bun's monorepo workspace workflows (https://bun.com/docs/pm/workspaces) on top of
 * the repository's frozen-lockfile + isolated-linker policy (`lib/pm_policy.ts`):
 *   - `list` (`ls`)       — inspect root + `packages/*` workspaces, topological waves & isolated links
 *   - `graph`             — visualize `"workspace:*"` dependency edges (`--mermaid` | `--dot` | `--json` | `--yaml`)
 *   - `audit` (`check`)   — run 7 monorepo gates (`"private": true`, globs/dirs, lock sync, `"workspace:*"` graph,
 *                           `Bun.Transpiler` self-contained imports, isolated `node_modules` links, `--strict-root`)
 *   - `run <script>`      — controlled multi-workspace runner (`--filter`, `--workspaces-only`, `--topological`,
 *                           `--parallel` | `--sequential`, `--if-present`, `--elide-lines`, `--dry-run`)
 *   - `add <ws> <pkg...>` — workspace-scoped dependency add (auto-normalizes sibling workspaces to `"workspace:*"`
 *                           and runs unfrozen `bun-deps` in that workspace's `cwd` + lock drift verification)
 *   - `remove <ws> <pkg>` — workspace-scoped dependency removal + lock drift verification
 *   - `link <from> <to>`  — wire `"<to>": "workspace:*"` into `<from>/package.json` (cycle-safe) + root install
 *   - `init <name>`       — scaffold a new self-contained workspace under `packages/<slug>` + lock refresh
 */

import { YAML } from "bun";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { inspectReport } from "../lib/cli_inspect.ts";
import {
  analyzeWorkspaceGraph,
  auditRootWorkspaceHygiene,
  auditWorkspaceSelfContainment,
  FOREIGN_LOCKFILES,
  formatWorkspaceLinkSpecifier,
  globalBunfigPath,
  inspectWorkspaceInstallLayout,
  inspectWorkspaces,
  lockWorkspaceDependencies,
  lockWorkspaceNames,
  lockWorkspaceVersions,
  resolveWorkspaceSelector,
  type WorkspaceDependencyGroup,
  type WorkspaceEdge,
  type WorkspacePackageInfo,
} from "../lib/pm_policy.ts";
import { checkVerboseFetchSecretSafety } from "./dx_run_control.ts";

const DEFAULT_ROOT = path.resolve(import.meta.dir, "..");

export interface WorkspaceListRow {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  readonly private: boolean;
  readonly deps: number;
  readonly devDeps: number;
  readonly workspaceDeps: readonly string[];
  readonly scripts: number;
  readonly bins: number;
  readonly wave: number | null;
  readonly isolatedLinks: string;
}

export interface WorkspaceListReport {
  readonly root: string;
  readonly storeMode: "isolated" | "hoisted" | "missing";
  readonly patterns: readonly string[];
  readonly count: number;
  readonly rows: readonly WorkspaceListRow[];
}

export interface WorkspaceGraphReport {
  readonly root: string;
  readonly packages: readonly {
    readonly dir: string;
    readonly name: string;
    readonly version: string | null;
  }[];
  readonly edges: readonly WorkspaceEdge[];
  readonly waves: readonly (readonly string[])[];
  readonly allWaves: readonly (readonly string[])[];
  readonly cycles: readonly (readonly string[])[];
}

export interface WorkspaceAuditCheck {
  readonly name: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

export interface WorkspaceAuditReport {
  readonly ok: boolean;
  readonly strictRoot: boolean;
  readonly checks: readonly WorkspaceAuditCheck[];
}

export interface WorkspaceRunPlan {
  readonly script: string;
  readonly scriptArgs: readonly string[];
  readonly mode: "parallel" | "sequential";
  readonly topological: boolean;
  readonly workspacesOnly: boolean;
  readonly ifPresent: boolean;
  readonly noExitOnError: boolean;
  readonly elideLines: number;
  readonly filters: readonly string[];
  readonly matchedWorkspaces: readonly {
    readonly dir: string;
    readonly name: string;
    readonly hasScript: boolean;
  }[];
  readonly waves: readonly (readonly string[])[];
  readonly commands: readonly {
    readonly cwd: string;
    readonly argv: readonly string[];
  }[];
}

export interface ResolvedDepSpec {
  readonly raw: string;
  readonly normalizedArg: string;
  readonly depName: string;
  readonly isWorkspaceLink: boolean;
  readonly targetWorkspaceDir: string | null;
}

export interface WorkspaceMutationPlan {
  readonly action: "add" | "remove";
  readonly workspaceDir: string;
  readonly workspaceName: string;
  readonly cwd: string;
  readonly groupFlag: string | null;
  readonly specs: readonly ResolvedDepSpec[];
  readonly installerKind: "bun-deps" | "bun-unfrozen-config" | "bun-direct";
  readonly argv: readonly string[];
}

export interface WorkspaceInitPlan {
  readonly dir: string;
  readonly absDir: string;
  readonly name: string;
  readonly manifest: Record<string, unknown>;
  readonly entryFile: string;
  readonly tsconfigFile: string | null;
}

function emitStructured(
  payload: object,
  format: "inspect" | "json" | "yaml",
): void {
  if (format === "json") {
    console.log(JSON.stringify(payload, null, 2));
  } else if (format === "yaml") {
    console.log(YAML.stringify(payload, null, 2).trimEnd());
  } else {
    console.log(inspectReport(payload));
  }
}

function waveIndexMap(
  allWaves: readonly (readonly string[])[],
): Map<string, number> {
  const map = new Map<string, number>();
  allWaves.forEach((wave, index) => {
    for (const dir of wave) map.set(dir, index);
  });
  return map;
}

export async function buildWorkspaceListReport(
  root: string,
  options: {
    readonly workspacesOnly?: boolean;
    readonly needle?: string | undefined;
  } = {},
): Promise<WorkspaceListReport> {
  const inspection = await inspectWorkspaces(root);
  const graph = analyzeWorkspaceGraph(inspection);
  const layout = await inspectWorkspaceInstallLayout(root);
  const wavesByDir = waveIndexMap(graph.allWaves);
  const linkStatusByDir = new Map(layout.workspaceLinks.map((w) => [w.dir, w]));
  const lower = options.needle?.trim().toLowerCase();

  const rows: WorkspaceListRow[] = [];
  for (const pkg of inspection.packages) {
    if (options.workspacesOnly && pkg.dir === "") continue;
    if (
      lower &&
      !pkg.dir.toLowerCase().includes(lower) &&
      !pkg.name.toLowerCase().includes(lower)
    ) {
      continue;
    }

    const wsEdges = graph.edges
      .filter((e) => e.fromDir === pkg.dir)
      .map((e) => `${e.depName}@${e.specifier}`);
    const linkInfo = linkStatusByDir.get(pkg.dir);
    let isolatedLinks = "root";
    if (pkg.dir !== "") {
      if (!linkInfo || linkInfo.expectedLinks.length === 0) {
        isolatedLinks = "0 deps (self-contained)";
      } else if (
        linkInfo.missingLinks.length === 0 &&
        linkInfo.brokenLinks.length === 0
      ) {
        isolatedLinks = `${linkInfo.presentLinks.length}/${linkInfo.expectedLinks.length} linked`;
      } else {
        isolatedLinks = `${linkInfo.presentLinks.length}/${linkInfo.expectedLinks.length} (${linkInfo.missingLinks.length} missing, ${linkInfo.brokenLinks.length} broken)`;
      }
    }

    rows.push({
      dir: pkg.dir || ".",
      name: pkg.name,
      version: pkg.version ?? "(root)",
      private: pkg.private,
      deps: Object.keys(pkg.dependencies).length,
      devDeps: Object.keys(pkg.devDependencies).length,
      workspaceDeps: wsEdges,
      scripts: Object.keys(pkg.scripts).length,
      bins: Object.keys(pkg.bin).length,
      wave: wavesByDir.get(pkg.dir) ?? null,
      isolatedLinks,
    });
  }

  const report: WorkspaceListReport = {
    root,
    storeMode: layout.storeMode,
    patterns: inspection.patterns,
    count: rows.length,
    rows,
  };

  Object.defineProperty(report, Bun.inspect.custom, {
    enumerable: false,
    value: () => {
      const table = rows.map((r) => ({
        dir: r.dir,
        name: r.name,
        version: r.version,
        private: r.private ? "yes" : "no",
        deps: `${r.deps}+${r.devDeps}d`,
        "workspace:*":
          r.workspaceDeps.length > 0 ? r.workspaceDeps.join(", ") : "—",
        scripts: r.scripts,
        bins: r.bins,
        wave: r.wave ?? "—",
        links: r.isolatedLinks,
      }));
      return [
        `Monorepo Workspaces : ${rows.length} package(s) · patterns=[${inspection.patterns.join(", ")}] · store=${layout.storeMode}`,
        table.length > 0
          ? Bun.inspect.table(table).trimEnd()
          : "  (no matches)",
      ].join("\n");
    },
  });

  return report;
}

export async function buildWorkspaceGraphReport(
  root: string,
): Promise<WorkspaceGraphReport> {
  const inspection = await inspectWorkspaces(root);
  const graph = analyzeWorkspaceGraph(inspection);
  const report: WorkspaceGraphReport = {
    root,
    packages: inspection.packages.map((p) => ({
      dir: p.dir || ".",
      name: p.name,
      version: p.version ?? null,
    })),
    edges: graph.edges,
    waves: graph.waves,
    allWaves: graph.allWaves.map((w) => w.map((d) => d || ".")),
    cycles: graph.cycles.map((c) => c.map((d) => d || ".")),
  };

  Object.defineProperty(report, Bun.inspect.custom, {
    enumerable: false,
    value: () => {
      const lines = [
        `Workspace Dependency Graph (${report.packages.length} workspace(s), ${report.edges.length} workspace:* edge(s))`,
        "",
        "Topological Waves (dependency-first):",
      ];
      report.allWaves.forEach((wave, idx) => {
        lines.push(`  Wave ${idx}: ${wave.join(", ")}`);
      });
      lines.push("");
      lines.push("Inter-Workspace Edges:");
      if (report.edges.length === 0) {
        lines.push("  (no workspace:* dependencies declared)");
      } else {
        for (const edge of report.edges) {
          lines.push(
            `  ${edge.fromDir || "."} (${edge.fromName}) --[${edge.group}: ${edge.specifier}]--> ${edge.toDir || "."} (${edge.toName})`,
          );
        }
      }
      if (report.cycles.length > 0) {
        lines.push("");
        lines.push(
          `Cycles: ${report.cycles.map((c) => c.join(" <-> ")).join("; ")}`,
        );
      }
      return lines.join("\n");
    },
  });

  return report;
}

function mermaidNodeId(dir: string): string {
  const clean = dir === "." || dir === "" ? "root" : dir;
  return `ws_${clean.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

export function renderWorkspaceMermaid(report: WorkspaceGraphReport): string {
  const lines = ["flowchart LR"];
  const pkgByDir = new Map(report.packages.map((p) => [p.dir, p]));

  report.allWaves.forEach((wave, idx) => {
    lines.push(`  subgraph wave_${idx}["Wave ${idx}"]`);
    for (const dir of wave) {
      const pkg = pkgByDir.get(dir);
      const label = pkg
        ? `${pkg.name}${pkg.version ? ` v${pkg.version}` : ""} (${dir})`
        : dir;
      lines.push(`    ${mermaidNodeId(dir)}["${label}"]`);
    }
    lines.push("  end");
  });

  for (const edge of report.edges) {
    const from = edge.fromDir || ".";
    const to = edge.toDir || ".";
    lines.push(
      `  ${mermaidNodeId(from)} -->|"${edge.specifier}"| ${mermaidNodeId(to)}`,
    );
  }
  return lines.join("\n");
}

export function renderWorkspaceDot(report: WorkspaceGraphReport): string {
  const lines = ["digraph workspaces {", '  rankdir="LR";'];
  for (const pkg of report.packages) {
    lines.push(`  "${pkg.dir}" [label="${pkg.name}\\n(${pkg.dir})"];`);
  }
  for (const edge of report.edges) {
    const from = edge.fromDir || ".";
    const to = edge.toDir || ".";
    lines.push(`  "${from}" -> "${to}" [label="${edge.specifier}"];`);
  }
  lines.push("}");
  return lines.join("\n");
}

export async function runWorkspaceAudit(
  root: string,
  options: { readonly strictRoot?: boolean } = {},
): Promise<WorkspaceAuditReport> {
  const strictRoot = options.strictRoot ?? false;
  const checks: WorkspaceAuditCheck[] = [];

  const rootHygiene = await auditRootWorkspaceHygiene(root, {
    strictZeroRootDeps: strictRoot,
  });
  checks.push({
    name: "root manifest hygiene",
    status: rootHygiene.ok ? "ok" : "fail",
    detail: rootHygiene.detail,
  });

  const inspection = await inspectWorkspaces(root);
  const dirIssues: string[] = [];
  if (inspection.patterns.length === 0) {
    dirIssues.push('root package.json declares no "workspaces" patterns');
  }
  if (inspection.nameless.length > 0) {
    dirIssues.push(`nameless manifests: ${inspection.nameless.join(", ")}`);
  }
  if (inspection.unregisteredDirs.length > 0) {
    dirIssues.push(
      `missing package.json in ${inspection.unregisteredDirs.join(", ")}`,
    );
  }
  checks.push({
    name: "workspace directories",
    status: dirIssues.length === 0 ? "ok" : "fail",
    detail:
      dirIssues.length === 0
        ? `${inspection.packages.length - 1} workspace(s) matched [${inspection.patterns.join(", ")}]`
        : dirIssues.join("; "),
  });

  const hasLock = existsSync(path.join(root, "bun.lock"));
  const foreign = FOREIGN_LOCKFILES.filter((f) =>
    existsSync(path.join(root, f)),
  );
  checks.push({
    name: "single bun.lock",
    status: hasLock && foreign.length === 0 ? "ok" : "fail",
    detail: !hasLock
      ? "bun.lock missing"
      : foreign.length > 0
        ? `foreign lockfile(s): ${foreign.join(", ")}`
        : "bun.lock present; 0 foreign lockfiles",
  });

  if (hasLock) {
    const names = await lockWorkspaceNames(root);
    const nameKeys = [
      ...new Set([
        ...Object.keys(names.expected),
        ...Object.keys(names.locked),
      ]),
    ];
    const nameDrift = nameKeys
      .filter((k) => names.expected[k] !== names.locked[k])
      .map(
        (k) =>
          `${k || "<root>"}: lock ${names.locked[k]} vs ${names.expected[k]}`,
      );
    checks.push({
      name: "lock workspace names",
      status: nameDrift.length === 0 ? "ok" : "fail",
      detail:
        nameDrift.length === 0
          ? `${Object.keys(names.expected).length} workspace name(s) match bun.lock`
          : nameDrift.join("; "),
    });

    const versions = await lockWorkspaceVersions(root);
    const verKeys = [
      ...new Set([
        ...Object.keys(versions.expected),
        ...Object.keys(versions.locked),
      ]),
    ];
    const verDrift = verKeys
      .filter((k) => versions.expected[k] !== versions.locked[k])
      .map(
        (k) => `${k}: lock ${versions.locked[k]} vs ${versions.expected[k]}`,
      );
    checks.push({
      name: "lock workspace versions",
      status: verDrift.length === 0 ? "ok" : "fail",
      detail:
        verDrift.length === 0
          ? "all workspace versions match bun.lock"
          : verDrift.join("; "),
    });

    const depSync = await lockWorkspaceDependencies(root);
    checks.push({
      name: "lock workspace dependencies",
      status: depSync.drift.length === 0 ? "ok" : "fail",
      detail:
        depSync.drift.length === 0
          ? "all workspace dependency maps match bun.lock"
          : depSync.drift.join("; "),
    });
  }

  const graph = analyzeWorkspaceGraph(inspection);
  checks.push({
    name: "workspace:* protocol & graph",
    status: graph.issues.length === 0 ? "ok" : "fail",
    detail:
      graph.issues.length === 0
        ? `${graph.edges.length} workspace:* edge(s), ${graph.waves.length} child wave(s), 0 cycles`
        : graph.issues.map((i) => i.detail).join("; "),
  });

  const containment = await auditWorkspaceSelfContainment(root);
  const layout = await inspectWorkspaceInstallLayout(root);
  const linkProblems = [
    ...containment.undeclaredImports.map(
      (u) => `${u.file} imports undeclared "${u.packageName}"`,
    ),
    ...layout.nshVersionDrift,
    ...layout.workspaceLinks.flatMap((w) => [
      ...w.brokenLinks.map((b) => `${w.dir}/node_modules/${b} broken`),
      ...w.missingLinks.map((m) => `${w.dir}/node_modules/${m} missing`),
    ]),
  ];
  checks.push({
    name: "self-contained packages & links",
    status: linkProblems.length === 0 ? "ok" : "fail",
    detail:
      linkProblems.length === 0
        ? `store=${layout.storeMode}; Bun.Transpiler scanned ${containment.scannedFiles} file(s) (${containment.scannedImports} imports, 0 undeclared)`
        : linkProblems.join("; "),
  });

  const ok = checks.every((c) => c.status !== "fail");
  const report: WorkspaceAuditReport = { ok, strictRoot, checks };
  Object.defineProperty(report, Bun.inspect.custom, {
    enumerable: false,
    value: () => {
      const rows = checks.map((c) => ({
        status: c.status.toUpperCase(),
        check: c.name,
        detail: c.detail,
      }));
      return [
        `Workspace Audit : ${ok ? "PASS" : "FAIL"}${strictRoot ? " (strict zero-root-deps)" : ""}`,
        Bun.inspect.table(rows).trimEnd(),
      ].join("\n");
    },
  });
  return report;
}

function matchesWorkspaceFilter(
  pkg: WorkspacePackageInfo,
  pattern: string,
): boolean {
  const trimmed = pattern.trim();
  if (trimmed === "") return true;
  if (trimmed === "." || trimmed === "root") return pkg.dir === "";
  if (trimmed.startsWith("./") || trimmed.includes("/")) {
    const norm = trimmed.replace(/^\.\//, "").replace(/\/+$/, "");
    const dirGlob = new Bun.Glob(norm);
    return pkg.dir === norm || dirGlob.match(pkg.dir);
  }
  const nameGlob = new Bun.Glob(trimmed);
  return (
    pkg.name === trimmed ||
    nameGlob.match(pkg.name) ||
    pkg.dir === `packages/${trimmed}` ||
    nameGlob.match(path.posix.basename(pkg.dir || "."))
  );
}

export async function buildWorkspaceRunPlan(
  root: string,
  script: string,
  options: {
    readonly scriptArgs?: readonly string[];
    readonly filters?: readonly string[];
    readonly mode?: "parallel" | "sequential";
    readonly topological?: boolean;
    readonly workspacesOnly?: boolean;
    readonly ifPresent?: boolean;
    readonly noExitOnError?: boolean;
    readonly elideLines?: number;
    readonly bunPath?: string;
  } = {},
): Promise<WorkspaceRunPlan> {
  const inspection = await inspectWorkspaces(root);
  const graph = analyzeWorkspaceGraph(inspection);
  const bunPath = options.bunPath ?? process.execPath;
  const scriptArgs = options.scriptArgs ?? [];
  const filters = options.filters ?? [];
  const mode = options.mode ?? "parallel";
  const topological = options.topological ?? false;
  const workspacesOnly =
    options.workspacesOnly ?? (filters.length === 0 ? true : false);
  const ifPresent = options.ifPresent ?? true;
  const noExitOnError = options.noExitOnError ?? false;
  const elideLines = options.elideLines ?? 10;

  const positiveFilters = filters.filter((f) => !f.startsWith("!"));
  const negativeFilters = filters
    .filter((f) => f.startsWith("!"))
    .map((f) => f.slice(1));

  const candidates = inspection.packages.filter((pkg) => {
    if (workspacesOnly && pkg.dir === "") return false;
    const posOk =
      positiveFilters.length === 0 ||
      positiveFilters.some((f) => matchesWorkspaceFilter(pkg, f));
    if (!posOk) return false;
    const negHit = negativeFilters.some((f) => matchesWorkspaceFilter(pkg, f));
    return !negHit;
  });

  const matchedDirs = new Set(candidates.map((p) => p.dir));
  const matchedWorkspaces = candidates.map((p) => ({
    dir: p.dir || ".",
    name: p.name,
    hasScript: Object.hasOwn(p.scripts, script),
  }));

  const activeWaves = graph.allWaves
    .map((wave) => wave.filter((dir) => matchedDirs.has(dir)))
    .filter((wave) => wave.length > 0);

  const commands: { cwd: string; argv: string[] }[] = [];

  if (topological) {
    // Execute wave-by-wave so upstream `"workspace:*"` dependencies finish before dependents start
    const byDir = new Map(inspection.packages.map((p) => [p.dir, p]));
    for (const wave of activeWaves) {
      const runnable = wave.filter((dir) => {
        const pkg = byDir.get(dir);
        return (
          pkg !== undefined &&
          (!ifPresent || Object.hasOwn(pkg.scripts, script))
        );
      });
      if (runnable.length === 0) continue;

      if (runnable.length === 1 && runnable[0] === "") {
        const argv = [bunPath, "--no-orphans", "run"];
        if (ifPresent) argv.push("--if-present");
        argv.push(script, ...scriptArgs);
        commands.push({ cwd: root, argv });
      } else {
        const argv = [
          bunPath,
          "--no-orphans",
          "run",
          mode === "sequential" ? "--sequential" : "--parallel",
          `--elide-lines=${elideLines}`,
        ];
        if (noExitOnError) argv.push("--no-exit-on-error");
        if (ifPresent) argv.push("--if-present");
        for (const dir of runnable) {
          const selector = dir === "" ? "." : `./${dir}`;
          argv.push(`--filter=${selector}`);
        }
        argv.push(script, ...scriptArgs);
        commands.push({ cwd: root, argv });
      }
    }
  } else {
    const argv = [
      bunPath,
      "--no-orphans",
      "run",
      mode === "sequential" ? "--sequential" : "--parallel",
      `--elide-lines=${elideLines}`,
    ];
    if (noExitOnError) argv.push("--no-exit-on-error");
    if (ifPresent) argv.push("--if-present");
    if (filters.length > 0) {
      for (const f of filters) {
        argv.push(`--filter=${f}`);
      }
    } else {
      argv.push("--workspaces");
    }
    argv.push(script, ...scriptArgs);
    commands.push({ cwd: root, argv });
  }

  return {
    script,
    scriptArgs,
    mode,
    topological,
    workspacesOnly,
    ifPresent,
    noExitOnError,
    elideLines,
    filters,
    matchedWorkspaces,
    waves: activeWaves.map((w) => w.map((d) => d || ".")),
    commands,
  };
}

function detectUnfrozenInstaller(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): {
  readonly kind: "bun-deps" | "bun-unfrozen-config" | "bun-direct";
  readonly prefix: readonly string[];
} {
  if (env.DX_WORKSPACES_DIRECT_BUN !== "1") {
    const searchPath = env.PATH ?? Bun.env.PATH;
    const bunDeps =
      searchPath !== undefined
        ? Bun.which("bun-deps", { PATH: searchPath })
        : Bun.which("bun-deps");
    if (bunDeps) {
      return { kind: "bun-deps", prefix: [bunDeps] };
    }
    const home = env.HOME ?? "";
    const unfrozen = path.join(home, "dotfiles/bun/unfrozen.bunfig.toml");
    if (home !== "" && existsSync(unfrozen)) {
      return {
        kind: "bun-unfrozen-config",
        prefix: [process.execPath, `--config=${unfrozen}`],
      };
    }
    // Check if live global bunfig sets frozenLockfile = true without unfrozen override
    const liveGlobal = globalBunfigPath(env);
    if (existsSync(liveGlobal)) {
      try {
        const parsed = Bun.TOML.parse(readFileSync(liveGlobal, "utf8")) as {
          install?: { frozenLockfile?: boolean };
        };
        if (parsed.install?.frozenLockfile === true) {
          throw new Error(
            `global bunfig (${liveGlobal}) sets frozenLockfile = true, and neither 'bun-deps' nor '${unfrozen}' is available`,
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("frozenLockfile")) {
          throw err;
        }
      }
    }
  }
  return { kind: "bun-direct", prefix: [process.execPath] };
}

function parseRequestedPkgSpec(raw: string): {
  readonly namePart: string;
  readonly versionPart: string | null;
} {
  const trimmed = raw.trim();
  if (trimmed.startsWith("@")) {
    const secondAt = trimmed.indexOf("@", 1);
    if (secondAt === -1) return { namePart: trimmed, versionPart: null };
    return {
      namePart: trimmed.slice(0, secondAt),
      versionPart: trimmed.slice(secondAt + 1),
    };
  }
  const at = trimmed.indexOf("@");
  if (at === -1) return { namePart: trimmed, versionPart: null };
  return {
    namePart: trimmed.slice(0, at),
    versionPart: trimmed.slice(at + 1),
  };
}

export async function buildWorkspaceMutationPlan(
  root: string,
  action: "add" | "remove",
  workspaceSelector: string,
  rawSpecs: readonly string[],
  options: {
    readonly dev?: boolean;
    readonly optional?: boolean;
    readonly peer?: boolean;
    readonly exact?: boolean;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<WorkspaceMutationPlan> {
  if (rawSpecs.length === 0) {
    throw new Error(`dx workspaces ${action}: missing package specifier(s)`);
  }
  const inspection = await inspectWorkspaces(root);
  const targetWs = resolveWorkspaceSelector(inspection, workspaceSelector);
  if (!targetWs) {
    const known = inspection.packages
      .map((p) => `${p.dir || "."} (${p.name})`)
      .join(", ");
    throw new Error(
      `dx workspaces ${action}: unknown workspace "${workspaceSelector}". Known: ${known}`,
    );
  }

  const installer = detectUnfrozenInstaller(options.env ?? Bun.env);
  const cwd = targetWs.dir === "" ? root : path.join(root, targetWs.dir);

  let groupFlag: string | null = null;
  if (action === "add") {
    if (options.dev) groupFlag = "--dev";
    else if (options.optional) groupFlag = "--optional";
    else if (options.peer) groupFlag = "--peer";
  }

  const specs: ResolvedDepSpec[] = rawSpecs.map((raw) => {
    const { namePart, versionPart } = parseRequestedPkgSpec(raw);
    if (action === "remove") {
      const sibling = resolveWorkspaceSelector(inspection, namePart);
      const depName =
        sibling && sibling.dir !== targetWs.dir ? sibling.name : namePart;
      return {
        raw,
        normalizedArg: depName,
        depName,
        isWorkspaceLink: false,
        targetWorkspaceDir: null,
      };
    }

    // Check if namePart refers to another workspace in this monorepo
    const matchedSibling =
      versionPart === null || versionPart.startsWith("workspace:")
        ? resolveWorkspaceSelector(inspection, namePart)
        : null;

    if (matchedSibling) {
      if (matchedSibling.dir === targetWs.dir) {
        throw new Error(
          `dx workspaces add: workspace "${targetWs.dir || "."}" cannot add itself as a dependency`,
        );
      }
      const link = formatWorkspaceLinkSpecifier(inspection, matchedSibling);
      const spec =
        versionPart && versionPart.startsWith("workspace:")
          ? versionPart
          : link.specifier;
      return {
        raw,
        normalizedArg: `${link.depName}@${spec}`,
        depName: link.depName,
        isWorkspaceLink: true,
        targetWorkspaceDir: matchedSibling.dir || ".",
      };
    }

    return {
      raw,
      normalizedArg: raw.trim(),
      depName: namePart,
      isWorkspaceLink: versionPart?.startsWith("workspace:") ?? false,
      targetWorkspaceDir: null,
    };
  });

  const argv: string[] = [...installer.prefix, action];
  if (groupFlag) argv.push(groupFlag);
  if (action === "add" && options.exact) argv.push("--exact");
  for (const s of specs) argv.push(s.normalizedArg);

  return {
    action,
    workspaceDir: targetWs.dir || ".",
    workspaceName: targetWs.name,
    cwd,
    groupFlag,
    specs,
    installerKind: installer.kind,
    argv,
  };
}

export async function linkWorkspaces(
  root: string,
  fromSelector: string,
  toSelector: string,
  options: {
    readonly group?: WorkspaceDependencyGroup;
    readonly dryRun?: boolean;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<{
  readonly fromDir: string;
  readonly toDir: string;
  readonly depName: string;
  readonly specifier: string;
  readonly group: WorkspaceDependencyGroup;
  readonly installArgv: readonly string[];
  readonly dryRun: boolean;
}> {
  const inspection = await inspectWorkspaces(root);
  const fromWs = resolveWorkspaceSelector(inspection, fromSelector);
  if (!fromWs) {
    throw new Error(
      `dx workspaces link: unknown source workspace "${fromSelector}"`,
    );
  }
  const toWs = resolveWorkspaceSelector(inspection, toSelector);
  if (!toWs) {
    throw new Error(
      `dx workspaces link: unknown target workspace "${toSelector}"`,
    );
  }
  if (fromWs.dir === toWs.dir) {
    throw new Error(
      `dx workspaces link: workspace "${fromWs.dir || "."}" cannot link to itself`,
    );
  }

  const group = options.group ?? "dependencies";
  const { depName, specifier } = formatWorkspaceLinkSpecifier(inspection, toWs);

  // Verify linking does not introduce a cycle before mutating any manifest
  const simulatedPackages = inspection.packages.map((p) =>
    p.dir === fromWs.dir
      ? {
          ...p,
          [group]: { ...p[group], [depName]: specifier },
        }
      : p,
  );
  const simulatedGraph = analyzeWorkspaceGraph({
    ...inspection,
    packages: simulatedPackages,
  });
  if (simulatedGraph.cycles.length > 0) {
    throw new Error(
      `dx workspaces link: linking ${fromWs.dir || "."} -> ${toWs.dir || "."} creates a dependency cycle`,
    );
  }

  const installer = detectUnfrozenInstaller(options.env ?? Bun.env);
  const installArgv = [...installer.prefix, "install"];
  const dryRun = options.dryRun ?? false;

  if (!dryRun) {
    const pkgPath = path.join(root, fromWs.dir, "package.json");
    const raw = (await Bun.file(pkgPath).json()) as Record<string, unknown>;
    const existingGroup =
      typeof raw[group] === "object" && raw[group] !== null
        ? { ...(raw[group] as Record<string, string>) }
        : {};
    existingGroup[depName] = specifier;
    const sortedGroup = Object.fromEntries(
      Object.entries(existingGroup).sort(([a], [b]) => a.localeCompare(b)),
    );
    raw[group] = sortedGroup;
    await Bun.write(pkgPath, `${JSON.stringify(raw, null, 2)}\n`);

    const proc = Bun.spawnSync(installArgv, {
      cwd: root,
      env: { ...Bun.env, ...options.env },
      stdout: "inherit",
      stderr: "inherit",
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `dx workspaces link: root install exited with code ${proc.exitCode}`,
      );
    }
  }

  return {
    fromDir: fromWs.dir || ".",
    toDir: toWs.dir || ".",
    depName,
    specifier,
    group,
    installArgv,
    dryRun,
  };
}

export async function planWorkspaceInit(
  root: string,
  rawName: string,
  options: {
    readonly dir?: string | undefined;
    readonly scoped?: boolean;
    readonly description?: string | undefined;
    readonly withTsconfig?: boolean;
  } = {},
): Promise<WorkspaceInitPlan> {
  const clean = rawName.trim();
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(clean)) {
    throw new Error(
      `dx workspaces init: invalid package name "${rawName}" (expected lowercase npm package name)`,
    );
  }
  const rootPkg = (await Bun.file(path.join(root, "package.json")).json()) as {
    name?: string;
    engines?: { bun?: string };
  };
  const scopePrefix = `@${rootPkg.name ?? "monorepo"}/`;
  const pkgName =
    options.scoped && !clean.startsWith("@") ? `${scopePrefix}${clean}` : clean;
  const slug = clean.includes("/") ? (clean.split("/").at(-1) ?? clean) : clean;
  const relDir = (options.dir ?? `packages/${slug}`)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  const absDir = path.join(root, relDir);

  const manifest: Record<string, unknown> = {
    name: pkgName,
    version: "0.1.0",
    private: true,
    ...(options.description ? { description: options.description } : {}),
    type: "module",
    main: "./src/index.ts",
    exports: {
      ".": "./src/index.ts",
    },
    scripts: {
      test: "bun test",
    },
    ...(rootPkg.engines?.bun ? { engines: { bun: rootPkg.engines.bun } } : {}),
  };

  return {
    dir: relDir,
    absDir,
    name: pkgName,
    manifest,
    entryFile: `${relDir}/src/index.ts`,
    tsconfigFile: options.withTsconfig ? `${relDir}/tsconfig.json` : null,
  };
}

const HELP_TEXT = `dx workspaces — Monorepo Workspace Dev Control (Bun Workspaces)

Usage:
  ./bin/dx workspaces [list] [filter] [--workspaces-only] [--json | --yaml]
  ./bin/dx workspaces graph [--mermaid | --dot | --json | --yaml]
  ./bin/dx workspaces audit [--strict-root] [--json | --yaml]
  ./bin/dx workspaces run [options] <script> [-- <script-args...>]
  ./bin/dx workspaces add <workspace> <pkg...> [-d|--dev] [-E|--exact] [--dry-run] [--json | --yaml]
  ./bin/dx workspaces remove <workspace> <pkg...> [--dry-run] [--json | --yaml]
  ./bin/dx workspaces link <from-workspace> <to-workspace> [-d|--dev] [--dry-run] [--json | --yaml]
  ./bin/dx workspaces init <name> [--dir packages/<slug>] [--scoped] [--with-tsconfig] [--dry-run]

Run Options:
  -F, --filter=<pattern>   Filter workspaces by package name or path glob (repeatable; !negates)
  --workspaces-only        Exclude root manifest (default when --filter is omitted)
  --include-root           Include root manifest alongside packages/*
  --topological, --topo    Execute waves in dependency-first order (parallel within each wave)
  --parallel               Run matched workspaces concurrently (default)
  --sequential             Run matched workspaces sequentially
  --if-present             Skip workspaces that do not define <script> (default)
  --require-script         Fail if a matched workspace lacks <script>
  --no-exit-on-error       Continue running remaining workspaces when one fails
  --elide-lines=<n>        Lines of output retained per workspace with --filter (default: 10)
  --dry-run                Print resolved workspace wave plan and Bun argv without executing

Examples:
  ./bin/dx workspaces
  ./bin/dx workspaces graph --mermaid
  ./bin/dx workspaces audit
  ./bin/dx workspaces run --topological test
  ./bin/dx workspaces run --filter '@sportsdesk-ops/*' --dry-run verify
  ./bin/dx workspaces add ba-example zod --dry-run
  ./bin/dx workspaces link ba-example @sportsdesk-ops/nsh-desk --dry-run
`;

function parseFormat(flags: {
  readonly json: boolean;
  readonly yaml: boolean;
}): "inspect" | "json" | "yaml" {
  if (flags.json) return "json";
  if (flags.yaml) return "yaml";
  return "inspect";
}

export async function runWorkspacesCli(
  argv: readonly string[],
  root: string = DEFAULT_ROOT,
): Promise<number> {
  const args = [...argv];
  const first = args[0];
  if (first === "-h" || first === "--help" || first === "help") {
    console.log(HELP_TEXT.trimEnd());
    return 0;
  }

  const knownSubs = new Set([
    "list",
    "ls",
    "graph",
    "audit",
    "check",
    "doctor",
    "run",
    "add",
    "remove",
    "rm",
    "link",
    "init",
  ]);
  const sub =
    first !== undefined && !first.startsWith("-") && knownSubs.has(first)
      ? args.shift()!
      : "list";

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP_TEXT.trimEnd());
    return 0;
  }

  if (sub === "list" || sub === "ls") {
    let json = false;
    let yaml = false;
    let workspacesOnly = false;
    let needle: string | undefined;
    for (const token of args) {
      if (token === "--json") json = true;
      else if (token === "--yaml") yaml = true;
      else if (token === "--workspaces-only") workspacesOnly = true;
      else if (token.startsWith("-")) {
        console.error(`dx workspaces list: unknown flag "${token}"`);
        return 2;
      } else if (needle === undefined) {
        needle = token;
      } else {
        console.error(`dx workspaces list: unexpected argument "${token}"`);
        return 2;
      }
    }
    const report = await buildWorkspaceListReport(root, {
      workspacesOnly,
      needle,
    });
    emitStructured(report, parseFormat({ json, yaml }));
    return 0;
  }

  if (sub === "graph") {
    let json = false;
    let yaml = false;
    let mermaid = false;
    let dot = false;
    for (const token of args) {
      if (token === "--json") json = true;
      else if (token === "--yaml") yaml = true;
      else if (token === "--mermaid") mermaid = true;
      else if (token === "--dot") dot = true;
      else {
        console.error(`dx workspaces graph: unknown argument "${token}"`);
        return 2;
      }
    }
    const report = await buildWorkspaceGraphReport(root);
    if (mermaid) {
      console.log(renderWorkspaceMermaid(report));
    } else if (dot) {
      console.log(renderWorkspaceDot(report));
    } else {
      emitStructured(report, parseFormat({ json, yaml }));
    }
    return 0;
  }

  if (sub === "audit" || sub === "check" || sub === "doctor") {
    let json = false;
    let yaml = false;
    let strictRoot = false;
    for (const token of args) {
      if (token === "--json") json = true;
      else if (token === "--yaml") yaml = true;
      else if (token === "--strict-root") strictRoot = true;
      else {
        console.error(`dx workspaces audit: unknown argument "${token}"`);
        return 2;
      }
    }
    const report = await runWorkspaceAudit(root, { strictRoot });
    emitStructured(report, parseFormat({ json, yaml }));
    return report.ok ? 0 : 1;
  }

  if (sub === "run") {
    const filters: string[] = [];
    let mode: "parallel" | "sequential" = "parallel";
    let topological = false;
    let workspacesOnly: boolean | undefined;
    let ifPresent = true;
    let noExitOnError = false;
    let elideLines = 10;
    let dryRun = false;
    let json = false;
    let yaml = false;
    let script: string | null = null;
    const scriptArgs: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
      const token = args[i]!;
      if (script !== null) {
        if (token === "--") {
          scriptArgs.push(...args.slice(i + 1));
          break;
        }
        scriptArgs.push(token);
        continue;
      }
      if (token === "--") {
        const next = args[i + 1];
        if (!next) {
          console.error("dx workspaces run: missing <script> after '--'");
          return 2;
        }
        script = next;
        scriptArgs.push(...args.slice(i + 2));
        break;
      }
      if (token === "-F" || token === "--filter") {
        const val = args[i + 1];
        if (!val) {
          console.error(`dx workspaces run: ${token} requires a pattern`);
          return 2;
        }
        filters.push(val);
        i += 1;
        continue;
      }
      if (token.startsWith("--filter=")) {
        filters.push(token.slice("--filter=".length));
        continue;
      }
      if (token === "--parallel") {
        mode = "parallel";
        continue;
      }
      if (token === "--sequential") {
        mode = "sequential";
        continue;
      }
      if (token === "--topological" || token === "--topo") {
        topological = true;
        continue;
      }
      if (token === "--workspaces-only") {
        workspacesOnly = true;
        continue;
      }
      if (token === "--include-root") {
        workspacesOnly = false;
        continue;
      }
      if (token === "--if-present") {
        ifPresent = true;
        continue;
      }
      if (token === "--require-script") {
        ifPresent = false;
        continue;
      }
      if (token === "--no-exit-on-error") {
        noExitOnError = true;
        continue;
      }
      if (token.startsWith("--elide-lines=")) {
        const n = Number(token.slice("--elide-lines=".length));
        if (!Number.isInteger(n) || n < 0) {
          console.error("dx workspaces run: --elide-lines must be >= 0");
          return 2;
        }
        elideLines = n;
        continue;
      }
      if (token === "--elide-lines") {
        const n = Number(args[i + 1]);
        if (!Number.isInteger(n) || n < 0) {
          console.error("dx workspaces run: --elide-lines must be >= 0");
          return 2;
        }
        elideLines = n;
        i += 1;
        continue;
      }
      if (token === "--dry-run") {
        dryRun = true;
        continue;
      }
      if (token === "--json") {
        json = true;
        continue;
      }
      if (token === "--yaml") {
        yaml = true;
        continue;
      }
      if (token.startsWith("-")) {
        console.error(`dx workspaces run: unknown flag "${token}"`);
        return 2;
      }
      script = token;
    }

    if (!script) {
      console.error(
        "usage: ./bin/dx workspaces run [options] <script> [-- <args...>]",
      );
      return 2;
    }

    const plan = await buildWorkspaceRunPlan(root, script, {
      scriptArgs,
      filters,
      mode,
      topological,
      ...(workspacesOnly !== undefined ? { workspacesOnly } : {}),
      ifPresent,
      noExitOnError,
      elideLines,
    });

    if (dryRun) {
      if (json || yaml) {
        emitStructured(plan, parseFormat({ json, yaml }));
      } else {
        console.log(
          `[dry-run] script="${plan.script}" matched=${plan.matchedWorkspaces.length} waves=${JSON.stringify(plan.waves)}`,
        );
        for (const cmd of plan.commands) {
          console.log(`  (${cmd.cwd}) $ ${cmd.argv.join(" ")}`);
        }
      }
      return 0;
    }

    const secretCheck = checkVerboseFetchSecretSafety(Bun.env);
    if (secretCheck.blocked) {
      console.error(`dx workspaces run: BLOCKED — ${secretCheck.reason}`);
      return 2;
    }

    if (plan.commands.length === 0) {
      console.log(
        `dx workspaces run: no matched workspace defines script "${script}"`,
      );
      return 0;
    }

    let finalCode = 0;
    for (const step of plan.commands) {
      const proc = Bun.spawnSync(step.argv as string[], {
        cwd: step.cwd,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      });
      if (proc.exitCode !== 0) {
        finalCode = proc.exitCode;
        if (!noExitOnError) return finalCode;
      }
    }
    return finalCode;
  }

  if (sub === "add" || sub === "remove" || sub === "rm") {
    const action = sub === "add" ? "add" : "remove";
    let dev = false;
    let optional = false;
    let peer = false;
    let exact = false;
    let dryRun = false;
    let json = false;
    let yaml = false;
    const positional: string[] = [];

    for (const token of args) {
      if (token === "-d" || token === "--dev") dev = true;
      else if (token === "--optional") optional = true;
      else if (token === "--peer") peer = true;
      else if (token === "-E" || token === "--exact") exact = true;
      else if (token === "--dry-run") dryRun = true;
      else if (token === "--json") json = true;
      else if (token === "--yaml") yaml = true;
      else if (token.startsWith("-")) {
        console.error(`dx workspaces ${action}: unknown flag "${token}"`);
        return 2;
      } else {
        positional.push(token);
      }
    }

    const [wsSelector, ...specs] = positional;
    if (!wsSelector || specs.length === 0) {
      console.error(
        `usage: ./bin/dx workspaces ${action} <workspace> <pkg...> [--dry-run]`,
      );
      return 2;
    }

    const plan = await buildWorkspaceMutationPlan(
      root,
      action,
      wsSelector,
      specs,
      { dev, optional, peer, exact },
    );

    if (dryRun) {
      if (json || yaml) {
        emitStructured(plan, parseFormat({ json, yaml }));
      } else {
        console.log(
          `[dry-run] workspace=${plan.workspaceDir} (${plan.workspaceName}) installer=${plan.installerKind}`,
        );
        console.log(`  cwd : ${plan.cwd}`);
        console.log(`  cmd : ${plan.argv.join(" ")}`);
      }
      return 0;
    }

    const secretCheck = checkVerboseFetchSecretSafety(Bun.env);
    if (secretCheck.blocked) {
      console.error(`dx workspaces ${action}: BLOCKED — ${secretCheck.reason}`);
      return 2;
    }

    const proc = Bun.spawnSync(plan.argv as string[], {
      cwd: plan.cwd,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (proc.exitCode !== 0) return proc.exitCode;

    const depCheck = await lockWorkspaceDependencies(root);
    if (depCheck.drift.length > 0) {
      console.error(
        `dx workspaces ${action}: lockfile drift after ${action}: ${depCheck.drift.join("; ")}`,
      );
      return 1;
    }
    return 0;
  }

  if (sub === "link") {
    let dev = false;
    let dryRun = false;
    let json = false;
    let yaml = false;
    const positional: string[] = [];

    for (const token of args) {
      if (token === "-d" || token === "--dev") dev = true;
      else if (token === "--dry-run") dryRun = true;
      else if (token === "--json") json = true;
      else if (token === "--yaml") yaml = true;
      else if (token.startsWith("-")) {
        console.error(`dx workspaces link: unknown flag "${token}"`);
        return 2;
      } else {
        positional.push(token);
      }
    }

    const [fromSel, toSel, extra] = positional;
    if (!fromSel || !toSel || extra !== undefined) {
      console.error(
        "usage: ./bin/dx workspaces link <from-workspace> <to-workspace> [-d|--dev] [--dry-run]",
      );
      return 2;
    }

    const result = await linkWorkspaces(root, fromSel, toSel, {
      group: dev ? "devDependencies" : "dependencies",
      dryRun,
    });

    if (json || yaml) {
      emitStructured(result, parseFormat({ json, yaml }));
    } else {
      console.log(
        `${dryRun ? "[dry-run] " : ""}linked ${result.fromDir} -> "${result.depName}": "${result.specifier}" (${result.group})`,
      );
    }
    return 0;
  }

  if (sub === "init") {
    let dir: string | undefined;
    let scoped = false;
    let description: string | undefined;
    let withTsconfig = false;
    let noInstall = false;
    let dryRun = false;
    let json = false;
    let yaml = false;
    const positional: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
      const token = args[i]!;
      if (token === "--scoped") scoped = true;
      else if (token === "--with-tsconfig") withTsconfig = true;
      else if (token === "--no-install") noInstall = true;
      else if (token === "--dry-run") dryRun = true;
      else if (token === "--json") json = true;
      else if (token === "--yaml") yaml = true;
      else if (token === "--dir") {
        dir = args[++i];
      } else if (token.startsWith("--dir=")) {
        dir = token.slice("--dir=".length);
      } else if (token === "--description") {
        description = args[++i];
      } else if (token.startsWith("--description=")) {
        description = token.slice("--description=".length);
      } else if (token.startsWith("-")) {
        console.error(`dx workspaces init: unknown flag "${token}"`);
        return 2;
      } else {
        positional.push(token);
      }
    }

    const [pkgName, extra] = positional;
    if (!pkgName || extra !== undefined) {
      console.error(
        "usage: ./bin/dx workspaces init <name> [--dir packages/<slug>] [--scoped] [--with-tsconfig] [--dry-run]",
      );
      return 2;
    }

    const plan = await planWorkspaceInit(root, pkgName, {
      dir,
      scoped,
      description,
      withTsconfig,
    });

    if (existsSync(path.join(plan.absDir, "package.json"))) {
      console.error(
        `dx workspaces init: ${plan.dir}/package.json already exists`,
      );
      return 2;
    }

    if (!dryRun) {
      mkdirSync(path.join(plan.absDir, "src"), { recursive: true });
      await Bun.write(
        path.join(plan.absDir, "package.json"),
        `${JSON.stringify(plan.manifest, null, 2)}\n`,
      );
      const entryAbs = path.join(root, plan.entryFile);
      if (!existsSync(entryAbs)) {
        await Bun.write(
          entryAbs,
          `export const WORKSPACE_NAME = ${JSON.stringify(plan.name)} as const;\n`,
        );
      }
      if (plan.tsconfigFile) {
        await Bun.write(
          path.join(root, plan.tsconfigFile),
          `${JSON.stringify(
            {
              extends: "../../tsconfig.json",
              include: ["src/**/*.ts"],
            },
            null,
            2,
          )}\n`,
        );
      }
      if (!noInstall) {
        const installer = detectUnfrozenInstaller(Bun.env);
        const proc = Bun.spawnSync([...installer.prefix, "install"], {
          cwd: root,
          stdout: "inherit",
          stderr: "inherit",
        });
        if (proc.exitCode !== 0) return proc.exitCode;
      }
    }

    if (json || yaml) {
      emitStructured({ dryRun, ...plan }, parseFormat({ json, yaml }));
    } else {
      console.log(
        `${dryRun ? "[dry-run] " : ""}initialized workspace ${plan.name} at ${plan.dir}`,
      );
    }
    return 0;
  }

  console.error(`dx workspaces: unknown subcommand "${sub}"`);
  return 2;
}

if (import.meta.main) {
  try {
    const code = await runWorkspacesCli(Bun.argv.slice(2));
    process.exit(code);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
