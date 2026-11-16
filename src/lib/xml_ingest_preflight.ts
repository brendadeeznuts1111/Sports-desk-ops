/**
 * @file src/lib/xml_ingest_preflight.ts
 * @description Class A HTML-on-200 and XML entity-bomb guards before DodSpine / R2 CAS promotion.
 * No local `.json` / `.jsonl` / `.sqlite` artifacts — in-memory bytes only.
 */

const HTML_HEAD_PROBE_BYTES = 64;

/** Reject expired-session HTML login pages masquerading as XML API bodies. */
export function assertXmlIngestBytesNotHtmlOn200(rawBytes: Uint8Array): void {
  const headProbe = new TextDecoder()
    .decode(
      rawBytes.subarray(0, Math.min(rawBytes.length, HTML_HEAD_PROBE_BYTES)),
    )
    .trimStart();
  if (/^<!doctype\s+html|^<html/i.test(headProbe)) {
    throw new Error("ERR_GSLIVE_SESSION_EXPIRED");
  }
}

const ENTITY_BOMB_SYNTAX = /call stack|too deeply|entity|SyntaxError/i;

/**
 * Parse XML after preflight. Maps exponential entity expansion to a stable ops error code.
 */
export function parseXmlCompactDocument(rawBytes: Uint8Array): unknown {
  assertXmlIngestBytesNotHtmlOn200(rawBytes);
  try {
    return Bun.XML.parse(rawBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof SyntaxError || ENTITY_BOMB_SYNTAX.test(message)) {
      throw new Error(`ERR_XML_ENTITY_BOMB: ${message}`, { cause: err });
    }
    throw err;
  }
}
