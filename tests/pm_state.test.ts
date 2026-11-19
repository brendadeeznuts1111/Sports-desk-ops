import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};

describe("PM state invariants", () => {
  test("the runtime pin is 1.4.4", () => {
    expect(readFileSync(join(root, ".bun-version"), "utf8").trim()).toBe(
      "1.4.4",
    );
  });

  test("predev and test:pm-contracts are wired", () => {
    expect(pkg.scripts?.predev ?? "").toContain("check:pm-state");
    expect(pkg.scripts?.["test:pm-contracts"] ?? "").toContain(
      "bun_pm_behaviors.test.ts",
    );
  });

  test("check:pm-state inspects the tree before anything reconciles it", () => {
    // `bun ci && bun prune --check` could never fail for the reason it exists: the install has
    // just rewritten node_modules to match the lock. The check runs first, or not at all.
    const check = pkg.scripts?.["check:pm-state"] ?? "";
    expect(check).toBe("bun run scripts/check_pm_state.ts");
    expect(check).not.toContain("bun ci");
    expect(check).not.toContain("prune");
  });

  test("predev checks before it installs, then still installs", () => {
    // Order matters: the check is only meaningful against the tree as it was found. The install
    // stays because `prune --check` reports extras, not missing packages.
    const predev = pkg.scripts?.predev ?? "";
    const checkAt = predev.indexOf("check:pm-state");
    const installAt = predev.indexOf("bun ci");
    expect(checkAt).toBeGreaterThanOrEqual(0);
    expect(installAt).toBeGreaterThan(checkAt);
  });

  test("the lockfile is present", () => {
    expect(existsSync(join(root, "bun.lock"))).toBe(true);
  });
});

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly publishConfig?: {
    readonly tag?: string;
    readonly access?: string;
  };
  readonly scripts?: Record<string, string>;
}

const SEMVER_PRERELEASE_RE = /-[0-9A-Za-z.-]+$/;
const FORBIDDEN_FILTER_BEFORE_PUBLISH_RE =
  /\bbun\s+--filter\b[^\n]*\bpublish\b/;

describe("Contract #36: workspace publish policy & flag-order guard", () => {
  test("root package.json stays private: true with no publishConfig.tag", async () => {
    const rootPkg = (await Bun.file(
      join(root, "package.json"),
    ).json()) as PackageManifest;
    expect(rootPkg.private).toBe(true);
    expect(rootPkg.publishConfig?.tag).toBeUndefined();
  });

  test("publishable workspaces declare publishConfig.tag on prerelease versions", async () => {
    const glob = new Glob("packages/*/package.json");
    for await (const relPath of glob.scan({ cwd: root })) {
      const manifest = (await Bun.file(
        join(root, relPath),
      ).json()) as PackageManifest;
      if (manifest.private !== false) continue;

      const isPrerelease =
        typeof manifest.version === "string" &&
        SEMVER_PRERELEASE_RE.test(manifest.version);
      if (isPrerelease) {
        expect(
          typeof manifest.publishConfig?.tag === "string" &&
            manifest.publishConfig.tag.length > 0,
        ).toBe(true);
      }
    }
  });

  test("CI workflows and package scripts use 'bun publish --filter', never 'bun --filter ... publish'", async () => {
    const rootPkg = (await Bun.file(
      join(root, "package.json"),
    ).json()) as PackageManifest;
    for (const [scriptName, cmd] of Object.entries(rootPkg.scripts ?? {})) {
      expect(
        FORBIDDEN_FILTER_BEFORE_PUBLISH_RE.test(cmd),
        `scripts.${scriptName} uses forbidden flag order: ${cmd}`,
      ).toBe(false);
    }

    const wfGlob = new Glob(".github/workflows/*.{yml,yaml}");
    for await (const relPath of wfGlob.scan({ cwd: root })) {
      const text = await Bun.file(join(root, relPath)).text();
      expect(
        FORBIDDEN_FILTER_BEFORE_PUBLISH_RE.test(text),
        `${relPath} uses forbidden 'bun --filter ... publish' flag order`,
      ).toBe(false);
    }
  });
});

const FORBIDDEN_PUBLISH_WORKFLOW_FLAGS_RE =
  /\bbun\s+publish\b[^\n]*(?:--provenance(?!\s*=?\s*false)\b|--trust\b|--use-openssl-ca\b|--use-system-ca\b|--cafile\b|--ca\b)|NPM_CONFIG_PROVENANCE\s*[:=]\s*["']?true\b/;

describe("Contract #37: publishConfig, provenance, and packageExtensions invariants", () => {
  test("publishable workspaces set publishConfig.access and never enable provenance", async () => {
    const glob = new Glob("packages/*/package.json");
    for await (const relPath of glob.scan({ cwd: root })) {
      const manifest = (await Bun.file(join(root, relPath)).json()) as {
        private?: boolean;
        packageExtensions?: unknown;
        publishConfig?: { access?: string; provenance?: boolean };
      };

      expect(
        manifest.packageExtensions,
        `${relPath} must not declare packageExtensions`,
      ).toBeUndefined();

      if (manifest.private === false) {
        expect(
          manifest.publishConfig?.access,
          `${relPath} must set publishConfig.access`,
        ).toBe("public");
        expect(
          manifest.publishConfig?.provenance,
          `${relPath} must not set publishConfig.provenance: true (unsupported in Bun)`,
        ).not.toBe(true);
      }
    }
  });

  test("CI workflows do not pass forbidden bun publish flags or NPM_CONFIG_PROVENANCE=true", async () => {
    const wfGlob = new Glob(".github/workflows/*.{yml,yaml}");
    for await (const relPath of wfGlob.scan({ cwd: root })) {
      const text = await Bun.file(join(root, relPath)).text();
      expect(
        FORBIDDEN_PUBLISH_WORKFLOW_FLAGS_RE.test(text),
        `${relPath} contains forbidden bun publish flag or NPM_CONFIG_PROVENANCE=true`,
      ).toBe(false);
    }
  });
});
