/**
 * @file lib/signatures/specs/cbb_under_concentration.ts
 * @description College basketball (`competitionFamily === "NCAAB"`) total Under concentration spec.
 * Marked dormant (`thresholds.dormant = true`) until NCAAB totals volume reaches >= 30 accounts.
 */

import type { SignatureSpec } from "../spec.ts";
import type { SignatureThresholds } from "../thresholds.ts";
import type {
  CbbUnderConcentrationSignature,
  CustomerTotals,
  NormalizedObservationTicket,
} from "../types.ts";

export interface CbbUnderState {
  underCount: number;
  cbbTotalCount: number;
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

export function makeCbbUnderConcentration(
  thresholds: SignatureThresholds["cbbUnder"],
): SignatureSpec<
  "cbb_under_concentration",
  CbbUnderState,
  CbbUnderConcentrationSignature
> {
  return {
    kind: "cbb_under_concentration",
    init(): CbbUnderState {
      return {
        underCount: 0,
        cbbTotalCount: 0,
        customerLegs: 0,
        distinctWagers: new Set<string>(),
      };
    },
    observe(state: CbbUnderState, ticket: NormalizedObservationTicket): void {
      state.customerLegs += 1;
      if (
        ticket.competitionFamily === "NCAAB" &&
        ticket.marketKind === "total"
      ) {
        state.cbbTotalCount += 1;
        state.distinctWagers.add(wagerKeyOf(ticket, state.customerLegs));
        if (ticket.side === "under") {
          state.underCount += 1;
        }
      }
    },
    emit(
      state: CbbUnderState,
      _totals: CustomerTotals,
    ): CbbUnderConcentrationSignature | null {
      if (
        state.cbbTotalCount <= 0 ||
        state.underCount <= 0 ||
        state.customerLegs > thresholds.maxLegsPerCustomer ||
        state.cbbTotalCount < thresholds.minCbbTotals ||
        state.distinctWagers.size < thresholds.minWagers
      ) {
        return null;
      }
      const underRate = state.underCount / state.cbbTotalCount;
      if (underRate < thresholds.minRate) {
        return null;
      }
      return {
        kind: "cbb_under_concentration",
        status: thresholds.dormant ? "dormant" : "active",
        cbbTotalCount: state.cbbTotalCount,
        underCount: state.underCount,
        underRate,
        distinctWagers: state.distinctWagers.size,
      };
    },
    rankScore(
      sig: CbbUnderConcentrationSignature,
      _totals: CustomerTotals,
    ): number {
      return sig.cbbTotalCount > 0 ? sig.underCount / sig.cbbTotalCount : 0;
    },
    tieBreak(
      sig: CbbUnderConcentrationSignature,
      _totals: CustomerTotals,
    ): readonly number[] {
      return [sig.underCount];
    },
  };
}
