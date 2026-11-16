import { describe, expect, test } from "bun:test";
import {
  liveOpenWagersToProfiles,
  mapRankingTierCode,
  mergeMatrixProfileOverlay,
  rankingsPlayersToProfiles,
} from "../packages/ui/src/profile_rows.ts";
import type { LiveWager, RankedPlayer30d } from "../packages/ui/src/types.ts";

describe("profile matrix overlay", () => {
  test("mapRankingTierCode prefers API tier codes", () => {
    expect(mapRankingTierCode("TIER_5")).toBe("TIER_5_RECREATIONAL");
    expect(mapRankingTierCode("Tier 2: Steam Syndicate")).toBe(
      "TIER_2_STEAM_SYNDICATE",
    );
  });

  test("rankingsPlayersToProfiles uses payload tier and score", () => {
    const players: RankedPlayer30d[] = [
      {
        rank: 1,
        id: "DCC306",
        agentId: "CHUNG2",
        masterAgent: "CHUNG2",
        handleUsd: 500,
        wagers: 2,
        gini: 0.1,
        alertRate: 0,
        score: 3.96,
        tier: "TIER_5",
        tierLabel: "Tier 5: Recreational / Retail",
        dominantSport: "NBA",
        isProxy: false,
        limitUsd: 5000,
      },
    ];
    const [row] = rankingsPlayersToProfiles(players);
    expect(row?.id).toBe("DCC306");
    expect(row?.tier).toBe("TIER_5_RECREATIONAL");
    expect(row?.tierLabel).toBe("Tier 5: Recreational / Retail");
    expect(row?.source).toBe("rankings");
  });

  test("mergeMatrixProfileOverlay ranks over live-open", () => {
    const wagers = [
      {
        ticketId: "t1",
        timestamp: "now",
        customerId: "DCC306",
        agentId: "CHUNG2",
        masterAgent: "CHUNG2",
        sport: "Basketball",
        betType: "SPREAD",
        event: "Game",
        selection: "Test",
        lineDisplay: "+1",
        oddsAmerican: "-110",
        riskUsd: 100,
        toWinUsd: 90,
        clvCents: null,
        alertTier: "BASELINE",
        alertBadge: "ok",
        operatorDirective: "MONITOR",
        maxRecommendedStake: 5000,
        autoExecute: false as const,
      },
    ] satisfies LiveWager[];
    const players: RankedPlayer30d[] = [
      {
        rank: 1,
        id: "DCC306",
        agentId: "CHUNG2",
        masterAgent: "CHUNG2",
        handleUsd: 500,
        wagers: 2,
        gini: 0.1,
        alertRate: 0,
        score: 3.96,
        tier: "TIER_5",
        tierLabel: "Tier 5: Recreational / Retail",
        dominantSport: "NBA",
        isProxy: false,
        limitUsd: 5000,
      },
    ];
    const liveOnly = liveOpenWagersToProfiles(wagers);
    const merged = mergeMatrixProfileOverlay([], players, wagers);
    expect(liveOnly[0]?.tierLabel).toContain("pending");
    expect(merged.find((c) => c.id === "DCC306")?.source).toBe("rankings");
    expect(merged.find((c) => c.id === "DCC306")?.openRiskUsd).toBeUndefined();
  });
});
