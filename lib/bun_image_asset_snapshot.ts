/**
 * @file lib/bun_image_asset_snapshot.ts
 * @description TTL-cached, ETag-addressable snapshot of a raster asset directory.
 *
 * The dashboard rescans on tab focus, so a short TTL keeps repeated opens to one directory read;
 * the ETag is hashed from the canonical body (excluding the `cached` flag) so a revalidating client
 * can take a 304 while `cached` still reports whether this call hit the TTL cache.
 */

import {
  scanBunImageAssetDirectory,
  type BunImageAssetScanEntry,
} from "./bun_image_assets.ts";
import type { InspectVisibility } from "./inspect_redactor.ts";

export interface BunImageAssetSnapshot {
  readonly ok: true;
  readonly generatedAt: string;
  readonly root: string;
  readonly visibility: InspectVisibility;
  readonly limit: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly count: number;
  readonly cached: boolean;
  readonly assets: readonly BunImageAssetScanEntry[];
  readonly etag: string;
}

export interface BunImageAssetSnapshotOptions {
  /** Entries returned, clamped to `1..100`. Default 24. */
  readonly limit?: number;
  readonly visibility?: InspectVisibility;
  readonly maxBytes?: number;
  readonly maxPixels?: number;
  /** Reuse window for one scan. Default 5000 ms; `0` rescans on every call. */
  readonly ttlMs?: number;
  /** Display root, never an absolute host path. Default `docs/assets`. */
  readonly displayRoot?: string;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

export interface BunImageAssetSnapshotSource {
  snapshot(): Promise<BunImageAssetSnapshot>;
}

type SnapshotBody = Omit<BunImageAssetSnapshot, "cached" | "etag">;

function etagFor(body: SnapshotBody): string {
  return `"img-${Bun.hash(JSON.stringify(body)).toString(16)}"`;
}

export function createBunImageAssetSnapshotSource(
  dir: string,
  options: BunImageAssetSnapshotOptions = {},
): BunImageAssetSnapshotSource {
  const ttlMs = options.ttlMs ?? 5_000;
  const now = options.now ?? (() => Date.now());
  const displayRoot = options.displayRoot ?? "docs/assets";
  const visibility = options.visibility ?? "RISK_MANAGER";
  const limit = Math.max(1, Math.min(options.limit ?? 24, 100));
  let cached: BunImageAssetSnapshot | null = null;
  let cachedAt = Number.NEGATIVE_INFINITY;

  return {
    async snapshot(): Promise<BunImageAssetSnapshot> {
      const at = now();
      if (cached !== null && at - cachedAt < ttlMs) {
        return Object.freeze({ ...cached, cached: true });
      }
      const scan = await scanBunImageAssetDirectory(dir, {
        limit,
        visibility,
        maxBytes: options.maxBytes,
        maxPixels: options.maxPixels,
      });
      const body: SnapshotBody = {
        ok: true,
        generatedAt: new Date(at).toISOString(),
        root: displayRoot,
        visibility,
        limit,
        total: scan.total,
        truncated: scan.truncated,
        count: scan.entries.length,
        assets: scan.entries,
      };
      cached = Object.freeze({
        ...body,
        cached: false,
        etag: etagFor(body),
      });
      cachedAt = at;
      return cached;
    },
  };
}
