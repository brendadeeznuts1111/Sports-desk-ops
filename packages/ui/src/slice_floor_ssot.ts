import type {
  SliceFlag,
  SliceMetrics,
} from "@sportsdesk-ops/contracts/slice-metrics";
import type { HoldFloorFallbackSloSummary } from "@sportsdesk-ops/contracts/slice-metrics";

export const SLICE_FLAG_ORDER: readonly SliceFlag[] = [
  "HOLD_BELOW_FLOOR",
  "POLICY_DATA_CONFLICT",
  "BUY_SHARE_EXTREME",
  "DIRECTIONAL_DOMINANT",
  "MISSING_VIG_SPLIT",
];

export type SliceFlagRollup = Readonly<Record<SliceFlag, number>>;

export interface SliceFloorSsotSummary {
  readonly totalSlices: number;
  readonly flaggedSlices: number;
  readonly cleanSlices: number;
  readonly byFlag: SliceFlagRollup;
  readonly belowFloorSlices: number;
  readonly defaultFallbackSliceCount: number;
  readonly defaultFallbackHandleSharePct: number;
  readonly worstFloorDeltaPct: number | null;
  readonly worstFloorSliceId: string | null;
}

export function emptyFlagRollup(): SliceFlagRollup {
  return {
    BUY_SHARE_EXTREME: 0,
    POLICY_DATA_CONFLICT: 0,
    HOLD_BELOW_FLOOR: 0,
    DIRECTIONAL_DOMINANT: 0,
    MISSING_VIG_SPLIT: 0,
  };
}

export function rollupSliceFlags(
  rows: readonly SliceMetrics[],
): SliceFlagRollup {
  const rollup: Record<SliceFlag, number> = {
    BUY_SHARE_EXTREME: 0,
    POLICY_DATA_CONFLICT: 0,
    HOLD_BELOW_FLOOR: 0,
    DIRECTIONAL_DOMINANT: 0,
    MISSING_VIG_SPLIT: 0,
  };
  for (const row of rows) {
    for (const flag of row.flags) {
      rollup[flag] += 1;
    }
  }
  return rollup;
}

export function summarizeSliceFloorSsot(
  rows: readonly SliceMetrics[],
  fallback: HoldFloorFallbackSloSummary,
): SliceFloorSsotSummary {
  const byFlag = rollupSliceFlags(rows);
  const flaggedSlices = rows.filter((r) => r.flags.length > 0).length;
  let worstFloorDeltaPct: number | null = null;
  let worstFloorSliceId: string | null = null;
  for (const row of rows) {
    if (
      worstFloorDeltaPct === null ||
      row.floor_delta_pct < worstFloorDeltaPct
    ) {
      worstFloorDeltaPct = row.floor_delta_pct;
      worstFloorSliceId = row.slice_id;
    }
  }
  return {
    totalSlices: rows.length,
    flaggedSlices,
    cleanSlices: rows.length - flaggedSlices,
    byFlag,
    belowFloorSlices: byFlag.HOLD_BELOW_FLOOR,
    defaultFallbackSliceCount: fallback.counts_by_tier.default,
    defaultFallbackHandleSharePct: fallback.default_handle_share_pct,
    worstFloorDeltaPct,
    worstFloorSliceId,
  };
}

export function rowMatchesFlagFilter(
  row: SliceMetrics,
  flaggedOnly: boolean,
  flagFilter: SliceFlag | null,
): boolean {
  if (flaggedOnly && row.flags.length === 0) {
    return false;
  }
  if (flagFilter !== null && !row.flags.includes(flagFilter)) {
    return false;
  }
  return true;
}
