import { describe, expect, test } from "bun:test";

import {
  DEFAULT_QUEUE_READINESS_POLICY,
  assessQueueReadiness,
} from "../lib/queue_readiness.ts";

describe("queue readiness gate", () => {
  test("is ready only when every execution input clears its threshold", () => {
    expect(
      assessQueueReadiness({
        corpusAgeHours: 2,
        modelAgeDays: 2,
        bridgeCoverage: 0.6,
        bridgeRepresentative: true,
        confirmedReviews: 10,
        minConfirmedReviewsPerRule: 6,
      }),
    ).toEqual({
      ready: true,
      blockers: [],
      ruleApplication: { ready: true, blockers: [] },
    });
  });

  test("names every blocker instead of a single vague refusal", () => {
    const readiness = assessQueueReadiness({
      corpusAgeHours: 24,
      modelAgeDays: 9,
      bridgeCoverage: 0.0394,
      bridgeRepresentative: null,
      confirmedReviews: 0,
      minConfirmedReviewsPerRule: 0,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((blocker) => blocker.name)).toEqual([
      "corpusFreshness",
      "modelFreshness",
      "bridgeRepresentativeness",
      "reviewRows",
    ]);
    expect(readiness.blockers[0]).toMatchObject({
      current: "24.0h",
      required: "<= 6h",
    });
    expect(readiness.blockers[1]).toMatchObject({
      current: "9.0d",
      required: "<= 7d",
    });
    expect(readiness.blockers[2]?.current).toBe("not measured");
    expect(readiness.ruleApplication.blockers).toEqual([
      {
        name: "reviewRowsPerRule",
        current: "0 per rule",
        required: ">= 5 confirmed per rule",
      },
    ]);
  });

  test("treats the thresholds as inclusive", () => {
    const readiness = assessQueueReadiness({
      corpusAgeHours: DEFAULT_QUEUE_READINESS_POLICY.maxCorpusAgeHours,
      modelAgeDays: DEFAULT_QUEUE_READINESS_POLICY.maxModelAgeDays,
      bridgeCoverage: 0.01,
      bridgeRepresentative: true,
      confirmedReviews: DEFAULT_QUEUE_READINESS_POLICY.minConfirmedReviews,
      minConfirmedReviewsPerRule: 5,
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.ruleApplication.ready).toBe(true);
  });

  test("execution readiness and per-rule application are separate", () => {
    const readiness = assessQueueReadiness({
      corpusAgeHours: 2,
      modelAgeDays: 2,
      bridgeCoverage: 0.9,
      bridgeRepresentative: true,
      confirmedReviews: 1,
      minConfirmedReviewsPerRule: 0,
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.ruleApplication.ready).toBe(false);
    expect(readiness.ruleApplication.blockers[0]?.name).toBe(
      "reviewRowsPerRule",
    );
  });

  test("coverage alone does not satisfy the bridge gate", () => {
    const readiness = assessQueueReadiness({
      corpusAgeHours: 2,
      modelAgeDays: 2,
      bridgeCoverage: 1,
      bridgeRepresentative: null,
      confirmedReviews: 10,
      minConfirmedReviewsPerRule: 6,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((blocker) => blocker.name)).toEqual([
      "bridgeRepresentativeness",
    ]);
  });

  test("accepts a stricter policy", () => {
    const readiness = assessQueueReadiness(
      {
        corpusAgeHours: 5,
        modelAgeDays: 3,
        bridgeCoverage: 0.7,
        bridgeRepresentative: true,
        confirmedReviews: 5,
        minConfirmedReviewsPerRule: 5,
      },
      {
        maxCorpusAgeHours: 6,
        maxModelAgeDays: 2,
        minConfirmedReviews: 10,
        minConfirmedReviewsPerRule: 10,
      },
    );
    expect(readiness.blockers.map((blocker) => blocker.name)).toEqual([
      "modelFreshness",
      "reviewRows",
    ]);
    expect(readiness.ruleApplication.blockers[0]?.name).toBe(
      "reviewRowsPerRule",
    );
  });
});
