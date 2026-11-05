import { describe, expect, test } from "bun:test";

import {
  DEFAULT_QUEUE_READINESS_POLICY,
  assessQueueReadiness,
} from "../lib/queue_readiness.ts";

describe("queue readiness gate", () => {
  test("is ready only when every input clears its threshold", () => {
    expect(
      assessQueueReadiness({
        corpusAgeHours: 2,
        bridgeCoverage: 0.6,
        confirmedReviews: 10,
        topKGapMedian: 1,
      }),
    ).toEqual({ ready: true, blockers: [] });
  });

  test("names every blocker instead of a single vague refusal", () => {
    const readiness = assessQueueReadiness({
      corpusAgeHours: 24,
      bridgeCoverage: 0.0394,
      confirmedReviews: 0,
      topKGapMedian: null,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((blocker) => blocker.name)).toEqual([
      "corpusFreshness",
      "bridgeCoverage",
      "reviewRows",
      "weightCalibration",
    ]);
    expect(readiness.blockers[0]).toMatchObject({
      current: "24.0h",
      required: "<= 6h",
    });
    expect(readiness.blockers[1]?.current).toBe("3.9%");
    expect(readiness.blockers[2]?.required).toBe(">= 1 confirmed");
  });

  test("treats the thresholds as inclusive", () => {
    expect(
      assessQueueReadiness({
        corpusAgeHours: DEFAULT_QUEUE_READINESS_POLICY.maxCorpusAgeHours,
        bridgeCoverage: DEFAULT_QUEUE_READINESS_POLICY.minBridgeCoverage,
        confirmedReviews: DEFAULT_QUEUE_READINESS_POLICY.minConfirmedReviews,
        topKGapMedian: 0,
      }).ready,
    ).toBe(true);
  });

  test("accepts a stricter policy", () => {
    const readiness = assessQueueReadiness(
      {
        corpusAgeHours: 5,
        bridgeCoverage: 0.7,
        confirmedReviews: 5,
        topKGapMedian: 1,
      },
      {
        maxCorpusAgeHours: 6,
        minBridgeCoverage: 0.8,
        minConfirmedReviews: 10,
        requireTopKGap: true,
      },
    );
    expect(readiness.blockers.map((blocker) => blocker.name)).toEqual([
      "bridgeCoverage",
      "reviewRows",
    ]);
  });
});
