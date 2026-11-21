import { describe, expect, test } from "bun:test";
import bunfig from "../bunfig.toml" with { type: "toml" };
import oxlintConfig from "../.oxlintrc.json" with { type: "json" };
import oxlintTypeAwareConfig from "../.oxlintrc.type-aware.json" with { type: "json" };
import pkg from "../package.json";
import {
  analyzeWorkspaceGraph,
  auditRootWorkspaceHygiene,
  auditWorkspaceSelfContainment,
  FOREIGN_LOCKFILES,
  globalBunfigPath,
  inspectWorkspaceInstallLayout,
  inspectWorkspaces,
  invalidReleaseAgeExcludes,
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

  test("the age-gate exemption list is machine-owned too", () => {
    // `minimumReleaseAgeExcludes` is the other half of the gate: a project copy would override the
    // machine's vetted exemptions, so it cannot be a project key.
    expect(MACHINE_OWNED_INSTALL_KEYS).toContain("minimumReleaseAgeExcludes");
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

  test("no loopback registry or auth token is committed", async () => {
    // The old committed .npmrc routed @tennis-hq at 127.0.0.1:50851, a registry
    // that never ran. Registry and token configuration belongs in the user-level
    // ~/.npmrc (see docs/runbooks/bun-pm-policy.md); this guard keeps a dead
    // loopback route from returning. Measured 2026-11-14.
    const npmrc = Bun.file(".npmrc");
    if (await npmrc.exists()) {
      const text = await npmrc.text();
      expect(text).not.toMatch(/127\.0\.0\.1|localhost/);
      expect(text).not.toContain("_authToken");
    }
    const pkg = await Bun.file("package.json").json();
    const registry = pkg.publishConfig?.registry ?? "";
    expect(registry).not.toMatch(/127\.0\.0\.1|localhost/);
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
      "packages/api",
      "packages/ba-example",
      "packages/backend",
      "packages/contracts",
      "packages/nsh-desk",
      "packages/sportsdesk-ops",
      "packages/ui",
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

/**
 * `minimumReleaseAgeExcludes` grammar: a bare name exempts every version, `name@x.y.z`
 * exempts only that release, and Bun drops anything else **with a warning only** — the
 * package stays gated while the config reads as if it were exempt. `pm:doctor` exposes
 * that silent drop as `release age excludes`.
 */
describe("minimumReleaseAgeExcludes", () => {
  test("accepts the bare-name and exact-version forms Bun honours", () => {
    expect(invalidReleaseAgeExcludes([])).toEqual([]);
    expect(
      invalidReleaseAgeExcludes(["typescript", "@types/node", "bun-types"]),
    ).toEqual([]);
    expect(
      invalidReleaseAgeExcludes(["typescript@5.4.5", "@types/node@20.11.0"]),
    ).toEqual([]);
    expect(invalidReleaseAgeExcludes(["esbuild@0.21.4 || 0.21.5"])).toEqual([]);
    expect(
      invalidReleaseAgeExcludes(["pkg@1.2.3-rc.1", "pkg@1.2.3+build.5"]),
    ).toEqual([]);
  });

  test("reports the entries Bun would ignore", () => {
    expect(
      invalidReleaseAgeExcludes([
        "typescript@^5",
        "typescript@latest",
        "typescript@",
      ]),
    ).toEqual(["typescript@^5", "typescript@latest", "typescript@"]);
    expect(invalidReleaseAgeExcludes(["ok", "pkg@1.2.3 || latest"])).toEqual([
      "pkg@1.2.3 || latest",
    ]);
  });

  test("treats a non-list value as no exclusions rather than a config error", () => {
    expect(invalidReleaseAgeExcludes(undefined)).toEqual([]);
    expect(invalidReleaseAgeExcludes("typescript")).toEqual([]);
    expect(invalidReleaseAgeExcludes({})).toEqual([]);
  });
});

interface RootBunfigShape {
  readonly fmt: {
    readonly printWidth: number;
    readonly tabWidth: number;
    readonly useTabs: boolean;
    readonly semi: boolean;
    readonly singleQuote: boolean;
    readonly ignorePatterns: readonly string[];
    readonly overrides: readonly {
      readonly files: string | readonly string[];
      readonly options: { readonly sortImports?: boolean };
    }[];
  };
  readonly install: {
    readonly exact: boolean;
    readonly ignoreScripts: boolean;
  };
  readonly lint: {
    readonly ignorePatterns: readonly string[];
    readonly categories: Readonly<Record<string, string>>;
    readonly rules: Readonly<Record<string, unknown>>;
  };
  readonly run: {
    readonly noOrphans: boolean;
  };
  readonly console: {
    readonly depth: number;
  };
  readonly test: {
    readonly pathIgnorePatterns: readonly string[];
    readonly coverageReporter: readonly string[];
    readonly coverageDir: string;
    readonly coverageSkipTestFiles: boolean;
    readonly coveragePathIgnorePatterns: string | readonly string[];
  };
}

const LINT_SEVERITY_PATTERN = /^(off|warn|error)$/;

const normalizeRuleName = (name: string): string =>
  name.replace(/^@typescript-eslint\//, "typescript/");

function normalizedRuleMap(
  rules: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, unknown> {
  const mapped = new Map<string, unknown>();
  for (const [name, value] of Object.entries(rules)) {
    mapped.set(normalizeRuleName(name), value);
  }
  return mapped;
}

describe("root bunfig.toml contract", () => {
  const parsedBunfig = bunfig as unknown as RootBunfigShape;

  test("top-level section allowlist and property-matcher schema", () => {
    expect(Object.keys(bunfig).sort()).toEqual([
      "console",
      "fmt",
      "install",
      "lint",
      "run",
      "test",
    ]);

    // Clone before toMatchObject: bun:test replaces matched properties on the received
    // object in place with asymmetric matchers (e.g. `expect.any(...)`).
    expect(structuredClone(parsedBunfig)).toMatchObject({
      fmt: {
        printWidth: expect.any(Number),
        tabWidth: expect.any(Number),
        useTabs: expect.any(Boolean),
        semi: expect.any(Boolean),
        singleQuote: expect.any(Boolean),
        ignorePatterns: expect.arrayContaining([expect.any(String)]),
        overrides: expect.arrayContaining([
          expect.objectContaining({
            files: expect.arrayContaining([expect.any(String)]),
            options: expect.objectContaining({
              sortImports: expect.any(Boolean),
            }),
          }),
        ]),
      },
      install: {
        exact: expect.any(Boolean),
        ignoreScripts: expect.any(Boolean),
      },
      lint: {
        ignorePatterns: expect.arrayContaining([expect.any(String)]),
        categories: {
          correctness: expect.stringMatching(LINT_SEVERITY_PATTERN),
        },
        rules: expect.any(Object),
      },
      run: {
        noOrphans: expect.any(Boolean),
      },
      console: {
        depth: expect.any(Number),
      },
      test: {
        pathIgnorePatterns: expect.arrayContaining([expect.any(String)]),
        coverageReporter: expect.arrayContaining(["text", "lcov"]),
        coverageDir: expect.any(String),
        coverageSkipTestFiles: expect.any(Boolean),
        coveragePathIgnorePatterns: expect.arrayContaining([
          expect.any(String),
        ]),
      },
    });
  });

  test("pins [fmt], [install], [run], [console], and [test] root policy values", () => {
    expect(parsedBunfig.fmt.printWidth).toBe(80);
    expect(parsedBunfig.fmt.tabWidth).toBe(2);
    expect(parsedBunfig.fmt.useTabs).toBe(false);
    expect(parsedBunfig.fmt.semi).toBe(true);
    expect(parsedBunfig.fmt.singleQuote).toBe(false);
    expect(parsedBunfig.fmt.ignorePatterns).toContain(
      "verification/manager-boot-oracle/pinned/*.js",
    );
    expect(parsedBunfig.fmt.ignorePatterns).toContain(
      "data/profile-snapshot.json",
    );
    expect(parsedBunfig.fmt.overrides.length).toBeGreaterThan(0);
    for (const override of parsedBunfig.fmt.overrides) {
      const files = Array.isArray(override.files)
        ? override.files
        : [override.files];
      expect(files.length).toBeGreaterThan(0);
      expect(override.options.sortImports).toBe(true);
    }

    expect(parsedBunfig.install.exact).toBe(true);
    expect(parsedBunfig.install.ignoreScripts).toBe(true);

    expect(parsedBunfig.run.noOrphans).toBe(true);

    expect(parsedBunfig.console.depth).toBe(8);
    expect(Number.isInteger(parsedBunfig.console.depth)).toBe(true);
    expect(parsedBunfig.console.depth).toBeGreaterThanOrEqual(0);

    for (const pattern of [
      "scratch/**",
      "tests/fixtures/**",
      "packages/nsh-desk/**",
      "scripts/author_openapi_spec.mjs",
    ]) {
      expect(parsedBunfig.test.pathIgnorePatterns).toContain(pattern);
    }
    expect(parsedBunfig.test.coverageReporter).toEqual(["text", "lcov"]);
    expect(parsedBunfig.test.coverageDir).toBe("coverage");
    expect(parsedBunfig.test.coverageSkipTestFiles).toBe(true);
    const covIgnore = Array.isArray(
      parsedBunfig.test.coveragePathIgnorePatterns,
    )
      ? parsedBunfig.test.coveragePathIgnorePatterns
      : [parsedBunfig.test.coveragePathIgnorePatterns];
    for (const pattern of ["tests/**", "dist/**", "docs/**"]) {
      expect(covIgnore).toContain(pattern);
    }
  });

  test("[lint] parsed TOML stays in parity with .oxlintrc.json and .oxlintrc.type-aware.json", () => {
    expect(parsedBunfig.lint.ignorePatterns).toEqual(
      oxlintConfig.ignorePatterns,
    );
    expect(parsedBunfig.lint.categories).toEqual(oxlintConfig.categories);

    for (const value of Object.values(parsedBunfig.lint.rules)) {
      if (typeof value === "string") {
        expect(value).toMatch(LINT_SEVERITY_PATTERN);
      } else {
        expect(Array.isArray(value)).toBe(true);
        const tuple = value as readonly unknown[];
        expect(tuple).toHaveLength(2);
        expect(String(tuple[0])).toMatch(LINT_SEVERITY_PATTERN);
      }
    }

    const bunfigRules = normalizedRuleMap(parsedBunfig.lint.rules);
    const baseRules = normalizedRuleMap(oxlintConfig.rules);
    const typeAwareRules = normalizedRuleMap(oxlintTypeAwareConfig.rules);

    for (const [name, expected] of [...baseRules, ...typeAwareRules]) {
      expect(bunfigRules.get(name)).toEqual(expected);
    }

    for (const [name, value] of bunfigRules) {
      if (!baseRules.has(name) && !typeAwareRules.has(name)) {
        expect(value).toBe("off");
      }
    }
  });
});
