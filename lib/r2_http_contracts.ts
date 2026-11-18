/**
 * @file lib/r2_http_contracts.ts
 * @description Source of truth for R2/S3 HTTP header names, ETag types, signed
 * response shapes, and `ERR_R2_*` codes.
 *
 * #392 (`lib/r2_s3_client.ts`, `lib/r2_chunk_manifest.ts`) and #394
 * (`lib/r2_s3_client.ts`, `lib/desk_fetch_proxy.ts`) already define some of these
 * names. This module reuses those names and shapes so a later rebase can delete
 * the duplicates and re-export from here. This branch does not change those PRs.
 */

/** Lowercase wire names used in SigV4 `SignedHeaders` and `Headers` lookups. */
export const R2_HTTP_HEADER = {
  host: "host",
  ifMatch: "if-match",
  ifNoneMatch: "if-none-match",
  etag: "etag",
  contentEncoding: "content-encoding",
  acceptEncoding: "accept-encoding",
  contentType: "content-type",
  contentLength: "content-length",
  xAmzContentSha256: "x-amz-content-sha256",
  xAmzDate: "x-amz-date",
  xAmzSecurityToken: "x-amz-security-token",
  xAmzMetaPrefix: "x-amz-meta-",
} as const;

export type R2HttpHeaderName =
  (typeof R2_HTTP_HEADER)[keyof typeof R2_HTTP_HEADER];

/**
 * Sent and signed on every signed R2 request, with `decompress: false`, so no hop
 * may answer with a compressed representation whose ETag differs from the stored
 * object's. Same value as #394 `R2_IDENTITY_ENCODING_HEADERS`.
 */
export const R2_IDENTITY_ENCODING_HEADERS = {
  "accept-encoding": "identity",
} as const satisfies Readonly<Record<string, string>>;

/** #392 name for the same identity Accept-Encoding map. */
export const R2_IDENTITY_GET_HEADERS = R2_IDENTITY_ENCODING_HEADERS;

/**
 * Headers Bun's fetch appends on its own after ours. They stay out of
 * SignedHeaders (SigV4 tolerates unsigned extras); every header we set is signed.
 */
export const R2_BUN_ADDED_UNSIGNED_HEADERS = [
  "connection",
  "user-agent",
  "accept",
] as const;

/** Payload hash Bun's `S3Client.write` signs instead of the body sha256. */
export const R2_UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export type R2SignedMethod = "PUT" | "HEAD" | "GET";

export const DEFAULT_R2_FETCH_TIMEOUT_MS = 30_000;

/** Connect-failure `.code`s on Bun's fetch `TypeError` that a PUT may retry. */
export const R2_TRANSIENT_NETWORK_CODES = [
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNABORTED",
  "EAI_AGAIN",
] as const;

/**
 * Every `ERR_R2_*` code used on main or introduced in #392 / #394.
 * Class-level `readonly code` fields should use these strings.
 */
export const R2_ERROR_CODES = {
  AUTH_MISSING: "ERR_R2_AUTH_MISSING",
  CHUNK_MERKLE_MISMATCH: "ERR_R2_CHUNK_MERKLE_MISMATCH",
  CHUNK_PUT_RETRY: "ERR_R2_CHUNK_PUT_RETRY",
  ENCODED_ETAG: "ERR_R2_ENCODED_ETAG",
  ENCODED_RESPONSE: "ERR_R2_ENCODED_RESPONSE",
  INVALID_UTF8: "ERR_R2_INVALID_UTF8",
  LONE_SURROGATE: "ERR_R2_LONE_SURROGATE",
  MANIFEST_CAS_REJECTED: "ERR_R2_MANIFEST_CAS_REJECTED",
  MANIFEST_CAS_TIMEOUT: "ERR_R2_MANIFEST_CAS_TIMEOUT",
  MANIFEST_CAS_TRANSPORT: "ERR_R2_MANIFEST_CAS_TRANSPORT",
  MANIFEST_CAS_VERIFY: "ERR_R2_MANIFEST_CAS_VERIFY",
  MANIFEST_EXISTS: "ERR_R2_MANIFEST_EXISTS",
  PROXY_TUNNEL: "ERR_R2_PROXY_TUNNEL",
  PROXY_URL: "ERR_R2_PROXY_URL",
  SINK_BACKPRESSURE: "ERR_R2_SINK_BACKPRESSURE",
  TIMEOUT: "ERR_R2_TIMEOUT",
  UNSUPPORTED_BOM: "ERR_R2_UNSUPPORTED_BOM",
  WEAK_ETAG: "ERR_R2_WEAK_ETAG",
} as const;

export type R2ErrorCode = (typeof R2_ERROR_CODES)[keyof typeof R2_ERROR_CODES];

const R2_ERROR_CODE_SET = new Set<string>(Object.values(R2_ERROR_CODES));

export function isR2ErrorCode(value: unknown): value is R2ErrorCode {
  return typeof value === "string" && R2_ERROR_CODE_SET.has(value);
}

declare const strongETagBrand: unique symbol;
/** A strong (non-`W/`) ETag, safe to send in `If-Match` / `If-None-Match`. */
export type StrongETag = string & { readonly [strongETagBrand]: "StrongETag" };

export type R2GetObjectResult =
  | { readonly status: 404; readonly etag: null; readonly body: null }
  | {
      readonly status: 200;
      readonly etag: string | null;
      readonly body: Uint8Array;
    };

export type R2HeadObjectResult =
  | {
      readonly status: 404;
      readonly etag: null;
      readonly contentEncoding: null;
      readonly contentLength: null;
    }
  | {
      readonly status: 200;
      readonly etag: string | null;
      readonly contentEncoding: string | null;
      readonly contentLength: number | null;
    };

export type R2PutObjectResult = {
  readonly status: number;
  readonly etag: string | null;
};

const WEAK_ETAG_PREFIX = /^W\//i;
const ENCODED_ETAG_SUFFIX = /[-+;](?:x-)?(?:gzip|br|deflate|zstd|compress)"?$/i;

export function isWeakETag(etag: string): boolean {
  return WEAK_ETAG_PREFIX.test(etag.trim());
}

export class R2WeakETagError extends Error {
  readonly code = R2_ERROR_CODES.WEAK_ETAG;
  readonly exitCode = 74 as const;
  readonly key: string;
  readonly etag: string;
  constructor(key: string, etag: string) {
    super(
      `ERR_R2_WEAK_ETAG: ${etag} for ${key} is weak; If-Match compares strong ETags only`,
    );
    this.name = "R2WeakETagError";
    this.key = key;
    this.etag = etag;
  }
}

export class R2EncodedETagError extends Error {
  readonly code = R2_ERROR_CODES.ENCODED_ETAG;
  readonly exitCode = 74 as const;
  readonly key: string;
  readonly method: R2SignedMethod;
  readonly etag: string;
  constructor(key: string, method: R2SignedMethod, etag: string) {
    super(
      `ERR_R2_ENCODED_ETAG: R2 ${method} ${key} returned ETag ${etag} for a content-encoded representation, not the stored object`,
    );
    this.name = "R2EncodedETagError";
    this.key = key;
    this.method = method;
    this.etag = etag;
  }
}

/** The trimmed ETag, or {@link R2WeakETagError} when it is weak and so unusable for If-Match. */
export function assertStrongETag(key: string, etag: string): StrongETag {
  const trimmed = etag.trim();
  if (isWeakETag(trimmed)) throw new R2WeakETagError(key, trimmed);
  return trimmed as StrongETag;
}

/**
 * A response ETag, trimmed, or null when absent. A content-coding tag such as
 * `"…-gzip"` / `"…+gzip"` names a transformed body; feeding it to If-Match would 412
 * forever, so it is refused with {@link R2EncodedETagError}. Weak ETags pass through
 * and are refused where they would be used for CAS. Same contract as #394.
 */
export function parseR2ETag(
  raw: string | null | undefined,
  key: string,
  method: R2SignedMethod,
): string | null {
  const etag = raw?.trim() ?? "";
  if (etag === "") return null;
  if (ENCODED_ETAG_SUFFIX.test(etag)) {
    throw new R2EncodedETagError(key, method, etag);
  }
  return etag;
}

/**
 * Strong, non-encoded ETag for conditional headers. Missing/empty throws
 * `TypeError`; weak throws {@link R2WeakETagError}; a coding suffix throws
 * {@link R2EncodedETagError}.
 */
export function parseStrongETag(
  raw: string | null | undefined,
  key: string,
  method: R2SignedMethod = "GET",
): StrongETag {
  const parsed = parseR2ETag(raw, key, method);
  if (parsed === null) {
    throw new TypeError(`missing ETag for ${key}`);
  }
  return assertStrongETag(key, parsed);
}

/** `getObject` asks for identity bytes; a coded body is not the object readers can parse. */
export class R2EncodedResponseError extends Error {
  readonly code = R2_ERROR_CODES.ENCODED_RESPONSE;
  readonly exitCode = 74 as const;
  readonly key: string;
  readonly contentEncoding: string;
  constructor(key: string, contentEncoding: string) {
    super(
      `ERR_R2_ENCODED_RESPONSE: GET ${key} returned Content-Encoding ${contentEncoding} for an identity request`,
    );
    this.name = "R2EncodedResponseError";
    this.key = key;
    this.contentEncoding = contentEncoding;
  }
}

/** A manifest key already exists; manifests are immutable, so the write was refused (412). */
export class ManifestExistsError extends Error {
  readonly code = R2_ERROR_CODES.MANIFEST_EXISTS;
  readonly exitCode = 74 as const;
  constructor(
    readonly key: string,
    options?: ErrorOptions,
  ) {
    super(
      `ERR_R2_MANIFEST_EXISTS: ${key} already exists (If-None-Match:* returned 412)`,
      options,
    );
    this.name = "ManifestExistsError";
  }
}

export class R2PreconditionFailedError extends Error {
  readonly status = 412 as const;
  readonly key: string;
  constructor(key: string) {
    super(`R2 PUT ${key} precondition failed (412)`);
    this.name = "R2PreconditionFailedError";
    this.key = key;
  }
}

export class R2TimeoutError extends Error {
  readonly code = R2_ERROR_CODES.TIMEOUT;
  readonly key: string;
  readonly method: R2SignedMethod;
  readonly ms: number;
  constructor(
    key: string,
    method: R2SignedMethod,
    ms: number,
    options: { readonly cause: unknown },
  ) {
    super(`R2 ${method} ${key} timed out after ${ms}ms`, {
      cause: options.cause,
    });
    this.name = "R2TimeoutError";
    this.key = key;
    this.method = method;
    this.ms = ms;
  }
}

export class R2NetworkError extends Error {
  readonly key: string;
  readonly method: R2SignedMethod;
  /** The fetch error's `.code` (e.g. `ECONNREFUSED`), or null when it had none. */
  readonly code: string | null;
  readonly transient: boolean;
  constructor(
    key: string,
    method: R2SignedMethod,
    code: string | null,
    options: { readonly cause: unknown },
  ) {
    super(`R2 ${method} ${key} network error (${code ?? "no code"})`, {
      cause: options.cause,
    });
    this.name = "R2NetworkError";
    this.key = key;
    this.method = method;
    this.code = code;
    this.transient =
      code !== null &&
      (R2_TRANSIENT_NETWORK_CODES as readonly string[]).includes(code);
  }
}

export type R2ProxyUrlErrorReason = "invalid" | "protocol" | "credentials";

export class R2ProxyUrlError extends Error {
  readonly code = R2_ERROR_CODES.PROXY_URL;
  readonly reason: R2ProxyUrlErrorReason;
  constructor(reason: R2ProxyUrlErrorReason) {
    super(
      reason === "credentials"
        ? "proxy URL must not carry credentials; pass headers['Proxy-Authorization']"
        : reason === "protocol"
          ? "proxy URL must be http: or https:"
          : "proxy URL is not a valid URL",
    );
    this.name = "R2ProxyUrlError";
    this.reason = reason;
  }
}

export class R2ProxyTunnelError extends Error {
  readonly code = R2_ERROR_CODES.PROXY_TUNNEL;
  readonly status: number | null;
  readonly statusText: string;
  readonly proxyAuthenticate: string | null;
  constructor(
    status: number | null,
    statusText: string,
    proxyAuthenticate: string | null,
    options: { readonly cause: unknown },
  ) {
    super(
      `proxy refused to open a tunnel${status === null ? "" : ` (${status}${statusText === "" ? "" : ` ${statusText}`})`}`,
      { cause: options.cause },
    );
    this.name = "R2ProxyTunnelError";
    this.status = status;
    this.statusText = statusText;
    this.proxyAuthenticate = proxyAuthenticate;
  }
}
