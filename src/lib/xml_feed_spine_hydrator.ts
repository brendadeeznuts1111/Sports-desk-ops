/**
 * @file src/lib/xml_feed_spine_hydrator.ts
 * @description Live XML odds feed → pre-allocated DodSpine SoA columns (@hotpath, zero Map/Set).
 */

import { asComboPackedKey15 } from "../../design/domain-branded-types.ts";
import {
  packSubSportComboKey15,
  SUBSPORT_UNKNOWN_CODE6,
} from "./portal_taxonomy_normalizer.ts";
import { parseXmlCompactDocument } from "./xml_ingest_preflight.ts";

export type { SubSportComboPackedKey15 } from "./portal_taxonomy_normalizer.ts";

export interface XmlOddsFeedColumnStore {
  readonly capacity: number;
  count: number;
  readonly eventId32Col: Uint32Array;
  readonly packedComboKey15Col: Uint16Array;
  readonly lineHundredthsI32Col: Int32Array;
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
  };
}

function parseLineHundredths(lineRaw: string): number {
  const trimmed = lineRaw.trim();
  if (trimmed === "") return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) | 0;
}

type CompactFeedDoc = {
  readonly feed?: {
    readonly event?:
      Record<string, unknown> | ReadonlyArray<Record<string, unknown>>;
  };
};

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
  const doc = parseXmlCompactDocument(rawBytes) as CompactFeedDoc;
  const events = normalizeEvents(doc.feed?.event);
  if (events.length === 0) return 0;

  let written = 0;
  for (let rowIndex = 0; rowIndex < events.length; rowIndex++) {
    if (store.count >= store.capacity) {
      throw new Error("ERR_DOD_CSR_CONSERVATION_BREACH");
    }

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
    const lineHundredths = parseLineHundredths(String(ev["@line"] ?? "0"));

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
    store.lineHundredthsI32Col[slotIndex] = lineHundredths;
    written++;
  }

  return written;
}
