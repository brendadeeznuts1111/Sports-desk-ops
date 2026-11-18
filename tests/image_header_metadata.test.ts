/**
 * @file tests/image_header_metadata.test.ts
 * @description Pins the partial-buffer contract of `Bun.Image.metadata()` on Bun 1.4.4:
 * PNG needs 24 bytes, WebP 32, JPEG through SOS + 10 — and a real 1.4 MB JPEG with EXIF/XMP ahead
 * of SOF needs 1,082,595 bytes, so a fixed 64 KiB header slice is not enough.
 */
import { describe, expect, test } from "bun:test";

import {
  detectImageFormat,
  IMAGE_HEADER_MIN_BYTES,
  type ImageHeaderResult,
  readImageHeaderMetadata,
} from "../lib/image_header.ts";
import { png1x1 } from "./support/image_fixtures.ts";

async function growToMetadata(
  bytes: Uint8Array,
  initialPrefix: number,
): Promise<{ result: ImageHeaderResult; prefix: number; attempts: number }> {
  let prefix = initialPrefix;
  let result = await readImageHeaderMetadata(bytes.subarray(0, prefix));
  let attempts = 1;
  while (
    !result.ok &&
    result.code === "ERR_IMAGE_HEADER_TRUNCATED" &&
    attempts < 48
  ) {
    const next = result.requiredBytes;
    if (next === null || next <= prefix) break;
    prefix = Math.min(bytes.length, next);
    result = await readImageHeaderMetadata(bytes.subarray(0, prefix));
    attempts += 1;
  }
  return { result, prefix, attempts };
}

describe("readImageHeaderMetadata", () => {
  test("PNG needs 24 bytes and rejects 23", async () => {
    const png = new Uint8Array(
      await Bun.file(
        "docs/assets/pipeline-10-mode-architecture.png",
      ).arrayBuffer(),
    );
    expect(detectImageFormat(png)).toBe("png");
    expect(IMAGE_HEADER_MIN_BYTES.png).toBe(24);

    const short = await readImageHeaderMetadata(png.subarray(0, 23));
    expect(short).toMatchObject({
      ok: false,
      code: "ERR_IMAGE_HEADER_TRUNCATED",
      format: "png",
      requiredBytes: 24,
    });

    const ok = await readImageHeaderMetadata(png.subarray(0, 24));
    expect(ok).toMatchObject({
      ok: true,
      attributes: { width: 1600, height: 920, format: "png" },
    });
  });

  test("WebP needs 32 bytes and rejects 31", async () => {
    const webp = new Uint8Array(
      await Bun.file("docs/assets/ARCH-Guide.webp").arrayBuffer(),
    );
    expect(detectImageFormat(webp)).toBe("webp");
    expect(IMAGE_HEADER_MIN_BYTES.webp).toBe(32);

    const short = await readImageHeaderMetadata(webp.subarray(0, 31));
    expect(short).toMatchObject({
      ok: false,
      code: "ERR_IMAGE_HEADER_TRUNCATED",
      requiredBytes: 32,
    });
    const ok = await readImageHeaderMetadata(webp.subarray(0, 32));
    expect(ok).toMatchObject({
      ok: true,
      attributes: { width: 1200, height: 896, format: "webp" },
    });
  });

  test("a clean JPEG resolves after walking to SOS + 10", async () => {
    const png = png1x1();
    const clean = new Uint8Array(
      await new Bun.Image(png).resize(120, 90).jpeg({ quality: 80 }).bytes(),
    );
    expect(detectImageFormat(clean)).toBe("jpeg");

    const grown = await growToMetadata(clean, 16);
    expect(grown.result.ok).toBe(true);
    expect(grown.attempts).toBeGreaterThan(1);
    if (grown.result.ok) {
      expect(grown.result.attributes).toEqual({
        width: 120,
        height: 90,
        format: "jpeg",
      });
    }
    expect(grown.prefix).toBeLessThan(clean.length);
  });

  test("a 1.4 MB JPEG with EXIF/XMP needs more than a 64 KiB slice", async () => {
    const jpeg = new Uint8Array(
      await Bun.file("docs/assets/ARCH-Guide.jpg").arrayBuffer(),
    );
    const short = await readImageHeaderMetadata(jpeg.subarray(0, 64 * 1024));
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.code).toBe("ERR_IMAGE_HEADER_TRUNCATED");
      expect(short.requiredBytes).toBeGreaterThan(64 * 1024);
    }

    const grown = await growToMetadata(jpeg, 64 * 1024);
    expect(grown.result.ok).toBe(true);
    expect(grown.attempts).toBeGreaterThan(1);
    expect(grown.prefix).toBeGreaterThan(1024 * 1024);
    expect(grown.prefix).toBeLessThan(jpeg.length);
    if (grown.result.ok) {
      expect(grown.result.attributes).toEqual({
        width: 1200,
        height: 896,
        format: "jpeg",
      });
    }
  });

  test("unknown and empty buffers are labelled, not guessed", async () => {
    const unknown = await readImageHeaderMetadata(
      new TextEncoder().encode("not an image"),
    );
    expect(unknown).toMatchObject({
      ok: false,
      code: "ERR_IMAGE_UNKNOWN_FORMAT",
      format: null,
    });

    const empty = await readImageHeaderMetadata(new Uint8Array(0));
    expect(empty).toMatchObject({
      ok: false,
      code: "ERR_IMAGE_HEADER_TRUNCATED",
      requiredBytes: 1,
    });
  });
});
