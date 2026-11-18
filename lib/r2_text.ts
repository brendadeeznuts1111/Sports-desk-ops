/**
 * @file lib/r2_text.ts
 * @description Fail-closed text reads from R2/S3 objects.
 *
 * A normal `TextDecoder` replaces invalid UTF-8 with U+FFFD and accepts a UTF-16/UTF-32
 * payload as a stream of replacement characters. Manifest and evidence readers must not
 * silently rewrite the bytes they are about to parse, so this helper rejects unsupported
 * BOMs explicitly and decodes UTF-8 with `fatal: true`.
 */

/** Minimal structural source; `Bun.S3File` and the CAS client's file handle both satisfy it. */
export interface R2ObjectBytesSource {
  bytes(): Promise<Uint8Array>;
}

export const ERR_R2_UNSUPPORTED_BOM = "ERR_R2_UNSUPPORTED_BOM";
export const ERR_R2_INVALID_UTF8 =
  "ERR_R2_INVALID_UTF8: payload is not valid UTF-8";
export const ERR_R2_LONE_SURROGATE =
  "ERR_R2_LONE_SURROGATE: Unpaired UTF-16 surrogate in decoded text";

const STRICT_UTF8 = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

/**
 * True for UTF-16 BE/LE and UTF-32 BE/LE BOMs. UTF-32 LE starts with the UTF-16 LE
 * BOM (FF FE), so the two-byte check intentionally covers both.
 */
function hasUnsupportedBom(raw: Uint8Array): boolean {
  return (
    (raw[0] === 0xff && raw[1] === 0xfe) ||
    (raw[0] === 0xfe && raw[1] === 0xff) ||
    (raw[0] === 0x00 && raw[1] === 0x00 && raw[2] === 0xfe && raw[3] === 0xff)
  );
}

/** Read an R2/S3 object as strict UTF-8. Invalid bytes throw TypeError; no U+FFFD repair. */
export async function readStrictUtf8R2Object(
  file: R2ObjectBytesSource,
): Promise<string> {
  const raw = await file.bytes();
  if (hasUnsupportedBom(raw)) {
    throw new TypeError(ERR_R2_UNSUPPORTED_BOM);
  }

  let text: string;
  try {
    text = STRICT_UTF8.decode(raw);
  } catch (cause) {
    throw new TypeError(ERR_R2_INVALID_UTF8, { cause });
  }

  // `fatal: true` already rejects invalid UTF-8 (including encoded surrogates); this
  // remains a cheap postcondition for callers that reason about the returned string.
  if (!text.isWellFormed()) {
    throw new TypeError(ERR_R2_LONE_SURROGATE);
  }
  return text;
}
