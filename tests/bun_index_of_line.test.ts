import { describe, expect, test } from "bun:test";
import { skipPoisonJsonlLine } from "../lib/jsonl_stream_replay.ts";

/**
 * `Bun.indexOfLine(buffer, offset?)` is the native "readline without the IO"
 * scan. These cases pin the contract the JSONL readers rely on, so an upgrade
 * that changes the return convention (e.g. -1 → buffer.length) fails here.
 *
 * @see https://bun.com/reference/bun/indexOfLine
 */
describe("Bun.indexOfLine", () => {
  test("returns the LF index, or -1 when the buffer has no newline", () => {
    expect(Bun.indexOfLine(Buffer.from("a\nb"))).toBe(1);
    expect(Bun.indexOfLine(Buffer.from("abc"))).toBe(-1);
    expect(Bun.indexOfLine(Buffer.from(""))).toBe(-1);
    expect(Bun.indexOfLine(Buffer.from("\nx"))).toBe(0);
  });

  test("finds the LF of a CRLF pair, not the CR", () => {
    expect(Bun.indexOfLine(Buffer.from("a\r\nb"))).toBe(2);
  });

  test("scans ill-formed UTF-8 without a decode step", () => {
    // 0xff is never a valid lead byte; LF still delimits.
    expect(Bun.indexOfLine(Uint8Array.from([0xff, 0xfe, 0x0a, 0x41]))).toBe(2);
    // Multi-byte sequence before the delimiter must not shift the index.
    expect(Bun.indexOfLine(Buffer.from("é\nb"))).toBe(2);
    expect(Bun.indexOfLine(Buffer.from("🎲\n"))).toBe(4);
  });

  test("honours numeric and bigint offsets", () => {
    const buf = Buffer.from("aa\nbb\ncc");
    expect(Bun.indexOfLine(buf, 0)).toBe(2);
    expect(Bun.indexOfLine(buf, 3)).toBe(5);
    expect(Bun.indexOfLine(buf, 3n)).toBe(5);
    expect(Bun.indexOfLine(buf, buf.length)).toBe(-1);
    expect(Bun.indexOfLine(buf, buf.length + 10)).toBe(-1);
  });

  test("accepts a raw ArrayBuffer as well as a view", () => {
    const bytes = new TextEncoder().encode("x\ny");
    expect(Bun.indexOfLine(bytes)).toBe(1);
    expect(Bun.indexOfLine(bytes.buffer)).toBe(1);
  });

  test("agrees with a byte scan across a mixed corpus", () => {
    const samples = [
      "",
      "\n",
      "\n\n\n",
      "one line",
      "one\ntwo",
      "\r\n\r\n",
      "éé\né",
      "\u0000\u0001\n\u0002",
    ];
    for (const sample of samples) {
      const buf = Buffer.from(sample);
      expect(Bun.indexOfLine(buf)).toBe(buf.indexOf(0x0a));
      expect(Bun.indexOfLine(buf, 1)).toBe(buf.indexOf(0x0a, 1));
    }
  });

  test("skipPoisonJsonlLine drops the poison line and keeps the remainder", () => {
    // The helper is the repo call site; it must consume exactly one line.
    const poisoned = Buffer.from('###not json###\n{"ok":true}\n');
    expect(skipPoisonJsonlLine(poisoned).toString()).toBe('{"ok":true}\n');
    // No newline: nothing to skip, the buffer is returned unchanged.
    const single = Buffer.from("###not json###");
    expect(skipPoisonJsonlLine(single).toString()).toBe("###not json###");
  });
});
