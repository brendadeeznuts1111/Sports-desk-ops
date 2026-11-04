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

export interface R2S3Options {
  readonly bucket: string;
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
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
export function resolveR2S3Options(env: R2S3Env = Bun.env): R2S3Options | null {
  const bucket = firstDefined(env, [
    "R2_BUCKET_NAME",
    "S3_BUCKET",
    "AWS_BUCKET",
  ]);
  const accountId =
    firstDefined(env, ["CLOUDFLARE_ACCOUNT_ID", "R2_ACCOUNT_ID"]) ?? "";
  const endpoint =
    firstDefined(env, ["R2_ENDPOINT", "S3_ENDPOINT", "AWS_ENDPOINT_URL_S3"]) ??
    (accountId === ""
      ? undefined
      : `https://${accountId}.r2.cloudflarestorage.com`);
  let accessKeyId = firstDefined(env, [
    "R2_ACCESS_KEY_ID",
    "S3_ACCESS_KEY_ID",
    "AWS_ACCESS_KEY_ID",
  ]);
  let secretAccessKey = firstDefined(env, [
    "R2_SECRET_ACCESS_KEY",
    "S3_SECRET_ACCESS_KEY",
    "AWS_SECRET_ACCESS_KEY",
  ]);
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    const tokenId = firstDefined(env, ["CLOUDFLARE_R2_TOKEN_ID"]);
    const tokenValue = firstDefined(env, ["CLOUDFLARE_R2_API_TOKEN"]);
    if (tokenId !== undefined && tokenValue !== undefined) {
      accessKeyId = tokenId;
      secretAccessKey = sha256Hex(tokenValue);
    }
  }
  if (
    bucket === undefined ||
    endpoint === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  ) {
    return null;
  }
  return {
    bucket,
    endpoint,
    accessKeyId,
    secretAccessKey,
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
    private readonly client: R2S3ClientBackend,
    readonly bucket: string,
    readonly publicBase: string,
  ) {}

  static fromOptions(
    options: R2S3Options,
    client?: R2S3ClientBackend,
  ): R2S3Client {
    const backend =
      client ??
      new Bun.S3Client({
        bucket: options.bucket,
        endpoint: options.endpoint,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      });
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
  async putWithMetadata(
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
