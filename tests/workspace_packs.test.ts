import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  checkWorkspacePacks,
  parseBunPackDryRunFiles,
  WORKSPACE_PACK_DIRS,
} from "../scripts/check_workspace_packs.ts";
import { buildWorkspaceRunPlan } from "../scripts/dx_workspaces.ts";

const ROOT = path.resolve(import.meta.dir, "..");

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
