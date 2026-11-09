/**
 * @file lib/signatures/specs/post_halftime_activity.ts
 * @description Post-halftime activity spec (`post_halftime_activity`, renamed from
 * `second_half_concentration`) with sport-separated clock windows (`Football`: `60..150m`,
 * `Basketball`: `40..120m`), reason-code attribution (`"period"` vs `"in_play"`), distinct-wager
 * floor (`minWagers`), and volume-account cap (`maxLegsPerCustomer`).
 */

import type { SignatureSpec } from "../spec.ts";
import { DEFAULT_THRESHOLDS, type SignatureThresholds } from "../thresholds.ts";
import type {
  CustomerTotals,
  NormalizedObservationTicket,
  PostHalftimeActivitySignature,
  SecondHalfSportSlice,
} from "../types.ts";

export interface MutableSportSlice {
  twoHalfCount: number;
  periodCount: number;
  inPlayCount: number;
  totalCount: number;
}

export interface PostHalftimeState {
  twoHalfCount: number;
  periodCount: number;
  inPlayCount: number;
  totalCount: number;
  distinctWagers: Set<string>;
  bySport: {
    Football: MutableSportSlice;
    Basketball: MutableSportSlice;
    Other: MutableSportSlice;
  };
}

function wagerKeyOf(
  ticket: NormalizedObservationTicket,
  fallbackIndex: number,
): string {
  const gk = ticket.wagerGroupKey?.trim();
  if (gk) return gk;
  const tn = ticket.ticketNumber.trim();
  return tn !== "" ? `TICKET:${tn}` : `LEG:${fallbackIndex}`;
}

export function isExplicitSecondHalfPeriod(canonicalPeriod: string): boolean {
  return (
    canonicalPeriod === "2h" ||
    canonicalPeriod === "3q" ||
    canonicalPeriod === "4q"
  );
}

/**
 * Evaluates whether an in-play wager falls inside its sport's 2nd-half live clock window:
 * - `Football`: `footballInPlayWindowMin` (`[60, 150]` minutes from kickoff)
 * - `Basketball`: `basketballInPlayWindowMin` (`[40, 120]` minutes from tipoff)
 * - Other sports: `false` (no full-game elapsed-clock proxy).
 */
export function isSportSpecificInPlay2HWindow(
  ticket: NormalizedObservationTicket,
  postHalftimeThresholds: SignatureThresholds["postHalftime"] = DEFAULT_THRESHOLDS.postHalftime,
): boolean {
  const elapsed = ticket.elapsedMinutesFromStart;
  if (elapsed !== undefined && elapsed !== null && Number.isFinite(elapsed)) {
    if (ticket.sport === "Football") {
      const [lo, hi] = postHalftimeThresholds.footballInPlayWindowMin;
      return elapsed >= lo && elapsed <= hi;
    }
    if (ticket.sport === "Basketball") {
      const [lo, hi] = postHalftimeThresholds.basketballInPlayWindowMin;
      return elapsed >= lo && elapsed <= hi;
    }
    return false;
  }
  if (ticket.placedIn2HWindow === true) {
    return ticket.sport === "Football" || ticket.sport === "Basketball";
  }
  return false;
}

export function classifySecondHalfTicket(
  ticket: NormalizedObservationTicket,
  postHalftimeThresholds: SignatureThresholds["postHalftime"] = DEFAULT_THRESHOLDS.postHalftime,
): {
  readonly matched: boolean;
  readonly reason: "period" | "in_play" | null;
  readonly sportKey: "Football" | "Basketball" | "Other";
} {
  const sportKey: "Football" | "Basketball" | "Other" =
    ticket.sport === "Football"
      ? "Football"
      : ticket.sport === "Basketball"
        ? "Basketball"
        : "Other";

  if (isExplicitSecondHalfPeriod(ticket.canonicalPeriod)) {
    return { matched: true, reason: "period", sportKey };
  }
  if (isSportSpecificInPlay2HWindow(ticket, postHalftimeThresholds)) {
    return { matched: true, reason: "in_play", sportKey };
  }
  return { matched: false, reason: null, sportKey };
}

export function isSecondHalfOrLateGameTicket(
  ticket: NormalizedObservationTicket,
  postHalftimeThresholds: SignatureThresholds["postHalftime"] = DEFAULT_THRESHOLDS.postHalftime,
): boolean {
  return classifySecondHalfTicket(ticket, postHalftimeThresholds).matched;
}

function emptySportSlice(): MutableSportSlice {
  return {
    twoHalfCount: 0,
    periodCount: 0,
    inPlayCount: 0,
    totalCount: 0,
  };
}

export function makePostHalftimeActivity(
  thresholds: SignatureThresholds["postHalftime"],
): SignatureSpec<
  "post_halftime_activity",
  PostHalftimeState,
  PostHalftimeActivitySignature
> {
  return {
    kind: "post_halftime_activity",
    init(): PostHalftimeState {
      return {
        twoHalfCount: 0,
        periodCount: 0,
        inPlayCount: 0,
        totalCount: 0,
        distinctWagers: new Set<string>(),
        bySport: {
          Football: emptySportSlice(),
          Basketball: emptySportSlice(),
          Other: emptySportSlice(),
        },
      };
    },
    observe(
      state: PostHalftimeState,
      ticket: NormalizedObservationTicket,
    ): void {
      state.totalCount += 1;
      const { matched, reason, sportKey } = classifySecondHalfTicket(
        ticket,
        thresholds,
      );
      const sportSlice = state.bySport[sportKey];
      sportSlice.totalCount += 1;

      if (matched) {
        state.twoHalfCount += 1;
        sportSlice.twoHalfCount += 1;
        state.distinctWagers.add(wagerKeyOf(ticket, state.totalCount));
        if (reason === "period") {
          state.periodCount += 1;
          sportSlice.periodCount += 1;
        } else {
          state.inPlayCount += 1;
          sportSlice.inPlayCount += 1;
        }
      }
    },
    emit(
      state: PostHalftimeState,
      _totals: CustomerTotals,
    ): PostHalftimeActivitySignature | null {
      if (
        state.totalCount <= 0 ||
        state.twoHalfCount <= 0 ||
        state.totalCount > thresholds.maxLegsPerCustomer ||
        state.totalCount < thresholds.minTickets ||
        state.twoHalfCount < thresholds.minTwoHalfCount ||
        state.distinctWagers.size < thresholds.minWagers
      ) {
        return null;
      }
      const twoHalfRate = state.twoHalfCount / state.totalCount;
      if (twoHalfRate < thresholds.minRate) {
        return null;
      }
      const reason: "period" | "in_play" =
        state.periodCount >= state.inPlayCount && state.periodCount > 0
          ? "period"
          : "in_play";

      const bySport: Record<string, SecondHalfSportSlice> = {};
      for (const k of ["Football", "Basketball", "Other"] as const) {
        const s = state.bySport[k];
        if (s.totalCount > 0) {
          bySport[k] = {
            twoHalfCount: s.twoHalfCount,
            periodCount: s.periodCount,
            inPlayCount: s.inPlayCount,
            totalCount: s.totalCount,
          };
        }
      }

      return {
        kind: "post_halftime_activity",
        twoHalfCount: state.twoHalfCount,
        totalCount: state.totalCount,
        twoHalfRate,
        reason,
        periodCount: state.periodCount,
        inPlayCount: state.inPlayCount,
        distinctWagers: state.distinctWagers.size,
        bySport,
      };
    },
    rankScore(
      sig: PostHalftimeActivitySignature,
      _totals: CustomerTotals,
    ): number {
      return sig.totalCount > 0 ? sig.twoHalfCount / sig.totalCount : 0;
    },
    tieBreak(
      sig: PostHalftimeActivitySignature,
      _totals: CustomerTotals,
    ): readonly number[] {
      return [sig.twoHalfCount];
    },
  };
}
