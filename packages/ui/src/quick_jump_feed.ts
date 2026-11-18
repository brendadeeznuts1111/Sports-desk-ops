/**
 * @file quick_jump_feed.ts
 * @description Feed freshness for the Desk Quick-Jump ribbon.
 *
 * The ribbon prints wager counts; without an age next to them a stale snapshot
 * reads as live. These helpers are pure so the honesty rule is testable: a
 * missing timestamp is `pending`, never `0s`.
 */

import { formatRelativeAge } from "./relative_time.ts";

export { formatRelativeAge } from "./relative_time.ts";

/** A feed older than this is reported stale rather than as a live number. */
export const QUICK_JUMP_STALE_MS = 60_000;

export interface QuickJumpFeedState {
  /** False until the first successful feed update. */
  readonly known: boolean;
  /** True when the feed age exceeds the stale budget. */
  readonly stale: boolean;
  /** `pending`, `just now`, `12s ago`, … */
  readonly label: string;
}

/**
 * Freshness of the live wager feed behind the ribbon's counts. A missing
 * timestamp reports `pending` (unknown), not `just now`.
 */
export function quickJumpFeedState(
  feedUpdatedAt: number | null,
  nowMs: number,
  staleMs: number = QUICK_JUMP_STALE_MS,
): QuickJumpFeedState {
  const age = formatRelativeAge(nowMs, feedUpdatedAt);
  if (age === null) {
    return { known: false, stale: false, label: "pending" };
  }
  const ageMs = nowMs - (feedUpdatedAt ?? nowMs);
  return {
    known: true,
    stale: ageMs > staleMs,
    label: age,
  };
}

/** Tooltip text for the age chip; states what the number is and where it came from. */
export function feedFreshnessTitle(
  state: QuickJumpFeedState,
  feedLabel: string,
): string {
  if (!state.known) {
    return `No live wager snapshot yet (${feedLabel}) — the count reads 0 until the first feed lands`;
  }
  if (state.stale) {
    return `No live wager update for over a minute (${feedLabel}) — showing the last landed snapshot, ${state.label}`;
  }
  return `Live wager feed: ${feedLabel} · updated ${state.label}`;
}
