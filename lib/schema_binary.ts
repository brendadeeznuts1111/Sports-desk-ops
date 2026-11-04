/**
 * Bun-native binary helpers for schema snapshots and JSON column payloads.
 */

import { sha256FromDigest, type Sha256Hex } from "./brand.ts";
import type { SqliteSchemaReport } from "./schema_report.ts";
import type { SqliteStorageKind } from "./sqlite_schema_registry.ts";
import { canonicalJsonString } from "./canonical_json.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** First byte of schema.manifest.bin — bump when layout or kind map breaks compat. */
export const MANIFEST_VERSION = 1;
export const SUPPORTED_MANIFEST_VERSION = MANIFEST_VERSION;

// Reserved manifest kind codes (byte per column after name):
//   1 = integer_pk   — never reuse; v1 manifests exist in the wild
//   2 = text
//   3 = text_iso_time
//   4 = text_sha256
//   5 = text_json
//   6 = text_enum
//   7 = real
//   8 = integer      — added after 1–7; do not assign 1 to non-PK integers
//   9 = (reserved)
//  10 = (reserved)

export const KIND_CODES: Record<SqliteStorageKind, number> = {
  integer_pk: 1,
  integer: 8,
  text: 2,
  text_iso_time: 3,
  text_sha256: 4,
  text_json: 5,
  text_enum: 6,
  real: 7,
};

const CODE_TO_KIND: Record<number, SqliteStorageKind> = {
  1: "integer_pk",
  2: "text",
  3: "text_iso_time",
  4: "text_sha256",
  5: "text_json",
  6: "text_enum",
  7: "real",
  8: "integer",
};

export type BinaryJsonColumn = {
  table: string;
  column: string;
  encoding: "gzip" | "zstd";
  sha256Column: string | null;
};

/** Optional BLOB storage mode for large JSON columns (hex sha256 sidecar unchanged). */
export const BINARY_JSON_COLUMNS: readonly BinaryJsonColumn[] = [
  {
    table: "match_evaluations",
    column: "evaluation_json",
    encoding: "gzip",
    sha256Column: "evaluation_json_sha256",
  },
  {
    table: "match_evaluations",
    column: "replay_input_json",
    encoding: "zstd",
    sha256Column: null,
  },
  {
    table: "wager_settlement_observations",
    column: "payload_json",
    encoding: "gzip",
    sha256Column: "payload_sha256",
  },
  {
    table: "combo_legs",
    column: "leg_json",
    encoding: "gzip",
    sha256Column: null,
  },
];

export async function readDbHeaderBytes(path: string): Promise<Uint8Array> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`missing: ${path}`);
  return file.bytes();
}

export function isSqliteFileHeader(bytes: Uint8Array): boolean {
  const magic = textEncoder.encode("SQLite format 3\0");
  if (bytes.byteLength < magic.byteLength) return false;
  for (let i = 0; i < magic.byteLength; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

export async function readSnapshotArrayBuffer(
  path: string,
): Promise<ArrayBuffer> {
  return Bun.file(path).arrayBuffer();
}

export function sha256Bytes(bytes: Uint8Array): Sha256Hex {
  return sha256FromDigest(Bun.CryptoHasher.hash("sha256", bytes, "hex"));
}

export function sha256Json(value: unknown): Sha256Hex {
  const bytes = textEncoder.encode(JSON.stringify(value));
  return sha256Bytes(bytes);
}

export function sha256CanonicalJson(value: unknown): Sha256Hex {
  const bytes = textEncoder.encode(canonicalJsonString(value));
  return sha256Bytes(bytes);
}

export type JsonPackAlgo = "gzip" | "zstd";

export function packJson(
  value: unknown,
  algo: JsonPackAlgo = "gzip",
): Uint8Array {
  const raw = textEncoder.encode(JSON.stringify(value));
  return algo === "zstd" ? Bun.zstdCompressSync(raw) : Bun.gzipSync(raw);
}

export function packJsonCanonical(
  value: unknown,
  algo: JsonPackAlgo = "gzip",
): Uint8Array {
  const raw = textEncoder.encode(canonicalJsonString(value));
  return algo === "zstd" ? Bun.zstdCompressSync(raw) : Bun.gzipSync(raw);
}

export function unpackJson(
  bytes: Uint8Array,
  algo: JsonPackAlgo = "gzip",
): unknown {
  const buf = bytes as Uint8Array<ArrayBuffer>;
  const raw: Uint8Array =
    algo === "zstd" ? Bun.zstdDecompressSync(buf) : Bun.gunzipSync(buf);
  return JSON.parse(textDecoder.decode(raw));
}

export function encodeManifest(report: SqliteSchemaReport): Uint8Array {
  let size = 1 + 2;
  for (const t of report.summary) {
    size += 2 + textEncoder.encode(t.table).byteLength + 2;
    for (const c of report.columns.filter((col) => col.table === t.table)) {
      size += 2 + textEncoder.encode(c.column).byteLength + 1 + 1;
    }
  }

  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint8(o++, MANIFEST_VERSION);
  dv.setUint16(o, report.summary.length, true);
  o += 2;

  for (const t of report.summary) {
    const name = textEncoder.encode(t.table);
    dv.setUint16(o, name.byteLength, true);
    o += 2;
    new Uint8Array(buf, o, name.byteLength).set(name);
    o += name.byteLength;

    const cols = report.columns.filter((c) => c.table === t.table);
    dv.setUint16(o, cols.length, true);
    o += 2;

    for (const c of cols) {
      const col = textEncoder.encode(c.column);
      dv.setUint16(o, col.byteLength, true);
      o += 2;
      new Uint8Array(buf, o, col.byteLength).set(col);
      o += col.byteLength;
      const kindCode = KIND_CODES[c.kind];
      if (kindCode === undefined) {
        throw new Error(`encodeManifest: unknown kind ${c.kind}`);
      }
      dv.setUint8(o++, kindCode);
      dv.setUint8(o++, c.nullable === "YES" ? 1 : 0);
    }
  }

  return new Uint8Array(buf, 0, o);
}

export type DecodedManifestColumn = {
  column: string;
  kind: SqliteStorageKind;
  nullable: boolean;
};

export type DecodedManifestTable = {
  table: string;
  columns: DecodedManifestColumn[];
};

export function decodeManifest(bytes: Uint8Array): DecodedManifestTable[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const version = dv.getUint8(o++);
  if (version > SUPPORTED_MANIFEST_VERSION) {
    throw new Error(
      `manifest format v${version} unsupported; upgrade decoder (supported v${SUPPORTED_MANIFEST_VERSION})`,
    );
  }
  if (version < MANIFEST_VERSION) {
    throw new Error(`manifest format v${version} is obsolete`);
  }
  const tableCount = dv.getUint16(o, true);
  o += 2;
  const tables: DecodedManifestTable[] = [];

  for (let ti = 0; ti < tableCount; ti++) {
    const nameLen = dv.getUint16(o, true);
    o += 2;
    const nameBytes = new Uint8Array(
      bytes.buffer,
      bytes.byteOffset + o,
      nameLen,
    );
    o += nameLen;
    const table = textDecoder.decode(nameBytes);

    const colCount = dv.getUint16(o, true);
    o += 2;
    const columns: DecodedManifestColumn[] = [];
    for (let ci = 0; ci < colCount; ci++) {
      const colLen = dv.getUint16(o, true);
      o += 2;
      const colBytes = new Uint8Array(
        bytes.buffer,
        bytes.byteOffset + o,
        colLen,
      );
      o += colLen;
      const column = textDecoder.decode(colBytes);
      const kindCode = dv.getUint8(o++);
      const nullable = dv.getUint8(o++) === 1;
      const kind = CODE_TO_KIND[kindCode];
      if (kind === undefined) {
        throw new Error(
          `manifest v${version}: unknown kind code ${kindCode} on ${table}.${column}`,
        );
      }
      columns.push({
        column,
        kind,
        nullable,
      });
    }
    tables.push({ table, columns });
  }
  return tables;
}

/** Expected decode shape for a report (round-trip gate). */
export function decodedManifestFromReport(
  report: SqliteSchemaReport,
): DecodedManifestTable[] {
  return report.summary.map((t) => ({
    table: t.table,
    columns: report.columns
      .filter((c) => c.table === t.table)
      .map((c) => ({
        column: c.column,
        kind: c.kind,
        nullable: c.nullable === "YES",
      })),
  }));
}

export function assertManifestRoundTrip(
  bytes: Uint8Array,
  report: SqliteSchemaReport,
): void {
  const decoded = decodeManifest(bytes);
  const expected = decodedManifestFromReport(report);
  if (!Bun.deepEquals(decoded, expected, true)) {
    throw new Error("manifest round-trip mismatch");
  }
}

export function mergeManifests(chunks: Uint8Array[]): Uint8Array {
  const merged = Bun.concatArrayBuffers(chunks);
  return new Uint8Array(merged);
}

export function buildSnapshotStreaming(
  reports: SqliteSchemaReport[],
): Uint8Array {
  const sink = new Bun.ArrayBufferSink();
  sink.start({ asUint8Array: true });
  sink.write(new Uint8Array([MANIFEST_VERSION]));
  for (const report of reports) {
    const chunk = encodeManifest(report);
    const len = new Uint8Array(2);
    new DataView(len.buffer).setUint16(0, chunk.byteLength, true);
    sink.write(len);
    sink.write(chunk);
  }
  return sink.end() as Uint8Array;
}

export async function writeBinarySnapshot(
  destination: string | URL,
  bytes: Uint8Array,
): Promise<number> {
  return Bun.write(destination, bytes);
}

export type SchemaReportJsonWithBinary = ReturnType<
  SqliteSchemaReport["toJSON"]
> & {
  manifestBase64: string;
  manifestHex: string;
  manifestByteLength: number;
};

export function reportToJsonWithBinary(
  report: SqliteSchemaReport,
): SchemaReportJsonWithBinary {
  const manifest = encodeManifest(report);
  return {
    ...report.toJSON(),
    manifestBase64: manifest.toBase64(),
    manifestHex: manifest.toHex(),
    manifestByteLength: manifest.byteLength,
  };
}

/** Zero-copy DataView over a SQLite BLOB column. */
export function dataViewOverBlob(blob: Uint8Array): DataView {
  return new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
}

export function decodeEvaluationBlobHeader(blob: Uint8Array): {
  version: number;
  runAtMs: number;
} {
  const dv = dataViewOverBlob(blob);
  return {
    version: dv.getUint8(0),
    runAtMs: dv.getFloat64(1, true),
  };
}

export function findBinaryJsonColumn(
  table: string,
  column: string,
): BinaryJsonColumn | undefined {
  return BINARY_JSON_COLUMNS.find(
    (c) => c.table === table && c.column === column,
  );
}
