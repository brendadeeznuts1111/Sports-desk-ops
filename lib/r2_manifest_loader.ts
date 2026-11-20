/**
 * @file r2_manifest_loader.ts
 * @description Read-only R2 transport the sealed client can delegate to.
 * Tests inject an implementation so preflight never opens a socket.
 * A full digest-and-YAML load is a separate contract from this transport.
 */

export interface R2ManifestStat {
  readonly size: number;
}

/** Bounded object read. `get` must not return more than `maxBytes`. */
export interface R2ManifestClient {
  stat(key: string): Promise<R2ManifestStat | null>;
  get(key: string, maxBytes: number): Promise<Uint8Array>;
}
