import { describe, expect, it } from "bun:test";
import {
  buildComprehensiveCustomerProfile,
  buildCorrelatedParlayProfile,
  buildDeskActionDirectives,
  buildMarketSpecializationProfile,
  buildPortfolioRiskForensics,
  buildStakeDistributionProfile,
  buildSyndicateClusterProfile,
  buildTimingFingerprintProfile,
  computeSharpnessCompositeIndex,
  computeStakeGini,
  enrichSyndicateWithIpClassification,
  evaluateIncomingTickerProfiling,
  formatComprehensiveProfileMarkdown,
  renderComprehensiveProfileAnsi,
} from "../lib/customer_profiling_enhanced.ts";
import type { CustomerRow, TicketRow } from "../lib/customer_profile.ts";
import type { NormalizedObservationTicket } from "../lib/signatures/types.ts";
import type { ReverseDnsClassification } from "../lib/bun_dns.ts";
import type { CustomerRating } from "../lib/customer_rating.ts";

describe("Enhanced Customer Profiling & Risk Forensics Engine", () => {
  it("computeStakeGini calculates accurate inequality metrics", () => {
    expect(computeStakeGini([])).toBe(0.0);
    expect(computeStakeGini([500])).toBe(0.0);
    // Perfect equality -> 0.0 Gini
    expect(computeStakeGini([100, 100, 100, 100])).toBe(0.0);
    // Moderate variation
    const moderateGini = computeStakeGini([100, 150, 120, 200]);
    expect(moderateGini).toBeGreaterThan(0.05);
    expect(moderateGini).toBeLessThan(0.35);
    // Extreme outlier / Martingale skew -> > 0.5 Gini
    const extremeGini = computeStakeGini([10, 10, 10, 1000]);
    expect(extremeGini).toBeGreaterThan(0.5);
  });

  it("buildStakeDistributionProfile classifies bettor sizing discipline", () => {
    const flatTickets: TicketRow[] = [
      { risk_usd: 100, net_usd: 90 },
      { risk_usd: 110, net_usd: 100 },
      { risk_usd: 100, net_usd: -100 },
      { risk_usd: 105, net_usd: 95 },
    ];
    const flatProfile = buildStakeDistributionProfile(flatTickets);
    expect(flatProfile.sampleCount).toBe(4);
    expect(flatProfile.strategy).toBe("FLAT_UNIT");
    expect(flatProfile.giniCoefficient).toBeLessThan(0.15);

    const martingaleTickets: TicketRow[] = [
      { risk_usd: 50, net_usd: -50 },
      { risk_usd: 100, net_usd: -100 },
      { risk_usd: 200, net_usd: -200 },
      { risk_usd: 1000, net_usd: 900 },
    ];
    const martProfile = buildStakeDistributionProfile(martingaleTickets);
    expect(["MARTINGALE_CHASER", "VARIABLE_STAKE"]).toContain(
      martProfile.strategy,
    );
    expect(martProfile.maxToMinRatio).toBe(20.0);
  });

  it("buildMarketSpecializationProfile identifies dominant league, market, and side bias", () => {
    const tickets: TicketRow[] = [
      { league: "NFL", market: "SPREAD", channel: "Internet" },
      { league: "NFL", market: "TOTAL", channel: "Internet" },
      { league: "NFL", market: "SPREAD", channel: "Internet" },
      { league: "NBA", market: "SPREAD", channel: "Live" },
      { league: "NFL", market: "OVER", channel: "Internet" },
      { league: "NFL", market: "OVER", channel: "Internet" },
    ];
    const marketProf = buildMarketSpecializationProfile(tickets);

    expect(marketProf.dominantLeague).toBe("NFL");
    expect(marketProf.dominantMarket).toBe("SPREAD");
    expect(marketProf.leagueDistribution["NFL"]).toBe(5);
    expect(marketProf.overUnderBias).toBe("OVER_HEAVY");
  });

  it("buildSyndicateClusterProfile detects multi-account sub-wallets and syndicate probability", () => {
    // Linked sub-account seat #0
    const subAccount = buildSyndicateClusterProfile(
      "GP301_0",
      "AG99",
      "MASTER_VEND",
    );
    expect(subAccount.isSubAccount).toBe(true);
    expect(subAccount.subAccountIndex).toBe(0);
    expect(subAccount.rootCustomerId).toBe("GP301");
    expect(subAccount.syndicateProbability).toBeGreaterThanOrEqual(0.5);
    expect(subAccount.clusterRiskLevel).toBe("HIGH");

    // Standard root account
    const rootAccount = buildSyndicateClusterProfile(
      "RF2003",
      "AG12",
      "MASTER_VEND",
    );
    expect(rootAccount.isSubAccount).toBe(false);
    expect(rootAccount.subAccountIndex).toBeNull();
    expect(rootAccount.syndicateProbability).toBeLessThan(0.2);
    expect(rootAccount.clusterRiskLevel).toBe("LOW");
  });

  it("enrichSyndicateWithIpClassification escalates risk when cloud/datacenter IP is detected", () => {
    const baseSyndicate = buildSyndicateClusterProfile(
      "CUST77",
      "AG10",
      "MASTER_X",
    );
    expect(baseSyndicate.clusterRiskLevel).toBe("LOW");

    const cloudIp: ReverseDnsClassification = {
      ipAddress: "146.190.10.20",
      hostnames: ["app-node.digitalocean.com"],
      primaryHostname: "app-node.digitalocean.com",
      isDatacenterOrCloud: true,
      isVpnOrProxySuspicious: true,
      organization: "DigitalOcean VPS",
    };

    const enriched = enrichSyndicateWithIpClassification(
      baseSyndicate,
      cloudIp,
    );
    expect(enriched.syndicateProbability).toBeGreaterThan(0.35);
    expect(enriched.clusterRiskLevel).toBe("ELEVATED");
    expect(
      enriched.clusterIndicators.some((i) => i.includes("DigitalOcean")),
    ).toBe(true);
  });

  it("buildPortfolioRiskForensics computes 95% VaR, CVaR and lifetime hold", () => {
    const row: CustomerRow = {
      customer_id: "SHARP_PORTFOLIO",
      agent_id: "AG_DESK",
      master_agent: "MASTER_A",
      lifetime_volume_usd: 1_000_000,
      lifetime_net_usd: 80_000, // Customer is winning $80k -> negative hold for desk
      sports_7d_volume_usd: 50_000,
      sports_7d_net_usd: 5_000,
      churn_hazard: 0.1,
    };
    const tickets: TicketRow[] = [
      { risk_usd: 5000, net_usd: 4500 },
      { risk_usd: 5000, net_usd: -5000 },
      { risk_usd: 10000, net_usd: 9000 },
    ];

    const risk = buildPortfolioRiskForensics(row, tickets);

    expect(risk.holdPercentage).toBe(-8.0); // -80k / 1M = -8.0%
    expect(risk.estimated7dVaR95Usd).toBeGreaterThan(0);
    expect(risk.estimated7dCVaR95Usd).toBeGreaterThan(risk.estimated7dVaR95Usd);
    expect(risk.projectedLtvUsd).toBeLessThan(0); // Sharp bettor has negative expected LTV to the desk
  });

  it("buildCorrelatedParlayProfile detects favorite+over, underdog+under and period cross exploits", () => {
    const parlayTickets: NormalizedObservationTicket[] = [
      // Parlay 1: Favorite Spread + Over (high correlation exploit)
      {
        ticketNumber: "TK101",
        wagerGroupKey: "PARLAY_GROUP_1",
        customerId: "SHARP_PARLAY",
        agentId: "AG1",
        placedAtYmd: "2026-11-08",
        sport: "Football",
        competitionFamily: "NFL",
        canonicalPeriod: "game",
        marketKind: "spread",
        side: "home",
        origSpread: -7.5,
        adjSpread: -7.5,
        buyPoints: 0,
        touchedKeyNumber: null,
        priceVsCloseCents: 10,
        movedInFavor: true,
        riskUsd: 1000,
        netUsd: 2600,
      },
      {
        ticketNumber: "TK102",
        wagerGroupKey: "PARLAY_GROUP_1",
        customerId: "SHARP_PARLAY",
        agentId: "AG1",
        placedAtYmd: "2026-11-08",
        sport: "Football",
        competitionFamily: "NFL",
        canonicalPeriod: "game",
        marketKind: "total",
        side: "over",
        origSpread: 48.5,
        adjSpread: 48.5,
        buyPoints: 0,
        touchedKeyNumber: null,
        priceVsCloseCents: 12,
        movedInFavor: true,
        riskUsd: 1000,
        netUsd: 2600,
      },
      // Parlay 2: 1H derivative crossed with Full Game
      {
        ticketNumber: "TK201",
        wagerGroupKey: "PARLAY_GROUP_2",
        customerId: "SHARP_PARLAY",
        agentId: "AG1",
        placedAtYmd: "2026-11-08",
        sport: "Basketball",
        competitionFamily: "NBA",
        canonicalPeriod: "1h",
        marketKind: "spread",
        side: "home",
        origSpread: -4.0,
        adjSpread: -4.0,
        buyPoints: 0,
        touchedKeyNumber: null,
        priceVsCloseCents: 15,
        movedInFavor: true,
        riskUsd: 500,
        netUsd: 1300,
      },
      {
        ticketNumber: "TK202",
        wagerGroupKey: "PARLAY_GROUP_2",
        customerId: "SHARP_PARLAY",
        agentId: "AG1",
        placedAtYmd: "2026-11-08",
        sport: "Basketball",
        competitionFamily: "NBA",
        canonicalPeriod: "game",
        marketKind: "spread",
        side: "home",
        origSpread: -7.0,
        adjSpread: -7.0,
        buyPoints: 0,
        touchedKeyNumber: null,
        priceVsCloseCents: 18,
        movedInFavor: true,
        riskUsd: 500,
        netUsd: 1300,
      },
    ];

    const cp = buildCorrelatedParlayProfile(parlayTickets);
    expect(cp.totalParlaysObserved).toBe(2);
    expect(cp.correlatedParlayCount).toBe(2);
    expect(cp.correlationExploitRate).toBe(1.0);
    expect(["HIGH", "CRITICAL"]).toContain(cp.correlationRiskTier);
    expect(
      cp.correlatedGroups.some(
        (g) => g.correlationType === "FAVORITE_SPREAD_OVER",
      ),
    ).toBe(true);
    expect(
      cp.correlatedGroups.some(
        (g) => g.correlationType === "PERIOD_DERIVATIVE_CROSS",
      ),
    ).toBe(true);
  });

  it("buildTimingFingerprintProfile classifies steam chasers, closing snipers and early originators", () => {
    const steamTickets: NormalizedObservationTicket[] = [
      {
        ticketNumber: "S1",
        customerId: "STEAM_BOT",
        agentId: "AG1",
        placedAtYmd: "2026-11-08",
        sport: "Football",
        competitionFamily: "NFL",
        canonicalPeriod: "game",
        marketKind: "spread",
        side: "home",
        origSpread: -3.0,
        adjSpread: -3.0,
        buyPoints: 0,
        touchedKeyNumber: 3,
        priceVsCloseCents: 20,
        movedInFavor: true, // Steam trigger
        riskUsd: 2000,
        netUsd: 1800,
        elapsedMinutesFromStart: -60,
      },
      {
        ticketNumber: "S2",
        customerId: "STEAM_BOT",
        agentId: "AG1",
        placedAtYmd: "2026-11-08",
        sport: "Basketball",
        competitionFamily: "NBA",
        canonicalPeriod: "game",
        marketKind: "spread",
        side: "away",
        origSpread: 5.5,
        adjSpread: 5.5,
        buyPoints: 0,
        touchedKeyNumber: null,
        priceVsCloseCents: 15,
        movedInFavor: true, // Steam trigger
        riskUsd: 2000,
        netUsd: 1800,
        elapsedMinutesFromStart: -45,
      },
    ];

    const timing = buildTimingFingerprintProfile(steamTickets);
    expect(timing.steamTriggeredCount).toBe(2);
    expect(timing.steamChaserScore).toBe(1.0);
    expect(timing.timingArchetype).toBe("STEAM_CHASER");
  });

  it("computeSharpnessCompositeIndex calculates decomposed 0-10 index and tier", () => {
    const mockRating: CustomerRating = {
      customerId: "ELITE_SHARP",
      score: 9.6,
      tier: "ELITE_SHARP",
      riskLevel: "CRITICAL",
      primaryArchetype: "key_number_buyer",
      clvSignificance: {
        meanClvPercent: 22,
        stdDevClvPercent: 5,
        sampleCount: 50,
        standardError: 5.2,
        tStatistic: 4.23,
        pValue: 0.0001,
        isSignificant95: true,
        isSignificant99: true,
      },
      bayesianSkill: {
        priorAlpha: 10,
        priorBeta: 10,
        posteriorAlpha: 61,
        posteriorBeta: 39,
        posteriorMeanWinRate: 0.61,
        variance: 0.002,
        standardDeviation: 0.045,
        credibleInterval95: [0.51, 0.7],
        status: "CONFIRMED",
      },
      recommendedAction: "ALERT_OPERATOR",
      componentScores: {
        keyNumberScore: 9.0,
        clvEdgeScore: 8.5,
        steamLatencyScore: 8.0,
        timingDisciplineScore: 8.0,
        derivativeSharpScore: 7.5,
      },
      confidence: 0.95,
      sampleSize: 50,
      totalRiskUsd: 50000,
      netUsd: 12000,
      summary: "Elite Sharp",
      autoExecute: false,
    };

    const stakeProfile = buildStakeDistributionProfile([
      { risk_usd: 500, net_usd: 450 },
      { risk_usd: 600, net_usd: 540 },
    ]);
    const correlatedProfile = buildCorrelatedParlayProfile([]);
    const timingProfile = buildTimingFingerprintProfile([]);

    const composite = computeSharpnessCompositeIndex(
      mockRating,
      stakeProfile,
      correlatedProfile,
      timingProfile,
    );

    expect(composite.overallScore).toBeGreaterThanOrEqual(8.5);
    expect(composite.tier).toBe("TIER_1_ELITE_ORIGINATOR");
    expect(composite.components.clvScore).toBe(3.0);
    expect(composite.components.bayesianSkillScore).toBe(2.5);
  });

  it("buildDeskActionDirectives establishes limits, delays, and rationales", () => {
    const mockRating: CustomerRating = {
      customerId: "SHARP_TIER1",
      score: 9.2,
      tier: "ELITE_SHARP",
      riskLevel: "CRITICAL",
      primaryArchetype: "key_number_buyer",
      recommendedAction: "ALERT_OPERATOR",
      componentScores: {
        keyNumberScore: 9.0,
        clvEdgeScore: 8.5,
        steamLatencyScore: 8.0,
        timingDisciplineScore: 8.0,
        derivativeSharpScore: 7.5,
      },
      confidence: 0.95,
      sampleSize: 50,
      totalRiskUsd: 50000,
      netUsd: 12000,
      summary: "Elite Sharp",
      autoExecute: false,
    };
    const composite = {
      overallScore: 9.2,
      tier: "TIER_1_ELITE_ORIGINATOR" as const,
      components: {
        clvScore: 3.0,
        bayesianSkillScore: 2.2,
        sizingDisciplineScore: 1.5,
        signatureSpecializationScore: 2.0,
        timingExploitationScore: 0.5,
      },
      explanation: "Test",
    };
    const stakeProf = buildStakeDistributionProfile([]);
    const synProf = buildSyndicateClusterProfile(
      "SHARP_TIER1_0",
      "AG1",
      "MASTER",
    );
    const risk = buildPortfolioRiskForensics(
      {
        customer_id: "SHARP_TIER1",
        sports_7d_volume_usd: 10000,
        sports_7d_net_usd: 1000,
      },
      [],
    );
    const timing = buildTimingFingerprintProfile([]);

    const directives = buildDeskActionDirectives(
      mockRating,
      composite,
      stakeProf,
      synProf,
      risk,
      timing,
    );

    expect(directives.action).toBe("ALERT_OPERATOR");
    expect(directives.recommendedStakeLimitUsd).toBe(250);
    expect(directives.shadowCopyMultiplier).toBe(1.0);
    expect(directives.lineShadeCents).toBe(20);
    expect(directives.syndicateQuarantine).toBe(true);
    expect(directives.rationales.length).toBeGreaterThan(0);
  });

  it("evaluateIncomingTickerProfiling flags sharp bettor tickets in real time", () => {
    const row: CustomerRow = {
      customer_id: "SHARP_PUNTER",
      agent_id: "AG_LIVE",
      master_agent: "MASTER_LIVE",
      recent_tickets: [
        { risk_usd: 500, net_usd: 450 },
        { risk_usd: 500, net_usd: 450 },
      ],
    };
    const observationTickets: NormalizedObservationTicket[] = [
      {
        ticketNumber: "TK99",
        customerId: "SHARP_PUNTER",
        agentId: "AG_LIVE",
        placedAtYmd: "2026-11-08",
        sport: "Football",
        competitionFamily: "NFL",
        canonicalPeriod: "game",
        marketKind: "spread",
        side: "home",
        origSpread: -3.0,
        adjSpread: -3.0,
        buyPoints: 0.5,
        touchedKeyNumber: 3,
        priceVsCloseCents: 25,
        movedInFavor: true,
        riskUsd: 500,
        netUsd: 450,
      },
    ];

    const profile = buildComprehensiveCustomerProfile(row, observationTickets);

    // Incoming normal ticket from non-matching customer -> null
    const otherTick = {
      CustomerID: "OTHER_USER",
      WagerNumber: "W123",
      AmountWagered: 100,
    };
    expect(evaluateIncomingTickerProfiling(otherTick, profile)).toBeNull();

    // Incoming ticket with 4x median stake spike ($2,000 vs median $500)
    const spikeTick = {
      CustomerID: "SHARP_PUNTER",
      WagerNumber: "W999",
      AmountWagered: 2000,
    };
    const alert = evaluateIncomingTickerProfiling(spikeTick, profile);
    expect(alert).not.toBeNull();
    expect(alert?.autoExecute).toBe(false);
    expect(alert?.stakeSpikeRatio).toBe(4.0);
    expect(["WARN", "CRITICAL"]).toContain(alert?.level ?? "");
    expect(alert?.toString()).toContain("Realtime Ticker Profiling Alert");
  });

  it("buildComprehensiveCustomerProfile unifies all dimensions and formats to ANSI and Markdown", () => {
    const row: CustomerRow = {
      customer_id: "BRT5229_1",
      agent_id: "AG_SHARP",
      master_agent: "MASTER_SYNDICATE",
      status: "ACTIVE",
      context_type: "VIP_SPORTS",
      lifetime_volume_usd: 750_000,
      lifetime_net_usd: 62_000,
      sports_7d_volume_usd: 80_000,
      sports_7d_net_usd: 12_000,
      sharp_score: 8.9,
      clv_bps: 145,
      churn_hazard: 0.05,
      recent_tickets: [
        {
          league: "NFL",
          market: "SPREAD",
          risk_usd: 5000,
          net_usd: 4500,
          result: "WIN",
        },
        {
          league: "NFL",
          market: "SPREAD",
          risk_usd: 5000,
          net_usd: 4500,
          result: "WIN",
        },
        {
          league: "CFB",
          market: "TOTAL",
          risk_usd: 5000,
          net_usd: -5000,
          result: "LOSS",
        },
      ],
    };

    const comp = buildComprehensiveCustomerProfile(row);

    expect(comp.customerId).toBe("BRT5229_1");
    expect(comp.syndicateProfile.isSubAccount).toBe(true);
    expect(comp.syndicateProfile.rootCustomerId).toBe("BRT5229");
    expect(comp.stakeProfile.strategy).toBe("FLAT_UNIT");
    expect(comp.marketProfile.dominantLeague).toBe("NFL");
    expect(comp.autoExecute).toBe(false);
    expect(comp.compositeSharpness.overallScore).toBeGreaterThanOrEqual(0);
    expect(comp.deskDirectives.recommendedStakeLimitUsd).toBeGreaterThan(0);

    // Markdown formatting verification
    const md = formatComprehensiveProfileMarkdown(comp);
    expect(md).toContain("BRT5229_1");
    expect(md).toContain("Comprehensive Customer Profile");
    expect(md).toContain("Unified Sharpness Composite Index");
    expect(md).toContain("Correlated Parlay & Derivative Exploit");
    expect(md).toContain("Desk Action Directives");

    // ANSI terminal formatting verification
    const ansi = renderComprehensiveProfileAnsi(comp);
    expect(ansi.length).toBeGreaterThan(0);
    expect(ansi).toContain("BRT5229_1");
  });
});
