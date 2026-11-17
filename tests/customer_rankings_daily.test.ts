import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeRankingInputStamp,
  RANKING_INPUT_REL_PATHS,
  RANKING_OUTPUT_REL_PATHS,
  runCustomerRankingsDailyTick,
} from "../lib/customer_rankings_daily.ts";

function stageInputsAndOutputs(root: string, includeOutputs = true): void {
  for (const rel of RANKING_INPUT_REL_PATHS) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, `{"ok":true,"path":${JSON.stringify(rel)}}\n`, "utf8");
  }
  if (includeOutputs) {
    for (const rel of RANKING_OUTPUT_REL_PATHS) {
      const abs = join(root, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, "{}\n", "utf8");
    }
  }
}

describe("customer_rankings_daily", () => {
  test("skips cleanly with missingPaths when scratch inputs are absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "rankings-daily-missing-"));
    try {
      const result = await runCustomerRankingsDailyTick({
        root,
        statePath: join(root, "state.json"),
      });
      expect(result.ok).toBe(true);
      expect(result.refreshedRankings).toBe(false);
      expect(result.skippedReason).toBe("missing-inputs");
      expect(result.missingPaths).toEqual([...RANKING_INPUT_REL_PATHS]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry-run validates staged inputs without spawning generator", async () => {
    const root = mkdtempSync(join(tmpdir(), "rankings-daily-dry-"));
    try {
      stageInputsAndOutputs(root, false);
      let spawned = false;
      const result = await runCustomerRankingsDailyTick({
        root,
        statePath: join(root, "state.json"),
        dryRun: true,
        runGenerator: async () => {
          spawned = true;
          return { exitCode: 0 };
        },
      });
      expect(spawned).toBe(false);
      expect(result.ok).toBe(true);
      expect(result.skippedReason).toBe("dry-run");
      expect(result.inputStamp).toMatch(/^[0-9a-f]+$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips unchanged inputs after successful run unless force=true", async () => {
    const root = mkdtempSync(join(tmpdir(), "rankings-daily-stamp-"));
    try {
      stageInputsAndOutputs(root, true);
      const statePath = join(root, "state.json");
      let runs = 0;

      const first = await runCustomerRankingsDailyTick({
        root,
        statePath,
        now: () => new Date("2026-11-16T09:15:00.000Z"),
        runGenerator: async () => {
          runs += 1;
          return { exitCode: 0 };
        },
      });
      expect(first.ok).toBe(true);
      expect(first.refreshedRankings).toBe(true);
      expect(runs).toBe(1);

      const second = await runCustomerRankingsDailyTick({
        root,
        statePath,
        now: () => new Date("2026-11-16T09:20:00.000Z"),
        runGenerator: async () => {
          runs += 1;
          return { exitCode: 0 };
        },
      });
      expect(second.ok).toBe(true);
      expect(second.refreshedRankings).toBe(false);
      expect(second.skippedReason).toBe("unchanged-inputs");
      expect(runs).toBe(1);

      const forced = await runCustomerRankingsDailyTick({
        root,
        statePath,
        force: true,
        now: () => new Date("2026-11-16T09:25:00.000Z"),
        runGenerator: async () => {
          runs += 1;
          return { exitCode: 0 };
        },
      });
      expect(forced.ok).toBe(true);
      expect(forced.refreshedRankings).toBe(true);
      expect(runs).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports generator-failed without saving input stamp", async () => {
    const root = mkdtempSync(join(tmpdir(), "rankings-daily-fail-"));
    try {
      stageInputsAndOutputs(root, true);
      const statePath = join(root, "state.json");
      const failed = await runCustomerRankingsDailyTick({
        root,
        statePath,
        runGenerator: async () => ({
          exitCode: 2,
          stderr: "boom",
        }),
      });
      expect(failed.ok).toBe(false);
      expect(failed.skippedReason).toBe("generator-failed");
      expect(failed.exitCode).toBe(2);
      expect(failed.error).toBe("boom");
      const { inputStamp } = computeRankingInputStamp(root);
      expect(inputStamp).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
