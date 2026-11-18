/**
 * @file src/lib/xml_ingest_r2_publish.ts
 * @description The one R2 snapshot publisher for normalized XML ingest (`sportsdesk-ops-reports`).
 *
 * The shipped `xml-parse` run calls `publishXmlIngestSnapshotToR2`, so the function below owns
 * the only xml-ingest manifest-body construction and the only conditional-PUT (If-Match) CAS
 * path. The unit test drives it through a fake write/fetch client and the CLI e2e test drives
 * it through `createXmlIngestR2Client` against a mock S3 endpoint: tested path === shipped path.
 */

import { BRIDGE_R2_SINK_SPECS } from "../../lib/r2_manifest_cas.ts";
import {
  R2PreconditionFailedError,
  type R2S3Client,
} from "../../lib/r2_s3_client.ts";

/** Canonical xml-ingest sink spec (bucket / manifest key / generation prefix SSOT). */
export const XML_INGEST_SINK = BRIDGE_R2_SINK_SPECS["xml-ingest"];

export interface XmlIngestR2Client {
  write(
    key: string,
    data: string | Uint8Array,
    opts?: { type?: string },
  ): Promise<unknown>;
  fetch(key: string, init: XmlIngestR2ManifestPut): Promise<Response>;
}

/** The publisher's only request: the conditional manifest PUT. */
export interface XmlIngestR2ManifestPut {
  readonly method: "PUT";
  readonly headers: {
    readonly "Content-Type": string;
    readonly "If-Match"?: string;
    readonly "If-None-Match"?: string;
  };
  readonly body: string;
}

export interface XmlIngestSnapshotPublishInput {
  readonly client: XmlIngestR2Client;
  readonly prevManifestETag: string;
  readonly nextGenerationU32: number;
  readonly watermarkCursor: string;
  readonly dataWindowMaxEpochMs: number;
  /** Canonical XML chunk bytes; the CLI serializer is the single owner of that shape. */
  readonly canonicalXmlBytes: Uint8Array;
  /** Rows hydrated into the chunk — recorded in the manifest (`row_count`). */
  readonly rowCount: number;
  /** Rows with an explicit UNKNOWN line — recorded in the manifest (`line_unknown_count`). */
  readonly lineUnknownCount?: number | undefined;
  /** `--dry-run`: compute the snapshot without writing, ignoring the CAS entirely. */
  readonly dryRun?: boolean | undefined;
}

export interface XmlIngestSnapshotPublishResult {
  readonly merkleRootSha256: string;
  readonly r2PublishedAtEpochMs: number;
  readonly generationKey: string;
  readonly chunkKey: string;
}

/**
 * Adapt the repo's signed-request S3 client to the publisher's write/fetch surface.
 * `R2S3Client` has no `fetch()`, so the conditional PUT becomes
 * `writeWithMetadata(ifMatch)` and a 412 is surfaced as a `Response(412)` — the publisher
 * maps it to `ERR_R2_MANIFEST_CAS_REJECTED` exactly as it does for a raw HTTP 412.
 */
export function createXmlIngestR2Client(s3: R2S3Client): XmlIngestR2Client {
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

export async function publishXmlIngestSnapshotToR2(
  input: XmlIngestSnapshotPublishInput,
): Promise<XmlIngestSnapshotPublishResult> {
  const sink = XML_INGEST_SINK;
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input.canonicalXmlBytes);
  const merkleRootSha256 = hasher.digest("hex");
  const chunkKey = `chunks/${merkleRootSha256}.bin`;
  const generationKey = `${sink.generationPrefix}/gen-${input.nextGenerationU32}-${merkleRootSha256.slice(0, 16)}`;
  const r2PublishedAtEpochMs = input.dryRun === true ? 0 : Date.now();

  // The single manifest-body construction for this sink.
  const manifestBody = JSON.stringify({
    domain: sink.domain,
    sink_id: sink.sinkId,
    r2_bucket: sink.r2Bucket,
    r2_manifest_key: sink.manifestKey,
    generation_u32: input.nextGenerationU32,
    merkle_root_sha256: merkleRootSha256,
    watermark_cursor: input.watermarkCursor,
    data_window_max_epoch_ms: input.dataWindowMaxEpochMs,
    r2_published_at_epoch_ms: r2PublishedAtEpochMs,
    chunk_key: chunkKey,
    row_count: input.rowCount,
    line_unknown_count: input.lineUnknownCount ?? 0,
    circuit_state: "CLOSED",
    unresolved_gap_cents: "0",
  });

  if (input.dryRun === true) {
    return { merkleRootSha256, r2PublishedAtEpochMs, generationKey, chunkKey };
  }

  await input.client.write(chunkKey, input.canonicalXmlBytes, {
    type: "application/xml",
  });
  await input.client.write(generationKey, manifestBody, {
    type: "application/json",
  });

  // The single CAS path: If-Match on the previous ETag, zero rebases in place.
  let casResponse: Response;
  try {
    casResponse = await input.client.fetch(sink.manifestKey, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": input.prevManifestETag,
      },
      body: manifestBody,
    });
  } catch (error) {
    throw new Error(
      `ERR_R2_SINK_BACKPRESSURE: PUT ${sink.manifestKey} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  if (casResponse.status === 412) {
    // 0 rebases: the caller re-probes instead of retrying the CAS in place.
    throw new Error("ERR_R2_MANIFEST_CAS_REJECTED");
  }
  if (!casResponse.ok) {
    throw new Error(`ERR_R2_SINK_BACKPRESSURE: HTTP ${casResponse.status}`);
  }

  return { merkleRootSha256, r2PublishedAtEpochMs, generationKey, chunkKey };
}
