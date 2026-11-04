/**
 * @file r2_s3_client.ts
 * @description One Bun.S3Client adapter for R2/S3: credential resolution, presigned
 * metadata uploads, and the full object verb set used by the blob gateway and the docs
 * publisher. `Bun.S3Client` supplies upload/download/list/presign; this module only adds
 * the project's env contract and the `x-amz-meta-*` PUT path Bun's writer does not expose.
 */

import type {
  S3File,
  S3FilePresignOptions,
  S3ListObjectsOptions,
  S3ListObjectsResponse,
  S3Stats,
} from "bun";

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
const PRESIGN_TTL_SEC = 300;

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

export function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
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

function metadataHeaders(metadata: Readonly<Record<string, string>>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(metadata)) {
    headers.set(
      `x-amz-meta-${name.toLowerCase()}`,
      value.replace(/[\r\n]+/g, " ").trim(),
    );
  }
  return headers;
}

function byteLength(data: Uint8Array | string): number {
  return typeof data === "string"
    ? new TextEncoder().encode(data).byteLength
    : data.byteLength;
}

export class R2S3Client {
  constructor(
    readonly client: R2S3ClientBackend,
    readonly bucket: string,
    readonly publicBase: string,
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
    return new R2S3Client(backend, options.bucket, options.publicBase);
  }

  static fromEnv(env: R2S3Env = Bun.env): R2S3Client | null {
    const options = resolveR2S3Options(env);
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
   * Upload with `x-amz-meta-*` headers. Bun's S3 writer has no metadata option, so
   * this presigns a PUT, then sends the caller's metadata headers on the upload.
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
    const url = this.client.presign(key, {
      method: "PUT",
      expiresIn: PRESIGN_TTL_SEC,
      type,
    });
    const headers = metadataHeaders(metadata);
    headers.set("content-type", type);
    const response = await fetch(url, { method: "PUT", headers, body: data });
    if (!response.ok) {
      throw new Error(`R2 PUT ${key} failed (${response.status})`);
    }
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

  stat(key: string): Promise<S3Stats> {
    return this.client.stat(key);
  }

  exists(key: string): Promise<boolean> {
    return this.client.exists(key);
  }

  size(key: string): Promise<number> {
    return this.client.size(key);
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
