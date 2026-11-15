import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  F402PullerError,
  emptyCheckpoint,
  mapPool,
  saveCheckpoint,
} from "../lib/f402_readonly_puller.ts";
import {
  applySinceToRange,
  parseConcurrency,
  parseIdList,
  parseRateAndInterval,
  planPull,
  resolveResume,
} from "../lib/f402_pull_plan.ts";
import { main as pullMain } from "../scripts/f402_readonly_pull.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempOut(): string {
  const dir = mkdtempSync(join(tmpdir(), "f402-opt-"));
  dirs.push(dir);
  return dir;
}

describe("pull option parsers", () => {
  test("parses id lists, rate, concurrency, resume, and since", () => {
    expect(parseIdList("A, B,A", "--agents")).toEqual(["A", "B"]);
    expect(() => parseIdList(" , ", "--agents")).toThrow(F402PullerError);
    expect(parseRateAndInterval(undefined, undefined)).toEqual({
      ratePerSec: 1,
      intervalMs: 1000,
    });
    expect(parseRateAndInterval("2", undefined)).toEqual({
      ratePerSec: 2,
      intervalMs: 500,
    });
    expect(() => parseRateAndInterval("2", "1000")).toThrow(F402PullerError);
    expect(parseConcurrency(undefined)).toBe(1);
    expect(parseConcurrency("3")).toBe(3);
    expect(() => parseConcurrency("0")).toThrow(F402PullerError);
    expect(resolveResume(false, false)).toBe(true);
    expect(resolveResume(false, true)).toBe(false);
    expect(() => resolveResume(true, true)).toThrow(F402PullerError);
    expect(
      applySinceToRange("2026-11-01", "2026-11-14", "2026-11-10", "weblog"),
    ).toEqual({
      from: "2026-11-10",
      to: "2026-11-14",
    });
    expect(
      applySinceToRange(undefined, "2026-11-14", "2026-11-10", "wagers"),
    ).toEqual({
      from: "2026-11-10",
      to: "2026-11-14",
    });
  });
});

describe("mapPool", () => {
  test("runs with concurrency 2 and preserves order", async () => {
    const started: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await mapPool([10, 20, 30], 2, async (item, index) => {
      started.push(index);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(20);
      inFlight -= 1;
      return item + 1;
    });
    expect(result).toEqual([11, 21, 31]);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

describe("dry-run planner", () => {
  test("prints planned wagers calls and skips completed checkpoint dates", async () => {
    const outDir = tempOut();
    saveCheckpoint(outDir, {
      ...emptyCheckpoint("ROOT1", "2026-11-14T00:00:00.000Z"),
      phase: "wagers",
      customerIds: ["CUST1", "CUST2"],
      completedGradedDates: ["2026-11-01"],
      wagersPendingDone: true,
      wagersTickerDone: false,
    });
    const plan = planPull({
      phase: "wagers",
      outDir,
      agentId: "ROOT1",
      agentOwner: "ROOT1",
      agentType: "M",
      from: "2026-11-01",
      to: "2026-11-02",
      includeFigureDate: true,
      options: {
        resume: true,
        dryRun: true,
        intervalMs: 1000,
        ratePerSec: 1,
        concurrency: 1,
        since: null,
        agents: [],
        accounts: ["CUST1"],
        recurseDownline: false,
      },
    });
    expect(plan.dryRun).toBe(true);
    const ops = plan.calls.map((call) => call.operation);
    expect(ops).not.toContain("getPending");
    expect(ops).toContain("getBetTicker");
    expect(ops).toContain("getGraded");
    expect(
      plan.calls.some((call) => call.fields.startDate === "11-01-2026"),
    ).toBe(false);
    expect(
      plan.calls.some((call) => call.fields.startDate === "11-02-2026"),
    ).toBe(true);
    expect(
      plan.calls.some(
        (call) =>
          call.operation === "getWagersByFigureDate" &&
          call.fields.customerID === "CUST1",
      ),
    ).toBe(true);
    expect(plan.calls.some((call) => call.fields.customerID === "CUST2")).toBe(
      false,
    );
    expect(plan.skipped.some((row) => row.key === "2026-11-01")).toBe(true);

    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const code = await pullMain([
        "census",
        "--agent-id",
        "ROOT1",
        "--dry-run",
        "--out",
        outDir,
        "--recurse-downline",
      ]);
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!) as {
      dryRun: boolean;
      calls: { operation: string }[];
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.calls.some((call) => call.operation === "getHeriarchy")).toBe(
      true,
    );
    expect(
      parsed.calls.some((call) => call.operation === "getListAgenstByAgent"),
    ).toBe(true);
  });

  test("census recurse is planned from a saved list-agents file", () => {
    const outDir = tempOut();
    mkdirSync(join(outDir, "raw/census"), { recursive: true });
    writeFileSync(
      join(outDir, "raw/census/getListAgenstByAgent.json"),
      JSON.stringify({
        GENERAL: [
          {
            AgentID: "ROOT1",
            Login: "ROOT1",
            SeqNumber: 1,
            Level: 0,
            AgentType: "M",
          },
          {
            AgentID: "SUB1",
            Login: "SUB1",
            SeqNumber: 2,
            Level: 1,
            AgentType: "A",
          },
        ],
        PLAYERS: [{ customerID: "CUST1", Login: "cust1", Agent: "SUB1" }],
      }),
    );
    const plan = planPull({
      phase: "census",
      outDir,
      agentId: "ROOT1",
      agentOwner: "ROOT1",
      agentType: "M",
      options: {
        resume: true,
        dryRun: true,
        intervalMs: 1000,
        ratePerSec: 1,
        concurrency: 1,
        since: null,
        agents: [],
        accounts: [],
        recurseDownline: true,
      },
    });
    expect(
      plan.calls
        .filter((call) => call.operation === "getListAgenstByAgent")
        .map((call) => call.fields.agentID),
    ).toEqual(["ROOT1", "SUB1"]);
  });
});
