import { describe, expect, test } from "bun:test";
import bunfig from "../bunfig.toml" with { type: "toml" };
import pkg from "../package.json";
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
  auditTrustedDependencies,
  evaluateTrustedDependenciesPolicy,
  patchState,
  TRUSTED_DEPENDENCIES_POLICY,
} from "../lib/pm_policy.ts";

/**
 * Package-manager policy, from the machine config and Bun's docs.
 *
 * `~/.bunfig.toml` states the rule directly: "Project bunfig.toml must not set linker, globalStore,
 * cache.dir, or age keys." Those are machine-owned so every project shares one install policy; a
 * project copy is redundant at best and divergent at worst.
 *
 * `trustedDependencies` is pinned to an empty list so lifecycle scripts never run on install, rather
 * than inheriting Bun's built-in allow list: defining the field *replaces* that list instead of
 * extending it, and `[]` is the documented opt-out (docs/pm/lifecycle §"Behavior of the
 * `trustedDependencies` field"). Measured 2026-11-11 on Bun 1.4.4: registry `esbuild@0.25.0` is
 * trusted when the field is omitted and blocked when it is `[]`; a `file:` dependency whose name
 * matches the list is never trusted, by design.
 */

describe("package manager policy", () => {
  test("the project bunfig does not set machine-owned install keys", () => {
    const config = bunfig as {
      install?: Record<string, unknown>;
    };
    for (const key of MACHINE_OWNED_INSTALL_KEYS) {
      expect(config.install?.[key]).toBeUndefined();
    }
  });

  test("lifecycle scripts are not trusted implicitly", () => {
    // The cast is for the JSON literal: `trustedDependencies: []` infers `never[]`, and `toEqual`
    // binds its expected type to the received one (`toEqual(expected: T)`), so the policy
    // constant's `readonly string[]` is not assignable to the field's `never[]`. The cast changes
    // the received type to `readonly string[]`; `readonly` was never the blocker.
    expect(pkg.trustedDependencies as readonly string[]).toEqual(
      TRUSTED_DEPENDENCIES_POLICY,
    );
  });

  test("trustedDependencies is empty in manifest and lock", async () => {
    const audit = await auditTrustedDependencies(".");
    expect(audit.ok).toBe(true);
    expect(audit.sources.manifest).toEqual([]);
    expect(audit.sources.lock).toEqual([]);
  });

  test("non-empty trustedDependencies fails the policy", () => {
    const blocked = evaluateTrustedDependenciesPolicy({
      manifestRaw: ["sharp"],
      lockRaw: ["sharp"],
    });
    expect(blocked.ok).toBe(false);
    expect(
      blocked.issues.some((i) => i.includes("manifest must opt out")),
    ).toBe(true);
  });

  test("manifest/lock trustedDependencies drift fails the policy", () => {
    const drift = evaluateTrustedDependenciesPolicy({
      manifestRaw: [],
      lockRaw: ["node-sass"],
    });
    expect(drift.ok).toBe(false);
    expect(drift.issues.some((i) => i.includes("drift"))).toBe(true);
    expect(drift.issues.some((i) => i.includes("lock must match"))).toBe(true);
  });

  test.skip("bun link --trust writes a non-empty list (regression hazard)", async () => {
    // Fixture would run `bun link --trust <pkg>` against trustedDependencies: [].
    // Policy violation when manifest becomes ["pkg"] and default allow list is replaced.
  });

  test("package manager and engine match the runtime", () => {
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

  test("root manifest is private and every packages/* directory is a registered workspace", async () => {
    const hygiene = await auditRootWorkspaceHygiene(".");
    expect(hygiene.rootPrivate).toBe(true);
    expect(hygiene.ok).toBe(true);

    const inspection = await inspectWorkspaces(".");
    expect(inspection.nameless).toEqual([]);
    expect(inspection.unregisteredDirs).toEqual([]);
    expect(inspection.packages.map((p) => p.dir)).toEqual([
      "",
      "packages/ba-example",
      "packages/nsh-desk",
      "packages/sportsdesk-ops",
    ]);
  });

  test("workspace:* dependency graph is acyclic, lock-synced, and self-contained", async () => {
    const inspection = await inspectWorkspaces(".");
    const graph = analyzeWorkspaceGraph(inspection);
    expect(graph.issues).toEqual([]);
    expect(graph.cycles).toEqual([]);

    const depSync = await lockWorkspaceDependencies(".");
    expect(depSync.drift).toEqual([]);

    const containment = await auditWorkspaceSelfContainment(".");
    expect(containment.undeclaredImports).toEqual([]);

    const layout = await inspectWorkspaceInstallLayout(".");
    expect(layout.nshVersionDrift).toEqual([]);
  });
});
