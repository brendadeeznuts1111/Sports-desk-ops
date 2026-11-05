import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SAMPLING_BUDGET,
  buildFlagRateHistory,
  buildFlagsMetricMetadata,
  openReviewDb,
  planReviews,
  readFlagReviews,
  readReviewRun,
  readReviewRuns,
  recordFlagReview,
  reviewProgress,
  reviewsCsv,
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
    customerRef: null,
    agentRef: null,
    notes: null,
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

  test("persists every flag, not only the review sample", () => {
    const plan = planFor(
      anomalies({ period_correlation: 25, batch_replay: 5 }),
      {
        budget: {
          ...DEFAULT_SAMPLING_BUDGET,
          analystMinutesPerDay: 1,
        },
      },
    );
    expect(plan.flags).toHaveLength(30);
    expect(plan.samples.length).toBeLessThan(30);
    expect(plan.flags?.[0]).toMatchObject({
      seq: 0,
      rule: "period_correlation",
      customerRef: null,
      agentRef: null,
    });
  });

  test("double review is global, not one per rule", () => {
    const plan = planFor(
      anomalies({ period_correlation: 25, batch_replay: 25 }),
      {
        budget: {
          ...DEFAULT_SAMPLING_BUDGET,
          analystMinutesPerDay: 120,
        },
      },
    );
    expect(plan.samples).toHaveLength(50);
    expect(plan.samples.filter((sample) => sample.doubleReview)).toHaveLength(
      3,
    );
  });

  test("carries hashed actor refs from the anomaly evidence", () => {
    const rows = [
      {
        ...anomaly("period_correlation", 0),
        evidence: {
          customerRef: "customer:abc",
          agentRef: "agent:def",
        },
      },
    ];
    const plan = planFor(rows);
    expect(plan.samples[0]).toMatchObject({
      customerRef: "customer:abc",
      agentRef: "agent:def",
    });
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
    expect(readReviewRun(db, plan.runId)?.plan.flags).toHaveLength(12);

    recordFlagReview(db, {
      runId: plan.runId,
      seq: 0,
      rule: "period_correlation",
      wagerNumbers: ["900000000"],
      verdict: "false_positive",
      reviewer: "analyst-a",
      reviewedAt: "2026-11-05T12:30:00.000Z",
      customerRef: null,
      agentRef: null,
    });
    recordFlagReview(db, {
      runId: plan.runId,
      seq: 0,
      rule: "period_correlation",
      wagerNumbers: ["900000000"],
      verdict: "confirmed",
      reviewer: "analyst-a",
      reviewedAt: "2026-11-05T12:31:00.000Z",
      notes: "market moved after placement",
      customerRef: "customer:abc",
      agentRef: "agent:def",
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
    expect(
      stored.find((review) => review.reviewer === "analyst-a")?.notes,
    ).toBe("market moved after placement");
    expect(
      stored.find((review) => review.reviewer === "analyst-a")?.customerRef,
    ).toBe("customer:abc");
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

  test("builds a P50 flag-rate reference after three persisted runs", () => {
    const db = openReviewDb(join(ROOT, "history.sqlite"));
    const counts = [10, 20, 30];
    for (const [index, count] of counts.entries()) {
      const plan = planReviews(anomalies({ period_correlation: count }), {
        runId: `history-${index}`,
        wagerCount: 1000,
        budget: DEFAULT_SAMPLING_BUDGET,
        captureKey: `capture-${index}`,
      });
      recordReviewPlan(db, plan);
    }
    const runs = readReviewRuns(db);
    const history = buildFlagRateHistory(runs);
    expect(history?.runs).toBe(3);
    expect(history?.p50["period_correlation"]).toBeCloseTo(0.02, 10);
    const metadata = buildFlagsMetricMetadata(runs[2]!.plan, [], {
      flagRateHistory: history,
    });
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "flagRateReference",
      ),
    ).toMatchObject({
      kind: "baseline",
      state: "measured",
      value: { runs: 3, p50: { period_correlation: 0.02 } },
    });
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

describe("review progress and export", () => {
  const plan = planFor(anomalies({ period_correlation: 12 }));
  const reviews: StoredFlagReview[] = [
    {
      runId: plan.runId,
      seq: 0,
      rule: "period_correlation",
      wagerNumbers: ["1", "2"],
      verdict: "confirmed",
      reviewer: "a",
      reviewedAt: "2026-11-05T12:30:00.000Z",
      customerRef: null,
      agentRef: null,
      notes: "look, a comma",
    },
    {
      runId: plan.runId,
      seq: 0,
      rule: "period_correlation",
      wagerNumbers: ["1", "2"],
      verdict: "confirmed",
      reviewer: "b",
      reviewedAt: "2026-11-05T12:31:00.000Z",
      customerRef: null,
      agentRef: null,
      notes: null,
    },
    {
      runId: plan.runId,
      seq: 1,
      rule: "period_correlation",
      wagerNumbers: ["3"],
      verdict: "false_positive",
      reviewer: "a",
      reviewedAt: "2026-11-05T12:32:00.000Z",
      customerRef: null,
      agentRef: null,
      notes: 'quoted "note"',
    },
  ];

  test("reports reviewed, remaining and double coverage", () => {
    const progress = reviewProgress(plan, reviews);
    expect(progress).toMatchObject({
      runId: plan.runId,
      sampled: 12,
      reviewed: 2,
      remaining: 10,
      doubleReviewPlanned: 1,
      doubleReviewCovered: 1,
      verdicts: { confirmed: 2, false_positive: 1, needs_more_info: 0 },
    });
    expect(progress.rules[0]).toMatchObject({
      rule: "period_correlation",
      selected: 12,
      reviewed: 2,
      remaining: 10,
    });
  });

  test("exports CSV with escaped notes and wager numbers", () => {
    const csv = reviewsCsv(reviews);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "run_id,seq,rule,verdict,reviewer,reviewed_at,notes,customer_ref,agent_ref,wager_numbers",
    );
    expect(lines).toHaveLength(4);
    expect(csv).toContain('"look, a comma"');
    expect(csv).toContain('"quoted ""note"""');
    expect(csv).toContain("1|2");
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
      kind: "metric",
      evaluates: "rule",
      notApplicableTo: "individual-flag",
      derivedFrom: "sampled",
    });
    const values = rulePrecision?.value as Record<string, unknown>;
    expect(values["period_correlation"]).toMatchObject({
      state: "not_measured",
      blockedBy: "noReviews",
    });
    expect(
      metadata.definitions.find((definition) => definition.name === "flagRate"),
    ).toMatchObject({ baselineRef: "flagRateReference" });
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "flagRateReference",
      ),
    ).toMatchObject({
      kind: "baseline",
      state: "not_measured",
      blockedBy: { name: "captureHistory", layer: "persistence" },
    });
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "ruleHitWeight",
      ),
    ).toMatchObject({
      kind: "parameter",
      state: "not_measured",
      blockedBy: "scoreSubIntegerPrecision",
      value: {
        perConfirmedHit: 0.02,
        cap: 0.1,
        appliedTo: "normalized-priority",
      },
    });
    expect(
      (
        metadata.definitions.find(
          (definition) => definition.name === "ruleHitWeight",
        )?.value as { confirmedByRule: Record<string, number> }
      ).confirmedByRule["period_correlation"],
    ).toBe(0);
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "queuePriorityOrder",
      ),
    ).toMatchObject({
      kind: "parameter",
      state: "not_measured",
      blockedBy: [
        { name: "durableCustomerMaster", layer: "escalation" },
        { name: "reviewRowsPerRule", layer: "application" },
      ],
      value: [
        "desk-flag",
        "findings",
        "odds-drift",
        "model-score",
        "has-rule-hit",
        "has-confirmed-rule-hit",
        "bets",
      ],
    });
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "scoreNormalization",
      ),
    ).toMatchObject({
      kind: "parameter",
      state: "not_measured",
      blockedBy: { name: "corpusFreshness", layer: "execution" },
    });
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "bridgeCoverage",
      ),
    ).toMatchObject({
      kind: "metric",
      state: "not_measured",
      blockedBy: { name: "durableCustomerMaster", layer: "escalation" },
      value: 0.0394,
    });
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "ruleHitTieBreak",
      ),
    ).toMatchObject({
      kind: "parameter",
      state: "not_measured",
      value: {
        field: "hasRuleHit",
        evidenceField: "hasConfirmedRuleHit",
        order: "desc",
        position: "after-model-score",
        scoreBonus: false,
        minConfirmedReviewsPerRule: 5,
      },
    });
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "bridgeRepresentativeness",
      ),
    ).toMatchObject({
      kind: "quality",
      state: "not_measured",
      blockedBy: "bridgeRepresentativenessStudy",
      value: { covered: 102, uncovered: 2484, measured: false },
    });
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "ruleApplication",
      ),
    ).toMatchObject({
      kind: "parameter",
      state: "not_measured",
      blockedBy: { name: "reviewRowsPerRule", layer: "application" },
      value: { applied: [], notApplied: [] },
    });
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "allFlagRows",
      ),
    ).toMatchObject({
      kind: "caveat",
      state: "measured",
      value: "persisted-in-plan",
    });
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "modelFreshnessThreshold",
      ),
    ).toMatchObject({
      kind: "parameter",
      value: 7,
      unit: "day",
      derivedFrom: "assumed_default",
    });
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "bridgeRepresentativenessThreshold",
      ),
    ).toMatchObject({
      kind: "parameter",
      value: "within one Wilson interval",
      derivedFrom: "assumed_default",
    });
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "queueEscalation",
      ),
    ).toMatchObject({
      kind: "caveat",
      state: "not_measured",
      blockedBy: [
        { name: "durableCustomerMaster", layer: "escalation" },
        { name: "corpusFreshness", layer: "execution" },
        { name: "modelFreshness", layer: "execution" },
        { name: "bridgeRepresentativeness", layer: "execution" },
        { name: "reviewRows", layer: "execution" },
        { name: "reviewRowsPerRule", layer: "application" },
      ],
    });
    expect(
      metadata.definitions.find((definition) => definition.name === "response"),
    ).toMatchObject({ kind: "caveat", value: "measurement-only" });
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
      { precision: number; n: number; wilson: { low: number } }
    >;
    expect(values["period_correlation"]?.precision).toBeCloseTo(0.7, 6);
    expect(values["period_correlation"]?.n).toBe(10);
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
      n: 5,
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
      kind: "quality",
      method: "cohen-kappa",
      n: 2,
    });
    expect(typeof agreement?.value).toBe("number");
  });

  test("all-agree double reviews report kappa undefined, not no double review", () => {
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
        verdict: "confirmed",
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
      state: "not_measured",
      blockedBy: "kappaUndefined",
      n: 2,
    });
  });

  test("partial rows must name what is missing", () => {
    const metadata = buildFlagsMetricMetadata(plan, []);
    const bad = {
      ...metadata,
      definitions: metadata.definitions.map((definition) =>
        definition.name === "ruleApplication"
          ? {
              name: "ruleApplication",
              kind: "parameter",
              state: "partial",
              value: {},
              description: "partial without a blocker",
            }
          : definition,
      ),
    };
    expect(() => validateFlagsMetricMetadata(bad)).toThrow(
      /partial but has no blockedBy/,
    );
    const good = {
      ...metadata,
      definitions: metadata.definitions.map((definition) =>
        definition.name === "ruleApplication"
          ? {
              ...definition,
              state: "partial",
              blockedBy: {
                name: "reviewRowsPerRule",
                layer: "application" as const,
              },
            }
          : definition,
      ),
    };
    expect(() => validateFlagsMetricMetadata(good)).not.toThrow();
  });

  test("refuses an unknown derivedFrom", () => {
    const metadata = buildFlagsMetricMetadata(plan, []);
    const bad = {
      ...metadata,
      definitions: metadata.definitions.map((definition) =>
        definition.name === "rulePrecision"
          ? { ...definition, derivedFrom: "guessed" as never }
          : definition,
      ),
    };
    expect(() => validateFlagsMetricMetadata(bad)).toThrow(/derivedFrom/);
  });

  test("refuses a stale schemaVersion", () => {
    const metadata = buildFlagsMetricMetadata(plan, []);
    expect(() =>
      validateFlagsMetricMetadata({
        ...metadata,
        schemaVersion: 2 as never,
      }),
    ).toThrow(/schemaVersion/);
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
