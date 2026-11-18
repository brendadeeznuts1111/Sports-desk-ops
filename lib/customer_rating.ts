/**
 * @file lib/customer_rating.ts
 * @description Customer Sharpness Rating & Real-Time Incoming Wager Profiling Engine.
 *
 * Synthesizes customer observations, the 5 active behavioral signature cohorts
 * (`football_key_number_discipline`, `in_play_activity`, `post_halftime_activity`,
 * `pre_move_betting`, `cbb_under_concentration`), closing line value (CLV) edge, and
 * point-buy disciplines into a composite 0.0-10.0 Sharpness Score and Risk Tier.
 *
 * Integrates natively with Bun's terminal formatting, `[Bun.inspect.custom]`, OSC 8
 * terminal hyperlinks, and Bun's official `AnsiTheme` specification.
 */

import {
  type CustomerBehavioralArchetype,
  CustomerObservations,
  type CustomerRow,
  type FootballKeyNumber,
  type TicketRow,
  isKeyNumberBuy,
  normalizeCustomerId,
  normalizeObservationTicket,
  runCustomerSignaturePipeline,
} from "./customer_profile.ts";
import type { EnrichedTicketMaster } from "./f402_figure_date_enricher.ts";
import {
  formatCustomerOsc8Markdown,
  getCanonicalCustomerUrl,
  renderAnsiMarkdown,
  type AnsiTheme,
} from "./canonical_osc8_links.ts";
import type { BunInspectOptions } from "./cli_inspect.ts";
import type {
  NormalizedObservationTicket,
  WagerTiming,
} from "./signatures/types.ts";

export type CustomerSharpnessTier =
  "ELITE_SHARP" | "SHARP" | "SEMI_SHARP" | "RECREATIONAL" | "SQUARE";

export type CustomerRiskLevel =
  "CRITICAL" | "HIGH" | "ELEVATED" | "STANDARD" | "LOW";

export type RatingAction = "ALERT_OPERATOR" | "MONITOR" | "ACCEPT" | "INSPECT";

export type ClvRatingSource = "ticket_prices" | "book_clv_bps" | "none";

export interface RateObservationOptions {
  readonly measuredClvBps?: number | null;
}

export interface CustomerComponentScores {
  /** 0..10 score measuring concentration on football key numbers (3, 7, 10, 14, 21). */
  readonly keyNumberScore: number;
  /** 0..10 score measuring average price advantage over closing price (CLV). */
  readonly clvEdgeScore: number;
  /** 0..10 score measuring steam timing and pre-move betting latency. */
  readonly steamLatencyScore: number;
  /** 0..10 score measuring in-play execution speed and 2nd-half specialization. */
  readonly timingDisciplineScore: number;
  /** 0..10 score measuring derivative/niche market exploitation (e.g. CBB totals). */
  readonly derivativeSharpScore: number;
}

export interface BayesianSkillProfile {
  readonly priorAlpha: number;
  readonly priorBeta: number;
  readonly posteriorAlpha: number;
  readonly posteriorBeta: number;
  readonly posteriorMeanWinRate: number;
  readonly variance: number;
  readonly standardDeviation: number;
  readonly credibleInterval95: readonly [number, number];
  readonly status: "PRELIMINARY" | "CONVERGING" | "CONFIRMED";
}

export interface KellySizingMetrics {
  readonly impliedKellyFraction: number;
  readonly halfKellyFraction: number;
  readonly quarterKellyFraction: number;
  readonly observedUnitFraction: number;
  readonly kellyDivergence: number;
  readonly isKellyDisciplined: boolean;
  readonly growthRate: number;
}

export interface ClvStatisticalSignificance {
  readonly meanClvPercent: number;
  readonly stdDevClvPercent: number;
  readonly sampleCount: number;
  readonly standardError: number;
  readonly tStatistic: number;
  readonly pValue: number;
  readonly isSignificant95: boolean;
  readonly isSignificant99: boolean;
}

export interface CustomerRating {
  readonly customerId: string;
  /** Composite Sharpness Score from 0.0 (extreme square) to 10.0 (elite syndicate sharp). */
  readonly score: number;
  readonly tier: CustomerSharpnessTier;
  readonly riskLevel: CustomerRiskLevel;
  readonly primaryArchetype: CustomerBehavioralArchetype;
  readonly componentScores: CustomerComponentScores;
  readonly confidence: number;
  readonly sampleSize: number;
  readonly totalRiskUsd: number;
  readonly netUsd: number;
  readonly recommendedAction: RatingAction;
  readonly bayesianSkill?: BayesianSkillProfile;
  readonly clvSignificance?: ClvStatisticalSignificance;
  readonly kellyMetrics?: KellySizingMetrics;
  /** Strictly invariant: Informational alert only; NEVER auto-execute on external exchanges/Kalshi/Polymarket. */
  readonly autoExecute: false;
  readonly summary: string;
  readonly [Bun.inspect.custom]?: (
    depth: number,
    options?: BunInspectOptions,
  ) => string;
  readonly toString: () => string;
}

export interface CustomerRatingBookResult extends CustomerRating {
  readonly clvBps: number | null;
  readonly clvSource: ClvRatingSource;
  readonly signatures: readonly string[];
  readonly activeDays: number;
}

export interface RatedIncomingWager {
  readonly type: "RATED_INCOMING_WAGER";
  readonly ticketNumber: string;
  readonly customerId: string;
  readonly rating: CustomerRating;
  readonly level: "CRITICAL" | "WARN" | "INFO";
  readonly touchesKey: boolean;
  readonly touchedKeys: readonly FootballKeyNumber[];
  readonly buyPoints: number;
  readonly timing: WagerTiming | "unknown";
  readonly riskUsd: number;
  readonly flags: readonly string[];
  readonly message: string;
  readonly wagerKelly?: KellySizingMetrics;
  /** Strictly invariant: Informational desk alert only; NEVER auto-execute on external markets. */
  readonly autoExecute: false;
  readonly [Bun.inspect.custom]?: (
    depth: number,
    options?: BunInspectOptions,
  ) => string;
  readonly toString: () => string;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

/**
 * Computes sequential Bayesian skill updates for a bettor based on their closing line value (CLV).
 */
function buildBetaSkillProfile(
  wins: number,
  losses: number,
  sampleCount: number,
  priorAlpha: number = 10,
  priorBeta: number = 10,
): BayesianSkillProfile {
  const posteriorAlpha = priorAlpha + wins;
  const posteriorBeta = priorBeta + losses;
  const total = posteriorAlpha + posteriorBeta;
  const posteriorMeanWinRate =
    Math.round((posteriorAlpha / total) * 1000) / 1000;
  const variance =
    (posteriorAlpha * posteriorBeta) / (total * total * (total + 1));
  const standardDeviation = Math.round(Math.sqrt(variance) * 1000) / 1000;

  const low95 = Math.max(
    0,
    Math.round((posteriorMeanWinRate - 1.96 * standardDeviation) * 1000) / 1000,
  );
  const high95 = Math.min(
    1,
    Math.round((posteriorMeanWinRate + 1.96 * standardDeviation) * 1000) / 1000,
  );

  let status: "PRELIMINARY" | "CONVERGING" | "CONFIRMED" = "PRELIMINARY";
  if (sampleCount >= 50 || standardDeviation < 0.04) {
    status = "CONFIRMED";
  } else if (sampleCount >= 15) {
    status = "CONVERGING";
  }

  return {
    priorAlpha,
    priorBeta,
    posteriorAlpha: Math.round(posteriorAlpha * 10) / 10,
    posteriorBeta: Math.round(posteriorBeta * 10) / 10,
    posteriorMeanWinRate,
    variance: Math.round(variance * 100000) / 100000,
    standardDeviation,
    credibleInterval95: [low95, high95],
    status,
  };
}

export function computeBayesianSkillProfile(
  tickets: readonly NormalizedObservationTicket[],
  priorAlpha: number = 10,
  priorBeta: number = 10,
): BayesianSkillProfile {
  let clvWins = 0;
  let clvLosses = 0;

  for (const t of tickets) {
    const clv = t.priceVsCloseCents;
    if (clv !== null && clv !== undefined) {
      if (clv > 0) clvWins += 1;
      else if (clv < 0) clvLosses += 1;
      else {
        clvWins += 0.5;
        clvLosses += 0.5;
      }
    } else if (t.movedInFavor === true) {
      clvWins += 1;
    } else if (t.movedInFavor === false) {
      clvLosses += 1;
    } else {
      clvWins += 0.5;
      clvLosses += 0.5;
    }
  }

  return buildBetaSkillProfile(
    clvWins,
    clvLosses,
    tickets.length,
    priorAlpha,
    priorBeta,
  );
}

/**
 * Computes CLV statistical significance: t-statistic, standard error, and two-tailed p-value.
 */
export function computeClvSignificance(
  clvSamples: readonly number[],
): ClvStatisticalSignificance {
  const n = clvSamples.length;
  if (n < 2) {
    const single = clvSamples[0] ?? 0;
    return {
      meanClvPercent: Math.round(single * 1000) / 10,
      stdDevClvPercent: 0,
      sampleCount: n,
      standardError: 0,
      tStatistic: 0,
      pValue: 1.0,
      isSignificant95: false,
      isSignificant99: false,
    };
  }

  const mean = clvSamples.reduce((a, b) => a + b, 0) / n;
  const variance =
    clvSamples.reduce((acc, x) => acc + Math.pow(x - mean, 2), 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const standardError = stdDev / Math.sqrt(n);
  const tStatistic = standardError > 0 ? mean / standardError : 0;

  const absZ = Math.abs(tStatistic);
  const pValue = Math.min(
    1.0,
    Math.max(0.0, 2.0 / (1.0 + Math.exp(1.702 * absZ))),
  );

  return {
    meanClvPercent: Math.round(mean * 1000) / 10,
    stdDevClvPercent: Math.round(stdDev * 1000) / 10,
    sampleCount: n,
    standardError: Math.round(standardError * 10000) / 10000,
    tStatistic: Math.round(tStatistic * 100) / 100,
    pValue: Math.round(pValue * 10000) / 10000,
    isSignificant95: pValue < 0.05,
    isSignificant99: pValue < 0.01,
  };
}

/**
 * Computes fractional Kelly allocation, divergence, and capital growth rate.
 */
export function computeKellyMetrics(
  oddsPrice: number,
  estimatedWinProbability: number,
  riskAmountUsd: number,
  bankrollUsd: number = 10_000,
): KellySizingMetrics {
  let decimalOdds = 1.909;
  if (oddsPrice > 0) {
    decimalOdds = 1 + oddsPrice / 100;
  } else if (oddsPrice < 0) {
    decimalOdds = 1 + 100 / Math.abs(oddsPrice);
  }
  const b = Math.max(0.01, decimalOdds - 1);
  const p = Math.max(0.01, Math.min(0.99, estimatedWinProbability));
  const q = 1 - p;

  const rawKelly = (b * p - q) / b;
  const impliedKellyFraction = Math.max(
    0,
    Math.round(rawKelly * 10000) / 10000,
  );
  const halfKellyFraction =
    Math.round(impliedKellyFraction * 0.5 * 10000) / 10000;
  const quarterKellyFraction =
    Math.round(impliedKellyFraction * 0.25 * 10000) / 10000;

  const observedUnitFraction =
    bankrollUsd > 0
      ? Math.round((riskAmountUsd / bankrollUsd) * 10000) / 10000
      : 0;

  const divergence = Math.abs(observedUnitFraction - halfKellyFraction);
  const isKellyDisciplined =
    impliedKellyFraction > 0 &&
    observedUnitFraction >= quarterKellyFraction * 0.8 &&
    observedUnitFraction <= halfKellyFraction * 1.5;

  const f = Math.min(0.99, observedUnitFraction);
  const growthRate =
    p * Math.log(Math.max(0.0001, 1 + f * b)) +
    q * Math.log(Math.max(0.0001, 1 - f));

  return {
    impliedKellyFraction,
    halfKellyFraction,
    quarterKellyFraction,
    observedUnitFraction,
    kellyDivergence: Math.round(divergence * 10000) / 10000,
    isKellyDisciplined,
    growthRate: Math.round(growthRate * 10000) / 10000,
  };
}

/**
 * Rates a customer based on their accumulated observations and behavioral signatures.
 */
export function rateCustomerFromObservations(
  obs: CustomerObservations,
  options?: RateObservationOptions,
): CustomerRating {
  const normId = normalizeCustomerId(obs.customerId);

  let keyNumberScore = 0;
  let clvEdgeScore = 0;
  let steamLatencyScore = 0;
  let timingDisciplineScore = 0;
  let derivativeSharpScore = 0;

  let hasKeySig = false;
  let hasSteamSig = false;
  let hasInPlaySig = false;
  let has2HSig = false;
  let hasCbbSig = false;

  for (const sig of obs.signatures) {
    switch (sig.kind) {
      case "football_key_number_discipline": {
        hasKeySig = true;
        const keyRatio = sig.onKey / Math.max(1, sig.totalSpread);
        const buyRatio =
          (sig.boughtKeyCount ?? 0) / Math.max(1, sig.totalSpread);
        // Key number density > 35% is highly significant; buys directly onto key numbers heavily weighted
        keyNumberScore = clamp(keyRatio * 15 + buyRatio * 10, 0, 10);
        break;
      }
      case "pre_move_betting": {
        hasSteamSig = true;
        const moveRatio = sig.moveCount / Math.max(1, sig.totalCount);
        const liveShare = (sig.liveCount ?? 0) / Math.max(1, sig.moveCount);
        steamLatencyScore = clamp(moveRatio * 14 + liveShare * 4, 0, 10);
        break;
      }
      case "in_play_activity": {
        hasInPlaySig = true;
        const liveRatio = sig.liveCount / Math.max(1, sig.totalCount);
        timingDisciplineScore = Math.max(
          timingDisciplineScore,
          clamp(liveRatio * 12, 0, 10),
        );
        break;
      }
      case "post_halftime_activity":
      case "second_half_concentration": {
        has2HSig = true;
        const twoHRatio = sig.twoHalfCount / Math.max(1, sig.totalCount);
        timingDisciplineScore = Math.max(
          timingDisciplineScore,
          clamp(twoHRatio * 14, 0, 10),
        );
        break;
      }
      case "cbb_under_concentration": {
        hasCbbSig = true;
        const underRatio = sig.underCount / Math.max(1, sig.cbbTotalCount);
        derivativeSharpScore = clamp(underRatio * 12, 0, 10);
        break;
      }
      case "half_point_buys": {
        const buyRatio = (sig.keyNumberBuys ?? 0) / Math.max(1, sig.buyCount);
        keyNumberScore = Math.max(keyNumberScore, clamp(buyRatio * 10, 0, 8));
        break;
      }
    }
  }

  // Net win / loss and CLV edge estimation
  const measuredClvBps = options?.measuredClvBps;
  const hasMeasuredClv =
    typeof measuredClvBps === "number" && Number.isFinite(measuredClvBps);
  if (hasMeasuredClv) {
    clvEdgeScore = clamp(5 + (measuredClvBps / 100) * 1.25, 0, 10);
    if (obs.nTickets > 0 && measuredClvBps >= 0) {
      const avgRisk = obs.totalRiskUsd / obs.nTickets;
      if (avgRisk > 3000) {
        clvEdgeScore = clamp(clvEdgeScore + 0.5, 0, 10);
      }
    }
  } else if (obs.nTickets > 0) {
    const avgRisk = obs.totalRiskUsd / obs.nTickets;
    const winRate = obs.netUsd / Math.max(1, obs.totalRiskUsd);
    if (winRate > 0.05) {
      clvEdgeScore = clamp(5 + winRate * 25, 0, 10);
    } else if (winRate < -0.05) {
      clvEdgeScore = clamp(5 + winRate * 20, 0, 5);
    } else {
      clvEdgeScore = 5.0;
    }

    if (avgRisk > 3000) {
      // Big bettor volume weight
      clvEdgeScore = clamp(clvEdgeScore + 1.0, 0, 10);
    }
  }

  // Confidence adjustment based on ticket volume
  const sampleVolumeFactor = clamp(
    Math.log10(obs.nTickets + 1) / 2.0,
    0.2,
    1.0,
  );
  const confidence = round1(sampleVolumeFactor);

  // Composite Sharpness Score calculation
  const weightedSum =
    keyNumberScore * 0.3 +
    clvEdgeScore * 0.25 +
    steamLatencyScore * 0.2 +
    timingDisciplineScore * 0.15 +
    derivativeSharpScore * 0.1;

  // Determine Primary Archetype
  let primaryArchetype: CustomerBehavioralArchetype = "recreational";
  const maxComponent = Math.max(
    keyNumberScore,
    steamLatencyScore,
    timingDisciplineScore,
    derivativeSharpScore,
  );

  // If a bettor displays strong specialization in any sharp dimension, that sets their sharpness baseline
  const compositeSharpness =
    maxComponent > 0
      ? maxComponent * 0.65 + clvEdgeScore * 0.25 + weightedSum * 0.1
      : clvEdgeScore;

  // Scale score dampened by sample confidence
  const rawScore = compositeSharpness * (0.75 + 0.25 * sampleVolumeFactor);
  const score = round1(clamp(rawScore, 0.0, 10.0));

  if (score < 2.5) {
    primaryArchetype = "square";
  } else if (maxComponent === keyNumberScore && hasKeySig) {
    primaryArchetype = "key_number_buyer";
  } else if (maxComponent === steamLatencyScore && hasSteamSig) {
    primaryArchetype = "early_line_mover";
  } else if (
    maxComponent === timingDisciplineScore &&
    (has2HSig || hasInPlaySig)
  ) {
    primaryArchetype = has2HSig
      ? "post_halftime_specialist"
      : "in_play_specialist";
  } else if (maxComponent === derivativeSharpScore && hasCbbSig) {
    primaryArchetype = "cbb_under_concentration";
  } else if (score >= 6.0) {
    primaryArchetype = "closing_line_sharp";
  }

  // Tier, Risk Level, and Recommended Action
  let tier: CustomerSharpnessTier;
  let riskLevel: CustomerRiskLevel;
  let recommendedAction: RatingAction;

  if (score >= 8.5) {
    tier = "ELITE_SHARP";
    riskLevel = "CRITICAL";
    recommendedAction = "ALERT_OPERATOR";
  } else if (score >= 7.0) {
    tier = "SHARP";
    riskLevel = "HIGH";
    recommendedAction = "ALERT_OPERATOR";
  } else if (score >= 5.0) {
    tier = "SEMI_SHARP";
    riskLevel = "ELEVATED";
    recommendedAction = "MONITOR";
  } else if (score >= 2.5) {
    tier = "RECREATIONAL";
    riskLevel = "STANDARD";
    recommendedAction = "ACCEPT";
  } else {
    tier = "SQUARE";
    riskLevel = "LOW";
    recommendedAction = "ACCEPT";
  }

  const componentScores: CustomerComponentScores = {
    keyNumberScore: round1(keyNumberScore),
    clvEdgeScore: round1(clvEdgeScore),
    steamLatencyScore: round1(steamLatencyScore),
    timingDisciplineScore: round1(timingDisciplineScore),
    derivativeSharpScore: round1(derivativeSharpScore),
  };

  const summary =
    `Customer ${normId}: ${tier} (Score: ${score}/10.0, Risk: ${riskLevel}) | ` +
    `Archetype: ${primaryArchetype} | Action: ${recommendedAction} | N=${obs.nTickets}`;

  const rating: CustomerRating = {
    customerId: normId,
    score,
    tier,
    riskLevel,
    primaryArchetype,
    componentScores,
    confidence,
    sampleSize: obs.nTickets,
    totalRiskUsd: obs.totalRiskUsd,
    netUsd: obs.netUsd,
    recommendedAction,
    autoExecute: false,
    summary,
    [Bun.inspect.custom](
      depth: number = 0,
      options: BunInspectOptions = {},
    ): string {
      return formatCustomerRating(this, depth, options);
    },
    toString(): string {
      return formatCustomerRating(this, 1, { colors: false });
    },
  };

  return rating;
}

/**
 * Rates a customer directly from their normalized observation tickets.
 */
export function rateCustomerFromTickets(
  customerId: string,
  tickets: readonly NormalizedObservationTicket[],
): CustomerRating {
  const normId = normalizeCustomerId(customerId);
  const relevantTickets = tickets.filter(
    (t) => normalizeCustomerId(t.customerId) === normId,
  );
  const pipeline = runCustomerSignaturePipeline(relevantTickets);
  const obs =
    pipeline.observations.get(normId) ??
    pipeline.observations.get(customerId) ??
    null;

  if (obs) {
    const base = rateCustomerFromObservations(obs);
    const bayesianSkill = computeBayesianSkillProfile(relevantTickets);
    const clvSamples = relevantTickets
      .map((t) => t.priceVsCloseCents)
      .filter((c): c is number => c !== null && c !== undefined)
      .map((c) => c / 100);
    const clvSignificance = computeClvSignificance(clvSamples);
    const avgRisk = obs.nTickets > 0 ? obs.totalRiskUsd / obs.nTickets : 100;
    const kellyMetrics = computeKellyMetrics(
      -110,
      bayesianSkill.posteriorMeanWinRate,
      avgRisk,
    );
    return {
      ...base,
      bayesianSkill,
      clvSignificance,
      kellyMetrics,
    };
  }

  // Fallback empty rating for zero-ticket customer
  const emptyScores: CustomerComponentScores = {
    keyNumberScore: 0,
    clvEdgeScore: 5,
    steamLatencyScore: 0,
    timingDisciplineScore: 0,
    derivativeSharpScore: 0,
  };

  return {
    customerId: normId,
    score: 5.0,
    tier: "RECREATIONAL",
    riskLevel: "STANDARD",
    primaryArchetype: "recreational",
    componentScores: emptyScores,
    confidence: 0.1,
    sampleSize: 0,
    totalRiskUsd: 0,
    netUsd: 0,
    recommendedAction: "ACCEPT",
    autoExecute: false,
    summary: `Customer ${normId}: UNRATED (0 tickets)`,
    [Bun.inspect.custom](
      depth: number = 0,
      options: BunInspectOptions = {},
    ): string {
      return formatCustomerRating(this, depth, options);
    },
    toString(): string {
      return formatCustomerRating(this, 1, { colors: false });
    },
  };
}

function finiteRatingNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function inferTicketPeriodDescription(
  market?: string,
  selection?: string,
): string {
  const combined = `${market ?? ""} ${selection ?? ""}`.trim();
  if (/\b(?:2nd\s*half|2h|second\s*half)\b/i.test(combined)) {
    return "2nd Half";
  }
  if (/\b(?:1st\s*half|1h|first\s*half)\b/i.test(combined)) {
    return "1st Half";
  }
  if (/\b(?:1st\s*q(?:uarter)?|1q|q1)\b/i.test(combined)) {
    return "1st Quarter";
  }
  if (/\b(?:2nd\s*q(?:uarter)?|2q|q2)\b/i.test(combined)) {
    return "2nd Quarter";
  }
  if (/\b(?:3rd\s*q(?:uarter)?|3q|q3)\b/i.test(combined)) {
    return "3rd Quarter";
  }
  if (/\b(?:4th\s*q(?:uarter)?|4q|q4)\b/i.test(combined)) {
    return "4th Quarter";
  }
  return "";
}

function inferTicketWagerType(market?: string): string | undefined {
  const m = (market ?? "").trim();
  if (m === "") return undefined;
  if (/\b(?:spread|point\s*spread|run\s*line|puck\s*line)\b/i.test(m)) {
    return "S";
  }
  if (/\b(?:total|over\/under|o\/u)\b/i.test(m)) {
    return "L";
  }
  if (/\b(?:money\s*line|ml)\b/i.test(m)) {
    return "M";
  }
  return undefined;
}

/**
 * Converts book `recent_tickets` (`TicketRow[]`) into `NormalizedObservationTicket[]`
 * via the canonical `normalizeObservationTicket` mapper without synthesizing ticket CLV.
 */
export function ticketRowsToObservationTickets(
  customerId: string,
  tickets: readonly TicketRow[],
  agentId: string = "",
): NormalizedObservationTicket[] {
  const normId = normalizeCustomerId(customerId || "UNKNOWN");
  return tickets.map((t, idx) => {
    const rec = t as unknown as Record<string, unknown>;
    const league = typeof t.league === "string" ? t.league.trim() : "";
    const market = typeof t.market === "string" ? t.market.trim() : "";
    const selection = typeof t.selection === "string" ? t.selection.trim() : "";
    const periodDescription = inferTicketPeriodDescription(market, selection);
    const wagerType = inferTicketWagerType(market);
    const rawPriceVsClose =
      finiteRatingNum(rec["priceVsCloseCents"]) ??
      finiteRatingNum(rec["price_vs_close_cents"]);
    const rawMoved = rec["movedInFavor"] ?? rec["moved_in_favor"];

    return normalizeObservationTicket({
      CustomerID: normId,
      AgentID: agentId,
      WagerNumber: t.wager_number ?? idx + 1,
      SportType: league,
      SportSubType: league,
      PeriodDescription: periodDescription,
      ...(wagerType !== undefined ? { WagerType: wagerType } : {}),
      ShortDesc: selection || market,
      Description: [league, market, selection].filter(Boolean).join(" "),
      AmountWagered: Number(t.risk_usd) || 0,
      ToWinAmount: Number(t.win_usd) || 0,
      NetAmount: Number(t.net_usd) || 0,
      TicketWriter: typeof t.channel === "string" ? t.channel : "",
      PlacedOn: typeof t.channel === "string" ? t.channel : "",
      InsertDateTime: typeof t.placed_at === "string" ? t.placed_at : "",
      ...(rawPriceVsClose !== null
        ? { priceVsCloseCents: rawPriceVsClose }
        : {}),
      ...(typeof rawMoved === "boolean" ? { movedInFavor: rawMoved } : {}),
    });
  });
}

/**
 * Rates a `CustomerRow` using real ticket signatures, dates, sign-safe player net,
 * book `clv_bps` / ticket CLV, Bayesian skill, and realistic unit Kelly sizing.
 */
export function rateCustomerBookRow(
  row: CustomerRow,
  fallbackId?: string,
  preNormalizedTickets?: readonly NormalizedObservationTicket[],
): CustomerRatingBookResult {
  const rec = row as unknown as Record<string, unknown>;
  const rawId = String(row.customer_id ?? fallbackId ?? "").trim();
  const normId = normalizeCustomerId(rawId || fallbackId || "UNKNOWN");
  const rawTickets = Array.isArray(row.recent_tickets)
    ? row.recent_tickets
    : [];
  const obsTickets =
    preNormalizedTickets ??
    ticketRowsToObservationTickets(normId, rawTickets, row.agent_id ?? "");

  const pipeline = runCustomerSignaturePipeline(obsTickets);
  const obsFromPipeline = pipeline.observations.get(normId) ?? null;
  const signatures = [...(obsFromPipeline?.signatures ?? [])].sort((a, b) =>
    a.kind.localeCompare(b.kind),
  );

  const validYmds = obsTickets
    .map((t) => t.placedAtYmd)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d !== "1970-01-01")
    .sort();
  const rawLastActive =
    typeof rec["last_active_at"] === "string"
      ? rec["last_active_at"].slice(0, 10)
      : "";
  const fallbackYmd =
    /^\d{4}-\d{2}-\d{2}$/.test(rawLastActive) && rawLastActive !== "1970-01-01"
      ? rawLastActive
      : new Date().toISOString().slice(0, 10);
  const firstSeen = validYmds[0] ?? fallbackYmd;
  const lastSeen = validYmds[validYmds.length - 1] ?? firstSeen;

  const rawVolLife = finiteRatingNum(row.lifetime_volume_usd);
  const rawWagers = finiteRatingNum(rec["total_wagers"]);
  const nTickets = Math.max(
    obsFromPipeline?.nTickets ?? 0,
    rawWagers !== null && rawWagers > 0 ? Math.round(rawWagers) : 0,
    rawTickets.length,
  );
  const activeDays = new Set(validYmds).size || (nTickets > 0 ? 1 : 0);
  const totalRiskUsd =
    rawVolLife !== null && rawVolLife > 0
      ? rawVolLife
      : (obsFromPipeline?.totalRiskUsd ?? 0);

  // `enriched_customers_full.json` stores `lifetime_net_usd` with desk-net sign matching `hold_pct`.
  // Only flip to player net when `hold_pct` is explicit, non-zero, and shares the same sign.
  const rawNetLife = finiteRatingNum(row.lifetime_net_usd);
  const rawHoldPct = finiteRatingNum(rec["hold_pct"]);
  const isDeskSignNet =
    rawNetLife !== null &&
    rawNetLife !== 0 &&
    rawHoldPct !== null &&
    rawHoldPct !== 0 &&
    Math.sign(rawNetLife) === Math.sign(rawHoldPct);
  const playerNetUsd =
    rawNetLife !== null
      ? isDeskSignNet
        ? -rawNetLife
        : rawNetLife
      : (obsFromPipeline?.netUsd ?? 0);

  const ticketClvCents = obsTickets
    .map((t) => t.priceVsCloseCents)
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  const rowClvBps = finiteRatingNum(row.clv_bps);

  let clvSource: ClvRatingSource = "none";
  let clvBps: number | null = null;
  let clvSignificance: ClvStatisticalSignificance | undefined;
  if (ticketClvCents.length > 0) {
    clvSource = "ticket_prices";
    const clvSamples = ticketClvCents.map((c) => c / 100);
    clvSignificance = computeClvSignificance(clvSamples);
    const meanDec =
      clvSamples.reduce((acc, v) => acc + v, 0) / clvSamples.length;
    clvBps = rowClvBps ?? Math.round(meanDec * 10_000);
  } else if (rowClvBps !== null) {
    clvSource = "book_clv_bps";
    clvBps = rowClvBps;
    // Single aggregate book CLV: honest sampleCount=1, pValue=1.0, never overstated as n>=2.
    clvSignificance = computeClvSignificance([rowClvBps / 10_000]);
  }

  const obs = new CustomerObservations(
    normId,
    nTickets,
    totalRiskUsd,
    playerNetUsd,
    signatures,
    firstSeen,
    lastSeen,
    obsFromPipeline?.sportMix,
    obsFromPipeline?.competitionFamilyMix,
  );
  const baseRating = rateCustomerFromObservations(obs, {
    measuredClvBps: clvBps,
  });

  const hasPerTicketClvEvidence = obsTickets.some(
    (t) =>
      (t.priceVsCloseCents !== null && t.priceVsCloseCents !== undefined) ||
      t.movedInFavor !== null,
  );
  let bayesianSkill: BayesianSkillProfile;
  if (hasPerTicketClvEvidence) {
    bayesianSkill = computeBayesianSkillProfile(obsTickets);
  } else {
    let settledWins = 0;
    let settledLosses = 0;
    for (const ticket of rawTickets) {
      const res =
        typeof ticket.result === "string"
          ? ticket.result.trim().toUpperCase()
          : "";
      const net = finiteRatingNum(ticket.net_usd);
      if (
        res === "W" ||
        res === "WIN" ||
        (res === "" && net !== null && net > 0)
      ) {
        settledWins += 1;
      } else if (
        res === "L" ||
        res === "LOSS" ||
        (res === "" && net !== null && net < 0)
      ) {
        settledLosses += 1;
      }
    }
    const settledCount = settledWins + settledLosses;
    bayesianSkill =
      settledCount > 0
        ? buildBetaSkillProfile(settledWins, settledLosses, settledCount)
        : computeBayesianSkillProfile([]);
  }

  const rawAvgBet = finiteRatingNum(rec["average_bet_usd"]);
  const ticketRisks = rawTickets
    .map((t) => finiteRatingNum(t.risk_usd))
    .filter((r): r is number => r !== null && r > 0);
  const meanTicketRisk =
    ticketRisks.length > 0
      ? ticketRisks.reduce((a, b) => a + b, 0) / ticketRisks.length
      : null;
  const avgUnitRiskUsd =
    rawAvgBet !== null && rawAvgBet > 0
      ? rawAvgBet
      : meanTicketRisk !== null
        ? meanTicketRisk
        : rawWagers !== null && rawWagers > 0 && totalRiskUsd > 0
          ? totalRiskUsd / rawWagers
          : 100;
  const bankrollUsd = Math.max(
    10_000,
    Math.round(Math.max(avgUnitRiskUsd * 20, totalRiskUsd * 0.1)),
  );
  const kellyWinProb =
    clvSource === "ticket_prices"
      ? bayesianSkill.posteriorMeanWinRate
      : clvSource === "book_clv_bps" && clvBps !== null
        ? clamp(0.52381 + clvBps / 10_000, 0.35, 0.65)
        : bayesianSkill.posteriorMeanWinRate;
  const kellyMetrics = computeKellyMetrics(
    -110,
    kellyWinProb,
    avgUnitRiskUsd,
    bankrollUsd,
  );

  return {
    ...baseRating,
    bayesianSkill,
    ...(clvSignificance !== undefined ? { clvSignificance } : {}),
    kellyMetrics,
    clvBps,
    clvSource,
    signatures: signatures.map((s) => s.kind),
    activeDays,
  };
}

/**
 * Rates an incoming wager against the customer's sharpness profile.
 */
export function rateIncomingWager(
  ticket: EnrichedTicketMaster,
  rating: CustomerRating,
): RatedIncomingWager {
  const normCustomerId = normalizeCustomerId(ticket.CustomerID);
  const keyBuyCheck = isKeyNumberBuy(ticket.adjSpread, ticket.buyPoints);
  const touchesKey = keyBuyCheck.isKey || keyBuyCheck.is3or7;
  const touchedKeys = keyBuyCheck.touchedKeys;
  const flags: string[] = [];

  let level: "CRITICAL" | "WARN" | "INFO" = "INFO";

  if (touchesKey) {
    flags.push(`KEY_NUMBER_BUY:${touchedKeys.join(",")}`);
  }
  if (ticket.buyPoints > 0) {
    flags.push(`BUY_PTS:${ticket.buyPoints}`);
  }
  if (ticket.amountWageredUsd >= 5000) {
    flags.push("HIGH_STAKE");
  }

  // Evaluate risk level
  if (rating.tier === "ELITE_SHARP") {
    level = "CRITICAL";
  } else if (rating.tier === "SHARP") {
    level = touchesKey || ticket.amountWageredUsd >= 2000 ? "CRITICAL" : "WARN";
  } else if (rating.tier === "SEMI_SHARP") {
    level = touchesKey ? "WARN" : "INFO";
  }

  const message =
    `Incoming Wager ${ticket.TicketNumber || ticket.WagerNumber} by ${normCustomerId} [${rating.tier} ${rating.score}/10] ` +
    `Risk=$${ticket.amountWageredUsd.toLocaleString()} ` +
    (touchesKey ? `touches key ${touchedKeys.join(",")} ` : "") +
    `-> ${rating.recommendedAction}`;

  const wagerKelly = computeKellyMetrics(
    -110,
    rating.bayesianSkill?.posteriorMeanWinRate ?? 0.524,
    ticket.amountWageredUsd,
    10_000,
  );

  const ratedWager: RatedIncomingWager = {
    type: "RATED_INCOMING_WAGER",
    ticketNumber: ticket.TicketNumber || ticket.WagerNumber,
    customerId: normCustomerId,
    rating,
    level,
    touchesKey,
    touchedKeys,
    buyPoints: ticket.buyPoints,
    timing: "unknown",
    riskUsd: ticket.amountWageredUsd,
    flags,
    message,
    wagerKelly,
    autoExecute: false,
    [Bun.inspect.custom](
      depth: number = 0,
      options: BunInspectOptions = {},
    ): string {
      return formatRatedIncomingWager(this, depth, options);
    },
    toString(): string {
      return formatRatedIncomingWager(this, 1, { colors: false });
    },
  };

  return ratedWager;
}

/**
 * Batch-rates all customers present in a collection of observation tickets,
 * returning a leaderboard sorted descending by Sharpness Score.
 */
export function batchRateCustomers(
  tickets: readonly NormalizedObservationTicket[],
): readonly CustomerRating[] {
  const pipeline = runCustomerSignaturePipeline(tickets);
  const ratings: CustomerRating[] = [];

  for (const obs of pipeline.observations.values()) {
    ratings.push(rateCustomerFromObservations(obs));
  }

  ratings.sort((a, b) => b.score - a.score || b.totalRiskUsd - a.totalRiskUsd);
  return ratings;
}

/**
 * Generates structured Markdown for a customer rating, hyperlinking customer portals
 * and documenting components.
 */
export function formatCustomerRatingMarkdown(rating: CustomerRating): string {
  const custLink = formatCustomerOsc8Markdown(rating.customerId);
  const scores = rating.componentScores;
  let extraMd = "";

  if (rating.bayesianSkill) {
    const b = rating.bayesianSkill;
    extraMd +=
      `- **Bayesian Skill**: Status \`${b.status}\` | Win Rate: **${(b.posteriorMeanWinRate * 100).toFixed(1)}%** ` +
      `(95% CI: [${(b.credibleInterval95[0] * 100).toFixed(1)}%, ${(b.credibleInterval95[1] * 100).toFixed(1)}%], ` +
      `Posterior: α=${b.posteriorAlpha}, β=${b.posteriorBeta})\n`;
  }
  if (rating.clvSignificance) {
    const s = rating.clvSignificance;
    extraMd +=
      `- **CLV Significance**: Mean CLV: **${s.meanClvPercent > 0 ? "+" : ""}${s.meanClvPercent.toFixed(1)}%** ` +
      `| t-stat: \`${s.tStatistic.toFixed(2)}\` (p=\`${s.pValue.toFixed(4)}\`, ` +
      (s.isSignificant99
        ? "99% Statistically Significant"
        : s.isSignificant95
          ? "95% Statistically Significant"
          : "Not Significant") +
      `)\n`;
  }
  if (rating.kellyMetrics) {
    const k = rating.kellyMetrics;
    extraMd +=
      `- **Kelly Sizing**: Optimal Half-Kelly: \`${(k.halfKellyFraction * 100).toFixed(2)}%\` | ` +
      `Observed: \`${(k.observedUnitFraction * 100).toFixed(2)}%\` (Divergence: \`${(k.kellyDivergence * 100).toFixed(2)}%\`, ` +
      (k.isKellyDisciplined
        ? "✅ Disciplined Sizing"
        : "⚠️ Undisciplined / Irrational Sizing") +
      `)\n`;
  }

  return (
    `### Customer Rating Report: ${custLink}\n\n` +
    `- **Tier**: \`${rating.tier}\` (Score: **${rating.score.toFixed(1)}/10**)\n` +
    `- **Risk Level**: \`${rating.riskLevel}\`\n` +
    `- **Archetype**: \`${rating.primaryArchetype}\`\n` +
    `- **Recommended Action**: \`${rating.recommendedAction}\`\n` +
    `- **Sample Size**: ${rating.sampleSize} tickets ($${Math.round(rating.totalRiskUsd).toLocaleString()} risk)\n` +
    extraMd +
    `- **Components**:\n` +
    `  - Key Numbers: \`${scores.keyNumberScore.toFixed(1)}/10\`\n` +
    `  - CLV Edge: \`${scores.clvEdgeScore.toFixed(1)}/10\`\n` +
    `  - Steam Latency: \`${scores.steamLatencyScore.toFixed(1)}/10\`\n` +
    `  - Timing Discipline: \`${scores.timingDisciplineScore.toFixed(1)}/10\`\n` +
    `  - Derivative Sharp: \`${scores.derivativeSharpScore.toFixed(1)}/10\`\n`
  );
}

/**
 * Renders a customer rating to ANSI-colored terminal text using Bun's native Markdown renderer and AnsiTheme.
 */
export function renderCustomerRatingAnsi(
  rating: CustomerRating,
  theme?: AnsiTheme,
): string {
  const md = formatCustomerRatingMarkdown(rating);
  return renderAnsiMarkdown(md, theme);
}

/* -------------------------------------------------------------------------- */
/* Terminal Formatters with OSC 8 Links & AnsiTheme Compatibility             */
/* -------------------------------------------------------------------------- */

function formatCustomerRating(
  rating: CustomerRating,
  depth: number,
  options: BunInspectOptions,
): string {
  const c = options.colors === true;
  const red = (s: string) => (c ? `\x1b[31;1m${s}\x1b[0m` : s);
  const yellow = (s: string) => (c ? `\x1b[33;1m${s}\x1b[0m` : s);
  const green = (s: string) => (c ? `\x1b[32;1m${s}\x1b[0m` : s);
  const cyan = (s: string) => (c ? `\x1b[36m${s}\x1b[0m` : s);
  const bold = (s: string) => (c ? `\x1b[1m${s}\x1b[22m` : s);
  const dim = (s: string) => (c ? `\x1b[2m${s}\x1b[22m` : s);

  // OSC 8 Hyperlink for customer portal
  const custLink = c
    ? `\x1b]8;;${getCanonicalCustomerUrl(rating.customerId)}\x1b\\${rating.customerId}\x1b]8;;\x1b\\`
    : rating.customerId;

  const tierBadge =
    rating.tier === "ELITE_SHARP"
      ? red(`[${rating.tier}]`)
      : rating.tier === "SHARP"
        ? red(`[${rating.tier}]`)
        : rating.tier === "SEMI_SHARP"
          ? yellow(`[${rating.tier}]`)
          : green(`[${rating.tier}]`);

  if (depth <= 0) {
    return `${bold(custLink)} ${tierBadge} score=${bold(rating.score.toFixed(1))} risk=${rating.riskLevel}`;
  }

  const scores = rating.componentScores;
  return (
    `${bold(custLink)} ${tierBadge} score=${bold(rating.score.toFixed(1))}/10 ` +
    `risk=${rating.riskLevel} archetype=${cyan(rating.primaryArchetype)} ` +
    `action=${bold(rating.recommendedAction)}\n` +
    `  ${dim("Components:")} key=${scores.keyNumberScore} clv=${scores.clvEdgeScore} ` +
    `steam=${scores.steamLatencyScore} timing=${scores.timingDisciplineScore} deriv=${scores.derivativeSharpScore}\n` +
    `  ${dim("Volume:")} N=${rating.sampleSize} risk=$${Math.round(rating.totalRiskUsd).toLocaleString()} ` +
    `net=${rating.netUsd >= 0 ? "+" : ""}$${Math.round(rating.netUsd).toLocaleString()} conf=${rating.confidence}`
  );
}

function formatRatedIncomingWager(
  rated: RatedIncomingWager,
  depth: number,
  options: BunInspectOptions,
): string {
  const c = options.colors === true;
  const red = (s: string) => (c ? `\x1b[31;1m${s}\x1b[0m` : s);
  const yellow = (s: string) => (c ? `\x1b[33;1m${s}\x1b[0m` : s);
  const cyan = (s: string) => (c ? `\x1b[36m${s}\x1b[0m` : s);
  const bold = (s: string) => (c ? `\x1b[1m${s}\x1b[22m` : s);
  const dim = (s: string) => (c ? `\x1b[2m${s}\x1b[22m` : s);

  const levelBadge =
    rated.level === "CRITICAL"
      ? red(`[${rated.level}]`)
      : rated.level === "WARN"
        ? yellow(`[${rated.level}]`)
        : cyan(`[${rated.level}]`);

  const custLink = c
    ? `\x1b]8;;${getCanonicalCustomerUrl(rated.customerId)}\x1b\\${rated.customerId}\x1b]8;;\x1b\\`
    : rated.customerId;

  if (depth <= 0) {
    return `${levelBadge} Wager:${bold(rated.ticketNumber)} Cust:${bold(custLink)} $${rated.riskUsd} -> ${rated.rating.tier}`;
  }

  const flagsStr = rated.flags.length > 0 ? rated.flags.join(", ") : "none";
  return (
    `${levelBadge} ${bold("RATED INCOMING WAGER")} #${bold(rated.ticketNumber)}\n` +
    `  ${dim("Customer:")} ${custLink} [${rated.rating.tier} ${rated.rating.score}/10] action=${bold(rated.rating.recommendedAction)}\n` +
    `  ${dim("Risk:")} $${rated.riskUsd.toLocaleString()} ${dim("BuyPoints:")} ${rated.buyPoints}pt\n` +
    `  ${dim("Key Numbers:")} ${rated.touchesKey ? red(rated.touchedKeys.join(", ")) : "none"}\n` +
    `  ${dim("Flags:")} ${flagsStr}\n` +
    `  ${dim("Notice:")} ${dim("informational desk alert only; autoExecute: false")}`
  );
}
