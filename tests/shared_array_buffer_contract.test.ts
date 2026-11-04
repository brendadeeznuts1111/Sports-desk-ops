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
