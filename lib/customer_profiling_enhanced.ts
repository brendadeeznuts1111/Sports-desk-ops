/**
 * @file lib/customer_profiling_enhanced.ts
 * @description Advanced Multidimensional Customer Profiling, Syndicate Linkage & Risk Forensics Engine.
 *
 * Extends the baseline customer book and behavioral signature pipelines with:
 *  1. Stake Sizing & Variance Distribution (Gini coefficient, sizing strategy classification: Flat Unit vs Kelly vs Martingale)
 *  2. Market, League, Side & Timing Specialization (Spread/Total ratio, Over/Under bias, Halftime/In-play concentration)
 *  3. Syndicate & Multi-Account Downline Clustering (Sub-account linkage, shared master agent cohort risk)
 *  4. Portfolio Risk Forensics (Value-at-Risk VaR 95%, Expected Shortfall CVaR 95%, Hold %, Lifetime Value LTV)
 *  5. Correlated Parlay & Cross-Market Exploitation Analysis (Favorite+Over, Derivative Cross, SGP multipliers)
 *  6. Market Timing Fingerprint & Steam Chasing Profile (Early Originator, Steam Chaser, Closing Sniper, Halftime)
 *  7. Decomposed Unified Sharpness Composite Index (0.0 to 10.0 scale)
 *  8. Operator Desk Action Directives (Dynamic limit sizing, in-play submission delays, line shading cents)
 *  9. Real-time Ticker Profiling Surveillance & IP Forensics Enrichment
 * 10. Unified Comprehensive Customer Profile with native [Bun.inspect.custom], OSC 8 links, and AnsiTheme
 */

import {
  type CustomerRow,
  type TicketRow,
  CustomerObservations,
  normalizeCustomerId,
} from "./customer_profile.ts";
import {
  type CustomerRating,
  type RatingAction,
  rateCustomerFromObservations,
  rateCustomerFromTickets,
} from "./customer_rating.ts";
import {
  formatCustomerOsc8Markdown,
  renderAnsiMarkdown,
  type AnsiTheme,
} from "./canonical_osc8_links.ts";
import type { BunInspectOptions } from "./cli_inspect.ts";
import type { NormalizedObservationTicket } from "./signatures/types.ts";
import type { ReverseDnsClassification } from "./bun_dns.ts";
import type { F402TickerRow } from "./f402_ingest.ts";

export type StakeSizingStrategy =
  "FLAT_UNIT" | "PROPORTIONAL_KELLY" | "VARIABLE_STAKE" | "MARTINGALE_CHASER";

export interface StakeDistributionProfile {
  readonly sampleCount: number;
  readonly meanStakeUsd: number;
  readonly medianStakeUsd: number;
  readonly stdDevStakeUsd: number;
  readonly minStakeUsd: number;
  readonly maxStakeUsd: number;
  /** Gini coefficient of stake amounts: 0.0 = perfectly flat, 1.0 = maximally skewed. */
  readonly giniCoefficient: number;
  readonly strategy: StakeSizingStrategy;
  readonly maxToMinRatio: number;
}

export interface MarketSpecializationProfile {
  readonly dominantLeague: string;
  readonly dominantMarket: string;
  readonly dominantTiming: "pregame" | "in_play" | "halftime" | "mixed";
  readonly leagueDistribution: Readonly<Record<string, number>>;
  readonly marketDistribution: Readonly<Record<string, number>>;
  readonly spreadTotalRatio: number;
  readonly overUnderBias: "OVER_HEAVY" | "UNDER_HEAVY" | "BALANCED";
}

export interface SyndicateClusterProfile {
  readonly rootCustomerId: string;
  readonly subAccountIndex: number | null;
  readonly isSubAccount: boolean;
  readonly masterAgent: string;
  readonly agentId: string;
  /** Estimated probability (0.0 - 1.0) that the account operates within a multi-seat syndicate. */
  readonly syndicateProbability: number;
  readonly clusterRiskLevel: "LOW" | "ELEVATED" | "HIGH";
  readonly clusterIndicators: readonly string[];
}

export interface PortfolioRiskForensics {
  readonly sports7dVolumeUsd: number;
  readonly sports7dNetUsd: number;
  readonly lifetimeVolumeUsd: number;
  readonly lifetimeNetUsd: number;
  readonly holdPercentage: number;
  /** 95% 7-day Value-at-Risk: maximum probable loss the desk faces from this bettor. */
  readonly estimated7dVaR95Usd: number;
  /** 95% Expected Shortfall (Conditional VaR): expected tail loss beyond 95% VaR. */
  readonly estimated7dCVaR95Usd: number;
  readonly churnHazard: number;
  /** Projected lifetime value of the customer to the desk based on hold % and hazard. */
  readonly projectedLtvUsd: number;
}

export type CorrelatedExploitType =
  | "FAVORITE_SPREAD_OVER"
  | "UNDERDOG_SPREAD_UNDER"
  | "PERIOD_DERIVATIVE_CROSS"
  | "SAME_GAME_MULTIPLIER";

export interface CorrelatedParlayLeg {
  readonly ticketNumber: string;
  readonly sport: string;
  readonly marketKind: string;
  readonly side: string;
  readonly period: string;
  readonly spreadOrTotal: number | null;
}

export interface CorrelatedWagerGroup {
  readonly wagerGroupKey: string;
  readonly correlationType: CorrelatedExploitType;
  readonly explanation: string;
  readonly legs: readonly CorrelatedParlayLeg[];
  readonly totalRiskUsd: number;
}

export interface CorrelatedParlayProfile {
  readonly totalParlaysObserved: number;
  readonly correlatedParlayCount: number;
  readonly correlationExploitRate: number;
  readonly correlatedGroups: readonly CorrelatedWagerGroup[];
  readonly correlationRiskTier: "NONE" | "MODERATE" | "HIGH" | "CRITICAL";
}

export type TimingArchetype =
  | "EARLY_ORIGINATOR"
  | "STEAM_CHASER"
  | "CLOSING_SNIPER"
  | "HALFTIME_SPECIALIST"
  | "CASUAL_GAMEDAY"
  | "UNCLASSIFIED";

export interface TimingFingerprintProfile {
  readonly earlyMarketCount: number;
  readonly normalPregameCount: number;
  readonly closingSnipeCount: number;
  readonly inPlayHalftimeCount: number;
  readonly steamTriggeredCount: number;
  readonly steamChaserScore: number;
  readonly timingArchetype: TimingArchetype;
  readonly averageMinutesBeforeStart: number | null;
}

export type CompositeSharpnessTier =
  | "TIER_1_ELITE_ORIGINATOR"
  | "TIER_2_STEAM_SYNDICATE"
  | "TIER_3_SHARP_DISCIPLINED"
  | "TIER_4_SEMI_SHARP"
  | "TIER_5_RECREATIONAL";

export interface SharpnessCompositeIndex {
  readonly overallScore: number; // 0.0 - 10.0
  readonly tier: CompositeSharpnessTier;
  readonly components: {
    readonly clvScore: number; // 0.0 - 3.0
    readonly bayesianSkillScore: number; // 0.0 - 2.5
    readonly sizingDisciplineScore: number; // 0.0 - 1.5
    readonly signatureSpecializationScore: number; // 0.0 - 2.0
    readonly timingExploitationScore: number; // 0.0 - 1.0
  };
  readonly explanation: string;
}

export interface DeskActionDirectives {
  readonly action: RatingAction;
  readonly recommendedStakeLimitUsd: number;
  readonly maxToMinStakeEnforcement: number;
  readonly inPlayDelaySeconds: number;
  readonly lineShadeCents: number;
  readonly shadowCopyMultiplier: number;
  readonly syndicateQuarantine: boolean;
  readonly rationales: readonly string[];
}

export interface RealtimeTickerProfilingAlert {
  readonly type: "REALTIME_TICKER_PROFILING_ALERT";
  readonly level: "INFO" | "WARN" | "CRITICAL";
  readonly customerId: string;
  readonly ticketNumber: string;
  readonly sharpTier: string;
  readonly sharpScore: number;
  readonly triggerReason: string;
  readonly stakeUsd: number;
  readonly medianStakeUsd: number;
  readonly stakeSpikeRatio: number;
  readonly recommendedAction: RatingAction;
  readonly autoExecute: false;
  readonly [Bun.inspect.custom]?: (
    depth: number,
    options?: BunInspectOptions,
  ) => string;
  readonly toString: () => string;
}

export interface ComprehensiveCustomerProfile {
  readonly customerId: string;
  readonly agentId: string;
  readonly masterAgent: string;
  readonly status: string;
  readonly contextType: string;
  readonly rating: CustomerRating;
  readonly stakeProfile: StakeDistributionProfile;
  readonly marketProfile: MarketSpecializationProfile;
  readonly syndicateProfile: SyndicateClusterProfile;
  readonly riskForensics: PortfolioRiskForensics;
  readonly correlatedParlayProfile: CorrelatedParlayProfile;
  readonly timingProfile: TimingFingerprintProfile;
  readonly compositeSharpness: SharpnessCompositeIndex;
  readonly deskDirectives: DeskActionDirectives;
  readonly flags: readonly string[];
  readonly recommendedAction: RatingAction;
  /** Strictly invariant: Desk alert only; never auto-execute external hedges. */
  readonly autoExecute: false;
  readonly [Bun.inspect.custom]?: (
    depth: number,
    options?: BunInspectOptions,
  ) => string;
  readonly toString: () => string;
}

/* -------------------------------------------------------------------------- */
/* Mathematical Profiling Helpers                                             */
/* -------------------------------------------------------------------------- */

/**
 * Computes the Gini coefficient for an array of stake sizes.
 * Returns 0.0 for uniform bets, approaching 1.0 for highly unequal / martingale bets.
 */
export function computeStakeGini(stakes: readonly number[]): number {
  const valid = stakes.filter((s) => Number.isFinite(s) && s > 0);
  const n = valid.length;
  if (n < 2) return 0.0;

  const sorted = [...valid].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  if (sum === 0) return 0.0;

  let weightedSum = 0;
  for (let i = 0; i < n; i++) {
    weightedSum += (i + 1) * (sorted[i] ?? 0);
  }

  const rawGini = (2 * weightedSum) / (n * sum) - (n + 1) / n;
  return Math.max(0.0, Math.min(1.0, Math.round(rawGini * 1000) / 1000));
}

/**
 * Computes the stake distribution and classifies bettor sizing discipline.
 */
export function buildStakeDistributionProfile(
  tickets: readonly TicketRow[],
): StakeDistributionProfile {
  const stakes = tickets
    .map((t) => (typeof t.risk_usd === "number" ? t.risk_usd : 0))
    .filter((s) => s > 0);

  if (stakes.length === 0) {
    return {
      sampleCount: 0,
      meanStakeUsd: 0,
      medianStakeUsd: 0,
      stdDevStakeUsd: 0,
      minStakeUsd: 0,
      maxStakeUsd: 0,
      giniCoefficient: 0,
      strategy: "FLAT_UNIT",
      maxToMinRatio: 1.0,
    };
  }

  const sorted = [...stakes].sort((a, b) => a - b);
  const n = sorted.length;
  const minStakeUsd = sorted[0] ?? 0;
  const maxStakeUsd = sorted[n - 1] ?? 0;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const median =
    n % 2 === 1
      ? (sorted[Math.floor(n / 2)] ?? mean)
      : ((sorted[n / 2 - 1] ?? mean) + (sorted[n / 2] ?? mean)) / 2;

  const variance =
    n > 1
      ? sorted.reduce((acc, s) => acc + Math.pow(s - mean, 2), 0) / (n - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  const gini = computeStakeGini(sorted);
  const maxToMinRatio =
    minStakeUsd > 0 ? Math.round((maxStakeUsd / minStakeUsd) * 10) / 10 : 1.0;

  let strategy: StakeSizingStrategy = "FLAT_UNIT";
  if (gini < 0.15 && maxToMinRatio <= 2.5) {
    strategy = "FLAT_UNIT";
  } else if (gini <= 0.35 && maxToMinRatio <= 5.0) {
    strategy = "PROPORTIONAL_KELLY";
  } else if (gini > 0.55 || maxToMinRatio >= 10.0) {
    strategy = "MARTINGALE_CHASER";
  } else {
    strategy = "VARIABLE_STAKE";
  }

  return {
    sampleCount: n,
    meanStakeUsd: Math.round(mean),
    medianStakeUsd: Math.round(median),
    stdDevStakeUsd: Math.round(stdDev),
    minStakeUsd,
    maxStakeUsd,
    giniCoefficient: gini,
    strategy,
    maxToMinRatio,
  };
}

/**
 * Builds the market and sport specialization profile.
 */
export function buildMarketSpecializationProfile(
  tickets: readonly TicketRow[],
): MarketSpecializationProfile {
  const leagueCounts: Record<string, number> = {};
  const marketCounts: Record<string, number> = {};
  let spreads = 0;
  let totals = 0;
  let overs = 0;
  let unders = 0;
  let liveCount = 0;

  for (const t of tickets) {
    const l = (t.league ?? "OTHER").toUpperCase();
    const m = (t.market ?? "OTHER").toUpperCase();
    leagueCounts[l] = (leagueCounts[l] ?? 0) + 1;
    marketCounts[m] = (marketCounts[m] ?? 0) + 1;

    if (m.includes("SPREAD")) spreads++;
    if (m.includes("TOTAL")) totals++;
    if (m.includes("OVER")) overs++;
    if (m.includes("UNDER")) unders++;
    if ((t.channel ?? "").toLowerCase().includes("live")) liveCount++;
  }

  const sortedLeagues = Object.entries(leagueCounts).sort(
    (a, b) => b[1] - a[1],
  );
  const dominantLeague = sortedLeagues[0]?.[0] ?? "UNKNOWN";

  const sortedMarkets = Object.entries(marketCounts).sort(
    (a, b) => b[1] - a[1],
  );
  const dominantMarket = sortedMarkets[0]?.[0] ?? "UNKNOWN";

  const n = tickets.length;
  let dominantTiming: "pregame" | "in_play" | "halftime" | "mixed" = "pregame";
  if (n > 0 && liveCount / n >= 0.6) {
    dominantTiming = "in_play";
  } else if (n > 0 && liveCount / n >= 0.3) {
    dominantTiming = "mixed";
  }

  const spreadTotalRatio =
    totals > 0 ? Math.round((spreads / totals) * 100) / 100 : spreads;

  let overUnderBias: "OVER_HEAVY" | "UNDER_HEAVY" | "BALANCED" = "BALANCED";
  if (overs + unders >= 2) {
    if (overs / (overs + unders) >= 0.7) overUnderBias = "OVER_HEAVY";
    else if (unders / (overs + unders) >= 0.7) overUnderBias = "UNDER_HEAVY";
  }

  return {
    dominantLeague,
    dominantMarket,
    dominantTiming,
    leagueDistribution: leagueCounts,
    marketDistribution: marketCounts,
    spreadTotalRatio,
    overUnderBias,
  };
}

/**
 * Builds syndicate linkage and multi-account clustering indicators.
 */
export function buildSyndicateClusterProfile(
  customerId: string,
  agentId: string,
  masterAgent: string = "",
): SyndicateClusterProfile {
  const normId = normalizeCustomerId(customerId);
  const clusterIndicators: string[] = [];

  // Sub-account pattern detection (e.g. GP301_0, GP301_1)
  const subMatch = customerId.match(/_(\d+)$/);
  const isSubAccount = subMatch !== null;
  const subAccountIndex = subMatch ? parseInt(subMatch[1] ?? "0", 10) : null;
  const rootCustomerId = normId;

  if (isSubAccount) {
    clusterIndicators.push(
      `Linked sub-account detected: parent root is ${rootCustomerId} (seat #${subAccountIndex})`,
    );
  }

  let syndicateProbability = 0.05;
  if (isSubAccount) {
    syndicateProbability += 0.45;
  }
  if (masterAgent !== "" && masterAgent !== "UNKNOWN") {
    clusterIndicators.push(`Downline anchored to Master Agent: ${masterAgent}`);
  }

  let clusterRiskLevel: "LOW" | "ELEVATED" | "HIGH" = "LOW";
  if (syndicateProbability >= 0.5) clusterRiskLevel = "HIGH";
  else if (syndicateProbability >= 0.25) clusterRiskLevel = "ELEVATED";

  return {
    rootCustomerId,
    subAccountIndex,
    isSubAccount,
    masterAgent,
    agentId,
    syndicateProbability: Math.round(syndicateProbability * 100) / 100,
    clusterRiskLevel,
    clusterIndicators,
  };
}

/**
 * Enriches a syndicate cluster profile with IP reverse DNS and hosting classifications.
 */
export function enrichSyndicateWithIpClassification(
  syndicateProfile: SyndicateClusterProfile,
  ipClassification: ReverseDnsClassification,
): SyndicateClusterProfile {
  const clusterIndicators = [...syndicateProfile.clusterIndicators];
  let prob = syndicateProfile.syndicateProbability;

  if (
    ipClassification.isDatacenterOrCloud ||
    ipClassification.isVpnOrProxySuspicious
  ) {
    clusterIndicators.push(
      `Cloud / Proxy IP detected: ${ipClassification.organization} (${ipClassification.ipAddress})`,
    );
    prob = Math.min(1.0, prob + 0.35);
  }

  let clusterRiskLevel: "LOW" | "ELEVATED" | "HIGH" =
    syndicateProfile.clusterRiskLevel;
  if (prob >= 0.5) clusterRiskLevel = "HIGH";
  else if (prob >= 0.25) clusterRiskLevel = "ELEVATED";

  return {
    ...syndicateProfile,
    syndicateProbability: Math.round(prob * 100) / 100,
    clusterRiskLevel,
    clusterIndicators,
  };
}

/**
 * Computes portfolio risk forensics: Value-at-Risk (VaR), CVaR, hold %, and LTV.
 */
export function buildPortfolioRiskForensics(
  row: CustomerRow,
  tickets: readonly TicketRow[],
): PortfolioRiskForensics {
  const vol7d = Number(row.sports_7d_volume_usd) || 0;
  const net7d = Number(row.sports_7d_net_usd) || 0;
  const volLife = Number(row.lifetime_volume_usd) || 0;
  const netLife = Number(row.lifetime_net_usd) || 0;
  const hazard = Number(row.churn_hazard) || 0.15;

  const holdPct =
    volLife > 0 ? Math.round((-netLife / volLife) * 1000) / 10 : 0.0;

  // Compute 7d VaR and CVaR from recent ticket stakes
  const stakes = tickets
    .map((t) => (typeof t.risk_usd === "number" ? t.risk_usd : 0))
    .filter((s) => s > 0);
  const sumSq = stakes.reduce((acc, s) => acc + s * s, 0);
  const sampleStdDev = Math.sqrt(sumSq);

  // Scaled to 7-day horizon:
  const baseScale = vol7d > 0 ? Math.sqrt(vol7d / Math.max(1, volLife)) : 0.5;
  const dailySigma =
    sampleStdDev > 0 ? sampleStdDev : Math.max(100, vol7d * 0.1);

  // 95% 1-tailed Normal: Z = 1.645, CVaR coefficient ~ 2.06
  const estimated7dVaR95Usd = Math.round(
    1.645 * dailySigma * Math.sqrt(7) * baseScale,
  );
  const estimated7dCVaR95Usd = Math.round(
    2.06 * dailySigma * Math.sqrt(7) * baseScale,
  );

  // Projected LTV based on remaining active horizon: (1 / hazard) * monthly volume * hold rate
  const monthlyVol = vol7d > 0 ? vol7d * 4.3 : volLife / 6;
  const holdFraction = holdPct / 100;
  const activeMonths = hazard > 0 ? Math.min(24, 1.0 / hazard) : 6;
  const projectedLtvUsd = Math.round(monthlyVol * holdFraction * activeMonths);

  return {
    sports7dVolumeUsd: vol7d,
    sports7dNetUsd: net7d,
    lifetimeVolumeUsd: volLife,
    lifetimeNetUsd: netLife,
    holdPercentage: holdPct,
    estimated7dVaR95Usd: Math.max(0, estimated7dVaR95Usd),
    estimated7dCVaR95Usd: Math.max(0, estimated7dCVaR95Usd),
    churnHazard: hazard,
    projectedLtvUsd,
  };
}

/**
 * Analyzes correlated multi-leg tickets / parlays and evaluates systemic correlation exploit risk.
 */
export function buildCorrelatedParlayProfile(
  observationTickets: readonly NormalizedObservationTicket[],
): CorrelatedParlayProfile {
  const groupMap = new Map<string, NormalizedObservationTicket[]>();
  for (const t of observationTickets) {
    if (t.wagerGroupKey) {
      const list = groupMap.get(t.wagerGroupKey) ?? [];
      list.push(t);
      groupMap.set(t.wagerGroupKey, list);
    }
  }

  const detectedGroups: CorrelatedWagerGroup[] = [];
  for (const [wagerGroupKey, legs] of groupMap.entries()) {
    if (legs.length < 2) continue;

    let favoriteSpread = false;
    let underdogSpread = false;
    let totalOver = false;
    let totalUnder = false;
    let has1H = false;
    let hasGame = false;
    let totalRisk = 0;

    const parlayLegs: CorrelatedParlayLeg[] = [];
    for (const leg of legs) {
      totalRisk = Math.max(totalRisk, leg.riskUsd);
      parlayLegs.push({
        ticketNumber: leg.ticketNumber,
        sport: leg.sport,
        marketKind: leg.marketKind,
        side: leg.side,
        period: leg.canonicalPeriod,
        spreadOrTotal: leg.adjSpread ?? leg.origSpread,
      });

      if (leg.marketKind === "spread") {
        const spread = leg.adjSpread ?? leg.origSpread ?? 0;
        if (spread < 0 || leg.side === "home") favoriteSpread = true;
        if (spread > 0 || leg.side === "away") underdogSpread = true;
      }
      if (leg.marketKind === "total") {
        if (leg.side === "over") totalOver = true;
        if (leg.side === "under") totalUnder = true;
      }
      if (leg.canonicalPeriod === "1h") has1H = true;
      if (leg.canonicalPeriod === "game") hasGame = true;
    }

    if (favoriteSpread && totalOver) {
      detectedGroups.push({
        wagerGroupKey,
        correlationType: "FAVORITE_SPREAD_OVER",
        explanation:
          "Correlated Favorite Spread coupled with Game Total Over (high-scoring covariance exploit)",
        legs: parlayLegs,
        totalRiskUsd: totalRisk,
      });
    } else if (underdogSpread && totalUnder) {
      detectedGroups.push({
        wagerGroupKey,
        correlationType: "UNDERDOG_SPREAD_UNDER",
        explanation:
          "Correlated Underdog Spread coupled with Game Total Under (low-scoring covariance exploit)",
        legs: parlayLegs,
        totalRiskUsd: totalRisk,
      });
    } else if (has1H && hasGame) {
      detectedGroups.push({
        wagerGroupKey,
        correlationType: "PERIOD_DERIVATIVE_CROSS",
        explanation:
          "Cross-period derivative correlation (1H and Full Game linked on same outcome)",
        legs: parlayLegs,
        totalRiskUsd: totalRisk,
      });
    } else if (
      legs.length >= 2 &&
      legs.every((l) => l.sport === legs[0]?.sport)
    ) {
      detectedGroups.push({
        wagerGroupKey,
        correlationType: "SAME_GAME_MULTIPLIER",
        explanation: "Same-competition multi-leg combination",
        legs: parlayLegs,
        totalRiskUsd: totalRisk,
      });
    }
  }

  const totalParlaysObserved = groupMap.size;
  const correlatedParlayCount = detectedGroups.length;
  const correlationExploitRate =
    totalParlaysObserved > 0
      ? Math.round((correlatedParlayCount / totalParlaysObserved) * 100) / 100
      : 0.0;

  let correlationRiskTier: "NONE" | "MODERATE" | "HIGH" | "CRITICAL" = "NONE";
  if (
    correlatedParlayCount >= 3 ||
    (totalParlaysObserved >= 2 && correlationExploitRate >= 0.5)
  ) {
    correlationRiskTier = "CRITICAL";
  } else if (correlatedParlayCount >= 2) {
    correlationRiskTier = "HIGH";
  } else if (correlatedParlayCount === 1) {
    correlationRiskTier = "MODERATE";
  }

  return {
    totalParlaysObserved,
    correlatedParlayCount,
    correlationExploitRate,
    correlatedGroups: detectedGroups,
    correlationRiskTier,
  };
}

/**
 * Builds placement timing signature and steam-chasing / line-sniping fingerprint.
 */
export function buildTimingFingerprintProfile(
  observationTickets: readonly NormalizedObservationTicket[],
): TimingFingerprintProfile {
  let earlyMarketCount = 0;
  let normalPregameCount = 0;
  let closingSnipeCount = 0;
  let inPlayHalftimeCount = 0;
  let steamTriggeredCount = 0;
  let minutesSum = 0;
  let minutesCount = 0;

  for (const t of observationTickets) {
    let elapsedMin: number | null = t.elapsedMinutesFromStart ?? null;
    if (elapsedMin === null && t.placedAt && t.eventStartsAt) {
      const placedMs = new Date(t.placedAt).getTime();
      const startMs = new Date(t.eventStartsAt).getTime();
      if (!Number.isNaN(placedMs) && !Number.isNaN(startMs)) {
        elapsedMin = Math.round((placedMs - startMs) / 60000);
      }
    }

    if (elapsedMin !== null) {
      minutesSum += elapsedMin;
      minutesCount++;
      if (elapsedMin < -1440) {
        earlyMarketCount++;
      } else if (elapsedMin >= -15 && elapsedMin < 0) {
        closingSnipeCount++;
      } else if (elapsedMin >= 0) {
        inPlayHalftimeCount++;
      } else {
        normalPregameCount++;
      }
    } else {
      if (t.timing === "in_play" || t.timing === "halftime") {
        inPlayHalftimeCount++;
      } else {
        normalPregameCount++;
      }
    }

    if (t.movedInFavor === true && (t.priceVsCloseCents ?? 0) > 0) {
      steamTriggeredCount++;
    }
  }

  const n = observationTickets.length;
  const steamChaserScore =
    n > 0 ? Math.round((steamTriggeredCount / n) * 100) / 100 : 0.0;
  const averageMinutesBeforeStart =
    minutesCount > 0 ? Math.round(minutesSum / minutesCount) : null;

  let timingArchetype: TimingArchetype = "UNCLASSIFIED";
  if (n >= 2) {
    if (earlyMarketCount / n >= 0.4) {
      timingArchetype = "EARLY_ORIGINATOR";
    } else if (steamChaserScore >= 0.5) {
      timingArchetype = "STEAM_CHASER";
    } else if (closingSnipeCount / n >= 0.4) {
      timingArchetype = "CLOSING_SNIPER";
    } else if (inPlayHalftimeCount / n >= 0.5) {
      timingArchetype = "HALFTIME_SPECIALIST";
    } else if (normalPregameCount / n >= 0.6) {
      timingArchetype = "CASUAL_GAMEDAY";
    }
  }

  return {
    earlyMarketCount,
    normalPregameCount,
    closingSnipeCount,
    inPlayHalftimeCount,
    steamTriggeredCount,
    steamChaserScore,
    timingArchetype,
    averageMinutesBeforeStart,
  };
}

/**
 * Computes a multi-factor decomposed sharpness composite score (0.0 to 10.0 scale).
 */
export function computeSharpnessCompositeIndex(
  rating: CustomerRating,
  stakeProfile: StakeDistributionProfile,
  correlatedProfile: CorrelatedParlayProfile,
  timingProfile: TimingFingerprintProfile,
): SharpnessCompositeIndex {
  // 1. CLV component: 0.0 to 3.0
  let clvScore = 0.0;
  if (rating.clvSignificance) {
    const t = rating.clvSignificance.tStatistic;
    if (t >= 3.0) clvScore = 3.0;
    else if (t >= 2.0) clvScore = 2.4;
    else if (t >= 1.0) clvScore = 1.6;
    else if (t > 0) clvScore = 0.8;
  } else if (rating.componentScores?.clvEdgeScore) {
    clvScore = Math.min(3.0, (rating.componentScores.clvEdgeScore / 10) * 3.0);
  }

  // 2. Bayesian skill component: 0.0 to 2.5
  let bayesianSkillScore = 0.0;
  if (rating.bayesianSkill) {
    const wr = rating.bayesianSkill.posteriorMeanWinRate;
    if (wr >= 0.6) bayesianSkillScore = 2.5;
    else if (wr >= 0.55) bayesianSkillScore = 2.0;
    else if (wr >= 0.53) bayesianSkillScore = 1.2;
    else if (wr >= 0.51) bayesianSkillScore = 0.5;
  } else if (rating.score >= 7.0) {
    bayesianSkillScore = Math.min(2.5, (rating.score / 10) * 2.5);
  }

  // 3. Sizing discipline component: 0.0 to 1.5
  let sizingDisciplineScore = 0.5;
  if (stakeProfile.strategy === "PROPORTIONAL_KELLY") {
    sizingDisciplineScore = 1.5;
  } else if (stakeProfile.strategy === "FLAT_UNIT") {
    sizingDisciplineScore = 1.2;
  } else if (stakeProfile.strategy === "MARTINGALE_CHASER") {
    sizingDisciplineScore = 0.0;
  }

  // 4. Signature specialization component: 0.0 to 2.0
  let signatureSpecializationScore = 0.0;
  if (rating.tier === "ELITE_SHARP") {
    signatureSpecializationScore = 2.0;
  } else if (rating.tier === "SHARP") {
    signatureSpecializationScore = 1.5;
  } else if (rating.tier === "SEMI_SHARP") {
    signatureSpecializationScore = 0.8;
  }

  // 5. Timing & Correlated parlay exploitation component: 0.0 to 1.0
  let timingExploitationScore = 0.0;
  if (
    timingProfile.timingArchetype === "STEAM_CHASER" ||
    timingProfile.timingArchetype === "EARLY_ORIGINATOR"
  ) {
    timingExploitationScore += 0.5;
  }
  if (
    correlatedProfile.correlationRiskTier === "CRITICAL" ||
    correlatedProfile.correlationRiskTier === "HIGH"
  ) {
    timingExploitationScore += 0.5;
  } else if (correlatedProfile.correlationRiskTier === "MODERATE") {
    timingExploitationScore += 0.25;
  }
  timingExploitationScore = Math.min(1.0, timingExploitationScore);

  const rawSum =
    clvScore +
    bayesianSkillScore +
    sizingDisciplineScore +
    signatureSpecializationScore +
    timingExploitationScore;
  const overallScore = Math.min(10.0, Math.round(rawSum * 10) / 10);

  let tier: CompositeSharpnessTier = "TIER_5_RECREATIONAL";
  if (overallScore >= 8.5) tier = "TIER_1_ELITE_ORIGINATOR";
  else if (overallScore >= 7.0) tier = "TIER_2_STEAM_SYNDICATE";
  else if (overallScore >= 5.5) tier = "TIER_3_SHARP_DISCIPLINED";
  else if (overallScore >= 4.0) tier = "TIER_4_SEMI_SHARP";

  const explanation =
    `Decomposed Score ${overallScore.toFixed(1)}/10.0 [CLV: ${clvScore.toFixed(1)}/3.0, ` +
    `Skill: ${bayesianSkillScore.toFixed(1)}/2.5, Sizing: ${sizingDisciplineScore.toFixed(1)}/1.5, ` +
    `Sig: ${signatureSpecializationScore.toFixed(1)}/2.0, Timing/Parlay: ${timingExploitationScore.toFixed(1)}/1.0] -> ${tier}`;

  return {
    overallScore,
    tier,
    components: {
      clvScore: Math.round(clvScore * 10) / 10,
      bayesianSkillScore: Math.round(bayesianSkillScore * 10) / 10,
      sizingDisciplineScore: Math.round(sizingDisciplineScore * 10) / 10,
      signatureSpecializationScore:
        Math.round(signatureSpecializationScore * 10) / 10,
      timingExploitationScore: Math.round(timingExploitationScore * 10) / 10,
    },
    explanation,
  };
}

/**
 * Derives actionable operator directives, limit ceilings, and live delays based on profile telemetry.
 */
export function buildDeskActionDirectives(
  rating: CustomerRating,
  composite: SharpnessCompositeIndex,
  _stakeProfile: StakeDistributionProfile,
  syndicateProfile: SyndicateClusterProfile,
  riskForensics: PortfolioRiskForensics,
  timingProfile: TimingFingerprintProfile,
): DeskActionDirectives {
  const rationales: string[] = [];
  let action: RatingAction = rating.recommendedAction;

  let recommendedStakeLimitUsd = 10000;
  let shadowCopyMultiplier = 0.0;
  let inPlayDelaySeconds = 0;
  let lineShadeCents = 0;
  const maxToMinStakeEnforcement = 3.0;

  if (composite.tier === "TIER_1_ELITE_ORIGINATOR") {
    recommendedStakeLimitUsd = 250;
    shadowCopyMultiplier = 1.0;
    lineShadeCents = 20;
    action = "ALERT_OPERATOR";
    rationales.push(
      "Tier 1 Elite Originator: severely reduce betting limit to $250; full 1.0 shadow copy recommended.",
    );
  } else if (composite.tier === "TIER_2_STEAM_SYNDICATE") {
    recommendedStakeLimitUsd = 500;
    shadowCopyMultiplier = 0.75;
    lineShadeCents = 15;
    action = "ALERT_OPERATOR";
    rationales.push(
      "Tier 2 Steam Syndicate: throttle betting limit to $500; 0.75 shadow copy recommended.",
    );
  } else if (composite.tier === "TIER_3_SHARP_DISCIPLINED") {
    recommendedStakeLimitUsd = 1000;
    shadowCopyMultiplier = 0.5;
    lineShadeCents = 10;
    rationales.push(
      "Tier 3 Sharp Disciplined: cap limit at $1,000; monitor for timing escalation.",
    );
  } else if (composite.tier === "TIER_4_SEMI_SHARP") {
    recommendedStakeLimitUsd = 2500;
    rationales.push("Tier 4 Semi-Sharp: standard sharp limits ($2,500).");
  } else {
    // Recreational
    if (
      riskForensics.holdPercentage > 5.0 &&
      riskForensics.lifetimeVolumeUsd > 10000
    ) {
      action = "ACCEPT";
      recommendedStakeLimitUsd = 25000;
      rationales.push(
        "High-volume profitable customer (hold > 5%): raise limit to $25,000 to maximize house revenue.",
      );
    } else {
      rationales.push("Recreational bettor: standard house limits ($10,000).");
    }
  }

  if (
    timingProfile.timingArchetype === "STEAM_CHASER" ||
    timingProfile.inPlayHalftimeCount > 5
  ) {
    inPlayDelaySeconds = 3;
    rationales.push(
      "Active in-play / steam chaser: impose 3-second live wager delay.",
    );
  }

  const syndicateQuarantine =
    syndicateProfile.clusterRiskLevel === "HIGH" ||
    syndicateProfile.syndicateProbability >= 0.5;
  if (syndicateQuarantine) {
    action = "ALERT_OPERATOR";
    rationales.push(
      "Syndicate cluster flag: quarantine linked downline accounts for compliance audit.",
    );
  }

  return {
    action,
    recommendedStakeLimitUsd,
    maxToMinStakeEnforcement,
    inPlayDelaySeconds,
    lineShadeCents,
    shadowCopyMultiplier,
    syndicateQuarantine,
    rationales,
  };
}

/**
 * Pure evaluator for incoming live ticker wagers against comprehensive customer profiles.
 * Adheres strictly to the `autoExecute: false` invariant.
 */
export function evaluateIncomingTickerProfiling(
  row: F402TickerRow | Record<string, unknown>,
  profile: ComprehensiveCustomerProfile,
): RealtimeTickerProfilingAlert | null {
  const raw = row as Record<string, unknown>;
  const customerId = (raw.CustomerID ??
    raw.customerId ??
    raw.Login ??
    raw.login ??
    "") as string;
  const normalizedId = normalizeCustomerId(customerId);
  if (normalizedId !== profile.customerId) return null;

  const wagerNum = String(raw.WagerNumber ?? raw.wagerNumber ?? "");
  const stake = Number(raw.AmountWagered ?? raw.amountWagered ?? 0);
  const medianStake = profile.stakeProfile.medianStakeUsd || 100;
  const stakeSpikeRatio = Math.round((stake / medianStake) * 10) / 10;

  const isSharpTier =
    profile.compositeSharpness.tier === "TIER_1_ELITE_ORIGINATOR" ||
    profile.compositeSharpness.tier === "TIER_2_STEAM_SYNDICATE" ||
    profile.rating.tier === "ELITE_SHARP";

  const isLargeStakeSpike = stakeSpikeRatio >= 3.0 && stake >= 500;

  if (
    !isSharpTier &&
    !isLargeStakeSpike &&
    profile.deskDirectives.action !== "ALERT_OPERATOR"
  ) {
    return null;
  }

  let level: "INFO" | "WARN" | "CRITICAL" = "INFO";
  let triggerReason = "";

  if (isSharpTier && isLargeStakeSpike) {
    level = "CRITICAL";
    triggerReason = `Sharp customer (${profile.compositeSharpness.tier}) fired ${stakeSpikeRatio}x median stake ($${stake} vs median $${medianStake})`;
  } else if (isSharpTier) {
    level =
      profile.compositeSharpness.tier === "TIER_1_ELITE_ORIGINATOR"
        ? "CRITICAL"
        : "WARN";
    triggerReason = `Sharp customer (${profile.compositeSharpness.tier}) ticket submission ($${stake})`;
  } else if (isLargeStakeSpike) {
    level = "WARN";
    triggerReason = `Anomalous stake spike detected (${stakeSpikeRatio}x median: $${stake} vs $${medianStake})`;
  } else {
    level = "INFO";
    triggerReason = `Desk directive alert for customer ${profile.customerId}`;
  }

  const alert: RealtimeTickerProfilingAlert = {
    type: "REALTIME_TICKER_PROFILING_ALERT",
    level,
    customerId: profile.customerId,
    ticketNumber: wagerNum,
    sharpTier: profile.compositeSharpness.tier,
    sharpScore: profile.compositeSharpness.overallScore,
    triggerReason,
    stakeUsd: stake,
    medianStakeUsd: medianStake,
    stakeSpikeRatio,
    recommendedAction: profile.recommendedAction,
    autoExecute: false,
    [Bun.inspect.custom](
      _depth: number = 0,
      _options: BunInspectOptions = {},
    ): string {
      return `[${this.level}] Realtime Ticker Profiling Alert: ${this.customerId} (Tier: ${this.sharpTier}, Score: ${this.sharpScore}/10) · ${this.triggerReason} · Ticket #${this.ticketNumber} · Stake: $${this.stakeUsd} (Action: ${this.recommendedAction})`;
    },
    toString(): string {
      return `[${this.level}] Realtime Ticker Profiling Alert: ${this.customerId} (Tier: ${this.sharpTier}) · ${this.triggerReason}`;
    },
  };

  return alert;
}

/**
 * Builds a comprehensive, unified customer profile combining hierarchy, behavioral
 * signatures, stake distribution, syndicate linkage, portfolio risk forensics,
 * correlated parlays, and timing fingerprints.
 */
export function buildComprehensiveCustomerProfile(
  row: CustomerRow,
  observationTickets: readonly NormalizedObservationTicket[] = [],
): ComprehensiveCustomerProfile {
  const customerId = (row.customer_id ?? "").trim();
  const agentId = (row.agent_id ?? "").trim();
  const masterAgent = (row.master_agent ?? "UNKNOWN").trim();
  const status = (row.status ?? "ACTIVE").trim();
  const contextType = (row.context_type ?? "REGULAR").trim();
  const tickets = row.recent_tickets ?? [];

  const stakeProfile = buildStakeDistributionProfile(tickets);
  const marketProfile = buildMarketSpecializationProfile(tickets);
  const syndicateProfile = buildSyndicateClusterProfile(
    customerId,
    agentId,
    masterAgent,
  );
  const riskForensics = buildPortfolioRiskForensics(row, tickets);
  const correlatedParlayProfile =
    buildCorrelatedParlayProfile(observationTickets);
  const timingProfile = buildTimingFingerprintProfile(observationTickets);

  let rating: CustomerRating;
  if (observationTickets.length > 0) {
    rating = rateCustomerFromTickets(customerId, observationTickets);
  } else {
    // Fallback from customer book row numbers
    const obs = new CustomerObservations(
      customerId,
      tickets.length,
      riskForensics.lifetimeVolumeUsd,
      riskForensics.lifetimeNetUsd,
      [],
      "2026-10-01",
      "2026-11-09",
    );
    rating = rateCustomerFromObservations(obs);
  }

  const compositeSharpness = computeSharpnessCompositeIndex(
    rating,
    stakeProfile,
    correlatedParlayProfile,
    timingProfile,
  );

  const deskDirectives = buildDeskActionDirectives(
    rating,
    compositeSharpness,
    stakeProfile,
    syndicateProfile,
    riskForensics,
    timingProfile,
  );

  const flags: string[] = [];
  if (syndicateProfile.isSubAccount) {
    flags.push(
      `SYNDICATE_SUB_ACCOUNT:${syndicateProfile.rootCustomerId}_${syndicateProfile.subAccountIndex}`,
    );
  }
  if (stakeProfile.strategy === "MARTINGALE_CHASER") {
    flags.push("STAKE_VOLATILITY:MARTINGALE");
  }
  if (rating.tier === "ELITE_SHARP" || rating.tier === "SHARP") {
    flags.push(`SHARP_TIER:${rating.tier}`);
  }
  if (riskForensics.holdPercentage < 0) {
    flags.push(`NEGATIVE_HOLD:${riskForensics.holdPercentage}%`);
  }
  if (correlatedParlayProfile.correlationRiskTier !== "NONE") {
    flags.push(
      `CORRELATED_EXPLOIT:${correlatedParlayProfile.correlationRiskTier}`,
    );
  }
  if (timingProfile.timingArchetype !== "UNCLASSIFIED") {
    flags.push(`TIMING_ARCHETYPE:${timingProfile.timingArchetype}`);
  }

  let recommendedAction: RatingAction = deskDirectives.action;
  if (syndicateProfile.clusterRiskLevel === "HIGH" && rating.score >= 7.0) {
    recommendedAction = "ALERT_OPERATOR";
  }

  const profile: ComprehensiveCustomerProfile = {
    customerId,
    agentId,
    masterAgent,
    status,
    contextType,
    rating,
    stakeProfile,
    marketProfile,
    syndicateProfile,
    riskForensics,
    correlatedParlayProfile,
    timingProfile,
    compositeSharpness,
    deskDirectives,
    flags,
    recommendedAction,
    autoExecute: false,
    [Bun.inspect.custom](
      depth: number = 0,
      options: BunInspectOptions = {},
    ): string {
      return formatComprehensiveProfileAnsi(this, options);
    },
    toString(): string {
      return formatComprehensiveProfileAnsi(this, { colors: false });
    },
  };

  return profile;
}

/* -------------------------------------------------------------------------- */
/* Terminal & Markdown Formatters                                             */
/* -------------------------------------------------------------------------- */

export function formatComprehensiveProfileMarkdown(
  p: ComprehensiveCustomerProfile,
): string {
  const custLink = formatCustomerOsc8Markdown(p.customerId);
  const r = p.rating;
  const s = p.stakeProfile;
  const m = p.marketProfile;
  const syn = p.syndicateProfile;
  const risk = p.riskForensics;
  const cp = p.correlatedParlayProfile;
  const tp = p.timingProfile;
  const comp = p.compositeSharpness;
  const desk = p.deskDirectives;

  return (
    `## 📊 Comprehensive Customer Profile: ${custLink}\n\n` +
    `> Hierarchy: Agent **${p.agentId}** · Master **${p.masterAgent}** · Status: \`${p.status}\` · Action: \`${p.recommendedAction}\`\n\n` +
    `### 1. Unified Sharpness Composite Index (0.0 - 10.0)\n` +
    `- **Composite Score**: **${comp.overallScore.toFixed(1)}/10.0** · Tier: \`${comp.tier}\`\n` +
    `- **Score Breakdown**: CLV: **${comp.components.clvScore.toFixed(1)}/3.0** | Skill: **${comp.components.bayesianSkillScore.toFixed(1)}/2.5** | Sizing: **${comp.components.sizingDisciplineScore.toFixed(1)}/1.5** | Sig: **${comp.components.signatureSpecializationScore.toFixed(1)}/2.0** | Timing/Parlay: **${comp.components.timingExploitationScore.toFixed(1)}/1.0**\n` +
    `- **Analysis**: *${comp.explanation}*\n\n` +
    `### 2. Sharpness & Behavioral Rating\n` +
    `- **Baseline Tier / Risk**: \`${r.tier}\` / \`${r.riskLevel}\` (Score: **${r.score.toFixed(1)}/10**)\n` +
    `- **Primary Archetype**: \`${r.primaryArchetype}\`\n` +
    (r.bayesianSkill
      ? `- **Bayesian Skill**: Win Rate **${(r.bayesianSkill.posteriorMeanWinRate * 100).toFixed(1)}%** ` +
        `(95% CI: [${(r.bayesianSkill.credibleInterval95[0] * 100).toFixed(1)}%, ${(r.bayesianSkill.credibleInterval95[1] * 100).toFixed(1)}%], ` +
        `Status: \`${r.bayesianSkill.status}\`)\n`
      : "") +
    (r.clvSignificance
      ? `- **CLV Significance**: t-statistic \`${r.clvSignificance.tStatistic.toFixed(2)}\` ` +
        `(p=\`${r.clvSignificance.pValue.toFixed(4)}\`, ${r.clvSignificance.isSignificant99 ? "99% Significant" : "Not Significant"})\n`
      : "") +
    `\n### 3. Stake Sizing & Variance Discipline\n` +
    `- **Sizing Strategy**: \`${s.strategy}\` (Gini Coefficient: **${s.giniCoefficient.toFixed(3)}**)\n` +
    `- **Stake Distribution**: Mean **$${s.meanStakeUsd.toLocaleString()}** | Median **$${s.medianStakeUsd.toLocaleString()}** | Max/Min Ratio **${s.maxToMinRatio}x**\n` +
    `\n### 4. Market & Timing Specialization\n` +
    `- **Dominant Sport / Market**: \`${m.dominantLeague}\` / \`${m.dominantMarket}\`\n` +
    `- **Execution Timing**: \`${m.dominantTiming}\` · Side Bias: \`${m.overUnderBias}\`\n` +
    `- **Timing Archetype**: \`${tp.timingArchetype}\` (Steam Chaser Score: **${(tp.steamChaserScore * 100).toFixed(0)}%**)\n` +
    `- **Spread-to-Total Ratio**: \`${m.spreadTotalRatio.toFixed(2)}\`\n` +
    `\n### 5. Correlated Parlay & Derivative Exploit Forensics\n` +
    `- **Correlation Risk Tier**: \`${cp.correlationRiskTier}\` (Exploit Rate: **${(cp.correlationExploitRate * 100).toFixed(0)}%**)\n` +
    `- **Parlays Observed**: **${cp.totalParlaysObserved}** (Correlated Groups: **${cp.correlatedParlayCount}**)\n` +
    (cp.correlatedGroups.length > 0
      ? `- **Detected Vectors**: ${cp.correlatedGroups.map((g) => `\`${g.correlationType}\``).join(", ")}\n`
      : "") +
    `\n### 6. Syndicate Linkage & Cluster Analysis\n` +
    `- **Sub-Account Linked**: ${syn.isSubAccount ? `🚨 YES (Parent: \`${syn.rootCustomerId}\`, Seat: #${syn.subAccountIndex})` : "NO (Root Account)"}\n` +
    `- **Syndicate Probability**: **${(syn.syndicateProbability * 100).toFixed(0)}%** (Cluster Risk: \`${syn.clusterRiskLevel}\`)\n` +
    (syn.clusterIndicators.length > 0
      ? `- **Cluster Flags**: ${syn.clusterIndicators.join("; ")}\n`
      : "") +
    `\n### 7. Portfolio Risk & Capital Forensics\n` +
    `- **Lifetime Metrics**: Volume **$${Math.round(risk.lifetimeVolumeUsd).toLocaleString()}** | Net **$${Math.round(risk.lifetimeNetUsd).toLocaleString()}** (Hold: **${risk.holdPercentage.toFixed(1)}%**)\n` +
    `- **7-Day Risk at Hazard (VaR 95%)**: **$${risk.estimated7dVaR95Usd.toLocaleString()}** (CVaR 95%: **$${risk.estimated7dCVaR95Usd.toLocaleString()}**)\n` +
    `- **Projected Lifetime Value (LTV)**: **$${risk.projectedLtvUsd.toLocaleString()}** (Hazard: \`${risk.churnHazard.toFixed(2)}\`)\n` +
    `\n### 8. Desk Action Directives\n` +
    `- **Recommended Max Stake Limit**: **$${desk.recommendedStakeLimitUsd.toLocaleString()}**\n` +
    `- **In-Play Submission Delay**: **${desk.inPlayDelaySeconds}s** | Line Shading: **${desk.lineShadeCents}¢**\n` +
    `- **Shadow Copy Multiplier**: **${desk.shadowCopyMultiplier.toFixed(2)}x** | Syndicate Quarantine: \`${desk.syndicateQuarantine}\`\n` +
    `- **Directive Rationales**: ${desk.rationales.join("; ")}\n`
  );
}

export function formatComprehensiveProfileAnsi(
  profile: ComprehensiveCustomerProfile,
  _options: BunInspectOptions = {},
): string {
  const md = formatComprehensiveProfileMarkdown(profile);
  return renderAnsiMarkdown(md);
}

export function renderComprehensiveProfileAnsi(
  profile: ComprehensiveCustomerProfile,
  theme?: AnsiTheme,
): string {
  const md = formatComprehensiveProfileMarkdown(profile);
  return renderAnsiMarkdown(md, theme);
}
