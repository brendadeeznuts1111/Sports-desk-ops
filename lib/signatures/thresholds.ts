/**
 * @file lib/signatures/thresholds.ts
 * @description Centralized gate thresholds for the 5-kind Customer Signature Pipeline catalog:
 * - `cbb_under_concentration` (dormant: retained until NCAAB totals volume reaches >= 30 accounts)
 * - `football_key_number_discipline` (replaces `half_point_buys`)
 * - `in_play_activity` (live vs. pregame share)
 * - `post_halftime_activity` (renamed from `second_half_concentration`)
 * - `pre_move_betting` (enriched with `timing: "pregame" | "live"` and local live reference window)
 *
 * Every leaf field in `SignatureThresholds` is actively referenced by at least one spec in
 * `lib/signatures/specs/*.ts` (enforced by Acceptance Check 5).
 */

export interface SignatureThresholds {
  readonly cbbUnder: {
    /** Dormant flag: retained in catalog until NCAAB totals volume reaches >= 30 multi-wager accounts. */
    readonly dormant: boolean;
    readonly minCbbTotals: number;
    readonly minWagers: number;
    readonly minRate: number;
    readonly maxLegsPerCustomer: number;
  };
  readonly footballKeyNumber: {
    readonly minSpreadLegs: number;
    readonly minOnKey: number;
    readonly minWagers: number;
    readonly minRate: number;
    readonly maxLegsPerCustomer: number;
  };
  /** @deprecated Retired spec config retained for backward-compatible `makeHalfPointBuys` callers. */
  readonly halfPoint: {
    readonly minBuys: number;
    readonly minWagers: number;
    readonly requireKeyNumber: boolean;
    readonly maxLegsPerCustomer: number;
  };
  readonly inPlay: {
    readonly minTickets: number;
    readonly minLiveCount: number;
    readonly minWagers: number;
    readonly minRate: number;
    readonly dominantInPlayRate: number;
    readonly maxLegsPerCustomer: number;
  };
  readonly postHalftime: {
    readonly minTickets: number;
    readonly minTwoHalfCount: number;
    readonly minWagers: number;
    readonly minRate: number;
    readonly maxLegsPerCustomer: number;
    /** Football 2nd-half in-play clock window in minutes from kickoff (`[60, 150]`). */
    readonly footballInPlayWindowMin: readonly [number, number];
    /** Basketball 2nd-half in-play clock window in minutes from tipoff (`[40, 120]`). */
    readonly basketballInPlayWindowMin: readonly [number, number];
  };
  readonly preMove: {
    readonly minPriced: number;
    readonly minWagers: number;
    readonly minRate: number;
    readonly maxLegsPerCustomer: number;
    /**
     * Promotion trigger: if either timing slice (`"pregame"` or `"live"`) reaches >= 20 emitted
     * accounts in an audit run, promote to a dedicated `Signature["kind"]`.
     */
    readonly promotionTriggerMinEmitted: number;
    /**
     * Maximum local reference window in seconds (`60s`) for GSLive in-play closing-price
     * comparison when `fVal === fVal_new` (prevents comparing Q1 bets to Q4 full-game closes).
     */
    readonly liveReferenceWindowSec: number;
  };
}

export const DEFAULT_THRESHOLDS: SignatureThresholds = {
  cbbUnder: {
    dormant: true,
    minCbbTotals: 12,
    minWagers: 6,
    minRate: 0.65,
    maxLegsPerCustomer: 50,
  },
  footballKeyNumber: {
    minSpreadLegs: 8,
    minOnKey: 4,
    minWagers: 3,
    minRate: 0.5,
    maxLegsPerCustomer: 50,
  },
  halfPoint: {
    minBuys: 3,
    minWagers: 3,
    requireKeyNumber: true,
    maxLegsPerCustomer: 20,
  },
  inPlay: {
    minTickets: 12,
    minLiveCount: 4,
    minWagers: 4,
    minRate: 0.4,
    dominantInPlayRate: 0.75,
    maxLegsPerCustomer: 50,
  },
  postHalftime: {
    minTickets: 12,
    minTwoHalfCount: 4,
    minWagers: 4,
    minRate: 0.3,
    maxLegsPerCustomer: 50,
    footballInPlayWindowMin: [60, 150],
    basketballInPlayWindowMin: [40, 120],
  },
  preMove: {
    minPriced: 10,
    minWagers: 5,
    minRate: 0.6,
    maxLegsPerCustomer: 50,
    promotionTriggerMinEmitted: 20,
    liveReferenceWindowSec: 60,
  },
};
