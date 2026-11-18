/**
 * @file lib/bun_thumbnail_manifest.ts
 * @description Derived-artifact manifest for generated WebP thumbnails.
 *
 * `<thumbsDir>/manifest.json` records the encoder settings plus one entry per thumbnail: source
 * size and mtime, output dimensions and bytes, and a hash of the written artifact. `--thumbs-check`
 * compares against this manifest, so a changed `--thumbs` edge, a stale source or a corrupted
 * thumbnail is detected even when mtimes alone would look fresh.
 */

import { mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/**
 * v2: keys are relative to the artifact directory instead of `process.cwd()`.
 * A v1 manifest reads as `null`, so a stale-key file is regenerated rather than
 * silently half-matching.
 */
export const THUMBNAIL_MANIFEST_VERSION = 2;
export const THUMBNAIL_MANIFEST_FILENAME = "manifest.json";

export interface ThumbnailManifestEntry {
  /** Portable source key: relative to the artifact directory, posix separators. */
  readonly source: string;
  /** Thumbnail path relative to the manifest directory. */
  readonly thumb: string;
  readonly sourceBytes: number;
  readonly sourceMtimeMs: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** `Bun.hash` of the written WebP bytes, hex. */
  readonly hash: string;
}

export interface ThumbnailManifest {
  readonly version: typeof THUMBNAIL_MANIFEST_VERSION;
  readonly generatedAt: string;
  readonly maxEdge: number;
  readonly quality: number;
  readonly backend: string;
  readonly entries: Readonly<Record<string, ThumbnailManifestEntry>>;
}

function posixPath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * Manifest key for a source: relative to the artifact that stores it, posix
 * separators, basename as a last resort.
 *
 * The root is a required parameter rather than `process.cwd()` on purpose. A cwd
 * default made the same asset map to different entries depending on where the CLI
 * ran (`dist/assets/logo.png`, `assets/logo.png`, `logo.png`), so a check from
 * another directory reported every thumbnail missing and a run from a
 * subdirectory added duplicates. Pass the directory the manifest (or baseline)
 * lives in — or its parent — and the key is stable from anywhere.
 */
export function thumbnailSourceKey(source: string, root: string): string {
  const rel = relative(root, source);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return posixPath(basename(source));
  }
  return posixPath(rel);
}

/** Thumbnail path recorded in the manifest, relative to the manifest directory. */
export function thumbnailArtifactKey(
  thumbsDir: string,
  destination: string,
): string {
  const rel = relative(thumbsDir, destination);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return posixPath(basename(destination));
  }
  return posixPath(rel);
}

export function thumbnailManifestPath(thumbsDir: string): string {
  return join(thumbsDir, THUMBNAIL_MANIFEST_FILENAME);
}

export async function hashFile(path: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return Bun.hash(bytes).toString(16);
}

/** Returns `null` for a missing, unreadable or wrong-version manifest. */
export async function readThumbnailManifest(
  thumbsDir: string,
): Promise<ThumbnailManifest | null> {
  const file = Bun.file(thumbnailManifestPath(thumbsDir));
  if (!(await file.exists())) return null;
  try {
    const parsed = (await file.json()) as Partial<ThumbnailManifest>;
    if (
      parsed.version !== THUMBNAIL_MANIFEST_VERSION ||
      typeof parsed.maxEdge !== "number" ||
      typeof parsed.quality !== "number" ||
      typeof parsed.backend !== "string" ||
      typeof parsed.entries !== "object" ||
      parsed.entries === null
    ) {
      return null;
    }
    return parsed as ThumbnailManifest;
  } catch {
    return null;
  }
}

export async function writeThumbnailManifest(
  thumbsDir: string,
  manifest: ThumbnailManifest,
): Promise<void> {
  mkdirSync(dirname(thumbnailManifestPath(thumbsDir)), { recursive: true });
  await Bun.write(
    thumbnailManifestPath(thumbsDir),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
