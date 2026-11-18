/**
 * @file lib/r2_chunk_manifest.ts
 * @description YAML manifest written next to each sealed R2 chunk, plus a per-stream latest
 * pointer promoted with the shared CAS writer in `lib/r2_manifest_cas.ts`.
 *
 * Keys: `manifests/<stream_id>/<slot>/<timestamp_ns>.yaml` (immutable, YAML) and
 * `manifests/<stream_id>/latest` (CAS pointer, JSON from `promoteCanonicalManifestWithCas`).
 * Consumers track the last generation they consumed in memory; nothing is written back to R2.
 */

import { z } from "zod";

import {
  promoteCanonicalManifestWithCas,
  writeContentAddressedChunkWithRetry,
  type CasR2ClientLike,
} from "./r2_manifest_cas.ts";
import type { R2GetObjectResult } from "./r2_s3_client.ts";
import { readStrictUtf8R2Object } from "./r2_text.ts";

/** Stream ids already published to `sportsdesk-ops-reports` (docs/INTEGRATION-SOURCES.md). */
export const LIVE_STREAM_IDS = ["f402-bet-ticker", "gslive-tally"] as const;

export type LiveStreamId = (typeof LIVE_STREAM_IDS)[number];

export const liveStreamIdSchema = z.enum(LIVE_STREAM_IDS);

export class ManifestInvalid extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManifestInvalid";
  }
}

export class ManifestStoreError extends Error {
  constructor(
    readonly operation: "get" | "put",
    readonly key: string,
    options?: ErrorOptions,
  ) {
    const reason =
      options?.cause instanceof Error
        ? options.cause.message
        : String(options?.cause);
    super(`manifest store ${operation} ${key} failed: ${reason}`, options);
    this.name = "ManifestStoreError";
  }
}

const SLOT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TIMESTAMP_NS_PATTERN = /^(0|[1-9]\d{0,19})$/;

const slotSchema = z.string().regex(SLOT_PATTERN, "invalid slot");
const timestampNsSchema = z
  .string()
  .regex(TIMESTAMP_NS_PATTERN, "timestamp_ns must be a decimal string");

export const chunkManifestSchema = z
  .object({
    version: z.literal(1),
    stream_id: liveStreamIdSchema,
    slot: slotSchema,
    timestamp_ns: timestampNsSchema,
    chunk_key: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 hex chars"),
    bytes: z.number().int().nonnegative(),
    wager_count: z.number().int().nonnegative(),
  })
  .strict();

export const latestPointerSchema = z
  .object({
    version: z.literal(1),
    stream_id: liveStreamIdSchema,
    generation_u32: z.number().int().min(1).max(0xffff_ffff),
    manifest_key: z.string().min(1),
    manifest: chunkManifestSchema,
  })
  .strict();

export type ChunkManifest = z.infer<typeof chunkManifestSchema>;
export type LatestPointer = z.infer<typeof latestPointerSchema>;

export interface SealedChunk {
  readonly stream_id: string;
  readonly slot: string;
  readonly timestamp_ns: bigint | string;
  readonly chunk_key: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly wager_count: number;
}

export interface ManifestReadOptions {
  readonly fetchImpl?: typeof fetch;
}

/** Read side: one GET per pointer read (`R2S3Client.getObject`). */
export interface ManifestR2Reader {
  getObject(
    key: string,
    options?: ManifestReadOptions,
  ): Promise<R2GetObjectResult>;
}

/** Write side: the shared CAS client plus the single-GET reader. */
export interface ManifestR2Client extends CasR2ClientLike, ManifestR2Reader {}

const YAML_CONTENT_TYPE = "application/yaml";

export function manifestKey(
  streamId: LiveStreamId,
  slot: string,
  timestampNs: string,
): string {
  return `manifests/${streamId}/${slot}/${timestampNs}.yaml`;
}

export function latestPointerKey(streamId: LiveStreamId): string {
  return `manifests/${streamId}/latest`;
}

function validate<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ManifestInvalid(`${label}: ${issues}`, { cause: parsed.error });
  }
  return parsed.data;
}

function timestampNsString(value: bigint | string): string {
  return typeof value === "bigint" ? value.toString() : value;
}

export function buildChunkManifest(chunk: SealedChunk): ChunkManifest {
  return validate(
    chunkManifestSchema,
    {
      version: 1,
      stream_id: chunk.stream_id,
      slot: chunk.slot,
      timestamp_ns: timestampNsString(chunk.timestamp_ns),
      chunk_key: chunk.chunk_key,
      sha256: chunk.sha256,
      bytes: chunk.bytes,
      wager_count: chunk.wager_count,
    },
    "chunk manifest",
  );
}

export type PointerRead =
  | { readonly state: "missing" }
  | { readonly state: "corrupt"; readonly error: ManifestInvalid }
  | {
      readonly state: "ok";
      readonly etag: string | null;
      readonly pointer: LatestPointer;
    };

async function getOnce(
  reader: ManifestR2Reader,
  key: string,
  options: ManifestReadOptions,
): Promise<R2GetObjectResult> {
  try {
    return await reader.getObject(key, options);
  } catch (cause) {
    throw new ManifestStoreError("get", key, { cause });
  }
}

function parsePointer(
  streamId: LiveStreamId,
  key: string,
  text: string,
): LatestPointer {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new ManifestInvalid(`${key}: not valid JSON`, { cause });
  }
  const pointer = validate(latestPointerSchema, value, key);
  if (
    pointer.stream_id !== streamId ||
    pointer.manifest.stream_id !== streamId
  ) {
    throw new ManifestInvalid(`${key}: pointer is not for ${streamId}`);
  }
  const expectedKey = manifestKey(
    streamId,
    pointer.manifest.slot,
    pointer.manifest.timestamp_ns,
  );
  if (pointer.manifest_key !== expectedKey) {
    throw new ManifestInvalid(
      `${key}: manifest_key ${pointer.manifest_key} does not match ${expectedKey}`,
    );
  }
  return pointer;
}

/**
 * One GET for the latest pointer. A 404 (including a delete that lands before or during the
 * request) is `missing`; bad bytes, JSON or schema are `corrupt`; backend failures throw.
 */
export async function readLatestPointer(
  reader: ManifestR2Reader,
  streamId: LiveStreamId,
  options: ManifestReadOptions = {},
): Promise<PointerRead> {
  const key = latestPointerKey(streamId);
  const read = await getOnce(reader, key, options);
  if (read.status === 404) return { state: "missing" };
  try {
    const text = await readStrictUtf8R2Object({
      bytes: async () => read.body,
    });
    return {
      state: "ok",
      etag: read.etag,
      pointer: parsePointer(streamId, key, text),
    };
  } catch (error) {
    const invalid =
      error instanceof ManifestInvalid
        ? error
        : new ManifestInvalid(`${key}: not valid UTF-8`, { cause: error });
    return { state: "corrupt", error: invalid };
  }
}

export interface WrittenManifest {
  readonly manifestKey: string;
  readonly latestKey: string;
  readonly manifest: ChunkManifest;
  /** Pointer generation after this write; unchanged when `latestAdvanced` is false. */
  readonly generation_u32: number;
  /** False when an existing pointer is newer, so an out-of-order chunk leaves it alone. */
  readonly latestAdvanced: boolean;
}

/**
 * Writes the chunk's YAML manifest, then promotes `manifests/<stream_id>/latest` with
 * If-Match (If-None-Match:* on first write). A 412 surfaces as `R2ManifestCasError`
 * (`ERR_R2_MANIFEST_CAS_REJECTED`); there is no silent rebase.
 */
export async function writeChunkManifest(
  client: ManifestR2Client,
  chunk: SealedChunk,
  options: ManifestReadOptions = {},
): Promise<WrittenManifest> {
  const manifest = buildChunkManifest(chunk);
  const streamId = manifest.stream_id;
  const key = manifestKey(streamId, manifest.slot, manifest.timestamp_ns);
  const latestKey = latestPointerKey(streamId);
  try {
    await client.write(key, Bun.YAML.stringify(manifest, null, 2), {
      type: YAML_CONTENT_TYPE,
    });
  } catch (cause) {
    throw new ManifestStoreError("put", key, { cause });
  }

  const current = await readLatestPointer(client, streamId, options);
  if (current.state === "corrupt") throw current.error;
  let prevETag: string | null = null;
  let generation = 0;
  if (current.state === "ok") {
    if (current.etag === null) {
      throw new ManifestStoreError("get", latestKey, {
        cause: new Error("pointer has no ETag to CAS against"),
      });
    }
    if (
      BigInt(current.pointer.manifest.timestamp_ns) >
      BigInt(manifest.timestamp_ns)
    ) {
      return {
        manifestKey: key,
        latestKey,
        manifest,
        generation_u32: current.pointer.generation_u32,
        latestAdvanced: false,
      };
    }
    prevETag = current.etag;
    generation = current.pointer.generation_u32;
  }

  const pointer: LatestPointer = {
    version: 1,
    stream_id: streamId,
    generation_u32: generation + 1,
    manifest_key: key,
    manifest,
  };
  await promoteCanonicalManifestWithCas({
    client,
    sinkId: streamId,
    manifestKey: latestKey,
    prevETag,
    nextGenerationU32: pointer.generation_u32,
    merkleRootSha256: manifest.sha256,
    manifest: pointer,
    ...(options.fetchImpl === undefined
      ? {}
      : { fetchImpl: options.fetchImpl }),
  });
  return {
    manifestKey: key,
    latestKey,
    manifest,
    generation_u32: pointer.generation_u32,
    latestAdvanced: true,
  };
}

export interface ChunkToSeal {
  readonly bytes: Uint8Array;
  readonly stream_id: string;
  readonly slot: string;
  readonly timestamp_ns: bigint | string;
  readonly wager_count: number;
}

/** Content-addressed chunk upload followed by its manifest and CAS latest pointer. */
export async function sealChunkWithManifest(
  client: ManifestR2Client,
  chunk: ChunkToSeal,
  options?: Parameters<typeof writeContentAddressedChunkWithRetry>[2] &
    ManifestReadOptions,
): Promise<WrittenManifest> {
  validate(
    chunkManifestSchema.pick({
      stream_id: true,
      slot: true,
      timestamp_ns: true,
      wager_count: true,
    }),
    {
      stream_id: chunk.stream_id,
      slot: chunk.slot,
      timestamp_ns: timestampNsString(chunk.timestamp_ns),
      wager_count: chunk.wager_count,
    },
    "chunk to seal",
  );
  const written = await writeContentAddressedChunkWithRetry(
    client,
    chunk.bytes,
    options,
  );
  return writeChunkManifest(
    client,
    {
      stream_id: chunk.stream_id,
      slot: chunk.slot,
      timestamp_ns: chunk.timestamp_ns,
      chunk_key: written.chunkKey,
      sha256: written.merkleRootSha256,
      bytes: written.byteLength,
      wager_count: chunk.wager_count,
    },
    options?.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
  );
}

export type StreamState =
  | {
      readonly status: "active";
      readonly generation_u32: number;
      readonly manifest: ChunkManifest;
    }
  | { readonly status: "missing" }
  | { readonly status: "corrupt"; readonly error: ManifestInvalid }
  | { readonly status: "stale"; readonly generation_u32: number };

/**
 * Per-consumer view of the latest pointers. The last consumed generation lives in this
 * instance only, so one consumer reading a stream never hides it from another.
 */
export class LiveStreamConsumer {
  readonly #lastGeneration = new Map<LiveStreamId, number>();

  constructor(
    private readonly reader: ManifestR2Reader,
    private readonly options: ManifestReadOptions = {},
  ) {}

  lastConsumedGeneration(streamId: LiveStreamId): number | undefined {
    return this.#lastGeneration.get(streamId);
  }

  async poll(streamId: LiveStreamId): Promise<StreamState> {
    const read = await readLatestPointer(this.reader, streamId, this.options);
    if (read.state === "missing") return { status: "missing" };
    if (read.state === "corrupt") {
      return { status: "corrupt", error: read.error };
    }
    const generation = read.pointer.generation_u32;
    const last = this.#lastGeneration.get(streamId);
    if (last !== undefined && generation <= last) {
      return { status: "stale", generation_u32: generation };
    }
    this.#lastGeneration.set(streamId, generation);
    return {
      status: "active",
      generation_u32: generation,
      manifest: read.pointer.manifest,
    };
  }
}

export const NO_ACTIVE_STREAM = "NO ACTIVE STREAM" as const;

export type StreamTelemetryEntry =
  | {
      readonly stream_id: LiveStreamId;
      readonly status: "ACTIVE";
      readonly generation_u32: number;
      readonly slot: string;
      readonly timestamp_ns: string;
      readonly wager_count: number;
      readonly bytes: number;
    }
  | {
      readonly stream_id: LiveStreamId;
      readonly status: typeof NO_ACTIVE_STREAM;
      readonly reason: "missing" | "corrupt" | "stale";
    };

export function streamTelemetryEntry(
  streamId: LiveStreamId,
  state: StreamState,
): StreamTelemetryEntry {
  if (state.status !== "active") {
    return {
      stream_id: streamId,
      status: NO_ACTIVE_STREAM,
      reason: state.status,
    };
  }
  return {
    stream_id: streamId,
    status: "ACTIVE",
    generation_u32: state.generation_u32,
    slot: state.manifest.slot,
    timestamp_ns: state.manifest.timestamp_ns,
    wager_count: state.manifest.wager_count,
    bytes: state.manifest.bytes,
  };
}

export async function loadStreamTelemetry(
  consumer: LiveStreamConsumer,
  streamIds: readonly LiveStreamId[],
): Promise<readonly StreamTelemetryEntry[]> {
  return Promise.all(
    streamIds.map(async (streamId) =>
      streamTelemetryEntry(streamId, await consumer.poll(streamId)),
    ),
  );
}
