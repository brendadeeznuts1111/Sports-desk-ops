/**
 * Read-only DOD6 v5.4 `02_LIFETIME_SOA` column views from a unified `.dodbin` spine (88 sections).
 */
import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { resolve } from "node:path";

import {
  computeLoginRadixSlots16,
  encodeCustomerPackedKey64,
} from "./dod6_v54_login_key.ts";
import type { Dod6LifetimeLookup } from "./dod6_spine_overlay.ts";
import { SHARP_CAND_MIN_CLV_LEGS_V54 } from "./dod6_spine_overlay.ts";

export const DOD_BINARY_MAGIC = 0x444f4436;
export const DOD_BINARY_VERSION = 54;
export const DOD_HEADER_BYTE_LENGTH = 2048;
export const DOD_HEADER_UINT32_SLOTS = 512;
export const DOD_NUM_SECTION_OFFSETS = 88;
export const HEADER_SECTION_TABLE_START = 16;
export const RADIX_SLOT_COUNT = 65536;
export const EMPTY_RADIX_SLOT_ROW = -1;
export const NULL_CLV_SENTINEL = -2_147_483_648;

export interface Dod6V54SpineMeta {
  readonly path: string;
  readonly customerCount: number;
  readonly rowCapacity: number;
  readonly asOfEpochDays: number;
  readonly totalFileBytes: number;
  readonly sectionCount: number;
}

export interface Dod6V54LifetimeReader {
  readonly meta: Dod6V54SpineMeta;
  lookup(login: string): Dod6LifetimeLookup | null;
}

interface LifetimeColumns {
  readonly radixHeadRowCol: Int32Array;
  readonly loginKey64Col: BigUint64Array;
  readonly nextInRadixBucketCol: Int32Array;
  readonly lifetimeNetProfitCents: BigInt64Array;
  readonly roiBasisPoints: Int32Array;
  readonly clvLegsCount: Uint32Array;
  readonly avgClvLineHundredths: Int32Array;
  readonly packedHandleCol: Uint32Array;
}

function readFileBuffer(path: string): ArrayBuffer {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new Error(`DOD6 spine missing: ${absolute}`);
  }
  const fd = openSync(absolute, "r");
  try {
    const stat = Bun.file(absolute).size;
    const buf = new Uint8Array(stat);
    const read = readSync(fd, buf, 0, stat, 0);
    if (read !== stat) {
      throw new Error(`DOD6 spine truncated read: ${read} < ${stat}`);
    }
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } finally {
    closeSync(fd);
  }
}

function sectionTriple(
  header: Uint32Array,
  sectionIndex: number,
): readonly [number, number, number] {
  const base = HEADER_SECTION_TABLE_START + sectionIndex * 3;
  return [header[base]!, header[base + 1]!, header[base + 2]!];
}

function roiBasisPointsToSharpScore(roiBps: number): number | null {
  if (roiBps === NULL_CLV_SENTINEL) return null;
  return Number((roiBps / 100).toFixed(1));
}

function rowToLookup(
  columns: LifetimeColumns,
  rowIndex: number,
): Dod6LifetimeLookup {
  const clvLegs = columns.clvLegsCount[rowIndex]!;
  const avgLh = columns.avgClvLineHundredths[rowIndex]!;
  const avgClvPoints =
    avgLh !== NULL_CLV_SENTINEL && clvLegs > 0 ? avgLh / 100 : null;
  const clvBps =
    avgClvPoints !== null ? Math.round(avgClvPoints * 100) : null;
  const roiBps = columns.roiBasisPoints[rowIndex]!;
  const netCents = Number(columns.lifetimeNetProfitCents[rowIndex]!);

  return {
    clvBps,
    sharpScore: roiBasisPointsToSharpScore(roiBps),
    lifetimeNetUsd: netCents / 100,
    clvLegs,
    avgClvPoints,
    sharpCandidateGatePassed: clvLegs >= SHARP_CAND_MIN_CLV_LEGS_V54,
    source: "lifetime_csv",
  };
}

function resolveRowIndex(columns: LifetimeColumns, login: string): number {
  const key64 = encodeCustomerPackedKey64(login);
  const slots = computeLoginRadixSlots16(login);
  for (const slot of slots) {
    let cur = columns.radixHeadRowCol[slot]!;
    while (cur !== EMPTY_RADIX_SLOT_ROW) {
      if (columns.loginKey64Col[cur] === key64) return cur;
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
  const offset = (sectionIndex: number): number =>
    sectionTriple(header, sectionIndex)[0];

  return {
    radixHeadRowCol: new Int32Array(
      buffer,
      offset(SEC.radixHeadRowCol),
      RADIX_SLOT_COUNT,
    ),
    loginKey64Col: new BigUint64Array(
      buffer,
      offset(SEC.loginKey64Col),
      rows,
    ),
    nextInRadixBucketCol: new Int32Array(
      buffer,
      offset(SEC.nextInRadixBucketCol),
      rows,
    ),
    lifetimeNetProfitCents: new BigInt64Array(
      buffer,
      offset(SEC.lifetimeNetProfitCents),
      rows,
    ),
    roiBasisPoints: new Int32Array(buffer, offset(SEC.roiBasisPoints), rows),
    clvLegsCount: new Uint32Array(buffer, offset(SEC.clvLegsCount), rows),
    avgClvLineHundredths: new Int32Array(
      buffer,
      offset(SEC.avgClvLineHundredths),
      rows,
    ),
    packedHandleCol: new Uint32Array(buffer, offset(SEC.packedHandleCol), rows),
  };
}

export function readDod6V54SpineMeta(path: string): Dod6V54SpineMeta | null {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return null;
  const buffer = readFileBuffer(absolute);
  if (buffer.byteLength < DOD_HEADER_BYTE_LENGTH) return null;
  const header = new Uint32Array(buffer, 0, DOD_HEADER_UINT32_SLOTS);
  if (header[0] !== DOD_BINARY_MAGIC || header[1] !== DOD_BINARY_VERSION) {
    return null;
  }
  return {
    path: absolute,
    customerCount: header[2]!,
    rowCapacity: header[3]!,
    asOfEpochDays: header[7]!,
    totalFileBytes: header[8]!,
    sectionCount: header[9]!,
  };
}

export async function createDod6V54LifetimeReader(
  dodbinPath: string,
): Promise<Dod6V54LifetimeReader | null> {
  const meta = readDod6V54SpineMeta(dodbinPath);
  if (meta === null) return null;
  if (meta.sectionCount !== DOD_NUM_SECTION_OFFSETS) return null;
  if (meta.totalFileBytes !== Bun.file(resolve(dodbinPath)).size) return null;

  const buffer = readFileBuffer(dodbinPath);
  const header = new Uint32Array(buffer, 0, DOD_HEADER_UINT32_SLOTS);
  const rows = meta.rowCapacity;
  const columns = mountLifetimeColumns(buffer, header, rows);

  return {
    meta,
    lookup(login: string): Dod6LifetimeLookup | null {
      const row = resolveRowIndex(columns, login);
      if (row < 0) return null;
      const base = rowToLookup(columns, row);
      return base;
    },
  };
}
