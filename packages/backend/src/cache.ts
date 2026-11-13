/**
 * @file packages/backend/src/cache.ts
 * @description Stat-stamped bounded caches and JSON readers for the SportsDesk dashboard backend.
 */

/** Return a compact mtime+size cache stamp for a file, or `null` if unavailable. */
export async function statStamp(filePath: string): Promise<string | null> {
  const st = await Bun.file(filePath)
    .stat()
    .catch(() => null);
  return st === null ? null : `${st.mtimeMs}:${st.size}`;
}

/** Bounded key-value cache keyed by file stamp (`mtimeMs:size`). */
export class BoundedStampCache<T> {
  private readonly store = new Map<
    string,
    { readonly stamp: string; readonly value: T }
  >();
  private readonly maxEntries: number;

  constructor(maxEntries = 24) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get size(): number {
    return this.store.size;
  }

  getIfFresh(key: string, stamp: string): T | undefined {
    const hit = this.store.get(key);
    if (hit !== undefined && hit.stamp === stamp) {
      return hit.value;
    }
    return undefined;
  }

  set(key: string, stamp: string, value: T): void {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      this.store.clear();
    }
    this.store.set(key, { stamp, value });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

export interface CachedJsonReader {
  readCachedJson: <T>(
    filePath: string,
  ) => Promise<{ stamp: string; value: T } | null>;
  clear: () => void;
}

/** Create a stat-stamped JSON file reader bounded to `maxEntries` paths. */
export function createCachedJsonReader(maxEntries = 24): CachedJsonReader {
  const cache = new BoundedStampCache<unknown>(maxEntries);
  return {
    async readCachedJson<T>(
      filePath: string,
    ): Promise<{ stamp: string; value: T } | null> {
      const stamp = await statStamp(filePath);
      if (stamp === null) {
        cache.delete(filePath);
        return null;
      }
      const hit = cache.getIfFresh(filePath, stamp);
      if (hit !== undefined) {
        return { stamp, value: hit as T };
      }
      const value = (await Bun.file(filePath).json()) as T;
      cache.set(filePath, stamp, value);
      return { stamp, value };
    },
    clear() {
      cache.clear();
    },
  };
}
