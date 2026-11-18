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

import {
  parseXmlOddsSoaPayload,
  type ParsedXmlOddsSoaPayload,
} from "./desk_model";

export interface XmlOddsFeed {
  readonly capacity: number;
  count: number;
  readonly eventId32Col: Uint32Array;
  readonly packedComboKey15Col: Uint16Array;
  readonly lineHundredthsI32Col: Int32Array;
  /**
   * Dense bit per row (`Uint32Array` bitset): 1 = that row's line unit is UNKNOWN.
   * Mirrors `XmlOddsFeedColumnStore.lineUnknownFlags`; optional, and an absent bitset
   * means every row is known (a store/route body written before the tri-state contract).
   */
  readonly lineUnknownFlags?: Uint32Array;
  /** Rows whose line unit is unknown; optional, absent means all known. */
  lineUnknownCount?: number;
}

export interface XmlOddsRow {
  /** Position in the columns, not an id. */
  readonly index: number;
  /** `eventId32Col` as an unsigned 32-bit integer. */
  readonly eventId: number;
  /** `packedComboKey15Col`, the 15-bit sport+subSport combo key. */
  readonly comboKey: number;
  /** `lineHundredthsI32Col` as a signed integer of hundredths (0 for an unknown line). */
  readonly lineHundredths: number;
  /** Whether the line unit is known; false when `line` is the placeholder. */
  readonly lineKnown: boolean;
  /** `lineHundredths` rendered as a decimal string, e.g. `3.50`, `-1.10`; `—` when unknown. */
  readonly line: string;
}

/** Placeholder for a row whose line unit cannot be deduced; never a fabricated number. */
export const XML_ODDS_UNKNOWN_LINE = "—";

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

/** True when row `rowIndex` was classified with an UNKNOWN line (mirror of the hydrator). */
export function isXmlOddsLineUnknown(
  feed: XmlOddsFeed,
  rowIndex: number,
): boolean {
  const flags = feed.lineUnknownFlags;
  if (flags === undefined) return false;
  const word = flags[rowIndex >>> 5];
  if (word === undefined) return false;
  return (word & (1 << (rowIndex & 31))) !== 0;
}

/**
 * The feed's unknown-line count: the declared count when the producer stated it, else the
 * flags count over the written rows. 0 for a feed written before the tri-state contract.
 */
export function xmlOddsUnknownLineCount(
  feed: XmlOddsFeed | null | undefined,
): number {
  if (feed === null || feed === undefined) return 0;
  const declared = feed.lineUnknownCount;
  if (typeof declared === "number" && Number.isInteger(declared)) {
    return Math.max(0, Math.min(declared, xmlOddsFeedCount(feed)));
  }
  const flags = feed.lineUnknownFlags;
  if (flags === undefined) return 0;
  let count = 0;
  const rows = xmlOddsFeedCount(feed);
  for (let index = 0; index < rows; index += 1) {
    if (isXmlOddsLineUnknown(feed, index)) count += 1;
  }
  return count;
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
  const lineKnown = !isXmlOddsLineUnknown(feed, index);
  return {
    index,
    eventId: feed.eventId32Col[index] ?? 0,
    comboKey: feed.packedComboKey15Col[index] ?? 0,
    lineHundredths,
    lineKnown,
    line: lineKnown
      ? formatLineHundredths(lineHundredths)
      : XML_ODDS_UNKNOWN_LINE,
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

/** Row views a table materialises; a larger feed is cut to this many. */
export const XML_ODDS_ROW_LIMIT = 2000;

/**
 * Header line for a row view: the row count (or the truncation it shows), plus the
 * unknown-line count whose unit is unconfirmed. No suffix when every line is known.
 */
export function xmlOddsRowsHeader(
  feed: XmlOddsFeed | null | undefined,
): string {
  const rows = xmlOddsFeedCount(feed);
  const base =
    rows > XML_ODDS_ROW_LIMIT
      ? `Showing first ${XML_ODDS_ROW_LIMIT} of ${rows}`
      : `${rows} ${rows === 1 ? "row" : "rows"}`;
  const unknown = xmlOddsUnknownLineCount(feed);
  if (unknown === 0) return base;
  return `${base} · ${unknown} ${unknown === 1 ? "line" : "lines"} unit-unconfirmed`;
}

/**
 * Materialises the row views for a table input, in column order and bounded to
 * `XML_ODDS_ROW_LIMIT` objects, so an oversized feed cannot allocate one row
 * object per row it holds.
 */
export function xmlOddsRows(
  feed: XmlOddsFeed | null | undefined,
): XmlOddsRow[] {
  const rows = Math.min(xmlOddsFeedCount(feed), XML_ODDS_ROW_LIMIT);
  const out: XmlOddsRow[] = [];
  if (feed === null || feed === undefined) return out;
  for (let index = 0; index < rows; index++) {
    out.push(readXmlOddsRow(feed, index));
  }
  return out;
}

/** Pre-allocated in-memory TypedArray arena for hot-path XML odds rows. */
export function createXmlOddsArena(capacity: number): XmlOddsFeed {
  if (!Number.isInteger(capacity) || capacity < 0) {
    throw new Error("ERR_DOD_CSR_CONSERVATION_BREACH: invalid capacity");
  }
  return {
    capacity,
    count: 0,
    eventId32Col: new Uint32Array(capacity),
    packedComboKey15Col: new Uint16Array(capacity),
    lineHundredthsI32Col: new Int32Array(capacity),
    lineUnknownFlags: new Uint32Array(Math.ceil(capacity / 32)),
    lineUnknownCount: 0,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Plain decimal literal: optional sign, digits, an optional fraction (never exponent). */
const LEGACY_DECIMAL_LINE_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** An integer-valued legacy `@line` at or above this magnitude has no deducible unit. */
const LEGACY_LINE_UNKNOWN_INTEGER_MIN_ABS = 20;

interface LegacyParsedLine {
  readonly hundredths: number;
  readonly unknown: boolean;
}

/**
 * Legacy compact `@line` → integer hundredths, with the same tri-state as `parseLine` in
 * src/lib/xml_feed_spine_hydrator.ts: a blank, non-decimal, non-finite, Int32-unrepresentable,
 * or ambiguous integer-valued (`-110`, `48`) value is UNKNOWN — it keeps the 0 sentinel and is
 * flagged, never scaled into a fabricated `-11000`.
 */
function parseLegacyLine(raw: unknown): LegacyParsedLine {
  const text = String(raw ?? "").trim();
  if (text === "") return { hundredths: 0, unknown: true };
  if (!LEGACY_DECIMAL_LINE_LITERAL.test(text)) {
    return { hundredths: 0, unknown: true };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return { hundredths: 0, unknown: true };
  if (
    Number.isInteger(value) &&
    Math.abs(value) >= LEGACY_LINE_UNKNOWN_INTEGER_MIN_ABS
  ) {
    return { hundredths: 0, unknown: true };
  }
  const hundredths = Math.round(value * 100);
  if (
    !Number.isSafeInteger(hundredths) ||
    hundredths < -0x8000_0000 ||
    hundredths > 0x7fff_ffff
  ) {
    return { hundredths: 0, unknown: true };
  }
  return { hundredths, unknown: false };
}

/**
 * Hydrates a compact `Bun.XML.parse` / `/api/parse-xml` document (`feed.event`)
 * into an existing `XmlOddsFeed` arena without allocating `Map`/`Set` or row objects.
 */
export function hydrateCompactXmlDocIntoArena(
  doc: unknown,
  target: XmlOddsFeed,
): number {
  if (!isPlainRecord(doc) || !isPlainRecord(doc["feed"])) return 0;
  const rawEvent = doc["feed"]["event"];
  const events = Array.isArray(rawEvent)
    ? rawEvent.filter(isPlainRecord)
    : isPlainRecord(rawEvent)
      ? [rawEvent]
      : [];
  if (events.length === 0) return 0;

  // Pre-check the whole frame: a frame that cannot fit must leave `count` and every
  // column untouched instead of committing a prefix before throwing (same contract as
  // hydrateXmlOddsFeedIntoSoA in src/lib/xml_feed_spine_hydrator.ts).
  if (events.length > target.capacity - target.count) {
    throw new Error("ERR_DOD_CSR_CONSERVATION_BREACH");
  }

  let written = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    const line = parseLegacyLine(ev["@line"]);
    const slot = target.count++;
    target.eventId32Col[slot] = Number(ev["@id"] ?? 0) >>> 0;
    target.packedComboKey15Col[slot] =
      Number(ev["@comboKey"] ?? ev["@wagerType"] ?? 0) & 0x7fff;
    target.lineHundredthsI32Col[slot] = line.hundredths;
    if (line.unknown) {
      target.lineUnknownCount = (target.lineUnknownCount ?? 0) + 1;
      const flags = target.lineUnknownFlags;
      if (flags !== undefined) {
        const wordIndex = slot >>> 5;
        flags[wordIndex] = (flags[wordIndex] ?? 0) | (1 << (slot & 31));
      }
    }
    written++;
  }
  return written;
}

/** The daemon route the desk loader reads (producer: services/sportsdesk_webview_server.ts). */
export const XML_ODDS_SOA_PATH = "/api/xml-odds/soa";
const XML_ODDS_SOA_TIMEOUT_MS = 5_000;

/** Provenance the panel states for the rendered columns. */
export interface XmlOddsSoaProvenance {
  readonly basis: string;
  readonly generatedAt: string;
  readonly watermarkCursor: string;
  readonly rowCount: number;
}

export type XmlOddsSoaLoadResult =
  | {
      readonly ok: true;
      readonly feed: XmlOddsFeed;
      readonly provenance: XmlOddsSoaProvenance;
    }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/** Injectable for tests (a mocked fetch); the store passes Bun's `fetch`. */
export type XmlOddsSoaFetcher = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<Response>;

/** The route's failure body names the reason; keep it instead of an HTTP status alone. */
function xmlOddsSoaFailureReason(status: number, bodyText: string): string {
  try {
    const body: unknown = JSON.parse(bodyText);
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const error = (body as Record<string, unknown>)["error"];
      if (typeof error === "string" && error.trim() !== "") {
        return error.trim();
      }
    }
  } catch {
    // A non-JSON failure body is only a status; fall through to the HTTP reason.
  }
  return `GET ${XML_ODDS_SOA_PATH} failed: HTTP ${status}`;
}

/**
 * Loads the XML odds SoA snapshot from the daemon route into the view's typed arrays.
 *
 * The route is the producer: it parses the canonical R2 chunk and returns the columns plus their
 * provenance, or a non-2xx body whose `error` is the measured reason (missing manifest/chunk,
 * malformed chunk). This never invents rows on failure.
 */
export async function loadXmlOddsSoaFeed(
  origin: string,
  fetchImpl: XmlOddsSoaFetcher = (url, init) => fetch(url, init),
  timeoutMs = XML_ODDS_SOA_TIMEOUT_MS,
): Promise<XmlOddsSoaLoadResult> {
  const base = origin.replace(/\/+$/, "");
  const url = `${base}${XML_ODDS_SOA_PATH}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "fetch_failed",
      reason: `GET ${XML_ODDS_SOA_PATH} failed: ${message}`,
    };
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return {
      ok: false,
      code: `http_${response.status}`,
      reason: xmlOddsSoaFailureReason(response.status, bodyText),
    };
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return {
      ok: false,
      code: "invalid_json",
      reason: `GET ${XML_ODDS_SOA_PATH} returned invalid JSON`,
    };
  }
  let parsed: ParsedXmlOddsSoaPayload;
  try {
    parsed = parseXmlOddsSoaPayload(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "invalid_payload", reason: message };
  }
  return {
    ok: true,
    feed: {
      capacity: parsed.rowCount,
      count: parsed.rowCount,
      eventId32Col: parsed.eventId32Col,
      packedComboKey15Col: parsed.comboKey15Col,
      lineHundredthsI32Col: parsed.lineHundredthsCol,
      ...(parsed.lineUnknownFlags === undefined
        ? {}
        : { lineUnknownFlags: parsed.lineUnknownFlags }),
      lineUnknownCount: parsed.lineUnknownCount,
    },
    provenance: {
      basis: parsed.basis,
      generatedAt: parsed.generatedAt,
      watermarkCursor: parsed.watermarkCursor,
      rowCount: parsed.rowCount,
    },
  };
}
