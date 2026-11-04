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

  test("gzip and zstd round-trip through the native APIs", () => {
    const gzip = Bun.gzipSync(BYTES);
    expect(new Uint8Array(Bun.gunzipSync(gzip))).toEqual(BYTES);

    const zstd = Bun.zstdCompressSync(BYTES);
    expect(new Uint8Array(Bun.zstdDecompressSync(zstd))).toEqual(BYTES);
  });
});
