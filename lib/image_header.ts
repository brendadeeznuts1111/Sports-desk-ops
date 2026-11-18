/**
 * @file lib/image_header.ts
 * @description Read `Bun.Image` metadata from a partial buffer, with format-aware minimums.
 *
 * `new Bun.Image(bytes).metadata()` does not decode pixels, but it still walks enough of the file to
 * reach the dimensions. Measured on Bun 1.4.4:
 *
 * - PNG: 24 bytes (signature + IHDR width/height); 23 rejects with `ERR_IMAGE_DECODE_FAILED`.
 * - WebP: 32 bytes (RIFF + chunk header + dimensions); 31 rejects.
 * - JPEG: through the SOS marker plus 10 bytes. A clean re-encode needs 619 bytes, but
 *   `docs/assets/ARCH-Guide.jpg` keeps EXIF/XMP ahead of SOF and needs 1,082,595 of 1,428,749
 *   bytes. A fixed 64 KiB "header" slice therefore fails on real JPEGs.
 *
 * The helper returns `ERR_IMAGE_HEADER_TRUNCATED` with the next needed prefix length, so a caller
 * can range-fetch and retry instead of reading the whole object.
 */

import { imageErrorCode } from "./image_errors.ts";

export type ImageHeaderErrorCode =
  | "ERR_IMAGE_HEADER_TRUNCATED"
  | "ERR_IMAGE_UNKNOWN_FORMAT"
  | "ERR_IMAGE_DECODE_FAILED";

export interface ImageHeaderAttributes {
  readonly width: number;
  readonly height: number;
  readonly format: Bun.Image.Metadata["format"];
}

export type ImageHeaderResult =
  | { readonly ok: true; readonly attributes: ImageHeaderAttributes }
  | {
      readonly ok: false;
      readonly code: ImageHeaderErrorCode;
      readonly format: string | null;
      /** Next prefix length to try, or `null` when the format makes it unknowable. */
      readonly requiredBytes: number | null;
    };

/** Measured minimum prefixes for the formats where the header alone is enough. */
export const IMAGE_HEADER_MIN_BYTES: Readonly<Record<"png" | "webp", number>> =
  Object.freeze({ png: 24, webp: 32 });

/** JPEG sequence-start header cost after the SOS marker (measured: 10 bytes). */
const JPEG_SOS_HEADER_BYTES = 10;

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < start + length; i++) {
    const byte = bytes[i];
    if (byte === undefined) return out;
    out += String.fromCharCode(byte);
  }
  return out;
}

export function detectImageFormat(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "jpeg";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    return "webp";
  }
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "gif";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x2a &&
      bytes[3] === 0x00) ||
      (bytes[0] === 0x4d &&
        bytes[1] === 0x4d &&
        bytes[2] === 0x00 &&
        bytes[3] === 0x2a))
  ) {
    return "tiff";
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return "avif";
    if (
      brand === "heic" ||
      brand === "heix" ||
      brand === "hevc" ||
      brand === "mif1"
    ) {
      return "heic";
    }
  }
  return null;
}

type JpegScan =
  | { readonly kind: "sos"; readonly offset: number }
  | { readonly kind: "needs"; readonly requiredBytes: number }
  | { readonly kind: "none" };

/** Walks JPEG markers until SOS, reporting the next segment boundary when the slice ends early. */
function scanJpegToSos(bytes: Uint8Array): JpegScan {
  let i = 2;
  while (i < bytes.length) {
    if (i + 1 >= bytes.length) return { kind: "needs", requiredBytes: i + 2 };
    if (bytes[i] !== 0xff) return { kind: "none" };
    const marker = bytes[i + 1]!;
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    if (marker === 0xda) return { kind: "sos", offset: i };
    if (marker === 0xd9) return { kind: "none" };
    if (i + 3 >= bytes.length) return { kind: "needs", requiredBytes: i + 4 };
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (length < 2) return { kind: "none" };
    const end = i + 2 + length;
    if (end > bytes.length) {
      // Ask for the segment plus the next marker header, so growth costs one request per segment.
      return { kind: "needs", requiredBytes: end + 4 };
    }
    i = end;
  }
  return { kind: "needs", requiredBytes: i + 2 };
}

function truncated(
  format: string | null,
  requiredBytes: number | null,
): ImageHeaderResult {
  return {
    ok: false,
    code: "ERR_IMAGE_HEADER_TRUNCATED",
    format,
    requiredBytes,
  };
}

function decodeFailed(
  format: string | null,
  code: string | null,
): ImageHeaderResult {
  return {
    ok: false,
    code:
      code === "ERR_IMAGE_UNKNOWN_FORMAT"
        ? "ERR_IMAGE_UNKNOWN_FORMAT"
        : "ERR_IMAGE_DECODE_FAILED",
    format,
    requiredBytes: null,
  };
}

/**
 * Reads dimensions from a possibly-partial buffer. When the slice ends before the dimensions,
 * returns `ERR_IMAGE_HEADER_TRUNCATED` and the next prefix length to request.
 */
export async function readImageHeaderMetadata(
  bytes: Uint8Array,
): Promise<ImageHeaderResult> {
  if (bytes.length === 0) return truncated(null, 1);
  const format = detectImageFormat(bytes);
  if (format === null) {
    return {
      ok: false,
      code: "ERR_IMAGE_UNKNOWN_FORMAT",
      format: null,
      requiredBytes: null,
    };
  }

  if (format === "png") {
    const minimum = IMAGE_HEADER_MIN_BYTES.png;
    if (bytes.length < minimum) return truncated(format, minimum);
  } else if (format === "webp") {
    const minimum = IMAGE_HEADER_MIN_BYTES.webp;
    if (bytes.length < minimum) return truncated(format, minimum);
  } else if (format === "jpeg") {
    const scan = scanJpegToSos(bytes);
    if (scan.kind === "none") return decodeFailed(format, null);
    if (scan.kind === "needs") {
      if (scan.requiredBytes > bytes.length) {
        return truncated(format, scan.requiredBytes);
      }
      return decodeFailed(format, null);
    }
    const requiredBytes = scan.offset + JPEG_SOS_HEADER_BYTES;
    if (bytes.length < requiredBytes) return truncated(format, requiredBytes);
  }

  try {
    const metadata = await new Bun.Image(bytes).metadata();
    return {
      ok: true,
      attributes: {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
      },
    };
  } catch (error) {
    return decodeFailed(format, imageErrorCode(error) ?? null);
  }
}
