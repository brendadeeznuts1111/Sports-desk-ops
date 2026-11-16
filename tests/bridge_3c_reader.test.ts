import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  computeWagerSoAMetrics,
  deserializeWagerSoABinary,
  processBridge3cStream,
  serializeWagerSoABinary,
  sniffStreamCompression,
} from "../packages/sportsdesk-ops/src/bridge/bridge_3c_reader.ts";

describe("processBridge3cStream", () => {
  test("throws ERR_ROUTER_STREAM_NULL when response body is null", async () => {
    const emptyResponse = new Response(null);
    expect(processBridge3cStream(emptyResponse)).rejects.toThrow(
      "ERR_ROUTER_STREAM_NULL: Response body is empty.",
    );
  });

  test("auto-sniffs gzip magic bytes and selects bun-native-jsonl engine", async () => {
    const lines = [
      JSON.stringify({ spread: 35, total: 480, odds: -110 }),
      JSON.stringify({ spread: -70, total: 515, odds: 105 }),
    ].join("\n");

    const compressed = gzipSync(Buffer.from(lines, "utf-8"));
    const response = new Response(compressed);

    const result = await processBridge3cStream(response);

    expect(result.detectedCompression).toBe("gzip");
    expect(result.engineUsed).toBe("bun-native-jsonl");
    expect(result.rowCount).toBe(2);
    expect(result.malformedRows).toBe(0);
    expect(result.spreadCol[0]).toBe(35);
    expect(result.totalCol[0]).toBe(480);
    expect(result.oddsCol[0]).toBe(-110);
    expect(result.spreadCol[1]).toBe(-70);
    expect(result.totalCol[1]).toBe(515);
    expect(result.oddsCol[1]).toBe(105);

    const view = result.view();
    expect(view.rowCount).toBe(2);
    expect(view.spreadCol.length).toBe(2);
    expect(Array.from(view.spreadCol)).toEqual([35, -70]);
  });

  test("runs in explicit text-stream mode with chunk boundary slicing", async () => {
    const line1 = JSON.stringify({ spread: 14, total: 420, odds: -105 });
    const line2 = JSON.stringify({ spread: -14, total: 420, odds: -115 });
    const fullText = `${line1}\n${line2}\n`;

    const splitIndex = 18;
    const chunk1 = fullText.slice(0, splitIndex);
    const chunk2 = fullText.slice(splitIndex);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk1));
        controller.enqueue(new TextEncoder().encode(chunk2));
        controller.close();
      },
    });

    const response = new Response(stream);
    const result = await processBridge3cStream(response, {
      parseMode: "text-stream",
    });

    expect(result.engineUsed).toBe("text-stream");
    expect(result.rowCount).toBe(2);
    expect(result.spreadCol[0]).toBe(14);
    expect(result.totalCol[0]).toBe(420);
    expect(result.oddsCol[0]).toBe(-105);
    expect(result.spreadCol[1]).toBe(-14);
    expect(result.totalCol[1]).toBe(420);
    expect(result.oddsCol[1]).toBe(-115);
  });

  test("dynamically expands table capacity when row count exceeds initial capacity", async () => {
    const records = Array.from({ length: 8 }, (_, i) =>
      JSON.stringify({ spread: i + 1, total: (i + 1) * 10, odds: -110 }),
    ).join("\n");

    const response = new Response(records);
    const result = await processBridge3cStream(response, {
      initialCapacity: 4,
    });

    expect(result.capacity).toBeGreaterThanOrEqual(8);
    expect(result.rowCount).toBe(8);
    for (let i = 0; i < 8; i++) {
      expect(result.spreadCol[i]).toBe(i + 1);
      expect(result.totalCol[i]).toBe((i + 1) * 10);
      expect(result.oddsCol[i]).toBe(-110);
    }
  });

  test("recovers past poison lines in native parse mode with telemetry", async () => {
    const lines = [
      JSON.stringify({ spread: 7, total: 450, odds: -110 }),
      "POISON_RECORD_LINE_CORRUPT",
      JSON.stringify({ spread: -7, total: 450, odds: -110 }),
    ].join("\n");

    const malformedCapture: string[] = [];
    const response = new Response(lines);
    const result = await processBridge3cStream(response, {
      errorMode: "skip",
      onMalformedLine: (raw) => malformedCapture.push(raw),
    });

    expect(result.rowCount).toBe(2);
    expect(result.malformedRows).toBe(1);
    expect(malformedCapture[0]).toContain("POISON_RECORD_LINE_CORRUPT");
    expect(result.spreadCol[0]).toBe(7);
    expect(result.spreadCol[1]).toBe(-7);
  });

  test("serializes and deserializes zero-copy binary SOA1 snapshots", async () => {
    const lines = [
      JSON.stringify({ spread: 35, total: 480, odds: -110 }),
      JSON.stringify({ spread: -70, total: 515, odds: 105 }),
      JSON.stringify({ spread: 0, total: 440, odds: -105 }),
    ].join("\n");

    const response = new Response(lines);
    const original = await processBridge3cStream(response, {
      initialCapacity: 4,
    });

    // Serialize to ArrayBuffer using explicit function
    const binary = serializeWagerSoABinary(original, original.rowCount);
    expect(binary.byteLength).toBe(16 + 4 * 4 * 3); // 16 header + (4 cap * 4 bytes * 3 cols) = 64 bytes

    // Also verify toBinary method matches
    const methodBinary = original.toBinary();
    expect(methodBinary.byteLength).toBe(binary.byteLength);

    // Zero-copy deserialization
    const restored = deserializeWagerSoABinary(binary);
    expect(restored.rowCount).toBe(3);
    expect(restored.capacity).toBe(4);
    expect(restored.spreadCol[0]).toBe(35);
    expect(restored.totalCol[0]).toBe(480);
    expect(restored.oddsCol[0]).toBe(-110);
    expect(restored.spreadCol[1]).toBe(-70);
    expect(restored.totalCol[1]).toBe(515);
    expect(restored.oddsCol[1]).toBe(105);
    expect(restored.spreadCol[2]).toBe(0);
    expect(restored.totalCol[2]).toBe(440);
    expect(restored.oddsCol[2]).toBe(-105);
  });

  test("computes analytic metrics with zero collection allocations", async () => {
    const lines = [
      JSON.stringify({ spread: -10, total: 400, odds: -120 }),
      JSON.stringify({ spread: 20, total: 500, odds: 100 }),
    ].join("\n");

    const response = new Response(lines);
    const result = await processBridge3cStream(response);
    const metrics = computeWagerSoAMetrics(result, result.rowCount);

    expect(metrics.rowCount).toBe(2);
    expect(metrics.minSpread).toBe(-10);
    expect(metrics.maxSpread).toBe(20);
    expect(metrics.avgSpread).toBe(5);
    expect(metrics.minTotal).toBe(400);
    expect(metrics.maxTotal).toBe(500);
    expect(metrics.avgTotal).toBe(450);
    expect(metrics.minOdds).toBe(-120);
    expect(metrics.maxOdds).toBe(100);
    expect(metrics.avgOdds).toBe(-10);
  });

  test("guards against unbounded line length via maxLineBytes", async () => {
    const hugeLine = "x".repeat(100);
    const response = new Response(hugeLine);

    expect(
      processBridge3cStream(response, { maxLineBytes: 50 }),
    ).rejects.toThrow("ERR_BRIDGE3C_LINE_OVERFLOW");
  });

  test("aborts gracefully with AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Canceled by operator"));

    const response = new Response('{"spread":0}\n');
    expect(
      processBridge3cStream(response, { signal: controller.signal }),
    ).rejects.toThrow("Canceled by operator");
  });

  test("sniffStreamCompression detects magic bytes correctly", () => {
    expect(sniffStreamCompression(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe(
      "gzip",
    );
    expect(
      sniffStreamCompression(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd])),
    ).toBe("zstd");
    expect(sniffStreamCompression(new Uint8Array([0x78, 0x9c]))).toBe(
      "deflate",
    );
    expect(sniffStreamCompression(new Uint8Array([0x7b, 0x22]))).toBe(null);
  });
});
