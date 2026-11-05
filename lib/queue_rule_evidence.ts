/**
 * Join persisted flag plans to the queue's rule tie-break. Evidence is keyed by the hashed
 * customerRef, never a raw login, and `(runId, seq)` identifies a flag: the same seq in two runs is
 * two flags, while a double review of one flag is one.
 *
 * Only rules the readiness gate applied may contribute. A rule below the confirmed-review minimum
 * is absent from the index, so the queue cannot accidentally promote on an unmeasured rule.
 */
import type { FraudQueueRuleEvidence } from "./fraud_queue.ts";

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
  appliedRules: ReadonlySet<string>,
): ReadonlyMap<string, FraudQueueRuleEvidence> {
  const confirmedSeqs = new Map<string, Set<number>>();
  for (const review of reviews) {
    if (review.verdict !== "confirmed") continue;
    const set = confirmedSeqs.get(review.runId) ?? new Set<number>();
    set.add(review.seq);
    confirmedSeqs.set(review.runId, set);
  }

  const byRef = new Map<string, { hit: Set<string>; confirmed: Set<string> }>();
  for (const run of runs) {
    const confirmed = confirmedSeqs.get(run.runId) ?? new Set<number>();
    for (const flag of run.plan.flags ?? []) {
      if (!appliedRules.has(flag.rule) || flag.customerRef === null) continue;
      const entry = byRef.get(flag.customerRef) ?? {
        hit: new Set<string>(),
        confirmed: new Set<string>(),
      };
      entry.hit.add(flag.rule);
      if (confirmed.has(flag.seq)) entry.confirmed.add(flag.rule);
      byRef.set(flag.customerRef, entry);
    }
  }

  const evidence = new Map<string, FraudQueueRuleEvidence>();
  for (const [ref, entry] of byRef) {
    evidence.set(ref, {
      hasRuleHit: entry.hit.size > 0,
      hasConfirmedRuleHit: entry.confirmed.size > 0,
      ruleHits: [...entry.hit].sort(),
      confirmedRuleHits: [...entry.confirmed].sort(),
    });
  }
  return evidence;
}
