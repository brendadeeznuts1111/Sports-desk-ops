/**
 * @file src/lib/xml_feed_spine_hydrator.ts
 * @description Live XML odds feed → pre-allocated DodSpine SoA columns (@hotpath, zero Map/Set).
 *
 * `@line` tri-state contract (the wire unit is still an assumption — see
 * `docs/decisions/xml-line-unit.md`):
 *
 * - **KNOWN**: a decimal literal whose value is non-integer (fractional), or whose
 *   |value| < 20. Stored as `Math.round(value * 100)` (`3.5` → `350`, `-3.25` → `-325`,
 *   `48.5` → `4850`, `0` → `0`, `19` → `1900`).
 * - **UNKNOWN**: blank/absent `@line`; non-decimal text; non-finite; not representable as
 *   int32 hundredths; or integer-valued with |value| >= 20 (`48`, `220`, `20.0`, `-20`,
 *   `-110`, `-110.0`, `+145`, `N/A`). The line column keeps the legacy `0` sentinel, the row
 *   is marked in `lineUnknownFlags`, and the row is counted in `malformedLineCount` (field
 *   name kept; it is the line-unknown count). No unit is guessed and no price is scaled, so
 *   an unknown row never stores `-11000`.
 *
 * Either state keeps the row: event id and taxonomy are always written, and the canonical
 * snapshot carries the explicit `lineUnknown` flag instead of a fabricated hundredths value.
 */

import { asComboPackedKey15 } from "../../design/domain-branded-types.ts";
import {
  packSubSportComboKey15,
  SUBSPORT_UNKNOWN_CODE6,
} from "./portal_taxonomy_normalizer.ts";
import { parseXmlCompactDocument } from "./xml_ingest_preflight.ts";

export type { SubSportComboPackedKey15 } from "./portal_taxonomy_normalizer.ts";

/** The `@line` unit this hydrator assumes for a KNOWN line (a decimal spread/total). */
export const XML_FEED_LINE_UNIT = "decimal" as const;

/**
 * An integer-valued `@line` at or above this magnitude has no deducible unit: it could be a
 * whole-number decimal total (`48`) or an American price (`-110`, `+145`), so it is UNKNOWN.
 */
export const XML_FEED_LINE_UNKNOWN_INTEGER_MIN_ABS = 20 as const;

export interface XmlOddsFeedColumnStore {
  readonly capacity: number;
  count: number;
  readonly eventId32Col: Uint32Array;
  readonly packedComboKey15Col: Uint16Array;
  readonly lineHundredthsI32Col: Int32Array;
  /**
   * Rows whose `@line` was UNKNOWN (see the file contract). Their line column is left at 0
   * (the legacy sentinel) so no fabricated line is published; the row itself is retained.
   * Field name kept for compatibility: this is the line-unknown count.
   *
   * Optional: arena literals written before this counter omit it, so a caller without the
   * field still hydrates — the count starts at 0 on first use.
   */
  malformedLineCount?: number;
  /**
   * Dense bit per written row (`Uint32Array` bitset): 1 = that row's `@line` was UNKNOWN.
   * Optional because legacy arena literals and the NSH read model omit it; a store without the
   * bitset still classifies and counts, but the canonical serializer needs it to emit
   * `lineUnknown="1"` per row, so the shipped CLI arena allocates it.
   */
  lineUnknownFlags?: Uint32Array;
}

export function createXmlOddsFeedColumnStore(
  capacity: number,
): XmlOddsFeedColumnStore {
  if (!Number.isInteger(capacity) || capacity < 0) {
    throw new Error("ERR_DOD_CSR_CONSERVATION_BREACH: invalid capacity");
  }
  return {
    capacity,
    count: 0,
    eventId32Col: new Uint32Array(capacity),
    packedComboKey15Col: new Uint16Array(capacity),
    lineHundredthsI32Col: new Int32Array(capacity),
    malformedLineCount: 0,
    lineUnknownFlags: createXmlOddsLineUnknownFlags(capacity),
  };
}

/** The dense line-unknown bitset length for `capacity` rows: one 32-bit word per 32 rows. */
export function createXmlOddsLineUnknownFlags(capacity: number): Uint32Array {
  return new Uint32Array(Math.ceil(capacity / 32));
}

/** True when row `rowIndex` was classified with an UNKNOWN `@line`. */
export function isXmlOddsLineUnknown(
  store: XmlOddsFeedColumnStore,
  rowIndex: number,
): boolean {
  const flags = store.lineUnknownFlags;
  if (flags === undefined) return false;
  const word = flags[rowIndex >>> 5];
  if (word === undefined) return false;
  return (word & (1 << (rowIndex & 31))) !== 0;
}

/** Plain decimal literal: optional sign, digits, and an optional fraction (never exponent). */
const DECIMAL_LINE_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

interface ParsedLine {
  readonly hundredths: number;
  readonly unknown: boolean;
}

/**
 * Parse one `@line` into integer hundredths, or classify it UNKNOWN when the unit cannot be
 * deduced (see the file-level contract). `null` means the attribute is absent.
 */
function parseLine(lineRaw: string | null): ParsedLine {
  if (lineRaw === null) return { hundredths: 0, unknown: true };
  const trimmed = lineRaw.trim();
  if (trimmed === "") return { hundredths: 0, unknown: true };
  if (!DECIMAL_LINE_LITERAL.test(trimmed)) {
    return { hundredths: 0, unknown: true };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { hundredths: 0, unknown: true };
  if (
    Number.isInteger(value) &&
    Math.abs(value) >= XML_FEED_LINE_UNKNOWN_INTEGER_MIN_ABS
  ) {
    // `48` / `220` / `-110` / `-110.0`: integer-valued, so the unit is ambiguous. Do not
    // guess decimal (zeroes a whole-number total) or American (scales a price to -11000).
    return { hundredths: 0, unknown: true };
  }
  const hundredths = Math.round(value * 100);
  if (
    !Number.isSafeInteger(hundredths) ||
    hundredths < -0x8000_0000 ||
    hundredths > 0x7fff_ffff
  ) {
    // Not representable in the Int32 line column: count it instead of truncating.
    return { hundredths: 0, unknown: true };
  }
  return { hundredths: hundredths | 0, unknown: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordList(
  value: unknown,
): value is ReadonlyArray<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isRecord);
}

function normalizeEvents(
  rawEvents: unknown,
): ReadonlyArray<Record<string, unknown>> {
  if (rawEvents === undefined || rawEvents === null) return [];
  if (isRecordList(rawEvents)) return rawEvents;
  return isRecord(rawEvents) ? [rawEvents] : [];
}

const FEED_ROOT_LOCAL_NAME = "feed";
const EVENT_LOCAL_NAME = "event";

/** XML namespace prefixes are not part of the local name (`m:feed` → `feed`). */
function localNameOf(xmlName: string): string {
  const separatorIndex = xmlName.lastIndexOf(":");
  return separatorIndex === -1 ? xmlName : xmlName.slice(separatorIndex + 1);
}

/** Attribute (`@name`) and text (`#text`) keys can never name a child element. */
function isChildElementKey(key: string): boolean {
  return !key.startsWith("@") && !key.startsWith("#");
}

/**
 * Resolve the feed root by local name: `<m:feed>` and `<feed>` hydrate alike.
 * A document with no feed root is mis-shaped, not an empty feed — fail closed so a
 * typo or a proxy error page cannot look like a healthy zero-row ingest.
 */
function resolveFeedRoot(doc: Bun.XML.Document): unknown {
  for (const [rootName, rootValue] of Object.entries(doc)) {
    if (localNameOf(rootName) === FEED_ROOT_LOCAL_NAME) return rootValue;
  }
  const rootNames = Object.keys(doc).join(", ");
  throw new Error(
    `ERR_XML_FEED_ROOT_MISSING: expected a <feed> root element, found ${rootNames || "none"}`,
  );
}

/** Resolve the event collection by local name (accepts `event` and `prefix:event`). */
function resolveEventCollection(feed: unknown): unknown {
  if (!isRecord(feed)) return undefined;
  for (const [childName, childValue] of Object.entries(feed)) {
    if (
      isChildElementKey(childName) &&
      localNameOf(childName) === EVENT_LOCAL_NAME
    ) {
      return childValue;
    }
  }
  return undefined;
}

/**
 * Hydrates a live XML odds feed (compact mode) directly into contiguous SoA columns.
 */
export function hydrateXmlOddsFeedIntoSoA(
  rawBytes: Uint8Array,
  store: XmlOddsFeedColumnStore,
  resolveSubSportCode6: (sport: string, subSport: string | null) => number,
  /** Called when a non-blank subSport resolves to the unknown code (0). */
  onUnmappedTaxonomy?: (sport: string, subSport: string) => void,
): number {
  const doc = parseXmlCompactDocument(rawBytes);
  const events = normalizeEvents(resolveEventCollection(resolveFeedRoot(doc)));
  if (events.length === 0) return 0;

  // Pre-check the whole frame: a frame that cannot fit must leave `store.count`
  // (and every column) untouched instead of failing halfway through the loop.
  if (events.length > store.capacity - store.count) {
    throw new Error("ERR_DOD_CSR_CONSERVATION_BREACH");
  }

  // The unknown-line bitset must cover every row this frame can write; a short arena is an
  // integrity error, not a reason to publish a chunk whose flags disagree with its count.
  const lineUnknownFlags = store.lineUnknownFlags;
  if (
    lineUnknownFlags !== undefined &&
    lineUnknownFlags.length < (store.count + events.length + 31) >>> 5
  ) {
    throw new Error(
      "ERR_DOD_CSR_CONSERVATION_BREACH: lineUnknownFlags too small",
    );
  }

  let written = 0;
  for (let rowIndex = 0; rowIndex < events.length; rowIndex++) {
    const ev = events[rowIndex]!;
    const eventId32 = Number(ev["@id"] ?? 0) >>> 0;
    const sport = String(ev["@sport"] ?? "");
    const subSportRaw = ev["@subSport"];
    const subSport =
      subSportRaw === null || subSportRaw === undefined
        ? null
        : String(subSportRaw);
    const subSportCode = resolveSubSportCode6(sport, subSport);
    if (
      subSport !== null &&
      subSport.trim().length > 0 &&
      subSportCode === SUBSPORT_UNKNOWN_CODE6
    ) {
      onUnmappedTaxonomy?.(sport, subSport);
    }
    const lineRaw = ev["@line"];
    const line = parseLine(
      lineRaw === undefined || lineRaw === null ? null : String(lineRaw),
    );

    const packed = asComboPackedKey15(
      packSubSportComboKey15(
        subSportCode,
        Number(ev["@wagerType"] ?? 0),
        Number(ev["@period"] ?? 0),
        Number(ev["@marketKind"] ?? 0),
      ),
    );

    const slotIndex = store.count++;
    store.eventId32Col[slotIndex] = eventId32;
    store.packedComboKey15Col[slotIndex] = packed;
    store.lineHundredthsI32Col[slotIndex] = line.hundredths;
    if (line.unknown) {
      store.malformedLineCount = (store.malformedLineCount ?? 0) + 1;
      if (lineUnknownFlags !== undefined) {
        const wordIndex = slotIndex >>> 5;
        lineUnknownFlags[wordIndex] =
          lineUnknownFlags[wordIndex]! | (1 << (slotIndex & 31));
      }
    }
    written++;
  }

  return written;
}
