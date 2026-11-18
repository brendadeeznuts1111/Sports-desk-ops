/**
 * @file tests/xml_odds_view.test.ts
 * @description Pins the NSH read model over the XML odds SoA columns: index-based
 * reads, no row objects retained, and fail-closed bounds.
 */

import { describe, expect, test } from "bun:test";

import {
  formatLineHundredths,
  readXmlOddsRow,
  xmlOddsFeedCount,
  xmlOddsFeedSummary,
  type XmlOddsFeed,
} from "../packages/nsh-desk/xml_odds_view.ts";
import {
  createXmlOddsFeedColumnStore,
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
      line: "3.50",
    });
    expect(readXmlOddsRow(feed, 1)).toEqual({
      index: 1,
      eventId: 43,
      comboKey: 9,
      lineHundredths: -110,
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

  test("reading a row allocates only the view object, never the columns", () => {
    const feed = createXmlOddsFeedColumnStore(1000);
    feed.count = 1000;
    const before = feed.eventId32Col;
    for (let i = 0; i < 1000; i++) readXmlOddsRow(feed, i);
    expect(feed.eventId32Col).toBe(before);
    expect(feed.eventId32Col.length).toBe(1000);
  });
});
