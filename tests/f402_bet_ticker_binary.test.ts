import { describe, expect, test } from "bun:test";

import {
  buildF402TickerSnapshot,
  decodeF402TickerBinarySnapshot,
  encodeF402TickerBinarySnapshot,
  F402_BET_TICKER_BINARY_BUFFER_BYTES,
  F402_BET_TICKER_BINARY_BYTE0,
  F402_BET_TICKER_BINARY_PAYLOAD_KIND,
  F402_BET_TICKER_BINARY_SCHEMA_VERSION,
  F402_BET_TICKER_JSON_BYTE0,
  parseF402TickerSnapshotOrBinary,
  projectF402TickerDelta,
  SchemaVersionMismatchError,
} from "../lib/f402_bet_ticker_delta.ts";
import { parseF402TickerRow, type F402TickerRow } from "../lib/f402_ingest.ts";

describe("Bridge 3a fixed 304-byte binary canonical buffer (Stage 4)", () => {
  async function loadFixtureSnapshot() {
    const fixtureFile = Bun.file("tests/fixtures/live-wagers-LIST-100.json");
    const json = (await fixtureFile.json()) as { LIST: unknown[] };
    const rows = json.LIST.map((r) => parseF402TickerRow(r)).filter(
      (r): r is F402TickerRow => r !== null,
    );
    const delta = projectF402TickerDelta([], rows, "2026-11-08T18:00:00.000Z");
    return buildF402TickerSnapshot(delta, rows.length);
  }

  test("encodes to exactly 304 bytes with correct header offsets and magic bytes", async () => {
    const snapshot = await loadFixtureSnapshot();
    const bin = encodeF402TickerBinarySnapshot(snapshot);

    expect(bin.byteLength).toBe(F402_BET_TICKER_BINARY_BUFFER_BYTES);
    expect(bin.byteLength).toBe(304);

    const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    // Header magic
    expect(view.getUint8(0)).toBe(F402_BET_TICKER_BINARY_SCHEMA_VERSION); // 0x02
    expect(view.getUint8(1)).toBe(F402_BET_TICKER_BINARY_PAYLOAD_KIND); // 0x3A (":")
    expect(view.getUint16(2, true)).toBe(1); // LE flag

    expect(view.getUint32(4, true)).toBe(snapshot.ticketCount);
    expect(view.getUint32(8, true)).toBe(snapshot.legCount);
    expect(view.getUint32(12, true)).toBe(Number(snapshot.watermark));
  });

  test("roundtrips with exact field and sourceSha256 cryptographic parity", async () => {
    const snapshot = await loadFixtureSnapshot();
    const bin = encodeF402TickerBinarySnapshot(snapshot);
    const decoded = decodeF402TickerBinarySnapshot(bin);

    expect(decoded.schemaVersion).toBe(snapshot.schemaVersion);
    expect(decoded.kind).toBe(snapshot.kind);
    expect(decoded.ticketCount).toBe(snapshot.ticketCount);
    expect(decoded.legCount).toBe(snapshot.legCount);
    expect(decoded.watermark).toBe(snapshot.watermark);
    expect(decoded.generatedAt).toBe(snapshot.generatedAt);
    expect(decoded.deskDate).toBe(snapshot.deskDate);
    expect(decoded.deskHour).toBe(snapshot.deskHour);
    expect(decoded.alertTwinCount).toBe(snapshot.alertTwinCount);
    expect(decoded.confirmCount).toBe(snapshot.confirmCount);
    expect(decoded.lateCount).toBe(snapshot.lateCount);
    expect(decoded.orphanCount).toBe(snapshot.orphanCount);

    expect(decoded.byChannel).toEqual(snapshot.byChannel);
    expect(decoded.byWagerType).toEqual(snapshot.byWagerType);
    expect(decoded.sourceSha256).toBe(snapshot.sourceSha256);
  });

  test("parseF402TickerSnapshotOrBinary sniffs byte 0 (0x7B JSON vs 0x02 Binary)", async () => {
    const snapshot = await loadFixtureSnapshot();
    const jsonText = JSON.stringify(snapshot);
    const jsonBytes = new TextEncoder().encode(jsonText);
    const binBytes = encodeF402TickerBinarySnapshot(snapshot);

    expect(jsonBytes[0]).toBe(F402_BET_TICKER_JSON_BYTE0); // 0x7B
    expect(binBytes[0]).toBe(F402_BET_TICKER_BINARY_BYTE0); // 0x02

    // 1. Text string input
    const fromText = parseF402TickerSnapshotOrBinary(jsonText);
    expect(fromText.ticketCount).toBe(snapshot.ticketCount);
    expect(fromText.sourceSha256).toBe(snapshot.sourceSha256);

    // 2. JSON byte buffer input
    const fromJsonBytes = parseF402TickerSnapshotOrBinary(jsonBytes);
    expect(fromJsonBytes.ticketCount).toBe(snapshot.ticketCount);
    expect(fromJsonBytes.sourceSha256).toBe(snapshot.sourceSha256);

    // 3. Binary v2 byte buffer input
    const fromBinBytes = parseF402TickerSnapshotOrBinary(binBytes);
    expect(fromBinBytes.ticketCount).toBe(snapshot.ticketCount);
    expect(fromBinBytes.sourceSha256).toBe(snapshot.sourceSha256);
  });

  test("fails closed with SchemaVersionMismatchError on novel or corrupted leading bytes", () => {
    const corruptedBytes = new Uint8Array([0x03, 0x3a, 0x01, 0x00]);
    expect(() => parseF402TickerSnapshotOrBinary(corruptedBytes)).toThrow(
      SchemaVersionMismatchError,
    );

    const emptyBytes = new Uint8Array([]);
    expect(() => parseF402TickerSnapshotOrBinary(emptyBytes)).toThrow(
      SchemaVersionMismatchError,
    );

    const badString = "NOT_JSON_OR_BINARY";
    expect(() => parseF402TickerSnapshotOrBinary(badString)).toThrow(
      SchemaVersionMismatchError,
    );
  });

  test("rejects malformed binary buffers (wrong length, bad payloadKind, missing LE flag)", () => {
    // Under 304 bytes
    expect(() => decodeF402TickerBinarySnapshot(new Uint8Array(300))).toThrow(
      RangeError,
    );
    // Over 304 bytes
    expect(() => decodeF402TickerBinarySnapshot(new Uint8Array(308))).toThrow(
      RangeError,
    );

    const buf = new Uint8Array(304);
    buf[0] = F402_BET_TICKER_BINARY_SCHEMA_VERSION;
    buf[1] = 0x00; // invalid payloadKind (not 0x3A)
    buf[2] = 0x01; // LE flag
    expect(() => decodeF402TickerBinarySnapshot(buf)).toThrow(
      /invalid payloadKind/,
    );

    buf[1] = F402_BET_TICKER_BINARY_PAYLOAD_KIND;
    buf[2] = 0x00; // missing LE flag
    expect(() => decodeF402TickerBinarySnapshot(buf)).toThrow(
      /little-endian bit/,
    );
  });

  test("binary encoder and decoder adhere to zero collection-heap allocation invariant", async () => {
    const source = await Bun.file("lib/f402_bet_ticker_binary.ts").text();
    const pattern = /\bnew\s+(Map|Set|WeakMap|WeakSet)\s*[<(]/g;
    const allocations = [...source.matchAll(pattern)].map((m) => m[0]);
    expect(allocations.length).toBe(0);
    expect(source).not.toMatch(/\bboolean\s*\[\s*\]/);
    expect(source).not.toMatch(/Array<\s*boolean\s*>/);
  });
});
