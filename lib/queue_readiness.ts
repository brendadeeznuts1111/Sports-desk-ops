/**
 * Readiness gate for the queue rule-hit batch. Execution and per-rule application are separate
 * decisions: a batch may run and still be a no-op if no rule has enough reviews to apply.
 *
 * The gate is hard: `ready: false` means the batch must not produce a queue.
 */
export interface QueueRuleSupport {
  readonly rule: string;
  readonly confirmedReviews: number;
}

export interface QueueReadinessInput {
  /** Age of the GSLive corpus window relative to the batch clock. */
  readonly corpusAgeHours: number;
  /** Age of the fitted model artifact. */
  readonly modelAgeDays: number;
  /** Fraction of GSLive queue accounts that resolve to a durable F402 identity. */
  readonly bridgeCoverage: number;
  /**
   * Whether covered and uncovered accounts are statistically comparable. Null means the
   * representativeness study has not been run; coverage alone is not enough.
   */
  readonly bridgeRepresentative: boolean | null;
  /** Confirmed review rows available to attach. */
  readonly confirmedReviews: number;
  /** Per-rule confirmed-review support; a rule is applied only at the policy minimum. */
  readonly rules: readonly QueueRuleSupport[];
}

export interface QueueReadinessBlocker {
  readonly name:
    | "corpusFreshness"
    | "modelFreshness"
    | "bridgeRepresentativeness"
    | "reviewRows"
    | "reviewRowsPerRule";
  readonly current: string;
  readonly required: string;
}

export interface QueueReadinessPolicy {
  readonly maxCorpusAgeHours: number;
  readonly maxModelAgeDays: number;
  readonly minConfirmedReviews: number;
  readonly minConfirmedReviewsPerRule: number;
}

export const DEFAULT_QUEUE_READINESS_POLICY: QueueReadinessPolicy = {
  maxCorpusAgeHours: 6,
  maxModelAgeDays: 7,
  minConfirmedReviews: 1,
  minConfirmedReviewsPerRule: 5,
};

export interface QueueRuleApplication {
  readonly rule: string;
  readonly reason: "reviewedSampleSize";
  readonly n: number;
}

export interface QueueReadiness {
  /** The batch may execute: fresh corpus/model, representative bridge, at least one review. */
  readonly ready: boolean;
  readonly blockers: readonly QueueReadinessBlocker[];
  /** Which rules may contribute a tie-break, and which are excluded and why. */
  readonly ruleApplication: {
    readonly ready: boolean;
    readonly applied: readonly string[];
    readonly notApplied: readonly QueueRuleApplication[];
    readonly blockers: readonly QueueReadinessBlocker[];
  };
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
  if (input.modelAgeDays > policy.maxModelAgeDays) {
    blockers.push({
      name: "modelFreshness",
      current: `${input.modelAgeDays.toFixed(1)}d`,
      required: `<= ${policy.maxModelAgeDays}d`,
    });
  }
  if (input.bridgeRepresentative !== true) {
    blockers.push({
      name: "bridgeRepresentativeness",
      current:
        input.bridgeRepresentative === null
          ? "not measured"
          : input.bridgeRepresentative
            ? "representative"
            : "divergent",
      required: "covered vs uncovered within one Wilson interval",
    });
  }
  if (input.confirmedReviews < policy.minConfirmedReviews) {
    blockers.push({
      name: "reviewRows",
      current: String(input.confirmedReviews),
      required: `>= ${policy.minConfirmedReviews} confirmed`,
    });
  }

  const applied = input.rules
    .filter(
      (rule) => rule.confirmedReviews >= policy.minConfirmedReviewsPerRule,
    )
    .map((rule) => rule.rule);
  const notApplied: QueueRuleApplication[] = input.rules
    .filter((rule) => rule.confirmedReviews < policy.minConfirmedReviewsPerRule)
    .map((rule) => ({
      rule: rule.rule,
      reason: "reviewedSampleSize" as const,
      n: rule.confirmedReviews,
    }));
  const applicationBlockers: QueueReadinessBlocker[] = [];
  if (input.rules.length > 0 && applied.length === 0) {
    applicationBlockers.push({
      name: "reviewRowsPerRule",
      current: `best ${Math.max(...input.rules.map((rule) => rule.confirmedReviews))} per rule`,
      required: `>= ${policy.minConfirmedReviewsPerRule} confirmed per rule`,
    });
  }

  return {
    ready: blockers.length === 0,
    blockers,
    ruleApplication: {
      ready: applicationBlockers.length === 0,
      applied,
      notApplied,
      blockers: applicationBlockers,
    },
  };
}
