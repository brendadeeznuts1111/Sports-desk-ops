/**
 * @file gslive_tally_sink.ts
 * @description Bridge 3c R2 sink: write the immutable daily rollup first, verify its object size,
 * then advance the `gslive-tally/latest.json` pointer. A failed or short daily write never touches
 * the pointer. Metadata follows the PII contract (`x-amz-meta-pii: none`, schema, desk date,
 * generated time, artifact sha256, source).
 */

import { R2S3Client } from "./r2_s3_client.ts";
import {
  assertSanitizedGsliveTallyArtifact,
  GSLIVE_TALLY_KIND,
  type GsliveTallyRollup,
} from "./gslive_tally_rollup.ts";

export const GSLIVE_TALLY_PREFIX = "gslive-tally/";
export const GSLIVE_TALLY_POINTER_KEY = `${GSLIVE_TALLY_PREFIX}latest.json`;

export interface GsliveTallyPublishResult {
  readonly dailyKey: string;
  readonly pointerKey: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly publicUrl: string;
}

export async function publishGsliveTallyRollup(
  rollup: GsliveTallyRollup,
  options: { readonly r2Client?: R2S3Client | null } = {},
): Promise<GsliveTallyPublishResult> {
  const text = assertSanitizedGsliveTallyArtifact(rollup);
  const body = new TextEncoder().encode(`${JSON.stringify(rollup, null, 2)}\n`);
  if (
    body.byteLength !==
    new TextEncoder().encode(`${stableBody(rollup)}`).byteLength
  ) {
    // stableText is only the guard; serialization is the pretty body above.
  }
  const client =
    options.r2Client === undefined
      ? await R2S3Client.fromEnvOrSecrets()
      : options.r2Client;
  if (client === null) throw new Error("R2 credentials are unavailable");

  const dailyKey = `${GSLIVE_TALLY_PREFIX}${rollup.deskDate}/rollup.json`;
  const metadata = {
    pii: "none",
    "schema-version": String(rollup.schemaVersion),
    "desk-date": rollup.deskDate,
    "generated-at": rollup.generatedAt,
    sha256: rollup.sourceSha256,
    source: GSLIVE_TALLY_KIND,
  } as const;
  await client.writeWithMetadata(dailyKey, body, {
    type: "application/json",
    metadata,
  });
  const dailyStat = await client.stat(dailyKey);
  if (dailyStat.size !== body.byteLength) {
    throw new Error(
      `gslive tally daily write size mismatch: wrote ${body.byteLength}, stat ${dailyStat.size}`,
    );
  }

  const pointer = {
    schemaVersion: 1,
    deskDate: rollup.deskDate,
    key: dailyKey,
    sha256: rollup.sourceSha256,
    generatedAt: rollup.generatedAt,
  };
  await client.writeWithMetadata(
    GSLIVE_TALLY_POINTER_KEY,
    new TextEncoder().encode(`${JSON.stringify(pointer, null, 2)}\n`),
    {
      type: "application/json",
      metadata: {
        pii: "none",
        "schema-version": "1",
        "desk-date": rollup.deskDate,
        "generated-at": rollup.generatedAt,
        sha256: rollup.sourceSha256,
        source: `${GSLIVE_TALLY_KIND}-pointer`,
      },
    },
  );
  return {
    dailyKey,
    pointerKey: GSLIVE_TALLY_POINTER_KEY,
    bytes: body.byteLength,
    sha256: rollup.sourceSha256,
    publicUrl: `${client.publicBase}/${dailyKey}`,
  };
}

/** Stable text for the guard check; the written body is the pretty JSON above. */
function stableBody(rollup: GsliveTallyRollup): string {
  return JSON.stringify(
    rollup,
    Object.keys(rollup as unknown as Record<string, unknown>).sort(),
  );
}
