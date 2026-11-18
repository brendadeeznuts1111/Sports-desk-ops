/**
 * @file lib/bun_thumbnail.ts
 * @description Deterministic WebP thumbnail writer built on `Bun.Image`.
 *
 * `Bun.Image.backend` selects the resize/rotate/flip implementation, not the codec:
 * `"system"` is the macOS/Windows default (Accelerate vImage on macOS with the default
 * `lanczos3` filter), `"bun"` is the portable Highway SIMD path. JPEG/PNG/WebP codecs are the same
 * built-in codecs on every platform, so pinning `"bun"` makes geometry byte-identical for
 * golden-image tests. TIFF/HEIC/AVIF still decode through the OS, so their output can differ by
 * platform regardless of this setting.
 */

import { mkdirSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { DEFAULT_MAX_PIXELS, MAX_IMAGE_EDGE } from "./image_limits.ts";

/** Default long edge for generated thumbnails. */
export const DEFAULT_THUMBNAIL_EDGE = 400;
/** Default WebP quality for generated thumbnails. */
export const DEFAULT_THUMBNAIL_QUALITY = 80;
/** Longest edge `Bun.Image.resize()` accepts. */
export const MAX_THUMBNAIL_EDGE = MAX_IMAGE_EDGE;

export type BunImageBackend = "bun" | "system";

export interface WebpThumbnailOptions {
  /** Longest output edge in pixels, `1..16384`. Default 400. */
  readonly maxEdge?: number | undefined;
  /** WebP quality, `1..100`. Default 80. */
  readonly quality?: number | undefined;
  /** Source/target pixel cap. Default 16384². */
  readonly maxPixels?: number | undefined;
  /** Resize backend. Default `"bun"` so generated artifacts are platform-stable. */
  readonly backend?: BunImageBackend | undefined;
  /** Keep images smaller than `maxEdge` at their own size. Default true. */
  readonly withoutEnlargement?: boolean | undefined;
}

export interface WebpThumbnail {
  readonly source: string;
  readonly destination: string;
  readonly bytesWritten: number;
  readonly width: number;
  readonly height: number;
  readonly format: "webp";
  readonly maxEdge: number;
  readonly quality: number;
  readonly backend: string;
}

function assertInt(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer in ${minimum}..${maximum}, got ${value}`,
    );
  }
}

/**
 * Destination for a thumbnail that keeps the source filename:
 * `<root>/nested/a.png` → `<thumbsDir>/nested/a.png.thumb.webp`. A source outside `root` is placed
 * at the top level by basename so the result can never escape `thumbsDir`.
 */
export function thumbnailDestination(
  root: string,
  source: string,
  thumbsDir: string,
): string {
  const rel = relative(root, source);
  const safeRel =
    rel === "" || rel.startsWith("..") || isAbsolute(rel)
      ? basename(source)
      : rel;
  const dir = dirname(safeRel);
  const name = `${basename(safeRel)}.thumb.webp`;
  return dir === "." ? join(thumbsDir, name) : join(thumbsDir, dir, name);
}

/** Resize + encode a WebP thumbnail and write it, returning the measured output attributes. */
export async function writeWebpThumbnail(
  source: string,
  destination: string,
  options: WebpThumbnailOptions = {},
): Promise<WebpThumbnail> {
  const maxEdge = options.maxEdge ?? DEFAULT_THUMBNAIL_EDGE;
  const quality = options.quality ?? DEFAULT_THUMBNAIL_QUALITY;
  assertInt("maxEdge", maxEdge, 1, MAX_THUMBNAIL_EDGE);
  assertInt("quality", quality, 1, 100);
  if (resolve(source) === resolve(destination)) {
    throw new Error("thumbnail destination must differ from the source");
  }

  const file = Bun.file(source);
  if (!(await file.exists())) {
    throw new Error(`source image not found: ${source}`);
  }

  Bun.Image.backend = options.backend ?? "bun";
  mkdirSync(dirname(resolve(destination)), { recursive: true });

  const pipeline = file
    .image({ maxPixels: options.maxPixels ?? DEFAULT_MAX_PIXELS })
    .resize(maxEdge, maxEdge, {
      fit: "inside",
      withoutEnlargement: options.withoutEnlargement !== false,
    })
    .webp({ quality });
  const bytesWritten = await pipeline.write(destination);

  return Object.freeze({
    source,
    destination,
    bytesWritten,
    width: pipeline.width,
    height: pipeline.height,
    format: "webp",
    maxEdge,
    quality,
    backend: Bun.Image.backend,
  });
}
