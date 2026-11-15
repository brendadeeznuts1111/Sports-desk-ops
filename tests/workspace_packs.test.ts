import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  checkWorkspacePacks,
  isPackedFileAllowed,
  isPublishableManifest,
  parseBunPackDryRunFiles,
  WORKSPACE_PACK_DIRS,
} from "../scripts/check_workspace_packs.ts";
import { buildWorkspaceRunPlan } from "../scripts/dx_workspaces.ts";

const ROOT = path.resolve(import.meta.dir, "..");

describe("publish opt-in", () => {
  test("private is the default and never publishable", () => {
    expect(isPublishableManifest({ private: true })).toBe(false);
    expect(isPublishableManifest({})).toBe(false);
  });

  test("public access to an https registry opts in", () => {
    expect(
      isPublishableManifest({
        publishConfig: {
          access: "public",
          registry: "https://registry.npmjs.org/",
        },
      }),
    ).toBe(true);
  });

  test("loopback, http, or missing access does not opt in", () => {
    expect(
      isPublishableManifest({
        publishConfig: {
          access: "public",
          registry: "http://127.0.0.1:50851/",
        },
      }),
    ).toBe(false);
    expect(
      isPublishableManifest({
        publishConfig: {
          access: "restricted",
          registry: "https://registry.npmjs.org/",
        },
      }),
    ).toBe(false);
  });
});

describe("pack allowlist", () => {
  test("auto-included files always pass", () => {
    for (const file of [
      "package.json",
      "README.md",
      "LICENSE",
      "CHANGELOG.md",
    ]) {
      expect(isPackedFileAllowed(file, ["src"])).toBe(true);
    }
  });

  test("entries match as an exact file or a directory prefix", () => {
    expect(isPackedFileAllowed("src/index.ts", ["src"])).toBe(true);
    expect(isPackedFileAllowed("dist/index.js", ["src", "dist"])).toBe(true);
    expect(isPackedFileAllowed("src/nested/x.ts", ["src"])).toBe(true);
    expect(isPackedFileAllowed("docs/x.md", ["src"])).toBe(false);
    expect(isPackedFileAllowed("src/index.ts", [])).toBe(false);
  });

  test("glob entries follow the measured pack semantics", () => {
    // "src/**/*.ts" also matches the top-level file (zero directories).
    expect(isPackedFileAllowed("src/a.ts", ["src/**/*.ts"])).toBe(true);
    expect(isPackedFileAllowed("src/nested/b.ts", ["src/**/*.ts"])).toBe(true);
    expect(isPackedFileAllowed("src/c.md", ["src/**/*.ts"])).toBe(false);
    // "src/*.ts" does not cross the slash.
    expect(isPackedFileAllowed("src/a.ts", ["src/*.ts"])).toBe(true);
    expect(isPackedFileAllowed("src/nested/b.ts", ["src/*.ts"])).toBe(false);
    // "**/*.ts" matches a root-level file.
    expect(isPackedFileAllowed("a.ts", ["**/*.ts"])).toBe(true);
  });

  test("negated entries exclude", () => {
    expect(
      isPackedFileAllowed("src/nested/b.ts", ["src", "!src/nested/**"]),
    ).toBe(false);
    expect(isPackedFileAllowed("src/a.ts", ["src", "!src/nested/**"])).toBe(
      true,
    );
  });
});

describe("workspace pack boundaries", () => {
  test("parses bun pm pack --dry-run file listing", () => {
    const sample = [
      "bun pack v1.4.4-canary.1",
      "",
      "packed 0.75KB package.json",
      "packed 1.00KB src/features.ts",
      "packed 253B src/index.ts",
      "",
      "Total files: 3",
    ].join("\n");

    expect(parseBunPackDryRunFiles(sample)).toEqual([
      "package.json",
      "src/features.ts",
      "src/index.ts",
    ]);
  });

  test("all @sportsdesk-ops workspace packages pass pack --dry-run and browser isolation checks", async () => {
    const report = await checkWorkspacePacks(ROOT);
    expect(report.entries.map((e) => e.dir)).toEqual([...WORKSPACE_PACK_DIRS]);
    expect(report.entries.flatMap((e) => e.issues)).toEqual([]);
    expect(report.ok).toBe(true);
    for (const entry of report.entries) {
      expect(entry.issues).toEqual([]);
      expect(entry.packedFiles).toContain("package.json");
      expect(entry.packedFiles).toContain("src/index.ts");
    }
  });

  test("all @sportsdesk-ops workspace packages expose typecheck, lint, test scripts and resolve topological waves", async () => {
    for (const dir of WORKSPACE_PACK_DIRS) {
      const manifest = (await Bun.file(
        path.join(ROOT, dir, "package.json"),
      ).json()) as {
        scripts?: Record<string, string>;
      };
      expect(typeof manifest.scripts?.typecheck).toBe("string");
      expect(typeof manifest.scripts?.lint).toBe("string");
      expect(typeof manifest.scripts?.test).toBe("string");
      if (dir === "packages/ui") {
        expect(typeof manifest.scripts?.build).toBe("string");
      }
    }

    for (const script of ["typecheck", "lint", "test"] as const) {
      const plan = await buildWorkspaceRunPlan(ROOT, script, {
        filters: ["@sportsdesk-ops/*", "!@sportsdesk-ops/nsh-desk"],
        topological: true,
      });
      expect(plan.matchedWorkspaces.length).toBe(WORKSPACE_PACK_DIRS.length);
      expect(plan.matchedWorkspaces.every((w) => w.hasScript)).toBe(true);
      expect(plan.waves[0]).toEqual(["packages/contracts"]);
      expect(plan.waves[1]).toContain("packages/backend");
      expect(plan.waves[1]).toContain("packages/ui");
      expect(plan.waves[2]).toEqual(["packages/api"]);
    }
  });
});
