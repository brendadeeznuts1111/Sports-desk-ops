import { describe, expect, test } from "bun:test";
import type { BatchedRankingResult } from "../scripts/batch_rank_all_players.ts";
import {
  buildDownlineTrunkReport,
  formatDownlineTrunksAnsi,
  parseTrunksCliArgs,
} from "../lib/downline_trunks.ts";

describe("downline trunks", () => {
  const mini: BatchedRankingResult = {
    generatedAtIso: "2026-11-15T00:00:00Z",
    windowStart: "2026-10-16",
    windowEnd: "2026-11-15",
    totalWagersScanned: 1000,
    inWindowWagers: 900,
    totalHandleUsd: 1_000_000,
    totalToWinUsd: 900_000,
    activeCustomerCount: 120,
    activeSubAgentCount: 12,
    activeMasterAgentCount: 4,
    conduitSubAgentCount: 1,
    topMasterAgents: [],
    topSubAgents: [
      {
        agentId: "VIP01",
        masterAgent: "TRACKTHIS",
        totalHandleUsd: 700_000,
        totalWagers: 500,
        customerCount: 40,
        topCustomer: "GP301",
        topCustomerHandleUsd: 50_000,
        topCustomerConcentrationPct: 12,
        isProxyConduit: false,
      },
      {
        agentId: "RET01",
        masterAgent: "NOLAPPH",
        totalHandleUsd: 200_000,
        totalWagers: 300,
        customerCount: 60,
        topCustomer: "BRT106",
        topCustomerHandleUsd: 5_000,
        topCustomerConcentrationPct: 4,
        isProxyConduit: false,
      },
    ],
    topRankedPlayers: [
      {
        rank: 1,
        customerId: "GP301",
        agentId: "VIP01",
        masterAgent: "TRACKTHIS",
        totalWagers: 100,
        handleUsd: 50_000,
        avgStakeUsd: 500,
        medianStakeUsd: 400,
        maxStakeUsd: 5_000,
        toWinUsd: 45_000,
        stakeGini: 0.4,
        alertRatePct: 30,
        dominantSport: "Football",
        dominantBetType: "S",
        compositeScore: 8,
        tier: "TIER_1",
        tierLabel: "ORIGINATOR",
        recommendedLimitUsd: 250,
        recommendedDelaySeconds: 3,
        recommendedLineShadeCents: 5,
        shadowCopyRatio: 1,
        isProxyConduit: false,
        autoExecute: false,
      },
      {
        rank: 2,
        customerId: "BRT106",
        agentId: "RET01",
        masterAgent: "NOLAPPH",
        totalWagers: 80,
        handleUsd: 8_000,
        avgStakeUsd: 100,
        medianStakeUsd: 100,
        maxStakeUsd: 500,
        toWinUsd: 7_000,
        stakeGini: 0.2,
        alertRatePct: 3,
        dominantSport: "Football",
        dominantBetType: "S",
        compositeScore: 4,
        tier: "TIER_5",
        tierLabel: "BASELINE",
        recommendedLimitUsd: 2_500,
        recommendedDelaySeconds: 0,
        recommendedLineShadeCents: 0,
        shadowCopyRatio: 1,
        isProxyConduit: false,
        autoExecute: false,
      },
    ],
  };

  test("buildDownlineTrunkReport rolls sub-agents into TRACKTHIS vs NOLAPPH", () => {
    const report = buildDownlineTrunkReport(mini);
    const track = report.branches.find((b) => b.id === "TRACKTHIS");
    const retail = report.branches.find((b) => b.id === "NOLAPPH");
    expect(track?.handleUsd).toBe(700_000);
    expect(retail?.handleUsd).toBe(200_000);
    expect(report.structuralFinding).toContain("TRACKTHIS");
  });

  test("formatDownlineTrunksAnsi renders comparison table", () => {
    const ansi = formatDownlineTrunksAnsi(buildDownlineTrunkReport(mini));
    expect(ansi).toContain("TWO-TRUNK TOPOLOGY");
    expect(ansi).toContain("TRACKTHIS");
    expect(ansi).toContain("NOLAPPH");
    expect(ansi).toContain("LIVE CORPUS");
  });

  test("every table row is the same terminal width, SGR included", () => {
    // The TRACKTHIS handle cell carries bold escapes. Padding it with `padStart` counted the
    // escapes (17 code units, 9 columns) and left the column visibly short; a column measure
    // keeps every row aligned.
    const rows = formatDownlineTrunksAnsi(buildDownlineTrunkReport(mini))
      .split("\n")
      .filter((line) => line.startsWith("│"));
    expect(rows.length).toBeGreaterThan(2);
    const widths = new Set(rows.map((line) => Bun.stringWidth(line)));
    expect([...widths]).toHaveLength(1);
  });

  test("parseTrunksCliArgs understands detail and branch filters", () => {
    expect(parseTrunksCliArgs(["detail", "trackthis"]).detail).toBe(true);
    expect(parseTrunksCliArgs(["nolapph"]).branchFilter).toBe("NOLAPPH");
    expect(parseTrunksCliArgs(["json"]).json).toBe(true);
  });
});
