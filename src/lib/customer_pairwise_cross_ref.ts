/**
 * @file src/lib/customer_pairwise_cross_ref.ts
 * @description Zero-Map/Zero-Set contiguous Structure-of-Arrays (SoA) pairwise customer wager
 * cross-reference engine reusing canonical taxonomy bitfields, dual-regime windows, and branded types.
 */

import {
  SOURCE_BRIDGE_IDS,
  asLineHundredths,
  parseAsBasisPoints,
  parseAsCents,
  type BasisPoints,
  type Cents,
  type LineHundredths,
  type SourceBridgeId2,
} from "../../design/domain-branded-types.ts";
import { normalizeCustomerId } from "../../lib/customer_wager_artifacts.ts";
import {
  COMBO_KEY15_MASK,
  MARKET_KIND_MASK,
  MARKET_KIND_SHIFT,
  PERIOD_MASK,
  PERIOD_SHIFT,
  SUB_SPORT_MASK,
  SUB_SPORT_SHIFT,
  WAGER_TYPE_MASK,
  WAGER_TYPE_SHIFT,
  packSubSportComboKey15,
  type SubSportComboPackedKey15,
} from "./portal_taxonomy_normalizer.ts";
import {
  LIVE_BOT_FOLLOW_WINDOW_MS,
  LIVE_BROADCAST_SURGE_ACCOUNT_CAP,
  LIVE_BROADCAST_SURGE_WINDOW_MS,
  LIVE_WAGER_TYPE_CODE3,
  PREGAME_API_BOT_WINDOW_MS,
  PREGAME_TIP_CHANNEL_WINDOW_MS,
  REGIME_LIVE_IN_PLAY,
  REGIME_PREGAME,
  classifyWagerRegime,
  computeRegimeLineSig32,
  type WagerRegime,
} from "./syndicate_bot_detector.ts";

export type {
  BasisPoints,
  Cents,
  LineHundredths,
  SourceBridgeId2,
  SubSportComboPackedKey15,
  WagerRegime,
};

export {
  LIVE_BOT_FOLLOW_WINDOW_MS,
  LIVE_BROADCAST_SURGE_ACCOUNT_CAP,
  LIVE_BROADCAST_SURGE_WINDOW_MS,
  LIVE_WAGER_TYPE_CODE3,
  PREGAME_API_BOT_WINDOW_MS,
  PREGAME_TIP_CHANNEL_WINDOW_MS,
  REGIME_LIVE_IN_PLAY,
  REGIME_PREGAME,
  SOURCE_BRIDGE_IDS,
  asLineHundredths,
  packSubSportComboKey15,
  parseAsBasisPoints,
  parseAsCents,
};

export const LEG_FLAG_IS_LIVE_INPLAY = 1 << 0;
export const LEG_FLAG_IS_ALT_SPREAD_PLUS_5000 = 1 << 1;
export const LEG_FLAG_IS_GSBUILDER_SGP = 1 << 2;
export const LEG_FLAG_IS_PLAYER_ANALYSIS_SURFACE = 1 << 3;
export const LEG_FLAG_IS_BROADCAST_SURGE_SUPPRESSED = 1 << 4;

export const OVERLAP_SAME_SIDE = 1 as const;
export const OVERLAP_OPPOSITE_SIDE = 2 as const;
export const OVERLAP_DIFFERENT_MARKET = 3 as const;
export type OverlapKindCode =
  | typeof OVERLAP_SAME_SIDE
  | typeof OVERLAP_OPPOSITE_SIDE
  | typeof OVERLAP_DIFFERENT_MARKET;

export type RegimeMask2 = typeof REGIME_PREGAME | typeof REGIME_LIVE_IN_PLAY;

export const INITIATOR_SIMULTANEOUS = 0 as const;
export const INITIATOR_CUSTOMER_A = 1 as const;
export const INITIATOR_CUSTOMER_B = 2 as const;
export type InitiatorCodeU8 =
  | typeof INITIATOR_SIMULTANEOUS
  | typeof INITIATOR_CUSTOMER_A
  | typeof INITIATOR_CUSTOMER_B;

export const OVERLAP_FLAG_LINE_SIG_MATCH = 1 << 0;
export const OVERLAP_FLAG_BROADCAST_SURGE_SUPPRESSED = 1 << 1;

export const PAIRWISE_SOA_CHUNK_MAGIC = 0x534f4157 as const; // 'SOAW'
export const PAIRWISE_SOA_CHUNK_VERSION = 1 as const;
export const PAIRWISE_SOA_HEADER_BYTES = 16 as const;
export const PAIRWISE_WAGER_SOA_ROW_BYTES = 54 as const;
export const PAIRWISE_OVERLAP_SOA_ROW_BYTES = 22 as const;

const BINARY_ROT_MASK_20 = 0x0fffff;
const U32_RADIX = 0x1_0000_0000;
const U32_MAX = 0xffff_ffff;

/** Unpack a 15-bit combo key using canonical masks & shifts. */
export function unpackSubSportComboKey15(
  packedComboKey15: SubSportComboPackedKey15,
): {
  readonly subSportCode6: number;
  readonly wagerTypeCode3: number;
  readonly periodCode4: number;
  readonly marketKindCode2: number;
} {
  return {
    subSportCode6: (packedComboKey15 >>> SUB_SPORT_SHIFT) & SUB_SPORT_MASK,
    wagerTypeCode3: (packedComboKey15 >>> WAGER_TYPE_SHIFT) & WAGER_TYPE_MASK,
    periodCode4: (packedComboKey15 >>> PERIOD_SHIFT) & PERIOD_MASK,
    marketKindCode2:
      (packedComboKey15 >>> MARKET_KIND_SHIFT) & MARKET_KIND_MASK,
  };
}

/**
 * Zero-float ASCII fixed-point parser (`GATE-06` 1:1 Dollar & LineHundredths accounting).
 * Handles Unicode `½` (`\u00BD`), commas, signs, and fractional zero-padding.
 */
export function parseFixedPointDecimalToBigInt(
  rawInput: string | number,
  fractionDigits: number,
): bigint {
  const trimmed = String(rawInput)
    .trim()
    .replaceAll("\u00BD", ".5")
    .replaceAll(",", "");
  if (trimmed.length === 0) return 0n;

  const isNegative = trimmed.startsWith("-");
  const unsignedSlice =
    isNegative || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const dotOffset = unsignedSlice.indexOf(".");
  const scaleFactor = 10n ** BigInt(fractionDigits);

  if (dotOffset === -1) {
    const whole = BigInt(unsignedSlice || "0") * scaleFactor;
    return isNegative ? -whole : whole;
  }

  const wholePart =
    BigInt(unsignedSlice.slice(0, dotOffset) || "0") * scaleFactor;
  const rawFrac = unsignedSlice
    .slice(dotOffset + 1, dotOffset + 1 + fractionDigits)
    .padEnd(fractionDigits, "0");
  const fracPart = BigInt(rawFrac || "0");
  const combined = wholePart + fracPart;
  return isNegative ? -combined : combined;
}

/**
 * Collapses alternate [5000..5999] and live [9000..9999] rotations into canonical rotation20.
 */
export function normalizeCanonicalRotation20(rawRotation: number): {
  readonly canonicalRot20: number;
  readonly flagMask32: number;
} {
  if (
    !Number.isInteger(rawRotation) ||
    rawRotation < 0 ||
    rawRotation > BINARY_ROT_MASK_20
  ) {
    throw new RangeError(
      `ERR_DOD_BITFIELD_RANGE_OVERFLOW: rawRotation=${String(rawRotation)}`,
    );
  }
  if (rawRotation >= 9000 && rawRotation <= 9999) {
    return {
      canonicalRot20: rawRotation - 9000,
      flagMask32: LEG_FLAG_IS_LIVE_INPLAY,
    };
  }
  if (rawRotation >= 5000 && rawRotation <= 5999) {
    return {
      canonicalRot20: rawRotation - 5000,
      flagMask32: LEG_FLAG_IS_ALT_SPREAD_PLUS_5000,
    };
  }
  return { canonicalRot20: rawRotation, flagMask32: 0 };
}

/**
 * Parses Partner 118 `G<digits>` or Fantasy402 `M.G<digits>` betGroupId tokens into `bigint`.
 */
export function parseDualSurfaceBetGroupToken(rawToken: string): bigint {
  const cleaned = rawToken.trim().toUpperCase();
  const digits = cleaned.startsWith("M.G")
    ? cleaned.slice(3)
    : cleaned.startsWith("G")
      ? cleaned.slice(1)
      : cleaned;
  let value64 = 0n;
  for (let charIndex = 0; charIndex < digits.length; charIndex++) {
    const code = digits.charCodeAt(charIndex);
    if (code >= 48 && code <= 57) {
      value64 = value64 * 10n + BigInt(code - 48);
    }
  }
  return value64;
}

/**
 * Normalizes a customer login (`normalizeCustomerId`) and hashes it via 64-bit FNV-1a
 * into stride-2 `Uint32Array` words.
 */
export function hashCustomerLogin64Stride2(
  rawCustomerId: string,
  outWords32: Uint32Array,
  wordSlotOffset: number,
): void {
  const normalized = normalizeCustomerId(rawCustomerId);
  let hash64 = 0xcbf29ce484222325n;
  const fnvPrime64 = 0x100000001b3n;
  for (let charIndex = 0; charIndex < normalized.length; charIndex++) {
    hash64 ^= BigInt(normalized.charCodeAt(charIndex) & 0xff);
    hash64 = BigInt.asUintN(64, hash64 * fnvPrime64);
  }
  outWords32[wordSlotOffset] = Number(hash64 & 0xffffffffn) >>> 0;
  outWords32[wordSlotOffset + 1] = Number((hash64 >> 32n) & 0xffffffffn) >>> 0;
}

/**
 * Encodes a 64-bit epoch millisecond timestamp into stride-2 `[lo32, hi32]` unsigned 32-bit words.
 */
export function writeEpochMs64Stride2(
  epochMs: number | bigint,
  outWords32: Uint32Array,
  wordSlotOffset: number,
): void {
  if (typeof epochMs === "bigint") {
    const unsigned = BigInt.asUintN(64, epochMs);
    outWords32[wordSlotOffset] = Number(unsigned & 0xffffffffn) >>> 0;
    outWords32[wordSlotOffset + 1] =
      Number((unsigned >> 32n) & 0xffffffffn) >>> 0;
    return;
  }
  const truncated = Math.trunc(epochMs);
  const lo = truncated >>> 0;
  const hi = Math.floor(truncated / U32_RADIX) >>> 0;
  outWords32[wordSlotOffset] = lo;
  outWords32[wordSlotOffset + 1] = hi;
}

/**
 * Decodes stride-2 `[lo32, hi32]` unsigned 32-bit timestamp words into exact millisecond number.
 */
export function readEpochMs64Stride2(
  words32: Uint32Array,
  wordSlotOffset: number,
): number {
  const lo = words32[wordSlotOffset]! >>> 0;
  const hi = words32[wordSlotOffset + 1]! >>> 0;
  return hi * U32_RADIX + lo;
}

function compareEpochMsStride2(
  words32: Uint32Array,
  rowLeft: number,
  rowRight: number,
): number {
  const slotLeft = rowLeft << 1;
  const slotRight = rowRight << 1;
  const hiDiff =
    (words32[slotLeft + 1]! >>> 0) - (words32[slotRight + 1]! >>> 0);
  if (hiDiff !== 0) return hiDiff;
  return (words32[slotLeft]! >>> 0) - (words32[slotRight]! >>> 0);
}

function clampLagMsU32(rawDiffMs: number): number {
  if (rawDiffMs <= 0) return 0;
  return rawDiffMs >= U32_MAX ? U32_MAX : Math.trunc(rawDiffMs) >>> 0;
}

/**
 * Contiguous Structure-of-Arrays (SoA) column store for pairwise customer wager cross-referencing
 * backed by a single aligned `ArrayBuffer` slab (`alignedCapacity = (capacity + 3) & ~3`).
 */
export class PairwiseWagerColumnStore {
  public readonly buffer: ArrayBuffer;
  public readonly capacity: number;
  public readonly alignedCapacity: number;
  public length = 0;

  // 64-bit signed monetary column (`1:1` Cents) + stride-2 64-bit unsigned columns
  public readonly stakeCentsI64Col: BigInt64Array;
  public readonly loginKey32WordsCol: Uint32Array;
  public readonly betGroupOrWagerId32WordsCol: Uint32Array;
  public readonly placedAtEpochMs32WordsCol: Uint32Array;

  // 32-bit & 16-bit columnar coordinates
  public readonly canonicalRot20Col: Uint32Array;
  public readonly lineHundredthsI32Col: Int32Array;
  public readonly oddsAmericanI32Col: Int32Array;
  public readonly flagsBitSet32Col: Uint32Array;
  public readonly packedComboKey15Col: Uint16Array;
  public readonly concurrentEventAccountCountU16Col: Uint16Array;

  // 8-bit provenance & side columns
  public readonly sourceBridgeU8Col: Uint8Array;
  public readonly sideCodeU8Col: Uint8Array; // 0 = AWAY/OVER, 1 = HOME/UNDER, 2 = DRAW

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `ERR_DOD_BITFIELD_RANGE_OVERFLOW: capacity=${String(capacity)}`,
      );
    }
    this.capacity = capacity;
    const aligned = (capacity + 3) & ~3;
    this.alignedCapacity = aligned;
    this.buffer = new ArrayBuffer(aligned * PAIRWISE_WAGER_SOA_ROW_BYTES);

    // Every offset below is a multiple of at least 4*aligned (and 8*aligned for 8-byte views).
    this.stakeCentsI64Col = new BigInt64Array(this.buffer, 0, aligned);
    this.loginKey32WordsCol = new Uint32Array(
      this.buffer,
      8 * aligned,
      aligned * 2,
    );
    this.betGroupOrWagerId32WordsCol = new Uint32Array(
      this.buffer,
      16 * aligned,
      aligned * 2,
    );
    this.placedAtEpochMs32WordsCol = new Uint32Array(
      this.buffer,
      24 * aligned,
      aligned * 2,
    );
    this.canonicalRot20Col = new Uint32Array(
      this.buffer,
      32 * aligned,
      aligned,
    );
    this.lineHundredthsI32Col = new Int32Array(
      this.buffer,
      36 * aligned,
      aligned,
    );
    this.oddsAmericanI32Col = new Int32Array(
      this.buffer,
      40 * aligned,
      aligned,
    );
    this.flagsBitSet32Col = new Uint32Array(this.buffer, 44 * aligned, aligned);
    this.packedComboKey15Col = new Uint16Array(
      this.buffer,
      48 * aligned,
      aligned,
    );
    this.concurrentEventAccountCountU16Col = new Uint16Array(
      this.buffer,
      50 * aligned,
      aligned,
    );
    this.sourceBridgeU8Col = new Uint8Array(this.buffer, 52 * aligned, aligned);
    this.sideCodeU8Col = new Uint8Array(this.buffer, 53 * aligned, aligned);
  }

  public readPlacedAtEpochMs(rowIndex: number): number {
    return readEpochMs64Stride2(this.placedAtEpochMs32WordsCol, rowIndex << 1);
  }

  public appendLeg(
    rawCustomerId: string,
    wagerOrGroupId64: bigint,
    rawRotation: number,
    packedComboKey15: SubSportComboPackedKey15,
    lineHundredths: LineHundredths,
    oddsAmerican: number,
    stakeCents: bigint | Cents,
    placedAtEpochMs: number | bigint,
    sourceBridgeId2: SourceBridgeId2,
    sideCode2: number,
    extraFlags32 = 0,
    concurrentEventAccounts = 1,
  ): number {
    if (sourceBridgeId2 === SOURCE_BRIDGE_IDS.INGEST_STAGE1_DROP) {
      return -1;
    }
    const missingEpoch =
      typeof placedAtEpochMs === "bigint"
        ? placedAtEpochMs <= 0n
        : !Number.isFinite(placedAtEpochMs) || placedAtEpochMs <= 0;
    if (missingEpoch) {
      throw new Error(
        "ERR_PENDING_TRUNCATED_TICKET: missing upstream placedAt epoch",
      );
    }
    if (this.length >= this.capacity) {
      throw new Error("ERR_ROUTER_INLINE_LEG_OVERFLOW");
    }

    const rowIndex = this.length++;
    const wordSlot = rowIndex << 1;

    hashCustomerLogin64Stride2(
      rawCustomerId,
      this.loginKey32WordsCol,
      wordSlot,
    );
    this.betGroupOrWagerId32WordsCol[wordSlot] =
      Number(wagerOrGroupId64 & 0xffffffffn) >>> 0;
    this.betGroupOrWagerId32WordsCol[wordSlot + 1] =
      Number((wagerOrGroupId64 >> 32n) & 0xffffffffn) >>> 0;
    writeEpochMs64Stride2(
      placedAtEpochMs,
      this.placedAtEpochMs32WordsCol,
      wordSlot,
    );

    const { canonicalRot20, flagMask32 } =
      normalizeCanonicalRotation20(rawRotation);
    this.canonicalRot20Col[rowIndex] = canonicalRot20;
    this.packedComboKey15Col[rowIndex] = packedComboKey15 & COMBO_KEY15_MASK;
    this.lineHundredthsI32Col[rowIndex] = Math.trunc(lineHundredths) | 0;
    this.oddsAmericanI32Col[rowIndex] = oddsAmerican | 0;
    this.stakeCentsI64Col[rowIndex] =
      typeof stakeCents === "bigint"
        ? stakeCents
        : BigInt(Math.trunc(stakeCents));
    this.sourceBridgeU8Col[rowIndex] = sourceBridgeId2;
    this.sideCodeU8Col[rowIndex] = sideCode2 & 0x03;
    this.flagsBitSet32Col[rowIndex] = (flagMask32 | extraFlags32) >>> 0;
    this.concurrentEventAccountCountU16Col[rowIndex] =
      concurrentEventAccounts & 0xffff;

    return rowIndex;
  }
}

/**
 * Contiguous Structure-of-Arrays (SoA) column store for deduplicated pairwise overlap results.
 */
export class PairwiseOverlapColumnStore {
  public readonly buffer: ArrayBuffer;
  public readonly capacity: number;
  public readonly alignedCapacity: number;
  public length = 0;

  public readonly canonicalRot20Col: Uint32Array;
  public readonly rowIndexACol: Uint32Array;
  public readonly rowIndexBCol: Uint32Array;
  public readonly lagMsU32Col: Uint32Array;
  public readonly packedComboKey15Col: Uint16Array;
  public readonly overlapKindU8Col: Uint8Array;
  public readonly regimeMask2U8Col: Uint8Array;
  public readonly initiatorCodeU8Col: Uint8Array;
  public readonly flagsU8Col: Uint8Array;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `ERR_DOD_BITFIELD_RANGE_OVERFLOW: capacity=${String(capacity)}`,
      );
    }
    this.capacity = capacity;
    const aligned = (capacity + 3) & ~3;
    this.alignedCapacity = aligned;
    this.buffer = new ArrayBuffer(aligned * PAIRWISE_OVERLAP_SOA_ROW_BYTES);

    this.canonicalRot20Col = new Uint32Array(this.buffer, 0, aligned);
    this.rowIndexACol = new Uint32Array(this.buffer, 4 * aligned, aligned);
    this.rowIndexBCol = new Uint32Array(this.buffer, 8 * aligned, aligned);
    this.lagMsU32Col = new Uint32Array(this.buffer, 12 * aligned, aligned);
    this.packedComboKey15Col = new Uint16Array(
      this.buffer,
      16 * aligned,
      aligned,
    );
    this.overlapKindU8Col = new Uint8Array(this.buffer, 18 * aligned, aligned);
    this.regimeMask2U8Col = new Uint8Array(this.buffer, 19 * aligned, aligned);
    this.initiatorCodeU8Col = new Uint8Array(
      this.buffer,
      20 * aligned,
      aligned,
    );
    this.flagsU8Col = new Uint8Array(this.buffer, 21 * aligned, aligned);
  }

  public appendOverlap(
    canonicalRot20: number,
    packedComboKey15: SubSportComboPackedKey15,
    rowIndexA: number,
    rowIndexB: number,
    lagMsU32: number,
    overlapKind: OverlapKindCode,
    regimeMask2: RegimeMask2,
    initiatorCodeU8: InitiatorCodeU8,
    lineSigMatch: boolean,
    broadcastSurgeSuppressed: boolean,
  ): number {
    if (this.length >= this.capacity) {
      throw new Error("ERR_ROUTER_INLINE_LEG_OVERFLOW");
    }
    const idx = this.length++;
    this.canonicalRot20Col[idx] = canonicalRot20 >>> 0;
    this.rowIndexACol[idx] = rowIndexA >>> 0;
    this.rowIndexBCol[idx] = rowIndexB >>> 0;
    this.lagMsU32Col[idx] = lagMsU32 >>> 0;
    this.packedComboKey15Col[idx] = packedComboKey15 & COMBO_KEY15_MASK;
    this.overlapKindU8Col[idx] = overlapKind;
    this.regimeMask2U8Col[idx] = regimeMask2;
    this.initiatorCodeU8Col[idx] = initiatorCodeU8;
    this.flagsU8Col[idx] =
      (lineSigMatch ? OVERLAP_FLAG_LINE_SIG_MATCH : 0) |
      (broadcastSurgeSuppressed ? OVERLAP_FLAG_BROADCAST_SURGE_SUPPRESSED : 0);
    return idx;
  }

  public toRecords(limit = this.length): readonly PairwiseOverlapRecord[] {
    const count = Math.min(this.length, Math.max(0, Math.trunc(limit)));
    const out: PairwiseOverlapRecord[] = [];
    for (let i = 0; i < count; i++) {
      const initiatorRaw = this.initiatorCodeU8Col[i]!;
      const initiatorCode: "CUSTOMER_A" | "CUSTOMER_B" | "SIMULTANEOUS" =
        initiatorRaw === INITIATOR_CUSTOMER_A
          ? "CUSTOMER_A"
          : initiatorRaw === INITIATOR_CUSTOMER_B
            ? "CUSTOMER_B"
            : "SIMULTANEOUS";
      const flags = this.flagsU8Col[i]!;
      out.push({
        canonicalRot20: this.canonicalRot20Col[i]!,
        packedComboKey15: this.packedComboKey15Col[i]!,
        rowIndexA: this.rowIndexACol[i]!,
        rowIndexB: this.rowIndexBCol[i]!,
        lagMsU32: this.lagMsU32Col[i]!,
        overlapKind: this.overlapKindU8Col[i]! as OverlapKindCode,
        regimeMask2: this.regimeMask2U8Col[i]! as RegimeMask2,
        initiatorCode,
        lineSigMatch: (flags & OVERLAP_FLAG_LINE_SIG_MATCH) !== 0,
        broadcastSurgeSuppressed:
          (flags & OVERLAP_FLAG_BROADCAST_SURGE_SUPPRESSED) !== 0,
      });
    }
    return out;
  }
}

/**
 * Serializes `store` as a contiguous 16-byte header (`[magic=0x534f4157, version=1, rowCount, alignedCount]`)
 * followed by aligned column slices for `alignedCount = (rowCount + 3) & ~3`.
 */
export function encodePairwiseSoAChunk(
  store: PairwiseWagerColumnStore,
): Uint8Array {
  const rowCount = store.length >>> 0;
  const alignedCount = (rowCount + 3) & ~3;
  const outBuffer = new ArrayBuffer(
    PAIRWISE_SOA_HEADER_BYTES + alignedCount * PAIRWISE_WAGER_SOA_ROW_BYTES,
  );
  const headerView = new DataView(outBuffer, 0, PAIRWISE_SOA_HEADER_BYTES);
  headerView.setUint32(0, PAIRWISE_SOA_CHUNK_MAGIC, true);
  headerView.setUint32(4, PAIRWISE_SOA_CHUNK_VERSION, true);
  headerView.setUint32(8, rowCount, true);
  headerView.setUint32(12, alignedCount, true);

  if (rowCount > 0) {
    const base = PAIRWISE_SOA_HEADER_BYTES;
    new BigInt64Array(outBuffer, base, alignedCount).set(
      store.stakeCentsI64Col.subarray(0, rowCount),
    );
    new Uint32Array(outBuffer, base + 8 * alignedCount, alignedCount * 2).set(
      store.loginKey32WordsCol.subarray(0, rowCount * 2),
    );
    new Uint32Array(outBuffer, base + 16 * alignedCount, alignedCount * 2).set(
      store.betGroupOrWagerId32WordsCol.subarray(0, rowCount * 2),
    );
    new Uint32Array(outBuffer, base + 24 * alignedCount, alignedCount * 2).set(
      store.placedAtEpochMs32WordsCol.subarray(0, rowCount * 2),
    );
    new Uint32Array(outBuffer, base + 32 * alignedCount, alignedCount).set(
      store.canonicalRot20Col.subarray(0, rowCount),
    );
    new Int32Array(outBuffer, base + 36 * alignedCount, alignedCount).set(
      store.lineHundredthsI32Col.subarray(0, rowCount),
    );
    new Int32Array(outBuffer, base + 40 * alignedCount, alignedCount).set(
      store.oddsAmericanI32Col.subarray(0, rowCount),
    );
    new Uint32Array(outBuffer, base + 44 * alignedCount, alignedCount).set(
      store.flagsBitSet32Col.subarray(0, rowCount),
    );
    new Uint16Array(outBuffer, base + 48 * alignedCount, alignedCount).set(
      store.packedComboKey15Col.subarray(0, rowCount),
    );
    new Uint16Array(outBuffer, base + 50 * alignedCount, alignedCount).set(
      store.concurrentEventAccountCountU16Col.subarray(0, rowCount),
    );
    new Uint8Array(outBuffer, base + 52 * alignedCount, alignedCount).set(
      store.sourceBridgeU8Col.subarray(0, rowCount),
    );
    new Uint8Array(outBuffer, base + 53 * alignedCount, alignedCount).set(
      store.sideCodeU8Col.subarray(0, rowCount),
    );
  }

  return new Uint8Array(outBuffer);
}

/**
 * Hydrates a contiguous SoA binary chunk into `targetStore`. Skips `INGEST_STAGE1_DROP` rows and
 * throws `ERR_BRIDGE_CHANNEL_CONTAMINATION` when `expectedBridgeId2 !== "ALL"` mismatches a row.
 */
export function hydratePairwiseColumnStoreFromSoAChunk(
  chunkBytes: Uint8Array,
  expectedBridgeId2: SourceBridgeId2 | "ALL",
  targetStore: PairwiseWagerColumnStore,
): number {
  if (chunkBytes.byteLength < PAIRWISE_SOA_HEADER_BYTES) {
    throw new Error(
      "ERR_SOA_BINARY_TRUNCATED: chunk is smaller than 16-byte SoA header",
    );
  }

  const view = new DataView(
    chunkBytes.buffer,
    chunkBytes.byteOffset,
    chunkBytes.byteLength,
  );
  const magic = view.getUint32(0, true);
  if (magic !== PAIRWISE_SOA_CHUNK_MAGIC) {
    throw new Error(
      `ERR_SOA_BINARY_BAD_MAGIC: expected 0x${PAIRWISE_SOA_CHUNK_MAGIC.toString(16)}, found 0x${magic.toString(16)}`,
    );
  }
  const version = view.getUint32(4, true);
  if (version !== PAIRWISE_SOA_CHUNK_VERSION) {
    throw new Error(
      `ERR_SOA_BINARY_VERSION_MISMATCH: unsupported version ${String(version)}`,
    );
  }
  const rowCount = view.getUint32(8, true);
  const alignedCount = view.getUint32(12, true);
  const requiredBytes =
    PAIRWISE_SOA_HEADER_BYTES + alignedCount * PAIRWISE_WAGER_SOA_ROW_BYTES;
  if (
    (alignedCount & 3) !== 0 ||
    alignedCount < rowCount ||
    chunkBytes.byteLength < requiredBytes
  ) {
    throw new Error(
      `ERR_SOA_BINARY_PAYLOAD_TRUNCATED: expected ${requiredBytes} bytes, got ${chunkBytes.byteLength}`,
    );
  }

  const base = PAIRWISE_SOA_HEADER_BYTES;
  const offStake = base;
  const offLogin = base + 8 * alignedCount;
  const offGroup = base + 16 * alignedCount;
  const offPlaced = base + 24 * alignedCount;
  const offRot = base + 32 * alignedCount;
  const offLine = base + 36 * alignedCount;
  const offOdds = base + 40 * alignedCount;
  const offFlags = base + 44 * alignedCount;
  const offCombo = base + 48 * alignedCount;
  const offConc = base + 50 * alignedCount;
  const offBridge = base + 52 * alignedCount;
  const offSide = base + 53 * alignedCount;

  let loaded = 0;
  for (let srcRow = 0; srcRow < rowCount; srcRow++) {
    const rowBridgeId2 = view.getUint8(offBridge + srcRow) as SourceBridgeId2;
    if (rowBridgeId2 === SOURCE_BRIDGE_IDS.INGEST_STAGE1_DROP) {
      continue;
    }
    if (expectedBridgeId2 !== "ALL" && rowBridgeId2 !== expectedBridgeId2) {
      throw new Error("ERR_BRIDGE_CHANNEL_CONTAMINATION");
    }
    if (targetStore.length >= targetStore.capacity) {
      throw new Error("ERR_ROUTER_INLINE_LEG_OVERFLOW");
    }

    const dstRow = targetStore.length++;
    const srcWord8 = srcRow << 3;
    const dstWordSlot = dstRow << 1;

    targetStore.stakeCentsI64Col[dstRow] = view.getBigInt64(
      offStake + srcWord8,
      true,
    );
    targetStore.loginKey32WordsCol[dstWordSlot] = view.getUint32(
      offLogin + srcWord8,
      true,
    );
    targetStore.loginKey32WordsCol[dstWordSlot + 1] = view.getUint32(
      offLogin + srcWord8 + 4,
      true,
    );
    targetStore.betGroupOrWagerId32WordsCol[dstWordSlot] = view.getUint32(
      offGroup + srcWord8,
      true,
    );
    targetStore.betGroupOrWagerId32WordsCol[dstWordSlot + 1] = view.getUint32(
      offGroup + srcWord8 + 4,
      true,
    );
    targetStore.placedAtEpochMs32WordsCol[dstWordSlot] = view.getUint32(
      offPlaced + srcWord8,
      true,
    );
    targetStore.placedAtEpochMs32WordsCol[dstWordSlot + 1] = view.getUint32(
      offPlaced + srcWord8 + 4,
      true,
    );
    targetStore.canonicalRot20Col[dstRow] =
      view.getUint32(offRot + (srcRow << 2), true) & BINARY_ROT_MASK_20;
    targetStore.lineHundredthsI32Col[dstRow] = view.getInt32(
      offLine + (srcRow << 2),
      true,
    );
    targetStore.oddsAmericanI32Col[dstRow] = view.getInt32(
      offOdds + (srcRow << 2),
      true,
    );
    targetStore.flagsBitSet32Col[dstRow] = view.getUint32(
      offFlags + (srcRow << 2),
      true,
    );
    targetStore.packedComboKey15Col[dstRow] =
      view.getUint16(offCombo + (srcRow << 1), true) & COMBO_KEY15_MASK;
    targetStore.concurrentEventAccountCountU16Col[dstRow] = view.getUint16(
      offConc + (srcRow << 1),
      true,
    );
    targetStore.sourceBridgeU8Col[dstRow] = rowBridgeId2;
    targetStore.sideCodeU8Col[dstRow] = view.getUint8(offSide + srcRow) & 0x03;
    loaded++;
  }

  return loaded;
}

export interface PairwiseOverlapRecord {
  readonly canonicalRot20: number;
  readonly packedComboKey15: SubSportComboPackedKey15;
  readonly rowIndexA: number;
  readonly rowIndexB: number;
  readonly lagMsU32: number;
  readonly overlapKind: OverlapKindCode;
  readonly regimeMask2: RegimeMask2;
  readonly initiatorCode: "CUSTOMER_A" | "CUSTOMER_B" | "SIMULTANEOUS";
  readonly lineSigMatch: boolean;
  readonly broadcastSurgeSuppressed: boolean;
}

export interface PairwiseCrossRefResult {
  readonly customerA: string;
  readonly customerB: string;
  readonly bridgeFilter: SourceBridgeId2 | "ALL";
  readonly totalWagersA: number;
  readonly totalWagersB: number;
  readonly catalogDistinctEvents: number;
  readonly distinctEventsA: number;
  readonly distinctEventsB: number;
  readonly sharedEventsCount: number;
  readonly sameSideCount: number;
  readonly oppositeSideCount: number;
  readonly differentMarketCount: number;
  readonly suppressedBroadcastSurgeCount: number;
  readonly liveBotFollowsAtoB: number;
  readonly liveBotFollowsBtoA: number;
  readonly pregameApiBotFollowsAtoB: number;
  readonly pregameApiBotFollowsBtoA: number;
  readonly pregameFollowsAtoB: number;
  readonly pregameFollowsBtoA: number;
  readonly avgSameSideLagMsU32: number;
  readonly minSameSideLagMsU32: number;
  readonly customerALeadShareBps: BasisPoints;
  readonly bAbsentParticipationBps: BasisPoints;
  readonly bPresentParticipationBps: BasisPoints;
  readonly liftRatioBps: BasisPoints;
  readonly inferredRoleB:
    "ORIGIN_LEADER" | "BRIDGE_RELAY" | "COPY_FOLLOWER" | "INDEPENDENT";
  readonly overlapStore: PairwiseOverlapColumnStore;
  readonly overlaps: readonly PairwiseOverlapRecord[];
}

function countDistinctSortedU32Runs(
  sorted: Uint32Array,
  len: number,
  readValue: (item: number) => number,
): number {
  let distinct = 0;
  let prev = 0;
  for (let i = 0; i < len; i++) {
    const current = readValue(sorted[i]!);
    if (i === 0 || current !== prev) {
      distinct++;
      prev = current;
    }
  }
  return distinct;
}

/**
 * Zero-`Set` / Zero-`Map` columnar pairwise cross-reference evaluator with follower deduplication.
 * Each follower wager binds at most once to its closest preceding qualifying leader wager.
 */
export function evaluateColumnarPairwiseCrossRef(
  store: PairwiseWagerColumnStore,
  customerA: string,
  customerB: string,
  options?: {
    readonly bridgeFilter?: SourceBridgeId2 | "ALL";
    readonly maxSampleOverlaps?: number;
    readonly catalogDistinctEventsOverride?: number;
  },
): PairwiseCrossRefResult {
  const normA = normalizeCustomerId(customerA);
  const normB = normalizeCustomerId(customerB);
  const bridgeFilter = options?.bridgeFilter ?? "ALL";
  const maxSampleOverlaps = options?.maxSampleOverlaps ?? 16;

  const targetKeys32 = new Uint32Array(4);
  hashCustomerLogin64Stride2(normA, targetKeys32, 0);
  hashCustomerLogin64Stride2(normB, targetKeys32, 2);

  const keyALo32 = targetKeys32[0]!;
  const keyAHi32 = targetKeys32[1]!;
  const keyBLo32 = targetKeys32[2]!;
  const keyBHi32 = targetKeys32[3]!;

  let countA = 0;
  let countB = 0;
  let activeCatalogRows = 0;

  for (let rowIndex = 0; rowIndex < store.length; rowIndex++) {
    const rowBridge = store.sourceBridgeU8Col[rowIndex]!;
    if (rowBridge === SOURCE_BRIDGE_IDS.INGEST_STAGE1_DROP) {
      throw new Error("ERR_BRIDGE_CHANNEL_CONTAMINATION");
    }
    if (bridgeFilter !== "ALL" && rowBridge !== bridgeFilter) {
      continue;
    }
    activeCatalogRows++;
    const wordSlot = rowIndex << 1;
    const lo32 = store.loginKey32WordsCol[wordSlot]!;
    const hi32 = store.loginKey32WordsCol[wordSlot + 1]!;
    if (lo32 === keyALo32 && hi32 === keyAHi32) countA++;
    else if (lo32 === keyBLo32 && hi32 === keyBHi32) countB++;
  }

  const indicesA = new Uint32Array(countA);
  const indicesB = new Uint32Array(countB);
  const catalogRots = new Uint32Array(
    options?.catalogDistinctEventsOverride === undefined
      ? activeCatalogRows
      : 0,
  );
  let writeOffsetA = 0;
  let writeOffsetB = 0;
  let writeOffsetCat = 0;

  for (let rowIndex = 0; rowIndex < store.length; rowIndex++) {
    const rowBridge = store.sourceBridgeU8Col[rowIndex]!;
    if (bridgeFilter !== "ALL" && rowBridge !== bridgeFilter) {
      continue;
    }
    if (options?.catalogDistinctEventsOverride === undefined) {
      catalogRots[writeOffsetCat++] = store.canonicalRot20Col[rowIndex]!;
    }
    const wordSlot = rowIndex << 1;
    const lo32 = store.loginKey32WordsCol[wordSlot]!;
    const hi32 = store.loginKey32WordsCol[wordSlot + 1]!;
    if (lo32 === keyALo32 && hi32 === keyAHi32) {
      indicesA[writeOffsetA++] = rowIndex;
    } else if (lo32 === keyBLo32 && hi32 === keyBHi32) {
      indicesB[writeOffsetB++] = rowIndex;
    }
  }

  const sortByRotAndTime = (rowLeft: number, rowRight: number): number => {
    const rotDiff =
      (store.canonicalRot20Col[rowLeft]! >>> 0) -
      (store.canonicalRot20Col[rowRight]! >>> 0);
    if (rotDiff !== 0) return rotDiff;
    return compareEpochMsStride2(
      store.placedAtEpochMs32WordsCol,
      rowLeft,
      rowRight,
    );
  };
  indicesA.sort(sortByRotAndTime);
  indicesB.sort(sortByRotAndTime);

  const distinctEventsA = countDistinctSortedU32Runs(
    indicesA,
    countA,
    (rowIdx) => store.canonicalRot20Col[rowIdx]!,
  );
  const distinctEventsB = countDistinctSortedU32Runs(
    indicesB,
    countB,
    (rowIdx) => store.canonicalRot20Col[rowIdx]!,
  );

  let catalogDistinctEvents: number;
  if (options?.catalogDistinctEventsOverride !== undefined) {
    catalogDistinctEvents = Math.max(
      1,
      Math.trunc(options.catalogDistinctEventsOverride),
    );
  } else {
    catalogRots.sort();
    catalogDistinctEvents = Math.max(
      1,
      countDistinctSortedU32Runs(catalogRots, writeOffsetCat, (rot) => rot),
    );
  }

  // Deduplicated overlap arena bounded linearly by countA + countB (never Cartesian countA * countB).
  const overlapStore = new PairwiseOverlapColumnStore(
    Math.max(1, countA + countB),
  );
  const matchedA = new Uint8Array(countA);
  const matchedB = new Uint8Array(countB);

  let cursorA = 0;
  let cursorB = 0;
  let sharedEventsCount = 0;
  let sameSideCount = 0;
  let oppositeSideCount = 0;
  let differentMarketCount = 0;
  let suppressedBroadcastSurgeCount = 0;
  let liveBotFollowsAtoB = 0;
  let liveBotFollowsBtoA = 0;
  let pregameApiBotFollowsAtoB = 0;
  let pregameApiBotFollowsBtoA = 0;
  let pregameFollowsAtoB = 0;
  let pregameFollowsBtoA = 0;
  let aLedSameSideCount = 0;
  let bLedSameSideCount = 0;
  let totalSameSideLagMs = 0;
  let minSameSideLagMsU32 = U32_MAX;

  const inspectPairMarketAndLine = (
    rowA: number,
    rowB: number,
    absLagMsU32: number,
  ): {
    readonly key15A: number;
    readonly key15B: number;
    readonly sameMarket: boolean;
    readonly regime: WagerRegime;
    readonly regimeMask2: RegimeMask2;
    readonly lineSigMatch: boolean;
    readonly broadcastSurgeSuppressed: boolean;
  } => {
    const key15A = store.packedComboKey15Col[rowA]!;
    const key15B = store.packedComboKey15Col[rowB]!;
    const unpackedA = unpackSubSportComboKey15(key15A);
    const unpackedB = unpackSubSportComboKey15(key15B);
    const bridgeA = store.sourceBridgeU8Col[rowA]!;
    const bridgeB = store.sourceBridgeU8Col[rowB]!;
    const flagsA = store.flagsBitSet32Col[rowA]!;
    const flagsB = store.flagsBitSet32Col[rowB]!;
    const isGsLiveBridge =
      bridgeA === SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C ||
      bridgeB === SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C ||
      ((flagsA | flagsB) & LEG_FLAG_IS_LIVE_INPLAY) !== 0;
    const regimeA = classifyWagerRegime(key15A, isGsLiveBridge);
    const regimeB = classifyWagerRegime(key15B, isGsLiveBridge);
    const regime: WagerRegime =
      regimeA === "LIVE_IN_PLAY" || regimeB === "LIVE_IN_PLAY"
        ? "LIVE_IN_PLAY"
        : "PREGAME";
    const regimeMask2: RegimeMask2 =
      regime === "LIVE_IN_PLAY" ? REGIME_LIVE_IN_PLAY : REGIME_PREGAME;
    const sameMarket =
      unpackedA.periodCode4 === unpackedB.periodCode4 &&
      unpackedA.marketKindCode2 === unpackedB.marketKindCode2;

    if (!sameMarket) {
      return {
        key15A,
        key15B,
        sameMarket: false,
        regime,
        regimeMask2,
        lineSigMatch: false,
        broadcastSurgeSuppressed: false,
      };
    }

    const lineSigA = computeRegimeLineSig32(
      regime,
      store.sideCodeU8Col[rowA]!,
      unpackedA.marketKindCode2,
      store.lineHundredthsI32Col[rowA]!,
    );
    const lineSigB = computeRegimeLineSig32(
      regime,
      store.sideCodeU8Col[rowB]!,
      unpackedB.marketKindCode2,
      store.lineHundredthsI32Col[rowB]!,
    );
    const lineSigMatch = lineSigA === lineSigB;
    const maxConcurrentAccounts = Math.max(
      store.concurrentEventAccountCountU16Col[rowA]!,
      store.concurrentEventAccountCountU16Col[rowB]!,
    );
    const broadcastSurgeSuppressed =
      regime === "LIVE_IN_PLAY" &&
      absLagMsU32 <= LIVE_BROADCAST_SURGE_WINDOW_MS &&
      maxConcurrentAccounts > LIVE_BROADCAST_SURGE_ACCOUNT_CAP;

    return {
      key15A,
      key15B,
      sameMarket: true,
      regime,
      regimeMask2,
      lineSigMatch,
      broadcastSurgeSuppressed,
    };
  };

  while (cursorA < countA && cursorB < countB) {
    const rotA = store.canonicalRot20Col[indicesA[cursorA]!]!;
    const rotB = store.canonicalRot20Col[indicesB[cursorB]!]!;

    if (rotA < rotB) {
      cursorA++;
      continue;
    }
    if (rotB < rotA) {
      cursorB++;
      continue;
    }

    sharedEventsCount++;
    const runStartA = cursorA;
    while (
      cursorA < countA &&
      store.canonicalRot20Col[indicesA[cursorA]!] === rotA
    ) {
      cursorA++;
    }
    const runEndA = cursorA;

    const runStartB = cursorB;
    while (
      cursorB < countB &&
      store.canonicalRot20Col[indicesB[cursorB]!] === rotB
    ) {
      cursorB++;
    }
    const runEndB = cursorB;

    // Pass 1 (A -> B): bind each B wager at most once to its closest preceding qualifying A leader.
    for (let offsetB = runStartB; offsetB < runEndB; offsetB++) {
      const rowB = indicesB[offsetB]!;
      const tB = readEpochMs64Stride2(
        store.placedAtEpochMs32WordsCol,
        rowB << 1,
      );
      const sideB = store.sideCodeU8Col[rowB]!;
      const unpackedB = unpackSubSportComboKey15(
        store.packedComboKey15Col[rowB]!,
      );

      let bestOffsetA = -1;
      let bestLagMsU32 = U32_MAX;
      let bestLineSigMatch = false;
      let bestRegime: WagerRegime = "PREGAME";
      let bestRegimeMask2: RegimeMask2 = REGIME_PREGAME;
      let bestSurgeSuppressed = false;
      let bestKey15A = 0;

      for (let offsetA = runStartA; offsetA < runEndA; offsetA++) {
        const rowA = indicesA[offsetA]!;
        const tA = readEpochMs64Stride2(
          store.placedAtEpochMs32WordsCol,
          rowA << 1,
        );
        if (tA > tB) break;

        if (store.sideCodeU8Col[rowA]! !== sideB) continue;
        const key15A = store.packedComboKey15Col[rowA]!;
        const unpackedA = unpackSubSportComboKey15(key15A);
        if (
          unpackedA.periodCode4 !== unpackedB.periodCode4 ||
          unpackedA.marketKindCode2 !== unpackedB.marketKindCode2
        ) {
          continue;
        }

        const lagMsU32 = clampLagMsU32(tB - tA);
        const info = inspectPairMarketAndLine(rowA, rowB, lagMsU32);
        const isBetter =
          bestOffsetA === -1 ||
          (info.lineSigMatch && !bestLineSigMatch) ||
          (info.lineSigMatch === bestLineSigMatch && lagMsU32 <= bestLagMsU32);
        if (isBetter) {
          bestOffsetA = offsetA;
          bestLagMsU32 = lagMsU32;
          bestLineSigMatch = info.lineSigMatch;
          bestRegime = info.regime;
          bestRegimeMask2 = info.regimeMask2;
          bestSurgeSuppressed = info.broadcastSurgeSuppressed;
          bestKey15A = info.key15A;
        }
      }

      if (bestOffsetA !== -1) {
        const rowA = indicesA[bestOffsetA]!;
        const tA = readEpochMs64Stride2(
          store.placedAtEpochMs32WordsCol,
          rowA << 1,
        );
        const isSimultaneous = tA === tB;
        matchedB[offsetB] = 1;
        matchedA[bestOffsetA] = 1;

        if (bestSurgeSuppressed) suppressedBroadcastSurgeCount++;
        sameSideCount++;
        totalSameSideLagMs += bestLagMsU32;
        if (bestLagMsU32 < minSameSideLagMsU32) {
          minSameSideLagMsU32 = bestLagMsU32;
        }
        if (!isSimultaneous) {
          aLedSameSideCount++;
          if (!bestSurgeSuppressed) {
            if (
              bestRegime === "LIVE_IN_PLAY" &&
              bestLagMsU32 <= LIVE_BOT_FOLLOW_WINDOW_MS
            ) {
              liveBotFollowsAtoB++;
            } else if (bestRegime === "PREGAME" && bestLineSigMatch) {
              if (bestLagMsU32 <= PREGAME_API_BOT_WINDOW_MS) {
                pregameApiBotFollowsAtoB++;
                pregameFollowsAtoB++;
              } else if (bestLagMsU32 <= PREGAME_TIP_CHANNEL_WINDOW_MS) {
                pregameFollowsAtoB++;
              }
            }
          }
        }

        overlapStore.appendOverlap(
          rotA,
          bestKey15A,
          rowA,
          rowB,
          bestLagMsU32,
          OVERLAP_SAME_SIDE,
          bestRegimeMask2,
          isSimultaneous ? INITIATOR_SIMULTANEOUS : INITIATOR_CUSTOMER_A,
          bestLineSigMatch,
          bestSurgeSuppressed,
        );
      }
    }

    // Pass 2 (B -> A): bind each unmatched A wager at most once to its closest strictly preceding
    // qualifying B leader when no same-side A wager on that market preceded the earliest B wager.
    for (let offsetA = runStartA; offsetA < runEndA; offsetA++) {
      if (matchedA[offsetA] === 1) continue;
      const rowA = indicesA[offsetA]!;
      const tA = readEpochMs64Stride2(
        store.placedAtEpochMs32WordsCol,
        rowA << 1,
      );
      const sideA = store.sideCodeU8Col[rowA]!;
      const key15A = store.packedComboKey15Col[rowA]!;
      const unpackedA = unpackSubSportComboKey15(key15A);

      let earliestBMs = -1;
      for (let offsetB = runStartB; offsetB < runEndB; offsetB++) {
        const rowB = indicesB[offsetB]!;
        const tB = readEpochMs64Stride2(
          store.placedAtEpochMs32WordsCol,
          rowB << 1,
        );
        if (tB >= tA) break;
        if (store.sideCodeU8Col[rowB]! !== sideA) continue;
        const unpackedB = unpackSubSportComboKey15(
          store.packedComboKey15Col[rowB]!,
        );
        if (
          unpackedB.periodCode4 === unpackedA.periodCode4 &&
          unpackedB.marketKindCode2 === unpackedA.marketKindCode2
        ) {
          earliestBMs = tB;
          break;
        }
      }
      if (earliestBMs < 0) continue;

      let aPrecededEarliestB = false;
      for (let offsetA0 = runStartA; offsetA0 < offsetA; offsetA0++) {
        const rowA0 = indicesA[offsetA0]!;
        const tA0 = readEpochMs64Stride2(
          store.placedAtEpochMs32WordsCol,
          rowA0 << 1,
        );
        if (tA0 > earliestBMs) break;
        if (store.sideCodeU8Col[rowA0]! !== sideA) continue;
        const unpackedA0 = unpackSubSportComboKey15(
          store.packedComboKey15Col[rowA0]!,
        );
        if (
          unpackedA0.periodCode4 === unpackedA.periodCode4 &&
          unpackedA0.marketKindCode2 === unpackedA.marketKindCode2
        ) {
          aPrecededEarliestB = true;
          break;
        }
      }
      if (aPrecededEarliestB) continue;

      let bestOffsetB = -1;
      let bestLagMsU32 = U32_MAX;
      let bestLineSigMatch = false;
      let bestRegime: WagerRegime = "PREGAME";
      let bestRegimeMask2: RegimeMask2 = REGIME_PREGAME;
      let bestSurgeSuppressed = false;

      for (let offsetB = runStartB; offsetB < runEndB; offsetB++) {
        const rowB = indicesB[offsetB]!;
        const tB = readEpochMs64Stride2(
          store.placedAtEpochMs32WordsCol,
          rowB << 1,
        );
        if (tB >= tA) break;
        if (store.sideCodeU8Col[rowB]! !== sideA) continue;
        const unpackedB = unpackSubSportComboKey15(
          store.packedComboKey15Col[rowB]!,
        );
        if (
          unpackedB.periodCode4 !== unpackedA.periodCode4 ||
          unpackedB.marketKindCode2 !== unpackedA.marketKindCode2
        ) {
          continue;
        }

        const lagMsU32 = clampLagMsU32(tA - tB);
        const info = inspectPairMarketAndLine(rowA, rowB, lagMsU32);
        const isBetter =
          bestOffsetB === -1 ||
          (info.lineSigMatch && !bestLineSigMatch) ||
          (info.lineSigMatch === bestLineSigMatch && lagMsU32 <= bestLagMsU32);
        if (isBetter) {
          bestOffsetB = offsetB;
          bestLagMsU32 = lagMsU32;
          bestLineSigMatch = info.lineSigMatch;
          bestRegime = info.regime;
          bestRegimeMask2 = info.regimeMask2;
          bestSurgeSuppressed = info.broadcastSurgeSuppressed;
        }
      }

      if (bestOffsetB !== -1) {
        const rowB = indicesB[bestOffsetB]!;
        matchedA[offsetA] = 1;
        matchedB[bestOffsetB] = 1;

        if (bestSurgeSuppressed) suppressedBroadcastSurgeCount++;
        sameSideCount++;
        totalSameSideLagMs += bestLagMsU32;
        if (bestLagMsU32 < minSameSideLagMsU32) {
          minSameSideLagMsU32 = bestLagMsU32;
        }
        bLedSameSideCount++;
        if (!bestSurgeSuppressed) {
          if (
            bestRegime === "LIVE_IN_PLAY" &&
            bestLagMsU32 <= LIVE_BOT_FOLLOW_WINDOW_MS
          ) {
            liveBotFollowsBtoA++;
          } else if (bestRegime === "PREGAME" && bestLineSigMatch) {
            if (bestLagMsU32 <= PREGAME_API_BOT_WINDOW_MS) {
              pregameApiBotFollowsBtoA++;
              pregameFollowsBtoA++;
            } else if (bestLagMsU32 <= PREGAME_TIP_CHANNEL_WINDOW_MS) {
              pregameFollowsBtoA++;
            }
          }
        }

        overlapStore.appendOverlap(
          rotA,
          key15A,
          rowA,
          rowB,
          bestLagMsU32,
          OVERLAP_SAME_SIDE,
          bestRegimeMask2,
          INITIATOR_CUSTOMER_B,
          bestLineSigMatch,
          bestSurgeSuppressed,
        );
      }
    }

    // Pass 3: unmatched B wagers -> closest-in-time OPPOSITE_SIDE (same market) or DIFFERENT_MARKET.
    for (let offsetB = runStartB; offsetB < runEndB; offsetB++) {
      if (matchedB[offsetB] === 1) continue;
      const rowB = indicesB[offsetB]!;
      const tB = readEpochMs64Stride2(
        store.placedAtEpochMs32WordsCol,
        rowB << 1,
      );
      const sideB = store.sideCodeU8Col[rowB]!;
      const unpackedB = unpackSubSportComboKey15(
        store.packedComboKey15Col[rowB]!,
      );

      let hasSameMarketMatch = false;
      let bestOppOffsetA = -1;
      let bestOppLagMsU32 = U32_MAX;
      let bestAnyOffsetA = -1;
      let bestAnyLagMsU32 = U32_MAX;

      for (let offsetA = runStartA; offsetA < runEndA; offsetA++) {
        const rowA = indicesA[offsetA]!;
        const tA = readEpochMs64Stride2(
          store.placedAtEpochMs32WordsCol,
          rowA << 1,
        );
        const absLagMsU32 = clampLagMsU32(tB >= tA ? tB - tA : tA - tB);
        if (bestAnyOffsetA === -1 || absLagMsU32 < bestAnyLagMsU32) {
          bestAnyOffsetA = offsetA;
          bestAnyLagMsU32 = absLagMsU32;
        }

        const unpackedA = unpackSubSportComboKey15(
          store.packedComboKey15Col[rowA]!,
        );
        if (
          unpackedA.periodCode4 === unpackedB.periodCode4 &&
          unpackedA.marketKindCode2 === unpackedB.marketKindCode2
        ) {
          hasSameMarketMatch = true;
          if (store.sideCodeU8Col[rowA]! !== sideB) {
            if (bestOppOffsetA === -1 || absLagMsU32 < bestOppLagMsU32) {
              bestOppOffsetA = offsetA;
              bestOppLagMsU32 = absLagMsU32;
            }
          }
        }
      }

      if (bestOppOffsetA !== -1) {
        const rowA = indicesA[bestOppOffsetA]!;
        const tA = readEpochMs64Stride2(
          store.placedAtEpochMs32WordsCol,
          rowA << 1,
        );
        const info = inspectPairMarketAndLine(rowA, rowB, bestOppLagMsU32);
        const initiatorCodeU8: InitiatorCodeU8 =
          tB > tA
            ? INITIATOR_CUSTOMER_A
            : tB < tA
              ? INITIATOR_CUSTOMER_B
              : INITIATOR_SIMULTANEOUS;
        matchedB[offsetB] = 1;
        oppositeSideCount++;
        if (info.broadcastSurgeSuppressed) suppressedBroadcastSurgeCount++;
        overlapStore.appendOverlap(
          rotA,
          info.key15A,
          rowA,
          rowB,
          bestOppLagMsU32,
          OVERLAP_OPPOSITE_SIDE,
          info.regimeMask2,
          initiatorCodeU8,
          info.lineSigMatch,
          info.broadcastSurgeSuppressed,
        );
      } else if (!hasSameMarketMatch && bestAnyOffsetA !== -1) {
        const rowA = indicesA[bestAnyOffsetA]!;
        const tA = readEpochMs64Stride2(
          store.placedAtEpochMs32WordsCol,
          rowA << 1,
        );
        const info = inspectPairMarketAndLine(rowA, rowB, bestAnyLagMsU32);
        const initiatorCodeU8: InitiatorCodeU8 =
          tB > tA
            ? INITIATOR_CUSTOMER_A
            : tB < tA
              ? INITIATOR_CUSTOMER_B
              : INITIATOR_SIMULTANEOUS;
        matchedB[offsetB] = 1;
        differentMarketCount++;
        overlapStore.appendOverlap(
          rotA,
          info.key15A,
          rowA,
          rowB,
          bestAnyLagMsU32,
          OVERLAP_DIFFERENT_MARKET,
          info.regimeMask2,
          initiatorCodeU8,
          false,
          false,
        );
      }
    }
  }

  const totalDirectionalSameSide = aLedSameSideCount + bLedSameSideCount;
  const customerALeadShareBps = parseAsBasisPoints(
    totalDirectionalSameSide > 0
      ? Math.round((aLedSameSideCount * 10_000) / totalDirectionalSameSide)
      : 0,
    true,
  );

  const avgSameSideLagMsU32 =
    sameSideCount > 0 ? Math.floor(totalSameSideLagMs / sameSideCount) : 0;

  const bOnlyEvents = Math.max(0, distinctEventsB - sharedEventsCount);
  const nonAEvents = Math.max(1, catalogDistinctEvents - distinctEventsA);

  const bPresentParticipationBps = parseAsBasisPoints(
    distinctEventsA > 0
      ? Math.round((sharedEventsCount * 10_000) / distinctEventsA)
      : 0,
    true,
  );
  const bAbsentParticipationBps = parseAsBasisPoints(
    Math.round((bOnlyEvents * 10_000) / nonAEvents),
    true,
  );
  const liftRatioBps = parseAsBasisPoints(
    bPresentParticipationBps - bAbsentParticipationBps,
    true,
  );

  const totalDirectedAtoB = liveBotFollowsAtoB + pregameFollowsAtoB;
  const totalDirectedBtoA = liveBotFollowsBtoA + pregameFollowsBtoA;
  let inferredRoleB:
    "ORIGIN_LEADER" | "BRIDGE_RELAY" | "COPY_FOLLOWER" | "INDEPENDENT" =
    "INDEPENDENT";
  if (totalDirectedAtoB >= 3 && totalDirectedBtoA >= 3) {
    inferredRoleB = "BRIDGE_RELAY";
  } else if (totalDirectedAtoB >= 3) {
    inferredRoleB = "COPY_FOLLOWER";
  } else if (totalDirectedBtoA >= 3) {
    inferredRoleB = "ORIGIN_LEADER";
  }

  return {
    customerA: normA,
    customerB: normB,
    bridgeFilter,
    totalWagersA: countA,
    totalWagersB: countB,
    catalogDistinctEvents,
    distinctEventsA,
    distinctEventsB,
    sharedEventsCount,
    sameSideCount,
    oppositeSideCount,
    differentMarketCount,
    suppressedBroadcastSurgeCount,
    liveBotFollowsAtoB,
    liveBotFollowsBtoA,
    pregameApiBotFollowsAtoB,
    pregameApiBotFollowsBtoA,
    pregameFollowsAtoB,
    pregameFollowsBtoA,
    avgSameSideLagMsU32,
    minSameSideLagMsU32: sameSideCount > 0 ? minSameSideLagMsU32 : 0,
    customerALeadShareBps,
    bAbsentParticipationBps,
    bPresentParticipationBps,
    liftRatioBps,
    inferredRoleB,
    overlapStore,
    overlaps: overlapStore.toRecords(maxSampleOverlaps),
  };
}
