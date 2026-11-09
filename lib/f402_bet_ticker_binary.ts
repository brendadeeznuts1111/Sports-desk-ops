/**
 * @file f402_bet_ticker_binary.ts
 * @description Binary canonical buffer specification (Stage 4) for Bridge 3a.
 * Defines the fixed 304-byte binary buffer encoding, zero-allocation DataView decoding,
 * byte-0 sniffing reader contract (0x7B '{' JSON v1 vs 0x02 Binary v2), and fail-closed
 * SchemaVersionMismatchError.
 *
 * Layout (304 bytes total):
 *  - Header: 40 bytes (schemaVersion 0x02, payloadKind 0x3A, flags, ticketCount, legCount,
 *                      watermarkNum, polledEpochMs, alertTwinCount, confirmCount, lateCount, orphanCount)
 *  - Section 1: 192 bytes (12 channel entries × 16 bytes: ticketCount uint32, legCount uint32, canonicalVolumeCents int64)
 *  - Section 2: 72 bytes (9 wager-type entries × 8 bytes: ticketCount uint32, legCount uint32)
 */

import {
  CHANNEL_BY_ORDINAL,
  CHANNEL_RANK_ORDINALS,
  demuxWagerTypeOrdinal,
  deskClock,
  F402_BET_TICKER_KIND,
  F402_BET_TICKER_SCHEMA_VERSION,
  serializeF402TickerSnapshotPayload,
  sha256Hex,
  ticketWriterToChannelOrdinal,
  WAGER_TYPE_BY_ORDINAL,
  WAGER_TYPE_RANK_ORDINALS,
  type F402TickerChannelAggregate,
  type F402TickerSnapshot,
  type F402TickerWagerTypeAggregate,
} from "./f402_bet_ticker_delta.ts";

export const F402_BET_TICKER_BINARY_SCHEMA_VERSION = 2;
export const F402_BET_TICKER_BINARY_PAYLOAD_KIND = 0x3a; // ASCII ":" (Bridge 3A identifier)
export const F402_BET_TICKER_BINARY_FLAGS_LE = 0x0001; // Little-endian
export const F402_BET_TICKER_BINARY_BUFFER_BYTES = 304;

export const F402_BET_TICKER_JSON_BYTE0 = 0x7b; // ASCII "{"
export const F402_BET_TICKER_BINARY_BYTE0 = 0x02; // Version 2 binary

export const F402_BET_TICKER_R2_BINARY_KEY = "f402-bet-ticker/latest.bin";

/**
 * Thrown when an incoming ticker payload does not match expected wire formats
 * (neither 0x7B for JSON v1 nor 0x02 for Binary v2).
 */
export class SchemaVersionMismatchError extends Error {
  public readonly actualByte: number;
  public readonly expectedBytes: readonly number[];

  constructor(
    actualByte: number,
    expectedBytes: readonly number[] = [
      F402_BET_TICKER_JSON_BYTE0,
      F402_BET_TICKER_BINARY_BYTE0,
    ],
  ) {
    const actualHex = `0x${actualByte.toString(16).padStart(2, "0")}`;
    const expectedHex = expectedBytes
      .map((b) => `0x${b.toString(16).padStart(2, "0")}`)
      .join(", ");
    super(
      `SchemaVersionMismatchError: received leading byte ${actualHex}, expected one of [${expectedHex}]`,
    );
    this.name = "SchemaVersionMismatchError";
    this.actualByte = actualByte;
    this.expectedBytes = expectedBytes;
  }
}

/**
 * Encodes an existing sanitized F402TickerSnapshot into the 304-byte fixed canonical buffer.
 * Implements strict zero collection allocations: loops directly over aggregates and writes
 * fixed DataView offsets.
 */
export function encodeF402TickerBinarySnapshot(
  snapshot: F402TickerSnapshot,
): Uint8Array {
  const buffer = new ArrayBuffer(F402_BET_TICKER_BINARY_BUFFER_BYTES);
  const view = new DataView(buffer);

  // Header (40 bytes)
  view.setUint8(0, F402_BET_TICKER_BINARY_SCHEMA_VERSION);
  view.setUint8(1, F402_BET_TICKER_BINARY_PAYLOAD_KIND);
  view.setUint16(2, F402_BET_TICKER_BINARY_FLAGS_LE, true);
  view.setUint32(4, snapshot.ticketCount, true);
  view.setUint32(8, snapshot.legCount, true);
  view.setUint32(12, Number(snapshot.watermark) >>> 0, true);
  view.setBigInt64(16, BigInt(new Date(snapshot.generatedAt).getTime()), true);
  view.setUint32(24, snapshot.alertTwinCount, true);
  view.setUint32(28, snapshot.confirmCount, true);
  view.setUint32(32, snapshot.lateCount, true);
  view.setUint32(36, snapshot.orphanCount, true);

  // Section 1: 12-channel table (12 entries × 16 bytes = 192 bytes)
  for (let i = 0; i < snapshot.byChannel.length; i++) {
    const ch = snapshot.byChannel[i]!;
    const ord = ticketWriterToChannelOrdinal(ch.channel);
    if (ord >= 0 && ord < 12) {
      const offset = 40 + ord * 16;
      view.setUint32(offset, ch.ticketCount, true);
      view.setUint32(offset + 4, ch.legCount, true);
      view.setBigInt64(
        offset + 8,
        BigInt(Math.round(ch.canonicalVolumeCents)),
        true,
      );
    }
  }

  // Section 2: 9-wager-type table (9 entries × 8 bytes = 72 bytes)
  for (let j = 0; j < snapshot.byWagerType.length; j++) {
    const wt = snapshot.byWagerType[j]!;
    const ord = demuxWagerTypeOrdinal(wt.wagerType);
    if (ord >= 0 && ord < 9) {
      const offset = 232 + ord * 8;
      view.setUint32(offset, wt.ticketCount, true);
      view.setUint32(offset + 4, wt.legCount, true);
    }
  }

  return new Uint8Array(buffer);
}

/**
 * Decodes a 304-byte fixed canonical buffer into a fully-typed F402TickerSnapshot.
 * Validates header magic bytes, schema version, and little-endian flag.
 */
export function decodeF402TickerBinarySnapshot(
  input: ArrayBuffer | Uint8Array,
): F402TickerSnapshot {
  const byteLength = input.byteLength;
  if (byteLength !== F402_BET_TICKER_BINARY_BUFFER_BYTES) {
    throw new RangeError(
      `decodeF402TickerBinarySnapshot: expected ${F402_BET_TICKER_BINARY_BUFFER_BYTES} bytes, received ${byteLength}`,
    );
  }

  const view =
    input instanceof Uint8Array
      ? new DataView(input.buffer, input.byteOffset, input.byteLength)
      : new DataView(input);

  const schemaVersion = view.getUint8(0);
  if (schemaVersion !== F402_BET_TICKER_BINARY_SCHEMA_VERSION) {
    throw new SchemaVersionMismatchError(schemaVersion, [
      F402_BET_TICKER_BINARY_SCHEMA_VERSION,
    ]);
  }

  const payloadKind = view.getUint8(1);
  if (payloadKind !== F402_BET_TICKER_BINARY_PAYLOAD_KIND) {
    throw new Error(
      `decodeF402TickerBinarySnapshot: invalid payloadKind 0x${payloadKind.toString(16)} (expected 0x${F402_BET_TICKER_BINARY_PAYLOAD_KIND.toString(16)})`,
    );
  }

  const flags = view.getUint16(2, true);
  if ((flags & F402_BET_TICKER_BINARY_FLAGS_LE) === 0) {
    throw new Error(
      `decodeF402TickerBinarySnapshot: flags 0x${flags.toString(16)} does not have little-endian bit set`,
    );
  }

  const ticketCount = view.getUint32(4, true);
  const legCount = view.getUint32(8, true);
  const watermarkNum = view.getUint32(12, true);
  const polledEpochMs = Number(view.getBigInt64(16, true));
  const alertTwinCount = view.getUint32(24, true);
  const confirmCount = view.getUint32(28, true);
  const lateCount = view.getUint32(32, true);
  const orphanCount = view.getUint32(36, true);

  const generatedAt = new Date(polledEpochMs).toISOString();
  const { deskDate, deskHour } = deskClock(generatedAt);

  const byChannel: F402TickerChannelAggregate[] = [];
  for (const chOrd of CHANNEL_RANK_ORDINALS) {
    const offset = 40 + chOrd * 16;
    const count = view.getUint32(offset, true);
    if (count > 0) {
      byChannel.push({
        channel: CHANNEL_BY_ORDINAL[chOrd]!,
        ticketCount: count,
        legCount: view.getUint32(offset + 4, true),
        canonicalVolumeCents: Number(view.getBigInt64(offset + 8, true)),
      });
    }
  }

  const byWagerType: F402TickerWagerTypeAggregate[] = [];
  for (const wtOrd of WAGER_TYPE_RANK_ORDINALS) {
    const offset = 232 + wtOrd * 8;
    const count = view.getUint32(offset, true);
    if (count > 0) {
      byWagerType.push({
        wagerType: WAGER_TYPE_BY_ORDINAL[wtOrd]!,
        ticketCount: count,
        legCount: view.getUint32(offset + 4, true),
      });
    }
  }

  const payload = {
    schemaVersion: F402_BET_TICKER_SCHEMA_VERSION,
    kind: F402_BET_TICKER_KIND,
    generatedAt,
    deskDate,
    deskHour,
    watermark: String(watermarkNum),
    rowCount: ticketCount,
    ticketCount,
    legCount,
    alertTwinCount,
    confirmCount,
    lateCount,
    orphanCount,
    byChannel,
    byWagerType,
  } as const;

  return {
    ...payload,
    sourceSha256: sha256Hex(serializeF402TickerSnapshotPayload(payload)),
  };
}

/**
 * Universal reader boundary for R2 snapshots and WebSocket frames.
 * Inspects byte 0 to sniff wire format without trial parsing:
 *  - 0x7B ('{'): Decodes UTF-8 JSON text (Schema Version 1).
 *  - 0x02: Direct zero-copy DataView decode into F402TickerSnapshot (Schema Version 2).
 *  - Otherwise: Fails closed immediately with SchemaVersionMismatchError.
 */
export function parseF402TickerSnapshotOrBinary(
  input: string | Uint8Array | ArrayBuffer,
): F402TickerSnapshot {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.charCodeAt(0) === F402_BET_TICKER_JSON_BYTE0) {
      return JSON.parse(trimmed) as F402TickerSnapshot;
    }
    throw new SchemaVersionMismatchError(trimmed.charCodeAt(0), [
      F402_BET_TICKER_JSON_BYTE0,
      F402_BET_TICKER_BINARY_BYTE0,
    ]);
  }

  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength === 0) {
    throw new SchemaVersionMismatchError(0, [
      F402_BET_TICKER_JSON_BYTE0,
      F402_BET_TICKER_BINARY_BYTE0,
    ]);
  }

  const byte0 = bytes[0]!;
  if (byte0 === F402_BET_TICKER_JSON_BYTE0) {
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as F402TickerSnapshot;
  }

  if (byte0 === F402_BET_TICKER_BINARY_BYTE0) {
    return decodeF402TickerBinarySnapshot(bytes);
  }

  throw new SchemaVersionMismatchError(byte0, [
    F402_BET_TICKER_JSON_BYTE0,
    F402_BET_TICKER_BINARY_BYTE0,
  ]);
}
