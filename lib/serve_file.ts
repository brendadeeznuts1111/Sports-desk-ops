/**
 * @file lib/serve_file.ts
 * @description Range-aware, validator-aware static file handler for `Bun.serve` on Bun 1.4.4.
 *
 * `new Response(Bun.file(path))` answers `Range` requests correctly out of the box, so this is not
 * a replacement for that — it is what the reply is missing around it. Measured on 1.4.4 against
 * exactly that response:
 *
 *   1. `Accept-Ranges: bytes` appears only on the 206, never on the initial 200. A player that
 *      probes the first response for seekability therefore has to guess.
 *   2. `Range: bytes=0-1,2000-2003` returns the whole file with 200. Legal (`Range` may be
 *      ignored) but the opposite of what was asked: a player fetching a header box and an index
 *      gets the entire body twice over.
 *   3. No `ETag`, so no `304` and every seek or retry pays for the body again. It also ignores
 *      `If-Modified-Since`, which is the only validator some clients send.
 *   4. No `If-Range`, so a seek issued after the file was replaced splices new bytes into the
 *      client's old buffer.
 *   5. No method guard and no containment: a catch-all `fetch` answers `POST`, and a joined path
 *      or a symlink reads outside the directory.
 *
 * Range parsing is local instead of delegated to the platform. Delegating works, but Bun appends
 * its own `Accept-Ranges` to the caller's, and a wire capture shows a 206 carrying
 * `Accept-Ranges: bytes` twice. Owning the parse keeps every response single-valued and lets
 * `If-Range` share one code path with the plain 206.
 *
 * Path containment is not re-implemented here: `containedAssetPath` already owns that decision
 * (decode, reject `..`, `realpath`, then compare), including the symlink escape measured on this
 * Bun. This module adds the rules that are its own — dot segments and the method guard.
 */

import { extname } from "node:path";

import { containedAssetPath } from "./asset_path.ts";

export interface ServeFileOptions {
  /** Directory a request may read from. */
  readonly root: string;
  /** Value of `Cache-Control`. Default `public, max-age=60`. */
  readonly cacheControl?: string;
  /** Extension → MIME overrides, merged over the built-in table. */
  readonly types?: Readonly<Record<string, string>>;
  /** Multipart boundary. Default is unique per response; see `multipartResponse`. */
  readonly boundary?: string;
  /**
   * Sent as `Content-Disposition`. Default `inline`.
   *
   * Worth setting explicitly: for a file whose type resolves to `application/octet-stream`, Bun
   * adds its own `Content-Disposition: filename="…"` (measured 1.4.4), which some browsers treat
   * as a download. Naming the disposition keeps playback in the tab.
   */
  readonly disposition?: "inline" | "attachment" | "none";
}

export type ServeFile = (
  req: Request,
  url: URL,
) => Response | Promise<Response>;

/** One `bytes=` range already resolved against the file size. */
interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export type RangeParse =
  | { readonly kind: "ignore" }
  | { readonly kind: "unsatisfiable" }
  | { readonly kind: "ranges"; readonly ranges: readonly ByteRange[] };

/**
 * A multi-range request is answered with every requested range, so an unbounded spec is unbounded
 * work. Past this many, `Range` is ignored (RFC 9110 §14.2 permits ignoring it).
 */
export const MAX_RANGES = 16;

const DEFAULT_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
};

/** MIME for an extension, falling back to `application/octet-stream`. */
export function mimeFor(
  path: string,
  overrides: Readonly<Record<string, string>> = {},
): string {
  const ext = extname(path).toLowerCase();
  return overrides[ext] ?? DEFAULT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Parse a `Range` header for a resource of `size` bytes.
 *
 * `ignore` covers everything RFC 9110 §14.2 lets a server ignore: an unknown unit, a non-`bytes`
 * unit, or a malformed spec. `unsatisfiable` is the one case that must be answered with 416, and
 * only when *every* requested range is past EOF.
 */
export function parseByteRange(header: string, size: number): RangeParse {
  const match = /^bytes=(.+)$/i.exec(header.trim());
  if (match === null || match[1] === undefined) return { kind: "ignore" };

  const ranges: ByteRange[] = [];
  let allUnsatisfiable = true;
  for (const spec of match[1].split(",")) {
    const part = spec.trim();
    if (part === "") return { kind: "ignore" };
    const [startRaw, endRaw, extra] = part.split("-");
    if (startRaw === undefined || endRaw === undefined || extra !== undefined) {
      return { kind: "ignore" };
    }
    if (startRaw === "") {
      // `bytes=-N`: the last N bytes.
      const suffix = Number(endRaw);
      if (!Number.isInteger(suffix) || suffix <= 0) return { kind: "ignore" };
      if (size === 0) continue;
      ranges.push({ start: Math.max(0, size - suffix), end: size - 1 });
      allUnsatisfiable = false;
      continue;
    }
    const start = Number(startRaw);
    if (!Number.isInteger(start) || start < 0) return { kind: "ignore" };
    const end = endRaw === "" ? size - 1 : Number(endRaw);
    if (!Number.isInteger(end) || end < start) return { kind: "ignore" };
    if (start >= size) continue; // past EOF: unsatisfiable, but a later range may still fit
    ranges.push({ start, end: Math.min(end, size - 1) });
    allUnsatisfiable = false;
  }

  if (ranges.length === 0) {
    return allUnsatisfiable ? { kind: "unsatisfiable" } : { kind: "ignore" };
  }
  if (ranges.length > MAX_RANGES) return { kind: "ignore" };
  return { kind: "ranges", ranges };
}

/** Validator: changes whenever the bytes or the write time change. */
export function entityTag(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

/**
 * Whether an `If-Range` value still describes the current file.
 *
 * The header carries a strong entity-tag or an HTTP-date. An entity-tag that does not match, a
 * weak validator (`W/"…"`, which RFC 9110 §13.1.5 says to ignore here), or an unparseable value
 * all count as a mismatch — the caller then sends the whole file instead of a range.
 */
export function ifRangeMatches(
  value: string,
  etag: string,
  mtimeMs: number,
): boolean {
  if (value === etag) return true;
  // A quoted or weak value is an entity-tag that did not match; never parse it as a date.
  if (value.startsWith('"') || value.startsWith("W/")) return false;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return false;
  return Math.floor(mtimeMs / 1_000) <= Math.floor(dateMs / 1_000);
}

/**
 * A `GET`/`HEAD` handler over `options.root`.
 *
 * Dot-prefixed segments are refused: a handler rooted at a media directory has no business
 * reading `.env`, and the containment helper deliberately allows names like `.well-known`.
 */
export function createServeFile(options: ServeFileOptions): ServeFile {
  const cacheControl = options.cacheControl ?? "public, max-age=60";
  const types = options.types ?? {};
  const disposition = options.disposition ?? "inline";
  // A fixed boundary can occur inside binary payloads, so the default is unique per response;
  // RFC 9110 §14.6 only requires that it not appear in the body.
  const boundary = options.boundary ?? null;

  return async (req, url) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const raw = url.pathname.replace(/^\/+/, "");
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (
      decoded === "" ||
      decoded.includes("\0") ||
      decoded.split("/").some((part) => part === "" || part.startsWith("."))
    ) {
      return new Response("not found", { status: 404 });
    }

    const absolute = containedAssetPath(options.root, raw);
    if (absolute === null) return new Response("not found", { status: 404 });

    // `Bun.file(path).stat()` is the declared shape for this (`Promise<node:fs.Stats>`), and it
    // does not block the event loop the way `statSync` does on every request.
    const file = Bun.file(absolute);
    let size: number;
    let mtimeMs: number;
    try {
      const stats = await file.stat();
      if (!stats.isFile()) return new Response("not found", { status: 404 });
      size = stats.size;
      mtimeMs = stats.mtimeMs;
    } catch {
      return new Response("not found", { status: 404 });
    }

    const etag = entityTag(size, mtimeMs);
    const headers: Record<string, string> = {
      "Content-Type": mimeFor(absolute, types),
      "Cache-Control": cacheControl,
      ETag: etag,
      "Last-Modified": new Date(mtimeMs).toUTCString(),
      "Accept-Ranges": "bytes",
    };
    if (disposition !== "none") headers["Content-Disposition"] = disposition;

    const ifNoneMatch = req.headers.get("if-none-match")?.trim();
    // `*` means "if any current representation exists", which it does — this point is only
    // reached once the file has been resolved.
    if (ifNoneMatch === "*" || ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers });
    }
    // `If-None-Match` outranks `If-Modified-Since` (RFC 9110 §13.1.3), so the date is only
    // consulted when no entity-tag was sent. HTTP dates have one-second resolution, so both
    // sides are floored: a file written 400 ms into a second is not "modified since" that second.
    if (ifNoneMatch === undefined) {
      const since = req.headers.get("if-modified-since");
      const sinceMs = since === null ? Number.NaN : Date.parse(since);
      if (
        Number.isFinite(sinceMs) &&
        Math.floor(mtimeMs / 1_000) <= Math.floor(sinceMs / 1_000)
      ) {
        return new Response(null, { status: 304, headers });
      }
    }

    const rangeHeader = req.headers.get("range");
    const ifRange = req.headers.get("if-range")?.trim();
    // `If-Range` with a validator that no longer matches means "send the whole current file":
    // splicing a range from the new bytes into the client's old buffer corrupts the stream.
    // The header carries either a strong entity-tag or an HTTP-date, and a weak validator must
    // not gate a range at all (RFC 9110 §13.1.5), so anything else is treated as a mismatch.
    const rangeApplies =
      rangeHeader !== null &&
      (ifRange === undefined || ifRangeMatches(ifRange, etag, mtimeMs));
    const parsed: RangeParse = rangeApplies
      ? parseByteRange(rangeHeader, size)
      : { kind: "ignore" };

    if (parsed.kind === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${size}` },
      });
    }

    if (parsed.kind === "ignore") {
      // `Content-Length` is required for HEAD: a null body would otherwise report 0.
      return new Response(req.method === "HEAD" ? null : file, {
        headers: { ...headers, "Content-Length": String(size) },
      });
    }

    const { ranges } = parsed;
    const only = ranges[0];
    if (ranges.length === 1 && only !== undefined) {
      const { start, end } = only;
      return new Response(
        req.method === "HEAD" ? null : file.slice(start, end + 1),
        {
          status: 206,
          headers: {
            ...headers,
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": String(end - start + 1),
          },
        },
      );
    }

    return multipartResponse(
      req.method,
      file,
      ranges,
      size,
      headers,
      boundary ?? `bun-${crypto.randomUUID()}`,
    );
  };
}

/**
 * `multipart/byteranges`, streamed so a multi-range request never buffers its ranges.
 *
 * Bun answers this request with the whole file and a 200. That is RFC-legal but it is never what
 * the client asked for, so the ranges are answered here instead. The body is streamed rather than
 * concatenated: a client may ask for ranges spanning gigabytes, and buffering them to learn a
 * `Content-Length` would trade a self-delimiting body for a memory ceiling.
 */
function multipartResponse(
  method: string,
  file: ReturnType<typeof Bun.file>,
  ranges: readonly ByteRange[],
  size: number,
  headers: Record<string, string>,
  boundary: string,
): Response {
  const encoder = new TextEncoder();
  const parts = ranges.map(({ start, end }) => ({
    header: encoder.encode(
      `--${boundary}\r\nContent-Type: ${headers["Content-Type"]}\r\nContent-Range: bytes ${start}-${end}/${size}\r\n\r\n`,
    ),
    body: file.slice(start, end + 1),
  }));
  const tail = encoder.encode(`--${boundary}--\r\n`);
  // No `Content-Length`: Bun sends a streaming body with `Transfer-Encoding: chunked` and omits
  // the header (measured on the wire, 1.4.4), so declaring one would be a promise this response
  // cannot keep. The closing boundary is what delimits it.
  const outHeaders = {
    ...headers,
    "Content-Type": `multipart/byteranges; boundary=${boundary}`,
  };

  if (method === "HEAD") {
    return new Response(null, { status: 206, headers: outHeaders });
  }

  let index = 0;
  let headerPending = true;
  // Inferred, not annotated: `Blob#stream()` is declared against the DOM `ReadableStream`, while
  // the global here is Bun's (which adds `readMany`). Naming the type is what fails; reading from
  // the returned object is identical at runtime.
  const readers = parts.map((part) => part.body.stream().getReader());
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (index >= parts.length) {
          controller.enqueue(tail);
          controller.close();
          return;
        }
        const part = parts[index];
        const reader = readers[index];
        if (part === undefined || reader === undefined) {
          controller.enqueue(tail);
          controller.close();
          return;
        }
        if (headerPending) {
          headerPending = false;
          controller.enqueue(part.header);
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          index += 1;
          headerPending = true;
          continue;
        }
        controller.enqueue(value);
        return;
      }
    },
  });
  return new Response(stream, { status: 206, headers: outHeaders });
}
