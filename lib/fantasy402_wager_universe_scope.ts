/**
 * What Fantasy402 Manager feeds can prove — not "all wagers," but observation slices.
 *
 * `Manager/getPending` is a pending snapshot (WagerStatus "P"). Settled/canceled wagers
 * leave the feed; they are not backfilled unless a settlement/history poll is ingested.
 */

export type WagerObservationSlice =
  "pending_at_poll" | "settlement_history" | "pending_diff_inferred";

/** Feeds that extend the observable universe when ingested append-only. */
export const FANTASY402_MANAGER_FEEDS = {
  getPending: {
    endpoint: "Manager/getPending",
    slice: "pending_at_poll" as const,
    wagerStatusOnWire: "P",
    includesFutureGameWagers: true,
    includesSettledWagers: false,
    includesCanceledBeforePoll: false,
    forwardLiabilitySnapshot: false,
  },
  getHistory: {
    endpoint: "Manager/getHistory",
    slice: "settlement_history" as const,
    wagerStatusOnWire: "S|C|…",
    includesFutureGameWagers: false,
    includesSettledWagers: true,
    includesCanceledBeforePoll: true,
    forwardLiabilitySnapshot: false,
    ingestionStatus: "wired" as const,
  },
  getGrading: {
    endpoint: "Manager/getGrading",
    slice: "settlement_history" as const,
    wagerStatusOnWire: "graded outcomes",
    includesSettledWagers: true,
    ingestionStatus: "wired" as const,
  },
  getDeleteWager: {
    endpoint: "Manager/getDeleteWager",
    slice: "settlement_history" as const,
    wagerStatusOnWire: "P|O (BUYOUT-<CustomerID> + operator/system deletes)",
    includesSettledWagers: false,
    includesCanceledBeforePoll: true,
    ingestionStatus: "wired" as const,
  },
  getTransactions: {
    endpoint: "Report/getTransactions",
    slice: "settlement_history" as const,
    wagerStatusOnWire: "C|D ledger credits/debits (Buyout ... ticket <id>)",
    includesSettledWagers: true,
    includesCanceledBeforePoll: true,
    ingestionStatus: "wired" as const,
  },
} as const;

export type PatternClass =
  | "pending_price_spike"
  | "cross_source_arb"
  | "customer_stake_timing_cluster"
  | "win_loss_rate"
  | "cancel_rate"
  | "parlay_leg_completion"
  | "parlay_buyout_audit";

export type PatternProvability = "proven" | "partial" | "blocked";

export type PatternScopeRow = {
  pattern: PatternClass;
  provability: PatternProvability;
  requiredSlices: WagerObservationSlice[];
  limitation: string;
};

/** Pattern claims allowed against current SSOT (pending + match_evaluations + replay). */
export const PATTERN_SCOPE_MATRIX: readonly PatternScopeRow[] = [
  {
    pattern: "pending_price_spike",
    provability: "proven",
    requiredSlices: ["pending_at_poll"],
    limitation: "Only wagers pending at poll time",
  },
  {
    pattern: "cross_source_arb",
    provability: "partial",
    requiredSlices: ["pending_at_poll"],
    limitation:
      "Polymarket discovery done; Phase 4 cross-match rows not implemented",
  },
  {
    pattern: "customer_stake_timing_cluster",
    provability: "partial",
    requiredSlices: ["pending_at_poll"],
    limitation: "Misses pre-settle cancels and single-observation lifecycles",
  },
  {
    pattern: "win_loss_rate",
    provability: "proven",
    requiredSlices: ["settlement_history"],
    limitation: "Requires getHistory/getGrading ingestion",
  },
  {
    pattern: "cancel_rate",
    provability: "proven",
    requiredSlices: ["settlement_history"],
    limitation:
      "Pending diff alone cannot distinguish cancel vs settle (ambiguous disappearance)",
  },
  {
    pattern: "parlay_leg_completion",
    provability: "proven",
    requiredSlices: ["settlement_history"],
    limitation:
      "getPending shows legs; per-leg settlement status needs history feed",
  },
  {
    pattern: "parlay_buyout_audit",
    provability: "proven",
    requiredSlices: ["settlement_history"],
    limitation:
      "Requires getDeleteWager (BUYOUT-* legs) + getTransactions (Buyout ... ticket <id> ledger credits)",
  },
];

export function patternProvability(
  pattern: PatternClass,
  activeSlices: ReadonlySet<WagerObservationSlice>,
): PatternProvability {
  const row = PATTERN_SCOPE_MATRIX.find((r) => r.pattern === pattern);
  if (!row) return "blocked";
  const hasAll = row.requiredSlices.every((s) => activeSlices.has(s));
  if (!hasAll) return "blocked";
  return row.provability;
}

/** Default slices when no settlement store is attached (pending-only). */
export function activeWagerObservationSlices(): ReadonlySet<WagerObservationSlice> {
  return activeWagerObservationSlicesForSettlementCount(0);
}

export function activeWagerObservationSlicesForSettlementCount(
  settlementObservationCount: number,
): ReadonlySet<WagerObservationSlice> {
  const slices = new Set<WagerObservationSlice>(["pending_at_poll"]);
  if (settlementObservationCount > 0) {
    slices.add("settlement_history");
  }
  return slices;
}

export function assertPatternClaimAllowed(
  pattern: PatternClass,
  activeSlices?: ReadonlySet<WagerObservationSlice>,
): void {
  const active = activeSlices ?? activeWagerObservationSlices();
  const level = patternProvability(pattern, active);
  if (level === "blocked") {
    const row = PATTERN_SCOPE_MATRIX.find((r) => r.pattern === pattern)!;
    throw new WagerUniverseScopeError(
      `Pattern "${pattern}" is not provable on slices [${[...active].join(", ")}]: ${row.limitation}`,
    );
  }
}

export class WagerUniverseScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WagerUniverseScopeError";
  }
}
