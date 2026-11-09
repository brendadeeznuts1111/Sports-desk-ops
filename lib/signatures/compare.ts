/**
 * @file lib/signatures/compare.ts
 * @description Deterministic comparator (Stage 4.3) for ranking `bySignature[K]` cohort buckets.
 *
 * Order of keys (descending unless noted):
 * 1. `spec.rankScore(sig, totals)`
 * 2. `spec.tieBreak?.(sig, totals)` (element-wise descending)
 * 3. `totals.totalRiskUsd`
 * 4. `customerId` (ascending, ASCII lexicographic for determinism)
 */

import type { SignatureSpec } from "./spec.ts";
import type { CustomerTotals, Signature } from "./types.ts";

export interface RankedSignatureEntry<
  K extends Signature["kind"] = Signature["kind"],
> {
  readonly customerId: string;
  readonly sig: Extract<Signature, { kind: K }>;
  readonly totals: CustomerTotals;
}

function compareDesc(a: number, b: number): number {
  const na = Number.isFinite(a) ? a : Number.NEGATIVE_INFINITY;
  const nb = Number.isFinite(b) ? b : Number.NEGATIVE_INFINITY;
  if (nb !== na) return nb > na ? 1 : -1;
  return 0;
}

export function compareSignatures<K extends Signature["kind"]>(
  spec: SignatureSpec<K, unknown>,
  a: RankedSignatureEntry<K>,
  b: RankedSignatureEntry<K>,
): number {
  const primary = compareDesc(
    spec.rankScore(a.sig, a.totals),
    spec.rankScore(b.sig, b.totals),
  );
  if (primary !== 0) return primary;

  if (typeof spec.tieBreak === "function") {
    const tieA = spec.tieBreak(a.sig, a.totals);
    const tieB = spec.tieBreak(b.sig, b.totals);
    const len = Math.min(tieA.length, tieB.length);
    for (let i = 0; i < len; i++) {
      const diff = compareDesc(tieA[i]!, tieB[i]!);
      if (diff !== 0) return diff;
    }
  }

  const riskDiff = compareDesc(a.totals.totalRiskUsd, b.totals.totalRiskUsd);
  if (riskDiff !== 0) return riskDiff;

  return a.customerId < b.customerId ? -1 : a.customerId > b.customerId ? 1 : 0;
}
