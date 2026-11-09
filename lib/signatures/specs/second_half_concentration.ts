/**
 * @file lib/signatures/specs/second_half_concentration.ts
 * @description Deprecated alias for `post_halftime_activity.ts`.
 */

import type { SignatureSpec } from "../spec.ts";
import type { SignatureThresholds } from "../thresholds.ts";
import type {
  CustomerTotals,
  SecondHalfConcentrationSignature,
} from "../types.ts";
import {
  classifySecondHalfTicket,
  isExplicitSecondHalfPeriod,
  isSecondHalfOrLateGameTicket,
  isSportSpecificInPlay2HWindow,
  makePostHalftimeActivity,
  type MutableSportSlice,
  type PostHalftimeState,
} from "./post_halftime_activity.ts";

export {
  classifySecondHalfTicket,
  isExplicitSecondHalfPeriod,
  isSecondHalfOrLateGameTicket,
  isSportSpecificInPlay2HWindow,
  type MutableSportSlice,
  type PostHalftimeState as SecondHalfState,
};

/**
 * @deprecated Use `makePostHalftimeActivity` (`post_halftime_activity`) instead.
 */
export function makeSecondHalfConcentration(
  thresholds: SignatureThresholds["postHalftime"],
): SignatureSpec<
  "second_half_concentration",
  PostHalftimeState,
  SecondHalfConcentrationSignature
> {
  const delegate = makePostHalftimeActivity(thresholds);
  return {
    kind: "second_half_concentration",
    init: () => delegate.init(),
    observe: (state, ticket) => delegate.observe(state, ticket),
    emit(
      state: PostHalftimeState,
      totals: CustomerTotals,
    ): SecondHalfConcentrationSignature | null {
      const emitted = delegate.emit(state, totals);
      if (emitted === null) return null;
      return {
        ...emitted,
        kind: "second_half_concentration",
      };
    },
    rankScore: (sig, totals) =>
      delegate.rankScore(
        {
          ...sig,
          kind: "post_halftime_activity",
          twoHalfRate:
            sig.twoHalfRate ??
            (sig.totalCount > 0 ? sig.twoHalfCount / sig.totalCount : 0),
          distinctWagers: sig.distinctWagers ?? 1,
        },
        totals,
      ),
    tieBreak: (sig, totals) =>
      delegate.tieBreak
        ? delegate.tieBreak(
            {
              ...sig,
              kind: "post_halftime_activity",
              twoHalfRate:
                sig.twoHalfRate ??
                (sig.totalCount > 0 ? sig.twoHalfCount / sig.totalCount : 0),
              distinctWagers: sig.distinctWagers ?? 1,
            },
            totals,
          )
        : [sig.twoHalfCount],
  };
}
