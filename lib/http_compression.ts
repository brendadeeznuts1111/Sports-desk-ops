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
  // Bun returns a Buffer (ArrayBufferLike); copy into a plain view so the cached type is exact.
  return encoding === "zstd"
    ? new Uint8Array(Bun.zstdCompressSync(bytes))
    : new Uint8Array(Bun.gzipSync(bytes));
}

function bodyFor(
  version: string,
  produce: () => Uint8Array<ArrayBuffer>,
): CachedBody {
  const hit = bodies.get(version);
  if (hit !== undefined) return hit;
  if (bodies.size >= MAX_CACHED_BODIES) bodies.clear();
  const entry: CachedBody = { plain: produce(), encoded: {} };
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
  },
): Response {
  const entry = bodyFor(options.version, options.produce);
  const headers: Record<string, string> = {
    ...options.headers,
    "Content-Type": options.contentType,
  };
  const encoding = negotiateEncoding(req.headers.get("accept-encoding"));
  if (encoding === null || entry.plain.byteLength < MIN_COMPRESS_BYTES) {
    headers["Content-Length"] = String(entry.plain.byteLength);
    return new Response(entry.plain, { headers });
  }
  const compressed =
    entry.encoded[encoding] ??
    (entry.encoded[encoding] = encode(entry.plain, encoding));
  headers["Content-Encoding"] = encoding;
  headers["Content-Length"] = String(compressed.byteLength);
  // The response differs per client, so a shared cache must key on the header.
  headers["Vary"] = headers["Vary"]
    ? `${headers["Vary"]}, Accept-Encoding`
    : "Accept-Encoding";
  return new Response(compressed, { headers });
}

/** Drop cached bodies; tests use it to prove the cache is keyed on the version, not the path. */
export function resetEncodedBodies(): void {
  bodies.clear();
}
