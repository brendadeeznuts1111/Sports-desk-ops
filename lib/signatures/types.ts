/**
 * @file lib/signatures/types.ts
 * @description Stage 1 normalized wager input, per-customer totals, sport/competition-family mix
 * descriptors, and the behavioral `Signature` discriminated union emitted by `SignatureSpec`
 * implementations.
 */

import type { FootballKeyNumber } from "../customer_profile.ts";

export type WagerTiming = "pregame" | "in_play" | "halftime";

export interface NormalizedObservationTicket {
  readonly ticketNumber: string;
  /**
   * Optional parent wager-group key (`F402:${TicketNumber}:${WagerNumber}` or `GSLIVE:${betGroupId}`)
   * used to deduplicate `CustomerTotals` (`nTickets`, `totalRiskUsd`, `netUsd`) across multi-leg
   * parlays, round robins, and SGPs while tracking `distinctWagers` per spec.
   */
  readonly wagerGroupKey?: string;
  readonly customerId: string;
  readonly agentId: string;
  /** ISO date string `"YYYY-MM-DD"`. */
  readonly placedAtYmd: string;
  /** Full ISO-8601 placement timestamp (`"YYYY-MM-DDTHH:MM:SS.sssZ"`). */
  readonly placedAt?: string;
  /** Full ISO-8601 event start (kickoff/tipoff) timestamp (`"YYYY-MM-DDTHH:MM:SS.sssZ"`) or `null`. */
  readonly eventStartsAt?: string | null;
  /**
   * Wager timing relative to kickoff/tipoff (`< -5m` pregame window guard for postponed/pre-start
   * wagers; sport-specific halftime window for `"halftime"`; otherwise `"in_play"`).
   */
  readonly timing?: WagerTiming;
  /** Canonical sport title (`"Football"`, `"Basketball"`, `"Hockey"`, `"Baseball"`, `"Tennis"`, `"Soccer"`, `"Martial Arts"`, `"Other"`). */
  readonly sport: string;
  /** Canonical competition family (`"NFL"`, `"NCAAF"`, `"NBA"`, `"NCAAB"`, `"WNBA"`, `"NHL"`, `"MLB"`, `"ATP"`, `"WTA"`, `"UFC"`, `"SOCCER"`, or `""`). */
  readonly competitionFamily: string;
  /** Canonical period token (`"game"`, `"1h"`, `"2h"`, `"1q"`, `"2q"`, `"3q"`, `"4q"`, `"1p"`, `"2p"`, `"3p"`, `"f5"`, `"l4"`, `"1s"`, `"2s"`, etc.). */
  readonly canonicalPeriod: string;
  /**
   * Elapsed minutes from event start (`(placedAt - eventStartsAt) / 60`) for wagers with both
   * timestamps, or `null`/`undefined` when unknown.
   */
  readonly elapsedMinutesFromStart?: number | null;
  /**
   * `true` when an in-play wager was placed inside its sport's 2nd-half clock window
   * (`Football`: `60 <= elapsedMin <= 150`, `Basketball`: `40 <= elapsedMin <= 120`).
   */
  readonly placedIn2HWindow?: boolean;
  /**
   * Market classification: "spread" | "total" | "moneyline" | "other".
   * Note: "derivative_points" (alt lines, Derivative Points Lines, derivative spreads) maps to "other"
   * to preserve game-spread purity in football_key_number_discipline.
   */
  readonly marketKind: "spread" | "total" | "moneyline" | "other";
  readonly side: "over" | "under" | "home" | "away" | "other";
  readonly origSpread: number | null;
  readonly adjSpread: number | null;
  readonly buyPoints: number;
  readonly touchedKeyNumber: FootballKeyNumber | null;
  /** Positive = customer beat the closing/reference price (in cents); `null` when no reference exists. */
  readonly priceVsCloseCents: number | null;
  /** `true` when line moved in the customer's favor after placement; `null` when no line series exists. */
  readonly movedInFavor: boolean | null;
  readonly riskUsd: number;
  readonly netUsd: number;
}

export interface CbbUnderConcentrationSignature {
  readonly kind: "cbb_under_concentration";
  /** Explicitly marked `"dormant"` until NCAAB totals volume reaches >= 30 multi-wager accounts. */
  readonly status?: "dormant" | "active";
  readonly cbbTotalCount: number;
  readonly underCount: number;
  readonly underRate: number;
  readonly distinctWagers: number;
}

export interface FootballKeyNumberDisciplineSignature {
  readonly kind: "football_key_number_discipline";
  readonly onKey: number;
  readonly totalSpread: number;
  readonly onKeyRate: number;
  readonly onKey3: number;
  readonly onKey7: number;
  readonly onKeyOther?: number;
  /** Count of key-number spread bets landed directly at the number (`buyPoints === 0`). */
  readonly atKeyCount?: number;
  /** Count of key-number spread bets bought onto/across the number (`buyPoints > 0`). */
  readonly boughtKeyCount?: number;
  readonly distinctWagers: number;
  readonly pregameCount?: number;
  readonly liveCount?: number;
}

/** @deprecated Retired in favor of `FootballKeyNumberDisciplineSignature` (`football_key_number_discipline`). */
export interface HalfPointBuysSignature {
  readonly kind: "half_point_buys";
  readonly buyCount: number;
  readonly keyNumberBuys: number;
  readonly keyNumberRate?: number;
  readonly avgPriceVsCloseCents: number | null;
  readonly distinctWagers?: number;
}

export interface InPlayActivitySignature {
  readonly kind: "in_play_activity";
  readonly liveCount: number;
  readonly halftimeCount?: number;
  readonly pregameCount?: number;
  readonly totalCount: number;
  readonly liveRate: number;
  readonly liveRiskUsd: number;
  readonly totalRiskUsd: number;
  readonly liveRiskShare?: number;
  readonly dominance: "dominant_in_play" | "dominant_pregame" | "balanced";
  readonly distinctWagers: number;
}

export interface SecondHalfSportSlice {
  readonly twoHalfCount: number;
  readonly periodCount: number;
  readonly inPlayCount: number;
  readonly totalCount: number;
}

export interface PostHalftimeActivitySignature {
  readonly kind: "post_halftime_activity";
  readonly twoHalfCount: number;
  readonly totalCount: number;
  readonly twoHalfRate: number;
  /** Distinguishes explicit 2H/3Q/4Q period line selection (`"period"`) from post-halftime in-play clock betting (`"in_play"`). */
  readonly reason?: "period" | "in_play";
  readonly periodCount?: number;
  readonly inPlayCount?: number;
  readonly distinctWagers: number;
  /** Sport-separated 2H/late-game breakdown (`Football`, `Basketball`, `Other`). */
  readonly bySport?: Readonly<Record<string, SecondHalfSportSlice>>;
}

/** @deprecated Renamed to `PostHalftimeActivitySignature` (`post_halftime_activity`). */
export interface SecondHalfConcentrationSignature {
  readonly kind: "second_half_concentration";
  readonly twoHalfCount: number;
  readonly totalCount: number;
  readonly twoHalfRate?: number;
  readonly reason?: "period" | "in_play";
  readonly periodCount?: number;
  readonly inPlayCount?: number;
  readonly distinctWagers?: number;
  readonly bySport?: Readonly<Record<string, SecondHalfSportSlice>>;
}

export interface PreMoveBettingSignature {
  readonly kind: "pre_move_betting";
  readonly moveCount: number;
  readonly totalCount: number;
  readonly moveRate: number;
  readonly avgPriceVsCloseCents: number;
  /** Dominant timing slice for the customer's priced pre-move bets (`"pregame"` vs `"live"`). */
  readonly dominantTiming?: "pregame" | "live";
  readonly pregameCount?: number;
  readonly liveCount?: number;
  readonly distinctWagers: number;
}

export type ActiveSignatureKind =
  | "cbb_under_concentration"
  | "football_key_number_discipline"
  | "in_play_activity"
  | "post_halftime_activity"
  | "pre_move_betting";

export type Signature =
  | CbbUnderConcentrationSignature
  | FootballKeyNumberDisciplineSignature
  | HalfPointBuysSignature
  | InPlayActivitySignature
  | PostHalftimeActivitySignature
  | PreMoveBettingSignature
  | SecondHalfConcentrationSignature;

export interface CustomerTotals {
  readonly nTickets: number;
  readonly totalRiskUsd: number;
  readonly netUsd: number;
}

export interface CustomerSportMix {
  readonly footballPct: number;
  readonly basketballPct: number;
  readonly otherPct: number;
}
