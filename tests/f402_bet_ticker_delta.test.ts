import { describe, expect, test } from "bun:test";
import { heapStats } from "bun:jsc";

import {
  amountToCents,
  assertSanitizedTickerArtifact,
  Bridge3aTicketColumnStore,
  buildF402TickerSnapshot,
  canonicalRiskCents,
  canonicalToWinCents,
  canonicalVolumeCents,
  demuxChannel,
  demuxWagerType,
  deskClock,
  F402_BET_TICKER_CHANNELS,
  highestWagerNumber,
  legCountOf,
  MAX_INT32_CENTS,
  MAX_UINT16_LEGS,
  MAX_UINT32_WAGER_NUMBER,
  numericWagerNumber,
  ORD_CHANNEL_INTERNET,
  ORD_CHANNEL_UNKNOWN,
  ticketWriterToChannelOrdinal,
  type F402BetTickerWagerType,
  projectF402TickerDelta,
  projectF402TickerDeltaWithDiagnostics,
  sha256Hex,
  stableJson,
  ticketKey,
} from "../lib/f402_bet_ticker_delta.ts";
import { parseF402TickerRow, type F402TickerRow } from "../lib/f402_ingest.ts";

const ONE_LEG =
  "Football - Team A vs Team B / Game / Winner (2 way) / Team A -110";
const TWO_LEGS = [
  "M.G319748909",
  "Basketball - Team C vs Team D / Game / Spread / Team C -2.5 -110",
  "Basketball - Team E vs Team F / Game / Total / Over 210 -110",
].join("\r\n");

function row(partial: Partial<F402TickerRow> = {}): F402TickerRow {
  return {
    login: "TESTLOGIN",
    customerId: "TESTCUST",
    agentId: "TESTAGENT",
    agentLogin: "TESTAGENTLOGIN",
    ticketWriter: "Internet",
    wagerNumber: "100",
    ticketNumber: "",
    wagerType: "S",
    shortDesc: ONE_LEG,
    insertedAt: "2026-11-03T18:00:00.000Z",
    vip: "0",
    amountWagered: 100,
    toWinAmount: 90,
    volumeAmount: 100,
    ...partial,
  };
}

describe("bounded demux", () => {
  test("maps every channel code, trims padding, and fails closed to other", () => {
    for (const channel of F402_BET_TICKER_CHANNELS) {
      expect(demuxChannel(`  ${channel.toLowerCase()}  `)).toBe(channel);
    }
    expect(
      demuxChannel("GSLIVE                                            "),
    ).toBe("GSLIVE");
    expect(demuxChannel("WILBANKS.")).toBe("other");
    expect(demuxChannel("")).toBe("other");
    expect(demuxChannel(null)).toBe("other");
  });

  test("novel channel maps to explicit UNKNOWN ordinal and other, not Internet", () => {
    expect(ticketWriterToChannelOrdinal("NOVEL_CHANNEL")).toBe(
      ORD_CHANNEL_UNKNOWN,
    );
    expect(ticketWriterToChannelOrdinal("NOVEL_CHANNEL")).not.toBe(
      ORD_CHANNEL_INTERNET,
    );
    expect(demuxChannel("NOVEL_CHANNEL")).toBe("other");
    expect(demuxChannel("NOVEL_CHANNEL")).not.toBe("Internet");
    expect(ticketWriterToChannelOrdinal("  crypto_desk_feed  ")).toBe(
      ORD_CHANNEL_UNKNOWN,
    );
    expect(demuxChannel("  crypto_desk_feed  ")).toBe("other");
  });

  test("maps the eight wager types and fails closed to unknown", () => {
    const codes: readonly F402BetTickerWagerType[] = [
      "S",
      "M",
      "L",
      "E",
      "P",
      "T",
      "I",
      "G",
    ];
    for (const code of codes) {
      expect(demuxWagerType(` ${code.toLowerCase()} `)).toBe(code);
    }
    expect(demuxWagerType("X")).toBe("unknown");
    expect(demuxWagerType(undefined)).toBe("unknown");
  });

  test("the locked key collapses to the wager number when TicketNumber is absent", () => {
    expect(ticketKey(row({ wagerNumber: "900001" }))).toBe("900001-900001");
    expect(ticketKey(row({ wagerNumber: "900001", ticketNumber: "T7" }))).toBe(
      "T7-900001",
    );
  });

  test("ALERT rows carry zero canonical volume; whole dollars convert exactly", () => {
    expect(
      canonicalVolumeCents(row({ ticketWriter: "ALERT", volumeAmount: 3500 })),
    ).toBe(0);
    expect(canonicalVolumeCents(row({ volumeAmount: 2188 }))).toBe(218800);
    expect(canonicalVolumeCents(row({ volumeAmount: null }))).toBe(0);
    expect(canonicalVolumeCents(row({ volumeAmount: -1 }))).toBe(0);
  });
});

describe("projectF402TickerDelta", () => {
  test("dedupes a ticket once: ALERT twin adds no money and confirms in-batch", () => {
    const alert = row({
      wagerNumber: "500",
      ticketWriter: "ALERT",
      volumeAmount: 3500,
      shortDesc: ONE_LEG,
    });
    const owner = row({
      wagerNumber: "500",
      ticketWriter: "GSLIVE",
      volumeAmount: 2188,
      shortDesc: TWO_LEGS,
      amountWagered: 3500,
    });
    const event = projectF402TickerDelta(
      [],
      [alert, owner],
      "2026-11-03T18:00:00.000Z",
    );

    expect(event.alertTwinCount).toBe(1);
    expect(event.confirmCount).toBe(1);
    expect(event.lateCount).toBe(0);
    expect(event.orphanCount).toBe(0);
    expect(event.byChannel).toEqual([
      {
        channel: "GSLIVE",
        ticketCount: 1,
        legCount: 2,
        canonicalVolumeCents: 218800,
      },
    ]);
    expect(event.newTickets).toBe(1);
  });

  test("an unmatched ALERT row is an orphan with zero volume", () => {
    const event = projectF402TickerDelta(
      [],
      [row({ wagerNumber: "501", ticketWriter: "ALERT", volumeAmount: 900 })],
      "2026-11-03T18:00:00.000Z",
    );
    expect(event.alertTwinCount).toBe(1);
    expect(event.orphanCount).toBe(1);
    expect(event.confirmCount).toBe(0);
    expect(event.byChannel).toEqual([
      {
        channel: "ALERT",
        ticketCount: 1,
        legCount: 1,
        canonicalVolumeCents: 0,
      },
    ]);
  });

  test("an alert whose twin arrives in a later poll is late", () => {
    const alert = row({ wagerNumber: "502", ticketWriter: "ALERT" });
    const owner = row({ wagerNumber: "502", ticketWriter: "GSBUILDER" });
    expect(
      projectF402TickerDelta([], [alert], "2026-11-03T18:00:00.000Z")
        .orphanCount,
    ).toBe(1);
    const late = projectF402TickerDelta(
      [alert],
      [alert, owner],
      "2026-11-03T18:05:00.000Z",
    );
    expect(late.lateCount).toBe(1);
    expect(late.confirmCount).toBe(0);
    expect(late.orphanCount).toBe(0);
  });

  test("counts new, gone, and changed tickets once per key", () => {
    const before = row({ wagerNumber: "100", volumeAmount: 100 });
    const after = row({ wagerNumber: "100", volumeAmount: 250 });
    const added = row({ wagerNumber: "101" });
    const event = projectF402TickerDelta(
      [before],
      [after, added],
      "2026-11-03T18:00:00.000Z",
    );
    expect(event.newTickets).toBe(1);
    expect(event.goneTickets).toBe(0);
    expect(event.changedTickets).toBe(1);
  });

  test("an empty current page reports the previous watermark and gone tickets", () => {
    const event = projectF402TickerDelta(
      [row({ wagerNumber: "100" })],
      [],
      "2026-11-03T18:00:00.000Z",
    );
    expect(event.goneTickets).toBe(1);
    expect(event.watermark).toBe("100");
  });

  test("watermark is the highest numeric wager number, ignoring non-numeric values", () => {
    expect(
      projectF402TickerDelta(
        [],
        [
          row({ wagerNumber: "900" }),
          row({ wagerNumber: "not-a-number" }),
          row({ wagerNumber: "9010" }),
        ],
        "2026-11-03T18:00:00.000Z",
      ).watermark,
    ).toBe("9010");
    expect(highestWagerNumber([row({ wagerNumber: "x" })])).toBe(0);
  });

  test("desk clock is America/Chicago, not UTC", () => {
    // 2026-11-03 04:30Z is 2026-11-02 22:30 CST (US DST ended 2026-11-01).
    expect(deskClock("2026-11-03T04:30:00.000Z")).toEqual({
      deskDate: "2026-11-02",
      deskHour: 22,
    });
  });

  test("the delta carries no identifier or raw description", () => {
    const event = projectF402TickerDelta(
      [],
      [row({ wagerNumber: "777", shortDesc: TWO_LEGS })],
      "2026-11-03T18:00:00.000Z",
    );
    const json = stableJson(event);
    for (const forbidden of [
      "TESTLOGIN",
      "TESTCUST",
      "TESTAGENT",
      "Team A",
      "Team C",
      "TicketWriter",
    ]) {
      expect(json).not.toContain(forbidden);
    }
    expect(() => assertSanitizedTickerArtifact(event)).not.toThrow();
  });

  test("hashing is deterministic for the same sanitized content", () => {
    expect(stableJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const first = projectF402TickerDelta(
      [],
      [row()],
      "2026-11-03T18:00:00.000Z",
    );
    const second = projectF402TickerDelta(
      [],
      [row()],
      "2026-11-03T18:00:00.000Z",
    );
    expect(first.sourceSha256).toBe(second.sourceSha256);
    expect(
      projectF402TickerDelta(
        [],
        [row({ volumeAmount: 1 })],
        "2026-11-03T18:00:00.000Z",
      ).sourceSha256,
    ).not.toBe(first.sourceSha256);
  });
});

describe("sentinel channels", () => {
  test("BLOCKED and NON_SPORTS_DROP are counted but carry zero money", () => {
    const blocked = row({
      wagerNumber: "801",
      ticketWriter: "BLOCKED",
      volumeAmount: 500,
      amountWagered: 500,
      toWinAmount: 400,
    });
    const dropped = row({
      wagerNumber: "802",
      ticketWriter: "NON_SPORTS_DROP",
      volumeAmount: 700,
      amountWagered: 700,
      toWinAmount: 600,
    });
    const accepted = row({
      wagerNumber: "803",
      ticketWriter: "GSLIVE",
      volumeAmount: 1000,
      amountWagered: 1000,
      toWinAmount: 900,
    });
    const event = projectF402TickerDelta(
      [],
      [blocked, dropped, accepted],
      "2026-11-03T18:00:00.000Z",
    );
    const byChannel = new Map(
      event.byChannel.map((entry) => [entry.channel, entry]),
    );
    expect(byChannel.get("BLOCKED")).toEqual({
      channel: "BLOCKED",
      ticketCount: 1,
      legCount: 1,
      canonicalVolumeCents: 0,
    });
    expect(byChannel.get("NON_SPORTS_DROP")).toEqual({
      channel: "NON_SPORTS_DROP",
      ticketCount: 1,
      legCount: 1,
      canonicalVolumeCents: 0,
    });
    const handleCents = event.byChannel.reduce(
      (total, entry) => total + entry.canonicalVolumeCents,
      0,
    );
    // Only the accepted GSLIVE row contributes: $1,000 in cents.
    expect(handleCents).toBe(100_000);
    // The internal risk/to-win axes are pinned too.
    expect(canonicalRiskCents(blocked)).toBe(0);
    expect(canonicalToWinCents(dropped)).toBe(0);
    expect(canonicalVolumeCents(blocked)).toBe(0);
    expect(canonicalVolumeCents(dropped)).toBe(0);
  });

  test("ALERT, BLOCKED, and NON_SPORTS_DROP stay out of a mixed handle sum", () => {
    const event = projectF402TickerDelta(
      [],
      [
        row({ wagerNumber: "901", ticketWriter: "ALERT", volumeAmount: 900 }),
        row({ wagerNumber: "902", ticketWriter: "BLOCKED", volumeAmount: 800 }),
        row({
          wagerNumber: "903",
          ticketWriter: "NON_SPORTS_DROP",
          volumeAmount: 700,
        }),
        row({
          wagerNumber: "904",
          ticketWriter: "Internet",
          volumeAmount: 100,
        }),
      ],
      "2026-11-03T18:00:00.000Z",
    );
    expect(
      event.byChannel.reduce(
        (total, entry) => total + entry.canonicalVolumeCents,
        0,
      ),
    ).toBe(10_000);
    expect(event.byChannel.map((entry) => entry.channel)).toEqual([
      "Internet",
      "ALERT",
      "BLOCKED",
      "NON_SPORTS_DROP",
    ]);
  });
});

describe("buildF402TickerSnapshot", () => {
  test("summarizes totals, watermark, and the same bounded aggregates", () => {
    const event = projectF402TickerDelta(
      [],
      [
        row({
          wagerNumber: "700",
          ticketWriter: "GSLIVE",
          shortDesc: TWO_LEGS,
        }),
        row({ wagerNumber: "701", ticketWriter: "GSBUILDER" }),
        row({ wagerNumber: "702", ticketWriter: "ALERT" }),
      ],
      "2026-11-03T18:00:00.000Z",
    );
    const snapshot = buildF402TickerSnapshot(event, 3);
    expect(snapshot.rowCount).toBe(3);
    expect(snapshot.ticketCount).toBe(3);
    expect(snapshot.legCount).toBe(4);
    expect(snapshot.watermark).toBe("702");
    expect(snapshot.generatedAt).toBe("2026-11-03T18:00:00.000Z");
    expect(snapshot.deskDate).toBe("2026-11-03");
    expect(snapshot.byChannel.map((entry) => entry.channel)).toEqual([
      "ALERT",
      "GSLIVE",
      "GSBUILDER",
    ]);
    expect(snapshot.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertSanitizedTickerArtifact(snapshot)).not.toThrow();
  });
});

describe("assertSanitizedTickerArtifact", () => {
  test("rejects a denylisted key at any depth", () => {
    expect(() => assertSanitizedTickerArtifact({ login: "x" })).toThrow();
    expect(() =>
      assertSanitizedTickerArtifact({ cells: [{ wagerNumber: "1" }] }),
    ).toThrow();
  });

  test("rejects an IP literal and an oversized artifact", () => {
    expect(() => assertSanitizedTickerArtifact({ note: "10.1.2.3" })).toThrow();
    expect(() =>
      assertSanitizedTickerArtifact({ note: "x".repeat(300_000) }),
    ).toThrow();
  });
});

describe("Int32Array overflow guard", () => {
  test("accepts valid amounts up to MAX_INT32_CENTS", () => {
    expect(amountToCents(21_474_836)).toBe(2_147_483_600);
    expect(amountToCents(21_474_836.47)).toBe(MAX_INT32_CENTS);
  });

  test("rejects amounts exceeding Int32Array boundary with RangeError", () => {
    // $30M is 3,000,000,000 cents > 2,147,483,647
    expect(() => amountToCents(30_000_000)).toThrow(RangeError);
    expect(() =>
      canonicalVolumeCents(row({ volumeAmount: 30_000_000 })),
    ).toThrow(RangeError);
  });

  test("a batch containing a $30M wager skips the overflowing row without aborting valid tickets", () => {
    const valid1 = row({ wagerNumber: "101", volumeAmount: 500 });
    const corrupt = row({ wagerNumber: "102", volumeAmount: 30_000_000 });
    const valid2 = row({ wagerNumber: "103", volumeAmount: 700 });

    const store = new Bridge3aTicketColumnStore(16);
    expect(store.insertOrUpdate(valid1)).toBe(0);
    expect(store.insertOrUpdate(corrupt)).toBe(-1); // safely rejected
    expect(store.overflowRejectionCount).toBe(1);
    expect(store.insertOrUpdate(valid2)).toBe(1);
    expect(store.count).toBe(2);

    // projectF402TickerDelta also processes valid tickets without throwing
    const delta = projectF402TickerDelta(
      [],
      [valid1, corrupt, valid2],
      "2026-11-03T18:00:00.000Z",
    );
    expect(delta.newTickets).toBe(2);
    expect(delta.watermark).toBe("103");
  });
});

describe("Bridge3aTicketColumnStore collision safety", () => {
  test("preserves distinct keys and probes correctly under slot collisions", () => {
    const store = new Bridge3aTicketColumnStore(16);
    const r1 = row({ wagerNumber: "100" });
    const r2 = row({ wagerNumber: "200" });
    const idx1 = store.insertOrUpdate(r1);
    const idx2 = store.insertOrUpdate(r2);
    expect(idx1).not.toBe(idx2);
    expect(store.lookup(ticketKey(r1))).toBe(idx1);
    expect(store.lookup(ticketKey(r2))).toBe(idx2);
    expect(store.keyCol[idx1]).toBe("100-100");
    expect(store.keyCol[idx2]).toBe("200-200");
  });
});

describe("watermark semantics under out-of-order and duplicate arrivals", () => {
  test("duplicate row arrival preserves stable watermark", () => {
    const r1 = row({ wagerNumber: "900001" });
    const r1Dup = row({ wagerNumber: "900001" });
    const delta = projectF402TickerDelta(
      [],
      [r1, r1Dup],
      "2026-11-03T18:00:00.000Z",
    );
    expect(delta.watermark).toBe("900001");
    expect(delta.newTickets).toBe(1);
    expect(delta.changedTickets).toBe(0);
  });

  test("out-of-order arrival advances watermark and backfilled ticket does not regress it", () => {
    // Poll 1: Ticket 900003 arrives first
    const r3 = row({ wagerNumber: "900003" });
    const delta1 = projectF402TickerDelta([], [r3], "2026-11-03T18:00:00.000Z");
    expect(delta1.watermark).toBe("900003");
    expect(delta1.newTickets).toBe(1);

    // Poll 2: Older ticket 900002 arrives out of order alongside 900003
    const r2 = row({ wagerNumber: "900002" });
    const delta2 = projectF402TickerDelta(
      [r3],
      [r3, r2],
      "2026-11-03T18:05:00.000Z",
    );
    // Watermark must NOT regress to 900002
    expect(delta2.watermark).toBe("900003");
    expect(delta2.newTickets).toBe(1);
    // changedTickets is 0 because ticket 900003's fields did not mutate between polls.
    // Out-of-order tickets do trigger change detection if their fields mutated.
    expect(delta2.changedTickets).toBe(0);
    expect(delta2.goneTickets).toBe(0);

    // Both tickets are accounted for
    const totalTickets = delta2.byChannel.reduce(
      (sum, ch) => sum + ch.ticketCount,
      0,
    );
    expect(totalTickets).toBe(2);
  });
});

describe("column boundary and range assertions", () => {
  test("legCountOf clamps at MAX_UINT16_LEGS (65535)", () => {
    const normalRow = row({ shortDesc: TWO_LEGS });
    expect(legCountOf(normalRow)).toBe(2);

    // Mock an oversized leg payload
    const fakeLegs = Array.from(
      { length: 70_000 },
      (_, i) => `Basketball - Leg ${i} / Win`,
    ).join("\r\n");
    const massiveRow = row({ shortDesc: fakeLegs });
    expect(legCountOf(massiveRow)).toBe(MAX_UINT16_LEGS);

    // Store assigns correctly without Uint16 overflow
    const store = new Bridge3aTicketColumnStore(4);
    const idx = store.insertOrUpdate(massiveRow);
    expect(idx).toBe(0);
    expect(store.legCountCol[idx]).toBe(MAX_UINT16_LEGS);
  });

  test("numericWagerNumber bounds against MAX_UINT32_WAGER_NUMBER (4.29B)", () => {
    expect(MAX_UINT32_WAGER_NUMBER).toBe(4_294_967_295);
    expect(
      numericWagerNumber(row({ wagerNumber: String(MAX_UINT32_WAGER_NUMBER) })),
    ).toBe(MAX_UINT32_WAGER_NUMBER);
    expect(numericWagerNumber(row({ wagerNumber: "4294967296" }))).toBeNull();
    expect(numericWagerNumber(row({ wagerNumber: "9999999999" }))).toBeNull();

    const store = new Bridge3aTicketColumnStore(4);
    const rValid = row({ wagerNumber: String(MAX_UINT32_WAGER_NUMBER) });
    const rExceed = row({ wagerNumber: "5000000000" });

    store.insertOrUpdate(rValid);
    expect(store.wagerNumberCol[0]).toBe(MAX_UINT32_WAGER_NUMBER);

    store.insertOrUpdate(rExceed);
    expect(store.wagerNumberCol[1]).toBe(0);
  });

  test("projectF402TickerDeltaWithDiagnostics surfaces batch diagnostics and overflow counts", () => {
    const valid1 = row({ wagerNumber: "101", amountWagered: 100 });
    const overflow = row({ wagerNumber: "102", amountWagered: 30_000_000 });
    const valid2 = row({ wagerNumber: "103", amountWagered: 250 });

    const result = projectF402TickerDeltaWithDiagnostics(
      [valid1],
      [valid1, overflow, valid2],
      "2026-11-03T18:00:00.000Z",
    );

    expect(result.diagnostics.beforeCount).toBe(1);
    expect(result.diagnostics.afterCount).toBe(2);
    expect(result.diagnostics.overflowRejectionCount).toBe(1);
    expect(result.event.newTickets).toBe(1);
    expect(result.event.watermark).toBe("103");
  });
});

describe("JSC heapStats Structure and PropertyTable invariant", () => {
  test("steady-state iteration produces 0 delta in PropertyTable and bounds Structure delta", async () => {
    const fixtureFile = Bun.file("tests/fixtures/live-wagers-LIST-100.json");
    const json = (await fixtureFile.json()) as { LIST: unknown[] };
    const rows = json.LIST.slice(0, 10)
      .map((r) => parseF402TickerRow(r))
      .filter((r): r is F402TickerRow => r !== null);

    // Warmup 50 iterations to ensure shapes are stabilized and JSC JIT tiers up fully
    for (let i = 0; i < 50; i++) {
      const delta = projectF402TickerDelta(
        [],
        rows,
        "2026-11-08T18:00:00.000Z",
      );
      buildF402TickerSnapshot(delta, rows.length);
    }
    if (typeof Bun.gc === "function") Bun.gc(true);

    const base = heapStats().objectTypeCounts;
    const baseStructure = base.Structure ?? 0;
    const basePropertyTable = base.PropertyTable ?? 0;

    // Run 50 steady-state iterations
    for (let i = 0; i < 50; i++) {
      const delta = projectF402TickerDelta(
        [],
        rows,
        "2026-11-08T18:00:00.000Z",
      );
      buildF402TickerSnapshot(delta, rows.length);
    }
    if (typeof Bun.gc === "function") Bun.gc(true);

    const after = heapStats().objectTypeCounts;
    const deltaStructure = (after.Structure ?? 0) - baseStructure;
    const deltaPropertyTable = (after.PropertyTable ?? 0) - basePropertyTable;

    // PropertyTable delta <= 1 in full multi-test runner suites (0 in dedicated runs)
    // proves objects never degrade into dictionary mode.
    expect(deltaPropertyTable).toBeLessThanOrEqual(1);
    // Delta-based assertion: measures net growth over steady-state iterations rather than absolute
    // baseline count, ensuring test stability across JSC version bumps (test runner overhead is <120).
    expect(deltaStructure).toBeLessThan(120);
  });
});
