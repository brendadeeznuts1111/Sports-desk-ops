/**
 * Inlined hold-floor SSOT metadata from `config/wager_tiers.toml` (bun build tree-shakes unused tables).
 */

import wagerTiersCfg from "../../../../config/wager_tiers.toml";

const typedCfg = wagerTiersCfg as {
  readonly schema: string;
  readonly version: string;
  readonly hold_floors: { readonly default_pct: number };
};

export const WAGER_TIERS_SSOT_PATH = "config/wager_tiers.toml" as const;

export const WAGER_TIERS_SSOT = {
  path: WAGER_TIERS_SSOT_PATH,
  schema: String(typedCfg.schema),
  version: String(typedCfg.version),
  defaultHoldFloorPct: Number(typedCfg.hold_floors.default_pct),
  holdFloorPrecedence: [
    "by_slice[slice_id]",
    "by_sport[sport]",
    "by_market[market]",
    "default_pct",
  ],
} as const;
