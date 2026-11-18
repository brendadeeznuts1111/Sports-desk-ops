/**
 * @file lib/r2_chunk_manifest.ts
 * @description YAML manifest written next to each sealed R2 chunk, plus a per-channel latest
 * pointer, behind a small `ManifestStore` so tests never touch R2.
 *
 * Keys: `<prefix>/<channel>/<slot>/<timestamp_ns>.yaml` and `<prefix>/<channel>/latest.yaml`.
 */

import { join } from "node:path";
import { z } from "zod";

import {
  writeContentAddressedChunkWithRetry,
  type CasR2ClientLike,
} from "./r2_manifest_cas.ts";
import { readStrictUtf8R2Object } from "./r2_text.ts";

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

const CHANNEL_PATTERN = /^[a-z0-9-]{1,32}$/;
const SLOT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TIMESTAMP_NS_PATTERN = /^(0|[1-9]\d{0,19})$/;
const PREFIX_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_-]*(\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

const channelSchema = z.string().regex(CHANNEL_PATTERN, "invalid channel");
const slotSchema = z.string().regex(SLOT_PATTERN, "invalid slot");
const timestampNsSchema = z
  .string()
  .regex(TIMESTAMP_NS_PATTERN, "timestamp_ns must be a decimal string");

export const chunkManifestSchema = z
  .object({
    version: z.literal(1),
    channel: channelSchema,
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
    channel: channelSchema,
    slot: slotSchema,
    timestamp_ns: timestampNsSchema,
    manifest_key: z.string().min(1),
  })
  .strict();

export type ChunkManifest = z.infer<typeof chunkManifestSchema>;
export type LatestPointer = z.infer<typeof latestPointerSchema>;

export interface SealedChunk {
  readonly channel: string;
  readonly slot: string;
  readonly timestamp_ns: bigint | string;
  readonly chunk_key: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly wager_count: number;
}

export interface ManifestStore {
  put(key: string, yaml: string): Promise<void>;
  /** `null` when the object does not exist. */
  get(key: string): Promise<Response | null>;
}

/** The subset of `Bun.S3Client` the R2 manifest store uses. */
export interface S3ManifestBackend {
  write(
    path: string,
    data: string,
    options?: { readonly type?: string },
  ): Promise<number | undefined>;
  file(path: string): {
    exists(): Promise<boolean>;
    stream(): ReadableStream<Uint8Array>;
  };
}

const YAML_CONTENT_TYPE = "application/yaml";

export class S3ManifestStore implements ManifestStore {
  constructor(private readonly client: S3ManifestBackend) {}

  async put(key: string, yaml: string): Promise<void> {
    try {
      await this.client.write(key, yaml, { type: YAML_CONTENT_TYPE });
    } catch (cause) {
      throw new ManifestStoreError("put", key, { cause });
    }
  }

  async get(key: string): Promise<Response | null> {
    try {
      const file = this.client.file(key);
      if (!(await file.exists())) return null;
      return new Response(file.stream(), {
        headers: { "content-type": YAML_CONTENT_TYPE },
      });
    } catch (cause) {
      throw new ManifestStoreError("get", key, { cause });
    }
  }
}

export class LocalDirManifestStore implements ManifestStore {
  constructor(readonly root: string) {}

  async put(key: string, yaml: string): Promise<void> {
    try {
      await Bun.write(join(this.root, key), yaml);
    } catch (cause) {
      throw new ManifestStoreError("put", key, { cause });
    }
  }

  async get(key: string): Promise<Response | null> {
    try {
      const file = Bun.file(join(this.root, key));
      if (!(await file.exists())) return null;
      return new Response(file);
    } catch (cause) {
      throw new ManifestStoreError("get", key, { cause });
    }
  }
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, "");
  if (!PREFIX_PATTERN.test(trimmed)) {
    throw new ManifestInvalid(`invalid manifest_prefix: ${prefix}`);
  }
  return trimmed;
}

export function manifestKey(
  prefix: string,
  channel: string,
  slot: string,
  timestampNs: string,
): string {
  return `${normalizePrefix(prefix)}/${channel}/${slot}/${timestampNs}.yaml`;
}

export function latestPointerKey(prefix: string, channel: string): string {
  return `${normalizePrefix(prefix)}/${channel}/latest.yaml`;
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
      channel: chunk.channel,
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

async function readYaml(
  store: ManifestStore,
  key: string,
): Promise<
  | { readonly state: "missing" }
  | { readonly state: "consumed" }
  | { readonly state: "ok"; readonly value: unknown }
> {
  const response = await store.get(key);
  if (response === null) return { state: "missing" };
  if (response.bodyUsed) return { state: "consumed" };
  let text: string;
  try {
    text = await readStrictUtf8R2Object({ bytes: () => response.bytes() });
  } catch (cause) {
    throw new ManifestStoreError("get", key, { cause });
  }
  try {
    return { state: "ok", value: Bun.YAML.parse(text) };
  } catch (cause) {
    throw new ManifestInvalid(`${key}: not valid YAML`, { cause });
  }
}

export interface WrittenManifest {
  readonly manifestKey: string;
  readonly latestKey: string;
  readonly manifest: ChunkManifest;
  /** False when an existing pointer is newer, so an out-of-order chunk leaves it alone. */
  readonly latestAdvanced: boolean;
}

export async function writeChunkManifest(
  store: ManifestStore,
  prefix: string,
  chunk: SealedChunk,
): Promise<WrittenManifest> {
  const manifest = buildChunkManifest(chunk);
  const key = manifestKey(
    prefix,
    manifest.channel,
    manifest.slot,
    manifest.timestamp_ns,
  );
  const latestKey = latestPointerKey(prefix, manifest.channel);
  await store.put(key, Bun.YAML.stringify(manifest, null, 2));

  const current = await readYaml(store, latestKey);
  if (current.state === "ok") {
    const pointer = validate(latestPointerSchema, current.value, latestKey);
    if (BigInt(pointer.timestamp_ns) > BigInt(manifest.timestamp_ns)) {
      return { manifestKey: key, latestKey, manifest, latestAdvanced: false };
    }
  }
  const pointer: LatestPointer = {
    version: 1,
    channel: manifest.channel,
    slot: manifest.slot,
    timestamp_ns: manifest.timestamp_ns,
    manifest_key: key,
  };
  await store.put(latestKey, Bun.YAML.stringify(pointer, null, 2));
  return { manifestKey: key, latestKey, manifest, latestAdvanced: true };
}

export interface ChunkToSeal {
  readonly bytes: Uint8Array;
  readonly channel: string;
  readonly slot: string;
  readonly timestamp_ns: bigint | string;
  readonly wager_count: number;
}

/** Content-addressed chunk upload followed by its manifest and latest pointer. */
export async function sealChunkWithManifest(
  client: CasR2ClientLike,
  store: ManifestStore,
  prefix: string,
  chunk: ChunkToSeal,
  options?: Parameters<typeof writeContentAddressedChunkWithRetry>[2],
): Promise<WrittenManifest> {
  validate(
    chunkManifestSchema.pick({
      channel: true,
      slot: true,
      timestamp_ns: true,
      wager_count: true,
    }),
    {
      channel: chunk.channel,
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
  return writeChunkManifest(store, prefix, {
    channel: chunk.channel,
    slot: chunk.slot,
    timestamp_ns: chunk.timestamp_ns,
    chunk_key: written.chunkKey,
    sha256: written.merkleRootSha256,
    bytes: written.byteLength,
    wager_count: chunk.wager_count,
  });
}

export type StreamState =
  | { readonly status: "active"; readonly manifest: ChunkManifest }
  | { readonly status: "missing" }
  | { readonly status: "body-used" };

export async function readLatestStream(
  store: ManifestStore,
  prefix: string,
  channel: string,
): Promise<StreamState> {
  const latestKey = latestPointerKey(
    prefix,
    validate(channelSchema, channel, "channel"),
  );
  const pointerRead = await readYaml(store, latestKey);
  if (pointerRead.state === "missing") return { status: "missing" };
  if (pointerRead.state === "consumed") return { status: "body-used" };
  const pointer = validate(latestPointerSchema, pointerRead.value, latestKey);
  if (pointer.channel !== channel) {
    throw new ManifestInvalid(
      `${latestKey}: pointer is for channel ${pointer.channel}`,
    );
  }
  const manifestRead = await readYaml(store, pointer.manifest_key);
  if (manifestRead.state === "missing") return { status: "missing" };
  if (manifestRead.state === "consumed") return { status: "body-used" };
  const manifest = validate(
    chunkManifestSchema,
    manifestRead.value,
    pointer.manifest_key,
  );
  if (
    manifest.channel !== pointer.channel ||
    manifest.slot !== pointer.slot ||
    manifest.timestamp_ns !== pointer.timestamp_ns
  ) {
    throw new ManifestInvalid(
      `${pointer.manifest_key}: manifest does not match ${latestKey}`,
    );
  }
  return { status: "active", manifest };
}

export const NO_ACTIVE_STREAM = "NO ACTIVE STREAM" as const;

export type StreamTelemetryEntry =
  | {
      readonly channel: string;
      readonly status: "ACTIVE";
      readonly slot: string;
      readonly timestamp_ns: string;
      readonly wager_count: number;
      readonly bytes: number;
    }
  | {
      readonly channel: string;
      readonly status: typeof NO_ACTIVE_STREAM;
      readonly reason: "missing" | "body-used";
    };

export function streamTelemetryEntry(
  channel: string,
  state: StreamState,
): StreamTelemetryEntry {
  if (state.status !== "active") {
    return { channel, status: NO_ACTIVE_STREAM, reason: state.status };
  }
  return {
    channel,
    status: "ACTIVE",
    slot: state.manifest.slot,
    timestamp_ns: state.manifest.timestamp_ns,
    wager_count: state.manifest.wager_count,
    bytes: state.manifest.bytes,
  };
}

export async function loadStreamTelemetry(
  store: ManifestStore,
  prefix: string,
  channels: readonly string[],
): Promise<readonly StreamTelemetryEntry[]> {
  return Promise.all(
    channels.map(async (channel) =>
      streamTelemetryEntry(
        channel,
        await readLatestStream(store, prefix, channel),
      ),
    ),
  );
}
