/**
 * JSONL byte-window SSOT — merge, carry-forward, and the bet-ticker read pattern.
 *
 * Worked example (same invariants as lib/f402_bet_ticker_jsonl.ts):
 *   slab → fill prefix → writtenUint8Prefix → parseChunk on complete lines → advance cursor.
 */
import { describe, expect, test } from "bun:test";

import {
  carryForwardJsonlBuffer,
  drainReadableStreamToUint8,
  jsonlAdvancePastLineFeedDelimiters,
  mergeUint8JsonlChunks,
  replayHistoricalJsonlStream,
  writtenUint8Prefix,
} from "../lib/jsonl_stream_replay.ts";

const enc = new TextEncoder();

describe("jsonl_stream_replay SSOT", () => {
  test("drainReadableStreamToUint8 matches Bun.readableStreamToArrayBuffer", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });
    const drained = await drainReadableStreamToUint8(stream);
    const ab = await Bun.readableStreamToArrayBuffer(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        },
      }),
    );
    expect(drained).toEqual(new Uint8Array(ab));
    expect([...drained]).toEqual([1, 2, 3, 4]);
  });

  test("mergeUint8JsonlChunks uses concat (no hand-rolled double set)", () => {
    const left = enc.encode('{"a":1}\n');
    const right = enc.encode('{"b":2}\n');
    const merged = mergeUint8JsonlChunks(left, right);
    expect([...merged]).toEqual([...left, ...right]);
    expect(merged.byteOffset).toBe(0);
  });

  test("writtenUint8Prefix rejects over-read", () => {
    const slab = new Uint8Array(8);
    expect(() => writtenUint8Prefix(slab, 9)).toThrow(RangeError);
    expect(writtenUint8Prefix(slab, 0).length).toBe(0);
  });

  test("worked example: two-chunk stream matches single-buffer replay", async () => {
    const line1 = '{"wager":1}\n';
    const line2 = '{"wager":2}\n';
    const full = enc.encode(`${line1}${line2}`);
    const splitAt = line1.length;

    const fromWhole: unknown[] = [];
    await replayHistoricalJsonlStream(
      new ReadableStream({
        start(c) {
          c.enqueue(full);
          c.close();
        },
      }),
      {
        onRecord: (v) => {
          fromWhole.push(v);
        },
      },
    );

    const fromChunks: unknown[] = [];
    await replayHistoricalJsonlStream(
      new ReadableStream({
        start(controller) {
          controller.enqueue(full.subarray(0, splitAt));
          controller.enqueue(full.subarray(splitAt));
          controller.close();
        },
      }),
      {
        onRecord: (v) => {
          fromChunks.push(v);
        },
      },
    );

    expect(fromChunks).toEqual(fromWhole);
    expect(fromWhole).toEqual([{ wager: 1 }, { wager: 2 }]);
  });

  test("worked example: bet-ticker slab read → parseChunk → file offset", () => {
    const fileBytes = enc.encode('{"wager":10}\n{"wager":11}\nPARTIAL');
    const slab = Bun.allocUnsafe(fileBytes.length);
    slab.set(fileBytes);
    const bytesRead = fileBytes.length;

    const view = writtenUint8Prefix(slab, bytesRead);
    expect(view.length).toBe(bytesRead);

    let lastNewline = -1;
    for (let index = view.length - 1; index >= 0; index -= 1) {
      if (view[index] === 0x0a) {
        lastNewline = index;
        break;
      }
    }
    expect(lastNewline).toBeGreaterThanOrEqual(0);

    const completeEnd = lastNewline + 1;
    const skip = 0;
    const chunk = Bun.JSONL.parseChunk(view.subarray(skip, completeEnd));
    expect(chunk.error).toBeNull();
    expect(chunk.values).toEqual([{ wager: 10 }, { wager: 11 }]);

    const consumed = jsonlAdvancePastLineFeedDelimiters(
      view,
      skip + chunk.read,
      completeEnd,
    );
    expect(consumed).toBe(completeEnd);

    const heldBack = view.subarray(completeEnd);
    expect(new TextDecoder().decode(heldBack)).toBe("PARTIAL");

    const nextStart = carryForwardJsonlBuffer(view, { read: completeEnd });
    expect(new TextDecoder().decode(nextStart)).toBe("PARTIAL");
    expect(nextStart.buffer).toBe(view.buffer);
  });
});
