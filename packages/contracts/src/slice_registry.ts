/**
 * @file src/risk/slice_registry.ts
 * @description Canonical Array-of-Structures (AoS) `SLICE_REGISTRY` source of truth.
 *
 * Design contract:
 * - `SLICE_REGISTRY` remains readable, diffable AoS policy data (`as const satisfies readonly SliceSpec[]`).
 * - Array indices are strictly internal derived handles (`buildSliceIndexLookup`), never bit-packed
 *   with upper-bit flags/axes, and never exposed as canonical join keys in TOML, docs, tests, or telemetry.
 * - Per-slice booleans live in derived `Uint32Array` bitsets keyed by registry index — never a `boolean[]`,
 *   never packed into the index — exposed only through predicates.
 */

import type {
  MarketCode,
  PeriodCode,
  SportCode,
  SubSportCode,
} from "./shadow_pricing.ts";
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
 *
 * No-packing invariant:
 * - Returns plain `0..registry.length - 1` positions in registry order (`-1` when absent).
 * - Never packs policy, axis, specificity, or flag bits into upper bits of the handle.
 * - Never persist or emit these positions in place of canonical `slice_id`.
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

export type SlicePredicate = (slice_id: string) => boolean;

export type UnknownSlicePolicy = "throw" | "telemetry";

export interface SlicePredicateOptions {
  readonly onUnknownSlice?: UnknownSlicePolicy;
}

export class UnknownSliceIdError extends RangeError {
  readonly slice_id: string;

  constructor(slice_id: string, context = "SLICE_REGISTRY") {
    super(
      `Unknown slice_id '${slice_id}' queried against ${context} predicate (not registered in SLICE_REGISTRY)`,
    );
    this.name = "UnknownSliceIdError";
    this.slice_id = slice_id;
  }
}

export interface SliceUnknownTelemetrySnapshot {
  readonly slice_unknown_total: number;
  readonly by_slice_id: Readonly<Record<string, number>>;
}

let sliceUnknownTotal = 0;
let sliceUnknownById: Record<string, number> = Object.create(null) as Record<
  string,
  number
>;

function readRuntimeNodeEnv(): string | undefined {
  if (typeof Bun !== "undefined") {
    return Bun.env.NODE_ENV;
  }
  if (typeof process !== "undefined" && typeof process.env === "object") {
    return process.env.NODE_ENV;
  }
  return undefined;
}

/**
 * Resolves the default non-silent unknown-slice behavior:
 * - `"production"` -> `"telemetry"` (increments `slice_unknown_total{slice_id}`, returns `false`)
 * - all non-production profiles (`development`, `test`, unset) -> `"throw"` (`UnknownSliceIdError` + telemetry)
 */
export function resolveDefaultUnknownSlicePolicy(
  nodeEnv: string | undefined = readRuntimeNodeEnv(),
): UnknownSlicePolicy {
  return nodeEnv === "production" ? "telemetry" : "throw";
}

export function getSliceUnknownTelemetry(): SliceUnknownTelemetrySnapshot {
  const copy: Record<string, number> = {};
  const keys = Object.keys(sliceUnknownById);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    copy[k] = sliceUnknownById[k]!;
  }
  return {
    slice_unknown_total: sliceUnknownTotal,
    by_slice_id: copy,
  };
}

export function resetSliceUnknownTelemetry(): void {
  sliceUnknownTotal = 0;
  sliceUnknownById = Object.create(null) as Record<string, number>;
}

/**
 * Records `slice_unknown_total{slice_id}` and enforces `UnknownSlicePolicy`
 * so unregistered `slice_id` lookups are never silent.
 */
export function recordUnknownSliceId(
  slice_id: string,
  options?: SlicePredicateOptions,
  context = "SLICE_REGISTRY",
): false {
  sliceUnknownTotal += 1;
  sliceUnknownById[slice_id] = (sliceUnknownById[slice_id] ?? 0) + 1;
  const policy = options?.onUnknownSlice ?? resolveDefaultUnknownSlicePolicy();
  if (policy === "throw") {
    throw new UnknownSliceIdError(slice_id, context);
  }
  return false;
}

/**
 * Derives an encapsulated `Uint32Array` bitset keyed by `SLICE_REGISTRY` index
 * from `predicate(spec)` — never a `boolean[]`, never packed into the index —
 * and exposes it strictly as a `(slice_id: string) => boolean` predicate.
 */
export function deriveSliceBitsetPredicate(
  predicate: (spec: SliceSpec) => boolean,
  registry: readonly SliceSpec[] = SLICE_REGISTRY,
  options?: SlicePredicateOptions,
): SlicePredicate {
  const lookup =
    registry === SLICE_REGISTRY
      ? DEFAULT_SLICE_LOOKUP
      : buildSliceIndexLookup(registry);
  const wordCount = (registry.length + 31) >>> 5;
  if (wordCount * 32 < registry.length) {
    throw new RangeError(
      `SLICE_REGISTRY bitset word-size invariant violated: length ${registry.length} > ${wordCount * 32}`,
    );
  }
  const words = new Uint32Array(wordCount);
  for (let i = 0; i < registry.length; i++) {
    if (predicate(registry[i]!)) {
      words[i >>> 5] = ((words[i >>> 5] ?? 0) | (1 << (i & 31))) >>> 0;
    }
  }
  return (slice_id: string): boolean => {
    const idx = lookup.indexOf(slice_id);
    if (idx < 0) {
      return recordUnknownSliceId(slice_id, options);
    }
    return ((words[idx >>> 5]! >>> (idx & 31)) & 1) === 1;
  };
}

export const isBlockedSlice: SlicePredicate = deriveSliceBitsetPredicate(
  (spec) => spec.policy === "BLOCKED",
);

export const isAdvantageSlice: SlicePredicate = deriveSliceBitsetPredicate(
  (spec) => spec.policy === "ADVANTAGE",
);

export const isLeakSlice: SlicePredicate = deriveSliceBitsetPredicate(
  (spec) => spec.policy === "LEAK",
);

export const isPreserveSlice: SlicePredicate = deriveSliceBitsetPredicate(
  (spec) => spec.policy === "PRESERVE",
);

export const isLiveLockoutSlice: SlicePredicate = deriveSliceBitsetPredicate(
  (spec) => spec.policy_mechanism === "LIVE_LOCKOUT",
);
