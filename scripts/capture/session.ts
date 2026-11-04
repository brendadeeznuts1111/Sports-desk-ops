/**
 * FetchSession wrapper for the live capture data path.
 *
 * Design points from the probed Bun 1.4.4 contract:
 *   - one `Bun.FetchSession` per capture run (connection pooling), closed in a
 *     `finally`;
 *   - TLS verification is never bypassed (`rejectUnauthorized: true`);
 *   - a session-level `proxy` overrides the environment for every request on
 *     this pool; `direct: true` maps to `proxy: false` and wins over both (the
 *     request option takes precedence over the session's);
 *   - retries are limited to read-only requests on 429/5xx (max two), honoring
 *     `Retry-After`;
 *   - thrown errors are redacted before they can reach a log or the CLI.
 */

import { redactError, redactUrlForLog } from "./redact.ts";
import type { HttpMethod, RawHttpRequest, RawHttpResponse } from "./types.ts";

export type SessionErrorCode =
  "timeout" | "network" | "response-too-large" | "closed";

export class SessionError extends Error {
  readonly code: SessionErrorCode;

  constructor(code: SessionErrorCode, message: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

/** Structural view of `Bun.FetchSession.fetch` so tests can inject a fake. */
export interface FetchSessionLike {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export type FetchSessionFactory = () => FetchSessionLike;

export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_BACKOFF_MS = 500;
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface SessionOptions {
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  maxResponseBytes?: number;
  /**
   * Session-level proxy for every request on this pool.
   *
   * - `false` connects directly even when `HTTP_PROXY` / `HTTPS_PROXY` /
   *   `ALL_PROXY` are set;
   * - a string, `URL`, or `{ url, headers, respectNoProxy }` selects that proxy;
   * - omitted reads the environment on every request.
   *
   * A request's own `direct: true` still wins (it sends `proxy: false`).
   */
  proxy?: Bun.FetchProxyOption | undefined;
  /** Injectable transport constructor; defaults to `Bun.FetchSession`. */
  sessionFactory?: FetchSessionFactory;
  /** Injectable sleep for retry tests. */
  sleep?: (ms: number) => Promise<void>;
}

const makeDefaultFactory =
  (proxy?: Bun.FetchProxyOption): FetchSessionFactory =>
  () => {
    const session = new Bun.FetchSession({
      tls: { rejectUnauthorized: true },
      proxy,
    });
    return {
      fetch: (url: string, init?: RequestInit) => session.fetch(url, init),
      close: async () => {
        await session.close();
      },
    };
  };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Methods the capture core is allowed to put on the wire. */
const ALLOWED_METHODS: ReadonlySet<HttpMethod> = new Set(["GET", "POST"]);

/**
 * Retry decision for one attempt. `maxRetries` counts additional attempts after
 * the first (so maxRetries=2 means at most 3 requests).
 */
export function shouldRetry(options: {
  status: number;
  attempt: number;
  maxRetries: number;
  retryable: boolean;
}): boolean {
  if (!options.retryable) return false;
  if (options.attempt >= options.maxRetries) return false;
  return options.status === 429 || options.status >= 500;
}

/**
 * Delay before the next attempt. `Retry-After` may be delta-seconds or an
 * HTTP-date; malformed values fall back to exponential backoff.
 */
export function retryDelayMs(
  headers: Record<string, string>,
  attempt: number,
  backoffMs: number,
  now: number = Date.now(),
): number {
  const raw = findHeader(headers, "retry-after");
  if (raw !== null) {
    const seconds = Number(raw.trim());
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.round(seconds * 1000);
    const dateMs = Date.parse(raw);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - now);
  }
  return backoffMs * 2 ** attempt;
}

function findHeader(
  headers: Record<string, string>,
  name: string,
): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

function contentTypeOf(headers: Record<string, string>): string {
  const raw = findHeader(headers, "content-type");
  if (raw === null) return "";
  return raw.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Fetches read-only requests through a single, closable FetchSession. */
export class HttpSession {
  readonly kind = "live" as const;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private session: FetchSessionLike | null = null;

  constructor(options: SessionOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? defaultSleep;
    this.sessionFactory =
      options.sessionFactory ?? makeDefaultFactory(options.proxy);
  }

  private readonly sessionFactory: FetchSessionFactory;

  /** Fetch one request, applying timeout + read-only retry policy. */
  async fetch(request: RawHttpRequest): Promise<RawHttpResponse> {
    if (!ALLOWED_METHODS.has(request.method)) {
      throw new SessionError(
        "network",
        `refusing unsupported HTTP method ${request.method}`,
      );
    }
    const effectiveTimeout = request.timeoutMs ?? this.timeoutMs;
    let attempt = 0;
    for (;;) {
      const response = await this.fetchOnce(request, effectiveTimeout);
      const retryable = request.retryable === true;
      if (
        !shouldRetry({
          status: response.status,
          attempt,
          maxRetries: this.maxRetries,
          retryable,
        })
      ) {
        return response;
      }
      const delay = retryDelayMs(response.headers, attempt, this.backoffMs);
      attempt += 1;
      await this.sleep(delay);
    }
  }

  private async fetchOnce(
    request: RawHttpRequest,
    timeoutMs: number,
  ): Promise<RawHttpResponse> {
    const session = this.ensureSession();
    const headers = request.headers ?? {};
    const init: RequestInit & { timeout?: number; proxy?: false } = {
      method: request.method,
      headers,
      timeout: timeoutMs,
    };
    if (request.body !== undefined && request.body !== null) {
      init.body = request.body;
    }
    if (request.direct === true) init.proxy = false;

    let response: Response;
    try {
      response = await session.fetch(request.url, init);
    } catch (error) {
      throw this.toSessionError("network", request.url, error);
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    const declaredLength = Number(responseHeaders["content-length"] ?? "");
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > this.maxResponseBytes
    ) {
      throw new SessionError(
        "response-too-large",
        `response from ${redactUrlForLog(request.url)} exceeds ${this.maxResponseBytes} bytes`,
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw this.toSessionError("network", request.url, error);
    }
    if (bytes.length > this.maxResponseBytes) {
      throw new SessionError(
        "response-too-large",
        `response from ${redactUrlForLog(request.url)} exceeds ${this.maxResponseBytes} bytes`,
      );
    }
    return {
      status: response.status,
      headers: responseHeaders,
      contentType: contentTypeOf(responseHeaders),
      bytes,
    };
  }

  private ensureSession(): FetchSessionLike {
    if (this.session === null) return (this.session = this.sessionFactory());
    return this.session;
  }

  private toSessionError(
    fallback: SessionErrorCode,
    url: string,
    error: unknown,
  ): SessionError {
    const code = isTimeoutLike(error) ? "timeout" : fallback;
    const label = code === "timeout" ? "request timed out" : "request failed";
    return new SessionError(
      code,
      `${label} for ${redactUrlForLog(url)}: ${redactError(error)}`,
    );
  }

  /** Close the underlying FetchSession; safe to call more than once. */
  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session !== null) {
      try {
        await session.close();
      } catch {
        // Closing must never mask a capture error.
      }
    }
  }
}

function isTimeoutLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    /timed?\s*out/i.test(error.message)
  );
}
