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

/**
 * Entity-shaped parse failures (Bun 1.4.4 measured):
 * `Entity expansion exceeds the amplification limit` (exponential expansion),
 * `Entity '<name>' refers to itself` (recursive entity), and undeclared-entity
 * references. Deep recursion builds surface as "call stack" / "too deeply".
 */
const ENTITY_BOMB_SYNTAX = /entity|amplification limit|call stack|too deeply/i;

/**
 * Parse XML after preflight. Entity-bomb failures map to their own stable ops
 * error code; every other syntax failure maps to `ERR_XML_PARSE_FAILED` so a
 * truncated tag is not misreported as an entity bomb.
 */
export function parseXmlCompactDocument(
  rawBytes: Uint8Array,
): Bun.XML.Document {
  assertXmlIngestBytesNotHtmlOn200(rawBytes);
  try {
    return Bun.XML.parse(rawBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (ENTITY_BOMB_SYNTAX.test(message)) {
      throw new Error(`ERR_XML_ENTITY_BOMB: ${message}`, { cause: err });
    }
    if (err instanceof SyntaxError) {
      throw new Error(`ERR_XML_PARSE_FAILED: ${message}`, { cause: err });
    }
    throw err;
  }
}
