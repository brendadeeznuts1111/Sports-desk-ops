/**
 * @file lib/desk_fetch_proxy.ts
 * @description Explicit proxy and timeout policy for desk fetches (issues #393, #399, #400).
 * Every call passes `proxy` so env proxy vars never decide routing: Bun re-reads
 * `HTTPS_PROXY` per request, so routing would follow whatever the process env says now.
 * A proxy comes only from the caller as `{ url, headers }`; credentials belong in
 * `headers["Proxy-Authorization"]` of a plain object, never in the URL, and are never logged.
 * Headers are validated before Bun sees them: since 1.4.4 one bad entry makes fetch reject
 * with a bare TypeError (older Bun dropped every proxy header, Proxy-Authorization included).
 * Timeouts use `AbortSignal.any([timeout, caller])` and surface as named errors.
 */

export type R2Proxy =
  | false
  | {
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

export type ResolvedR2Proxy =
  false | { url: string; headers?: Record<string, string> };

export type R2ProxyUrlErrorReason = "invalid" | "protocol" | "credentials";

export class R2ProxyUrlError extends Error {
  readonly code = "ERR_R2_PROXY_URL" as const;
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

export type R2ProxyConfigErrorReason =
  | "headers-shape"
  | "header-name"
  | "header-value-type"
  | "header-value-crlf"
  | "header-value-non-ascii"
  | "header-duplicate"
  | "runtime";

const CONFIG_MESSAGES: Record<R2ProxyConfigErrorReason, string> = {
  "headers-shape": "proxy headers must be a plain object",
  "header-name": "proxy header name is not an HTTP token",
  "header-value-type": "proxy header value must be a string",
  "header-value-crlf": "proxy header value must not contain CR or LF",
  "header-value-non-ascii": "proxy header value must be printable ASCII",
  "header-duplicate":
    "proxy header is set more than once (names are case-insensitive)",
  runtime: "Bun rejected the proxy headers",
};

/** Never carries a header value; `header` is set only when the name itself is a valid token. */
export class R2ProxyConfigError extends Error {
  readonly code = "ERR_R2_PROXY_CONFIG" as const;
  readonly reason: R2ProxyConfigErrorReason;
  readonly index: number | null;
  readonly header: string | null;
  constructor(
    reason: R2ProxyConfigErrorReason,
    index: number | null = null,
    header: string | null = null,
  ) {
    super(
      `${CONFIG_MESSAGES[reason]}${header === null ? "" : `: ${header}`}${index === null ? "" : ` (entry ${index})`}`,
    );
    this.name = "R2ProxyConfigError";
    this.reason = reason;
    this.index = index;
    this.header = header;
  }
}

const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ASCII_VALUE = /^[\t\x20-\x7e]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function resolveProxyHeaders(headers: unknown): Record<string, string> {
  if (!isPlainObject(headers)) throw new R2ProxyConfigError("headers-shape");
  const copy: Record<string, string> = {};
  const seen = new Set<string>();
  Object.keys(headers).forEach((name, index) => {
    if (!HEADER_TOKEN.test(name)) {
      throw new R2ProxyConfigError("header-name", index);
    }
    const value = headers[name];
    if (typeof value !== "string") {
      throw new R2ProxyConfigError("header-value-type", index, name);
    }
    if (/[\r\n]/.test(value)) {
      throw new R2ProxyConfigError("header-value-crlf", index, name);
    }
    if (!ASCII_VALUE.test(value)) {
      throw new R2ProxyConfigError("header-value-non-ascii", index, name);
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      throw new R2ProxyConfigError("header-duplicate", index, name);
    }
    seen.add(lower);
    copy[name] = value;
  });
  try {
    new Headers(copy);
  } catch {
    throw new R2ProxyConfigError("runtime");
  }
  return copy;
}

const BUN_HEADER_REJECTION =
  /^(?:Invalid header name: '([^]*)'|Header '([^]*)' has invalid value)$/;

/** Bun's header TypeError naming one of our proxy headers becomes {@link R2ProxyConfigError}. */
export function toR2ProxyConfigError(
  error: unknown,
  headers: Readonly<Record<string, string>> | undefined,
): unknown {
  if (!(error instanceof TypeError) || headers === undefined) return error;
  const match = BUN_HEADER_REJECTION.exec(error.message);
  const named = match?.[1] ?? match?.[2];
  if (named === undefined) return error;
  const lower = named.toLowerCase();
  const isProxyHeader = Object.keys(headers).some(
    (name) => name.toLowerCase() === lower,
  );
  return isProxyHeader ? new R2ProxyConfigError("runtime") : error;
}

export class R2ProxyTunnelError extends Error {
  readonly code = "ERR_R2_PROXY_TUNNEL" as const;
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

/** `undefined` means direct (`false`); an object proxy's URL and headers are validated and copied. */
export function resolveR2Proxy(proxy: R2Proxy | undefined): ResolvedR2Proxy {
  if (proxy === undefined || proxy === false) return false;
  let parsed: URL;
  try {
    parsed = new URL(proxy.url);
  } catch {
    throw new R2ProxyUrlError("invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new R2ProxyUrlError("protocol");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new R2ProxyUrlError("credentials");
  }
  return proxy.headers === undefined
    ? { url: parsed.href }
    : { url: parsed.href, headers: resolveProxyHeaders(proxy.headers) };
}

interface ProxyTunnelLike {
  readonly code?: unknown;
  readonly status?: unknown;
  readonly statusText?: unknown;
  readonly headers?: unknown;
}

/** Bun's `ERR_PROXY_TUNNEL` becomes {@link R2ProxyTunnelError}; anything else passes through. */
export function toR2ProxyTunnelError(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return error;
  const tunnel = error as ProxyTunnelLike;
  if (tunnel.code !== "ERR_PROXY_TUNNEL") return error;
  const proxyAuthenticate =
    tunnel.headers instanceof Headers
      ? tunnel.headers.get("proxy-authenticate")
      : null;
  return new R2ProxyTunnelError(
    typeof tunnel.status === "number" ? tunnel.status : null,
    typeof tunnel.statusText === "string" ? tunnel.statusText : "",
    proxyAuthenticate,
    { cause: error },
  );
}

export type ProxyAwareFetch = (
  input: string,
  init: BunFetchRequestInit,
) => Promise<Response>;

/** Fetch with `proxy` always set (default `false`); tunnel refusals and header rejections are named. */
export async function fetchWithProxyPolicy(
  fetchImpl: ProxyAwareFetch,
  input: string,
  init: BunFetchRequestInit,
  proxy: R2Proxy | undefined,
): Promise<Response> {
  const resolved = resolveR2Proxy(proxy);
  try {
    return await fetchImpl(input, { ...init, proxy: resolved });
  } catch (error) {
    throw toR2ProxyTunnelError(
      toR2ProxyConfigError(
        error,
        resolved === false ? undefined : resolved.headers,
      ),
    );
  }
}

/** Same 30s default as signed R2 fetches (`DEFAULT_R2_FETCH_TIMEOUT_MS`). */
export const DEFAULT_DESK_FETCH_TIMEOUT_MS = 30_000;

/** Connect-failure `.code`s on Bun's fetch `TypeError` treated as transient. */
export const DESK_TRANSIENT_NETWORK_CODES = [
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNABORTED",
  "EAI_AGAIN",
] as const;

export function resolveDeskTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_DESK_FETCH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }
  return Math.ceil(timeoutMs);
}

export class DeskTimeoutError extends Error {
  readonly code = "ERR_DESK_TIMEOUT" as const;
  readonly url: string;
  readonly ms: number;
  constructor(url: string, ms: number, options: { readonly cause: unknown }) {
    super(`fetch ${url} timed out after ${ms}ms`, { cause: options.cause });
    this.name = "DeskTimeoutError";
    this.url = url;
    this.ms = ms;
  }
}

export class DeskNetworkError extends Error {
  readonly url: string;
  /** The fetch error's `.code` (e.g. `ECONNREFUSED`), or null when it had none. */
  readonly code: string | null;
  readonly transient: boolean;
  constructor(
    url: string,
    code: string | null,
    options: { readonly cause: unknown },
  ) {
    super(`fetch ${url} network error (${code ?? "no code"})`, {
      cause: options.cause,
    });
    this.name = "DeskNetworkError";
    this.url = url;
    this.code = code;
    this.transient =
      code !== null &&
      (DESK_TRANSIENT_NETWORK_CODES as readonly string[]).includes(code);
  }
}

export interface DeskFetchPolicyOptions {
  readonly proxy?: R2Proxy;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function errorCode(error: unknown): string | null {
  const code =
    typeof error === "object" && error !== null
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return typeof code === "string" && code !== "" ? code : null;
}

/**
 * Fetch under the proxy policy with `AbortSignal.any([timeout, caller])`.
 * Rejects with {@link DeskTimeoutError} on our timeout, the caller's abort
 * reason on theirs, preserves proxy URL/configuration/tunnel errors, else
 * {@link DeskNetworkError}.
 */
export async function fetchWithDeskPolicy(
  fetchImpl: ProxyAwareFetch,
  input: string,
  init: BunFetchRequestInit,
  options?: DeskFetchPolicyOptions,
): Promise<Response> {
  const timeoutMs = resolveDeskTimeoutMs(options?.timeoutMs);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signals = [timeout];
  if (options?.signal) signals.push(options.signal);
  if (init.signal && init.signal !== options?.signal) signals.push(init.signal);
  const signal = signals.length === 1 ? timeout : AbortSignal.any(signals);
  try {
    return await fetchWithProxyPolicy(
      fetchImpl,
      input,
      { ...init, signal },
      options?.proxy,
    );
  } catch (error) {
    if (
      error instanceof R2ProxyConfigError ||
      error instanceof R2ProxyUrlError ||
      error instanceof R2ProxyTunnelError
    ) {
      throw error;
    }
    if (
      signal.aborted &&
      (Object.is(error, signal.reason) ||
        (error instanceof Error && error.name === "AbortError"))
    ) {
      if (timeout.aborted && Object.is(signal.reason, timeout.reason)) {
        throw new DeskTimeoutError(input, timeoutMs, { cause: error });
      }
      throw signal.reason;
    }
    throw new DeskNetworkError(input, errorCode(error), { cause: error });
  }
}
