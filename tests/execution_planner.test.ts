import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExecutionPlan,
  resolveKalshiLiveReady,
} from "../lib/execution_planner.ts";

const REPO = join(import.meta.dir, "..");
const NOW = new Date("2026-11-11T12:00:00.000Z");

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "execution-plan-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let counter = 0;
function freshRoot(): string {
  counter += 1;
  const dir = join(root, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const decision = {
  league: "NBA",
  teams: ["Lakers", "Celtics"],
  marketKind: "moneyline",
  line: null,
  position: "home",
};

const fill = (overrides: Record<string, unknown> = {}) => ({
  fillId: "f1",
  intentId: "i1",
  decisionId: "d1",
  venue: "kalshi",
  tickerToken: "T1",
  position: "home",
  style: "taker",
  status: "filled",
  price: 0.5,
  contracts: 10,
  sizeUsd: 25,
  slippageBps: null,
  createdAtIso: "2026-11-11T09:00:00.000Z",
  reason: null,
  ...overrides,
});

const quote = (overrides: Record<string, unknown> = {}) => ({
  quoteId: "q1",
  intentId: "i1",
  decisionId: "d1",
  venue: "kalshi",
  tickerToken: "T1",
  position: "home",
  price: 0.5,
  contracts: 10,
  sizeUsd: 10,
  createdAtIso: "2026-11-11T08:00:00.000Z",
  expiresAtIso: "2026-11-11T13:00:00.000Z",
  status: "open",
  ...overrides,
});

function writeLedger(
  ledgerRoot: string,
  rows: readonly unknown[],
  extraLines: readonly string[] = [],
): void {
  const dir = join(ledgerRoot, "Scratch", "execution");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "ledger.jsonl"),
    [...rows.map((row) => JSON.stringify(row)), ...extraLines].join("\n") +
      "\n",
    "utf8",
  );
}

describe("resolveKalshiLiveReady", () => {
  test("reports a missing adapter instead of crashing", async () => {
    expect(await resolveKalshiLiveReady(freshRoot(), {})).toEqual({
      ready: false,
      reason: "kalshi live adapter not installed in this checkout",
    });
  });

  test("is hermetic when an env view is injected", async () => {
    // The injected-env path passes `getSecret: async () => null`, so no OS keychain read and
    // no dependency on this machine's Kalshi credentials.
    expect(await resolveKalshiLiveReady(REPO, {})).toEqual({
      ready: false,
      reason: "api_key_id_missing",
    });
  });
});

describe("buildExecutionPlan with an empty checkout root", () => {
  test("returns an empty, read-only paper plan", async () => {
    const plan = await buildExecutionPlan({
      root: freshRoot(),
      now: NOW,
      policyEnv: {},
    });
    expect(plan.generatedAt).toBe(NOW.toISOString());
    expect(plan.mode).toBe("paper");
    expect(plan.killSwitch).toBe(false);
    expect(plan.stylePreference).toBe("auto");
    expect(plan.signals).toEqual([]);
    expect(plan.joins).toEqual([]);
    expect(plan.decisions).toEqual([]);
    expect(plan.blockedReasons).toEqual({});
    expect(plan.venueBooks.size).toBe(0);
    expect(plan.paper).toEqual({ quotes: [], fills: [], ledgerTail: [] });
    expect(plan.provenance).toEqual({
      fixture: false,
      stale: false,
      dataMode: null,
      asOf: null,
      ageSeconds: null,
      sources: [],
    });
    expect(plan.risk).toEqual({
      dailyPlannedUsd: 0,
      openIntents: 0,
      marketExposureUsd: {},
      dailyCapUsd: 5_000,
    });
    expect(plan.venues.kalshi).toEqual({
      liveReady: false,
      reason: "kalshi live adapter not installed in this checkout",
    });
    expect(plan.venues.polymarket.liveReady).toBe(false);
    expect(plan.kalshiTelemetry.requests).toBe(0);
    expect(plan.polymarketTelemetry.requests).toBe(0);
  });

  test("takes the mode from EXECUTION_MODE and reports the kill switch", async () => {
    const paused = await buildExecutionPlan({
      root: freshRoot(),
      now: NOW,
      policyEnv: { EXECUTION_MODE: "PAUSED" },
    });
    expect(paused.mode).toBe("paused");
    expect(paused.killSwitch).toBe(true);
    expect(paused.policy.mode).toBe("paused");

    const invalid = await buildExecutionPlan({
      root: freshRoot(),
      now: NOW,
      policyEnv: { EXECUTION_MODE: "banana" },
    });
    expect(invalid.mode).toBe("paper");
  });

  test("lets the in-memory mode override win over the env", async () => {
    const plan = await buildExecutionPlan({
      root: freshRoot(),
      now: NOW,
      policyEnv: { EXECUTION_MODE: "paper" },
      mode: "live",
    });
    expect(plan.mode).toBe("live");
    expect(plan.policy.mode).toBe("live");
    expect(plan.killSwitch).toBe(false);
  });

  test("applies the policy env overrides and clamps the hedge ratio", async () => {
    const plan = await buildExecutionPlan({
      root: freshRoot(),
      now: NOW,
      policyEnv: {
        EXECUTION_LIVE: "1",
        EXECUTION_HEDGE_RATIO: "2",
        EXECUTION_MAX_DAILY_PLANNED_USD: "1234.5",
        EXECUTION_MAX_ORDER_USD: "99",
        EXECUTION_MIN_EDGE_BPS: "450",
      },
    });
    expect(plan.policy.liveEnabled).toBe(true);
    expect(plan.policy.hedgeRatio).toBe(1);
    expect(plan.policy.maxDailyPlannedUsd).toBe(1_234.5);
    expect(plan.policy.maxOrderUsd).toBe(99);
    expect(plan.policy.minEdgeBps).toBe(450);
    expect(plan.risk.dailyCapUsd).toBe(1_234.5);
  });
});

describe("buildExecutionPlan ledger integration", () => {
  test("sums today's fills but counts exposure from today's rows", async () => {
    const ledgerRoot = freshRoot();
    writeLedger(ledgerRoot, [
      {
        kind: "intent",
        intentId: "i1",
        atIso: "2026-11-11T09:00:00.000Z",
        mode: "paper",
        decision,
        fill: fill(),
        quote: null,
        riskSnapshot: null,
      },
      {
        kind: "intent",
        intentId: "i2",
        atIso: "2026-11-11T10:00:00.000Z",
        mode: "paper",
        decision,
        fill: fill({ fillId: "f2", sizeUsd: 5 }),
        quote: null,
        riskSnapshot: null,
      },
      // Row dated today, fill dated yesterday: exposure counts the row, the daily total does not.
      {
        kind: "intent",
        intentId: "i3",
        atIso: "2026-11-11T11:00:00.000Z",
        mode: "paper",
        decision,
        fill: fill({
          fillId: "f3",
          sizeUsd: 100,
          createdAtIso: "2026-11-10T10:00:00.000Z",
        }),
        quote: null,
        riskSnapshot: null,
      },
      {
        kind: "intent",
        intentId: "i4",
        atIso: "2026-11-10T11:00:00.000Z",
        mode: "paper",
        decision,
        fill: fill({
          fillId: "f4",
          sizeUsd: 1_000,
          createdAtIso: "2026-11-10T11:00:00.000Z",
        }),
        quote: null,
        riskSnapshot: null,
      },
    ]);
    const plan = await buildExecutionPlan({
      root: freshRoot(),
      ledgerRoot,
      now: NOW,
      policyEnv: {},
    });
    expect(plan.risk.dailyPlannedUsd).toBe(30);
    expect(plan.paper.fills).toHaveLength(4);
    expect(plan.paper.ledgerTail).toHaveLength(4);
    expect(
      plan.risk.marketExposureUsd["NBA|Celtics_Lakers|moneyline|noline"],
    ).toBe(130);
  });

  test("counts open quotes as open intents and expires stale ones for the paper view", async () => {
    const ledgerRoot = freshRoot();
    writeLedger(ledgerRoot, [
      {
        kind: "intent",
        intentId: "i1",
        atIso: "2026-11-11T09:00:00.000Z",
        mode: "paper",
        decision,
        fill: null,
        quote: quote(),
        riskSnapshot: null,
      },
      {
        kind: "intent",
        intentId: "i2",
        atIso: "2026-11-11T09:00:00.000Z",
        mode: "paper",
        decision,
        fill: null,
        quote: quote({
          quoteId: "q2",
          expiresAtIso: "2026-11-11T11:00:00.000Z",
        }),
        riskSnapshot: null,
      },
    ]);
    const plan = await buildExecutionPlan({
      root: freshRoot(),
      ledgerRoot,
      now: NOW,
      policyEnv: {},
    });
    expect(plan.risk.openIntents).toBe(2);
    expect(plan.paper.quotes.map((entry) => entry.status)).toEqual([
      "open",
      "expired",
    ]);
  });

  test("skips malformed and rejected rows without failing the plan", async () => {
    const ledgerRoot = freshRoot();
    writeLedger(
      ledgerRoot,
      [
        {
          kind: "intent",
          intentId: "i1",
          atIso: "2026-11-11T09:00:00.000Z",
          mode: "paper",
          decision,
          fill: fill({ status: "rejected" }),
          quote: null,
          riskSnapshot: null,
        },
      ],
      ["not json", JSON.stringify({ kind: "intent" })],
    );
    const plan = await buildExecutionPlan({
      root: freshRoot(),
      ledgerRoot,
      now: NOW,
      policyEnv: {},
    });
    expect(plan.paper.fills).toEqual([]);
    expect(plan.risk.dailyPlannedUsd).toBe(0);
    expect(plan.paper.ledgerTail).toHaveLength(1);
  });

  test("accepts an injected ledger state over the file", async () => {
    const plan = await buildExecutionPlan({
      root: freshRoot(),
      now: NOW,
      policyEnv: {},
      ledger: {
        rows: [],
        fills: [],
        openQuotes: [],
        modeChanges: [],
      } as never,
    });
    expect(plan.risk.dailyPlannedUsd).toBe(0);
  });
});
