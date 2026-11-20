/**
 * @file src/utils/r2_manifest_loader.ts
 * @description Stage-gated, TOCTOU-resistant loader and credential-sealed client
 * for signed/digested YAML manifests stored in Cloudflare R2 via `Bun.S3Client`.
 */

import { S3Client, type S3Stats } from "bun";
import { timingSafeEqual } from "node:crypto";
import {
  parseHardenedYaml,
  type HardenedYamlOptions,
} from "./hardened_yaml.ts";

export type R2ManifestErrorCode =
  | "ERR_R2_INVALID_KEY"
  | "ERR_R2_INVALID_DIGEST"
  | "ERR_R2_INVALID_ENDPOINT"
  | "ERR_R2_INVALID_CREDENTIALS"
  | "ERR_R2_EMPTY_OBJECT"
  | "ERR_R2_BYTE_LIMIT"
  | "ERR_R2_SIZE_MISMATCH"
  | "ERR_R2_ETAG_MISMATCH"
  | "ERR_R2_STALE_OBJECT"
  | "ERR_R2_TIMEOUT"
  | "ERR_R2_TRANSPORT_ERROR"
  | "ERR_R2_SHA256_MISMATCH"
  | "ERR_R2_INVALID_UTF8";

export class R2ManifestError extends Error {
  readonly code: R2ManifestErrorCode;

  constructor(code: R2ManifestErrorCode, message: string, cause?: unknown) {
    super(`${code}: ${message}`, cause !== undefined ? { cause } : undefined);
    this.name = "R2ManifestError";
    this.code = code;
  }
}

export class SecretLeakError extends Error {
  readonly code = "ERR_SECRET_LEAK" as const;

  constructor(message: string) {
    super(message);
    this.name = "SecretLeakError";
  }
}

/** Structural subset of Bun.S3Client for zero-network fault-injection tests. */
export interface R2ManifestClient {
  stat(path: string): Promise<Pick<S3Stats, "size" | "etag" | "lastModified">>;
  file(path: string): { stream(): ReadableStream<Uint8Array> };
}

export interface ScopedR2ClientEnv {
  readonly bucket?: string | undefined;
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
  /** Permit plain `http:` endpoints (local test harnesses only). Default: false (`https:` required). */
  readonly allowInsecureHttp?: boolean | undefined;
}

export interface LoadR2ManifestOptions {
  /** Expected lowercase or uppercase 64-char hex SHA-256 digest of the raw R2 object. */
  readonly expectedSha256: string;
  /** Exact expected byte length (optional; checked on both HEAD and GET). */
  readonly expectedBytes?: number | undefined;
  /** Optional strong ETag pinned against Stage 1 HEAD (`stat.etag`). Rejects weak `W/` tags. */
  readonly expectedEtag?: string | undefined;
  /** Maximum permitted object age relative to `nowMs` (checked on Stage 1 `stat.lastModified`). */
  readonly maxAgeMs?: number | undefined;
  /** Override current epoch milliseconds for deterministic `maxAgeMs` staleness checks. */
  readonly nowMs?: number | undefined;
  /** Hard byte ceiling enforced on both HEAD and GET. Default: 1 MiB. */
  readonly maxBytes?: number | undefined;
  /** Maximum stream chunks permitted in Stage 2 (defeats 0-byte chunk floods). */
  readonly maxChunks?: number | undefined;
  /** Combined deadline (ms) for Stage 1 HEAD and Stage 2 GET read. Default: 30,000 ms. */
  readonly timeoutMs?: number | undefined;
  /** Required key prefix (e.g., "manifests/"). */
  readonly requiredPrefix?: string | undefined;
  /** Forwarded to parseHardenedYaml. */
  readonly yamlOptions?: HardenedYamlOptions | undefined;
}

export interface VerifiedR2Manifest {
  readonly key: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly etag: string;
  readonly lastModified: Date;
  readonly manifest: Record<string, unknown>;
}

const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_KEY_BYTES = 1_024;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const PCT_TRAVERSAL_RE = /%(?:2e|2f|5c|00)/i;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function hasAsciiControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Strip ANSI CSI (`ESC [`) and OSC (`ESC ]`) escape sequences without control-char regexes.
 */
function stripAnsiSequences(input: string): string {
  if (!input.includes("\u001b")) return input;
  let out = "";
  let i = 0;
  const len = input.length;

  while (i < len) {
    const code = input.charCodeAt(i);
    if (code === 0x1b && i + 1 < len) {
      const next = input.charCodeAt(i + 1);
      if (next === 0x5b) {
        // CSI sequence: ESC [ ... [@-~]
        let j = i + 2;
        while (j < len) {
          const b = input.charCodeAt(j);
          if (b >= 0x40 && b <= 0x7e) {
            j++;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }
      if (next === 0x5d) {
        // OSC sequence: ESC ] ... BEL or ST (ESC \)
        let j = i + 2;
        while (j < len) {
          const b = input.charCodeAt(j);
          if (b === 0x07) {
            j++;
            break;
          }
          if (b === 0x1b && j + 1 < len && input.charCodeAt(j + 1) === 0x5c) {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }
    }
    out += input.charAt(i);
    i++;
  }
  return out;
}

interface SecretRepresentation {
  readonly kind: "raw" | "url-encoded" | "base64" | "base64url" | "hex";
  readonly needle: string;
  readonly caseInsensitive: boolean;
}

function buildSecretRepresentations(secret: string): SecretRepresentation[] {
  const out: SecretRepresentation[] = [
    { kind: "raw", needle: secret, caseInsensitive: false },
  ];
  // Very short 1-2 byte values collide on unrelated hex/base64 substrings; still checked raw.
  if (secret.length < 3) {
    return out;
  }
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) {
    out.push({ kind: "url-encoded", needle: encoded, caseInsensitive: false });
  }
  const buf = Buffer.from(secret, "utf8");
  out.push({
    kind: "base64",
    needle: buf.toString("base64"),
    caseInsensitive: false,
  });
  out.push({
    kind: "base64url",
    needle: buf.toString("base64url"),
    caseInsensitive: false,
  });
  out.push({
    kind: "hex",
    needle: buf.toString("hex").toLowerCase(),
    caseInsensitive: true,
  });
  return out;
}

/**
 * Assert `surface` contains no raw, ANSI-split, URL-encoded, Base64, Base64URL, or
 * hex-encoded representations of any active secret. Error messages never echo secret text.
 */
export function assertNoSecretLeak(
  surface: string,
  label: string,
  activeSecrets: readonly string[],
): void {
  const stripped = stripAnsiSequences(surface);
  const candidates = stripped === surface ? [surface] : [surface, stripped];

  for (let idx = 0; idx < activeSecrets.length; idx++) {
    const secret = activeSecrets[idx];
    if (secret === undefined || secret.length === 0) continue;
    const reps = buildSecretRepresentations(secret);
    for (const candidate of candidates) {
      let lowerCandidate: string | undefined;
      for (const rep of reps) {
        if (rep.caseInsensitive) {
          lowerCandidate ??= candidate.toLowerCase();
          if (lowerCandidate.includes(rep.needle)) {
            throw new SecretLeakError(
              `ERR_SECRET_LEAK: inspected surface "${label}" leaked active secret #${idx} (${rep.kind})`,
            );
          }
        } else if (candidate.includes(rep.needle)) {
          throw new SecretLeakError(
            `ERR_SECRET_LEAK: inspected surface "${label}" leaked active secret #${idx} (${rep.kind})`,
          );
        }
      }
    }
  }
}

function scrubSecretsFromText(
  text: string,
  activeSecrets: readonly string[],
): string {
  let cleaned = stripAnsiSequences(text).replaceAll(
    /(https?:\/\/)[^/\s@]+@/gi,
    "$1[REDACTED]@",
  );
  for (const secret of activeSecrets) {
    if (secret.length === 0) continue;
    for (const rep of buildSecretRepresentations(secret)) {
      if (rep.caseInsensitive) {
        const idx = cleaned.toLowerCase().indexOf(rep.needle);
        if (idx !== -1) {
          cleaned = cleaned.replace(
            new RegExp(rep.needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
            "[REDACTED]",
          );
        }
      } else if (cleaned.includes(rep.needle)) {
        cleaned = cleaned.replaceAll(rep.needle, "[REDACTED]");
      }
    }
  }
  return cleaned;
}

function assertSafeEndpoint(
  endpoint: string,
  allowInsecureHttp: boolean,
): { readonly parsedUrl: URL; readonly host: string } {
  if (hasAsciiControlChar(endpoint)) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_ENDPOINT",
      "R2 endpoint URL contains disallowed control characters",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch (err) {
    // Do not echo the raw endpoint string in case it contained credentials.
    throw new R2ManifestError(
      "ERR_R2_INVALID_ENDPOINT",
      "R2 endpoint must be a valid URL",
      err instanceof Error ? new Error(err.name) : undefined,
    );
  }
  const allowedScheme =
    parsed.protocol === "https:" ||
    (allowInsecureHttp && parsed.protocol === "http:");
  if (!allowedScheme) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_ENDPOINT",
      `Unsupported R2 endpoint scheme "${parsed.protocol}"`,
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_ENDPOINT",
      "R2 endpoint URL must not embed username or password credentials",
    );
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_ENDPOINT",
      "R2 endpoint URL must not contain query parameters or fragments",
    );
  }
  if (parsed.host.length === 0) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_ENDPOINT",
      "R2 endpoint URL must include a non-empty host",
    );
  }
  return { parsedUrl: parsed, host: parsed.host };
}

function assertSafeCredentials(env: ScopedR2ClientEnv): void {
  if (
    env.accessKeyId.length === 0 ||
    env.accessKeyId.trim() !== env.accessKeyId ||
    hasAsciiControlChar(env.accessKeyId)
  ) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_CREDENTIALS",
      "R2 accessKeyId must be a non-empty trimmed string without control characters",
    );
  }
  if (
    env.secretAccessKey.length === 0 ||
    env.secretAccessKey.trim() !== env.secretAccessKey ||
    hasAsciiControlChar(env.secretAccessKey)
  ) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_CREDENTIALS",
      "R2 secretAccessKey must be a non-empty trimmed string without control characters",
    );
  }
  if (
    env.sessionToken !== undefined &&
    (env.sessionToken.length === 0 ||
      env.sessionToken.trim() !== env.sessionToken ||
      hasAsciiControlChar(env.sessionToken))
  ) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_CREDENTIALS",
      "R2 sessionToken must be a non-empty trimmed string without control characters",
    );
  }
}

function sanitizeKeyForMessage(key: string): string {
  let out = "";
  const limit = Math.min(key.length, 128);
  for (let i = 0; i < limit; i++) {
    const code = key.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? "?" : key.charAt(i);
  }
  return key.length > limit ? `${out}...` : out;
}

function assertSafeKey(key: string, requiredPrefix: string | undefined): void {
  const keyBytes = Buffer.byteLength(key, "utf8");
  if (
    key.length === 0 ||
    keyBytes > MAX_KEY_BYTES ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("//") ||
    key.includes("..") ||
    key.includes("\\") ||
    hasAsciiControlChar(key) ||
    PCT_TRAVERSAL_RE.test(key)
  ) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_KEY",
      `Unsafe R2 object key: "${sanitizeKeyForMessage(key)}"`,
    );
  }
  if (requiredPrefix !== undefined && !key.startsWith(requiredPrefix)) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_KEY",
      `Key "${sanitizeKeyForMessage(key)}" does not match required prefix "${requiredPrefix}"`,
    );
  }
}

function decodeHex32(hex: string): Uint8Array {
  if (!SHA256_HEX_RE.test(hex)) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_DIGEST",
      "expectedSha256 must be a 64-character hex string",
    );
  }
  return Buffer.from(hex, "hex");
}

function hasUnsupportedBom(raw: Uint8Array): boolean {
  return (
    (raw[0] === 0xff && raw[1] === 0xfe) ||
    (raw[0] === 0xfe && raw[1] === 0xff) ||
    (raw[0] === 0x00 && raw[1] === 0x00 && raw[2] === 0xfe && raw[3] === 0xff)
  );
}

async function raceWithDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => string,
): Promise<T> {
  if (timeoutMs <= 0) {
    throw new R2ManifestError("ERR_R2_TIMEOUT", onTimeout());
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new R2ManifestError("ERR_R2_TIMEOUT", onTimeout()));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
  limits: {
    readonly maxBytes: number;
    readonly maxChunks: number;
    readonly deadlineMs: number;
    readonly keyLabel: string;
  },
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;

  try {
    while (true) {
      const remainingMs = limits.deadlineMs - Date.now();
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await raceWithDeadline(
          reader.read(),
          remainingMs,
          () => `R2 GET stream timed out for "${limits.keyLabel}"`,
        );
      } catch (err) {
        if (err instanceof R2ManifestError && err.code === "ERR_R2_TIMEOUT") {
          await reader.cancel("ERR_R2_TIMEOUT");
        }
        throw err;
      }

      if (result.done) break;
      const value = result.value;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel("ERR_R2_SIZE_MISMATCH");
        throw new R2ManifestError(
          "ERR_R2_SIZE_MISMATCH",
          "R2 stream yielded a non-Uint8Array chunk",
        );
      }

      chunkCount += 1;
      if (chunkCount > limits.maxChunks) {
        await reader.cancel("ERR_R2_BYTE_LIMIT");
        throw new R2ManifestError(
          "ERR_R2_BYTE_LIMIT",
          `R2 stream exceeded maximum chunk count of ${limits.maxChunks}`,
        );
      }

      total += value.byteLength;
      if (total > limits.maxBytes) {
        await reader.cancel("ERR_R2_BYTE_LIMIT");
        throw new R2ManifestError(
          "ERR_R2_BYTE_LIMIT",
          `R2 stream exceeded byte ceiling of ${limits.maxBytes} bytes`,
        );
      }

      // Immediately copy into an owned buffer to defeat mutable ArrayBuffer reuse / TOCTOU.
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      chunks.push(copy);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 1) {
    const only = chunks[0];
    if (only !== undefined && only.byteLength === total) {
      return only;
    }
  }

  const out = new Uint8Array(Math.max(total, 0));
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk === undefined) continue;
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function createScopedR2Client(env: ScopedR2ClientEnv): S3Client {
  const { parsedUrl } = assertSafeEndpoint(
    env.endpoint,
    env.allowInsecureHttp === true,
  );
  assertSafeCredentials(env);
  return new S3Client({
    bucket: env.bucket ?? "sportsdesk-ops-reports",
    endpoint: parsedUrl.origin,
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    ...(env.sessionToken !== undefined
      ? { sessionToken: env.sessionToken }
      : {}),
  });
}

/**
 * Credential-sealed `R2ManifestClient` wrapper holding the underlying client and
 * scrub list in `#private` fields so `Bun.inspect`, `util.inspect`, `JSON.stringify`,
 * reflection APIs, and scrubbed transport errors cannot surface secret material.
 */
export class SealedR2ManifestClient implements R2ManifestClient {
  readonly #backend: R2ManifestClient;
  readonly #bucket: string;
  readonly #endpointHost: string;
  readonly #scrubSecrets: readonly string[];

  private constructor(
    backend: R2ManifestClient,
    bucket: string,
    endpointHost: string,
    scrubSecrets: readonly string[],
  ) {
    this.#backend = backend;
    this.#bucket = bucket;
    this.#endpointHost = endpointHost;
    this.#scrubSecrets = [...scrubSecrets];
    Object.freeze(this.#scrubSecrets);
    Object.freeze(this);
  }

  static create(env: ScopedR2ClientEnv): SealedR2ManifestClient {
    const { host } = assertSafeEndpoint(
      env.endpoint,
      env.allowInsecureHttp === true,
    );
    const client = createScopedR2Client(env);
    const scrub = [
      env.accessKeyId,
      env.secretAccessKey,
      ...(env.sessionToken !== undefined ? [env.sessionToken] : []),
    ];
    return new SealedR2ManifestClient(
      client,
      env.bucket ?? "sportsdesk-ops-reports",
      host,
      scrub,
    );
  }

  static fromBackend(
    backend: R2ManifestClient,
    options?: {
      readonly bucket?: string | undefined;
      readonly endpoint?: string | undefined;
      readonly allowInsecureHttp?: boolean | undefined;
      readonly activeSecrets?: readonly string[] | undefined;
    },
  ): SealedR2ManifestClient {
    const host =
      options?.endpoint !== undefined
        ? assertSafeEndpoint(
            options.endpoint,
            options.allowInsecureHttp === true,
          ).host
        : "mock.r2.local";
    return new SealedR2ManifestClient(
      backend,
      options?.bucket ?? "sportsdesk-ops-reports",
      host,
      options?.activeSecrets ?? [],
    );
  }

  get bucket(): string {
    return this.#bucket;
  }

  get endpointHost(): string {
    return this.#endpointHost;
  }

  get [Symbol.toStringTag](): string {
    return "SealedR2ManifestClient";
  }

  #scrubTransportError(
    stage: "stat" | "stream",
    err: unknown,
  ): R2ManifestError {
    if (err instanceof R2ManifestError) {
      return new R2ManifestError(
        err.code,
        scrubSecretsFromText(err.message, this.#scrubSecrets),
      );
    }
    const rawMsg = err instanceof Error ? err.message : String(err);
    const safeMsg = scrubSecretsFromText(rawMsg, this.#scrubSecrets);
    return new R2ManifestError(
      "ERR_R2_TRANSPORT_ERROR",
      `R2 ${stage} failed against "${this.#endpointHost}": ${safeMsg}`,
    );
  }

  async stat(
    path: string,
  ): Promise<Pick<S3Stats, "size" | "etag" | "lastModified">> {
    try {
      const info = await this.#backend.stat(path);
      return {
        size: info.size,
        etag: info.etag,
        lastModified: info.lastModified,
      };
    } catch (err) {
      throw this.#scrubTransportError("stat", err);
    }
  }

  file(path: string): { stream(): ReadableStream<Uint8Array> } {
    const backend = this.#backend;
    const scrub = (err: unknown) => this.#scrubTransportError("stream", err);
    const handle = {
      stream(): ReadableStream<Uint8Array> {
        try {
          return backend.file(path).stream();
        } catch (err) {
          throw scrub(err);
        }
      },
      [Bun.inspect.custom](): string {
        return `SealedR2File { path: ${JSON.stringify(sanitizeKeyForMessage(path))} }`;
      },
      toString(): string {
        return handle[Bun.inspect.custom]();
      },
    };
    return Object.freeze(handle);
  }

  [Bun.inspect.custom](): string {
    return `SealedR2ManifestClient { bucket: ${JSON.stringify(this.#bucket)}, endpointHost: ${JSON.stringify(this.#endpointHost)}, credentials: "[REDACTED]" }`;
  }

  toJSON(): {
    readonly type: "SealedR2ManifestClient";
    readonly bucket: string;
    readonly endpointHost: string;
    readonly credentials: "[REDACTED]";
  } {
    return {
      type: "SealedR2ManifestClient",
      bucket: this.#bucket,
      endpointHost: this.#endpointHost,
      credentials: "[REDACTED]",
    };
  }

  toString(): string {
    return this[Bun.inspect.custom]();
  }
}

export function createSealedR2ManifestClient(
  env: ScopedR2ClientEnv,
): SealedR2ManifestClient {
  return SealedR2ManifestClient.create(env);
}

export async function loadVerifiedR2Manifest(
  client: R2ManifestClient,
  key: string,
  options: LoadR2ManifestOptions,
): Promise<VerifiedR2Manifest> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new R2ManifestError(
      "ERR_R2_BYTE_LIMIT",
      `maxBytes must be a positive safe integer, got ${maxBytes}`,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new R2ManifestError(
      "ERR_R2_TIMEOUT",
      `timeoutMs must be a positive safe integer, got ${timeoutMs}`,
    );
  }
  const defaultMaxChunks = Math.max(4_096, Math.ceil(maxBytes / 256));
  const maxChunks = options.maxChunks ?? defaultMaxChunks;
  if (!Number.isSafeInteger(maxChunks) || maxChunks <= 0) {
    throw new R2ManifestError(
      "ERR_R2_BYTE_LIMIT",
      `maxChunks must be a positive safe integer, got ${maxChunks}`,
    );
  }
  if (
    options.expectedBytes !== undefined &&
    (!Number.isSafeInteger(options.expectedBytes) || options.expectedBytes < 0)
  ) {
    throw new R2ManifestError(
      "ERR_R2_SIZE_MISMATCH",
      `expectedBytes must be a non-negative safe integer, got ${options.expectedBytes}`,
    );
  }
  if (
    options.maxAgeMs !== undefined &&
    (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0)
  ) {
    throw new R2ManifestError(
      "ERR_R2_STALE_OBJECT",
      `maxAgeMs must be a non-negative finite number, got ${options.maxAgeMs}`,
    );
  }

  // Stage 0: Preflight key & digest format before any network I/O
  assertSafeKey(key, options.requiredPrefix);
  const expectedDigest = decodeHex32(options.expectedSha256);
  const safeKeyLabel = sanitizeKeyForMessage(key);
  const deadlineMs = Date.now() + timeoutMs;

  // Stage 1: HEAD metadata pre-check before downloading payload bytes
  const stat = await raceWithDeadline(
    client.stat(key),
    deadlineMs - Date.now(),
    () => `R2 HEAD stat timed out for "${safeKeyLabel}"`,
  );
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    throw new R2ManifestError(
      "ERR_R2_SIZE_MISMATCH",
      `Invalid R2 HEAD size ${String(stat.size)} for "${safeKeyLabel}"`,
    );
  }
  if (stat.size === 0) {
    throw new R2ManifestError(
      "ERR_R2_EMPTY_OBJECT",
      `R2 object "${safeKeyLabel}" is empty`,
    );
  }
  if (stat.size > maxBytes) {
    throw new R2ManifestError(
      "ERR_R2_BYTE_LIMIT",
      `R2 object "${safeKeyLabel}" reports ${stat.size} bytes, exceeding ceiling of ${maxBytes}`,
    );
  }
  if (
    options.expectedBytes !== undefined &&
    stat.size !== options.expectedBytes
  ) {
    throw new R2ManifestError(
      "ERR_R2_SIZE_MISMATCH",
      `HEAD size ${stat.size} !== expected ${options.expectedBytes} for "${safeKeyLabel}"`,
    );
  }
  if (options.expectedEtag !== undefined) {
    const trimmedEtag = typeof stat.etag === "string" ? stat.etag.trim() : "";
    if (
      trimmedEtag.length === 0 ||
      trimmedEtag.toUpperCase().startsWith("W/") ||
      trimmedEtag !== options.expectedEtag
    ) {
      throw new R2ManifestError(
        "ERR_R2_ETAG_MISMATCH",
        `HEAD etag mismatch for "${safeKeyLabel}"`,
      );
    }
  }
  if (options.maxAgeMs !== undefined) {
    const mtimeMs =
      stat.lastModified instanceof Date
        ? stat.lastModified.getTime()
        : Number.NaN;
    const nowMs = options.nowMs ?? Date.now();
    if (!Number.isFinite(mtimeMs) || nowMs - mtimeMs > options.maxAgeMs) {
      throw new R2ManifestError(
        "ERR_R2_STALE_OBJECT",
        `R2 object "${safeKeyLabel}" exceeds maxAgeMs ceiling (${options.maxAgeMs} ms)`,
      );
    }
  }

  // Stage 2: Bounded GET stream read with owned-buffer copies (TOCTOU-safe)
  const bytes = await readStreamCapped(client.file(key).stream(), {
    maxBytes,
    maxChunks,
    deadlineMs,
    keyLabel: safeKeyLabel,
  });

  if (
    options.expectedBytes !== undefined &&
    bytes.byteLength !== options.expectedBytes
  ) {
    throw new R2ManifestError(
      "ERR_R2_SIZE_MISMATCH",
      `GET body length ${bytes.byteLength} !== expected ${options.expectedBytes} for "${safeKeyLabel}"`,
    );
  }
  if (bytes.byteLength !== stat.size) {
    throw new R2ManifestError(
      "ERR_R2_SIZE_MISMATCH",
      `GET body length ${bytes.byteLength} drifted from HEAD size ${stat.size} for "${safeKeyLabel}"`,
    );
  }

  // Stage 3: Constant-time SHA-256 verification before decoding or parsing
  const actualDigest = new Bun.CryptoHasher("sha256").update(bytes).digest();
  if (
    actualDigest.byteLength !== expectedDigest.byteLength ||
    !timingSafeEqual(actualDigest, expectedDigest)
  ) {
    const actualHex = Buffer.from(actualDigest).toString("hex");
    throw new R2ManifestError(
      "ERR_R2_SHA256_MISMATCH",
      `SHA-256 mismatch for "${safeKeyLabel}": expected ${options.expectedSha256.toLowerCase()}, got ${actualHex}`,
    );
  }

  // Stage 4: Strict UTF-8 decode + hardened YAML parse
  if (hasUnsupportedBom(bytes)) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_UTF8",
      `R2 object "${safeKeyLabel}" contains unsupported UTF-16/UTF-32 BOM`,
    );
  }

  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch (err) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_UTF8",
      `R2 object "${safeKeyLabel}" contains invalid UTF-8 sequences`,
      err,
    );
  }
  if (!text.isWellFormed()) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_UTF8",
      `R2 object "${safeKeyLabel}" decoded to ill-formed UTF-16`,
    );
  }

  const manifest = parseHardenedYaml(text, {
    ...options.yamlOptions,
    maxBytes,
  });

  return {
    key,
    sha256: options.expectedSha256.toLowerCase(),
    byteLength: bytes.byteLength,
    etag: stat.etag,
    lastModified: stat.lastModified,
    manifest,
  };
}
