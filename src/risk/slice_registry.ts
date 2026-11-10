/**
 * @file src/risk/slice_registry.ts
 * @description Canonical Array-of-Structures (AoS) `SLICE_REGISTRY` source of truth.
 *
 * Design contract:
 * - `SLICE_REGISTRY` remains readable, diffable AoS policy data (`as const satisfies readonly SliceSpec[]`).
 * - Array indices are strictly internal derived handles (`buildSliceIndexLookup`), never bit-packed
 *   with upper-bit flags/axes, and never exposed as canonical join keys in TOML, docs, tests, or telemetry.
 */

import type {
  MarketCode,
  PeriodCode,
  SportCode,
  SubSportCode,
} from "../../types/shadow_pricing.ts";
import type { SlicePolicy, SlicePolicyMechanism } from "./slice_metrics.ts";

export type CanonicalSliceIdPattern =
  `${Lowercase<string>}:${string}:${string}:${string}`;

export interface SliceTaxonomySelector {
  readonly sport?: SportCode;
  readonly subSport?: SubSportCode;
  readonly period?: PeriodCode;
  readonly market?: MarketCode;
}

export interface SliceSpec {
  readonly slice_id: CanonicalSliceIdPattern;
  readonly sport: string;
  readonly league: string;
  readonly period: string;
  readonly market: string;
  readonly selector: SliceTaxonomySelector;
  readonly policy: SlicePolicy;
  readonly policy_mechanism: SlicePolicyMechanism;
  readonly policy_qualifier: string;
}

export const SLICE_REGISTRY = [
  {
    slice_id: "football:nfl:p0_game:spread",
    sport: "Football",
    league: "NFL",
    period: "P0 Game",
    market: "Spread",
    selector: {
      sport: "Football",
      subSport: "NFL",
      period: "game",
      market: "spread",
    },
    policy: "LEAK",
    policy_mechanism: "VIG",
    policy_qualifier: "Key 3/7/10/14 buy exposure",
  },
  {
    slice_id: "football:ncaaf:p0_game:spread",
    sport: "Football",
    league: "College FB",
    period: "P0 Game",
    market: "Spread",
    selector: {
      sport: "Football",
      subSport: "NCAAF",
      period: "game",
      market: "spread",
    },
    policy: "LEAK",
    policy_mechanism: "VIG",
    policy_qualifier: "Key 3/7/10/14 buy exposure",
  },
  {
    slice_id: "basketball:nba:p0_game:spread",
    sport: "Basketball",
    league: "NBA",
    period: "P0 Game",
    market: "Spread",
    selector: {
      sport: "Basketball",
      subSport: "NBA",
      period: "game",
      market: "spread",
    },
    policy: "ADVANTAGE",
    policy_mechanism: "BELL_CURVE",
    policy_qualifier: "PRESERVE_BELL_CURVE_VIG",
  },
  {
    slice_id: "basketball:ncaab:halves:all",
    sport: "Basketball",
    league: "NCAAB",
    period: "P0/1H/2H",
    market: "All Markets",
    selector: {
      sport: "Basketball",
      subSport: "NCAAB",
    },
    policy: "ADVANTAGE",
    policy_mechanism: "BELL_CURVE",
    policy_qualifier: "20m halves only",
  },
  {
    slice_id: "hockey:nhl:periods:all",
    sport: "Hockey",
    league: "NHL",
    period: "OT/Reg/P1-P3",
    market: "All Markets",
    selector: {
      sport: "Hockey",
      subSport: "NHL",
    },
    policy: "BLOCKED",
    policy_mechanism: "DERIVATIVE",
    policy_qualifier: "DERIVATIVE_AND_LIVE_LOCKOUT",
  },
  {
    slice_id: "baseball:mlb:f5:spread",
    sport: "Baseball",
    league: "MLB",
    period: "F5",
    market: "Spread",
    selector: {
      sport: "Baseball",
      subSport: "MLB",
      period: "f5",
      market: "spread",
    },
    policy: "BLOCKED",
    policy_mechanism: "DERIVATIVE",
    policy_qualifier: "DERIVATIVE_AND_LIVE_LOCKOUT",
  },
  {
    slice_id: "live:all:p0_inplay:all",
    sport: "LIVE",
    league: "In-Play #9000",
    period: "P0 In-Play",
    market: "All Markets",
    selector: {
      sport: "LIVE",
    },
    policy: "BLOCKED",
    policy_mechanism: "LIVE_LOCKOUT",
    policy_qualifier: "Clock/feed latency focus",
  },
] as const satisfies readonly SliceSpec[];

export type RegisteredSliceId = (typeof SLICE_REGISTRY)[number]["slice_id"];

export interface SliceIndexLookup {
  readonly size: number;
  indexOf(slice_id: string): number;
  getSpec(slice_id: string): SliceSpec | null;
}

const SLICE_SEGMENT_RE = /^[a-z0-9_]+:[a-z0-9_]+:[a-z0-9_]+:[a-z0-9_]+$/;
const NUMERIC_INDEX_RE = /^\d+$/;

/**
 * Validates that an AoS registry has unique, 4-segment `slice_id` keys and
 * non-empty split display metadata.
 */
export function assertValidSliceRegistry(
  registry: readonly SliceSpec[] = SLICE_REGISTRY,
): void {
  if (registry.length === 0) {
    throw new Error("SLICE_REGISTRY must contain at least one SliceSpec");
  }
  const seen = Object.create(null) as Record<string, true>;
  for (let i = 0; i < registry.length; i++) {
    const spec = registry[i]!;
    if (!SLICE_SEGMENT_RE.test(spec.slice_id)) {
      throw new Error(
        `Invalid slice_id '${spec.slice_id}' at registry[${i}]: expected lowercase 4-segment <sport>:<league>:<period>:<market>`,
      );
    }
    if (seen[spec.slice_id] === true) {
      throw new Error(
        `Duplicate slice_id '${spec.slice_id}' in SLICE_REGISTRY`,
      );
    }
    seen[spec.slice_id] = true;
    if (
      spec.sport.trim() === "" ||
      spec.league.trim() === "" ||
      spec.period.trim() === "" ||
      spec.market.trim() === ""
    ) {
      throw new Error(
        `Empty split label in SLICE_REGISTRY entry '${spec.slice_id}'`,
      );
    }
  }
}

/**
 * Builds an internal derived index lookup from a `SliceSpec[]` AoS registry.
 * Array indices are internal handles (`0..length-1`, `-1` when absent) and must
 * never be persisted or emitted in place of `slice_id`.
 */
export function buildSliceIndexLookup(
  registry: readonly SliceSpec[] = SLICE_REGISTRY,
): SliceIndexLookup {
  assertValidSliceRegistry(registry);
  const indexById = Object.create(null) as Record<string, number>;
  for (let i = 0; i < registry.length; i++) {
    indexById[registry[i]!.slice_id] = i;
  }
  return {
    size: registry.length,
    indexOf(slice_id: string): number {
      const idx = indexById[slice_id];
      return idx !== undefined ? idx : -1;
    },
    getSpec(slice_id: string): SliceSpec | null {
      const idx = indexById[slice_id];
      return idx !== undefined ? registry[idx]! : null;
    },
  };
}

const DEFAULT_SLICE_LOOKUP: SliceIndexLookup =
  buildSliceIndexLookup(SLICE_REGISTRY);

export function isRegisteredSliceId(
  slice_id: string,
): slice_id is RegisteredSliceId {
  return DEFAULT_SLICE_LOOKUP.indexOf(slice_id) >= 0;
}

export function getSliceSpec(slice_id: string): SliceSpec | null {
  return DEFAULT_SLICE_LOOKUP.getSpec(slice_id);
}

/**
 * Returns any invalid or unregistered keys in `wager_tiers.toml` `[hold_floors.by_slice]`
 * (explicitly rejecting numeric array indices such as `"0"` or `"1"`).
 */
export function validateHoldFloorSliceOverrides(
  bySlice: Readonly<Record<string, number>>,
  registry: readonly SliceSpec[] = SLICE_REGISTRY,
): string[] {
  const lookup =
    registry === SLICE_REGISTRY
      ? DEFAULT_SLICE_LOOKUP
      : buildSliceIndexLookup(registry);
  const invalid: string[] = [];
  const keys = Object.keys(bySlice);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (NUMERIC_INDEX_RE.test(key) || lookup.indexOf(key) < 0) {
      invalid.push(key);
    }
  }
  return invalid;
}
