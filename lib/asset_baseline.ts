/**
 * @file lib/asset_baseline.ts
 * @description Attribute baseline for raster assets, compared by `assets:diagnostics`.
 *
 * The baseline records only header-visible state — source key, format, width, height and byte size —
 * so a committed baseline stays small and a scan does not need to decode pixels. Keys come from
 * `thumbnailSourceKey()` (workspace-relative, posix separators), matching the thumbnail manifest.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { thumbnailSourceKey } from "./bun_thumbnail_manifest.ts";

/**
 * v2: keys follow `thumbnailSourceKey(source, root)` — relative to the baseline's
 * own directory, not `process.cwd()` — so a baseline written from the repo root
 * and compared from a subdirectory agree. A v1 baseline reads as `null`.
 */
export const ASSET_BASELINE_VERSION = 2;

export interface BaselineAsset {
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export interface AssetBaseline {
  readonly version: typeof ASSET_BASELINE_VERSION;
  readonly generatedAt: string;
  readonly visibility: string;
  /** Sorted by key so the artifact is stable across runs. */
  readonly assets: Readonly<Record<string, BaselineAsset>>;
}

export interface BaselineCandidate {
  readonly path: string;
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export interface BaselineDrift {
  readonly compared: number;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export function buildAssetBaseline(
  candidates: readonly BaselineCandidate[],
  visibility: string,
  root: string,
): AssetBaseline {
  const entries: Record<string, BaselineAsset> = {};
  const keys = candidates
    .map((candidate) => thumbnailSourceKey(candidate.path, root))
    .sort();
  for (const key of keys) {
    const candidate = candidates.find(
      (item) => thumbnailSourceKey(item.path, root) === key,
    );
    if (candidate === undefined) continue;
    entries[key] = Object.freeze({
      format: candidate.format,
      width: candidate.width,
      height: candidate.height,
      bytes: candidate.bytes,
    });
  }
  return Object.freeze({
    version: ASSET_BASELINE_VERSION,
    generatedAt: new Date().toISOString(),
    visibility,
    assets: Object.freeze(entries),
  });
}

/** Returns `null` for a missing, unreadable or wrong-version baseline. */
export async function readAssetBaseline(
  path: string,
): Promise<AssetBaseline | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const parsed = (await file.json()) as Partial<AssetBaseline>;
    if (
      parsed.version !== ASSET_BASELINE_VERSION ||
      typeof parsed.visibility !== "string" ||
      typeof parsed.assets !== "object" ||
      parsed.assets === null
    ) {
      return null;
    }
    return parsed as AssetBaseline;
  } catch {
    return null;
  }
}

/** Writes the baseline as pretty JSON; `bun fmt` accepts this shape unchanged. */
export async function writeAssetBaseline(
  path: string,
  baseline: AssetBaseline,
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

export function compareAssetBaseline(
  baseline: AssetBaseline,
  candidates: readonly BaselineCandidate[],
  root: string,
): BaselineDrift {
  const current = new Map<string, BaselineAsset>();
  for (const candidate of candidates) {
    current.set(thumbnailSourceKey(candidate.path, root), {
      format: candidate.format,
      width: candidate.width,
      height: candidate.height,
      bytes: candidate.bytes,
    });
  }

  const added: string[] = [];
  const changed: string[] = [];
  for (const [key, asset] of current) {
    const previous = baseline.assets[key];
    if (previous === undefined) {
      added.push(key);
      continue;
    }
    if (
      previous.format !== asset.format ||
      previous.width !== asset.width ||
      previous.height !== asset.height ||
      previous.bytes !== asset.bytes
    ) {
      changed.push(key);
    }
  }
  const removed = Object.keys(baseline.assets)
    .filter((key) => !current.has(key))
    .sort();

  return Object.freeze({
    compared: current.size,
    added: Object.freeze(added.sort()),
    removed: Object.freeze(removed),
    changed: Object.freeze(changed.sort()),
  });
}
