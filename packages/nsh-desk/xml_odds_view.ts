/**
 * @file packages/nsh-desk/xml_odds_view.ts
 * @description Read model over the hot-path XML odds SoA columns.
 *
 * `src/lib/xml_feed_spine_hydrator.ts` hydrates these columns — three parallel
 * typed arrays, no per-row objects. The shape is declared **structurally here**
 * rather than imported: `nsh check` compiles this package with its own tsconfig
 * (no Bun types, no `allowImportingTsExtensions`), and a single type-only import
 * from `src/` drags `design/domain-branded-types.ts` and the Bun-typed graph into
 * that compile unit and fails it. `tests/xml_odds_view.test.ts` asserts the two
 * shapes stay assignable in both directions, so drift fails in `bun test` where
 * Bun types are available.
 */

export interface XmlOddsFeed {
  readonly capacity: number;
  count: number;
  readonly eventId32Col: Uint32Array;
  readonly packedComboKey15Col: Uint16Array;
  readonly lineHundredthsI32Col: Int32Array;
}

export interface XmlOddsRow {
  /** Position in the columns, not an id. */
  readonly index: number;
  /** `eventId32Col` as an unsigned 32-bit integer. */
  readonly eventId: number;
  /** `packedComboKey15Col`, the 15-bit sport+subSport combo key. */
  readonly comboKey: number;
  /** `lineHundredthsI32Col` as a signed integer of hundredths. */
  readonly lineHundredths: number;
  /** `lineHundredths` rendered as a decimal string, e.g. `3.50`, `-1.10`. */
  readonly line: string;
}

/** Rows present. A store can hold more capacity than it has written. */
export function xmlOddsFeedCount(feed: XmlOddsFeed | null | undefined): number {
  if (feed === null || feed === undefined) return 0;
  return Math.max(0, Math.min(feed.count, feed.capacity));
}

/** Hundredths as a display string without floating point drift. */
export function formatLineHundredths(lineHundredths: number): string {
  const value = Math.trunc(lineHundredths);
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  const whole = Math.trunc(magnitude / 100);
  const fraction = magnitude % 100;
  return `${sign}${whole}.${String(fraction).padStart(2, "0")}`;
}

/**
 * Reads one row. Throws on an out-of-range index rather than returning a row of
 * zeroes, because a zeroed row is indistinguishable from a real event 0.
 */
export function readXmlOddsRow(feed: XmlOddsFeed, index: number): XmlOddsRow {
  const count = xmlOddsFeedCount(feed);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError(
      `ERR_XML_ODDS_ROW_OUT_OF_RANGE: index ${index} outside 0..${count - 1}`,
    );
  }
  const lineHundredths = feed.lineHundredthsI32Col[index] ?? 0;
  return {
    index,
    eventId: feed.eventId32Col[index] ?? 0,
    comboKey: feed.packedComboKey15Col[index] ?? 0,
    lineHundredths,
    line: formatLineHundredths(lineHundredths),
  };
}

/** Column occupancy, for the HUD header line. */
export function xmlOddsFeedSummary(feed: XmlOddsFeed | null | undefined): {
  readonly rows: number;
  readonly capacity: number;
} {
  if (feed === null || feed === undefined) return { rows: 0, capacity: 0 };
  return { rows: xmlOddsFeedCount(feed), capacity: feed.capacity };
}
