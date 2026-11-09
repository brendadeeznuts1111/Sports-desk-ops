/**
 * @file lib/signatures/specs/half_point_buys.ts
 * @description Football spread point-buy (`buyPoints > 0`) and key-number (3, 7, 10, 14, 21) spec.
 * Enforces `minBuys`, `minWagers` (parlay-deduped distinct wagers), `maxLegsPerCustomer`
 * (volume-account cap), and `requireKeyNumber`.
 */

import type { SignatureSpec } from "../spec.ts";
import type { SignatureThresholds } from "../thresholds.ts";
import type {
  CustomerTotals,
  HalfPointBuysSignature,
  NormalizedObservationTicket,
} from "../types.ts";

export interface HalfPointBuysState {
  buyCount: number;
  keyNumberBuys: number;
  priceDiffSum: number;
  priceDiffN: number;
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

export function makeHalfPointBuys(
  thresholds: SignatureThresholds["halfPoint"],
): SignatureSpec<
  "half_point_buys",
  HalfPointBuysState,
  HalfPointBuysSignature
> {
  return {
    kind: "half_point_buys",
    init(): HalfPointBuysState {
      return {
        buyCount: 0,
        keyNumberBuys: 0,
        priceDiffSum: 0,
        priceDiffN: 0,
        customerLegs: 0,
        distinctWagers: new Set<string>(),
      };
    },
    observe(
      state: HalfPointBuysState,
      ticket: NormalizedObservationTicket,
    ): void {
      state.customerLegs += 1;
      if (
        ticket.sport === "Football" &&
        ticket.marketKind === "spread" &&
        ticket.buyPoints > 0
      ) {
        state.buyCount += 1;
        state.distinctWagers.add(wagerKeyOf(ticket, state.customerLegs));
        if (ticket.touchedKeyNumber !== null) {
          state.keyNumberBuys += 1;
        }
        if (
          ticket.priceVsCloseCents !== null &&
          Number.isFinite(ticket.priceVsCloseCents)
        ) {
          state.priceDiffSum += ticket.priceVsCloseCents;
          state.priceDiffN += 1;
        }
      }
    },
    emit(
      state: HalfPointBuysState,
      _totals: CustomerTotals,
    ): HalfPointBuysSignature | null {
      if (
        state.buyCount <= 0 ||
        state.customerLegs > thresholds.maxLegsPerCustomer ||
        state.buyCount < thresholds.minBuys ||
        state.distinctWagers.size < thresholds.minWagers
      ) {
        return null;
      }
      if (thresholds.requireKeyNumber && state.keyNumberBuys < 1) {
        return null;
      }
      const keyNumberRate = state.keyNumberBuys / state.buyCount;
      const avgPriceVsCloseCents =
        state.priceDiffN > 0 ? state.priceDiffSum / state.priceDiffN : null;
      return {
        kind: "half_point_buys",
        buyCount: state.buyCount,
        keyNumberBuys: state.keyNumberBuys,
        keyNumberRate,
        avgPriceVsCloseCents,
        distinctWagers: state.distinctWagers.size,
      };
    },
    rankScore(sig: HalfPointBuysSignature, _totals: CustomerTotals): number {
      return sig.keyNumberBuys;
    },
    tieBreak(
      sig: HalfPointBuysSignature,
      _totals: CustomerTotals,
    ): readonly number[] {
      return [
        sig.buyCount > 0 ? sig.keyNumberBuys / sig.buyCount : 0,
        sig.buyCount,
      ];
    },
  };
}
