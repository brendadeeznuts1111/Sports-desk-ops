/**
 * @file live_positions_r2_publisher.ts
 * @description Mirror the three local KPI artifacts the 10-minute `live_positions_cron` writes
 * (`data/live-wagers.json`, `data/live-bets.json`, `data/capture-health.json`) into the
 * `sportsdesk-ops-reports` R2 bucket at stable `<prefix>/latest.json` keys so a remote daemon,
 * Worker or dashboard can fetch the same payload a loopback `:4020/` reader sees.
 *
 * The publisher is deliberately pure: it takes bytes in, writes to the client passed in, and
 * returns a structured outcome instead of throwing. R2 unreachability must never break the cron
 * tick that produced the local files.
 *
 * `x-amz-meta-*` headers carry `observed-at`, `schema-version` and `source` so a downstream reader
 * can decide freshness without having to parse the JSON body.
 */

import type { R2S3Client } from "./r2_s3_client.ts";

/** The three keys the cron publishes, in the order they are written. */
export const LIVE_POSITIONS_R2_KEYS = {
  liveWagers: "live-wagers/latest.json",
  liveBets: "live-bets/latest.json",
  captureHealth: "capture-health/latest.json",
} as const;

/** Source label written into every object's `x-amz-meta-source` header. */
export const LIVE_POSITIONS_R2_SOURCE = "scripts/live_positions_cron.ts";

/** JSON content-type used for every PUT; identical to what `Bun.write` would have set. */
export const LIVE_POSITIONS_R2_CONTENT_TYPE = "application/json; charset=utf-8";

export interface LivePositionsR2Payload {
  /** Serialized `data/live-wagers.json` body (already trailing-newline terminated or not). */
  readonly liveWagersText: string;
  /** Serialized `data/live-bets.json` body. */
  readonly liveBetsText: string;
  /** Serialized `data/capture-health.json` body. */
  readonly captureHealthText: string;
  /** The timestamp the cron recorded as `nowIso`; rendered as each object's observed-at header. */
  readonly observedAtIso: string;
  /** Per-artifact schema versions; recorded in the schema-version header. */
  readonly schemaVersions: {
    readonly liveWagers: number;
    readonly liveBets: number;
    readonly captureHealth: number;
  };
}

export interface LivePositionsR2WriteOutcome {
  readonly key: string;
  readonly bytes: number;
  readonly ok: boolean;
  /** Present only when `ok === false`. Message only; never the request body. */
  readonly error?: string;
}

export interface LivePositionsR2PublishResult {
  readonly ok: boolean;
  readonly writes: readonly LivePositionsR2WriteOutcome[];
  /** Short line safe for stdout/journal/Telegram. Names the result, not the payload content. */
  readonly summary: string;
}

interface SingleWriteInput {
  readonly key: string;
  readonly text: string;
  readonly schemaVersion: number;
  readonly observedAtIso: string;
}

async function writeOne(
  client: R2S3Client,
  input: SingleWriteInput,
): Promise<LivePositionsR2WriteOutcome> {
  const bytes = new TextEncoder().encode(input.text).byteLength;
  try {
    await client.writeWithMetadata(input.key, input.text, {
      type: LIVE_POSITIONS_R2_CONTENT_TYPE,
      metadata: {
        "observed-at": input.observedAtIso,
        "schema-version": String(input.schemaVersion),
        source: LIVE_POSITIONS_R2_SOURCE,
      },
    });
    return { key: input.key, bytes, ok: true };
  } catch (error) {
    return {
      key: input.key,
      bytes,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Publish the three local KPI artifacts to R2 using `R2S3Client.writeWithMetadata` so the signed
 * `x-amz-meta-*` headers Bun's writer cannot sign are carried correctly. Order is stable
 * (`live-wagers`, `live-bets`, `capture-health`) so a reader that tracks last-written keys sees a
 * deterministic sequence. Every PUT is isolated: one failure does not skip the others.
 */
export async function publishLivePositionsToR2(
  client: R2S3Client,
  payload: LivePositionsR2Payload,
): Promise<LivePositionsR2PublishResult> {
  const writes: LivePositionsR2WriteOutcome[] = [];

  writes.push(
    await writeOne(client, {
      key: LIVE_POSITIONS_R2_KEYS.liveWagers,
      text: payload.liveWagersText,
      schemaVersion: payload.schemaVersions.liveWagers,
      observedAtIso: payload.observedAtIso,
    }),
  );
  writes.push(
    await writeOne(client, {
      key: LIVE_POSITIONS_R2_KEYS.liveBets,
      text: payload.liveBetsText,
      schemaVersion: payload.schemaVersions.liveBets,
      observedAtIso: payload.observedAtIso,
    }),
  );
  writes.push(
    await writeOne(client, {
      key: LIVE_POSITIONS_R2_KEYS.captureHealth,
      text: payload.captureHealthText,
      schemaVersion: payload.schemaVersions.captureHealth,
      observedAtIso: payload.observedAtIso,
    }),
  );

  const ok = writes.every((write) => write.ok);
  const totalBytes = writes.reduce((sum, write) => sum + write.bytes, 0);
  const failed = writes.filter((write) => !write.ok);
  const summary = ok
    ? `R2 publish: 3/3 ok (${totalBytes} bytes to ${client.bucket})`
    : `R2 publish: ${writes.length - failed.length}/${writes.length} ok, failed=${failed
        .map((write) => write.key)
        .join(",")}`;

  return { ok, writes, summary };
}
