/**
 * @file lib/signatures/spec.ts
 * @description Stage 2 contract (`SignatureSpec<K, State>`) for customer behavioral signature builders.
 */

import type {
  CustomerTotals,
  NormalizedObservationTicket,
  Signature,
} from "./types.ts";

export interface SignatureSpec<
  K extends Signature["kind"],
  State,
  Sig extends Extract<Signature, { kind: K }> = Extract<Signature, { kind: K }>,
> {
  /** Literal `Signature["kind"]` key (drives lexicographic S4 sort & bucket indexing). */
  readonly kind: K;
  /** Fresh per-customer state initializer (no shared references). */
  init(): State;
  /** O(1) per-wager accumulator update. */
  observe(state: State, ticket: NormalizedObservationTicket): void;
  /**
   * Gate & materializer: MUST explicitly guard every denominator (`> 0`) and threshold
   * before emitting `Sig`, returning `null` otherwise (M3 invariant).
   */
  emit(state: State, totals: CustomerTotals): Sig | null;
  /** Primary ranking scalar only (higher is stronger; never folds in `totalRiskUsd` or `customerId`). */
  rankScore(sig: Sig, totals: CustomerTotals): number;
  /** Optional secondary tie-break scalars, compared lexicographically descending. */
  tieBreak?(sig: Sig, totals: CustomerTotals): readonly number[];
}
