/**
 * @file screenshot_clipboard.ts
 * @description Clipboard screenshot capture, publish-sized encoding, and the manifest entry shape.
 *
 * `Bun.Image.fromClipboard()` reads the operating-system clipboard's image synchronously and returns
 * `null` when there is none; `Bun.Image.hasClipboardImage()` answers the same question without
 * decoding; and `Bun.Image.clipboardChangeCount()` is a counter that moves when the clipboard
 * changes, which is what lets a watcher skip an unchanged image.
 *
 * Every `Bun.Image` terminal is async — `.resize()` and `.webp()` return a chainable `Image`, while
 * `.bytes()` / `.blob()` / `.metadata()` resolve. Measured on Bun 1.4.4.
 */

import { atomicWrite } from "./f402_agent_graph_artifacts.ts";

/** The clipboard held no image. Not an error in the system: nothing was captured. */
export const ERR_SCREENSHOT_CLIPBOARD_EMPTY = "ERR_SCREENSHOT_CLIPBOARD_EMPTY";
/** The encoder produced no bytes, or bytes that do not re-decode. */
export const ERR_SCREENSHOT_ENCODE = "ERR_SCREENSHOT_ENCODE";

export type ScreenshotFormat = "webp" | "png" | "jpeg";

export const SCREENSHOT_FORMATS: readonly ScreenshotFormat[] = [
  "webp",
  "png",
  "jpeg",
];

export const SCREENSHOT_MANIFEST_VERSION = 1;
export const SCREENSHOT_MANIFEST_FILENAME = "screenshot-manifest.json";

export interface ScreenshotOptimizeOptions {
  /** Longest edge in pixels. Smaller sources are never upscaled. */
  readonly maxEdge: number;
  /** Encoder quality, 1–100. Ignored by PNG. */
  readonly quality: number;
  readonly format: ScreenshotFormat;
}

export interface OptimizedScreenshot {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly format: ScreenshotFormat;
  readonly mime: string;
  /** What the clipboard/file actually held, so a size claim is checkable later. */
  readonly source: {
    readonly width: number;
    readonly height: number;
    readonly format: string;
    readonly bytes: number;
  };
}

export interface ScreenshotManifestEntry {
  /** Hex digest of the optimized bytes: the identity of the published object. */
  readonly sha256: string;
  /** Object key inside the bucket. */
  readonly key: string;
  readonly publicUrl: string | null;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly format: ScreenshotFormat;
  readonly quality: number;
  readonly maxEdge: number;
  /** Pre-encode facts, so a "smaller file" claim can be checked later. */
  readonly sourceBytes: number;
  readonly sourceFormat: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly capturedAt: string;
  readonly clipboardChangeCount: number | null;
}

export interface ScreenshotManifest {
  readonly version: number;
  readonly generatedAt: string;
  readonly entries: readonly ScreenshotManifestEntry[];
}

/** The slice of `Bun.Image` this module reads, so a test can inject a fake. */
export interface ClipboardImageApi {
  readonly hasClipboardImage: () => boolean;
  readonly clipboardChangeCount: () => number;
  readonly fromClipboard: () => unknown | null;
}

/** The subset of `Bun.Image` the encoder needs. */
export interface ImageEncoderApi {
  readonly Image: new (input: unknown) => EncodableImage;
}

interface EncodableImage {
  readonly resize: (
    width: number,
    height?: number,
    options?: {
      readonly fit?: "fill" | "inside";
      readonly withoutEnlargement?: boolean;
    },
  ) => EncodableImage;
  readonly webp: (options?: { readonly quality?: number }) => EncodableImage;
  readonly png: () => EncodableImage;
  readonly jpeg: (options?: { readonly quality?: number }) => EncodableImage;
  readonly bytes: () => Promise<Uint8Array>;
  readonly metadata: () => Promise<{
    readonly width: number;
    readonly height: number;
    readonly format: string;
    readonly size?: number;
  }>;
}

export class ScreenshotError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScreenshotError";
  }
}

export function mimeForScreenFormat(format: ScreenshotFormat): string {
  switch (format) {
    case "webp":
      return "image/webp";
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    default: {
      const unreachable: never = format;
      throw new ScreenshotError(
        ERR_SCREENSHOT_ENCODE,
        `unknown screenshot format: ${String(unreachable)}`,
      );
    }
  }
}

/**
 * Longest-edge target. `withoutEnlargement` semantics: a source already within `maxEdge` keeps its
 * size, and the aspect ratio is preserved. Rounding is floored at 1 so a degenerate input cannot
 * produce a 0-pixel edge that the encoder rejects.
 */
export function targetDimensions(
  width: number,
  height: number,
  maxEdge: number,
): { readonly width: number; readonly height: number } {
  if (width <= 0 || height <= 0) {
    throw new ScreenshotError(
      ERR_SCREENSHOT_ENCODE,
      `source image has no pixels (${width}x${height})`,
    );
  }
  if (maxEdge <= 0) {
    throw new ScreenshotError(
      ERR_SCREENSHOT_ENCODE,
      `maxEdge must be positive, got ${maxEdge}`,
    );
  }
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** A clipboard image only needs to yield bytes: `Bun.Image.blob()` is its publishable form. */
export interface ClipboardImage {
  readonly blob: () => Promise<Blob>;
}

/** Read the clipboard image, or explain precisely why there is none. */
export function readClipboardImage(
  api: ClipboardImageApi = Bun.Image as unknown as ClipboardImageApi,
): ClipboardImage {
  if (!api.hasClipboardImage()) {
    throw new ScreenshotError(
      ERR_SCREENSHOT_CLIPBOARD_EMPTY,
      "the clipboard holds no image — copy a screenshot first, or pass --file <path>",
    );
  }
  const image = api.fromClipboard();
  if (image === null || image === undefined) {
    throw new ScreenshotError(
      ERR_SCREENSHOT_CLIPBOARD_EMPTY,
      "hasClipboardImage() reported an image but fromClipboard() returned nothing — copy the image again",
    );
  }
  const candidate = image as { readonly blob?: () => Promise<Blob> };
  if (typeof candidate.blob !== "function") {
    throw new ScreenshotError(
      ERR_SCREENSHOT_ENCODE,
      "the clipboard image is not a Bun.Image (no blob() terminal)",
    );
  }
  return candidate as ClipboardImage;
}

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** `screenies/YYYY/MM/DD/<sha12>.<ext>` — dated, content-addressed, and stable across runs. */
export function screenshotObjectKey(
  sha256: string,
  format: ScreenshotFormat,
  capturedAt: Date,
  prefix = "screenies",
): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new ScreenshotError(
      ERR_SCREENSHOT_ENCODE,
      `object key needs a hex sha256, got '${sha256}'`,
    );
  }
  const year = String(capturedAt.getUTCFullYear());
  const month = String(capturedAt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(capturedAt.getUTCDate()).padStart(2, "0");
  const trimmed = prefix.replace(/^\/+|\/+$/g, "");
  const ext = format === "jpeg" ? "jpg" : format;
  return `${trimmed}/${year}/${month}/${day}/${sha256.slice(0, 12)}.${ext}`;
}

export function publicUrlFor(publicBase: string, key: string): string {
  const base = publicBase.replace(/\/+$/, "");
  return base.length === 0 ? key : `${base}/${key}`;
}

/**
 * Encode a publish-sized screenshot.
 *
 * The pipeline matches `webpBytesFromScreenshotBlob` (`lib/f402_agent_graph_capture.ts`): resize
 * `fit: "inside"` onto a chainable image, select the encoder, then resolve the bytes once. The
 * result is re-decoded so the reported width, height and format are the artifact's, not the plan's.
 */
export async function optimizeScreenshot(
  source: Blob,
  options: ScreenshotOptimizeOptions,
  Image: ImageEncoderApi["Image"] = Bun.Image as unknown as ImageEncoderApi["Image"],
): Promise<OptimizedScreenshot> {
  if (source.size === 0) {
    throw new ScreenshotError(
      ERR_SCREENSHOT_ENCODE,
      "the source image is empty (0 bytes)",
    );
  }
  const decoded = new Image(source);
  const sourceMeta = await decoded.metadata();
  const target = targetDimensions(
    sourceMeta.width,
    sourceMeta.height,
    options.maxEdge,
  );
  const resized = decoded.resize(target.width, target.height, {
    fit: "inside",
    withoutEnlargement: true,
  });
  const encoded =
    options.format === "webp"
      ? resized.webp({ quality: options.quality })
      : options.format === "jpeg"
        ? resized.jpeg({ quality: options.quality })
        : resized.png();
  const bytes = await encoded.bytes();
  if (bytes.length === 0) {
    throw new ScreenshotError(
      ERR_SCREENSHOT_ENCODE,
      `the ${options.format} encoder returned no bytes`,
    );
  }
  const verified = await new Image(bytes).metadata();
  return {
    bytes,
    width: verified.width,
    height: verified.height,
    format: options.format,
    mime: mimeForScreenFormat(options.format),
    source: {
      width: sourceMeta.width,
      height: sourceMeta.height,
      format: sourceMeta.format,
      bytes: source.size,
    },
  };
}

export function emptyScreenshotManifest(
  generatedAt = new Date(),
): ScreenshotManifest {
  return {
    version: SCREENSHOT_MANIFEST_VERSION,
    generatedAt: generatedAt.toISOString(),
    entries: [],
  };
}

/**
 * Append an entry, newest first, and keep one row per `sha256`.
 *
 * The digest is the identity: re-capturing the same pixels must not grow the manifest, and the
 * returned `replaced` flag lets a caller say "already published" instead of implying a new object.
 */
export function appendScreenshotManifestEntry(
  manifest: ScreenshotManifest,
  entry: ScreenshotManifestEntry,
  generatedAt = new Date(),
): {
  readonly manifest: ScreenshotManifest;
  readonly replaced: boolean;
} {
  const existing = manifest.entries.find((row) => row.sha256 === entry.sha256);
  const others = manifest.entries.filter((row) => row.sha256 !== entry.sha256);
  return {
    manifest: {
      version: SCREENSHOT_MANIFEST_VERSION,
      generatedAt: generatedAt.toISOString(),
      entries: [entry, ...others],
    },
    replaced: existing !== undefined,
  };
}

/** Parse a manifest defensively: a different version reads as empty rather than half-matching. */
export function parseScreenshotManifest(
  raw: unknown,
): ScreenshotManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record["version"] !== SCREENSHOT_MANIFEST_VERSION) return null;
  const entries = record["entries"];
  if (!Array.isArray(entries)) return null;
  const parsed: ScreenshotManifestEntry[] = [];
  for (const item of entries) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    if (
      typeof row["sha256"] !== "string" ||
      typeof row["key"] !== "string" ||
      typeof row["bytes"] !== "number" ||
      typeof row["capturedAt"] !== "string"
    ) {
      continue;
    }
    parsed.push(row as unknown as ScreenshotManifestEntry);
  }
  return {
    version: SCREENSHOT_MANIFEST_VERSION,
    generatedAt:
      typeof record["generatedAt"] === "string"
        ? record["generatedAt"]
        : new Date(0).toISOString(),
    entries: parsed,
  };
}

export async function readScreenshotManifest(
  path: string,
): Promise<ScreenshotManifest> {
  const file = Bun.file(path);
  if (!(await file.exists())) return emptyScreenshotManifest();
  try {
    const parsed = parseScreenshotManifest(await file.json());
    return parsed ?? emptyScreenshotManifest();
  } catch {
    // A corrupt manifest must not block a capture; it is rewritten from the new entry.
    return emptyScreenshotManifest();
  }
}

export async function writeScreenshotManifest(
  path: string,
  manifest: ScreenshotManifest,
): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
