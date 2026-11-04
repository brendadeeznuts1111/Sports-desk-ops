/**
 * @file gslive_weblog_sink.ts
 * @description R2 sink for the GSLive activity weblog rollup. Mirrors `lib/gslive_tally_sink.ts`:
 * write the immutable daily under `gslive-weblogs/<deskDate>/activity.json`, verify the stored
 * object's size matches the body length, and only then advance the `gslive-weblogs/latest.json`
 * pointer. A failed or short daily write never touches the pointer.
 *
 * Every write carries the standard PII contract via `x-amz-meta-*` headers: `pii: none` on all
 * payloads, with `schema-version`, `desk-date`, `generated-at`, `sha256` and a `source` label that
 * distinguishes the two writes (`gslive-weblogs` for the daily, `gslive-weblogs-pointer` for the
 * pointer) so a reader scanning HEAD responses can tell immutable data writes from pointer bumps.
 *
 * The sanitization guard rejects known identifier-shaped keys before any R2 call; callers must
 * pre-aggregate / strip PII in the rollup body before handing it in. A failed guard throws before
 * a single byte touches R2.
 */

import { R2S3Client } from "./r2_s3_client.ts";

export const GSLIVE_WEBLOGS_PREFIX = "gslive-weblogs/";
export const GSLIVE_WEBLOGS_POINTER_KEY = `${GSLIVE_WEBLOGS_PREFIX}latest.json`;
export const GSLIVE_WEBLOGS_KIND = "gslive-weblogs";
export const GSLIVE_WEBLOGS_POINTER_SOURCE = `${GSLIVE_WEBLOGS_KIND}-pointer`;
export const GSLIVE_WEBLOGS_SCHEMA_VERSION = 1;
export const GSLIVE_WEBLOGS_POINTER_SCHEMA_VERSION = 1;
/** Soft ceiling: a daily rollup should fit well under 1 MiB. Trips a guard, never silent truncation. */
export const GSLIVE_WEBLOGS_MAX_ARTIFACT_BYTES = 1024 * 1024;

export interface GsliveWeblogRollup {
  readonly schemaVersion: typeof GSLIVE_WEBLOGS_SCHEMA_VERSION;
  readonly deskDate: string;
  readonly generatedAtIso: string;
  readonly sourceSha256: string;
  readonly rowCount: number;
  /** Aggregates only; the sink's sanitization guard rejects known identifier-shaped keys. */
  readonly body: unknown;
}

export interface GsliveWeblogsPointer {
  readonly schemaVersion: typeof GSLIVE_WEBLOGS_POINTER_SCHEMA_VERSION;
  readonly deskDate: string;
  readonly key: string;
  readonly sha256: string;
  readonly generatedAtIso: string;
  readonly rowCount: number;
}

export interface GsliveWeblogPublishResult {
  readonly dailyKey: string;
  readonly pointerKey: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly publicUrl: string;
}

const FORBIDDEN_KEYS =
  /^(betGroupId|ticketNumber|wagerNumber|login|agent|ipAddress|userID|partnerUserID|playerId)$/;

function isSafeDeskDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Walk the body recursively and throw if any key matches the forbidden identifier set. Called
 * before encoding so a violation aborts before R2 sees a single byte.
 */
export function assertSanitizedGsliveWeblog(rollup: GsliveWeblogRollup): void {
  if (!isSafeDeskDate(rollup.deskDate)) {
    throw new Error(
      `gslive weblogs: deskDate must be YYYY-MM-DD (got "${rollup.deskDate}")`,
    );
  }
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (FORBIDDEN_KEYS.test(key)) {
        throw new Error(`gslive weblogs: body carries forbidden key "${key}"`);
      }
      walk(child);
    }
  };
  walk(rollup.body);
}

/**
 * Publish the daily rollup then advance the pointer. The daily write is size-verified against the
 * returned stat before the pointer is touched; a short or missing daily aborts with no pointer
 * update. Throws if R2 credentials are unavailable — callers choosing a silent no-op should check
 * `R2S3Client.fromEnvOrSecrets()` themselves.
 */
export async function publishGsliveWeblog(
  rollup: GsliveWeblogRollup,
  options: { readonly r2Client?: R2S3Client | null } = {},
): Promise<GsliveWeblogPublishResult> {
  assertSanitizedGsliveWeblog(rollup);

  const body = new TextEncoder().encode(`${JSON.stringify(rollup, null, 2)}\n`);
  if (body.byteLength > GSLIVE_WEBLOGS_MAX_ARTIFACT_BYTES) {
    throw new Error(
      `gslive weblogs: rollup exceeds ${GSLIVE_WEBLOGS_MAX_ARTIFACT_BYTES} bytes (${body.byteLength})`,
    );
  }

  const client =
    options.r2Client === undefined
      ? await R2S3Client.fromEnvOrSecrets()
      : options.r2Client;
  if (client === null) throw new Error("R2 credentials are unavailable");

  const dailyKey = `${GSLIVE_WEBLOGS_PREFIX}${rollup.deskDate}/activity.json`;
  await client.writeWithMetadata(dailyKey, body, {
    type: "application/json",
    metadata: {
      pii: "none",
      "schema-version": String(rollup.schemaVersion),
      "desk-date": rollup.deskDate,
      "generated-at": rollup.generatedAtIso,
      "row-count": String(rollup.rowCount),
      sha256: rollup.sourceSha256,
      source: GSLIVE_WEBLOGS_KIND,
    },
  });
  const dailyStat = await client.stat(dailyKey);
  if (dailyStat.size !== body.byteLength) {
    throw new Error(
      `gslive weblogs daily write size mismatch: wrote ${body.byteLength}, stat ${dailyStat.size}`,
    );
  }

  const pointer: GsliveWeblogsPointer = {
    schemaVersion: GSLIVE_WEBLOGS_POINTER_SCHEMA_VERSION,
    deskDate: rollup.deskDate,
    key: dailyKey,
    sha256: rollup.sourceSha256,
    generatedAtIso: rollup.generatedAtIso,
    rowCount: rollup.rowCount,
  };
  await client.writeWithMetadata(
    GSLIVE_WEBLOGS_POINTER_KEY,
    new TextEncoder().encode(`${JSON.stringify(pointer, null, 2)}\n`),
    {
      type: "application/json",
      metadata: {
        pii: "none",
        "schema-version": String(GSLIVE_WEBLOGS_POINTER_SCHEMA_VERSION),
        "desk-date": rollup.deskDate,
        "generated-at": rollup.generatedAtIso,
        "points-to": dailyKey,
        sha256: rollup.sourceSha256,
        source: GSLIVE_WEBLOGS_POINTER_SOURCE,
      },
    },
  );

  return {
    dailyKey,
    pointerKey: GSLIVE_WEBLOGS_POINTER_KEY,
    bytes: body.byteLength,
    sha256: rollup.sourceSha256,
    publicUrl: `${client.publicBase}/${dailyKey}`,
  };
}
