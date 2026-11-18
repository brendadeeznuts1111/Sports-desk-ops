/**
 * @file lib/desk_fetch_proxy.ts
 * @description Explicit proxy policy for desk fetches (R2 and desk APIs, issue #393).
 * Every call passes `proxy` so env proxy vars never decide routing: Bun re-reads
 * `HTTPS_PROXY` per request, so routing would follow whatever the process env says now.
 * A proxy comes only from the caller as `{ url, headers }`; credentials belong in
 * `headers["Proxy-Authorization"]`, never in the URL, and are never logged.
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
