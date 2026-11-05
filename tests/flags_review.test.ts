import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SAMPLING_BUDGET,
  buildFlagsMetricMetadata,
  openReviewDb,
  planReviews,
  readFlagReviews,
  readReviewRun,
  recordFlagReview,
  recordReviewPlan,
  validateFlagsMetricMetadata,
  wilsonInterval,
  type ReviewPlan,
  type StoredFlagReview,
} from "../cli/review.ts";
import type { Anomaly, RuleName, RuleTicket } from "../cli/rules.ts";

const ROOT = mkdtempSync(join(tmpdir(), "flags-review-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function ticket(seq: number): RuleTicket {
  return {
    wagerNumber: String(900000000 + seq),
    insertedAt: null,
    stake: 100,
    toWin: 90,
    legs: [],
  };
}

function anomaly(rule: RuleName, seq: number): Anomaly {
  return {
    rule,
    severity: "warning",
    tickets: [ticket(seq)],
    evidence: {},
  };
}

function anomalies(counts: Readonly<Record<string, number>>): Anomaly[] {
  const rows: Anomaly[] = [];
  for (const [rule, count] of Object.entries(counts)) {
    for (let index = 0; index < count; index += 1) {
      rows.push(anomaly(rule as RuleName, rows.length));
    }
  }
  return rows;
}

function planFor(
  rows: Anomaly[],
  overrides: {
    budget?: typeof DEFAULT_SAMPLING_BUDGET;
    wagerCount?: number;
  } = {},
): ReviewPlan {
  return planReviews(rows, {
    runId: "run-1",
    wagerCount: overrides.wagerCount ?? 10_000,
    budget: overrides.budget ?? DEFAULT_SAMPLING_BUDGET,
    captureKey: "capture-sha",
    now: new Date("2026-11-05T12:00:00.000Z"),
  });
}

function reviewsFor(
  plan: ReviewPlan,
  entries: ReadonlyArray<{
    seq: number;
    rule: string;
    verdict: "confirmed" | "false_positive" | "needs_more_info";
    reviewer?: string;
  }>,
): StoredFlagReview[] {
  return entries.map((entry) => ({
    runId: plan.runId,
    seq: entry.seq,
    rule: entry.rule,
    wagerNumbers: [String(entry.seq)],
    verdict: entry.verdict,
    reviewer: entry.reviewer ?? "analyst-a",
    reviewedAt: "2026-11-05T12:30:00.000Z",
  }));
}

describe("wilsonInterval", () => {
  test("matches the 2/20 cold-start interval", () => {
    const interval = wilsonInterval(2, 20);
    expect(interval?.low).toBeCloseTo(0.028, 2);
    expect(interval?.high).toBeCloseTo(0.301, 2);
    expect(interval?.low).toBeLessThan(interval?.high ?? 0);
  });

  test("is null with no samples", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});

describe("planReviews", () => {
  test("census low-volume rules and samples the rest within budget", () => {
    const rows = anomalies({ period_correlation: 25, batch_replay: 5 });
    const plan = planFor(rows);
    const low = plan.rules.find((rule) => rule.rule === "batch_replay");
    const high = plan.rules.find((rule) => rule.rule === "period_correlation");
    expect(low).toMatchObject({ fired: 5, selected: 5, mode: "census" });
    expect(high?.selected).toBeGreaterThan(0);
    expect(high?.selected).toBeLessThanOrEqual(25);
    expect(plan.estimatedMinutes).toBeLessThanOrEqual(plan.budgetMinutes);
    expect(plan.samples).toHaveLength(
      plan.rules.reduce((sum, rule) => sum + rule.selected, 0),
    );
  });

  test("is deterministic for the same capture and seed, independent of rule order", () => {
    const rows = anomalies({ period_correlation: 12, batch_replay: 12 });
    const first = planFor(rows);
    const second = planFor(rows);
    expect(second.samples.map((sample) => sample.seq)).toEqual(
      first.samples.map((sample) => sample.seq),
    );

    const reversed = [...rows].reverse();
    const third = planFor(reversed);
    // Reversed input changes seq, but the selection is still a valid stratified plan.
    expect(third.flagCount).toBe(first.flagCount);
    expect(third.rules.map((rule) => rule.selected)).toEqual(
      first.rules.map((rule) => rule.selected),
    );
  });

  test("marks every 20th sample for double review", () => {
    const plan = planFor(anomalies({ period_correlation: 45 }));
    const doubleReviews = plan.samples.filter((sample) => sample.doubleReview);
    expect(doubleReviews).toHaveLength(Math.ceil(plan.samples.length / 20));
  });

  test("a budget too small to census marks rules not_sampled", () => {
    const budget = {
      ...DEFAULT_SAMPLING_BUDGET,
      analystMinutesPerDay: 0.1,
    };
    const plan = planFor(
      anomalies({ period_correlation: 25, batch_replay: 5 }),
      {
        budget,
      },
    );
    expect(plan.estimatedMinutes).toBeLessThanOrEqual(plan.budgetMinutes);
    expect(plan.rules.every((rule) => rule.mode === "not_sampled")).toBe(true);
  });
});

describe("review ledger", () => {
  const dbPath = join(ROOT, "review.sqlite");

  test("stores a plan, reads it back, and upserts reviews by reviewer", () => {
    const db = openReviewDb(dbPath);
    const plan = planFor(anomalies({ period_correlation: 12 }));
    recordReviewPlan(db, plan, {
      capturePath: "data/live-wagers.json",
      captureSha256: "a".repeat(64),
    });
    expect(readReviewRun(db, plan.runId)?.flagCount).toBe(12);

    recordFlagReview(db, {
      runId: plan.runId,
      seq: 0,
      rule: "period_correlation",
      wagerNumbers: ["900000000"],
      verdict: "false_positive",
      reviewer: "analyst-a",
      reviewedAt: "2026-11-05T12:30:00.000Z",
    });
    recordFlagReview(db, {
      runId: plan.runId,
      seq: 0,
      rule: "period_correlation",
      wagerNumbers: ["900000000"],
      verdict: "confirmed",
      reviewer: "analyst-a",
      reviewedAt: "2026-11-05T12:31:00.000Z",
    });
    recordFlagReview(db, {
      runId: plan.runId,
      seq: 0,
      rule: "period_correlation",
      wagerNumbers: ["900000000"],
      verdict: "confirmed",
      reviewer: "analyst-b",
    });
    const stored = readFlagReviews(db, plan.runId);
    expect(stored).toHaveLength(2);
    expect(
      stored.find((review) => review.reviewer === "analyst-a")?.verdict,
    ).toBe("confirmed");
    db.close();
  });

  test("refuses to overwrite a run with a different plan", () => {
    const db = openReviewDb(join(ROOT, "integrity.sqlite"));
    const plan = planFor(anomalies({ period_correlation: 12 }));
    recordReviewPlan(db, plan);
    expect(() =>
      recordReviewPlan(db, { ...plan, flagCount: plan.flagCount + 1 }),
    ).toThrow(/already exists with a different plan/);
    db.close();
  });

  test("rejects an unknown verdict", () => {
    const db = openReviewDb(join(ROOT, "invalid.sqlite"));
    expect(() =>
      recordFlagReview(db, {
        runId: "run-1",
        seq: 0,
        rule: "period_correlation",
        wagerNumbers: ["1"],
        verdict: "maybe" as never,
        reviewer: "analyst-a",
      }),
    ).toThrow(/unknown verdict/);
    db.close();
  });
});

describe("flags metric metadata", () => {
  const rows = anomalies({ period_correlation: 25, batch_replay: 5 });
  const plan = planFor(rows);

  test("reports not_measured until a rule has enough reviews", () => {
    const metadata = buildFlagsMetricMetadata(plan, []);
    const rulePrecision = metadata.definitions.find(
      (definition) => definition.name === "rulePrecision",
    );
    expect(rulePrecision).toMatchObject({
      kind: "classification-metric",
      evaluates: "rule",
      doesNotEvaluate: "individual-flag",
    });
    const values = rulePrecision?.value as Record<string, unknown>;
    expect(values["period_correlation"]).toMatchObject({
      state: "not_measured",
      blockedBy: "noReviews",
    });
    const baseline = metadata.definitions.find(
      (definition) => definition.name === "reviewedSamplePositiveRate",
    );
    expect(baseline).toMatchObject({
      kind: "baseline",
      state: "not_measured",
      blockedBy: "noReviews",
    });
    expect(() => validateFlagsMetricMetadata(metadata)).not.toThrow();
  });

  test("reports precision and Wilson only at n >= 10", () => {
    const reviews = reviewsFor(
      plan,
      Array.from({ length: 10 }, (_, index) => ({
        seq: index,
        rule: "period_correlation",
        verdict:
          index < 7 ? ("confirmed" as const) : ("false_positive" as const),
        reviewer: index % 2 === 0 ? "analyst-a" : "analyst-b",
      })),
    );
    const metadata = buildFlagsMetricMetadata(plan, reviews);
    const rulePrecision = metadata.definitions.find(
      (definition) => definition.name === "rulePrecision",
    );
    const values = rulePrecision?.value as Record<
      string,
      { precision: number; sampleSize: number; wilson: { low: number } }
    >;
    expect(values["period_correlation"]?.precision).toBeCloseTo(0.7, 6);
    expect(values["period_correlation"]?.sampleSize).toBe(10);
    expect(values["period_correlation"]?.wilson.low).toBeGreaterThan(0.3);
    expect(() => validateFlagsMetricMetadata(metadata)).not.toThrow();
  });

  test("n < 10 stays not_measured with a reviewedSampleSize blocker", () => {
    const reviews = reviewsFor(
      plan,
      Array.from({ length: 5 }, (_, index) => ({
        seq: index,
        rule: "batch_replay",
        verdict: "confirmed" as const,
      })),
    );
    const metadata = buildFlagsMetricMetadata(plan, reviews);
    const rulePrecision = metadata.definitions.find(
      (definition) => definition.name === "rulePrecision",
    );
    const values = rulePrecision?.value as Record<string, unknown>;
    expect(values["batch_replay"]).toMatchObject({
      state: "not_measured",
      blockedBy: "reviewedSampleSize",
      sampleSize: 5,
    });
  });

  test("measures reviewer agreement from double reviews", () => {
    const reviews = reviewsFor(plan, [
      {
        seq: 0,
        rule: "period_correlation",
        verdict: "confirmed",
        reviewer: "a",
      },
      {
        seq: 0,
        rule: "period_correlation",
        verdict: "confirmed",
        reviewer: "b",
      },
      {
        seq: 1,
        rule: "period_correlation",
        verdict: "false_positive",
        reviewer: "a",
      },
      {
        seq: 1,
        rule: "period_correlation",
        verdict: "confirmed",
        reviewer: "b",
      },
    ]);
    const metadata = buildFlagsMetricMetadata(plan, reviews);
    const agreement = metadata.definitions.find(
      (definition) => definition.name === "reviewerAgreement",
    );
    expect(agreement).toMatchObject({
      kind: "measurement-quality",
      method: "cohen-kappa",
      overlapSamples: 2,
    });
    expect(typeof agreement?.value).toBe("number");
  });

  test("refuses a classification metric that claims per-flag evaluation", () => {
    const metadata = buildFlagsMetricMetadata(plan, []);
    const bad = {
      ...metadata,
      definitions: metadata.definitions.map((definition) =>
        definition.name === "rulePrecision"
          ? { ...definition, evaluates: "individual-flag" }
          : definition,
      ),
    };
    expect(() => validateFlagsMetricMetadata(bad)).toThrow(
      /must evaluate rules/,
    );
  });
});
