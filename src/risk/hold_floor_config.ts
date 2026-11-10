/**
 * @file src/risk/hold_floor_config.ts
 * @description Loads slice hold-floor thresholds and Blended Hold SLO policy from
 * `config/wager_tiers.toml` via `Bun.TOML.parse` (zero hardcoded floors in code).
 */

export interface HoldFloorConfig {
  readonly schema_version: number;
  readonly default_pct: number;
  readonly by_slice: Readonly<Record<string, number>>;
  readonly by_sport: Readonly<Record<string, number>>;
  readonly by_market: Readonly<Record<string, number>>;
  readonly slo_blended_hold_floor_pct: number;
  readonly slo_exclude_blocked: boolean;
  readonly slo_exclude_directional: boolean;
}

export interface SliceFloorLookupKey {
  readonly slice_id?: string;
  readonly sport: string;
  readonly market: string;
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
  const excludeBlocked =
    typeof slo.exclude_blocked === "boolean" ? slo.exclude_blocked : true;
  const excludeDirectional =
    typeof slo.exclude_directional === "boolean"
      ? slo.exclude_directional
      : true;

  return {
    schema_version: schemaVersion,
    default_pct: defaultPct,
    by_slice: parseNumericTable(holdFloors.by_slice, "hold_floors.by_slice"),
    by_sport: parseNumericTable(holdFloors.by_sport, "hold_floors.by_sport"),
    by_market: parseNumericTable(holdFloors.by_market, "hold_floors.by_market"),
    slo_blended_hold_floor_pct: sloFloorPct,
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
 * Resolves `hold_floor_pct` for a slice from `HoldFloorConfig` without hardcoding:
 * precedence: `by_slice[slice_id]` -> `by_sport[sport]` -> `by_market[market]` -> `default_pct`.
 */
export function resolveHoldFloorPct(
  config: HoldFloorConfig,
  key: SliceFloorLookupKey,
): number {
  if (
    key.slice_id !== undefined &&
    Object.hasOwn(config.by_slice, key.slice_id)
  ) {
    return config.by_slice[key.slice_id]!;
  }
  if (Object.hasOwn(config.by_sport, key.sport)) {
    return config.by_sport[key.sport]!;
  }
  if (Object.hasOwn(config.by_market, key.market)) {
    return config.by_market[key.market]!;
  }
  return config.default_pct;
}
