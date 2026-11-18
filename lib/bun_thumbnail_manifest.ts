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

export const THUMBNAIL_MANIFEST_VERSION = 1;
export const THUMBNAIL_MANIFEST_FILENAME = "manifest.json";

export interface ThumbnailManifestEntry {
  /** Portable source key (workspace-relative, posix separators). */
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

/** Manifest key for a source: workspace-relative when possible, else the basename. */
export function thumbnailSourceKey(source: string): string {
  const rel = relative(process.cwd(), source);
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
