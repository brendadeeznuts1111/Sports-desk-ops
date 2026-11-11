#!/usr/bin/env bun
/**
 * Checks that this machine's Bun package-manager setup is the one the repo assumes: the pinned
 * runtime, the live global bunfig and its install policy, the lockfile, the installed tree, and
 * the `bun-deps` command and its override file. Read-only; never installs.
 *
 *   bun run pm:doctor           table, exit 1 on any failure
 *   bun run pm:doctor --json    the same checks as JSON
 */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  analyzeWorkspaceGraph,
  auditRootWorkspaceHygiene,
  auditWorkspaceSelfContainment,
  FOREIGN_LOCKFILES,
  globalBunfigPath,
  inspectWorkspaceInstallLayout,
  inspectWorkspaces,
  lockWorkspaceDependencies,
  lockWorkspaceNames,
  lockWorkspaceVersions,
  MACHINE_OWNED_INSTALL_KEYS,
  patchState,
} from "../lib/pm_policy.ts";

type Status = "ok" | "warn" | "fail";
type Check = { name: string; status: Status; detail: string };

const ROOT = path.join(import.meta.dir, "..");
const HOME = Bun.env.HOME ?? "";
const UNFROZEN = path.join(HOME, "dotfiles/bun/unfrozen.bunfig.toml");
const USAGE = "usage: bun run pm:doctor [--json] [--only <name,name>]";

function parseCli() {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      options: {
        json: { type: "boolean", default: false },
        only: { type: "string" },
      },
      strict: true,
    }).values;
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    process.exit(2);
  }
}

type Install = Record<string, unknown>;

async function readInstall(file: string): Promise<Install | undefined> {
  const config = Bun.TOML.parse(await Bun.file(file).text()) as {
    install?: Install;
  };
  return config.install;
}

function check(name: string, ok: boolean, detail: string): Check {
  return { name, status: ok ? "ok" : "fail", detail };
}

function drift(
  expected: Readonly<Record<string, string | undefined>>,
  locked: Readonly<Record<string, string | undefined>>,
): string[] {
  return [...new Set([...Object.keys(expected), ...Object.keys(locked)])]
    .filter((key) => expected[key] !== locked[key])
    .map(
      (key) => `${key || "<root>"}: lock ${locked[key]} vs ${expected[key]}`,
    );
}

async function runtimeChecks(): Promise<Check[]> {
  const pkg = (await Bun.file(path.join(ROOT, "package.json")).json()) as {
    packageManager?: string;
    engines?: { bun?: string };
    trustedDependencies?: unknown;
  };
  const pin = pkg.engines?.bun ?? "<unset>";
  return [
    check(
      "runtime pin",
      Bun.version === pin && pkg.packageManager === `bun@${pin}`,
      `bun ${Bun.version}; engines ${pin}; packageManager ${pkg.packageManager}`,
    ),
    check(
      "lifecycle scripts",
      Array.isArray(pkg.trustedDependencies) &&
        pkg.trustedDependencies.length === 0,
      `trustedDependencies ${JSON.stringify(pkg.trustedDependencies)}`,
    ),
  ];
}

async function globalConfigChecks(): Promise<Check[]> {
  const live = globalBunfigPath(Bun.env);
  if (!existsSync(live)) {
    return [
      check(
        "global bunfig",
        false,
        `${live} missing: installs run with Bun's defaults`,
      ),
    ];
  }
  const checks = [check("global bunfig", true, live)];
  const other = path.join(HOME, ".bunfig.toml");
  if (
    other !== live &&
    existsSync(other) &&
    realpathSync(other) !== realpathSync(live)
  ) {
    checks.push({
      name: "inert bunfig",
      status: "warn",
      detail: `${other} differs from the live file and is never read`,
    });
  }
  const install = (await readInstall(live)) ?? {};
  const age = install.minimumReleaseAge;
  checks.push(
    check(
      "frozen lockfile",
      install.frozenLockfile === true,
      `frozenLockfile = ${String(install.frozenLockfile)}`,
    ),
    check(
      "isolated linker",
      install.linker === "isolated",
      `linker = ${String(install.linker)}`,
    ),
    check(
      "release age gate",
      (typeof age === "number" && age > 0) ||
        (typeof age === "string" && age !== "" && age !== "0"),
      `minimumReleaseAge = ${String(age)}`,
    ),
  );
  return checks;
}

async function projectChecks(): Promise<Check[]> {
  const install = (await readInstall(path.join(ROOT, "bunfig.toml"))) ?? {};
  const overridden = MACHINE_OWNED_INSTALL_KEYS.filter(
    (key) => install[key] !== undefined,
  );
  const foreign = FOREIGN_LOCKFILES.filter((file) =>
    existsSync(path.join(ROOT, file)),
  );
  const checks = [
    check(
      "project bunfig",
      overridden.length === 0,
      overridden.length === 0
        ? "no machine-owned install keys"
        : `overrides ${overridden.join(", ")}`,
    ),
    check(
      "lockfile",
      existsSync(path.join(ROOT, "bun.lock")) && foreign.length === 0,
      foreign.length === 0 ? "bun.lock only" : `also ${foreign.join(", ")}`,
    ),
  ];
  if (existsSync(path.join(ROOT, "bun.lock"))) {
    const names = await lockWorkspaceNames(ROOT);
    const nameDrift = drift(names.expected, names.locked);
    checks.push(
      check(
        "lock workspaces",
        nameDrift.length === 0,
        nameDrift.length === 0
          ? `${Object.keys(names.expected).length} match package.json`
          : `${nameDrift.join("; ")}; regenerate bun.lock from scratch`,
      ),
    );
    const versions = await lockWorkspaceVersions(ROOT);
    const versionDrift = drift(versions.expected, versions.locked);
    checks.push(
      check(
        "lock versions",
        versionDrift.length === 0,
        versionDrift.length === 0
          ? "workspace versions match package.json"
          : `${versionDrift.join("; ")}; run bun-deps install`,
      ),
    );
    const patches = await patchState(ROOT);
    const patchDrift = drift(patches.declared, patches.locked);
    const count = Object.keys(patches.declared).length;
    checks.push(
      check(
        "patches",
        patchDrift.length === 0 && patches.missing.length === 0,
        patches.missing.length > 0
          ? `missing ${patches.missing.join(", ")}`
          : patchDrift.length > 0
            ? `${patchDrift.join("; ")}; run bun-deps install`
            : count === 0
              ? "none declared"
              : `${count} declared, in bun.lock and on disk`,
      ),
    );
  }
  const inspection = await inspectWorkspaces(ROOT);
  const { nameless } = inspection;
  if (nameless.length > 0) {
    checks.push({
      name: "nameless workspace",
      status: "warn",
      detail: `${nameless.join(", ")}: no "name", so Bun skips it`,
    });
  }
  const rootHygiene = await auditRootWorkspaceHygiene(ROOT);
  checks.push(check("root private", rootHygiene.ok, rootHygiene.detail));
  checks.push(
    check(
      "workspace dirs",
      inspection.unregisteredDirs.length === 0,
      inspection.unregisteredDirs.length === 0
        ? `${inspection.packages.length - 1} package(s) under ${inspection.patterns.join(", ") || "<none>"}`
        : `missing package.json in ${inspection.unregisteredDirs.join(", ")}`,
    ),
  );
  const graph = analyzeWorkspaceGraph(inspection);
  const depLockDrift = existsSync(path.join(ROOT, "bun.lock"))
    ? (await lockWorkspaceDependencies(ROOT)).drift
    : [];
  const graphProblems = [...graph.issues.map((i) => i.detail), ...depLockDrift];
  checks.push(
    check(
      "workspace graph",
      graphProblems.length === 0,
      graphProblems.length === 0
        ? `${graph.edges.length} workspace:* link(s), ${graph.waves.length} wave(s), 0 cycles`
        : graphProblems.join("; "),
    ),
  );
  const selfContainment = await auditWorkspaceSelfContainment(ROOT);
  const layout = await inspectWorkspaceInstallLayout(ROOT);
  const containmentProblems = [
    ...selfContainment.undeclaredImports.map(
      (u) => `${u.file} imports undeclared "${u.packageName}"`,
    ),
    ...layout.nshVersionDrift,
    ...layout.workspaceLinks.flatMap((w) =>
      w.brokenLinks.map((b) => `${w.dir}/node_modules/${b} broken symlink`),
    ),
  ];
  checks.push(
    check(
      "self-contained packages",
      containmentProblems.length === 0,
      containmentProblems.length === 0
        ? `Bun.Transpiler scanned ${selfContainment.scannedFiles} workspace file(s) (${selfContainment.scannedImports} imports, 0 undeclared)`
        : containmentProblems.join("; "),
    ),
  );
  const modules = path.join(ROOT, "node_modules");
  checks.push(
    !existsSync(modules)
      ? { name: "installed tree", status: "warn", detail: "not installed" }
      : check(
          "installed tree",
          existsSync(path.join(modules, ".bun")),
          existsSync(path.join(modules, ".bun"))
            ? "isolated (node_modules/.bun)"
            : "hoisted: reinstall with the global config live",
        ),
  );
  return checks;
}

async function overrideChecks(): Promise<Check[]> {
  const command = Bun.which("bun-deps");
  const checks = [
    check(
      "bun-deps command",
      command !== null,
      command ??
        "not on PATH: link ~/dotfiles/shell/bin/bun-deps into ~/.local/bin",
    ),
  ];
  if (!existsSync(UNFROZEN)) {
    checks.push(
      check("deps override", false, `${UNFROZEN} missing: bun-deps fails`),
    );
    return checks;
  }
  const install = (await readInstall(UNFROZEN)) ?? {};
  const extra = Object.keys(install).filter((key) => key !== "frozenLockfile");
  checks.push(
    check(
      "deps override",
      install.frozenLockfile === false && extra.length === 0,
      extra.length === 0
        ? UNFROZEN
        : `${UNFROZEN} also sets ${extra.join(", ")}`,
    ),
  );
  return checks;
}

async function npmrcLines(): Promise<string[]> {
  const lines: string[] = [];
  for (const file of [
    path.join(ROOT, ".npmrc"),
    path.join(Bun.env.HOME ?? "", ".npmrc"),
  ]) {
    if (!existsSync(file)) continue;
    lines.push(...(await Bun.file(file).text()).split("\n"));
  }
  return lines.map((line) => line.trim());
}

/** Warn-level: a scoped registry only matters when installing or publishing that scope. */
async function registryChecks(): Promise<Check[]> {
  const lines = await npmrcLines();
  const checks: Check[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const [, scope, url] = /^(@[\w.-]+):registry\s*=\s*(\S+)$/.exec(line) ?? [];
    if (scope === undefined || url === undefined || seen.has(scope)) continue;
    seen.add(scope);
    const base = url.endsWith("/") ? url : `${url}/`;
    const host = base.replace(/^https?:/, "");
    const tokenVar = lines
      .map((l) => /^(\S+):_authToken\s*=\s*\$\{(\w+)\}$/.exec(l) ?? [])
      .find(
        ([, prefix]) => prefix !== undefined && host.startsWith(prefix),
      )?.[2];
    if (tokenVar !== undefined && !Bun.env[tokenVar]) {
      checks.push({
        name: `${scope} token`,
        status: "warn",
        detail: `${tokenVar} is unset: publish and installs from ${scope} fail`,
      });
    }
    const reachable = await fetch(`${base}-/ping`, {
      signal: AbortSignal.timeout(2000),
    }).then(
      (res) => res.ok,
      () => false,
    );
    checks.push(
      reachable
        ? { name: `${scope} registry`, status: "ok", detail: base }
        : {
            name: `${scope} registry`,
            status: "warn",
            detail: `${base} unreachable: publish and installs from ${scope} fail`,
          },
    );
  }
  return checks;
}

const values = parseCli();
const only = (values.only ?? "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter((entry) => entry.length > 0);
/**
 * Registry probes hit the network (2 s each), so a filtered run skips them
 * unless the filter asks for them. `--only lock` stays offline.
 */
const needsRegistry =
  only.length === 0 ||
  only.some(
    (entry) =>
      entry.includes("registry") ||
      entry.includes("token") ||
      entry.startsWith("@"),
  );
const checks = [
  ...(await runtimeChecks()),
  ...(await globalConfigChecks()),
  ...(await projectChecks()),
  ...(await overrideChecks()),
  ...(needsRegistry ? await registryChecks() : []),
];
const selected =
  only.length === 0
    ? checks
    : checks.filter((c) =>
        only.some((entry) => c.name.toLowerCase().includes(entry)),
      );
if (selected.length === 0) {
  console.error(
    `no checks match --only ${only.join(",")}; known names: ${checks
      .map((c) => c.name)
      .join(", ")}`,
  );
  process.exit(2);
}
const failed = selected.filter((c) => c.status === "fail").length;

if (values.json) {
  console.log(JSON.stringify({ ok: failed === 0, checks: selected }, null, 2));
} else {
  const mark: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };
  const width = Math.max(...selected.map((c) => c.name.length));
  for (const c of selected) {
    console.log(`${mark[c.status]} ${c.name.padEnd(width)}  ${c.detail}`);
  }
  console.log(
    failed === 0
      ? `\npm:doctor: ${selected.length} checks, none failed`
      : `\npm:doctor: ${failed} of ${selected.length} checks failed`,
  );
}
process.exit(failed === 0 ? 0 : 1);
