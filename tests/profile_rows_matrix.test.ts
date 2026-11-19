import { describe, expect, test } from "bun:test";
import {
  isSyntheticShowcaseCustomer,
  liveOpenWagersToProfiles,
  mapRankingTierCode,
  mergeMatrixProfileOverlay,
  mergeOpenRiskOverlay,
  rankingsPlayersToProfiles,
} from "../packages/ui/src/profile_rows.ts";
import { buildSharpnessDecomposition } from "../packages/ui/src/viz/SharpnessDecomposition.tsx";
import type {
  LiveWager,
  RankedPlayer30d,
  ShowcaseCustomer,
} from "../packages/ui/src/types.ts";

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

  test("rankingsPlayersToProfiles & liveOpenWagersToProfiles conserve radar axes and carry DOD6 CLV / recency", () => {
    const assertConserved = (c: ShowcaseCustomer) =>
      buildSharpnessDecomposition(
        [
          { key: "clvScore", label: "CLV", value: c.clvScore, cap: 3.0 },
          { key: "skillScore", label: "Skill", value: c.skillScore, cap: 2.5 },
          {
            key: "sizingScore",
            label: "Sizing",
            value: c.sizingScore,
            cap: 1.5,
          },
          { key: "sigScore", label: "Sig", value: c.sigScore, cap: 2.0 },
          {
            key: "timingScore",
            label: "Timing",
            value: c.timingScore,
            cap: 1.0,
          },
        ],
        c.score,
      );

    const players: RankedPlayer30d[] = [
      {
        rank: 1,
        id: "MM1023",
        agentId: "MOOSEM",
        masterAgent: "NOLAWOLF",
        handleUsd: 487200,
        wagers: 301,
        gini: 0.22,
        alertRate: 45.2,
        score: 7.25,
        tier: "TIER_3",
        tierLabel: "Tier 3: Disciplined Sharp",
        dominantSport: "FOOTBALL",
        isProxy: false,
        limitUsd: 1000,
        lastWagerAt: "2026-11-18 18:10:00",
        clvBps: 185,
        clvLegs: 15,
        lifetimeNetUsd: 42500,
        sharpCandidateGatePassed: true,
        keyNumberBuys30d: 4,
        halfPointBuys30d: 7,
        halfPointBuyRatePct: 2.3,
        seatCount: 2,
        isKeyNumberBuyer: true,
        isHalfPointHookBuyer: true,
        isMultiSeatCluster: true,
        scoreComponents: {
          clv: 1.81,
          volume: 1.93,
          sizing: 1.17,
          timing: 1.5,
          combo: 0.84,
        },
      },
      {
        rank: 2,
        id: "FALLBACK_NO_COMPONENTS",
        agentId: "AG1",
        masterAgent: "M1",
        handleUsd: 10000,
        wagers: 10,
        gini: 0.1,
        alertRate: 0,
        score: 4.37,
        tier: "TIER_5",
        tierLabel: "Tier 5: Recreational / Retail",
        dominantSport: "BASKETBALL",
        isProxy: false,
        limitUsd: 5000,
      },
    ];

    const mapped = rankingsPlayersToProfiles(players);
    expect(mapped[0]?.clvBps).toBe(185);
    expect(mapped[0]?.clvLegs).toBe(15);
    expect(mapped[0]?.ltvUsd).toBe(42500);
    expect(mapped[0]?.lastWagerAt).toBe("2026-11-18 18:10:00");
    expect(mapped[0]?.handle30dUsd).toBe(487200);
    expect(mapped[0]?.unknown).not.toContain("ltv");
    expect(mapped[0]?.isKeyNumberBuyer).toBe(true);
    expect(mapped[0]?.keyNumberBuys30d).toBe(4);
    expect(mapped[0]?.isHalfPointHookBuyer).toBe(true);
    expect(mapped[0]?.halfPointBuys30d).toBe(7);
    expect(mapped[0]?.isMultiSeatCluster).toBe(true);
    expect(mapped[0]?.seatCount).toBe(2);
    expect(mapped[0]?.sharpCandidateGatePassed).toBe(true);
    expect(mapped[0]?.syndicateRisk).toBe("HIGH");
    expect(mapped[1]?.syndicateRisk).toBe("LOW");
    expect(mapped[1]?.syndicateProb).toBe(0);
    expect(() => assertConserved(mapped[0]!)).not.toThrow();
    expect(() => assertConserved(mapped[1]!)).not.toThrow();

    const wagers: LiveWager[] = [
      {
        ticketId: "t2",
        timestamp: "2026-11-18T19:00:00Z",
        customerId: "GX195",
        agentId: "GOLD22",
        masterAgent: "NOLAWOLF",
        sport: "Basketball",
        betType: "SPREAD",
        event: "Game",
        selection: "Side",
        lineDisplay: "-4.5",
        oddsAmerican: "-110",
        riskUsd: 2500,
        toWinUsd: 2272.73,
        clvCents: null,
        customerClvBps: 185,
        alertTier: "CRITICAL",
        alertBadge: "SHARP",
        operatorDirective: "ALERT",
        maxRecommendedStake: 250,
        autoExecute: false,
      },
    ];
    const [liveProf] = liveOpenWagersToProfiles(wagers);
    expect(liveProf?.clvBps).toBe(185);
    expect(() => assertConserved(liveProf!)).not.toThrow();

    const overlaid = mergeOpenRiskOverlay(mapped, [
      { ...wagers[0]!, customerId: "MM1023" },
    ]);
    expect(overlaid[0]?.openRiskUsd).toBe(2500);
    expect(overlaid[0]?.source).toBe("rankings");
    expect(
      isSyntheticShowcaseCustomer({
        id: "SYNTH_SYN_01",
        masterAgent: "M1",
      }),
    ).toBe(true);
    expect(
      isSyntheticShowcaseCustomer({
        id: "MM1023",
        masterAgent: "NOLAWOLF",
      }),
    ).toBe(false);
  });
});
