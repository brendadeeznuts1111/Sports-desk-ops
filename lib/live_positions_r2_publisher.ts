/**
 * @file live_positions_r2_publisher.ts
 * @description Mirror local KPI artifacts into the `sportsdesk-ops-reports` R2 bucket at stable
 * `<prefix>/latest.json` keys so a remote daemon, Worker or dashboard can fetch the same payload
 * a loopback `:4020/` reader sees.
 *
 * The publisher is deliberately pure: it takes bytes in, writes to the client passed in, and
 * returns a structured outcome instead of throwing. R2 unreachability must never break the cron
 * tick that produced the local files.
 *
 * `x-amz-meta-*` headers carry `observed-at`, `schema-version` and `source` so a downstream reader
 * can decide freshness without parsing the JSON body. Arbitrary extra metadata (e.g. `desk-date`,
 * `row-count`) can ride along per artifact.
 */

import { resolve } from "node:path";

import type { R2S3Client } from "./r2_s3_client.ts";

/** The three keys the live-positions cron always publishes, in the order they are written. */
export const LIVE_POSITIONS_R2_KEYS = {
  liveWagers: "live-wagers/latest.json",
  liveBets: "live-bets/latest.json",
  captureHealth: "capture-health/latest.json",
} as const;

/** Source label written into every object's `x-amz-meta-source` header by default. */
export const LIVE_POSITIONS_R2_SOURCE = "scripts/live_positions_cron.ts";

/** JSON content-type used for every PUT; identical to what `Bun.write` would have set. */
export const LIVE_POSITIONS_R2_CONTENT_TYPE = "application/json; charset=utf-8";

/** One artifact to publish. Lower-level than `LivePositionsR2Payload`. */
export interface R2Artifact {
  readonly key: string;
  readonly text: string;
  readonly schemaVersion: number;
  readonly observedAtIso: string;
  /** Optional extra `x-amz-meta-*` headers; keys are lowercased by Bun's signer. */
  readonly extraMetadata?: Readonly<Record<string, string>>;
}

export interface R2ArtifactWriteOutcome {
  readonly key: string;
  readonly bytes: number;
  readonly ok: boolean;
  /** Present only when `ok === false`. Message only; never the request body. */
  readonly error?: string;
}

export interface R2PublishResult {
  readonly ok: boolean;
  readonly writes: readonly R2ArtifactWriteOutcome[];
  /** Short line safe for stdout/journal/Telegram. Names the result, not payload content. */
  readonly summary: string;
}

export interface LivePositionsR2Payload {
  /** Serialized `data/live-wagers.json` body. */
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

async function writeOne(
  client: R2S3Client,
  artifact: R2Artifact,
  source: string,
): Promise<R2ArtifactWriteOutcome> {
  const bytes = new TextEncoder().encode(artifact.text).byteLength;
  const baseMetadata: Record<string, string> = {
    "observed-at": artifact.observedAtIso,
    "schema-version": String(artifact.schemaVersion),
    source,
  };
  const metadata = { ...baseMetadata, ...artifact.extraMetadata };
  try {
    await client.writeWithMetadata(artifact.key, artifact.text, {
      type: LIVE_POSITIONS_R2_CONTENT_TYPE,
      metadata,
    });
    return { key: artifact.key, bytes, ok: true };
  } catch (error) {
    return {
      key: artifact.key,
      bytes,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Publish any list of artifacts to R2 using `R2S3Client.writeWithMetadata`. Order is preserved and
 * each PUT is isolated: one failure does not skip the others. The `source` label becomes the
 * `x-amz-meta-source` default for artifacts that do not override it in `extraMetadata`.
 */
export async function publishArtifactsToR2(
  client: R2S3Client,
  artifacts: readonly R2Artifact[],
  options: { readonly source?: string } = {},
): Promise<R2PublishResult> {
  const source = options.source ?? LIVE_POSITIONS_R2_SOURCE;
  const writes: R2ArtifactWriteOutcome[] = [];
  for (const artifact of artifacts) {
    writes.push(await writeOne(client, artifact, source));
  }
  const ok = writes.every((write) => write.ok);
  const totalBytes = writes.reduce((sum, write) => sum + write.bytes, 0);
  const failed = writes.filter((write) => !write.ok);
  const summary = ok
    ? `R2 publish: ${writes.length}/${writes.length} ok (${totalBytes} bytes to ${client.bucket})`
    : `R2 publish: ${writes.length - failed.length}/${writes.length} ok, failed=${failed
        .map((write) => write.key)
        .join(",")}`;
  return { ok, writes, summary };
}

/**
 * Convenience wrapper for the three live-positions artifacts that every 10-minute cron tick
 * produces. Behaviour is identical to calling `publishArtifactsToR2` with the three keys in the
 * stable `live-wagers` → `live-bets` → `capture-health` order.
 */
export async function publishLivePositionsToR2(
  client: R2S3Client,
  payload: LivePositionsR2Payload,
): Promise<R2PublishResult> {
  return publishArtifactsToR2(client, [
    {
      key: LIVE_POSITIONS_R2_KEYS.liveWagers,
      text: payload.liveWagersText,
      schemaVersion: payload.schemaVersions.liveWagers,
      observedAtIso: payload.observedAtIso,
    },
    {
      key: LIVE_POSITIONS_R2_KEYS.liveBets,
      text: payload.liveBetsText,
      schemaVersion: payload.schemaVersions.liveBets,
      observedAtIso: payload.observedAtIso,
    },
    {
      key: LIVE_POSITIONS_R2_KEYS.captureHealth,
      text: payload.captureHealthText,
      schemaVersion: payload.schemaVersions.captureHealth,
      observedAtIso: payload.observedAtIso,
    },
  ]);
}

export interface LocalArtifactSpec {
  readonly key: string;
  /** Path relative to the repo root. */
  readonly relativePath: string;
  readonly schemaVersion: number;
  /** Optional callback to extract a timestamp from the parsed body; otherwise file mtime is used. */
  readonly observedAtFromBody?: (body: unknown) => string | null;
  readonly extraMetadata?: Readonly<Record<string, string>>;
}

export interface LocalArtifactLoadResult {
  readonly artifacts: readonly R2Artifact[];
  readonly skipped: readonly {
    readonly relativePath: string;
    readonly reason: string;
  }[];
}

/**
 * Turn `[{relativePath, key, schemaVersion, observedAtFromBody?}]` specs into artifacts that
 * `publishArtifactsToR2` accepts. Missing files are recorded in `skipped` (never thrown), so a
 * machine without the optional artifact publishes the ones it does have.
 */
export async function collectLocalArtifacts(
  repoRoot: string,
  specs: readonly LocalArtifactSpec[],
): Promise<LocalArtifactLoadResult> {
  const artifacts: R2Artifact[] = [];
  const skipped: { relativePath: string; reason: string }[] = [];
  for (const spec of specs) {
    const abs = resolve(repoRoot, spec.relativePath);
    const file = Bun.file(abs);
    if (!(await file.exists())) {
      skipped.push({ relativePath: spec.relativePath, reason: "missing" });
      continue;
    }
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      skipped.push({
        relativePath: spec.relativePath,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    let observedAtIso = new Date(file.lastModified).toISOString();
    if (spec.observedAtFromBody !== undefined) {
      try {
        const parsed: unknown = JSON.parse(text);
        const fromBody = spec.observedAtFromBody(parsed);
        if (typeof fromBody === "string" && fromBody !== "") {
          observedAtIso = fromBody;
        }
      } catch {
        // Fall back to mtime; this is intentional and not an error.
      }
    }
    artifacts.push({
      key: spec.key,
      text,
      schemaVersion: spec.schemaVersion,
      observedAtIso,
      ...(spec.extraMetadata === undefined
        ? {}
        : { extraMetadata: spec.extraMetadata }),
    });
  }
  return { artifacts, skipped };
}
