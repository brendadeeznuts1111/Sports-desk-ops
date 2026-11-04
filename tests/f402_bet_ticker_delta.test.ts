import { describe, expect, test } from "bun:test";

import {
  assertSanitizedTickerArtifact,
  buildF402TickerSnapshot,
  canonicalVolumeCents,
  demuxChannel,
  demuxWagerType,
  deskClock,
  F402_BET_TICKER_CHANNELS,
  highestWagerNumber,
  type F402BetTickerWagerType,
  projectF402TickerDelta,
  sha256Hex,
  stableJson,
  ticketKey,
} from "../lib/f402_bet_ticker_delta.ts";
import type { F402TickerRow } from "../lib/f402_ingest.ts";

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
