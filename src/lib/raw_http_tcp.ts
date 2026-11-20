/**
 * @file src/lib/raw_http_tcp.ts
 * @description RFC 9110/9112 strict raw HTTP/1.1 TCP framing primitives and `Bun.connect` client.
 *
 * Preserves verbatim wire request targets (e.g. `/./`, `/../`, `//`, `%2F`, `%68`) without WHATWG
 * `URL`/`fetch()` normalization while enforcing strict CRLF, duplicate-header, Content-Length /
 * Transfer-Encoding smuggling, and chunked-trailer boundaries.
 */

import { isIP } from "node:net";

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HOST_FORBIDDEN_CHARS_RE = /[/@?#%]/;
const CONTENT_LENGTH_RE = /^\d+$/;
const STATUS_LINE_RE = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("latin1");

function hasCrlf(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x0d || code === 0x0a) return true;
  }
  return false;
}

/** RFC 9110 VCHAR (0x21-0x7e): rejects NUL, CTLs, SP, DEL, and non-ASCII. */
function hasNonVchar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return true;
  }
  return false;
}

/** RFC 9110 field-content (ASCII-strict): HTAB (0x09) + SP/VCHAR (0x20-0x7e). */
function hasInvalidHeaderValueChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code !== 0x09 && (code < 0x20 || code > 0x7e)) return true;
  }
  return false;
}

function assertNoCrlf(value: string, label: string): void {
  if (hasCrlf(value)) {
    throw new Error(`[ERR_RAW_TCP_INVALID_HEADER] CR/LF forbidden in ${label}`);
  }
}

export function formatHostHeader(
  hostname: string,
  port: number,
  defaultPort = 80,
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[ERR_RAW_TCP_INVALID_PORT] Invalid TCP port ${port}`);
  }
  if (
    !Number.isInteger(defaultPort) ||
    defaultPort < 1 ||
    defaultPort > 65535
  ) {
    throw new Error(
      `[ERR_RAW_TCP_INVALID_PORT] Invalid default TCP port ${defaultPort}`,
    );
  }

  const normalizedHost = hostname.trim();
  if (
    normalizedHost.length === 0 ||
    hasNonVchar(normalizedHost) ||
    HOST_FORBIDDEN_CHARS_RE.test(normalizedHost)
  ) {
    throw new Error(
      `[ERR_RAW_TCP_INVALID_HEADER] Invalid hostname "${hostname}"`,
    );
  }

  let host: string;
  if (normalizedHost.startsWith("[")) {
    const inner = normalizedHost.slice(1, -1);
    if (
      !normalizedHost.endsWith("]") ||
      inner.includes("[") ||
      inner.includes("]") ||
      isIP(inner) !== 6
    ) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Malformed IPv6 host "${hostname}"`,
      );
    }
    host = normalizedHost;
  } else {
    if (normalizedHost.includes("]")) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Malformed IPv6 host "${hostname}"`,
      );
    }
    const colonCount = normalizedHost.split(":").length - 1;
    if (colonCount === 1) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Hostname must not embed port "${hostname}"`,
      );
    }
    if (colonCount >= 2) {
      if (isIP(normalizedHost) !== 6) {
        throw new Error(
          `[ERR_RAW_TCP_INVALID_HEADER] Malformed IPv6 host "${hostname}"`,
        );
      }
      host = `[${normalizedHost}]`;
    } else {
      host = normalizedHost;
    }
  }

  return port === defaultPort ? host : `${host}:${port}`;
}

export interface BuildRequestOptions {
  readonly defaultPort?: number;
  readonly connection?: "close" | "keep-alive";
}

export function buildRequestPayload(
  rawTarget: string,
  method: string,
  hostname: string,
  port: number,
  headers: Record<string, string>,
  bodyBytes: Uint8Array | null,
  options: BuildRequestOptions = {},
): Uint8Array {
  assertNoCrlf(method, "method");
  assertNoCrlf(rawTarget, "rawTarget");

  if (!TOKEN_RE.test(method)) {
    throw new Error(
      `[ERR_RAW_TCP_INVALID_METHOD] Invalid HTTP method "${method}"`,
    );
  }
  if (
    rawTarget.length === 0 ||
    hasNonVchar(rawTarget) ||
    rawTarget.includes("#")
  ) {
    throw new Error(
      `[ERR_RAW_TCP_INVALID_TARGET] Invalid request target "${rawTarget}"`,
    );
  }

  const seenLower = new Set<string>();
  const customLines: string[] = [];
  let explicitContentLength: string | undefined;

  for (const [k, v] of Object.entries(headers)) {
    assertNoCrlf(k, "header key");
    assertNoCrlf(v, `header value for "${k}"`);
    if (hasInvalidHeaderValueChar(v)) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Invalid character in header value for "${k}"`,
      );
    }

    const key = k.trim();
    if (!TOKEN_RE.test(key)) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Invalid header name "${k}"`,
      );
    }

    const lower = key.toLowerCase();
    // Keep first occurrence to prevent duplicate-header smuggling
    if (seenLower.has(lower)) {
      continue;
    }
    seenLower.add(lower);

    const trimmedVal = v.trim();
    if (lower === "content-length") {
      explicitContentLength = trimmedVal;
    }
    customLines.push(`${key}: ${trimmedVal}`);
  }

  if (seenLower.has("content-length") && seenLower.has("transfer-encoding")) {
    throw new Error(
      "[ERR_RAW_TCP_INVALID_HEADER] Conflicting Content-Length and Transfer-Encoding headers",
    );
  }

  if (explicitContentLength !== undefined) {
    if (!CONTENT_LENGTH_RE.test(explicitContentLength)) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Invalid Content-Length "${explicitContentLength}"`,
      );
    }
    const declared = Number(explicitContentLength);
    if (!Number.isSafeInteger(declared)) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Content-Length overflow "${explicitContentLength}"`,
      );
    }
    const actual = bodyBytes?.byteLength ?? 0;
    if (declared !== actual) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Content-Length (${declared}) does not match body length (${actual})`,
      );
    }
  }

  const lines: string[] = [`${method} ${rawTarget} HTTP/1.1`];

  if (!seenLower.has("host")) {
    const hostVal = formatHostHeader(hostname, port, options.defaultPort ?? 80);
    assertNoCrlf(hostVal, "Host");
    lines.push(`Host: ${hostVal}`);
  }

  if (!seenLower.has("connection")) {
    lines.push(`Connection: ${options.connection ?? "close"}`);
  }

  lines.push(...customLines);

  if (
    bodyBytes !== null &&
    !seenLower.has("content-length") &&
    !seenLower.has("transfer-encoding")
  ) {
    lines.push(`Content-Length: ${bodyBytes.byteLength}`);
  }

  const headPayload = TEXT_ENCODER.encode(`${lines.join("\r\n")}\r\n\r\n`);
  if (bodyBytes === null || bodyBytes.byteLength === 0) return headPayload;

  const out = new Uint8Array(headPayload.byteLength + bodyBytes.byteLength);
  out.set(headPayload, 0);
  out.set(bodyBytes, headPayload.byteLength);
  return out;
}

export interface ParsedResponseHead {
  readonly status: number;
  readonly reason: string;
  readonly headers: Record<string, string[]>;
  readonly framing: "chunked" | "content-length" | "eof";
  readonly contentLength: number | null;
}

export function parseResponseHead(
  rawHead: Uint8Array | string,
): ParsedResponseHead {
  const text =
    typeof rawHead === "string" ? rawHead : TEXT_DECODER.decode(rawHead);
  const lines = text.split("\r\n");
  const statusLine = lines[0] ?? "";
  const statusMatch = hasCrlf(statusLine)
    ? null
    : STATUS_LINE_RE.exec(statusLine);
  if (!statusMatch) {
    throw new Error(
      `[ERR_RAW_TCP_INVALID_STATUS] Malformed HTTP status line "${statusLine}"`,
    );
  }

  const status = Number(statusMatch[1]);
  const reason = statusMatch[2] ?? "";
  const headers: Record<string, string[]> = {};

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line === "") break;
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Malformed response header "${line}"`,
      );
    }

    const name = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1).trim();
    if (!TOKEN_RE.test(name)) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Invalid response header name "${name}"`,
      );
    }
    if (hasInvalidHeaderValueChar(value)) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Invalid response header value for "${name}"`,
      );
    }

    const lower = name.toLowerCase();
    const bucket = headers[lower];
    if (bucket === undefined) {
      headers[lower] = [value];
    } else {
      bucket.push(value);
    }
  }

  const teValues = headers["transfer-encoding"];
  const clValues = headers["content-length"];

  if (teValues !== undefined && clValues !== undefined) {
    throw new Error(
      "[ERR_RAW_TCP_INVALID_HEADER] Conflicting Content-Length and Transfer-Encoding in response",
    );
  }

  if (teValues !== undefined) {
    const teTokens = teValues
      .join(",")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (teTokens[teTokens.length - 1] !== "chunked") {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Unsupported Transfer-Encoding "${teValues.join(", ")}"`,
      );
    }
    return { status, reason, headers, framing: "chunked", contentLength: null };
  }

  if (clValues !== undefined) {
    const firstCl = clValues[0];
    const unique = new Set(clValues);
    if (
      firstCl === undefined ||
      unique.size !== 1 ||
      !CONTENT_LENGTH_RE.test(firstCl)
    ) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Invalid or conflicting Content-Length "${clValues.join(", ")}"`,
      );
    }
    const parsedCl = Number(firstCl);
    if (!Number.isSafeInteger(parsedCl)) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_HEADER] Content-Length overflow "${firstCl}"`,
      );
    }
    return {
      status,
      reason,
      headers,
      framing: "content-length",
      contentLength: parsedCl,
    };
  }

  return { status, reason, headers, framing: "eof", contentLength: null };
}

function findCrlf(buf: Uint8Array, start: number): number {
  for (let i = start; i + 1 < buf.byteLength; i += 1) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}

export function findHeaderEnd(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.byteLength; i += 1) {
    if (
      buf[i] === 0x0d &&
      buf[i + 1] === 0x0a &&
      buf[i + 2] === 0x0d &&
      buf[i + 3] === 0x0a
    ) {
      return i;
    }
  }
  return -1;
}

export function decodeChunkedBody(raw: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  let offset = 0;

  while (offset < raw.byteLength) {
    const lineEnd = findCrlf(raw, offset);
    if (lineEnd === -1) {
      throw new Error(
        "[ERR_RAW_TCP_INVALID_CHUNK] Unterminated chunk size line",
      );
    }

    const sizeLine = TEXT_DECODER.decode(raw.subarray(offset, lineEnd));
    const semiIdx = sizeLine.indexOf(";");
    const hexPart = (
      semiIdx === -1 ? sizeLine : sizeLine.slice(0, semiIdx)
    ).trim();
    if (!/^[0-9a-fA-F]+$/.test(hexPart)) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_CHUNK] Invalid chunk size "${sizeLine}"`,
      );
    }

    const chunkSize = Number.parseInt(hexPart, 16);
    if (!Number.isSafeInteger(chunkSize)) {
      throw new Error(
        `[ERR_RAW_TCP_INVALID_CHUNK] Chunk size overflow "${hexPart}"`,
      );
    }

    offset = lineEnd + 2;
    if (chunkSize === 0) {
      while (true) {
        const trailerEnd = findCrlf(raw, offset);
        if (trailerEnd === -1) {
          throw new Error(
            "[ERR_RAW_TCP_INVALID_CHUNK] Unterminated chunked trailer section",
          );
        }
        const trailerLine = TEXT_DECODER.decode(
          raw.subarray(offset, trailerEnd),
        );
        offset = trailerEnd + 2;
        if (trailerLine === "") {
          break;
        }
        const colonIdx = trailerLine.indexOf(":");
        if (colonIdx <= 0) {
          throw new Error(
            `[ERR_RAW_TCP_INVALID_CHUNK] Malformed chunk trailer "${trailerLine}"`,
          );
        }
        const trailerName = trailerLine.slice(0, colonIdx);
        const trailerVal = trailerLine.slice(colonIdx + 1).trim();
        if (
          !TOKEN_RE.test(trailerName) ||
          hasInvalidHeaderValueChar(trailerVal)
        ) {
          throw new Error(
            `[ERR_RAW_TCP_INVALID_CHUNK] Invalid chunk trailer "${trailerLine}"`,
          );
        }
      }

      if (offset !== raw.byteLength) {
        throw new Error(
          "[ERR_RAW_TCP_INVALID_CHUNK] Unexpected trailing bytes after chunked terminator",
        );
      }

      const merged = new Uint8Array(totalLength);
      let cursor = 0;
      for (const chunk of chunks) {
        merged.set(chunk, cursor);
        cursor += chunk.byteLength;
      }
      return merged;
    }

    if (offset + chunkSize + 2 > raw.byteLength) {
      throw new Error("[ERR_RAW_TCP_INVALID_CHUNK] Truncated chunk payload");
    }
    if (
      raw[offset + chunkSize] !== 0x0d ||
      raw[offset + chunkSize + 1] !== 0x0a
    ) {
      throw new Error(
        "[ERR_RAW_TCP_INVALID_CHUNK] Missing CRLF after chunk payload",
      );
    }

    const slice = raw.subarray(offset, offset + chunkSize);
    chunks.push(slice);
    totalLength += chunkSize;
    offset += chunkSize + 2;
  }

  throw new Error(
    "[ERR_RAW_TCP_INVALID_CHUNK] Missing terminating zero-length chunk",
  );
}

export interface RawHttpRequestOptions {
  readonly hostname: string;
  readonly port: number;
  readonly rawTarget: string;
  readonly method?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly body?: Uint8Array | string | null | undefined;
  readonly defaultPort?: number | undefined;
  readonly connection?: "close" | "keep-alive" | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
}

export interface RawHttpResponse {
  readonly status: number;
  readonly reason: string;
  readonly headers: Record<string, string[]>;
  readonly framing: "chunked" | "content-length" | "eof";
  readonly contentLength: number | null;
  readonly body: Uint8Array;
  readonly text: () => string;
}

function concatBytes(
  chunks: readonly Uint8Array[],
  totalLength: number,
): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function sendRawHttpRequest(
  options: RawHttpRequestOptions,
): Promise<RawHttpResponse> {
  const method = options.method ?? "GET";
  const bodyBytes =
    options.body === undefined || options.body === null
      ? null
      : typeof options.body === "string"
        ? TEXT_ENCODER.encode(options.body)
        : options.body;

  const buildOpts: BuildRequestOptions = {
    ...(options.defaultPort !== undefined
      ? { defaultPort: options.defaultPort }
      : {}),
    ...(options.connection !== undefined
      ? { connection: options.connection }
      : {}),
  };

  const payload = buildRequestPayload(
    options.rawTarget,
    method,
    options.hostname,
    options.port,
    options.headers ?? {},
    bodyBytes,
    buildOpts,
  );

  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `[ERR_RAW_TCP_TIMEOUT] Invalid timeoutMs ${String(timeoutMs)}`,
    );
  }

  const maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error(
      `[ERR_RAW_TCP_RESPONSE_TOO_LARGE] Invalid maxResponseBytes ${String(maxResponseBytes)}`,
    );
  }

  const trimmedHost = options.hostname.trim();
  const connectHost =
    trimmedHost.startsWith("[") && trimmedHost.endsWith("]")
      ? trimmedHost.slice(1, -1)
      : trimmedHost;

  return new Promise<RawHttpResponse>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let settled = false;
    let activeSocket: { end: () => void } | null = null;

    const finishError = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        activeSocket?.end();
      } catch {
        // Best-effort socket teardown
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const timer = setTimeout(() => {
      finishError(
        new Error(
          `[ERR_RAW_TCP_TIMEOUT] Raw HTTP request timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    void Bun.connect({
      hostname: connectHost,
      port: options.port,
      socket: {
        open(socket) {
          activeSocket = socket;
          socket.write(payload);
        },
        data(socket, chunk) {
          if (settled) return;
          const copy = new Uint8Array(chunk.byteLength);
          copy.set(chunk);
          totalBytes += copy.byteLength;
          if (totalBytes > maxResponseBytes) {
            socket.end();
            finishError(
              new Error(
                `[ERR_RAW_TCP_RESPONSE_TOO_LARGE] Response exceeded ${maxResponseBytes} bytes`,
              ),
            );
            return;
          }
          chunks.push(copy);
        },
        close() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          try {
            const raw = concatBytes(chunks, totalBytes);
            const headerEnd = findHeaderEnd(raw);
            if (headerEnd === -1) {
              throw new Error(
                "[ERR_RAW_TCP_INVALID_STATUS] Missing HTTP header terminator",
              );
            }

            const head = parseResponseHead(raw.subarray(0, headerEnd + 2));
            const rawBody = raw.subarray(headerEnd + 4);
            const hasNoBody =
              method.toUpperCase() === "HEAD" ||
              (head.status >= 100 && head.status < 200) ||
              head.status === 204 ||
              head.status === 304;

            let body: Uint8Array;
            if (hasNoBody) {
              body = new Uint8Array(0);
            } else if (head.framing === "chunked") {
              body = decodeChunkedBody(rawBody);
            } else if (head.framing === "content-length") {
              if (rawBody.byteLength !== head.contentLength) {
                throw new Error(
                  `[ERR_RAW_TCP_TRUNCATED_BODY] Expected ${head.contentLength} body bytes, received ${rawBody.byteLength}`,
                );
              }
              body = rawBody;
            } else {
              body = rawBody;
            }

            resolve({
              status: head.status,
              reason: head.reason,
              headers: head.headers,
              framing: head.framing,
              contentLength: head.contentLength,
              body,
              text: () => new TextDecoder().decode(body),
            });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
        error(_socket, err) {
          finishError(err);
        },
      },
    }).catch(finishError);
  });
}
