/**
 * @file lib/signatures/specs/in_play_activity.ts
 * @description Live vs. pregame activity spec (`in_play_activity`).
 * Measures the customer's in-play/halftime wager share (`liveCount / totalCount`) and risk share
 * (`liveRiskUsd / totalRiskUsd`), classifying accounts into `"dominant_in_play"` (`>= 0.75`),
 * `"balanced"` (`0.40..0.75`), or `"dominant_pregame"`.
 */

import type { SignatureSpec } from "../spec.ts";
import type { SignatureThresholds } from "../thresholds.ts";
import type {
  CustomerTotals,
  InPlayActivitySignature,
  NormalizedObservationTicket,
} from "../types.ts";

export interface InPlayActivityState {
  liveCount: number;
  halftimeCount: number;
  pregameCount: number;
  totalCount: number;
  liveRiskUsd: number;
  totalRiskUsd: number;
  seenRiskWagers: Set<string>;
  distinctWagers: Set<string>;
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

export function isLiveOrHalftimeTicket(
  ticket: NormalizedObservationTicket,
): boolean {
  if (ticket.timing !== undefined) {
    return ticket.timing === "in_play" || ticket.timing === "halftime";
  }
  if (ticket.placedIn2HWindow === true) {
    return true;
  }
  if (
    ticket.elapsedMinutesFromStart !== undefined &&
    ticket.elapsedMinutesFromStart !== null &&
    Number.isFinite(ticket.elapsedMinutesFromStart)
  ) {
    return ticket.elapsedMinutesFromStart >= -5;
  }
  return false;
}

export function makeInPlayActivity(
  thresholds: SignatureThresholds["inPlay"],
): SignatureSpec<
  "in_play_activity",
  InPlayActivityState,
  InPlayActivitySignature
> {
  return {
    kind: "in_play_activity",
    init(): InPlayActivityState {
      return {
        liveCount: 0,
        halftimeCount: 0,
        pregameCount: 0,
        totalCount: 0,
        liveRiskUsd: 0,
        totalRiskUsd: 0,
        seenRiskWagers: new Set<string>(),
        distinctWagers: new Set<string>(),
      };
    },
    observe(
      state: InPlayActivityState,
      ticket: NormalizedObservationTicket,
    ): void {
      state.totalCount += 1;
      const wk = wagerKeyOf(ticket, state.totalCount);
      state.distinctWagers.add(wk);

      const isLive = isLiveOrHalftimeTicket(ticket);
      if (isLive) {
        state.liveCount += 1;
        if (ticket.timing === "halftime") {
          state.halftimeCount += 1;
        }
      } else {
        state.pregameCount += 1;
      }

      if (!state.seenRiskWagers.has(wk)) {
        state.seenRiskWagers.add(wk);
        state.totalRiskUsd += ticket.riskUsd;
        if (isLive) {
          state.liveRiskUsd += ticket.riskUsd;
        }
      }
    },
    emit(
      state: InPlayActivityState,
      _totals: CustomerTotals,
    ): InPlayActivitySignature | null {
      if (
        state.totalCount <= 0 ||
        state.liveCount <= 0 ||
        state.totalCount > thresholds.maxLegsPerCustomer ||
        state.totalCount < thresholds.minTickets ||
        state.liveCount < thresholds.minLiveCount ||
        state.distinctWagers.size < thresholds.minWagers
      ) {
        return null;
      }
      const liveRate = state.liveCount / state.totalCount;
      if (liveRate < thresholds.minRate) {
        return null;
      }
      const dominance: InPlayActivitySignature["dominance"] =
        liveRate >= thresholds.dominantInPlayRate
          ? "dominant_in_play"
          : liveRate >= thresholds.minRate
            ? "balanced"
            : "dominant_pregame";
      const liveRiskShare =
        state.totalRiskUsd > 0 ? state.liveRiskUsd / state.totalRiskUsd : 0;

      return {
        kind: "in_play_activity",
        liveCount: state.liveCount,
        halftimeCount: state.halftimeCount,
        pregameCount: state.pregameCount,
        totalCount: state.totalCount,
        liveRate,
        liveRiskUsd: state.liveRiskUsd,
        totalRiskUsd: state.totalRiskUsd,
        liveRiskShare,
        dominance,
        distinctWagers: state.distinctWagers.size,
      };
    },
    rankScore(sig: InPlayActivitySignature, _totals: CustomerTotals): number {
      return sig.totalCount > 0 ? sig.liveCount / sig.totalCount : 0;
    },
    tieBreak(
      sig: InPlayActivitySignature,
      _totals: CustomerTotals,
    ): readonly number[] {
      return [
        sig.totalRiskUsd > 0 ? sig.liveRiskUsd / sig.totalRiskUsd : 0,
        sig.liveCount,
      ];
    },
  };
}
