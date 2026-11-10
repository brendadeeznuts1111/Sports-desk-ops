/**
 * @file src/risk/hold_floor_config.ts
 * @description Loads slice hold-floor thresholds and Blended Hold SLO policy from
 * `config/wager_tiers.toml` via `Bun.TOML.parse` (zero hardcoded floors in code),
 * with `resolved_via` fallback-chain telemetry and fallback-rate SLO evaluation.
 */

import type {
  HoldFloorFallbackSloSummary,
  HoldFloorResolvedVia,
} from "./slice_metrics.ts";
import { validateHoldFloorSliceOverrides } from "./slice_registry.ts";

export type { HoldFloorFallbackSloSummary, HoldFloorResolvedVia };

export interface HoldFloorConfig {
  readonly schema_version: number;
  readonly default_pct: number;
  readonly by_slice: Readonly<Record<string, number>>;
  readonly by_sport: Readonly<Record<string, number>>;
  readonly by_market: Readonly<Record<string, number>>;
  readonly slo_blended_hold_floor_pct: number;
  readonly slo_max_default_fallback_share_pct: number;
  readonly slo_exclude_blocked: boolean;
  readonly slo_exclude_directional: boolean;
}

export interface SliceFloorLookupKey {
  readonly slice_id?: string;
  readonly sport: string;
  readonly market: string;
}

export interface HoldFloorResolution {
  readonly hold_floor_pct: number;
  readonly resolved_via: HoldFloorResolvedVia;
  readonly matched_key: string;
}

export interface HoldFloorResolutionTelemetrySnapshot {
  readonly hold_floor_resolutions_total: number;
  readonly by_resolved_via: {
    readonly by_slice: number;
    readonly by_sport: number;
    readonly by_market: number;
    readonly default: number;
  };
}

let holdFloorResolutionsTotal = 0;
let countBySlice = 0;
let countBySport = 0;
let countByMarket = 0;
let countByDefault = 0;

export function getHoldFloorResolutionTelemetry(): HoldFloorResolutionTelemetrySnapshot {
  return {
    hold_floor_resolutions_total: holdFloorResolutionsTotal,
    by_resolved_via: {
      by_slice: countBySlice,
      by_sport: countBySport,
      by_market: countByMarket,
      default: countByDefault,
    },
  };
}

export function resetHoldFloorResolutionTelemetry(): void {
  holdFloorResolutionsTotal = 0;
  countBySlice = 0;
  countBySport = 0;
  countByMarket = 0;
  countByDefault = 0;
}

function recordHoldFloorResolution(tier: HoldFloorResolvedVia): void {
  holdFloorResolutionsTotal += 1;
  switch (tier) {
    case "by_slice":
      countBySlice += 1;
      break;
    case "by_sport":
      countBySport += 1;
      break;
    case "by_market":
      countByMarket += 1;
      break;
    case "default":
      countByDefault += 1;
      break;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNumericTable(
  raw: unknown,
  sectionName: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw === undefined) {
    return out;
  }
  if (!isPlainRecord(raw)) {
    throw new Error(
      `Invalid [${sectionName}] in wager_tiers.toml: expected table`,
    );
  }
  const keys = Object.keys(raw);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const val = raw[key];
    if (typeof val !== "number" || !Number.isFinite(val)) {
      throw new Error(
        `Invalid numeric hold floor at ${sectionName}.${key}: expected finite number`,
      );
    }
    out[key] = val;
  }
  return out;
}

/**
 * Validates an already-parsed TOML object into `HoldFloorConfig`.
 */
export function parseHoldFloorConfigDocument(parsed: unknown): HoldFloorConfig {
  if (!isPlainRecord(parsed)) {
    throw new Error("Invalid wager_tiers.toml root document");
  }

  const meta = isPlainRecord(parsed.meta) ? parsed.meta : {};
  const schemaVersion =
    typeof meta.schema_version === "number" &&
    Number.isFinite(meta.schema_version)
      ? meta.schema_version
      : 1;

  const holdFloors = parsed.hold_floors;
  if (!isPlainRecord(holdFloors)) {
    throw new Error("Missing [hold_floors] table in wager_tiers.toml");
  }

  const defaultPct = holdFloors.default_pct;
  if (typeof defaultPct !== "number" || !Number.isFinite(defaultPct)) {
    throw new Error(
      "Missing or non-numeric hold_floors.default_pct in wager_tiers.toml",
    );
  }

  const slo = isPlainRecord(parsed.slo) ? parsed.slo : {};
  const sloFloorPct =
    typeof slo.blended_hold_floor_pct === "number" &&
    Number.isFinite(slo.blended_hold_floor_pct)
      ? slo.blended_hold_floor_pct
      : defaultPct;
  const maxDefaultFallbackSharePct =
    typeof slo.max_default_fallback_share_pct === "number" &&
    Number.isFinite(slo.max_default_fallback_share_pct) &&
    slo.max_default_fallback_share_pct >= 0 &&
    slo.max_default_fallback_share_pct <= 100
      ? slo.max_default_fallback_share_pct
      : 0;
  const excludeBlocked =
    typeof slo.exclude_blocked === "boolean" ? slo.exclude_blocked : true;
  const excludeDirectional =
    typeof slo.exclude_directional === "boolean"
      ? slo.exclude_directional
      : true;

  const bySlice = parseNumericTable(
    holdFloors.by_slice,
    "hold_floors.by_slice",
  );
  const invalidSliceKeys = validateHoldFloorSliceOverrides(bySlice);
  if (invalidSliceKeys.length > 0) {
    throw new Error(
      `Invalid [hold_floors.by_slice] key(s) in wager_tiers.toml (${invalidSliceKeys.join(", ")}): must match canonical SLICE_REGISTRY slice_id, never numeric indices`,
    );
  }

  return {
    schema_version: schemaVersion,
    default_pct: defaultPct,
    by_slice: bySlice,
    by_sport: parseNumericTable(holdFloors.by_sport, "hold_floors.by_sport"),
    by_market: parseNumericTable(holdFloors.by_market, "hold_floors.by_market"),
    slo_blended_hold_floor_pct: sloFloorPct,
    slo_max_default_fallback_share_pct: maxDefaultFallbackSharePct,
    slo_exclude_blocked: excludeBlocked,
    slo_exclude_directional: excludeDirectional,
  };
}

/**
 * Pure parser for `config/wager_tiers.toml` text using `Bun.TOML.parse`.
 */
export function parseHoldFloorConfigToml(tomlText: string): HoldFloorConfig {
  const parsed: unknown = Bun.TOML.parse(tomlText);
  return parseHoldFloorConfigDocument(parsed);
}

/**
 * Async loader reading `config/wager_tiers.toml` via `Bun.file`.
 */
export async function loadHoldFloorConfig(
  configPath = "config/wager_tiers.toml",
): Promise<HoldFloorConfig> {
  const text = await Bun.file(configPath).text();
  return parseHoldFloorConfigToml(text);
}

/**
 * Resolves `{ hold_floor_pct, resolved_via, matched_key }` for a slice from
 * `HoldFloorConfig` without hardcoding and increments `hold_floor_resolutions_total{resolved_via}`.
 *
 * Precedence: `by_slice[slice_id]` -> `by_sport[sport]` -> `by_market[market]` -> `default_pct`.
 */
export function resolveHoldFloor(
  config: HoldFloorConfig,
  key: SliceFloorLookupKey,
): HoldFloorResolution {
  if (
    key.slice_id !== undefined &&
    Object.hasOwn(config.by_slice, key.slice_id)
  ) {
    recordHoldFloorResolution("by_slice");
    return {
      hold_floor_pct: config.by_slice[key.slice_id]!,
      resolved_via: "by_slice",
      matched_key: key.slice_id,
    };
  }
  if (Object.hasOwn(config.by_sport, key.sport)) {
    recordHoldFloorResolution("by_sport");
    return {
      hold_floor_pct: config.by_sport[key.sport]!,
      resolved_via: "by_sport",
      matched_key: key.sport,
    };
  }
  if (Object.hasOwn(config.by_market, key.market)) {
    recordHoldFloorResolution("by_market");
    return {
      hold_floor_pct: config.by_market[key.market]!,
      resolved_via: "by_market",
      matched_key: key.market,
    };
  }
  recordHoldFloorResolution("default");
  return {
    hold_floor_pct: config.default_pct,
    resolved_via: "default",
    matched_key: "default_pct",
  };
}

/**
 * Numeric convenience wrapper around {@link resolveHoldFloor}.
 */
export function resolveHoldFloorPct(
  config: HoldFloorConfig,
  key: SliceFloorLookupKey,
): number {
  return resolveHoldFloor(config, key).hold_floor_pct;
}

/**
 * Evaluates hold-floor fallback distribution across slice rows and enforces the
 * `max_default_fallback_share_pct` SLO on both slice-count share and handle share
 * (so even a `$0`-handle slice falling through to `default_pct` cannot hide).
 */
export function evaluateHoldFloorFallbackSlo(
  rows: readonly {
    readonly slice_id: string;
    readonly handle_usd: number;
    readonly hold_floor_resolved_via: HoldFloorResolvedVia | null;
  }[],
  max_default_fallback_share_pct = 0,
): HoldFloorFallbackSloSummary {
  let slicesBySlice = 0;
  let slicesBySport = 0;
  let slicesByMarket = 0;
  let slicesByDefault = 0;

  let handleBySlice = 0;
  let handleBySport = 0;
  let handleByMarket = 0;
  let handleByDefault = 0;
  let totalHandleUsd = 0;

  const defaultFallbackSlices: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    totalHandleUsd += row.handle_usd;
    const tier = row.hold_floor_resolved_via ?? "default";
    switch (tier) {
      case "by_slice":
        slicesBySlice += 1;
        handleBySlice += row.handle_usd;
        break;
      case "by_sport":
        slicesBySport += 1;
        handleBySport += row.handle_usd;
        break;
      case "by_market":
        slicesByMarket += 1;
        handleByMarket += row.handle_usd;
        break;
      case "default":
        slicesByDefault += 1;
        handleByDefault += row.handle_usd;
        defaultFallbackSlices.push(row.slice_id);
        break;
    }
  }

  const totalSlices = rows.length;
  const defaultSliceSharePct =
    totalSlices > 0 ? (slicesByDefault / totalSlices) * 100 : 0;
  const defaultHandleSharePct =
    totalHandleUsd > 0 ? (handleByDefault / totalHandleUsd) * 100 : 0;
  const sloMet =
    defaultSliceSharePct <= max_default_fallback_share_pct &&
    defaultHandleSharePct <= max_default_fallback_share_pct;

  return {
    total_slices: totalSlices,
    total_handle_usd: totalHandleUsd,
    counts_by_tier: {
      by_slice: slicesBySlice,
      by_sport: slicesBySport,
      by_market: slicesByMarket,
      default: slicesByDefault,
    },
    handle_usd_by_tier: {
      by_slice: handleBySlice,
      by_sport: handleBySport,
      by_market: handleByMarket,
      default: handleByDefault,
    },
    default_slice_share_pct: defaultSliceSharePct,
    default_handle_share_pct: defaultHandleSharePct,
    max_default_fallback_share_pct,
    default_fallback_slices: defaultFallbackSlices,
    slo_met: sloMet,
  };
}
