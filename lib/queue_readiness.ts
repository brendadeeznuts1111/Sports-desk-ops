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
  /**
   * Fraction of GSLive queue accounts that resolve to a durable F402 identity. Reported, not
   * gated: null means the bridge coverage has not been measured for this run.
   */
  readonly bridgeCoverage: number | null;
  /**
   * Whether covered and uncovered accounts are statistically comparable. Null means the
   * representativeness study has not been run; coverage alone is not enough.
   */
  readonly bridgeRepresentative: boolean | null;
  /** Confirmed review rows available to attach. */
  readonly confirmedReviews: number;
  /** Per-rule confirmed-review support; a rule is applied only at the policy minimum. */
  readonly rules: readonly QueueRuleSupport[];
  /**
   * Age of the coverage measurement. Coverage is reported, not gated; a stale measurement emits a
   * warning so a 200-day-old fallback does not look authoritative.
   */
  readonly bridgeCoverageAgeDays?: number | null | undefined;
}

export interface QueueReadinessWarning {
  readonly name: "bridgeCoverageStaleness";
  readonly current: string;
  readonly required: string;
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
  /** Coverage is not gated; an older measurement is a warning, not a refusal. */
  readonly maxBridgeCoverageAgeDays: number;
}

export const DEFAULT_QUEUE_READINESS_POLICY: QueueReadinessPolicy = {
  maxCorpusAgeHours: 6,
  maxModelAgeDays: 7,
  minConfirmedReviews: 1,
  minConfirmedReviewsPerRule: 5,
  maxBridgeCoverageAgeDays: 30,
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
  /** Reported problems that do not close the gate. */
  readonly warnings: readonly QueueReadinessWarning[];
  /** Which rules may contribute a tie-break, and which are excluded and why. */
  readonly ruleApplication: {
    readonly ready: boolean;
    readonly applied: readonly string[];
    readonly notApplied: readonly QueueRuleApplication[];
    readonly blockers: readonly QueueReadinessBlocker[];
  };
}

function formatAge(value: number, unit: "h" | "d"): string {
  return Number.isFinite(value) ? `${value.toFixed(1)}${unit}` : "missing";
}

export function assessQueueReadiness(
  input: QueueReadinessInput,
  policy: QueueReadinessPolicy = DEFAULT_QUEUE_READINESS_POLICY,
): QueueReadiness {
  const blockers: QueueReadinessBlocker[] = [];
  const warnings: QueueReadinessWarning[] = [];
  if (input.corpusAgeHours > policy.maxCorpusAgeHours) {
    blockers.push({
      name: "corpusFreshness",
      current: formatAge(input.corpusAgeHours, "h"),
      required: `<= ${policy.maxCorpusAgeHours}h`,
    });
  }
  if (input.modelAgeDays > policy.maxModelAgeDays) {
    blockers.push({
      name: "modelFreshness",
      current: formatAge(input.modelAgeDays, "d"),
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
  const coverageAgeDays = input.bridgeCoverageAgeDays;
  if (
    coverageAgeDays !== null &&
    coverageAgeDays !== undefined &&
    coverageAgeDays > policy.maxBridgeCoverageAgeDays
  ) {
    warnings.push({
      name: "bridgeCoverageStaleness",
      current: `${coverageAgeDays.toFixed(1)}d`,
      required: `<= ${policy.maxBridgeCoverageAgeDays}d`,
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
    warnings,
    ruleApplication: {
      ready: applicationBlockers.length === 0,
      applied,
      notApplied,
      blockers: applicationBlockers,
    },
  };
}

/**
 * Stub batch body. It is deliberately unreachable until the gate clears; when it does, this is
 * the shape the real reason-attachment pass must fill in. Keeping it executable prevents the gate
 * from becoming a function nobody calls.
 */
export type QueueRuleApplicationState = "measured" | "partial" | "not_applied";

function ruleApplicationState(
  application: QueueReadiness["ruleApplication"],
): QueueRuleApplicationState {
  if (application.applied.length === 0) return "not_applied";
  return application.notApplied.length === 0 ? "measured" : "partial";
}

/**
 * Run the batch body behind the gate. The gate check stays here so a caller cannot build a queue
 * without an open readiness result; the body itself is supplied by the caller and is only
 * evaluated after the check.
 */
export function queueBatchBody<T extends object>(
  readiness: QueueReadiness,
  body: () => T,
): T & {
  readonly ruleApplication: QueueReadiness["ruleApplication"] & {
    /** measured = every reviewed rule applied; partial = some did; not_applied = none did. */
    readonly state: QueueRuleApplicationState;
  };
} {
  if (!readiness.ready) {
    throw new Error("queueBatchBody: readiness gate is closed");
  }
  return {
    ...body(),
    ruleApplication: {
      ...readiness.ruleApplication,
      state: ruleApplicationState(readiness.ruleApplication),
    },
  };
}
