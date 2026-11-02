/**
 * Team logos: validate, measure, and resize with `Bun.Image`.
 *
 * The proxy used to trust the upstream `content-type` and forward the bytes. The scoreboard's
 * `LogoTeam1`/`LogoTeam2` values are file names from the portal's own vocabulary — `NHL.png` in a
 * team slot, `toronto.png`, `miami_dolphins_logo.png`, `Notre Dame Fighting Irish.png` — so the
 * caller cannot assume a team logo, a square, or a sane size. Decoding the bytes proves the file is
 * an image the browser can render, and the metadata is what a layout needs to reserve space before
 * the pixels arrive.
 *
 * Formats: png/jpeg/webp can be re-encoded; gif/bmp/tiff are decode-only (`Bun.Image` has no
 * encoder for them), so a resize request on those returns the original bytes with the original
 * format.
 */

export type LogoFormat =
  "jpeg" | "png" | "webp" | "heic" | "avif" | "bmp" | "tiff" | "gif";

export interface LogoMetadata {
  readonly width: number;
  readonly height: number;
  readonly format: LogoFormat;
  readonly bytes: number;
  readonly contentType: string;
}

/** A 4 MP ceiling: a solid-colour 4096×4096 logo is 16 MP and still only a few KB compressed. */
const MAX_PIXELS = 4_000_000;

const CONTENT_TYPES: Readonly<Record<LogoFormat, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  heic: "image/heic",
  avif: "image/avif",
};

const ENCODABLE = new Set<LogoFormat>(["png", "jpeg", "webp"]);

export function contentTypeFor(format: LogoFormat): string {
  return CONTENT_TYPES[format] ?? "application/octet-stream";
}

/** Throws `Bun.Image`'s `ERR_IMAGE_*` code when the bytes are not an image this build can decode. */
export async function inspectLogo(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<LogoMetadata> {
  const image = new Bun.Image(bytes, { maxPixels: MAX_PIXELS });
  const metadata = await image.metadata();
  const format = metadata.format as LogoFormat;
  return {
    width: metadata.width,
    height: metadata.height,
    format,
    bytes: bytes.byteLength,
    contentType: contentTypeFor(format),
  };
}

export interface ResizedLogo {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly metadata: LogoMetadata;
  /** False when the format cannot be re-encoded and the original bytes were returned. */
  readonly resized: boolean;
}

/**
 * Downscale to `width` pixels, preserving the aspect ratio, and re-encode in the source format.
 *
 * `width` at or above the source width returns the original bytes: upscaling a 20-pixel league
 * logo to 512 makes a blurry file larger, which is the opposite of the point.
 */
export async function resizeLogo(
  bytes: Uint8Array<ArrayBuffer>,
  metadata: LogoMetadata,
  width: number,
): Promise<ResizedLogo> {
  if (!ENCODABLE.has(metadata.format) || width >= metadata.width) {
    return { bytes, metadata, resized: false };
  }
  const builder = new Bun.Image(bytes, { maxPixels: MAX_PIXELS }).resize(width);
  const encoded =
    metadata.format === "jpeg"
      ? await builder.jpeg({ quality: 82 }).bytes()
      : metadata.format === "webp"
        ? await builder.webp({ quality: 82 }).bytes()
        : await builder.png().bytes();
  const out = new Uint8Array(encoded);
  return {
    bytes: out,
    metadata: await inspectLogo(out),
    resized: true,
  };
}

/** Response headers that describe the image, so a client can size its box before the bytes land. */
export function logoHeaders(metadata: LogoMetadata): Record<string, string> {
  return {
    "X-Image-Width": String(metadata.width),
    "X-Image-Height": String(metadata.height),
    "X-Image-Format": metadata.format,
    "X-Image-Bytes": String(metadata.bytes),
  };
}
