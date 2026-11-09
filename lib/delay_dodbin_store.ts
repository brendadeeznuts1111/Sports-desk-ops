/**
 * @file delay_dodbin_store.ts
 * @description Binary Serialization & Bit-31 Gate for DOD6 v5.4/v5.5 Live Delay Snapshots.
 *
 * ARCHITECTURAL PARTITION INVARIANTS:
 * 1. Stream Provenance Preservation:
 *    Header watermark fields strictly partition EP09_GSLIVE_118 (betGroupIdNumeric)
 *    and EP03_BET_TICKER (lastCommittedWagerNumber). They occupy dedicated header slots
 *    and are never conflated.
 * 2. Bit-31 Stale Snapshot Poison Gate:
 *    Word 7 bit 31 (0x80000000) is the STALE_SNAPSHOT_POISON_BIT. If set, deserialization
 *    fails closed immediately to prevent resurrecting retired or stale artifacts.
 * 3. CustomerSpine Mapping & CustomerPackedHandle32 Wire Payload:
 *    Bitset masks (Uint32Array(wordCount32)) map back to CustomerSpineColumnStore rowIndex
 *    before constructing the CustomerPackedHandle32 wire payload (20-bit rowIndex, 7-bit agentIdx,
 *    1-bit vipShield, 2-bit delayTier, 2-bit gen).
 */

import {
  type CustomerPackedHandle32,
  asCustomerPackedHandle32,
} from "../design/domain-branded-types.ts";

export const DODBIN_MAGIC = 0x53444f44; // "SDOD"
export const DODBIN_VERSION = 55;
export const DODBIN_HEADER_BYTE_LENGTH = 2048;
export const DODBIN_HEADER_UINT32_SLOTS = DODBIN_HEADER_BYTE_LENGTH >>> 2; // 512 slots

/** Bit 31 poison bit in header slot 7. */
export const STALE_SNAPSHOT_POISON_BIT = 0x80000000 as const;

export type StreamProvenance =
  "EP09_GSLIVE_118" | "EP03_BET_TICKER" | "EP04_PENDING" | "EP05_SETTLED";

export const STREAM_PROVENANCE_MASKS: Readonly<
  Record<StreamProvenance, number>
> = {
  EP09_GSLIVE_118: 1 << 0, // bit 0
  EP03_BET_TICKER: 1 << 1, // bit 1
  EP04_PENDING: 1 << 2, // bit 2
  EP05_SETTLED: 1 << 3, // bit 3
};

/** Error thrown when attempting to load a dodbin with Bit-31 poison bit set. */
export class StaleSnapshotPoisonedError extends Error {
  constructor(message: string) {
    super(`[StaleSnapshotPoisonedError] ${message}`);
    this.name = "StaleSnapshotPoisonedError";
  }
}

/** Error thrown when a CustomerPackedHandle32 fails validation against CustomerSpineColumnStore. */
export class InvalidCustomerSpineMappingError extends Error {
  constructor(message: string) {
    super(`[InvalidCustomerSpineMappingError] ${message}`);
    this.name = "InvalidCustomerSpineMappingError";
  }
}

export interface DelaySnapshotWatermarks {
  readonly gsliveLastBetGroupIdNumeric: number;
  readonly f402LastWagerNumber: number;
  readonly streamProvenanceMask: number;
}

export interface DelaySnapshotHeader {
  readonly magic: number;
  readonly version: number;
  readonly customerCount: number;
  readonly rowCapacity: number;
  readonly watermarks: DelaySnapshotWatermarks;
  readonly asOfEpochDays: number;
  readonly isPoisoned: boolean;
  readonly totalFileBytes: number;
  readonly sectionCount: number;
}

export interface DelaySnapshotPayload {
  readonly header: DelaySnapshotHeader;
  readonly tier1Words32: Uint32Array;
  readonly tier2Words32: Uint32Array;
  readonly tier3Words32: Uint32Array;
  readonly shieldedVipWords32: Uint32Array;
}

/**
 * Constructs a 32-bit CustomerPackedHandle32 wire payload.
 *
 * Bit Layout:
 *   [0..19]  : 20-bit CustomerSpineColumnStore rowIndex (0..1,048,575)
 *   [20..26] : 7-bit leaf agentIdx (0..127)
 *   [27]     : 1-bit vipShield (0 = normal, 1 = shielded)
 *   [28..29] : 2-bit delayTier (0 = none, 1 = 10s, 2 = 11s, 3 = 12s)
 *   [30..31] : 2-bit generation (0..3)
 */
export function constructCustomerPackedHandle32(
  rowIndex: number,
  options: {
    delayTier?: 0 | 1 | 2 | 3;
    vipShield?: boolean;
    agentIdx?: number;
    gen?: number;
    spineMaxRows?: number;
  } = {},
): CustomerPackedHandle32 {
  if (!Number.isInteger(rowIndex) || rowIndex < 0) {
    throw new InvalidCustomerSpineMappingError(
      `rowIndex must be a non-negative integer (got: ${rowIndex})`,
    );
  }

  // 20-bit boundary (max 1,048,575)
  if (rowIndex > 0xfffff) {
    throw new InvalidCustomerSpineMappingError(
      `rowIndex ${rowIndex} exceeds 20-bit CustomerSpineColumnStore capacity (max 1,048,575)`,
    );
  }

  const spineMax = options.spineMaxRows ?? 1_048_576;
  if (rowIndex >= spineMax) {
    throw new InvalidCustomerSpineMappingError(
      `rowIndex ${rowIndex} is outside CustomerSpineColumnStore capacity boundary ${spineMax}`,
    );
  }

  const delayTier = (options.delayTier ?? 0) & 0x03;
  const vipShield = options.vipShield === true ? 1 : 0;
  const agentIdx = (options.agentIdx ?? 0) & 0x7f;
  const gen = (options.gen ?? 0) & 0x03;

  const packed =
    (rowIndex & 0xfffff) |
    ((agentIdx & 0x7f) << 20) |
    ((vipShield & 0x01) << 27) |
    ((delayTier & 0x03) << 28) |
    ((gen & 0x03) << 30);

  return asCustomerPackedHandle32(packed >>> 0);
}

/**
 * Unpacks a CustomerPackedHandle32 into its component fields.
 */
export function unpackCustomerPackedHandle32(handle: CustomerPackedHandle32): {
  readonly rowIndex: number;
  readonly agentIdx: number;
  readonly vipShield: boolean;
  readonly delayTier: 0 | 1 | 2 | 3;
  readonly gen: number;
} {
  const raw = Number(handle) >>> 0;
  const rowIndex = raw & 0xfffff;
  const agentIdx = (raw >>> 20) & 0x7f;
  const vipShield = ((raw >>> 27) & 0x01) === 1;
  const delayTier = ((raw >>> 28) & 0x03) as 0 | 1 | 2 | 3;
  const gen = (raw >>> 30) & 0x03;

  return { rowIndex, agentIdx, vipShield, delayTier, gen };
}

/**
 * Serializes a live delay snapshot into DOD6 v5.4/v5.5 binary format.
 */
export function serializeDelayDodbin(payload: {
  customerCount: number;
  rowCapacity: number;
  asOfEpochDays: number;
  watermarks: DelaySnapshotWatermarks;
  isPoisoned?: boolean;
  tier1Words32: Uint32Array;
  tier2Words32: Uint32Array;
  tier3Words32: Uint32Array;
  shieldedVipWords32: Uint32Array;
}): Uint8Array {
  const wordCount = payload.tier1Words32.length;
  if (
    payload.tier2Words32.length !== wordCount ||
    payload.tier3Words32.length !== wordCount ||
    payload.shieldedVipWords32.length !== wordCount
  ) {
    throw new Error("All delay tier bitsets must share identical wordCount32");
  }

  const bitsetByteLength = wordCount * 4;
  const totalLength = DODBIN_HEADER_BYTE_LENGTH + bitsetByteLength * 4;
  const buffer = new Uint8Array(totalLength);
  const words32 = new Uint32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength >>> 2,
  );

  // Header Words
  words32[0] = DODBIN_MAGIC;
  words32[1] = DODBIN_VERSION;
  words32[2] = payload.customerCount >>> 0;
  words32[3] = payload.rowCapacity >>> 0;

  // Stream Provenance Watermarks (Slots 4, 5, 6)
  words32[4] = payload.watermarks.gsliveLastBetGroupIdNumeric >>> 0; // EP09_GSLIVE_118
  words32[5] = payload.watermarks.f402LastWagerNumber >>> 0; // EP03_BET_TICKER
  words32[6] = payload.watermarks.streamProvenanceMask >>> 0;

  // Word 7: asOfEpochDays + Bit-31 Poison Gate
  const poisonFlag =
    payload.isPoisoned === true ? STALE_SNAPSHOT_POISON_BIT : 0;
  words32[7] =
    (payload.asOfEpochDays & ~STALE_SNAPSHOT_POISON_BIT) | poisonFlag;

  words32[8] = totalLength >>> 0;
  words32[9] = 4; // 4 bitset sections

  // Section Table (base 16): [offset, length, stride]
  let currentOffset = DODBIN_HEADER_BYTE_LENGTH;
  const bitsets = [
    payload.tier1Words32,
    payload.tier2Words32,
    payload.tier3Words32,
    payload.shieldedVipWords32,
  ];

  for (let s = 0; s < 4; s += 1) {
    const sectionBase = 16 + s * 3;
    words32[sectionBase] = currentOffset >>> 0;
    words32[sectionBase + 1] = bitsetByteLength >>> 0;
    words32[sectionBase + 2] = 4; // 4-byte stride

    const sectionWords = new Uint32Array(
      buffer.buffer,
      buffer.byteOffset + currentOffset,
      wordCount,
    );
    sectionWords.set(bitsets[s]!);
    currentOffset += bitsetByteLength;
  }

  return buffer;
}

/**
 * Deserializes a DOD6 v5.4/v5.5 binary delay snapshot, strictly enforcing Bit-31 poison check.
 */
export function deserializeDelayDodbin(
  bytes: Uint8Array,
): DelaySnapshotPayload {
  if (bytes.byteLength < DODBIN_HEADER_BYTE_LENGTH) {
    throw new Error(
      `Invalid dodbin: buffer length ${bytes.byteLength} smaller than header ${DODBIN_HEADER_BYTE_LENGTH}`,
    );
  }

  const words32 = new Uint32Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength >>> 2,
  );
  const magic = words32[0]!;
  if (magic !== DODBIN_MAGIC) {
    throw new Error(
      `Invalid dodbin magic: 0x${magic.toString(16)} (expected 0x${DODBIN_MAGIC.toString(16)})`,
    );
  }

  const version = words32[1]!;
  const customerCount = words32[2]!;
  const rowCapacity = words32[3]!;

  // Watermarks (Slots 4, 5, 6)
  const gsliveLastBetGroupIdNumeric = words32[4]!;
  const f402LastWagerNumber = words32[5]!;
  const streamProvenanceMask = words32[6]!;

  // Word 7: Bit-31 Poison Check
  const rawEpochWord = words32[7]!;
  const isPoisoned = (rawEpochWord & STALE_SNAPSHOT_POISON_BIT) !== 0;
  if (isPoisoned) {
    throw new StaleSnapshotPoisonedError(
      "DOD6 v5.4 Header Word 7 has Bit 31 set (STALE_SNAPSHOT_POISON_BIT). This snapshot is poisoned or retired and cannot be deserialized.",
    );
  }

  const asOfEpochDays = rawEpochWord & ~STALE_SNAPSHOT_POISON_BIT;
  const totalFileBytes = words32[8]!;
  const sectionCount = words32[9]!;

  const header: DelaySnapshotHeader = {
    magic,
    version,
    customerCount,
    rowCapacity,
    watermarks: {
      gsliveLastBetGroupIdNumeric,
      f402LastWagerNumber,
      streamProvenanceMask,
    },
    asOfEpochDays,
    isPoisoned: false,
    totalFileBytes,
    sectionCount,
  };

  // Read the 4 bitset sections
  const bitsets: Uint32Array[] = [];
  for (let s = 0; s < 4; s += 1) {
    const sectionBase = 16 + s * 3;
    const offset = words32[sectionBase]!;
    const byteLength = words32[sectionBase + 1]!;
    const wordCount = byteLength >>> 2;
    const words = new Uint32Array(
      bytes.buffer,
      bytes.byteOffset + offset,
      wordCount,
    );
    bitsets.push(new Uint32Array(words)); // defensive clone
  }

  return new DelayDodbinSnapshot(
    header,
    bitsets[0]!,
    bitsets[1]!,
    bitsets[2]!,
    bitsets[3]!,
  );
}

function popcountUint32(words: Uint32Array): number {
  let count = 0;
  for (let i = 0; i < words.length; i += 1) {
    let v = words[i]!;
    v -= (v >>> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    count += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return count;
}

/**
 * Rich domain representation of a deserialized DODBIN snapshot with Bun.inspect.custom.
 */
export class DelayDodbinSnapshot implements DelaySnapshotPayload {
  constructor(
    public readonly header: DelaySnapshotHeader,
    public readonly tier1Words32: Uint32Array,
    public readonly tier2Words32: Uint32Array,
    public readonly tier3Words32: Uint32Array,
    public readonly shieldedVipWords32: Uint32Array,
  ) {}

  [Bun.inspect.custom](
    _depth: number,
    options: { colors?: boolean } = {},
  ): string {
    const c = options?.colors === true;
    const bold = (s: string) => (c ? `\x1b[1m${s}\x1b[22m` : s);
    const cyan = (s: string) => (c ? `\x1b[36m${s}\x1b[39m` : s);
    const green = (s: string) => (c ? `\x1b[32m${s}\x1b[39m` : s);
    const yellow = (s: string) => (c ? `\x1b[33m${s}\x1b[39m` : s);

    const t1 = popcountUint32(this.tier1Words32);
    const t2 = popcountUint32(this.tier2Words32);
    const t3 = popcountUint32(this.tier3Words32);
    const vip = popcountUint32(this.shieldedVipWords32);

    return [
      `${bold("DelayDodbinSnapshot")} (DOD6 v${this.header.version}, ${this.header.totalFileBytes} bytes)`,
      `  ${cyan("Watermarks:")} GSLive_GID=${green(String(this.header.watermarks.gsliveLastBetGroupIdNumeric))} (EP09) | F402_Wager=${green(String(this.header.watermarks.f402LastWagerNumber))} (EP03)`,
      `  ${cyan("Capacity:")} customers=${this.header.customerCount} rowCapacity=${this.header.rowCapacity} words32=${this.tier1Words32.length}`,
      `  ${cyan("Tiers:")} T1(12s)=${yellow(String(t1))} T2(11s)=${yellow(String(t2))} T3(10s)=${yellow(String(t3))} VIP_Shield=${green(String(vip))}`,
      `  ${cyan("PoisonGate:")} ${this.header.isPoisoned ? "\x1b[31mPOISONED\x1b[39m" : "ACTIVE"} (epochDays=${this.header.asOfEpochDays})`,
    ].join("\n");
  }
}

/**
 * Custom inspect formatter for CustomerPackedHandle32 wire handles.
 */
export function formatCustomerPackedHandle32Inspect(
  handle: CustomerPackedHandle32,
  options: { colors?: boolean } = {},
): string {
  const unpacked = unpackCustomerPackedHandle32(handle);
  const c = options.colors === true;
  const bold = (s: string) => (c ? `\x1b[1m${s}\x1b[22m` : s);
  const cyan = (s: string) => (c ? `\x1b[36m${s}\x1b[39m` : s);
  const yellow = (s: string) => (c ? `\x1b[33m${s}\x1b[39m` : s);
  const tierName =
    unpacked.delayTier === 3
      ? "12s"
      : unpacked.delayTier === 2
        ? "11s"
        : unpacked.delayTier === 1
          ? "10s"
          : "none";

  return `${bold("CustomerPackedHandle32")}(${cyan("row=")}${unpacked.rowIndex}, ${cyan("agentIdx=")}${unpacked.agentIdx}, ${cyan("vip=")}${unpacked.vipShield}, ${cyan("tier=")}${yellow(tierName)}, ${cyan("gen=")}${unpacked.gen})`;
}
