/**
 * Read-only DOD6 v5.4 `02_LIFETIME_SOA` column views from a unified `.dodbin` spine (88 sections).
 *
 * Layout invariants enforced here before a view is created:
 *   - the 2048-byte header is validated from a 2048-byte read only (never from a full-file read),
 *   - the file buffer is one owned allocation (`byteOffset === 0`, `byteLength === buffer.byteLength`),
 *     read exactly once per reader,
 *   - every section view starts at its schema offset, on its element alignment, and ends inside
 *     the file; a violated invariant throws with the section index instead of returning a silently
 *     misaligned view,
 *   - the 64-bit columns are little-endian; the typed-array views are only mounted on a
 *     little-endian host (the file is LE, so a BE host must go through a DataView reader).
 *
 * Hot path: `lookup(login)` / `lookupInto(login, target)` use caller-owned scratch for the packed
 * key halves and the four radix slots, compare the 8-byte key column as two little-endian u32
 * words (no BigInt read), and read the signed 64-bit net column as two u32 words (no BigInt read).
 */
import { existsSync, fstatSync, openSync, readSync, closeSync } from "node:fs";
import { resolve } from "node:path";

import {
  DOD6_ALIGNMENT_BYTES,
  DOD6_HEADER_BYTE_LENGTH,
  DOD6_HEADER_UINT32_SLOTS,
  DOD6_MAGIC,
  DOD6_NULL_CLV_SENTINEL,
  DOD6_RADIX_SLOT_COUNT,
  DOD6_SECTION_COUNT,
  DOD6_VERSION,
  isValidDod6Header,
  isValidDod6RowCapacity,
} from "./dod6_v54_schema.ts";
import {
  encodeCustomerKeyAndSlotsIntoRange,
  loginBoundsInto,
} from "./dod6_v54_login_key.ts";
import type { Dod6LifetimeLookup } from "./dod6_spine_overlay.ts";
import { SHARP_CAND_MIN_CLV_LEGS_V54 } from "./dod6_spine_overlay.ts";

export const DOD_BINARY_MAGIC = DOD6_MAGIC;
export const DOD_BINARY_VERSION = DOD6_VERSION;
export const DOD_HEADER_BYTE_LENGTH = DOD6_HEADER_BYTE_LENGTH;
export const DOD_HEADER_UINT32_SLOTS = DOD6_HEADER_UINT32_SLOTS;
export const DOD_NUM_SECTION_OFFSETS = DOD6_SECTION_COUNT;
export const HEADER_SECTION_TABLE_START = 16;
export const RADIX_SLOT_COUNT = DOD6_RADIX_SLOT_COUNT;
export const EMPTY_RADIX_SLOT_ROW = -1;
export const NULL_CLV_SENTINEL = DOD6_NULL_CLV_SENTINEL;

export interface Dod6V54SpineMeta {
  readonly path: string;
  readonly customerCount: number;
  readonly rowCapacity: number;
  readonly asOfEpochDays: number;
  readonly totalFileBytes: number;
  readonly sectionCount: number;
}

/** Mutable version of the lookup result, for callers that reuse one object per row. */
export interface Dod6LifetimeLookupTarget {
  clvBps: number | null;
  sharpScore: number | null;
  lifetimeNetUsd: number | null;
  clvLegs: number;
  avgClvPoints: number | null;
  sharpCandidateGatePassed: boolean;
  source: Dod6LifetimeLookup["source"];
  /** Flat identity for allocation-free lookupInto: kind + binary handle or fallback row. */
  handleKind: Dod6LifetimeLookup["handle"]["kind"];
  handleValue: number | null;
}

export interface Dod6V54LifetimeReader {
  readonly meta: Dod6V54SpineMeta;
  /** Allocates a result + handle union; use lookupInto in per-row loops. */
  lookup(login: string): Dod6LifetimeLookup | null;
  /** Fill `target` instead of allocating a result object. Returns false when absent. */
  lookupInto(login: string, target: Dod6LifetimeLookupTarget): boolean;
}

interface LifetimeColumns {
  readonly radixHeadRowCol: Int32Array;
  /** `[lo, hi]` words of the little-endian `loginKey64Col`; compare without BigInt boxing. */
  readonly loginKeyWords: Uint32Array;
  readonly nextInRadixBucketCol: Int32Array;
  /** `[lo, hi]` words of the signed `lifetimeNetProfitCents` column. */
  readonly netProfitWords: Int32Array;
  readonly roiBasisPoints: Int32Array;
  readonly clvLegsCount: Uint32Array;
  readonly avgClvLineHundredths: Int32Array;
  /** Packed stable handle: low 15 bits row, 2-bit generation mod4, tier/vol/skill/flags above. */
  readonly packedHandleCol: Uint32Array;
}

/** 4 bytes: the only width the reader must branch on besides 8. */
const WORD_BYTES = 4;

function sectionOffset(header: Uint32Array, sectionIndex: number): number {
  return header[HEADER_SECTION_TABLE_START + sectionIndex * 3]!;
}

/**
 * Panel-aware view constructor. `byteLength` and `byteOffset` are asserted against the schema
 * offset/alignment and the file length, so a corrupt spine fails loudly at mount time instead of
 * producing a view over unrelated bytes (or throwing an opaque RangeError from the constructor).
 */
function mountView<T>(
  buffer: ArrayBuffer,
  offset: number,
  length: number,
  bytesPerElement: number,
  label: string,
  create: (buffer: ArrayBuffer, byteOffset: number, length: number) => T,
): T {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`${label}: invalid section offset ${offset}`);
  }
  if (offset % DOD6_ALIGNMENT_BYTES !== 0) {
    throw new Error(
      `${label}: section offset ${offset} is not ${DOD6_ALIGNMENT_BYTES}-byte aligned`,
    );
  }
  if (offset % bytesPerElement !== 0) {
    throw new Error(
      `${label}: section offset ${offset} is not ${bytesPerElement}-byte aligned`,
    );
  }
  const byteLength = length * bytesPerElement;
  if (offset + byteLength > buffer.byteLength) {
    throw new Error(
      `${label}: section ${offset}..${offset + byteLength} exceeds file ${buffer.byteLength}`,
    );
  }
  return create(buffer, offset, length);
}

function assertOwnedWholeBuffer(
  view: Uint8Array<ArrayBuffer>,
  label: string,
): ArrayBuffer {
  if (view.byteOffset !== 0 || view.byteLength !== view.buffer.byteLength) {
    throw new Error(`${label}: buffer must be an owned whole allocation`);
  }
  return view.buffer;
}

function assertLittleEndianHost(): void {
  if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) {
    throw new Error(
      "DOD6 spine columns are little-endian; this host is big-endian, so the typed-array " +
        "column views cannot be mounted",
    );
  }
}

/** Read exactly the 2048-byte header into its own owned allocation. */
function readHeaderBuffer(absolute: string): ArrayBuffer | null {
  const fd = openSync(absolute, "r");
  try {
    const bytes = new Uint8Array(DOD_HEADER_BYTE_LENGTH);
    const read = readSync(fd, bytes, 0, DOD_HEADER_BYTE_LENGTH, 0);
    if (read !== DOD_HEADER_BYTE_LENGTH) return null;
    return assertOwnedWholeBuffer(bytes, "DOD6 header");
  } finally {
    closeSync(fd);
  }
}

/** Read the whole file exactly once into one owned allocation (no `ArrayBuffer.slice` copy). */
function readFileBufferOwned(absolute: string): ArrayBuffer {
  const stat = Bun.file(absolute).size;
  const fd = openSync(absolute, "r");
  try {
    const bytes = new Uint8Array(stat);
    const read = readSync(fd, bytes, 0, stat, 0);
    if (read !== stat) {
      throw new Error(`DOD6 spine truncated read: ${read} < ${stat}`);
    }
    const sizeAfter = fstatSync(fd).size;
    if (sizeAfter !== stat) {
      throw new Error(
        `DOD6 spine size changed during read: ${stat} -> ${sizeAfter}`,
      );
    }
    return assertOwnedWholeBuffer(bytes, "DOD6 spine");
  } finally {
    closeSync(fd);
  }
}

function metaFromHeader(
  header: Uint32Array,
  absolute: string,
): Dod6V54SpineMeta | null {
  if (!isValidDod6Header(header)) return null;
  if (!isValidDod6RowCapacity(header[3]!)) return null;
  return {
    path: absolute,
    customerCount: header[2]!,
    rowCapacity: header[3]!,
    asOfEpochDays: header[7]!,
    totalFileBytes: header[8]!,
    sectionCount: header[9]!,
  };
}

export function roiBasisPointsToSharpScore(roiBps: number): number | null {
  if (roiBps === NULL_CLV_SENTINEL) return null;
  // Tenths are exact half-away-from-zero except on the residue-5 tie, where `toFixed`'s
  // exact-decimal rule decides. Avoid Math.sign/abs/round on the common path.
  const residue = roiBps % 10;
  if (residue !== 5 && residue !== -5) {
    const negative = roiBps < 0;
    const tenths = Math.floor(((negative ? -roiBps : roiBps) + 5) / 10);
    return (negative ? -tenths : tenths) / 10;
  }
  return Number((roiBps / 100).toFixed(1));
}

function validatePackedHandles(columns: LifetimeColumns, rows: number): void {
  for (let row = 0; row < rows; row += 1) {
    const handle = columns.packedHandleCol[row]!;
    if ((handle & 0x7fff) !== row) {
      throw new Error(
        `DOD6 packed handle row mismatch at ${row}: ${handle.toString(16)}`,
      );
    }
  }
}

function rowToLookup(
  columns: LifetimeColumns,
  rowIndex: number,
): Dod6LifetimeLookup {
  const clvLegs = columns.clvLegsCount[rowIndex]!;
  const avgLh = columns.avgClvLineHundredths[rowIndex]!;
  const avgClvPoints =
    avgLh !== NULL_CLV_SENTINEL && clvLegs > 0 ? avgLh / 100 : null;
  const clvBps = avgClvPoints !== null ? Math.round(avgClvPoints * 100) : null;
  const roiBps = columns.roiBasisPoints[rowIndex]!;
  const netCentWord = rowIndex * 2;
  const netCents =
    columns.netProfitWords[netCentWord + 1]! * 4294967296 +
    (columns.netProfitWords[netCentWord]! >>> 0);

  return {
    clvBps,
    sharpScore: roiBasisPointsToSharpScore(roiBps),
    lifetimeNetUsd: netCents / 100,
    clvLegs,
    avgClvPoints,
    sharpCandidateGatePassed: clvLegs >= SHARP_CAND_MIN_CLV_LEGS_V54,
    source: "lifetime_csv",
    handle: { kind: "binary", handle: columns.packedHandleCol[rowIndex]! },
  };
}

function fillLookup(
  columns: LifetimeColumns,
  rowIndex: number,
  target: Dod6LifetimeLookupTarget,
): void {
  const clvLegs = columns.clvLegsCount[rowIndex]!;
  const avgLh = columns.avgClvLineHundredths[rowIndex]!;
  const avgClvPoints =
    avgLh !== NULL_CLV_SENTINEL && clvLegs > 0 ? avgLh / 100 : null;
  const netCentWord = rowIndex * 2;
  target.clvBps = avgClvPoints !== null ? Math.round(avgClvPoints * 100) : null;
  target.sharpScore = roiBasisPointsToSharpScore(
    columns.roiBasisPoints[rowIndex]!,
  );
  target.lifetimeNetUsd =
    (columns.netProfitWords[netCentWord + 1]! * 4294967296 +
      (columns.netProfitWords[netCentWord]! >>> 0)) /
    100;
  target.clvLegs = clvLegs;
  target.avgClvPoints = avgClvPoints;
  target.sharpCandidateGatePassed = clvLegs >= SHARP_CAND_MIN_CLV_LEGS_V54;
  target.source = "lifetime_csv";
  target.handleKind = "binary";
  target.handleValue = columns.packedHandleCol[rowIndex]!;
}

function resolveRowIndex(
  columns: LifetimeColumns,
  keyParts: Uint32Array,
  slots: Uint32Array,
): number {
  const lo = keyParts[0]!;
  const hi = keyParts[1]!;
  for (let s = 0; s < 4; s += 1) {
    let cur = columns.radixHeadRowCol[slots[s]!]!;
    while (cur !== EMPTY_RADIX_SLOT_ROW) {
      const word = cur * 2;
      if (
        columns.loginKeyWords[word] === lo &&
        columns.loginKeyWords[word + 1] === hi
      ) {
        return cur;
      }
      cur = columns.nextInRadixBucketCol[cur]!;
    }
  }
  return -1;
}

/** Section indices for the first 20 lifetime SoA columns (post-radix). */
const SEC = {
  radixDirectory: 0,
  radixHeadRowCol: 1,
  loginKey64Col: 2,
  packedHandle64Col: 3,
  lifetimeStakedCents: 4,
  settledStakedCents: 5,
  lifetimeNetProfitCents: 6,
  packedHandleCol: 7,
  nextInRadixBucketCol: 8,
  lifetimeBetsCount: 9,
  settledBetsCount: 10,
  openBetsCount: 11,
  winsCount: 12,
  lossesCount: 13,
  pushesCount: 14,
  roiBasisPoints: 15,
  clvLegsCount: 16,
  avgClvLineHundredths: 17,
} as const;

function mountLifetimeColumns(
  buffer: ArrayBuffer,
  header: Uint32Array,
  rows: number,
): LifetimeColumns {
  assertLittleEndianHost();
  return {
    radixHeadRowCol: mountView(
      buffer,
      sectionOffset(header, SEC.radixHeadRowCol),
      RADIX_SLOT_COUNT,
      WORD_BYTES,
      "radixHeadRowCol",
      (b, o, l) => new Int32Array(b, o, l),
    ),
    loginKeyWords: mountView(
      buffer,
      sectionOffset(header, SEC.loginKey64Col),
      rows * 2,
      WORD_BYTES,
      "loginKey64Col",
      (b, o, l) => new Uint32Array(b, o, l),
    ),
    nextInRadixBucketCol: mountView(
      buffer,
      sectionOffset(header, SEC.nextInRadixBucketCol),
      rows,
      WORD_BYTES,
      "nextInRadixBucketCol",
      (b, o, l) => new Int32Array(b, o, l),
    ),
    netProfitWords: mountView(
      buffer,
      sectionOffset(header, SEC.lifetimeNetProfitCents),
      rows * 2,
      WORD_BYTES,
      "lifetimeNetProfitCents",
      (b, o, l) => new Int32Array(b, o, l),
    ),
    roiBasisPoints: mountView(
      buffer,
      sectionOffset(header, SEC.roiBasisPoints),
      rows,
      WORD_BYTES,
      "roiBasisPoints",
      (b, o, l) => new Int32Array(b, o, l),
    ),
    clvLegsCount: mountView(
      buffer,
      sectionOffset(header, SEC.clvLegsCount),
      rows,
      WORD_BYTES,
      "clvLegsCount",
      (b, o, l) => new Uint32Array(b, o, l),
    ),
    avgClvLineHundredths: mountView(
      buffer,
      sectionOffset(header, SEC.avgClvLineHundredths),
      rows,
      WORD_BYTES,
      "avgClvLineHundredths",
      (b, o, l) => new Int32Array(b, o, l),
    ),
    packedHandleCol: mountView(
      buffer,
      sectionOffset(header, SEC.packedHandleCol),
      rows,
      WORD_BYTES,
      "packedHandleCol",
      (b, o, l) => new Uint32Array(b, o, l),
    ),
  };
}

/** Read the spine header only (2048 bytes), never the whole file. */
export function readDod6V54SpineMeta(path: string): Dod6V54SpineMeta | null {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return null;
  const headerBuffer = readHeaderBuffer(absolute);
  if (headerBuffer === null) return null;
  const header = new Uint32Array(headerBuffer, 0, DOD_HEADER_UINT32_SLOTS);
  return metaFromHeader(header, absolute);
}

export async function createDod6V54LifetimeReader(
  dodbinPath: string,
): Promise<Dod6V54LifetimeReader | null> {
  const absolute = resolve(dodbinPath);
  if (!existsSync(absolute)) return null;
  const headerBuffer = readHeaderBuffer(absolute);
  if (headerBuffer === null) return null;
  const header = new Uint32Array(headerBuffer, 0, DOD_HEADER_UINT32_SLOTS);
  const meta = metaFromHeader(header, absolute);
  if (meta === null) return null;
  if (meta.sectionCount !== DOD_NUM_SECTION_OFFSETS) return null;
  const fileBytes = Bun.file(absolute).size;
  if (meta.totalFileBytes !== fileBytes) return null;

  const buffer = readFileBufferOwned(absolute);
  const fileHeader = new Uint32Array(buffer, 0, DOD_HEADER_UINT32_SLOTS);
  // A file replaced between the header read and the full read would mount the wrong header.
  if (
    fileHeader[0] !== DOD_BINARY_MAGIC ||
    fileHeader[1] !== DOD_BINARY_VERSION ||
    fileHeader[8] !== fileBytes ||
    !isValidDod6RowCapacity(fileHeader[3]!)
  ) {
    throw new Error(
      `DOD6 spine changed between header validation and read: ${absolute}`,
    );
  }
  const rows = meta.rowCapacity;
  const columns = mountLifetimeColumns(buffer, fileHeader, rows);
  validatePackedHandles(columns, rows);

  // One scratch pair per reader; `lookup` is synchronous, so a caller cannot interleave them.
  const keyParts = new Uint32Array(2);
  const slots = new Uint32Array(4);
  const bounds = new Int32Array(2);

  function rowFor(login: string): number {
    loginBoundsInto(login, bounds);
    encodeCustomerKeyAndSlotsIntoRange(
      login,
      keyParts,
      slots,
      bounds[0]!,
      bounds[1]!,
    );
    return resolveRowIndex(columns, keyParts, slots);
  }

  return {
    meta,
    lookup(login: string): Dod6LifetimeLookup | null {
      const row = rowFor(login);
      if (row < 0) return null;
      return rowToLookup(columns, row);
    },
    lookupInto(login: string, target: Dod6LifetimeLookupTarget): boolean {
      const row = rowFor(login);
      if (row < 0) return false;
      fillLookup(columns, row, target);
      return true;
    },
  };
}
