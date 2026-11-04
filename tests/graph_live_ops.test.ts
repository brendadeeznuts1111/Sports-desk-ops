/**
 * Live wagers + positions panel helpers.
 *
 * The panel is the only place the portal claims a live transport, so the pure layer is
 * pinned here: provenance never inflates, a fixture row never counts as observed, an
 * unknown bridge frame never renders, and a stale feed can never report "WS LIVE".
 */

import { describe, expect, test } from "bun:test";
import { BRIDGE_WS_TOPICS } from "../services/sportsdesk_webview_server.ts";
import {
  BRIDGE_LABELS,
  LIVE_WS_TOPICS,
  formatAgeMs,
  isObservedSource,
  mergeTape,
  normalizeTickerRow,
  resolveLiveMode,
  summarizeBridgeFrame,
  summarizePendingBets,
  summarizePositions,
} from "../docs/assets/live-ops.js";

const wallet = (overrides: Record<string, unknown> = {}) => ({
  rank: 1,
  proxyWallet: "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
  shortWallet: "0x26cf...c612",
  f402CustomerId: "BGD101",
  agentOwner: "BIGDAD",
  openLegsCount: 14,
  openVolumeUsd: 73300,
  positionsValueUsd: 70100,
  openPnlUsd: -3200,
  openBetsSummary: "KC -1.5 Wk10 ($18K)",
  dataSource: "LIVE",
  lastSyncedIso: "2026-11-04T04:37:53.329Z",
  walletAddressValid: true,
  lastError: null,
  ...overrides,
});

describe("summarizePositions", () => {
  test("aggregates legs/cost/mark/PnL and counts provenance per wallet", () => {
    const summary = summarizePositions([
      wallet(),
      wallet({
        rank: 2,
        shortWallet: "0x07db...fa4f",
        f402CustomerId: "MJ102",
        dataSource: "STALE",
        openLegsCount: 71,
        openVolumeUsd: 8629,
        positionsValueUsd: 9000,
        openPnlUsd: 371,
        lastSyncedIso: "2026-11-03T10:00:00.000Z",
      }),
      wallet({
        rank: 3,
        shortWallet: "0x3aF8...D89D",
        f402CustomerId: "7xBAY",
        dataSource: "FIXTURE",
        openLegsCount: 0,
        openVolumeUsd: 0,
        positionsValueUsd: 0,
        openPnlUsd: 0,
        walletAddressValid: false,
        lastSyncedIso: "2026-11-01T00:00:00.000Z",
      }),
    ]);

    expect(summary.walletCount).toBe(3);
    expect(summary.liveCount).toBe(1);
    expect(summary.staleCount).toBe(1);
    expect(summary.fixtureCount).toBe(1);
    expect(summary.invalidCount).toBe(1);
    expect(summary.openLegs).toBe(85);
    expect(summary.openCostUsd).toBe(81929);
    expect(summary.openValueUsd).toBe(79100);
    expect(summary.openPnlUsd).toBe(-2829);
    expect(summary.latestSyncIso).toBe("2026-11-04T04:37:53.329Z");

    // Sorted by mark value, not by input order.
    expect(summary.rows.map((row) => row.customerId)).toEqual([
      "BGD101",
      "MJ102",
      "7xBAY",
    ]);
    expect(summary.rows[0]?.source).toBe("LIVE");
  });

  test("missing or malformed input yields zeros, never throws", () => {
    for (const input of [undefined, null, [], "nope", {}]) {
      const summary = summarizePositions(input as never);
      expect(summary.walletCount).toBe(0);
      expect(summary.openLegs).toBe(0);
      expect(summary.openValueUsd).toBe(0);
      expect(summary.rows).toEqual([]);
    }
  });

  test("a wallet without a dataSource counts as FIXTURE, not observed", () => {
    const summary = summarizePositions([wallet({ dataSource: undefined })]);
    expect(summary.fixtureCount).toBe(1);
    expect(summary.liveCount).toBe(0);
    expect(isObservedSource(summary.rows[0]!.source)).toBe(false);
  });
});

describe("summarizePendingBets", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    ticketId: "PM-ORD-8801-1Q",
    sourceVenue: "POLYMARKET_SHADOW",
    f402CustomerId: "MJ102",
    agentOwner: "MJ2026",
    canonicalMarket: "NBA_LAL_BOS_1Q_TOTAL_OVER_55.5",
    sportAndPeriod: "NBA • 1Q Total",
    riskUsd: 16200,
    toWinUsd: 18630,
    deskVerdict: "OPENED F402 56.5 (-115) @ T+334ms",
    placedAtUtc: "2026-10-31 14:42:11 UTC",
    lastSyncedUtc: "2026-11-04T04:37:53.329Z",
    ...overrides,
  });

  test("totals risk/to-win, groups venues, and sorts by risk", () => {
    const summary = summarizePendingBets([
      row(),
      row({
        ticketId: "F402-1",
        sourceVenue: "F402_LIVE",
        riskUsd: 500,
        toWinUsd: 400,
        f402CustomerId: "RF2003",
      }),
    ]);
    expect(summary.clusterCount).toBe(2);
    expect(summary.riskUsd).toBe(16700);
    expect(summary.toWinUsd).toBe(19030);
    expect(summary.rows.map((r) => r.ticketId)).toEqual([
      "PM-ORD-8801-1Q",
      "F402-1",
    ]);
    expect(summary.venues[0]).toEqual({
      venue: "POLYMARKET_SHADOW",
      count: 1,
      riskUsd: 16200,
    });
  });

  test("empty input is a zero book, not an error", () => {
    expect(summarizePendingBets(undefined as never)).toEqual({
      clusterCount: 0,
      riskUsd: 0,
      toWinUsd: 0,
      exposureUsd: 0,
      venues: [],
      rows: [],
    });
  });
});

describe("wager tape entries", () => {
  test("normalizeTickerRow keeps identity and falls back to dashes", () => {
    const row = normalizeTickerRow(
      {
        insertedAt: "2026-11-04T04:37:53.329Z",
        login: "MJ102",
        agentLogin: "MJ2026",
        ticketWriter: "1072983884",
        wagerNumber: "1",
        shortDesc: "LAL -3.0",
      },
      7,
    );
    expect(row).toEqual({
      id: "tick|2026-11-04T04:37:53.329Z|MJ102|1072983884|1|7",
      atIso: "2026-11-04T04:37:53.329Z",
      source: "f402-ticker",
      label: "F402 ticker",
      login: "MJ102",
      agent: "MJ2026",
      ticket: "1072983884/1",
      summary: "LAL -3.0",
      kind: "tick",
    });
    expect(normalizeTickerRow(null as never)).toBeNull();
    expect(
      normalizeTickerRow({ insertedAt: "x", login: "", shortDesc: "" } as never)
        ?.ticket,
    ).toBe("—");
  });

  test("summarizeBridgeFrame rejects unknown kinds and summarizes the five topics", () => {
    expect(summarizeBridgeFrame({ kind: "not-a-topic" }, "t")).toBeNull();
    expect(summarizeBridgeFrame(null as never, "t")).toBeNull();

    for (const kind of LIVE_WS_TOPICS) {
      const entry = summarizeBridgeFrame(
        {
          kind,
          deskDate: "2026-11-03",
          generatedAtIso: "2026-11-04T04:37:53.329Z",
          totals: { ticketCount: 22611, legCount: 24778 },
        },
        "2026-11-04T05:00:00.000Z",
      );
      expect(entry).not.toBeNull();
      expect(entry?.source).toBe(kind);
      expect(entry?.label).toBe(BRIDGE_LABELS[kind]);
      expect(entry?.atIso).toBe("2026-11-04T04:37:53.329Z");
      expect(entry?.summary).toContain("2026-11-03");
      expect(entry?.summary).toContain("ticketCount=22611");
    }
  });

  test("summarizeBridgeFrame falls back to join/row counts, then a generic label", () => {
    expect(
      summarizeBridgeFrame(
        {
          kind: "f402-weblog",
          join: { matched: 52116, totalWindowWagers: 62409 },
        },
        "2026-11-04T05:00:00.000Z",
      )?.summary,
    ).toContain("matched=52116/62409");
    expect(
      summarizeBridgeFrame({ kind: "f402-pending" }, "2026-11-04T05:00:00.000Z")
        ?.summary,
    ).toContain("rollup event");
  });

  test("mergeTape dedupes by id, orders newest first, and caps the tape", () => {
    const row = (id: string, atIso: string) => ({
      id,
      atIso,
      source: "test",
      label: "test",
      login: "—",
      agent: "—",
      ticket: "—",
      summary: "row",
      kind: "tick" as const,
    });
    const a = row("a", "2026-11-04T05:00:00.000Z");
    const b = row("b", "2026-11-04T05:01:00.000Z");
    const c = row("c", "2026-11-04T04:59:00.000Z");
    expect(mergeTape([a, b], [b, c], 10).map((r) => r.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(mergeTape([a], [b], 1).map((r) => r.id)).toEqual(["b"]);
    expect(mergeTape([], [null as never, { noId: true } as never], 5)).toEqual(
      [],
    );
  });

  test("formatAgeMs is compact and total", () => {
    expect(formatAgeMs(0)).toBe("0s");
    expect(formatAgeMs(59_000)).toBe("59s");
    expect(formatAgeMs(60_000)).toBe("1m");
    expect(formatAgeMs(3_600_000)).toBe("1h");
    expect(formatAgeMs(86_400_000)).toBe("1d");
    expect(formatAgeMs(Number.NaN)).toBe("—");
    expect(formatAgeMs(-1)).toBe("—");
  });
});

describe("resolveLiveMode", () => {
  test("only a connected socket may say WS LIVE", () => {
    expect(
      resolveLiveMode({ wsState: "connected", feedAgeMs: 60_000 }).label,
    ).toBe("WS LIVE");
    expect(
      resolveLiveMode({ wsState: "polling", feedAgeMs: 60_000 }).label,
    ).toBe("POLL STALE");
  });

  test("fresh poll, stale poll, and unreachable feed are distinct modes", () => {
    expect(
      resolveLiveMode({
        wsState: "polling",
        feedAgeMs: 12_000,
        feedDataMode: "PARTIAL",
      }),
    ).toEqual({
      label: "POLL 15s",
      tone: "emerald",
      detail: "feed PARTIAL · 12s old",
    });
    expect(
      resolveLiveMode({ wsState: "polling", feedAgeMs: 120_000 }).label,
    ).toBe("POLL STALE");
    expect(
      resolveLiveMode({ wsState: "polling", feedAgeMs: 600_000 }).label,
    ).toBe("SNAPSHOT");
    expect(
      resolveLiveMode({ wsState: "offline", feedAgeMs: null }),
    ).toMatchObject({ label: "SNAPSHOT", tone: "rose" });
  });

  test("connecting is neither live nor stale", () => {
    expect(
      resolveLiveMode({ wsState: "connecting", feedAgeMs: 1_000 }),
    ).toMatchObject({ label: "WS CONNECTING", tone: "cyan" });
  });
});

describe("topic contract", () => {
  test("the page's topics are exactly the daemon hub's topics", () => {
    expect(LIVE_WS_TOPICS).toEqual([...BRIDGE_WS_TOPICS]);
    for (const kind of LIVE_WS_TOPICS) {
      expect(BRIDGE_LABELS[kind]).toBeString();
    }
  });
});
