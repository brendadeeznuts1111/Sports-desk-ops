/**
 * File-backed artifacts, read once per version instead of once per request.
 *
 * `/api/agent-tree` re-read and re-parsed a 94 KB JSON file on every request (measured 0.85 ms,
 * versus 0.10 ms for a route that returns a constant), `/api/contests` a 110 KB one, and the graph
 * feed a 217 KB one. The files change only when a capture rewrites them, so the version key is the
 * file's mtime and size: a rewrite invalidates the cache immediately, with no TTL to guess and no
 * window where a stale artifact is served.
 *
 * A missing file is not cached — it is the "not captured yet" state, and creating the file must be
 * visible on the next request.
 */

export interface ArtifactVersion<T> {
  /** `mtimeMs:size`, the cache key; also the body-cache version for lib/http_compression. */
  readonly version: string;
  readonly value: T;
}

const parsed = new Map<string, ArtifactVersion<unknown>>();
const bytes = new Map<string, ArtifactVersion<Uint8Array<ArrayBuffer>>>();
/** Must exceed the daemon's artifact count, or every full-cache insert clears the rest. */
const MAX_CACHED_FILES = 16;

async function versionOf(path: string): Promise<string | null> {
  const stat = await Bun.file(path)
    .stat()
    .catch(() => null);
  if (stat === null) return null;
  return `${stat.mtimeMs}:${stat.size}`;
}

function remember<T>(
  cache: Map<string, ArtifactVersion<unknown>>,
  path: string,
  version: string,
  value: T,
): ArtifactVersion<T> {
  if (cache.size >= MAX_CACHED_FILES) cache.clear();
  const entry: ArtifactVersion<T> = { version, value };
  cache.set(path, entry as ArtifactVersion<unknown>);
  return entry;
}

/**
 * A JSON file whose parsed contents are reused until its mtime or size changes.
 *
 * `parse` runs inside the cache miss, so a shape error surfaces on the request that notices the
 * new file rather than at startup — the same behaviour as reading the file directly.
 */
export function cachedJsonFile<T>(
  path: string,
  parse: (raw: unknown) => T,
): { read(): Promise<ArtifactVersion<T> | null> } {
  return {
    async read(): Promise<ArtifactVersion<T> | null> {
      const version = await versionOf(path);
      if (version === null) {
        parsed.delete(path);
        return null;
      }
      const hit = parsed.get(path);
      if (hit !== undefined && hit.version === version) {
        return hit as ArtifactVersion<T>;
      }
      const value = parse(await Bun.file(path).json());
      return remember(parsed, path, version, value);
    },
  };
}

/** Raw bytes of a file plus their version, or `null` when it is absent. */
export async function readFileBytes(
  path: string,
): Promise<ArtifactVersion<Uint8Array<ArrayBuffer>> | null> {
  const version = await versionOf(path);
  if (version === null) {
    bytes.delete(path);
    return null;
  }
  const hit = bytes.get(path);
  if (hit !== undefined && hit.version === version) return hit;
  const value = new Uint8Array<ArrayBuffer>(await Bun.file(path).arrayBuffer());
  return remember(bytes, path, version, value);
}

/** Drop every cached artifact; tests use it to prove invalidation is real. */
export function resetArtifactCache(): void {
  parsed.clear();
  bytes.clear();
}
