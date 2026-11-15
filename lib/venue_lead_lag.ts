/**
 * Venue lead-lag on shared canonical combos — seconds-scale, not ms.
 */

import type {
  ComboFirstSeenRow,
  ComboVenueStore,
} from "./combo_venue_store.ts";

/** Below this |delta| both venue clocks are undecidable (internal ~10ms vs Polygon ~2s). */
export const VENUE_CLOCK_NOISE_MS = 500;

export type VenueLeadLagClassification =
  | "polymarket_led"
  | "internal_led"
  | "within_clock_noise"
  | "single_venue_only";

export type VenueLeadLagPair = {
  canonicalComboId: string;
  internalFirstSeen: string | null;
  polymarketFirstSeen: string | null;
  deltaMs: number | null;
  classification: VenueLeadLagClassification;
};

export type VenueLeadLagSummary = {
  clockNoiseMs: number;
  sharedComboCount: number;
  polymarketLed: { count: number; medianLeadMs: number | null };
  internalLed: { count: number; medianLeadMs: number | null };
  withinClockNoise: number;
  pairs: VenueLeadLagPair[];
};

function parseMs(iso: string): number {
  return Date.parse(iso);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function classifyLeadLagDelta(
  deltaMs: number,
): VenueLeadLagClassification {
  if (Math.abs(deltaMs) <= VENUE_CLOCK_NOISE_MS) {
    return "within_clock_noise";
  }
  return deltaMs > 0 ? "polymarket_led" : "internal_led";
}

/** delta = internal_first − polymarket_first (ms). Positive → Polymarket earlier. */
export function buildLeadLagPairs(
  rows: ComboFirstSeenRow[],
): VenueLeadLagPair[] {
  const byCombo = new Map<string, { internal?: string; polymarket?: string }>();
  for (const row of rows) {
    let entry = byCombo.get(row.canonical_combo_id);
    if (!entry) {
      entry = {};
      byCombo.set(row.canonical_combo_id, entry);
    }
    // The desk side used to be a venue called "internal"; the venue is `desk`
    // (the host), split from `lakehouse` which never trades.
    if (row.venue === "desk") {
      entry.internal = row.first_valid_time;
    } else if (row.venue === "polymarket") {
      entry.polymarket = row.first_valid_time;
    }
  }

  const pairs: VenueLeadLagPair[] = [];
  for (const [canonicalComboId, times] of byCombo) {
    if (!times.internal || !times.polymarket) {
      pairs.push({
        canonicalComboId,
        internalFirstSeen: times.internal ?? null,
        polymarketFirstSeen: times.polymarket ?? null,
        deltaMs: null,
        classification: "single_venue_only",
      });
      continue;
    }
    const deltaMs = parseMs(times.internal) - parseMs(times.polymarket);
    pairs.push({
      canonicalComboId,
      internalFirstSeen: times.internal,
      polymarketFirstSeen: times.polymarket,
      deltaMs,
      classification: classifyLeadLagDelta(deltaMs),
    });
  }
  return pairs;
}

export function summarizeVenueLeadLag(
  store: ComboVenueStore,
): VenueLeadLagSummary {
  const pairs = buildLeadLagPairs(store.listFirstSeenByVenue());
  const shared = pairs.filter((p) => p.classification !== "single_venue_only");

  const polyLeads: number[] = [];
  const internalLeads: number[] = [];
  let withinNoise = 0;

  for (const p of shared) {
    if (p.deltaMs === null) continue;
    if (p.classification === "within_clock_noise") {
      withinNoise += 1;
    } else if (p.classification === "polymarket_led") {
      polyLeads.push(Math.abs(p.deltaMs));
    } else if (p.classification === "internal_led") {
      internalLeads.push(Math.abs(p.deltaMs));
    }
  }

  return {
    clockNoiseMs: VENUE_CLOCK_NOISE_MS,
    sharedComboCount: shared.length,
    polymarketLed: {
      count: polyLeads.length,
      medianLeadMs: median(polyLeads),
    },
    internalLed: {
      count: internalLeads.length,
      medianLeadMs: median(internalLeads),
    },
    withinClockNoise: withinNoise,
    pairs: shared,
  };
}

export function formatLeadLagReport(summary: VenueLeadLagSummary): string {
  const lines: string[] = [
    "Venue lead-lag (per canonical_combo_id, shared combos only):",
    `  clock noise floor: ±${summary.clockNoiseMs}ms (sub-noise deltas undecidable)`,
    `  shared combos: ${summary.sharedComboCount}`,
  ];
  if (summary.sharedComboCount > 0) {
    const polyPct = (
      (summary.polymarketLed.count / summary.sharedComboCount) *
      100
    ).toFixed(0);
    const intPct = (
      (summary.internalLed.count / summary.sharedComboCount) *
      100
    ).toFixed(0);
    const noisePct = (
      (summary.withinClockNoise / summary.sharedComboCount) *
      100
    ).toFixed(0);
    lines.push(
      `  Polymarket first: ${summary.polymarketLed.count} (${polyPct}%)` +
        (summary.polymarketLed.medianLeadMs != null
          ? ` median lead ${(summary.polymarketLed.medianLeadMs / 1000).toFixed(1)}s`
          : ""),
    );
    lines.push(
      `  Internal first:   ${summary.internalLed.count} (${intPct}%)` +
        (summary.internalLed.medianLeadMs != null
          ? ` median lead ${(summary.internalLed.medianLeadMs / 1000).toFixed(1)}s`
          : ""),
    );
    lines.push(
      `  Within ±${summary.clockNoiseMs}ms: ${summary.withinClockNoise} (${noisePct}%) ← below clock resolution`,
    );
  }
  return lines.join("\n");
}

/** Actor-level copy-trading — not provable without settlement + wallet join + legal review. */
export type CrossVenuePatternClass =
  "signal_propagation" | "venue_lead_lag" | "actor_copy_trading";

export const CROSS_VENUE_PATTERN_SCOPE: Record<
  CrossVenuePatternClass,
  { provable: boolean; note: string }
> = {
  signal_propagation: {
    provable: true,
    note: "High-value combo on internal → Polymarket within N seconds (no identity)",
  },
  venue_lead_lag: {
    provable: true,
    note: "Seconds-scale lead-lag on shared canonical_combo_id only",
  },
  actor_copy_trading: {
    provable: false,
    note: "Requires settlement labels, structural wallet join, and compliance review",
  },
};
