import { describe, expect, test } from "bun:test";

import {
  DEFAULT_QUEUE_READINESS_POLICY,
  assessQueueReadiness,
  queueBatchBody,
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
        rules: [
          { rule: "period_correlation", confirmedReviews: 6 },
          { rule: "batch_replay", confirmedReviews: 7 },
        ],
      }),
    ).toEqual({
      ready: true,
      blockers: [],
      ruleApplication: {
        ready: true,
        applied: ["period_correlation", "batch_replay"],
        notApplied: [],
        blockers: [],
      },
    });
  });

  test("names every blocker and every rule that did not apply", () => {
    const readiness = assessQueueReadiness({
      corpusAgeHours: 24,
      modelAgeDays: 9,
      bridgeCoverage: 0.0394,
      bridgeRepresentative: null,
      confirmedReviews: 0,
      rules: [
        { rule: "period_correlation", confirmedReviews: 0 },
        { rule: "velocity_market", confirmedReviews: 3 },
      ],
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
    expect(readiness.ruleApplication).toEqual({
      ready: false,
      applied: [],
      notApplied: [
        {
          rule: "period_correlation",
          reason: "reviewedSampleSize",
          n: 0,
        },
        {
          rule: "velocity_market",
          reason: "reviewedSampleSize",
          n: 3,
        },
      ],
      blockers: [
        {
          name: "reviewRowsPerRule",
          current: "best 3 per rule",
          required: ">= 5 confirmed per rule",
        },
      ],
    });
  });

  test("treats the thresholds as inclusive", () => {
    const readiness = assessQueueReadiness({
      corpusAgeHours: DEFAULT_QUEUE_READINESS_POLICY.maxCorpusAgeHours,
      modelAgeDays: DEFAULT_QUEUE_READINESS_POLICY.maxModelAgeDays,
      bridgeCoverage: 0.01,
      bridgeRepresentative: true,
      confirmedReviews: DEFAULT_QUEUE_READINESS_POLICY.minConfirmedReviews,
      rules: [
        {
          rule: "period_correlation",
          confirmedReviews:
            DEFAULT_QUEUE_READINESS_POLICY.minConfirmedReviewsPerRule,
        },
      ],
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.ruleApplication.ready).toBe(true);
    expect(readiness.ruleApplication.applied).toEqual(["period_correlation"]);
  });

  test("execution readiness and per-rule application are separate", () => {
    const readiness = assessQueueReadiness({
      corpusAgeHours: 2,
      modelAgeDays: 2,
      bridgeCoverage: 0.9,
      bridgeRepresentative: true,
      confirmedReviews: 1,
      rules: [{ rule: "period_correlation", confirmedReviews: 4 }],
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.ruleApplication.ready).toBe(false);
    expect(readiness.ruleApplication.notApplied).toEqual([
      { rule: "period_correlation", reason: "reviewedSampleSize", n: 4 },
    ]);
  });

  test("a divergent study closes the gate even at full coverage", () => {
    const readiness = assessQueueReadiness({
      corpusAgeHours: 2,
      modelAgeDays: 2,
      bridgeCoverage: 1,
      bridgeRepresentative: false,
      confirmedReviews: 10,
      rules: [{ rule: "period_correlation", confirmedReviews: 6 }],
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toContainEqual({
      name: "bridgeRepresentativeness",
      current: "divergent",
      required: "covered vs uncovered within one Wilson interval",
    });
  });

  test("coverage alone does not satisfy the bridge gate", () => {
    const readiness = assessQueueReadiness({
      corpusAgeHours: 2,
      modelAgeDays: 2,
      bridgeCoverage: 1,
      bridgeRepresentative: null,
      confirmedReviews: 10,
      rules: [{ rule: "period_correlation", confirmedReviews: 6 }],
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((blocker) => blocker.name)).toEqual([
      "bridgeRepresentativeness",
    ]);
  });

  test("the batch stub refuses closed gates and carries applied/notApplied", () => {
    const closed = assessQueueReadiness({
      corpusAgeHours: 24,
      modelAgeDays: 9,
      bridgeCoverage: 0.0394,
      bridgeRepresentative: null,
      confirmedReviews: 0,
      rules: [],
    });
    expect(() => queueBatchBody(closed, () => ({ rows: [] }))).toThrow(
      /gate is closed/,
    );
    const open = assessQueueReadiness({
      corpusAgeHours: 2,
      modelAgeDays: 2,
      bridgeCoverage: 0.6,
      bridgeRepresentative: true,
      confirmedReviews: 6,
      rules: [
        { rule: "period_correlation", confirmedReviews: 6 },
        { rule: "velocity_market", confirmedReviews: 3 },
      ],
    });
    expect(queueBatchBody(open, () => ({ rows: ["U001"] }))).toEqual({
      rows: ["U001"],
      ruleApplication: {
        ready: true,
        applied: ["period_correlation"],
        notApplied: [
          { rule: "velocity_market", reason: "reviewedSampleSize", n: 3 },
        ],
        blockers: [],
        state: "partial",
      },
    });
    const complete = assessQueueReadiness({
      corpusAgeHours: 2,
      modelAgeDays: 2,
      bridgeCoverage: 0.6,
      bridgeRepresentative: true,
      confirmedReviews: 6,
      rules: [{ rule: "period_correlation", confirmedReviews: 6 }],
    });
    expect(queueBatchBody(complete, () => ({})).ruleApplication.state).toBe(
      "measured",
    );
    const none = assessQueueReadiness({
      corpusAgeHours: 2,
      modelAgeDays: 2,
      bridgeCoverage: 0.6,
      bridgeRepresentative: true,
      confirmedReviews: 1,
      rules: [{ rule: "period_correlation", confirmedReviews: 1 }],
    });
    expect(queueBatchBody(none, () => ({})).ruleApplication.state).toBe(
      "not_applied",
    );
  });

  test("a missing corpus or model reports 'missing', not an infinity string", () => {
    const readiness = assessQueueReadiness({
      corpusAgeHours: Number.POSITIVE_INFINITY,
      modelAgeDays: Number.POSITIVE_INFINITY,
      bridgeCoverage: null,
      bridgeRepresentative: null,
      confirmedReviews: 0,
      rules: [],
    });
    expect(readiness.blockers[0]).toMatchObject({
      name: "corpusFreshness",
      current: "missing",
    });
    expect(readiness.blockers[1]).toMatchObject({
      name: "modelFreshness",
      current: "missing",
    });
  });

  test("accepts a stricter policy", () => {
    const readiness = assessQueueReadiness(
      {
        corpusAgeHours: 5,
        modelAgeDays: 3,
        bridgeCoverage: 0.7,
        bridgeRepresentative: true,
        confirmedReviews: 5,
        rules: [{ rule: "period_correlation", confirmedReviews: 5 }],
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
    expect(readiness.ruleApplication.applied).toEqual([]);
    expect(readiness.ruleApplication.notApplied[0]).toEqual({
      rule: "period_correlation",
      reason: "reviewedSampleSize",
      n: 5,
    });
  });
});
