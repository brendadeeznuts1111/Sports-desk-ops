import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Package-manager policy, from the machine config and Bun's docs.
 *
 * `~/.bunfig.toml` states the rule directly: "Project bunfig.toml must not set linker, globalStore,
 * cache.dir, or age keys." Those are machine-owned so every project shares one install policy; a
 * project copy is redundant at best and divergent at worst.
 *
 * `trustedDependencies` is pinned to an empty list so lifecycle scripts never run on install, rather
 * than inheriting Bun's built-in allow list (docs/pm/lifecycle: omitted = default list).
 */
const MACHINE_OWNED_INSTALL_KEYS = [
  "linker",
  "globalStore",
  "cache",
  "frozenLockfile",
  "minimumReleaseAge",
] as const;

describe("package manager policy", () => {
  test("the project bunfig does not set machine-owned install keys", () => {
    const config = Bun.TOML.parse(readFileSync("bunfig.toml", "utf8")) as {
      install?: Record<string, unknown>;
    };
    for (const key of MACHINE_OWNED_INSTALL_KEYS) {
      expect(config.install?.[key]).toBeUndefined();
    }
  });

  test("lifecycle scripts are not trusted implicitly", async () => {
    const pkg = (await Bun.file("package.json").json()) as {
      trustedDependencies?: unknown;
    };
    expect(pkg.trustedDependencies).toEqual([]);
  });

  test("package manager and engine match the runtime", async () => {
    const pkg = (await Bun.file("package.json").json()) as {
      packageManager?: string;
      engines?: { bun?: string };
    };
    const engine = pkg.engines?.bun ?? "";
    expect(pkg.packageManager).toBe(`bun@${engine}`);
    expect(Bun.semver.satisfies(Bun.version, engine)).toBe(true);
  });

  test("the lockfile is the text format and is the only one", async () => {
    expect(await Bun.file("bun.lock").exists()).toBe(true);
    for (const other of [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lockb",
    ]) {
      expect(await Bun.file(other).exists()).toBe(false);
    }
  });

  test("the lockfile's workspaces match the package.json files", async () => {
    // Bun 1.4.4 never rewrites a renamed package in an existing bun.lock, and a frozen install
    // does not compare names, so drift here survives every install until the lock is regenerated.
    const lock = Bun.JSONC.parse(await Bun.file("bun.lock").text()) as {
      workspaces: Record<string, { name?: string }>;
    };
    const root = (await Bun.file("package.json").json()) as {
      name: string;
      workspaces: string[];
    };
    const expected: Record<string, string> = { "": root.name };
    for (const pattern of root.workspaces) {
      for await (const manifest of new Bun.Glob(`${pattern}/package.json`).scan(
        ".",
      )) {
        const pkg = (await Bun.file(manifest).json()) as { name: string };
        expected[manifest.slice(0, -"/package.json".length)] = pkg.name;
      }
    }
    const actual = Object.fromEntries(
      Object.entries(lock.workspaces).map(([path, ws]) => [path, ws.name]),
    );
    expect(actual).toEqual(expected);
  });

  test("the registry scope is declared without a token", async () => {
    const npmrc = await Bun.file(".npmrc").text();
    expect(npmrc).toContain("@tennis-hq:registry=");
    expect(npmrc).not.toContain("_authToken");
  });
});
