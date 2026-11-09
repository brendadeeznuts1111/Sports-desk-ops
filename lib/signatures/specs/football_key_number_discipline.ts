/**
 * @file lib/signatures/specs/football_key_number_discipline.ts
 * @description Football spread key-number discipline spec (replaces `half_point_buys`).
 * Measures whether a customer lands on Football key numbers (`3`, `7`, `10`, `14`, `21`) on their
 * actual spread line (`adjSpread`) across all Football spread bets (`sport === "Football" &&
 * marketKind === "spread"`), distinguishing landing directly at a key number (`buyPoints === 0`)
 * from buying onto/across a key number (`buyPoints > 0`).
 */

import type { FootballKeyNumber } from "../../customer_profile.ts";
import type { SignatureSpec } from "../spec.ts";
import type { SignatureThresholds } from "../thresholds.ts";
import type {
  CustomerTotals,
  FootballKeyNumberDisciplineSignature,
  NormalizedObservationTicket,
} from "../types.ts";

export interface FootballKeyNumberState {
  onKey: number;
  totalSpread: number;
  onKey3: number;
  onKey7: number;
  onKeyOther: number;
  atKeyCount: number;
  boughtKeyCount: number;
  pregameCount: number;
  liveCount: number;
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

/**
 * Evaluates the key number (`3 | 7 | 10 | 14 | 21 | null`) on the customer's actual spread line
 * (`adjSpread`), falling back to `touchedKeyNumber` if a point-buy crossed a key number.
 */
export function resolveCustomerSpreadKeyNumber(
  ticket: NormalizedObservationTicket,
): FootballKeyNumber | null {
  if (ticket.adjSpread !== null && Number.isFinite(ticket.adjSpread)) {
    const abs = Math.round(Math.abs(ticket.adjSpread) * 100) / 100;
    if (abs === 3 || abs === 7 || abs === 10 || abs === 14 || abs === 21) {
      return abs as FootballKeyNumber;
    }
  }
  return ticket.touchedKeyNumber;
}

export function makeFootballKeyNumberDiscipline(
  thresholds: SignatureThresholds["footballKeyNumber"],
): SignatureSpec<
  "football_key_number_discipline",
  FootballKeyNumberState,
  FootballKeyNumberDisciplineSignature
> {
  return {
    kind: "football_key_number_discipline",
    init(): FootballKeyNumberState {
      return {
        onKey: 0,
        totalSpread: 0,
        onKey3: 0,
        onKey7: 0,
        onKeyOther: 0,
        atKeyCount: 0,
        boughtKeyCount: 0,
        pregameCount: 0,
        liveCount: 0,
        customerLegs: 0,
        distinctWagers: new Set<string>(),
      };
    },
    observe(
      state: FootballKeyNumberState,
      ticket: NormalizedObservationTicket,
    ): void {
      state.customerLegs += 1;
      if (ticket.sport !== "Football" || ticket.marketKind !== "spread") {
        return;
      }

      state.totalSpread += 1;
      state.distinctWagers.add(wagerKeyOf(ticket, state.customerLegs));

      if (ticket.timing === "in_play" || ticket.timing === "halftime") {
        state.liveCount += 1;
      } else {
        state.pregameCount += 1;
      }

      const keyNum = resolveCustomerSpreadKeyNumber(ticket);
      if (keyNum !== null) {
        state.onKey += 1;
        if (keyNum === 3) state.onKey3 += 1;
        else if (keyNum === 7) state.onKey7 += 1;
        else state.onKeyOther += 1;

        if (ticket.buyPoints > 0) {
          state.boughtKeyCount += 1;
        } else {
          state.atKeyCount += 1;
        }
      }
    },
    emit(
      state: FootballKeyNumberState,
      _totals: CustomerTotals,
    ): FootballKeyNumberDisciplineSignature | null {
      if (
        state.totalSpread <= 0 ||
        state.onKey <= 0 ||
        state.customerLegs > thresholds.maxLegsPerCustomer ||
        state.distinctWagers.size < thresholds.minWagers ||
        state.totalSpread < thresholds.minSpreadLegs ||
        state.onKey < thresholds.minOnKey
      ) {
        return null;
      }
      const onKeyRate = state.onKey / state.totalSpread;
      if (onKeyRate < thresholds.minRate) {
        return null;
      }
      return {
        kind: "football_key_number_discipline",
        onKey: state.onKey,
        totalSpread: state.totalSpread,
        onKeyRate,
        onKey3: state.onKey3,
        onKey7: state.onKey7,
        onKeyOther: state.onKeyOther,
        atKeyCount: state.atKeyCount,
        boughtKeyCount: state.boughtKeyCount,
        distinctWagers: state.distinctWagers.size,
        pregameCount: state.pregameCount,
        liveCount: state.liveCount,
      };
    },
    rankScore(
      sig: FootballKeyNumberDisciplineSignature,
      _totals: CustomerTotals,
    ): number {
      return sig.totalSpread > 0 ? sig.onKey / sig.totalSpread : 0;
    },
    tieBreak(
      sig: FootballKeyNumberDisciplineSignature,
      _totals: CustomerTotals,
    ): readonly number[] {
      return [sig.onKey3 + sig.onKey7, sig.distinctWagers];
    },
  };
}
