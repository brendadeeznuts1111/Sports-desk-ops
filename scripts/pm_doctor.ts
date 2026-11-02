#!/usr/bin/env bun
/**
 * Checks that this machine's Bun package-manager setup is the one the repo assumes: the pinned
 * runtime, the live global bunfig and its install policy, the lockfile, the installed tree, and
 * the override file that `bun run deps` uses. Read-only; never installs.
 *
 *   bun run pm:doctor           table, exit 1 on any failure
 *   bun run pm:doctor --json    the same checks as JSON
 */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  FOREIGN_LOCKFILES,
  globalBunfigPath,
  lockWorkspaceNames,
  MACHINE_OWNED_INSTALL_KEYS,
} from "../lib/pm_policy.ts";

type Status = "ok" | "warn" | "fail";
type Check = { name: string; status: Status; detail: string };

const ROOT = path.join(import.meta.dir, "..");
const HOME = Bun.env.HOME ?? "";
const UNFROZEN = path.join(HOME, "dotfiles/bun/unfrozen.bunfig.toml");
const USAGE = "usage: bun run pm:doctor [--json]";

function parseCli() {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      options: { json: { type: "boolean", default: false } },
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
    const { expected, locked } = await lockWorkspaceNames(ROOT);
    const drift = [
      ...new Set([...Object.keys(expected), ...Object.keys(locked)]),
    ]
      .filter((dir) => expected[dir] !== locked[dir])
      .map(
        (dir) => `${dir || "<root>"}: lock ${locked[dir]} vs ${expected[dir]}`,
      );
    checks.push(
      check(
        "lock workspaces",
        drift.length === 0,
        drift.length === 0
          ? `${Object.keys(expected).length} match package.json`
          : `${drift.join("; ")}; regenerate bun.lock from scratch`,
      ),
    );
  }
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
  if (!existsSync(UNFROZEN)) {
    return [
      check("deps override", false, `${UNFROZEN} missing: bun run deps fails`),
    ];
  }
  const install = (await readInstall(UNFROZEN)) ?? {};
  const extra = Object.keys(install).filter((key) => key !== "frozenLockfile");
  return [
    check(
      "deps override",
      install.frozenLockfile === false && extra.length === 0,
      extra.length === 0
        ? UNFROZEN
        : `${UNFROZEN} also sets ${extra.join(", ")}`,
    ),
  ];
}

const values = parseCli();
const checks = [
  ...(await runtimeChecks()),
  ...(await globalConfigChecks()),
  ...(await projectChecks()),
  ...(await overrideChecks()),
];
const failed = checks.filter((c) => c.status === "fail").length;

if (values.json) {
  console.log(JSON.stringify({ ok: failed === 0, checks }, null, 2));
} else {
  const mark: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    console.log(`${mark[c.status]} ${c.name.padEnd(width)}  ${c.detail}`);
  }
  console.log(
    failed === 0
      ? `\npm:doctor: ${checks.length} checks, none failed`
      : `\npm:doctor: ${failed} of ${checks.length} checks failed`,
  );
}
process.exit(failed === 0 ? 0 : 1);
