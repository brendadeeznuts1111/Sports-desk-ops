/**
 * @file lib/live_profile_harvester.test.ts
 * @description The harvester must report what the artifacts measured. These tests pin the
 * fixes that removed invented values: no per-profile IP, no CLV or timestamp fabricated for a
 * sample wager, no 24h exposure taken from the 4-week backtest, a real 10-minute burst window,
 * and a zero Gini for a single stake.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harvestLiveCustomerProfiles } from "./live_profile_harvester.ts";

const ROOT = mkdtempSync(join(tmpdir(), "harvester-"));

function writeJson(relativePath: string, value: unknown): void {
  const path = join(ROOT, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function wagerRow(
  customerId: string,
  insertedAt: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    CustomerID: customerId,
    AgentID: "AG1",
    TicketWriter: "gslive",
    AmountWagered: 10000,
    ShortDesc: "Lakers -3",
    WagerType: "S",
    InsertDateTime: insertedAt,
    ...overrides,
  };
}

writeJson("data/live-wagers.json", {
  LIST: [
    // three wagers inside ten minutes
    wagerRow("CUST_BURST", "2026-11-10 10:00:00.000"),
    wagerRow("CUST_BURST", "2026-11-10 10:03:00.000"),
    wagerRow("CUST_BURST", "2026-11-10 10:06:00.000"),
    // three wagers spread across the day
    wagerRow("CUST_SPREAD", "2026-11-10 09:00:00.000"),
    wagerRow("CUST_SPREAD", "2026-11-10 12:00:00.000"),
    wagerRow("CUST_SPREAD", "2026-11-10 15:00:00.000"),
    // one wager: Gini must be 0, not an invented default
    wagerRow("CUST_SINGLE", "2026-11-10 11:00:00.000"),
  ],
});

writeJson("reports/live-positions-summary.json", {
  window24hOpenPositions: {
    topAgents: [{ key: "AG1", riskCents: 30_000 }],
    topActiveAccounts: [
      {
        customerId: "CUST_SUMMARY",
        agentId: "AG1",
        wagersCount: 2,
        riskCents: 20_000,
        toWinCents: 36_000,
        latestSelection: "Lakers buying 0.5",
      },
    ],
  },
});

writeJson("docs/backtest-4wk-cfb-nba.json", {
  customerLeaderboard: [
    {
      customerId: "CUST_BACKTEST",
      agentId: "AG1",
      totalRiskUsd: 50_000,
      tickets: 99,
      avgClvBps: 120,
    },
  ],
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("live profile harvester reports measured values only", () => {
  const byId = async () => {
    const result = await harvestLiveCustomerProfiles({
      repoRoot: ROOT,
      limit: 100,
    });
    const map = new Map(
      result.profiles.map((profile) => [profile.id, profile]),
    );
    return { result, map };
  };

  test("names which inputs were read, so a zero scan is not a clean read", async () => {
    const { result } = await byId();
    expect(result.sources).toEqual({
      summary: "ok",
      liveWagers: "ok",
      liveBets: "missing",
      backtest: "ok",
      agentTree: "missing",
      dodSpine: "missing",
    });
  });

  test("a malformed input is reported as malformed, not as zero rows", async () => {
    const brokenRoot = mkdtempSync(join(tmpdir(), "harvester-broken-"));
    try {
      mkdirSync(join(brokenRoot, "data"), { recursive: true });
      writeFileSync(join(brokenRoot, "data/live-wagers.json"), "{ not json");
      const broken = await harvestLiveCustomerProfiles({
        repoRoot: brokenRoot,
        limit: 10,
      });
      expect(broken.sources.liveWagers).toBe("malformed");
      expect(broken.sources.summary).toBe("missing");
      expect(broken.totalUniqueCustomersScanned).toBe(0);
    } finally {
      rmSync(brokenRoot, { recursive: true, force: true });
    }
  });

  test("flags a ten-minute burst and not a spread-out ticket count", async () => {
    const { map } = await byId();
    expect(map.get("CUST_BURST")?.anomalyFlags).toContain(
      "VELOCITY_BURST_SNIPER",
    );
    expect(map.get("CUST_SPREAD")?.anomalyFlags).not.toContain(
      "VELOCITY_BURST_SNIPER",
    );
  });

  test("never fabricates a profile IP or a sample-wager CLV", async () => {
    const { result, map } = await byId();
    for (const profile of result.profiles) {
      expect("ipAddress" in profile).toBe(false);
    }
    const burst = map.get("CUST_BURST");
    expect(burst?.sampleWagers.length).toBeGreaterThan(0);
    for (const sample of burst?.sampleWagers ?? []) {
      expect(sample.clvBps).toBeNull();
      expect(sample.time).not.toBeNull();
      expect(sample.time).not.toBe("2026-11-14");
    }
    // No input carried 2026-11-14, so the old fallback must not appear anywhere.
    expect(JSON.stringify(result)).not.toContain("2026-11-14");
  });

  test("a summary row without a timestamp reports null time and null CLV", async () => {
    const { map } = await byId();
    const sample = map.get("CUST_SUMMARY")?.sampleWagers[0];
    expect(sample).toBeDefined();
    expect(sample?.time).toBeNull();
    expect(sample?.clvBps).toBeNull();
  });

  test("the 4-week backtest is not reported as 24h exposure", async () => {
    const { map } = await byId();
    const backtestOnly = map.get("CUST_BACKTEST");
    expect(backtestOnly).toBeDefined();
    expect(backtestOnly?.openRisk24hUsd).toBe(0);
    expect(backtestOnly?.openTickets24h).toBe(0);
  });

  test("a single stake has a zero Gini, not a default coefficient", async () => {
    const { map } = await byId();
    expect(map.get("CUST_SINGLE")?.gini).toBe(0);
  });
});
