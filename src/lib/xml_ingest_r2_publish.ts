/**
 * @file src/lib/xml_ingest_r2_publish.ts
 * @description Dual-clock R2 manifest CAS for normalized XML ingest (`sportsdesk-ops-reports`).
 */

export interface XmlIngestR2Client {
  write(
    key: string,
    data: string | Uint8Array,
    opts?: { type?: string },
  ): Promise<unknown>;
  fetch(
    key: string,
    init: RequestInit & { headers?: Record<string, string> },
  ): Promise<Response>;
}

export interface XmlIngestSnapshotPublishInput {
  readonly client: XmlIngestR2Client;
  readonly prevManifestETag: string;
  readonly nextGenerationU32: number;
  readonly watermarkCursor: string;
  readonly dataWindowMaxEpochMs: number;
  readonly normalizedNode: Bun.XML.NodeInput;
  readonly r2Bucket?: string | undefined;
}

export interface XmlIngestSnapshotPublishResult {
  readonly merkleRootSha256: string;
  readonly r2PublishedAtEpochMs: number;
  readonly generationKey: string;
  readonly chunkKey: string;
}

export async function publishXmlIngestSnapshotToR2(
  input: XmlIngestSnapshotPublishInput,
): Promise<XmlIngestSnapshotPublishResult> {
  const canonicalXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    Bun.XML.stringify(input.normalizedNode);
  const payloadBytes = new TextEncoder().encode(canonicalXml);

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(payloadBytes);
  const merkleRootSha256 = hasher.digest("hex");

  const chunkKey = `chunks/${merkleRootSha256}.bin`;
  await input.client.write(chunkKey, payloadBytes, {
    type: "application/xml",
  });

  const r2PublishedAtEpochMs = Date.now();
  const generationKey = `generations/xml-ingest/gen-${input.nextGenerationU32}-${merkleRootSha256.slice(0, 16)}`;
  const manifestBody = JSON.stringify({
    domain: "[Ops & Governance]",
    sink_id: "xml-ingest",
    r2_bucket: input.r2Bucket ?? "sportsdesk-ops-reports",
    generation_u32: input.nextGenerationU32,
    merkle_root_sha256: merkleRootSha256,
    watermark_cursor: input.watermarkCursor,
    data_window_max_epoch_ms: input.dataWindowMaxEpochMs,
    r2_published_at_epoch_ms: r2PublishedAtEpochMs,
    chunk_key: chunkKey,
    circuit_state: "CLOSED",
  });

  await input.client.write(generationKey, manifestBody, {
    type: "application/json",
  });

  const res = await input.client.fetch("manifests/xml-ingest/latest", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "If-Match": input.prevManifestETag,
    },
    body: manifestBody,
  });

  if (res.status === 412) {
    throw new Error("ERR_R2_MANIFEST_CAS_REJECTED");
  }
  if (!res.ok) {
    throw new Error(`ERR_R2_SINK_BACKPRESSURE: HTTP ${res.status}`);
  }

  return {
    merkleRootSha256,
    r2PublishedAtEpochMs,
    generationKey,
    chunkKey,
  };
}
