import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  FOREIGN_LOCKFILES,
  globalBunfigPath,
  lockWorkspaceNames,
  lockWorkspaceVersions,
  MACHINE_OWNED_INSTALL_KEYS,
  patchState,
} from "../lib/pm_policy.ts";

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
    for (const other of FOREIGN_LOCKFILES) {
      expect(await Bun.file(other).exists()).toBe(false);
    }
  });

  test("the lockfile's workspaces match the package.json files", async () => {
    const { expected, locked } = await lockWorkspaceNames(".");
    expect(locked).toEqual(expected);
  });

  test("the lockfile's workspace versions match the package.json files", async () => {
    const { expected, locked } = await lockWorkspaceVersions(".");
    expect(locked).toEqual(expected);
  });

  test("every declared patch is in the lockfile and on disk", async () => {
    const { declared, locked, missing } = await patchState(".");
    expect(locked).toEqual(declared);
    expect(missing).toEqual([]);
  });

  test("the global bunfig path follows XDG_CONFIG_HOME only when it is absolute", () => {
    expect(globalBunfigPath({ HOME: "/h", XDG_CONFIG_HOME: "/x" })).toBe(
      "/x/.bunfig.toml",
    );
    expect(globalBunfigPath({ HOME: "/h", XDG_CONFIG_HOME: "rel" })).toBe(
      "/h/.bunfig.toml",
    );
    expect(globalBunfigPath({ HOME: "/h" })).toBe("/h/.bunfig.toml");
  });

  test("the registry scope is declared without a token", async () => {
    const npmrc = await Bun.file(".npmrc").text();
    expect(npmrc).toContain("@tennis-hq:registry=");
    expect(npmrc).not.toContain("_authToken");
  });
});
