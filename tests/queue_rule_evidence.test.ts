import { describe, expect, test } from "bun:test";

import {
  buildRuleEvidenceByCustomerRef,
  type QueueRuleReview,
  type QueueRuleRun,
} from "../lib/queue_rule_evidence.ts";

function run(
  runId: string,
  flags: ReadonlyArray<{
    seq: number;
    rule?: string;
    customerRef?: string | null;
  }>,
): QueueRuleRun {
  return {
    runId,
    plan: {
      flags: flags.map((flag) => ({
        seq: flag.seq,
        rule: flag.rule ?? "period_correlation",
        customerRef:
          flag.customerRef === undefined ? "customer:z" : flag.customerRef,
      })),
    },
  };
}

function review(
  runId: string,
  seq: number,
  verdict: QueueRuleReview["verdict"],
): QueueRuleReview {
  return { runId, seq, verdict };
}

const APPLIED = new Set(["period_correlation"]);

describe("queue rule evidence", () => {
  test("separates an unreviewed hit from a confirmed hit", () => {
    const evidence = buildRuleEvidenceByCustomerRef(
      [
        run("run-1", [
          { seq: 0, customerRef: "customer:a" },
          { seq: 1, customerRef: "customer:z" },
        ]),
      ],
      [review("run-1", 0, "confirmed"), review("run-1", 1, "false_positive")],
      APPLIED,
    );
    expect(evidence.get("customer:a")).toEqual({
      hasRuleHit: true,
      hasConfirmedRuleHit: true,
      ruleHits: ["period_correlation"],
      confirmedRuleHits: ["period_correlation"],
    });
    expect(evidence.get("customer:z")).toEqual({
      hasRuleHit: true,
      hasConfirmedRuleHit: false,
      ruleHits: ["period_correlation"],
      confirmedRuleHits: [],
    });
  });

  test("a double review of one flag is one confirmed flag", () => {
    const evidence = buildRuleEvidenceByCustomerRef(
      [run("run-1", [{ seq: 0, customerRef: "customer:a" }])],
      [review("run-1", 0, "confirmed"), review("run-1", 0, "confirmed")],
      APPLIED,
    );
    expect(evidence.get("customer:a")).toMatchObject({
      hasRuleHit: true,
      hasConfirmedRuleHit: true,
    });
  });

  test("the same seq in two runs is two flags", () => {
    const evidence = buildRuleEvidenceByCustomerRef(
      [
        run("run-a", [{ seq: 0, customerRef: "customer:a" }]),
        run("run-b", [{ seq: 0, customerRef: "customer:z" }]),
      ],
      [review("run-a", 0, "confirmed")],
      APPLIED,
    );
    expect(evidence.get("customer:a")?.hasConfirmedRuleHit).toBe(true);
    expect(evidence.get("customer:z")?.hasConfirmedRuleHit).toBe(false);
  });

  test("only rules the gate applied enter the index", () => {
    const evidence = buildRuleEvidenceByCustomerRef(
      [
        run("run-1", [
          { seq: 0, rule: "period_correlation", customerRef: "customer:a" },
          { seq: 1, rule: "batch_replay", customerRef: "customer:a" },
        ]),
      ],
      [review("run-1", 0, "confirmed"), review("run-1", 1, "confirmed")],
      APPLIED,
    );
    expect(evidence.get("customer:a")?.ruleHits).toEqual([
      "period_correlation",
    ]);
    expect(evidence.get("customer:a")?.confirmedRuleHits).toEqual([
      "period_correlation",
    ]);
  });

  test("no applied rules means no evidence, even with confirmed reviews", () => {
    const evidence = buildRuleEvidenceByCustomerRef(
      [run("run-1", [{ seq: 0, customerRef: "customer:a" }])],
      [review("run-1", 0, "confirmed")],
      new Set(),
    );
    expect(evidence.size).toBe(0);
  });

  test("a null customerRef never joins", () => {
    const evidence = buildRuleEvidenceByCustomerRef(
      [run("run-1", [{ seq: 0, customerRef: null }])],
      [review("run-1", 0, "confirmed")],
      APPLIED,
    );
    expect(evidence.size).toBe(0);
  });
});
