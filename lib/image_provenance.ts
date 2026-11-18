/**
 * @file lib/image_provenance.ts
 * @description Header-only provenance for R2 WebP/PNG artifacts.
 *
 * Measured on Bun 1.4.4: there is no `Bun.Image.from(bytes)` (the constructor is
 * `new Bun.Image(bytes)`), and `image.metadata()` reads only structural header fields
 * (`{ width, height, format }`) — it never returns PNG text chunks or XMP properties.
 * The `sportsdesk:*` provenance values are carried in container metadata instead:
 *   - PNG: `tEXt` / `zTXt` / `iTXt` chunks, either as direct keywords or inside the
 *     `XML:com.adobe.xmp` packet (the convention `scripts/generate_pipeline_reference_images.ts`
 *     already writes)
 *   - WebP: the `XMP ` RIFF chunk
 *
 * This module walks those chunks without decoding pixels, and can write the three keys
 * back into a PNG/WebP container so the read path has a producer.
 */

import { inflateSync } from "node:zlib";
import type {
  ImageProvenanceChannel,
  ImageProvenanceFields,
  ImageProvenanceReport,
} from "@sportsdesk-ops/contracts";
import { imageErrorCode } from "./image_errors.ts";

/** Canonical keys, exactly as carried in the container. */
export const IMAGE_PROVENANCE_KEYS = {
  streamId: "sportsdesk:stream_id",
  genU32: "sportsdesk:gen_u32",
  merkleRoot: "sportsdesk:merkle_root",
} as const;

export type ImageProvenanceFieldKey = keyof ImageProvenanceFields;

const FIELD_BY_KEY: Readonly<Record<string, ImageProvenanceFieldKey>> = {
  "sportsdesk:stream_id": "streamId",
  "sportsdesk:gen_u32": "genU32",
  "sportsdesk:merkle_root": "merkleRoot",
};

const XMP_KEYWORD = "XML:com.adobe.xmp";
const MAX_PROVENANCE_PIXELS = 40_000_000;

const PNG_SIGNATURE = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
);

/** Values to embed; omitted/null fields are not written. */
export interface ImageProvenanceInput {
  readonly streamId?: string | null | undefined;
  readonly genU32?: number | null | undefined;
  readonly merkleRoot?: string | null | undefined;
}

export type ImageProvenanceExpectation = ImageProvenanceInput;

export interface ImageProvenanceVerification {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
}

interface ProvenanceEntry {
  readonly channel: ImageProvenanceChannel;
  readonly key: string;
  readonly value: string;
}

// ── byte helpers ───────────────────────────────────────────────────────────────

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const byte = bytes[start + i];
    out += byte === undefined ? "\0" : String.fromCharCode(byte);
  }
  return out;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function latin1Encode(text: string): Uint8Array | null {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) return null;
    out[i] = code;
  }
  return out;
}

function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  );
}

// ── container readers ──────────────────────────────────────────────────────────

function inflateMaybe(bytes: Uint8Array): string | null {
  try {
    return utf8Decode(inflateSync(bytes));
  } catch {
    return null;
  }
}

function firstNul(bytes: Uint8Array, from = 0): number {
  for (let i = from; i < bytes.length; i++) {
    if (bytes[i] === 0) return i;
  }
  return -1;
}

interface ParsedPngText {
  readonly keyword: string;
  readonly text: string;
  /** True when a malformed iTXt header was tolerated (recorded as an issue). */
  readonly tolerated: boolean;
}

function parsePngTextChunk(
  type: string,
  data: Uint8Array,
): ParsedPngText | null {
  const sep = firstNul(data);
  if (sep <= 0) return null;
  const keyword = latin1(data.subarray(0, sep));
  if (type === "tEXt") {
    return { keyword, text: latin1(data.subarray(sep + 1)), tolerated: false };
  }
  if (type === "zTXt") {
    const text = inflateMaybe(data.subarray(sep + 2));
    return text === null ? null : { keyword, text, tolerated: false };
  }
  // iTXt: keyword \0 flag method language \0 translated \0 text
  const compressionFlag = data[sep + 1] ?? 0;
  const langEnd = firstNul(data, sep + 3);
  const translatedEnd = langEnd < 0 ? -1 : firstNul(data, langEnd + 1);
  let textStart: number;
  let tolerated = false;
  if (translatedEnd >= 0) {
    textStart = translatedEnd + 1;
  } else {
    // Some generators (including scripts/generate_pipeline_reference_images.ts before
    // 2026-11-18) wrote three header bytes instead of five. Skip the zero padding and
    // read the rest as text, recording that the container was non-conforming.
    const firstTextByte = data
      .subarray(sep + 1)
      .findIndex((byte) => byte !== 0);
    if (firstTextByte < 0) return null;
    textStart = sep + 1 + firstTextByte;
    tolerated = true;
  }
  const textBytes = data.subarray(textStart);
  if (compressionFlag === 1) {
    const text = inflateMaybe(textBytes);
    return text === null ? null : { keyword, text, tolerated };
  }
  return { keyword, text: utf8Decode(textBytes), tolerated };
}

function readPngTextEntries(
  bytes: Uint8Array,
  issues: string[],
): ProvenanceEntry[] {
  const out: ProvenanceEntry[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const parsed = parsePngTextChunk(
        type,
        bytes.subarray(dataStart, dataEnd),
      );
      if (parsed !== null) {
        if (parsed.tolerated && !issues.includes("tolerated:png_itxt_header")) {
          issues.push("tolerated:png_itxt_header");
        }
        if (parsed.keyword === XMP_KEYWORD) {
          out.push(...xmpEntries(parsed.text, "png-xmp"));
        } else {
          out.push({
            channel: "png-text",
            key: parsed.keyword,
            value: parsed.text,
          });
        }
      }
    }
    if (type === "IEND") break;
    offset = dataEnd + 4;
  }
  return out;
}

function readWebpEntries(bytes: Uint8Array): ProvenanceEntry[] {
  const out: ProvenanceEntry[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = u32le(bytes, offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length) break;
    if (id === "XMP ") {
      const xml = utf8Decode(bytes.subarray(start, end)).replace(/\0+$/, "");
      out.push(...xmpEntries(xml, "webp-xmp"));
    }
    offset = end + (size & 1);
  }
  return out;
}

// ── XMP ───────────────────────────────────────────────────────────────────────

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** `sportsdesk:name` as an element or an attribute inside an XMP packet. */
function xmpEntries(
  xml: string,
  channel: ImageProvenanceChannel,
): ProvenanceEntry[] {
  const out: ProvenanceEntry[] = [];
  const element =
    /<sportsdesk:([A-Za-z0-9_.-]+)(?:\s[^>]*)?>([\s\S]*?)<\/sportsdesk:\1>/gi;
  for (const match of xml.matchAll(element)) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) continue;
    out.push({
      channel,
      key: `sportsdesk:${name.toLowerCase()}`,
      value: decodeXmlText(value.trim()),
    });
  }
  const attribute = /\bsportsdesk:([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/gi;
  for (const match of xml.matchAll(attribute)) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) continue;
    out.push({
      channel,
      key: `sportsdesk:${name.toLowerCase()}`,
      value: decodeXmlText(value.trim()),
    });
  }
  return out;
}

function buildProvenanceXmp(
  values: readonly (readonly [string, string])[],
): string {
  const properties = values
    .map(
      ([name, value]) =>
        `      <sportsdesk:${name}>${escapeXmlText(value)}</sportsdesk:${name}>`,
    )
    .join("\n");
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:sportsdesk="https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/ns/1.0/" rdf:about="">
${properties}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

// ── normalization ─────────────────────────────────────────────────────────────

function normalizeStreamId(raw: string): string | null {
  const value = raw.trim();
  return value === "" ? null : value;
}

function normalizeGenU32(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return null;
  const gen = Number(value);
  return Number.isInteger(gen) && gen >= 0 && gen <= 0xffff_ffff ? gen : null;
}

function normalizeMerkleRoot(raw: string): string | null {
  const value = raw.trim().replace(/^0x/i, "").toLowerCase();
  if (value === "" || value.length % 2 !== 0) return null;
  return /^[0-9a-f]+$/.test(value) ? value : null;
}

function normalizeField(
  field: ImageProvenanceFieldKey,
  raw: string,
): string | number | null {
  if (field === "genU32") return normalizeGenU32(raw);
  if (field === "merkleRoot") return normalizeMerkleRoot(raw);
  return normalizeStreamId(raw);
}

// ── public read API ───────────────────────────────────────────────────────────

/**
 * Read provenance from WebP/PNG bytes without decoding pixels.
 *
 * `available` reflects the `Bun.Image` header read; metadata extraction runs even when
 * the image backend rejects the bytes, because a container walk does not need a decoder.
 */
export async function readImageProvenance(
  bytes: Uint8Array,
): Promise<ImageProvenanceReport> {
  let available = false;
  let format: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let errorCode: string | undefined;
  try {
    const image = new Bun.Image(bytes, { maxPixels: MAX_PROVENANCE_PIXELS });
    const metadata = await image.metadata();
    available = true;
    format = typeof metadata.format === "string" ? metadata.format : null;
    width = metadata.width;
    height = metadata.height;
  } catch (error) {
    // signal-honesty: intentional-image-header-rejection-code
    errorCode = imageErrorCode(error) ?? "ERR_IMAGE_UNKNOWN_FORMAT";
  }

  const issues: string[] = [];
  const entries = hasPngSignature(bytes)
    ? readPngTextEntries(bytes, issues)
    : isWebp(bytes)
      ? readWebpEntries(bytes)
      : [];

  if (!available) {
    issues.push("image_unavailable");
    if (errorCode !== undefined) issues.push(`image_error:${errorCode}`);
  }

  const occurrences = new Map<
    ImageProvenanceFieldKey,
    { readonly value: string; readonly channel: ImageProvenanceChannel }[]
  >();
  const channels = new Set<ImageProvenanceChannel>();
  let namespaceEntries = 0;
  for (const entry of entries) {
    const field = FIELD_BY_KEY[entry.key.toLowerCase()];
    // The namespace is case-sensitive: `SportsDesk:PipelineSpecJson` is a different
    // keyword, not one of our fields (field keys still match case-insensitively).
    if (field !== undefined || entry.key.startsWith("sportsdesk:")) {
      namespaceEntries += 1;
      channels.add(entry.channel);
    }
    if (field === undefined) continue;
    const list = occurrences.get(field) ?? [];
    list.push({ value: entry.value, channel: entry.channel });
    occurrences.set(field, list);
  }

  const fields: Record<ImageProvenanceFieldKey, string | number | null> = {
    streamId: null,
    genU32: null,
    merkleRoot: null,
  };
  const raw: Record<string, string> = {};
  for (const [field, list] of occurrences) {
    const key = IMAGE_PROVENANCE_KEYS[field];
    const first = list[0];
    if (first === undefined) continue;
    if (new Set(list.map((item) => item.value)).size > 1) {
      issues.push(`conflict:${key}`);
    }
    raw[key] = first.value;
    const normalized = normalizeField(field, first.value);
    if (normalized === null && first.value.trim() !== "") {
      issues.push(`invalid:${key}`);
    }
    fields[field] = normalized;
  }

  for (const field of Object.keys(
    IMAGE_PROVENANCE_KEYS,
  ) as ImageProvenanceFieldKey[]) {
    // A present-but-invalid value is reported as `invalid:`, not as missing.
    if (!occurrences.has(field)) {
      issues.push(`missing:${IMAGE_PROVENANCE_KEYS[field]}`);
    }
  }
  if (namespaceEntries === 0) issues.push("no_sportsdesk_metadata");

  return {
    available,
    format,
    width,
    height,
    byteLength: bytes.length,
    channels: [...channels].sort(),
    fields: {
      streamId: typeof fields.streamId === "string" ? fields.streamId : null,
      genU32: typeof fields.genU32 === "number" ? fields.genU32 : null,
      merkleRoot:
        typeof fields.merkleRoot === "string" ? fields.merkleRoot : null,
    },
    raw,
    issues,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

/** Compare a report with expected values; only supplied expectations are checked. */
export function verifyImageProvenance(
  report: ImageProvenanceReport,
  expected: ImageProvenanceExpectation,
): ImageProvenanceVerification {
  const mismatches: string[] = [];
  if (!report.available) mismatches.push("image_unavailable");
  if (
    expected.streamId !== undefined &&
    expected.streamId !== null &&
    report.fields.streamId !== expected.streamId
  ) {
    mismatches.push(`stream_id:${report.fields.streamId ?? "missing"}`);
  }
  if (
    expected.genU32 !== undefined &&
    expected.genU32 !== null &&
    report.fields.genU32 !== expected.genU32
  ) {
    mismatches.push(`gen_u32:${report.fields.genU32 ?? "missing"}`);
  }
  if (expected.merkleRoot !== undefined && expected.merkleRoot !== null) {
    const want = normalizeMerkleRoot(expected.merkleRoot);
    if (want === null) mismatches.push("merkle_root:invalid_expected");
    else if (report.fields.merkleRoot !== want) {
      mismatches.push(`merkle_root:${report.fields.merkleRoot ?? "missing"}`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// ── public write API ──────────────────────────────────────────────────────────

function normalizeInput(
  input: ImageProvenanceInput,
): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  const streamId = input.streamId?.trim();
  if (streamId !== undefined && streamId !== "") {
    out.push(["stream_id", streamId]);
  }
  if (input.genU32 !== undefined && input.genU32 !== null) {
    if (
      !Number.isInteger(input.genU32) ||
      input.genU32 < 0 ||
      input.genU32 > 0xffff_ffff
    ) {
      throw new Error("embedImageProvenance: genU32 must be a uint32");
    }
    out.push(["gen_u32", String(input.genU32)]);
  }
  if (input.merkleRoot !== undefined && input.merkleRoot !== null) {
    const merkle = normalizeMerkleRoot(input.merkleRoot);
    if (merkle === null) {
      throw new Error(
        "embedImageProvenance: merkleRoot must be even-length hex",
      );
    }
    out.push(["merkle_root", merkle]);
  }
  return out;
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffff_ffff;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(utf8Encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function pngTextChunk(keyword: string, value: string): Uint8Array {
  const keyBytes = latin1Encode(keyword);
  const valueBytes = latin1Encode(value);
  if (keyBytes !== null && valueBytes !== null) {
    return pngChunk("tEXt", concat([keyBytes, Uint8Array.of(0), valueBytes]));
  }
  // UTF-8 values use iTXt: keyword \0 flag=0 method=0 language \0 translated \0 text
  const key = keyBytes ?? latin1Encode(keyword.replace(/[^\x20-\x7e]/g, "?"))!;
  return pngChunk(
    "iTXt",
    concat([key, Uint8Array.of(0, 0, 0, 0, 0), utf8Encode(value)]),
  );
}

function pngTextKeyword(data: Uint8Array): string | null {
  const sep = firstNul(data);
  return sep > 0 ? latin1(data.subarray(0, sep)) : null;
}

function isOurKey(keyword: string): boolean {
  return FIELD_BY_KEY[keyword.toLowerCase()] !== undefined;
}

/** Rewrite a PNG's `sportsdesk:*` tEXt/iTXt chunks, inserting them after IHDR. */
export function embedPngProvenance(
  bytes: Uint8Array,
  input: ImageProvenanceInput,
): Uint8Array {
  if (!hasPngSignature(bytes)) {
    throw new Error("embedPngProvenance: bytes are not a PNG");
  }
  const values = normalizeInput(input);
  if (values.length === 0) return bytes;
  const parts: Uint8Array[] = [bytes.subarray(0, PNG_SIGNATURE.length)];
  let offset = PNG_SIGNATURE.length;
  let inserted = false;
  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (end > bytes.length) break;
    const chunk = bytes.subarray(offset, end);
    if (type === "IHDR") {
      parts.push(chunk);
      for (const [name, value] of values) {
        parts.push(pngTextChunk(`sportsdesk:${name}`, value));
      }
      inserted = true;
    } else if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const keyword = pngTextKeyword(
        bytes.subarray(offset + 8, offset + 8 + length),
      );
      if (keyword === null || !isOurKey(keyword)) parts.push(chunk);
    } else {
      parts.push(chunk);
    }
    offset = end;
    if (type === "IEND") break;
  }
  if (!inserted) {
    throw new Error("embedPngProvenance: PNG has no IHDR chunk");
  }
  return concat(parts);
}

function webpChunk(id: string, data: Uint8Array): Uint8Array {
  const padded = data.length + (data.length & 1);
  const out = new Uint8Array(8 + padded);
  out.set(utf8Encode(id), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

/** Replace (or add) the WebP `XMP ` chunk with the three provenance properties. */
export function embedWebpProvenance(
  bytes: Uint8Array,
  input: ImageProvenanceInput,
): Uint8Array {
  if (!isWebp(bytes)) {
    throw new Error("embedWebpProvenance: bytes are not a RIFF/WEBP container");
  }
  const values = normalizeInput(input);
  if (values.length === 0) return bytes;
  const parts: Uint8Array[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = u32le(bytes, offset + 4);
    const end = offset + 8 + size;
    if (end > bytes.length) break;
    if (id !== "XMP ") {
      parts.push(bytes.subarray(offset, end + (size & 1)));
    }
    offset = end + (size & 1);
  }
  if (values.length > 0) {
    parts.push(webpChunk("XMP ", utf8Encode(buildProvenanceXmp(values))));
  }
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(utf8Encode("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set(utf8Encode("WEBP"), 8);
  out.set(body, 12);
  return out;
}

/** Embed provenance into a PNG or WebP container (sniffed from its signature). */
export function embedImageProvenance(
  bytes: Uint8Array,
  input: ImageProvenanceInput,
): Uint8Array {
  if (hasPngSignature(bytes)) return embedPngProvenance(bytes, input);
  if (isWebp(bytes)) return embedWebpProvenance(bytes, input);
  throw new Error(
    "embedImageProvenance: unsupported container (expected PNG or WebP)",
  );
}
