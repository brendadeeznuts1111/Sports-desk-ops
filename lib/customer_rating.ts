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
  type CustomerObservations,
  type FootballKeyNumber,
  isKeyNumberBuy,
  normalizeCustomerId,
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
  /** Strictly invariant: Informational alert only; NEVER auto-execute on external exchanges/Kalshi/Polymarket. */
  readonly autoExecute: false;
  readonly summary: string;
  readonly [Bun.inspect.custom]?: (
    depth: number,
    options?: BunInspectOptions,
  ) => string;
  readonly toString: () => string;
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
 * Rates a customer based on their accumulated observations and behavioral signatures.
 */
export function rateCustomerFromObservations(
  obs: CustomerObservations,
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
  if (obs.nTickets > 0) {
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
    return rateCustomerFromObservations(obs);
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
  return (
    `### Customer Rating Report: ${custLink}\n\n` +
    `- **Tier**: \`${rating.tier}\` (Score: **${rating.score.toFixed(1)}/10**)\n` +
    `- **Risk Level**: \`${rating.riskLevel}\`\n` +
    `- **Archetype**: \`${rating.primaryArchetype}\`\n` +
    `- **Recommended Action**: \`${rating.recommendedAction}\`\n` +
    `- **Sample Size**: ${rating.sampleSize} tickets ($${Math.round(rating.totalRiskUsd).toLocaleString()} risk)\n` +
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
