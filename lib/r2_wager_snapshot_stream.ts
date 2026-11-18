/**
 * @file r2_wager_snapshot_stream.ts
 * @description Stream R2 wager/columnar snapshots through Bun's S3 bindings (no env literals).
 */

import { R2S3Client } from "./r2_s3_client.ts";

/**
 * Read a snapshot object into memory via `S3File.stream()` → `readableStreamToArrayBuffer`.
 * Prefer this over buffering via string/json intermediates on large columnar blobs.
 */
export async function streamWagerSnapshot(
  client: R2S3Client,
  key: string,
): Promise<ArrayBuffer> {
  return client.readArrayBufferFromStream(key);
}

export async function streamWagerSnapshotFromEnv(
  key: string,
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): Promise<ArrayBuffer | null> {
  const client: R2S3Client | null = await R2S3Client.fromEnv(env);
  if (client === null) return null;
  return streamWagerSnapshot(client, key);
}
