/**
 * `Accept-Encoding` negotiation and a small cache of encoded response bodies.
 *
 * The daemon serves a 657 KB graph page, a 146 KB dashboard, a 94 KB agent tree and a 217 KB
 * graph feed, and sent all of them identity-encoded with no `Vary` (measured 2026-11-02). Bun does
 * not compress a `Response` on its own, and Nginx cannot be relied on for the unix-socket path,
 * so the choice is made here.
 *
 * Encoding is picked from the header's q-values, not by substring matching: `gzip;q=0` is a
 * refusal, and `*;q=0` with an explicit gzip is still a gzip. The encoded bytes are cached per
 * (version, encoding) because the artifacts only change when their file does — the server passes a
 * version string derived from the file's mtime and size.
 */

export type ArtifactEncoding = "gzip" | "zstd";

/**
 * Encodings this process can produce, in preference order for a client that accepts both.
 *
 * zstd is not always the smaller of the two on these artifacts (measured 2026-11-02: gzip wins
 * on the dashboard, the agent tree and the contest list, zstd on the 657 KB graph page, within a
 * few percent either way), but it decodes faster, so it stays first.
 */
const SUPPORTED: readonly ArtifactEncoding[] = ["zstd", "gzip"];

/** Below this, the framing overhead is not worth the CPU. */
const MIN_COMPRESS_BYTES = 1024;

/** One entry per artifact version; the plain bytes are reused for every encoding. */
interface CachedBody {
  plain: Uint8Array<ArrayBuffer>;
  /** Content-derived validator, so `If-None-Match` works without a `Last-Modified`. */
  etag: string;
  encoded: Partial<Record<ArtifactEncoding, Uint8Array<ArrayBuffer>>>;
}

const bodies = new Map<string, CachedBody>();
const MAX_CACHED_BODIES = 48;

/**
 * The best encoding the client accepts, or `null` for identity.
 *
 * Returns `null` for a missing or unparseable header — deliberately, because serving identity is
 * always a valid response while guessing an encoding is not.
 */
export function negotiateEncoding(
  header: string | null,
): ArtifactEncoding | null {
  if (!header) return null;
  const quality = new Map<string, number>();
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.trim().toLowerCase().split(";");
    const name = rawName?.trim() ?? "";
    if (name === "") continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key !== "q" || value === undefined) continue;
      const parsed = Number(value);
      q = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 1;
    }
    quality.set(name, q);
  }
  const wildcard = quality.get("*");
  let best: { encoding: ArtifactEncoding; q: number } | null = null;
  for (const encoding of SUPPORTED) {
    const q = quality.get(encoding) ?? wildcard ?? 0;
    if (q <= 0) continue;
    if (best === null || q > best.q) best = { encoding, q };
  }
  return best?.encoding ?? null;
}

function encode(
  bytes: Uint8Array<ArrayBuffer>,
  encoding: ArtifactEncoding,
): Uint8Array<ArrayBuffer> {
  // Bun returns a Uint8Array (ArrayBufferLike); copy into a plain view so the cached type is exact.
  return encoding === "zstd"
    ? new Uint8Array(Bun.zstdCompressSync(bytes))
    : new Uint8Array(Bun.gzipSync(bytes));
}

/**
 * A strong ETag for the bytes: `"<32 hex>"`, 128 bits of SHA-256.
 *
 * The body is already cached per version, so hashing once per version costs a single pass and
 * gives every encoded route a validator without a `Last-Modified` (there is no file behind a
 * JSON payload — the version string is the only timestamp).
 */
export function etagForBytes(bytes: Uint8Array<ArrayBuffer>): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return `"${hasher.digest("hex").slice(0, 32)}"`;
}

/**
 * RFC 9110 §13.1.2 `If-None-Match`: a comma list, `*`, and the weak `W/` form all compare
 * weakly for a GET (a weak validator may match the strong one).
 */
export function ifNoneMatchMatches(
  header: string | null,
  etag: string,
): boolean {
  if (header === null || header === "") return false;
  for (const part of header.split(",")) {
    const candidate = part.trim();
    if (candidate === "*") return true;
    const normalized = candidate.startsWith("W/")
      ? candidate.slice(2).trim()
      : candidate;
    if (normalized === etag) return true;
  }
  return false;
}

function bodyFor(
  version: string,
  produce: () => Uint8Array<ArrayBuffer>,
): CachedBody {
  const hit = bodies.get(version);
  if (hit !== undefined) return hit;
  if (bodies.size >= MAX_CACHED_BODIES) bodies.clear();
  const plain = produce();
  const entry: CachedBody = { plain, etag: etagForBytes(plain), encoded: {} };
  bodies.set(version, entry);
  return entry;
}

/**
 * A response for `body`, compressed when the client asked and the body is worth it.
 *
 * `version` identifies the bytes: the same string must be reused only while the bytes are the
 * same. Callers derive it from the artifact's mtime and size.
 */
export function encodedResponse(
  req: Request,
  options: {
    readonly version: string;
    readonly contentType: string;
    readonly produce: () => Uint8Array<ArrayBuffer>;
    readonly headers?: Record<string, string>;
    /**
     * Reuse the bytes across requests. `false` for a payload assembled per request (it would
     * otherwise fill the 48-entry cache with volatile bodies and evict the stable ones).
     */
    readonly cache?: boolean;
  },
): Response {
  if (options.cache === false) {
    const plain = options.produce();
    return respondWithBytes(req, plain, etagForBytes(plain), options);
  }
  const entry = bodyFor(options.version, options.produce);
  return respondWithBytes(req, entry.plain, entry.etag, options);
}

/**
 * A JSON response with a content-derived ETag and the same `Accept-Encoding` handling.
 *
 * Bytes are produced per request (there is no version to key a cache on), so this suits payloads
 * that are assembled per call; a conditional request still skips the body on the wire.
 */
export function encodedJsonResponse(
  req: Request,
  payload: unknown,
  options: {
    readonly status?: number;
    readonly headers?: Record<string, string>;
  } = {},
): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return respondWithBytes(req, bytes, etagForBytes(bytes), {
    contentType: "application/json; charset=utf-8",
    status: options.status ?? 200,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
}

interface RespondOptions {
  readonly contentType: string;
  readonly status?: number;
  readonly headers?: Record<string, string>;
}

/**
 * One response path for encoded and JSON bodies: validator, negotiated encoding, length.
 *
 * A `304` carries `ETag`/`Cache-Control`/`Vary` and no body; `Cache-Control: private, no-cache`
 * is the default because these payloads are operator data that must revalidate, not be stored by
 * a shared cache.
 */
function respondWithBytes(
  req: Request,
  plain: Uint8Array<ArrayBuffer>,
  etag: string,
  options: RespondOptions,
): Response {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", options.contentType);
  headers.set("ETag", etag);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "private, no-cache");
  }

  const declaredEncoding = headers.has("content-encoding");
  const encoding = declaredEncoding
    ? null
    : negotiateEncoding(req.headers.get("accept-encoding"));
  const willEncode =
    encoding !== null && plain.byteLength >= MIN_COMPRESS_BYTES;
  if (willEncode) appendVary(headers, "Accept-Encoding");

  if (ifNoneMatchMatches(req.headers.get("if-none-match"), etag)) {
    headers.delete("Content-Type");
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }

  if (declaredEncoding) {
    if (!headers.has("content-length")) {
      headers.set("Content-Length", String(plain.byteLength));
    }
    return new Response(plain, { status: options.status ?? 200, headers });
  }

  if (!willEncode) {
    headers.set("Content-Length", String(plain.byteLength));
    return new Response(plain, { status: options.status ?? 200, headers });
  }

  const compressed = encode(plain, encoding);
  headers.set("Content-Encoding", encoding);
  headers.set("Content-Length", String(compressed.byteLength));
  return new Response(compressed, { status: options.status ?? 200, headers });
}

/** Add a token to `Vary` without dropping an existing list or duplicating the token. */
function appendVary(headers: Headers, token: string): void {
  const existing = headers.get("vary");
  if (!existing) {
    headers.set("Vary", token);
    return;
  }
  if (
    !existing
      .split(",")
      .some((part) => part.trim().toLowerCase() === token.toLowerCase())
  ) {
    headers.set("Vary", `${existing}, ${token}`);
  }
}

/**
 * Prepare outgoing headers for a Bun `fetch()` upstream proxy call.
 *
 * Forces `accept-encoding: identity` because Bun's `fetch()` transparently decompresses
 * upstream `gzip`/`zstd`/`br` bodies while keeping `content-encoding` on `Response.headers`;
 * asking upstream for identity avoids double framing bugs and wasted CPU.
 */
export function prepareProxyRequestHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.set("accept-encoding", "identity");
  return headers;
}

/**
 * Forward a Bun `fetch()` upstream `Response` safely from a `Bun.serve` handler.
 *
 * Deletes `content-encoding` and `content-length` because Bun's `fetch()` exposes an
 * already-decoded body stream; leaving those headers intact causes `ERR_CONTENT_DECODING_FAILED`
 * when the browser attempts to decode plain JSON/bytes a second time.
 */
export function forwardProxiedResponse(upstream: Response): Response {
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** Drop cached bodies; tests use it to prove the cache is keyed on the version, not the path. */
export function resetEncodedBodies(): void {
  bodies.clear();
}
