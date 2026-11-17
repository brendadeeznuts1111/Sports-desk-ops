import { describe, expect, test } from "bun:test";
import { WAGER_TIERS_SSOT } from "../packages/ui/src/config/wager_tiers_ssot.ts";
import {
  rollupSliceFlags,
  summarizeSliceFloorSsot,
} from "../packages/ui/src/slice_floor_ssot.ts";
import type { HoldFloorFallbackSloSummary } from "@sportsdesk-ops/contracts/slice-metrics";

const fallbackStub: HoldFloorFallbackSloSummary = {
  total_slices: 7,
  total_handle_usd: 1_000_000,
  counts_by_tier: { by_slice: 4, by_sport: 1, by_market: 1, default: 1 },
  handle_usd_by_tier: { by_slice: 0, by_sport: 0, by_market: 0, default: 0 },
  default_slice_share_pct: 14.3,
  default_handle_share_pct: 5.2,
  max_default_fallback_share_pct: 15,
  default_fallback_slices: ["other:other_general:game:other"],
  slo_met: true,
};

describe("slice floor SSOT helpers", () => {
  test("WAGER_TIERS_SSOT inlines schema + default floor from toml", () => {
    expect(WAGER_TIERS_SSOT.schema).toBe("wager-tiers/v3");
    expect(WAGER_TIERS_SSOT.defaultHoldFloorPct).toBe(3.5);
  });

  test("summarizeSliceFloorSsot counts 6/7 flagged pattern", () => {
    const rows = [
      { slice_id: "a", flags: ["HOLD_BELOW_FLOOR"], floor_delta_pct: -0.5 },
      {
        slice_id: "b",
        flags: ["HOLD_BELOW_FLOOR", "BUY_SHARE_EXTREME"],
        floor_delta_pct: -1.2,
      },
      { slice_id: "c", flags: [], floor_delta_pct: 0.2 },
      { slice_id: "d", flags: ["POLICY_DATA_CONFLICT"], floor_delta_pct: -0.1 },
      { slice_id: "e", flags: ["DIRECTIONAL_DOMINANT"], floor_delta_pct: 0.4 },
      { slice_id: "f", flags: ["MISSING_VIG_SPLIT"], floor_delta_pct: -0.3 },
      { slice_id: "g", flags: ["HOLD_BELOW_FLOOR"], floor_delta_pct: -2.1 },
    ] as const;
    const summary = summarizeSliceFloorSsot(
      rows as unknown as import("@sportsdesk-ops/contracts/slice-metrics").SliceMetrics[],
      fallbackStub,
    );
    expect(summary.flaggedSlices).toBe(6);
    expect(summary.totalSlices).toBe(7);
    expect(summary.byFlag.HOLD_BELOW_FLOOR).toBe(3);
    expect(summary.worstFloorSliceId).toBe("g");
  });

  test("rollupSliceFlags is additive per row", () => {
    const rollup = rollupSliceFlags([
      { flags: ["HOLD_BELOW_FLOOR", "HOLD_BELOW_FLOOR"] },
    ] as never);
    expect(rollup.HOLD_BELOW_FLOOR).toBe(2);
  });
});
