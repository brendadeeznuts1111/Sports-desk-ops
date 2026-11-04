/**
 * @file lib/gslive_surveillance_governor.ts
 * @description Live Surveillance & Trojan-Horse Enforcement Governor
 *              (`GATE-SURV-01`, `GATE-SURV-01-ENC`, and `GATE-SURV-02`).
 *
 * Implements:
 *  - `GATE-SURV-01`: Named semantic predicates (`PRE_BET_SCORE_LATENCY`, `POST_BET_30S_RACE`,
 *    `CLINCHED_AT_PLACEMENT`, `CLINCHED_WON_AT_PLACEMENT`, `CLINCHED_LOST_AT_PLACEMENT`,
 *    `DANGER_STATE_AT_PLACEMENT`), side-specific monotonic cumulative clinch rules (`OVER` vs `UNDER`),
 *    `tauSkewSec > 0` clock-skew window shift, canonical tie/duplicate deduplication, and
 *    zero-allocation in-place insertion sort over preallocated scratch buffers.
 *  - `GATE-SURV-01-ENC`: Isolated `BitSet32` numeric wire-encoding contract.
 *  - `GATE-SURV-02`:
 *      1. Stage A (`detectAccountPredicates`): Named threshold constants (`TROJAN_BASE_MAX_NET_CENTS = -1`,
 *         `TROJAN_STEPUP_MIN_NET_CENTS = 100_000`, `TROJAN_STEPUP_MIN_ROI_BPS = 1_500`,
 *         `DONOR_SHIELD_MIN_LIFETIME_HOUSE_NET_CENTS = 5_000_000`, `CONFIRM_BYPASS_MAX_SETTLE_MS = 30_000`,
 *         `CONFIRM_BYPASS_MIN_CORROBORATED_COUNT = 2`).
 *      2. Stage B (`routeEnforcementEffect`): 3-variant Tagged Union keyed on `kind` (`CLOSED_FRAUD` |
 *         `ACTIVE_CLAMPED` | `ACTIVE_UNCLAMPED`) where `maxBetCents` and `liveDelaySec` exist ONLY on
 *         `ACTIVE_CLAMPED` and are strictly positive (`1_000 / 12s` for Priority 2 non-donor probation;
 *         `50_000 / 10s` for Priority 3 donor containment).
 *      3. Stage C (`transitionAccountState`): Explicit persistence state machine with absorbing `CLOSED_FRAUD`,
 *         monotonicity under automated polling, `RISK_DESK_ANALYST` review owner, 24-hour SLA, and
 *         signed review resolution exit paths.
 */

export const BIT_DANGER_STATE_AT_PLACEMENT = 0x0010;
export const BIT_CLINCHED_WON_AT_PLACEMENT = 0x0020;
export const BIT_CLINCHED_LOST_AT_PLACEMENT = 0x0080;
export const BIT_CLINCHED_AT_PLACEMENT = 0x0100;
export const BIT_PRE_BET_SCORE_LATENCY = 0x0200;
export const BIT_POST_BET_30S_RACE = 0x0400;

export const TROJAN_BASE_MAX_NET_CENTS = -1;
export const TROJAN_STEPUP_MIN_NET_CENTS = 100_000;
export const TROJAN_STEPUP_MIN_ROI_BPS = 1_500;
export const DONOR_SHIELD_MIN_LIFETIME_HOUSE_NET_CENTS = 5_000_000;
export const CONFIRM_BYPASS_MAX_SETTLE_MS = 30_000;
export const CONFIRM_BYPASS_MIN_CORROBORATED_COUNT = 2;

export const PROBATION_NON_DONOR_CAP_CENTS = 1_000;
export const PROBATION_NON_DONOR_DELAY_SEC = 12;
export const PROBATION_REVIEW_SLA_HOURS = 24;
export const SURGICAL_DONOR_CAP_CENTS = 50_000;
export const SURGICAL_DONOR_DELAY_SEC = 10;

export interface EventTick {
  deltaSec: number;
  relevantScore: number;
  isDanger: 0 | 1;
}

export interface Surv01Predicates {
  PRE_BET_SCORE_LATENCY: boolean;
  POST_BET_30S_RACE: boolean;
  CLINCHED_AT_PLACEMENT: boolean;
  CLINCHED_WON_AT_PLACEMENT: boolean;
  CLINCHED_LOST_AT_PLACEMENT: boolean;
  DANGER_STATE_AT_PLACEMENT: boolean;
}

export interface AccountPredicates {
  PRE_BET_CLINCHED_FRAUD: boolean;
  CONFIRM_WINDOW_BYPASS_WIN: boolean;
  TROJAN_ASYMMETRY: boolean;
  DONOR_VALUE_QUALIFIED: boolean;
}

export type EnforcementEffect =
  | {
      readonly kind: "CLOSED_FRAUD";
      readonly baseSportsEnabled: false;
      readonly derivativeLiveEnabled: false;
    }
  | {
      readonly kind: "ACTIVE_CLAMPED";
      readonly baseSportsEnabled: true;
      readonly derivativeLiveEnabled: false;
      readonly maxBetCents: 1_000 | 50_000;
      readonly liveDelaySec: 12 | 10;
      readonly reviewOwner: "RISK_DESK_ANALYST" | null;
      readonly reviewSlaHours: 24 | null;
    }
  | {
      readonly kind: "ACTIVE_UNCLAMPED";
      readonly baseSportsEnabled: true;
      readonly derivativeLiveEnabled: true;
    };

export interface SignedReviewResolution {
  readonly actor: "RISK_DESK_ANALYST";
  readonly signedAuditTicketId: string;
  readonly verdict: "EXONERATE_FEED_DRIFT" | "CONFIRM_SYNDICATE_ABUSE";
}

function inplaceInsertionSortTicks(buf: EventTick[], n: number): void {
  for (let i = 1; i < n; i++) {
    const cur = buf[i]!;
    let j = i - 1;
    while (
      j >= 0 &&
      (buf[j]!.deltaSec - cur.deltaSec ||
        buf[j]!.relevantScore - cur.relevantScore ||
        buf[j]!.isDanger - cur.isDanger) > 0
    ) {
      buf[j + 1] = buf[j]!;
      j -= 1;
    }
    buf[j + 1] = cur;
  }
}

export function evaluateEventLogPredicates(
  ticks: readonly EventTick[],
  lineHundredths: number,
  side: "OVER" | "UNDER",
  tauSkewSec: number = 2,
  scratchBuffer?: EventTick[],
): Surv01Predicates {
  const n = ticks.length;
  const ordered: EventTick[] = scratchBuffer ?? [];
  if (ordered.length < n) {
    ordered.length = n;
  }
  for (let i = 0; i < n; i++) {
    ordered[i] = ticks[i]!;
  }
  inplaceInsertionSortTicks(ordered, n);

  let preBetScoreLatency = false;
  let postBet30sRace = false;
  let clinchedAtPlacement = false;
  let clinchedWonAtPlacement = false;
  let clinchedLostAtPlacement = false;
  let dangerStateAtPlacement = false;

  const lowerBound = -(90 + tauSkewSec);
  let prev: EventTick | null = null;

  for (let i = 0; i < n; i++) {
    const t = ordered[i]!;
    if (
      prev !== null &&
      prev.deltaSec === t.deltaSec &&
      prev.relevantScore === t.relevantScore &&
      prev.isDanger === t.isDanger
    ) {
      continue;
    }
    prev = t;

    if (t.isDanger === 1 && t.deltaSec >= lowerBound && t.deltaSec <= 0) {
      dangerStateAtPlacement = true;
    }
    if (t.deltaSec >= lowerBound && t.deltaSec <= 0) {
      preBetScoreLatency = true;
      if (t.relevantScore * 100 > lineHundredths) {
        clinchedAtPlacement = true;
        if (side === "OVER") {
          clinchedWonAtPlacement = true;
        } else {
          clinchedLostAtPlacement = true;
        }
      }
    } else if (t.deltaSec > 0 && t.deltaSec <= 35) {
      postBet30sRace = true;
    }
  }

  return {
    PRE_BET_SCORE_LATENCY: preBetScoreLatency,
    POST_BET_30S_RACE: postBet30sRace,
    CLINCHED_AT_PLACEMENT: clinchedAtPlacement,
    CLINCHED_WON_AT_PLACEMENT: clinchedWonAtPlacement,
    CLINCHED_LOST_AT_PLACEMENT: clinchedLostAtPlacement,
    DANGER_STATE_AT_PLACEMENT: dangerStateAtPlacement,
  };
}

export function encodeSurv01PredicatesToBitSet32(p: Surv01Predicates): number {
  let mask = 0;
  if (p.DANGER_STATE_AT_PLACEMENT) mask |= BIT_DANGER_STATE_AT_PLACEMENT;
  if (p.CLINCHED_WON_AT_PLACEMENT) mask |= BIT_CLINCHED_WON_AT_PLACEMENT;
  if (p.CLINCHED_LOST_AT_PLACEMENT) mask |= BIT_CLINCHED_LOST_AT_PLACEMENT;
  if (p.CLINCHED_AT_PLACEMENT) mask |= BIT_CLINCHED_AT_PLACEMENT;
  if (p.PRE_BET_SCORE_LATENCY) mask |= BIT_PRE_BET_SCORE_LATENCY;
  if (p.POST_BET_30S_RACE) mask |= BIT_POST_BET_30S_RACE;
  return mask >>> 0;
}

export function detectAccountPredicates(
  baseNetCents: number,
  stepupNetCents: number,
  stepupRoiBps: number,
  lifetimeHouseNetCents: number,
  surv01: Surv01Predicates,
  winningTicketSettleMsList: readonly number[],
): AccountPredicates {
  let sub30sCount = 0;
  for (let i = 0; i < winningTicketSettleMsList.length; i++) {
    const ms = winningTicketSettleMsList[i]!;
    if (ms > 0 && ms <= CONFIRM_BYPASS_MAX_SETTLE_MS) {
      sub30sCount += 1;
    }
  }

  return {
    PRE_BET_CLINCHED_FRAUD: surv01.CLINCHED_WON_AT_PLACEMENT,
    CONFIRM_WINDOW_BYPASS_WIN:
      sub30sCount >= CONFIRM_BYPASS_MIN_CORROBORATED_COUNT ||
      (sub30sCount >= 1 && surv01.PRE_BET_SCORE_LATENCY),
    TROJAN_ASYMMETRY:
      baseNetCents <= TROJAN_BASE_MAX_NET_CENTS &&
      stepupNetCents >= TROJAN_STEPUP_MIN_NET_CENTS &&
      stepupRoiBps >= TROJAN_STEPUP_MIN_ROI_BPS,
    DONOR_VALUE_QUALIFIED:
      lifetimeHouseNetCents >= DONOR_SHIELD_MIN_LIFETIME_HOUSE_NET_CENTS,
  };
}

export function routeEnforcementEffect(
  p: AccountPredicates,
): EnforcementEffect {
  if (p.PRE_BET_CLINCHED_FRAUD) {
    return {
      kind: "CLOSED_FRAUD",
      baseSportsEnabled: false,
      derivativeLiveEnabled: false,
    };
  }
  if (
    (p.TROJAN_ASYMMETRY || p.CONFIRM_WINDOW_BYPASS_WIN) &&
    !p.DONOR_VALUE_QUALIFIED
  ) {
    return {
      kind: "ACTIVE_CLAMPED",
      baseSportsEnabled: true,
      derivativeLiveEnabled: false,
      maxBetCents: PROBATION_NON_DONOR_CAP_CENTS,
      liveDelaySec: PROBATION_NON_DONOR_DELAY_SEC,
      reviewOwner: "RISK_DESK_ANALYST",
      reviewSlaHours: PROBATION_REVIEW_SLA_HOURS,
    };
  }
  if (
    (p.TROJAN_ASYMMETRY || p.CONFIRM_WINDOW_BYPASS_WIN) &&
    p.DONOR_VALUE_QUALIFIED
  ) {
    return {
      kind: "ACTIVE_CLAMPED",
      baseSportsEnabled: true,
      derivativeLiveEnabled: false,
      maxBetCents: SURGICAL_DONOR_CAP_CENTS,
      liveDelaySec: SURGICAL_DONOR_DELAY_SEC,
      reviewOwner: null,
      reviewSlaHours: null,
    };
  }
  return {
    kind: "ACTIVE_UNCLAMPED",
    baseSportsEnabled: true,
    derivativeLiveEnabled: true,
  };
}

export function readActiveClampLimits(
  eff: EnforcementEffect,
): [number, number] {
  if (eff.kind !== "ACTIVE_CLAMPED") {
    throw new TypeError(
      `maxBetCents/liveDelaySec are not applicable for discriminant kind=${eff.kind}`,
    );
  }
  return [eff.maxBetCents, eff.liveDelaySec];
}

export function transitionAccountState(
  currentEffect: EnforcementEffect,
  candidateEffect: EnforcementEffect,
  reviewResolution?: SignedReviewResolution | null,
  elapsedHoursInState: number = 0,
): { readonly nextState: EnforcementEffect; readonly transitionCode: string } {
  if (currentEffect.kind === "CLOSED_FRAUD") {
    return {
      nextState: currentEffect,
      transitionCode: "TERMINAL_ABSORBING_NO_OP",
    };
  }
  if (candidateEffect.kind === "CLOSED_FRAUD") {
    return {
      nextState: candidateEffect,
      transitionCode: "ESCALATED_TO_CLOSED_FRAUD",
    };
  }
  if (reviewResolution && currentEffect.kind === "ACTIVE_CLAMPED") {
    const auditId = reviewResolution.signedAuditTicketId.trim();
    if (reviewResolution.actor !== "RISK_DESK_ANALYST" || auditId === "") {
      throw new Error(
        "Review resolution requires actor=RISK_DESK_ANALYST and signedAuditTicketId",
      );
    }
    if (reviewResolution.verdict === "EXONERATE_FEED_DRIFT") {
      return {
        nextState: {
          kind: "ACTIVE_UNCLAMPED",
          baseSportsEnabled: true,
          derivativeLiveEnabled: true,
        },
        transitionCode: "REVIEW_EXONERATED_TO_UNCLAMPED",
      };
    }
    return {
      nextState: {
        kind: "CLOSED_FRAUD",
        baseSportsEnabled: false,
        derivativeLiveEnabled: false,
      },
      transitionCode: "REVIEW_CONFIRMED_TO_CLOSED_FRAUD",
    };
  }
  if (
    currentEffect.kind === "ACTIVE_CLAMPED" &&
    candidateEffect.kind === "ACTIVE_UNCLAMPED"
  ) {
    if (
      currentEffect.reviewSlaHours !== null &&
      elapsedHoursInState >= currentEffect.reviewSlaHours
    ) {
      return {
        nextState: currentEffect,
        transitionCode: "P1_SLA_BREACH_HOLD_CLAMP",
      };
    }
    return {
      nextState: currentEffect,
      transitionCode: "HOLD_CLAMP_AWAITING_REVIEW",
    };
  }
  return { nextState: candidateEffect, transitionCode: "STATE_UPDATED" };
}
