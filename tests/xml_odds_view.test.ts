/**
 * @file tests/xml_odds_view.test.ts
 * @description Pins the NSH read model over the XML odds SoA columns: index-based
 * reads, no row objects retained, and fail-closed bounds.
 */

import { describe, expect, test } from "bun:test";

import {
  createXmlOddsArena,
  formatLineHundredths,
  hydrateCompactXmlDocIntoArena,
  isXmlOddsLineUnknown,
  loadXmlOddsSoaFeed,
  readXmlOddsRow,
  xmlOddsFeedCount,
  xmlOddsFeedSummary,
  xmlOddsRowsHeader,
  xmlOddsUnknownLineCount,
  type XmlOddsFeed,
} from "../packages/nsh-desk/xml_odds_view.ts";
import {
  createXmlOddsFeedColumnStore,
  hydrateXmlOddsFeedIntoSoA,
  type XmlOddsFeedColumnStore,
} from "../src/lib/xml_feed_spine_hydrator.ts";

describe("xml odds SoA read model", () => {
  test("the local column shape and the hydrator's store stay mutually assignable", () => {
    // `nsh check` cannot import src/ (no Bun types), so the shape is structural
    // here. This is the guard that keeps the two definitions from drifting.
    const store = createXmlOddsFeedColumnStore(2);
    const asView: XmlOddsFeed = store;
    expect(asView.capacity).toBe(2);
    expect(asView.eventId32Col).toBeInstanceOf(Uint32Array);
    const backToStore: XmlOddsFeedColumnStore = asView;
    expect(backToStore.packedComboKey15Col).toBeInstanceOf(Uint16Array);
    expect(backToStore.lineHundredthsI32Col).toBeInstanceOf(Int32Array);
  });

  test("reads rows by index from the typed arrays", () => {
    const feed = createXmlOddsFeedColumnStore(4);
    feed.eventId32Col[0] = 42;
    feed.packedComboKey15Col[0] = 0b1_0101_0011;
    feed.lineHundredthsI32Col[0] = 350;
    feed.eventId32Col[1] = 43;
    feed.packedComboKey15Col[1] = 9;
    feed.lineHundredthsI32Col[1] = -110;
    feed.count = 2;

    expect(readXmlOddsRow(feed, 0)).toEqual({
      index: 0,
      eventId: 42,
      comboKey: 0b1_0101_0011,
      lineHundredths: 350,
      lineKnown: true,
      line: "3.50",
    });
    expect(readXmlOddsRow(feed, 1)).toEqual({
      index: 1,
      eventId: 43,
      comboKey: 9,
      lineHundredths: -110,
      lineKnown: true,
      line: "-1.10",
    });
  });

  test("count is clamped to written rows, not capacity", () => {
    const feed = createXmlOddsFeedColumnStore(8);
    feed.count = 3;
    expect(xmlOddsFeedCount(feed)).toBe(3);
    expect(xmlOddsFeedSummary(feed)).toEqual({ rows: 3, capacity: 8 });
    // A count above capacity cannot happen through the hydrator, but a corrupt
    // value must not make the reader walk past the arrays.
    feed.count = 99;
    expect(xmlOddsFeedCount(feed)).toBe(8);
  });

  test("an out-of-range index throws instead of returning a zeroed row", () => {
    const feed = createXmlOddsFeedColumnStore(4);
    feed.count = 1;
    expect(() => readXmlOddsRow(feed, 1)).toThrow(
      /ERR_XML_ODDS_ROW_OUT_OF_RANGE/,
    );
    expect(() => readXmlOddsRow(feed, -1)).toThrow(
      /ERR_XML_ODDS_ROW_OUT_OF_RANGE/,
    );
    expect(() => readXmlOddsRow(feed, 1.5)).toThrow(
      /ERR_XML_ODDS_ROW_OUT_OF_RANGE/,
    );
    // Event 0 is a legal row, which is why bounds cannot be inferred from values.
    expect(readXmlOddsRow(feed, 0).eventId).toBe(0);
  });

  test("an absent feed reads as empty", () => {
    expect(xmlOddsFeedCount(null)).toBe(0);
    expect(xmlOddsFeedCount(undefined)).toBe(0);
    expect(xmlOddsFeedSummary(null)).toEqual({ rows: 0, capacity: 0 });
  });

  test("formatLineHundredths avoids floating point and keeps two places", () => {
    for (const [input, expected] of [
      [0, "0.00"],
      [5, "0.05"],
      [350, "3.50"],
      [-110, "-1.10"],
      [-5, "-0.05"],
      [12345, "123.45"],
    ] as const) {
      expect(formatLineHundredths(input)).toBe(expected);
    }
  });

  test("a price-shaped @line hydrates as unknown, never as a scaled price", () => {
    // The hydrator does not store a moneyline price (`-110`) as a line (`-11000`); the row
    // is kept and flagged, so the table renders the placeholder instead of a fabricated line.
    const store = createXmlOddsFeedColumnStore(2);
    const written = hydrateXmlOddsFeedIntoSoA(
      new TextEncoder().encode(
        '<feed><event id="7" sport="FOOTBALL" subSport="NFL" line="-110"/><event id="8" sport="BASKETBALL" subSport="NBA" line="-3.5"/></feed>',
      ),
      store,
      (sport, sub) => (sport === "FOOTBALL" && sub === "NFL" ? 1 : 3),
    );
    expect(written).toBe(2);
    expect(store.malformedLineCount).toBe(1);

    const feed: XmlOddsFeed = store;
    expect(isXmlOddsLineUnknown(feed, 0)).toBe(true);
    expect(isXmlOddsLineUnknown(feed, 1)).toBe(false);
    expect(xmlOddsUnknownLineCount(feed)).toBe(1);
    expect(readXmlOddsRow(feed, 0)).toMatchObject({
      eventId: 7,
      lineHundredths: 0,
      lineKnown: false,
      line: "—",
    });
    expect(readXmlOddsRow(feed, 1)).toMatchObject({
      eventId: 8,
      lineHundredths: -350,
      lineKnown: true,
      line: "-3.50",
    });
    expect(xmlOddsRowsHeader(feed)).toBe("2 rows · 1 line unit-unconfirmed");
  });

  test("reading a row allocates only the view object, never the columns", () => {
    const feed = createXmlOddsFeedColumnStore(1000);
    feed.count = 1000;
    const before = feed.eventId32Col;
    for (let i = 0; i < 1000; i++) readXmlOddsRow(feed, i);
    expect(feed.eventId32Col).toBe(before);
    expect(feed.eventId32Col.length).toBe(1000);
  });

  test("hydrateCompactXmlDocIntoArena packs Bun.XML compact feed into pre-allocated columns", () => {
    const arena = createXmlOddsArena(4);
    const written = hydrateCompactXmlDocIntoArena(
      {
        feed: {
          event: [
            { "@id": "42", "@comboKey": "17", "@line": "3.5" },
            { "@id": "43", "@wagerType": "2", "@line": "-1.10" },
          ],
        },
      },
      arena,
    );
    expect(written).toBe(2);
    expect(arena.count).toBe(2);
    expect(readXmlOddsRow(arena, 0)).toEqual({
      index: 0,
      eventId: 42,
      comboKey: 17,
      lineHundredths: 350,
      lineKnown: true,
      line: "3.50",
    });
    expect(readXmlOddsRow(arena, 1)).toEqual({
      index: 1,
      eventId: 43,
      comboKey: 2,
      lineHundredths: -110,
      lineKnown: true,
      line: "-1.10",
    });
  });

  test("hydrateCompactXmlDocIntoArena fails closed on capacity overflow", () => {
    const arena = createXmlOddsArena(1);
    expect(() =>
      hydrateCompactXmlDocIntoArena(
        {
          feed: {
            event: [
              { "@id": "1", "@line": "1.0" },
              { "@id": "2", "@line": "2.0" },
            ],
          },
        },
        arena,
      ),
    ).toThrow("ERR_DOD_CSR_CONSERVATION_BREACH");
    // A rejected frame must not leave a committed prefix in the arena.
    expect(arena.count).toBe(0);
    expect(arena.eventId32Col[0]).toBe(0);
  });

  test("hydrateCompactXmlDocIntoArena keeps the @line tri-state (no -11000 scaling)", () => {
    const arena = createXmlOddsArena(4);
    const written = hydrateCompactXmlDocIntoArena(
      {
        feed: {
          event: [
            { "@id": "1", "@comboKey": "3", "@line": "-110" },
            { "@id": "2", "@comboKey": "4", "@line": "48" },
            { "@id": "3", "@comboKey": "5", "@line": "-3.5" },
          ],
        },
      },
      arena,
    );
    expect(written).toBe(3);
    expect(arena.lineUnknownCount).toBe(2);
    expect(isXmlOddsLineUnknown(arena, 0)).toBe(true);
    expect(isXmlOddsLineUnknown(arena, 1)).toBe(true);
    expect(isXmlOddsLineUnknown(arena, 2)).toBe(false);
    // The old scaling (`-110` -> `-11000`) is gone: the column keeps the 0 sentinel.
    expect(arena.lineHundredthsI32Col[0]).toBe(0);
    expect(arena.lineHundredthsI32Col[1]).toBe(0);
    expect(readXmlOddsRow(arena, 0).line).toBe("—");
    expect(readXmlOddsRow(arena, 1).line).toBe("—");
    expect(readXmlOddsRow(arena, 2).line).toBe("-3.50");
    // An all-known arena writes no flags and counts no unknown lines.
    const knownArena = createXmlOddsArena(1);
    hydrateCompactXmlDocIntoArena(
      { feed: { event: { "@id": "9", "@line": "3.5" } } },
      knownArena,
    );
    expect(knownArena.lineUnknownCount).toBe(0);
    expect(xmlOddsUnknownLineCount(knownArena)).toBe(0);
    expect(xmlOddsRowsHeader(knownArena)).toBe("1 row");
  });

  test("a legacy arena with no lineUnknown fields reads as all known", () => {
    const knownOnly: XmlOddsFeed = {
      capacity: 2,
      count: 2,
      eventId32Col: new Uint32Array([1, 2]),
      packedComboKey15Col: new Uint16Array([3, 4]),
      lineHundredthsI32Col: new Int32Array([350, -110]),
    };
    expect(isXmlOddsLineUnknown(knownOnly, 0)).toBe(false);
    expect(xmlOddsUnknownLineCount(knownOnly)).toBe(0);
    expect(readXmlOddsRow(knownOnly, 0)).toMatchObject({
      lineKnown: true,
      line: "3.50",
    });
    expect(xmlOddsRowsHeader(knownOnly)).toBe("2 rows");
  });
});

describe("xml odds SoA provenance cache flags", () => {
  const body = (flags: Record<string, unknown> = {}) => ({
    success: true,
    rowCount: 2,
    eventId32: [11, 12],
    comboKey15: [1101, 2050],
    lineHundredths: [350, -110],
    watermarkCursor: "wm-9",
    generatedAt: "2023-11-14T22:13:20.123Z",
    basis: "r2-xml-ingest",
    ...flags,
  });

  const load = async (flags: Record<string, unknown> = {}) =>
    loadXmlOddsSoaFeed("http://127.0.0.1:4020", async () =>
      Response.json(body(flags)),
    );

  test("a cached read is stated, and does not change the rows", async () => {
    const loaded = await load({ cached: true, stale: false });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.provenance.cached).toBe(true);
    expect(loaded.provenance.stale).toBe(false);
    expect(Array.from(loaded.feed.eventId32Col)).toEqual([11, 12]);
  });

  test("a stale read is stated, and the rows are the last good ones", async () => {
    const loaded = await load({ cached: true, stale: true });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.provenance.stale).toBe(true);
    expect(loaded.feed.count).toBe(2);
  });

  test("an absent flag reads as a fresh, non-stale read", async () => {
    const loaded = await load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.provenance).toEqual({
      basis: "r2-xml-ingest",
      generatedAt: "2023-11-14T22:13:20.123Z",
      watermarkCursor: "wm-9",
      rowCount: 2,
      cached: false,
      stale: false,
    });
  });

  test("a non-boolean flag is a rejected payload, not a silent coercion", async () => {
    const loaded = await load({ stale: "yes" });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.code).toBe("invalid_payload");
    expect(loaded.reason).toContain("stale is not a boolean");
  });
});
