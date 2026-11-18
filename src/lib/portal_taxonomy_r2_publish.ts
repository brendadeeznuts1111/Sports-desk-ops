/**
 * @file src/lib/portal_taxonomy_r2_publish.ts
 * @description The one R2 publisher for the portal-taxonomy manifest
 * (`manifests/portal-taxonomy/latest`), which `xml:ingest` reads to map a feed's `subSport`
 * string onto the 6-bit dense code.
 *
 * There is no in-repo source for the code assignment: `SUBSPORT_TAXONOMY_CATALOG` orders NFL,
 * NCAAF, NBA, NCAAB, WNBA, NHL, but the desk's table uses NFL, CFB, NBA, NCAAB, NHL, MLB — the
 * codes come from the portal, so the table is an input, not something derived here. This module
 * validates it and performs the same content-addressed + CAS write as the XML snapshot.
 *
 * The unit test drives it through a fake client; the CLI (`bun run xml:taxonomy`) is the shipped
 * path, so the tested code is the code that runs.
 */
import {
  R2PreconditionFailedError,
  type R2S3Client,
} from "../../lib/r2_s3_client.ts";
import type { PortalTaxonomyEntry } from "./portal_taxonomy_normalizer.ts";

export const PORTAL_TAXONOMY_MANIFEST_KEY = "manifests/portal-taxonomy/latest";
export const PORTAL_TAXONOMY_GENERATION_PREFIX = "generations/portal-taxonomy";

/** Highest dense code a 6-bit sub-sport field can carry. */
export const PORTAL_TAXONOMY_MAX_CODE = 0x3f;

export interface PortalTaxonomyR2ManifestPut {
  readonly method: "PUT";
  readonly headers: {
    readonly "Content-Type": string;
    readonly "If-Match"?: string;
    readonly "If-None-Match"?: string;
  };
  readonly body: string;
}

/** The publisher's write/fetch surface; `createPortalTaxonomyR2Client` adapts `R2S3Client`. */
export interface PortalTaxonomyPublisherClient {
  write(
    key: string,
    data: string | Uint8Array,
    opts?: { type?: string },
  ): Promise<unknown>;
  fetch(key: string, init: PortalTaxonomyR2ManifestPut): Promise<Response>;
}

export interface PortalTaxonomyPublishResult {
  readonly merkleRootSha256: string;
  readonly r2PublishedAtEpochMs: number;
  readonly generationKey: string;
  readonly entryCount: number;
}

export interface PortalTaxonomyPublishInput {
  readonly client: PortalTaxonomyPublisherClient;
  readonly entries: readonly PortalTaxonomyEntry[];
  /** `""` on the first publish, which uses `If-None-Match: *` (generation 1). */
  readonly prevManifestETag: string;
  readonly nextGenerationU32: number;
  /** Compute and validate without writing (ignores the CAS entirely). */
  readonly dryRun?: boolean | undefined;
}

/** Adapt the signed-request S3 client; a 412 surfaces as a `Response(412)` for the CAS branch. */
export function createPortalTaxonomyR2Client(
  s3: R2S3Client,
): PortalTaxonomyPublisherClient {
  return {
    write: (key, data, opts) => s3.write(key, data, opts),
    async fetch(key, init) {
      const ifMatch = init.headers["If-Match"];
      const ifNoneMatch = init.headers["If-None-Match"];
      try {
        await s3.writeWithMetadata(key, init.body, {
          type: init.headers["Content-Type"],
          ...(ifMatch === undefined ? {} : { ifMatch }),
          ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
        });
        return new Response(null, { status: 200 });
      } catch (error) {
        if (error instanceof R2PreconditionFailedError) {
          return new Response(null, { status: 412 });
        }
        throw error;
      }
    },
  };
}

/**
 * Reject a table the 6-bit field or the lookup table cannot represent.
 *
 * Codes are unique and inside `1..63` (`0` is `SUBSPORT_UNKNOWN_CODE6`), and each entry needs a
 * non-empty `sport` and `subSport` so the lookup can normalize a key from them.
 * @throws ERR_PORTAL_TAXONOMY_INVALID with the first offending entry.
 */
export function assertPortalTaxonomyEntries(
  entries: readonly PortalTaxonomyEntry[],
): void {
  if (entries.length === 0) {
    throw new Error("ERR_PORTAL_TAXONOMY_INVALID: the table is empty");
  }
  const codes = new Set<number>();
  const pairs = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const where = `entry ${index}`;
    if (entry.sport.trim() === "" || entry.subSport.trim() === "") {
      throw new Error(
        `ERR_PORTAL_TAXONOMY_INVALID: ${where} needs a non-empty sport and subSport`,
      );
    }
    if (
      !Number.isInteger(entry.denseCode6) ||
      entry.denseCode6 < 1 ||
      entry.denseCode6 > PORTAL_TAXONOMY_MAX_CODE
    ) {
      throw new Error(
        `ERR_PORTAL_TAXONOMY_INVALID: ${where} denseCode6 ${entry.denseCode6} is outside 1..${PORTAL_TAXONOMY_MAX_CODE}`,
      );
    }
    if (codes.has(entry.denseCode6)) {
      throw new Error(
        `ERR_PORTAL_TAXONOMY_INVALID: ${where} reuses denseCode6 ${entry.denseCode6}`,
      );
    }
    codes.add(entry.denseCode6);
    const pair = `${entry.sport.trim().toUpperCase()}|${entry.subSport.trim().toUpperCase()}`;
    if (pairs.has(pair)) {
      throw new Error(`ERR_PORTAL_TAXONOMY_INVALID: ${where} repeats ${pair}`);
    }
    pairs.add(pair);
  }
}

/**
 * Publish the portal-taxonomy manifest with the same shape the reader parses
 * (`generation_u32`, `merkle_root_sha256`, `r2_published_at_epoch_ms`, `entries`) and the same
 * no-rebase CAS contract as the XML snapshot: `If-None-Match: *` for generation 1, `If-Match` after.
 */
export async function publishPortalTaxonomyToR2(
  input: PortalTaxonomyPublishInput,
): Promise<PortalTaxonomyPublishResult> {
  assertPortalTaxonomyEntries(input.entries);

  const body = JSON.stringify({
    generation_u32: input.nextGenerationU32,
    entries: input.entries,
  });
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(body);
  const merkleRootSha256 = hasher.digest("hex");
  const r2PublishedAtEpochMs = input.dryRun === true ? 0 : Date.now();
  const generationKey = `${PORTAL_TAXONOMY_GENERATION_PREFIX}/gen-${input.nextGenerationU32}-${merkleRootSha256.slice(0, 16)}`;

  const manifestBody = JSON.stringify({
    generation_u32: input.nextGenerationU32,
    merkle_root_sha256: merkleRootSha256,
    r2_published_at_epoch_ms: r2PublishedAtEpochMs,
    entries: input.entries,
  });

  const result: PortalTaxonomyPublishResult = {
    merkleRootSha256,
    r2PublishedAtEpochMs,
    generationKey,
    entryCount: input.entries.length,
  };
  if (input.dryRun === true) return result;

  await input.client.write(generationKey, manifestBody, {
    type: "application/json",
  });

  const firstPublish = input.prevManifestETag.trim() === "";
  let casResponse: Response;
  try {
    casResponse = await input.client.fetch(PORTAL_TAXONOMY_MANIFEST_KEY, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(firstPublish
          ? { "If-None-Match": "*" }
          : { "If-Match": input.prevManifestETag }),
      },
      body: manifestBody,
    });
  } catch (error) {
    throw new Error(
      `ERR_R2_SINK_BACKPRESSURE: PUT ${PORTAL_TAXONOMY_MANIFEST_KEY} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  if (casResponse.status === 412) {
    throw new Error("ERR_R2_MANIFEST_CAS_REJECTED");
  }
  if (!casResponse.ok) {
    throw new Error(`ERR_R2_SINK_BACKPRESSURE: HTTP ${casResponse.status}`);
  }
  return result;
}
