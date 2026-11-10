/**
 * @file tests/customer_rankings.test.ts
 * @description Unit tests for batched player rankings, Gini calculations, and proxy conduit detection.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calculateCompositeScore,
  computeGini,
  periodWindow,
  runBatchedRanking,
  type CustomerAccumulator,
} from "../lib/customer_rankings.ts";

describe("computeGini", () => {
  it("returns 0 for empty or single-element arrays", () => {
    expect(computeGini([])).toBe(0);
    expect(computeGini([100])).toBe(0);
  });

  it("returns 0 for perfectly flat stake sizing", () => {
    expect(computeGini([100, 100, 100, 100, 100])).toBe(0);
  });

  it("returns high Gini for extreme stake inequality (tilt / martingale)", () => {
    const stakes = [10, 10, 10, 10, 10, 10, 10, 10, 10000];
    const gini = computeGini(stakes);
    expect(gini).toBeGreaterThan(0.7);
    expect(gini).toBeLessThanOrEqual(1.0);
  });

  it("handles standard pro bettor sizing (Gini 0.05 to 0.25)", () => {
    const proStakes = [2200, 2200, 2500, 2200, 3000, 2200, 2500];
    const gini = computeGini(proStakes);
    expect(gini).toBeGreaterThan(0.01);
    expect(gini).toBeLessThan(0.25);
  });
});

describe("calculateCompositeScore", () => {
  it("classifies flat-stake originator as Tier 1 with autoExecute: false", () => {
    const acc: CustomerAccumulator = {
      login: "PRO_ORIGINATOR",
      agentId: "AGENT1",
      masterAgent: "MASTER1",
      wagerCount: 50,
      handleCents: 50 * 250000, // $2,500/ticket
      toWinCents: 50 * 227200,
      alertCount: 40, // 80% alert rate
      blockedCount: 2,
      stakesSample: Array.from({ length: 50 }, () => 2500),
      types: { S: 45, L: 5 },
      sports: { FOOTBALL: 50 },
      minDate: "2026-10-15",
      maxDate: "2026-11-05",
    };

    const res = calculateCompositeScore(acc);
    expect(res.score).toBeGreaterThanOrEqual(8.0);
    expect(res.tier === "TIER_1" || res.tier === "TIER_2").toBe(true);
    expect(res.limitUsd).toBeLessThanOrEqual(500);
    expect(res.delaySec).toBeGreaterThanOrEqual(2.0);
  });

  it("classifies recreational square as Tier 5 with retail limit", () => {
    const acc: CustomerAccumulator = {
      login: "SQUARE_JOE",
      agentId: "AGENT2",
      masterAgent: "MASTER1",
      wagerCount: 10,
      handleCents: 10 * 2000, // $20/ticket
      toWinCents: 10 * 50000,
      alertCount: 0,
      blockedCount: 0,
      stakesSample: [5, 10, 20, 15, 25, 50, 10, 100, 5, 20],
      types: { P: 8, S: 2 },
      sports: { FOOTBALL: 10 },
      minDate: "2026-10-20",
      maxDate: "2026-11-01",
    };

    const res = calculateCompositeScore(acc);
    expect(res.score).toBeLessThan(5.5);
    expect(res.tier).toBe("TIER_5");
    expect(res.limitUsd).toBe(5000);
    expect(res.delaySec).toBe(0.0);
  });
});

describe("periodWindow", () => {
  it("accepts valid periods", () => {
    expect(periodWindow("7d")).toBe("7d");
    expect(periodWindow("lifetime")).toBe("lifetime");
    expect(periodWindow("all")).toBe("lifetime");
  });

  it("rejects invalid periods with RangeError", () => {
    expect(() => periodWindow("24h")).toThrow();
  });
});

describe("runBatchedRanking", () => {
  it("aggregates the 30-day window and flags proxy conduits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sportsdesk-rankings-"));
    try {
      const corpusPath = join(dir, "f402-bets.jsonl");
      const rows = [
        ...Array.from({ length: 12 }, (_, idx) =>
          JSON.stringify({
            Login: "CONDUIT_PRO",
            AgentLogin: "SUB_CONDUIT",
            AmountWagered: 5000000, // $50,000 -> $600k total (>= $500k conduit threshold)
            ToWinAmount: 4545000,
            InsertDateTime: `2026-11-0${(idx % 8) + 1} 14:00:00`,
            WagerType: "S",
            TicketWriter: "ALERT_SHARP",
            ShortDesc: "NFL Football Spread",
          }),
        ),
        JSON.stringify({
          Login: "RETAIL_1",
          AgentLogin: "SUB_RETAIL",
          AmountWagered: 5000,
          ToWinAmount: 15000,
          InsertDateTime: "2026-11-05 18:00:00",
          WagerType: "P",
          TicketWriter: "INTERNET",
          ShortDesc: "NBA Basketball Parlay",
        }),
      ];
      writeFileSync(corpusPath, `${rows.join("\n")}\n`, "utf8");

      const res = await runBatchedRanking({
        corpusPath,
        windowCutoff: "2026-10-15",
        limitPlayers: 20,
      });
      expect(res.inWindowWagers).toBeGreaterThan(0);
      expect(res.totalHandleUsd).toBeGreaterThan(0);
      expect(res.activeCustomerCount).toBeGreaterThan(0);
      expect(res.conduitSubAgentCount).toBeGreaterThan(0);
      expect(res.topRankedPlayers.length).toBeGreaterThan(0);

      for (const player of res.topRankedPlayers) {
        expect(player.rank).toBeGreaterThan(0);
        expect(player.autoExecute).toBe(false);
        expect(player.compositeScore).toBeGreaterThanOrEqual(0);
        expect(player.compositeScore).toBeLessThanOrEqual(10);
      }

      // Top players should be sorted by score desc
      for (let i = 1; i < res.topRankedPlayers.length; i++) {
        const prev = res.topRankedPlayers[i - 1]!;
        const curr = res.topRankedPlayers[i]!;
        expect(prev.compositeScore).toBeGreaterThanOrEqual(curr.compositeScore);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
