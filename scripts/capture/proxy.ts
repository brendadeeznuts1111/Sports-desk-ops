/**
 * Proxy handling for the capture data path.
 *
 * Bun 1.4.4 honors `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` environment
 * variables, and it also accepts an explicit `proxy:` option — on `fetch()` and
 * on `Bun.FetchSession` — as a URL string, a `URL`, a `{ url, headers,
 * respectNoProxy }` object, or `false` for a direct connection. Measured in
 * tests/fetch_proxy_isolation.test.ts and tests/fetch_session_pool.test.ts.
 *
 * This module is the environment view: it reads the variables, applies the
 * `NO_PROXY` matcher itself so a bypass can be explained, and sets/restores the
 * environment for the callers that still need a process-global override. New
 * code should pass the option instead — it is scoped to one request or one
 * session rather than to the whole process.
 *
 * Known limitations (documented, not papered over):
 *   - Bun.WebView does not honor these variables or a proxy constructor option;
 *     browser navigation uses Chrome/system proxy settings.
 *   - An HTTPS target through an HTTP proxy needs CONNECT; an in-process
 *     forwarder should forward with `proxy: false` to avoid proxying itself.
 */

import type { Env } from "./types.ts";

export class ProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyConfigError";
  }
}

export interface ProxySettings {
  httpProxy: string | null;
  httpsProxy: string | null;
  noProxy: string[];
}

export interface ProxyDescription {
  present: boolean;
  http: string | null;
  https: string | null;
  noProxy: string[];
  noProxyCount: number;
  credentialsRedacted: boolean;
}

export type ProxyBypassReason =
  "no_proxy" | "not_configured" | "unsupported_protocol";

export interface ProxyDecision {
  mode: "proxy" | "direct";
  proxy: string | null;
  reason: ProxyBypassReason | "configured";
}

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
] as const;

function firstNonEmpty(env: Env, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return null;
}

/** Read proxy configuration from an environment snapshot. */
export function readProxyEnv(env: Env = Bun.env): ProxySettings {
  const rawNoProxy = firstNonEmpty(env, ["NO_PROXY", "no_proxy"]);
  return {
    httpProxy: firstNonEmpty(env, ["HTTP_PROXY", "http_proxy"]),
    httpsProxy: firstNonEmpty(env, ["HTTPS_PROXY", "https_proxy"]),
    noProxy:
      rawNoProxy === null
        ? []
        : rawNoProxy
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
  };
}

/**
 * Validate and canonicalize a proxy URL (`host:port` is accepted as HTTP).
 * Throws `ProxyConfigError` with an actionable message on bad input.
 */
export function normalizeProxyUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new ProxyConfigError("proxy URL is empty");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ProxyConfigError(
      `invalid proxy URL (expected http://host:port): ${redactProxyUrl(trimmed)}`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProxyConfigError(
      `unsupported proxy protocol ${url.protocol} (only http/https forward proxies are supported)`,
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ProxyConfigError(
      "proxy URL must not contain a path (pass http://host:port only)",
    );
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new ProxyConfigError(
      "proxy URL must not contain a query or fragment",
    );
  }
  return url.href.replace(/\/$/, "");
}

/** `scheme://<redacted>@host:port` — safe for logs and CLI output. */
export function redactProxyUrl(input: string): string {
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim())
        ? input.trim()
        : `http://${input.trim()}`,
    );
    const credentials =
      url.username.length > 0 || url.password.length > 0 ? "<redacted>@" : "";
    return `${url.protocol}//${credentials}${url.host}`;
  } catch {
    return "<redacted>";
  }
}

/** Safe, credential-free view of the current proxy configuration. */
export function describeProxy(
  settings: ProxySettings = readProxyEnv(),
): ProxyDescription {
  const http = settings.httpProxy;
  const https = settings.httpsProxy;
  const hasCredentials =
    (http !== null && hasUrlCredentials(http)) ||
    (https !== null && hasUrlCredentials(https));
  return {
    present: http !== null || https !== null,
    http: http === null ? null : redactProxyUrl(http),
    https: https === null ? null : redactProxyUrl(https),
    noProxy: [...settings.noProxy],
    noProxyCount: settings.noProxy.length,
    credentialsRedacted: hasCredentials,
  };
}

function hasUrlCredentials(value: string): boolean {
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`,
    );
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    return false;
  }
}

/** True for loopback-only hosts where a proxy hop would be pointless. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * Match a host against a NO_PROXY list.
 *
 * Supported entry forms: `*`, exact host / IPv4 / IPv6 literal, domain suffix
 * (`example.com`, `.example.com`, `*.example.com`), `host:port`, wildcard IPv4
 * (`192.168.*`), and CIDR (`10.0.0.0/8`).
 */
export function matchesNoProxy(
  host: string,
  entries: readonly string[],
  port?: number,
): boolean {
  const normalizedHost = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (normalizedHost.length === 0) return false;
  for (const rawEntry of entries) {
    const entry = rawEntry.trim().toLowerCase();
    if (entry.length === 0) continue;
    if (entry === "*") return true;

    const { hostPart, portPart } = splitHostPort(entry);
    if (portPart !== null && port !== undefined && portPart !== port) continue;

    const candidate = hostPart.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (candidate.length === 0) continue;

    if (candidate.includes("/")) {
      if (cidrMatches(normalizedHost, candidate)) return true;
      continue;
    }
    if (candidate.includes("*")) {
      if (globToRegExp(candidate).test(normalizedHost)) return true;
      continue;
    }
    const suffix = candidate.replace(/^\./, "");
    if (normalizedHost === suffix) return true;
    if (normalizedHost.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

function splitHostPort(entry: string): {
  hostPart: string;
  portPart: number | null;
} {
  if (entry.startsWith("[")) {
    const closing = entry.indexOf("]");
    if (closing === -1) return { hostPart: entry, portPart: null };
    const hostPart = entry.slice(0, closing + 1);
    const rest = entry.slice(closing + 1);
    const portPart = /^:(\d{1,5})$/.exec(rest);
    return {
      hostPart,
      portPart:
        portPart?.[1] === undefined ? null : Number.parseInt(portPart[1], 10),
    };
  }
  const match = /^(.*):(\d{1,5})$/.exec(entry);
  if (match === null) return { hostPart: entry, portPart: null };
  const candidateHost = match[1] ?? "";
  const candidatePort = match[2];
  if (candidatePort === undefined) return { hostPart: entry, portPart: null };
  // Only treat it as host:port if the host part is not an unbracketed IPv6.
  if (candidateHost.split(":").length > 2)
    return { hostPart: entry, portPart: null };
  return {
    hostPart: candidateHost,
    portPart: Number.parseInt(candidatePort, 10),
  };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("")
    .map((character) =>
      character === "*"
        ? ".*"
        : /[.+?^${}()|[\]\\]/.test(character)
          ? `\\${character}`
          : character,
    )
    .join("");
  return new RegExp(`^${escaped}$`);
}

function cidrMatches(host: string, cidr: string): boolean {
  const [network, prefixRaw] = cidr.split("/");
  if (network === undefined || prefixRaw === undefined) return false;
  const prefix = Number.parseInt(prefixRaw, 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const hostInt = ipv4ToInt(host);
  const networkInt = ipv4ToInt(network);
  if (hostInt === null || networkInt === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (hostInt & mask) >>> 0 === (networkInt & mask) >>> 0;
}

function ipv4ToInt(value: string): number | null {
  const octets = value.split(".");
  if (octets.length !== 4) return null;
  let result = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    const parsed = Number.parseInt(octet, 10);
    if (parsed < 0 || parsed > 255) return null;
    result = result * 256 + parsed;
  }
  return result;
}

/** Decide whether one URL should go through a proxy, and which one. */
export function proxyForUrl(
  url: string,
  settings: ProxySettings = readProxyEnv(),
): ProxyDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { mode: "direct", proxy: null, reason: "unsupported_protocol" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { mode: "direct", proxy: null, reason: "unsupported_protocol" };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const port =
    parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : undefined;
  if (matchesNoProxy(host, settings.noProxy, port)) {
    return { mode: "direct", proxy: null, reason: "no_proxy" };
  }
  const proxy =
    parsed.protocol === "https:" ? settings.httpsProxy : settings.httpProxy;
  if (proxy === null) {
    return { mode: "direct", proxy: null, reason: "not_configured" };
  }
  return { mode: "proxy", proxy, reason: "configured" };
}

/**
 * Point the process environment at one proxy (or clear it) for a run and return
 * a restore function.
 *
 * Process-global by construction: it also affects anything else in this process
 * that reads the environment, including a spawned child. Prefer passing `proxy`
 * to `fetch()` or `Bun.FetchSession`; keep this for the cases that genuinely
 * need the environment (a subprocess, or a library that only reads it).
 */
export function setProxyEnv(
  proxy: string | null,
  env: Env = Bun.env,
): () => void {
  const normalized = proxy === null ? null : normalizeProxyUrl(proxy);
  const previous = new Map<string, string | undefined>();
  for (const key of PROXY_ENV_KEYS) previous.set(key, env[key]);
  if (normalized !== null) {
    env.HTTP_PROXY = normalized;
    env.HTTPS_PROXY = normalized;
    env.http_proxy = normalized;
    env.https_proxy = normalized;
  } else {
    for (const key of PROXY_ENV_KEYS) delete env[key];
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  };
}

/** Run `fn` with the proxy environment applied; always restores it. */
export async function withProxyEnv<T>(
  proxy: string | null,
  fn: () => Promise<T> | T,
  env: Env = Bun.env,
): Promise<T> {
  const restore = setProxyEnv(proxy, env);
  try {
    return await fn();
  } finally {
    restore();
  }
}
