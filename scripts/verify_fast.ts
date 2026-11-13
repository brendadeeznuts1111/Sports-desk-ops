#!/usr/bin/env bun
/**
 * @file scripts/verify_fast.ts
 * @description Sub-2s parallel inner-loop verification for rapid local development.
 *
 * Replaces 15+ sequential gate commands and 60s+ full-repo test sweeps with:
 *   1. Scoped `bun fmt` on changed files (~30ms; `--check` for read-only)
 *   2. Parallel `Promise.all` execution of:
 *      - Workspace-scoped `bun check --no-script -p <tsconfig>` (UI-only edits skip root `tsconfig.json`)
 *      - `oxlint --deny-warnings` scoped to changed JS/TS/TSX files (`--deep` adds `--type-aware`)
 *      - Path-triggered gates ONLY when relevant directories changed
 *      - Targeted tests: `bun test --parallel --changed` (or head shard `--shard=1/8` + explicit
 *        changed/matched `*.test.ts` when root configs changed or inside a sandboxed worktree).
 *
 * Usage:
 *   bun run verify:fast                      # auto-detect changed files (git diff or mtime fallback)
 *   bun run verify:fast lib/foo.ts           # verify specific file(s) + matching tests
 *   bun run verify:fast --check              # read-only format check
 *   bun run verify:fast --shard              # force head shard (1/8)
 *   bun run verify:fast --deep               # include type-aware oxlint pass
 */

import { existsSync, lstatSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyzeWorkspaceGraph, inspectWorkspaces } from "../lib/pm_policy.ts";

const ROOT = path.resolve(import.meta.dir, "..");

export const FORMAT_EXT =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|json5|md|html|css|yml|yaml|toml)$/;
export const LINT_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
export const ROOT_BLAST_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "bun.lock",
  "bunfig.toml",
]);

export const SCOPED_WORKSPACE_DIRS = [
  "packages/contracts",
  "packages/ui",
  "packages/backend",
  "packages/api",
] as const;

export interface WorkspaceEdgeRef {
  readonly fromDir: string;
  readonly toDir: string;
}

export interface TypecheckTaskSpec {
  readonly name: string;
  readonly cmd: readonly string[];
}

export function workspaceDirOfFile(file: string): string | null {
  for (const ws of SCOPED_WORKSPACE_DIRS) {
    if (file === ws || file.startsWith(`${ws}/`)) {
      return ws;
    }
  }
  return null;
}

export function buildDownstreamDependents(
  edges: readonly WorkspaceEdgeRef[],
): Map<string, Set<string>> {
  const downstream = new Map<string, Set<string>>();
  for (const { fromDir, toDir } of edges) {
    if (fromDir === toDir) continue;
    let set = downstream.get(toDir);
    if (!set) {
      set = new Set<string>();
      downstream.set(toDir, set);
    }
    set.add(fromDir);
  }
  return downstream;
}

function fullTypecheckSpecs(): TypecheckTaskSpec[] {
  return [
    {
      name: "typecheck",
      cmd: ["bun", "check", "--no-script", "-p", "tsconfig.json"],
    },
    {
      name: "typecheck:ui",
      cmd: ["bun", "check", "--no-script", "-p", "src/dashboard/tsconfig.json"],
    },
    ...SCOPED_WORKSPACE_DIRS.map((ws) => ({
      name: `typecheck:pkg:${ws.slice("packages/".length)}`,
      cmd: ["bun", "check", "--no-script", "-p", `${ws}/tsconfig.json`],
    })),
    {
      name: "ensure:tsconfig",
      cmd: ["bun", "run", "scripts/ensure_deep_tsconfig.ts"],
    },
  ];
}

/**
 * Select the minimal set of `bun check -p <tsconfig>` tasks needed for `changed`:
 * - Case A: pure UI/dashboard edits run only `packages/ui/tsconfig.json` + `src/dashboard/tsconfig.json`.
 * - Case B: pure workspace edits run affected workspace `tsconfig.json`s + transitive downstream
 *   dependents (and include root `tsconfig.json` only if root `""` is in the downstream closure).
 * - Case C: root/mixed/empty/`hasRootBlast` runs the full typecheck set.
 */
export function planTypecheckTasks(
  changed: readonly string[],
  options: {
    readonly hasRootBlast: boolean;
    readonly edges: readonly WorkspaceEdgeRef[];
  },
): TypecheckTaskSpec[] {
  if (changed.length === 0 || options.hasRootBlast) {
    return fullTypecheckSpecs();
  }

  const isUiFile = (f: string): boolean =>
    f.startsWith("packages/ui/") || f.startsWith("src/dashboard/");
  if (changed.every(isUiFile)) {
    return [
      {
        name: "typecheck:pkg:ui",
        cmd: ["bun", "check", "--no-script", "-p", "packages/ui/tsconfig.json"],
      },
      {
        name: "typecheck:ui",
        cmd: [
          "bun",
          "check",
          "--no-script",
          "-p",
          "src/dashboard/tsconfig.json",
        ],
      },
    ];
  }

  const isWorkspaceOrUiFile = (f: string): boolean =>
    workspaceDirOfFile(f) !== null || f.startsWith("src/dashboard/");
  if (!changed.every(isWorkspaceOrUiFile)) {
    return fullTypecheckSpecs();
  }

  const downstream = buildDownstreamDependents(options.edges);
  const closure = new Set<string>();
  const queue: string[] = [];

  for (const file of changed) {
    const ws = workspaceDirOfFile(file);
    if (ws !== null && !closure.has(ws)) {
      closure.add(ws);
      queue.push(ws);
    }
    if (file.startsWith("src/dashboard/") && !closure.has("packages/ui")) {
      closure.add("packages/ui");
      queue.push("packages/ui");
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dep of downstream.get(current) ?? []) {
      // Isolated backend/api edits keep sub-100ms scoping by checking workspace
      // boundaries without dragging root tsconfig.json into every inner-loop save;
      // contracts/sportsdesk-ops edits still propagate into root.
      if (
        dep === "" &&
        current !== "packages/contracts" &&
        current !== "packages/sportsdesk-ops"
      ) {
        continue;
      }
      if (!closure.has(dep)) {
        closure.add(dep);
        queue.push(dep);
      }
    }
  }

  const specs: TypecheckTaskSpec[] = [];
  for (const ws of SCOPED_WORKSPACE_DIRS) {
    if (closure.has(ws)) {
      specs.push({
        name: `typecheck:pkg:${ws.slice("packages/".length)}`,
        cmd: ["bun", "check", "--no-script", "-p", `${ws}/tsconfig.json`],
      });
    }
  }

  if (
    closure.has("packages/ui") ||
    changed.some((f) => f.startsWith("src/dashboard/"))
  ) {
    specs.push({
      name: "typecheck:ui",
      cmd: ["bun", "check", "--no-script", "-p", "src/dashboard/tsconfig.json"],
    });
  }

  if (closure.has("")) {
    specs.push(
      {
        name: "typecheck",
        cmd: ["bun", "check", "--no-script", "-p", "tsconfig.json"],
      },
      {
        name: "ensure:tsconfig",
        cmd: ["bun", "run", "scripts/ensure_deep_tsconfig.ts"],
      },
    );
  }

  return specs.length > 0 ? specs : fullTypecheckSpecs();
}

export function inferTestsForFiles(
  files: readonly string[],
  root: string = ROOT,
): string[] {
  const tests = new Set<string>();
  for (const f of files) {
    if (
      /\.test\.(ts|tsx|js|mjs)$/.test(f) &&
      !f.includes("language_coverage") &&
      !f.includes("market_index")
    ) {
      tests.add(f);
      continue;
    }

    const candidates: string[] = [];
    const stem = path
      .basename(f)
      .replace(/\.(types\.)?(ts|tsx|js|mjs|toml|json|css)$/, "");

    if (stem && stem !== "index" && stem !== "package" && stem !== "tsconfig") {
      candidates.push(`tests/${stem}.test.ts`, `tests/${stem}_toml.test.ts`);
      if (/\.(ts|tsx)$/.test(f)) {
        candidates.push(f.replace(/\.(ts|tsx)$/, ".test.$1"));
      }
    }

    if (f.startsWith("packages/nsh-desk/")) {
      candidates.push("tests/nsh_desk_contract.test.ts");
    }

    if (f.startsWith("packages/backend/")) {
      candidates.push(
        "tests/dashboard_backend_workspace.test.ts",
        "tests/dashboard_api_inmemory.test.ts",
        "tests/dashboard_ui_hydration.test.tsx",
      );
    } else if (f.startsWith("packages/api/")) {
      candidates.push(
        "tests/dashboard_api_inmemory.test.ts",
        "tests/dashboard_ui_hydration.test.tsx",
      );
    }

    if (
      f.startsWith("packages/ui/") ||
      f.startsWith("packages/contracts/") ||
      f.startsWith("src/dashboard/") ||
      f.startsWith("src/risk/")
    ) {
      if (f.startsWith("packages/ui/src/")) {
        candidates.push(
          "tests/dashboard_ui_panels.test.tsx",
          "tests/dashboard_ui_hydration.test.tsx",
        );
      } else if (f.startsWith("packages/contracts/src/")) {
        candidates.push("tests/dashboard_ui_hydration.test.tsx");
      }
      if (stem === "ansi") {
        candidates.push("tests/dashboard_build_and_markdown.test.ts");
      } else if (stem === "wager_tokens" || stem === "runtime_flags") {
        candidates.push(
          "tests/wager_tiers_toml.test.ts",
          "tests/dashboard_build_and_markdown.test.ts",
        );
      } else if (stem === "features") {
        candidates.push("tests/wager_tiers_toml.test.ts");
      } else if (
        stem === "ShadowPricingPanel" ||
        stem === "SliceMetricsViews" ||
        stem === "shadow_pricing" ||
        stem.startsWith("slice_") ||
        f.startsWith("packages/ui/src/shadow_pricing/")
      ) {
        candidates.push(
          "tests/dashboard_shadow_panel.test.tsx",
          "tests/slice_metrics.test.ts",
          "tests/enhanced_dashboard_builder.test.ts",
        );
      } else if (
        stem === "App" ||
        stem === "index" ||
        stem === "desk" ||
        stem === "tokens" ||
        stem === "reset" ||
        stem === "dashboard"
      ) {
        candidates.push("tests/enhanced_dashboard_builder.test.ts");
      }
    }

    if (
      /^packages\/(contracts|ui|backend|api)\/package\.json$/.test(f) ||
      f === "scripts/check_workspace_packs.ts"
    ) {
      candidates.push("tests/workspace_packs.test.ts");
    }

    for (const c of candidates) {
      if (
        existsSync(path.join(root, c)) &&
        /\.test\.(ts|tsx|js|mjs)$/.test(c) &&
        !c.includes("market_index")
      ) {
        tests.add(c);
      }
    }
  }
  return [...tests];
}

function gitQuery(args: string[]): { ok: boolean; lines: string[] } {
  const res = Bun.spawnSync(["git", ...args], {
    cwd: ROOT,
    env: {
      ...Bun.env,
      GIT_CONFIG_GLOBAL: Bun.env.GIT_CONFIG_GLOBAL ?? "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) return { ok: false, lines: [] };
  const lines = new TextDecoder()
    .decode(res.stdout)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { ok: true, lines };
}

function collectRecentByMtime(minutes: number): string[] {
  const cutoff = Date.now() - minutes * 60_000;
  const glob = new Bun.Glob(
    "{lib,src,packages,scripts,tests,config,design,bin,cli,services,workers,types,migrations}/**/*.{ts,tsx,js,mjs,json,toml,md,sql}",
  );
  const found: string[] = [];
  for (const rel of glob.scanSync({ cwd: ROOT, onlyFiles: true })) {
    if (rel.includes("node_modules/")) continue;
    try {
      if (statSync(path.join(ROOT, rel)).mtimeMs >= cutoff) {
        found.push(rel);
      }
    } catch {
      // signal-honesty: intentional-ignore transient file removed mid-scan
    }
  }
  for (const top of [
    "package.json",
    "tsconfig.json",
    "AGENTS.md",
    "README.md",
  ]) {
    const p = path.join(ROOT, top);
    if (existsSync(p) && statSync(p).mtimeMs >= cutoff) found.push(top);
  }
  return found;
}

function collectChangedFiles(
  positionals: readonly string[],
  gitAvailable: boolean,
  options: { readonly base: string | undefined; readonly sinceMin: string },
): string[] {
  if (positionals.length > 0) {
    return positionals.filter((f) => existsSync(path.join(ROOT, f)));
  }
  if (!gitAvailable) {
    return collectRecentByMtime(Number(options.sinceMin) || 45);
  }
  const set = new Set<string>();
  for (const f of gitQuery(["diff", "--name-only", "HEAD"]).lines) set.add(f);
  for (const f of gitQuery(["diff", "--name-only", "--cached"]).lines)
    set.add(f);
  for (const f of gitQuery(["ls-files", "--others", "--exclude-standard"])
    .lines) {
    set.add(f);
  }
  if (set.size === 0 || options.base) {
    const ref = options.base ?? "origin/main...HEAD";
    for (const f of gitQuery(["diff", "--name-only", ref]).lines) set.add(f);
  }
  return [...set].filter((f) => {
    const full = path.join(ROOT, f);
    return existsSync(full) && !lstatSync(full).isSymbolicLink();
  });
}

interface TaskResult {
  name: string;
  ok: boolean;
  ms: number;
  output: string;
}

async function runTask(
  name: string,
  cmd: readonly string[],
  extraEnv?: Record<string, string>,
): Promise<TaskResult> {
  const t0 = performance.now();
  const proc = Bun.spawn([...cmd], {
    cwd: ROOT,
    env: { FORCE_COLOR: "1", ...Bun.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const ms = Math.round(performance.now() - t0);
  return {
    name,
    ok: exitCode === 0,
    ms,
    output: [out.trim(), err.trim()].filter(Boolean).join("\n"),
  };
}

function resolveOxlintCmd(): string[] | null {
  const localBin = path.join(ROOT, "node_modules", ".bin", "oxlint");
  if (
    existsSync(localBin) ||
    Bun.which("oxlint", { PATH: Bun.env.PATH ?? "" }) !== null
  ) {
    // Use `bun --bun run oxlint` so Bun injects its `node` PATH shim for both
    // the oxlint wrapper (`#!/usr/bin/env node`) and any child `tsgolint` process.
    return [process.execPath, "--bun", "run", "oxlint"];
  }
  return null;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      check: { type: "boolean", default: false },
      shard: { type: "boolean", default: false },
      deep: { type: "boolean", default: false },
      base: { type: "string" },
      "since-min": { type: "string", default: "45" },
    },
    allowPositionals: true,
    strict: true,
  });

  const started = performance.now();
  const probeGit = gitQuery(["rev-parse", "--is-inside-work-tree"]);
  const gitAvailable = probeGit.ok;
  const changed = collectChangedFiles(positionals, gitAvailable, {
    base: values.base,
    sinceMin: values["since-min"],
  });

  const fmtTargets = changed.filter((f) => FORMAT_EXT.test(f));
  const lintTargets = changed.filter((f) => LINT_EXT.test(f));
  const inferredTests = inferTestsForFiles(changed);
  const hasRootBlast = changed.some((f) => ROOT_BLAST_FILES.has(f));

  // Phase 1: Format & token gate (avoids racing parallel readers on unlinked files)
  let fmtResult: TaskResult | null = null;
  if (fmtTargets.length > 0) {
    const fmtCmd = values.check
      ? ["bun", "fmt", "--check", ...fmtTargets]
      : ["bun", "fmt", ...fmtTargets];
    fmtResult = await runTask(
      values.check
        ? `fmt:check (${fmtTargets.length})`
        : `fmt (${fmtTargets.length})`,
      fmtCmd,
    );
    if (!fmtResult.ok) {
      console.error(
        `✗ ${fmtResult.name} (${fmtResult.ms}ms)\n${fmtResult.output}`,
      );
      return 1;
    }
  }

  let tokensGateResult: TaskResult | null = null;
  if (
    gitAvailable &&
    changed.some(
      (f) => f.startsWith("design/") || f.startsWith("lib/gen_tokens/"),
    )
  ) {
    tokensGateResult = await runTask("gen:tokens:gate", [
      "bun",
      "run",
      "scripts/gen_tokens_gate.ts",
    ]);
    if (!tokensGateResult.ok) {
      console.error(
        `✗ ${tokensGateResult.name} (${tokensGateResult.ms}ms)\n${tokensGateResult.output}`,
      );
      return 1;
    }
  }

  const oxlintCmd = resolveOxlintCmd();
  const workspaceGraph = analyzeWorkspaceGraph(await inspectWorkspaces(ROOT));
  const typecheckSpecs = planTypecheckTasks(changed, {
    hasRootBlast,
    edges: workspaceGraph.edges,
  });

  // Phase 2: Parallel workspace-scoped typecheck + scoped lint + targeted tests
  const tasks: Promise<TaskResult>[] = typecheckSpecs.map((spec) =>
    runTask(spec.name, spec.cmd),
  );

  if (lintTargets.length > 0 && oxlintCmd !== null) {
    tasks.push(
      runTask(`oxlint (${lintTargets.length})`, [
        ...oxlintCmd,
        "--deny-warnings",
        ...lintTargets,
      ]),
    );
  }

  if (values.deep && oxlintCmd !== null) {
    tasks.push(
      runTask("oxlint:type-aware", [
        ...oxlintCmd,
        "--type-aware",
        "-c",
        ".oxlintrc.type-aware.json",
        "--deny-warnings",
      ]),
    );
  }

  if (changed.some((f) => f.startsWith("packages/nsh-desk/"))) {
    const { tryResolveNshBinary } = await import("./nsh_desk_cli.ts");
    const nsh = await tryResolveNshBinary(ROOT);
    if (nsh !== null) {
      tasks.push(
        runTask("nsh:check", [
          "bun",
          "run",
          "scripts/nsh_desk_cli.ts",
          "check",
        ]),
      );
    }
  }

  if (
    changed.some(
      (f) =>
        f === "lib/secret_manifest.ts" ||
        f === "types/env.d.ts" ||
        f.includes("secret"),
    )
  ) {
    tasks.push(
      runTask("audit:secrets", ["bun", "run", "scripts/audit_secrets.ts"]),
    );
  }

  // Smart test step: NEVER run all 520+ suites in the inner loop.
  if (values.shard) {
    tasks.push(
      runTask(
        "test:shard (1/8)",
        ["bun", "test", "--parallel", "--shard=1/8"],
        {
          PRETEST_SKIP: "1",
        },
      ),
    );
  } else if (positionals.length > 0 || !gitAvailable || hasRootBlast) {
    if (inferredTests.length > 0) {
      tasks.push(
        runTask(
          `test:targeted (${inferredTests.length})`,
          ["bun", "test", "--parallel", ...inferredTests],
          { PRETEST_SKIP: "1" },
        ),
      );
    } else if (hasRootBlast) {
      tasks.push(
        runTask(
          "test:shard (1/8)",
          ["bun", "test", "--parallel", "--shard=1/8"],
          { PRETEST_SKIP: "1" },
        ),
      );
    }
  } else if (changed.length > 0) {
    tasks.push(
      runTask("test:changed", ["bun", "test", "--parallel", "--changed"], {
        PRETEST_SKIP: "1",
      }),
    );
  }

  const results = await Promise.all(tasks);
  const all = [
    ...(fmtResult ? [fmtResult] : []),
    ...(tokensGateResult ? [tokensGateResult] : []),
    ...results,
  ];
  const failures = all.filter((r) => !r.ok);
  const totalSec = ((performance.now() - started) / 1000).toFixed(2);

  const summary = all
    .map((r) => `${r.ok ? "✓" : "✗"} ${r.name} ${r.ms}ms`)
    .join(" · ");

  if (failures.length === 0) {
    console.log(`${summary} — OK in ${totalSec}s`);
    return 0;
  }

  console.error(`${summary} — FAILED (${failures.length}) in ${totalSec}s\n`);
  for (const f of failures) {
    console.error(`── ✗ ${f.name} (${f.ms}ms) ──\n${f.output}\n`);
  }
  return 1;
}

if (import.meta.main) {
  process.exit(await main());
}
