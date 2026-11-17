import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createDod6SpineOverlay } from "../lib/dod6_spine_overlay.ts";

import type { F402TickerRow } from "../lib/f402_ingest.ts";
import {
  buildStreamSignalDiagnostics,
  PickShapeTwinTracker,
  ScoutApexTracker,
  loadDod6BookOverlayFromJson,
  pickShapeSha256FromShortDesc,
} from "../lib/weight_tier_signal_enrichment.ts";
import { planStreamSignalsForRows } from "../lib/weight_tier_stream_signals.ts";

const SPREAD_DESC =
  "S.\r\nFootball - Chiefs vs Bills / Game / Point spread / Chiefs -3 -110";

function row(
  partial: Partial<F402TickerRow> & Pick<F402TickerRow, "login">,
): F402TickerRow {
  return {
    customerId: partial.login,
    agentId: partial.agentId ?? "GOLD22",
    agentLogin: partial.agentLogin ?? "GOLD22",
    ticketWriter: partial.ticketWriter ?? "Internet",
    wagerNumber: partial.wagerNumber ?? "900101",
    ticketNumber: "",
    wagerType: partial.wagerType ?? "S",
    shortDesc: partial.shortDesc ?? SPREAD_DESC,
    insertedAt: partial.insertedAt ?? "2026-11-04T18:00:00.000Z",
    vip: "",
    amountWagered: partial.amountWagered ?? 5000,
    toWinAmount: 4545,
    volumeAmount: 5000,
    login: partial.login,
  };
}

describe("pick shape hashing", () => {
  test("same shape yields stable sha256", () => {
    const a = pickShapeSha256FromShortDesc(SPREAD_DESC);
    const b = pickShapeSha256FromShortDesc(SPREAD_DESC);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
});

describe("scout → apex timing", () => {
  test("GX195 inside 30s of WC8406 on same rotation tags diagnostics", () => {
    const t0 = Date.parse("2026-11-04T18:00:00.000Z");
    const emissions = planStreamSignalsForRows(
      [
        row({
          login: "WC8406",
          wagerNumber: "900201",
          insertedAt: new Date(t0).toISOString(),
        }),
        row({
          login: "GX195",
          wagerNumber: "900202",
          insertedAt: new Date(t0 + 29_680).toISOString(),
        }),
      ],
      { emittedAt: new Date(t0 + 29_680).toISOString() },
    );
    const apex = emissions.find((e) => e.triggerLogin === "GX195");
    expect(apex?.diagnostics.scoutPrecursor?.scoutLogin).toBe("WC8406");
    expect(apex?.diagnostics.routingTag).toBe("ANOM-01_SCOUT_CONFIRMED");
  });
});

describe("pick shape twins", () => {
  test("two logins same pick shape within 120s register induction hit", () => {
    const tracker = new PickShapeTwinTracker(120_000);
    const at = Date.now();
    const twinsA = tracker.record(row({ login: "MM1023_0" }), at);
    expect(twinsA).toHaveLength(0);
    const twinsB = tracker.record(
      row({ login: "MM1012_0", wagerNumber: "900301" }),
      at + 15_000,
    );
    expect(twinsB.length).toBeGreaterThan(0);
  });
});

describe("DOD6 book overlay", () => {
  test("loads enriched customer fixture", () => {
    const book = loadDod6BookOverlayFromJson(
      resolve(
        import.meta.dir,
        "fixtures/backtest/enriched_customers_full.json",
      ),
    );
    expect(book.lookup("SYNTH_SYN_01")?.clvBps).toBe(40);
  });
});

describe("ScoutApexTracker unit", () => {
  test("records scout before apex", () => {
    const tracker = new ScoutApexTracker(30_000);
    tracker.record(row({ login: "WC8406" }), 1_000);
    const hit = tracker.record(
      row({ login: "GX195", wagerNumber: "2" }),
      30_500,
    );
    expect(hit?.deltaMs).toBe(29_500);
  });
});

describe("DOD6 customer identity", () => {
  test("keeps exact ids separate and joins same-login ticker rows by customerId", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "dod6-identity-"));
    const path = resolve(dir, "book.json");
    try {
      writeFileSync(
        path,
        JSON.stringify([
          { customer_id: "same_0", clv_bps: 10 },
          { customer_id: "SAME_0", clv_bps: 20 },
          { customer_id: "same_1", clv_bps: 30 },
        ]),
      );
      const book = loadDod6BookOverlayFromJson(path);
      expect(book.lookup("same_0")?.clvBps).toBe(10);
      expect(book.lookup("SAME_0")?.clvBps).toBe(20);
      expect(book.lookup("same_1")?.clvBps).toBe(30);
      expect(book.lookup("same")).toBeNull();
      expect(book.lookup(" same_0 ")).toBeNull();
      const spine = await createDod6SpineOverlay({ jsonBookPath: path });
      for (const [customerId, expected] of [
        ["same_0", 10],
        ["same_1", 30],
      ] as const) {
        const tickerRow = {
          ...row({ login: "GX195", agentId: customerId }),
          customerId,
        };
        const diagnostics = buildStreamSignalDiagnostics(tickerRow, {
          atMs: 0,
          dod6Book: book,
        });
        expect(diagnostics.dod6Overlay?.clvBps).toBe(expected);
        expect(spine.lookup("GX195", customerId)?.clvBps).toBe(expected);
        const planned = planStreamSignalsForRows([tickerRow], {
          dod6Spine: spine,
        });
        expect(planned[0]?.diagnostics.dod6Overlay?.clvBps).toBe(expected);
      }
      expect(
        buildStreamSignalDiagnostics(
          { ...row({ login: "same_0" }), customerId: "missing" },
          { atMs: 0, dod6Book: book },
        ).dod6Overlay,
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("rejects duplicate exact ids instead of silently overwriting metrics", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "dod6-duplicate-"));
    const path = resolve(dir, "book.json");
    try {
      writeFileSync(
        path,
        JSON.stringify([
          { customer_id: "same_0", clv_bps: 10 },
          { customer_id: "same_0", clv_bps: 20 },
        ]),
      );
      expect(() => loadDod6BookOverlayFromJson(path)).toThrow(
        "duplicate customer id",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
