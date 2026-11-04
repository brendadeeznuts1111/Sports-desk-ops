/**
 * @file r2_s3_client.ts
 * @description One Bun.S3Client adapter for R2/S3: credential resolution, metadata
 * uploads, and the full object verb set used by the blob gateway and the docs publisher.
 * `Bun.S3Client` supplies upload/download/list/presign; this module adds the env
 * contract and the `x-amz-meta-*` PUT path Bun's writer does not expose.
 */

import type {
  S3File,
  S3FilePresignOptions,
  S3ListObjectsOptions,
  S3ListObjectsResponse,
  S3Stats,
} from "bun";
import type { BunSecretSetOptions } from "../types/bun-api";

export type R2S3Env = Readonly<Record<string, string | undefined>>;

/** Bun's S3 error codes (bun.com/docs/runtime/s3#error-codes). */
export const S3_ERROR_CODES = [
  "ERR_S3_MISSING_CREDENTIALS",
  "ERR_S3_INVALID_METHOD",
  "ERR_S3_INVALID_PATH",
  "ERR_S3_INVALID_ENDPOINT",
  "ERR_S3_INVALID_SIGNATURE",
  "ERR_S3_INVALID_SESSION_TOKEN",
] as const;

export type S3ErrorCode = (typeof S3_ERROR_CODES)[number];

export interface S3LikeError extends Error {
  readonly name: "S3Error" | string;
  readonly code?: S3ErrorCode;
}

export function isS3ErrorCode(value: unknown): value is S3ErrorCode {
  return (
    typeof value === "string" &&
    (S3_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** True for Bun's S3Error and for the six documented ERR_S3_* codes. */
export function isS3Error(error: unknown): error is S3LikeError {
  return (
    error instanceof Error &&
    (error.name === "S3Error" ||
      isS3ErrorCode((error as { code?: unknown }).code))
  );
}

export interface R2S3Options {
  readonly bucket: string;
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly region?: string;
  readonly publicBase: string;
}

/** The subset of Bun.S3Client this adapter delegates to (fake-able in tests). */
export interface R2S3ClientBackend {
  file(path: string, options?: Bun.S3Options): S3File;
  write(
    path: string,
    data: Uint8Array | string,
    options?: Bun.S3Options,
  ): Promise<number | undefined>;
  presign(path: string, options?: S3FilePresignOptions): string;
  stat(path: string, options?: Bun.S3Options): Promise<S3Stats>;
  exists(path: string, options?: Bun.S3Options): Promise<boolean>;
  size(path: string, options?: Bun.S3Options): Promise<number>;
  list(
    input?: S3ListObjectsOptions | null,
    options?: Bun.S3Options,
  ): Promise<S3ListObjectsResponse>;
  delete(path: string, options?: Bun.S3Options): Promise<void>;
  unlink(path: string, options?: Bun.S3Options): Promise<void>;
}

const DEFAULT_PUBLIC_BASE =
  "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev";

function firstDefined(
  env: R2S3Env,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

export const R2_SECRETS_SERVICE = "com.bookdeskops.sportsdesk";
export const R2_SECRETS_LEGACY_SERVICE = "sportsdesk-ops";
export const R2_SECRET_NAMES = [
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "R2_BUCKET_NAME",
  "BLOB_API_TOKEN",
  "BLOB_TICKET_SECRET",
  "CLOUDFLARE_R2_TOKEN_ID",
  "CLOUDFLARE_R2_API_TOKEN",
] as const;

export interface BunSecretsReader {
  get(options: {
    readonly service: string;
    readonly name: string;
  }): Promise<string | null>;
}

export async function resolveSecretBackedEnv(
  env: R2S3Env = Bun.env,
  secrets: BunSecretsReader | null = Bun.secrets,
): Promise<R2S3Env> {
  const merged: Record<string, string | undefined> = { ...env };
  if (secrets === null) return merged;
  for (const name of R2_SECRET_NAMES) {
    if (merged[name] !== undefined && merged[name] !== "") continue;
    try {
      const canonical = await secrets.get({
        service: R2_SECRETS_SERVICE,
        name,
      });
      if (canonical !== null && canonical !== "") {
        merged[name] = canonical;
        continue;
      }
      const legacy = await secrets.get({
        service: R2_SECRETS_LEGACY_SERVICE,
        name,
      });
      if (legacy !== null && legacy !== "") merged[name] = legacy;
    } catch {
      // Keychain unavailable/locked: keep the env-only contract.
    }
  }
  return merged;
}

export const MAX_SECRET_FIELD_CHARS = 255;
export const MAX_SECRET_VALUE_BYTES = 2048;

/** Bun.secrets service/name guard: non-empty printable ASCII, shorter than 256 chars. */
export function assertSecretField(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_SECRET_FIELD_CHARS ||
    !/^[\x20-\x7E]+$/.test(value)
  ) {
    throw new Error(
      `${label} must be 1..${MAX_SECRET_FIELD_CHARS} printable ASCII characters`,
    );
  }
}

export function assertSecretValue(value: string): void {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes === 0 || bytes > MAX_SECRET_VALUE_BYTES) {
    throw new Error(
      `secret value must be 1..${MAX_SECRET_VALUE_BYTES} UTF-8 bytes`,
    );
  }
}

/** Options for Bun.secrets.set: validates bounds and always persists locally. */
export function secretSetOptions(
  service: string,
  name: string,
  value: string,
): BunSecretSetOptions {
  assertSecretField(service, "service");
  assertSecretField(name, "name");
  assertSecretValue(value);
  return { service, name, value, persist: "local" };
}

export function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export async function resolveR2CredentialsAsync(
  env: R2S3Env = Bun.env,
  secrets: BunSecretsReader | null = Bun.secrets,
): Promise<R2S3Options | null> {
  return resolveR2S3Options(await resolveSecretBackedEnv(env, secrets));
}

/**
 * Resolve credentials in this order: R2_*, S3_*, AWS_*, then a Cloudflare R2 API
 * token pair (`CLOUDFLARE_R2_TOKEN_ID` becomes the access-key id; the secret is the
 * SHA-256 hex of `CLOUDFLARE_R2_API_TOKEN`).
 */
function credentialPair(
  access: string | undefined,
  secret: string | undefined,
): { readonly accessKeyId: string; readonly secretAccessKey: string } | null {
  return access === undefined || secret === undefined
    ? null
    : { accessKeyId: access, secretAccessKey: secret };
}

export function resolveR2S3Options(env: R2S3Env = Bun.env): R2S3Options | null {
  // Explicit precedence: R2_* → Cloudflare token pair → S3_* → AWS_*.
  const candidates = [
    credentialPair(
      firstDefined(env, ["R2_ACCESS_KEY_ID"]),
      firstDefined(env, ["R2_SECRET_ACCESS_KEY"]),
    ),
    (() => {
      const tokenId = firstDefined(env, ["CLOUDFLARE_R2_TOKEN_ID"]);
      const tokenValue = firstDefined(env, ["CLOUDFLARE_R2_API_TOKEN"]);
      return tokenId === undefined || tokenValue === undefined
        ? null
        : { accessKeyId: tokenId, secretAccessKey: sha256Hex(tokenValue) };
    })(),
    credentialPair(
      firstDefined(env, ["S3_ACCESS_KEY_ID"]),
      firstDefined(env, ["S3_SECRET_ACCESS_KEY"]),
    ),
    credentialPair(
      firstDefined(env, ["AWS_ACCESS_KEY_ID"]),
      firstDefined(env, ["AWS_SECRET_ACCESS_KEY"]),
    ),
  ];
  const credentials = candidates.find((candidate) => candidate !== null);
  if (credentials === null || credentials === undefined) return null;

  const bucket = firstDefined(env, [
    "R2_BUCKET_NAME",
    "S3_BUCKET",
    "AWS_BUCKET",
  ]);
  const accountId =
    firstDefined(env, ["CLOUDFLARE_ACCOUNT_ID", "R2_ACCOUNT_ID"]) ?? "";
  const endpoint =
    firstDefined(env, ["S3_ENDPOINT", "AWS_ENDPOINT", "AWS_ENDPOINT_URL_S3"]) ??
    (accountId === ""
      ? undefined
      : `https://${accountId}.r2.cloudflarestorage.com`);
  if (bucket === undefined || endpoint === undefined) return null;

  const sessionToken = firstDefined(env, [
    "S3_SESSION_TOKEN",
    "AWS_SESSION_TOKEN",
  ]);
  const region = firstDefined(env, ["S3_REGION", "AWS_REGION"]);
  return {
    bucket,
    endpoint,
    ...credentials,
    ...(sessionToken === undefined ? {} : { sessionToken }),
    ...(region === undefined ? {} : { region }),
    publicBase: firstDefined(env, ["R2_PUBLIC_URL"]) ?? DEFAULT_PUBLIC_BASE,
  };
}

function byteLength(data: Uint8Array | string): number {
  return typeof data === "string"
    ? new TextEncoder().encode(data).byteLength
    : data.byteLength;
}

type R2S3Auth = Pick<
  R2S3Options,
  "endpoint" | "accessKeyId" | "secretAccessKey" | "sessionToken" | "region"
>;

const textEncoder = new TextEncoder();

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function hmacSha256(
  key: Uint8Array | string,
  data: string,
): Promise<Uint8Array> {
  const keyBytes = typeof key === "string" ? textEncoder.encode(key) : key;
  const keyData = Uint8Array.from(keyBytes);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(data)),
  );
}

async function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
): Promise<Uint8Array> {
  const date = await hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const regional = await hmacSha256(date, region);
  const service = await hmacSha256(regional, "s3");
  return hmacSha256(service, "aws4_request");
}

/**
 * Bun's presign cannot sign arbitrary `x-amz-meta-*` headers, so a metadata PUT
 * needs SigV4 over the exact header set. This stays in Web Crypto (no node:crypto)
 * and is used only when metadata is non-empty; plain writes still go through
 * Bun.S3Client.write and downloads still use its presigner.
 */
async function putObjectWithMetadata(
  auth: R2S3Auth,
  bucket: string,
  key: string,
  payload: Uint8Array,
  type: string,
  metadata: Readonly<Record<string, string>>,
): Promise<void> {
  const endpoint = new URL(auth.endpoint);
  const host = endpoint.host;
  const path = `/${encodeBucket(bucket)}/${key.split("/").map(encodeRfc3986).join("/")}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.[0-9]{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = auth.region ?? "auto";
  const payloadHash = new Bun.CryptoHasher("sha256")
    .update(payload)
    .digest("hex");
  const headers: Record<string, string> = {
    "content-length": String(payload.byteLength),
    "content-type": type,
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (auth.sessionToken !== undefined) {
    headers["x-amz-security-token"] = auth.sessionToken;
  }
  for (const [name, value] of Object.entries(metadata)) {
    headers[`x-amz-meta-${name.toLowerCase()}`] = value
      .replace(/[\r\n]+/g, " ")
      .trim();
  }
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name]}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    "PUT",
    path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    new Bun.CryptoHasher("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const signing = await signingKey(auth.secretAccessKey, dateStamp, region);
  const signature = Buffer.from(
    await hmacSha256(signing, stringToSign),
  ).toString("hex");
  const requestHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (name !== "host") requestHeaders.set(name, value);
  }
  requestHeaders.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${auth.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
  const response = await fetch(`${endpoint.origin}${path}`, {
    method: "PUT",
    headers: requestHeaders,
    body: payload,
  });
  if (!response.ok) {
    throw new Error(`R2 PUT ${key} failed (${response.status})`);
  }
}

function encodeBucket(bucket: string): string {
  return encodeRfc3986(bucket);
}

export class R2S3Client {
  constructor(
    readonly client: R2S3ClientBackend,
    readonly bucket: string,
    readonly publicBase: string,
    private readonly auth?: R2S3Auth,
  ) {}

  static fromOptions(
    options: R2S3Options,
    client?: R2S3ClientBackend,
  ): R2S3Client {
    const credentials: Bun.S3Options = {
      bucket: options.bucket,
      endpoint: options.endpoint,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      ...(options.sessionToken === undefined
        ? {}
        : { sessionToken: options.sessionToken }),
      ...(options.region === undefined ? {} : { region: options.region }),
    };
    const backend = client ?? new Bun.S3Client(credentials);
    return new R2S3Client(backend, options.bucket, options.publicBase, options);
  }

  static fromEnv(env: R2S3Env = Bun.env): R2S3Client | null {
    const options = resolveR2S3Options(env);
    return options === null ? null : R2S3Client.fromOptions(options);
  }

  /** Env precedence first, then Bun.secrets fallback for the missing names. */
  static async fromEnvOrSecrets(
    env: R2S3Env = Bun.env,
    secrets: BunSecretsReader | null = Bun.secrets,
  ): Promise<R2S3Client | null> {
    const resolved = await resolveSecretBackedEnv(env, secrets);
    const options = resolveR2S3Options(resolved);
    return options === null ? null : R2S3Client.fromOptions(options);
  }

  file(key: string, options?: Bun.S3Options): S3File {
    return this.client.file(key, options);
  }

  async write(
    key: string,
    data: Uint8Array | string,
    options: { readonly type?: string } = {},
  ): Promise<number> {
    const type = options.type ?? "application/octet-stream";
    const written = await this.client.write(key, data, { type });
    return written ?? byteLength(data);
  }

  /** A 200 response backed directly by the lazy S3File (`new Response(s3file)`). */
  redirectResponse(key: string): Response {
    return new Response(this.client.file(key));
  }

  /**
   * Upload with `x-amz-meta-*` headers. Bun's writer has no metadata option and its
   * presigner cannot sign custom headers, so this signs the exact metadata PUT with
   * Web Crypto (SigV4); plain writes still go through `Bun.S3Client.write`.
   */
  async writeWithMetadata(
    key: string,
    data: Uint8Array | string,
    options: {
      readonly type?: string;
      readonly metadata?: Readonly<Record<string, string>>;
    } = {},
  ): Promise<number> {
    const type = options.type ?? "application/octet-stream";
    const metadata = options.metadata ?? {};
    if (Object.keys(metadata).length === 0) {
      return this.write(key, data, { type });
    }
    if (this.auth === undefined) {
      throw new Error("R2S3Client: metadata upload requires auth options");
    }
    const payload = typeof data === "string" ? textEncoder.encode(data) : data;
    await putObjectWithMetadata(
      this.auth,
      this.bucket,
      key,
      payload,
      type,
      metadata,
    );
    return byteLength(data);
  }

  /** Back-compat alias for callers written before the writeWithMetadata rename. */
  async putWithMetadata(
    key: string,
    data: Uint8Array | string,
    options: {
      readonly type?: string;
      readonly metadata?: Readonly<Record<string, string>>;
    } = {},
  ): Promise<number> {
    return this.writeWithMetadata(key, data, options);
  }

  async sliceBytes(
    key: string,
    start: number,
    end?: number,
  ): Promise<Uint8Array> {
    const sliced = this.client.file(key).slice(start, end);
    return new Uint8Array(await sliced.arrayBuffer());
  }

  /**
   * Bun's HEAD on R2 metadata objects can omit Content-Length, yielding size 0 even
   * though a GET returns the body. Keep the stat contract but recover the real size
   * with a body read when the HEAD says zero.
   */
  private async bodySize(key: string): Promise<number> {
    try {
      return (await this.client.file(key).arrayBuffer()).byteLength;
    } catch {
      return 0;
    }
  }

  async stat(key: string): Promise<S3Stats> {
    const stat = await this.client.stat(key);
    return stat.size > 0 ? stat : { ...stat, size: await this.bodySize(key) };
  }

  exists(key: string): Promise<boolean> {
    return this.client.exists(key);
  }

  async size(key: string): Promise<number> {
    const size = await this.client.size(key);
    return size > 0 ? size : this.bodySize(key);
  }

  list(input?: S3ListObjectsOptions | null): Promise<S3ListObjectsResponse> {
    return this.client.list(input);
  }

  presign(key: string, options?: S3FilePresignOptions): string {
    return this.client.presign(key, options);
  }

  delete(key: string): Promise<void> {
    return this.client.delete(key);
  }

  unlink(key: string): Promise<void> {
    return this.client.unlink(key);
  }
}
