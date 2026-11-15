import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalComboFromWire } from "../lib/canonical_combo_index.ts";
import { createComboVenueStore } from "../lib/combo_venue_store.ts";
import {
  classifyLeadLagDelta,
  summarizeVenueLeadLag,
  VENUE_CLOCK_NOISE_MS,
  CROSS_VENUE_PATTERN_SCOPE,
} from "../lib/venue_lead_lag.ts";
import { auditRunAt, auditRunId } from "../lib/audit_run_id.ts";

const FIX = join(import.meta.dir, "fixtures");

describe("canonical_combo_index", () => {
  test("internal and polymarket project to same canonical_combo_id (price excluded)", () => {
    const internal = JSON.parse(
      readFileSync(join(FIX, "canonical-combo-internal.json"), "utf8"),
    );
    const poly = JSON.parse(
      readFileSync(join(FIX, "canonical-combo-polymarket.json"), "utf8"),
    );
    const a = canonicalComboFromWire("desk", internal.wire)!;
    const b = canonicalComboFromWire("polymarket", poly.wire)!;
    expect(a.canonicalComboId).toBe(b.canonicalComboId);
    expect(a.canonicalComboId).toContain("NCAAF");
    expect(a.canonicalComboId).toContain("spread|UCF+1");
  });

  test("venue lead-lag: Polymarket first by 8.4s (seconds-scale signal)", () => {
    const store = createComboVenueStore();
    const internal = JSON.parse(
      readFileSync(join(FIX, "canonical-combo-internal.json"), "utf8"),
    );
    const poly = JSON.parse(
      readFileSync(join(FIX, "canonical-combo-polymarket.json"), "utf8"),
    );
    const pi = canonicalComboFromWire("desk", internal.wire)!;
    const pp = canonicalComboFromWire("polymarket", poly.wire)!;
    expect(pi.canonicalComboId).toBe(pp.canonicalComboId);

    store.insertObservation({
      canonicalComboId: pi.canonicalComboId,
      venue: "desk",
      venueRef: internal.venueRef,
      validTime: internal.validTime,
      legs: pi.input.legs,
      runId: auditRunId("r1"),
      runAt: auditRunAt("2026-10-21T08:00:00.000Z"),
    });
    store.insertObservation({
      canonicalComboId: pp.canonicalComboId,
      venue: "polymarket",
      venueRef: poly.venueRef,
      validTime: poly.validTime,
      legs: pp.input.legs,
      runId: auditRunId("r2"),
      runAt: auditRunAt("2026-10-21T08:00:01.000Z"),
    });

    const summary = summarizeVenueLeadLag(store);
    expect(summary.sharedComboCount).toBe(1);
    expect(summary.polymarketLed.count).toBe(1);
    expect(summary.polymarketLed.medianLeadMs).toBe(8400); // 8.4s lead
    expect(summary.withinClockNoise).toBe(0);
  });

  test("sub-500ms delta is within_clock_noise", () => {
    expect(classifyLeadLagDelta(300)).toBe("within_clock_noise");
    expect(classifyLeadLagDelta(-400)).toBe("within_clock_noise");
    expect(classifyLeadLagDelta(600)).toBe("polymarket_led");
    expect(VENUE_CLOCK_NOISE_MS).toBe(500);
  });

  test("actor copy-trading explicitly not provable in scope matrix", () => {
    expect(CROSS_VENUE_PATTERN_SCOPE.actor_copy_trading.provable).toBe(false);
    expect(CROSS_VENUE_PATTERN_SCOPE.signal_propagation.provable).toBe(true);
  });
});
