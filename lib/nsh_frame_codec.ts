/**
 * @file lib/nsh_frame_codec.ts
 * @description 64-byte NSH ticker-match frame: pack on the desk, read on the
 * UI without ever parsing a color string. The row's origin domain and writer
 * lane travel as `uint8` wire ids; the presentation colour is derived from the
 * channel ordinal in CSS, so no RGB triple is carried on the wire.
 *
 * Layout (little-endian, every byte initialized — `Bun.allocUnsafe` is not used):
 *
 *   0      u8   magic 0x4E ("N")
 *   1      u8   frame version (6)
 *   2      u8   message type
 *   3      u8   reserved, always 0
 *   4      u32  packed handle: channel(4) | sla/10ms(8) | rowIndex(20)
 *   8      u64  bet group id (two u32s; bigint input supported)
 *   16     f64  stake USDC
 *   24     f64  book odds
 *   32     f64  Polymarket average price
 *   40     f64  liability delta
 *   48     u64  epoch milliseconds (two u32s — identical bytes to `setBigUint64`)
 *   56     u8   origin domain wire id (`OriginDomainWireId`)
 *   57     u8   writer lane wire id (`WriterLaneWireId`)
 *   58     u8   reserved, always 0
 *   59     u16  flagsBitSet16
 *   61     u8   slippageBps8 (SOR-1 ceiling 200)
 *   62     u16  reservedPadding16, always 0x0000 (64-byte cache-line alignment)
 *
 * The slippage field is u8 and byte 63 is explicitly zeroed. That is byte-for-
 * byte identical to a u16 slippage for every valid 0–255 value, and it removes
 * the one-byte uninitialized leak the u8-only variant would ship.
 *
 * The hot path is `NshFrameWriter`: one 64-byte buffer and one DataView reused
 * for the writer's lifetime, no BigInt, no Map/Set, no per-frame string. The
 * returned array is valid only until the next `write()`; copy it if the
 * transport retains it. `packNshBinaryFrame` is the allocating convenience.
 */
import type {
  OriginDomainId,
  WriterChannelId,
} from "./domain_venue_registry.ts";
import {
  OriginDomainWireId,
  WriterLaneWireId,
  originDomainIdOfWireId,
  writerLaneIdOfWireId,
} from "./domain-enums.ts";

export const NSH_FRAME_BYTE_LENGTH = 64;

/**
 * Decode scratch. `readNshBinaryFrameInto` copies the incoming 64 bytes here and
 * reads through one module-level `DataView`, instead of constructing a DataView
 * per call, so the caller's reusable target is the only allocation on the decode
 * path. Not reentrant: the copy and reads are synchronous and never yield.
 */
const DECODE_SCRATCH = new Uint8Array(NSH_FRAME_BYTE_LENGTH);
const DECODE_SCRATCH_VIEW = new DataView(DECODE_SCRATCH.buffer);
export const NSH_FRAME_MAGIC = 0x4e; // "N"
export const NSH_FRAME_VERSION = 6;
export const NSH_MESSAGE_TYPE = Object.freeze({
  TICKER_MATCH: 1,
  LIABILITY_UPDATE: 2,
  ORDERBOOK_DELTA: 3,
} as const);
export type NshMessageType =
  (typeof NSH_MESSAGE_TYPE)[keyof typeof NSH_MESSAGE_TYPE];

const UINT16_MAX = 0xffff;
const UINT64_MAX = 0xffffffffffffffffn;
const UINT32_BASE = 0x1_0000_0000;
const ROW_INDEX_MAX = 0xfffff;

export type NshFrameErrorCode =
  | "short_frame"
  | "invalid_magic"
  | "invalid_version"
  | "invalid_reserved"
  | "invalid_message_type"
  | "invalid_channel_id"
  | "invalid_sla"
  | "invalid_row_index"
  | "invalid_bet_group_id"
  | "invalid_number"
  | "invalid_flags"
  | "invalid_slippage"
  | "invalid_origin_domain"
  | "invalid_writer_lane"
  | "invalid_timestamp";

export class NshFrameCodecError extends Error {
  readonly code: NshFrameErrorCode;

  constructor(code: NshFrameErrorCode, message: string) {
    super(message);
    this.name = "NshFrameCodecError";
    this.code = code;
  }
}

export interface NshMatchFrameInput {
  /** Defaults to `NSH_MESSAGE_TYPE.TICKER_MATCH`. */
  messageType?: number;
  /** 4-bit routing channel. */
  channelId: number;
  /** SLA in 10 ms units (0–255; L23 GSLIVE 500 ms packs as 50). */
  slaDivide10Ms: number;
  /** 20-bit row index (0–1,048,575). */
  rowIndex: number;
  betGroupId: number | bigint;
  stakeUsdc: number;
  bookOdds: number;
  polyAvgPrice: number;
  liabilityDelta: number;
  /** Origin domain wire id, byte 56 (`OriginDomainWireId`, 0–6). */
  originDomainWireId: OriginDomainWireId;
  /** Writer lane wire id, byte 57 (`WriterLaneWireId`, 0–7). */
  writerLaneWireId: WriterLaneWireId;
  flags: number;
  /** 0–255; SOR-1 bounds. */
  slippageBps: number;
  /** Defaults to `Date.now()`. */
  timestampMs?: number;
}

export interface NshMatchFrame {
  messageType: number;
  channelId: number;
  slaDivide10Ms: number;
  rowIndex: number;
  betGroupId: bigint;
  stakeUsdc: number;
  bookOdds: number;
  polyAvgPrice: number;
  liabilityDelta: number;
  timestampMs: number;
  /** Origin domain wire id, read from byte 56 and validated against the table. */
  originDomainWireId: OriginDomainWireId;
  /** Canonical origin domain resolved from byte 56. */
  originDomainId: OriginDomainId;
  /** Writer lane wire id, read from byte 57 and validated against the table. */
  writerLaneWireId: WriterLaneWireId;
  /** Canonical writer lane resolved from byte 57. */
  /** Lane, or a sentinel class when no feed wrote the row. */
  writerLaneId: WriterChannelId;
  flags: number;
  slippageBps: number;
}

function fail(code: NshFrameErrorCode, message: string): never {
  throw new NshFrameCodecError(code, message);
}

function requireUint(
  value: number,
  max: number,
  code: NshFrameErrorCode,
  field: string,
): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    fail(
      code,
      `${field} must be an integer in [0, ${max}] (got ${String(value)})`,
    );
  }
}

function requireFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    fail(
      "invalid_number",
      `ERR_FRAME_INVALID_FINANCIAL_DATA: ${field} must be finite (got ${String(value)})`,
    );
  }
}

function writeBetGroupId(view: DataView, value: number | bigint): void {
  if (typeof value === "bigint") {
    if (value < 0n || value > UINT64_MAX) {
      fail("invalid_bet_group_id", `betGroupId must be a u64 (got ${value})`);
    }
    view.setBigUint64(8, value, true);
    return;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      "invalid_bet_group_id",
      `betGroupId must be a non-negative safe integer or bigint (got ${String(value)})`,
    );
  }
  view.setUint32(8, value % UINT32_BASE, true);
  view.setUint32(12, Math.floor(value / UINT32_BASE), true);
}

function writeTimestamp(view: DataView, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      "invalid_timestamp",
      `timestampMs must be a non-negative integer (got ${String(value)})`,
    );
  }
  view.setUint32(48, value % UINT32_BASE, true);
  view.setUint32(52, Math.floor(value / UINT32_BASE), true);
}

/**
 * Reusable frame writer. The returned array is the same object on every call;
 * send or copy it before the next `write()`.
 */
export class NshFrameWriter {
  readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor() {
    const raw = Bun.allocUnsafe(NSH_FRAME_BYTE_LENGTH);
    this.bytes = new Uint8Array(
      raw.buffer,
      raw.byteOffset,
      NSH_FRAME_BYTE_LENGTH,
    );
    this.view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      NSH_FRAME_BYTE_LENGTH,
    );
  }

  write(input: NshMatchFrameInput): Uint8Array {
    const messageType = input.messageType ?? NSH_MESSAGE_TYPE.TICKER_MATCH;
    requireUint(messageType, 0xff, "invalid_message_type", "messageType");
    requireUint(input.channelId, 0xf, "invalid_channel_id", "channelId");
    requireUint(input.slaDivide10Ms, 0xff, "invalid_sla", "slaDivide10Ms");
    requireUint(input.rowIndex, ROW_INDEX_MAX, "invalid_row_index", "rowIndex");
    requireUint(input.flags, UINT16_MAX, "invalid_flags", "flags");
    requireUint(input.slippageBps, 0xff, "invalid_slippage", "slippageBps");
    requireFinite(input.stakeUsdc, "stakeUsdc");
    requireFinite(input.bookOdds, "bookOdds");
    requireFinite(input.polyAvgPrice, "polyAvgPrice");
    requireFinite(input.liabilityDelta, "liabilityDelta");

    if (originDomainIdOfWireId(input.originDomainWireId) === null) {
      fail(
        "invalid_origin_domain",
        `originDomainWireId must be a known wire id (got ${String(input.originDomainWireId)})`,
      );
    }
    if (writerLaneIdOfWireId(input.writerLaneWireId) === null) {
      fail(
        "invalid_writer_lane",
        `writerLaneWireId must be a known wire id (got ${String(input.writerLaneWireId)})`,
      );
    }

    const view = this.view;
    view.setUint8(0, NSH_FRAME_MAGIC);
    view.setUint8(1, NSH_FRAME_VERSION);
    view.setUint8(2, messageType);
    view.setUint8(3, 0);

    const packedHandle32 =
      ((input.channelId & 0xf) << 28) |
      ((input.slaDivide10Ms & 0xff) << 20) |
      (input.rowIndex & ROW_INDEX_MAX);
    view.setUint32(4, packedHandle32 >>> 0, true);

    writeBetGroupId(view, input.betGroupId);
    view.setFloat64(16, input.stakeUsdc, true);
    view.setFloat64(24, input.bookOdds, true);
    view.setFloat64(32, input.polyAvgPrice, true);
    view.setFloat64(40, input.liabilityDelta, true);
    writeTimestamp(view, input.timestampMs ?? Date.now());

    view.setUint8(56, input.originDomainWireId);
    view.setUint8(57, input.writerLaneWireId);
    view.setUint8(58, 0);
    view.setUint16(59, input.flags, true);
    view.setUint8(61, input.slippageBps);
    view.setUint16(62, 0, true);

    return this.bytes;
  }
}

/** One-off packer; allocates 64 bytes. Use `NshFrameWriter` in a hot loop. */
export function packNshBinaryFrame(input: NshMatchFrameInput): Uint8Array {
  return new NshFrameWriter().write(input);
}

/**
 * Reusable decode target. Pass one to `readNshBinaryFrameInto` on the hot path
 * (repo `lookup` / `lookupInto` convention) to keep decoding allocation-free.
 */
export function createNshFrameTarget(): NshMatchFrame {
  return {
    messageType: 0,
    channelId: 0,
    slaDivide10Ms: 0,
    rowIndex: 0,
    betGroupId: 0n,
    stakeUsdc: 0,
    bookOdds: 0,
    polyAvgPrice: 0,
    liabilityDelta: 0,
    timestampMs: 0,
    originDomainWireId: OriginDomainWireId.UNSET,
    originDomainId: "ORIGIN_HOST_NSH_DESK_LOCAL",
    writerLaneWireId: WriterLaneWireId.UNKNOWN,
    writerLaneId: "unknown",
    flags: 0,
    slippageBps: 0,
  };
}

export function readNshBinaryFrame(bytes: Uint8Array): NshMatchFrame {
  return readNshBinaryFrameInto(bytes, createNshFrameTarget());
}

export function readNshBinaryFrameInto(
  bytes: Uint8Array,
  target: NshMatchFrame,
): NshMatchFrame {
  if (bytes.byteLength < NSH_FRAME_BYTE_LENGTH) {
    fail(
      "short_frame",
      `NSH frame needs ${NSH_FRAME_BYTE_LENGTH} bytes (got ${bytes.byteLength})`,
    );
  }

  for (let i = 0; i < NSH_FRAME_BYTE_LENGTH; i += 1) {
    DECODE_SCRATCH[i] = bytes[i]!;
  }
  const view = DECODE_SCRATCH_VIEW;
  if (view.getUint8(0) !== NSH_FRAME_MAGIC) {
    fail(
      "invalid_magic",
      `expected 0x${NSH_FRAME_MAGIC.toString(16)} at byte 0`,
    );
  }
  const versionByte8 = view.getUint8(1);
  if (versionByte8 === 5) {
    fail(
      "invalid_version",
      "ERR_FRAME_V5_DEPRECATED: NSH frame v5 is deprecated; upgrade producer to v6",
    );
  }
  if (versionByte8 !== NSH_FRAME_VERSION) {
    fail("invalid_version", `unsupported NSH frame version ${versionByte8}`);
  }
  if (
    view.getUint8(3) !== 0 ||
    view.getUint8(58) !== 0 ||
    view.getUint16(62, true) !== 0
  ) {
    fail(
      "invalid_reserved",
      "reserved bytes 3 and 58 and padding bytes 62..63 must be zero",
    );
  }

  const packedHandle32 = view.getUint32(4, true);
  const originDomainWireId8 = view.getUint8(56);
  const originDomainId = originDomainIdOfWireId(originDomainWireId8);
  if (originDomainId === null) {
    fail(
      "invalid_origin_domain",
      `unknown origin domain wire id ${originDomainWireId8} at byte 56`,
    );
  }
  const writerLaneWireId8 = view.getUint8(57);
  const writerLaneId = writerLaneIdOfWireId(writerLaneWireId8);
  if (writerLaneId === null) {
    fail(
      "invalid_writer_lane",
      `unknown writer lane wire id ${writerLaneWireId8} at byte 57`,
    );
  }
  const timestampHighWord32 = view.getUint32(52, true);
  if (timestampHighWord32 > 0x1fffff) {
    fail(
      "invalid_timestamp",
      `timestamp high word exceeds the safe-integer millisecond range (${timestampHighWord32})`,
    );
  }
  const timestampMs =
    timestampHighWord32 * UINT32_BASE + view.getUint32(48, true);
  const stakeUsdc = view.getFloat64(16, true);
  const bookOdds = view.getFloat64(24, true);
  const polyAvgPrice = view.getFloat64(32, true);
  const liabilityDelta = view.getFloat64(40, true);
  requireFinite(stakeUsdc, "stakeUsdc");
  requireFinite(bookOdds, "bookOdds");
  requireFinite(polyAvgPrice, "polyAvgPrice");
  requireFinite(liabilityDelta, "liabilityDelta");

  target.messageType = view.getUint8(2);
  target.channelId = (packedHandle32 >>> 28) & 0xf;
  target.slaDivide10Ms = (packedHandle32 >>> 20) & 0xff;
  target.rowIndex = packedHandle32 & ROW_INDEX_MAX;
  target.betGroupId = view.getBigUint64(8, true);
  target.stakeUsdc = stakeUsdc;
  target.bookOdds = bookOdds;
  target.polyAvgPrice = polyAvgPrice;
  target.liabilityDelta = liabilityDelta;
  target.timestampMs = timestampMs;
  target.originDomainWireId = originDomainWireId8 as OriginDomainWireId;
  target.originDomainId = originDomainId;
  target.writerLaneWireId = writerLaneWireId8 as WriterLaneWireId;
  target.writerLaneId = writerLaneId;
  target.flags = view.getUint16(59, true);
  target.slippageBps = view.getUint8(61);
  return target;
}

/** WebSocket payloads arrive as ArrayBuffer; this is a view, not a copy. */
export function readNshBinaryFrameFromArrayBuffer(
  buffer: ArrayBuffer,
): NshMatchFrame {
  return readNshBinaryFrame(new Uint8Array(buffer));
}

export const NSH_BLOTTER_PUBLISH_TOPIC = "nsh_blotter" as const;

export type NshBroadcastDisposition = "PUBLISHED" | "BACKPRESSURED" | "DROPPED";

export interface NshPublishServer {
  publish(
    topic: string,
    data: Uint8Array | ArrayBuffer,
    compress?: boolean,
  ): number;
}

export interface BroadcastFrameResult {
  readonly disposition: NshBroadcastDisposition;
  readonly bytesOrStatus: number;
}

export interface NshSubscriberSocket {
  send(data: Uint8Array | ArrayBuffer, compress?: boolean): number;
  pause(): void;
  resume(): void;
}

/**
 * Publishes a 64-byte binary NSH frame to the `"nsh_blotter"` topic with
 * `compress = false` and handles Bun WebSocket backpressure (`-1`) and drop (`0`) signals.
 */
export function broadcastFrame(
  server: NshPublishServer,
  frame: Uint8Array,
  topic: string = NSH_BLOTTER_PUBLISH_TOPIC,
): BroadcastFrameResult {
  const result = server.publish(topic, frame, false);
  if (result === -1) {
    console.warn("[Backpressure] NSH Blotter client is slow. Pausing stream.");
    return { disposition: "BACKPRESSURED", bytesOrStatus: -1 };
  }
  if (result === 0) {
    console.error("[Drop] Frame dropped: No subscribers or buffer full.");
    return { disposition: "DROPPED", bytesOrStatus: 0 };
  }
  return { disposition: "PUBLISHED", bytesOrStatus: result };
}

/**
 * Sends a 64-byte binary NSH frame to a subscriber with `compress = false`.
 * Calls `ws.pause()` when Bun signals backpressure (`-1`); pair with `resumeNshSubscriber(ws)` in `drain(ws)`.
 */
export function sendNshFrameToSubscriber(
  ws: NshSubscriberSocket,
  frame: Uint8Array,
): BroadcastFrameResult {
  const result = ws.send(frame, false);
  if (result === -1) {
    ws.pause();
    return { disposition: "BACKPRESSURED", bytesOrStatus: -1 };
  }
  if (result === 0) {
    return { disposition: "DROPPED", bytesOrStatus: 0 };
  }
  return { disposition: "PUBLISHED", bytesOrStatus: result };
}

export function resumeNshSubscriber(
  ws: Pick<NshSubscriberSocket, "resume">,
): void {
  ws.resume();
}
