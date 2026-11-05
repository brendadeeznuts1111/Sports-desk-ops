/**
 * SharedArrayBuffer boundary.
 *
 * Bun stream chunks and `bun:jsc.serialize()` can hand back SharedArrayBuffer-backed data. The
 * JSONL replay path types its buffers as `Uint8Array<ArrayBufferLike>` for that reason; this test
 * pins the acceptance points so a runtime change surfaces here.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize, serialize } from "bun:jsc";

import {
  carryForwardJsonlBuffer,
  skipPoisonJsonlLine,
} from "../lib/jsonl_stream_replay.ts";

describe("SharedArrayBuffer contract", () => {
  test("growable buffers expose growable, maxByteLength, grow and the tag", () => {
    const sab = new SharedArrayBuffer(16, { maxByteLength: 32 });
    expect(sab.growable).toBe(true);
    expect(sab.maxByteLength).toBe(32);
    expect(sab.byteLength).toBe(16);

    sab.grow(24);
    expect(sab.byteLength).toBe(24);
    expect(Object.prototype.toString.call(sab)).toBe(
      "[object SharedArrayBuffer]",
    );
  });

  test("species, tag, slice and grow semantics", () => {
    expect(SharedArrayBuffer[Symbol.species]).toBe(SharedArrayBuffer);

    const sab = new SharedArrayBuffer(8, { maxByteLength: 16 });
    new Uint8Array(sab).set([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Object.prototype.toString.call(sab)).toBe(
      "[object SharedArrayBuffer]",
    );

    const slice = sab.slice(2, 5);
    expect(slice).toBeInstanceOf(SharedArrayBuffer);
    expect([...new Uint8Array(slice)]).toEqual([3, 4, 5]);
    new Uint8Array(slice)[0] = 99;
    expect(new Uint8Array(sab)[2]).toBe(3);

    sab.grow(12);
    expect(sab.byteLength).toBe(12);
    expect(() => sab.grow()).toThrow(RangeError);
    expect(() => sab.grow(4)).toThrow(RangeError);
    expect(() => sab.grow(32)).toThrow(RangeError);
    expect(() => new SharedArrayBuffer(8).grow(12)).toThrow(TypeError);
  });

  test("Bun.JSONL.parseChunk reads SAB-backed views with byte offsets", () => {
    const text = '{"a":1}\n{"b":2}\n';
    const sab = new SharedArrayBuffer(text.length);
    const view = new Uint8Array(sab);
    view.set(new TextEncoder().encode(text));

    const all = Bun.JSONL.parseChunk(view);
    expect(all.done).toBe(true);
    expect(all.error).toBeNull();
    expect(all.values).toEqual([{ a: 1 }, { b: 2 }]);

    const from = Bun.JSONL.parseChunk(view, 8);
    expect(from.values).toEqual([{ b: 2 }]);
    expect(from.read).toBe(text.length - 1);
  });

  test("Bun.write, Bun.hash, ArrayBufferSink and jsc.serialize accept SAB", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sab = new SharedArrayBuffer(bytes.length);
    new Uint8Array(sab).set(bytes);

    expect(Bun.hash(sab)).toBe(Bun.hash(bytes));

    const sink = new Bun.ArrayBufferSink();
    sink.write(sab);
    expect(new Uint8Array(sink.end())).toEqual(bytes);

    const dir = mkdtempSync(join(tmpdir(), "sab-contract-"));
    try {
      const path = join(dir, "sab.bin");
      await Bun.write(path, sab);
      expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const serialized = serialize({ a: 1 });
    expect(serialized).toBeInstanceOf(SharedArrayBuffer);
    expect(deserialize(serialized)).toEqual({ a: 1 });
  });
});

describe("ArrayBuffer Uint8Array views", () => {
  test("subarray shares backing storage; slice copies", () => {
    const buffer = new ArrayBuffer(8);
    const uint8 = new Uint8Array(buffer);
    uint8.set([1, 2, 3]);
    expect([...uint8]).toEqual([1, 2, 3, 0, 0, 0, 0, 0]);

    const sub = uint8.subarray(0, 4);
    expect([...sub]).toEqual([1, 2, 3, 0]);

    sub[0] = 99;
    expect(uint8[0]).toBe(99);

    const copy = uint8.slice(0, 4);
    copy[1] = 88;
    expect(uint8[1]).toBe(2);
  });

  test("subarray indices are relative to byteOffset", () => {
    const buffer = new ArrayBuffer(8);
    new Uint8Array(buffer).set([0, 1, 2, 3, 4, 5, 6, 7]);
    const window = new Uint8Array(buffer, 2, 4);
    expect([...window]).toEqual([2, 3, 4, 5]);
    expect(window.byteOffset).toBe(2);
    expect(window.buffer).toBe(buffer);

    const tail = window.subarray(1, 3);
    expect([...tail]).toEqual([3, 4]);
    tail[0] = 99;
    expect(new Uint8Array(buffer)[3]).toBe(99);
  });

  test("carryForwardJsonlBuffer drops consumed bytes without copying the buffer object", () => {
    const text = '{"a":1}\n{"b":';
    const bytes = new TextEncoder().encode(text);
    const first = Bun.JSONL.parseChunk(bytes);
    expect(first.values).toEqual([{ a: 1 }]);
    expect(first.read).toBeGreaterThan(0);

    const rest = carryForwardJsonlBuffer(bytes, first);
    expect(rest.buffer).toBe(bytes.buffer);
    expect(rest.byteOffset).toBe(bytes.byteOffset + first.read);
    const second = Bun.JSONL.parseChunk(rest);
    expect(second.values).toEqual([]);
    expect(new TextDecoder().decode(rest)).toContain('"b"');
  });

  test("skipPoisonJsonlLine advances with subarray past a bad line", () => {
    const poison = new TextEncoder().encode('not-json\n{"ok":1}\n');
    const after = skipPoisonJsonlLine(poison);
    const parsed = Bun.JSONL.parseChunk(after);
    expect(parsed.values).toEqual([{ ok: 1 }]);
  });

  test("allocUnsafe prefix slice exposes only the filled span", () => {
    const slab = Bun.allocUnsafe(16);
    slab.set([10, 11, 12, 13], 0);
    const exposed = slab.subarray(0, 4);
    expect([...exposed]).toEqual([10, 11, 12, 13]);
    exposed[0] = 1;
    expect(slab[0]).toBe(1);
    // Tail bytes are not part of `exposed`; production code must not read slab[4..] without writing.
    expect(exposed.buffer).toBe(slab.buffer);
  });
});
