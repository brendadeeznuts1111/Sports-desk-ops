/**
 * @file tests/bun_jsonl_contracts.test.ts
 * @description Pins `Bun.JSONL` cursor semantics and its documented fail-open.
 *
 * Measured on `Bun 1.4.4+38afee6c8` (2026-11-17):
 *
 *   input                        len  read  done   error        values  tail from read
 *   '{"a":1}\n'                    8     7  true   -                 1  "\n"
 *   '{"a":1}\n{"b":2}\n'          16    15  true   -                 2  "\n"
 *   '{"a":1}'                      7     7  true   -                 1  ""
 *   '\n\n{"id":1}\n,\n'           13    10  false  SyntaxError       1  "\n,\n"
 *   '{"a":1}\n{"b":'              13     7  false  -                 1  "\n{\"b\":"
 *
 * Two things follow, and both differ from the intuitive reading:
 *
 * 1. `read` stops **at** the terminating newline, not past it. A caller that
 *    slices `input.subarray(chunk.read)` re-feeds that newline, which is why the
 *    retry below is safe: a leading blank line is not an error.
 * 2. `Bun.JSONL.parse()` does NOT throw on trailing garbage — it returns the
 *    parsed prefix silently. That is why `lib/stale_line_cohort.ts` keeps a
 *    hand-rolled strict parser and why `docs/bun-upstream-reference.md`
 *    ("When NOT to migrate to Bun.JSONL") lists it. The last test pins the
 *    fail-open so a future hardening shows up as a failure rather than a silent
 *    behaviour change.
 */

import { describe, expect, test } from "bun:test";

const encoder = new TextEncoder();

describe("Bun.JSONL.parseChunk cursor", () => {
  test("read stops at the terminating newline, so the caller re-feeds it", () => {
    const raw = '{"a":1}\n';
    const chunk = Bun.JSONL.parseChunk(encoder.encode(raw));
    expect(chunk.values).toEqual([{ a: 1 }]);
    expect(chunk.done).toBe(true);
    expect(chunk.error).toBeNull();
    // Not raw.length: the trailing newline is still in the tail.
    expect(chunk.read).toBe(raw.length - 1);
    expect(
      new TextDecoder().decode(encoder.encode(raw).subarray(chunk.read)),
    ).toBe("\n");
  });

  test("a complete input without a trailing newline consumes everything", () => {
    const raw = '{"a":1}';
    const chunk = Bun.JSONL.parseChunk(encoder.encode(raw));
    expect(chunk.values).toEqual([{ a: 1 }]);
    expect(chunk.done).toBe(true);
    expect(chunk.read).toBe(raw.length);
  });

  test("a partial trailing record is left in the tail, not reported as an error", () => {
    const raw = '{"a":1}\n{"b":';
    const chunk = Bun.JSONL.parseChunk(encoder.encode(raw));
    expect(chunk.values).toEqual([{ a: 1 }]);
    expect(chunk.done).toBe(false);
    expect(chunk.error).toBeNull();
    expect(
      new TextDecoder().decode(encoder.encode(raw).subarray(chunk.read)),
    ).toBe('\n{"b":');
  });

  test("blank lines plus a stray delimiter emit the record once and never rewind", () => {
    for (const stray of [",", "]", "}"] as const) {
      const raw = `\n\n{"id":1,"leg":"GSLIVE"}\n${stray}\n`;
      const bytes = encoder.encode(raw);
      const recordStart = raw.indexOf("{");
      const recordTerminator = raw.indexOf("\n", recordStart);

      const chunk = Bun.JSONL.parseChunk(bytes);

      expect(chunk.done).toBe(false);
      expect(chunk.error).toBeInstanceOf(SyntaxError);
      // Exactly once — the v1.4.3 regression duplicated this value.
      expect(chunk.values).toEqual([{ id: 1, leg: "GSLIVE" }]);
      // Never rewinds before the record it already emitted, and stops at the
      // record's terminator rather than consuming the stray delimiter.
      expect(chunk.read).toBeGreaterThan(recordStart);
      expect(chunk.read).toBe(recordTerminator);

      const tail = Bun.JSONL.parseChunk(bytes.subarray(chunk.read));
      expect(tail.values).toEqual([]);
      expect(tail.error).toBeInstanceOf(SyntaxError);
    }
  });
});

describe("Bun.JSONL.parse fail-open", () => {
  test("parse() returns the parsed prefix and does not throw on trailing garbage", () => {
    const raw = '\n\n{"id":1,"leg":"GSLIVE"}\n,\n';

    // Documented hazard: strict callers must not rely on parse() to reject.
    expect(Bun.JSONL.parse(raw)).toEqual([{ id: 1, leg: "GSLIVE" }]);
    expect(Bun.JSONL.parse(encoder.encode(raw))).toEqual([
      { id: 1, leg: "GSLIVE" },
    ]);
  });

  test("parse() does throw on a malformed first record", () => {
    // The distinction that matters: garbage before any valid record is fatal;
    // garbage after one is silently dropped.
    expect(() => Bun.JSONL.parse("{not json}\n")).toThrow(SyntaxError);
  });
});
