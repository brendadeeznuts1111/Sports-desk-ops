/**
 * @file lib/signatures/index.ts
 * @description Stage 4.1 `SIGNATURE_SPECS` registry in strictly ascending `kind` order (S4 invariant):
 * 1. `cbb_under_concentration` (dormant)
 * 2. `football_key_number_discipline` (replaces `half_point_buys`)
 * 3. `in_play_activity` (new)
 * 4. `post_halftime_activity` (renamed from `second_half_concentration`)
 * 5. `pre_move_betting` (enriched with `timing: "pregame" | "live"`)
 */

import { compareSignatures, type RankedSignatureEntry } from "./compare.ts";
import type { SignatureSpec } from "./spec.ts";
import { makeCbbUnderConcentration } from "./specs/cbb_under_concentration.ts";
import {
  makeFootballKeyNumberDiscipline,
  resolveCustomerSpreadKeyNumber,
} from "./specs/football_key_number_discipline.ts";
import { makeHalfPointBuys } from "./specs/half_point_buys.ts";
import {
  isLiveOrHalftimeTicket,
  makeInPlayActivity,
} from "./specs/in_play_activity.ts";
import {
  classifySecondHalfTicket,
  isExplicitSecondHalfPeriod,
  isSecondHalfOrLateGameTicket,
  isSportSpecificInPlay2HWindow,
  makePostHalftimeActivity,
} from "./specs/post_halftime_activity.ts";
import { makePreMoveBetting } from "./specs/pre_move_betting.ts";
import { makeSecondHalfConcentration } from "./specs/second_half_concentration.ts";
import { DEFAULT_THRESHOLDS, type SignatureThresholds } from "./thresholds.ts";
import type {
  ActiveSignatureKind,
  CbbUnderConcentrationSignature,
  CustomerSportMix,
  CustomerTotals,
  FootballKeyNumberDisciplineSignature,
  HalfPointBuysSignature,
  InPlayActivitySignature,
  NormalizedObservationTicket,
  PostHalftimeActivitySignature,
  PreMoveBettingSignature,
  SecondHalfConcentrationSignature,
  SecondHalfSportSlice,
  Signature,
  WagerTiming,
} from "./types.ts";

export {
  classifySecondHalfTicket,
  compareSignatures,
  DEFAULT_THRESHOLDS,
  isExplicitSecondHalfPeriod,
  isLiveOrHalftimeTicket,
  isSecondHalfOrLateGameTicket,
  isSportSpecificInPlay2HWindow,
  makeCbbUnderConcentration,
  makeFootballKeyNumberDiscipline,
  makeHalfPointBuys,
  makeInPlayActivity,
  makePostHalftimeActivity,
  makePreMoveBetting,
  makeSecondHalfConcentration,
  resolveCustomerSpreadKeyNumber,
  type ActiveSignatureKind,
  type CbbUnderConcentrationSignature,
  type CustomerSportMix,
  type CustomerTotals,
  type FootballKeyNumberDisciplineSignature,
  type HalfPointBuysSignature,
  type InPlayActivitySignature,
  type NormalizedObservationTicket,
  type PostHalftimeActivitySignature,
  type PreMoveBettingSignature,
  type RankedSignatureEntry,
  type SecondHalfConcentrationSignature,
  type SecondHalfSportSlice,
  type Signature,
  type SignatureSpec,
  type SignatureThresholds,
  type WagerTiming,
};

export function createSignatureSpecs(
  thresholds: SignatureThresholds = DEFAULT_THRESHOLDS,
) {
  return [
    makeCbbUnderConcentration(thresholds.cbbUnder),
    makeFootballKeyNumberDiscipline(thresholds.footballKeyNumber),
    makeInPlayActivity(thresholds.inPlay),
    makePostHalftimeActivity(thresholds.postHalftime),
    makePreMoveBetting(thresholds.preMove),
  ] as const;
}

export const SIGNATURE_SPECS = createSignatureSpecs(DEFAULT_THRESHOLDS);

// Compile-time ascending `kind` order check (S4 invariant):
type AssertTrue<T extends true> = T;
type SpecKindsOrderValid = [
  (typeof SIGNATURE_SPECS)[0]["kind"] extends "cbb_under_concentration"
    ? true
    : false,
  (typeof SIGNATURE_SPECS)[1]["kind"] extends "football_key_number_discipline"
    ? true
    : false,
  (typeof SIGNATURE_SPECS)[2]["kind"] extends "in_play_activity" ? true : false,
  (typeof SIGNATURE_SPECS)[3]["kind"] extends "post_halftime_activity"
    ? true
    : false,
  (typeof SIGNATURE_SPECS)[4]["kind"] extends "pre_move_betting" ? true : false,
];
export type _AssertSignatureSpecsSorted = AssertTrue<
  SpecKindsOrderValid[number] extends true ? true : false
>;
