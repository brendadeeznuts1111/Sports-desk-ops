/**
 * Compression boundary: `Bun.deflateSync` emits raw DEFLATE, while PNG IDAT is an RFC 1950
 * zlib stream. `Bun.inflateSync` rejects the wrapper, which is why the PNG inspector in
 * `scripts/generate_pipeline_reference_images.ts` keeps `node:zlib.inflateSync`.
 */
import { describe, expect, test } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";

const TEXT = "sportsdesk compression contract ".repeat(40);
const BYTES = new TextEncoder().encode(TEXT);

describe("Bun compression contract", () => {
  test("Bun.deflateSync is raw DEFLATE, not an RFC 1950 zlib wrapper", () => {
    const raw = Bun.deflateSync(BYTES);
    const wrapped = deflateSync(BYTES);

    expect(new Uint8Array(Bun.inflateSync(raw))).toEqual(BYTES);
    expect(wrapped[0]).toBe(0x78);
    expect(() => Bun.inflateSync(wrapped)).toThrow();
    expect(new Uint8Array(inflateSync(wrapped))).toEqual(BYTES);
  });

  test("out-of-range memLevel/strategy throw instead of being ignored", () => {
    // Next-release contract: these options used to be accepted and silently replaced
    // with defaults. Callers get a RangeError now, so a bad CLI/env-derived option
    // cannot quietly change the compression profile.
    expect(() => Bun.gzipSync(BYTES, { memLevel: 10 } as never)).toThrow(
      RangeError,
    );
    expect(() => Bun.gzipSync(BYTES, { memLevel: 0 } as never)).toThrow(
      RangeError,
    );
    expect(() => Bun.deflateSync(BYTES, { strategy: 5 } as never)).toThrow(
      RangeError,
    );
    expect(() => Bun.deflateSync(BYTES, { strategy: -1 } as never)).toThrow(
      RangeError,
    );
    // In-range options still round-trip.
    const gz = Bun.gzipSync(BYTES, { memLevel: 1, strategy: 0 });
    expect(new Uint8Array(Bun.gunzipSync(gz))).toEqual(BYTES);
  });

  test("gzip and zstd round-trip through the native APIs", () => {
    const gzip = Bun.gzipSync(BYTES);
    expect(new Uint8Array(Bun.gunzipSync(gzip))).toEqual(BYTES);

    const zstd = Bun.zstdCompressSync(BYTES);
    expect(new Uint8Array(Bun.zstdDecompressSync(zstd))).toEqual(BYTES);
  });
});
