/**
 * Compression policy — Bun exposes three gzip surfaces on two scales
 * (do not merge constants). Each line below was measured 2026-11-17 on Bun 1.4.4.
 *
 * - `Bun.Archive` gzip → vendored libdeflate, levels 1–12 (12 = best). `level: 0`
 *   or `13` throws `TypeError: Archive: level must be between 1 and 12`.
 * - `Bun.gzipSync` / `node:zlib` → vendored zlib-ng, levels 0–9. `level: 10`
 *   throws `Zlib error: Invalid argument`, and the output is byte-identical to
 *   `node:zlib.gzipSync` at the same level.
 * - `CompressionStream("gzip")` → levels 0–9 (`level: 10` throws `RangeError`),
 *   but its bytes differ from `Bun.gzipSync` at the same level, so treat it as a
 *   third scale rather than an alias of the second.
 *
 * At the same nominal level the encoders produce different bytes, so a level
 * tuned for one is not a level tuned for another.
 */

/** EOD tar.gz archives (Bun.Archive). */
export const ARCHIVE_COMPRESS = { compress: "gzip" as const, level: 4 };

/** Streaming HTTP / pipe compression (CompressionStream). */
export const STREAM_COMPRESS_BROTLI = { level: 4 as const };
