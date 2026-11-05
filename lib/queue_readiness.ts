/**
 * Readiness gate for the queue rule-hit batch. This is a decision gate, not a warning: if any
 * blocker is present the batch must not run. A queue built on stale data or a 4% bridge looks
 * authoritative to the reviewer and is wrong in a way a warning does not fix.
 */
export interface QueueReadinessInput {
  /** Age of the GSLive corpus window relative to the batch clock. */
  readonly corpusAgeHours: number;
  /** Fraction of GSLive queue accounts that resolve to a durable F402 identity. */
  readonly bridgeCoverage: number;
  /** Confirmed review rows available to attach. */
  readonly confirmedReviews: number;
  /** Median absolute gap between adjacent model scores in the top K; null if not computed. */
  readonly topKGapMedian: number | null;
}

export interface QueueReadinessBlocker {
  readonly name:
    "corpusFreshness" | "bridgeCoverage" | "reviewRows" | "weightCalibration";
  readonly current: string;
  readonly required: string;
}

export interface QueueReadinessPolicy {
  readonly maxCorpusAgeHours: number;
  readonly minBridgeCoverage: number;
  readonly minConfirmedReviews: number;
  /** A weight is only calibrated once the top-K adjacent gap is known. */
  readonly requireTopKGap: boolean;
}

export const DEFAULT_QUEUE_READINESS_POLICY: QueueReadinessPolicy = {
  maxCorpusAgeHours: 6,
  minBridgeCoverage: 0.5,
  minConfirmedReviews: 1,
  requireTopKGap: true,
};

export interface QueueReadiness {
  readonly ready: boolean;
  readonly blockers: readonly QueueReadinessBlocker[];
}

export function assessQueueReadiness(
  input: QueueReadinessInput,
  policy: QueueReadinessPolicy = DEFAULT_QUEUE_READINESS_POLICY,
): QueueReadiness {
  const blockers: QueueReadinessBlocker[] = [];
  if (input.corpusAgeHours > policy.maxCorpusAgeHours) {
    blockers.push({
      name: "corpusFreshness",
      current: `${input.corpusAgeHours.toFixed(1)}h`,
      required: `<= ${policy.maxCorpusAgeHours}h`,
    });
  }
  if (input.bridgeCoverage < policy.minBridgeCoverage) {
    blockers.push({
      name: "bridgeCoverage",
      current: `${(input.bridgeCoverage * 100).toFixed(1)}%`,
      required: `>= ${(policy.minBridgeCoverage * 100).toFixed(0)}%`,
    });
  }
  if (input.confirmedReviews < policy.minConfirmedReviews) {
    blockers.push({
      name: "reviewRows",
      current: String(input.confirmedReviews),
      required: `>= ${policy.minConfirmedReviews} confirmed`,
    });
  }
  if (policy.requireTopKGap && input.topKGapMedian === null) {
    blockers.push({
      name: "weightCalibration",
      current: "not measured",
      required: "top-K gap median computed",
    });
  }
  return { ready: blockers.length === 0, blockers };
}
