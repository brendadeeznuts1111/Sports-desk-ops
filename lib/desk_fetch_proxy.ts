/**
 * @file lib/desk_fetch_proxy.ts
 * @description Explicit proxy and timeout policy for desk fetches (issues #393, #399, #400).
 * Every call passes `proxy` so env proxy vars never decide routing: Bun re-reads
 * `HTTPS_PROXY` per request, so routing would follow whatever the process env says now.
 * A proxy comes only from the caller as `{ url, headers }`; credentials belong in
 * `headers["Proxy-Authorization"]`, never in the URL, and are never logged.
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

/** `undefined` means direct (`false`); an object proxy is validated and copied. */
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
    : { url: parsed.href, headers: { ...proxy.headers } };
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

/** Fetch with `proxy` always set (default `false`) and tunnel refusals named. */
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
    throw toR2ProxyTunnelError(error);
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
 * reason on theirs, {@link R2ProxyTunnelError} on a refused tunnel, else
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
  const caller = options?.signal ?? init.signal ?? undefined;
  const signal =
    caller === undefined ? timeout : AbortSignal.any([timeout, caller]);
  try {
    return await fetchWithProxyPolicy(
      fetchImpl,
      input,
      { ...init, signal },
      options?.proxy,
    );
  } catch (error) {
    if (
      error instanceof R2ProxyUrlError ||
      error instanceof R2ProxyTunnelError
    ) {
      throw error;
    }
    if (caller?.aborted === true) throw error;
    if (timeout.aborted) {
      throw new DeskTimeoutError(input, timeoutMs, { cause: error });
    }
    throw new DeskNetworkError(input, errorCode(error), { cause: error });
  }
}
