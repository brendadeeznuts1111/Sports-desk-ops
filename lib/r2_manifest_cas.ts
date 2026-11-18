/**
 * @file lib/r2_manifest_cas.ts
 * @description Shared R2 Compare-And-Swap (If-Match / If-None-Match) manifest promoter,
 * content-addressed chunk writer, and governance guards for `sportsdesk-ops-reports`.
 */

import { readStrictUtf8R2Object } from "./r2_text.ts";
import {
  R2PreconditionFailedError,
  R2S3Client,
  R2TimeoutError,
  type R2WriteResult,
} from "./r2_s3_client.ts";
import { R2_PUBLIC_BASE } from "./r2_staleness.ts";

export const R2_BUCKET = "sportsdesk-ops-reports" as const;

export const RETIRED_FALLBACK_ENV_KEYS = [
  "DOD6_SPINE_PATH",
  "DOD_SPINE_PATH",
  "F402_BETS_JSONL_PATH",
  "DOD_SQLITE_PATH",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

export type R2CasEnv = Readonly<Record<string, string | undefined>>;

export class R2ManifestCasError extends Error {
  public readonly code: string;
  public readonly exitCode: number;

  constructor(
    code: string,
    message: string,
    exitCode: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "R2ManifestCasError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function mapR2ErrorExitCode(err: unknown): number {
  if (err instanceof R2ManifestCasError) {
    return err.exitCode;
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "exitCode" in err &&
    typeof (err as { readonly exitCode?: unknown }).exitCode === "number"
  ) {
    return (err as { readonly exitCode: number }).exitCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes("ERR_DOD_LEGACY_FALLBACK_REMOVED") ||
    message.includes("ERR_OPS_LOCAL_JSON_FORBIDDEN")
  ) {
    return 78;
  }
  if (message.includes("ERR_CF_TOKEN_BLEED_10000")) {
    return 77;
  }
  if (message.includes("ERR_R2_MANIFEST_CAS_TIMEOUT")) {
    return 75;
  }
  if (
    message.includes("ERR_R2_MANIFEST_CAS_REJECTED") ||
    message.includes("ERR_R2_CHUNK_PUT_RETRY") ||
    message.includes("ERR_R2_CHUNK_MERKLE_MISMATCH")
  ) {
    return 74;
  }
  if (
    message.includes("ERR_DOD_CSR_CONSERVATION_BREACH") ||
    message.includes("ERR_BRIDGE_CHANNEL_CONTAMINATION")
  ) {
    return 70;
  }
  return 65;
}

export function assertR2TokenIsolationAndEnv(env: R2CasEnv = Bun.env): void {
  for (const key of RETIRED_FALLBACK_ENV_KEYS) {
    if (env[key]) {
      throw new R2ManifestCasError(
        "ERR_DOD_LEGACY_FALLBACK_REMOVED",
        `ERR_DOD_LEGACY_FALLBACK_REMOVED: ${key}`,
        78,
      );
    }
  }
  if (env.CLOUDFLARE_R2_API_TOKEN && env.CLOUDFLARE_API_TOKEN) {
    throw new R2ManifestCasError(
      "ERR_CF_TOKEN_BLEED_10000",
      "ERR_CF_TOKEN_BLEED_10000",
      77,
    );
  }
}

export function assertZeroReconciliationGapCents(rawGap: unknown): void {
  const normalized = String(rawGap ?? "0").trim();
  let parsed: bigint;
  try {
    if (!/^[+-]?\d+$/.test(normalized)) {
      throw new Error("non-integer gap");
    }
    parsed = BigInt(normalized);
  } catch (cause) {
    throw new R2ManifestCasError(
      "ERR_OPS_RECONCILIATION_GAP",
      `ERR_OPS_RECONCILIATION_GAP: invalid unresolved_gap_cents (${normalized})`,
      65,
      cause,
    );
  }
  if (parsed !== 0n) {
    throw new R2ManifestCasError(
      "ERR_OPS_RECONCILIATION_GAP",
      `ERR_OPS_RECONCILIATION_GAP: unresolved_gap_cents=${parsed.toString()}`,
      65,
    );
  }
}

export function resolveR2EndpointFromEnv(
  env: R2CasEnv = Bun.env,
): string | undefined {
  if (env.R2_ENDPOINT && env.R2_ENDPOINT.trim().length > 0) {
    return env.R2_ENDPOINT.trim();
  }
  if (
    env.CLOUDFLARE_ACCOUNT_ID &&
    env.CLOUDFLARE_ACCOUNT_ID.trim().length > 0
  ) {
    return `https://${env.CLOUDFLARE_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`;
  }
  return undefined;
}

export function createScopedR2S3Client(env: R2CasEnv = Bun.env): R2S3Client {
  assertR2TokenIsolationAndEnv(env);
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const endpoint = resolveR2EndpointFromEnv(env);
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new R2ManifestCasError(
      "ERR_CF_R2_CREDENTIALS_MISSING",
      "ERR_CF_R2_CREDENTIALS_MISSING",
      65,
    );
  }
  const bucket = env.R2_BUCKET_NAME?.trim() || R2_BUCKET;
  const publicBase = env.R2_PUBLIC_URL?.trim() || R2_PUBLIC_BASE;
  return R2S3Client.fromOptions({
    bucket,
    endpoint,
    accessKeyId,
    secretAccessKey,
    publicBase,
  });
}

export interface CasR2ClientLike {
  headEtag(
    key: string,
    options?: { readonly fetchImpl?: typeof fetch },
  ): Promise<string | null>;
  write(
    key: string,
    data: Uint8Array | string,
    options?: { readonly type?: string },
  ): Promise<number>;
  writeWithMetadata(
    key: string,
    data: Uint8Array | string,
    options?: {
      readonly type?: string;
      readonly metadata?: Readonly<Record<string, string>>;
      readonly ifMatch?: string;
      readonly ifNoneMatch?: string;
      readonly retry?: number;
      readonly retryDelayMs?: number;
      readonly fetchImpl?: typeof fetch;
    },
  ): Promise<number>;
  /** When present, the CAS promote takes the new ETag from the PUT response. */
  writeWithMetadataResult?(
    key: string,
    data: Uint8Array | string,
    options?: {
      readonly type?: string;
      readonly metadata?: Readonly<Record<string, string>>;
      readonly ifMatch?: string;
      readonly ifNoneMatch?: string;
      readonly retry?: number;
      readonly fetchImpl?: typeof fetch;
    },
  ): Promise<R2WriteResult>;
  file(key: string): {
    text(): Promise<string>;
    bytes(): Promise<Uint8Array>;
  };
  stat(key: string): Promise<{
    readonly etag?: string | undefined;
    readonly size?: number | undefined;
  }>;
}

export type R2ManifestProbeResult<T> =
  | {
      readonly exists: false;
      readonly etag: null;
      readonly payload: null;
    }
  | {
      readonly exists: true;
      readonly etag: string;
      readonly payload: T;
    };

export function normalizeStrongETag(etag: string | null): string | null {
  if (etag === null) return null;
  const trimmed = etag.trim();
  if (trimmed.length === 0) return null;
  const normalized = trimmed.replace(/^W\//i, "").trim();
  return normalized.length === 0 ? null : normalized;
}

export async function probeR2ManifestState<T>(
  client: CasR2ClientLike,
  manifestKey: string,
  options?: { readonly fetchImpl?: typeof fetch },
): Promise<R2ManifestProbeResult<T>> {
  let rawEtag: string | null;
  try {
    rawEtag = await client.headEtag(
      manifestKey,
      options?.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
    );
  } catch (cause) {
    throw new R2ManifestCasError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: HEAD ${manifestKey} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      65,
      cause,
    );
  }
  const etag = normalizeStrongETag(rawEtag);
  if (etag === null) {
    return { exists: false, etag: null, payload: null };
  }

  let rawText: string;
  try {
    rawText = await readStrictUtf8R2Object(client.file(manifestKey));
  } catch (cause) {
    throw new R2ManifestCasError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: GET ${manifestKey} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      65,
      cause,
    );
  }

  try {
    const payload = JSON.parse(rawText) as T;
    return { exists: true, etag, payload };
  } catch (cause) {
    throw new R2ManifestCasError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: GET ${manifestKey} returned invalid JSON`,
      65,
      cause,
    );
  }
}

export async function writeContentAddressedChunkWithRetry(
  client: CasR2ClientLike,
  chunkBytes: Uint8Array,
  options?: {
    readonly contentType?: string;
    readonly expectedSha256?: string;
    readonly maxRetries?: number;
    readonly baseDelayMs?: number;
  },
): Promise<{
  readonly chunkKey: string;
  readonly merkleRootSha256: string;
  readonly byteLength: number;
}> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(chunkBytes);
  const merkleRootSha256 = hasher.digest("hex");

  if (
    options?.expectedSha256 !== undefined &&
    options.expectedSha256 !== merkleRootSha256
  ) {
    throw new R2ManifestCasError(
      "ERR_R2_CHUNK_MERKLE_MISMATCH",
      `ERR_R2_CHUNK_MERKLE_MISMATCH: expected=${options.expectedSha256} actual=${merkleRootSha256}`,
      74,
    );
  }

  const chunkKey = `chunks/${merkleRootSha256}.bin`;
  const contentType = options?.contentType ?? "application/octet-stream";
  const maxRetries = Math.max(0, Math.trunc(options?.maxRetries ?? 2));
  const baseDelayMs = Math.max(0, Math.trunc(options?.baseDelayMs ?? 15));

  try {
    const existingEtag = normalizeStrongETag(await client.headEtag(chunkKey));
    if (existingEtag !== null) {
      return {
        chunkKey,
        merkleRootSha256,
        byteLength: chunkBytes.byteLength,
      };
    }
  } catch {
    // Fall through to idempotent chunk upload attempts.
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0 && baseDelayMs > 0) {
      const jitterMs = Math.floor(Math.random() * 5);
      await Bun.sleep(baseDelayMs * attempt + jitterMs);
    }
    try {
      const written = await client.write(chunkKey, chunkBytes, {
        type: contentType,
      });
      if (written !== chunkBytes.byteLength) {
        throw new R2ManifestCasError(
          "ERR_R2_CHUNK_MERKLE_MISMATCH",
          `ERR_R2_CHUNK_MERKLE_MISMATCH: wrote ${written} of ${chunkBytes.byteLength} bytes to ${chunkKey}`,
          74,
        );
      }
      const uploadedEtag = normalizeStrongETag(await client.headEtag(chunkKey));
      if (uploadedEtag === null) {
        throw new R2ManifestCasError(
          "ERR_R2_CHUNK_MERKLE_MISMATCH",
          `ERR_R2_CHUNK_MERKLE_MISMATCH: missing ETag after upload on ${chunkKey}`,
          74,
        );
      }
      return {
        chunkKey,
        merkleRootSha256,
        byteLength: chunkBytes.byteLength,
      };
    } catch (error) {
      if (
        error instanceof R2ManifestCasError &&
        error.code === "ERR_R2_CHUNK_MERKLE_MISMATCH"
      ) {
        throw error;
      }
      lastError = error;
    }
  }

  throw new R2ManifestCasError(
    "ERR_R2_CHUNK_PUT_RETRY",
    `ERR_R2_CHUNK_PUT_RETRY: failed writing ${chunkKey} after ${maxRetries + 1} attempt(s): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    74,
    lastError,
  );
}

export async function promoteCanonicalManifestWithCas<TManifest>(params: {
  readonly client: CasR2ClientLike;
  readonly sinkId: string;
  readonly manifestKey?: string;
  readonly prevETag: string | null;
  readonly nextGenerationU32: number;
  readonly merkleRootSha256: string;
  readonly manifest: TManifest;
  readonly unresolvedGapCents?: unknown;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
}): Promise<{
  readonly manifestKey: string;
  readonly generationKey: string;
  readonly newETag: string | null;
}> {
  assertZeroReconciliationGapCents(params.unresolvedGapCents ?? "0");

  const nextGenU32 = params.nextGenerationU32 >>> 0;
  const manifestKey = params.manifestKey ?? `manifests/${params.sinkId}/latest`;

  const normalizedPrevETag = normalizeStrongETag(params.prevETag);
  if (params.prevETag === null) {
    if (nextGenU32 !== 1) {
      throw new R2ManifestCasError(
        "ERR_R2_MANIFEST_CAS_REJECTED",
        `ERR_R2_MANIFEST_CAS_REJECTED: missing prevETag for non-initial generation ${nextGenU32} on ${manifestKey}`,
        74,
      );
    }
  } else if (normalizedPrevETag === null) {
    throw new R2ManifestCasError(
      "ERR_R2_MANIFEST_CAS_REJECTED",
      `ERR_R2_MANIFEST_CAS_REJECTED: empty prevETag for ${manifestKey}`,
      74,
    );
  }

  const serialized = JSON.stringify(params.manifest);
  const merkle16 = params.merkleRootSha256.slice(0, 16);
  const generationKey = `generations/${params.sinkId}/gen-${nextGenU32}-${merkle16}`;
  await params.client.write(generationKey, serialized, {
    type: "application/json",
  });

  const casHeaders =
    normalizedPrevETag === null
      ? { ifNoneMatch: "*" }
      : { ifMatch: normalizedPrevETag };

  const putOptions = {
    type: "application/json",
    retry: 0,
    ...casHeaders,
    ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
    ...(params.fetchImpl === undefined ? {} : { fetchImpl: params.fetchImpl }),
  };
  let putETag: string | null = null;
  try {
    if (params.client.writeWithMetadataResult === undefined) {
      await params.client.writeWithMetadata(
        manifestKey,
        serialized,
        putOptions,
      );
    } else {
      putETag = normalizeStrongETag(
        (
          await params.client.writeWithMetadataResult(
            manifestKey,
            serialized,
            putOptions,
          )
        ).etag,
      );
    }
  } catch (error) {
    if (error instanceof R2TimeoutError) {
      const landedETag = await resolveTimedOutCasPut({
        client: params.client,
        manifestKey,
        serialized,
        prevETag: normalizedPrevETag,
        timeout: error,
        ...(params.fetchImpl === undefined
          ? {}
          : { fetchImpl: params.fetchImpl }),
      });
      return { manifestKey, generationKey, newETag: landedETag };
    }
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? (error as { readonly status?: unknown }).status
        : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof R2PreconditionFailedError ||
      status === 412 ||
      /\b412\b|precondition/i.test(message)
    ) {
      throw new R2ManifestCasError(
        "ERR_R2_MANIFEST_CAS_REJECTED",
        `ERR_R2_MANIFEST_CAS_REJECTED: HTTP 412 promoting ${manifestKey} (zero rebases)`,
        74,
        error,
      );
    }
    throw new R2ManifestCasError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: PUT ${manifestKey} failed: ${message}`,
      65,
      error,
    );
  }

  if (putETag !== null) return { manifestKey, generationKey, newETag: putETag };
  const rawNewETag = await params.client.headEtag(
    manifestKey,
    params.fetchImpl === undefined ? {} : { fetchImpl: params.fetchImpl },
  );
  return {
    manifestKey,
    generationKey,
    newETag: normalizeStrongETag(rawNewETag),
  };
}

/**
 * A timed-out CAS PUT is never retried blindly: re-read the pointer. Unchanged means
 * the PUT did not land (ERR_R2_MANIFEST_CAS_TIMEOUT, safe to retry with the same
 * prevETag); our exact body means it landed (returns its ETag); anything else means
 * another writer moved the generation (ERR_R2_MANIFEST_CAS_REJECTED).
 */
async function resolveTimedOutCasPut(options: {
  readonly client: CasR2ClientLike;
  readonly manifestKey: string;
  readonly serialized: string;
  readonly prevETag: string | null;
  readonly timeout: R2TimeoutError;
  readonly fetchImpl?: typeof fetch;
}): Promise<string> {
  const { manifestKey, timeout } = options;
  let currentETag: string | null;
  let currentText: string | null = null;
  try {
    currentETag = normalizeStrongETag(
      await options.client.headEtag(
        manifestKey,
        options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
      ),
    );
    if (currentETag !== null && currentETag !== options.prevETag) {
      currentText = await readStrictUtf8R2Object(
        options.client.file(manifestKey),
      );
    }
  } catch (cause) {
    throw new R2ManifestCasError(
      "ERR_R2_MANIFEST_CAS_TIMEOUT",
      `ERR_R2_MANIFEST_CAS_TIMEOUT: PUT ${manifestKey} timed out after ${timeout.ms}ms and the re-read failed; outcome unknown`,
      75,
      new AggregateError([timeout, cause]),
    );
  }
  if (currentETag === options.prevETag) {
    throw new R2ManifestCasError(
      "ERR_R2_MANIFEST_CAS_TIMEOUT",
      `ERR_R2_MANIFEST_CAS_TIMEOUT: PUT ${manifestKey} timed out after ${timeout.ms}ms; generation unchanged`,
      75,
      timeout,
    );
  }
  if (currentETag !== null && currentText === options.serialized) {
    return currentETag;
  }
  throw new R2ManifestCasError(
    "ERR_R2_MANIFEST_CAS_REJECTED",
    `ERR_R2_MANIFEST_CAS_REJECTED: PUT ${manifestKey} timed out after ${timeout.ms}ms and another writer moved the generation`,
    74,
    timeout,
  );
}

export type CanonicalR2SinkId =
  "wagers-by-state" | "syndicate-rings" | "ops-supervisor" | "edge-topology";

export type BridgeR2SinkId = "xml-ingest" | "f402-weblog";
export type AnyR2SinkId = CanonicalR2SinkId | BridgeR2SinkId;

export interface CanonicalR2SinkSpec<
  TSinkId extends AnyR2SinkId = CanonicalR2SinkId,
> {
  readonly sinkId: TSinkId;
  readonly domain: "[Ops & Governance]" | "[DOD Spine]";
  readonly r2Bucket: typeof R2_BUCKET;
  readonly manifestKey: string;
  readonly generationPrefix: string;
  readonly lane: string;
  readonly skillOrdinalU8: number;
  readonly slaMs: number;
  readonly r2Region?: "ENAM";
}

export const CANONICAL_R2_SINK_SPECS: Readonly<
  Record<CanonicalR2SinkId, CanonicalR2SinkSpec<CanonicalR2SinkId>>
> = {
  "wagers-by-state": {
    sinkId: "wagers-by-state",
    domain: "[Ops & Governance]",
    r2Bucket: R2_BUCKET,
    manifestKey: "manifests/wagers-by-state/latest",
    generationPrefix: "generations/wagers-by-state",
    lane: "ops-wagers-spine",
    skillOrdinalU8: 15,
    slaMs: 60 * 60 * 1000,
  },
  "syndicate-rings": {
    sinkId: "syndicate-rings",
    domain: "[DOD Spine]",
    r2Bucket: R2_BUCKET,
    manifestKey: "manifests/syndicate-rings/latest",
    generationPrefix: "generations/syndicate-rings",
    lane: "dod-syndicate-rings",
    skillOrdinalU8: 14,
    slaMs: 60 * 60 * 1000,
  },
  "ops-supervisor": {
    sinkId: "ops-supervisor",
    domain: "[Ops & Governance]",
    r2Bucket: R2_BUCKET,
    manifestKey: "manifests/ops-supervisor/latest",
    generationPrefix: "generations/ops-supervisor",
    lane: "ops-control-plane",
    skillOrdinalU8: 16,
    slaMs: 60 * 60 * 1000,
  },
  "edge-topology": {
    sinkId: "edge-topology",
    domain: "[Ops & Governance]",
    r2Bucket: R2_BUCKET,
    manifestKey: "manifests/edge-topology/latest",
    generationPrefix: "generations/edge-topology",
    lane: "ops-edge-ci",
    skillOrdinalU8: 4,
    r2Region: "ENAM",
    slaMs: 60 * 60 * 1000,
  },
} as const;

export const BRIDGE_R2_SINK_SPECS: Readonly<
  Record<BridgeR2SinkId, CanonicalR2SinkSpec<BridgeR2SinkId>>
> = {
  "xml-ingest": {
    sinkId: "xml-ingest",
    domain: "[Ops & Governance]",
    r2Bucket: R2_BUCKET,
    manifestKey: "manifests/xml-ingest/latest",
    generationPrefix: "generations/xml-ingest",
    lane: "ops-xml-ingest",
    skillOrdinalU8: 11,
    slaMs: 60 * 60 * 1000,
  },
  "f402-weblog": {
    sinkId: "f402-weblog",
    domain: "[Ops & Governance]",
    r2Bucket: R2_BUCKET,
    manifestKey: "manifests/f402-weblog/latest",
    generationPrefix: "generations/f402-weblog",
    lane: "ops-weblog-bridge",
    skillOrdinalU8: 12,
    slaMs: 90 * 60 * 1000,
  },
} as const;

export const STAGE_4_LEDGER_PUBLISH_SNAPSHOT = {
  stage: "STAGE_4_LEDGER_PUBLISH" as const,
  branch: "cross_reference_customer_wagers" as const,
  r2_bucket: R2_BUCKET,
  recorded_at_iso: "2026-11-17T21:11:06.000Z" as const,
  preserved_docs: ["DOC-13"] as const,
  targets: {
    "DOC-14": {
      label: "LIVE-01" as const,
      sinks: ["wagers-by-state", "syndicate-rings"] as const,
    },
    "DOC-16": {
      label: "LIVE-02" as const,
      sinks: ["ops-supervisor", "edge-topology"] as const,
    },
    "LIVE-KEEP-HUD": {
      label: "LIVE-KEEP-HUD" as const,
      sinks: [
        "wagers-by-state",
        "syndicate-rings",
        "ops-supervisor",
        "edge-topology",
      ] as const,
    },
  },
  sinks: {
    "wagers-by-state": {
      manifest_key: "manifests/wagers-by-state/latest",
      generation_u32: 2,
      etag: '"85d8da3a296d25ac823034cb7cf880de"',
      merkle_root_sha256:
        "762d82a5191e06e2437b456e5fe6282434319fbe0e442ebdf49cc4e5a08de392",
    },
    "syndicate-rings": {
      manifest_key: "manifests/syndicate-rings/latest",
      generation_u32: 1,
      etag: '"bccc9736b9e8b17d3f321f09f3b0699d"',
      merkle_root_sha256:
        "b1128b66f0c6d8155b428b7112802f506f02783f78c75dca0ac2b6962f46da2d",
    },
    "ops-supervisor": {
      manifest_key: "manifests/ops-supervisor/latest",
      generation_u32: 1,
      etag: '"20725e1d57a7ee8212bdccbd5572dc6b"',
      merkle_root_sha256:
        "ab2fba43fb87506793b448b0986170cd21420826c5698da456e9312ec1e2ded6",
    },
    "edge-topology": {
      manifest_key: "manifests/edge-topology/latest",
      generation_u32: 1,
      etag: '"9896acf3f47030389ffa5ef540e7e6ff"',
      merkle_root_sha256:
        "0a64e1e196dfddb6c79c73774c043aa15bb5ba6283ae615bb70f6132f0ac216e",
    },
  },
} as const;

export interface OpsSupervisorManifest {
  readonly domain: "[Ops & Governance]";
  readonly sink_id: "ops-supervisor";
  readonly r2_bucket: string;
  readonly lane: "ops-control-plane";
  readonly skillOrdinalU8: 16;
  readonly generation_u32: number;
  readonly merkle_root_sha256: string;
  readonly watermark_cursor: string;
  readonly data_window_max_epoch_ms: number;
  readonly r2_published_at_epoch_ms: number;
  readonly circuit_state: "CLOSED" | "OPEN";
  readonly unresolved_gap_cents: string;
}

export interface EdgeTopologyManifest {
  readonly domain: "[Ops & Governance]";
  readonly sink_id: "edge-topology";
  readonly account_scope: string;
  readonly r2_bucket: string;
  readonly r2_region: "ENAM";
  readonly lane: "ops-edge-ci";
  readonly skillOrdinalU8: 4;
  readonly snapshot_gen_u32: number;
  readonly generation_u32: number;
  readonly merkle_root_sha256: string;
  readonly etag_cas: string;
  readonly data_window_max_epoch_ms: number;
  readonly r2_published_at_epoch_ms: number;
  readonly drift_exit_code: number;
  readonly circuit_state: "CLOSED" | "OPEN";
  readonly unresolved_gap_cents: string;
}

export interface CanonicalManifestRecord {
  readonly domain?: string;
  readonly sink_id?: string;
  readonly r2_bucket?: string;
  readonly generation_u32?: number;
  readonly snapshot_gen_u32?: number;
  readonly merkle_root_sha256?: string;
  readonly sha256?: string;
  readonly deskDate?: string;
  readonly watermark_cursor?: string;
  readonly data_window_max_epoch_ms?: number;
  readonly r2_published_at_epoch_ms?: number;
  readonly circuit_state?: string;
  readonly unresolved_gap_cents?: string;
  readonly poison_bit?: number;
  readonly drift_exit_code?: number;
}

export async function publishOpsSupervisorManifestToR2(options: {
  readonly client: CasR2ClientLike;
  readonly env?: R2CasEnv;
  readonly watermarkCursor?: string;
  readonly dataWindowMaxEpochMs?: number;
  readonly unresolvedGapCents?: unknown;
  readonly nowMs?: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<{
  readonly manifestKey: string;
  readonly generationKey: string;
  readonly prevETag: string | null;
  readonly newETag: string | null;
  readonly manifest: OpsSupervisorManifest;
}> {
  const env = options.env ?? Bun.env;
  assertR2TokenIsolationAndEnv(env);
  const gapCents = String(options.unresolvedGapCents ?? "0").trim();
  assertZeroReconciliationGapCents(gapCents);

  const spec = CANONICAL_R2_SINK_SPECS["ops-supervisor"];
  const probe = await probeR2ManifestState<OpsSupervisorManifest>(
    options.client,
    spec.manifestKey,
    options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
  );
  const nextGenerationU32 = probe.exists
    ? ((probe.payload.generation_u32 >>> 0) + 1) >>> 0
    : 1;
  const nowMs = options.nowMs ?? Date.now();
  const dataWindowMaxEpochMs = options.dataWindowMaxEpochMs ?? nowMs;
  const watermarkCursor =
    options.watermarkCursor ?? `${spec.lane}:gen-${nextGenerationU32}`;

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    `${spec.sinkId}|gen=${nextGenerationU32}|lane=${spec.lane}|skill=${spec.skillOrdinalU8}|wm=${watermarkCursor}|dw=${dataWindowMaxEpochMs}\n`,
  );
  const merkleRootSha256 = hasher.digest("hex");
  const publishedEpochMs = options.nowMs ?? Date.now();

  const manifest: OpsSupervisorManifest = {
    domain: "[Ops & Governance]",
    sink_id: "ops-supervisor",
    r2_bucket: env.R2_BUCKET_NAME?.trim() || spec.r2Bucket,
    lane: "ops-control-plane",
    skillOrdinalU8: 16,
    generation_u32: nextGenerationU32,
    merkle_root_sha256: merkleRootSha256,
    watermark_cursor: watermarkCursor,
    data_window_max_epoch_ms: dataWindowMaxEpochMs,
    r2_published_at_epoch_ms: publishedEpochMs,
    circuit_state: "CLOSED",
    unresolved_gap_cents: gapCents,
  };

  const promo = await promoteCanonicalManifestWithCas({
    client: options.client,
    sinkId: spec.sinkId,
    manifestKey: spec.manifestKey,
    prevETag: probe.etag,
    nextGenerationU32,
    merkleRootSha256,
    manifest,
    unresolvedGapCents: gapCents,
    metadata: {
      pii: "none",
      domain: "ops-governance",
      "sink-id": spec.sinkId,
      lane: spec.lane,
      "generation-u32": String(nextGenerationU32),
      "merkle-root-sha256": merkleRootSha256,
    },
    ...(options.fetchImpl === undefined
      ? {}
      : { fetchImpl: options.fetchImpl }),
  });

  return {
    manifestKey: promo.manifestKey,
    generationKey: promo.generationKey,
    prevETag: probe.etag,
    newETag: promo.newETag,
    manifest,
  };
}

export async function publishEdgeTopologyManifestToR2(options: {
  readonly client: CasR2ClientLike;
  readonly env?: R2CasEnv;
  readonly accountScope?: string;
  readonly dataWindowMaxEpochMs?: number;
  readonly driftExitCode?: number;
  readonly unresolvedGapCents?: unknown;
  readonly nowMs?: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<{
  readonly manifestKey: string;
  readonly generationKey: string;
  readonly prevETag: string | null;
  readonly newETag: string | null;
  readonly manifest: EdgeTopologyManifest;
}> {
  const env = options.env ?? Bun.env;
  assertR2TokenIsolationAndEnv(env);
  const gapCents = String(options.unresolvedGapCents ?? "0").trim();
  assertZeroReconciliationGapCents(gapCents);

  const driftExitCode = Math.trunc(options.driftExitCode ?? 0);
  if (driftExitCode !== 0) {
    throw new R2ManifestCasError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: edge-topology drift_exit_code=${driftExitCode} !== 0`,
      65,
    );
  }

  const spec = CANONICAL_R2_SINK_SPECS["edge-topology"];
  const probe = await probeR2ManifestState<EdgeTopologyManifest>(
    options.client,
    spec.manifestKey,
    options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
  );
  const prevGen = probe.exists
    ? (probe.payload.snapshot_gen_u32 ?? probe.payload.generation_u32) >>> 0
    : 0;
  const nextGenerationU32 = (prevGen + 1) >>> 0;
  const nowMs = options.nowMs ?? Date.now();
  const dataWindowMaxEpochMs = options.dataWindowMaxEpochMs ?? nowMs;
  const accountScope =
    options.accountScope?.trim() ||
    env.CLOUDFLARE_ACCOUNT_ID?.trim() ||
    "sportsdesk-default";
  const etagCas =
    probe.etag === null ? "If-None-Match:*" : `If-Match:${probe.etag}`;

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    `${spec.sinkId}|gen=${nextGenerationU32}|scope=${accountScope}|region=ENAM|lane=${spec.lane}|skill=${spec.skillOrdinalU8}|dw=${dataWindowMaxEpochMs}\n`,
  );
  const merkleRootSha256 = hasher.digest("hex");
  const publishedEpochMs = options.nowMs ?? Date.now();

  const manifest: EdgeTopologyManifest = {
    domain: "[Ops & Governance]",
    sink_id: "edge-topology",
    account_scope: accountScope,
    r2_bucket: env.R2_BUCKET_NAME?.trim() || spec.r2Bucket,
    r2_region: "ENAM",
    lane: "ops-edge-ci",
    skillOrdinalU8: 4,
    snapshot_gen_u32: nextGenerationU32,
    generation_u32: nextGenerationU32,
    merkle_root_sha256: merkleRootSha256,
    etag_cas: etagCas,
    data_window_max_epoch_ms: dataWindowMaxEpochMs,
    r2_published_at_epoch_ms: publishedEpochMs,
    drift_exit_code: 0,
    circuit_state: "CLOSED",
    unresolved_gap_cents: gapCents,
  };

  const promo = await promoteCanonicalManifestWithCas({
    client: options.client,
    sinkId: spec.sinkId,
    manifestKey: spec.manifestKey,
    prevETag: probe.etag,
    nextGenerationU32,
    merkleRootSha256,
    manifest,
    unresolvedGapCents: gapCents,
    metadata: {
      pii: "none",
      domain: "ops-governance",
      "sink-id": spec.sinkId,
      lane: spec.lane,
      "r2-region": "ENAM",
      "generation-u32": String(nextGenerationU32),
      "merkle-root-sha256": merkleRootSha256,
    },
    ...(options.fetchImpl === undefined
      ? {}
      : { fetchImpl: options.fetchImpl }),
  });

  return {
    manifestKey: promo.manifestKey,
    generationKey: promo.generationKey,
    prevETag: probe.etag,
    newETag: promo.newETag,
    manifest,
  };
}

export async function syncCanonicalGovernanceManifestsToR2(options: {
  readonly client: CasR2ClientLike;
  readonly env?: R2CasEnv;
  readonly requireLiveIngest?: boolean;
  readonly nowMs?: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<{
  readonly schemaVersion: 1;
  readonly command: "r2 --sync";
  readonly domain: "[Ops & Governance]";
  readonly r2_bucket: string;
  readonly circuit_state: "CLOSED";
  readonly unresolved_gap_cents: "0";
  readonly opsSupervisor: Awaited<
    ReturnType<typeof publishOpsSupervisorManifestToR2>
  >;
  readonly edgeTopology: Awaited<
    ReturnType<typeof publishEdgeTopologyManifestToR2>
  >;
}> {
  const env = options.env ?? Bun.env;
  assertR2TokenIsolationAndEnv(env);
  if (
    (options.requireLiveIngest ?? true) &&
    env.SPORTSDESK_LIVE_INGEST !== "1"
  ) {
    throw new R2ManifestCasError(
      "ERR_R2_SINK_BACKPRESSURE",
      "ERR_R2_SINK_BACKPRESSURE: set SPORTSDESK_LIVE_INGEST=1 to sync canonical R2 governance manifests",
      65,
    );
  }

  const nowMs = options.nowMs ?? Date.now();
  const wagersProbe = await probeR2ManifestState<CanonicalManifestRecord>(
    options.client,
    CANONICAL_R2_SINK_SPECS["wagers-by-state"].manifestKey,
    options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
  );
  const dataWindowMaxEpochMs =
    wagersProbe.exists &&
    typeof wagersProbe.payload.data_window_max_epoch_ms === "number" &&
    Number.isFinite(wagersProbe.payload.data_window_max_epoch_ms)
      ? wagersProbe.payload.data_window_max_epoch_ms
      : nowMs;
  const wagersWatermark = wagersProbe.exists
    ? (wagersProbe.payload.watermark_cursor ??
      `wagers-gen-${wagersProbe.payload.generation_u32 ?? 0}`)
    : "ops-control-plane:bootstrap";

  const [opsSupervisor, edgeTopology] = await Promise.all([
    publishOpsSupervisorManifestToR2({
      client: options.client,
      env,
      watermarkCursor: wagersWatermark,
      dataWindowMaxEpochMs,
      unresolvedGapCents: "0",
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
    }),
    publishEdgeTopologyManifestToR2({
      client: options.client,
      env,
      dataWindowMaxEpochMs,
      driftExitCode: 0,
      unresolvedGapCents: "0",
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
    }),
  ]);

  return {
    schemaVersion: 1,
    command: "r2 --sync",
    domain: "[Ops & Governance]",
    r2_bucket: env.R2_BUCKET_NAME?.trim() || R2_BUCKET,
    circuit_state: "CLOSED",
    unresolved_gap_cents: "0",
    opsSupervisor,
    edgeTopology,
  };
}

export interface CanonicalSinkVerifyEntry {
  readonly sink_id: AnyR2SinkId;
  readonly manifest_key: string;
  readonly domain: string;
  readonly lane: string;
  readonly skillOrdinalU8: number;
  readonly exists: boolean;
  readonly etag: string | null;
  readonly generation_u32: number;
  readonly merkle_root_sha256: string | null;
  readonly data_window_max_epoch_ms: number | null;
  readonly r2_published_at_epoch_ms: number | null;
  readonly circuit_state: string;
  readonly unresolved_gap_cents: string;
  readonly poison_bit: number;
  readonly ok: boolean;
}

function parseManifestGapAndGeneration(payload: CanonicalManifestRecord): {
  readonly rawGap: string;
  readonly gapBig: bigint;
  readonly gapValid: boolean;
  readonly generationU32: number;
} {
  const rawGap = String(payload.unresolved_gap_cents ?? "0").trim();
  let gapBig = 0n;
  let gapValid = true;
  try {
    assertZeroReconciliationGapCents(rawGap);
  } catch {
    gapValid = false;
    try {
      gapBig = /^[+-]?\d+$/.test(rawGap) ? BigInt(rawGap) : 1n;
    } catch {
      gapBig = 1n;
    }
  }
  const hasDataWindow =
    typeof payload.data_window_max_epoch_ms === "number" &&
    Number.isFinite(payload.data_window_max_epoch_ms);
  const hasPublishedAt =
    typeof payload.r2_published_at_epoch_ms === "number" &&
    Number.isFinite(payload.r2_published_at_epoch_ms);
  const generationU32 =
    typeof payload.generation_u32 === "number" ||
    typeof payload.snapshot_gen_u32 === "number"
      ? Number(payload.generation_u32 ?? payload.snapshot_gen_u32) >>> 0
      : typeof payload.sha256 === "string" &&
          payload.sha256.length > 0 &&
          hasDataWindow &&
          hasPublishedAt
        ? 1
        : 0;
  return { rawGap, gapBig, gapValid, generationU32 };
}

export async function verifyCanonicalR2Manifests(options: {
  readonly client: CasR2ClientLike;
  readonly env?: R2CasEnv;
  readonly includeBridges?: boolean;
  readonly fetchImpl?: typeof fetch;
}): Promise<{
  readonly schemaVersion: 1;
  readonly command: "r2 --verify";
  readonly domain: "[Ops & Governance]";
  readonly r2_bucket: string;
  readonly circuit_state: "CLOSED" | "OPEN";
  readonly unresolved_gap_cents: string;
  readonly ok: boolean;
  readonly sinks: readonly CanonicalSinkVerifyEntry[];
}> {
  const env = options.env ?? Bun.env;
  assertR2TokenIsolationAndEnv(env);

  const specs: readonly CanonicalR2SinkSpec<AnyR2SinkId>[] =
    options.includeBridges
      ? [
          ...Object.values(CANONICAL_R2_SINK_SPECS),
          ...Object.values(BRIDGE_R2_SINK_SPECS),
        ]
      : Object.values(CANONICAL_R2_SINK_SPECS);
  const probes = await Promise.all(
    specs.map((spec) =>
      probeR2ManifestState<CanonicalManifestRecord>(
        options.client,
        spec.manifestKey,
        options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
      ),
    ),
  );

  let totalGapCents = 0n;
  const sinks: CanonicalSinkVerifyEntry[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const probe = probes[i]!;
    if (!probe.exists) {
      sinks.push({
        sink_id: spec.sinkId,
        manifest_key: spec.manifestKey,
        domain: spec.domain,
        lane: spec.lane,
        skillOrdinalU8: spec.skillOrdinalU8,
        exists: false,
        etag: null,
        generation_u32: 0,
        merkle_root_sha256: null,
        data_window_max_epoch_ms: null,
        r2_published_at_epoch_ms: null,
        circuit_state: "OPEN",
        unresolved_gap_cents: "0",
        poison_bit: 0,
        ok: false,
      });
      continue;
    }

    const { rawGap, gapBig, gapValid, generationU32 } =
      parseManifestGapAndGeneration(probe.payload);
    totalGapCents += gapBig < 0n ? -gapBig : gapBig;

    const circuitState = probe.payload.circuit_state ?? "CLOSED";
    const poisonBit = Number(probe.payload.poison_bit ?? 0);
    const driftExitCode = Number(probe.payload.drift_exit_code ?? 0);
    const merkleRoot =
      probe.payload.merkle_root_sha256 ?? probe.payload.sha256 ?? null;
    const sinkOk =
      gapValid &&
      circuitState === "CLOSED" &&
      poisonBit === 0 &&
      driftExitCode === 0 &&
      generationU32 > 0;

    sinks.push({
      sink_id: spec.sinkId,
      manifest_key: spec.manifestKey,
      domain: spec.domain,
      lane: spec.lane,
      skillOrdinalU8: spec.skillOrdinalU8,
      exists: true,
      etag: probe.etag,
      generation_u32: generationU32,
      merkle_root_sha256: merkleRoot,
      data_window_max_epoch_ms:
        typeof probe.payload.data_window_max_epoch_ms === "number"
          ? probe.payload.data_window_max_epoch_ms
          : null,
      r2_published_at_epoch_ms:
        typeof probe.payload.r2_published_at_epoch_ms === "number"
          ? probe.payload.r2_published_at_epoch_ms
          : null,
      circuit_state: circuitState,
      unresolved_gap_cents: rawGap,
      poison_bit: poisonBit,
      ok: sinkOk,
    });
  }

  const allOk = sinks.every((s) => s.ok);
  return {
    schemaVersion: 1,
    command: "r2 --verify",
    domain: "[Ops & Governance]",
    r2_bucket: env.R2_BUCKET_NAME?.trim() || R2_BUCKET,
    circuit_state: allOk ? "CLOSED" : "OPEN",
    unresolved_gap_cents: totalGapCents.toString(),
    ok: allOk,
    sinks,
  };
}

export interface CanonicalSinkStalenessEntry {
  readonly sink_id: AnyR2SinkId;
  readonly manifest_key: string;
  readonly lane: string;
  readonly state: "fresh" | "stale" | "missing";
  readonly sla_ms: number;
  readonly generation_u32: number;
  readonly data_window_max_epoch_ms: number | null;
  readonly r2_published_at_epoch_ms: number | null;
  readonly data_window_age_ms: number | null;
  readonly published_age_ms: number | null;
  readonly poison_bit: number;
  readonly circuit_state: string;
  readonly unresolved_gap_cents: string;
  readonly reason: string;
}

export async function evaluateCanonicalR2ManifestStaleness(options: {
  readonly client: CasR2ClientLike;
  readonly env?: R2CasEnv;
  readonly includeBridges?: boolean;
  readonly nowMs?: number;
  readonly slaMs?: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<{
  readonly schemaVersion: 1;
  readonly command: "stale";
  readonly domain: "[Ops & Governance]";
  readonly r2_bucket: string;
  readonly observed_at_epoch_ms: number;
  readonly circuit_state: "CLOSED" | "OPEN";
  readonly unresolved_gap_cents: string;
  readonly degraded_count: number;
  readonly ok: boolean;
  readonly sinks: readonly CanonicalSinkStalenessEntry[];
}> {
  const env = options.env ?? Bun.env;
  assertR2TokenIsolationAndEnv(env);
  const nowMs = options.nowMs ?? Date.now();
  const specs: readonly CanonicalR2SinkSpec<AnyR2SinkId>[] =
    options.includeBridges
      ? [
          ...Object.values(CANONICAL_R2_SINK_SPECS),
          ...Object.values(BRIDGE_R2_SINK_SPECS),
        ]
      : Object.values(CANONICAL_R2_SINK_SPECS);
  const probes = await Promise.all(
    specs.map((spec) =>
      probeR2ManifestState<CanonicalManifestRecord>(
        options.client,
        spec.manifestKey,
        options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
      ),
    ),
  );

  let degradedCount = 0;
  let totalGapCents = 0n;
  const sinks: CanonicalSinkStalenessEntry[] = [];

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const probe = probes[i]!;
    const slaMs = options.slaMs ?? spec.slaMs;

    if (!probe.exists) {
      degradedCount++;
      sinks.push({
        sink_id: spec.sinkId,
        manifest_key: spec.manifestKey,
        lane: spec.lane,
        state: "missing",
        sla_ms: slaMs,
        generation_u32: 0,
        data_window_max_epoch_ms: null,
        r2_published_at_epoch_ms: null,
        data_window_age_ms: null,
        published_age_ms: null,
        poison_bit: 0,
        circuit_state: "OPEN",
        unresolved_gap_cents: "0",
        reason: "manifest missing",
      });
      continue;
    }

    const p = probe.payload;
    const dataWinMs =
      typeof p.data_window_max_epoch_ms === "number" &&
      Number.isFinite(p.data_window_max_epoch_ms)
        ? p.data_window_max_epoch_ms
        : null;
    const pubMs =
      typeof p.r2_published_at_epoch_ms === "number" &&
      Number.isFinite(p.r2_published_at_epoch_ms)
        ? p.r2_published_at_epoch_ms
        : null;
    const dataWinAgeMs =
      dataWinMs === null ? null : Math.max(0, nowMs - dataWinMs);
    const pubAgeMs = pubMs === null ? null : Math.max(0, nowMs - pubMs);
    const poisonBit = Number(p.poison_bit ?? 0);
    const circuitState = p.circuit_state ?? "CLOSED";
    const { rawGap, gapBig, generationU32 } = parseManifestGapAndGeneration(p);
    totalGapCents += gapBig < 0n ? -gapBig : gapBig;

    const reasons: string[] = [];
    if (dataWinAgeMs === null) reasons.push("missing data_window_max_epoch_ms");
    else if (dataWinAgeMs > slaMs)
      reasons.push(`data_window age ${dataWinAgeMs}ms > sla ${slaMs}ms`);
    if (pubAgeMs === null) reasons.push("missing r2_published_at_epoch_ms");
    else if (pubAgeMs > slaMs)
      reasons.push(`published age ${pubAgeMs}ms > sla ${slaMs}ms`);
    if (poisonBit !== 0) reasons.push(`poison_bit=${poisonBit}`);
    if (circuitState !== "CLOSED")
      reasons.push(`circuit_state=${circuitState}`);
    if (gapBig !== 0n) reasons.push(`unresolved_gap_cents=${rawGap}`);

    const isFresh = reasons.length === 0;
    if (!isFresh) degradedCount++;

    sinks.push({
      sink_id: spec.sinkId,
      manifest_key: spec.manifestKey,
      lane: spec.lane,
      state: isFresh ? "fresh" : "stale",
      sla_ms: slaMs,
      generation_u32: generationU32,
      data_window_max_epoch_ms: dataWinMs,
      r2_published_at_epoch_ms: pubMs,
      data_window_age_ms: dataWinAgeMs,
      published_age_ms: pubAgeMs,
      poison_bit: poisonBit,
      circuit_state: circuitState,
      unresolved_gap_cents: rawGap,
      reason: isFresh ? "ok" : reasons.join("; "),
    });
  }

  return {
    schemaVersion: 1,
    command: "stale",
    domain: "[Ops & Governance]",
    r2_bucket: env.R2_BUCKET_NAME?.trim() || R2_BUCKET,
    observed_at_epoch_ms: nowMs,
    circuit_state: degradedCount === 0 ? "CLOSED" : "OPEN",
    unresolved_gap_cents: totalGapCents.toString(),
    degraded_count: degradedCount,
    ok: degradedCount === 0,
    sinks,
  };
}
