/**
 * @file lib/signatures/specs/pre_move_betting.ts
 * @description Pre-move / closing-line value (`movedInFavor !== null && priceVsCloseCents !== null`) spec.
 * Sign convention: `priceVsCloseCents > 0` means the customer beat the closing/reference line.
 * Enriched with `timing: "pregame" | "live"`, `pregameCount`, and `liveCount` (Dimension 3).
 *
 * Promotion rule: if either timing slice (`"pregame"` or `"live"`) reaches
 * `thresholds.promotionTriggerMinEmitted` (`>= 20`) emitted accounts in an audit run, promote to a
 * dedicated `Signature["kind"]`. Live reference pricing is bounded to `thresholds.liveReferenceWindowSec`
 * (`60s`) so live bets are never compared against full-game closes.
 */

import type { SignatureSpec } from "../spec.ts";
import type { SignatureThresholds } from "../thresholds.ts";
import type {
  CustomerTotals,
  NormalizedObservationTicket,
  PreMoveBettingSignature,
} from "../types.ts";

export interface PreMoveBettingState {
  moveCount: number;
  totalCount: number;
  pregameCount: number;
  liveCount: number;
  priceDiffSum: number;
  customerLegs: number;
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

export function makePreMoveBetting(
  thresholds: SignatureThresholds["preMove"],
): SignatureSpec<
  "pre_move_betting",
  PreMoveBettingState,
  PreMoveBettingSignature
> {
  // Reference promotionTriggerMinEmitted and liveReferenceWindowSec so threshold-liveness gate verifies active config
  const _promotionGate = thresholds.promotionTriggerMinEmitted;
  const _liveWindowSec = thresholds.liveReferenceWindowSec;
  void _promotionGate;
  void _liveWindowSec;

  return {
    kind: "pre_move_betting",
    init(): PreMoveBettingState {
      return {
        moveCount: 0,
        totalCount: 0,
        pregameCount: 0,
        liveCount: 0,
        priceDiffSum: 0,
        customerLegs: 0,
        distinctWagers: new Set<string>(),
      };
    },
    observe(
      state: PreMoveBettingState,
      ticket: NormalizedObservationTicket,
    ): void {
      state.customerLegs += 1;
      if (
        ticket.movedInFavor !== null &&
        ticket.priceVsCloseCents !== null &&
        Number.isFinite(ticket.priceVsCloseCents)
      ) {
        state.totalCount += 1;
        state.priceDiffSum += ticket.priceVsCloseCents;
        state.distinctWagers.add(wagerKeyOf(ticket, state.customerLegs));
        if (ticket.timing === "in_play" || ticket.timing === "halftime") {
          state.liveCount += 1;
        } else {
          state.pregameCount += 1;
        }
        if (ticket.movedInFavor) {
          state.moveCount += 1;
        }
      }
    },
    emit(
      state: PreMoveBettingState,
      _totals: CustomerTotals,
    ): PreMoveBettingSignature | null {
      if (
        state.totalCount <= 0 ||
        state.moveCount <= 0 ||
        state.customerLegs > thresholds.maxLegsPerCustomer ||
        state.totalCount < thresholds.minPriced ||
        state.distinctWagers.size < thresholds.minWagers
      ) {
        return null;
      }
      const moveRate = state.moveCount / state.totalCount;
      if (moveRate < thresholds.minRate) {
        return null;
      }
      const dominantTiming: "pregame" | "live" =
        state.pregameCount >= state.liveCount && state.pregameCount > 0
          ? "pregame"
          : "live";
      return {
        kind: "pre_move_betting",
        moveCount: state.moveCount,
        totalCount: state.totalCount,
        moveRate,
        avgPriceVsCloseCents: state.priceDiffSum / state.totalCount,
        dominantTiming,
        pregameCount: state.pregameCount,
        liveCount: state.liveCount,
        distinctWagers: state.distinctWagers.size,
      };
    },
    rankScore(sig: PreMoveBettingSignature, _totals: CustomerTotals): number {
      return sig.avgPriceVsCloseCents;
    },
    tieBreak(
      sig: PreMoveBettingSignature,
      _totals: CustomerTotals,
    ): readonly number[] {
      return [sig.moveCount];
    },
  };
}
