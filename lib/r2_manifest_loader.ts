/**
 * @file r2_manifest_loader.ts
 * @description Load one R2 YAML manifest only after the object matches the caller's
 * size and SHA-256. The digest is checked on the raw bytes, before UTF-8 decoding
 * and before YAML parsing.
 *
 * This module does not construct an S3 client and does not read credentials.
 * Callers inject an {@link R2ManifestClient}. Tests pass a fake. Nothing here
 * opens a live R2 connection.
 */

import { timingSafeEqual } from "node:crypto";
import { parseGuardedYaml, YamlGuardError } from "./yaml_guard.ts";

export { YamlGuardError };
export type { YamlGuardErrorCode } from "./yaml_guard.ts";

export const DEFAULT_R2_MANIFEST_BUCKET = "sportsdesk-ops-reports";
export const DEFAULT_R2_MANIFEST_MAX_BYTES = 1024 * 1024;

export type R2ManifestErrorCode =
  | "ERR_R2_INVALID_KEY"
  | "ERR_R2_INVALID_DIGEST"
  | "ERR_R2_EMPTY_OBJECT"
  | "ERR_R2_BYTE_LIMIT"
  | "ERR_R2_SIZE_MISMATCH"
  | "ERR_R2_SHA256_MISMATCH"
  | "ERR_R2_INVALID_UTF8";

export class R2ManifestError extends Error {
  readonly code: R2ManifestErrorCode;

  constructor(
    code: R2ManifestErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "R2ManifestError";
    this.code = code;
  }
}

export interface R2ManifestObjectStat {
  readonly size: number;
}

/**
 * Object store the loader talks to. `stat` is the HEAD. `getStream` is the GET
 * body and is not called when HEAD already fails the size contract.
 */
export interface R2ManifestClient {
  stat(key: string): Promise<R2ManifestObjectStat>;
  getStream(key: string): Promise<ReadableStream<Uint8Array>>;
}

/** Bucket-scoped backend. The scoped helper passes the bucket on every call. */
export interface R2ManifestBackend {
  stat(bucket: string, key: string): Promise<R2ManifestObjectStat>;
  getStream(bucket: string, key: string): Promise<ReadableStream<Uint8Array>>;
}

export interface ScopedR2ManifestClient extends R2ManifestClient {
  readonly bucket: string;
  readonly requiredPrefix?: string;
}

export interface R2ManifestLoadRequest {
  readonly key: string;
  /** 64 hex characters. Compared as 32 raw bytes with `timingSafeEqual`. */
  readonly expectedSha256: string;
  readonly expectedBytes: number;
  /** Defaults to 1 MiB. HEAD or GET above this fails with `ERR_R2_BYTE_LIMIT`. */
  readonly maxBytes?: number;
  /** Optional key prefix. A key outside it fails with `ERR_R2_INVALID_KEY`. */
  readonly requiredPrefix?: string;
}

export interface LoadedR2Manifest {
  readonly key: string;
  readonly byteLength: number;
  /** Lowercase hex of the digest that matched `expectedSha256`. */
  readonly sha256: string;
  readonly value: unknown;
}

/**
 * Bind a backend to one bucket. The bucket defaults to `sportsdesk-ops-reports`.
 * `requiredPrefix` is optional; when set, keys outside it never reach the backend.
 */
export function createScopedR2ManifestClient(
  backend: R2ManifestBackend,
  options?: {
    readonly bucket?: string;
    readonly requiredPrefix?: string;
  },
): ScopedR2ManifestClient {
  const bucket = options?.bucket ?? DEFAULT_R2_MANIFEST_BUCKET;
  if (!isBucketName(bucket)) {
    throw new TypeError(
      `R2 bucket "${bucket}" is not a bucket name (expected a non-empty name without "/")`,
    );
  }
  const requiredPrefix = options?.requiredPrefix;
  if (requiredPrefix !== undefined && requiredPrefix !== "") {
    assertManifestKey(prefixProbe(requiredPrefix));
  }
  const guard = (key: string): void => {
    assertManifestKey(key, requiredPrefix);
  };
  return {
    bucket,
    ...(requiredPrefix !== undefined && requiredPrefix !== ""
      ? { requiredPrefix }
      : {}),
    async stat(key: string): Promise<R2ManifestObjectStat> {
      guard(key);
      return backend.stat(bucket, key);
    },
    async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
      guard(key);
      return backend.getStream(bucket, key);
    },
  };
}

/**
 * HEAD, bounded GET, SHA-256, then UTF-8 and guarded YAML.
 * A failing HEAD does not open the GET stream.
 */
export async function loadVerifiedR2Manifest(
  client: R2ManifestClient,
  request: R2ManifestLoadRequest,
): Promise<LoadedR2Manifest> {
  const maxBytes = request.maxBytes ?? DEFAULT_R2_MANIFEST_MAX_BYTES;
  assertManifestKey(request.key, request.requiredPrefix);
  assertDigest(request.expectedSha256);
  assertBudget(request.expectedBytes, maxBytes);

  const head = await client.stat(request.key);
  assertHeadSize(head.size, request.expectedBytes, maxBytes, request.key);

  const stream = await client.getStream(request.key);
  const body = await readBounded(stream, maxBytes, request.key);
  if (body.byteLength === 0) {
    throw new R2ManifestError(
      "ERR_R2_EMPTY_OBJECT",
      `R2 object "${request.key}" GET body is empty`,
    );
  }
  if (
    body.byteLength !== head.size ||
    body.byteLength !== request.expectedBytes
  ) {
    throw new R2ManifestError(
      "ERR_R2_SIZE_MISMATCH",
      `R2 object "${request.key}" GET body is ${body.byteLength} bytes; HEAD was ${head.size}, expected ${request.expectedBytes}`,
    );
  }

  const actual = new Uint8Array(
    new Bun.CryptoHasher("sha256").update(body).digest(),
  );
  const expected = decodeSha256(request.expectedSha256);
  if (!timingSafeEqual(actual, expected)) {
    throw new R2ManifestError(
      "ERR_R2_SHA256_MISMATCH",
      `R2 object "${request.key}" sha256 ${toHex(actual)} does not match ${request.expectedSha256.toLowerCase()}`,
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (error) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_UTF8",
      `R2 object "${request.key}" is not valid UTF-8`,
      { cause: error },
    );
  }

  const value = parseGuardedYaml(text);
  return {
    key: request.key,
    byteLength: body.byteLength,
    sha256: request.expectedSha256.toLowerCase(),
    value,
  };
}

export function assertManifestKey(key: string, requiredPrefix?: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_KEY",
      "R2 key must be a non-empty relative object key of at most 1024 bytes",
    );
  }
  if (key.startsWith("/") || hasForbiddenKeyChar(key)) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_KEY",
      `R2 key "${key}" is not a relative object key`,
    );
  }
  const parts = key.split("/");
  if (
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_KEY",
      `R2 key "${key}" is not a relative object key`,
    );
  }
  if (
    requiredPrefix !== undefined &&
    requiredPrefix !== "" &&
    !prefixMatches(key, requiredPrefix)
  ) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_KEY",
      `R2 key "${key}" is outside required prefix "${requiredPrefix}"`,
    );
  }
}

function prefixMatches(key: string, prefix: string): boolean {
  if (prefix.endsWith("/")) return key.startsWith(prefix);
  return key === prefix || key.startsWith(`${prefix}/`);
}

function prefixProbe(prefix: string): string {
  return prefix.endsWith("/") ? `${prefix}placeholder` : prefix;
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hasForbiddenKeyChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

function isBucketName(bucket: string): boolean {
  return (
    bucket.length > 0 &&
    bucket.length <= 63 &&
    !bucket.includes("/") &&
    !hasControlChar(bucket)
  );
}

function assertDigest(expectedSha256: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(expectedSha256)) {
    throw new R2ManifestError(
      "ERR_R2_INVALID_DIGEST",
      "expectedSha256 must be 64 hex characters",
    );
  }
}

function assertBudget(expectedBytes: number, maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new R2ManifestError(
      "ERR_R2_BYTE_LIMIT",
      "maxBytes must be a positive integer",
    );
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) {
    throw new R2ManifestError(
      "ERR_R2_SIZE_MISMATCH",
      "expectedBytes must be a positive integer byte length",
    );
  }
  if (expectedBytes > maxBytes) {
    throw new R2ManifestError(
      "ERR_R2_BYTE_LIMIT",
      `expectedBytes ${expectedBytes} exceeds the ${maxBytes} byte limit`,
    );
  }
}

function assertHeadSize(
  size: number,
  expectedBytes: number,
  maxBytes: number,
  key: string,
): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new R2ManifestError(
      "ERR_R2_SIZE_MISMATCH",
      `R2 object "${key}" HEAD size is not a byte length`,
    );
  }
  if (size === 0) {
    throw new R2ManifestError(
      "ERR_R2_EMPTY_OBJECT",
      `R2 object "${key}" is empty`,
    );
  }
  if (size > maxBytes) {
    throw new R2ManifestError(
      "ERR_R2_BYTE_LIMIT",
      `R2 object "${key}" is ${size} bytes, over the ${maxBytes} byte limit`,
    );
  }
  if (size !== expectedBytes) {
    throw new R2ManifestError(
      "ERR_R2_SIZE_MISMATCH",
      `R2 object "${key}" HEAD size is ${size} bytes; expected ${expectedBytes}`,
    );
  }
}

function decodeSha256(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    const hi = fromHex(hex.charCodeAt(i * 2));
    const lo = fromHex(hex.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) {
      throw new R2ManifestError(
        "ERR_R2_INVALID_DIGEST",
        "expectedSha256 must be 64 hex characters",
      );
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function fromHex(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  key: string,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      const chunk = step.value;
      if (chunk.byteLength === 0) continue;
      if (total + chunk.byteLength > maxBytes) {
        overflow = true;
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The size error is the contract. A failed cancel does not replace it.
    }
  }
  if (overflow) {
    throw new R2ManifestError(
      "ERR_R2_BYTE_LIMIT",
      `R2 object "${key}" GET body exceeds the ${maxBytes} byte limit`,
    );
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
