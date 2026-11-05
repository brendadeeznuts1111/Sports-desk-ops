/**
 * Join persisted flag plans to the queue's rule tie-break. Evidence is keyed by the hashed
 * customerRef, never a raw login, and `(runId, seq)` identifies a flag: the same seq in two runs is
 * two flags, while a double review of one flag is one.
 *
 * Only rules the readiness gate applied may contribute. A rule below the confirmed-review minimum
 * is absent from the index, so the queue cannot accidentally promote on an unmeasured rule. The
 * applied-rule map carries the confirmed-review count; that `n` travels into the row so a hit at
 * n=5 is distinguishable from one at n=50.
 */
import type {
  FraudQueueRuleEvidence,
  FraudQueueRuleHit,
} from "./fraud_queue.ts";

export interface QueueRuleFlag {
  readonly seq: number;
  readonly rule: string;
  readonly customerRef: string | null;
}

export interface QueueRuleRun {
  readonly runId: string;
  readonly plan: {
    readonly flags?: readonly QueueRuleFlag[] | undefined;
  };
}

export interface QueueRuleReview {
  readonly runId: string;
  readonly seq: number;
  readonly verdict: string;
}

export function buildRuleEvidenceByCustomerRef(
  runs: readonly QueueRuleRun[],
  reviews: readonly QueueRuleReview[],
  appliedRules: ReadonlyMap<string, number>,
): ReadonlyMap<string, FraudQueueRuleEvidence> {
  const confirmedSeqs = new Map<string, Set<number>>();
  for (const review of reviews) {
    if (review.verdict !== "confirmed") continue;
    const set = confirmedSeqs.get(review.runId) ?? new Set<number>();
    set.add(review.seq);
    confirmedSeqs.set(review.runId, set);
  }

  const byRef = new Map<
    string,
    { hit: Map<string, number>; confirmed: Map<string, number> }
  >();
  for (const run of runs) {
    const confirmed = confirmedSeqs.get(run.runId) ?? new Set<number>();
    for (const flag of run.plan.flags ?? []) {
      const reviewCount = appliedRules.get(flag.rule);
      if (reviewCount === undefined || flag.customerRef === null) continue;
      const entry = byRef.get(flag.customerRef) ?? {
        hit: new Map<string, number>(),
        confirmed: new Map<string, number>(),
      };
      entry.hit.set(flag.rule, reviewCount);
      if (confirmed.has(flag.seq)) {
        entry.confirmed.set(flag.rule, reviewCount);
      }
      byRef.set(flag.customerRef, entry);
    }
  }

  const hits = (values: ReadonlyMap<string, number>): FraudQueueRuleHit[] =>
    [...values]
      .map(([rule, n]) => ({ rule, n }))
      .sort((left, right) =>
        left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0,
      );

  const evidence = new Map<string, FraudQueueRuleEvidence>();
  for (const [ref, entry] of byRef) {
    evidence.set(ref, {
      hasRuleHit: entry.hit.size > 0,
      hasConfirmedRuleHit: entry.confirmed.size > 0,
      ruleHits: hits(entry.hit),
      confirmedRuleHits: hits(entry.confirmed),
    });
  }
  return evidence;
}
