/**
 * @file src/risk/slice_diff_view.ts
 * @description Pre/post-trade DiffView evaluator over `{ policy, block_enforced }` pairs.
 *
 * Alert contract: raises `BLOCK_ENFORCED_FLIPPED_FALSE` whenever `block_enforced`
 * flips `true -> false` on a `BLOCKED` slice.
 */

import type { SlicePolicy } from "./slice_metrics.ts";

export interface SlicePolicyStateRow {
  readonly slice_id: string;
  readonly policy: SlicePolicy;
  readonly block_enforced: boolean;
}

export interface SlicePolicyDiffPair {
  readonly policy: SlicePolicy;
  readonly block_enforced: boolean;
}

export type SliceDiffAlertCode = "BLOCK_ENFORCED_FLIPPED_FALSE";

export interface SlicePolicyDiffEntry {
  readonly slice_id: string;
  readonly pre: SlicePolicyDiffPair | null;
  readonly post: SlicePolicyDiffPair | null;
  readonly changed: boolean;
  readonly policy_changed: boolean;
  readonly block_enforced_changed: boolean;
  readonly alert: SliceDiffAlertCode | null;
  readonly alert_message: string | null;
}

export interface SlicePolicyDiffReport {
  readonly entries: readonly SlicePolicyDiffEntry[];
  readonly alerts: readonly SlicePolicyDiffEntry[];
  readonly has_critical_alert: boolean;
}

/**
 * Compares pre-trade vs post-trade `{ policy, block_enforced }` pairs by `slice_id`
 * and flags critical regressions when `block_enforced` flips `true -> false` on a
 * `BLOCKED` slice.
 */
export function diffSlicePolicyPairs(
  preRows: readonly SlicePolicyStateRow[],
  postRows: readonly SlicePolicyStateRow[],
): SlicePolicyDiffReport {
  const preBySlice: Record<string, SlicePolicyDiffPair> = {};
  const orderedIds: string[] = [];
  const seenIds: Record<string, true> = {};

  for (let i = 0; i < preRows.length; i++) {
    const r = preRows[i]!;
    preBySlice[r.slice_id] = {
      policy: r.policy,
      block_enforced: r.block_enforced,
    };
    if (!Object.hasOwn(seenIds, r.slice_id)) {
      seenIds[r.slice_id] = true;
      orderedIds.push(r.slice_id);
    }
  }

  const postBySlice: Record<string, SlicePolicyDiffPair> = {};
  for (let i = 0; i < postRows.length; i++) {
    const r = postRows[i]!;
    postBySlice[r.slice_id] = {
      policy: r.policy,
      block_enforced: r.block_enforced,
    };
    if (!Object.hasOwn(seenIds, r.slice_id)) {
      seenIds[r.slice_id] = true;
      orderedIds.push(r.slice_id);
    }
  }

  const entries: SlicePolicyDiffEntry[] = [];
  const alerts: SlicePolicyDiffEntry[] = [];

  for (let i = 0; i < orderedIds.length; i++) {
    const slice_id = orderedIds[i]!;
    const pre = Object.hasOwn(preBySlice, slice_id)
      ? preBySlice[slice_id]!
      : null;
    const post = Object.hasOwn(postBySlice, slice_id)
      ? postBySlice[slice_id]!
      : null;

    const policy_changed =
      pre === null || post === null ? pre !== post : pre.policy !== post.policy;
    const block_enforced_changed =
      pre === null || post === null
        ? pre !== post
        : pre.block_enforced !== post.block_enforced;
    const changed = policy_changed || block_enforced_changed;

    const flippedTrueToFalseOnBlocked =
      pre !== null &&
      post !== null &&
      post.policy === "BLOCKED" &&
      pre.block_enforced === true &&
      post.block_enforced === false;

    const alert: SliceDiffAlertCode | null = flippedTrueToFalseOnBlocked
      ? "BLOCK_ENFORCED_FLIPPED_FALSE"
      : null;
    const alert_message: string | null = flippedTrueToFalseOnBlocked
      ? `CRITICAL: Router block_enforced flipped true -> false on BLOCKED slice '${slice_id}'`
      : null;

    const entry: SlicePolicyDiffEntry = {
      slice_id,
      pre,
      post,
      changed,
      policy_changed,
      block_enforced_changed,
      alert,
      alert_message,
    };
    entries.push(entry);
    if (alert !== null) {
      alerts.push(entry);
    }
  }

  return {
    entries,
    alerts,
    has_critical_alert: alerts.length > 0,
  };
}
