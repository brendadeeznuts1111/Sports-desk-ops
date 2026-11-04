/**
 * Cookie handoff between the authenticated WebView (CDP) and the FetchSession
 * data path.
 *
 * Values are needed exactly once — to build the `Cookie` request header for a
 * replay — and are never persisted, logged or summarized. Everything that leaves
 * this module is a name/count/redacted-header view.
 */

import { isPlainObject } from "./json.ts";
import { REDACTED } from "./redact.ts";

export class CookieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CookieError";
  }
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  expires?: number;
  session?: boolean;
}

export interface CookieSummary {
  count: number;
  names: string[];
  headerPresent: boolean;
  /** e.g. `session=<redacted>; csrftoken=<redacted>` — never raw values. */
  redactedHeader: string;
}

export interface CookieSelectionOptions {
  /**
   * Whether the request that will carry the header is https. Defaults to
   * `true` (undefined): an https request may carry both secure and non-secure
   * cookies, so nothing is dropped. `false` drops every `secure: true` cookie,
   * which is what a plain-http replay must not send.
   */
  requestSecure?: boolean;
}

/** Validate the `Network.getAllCookies` CDP result into typed cookies. */
export function parseCdpCookies(result: unknown): CdpCookie[] {
  if (!isPlainObject(result)) {
    throw new CookieError("CDP Network.getAllCookies returned a non-object");
  }
  const rawCookies = result["cookies"];
  if (!Array.isArray(rawCookies)) {
    throw new CookieError(
      "CDP Network.getAllCookies result is missing a cookies array",
    );
  }
  const cookies: CdpCookie[] = [];
  for (const raw of rawCookies) {
    if (!isPlainObject(raw)) {
      throw new CookieError("CDP cookie entry is not an object");
    }
    const name = raw["name"];
    const value = raw["value"];
    if (typeof name !== "string" || name.length === 0) {
      throw new CookieError("CDP cookie entry has no usable name");
    }
    if (typeof value !== "string") {
      throw new CookieError(`CDP cookie "${name}" has a non-string value`);
    }
    const cookie: CdpCookie = {
      name,
      value,
      domain: typeof raw["domain"] === "string" ? raw["domain"] : "",
      path: typeof raw["path"] === "string" ? raw["path"] : "/",
      httpOnly: raw["httpOnly"] === true,
      secure: raw["secure"] === true,
    };
    if (typeof raw["expires"] === "number") cookie.expires = raw["expires"];
    if (typeof raw["session"] === "boolean") cookie.session = raw["session"];
    cookies.push(cookie);
  }
  return cookies;
}

/** Lowercased host without its port; IPv6 brackets are preserved. */
function stripPort(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const closing = trimmed.indexOf("]");
    if (closing !== -1) return trimmed.slice(0, closing + 1);
    return trimmed;
  }
  // A bare IPv6 literal (`::1`, `2001:db8::1`) has more than one colon, so
  // stripping a trailing `:digits` would corrupt it into a fragment.
  const colons = trimmed.split(":").length - 1;
  return colons === 1 ? trimmed.replace(/:\d+$/, "") : trimmed;
}

/**
 * Host key for domain comparison: no port, no IPv6 brackets. CDP may report
 * `[::1]` where the cookie jar stores `::1`; both normalize to `::1`.
 */
function hostKey(host: string): string {
  return stripPort(host).replace(/^\[/, "").replace(/\]$/, "");
}

/** Cookie domain key: lowercased, no IPv6 brackets, no trailing dot. */
function cookieDomainKey(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
}

/**
 * RFC 6265 §5.1.3 domain-match, with the host-only distinction preserved.
 *
 * A cookie whose `Domain` attribute starts with `.` (or that CDP persisted as
 * `.example.com`) is a domain cookie: it matches the suffix itself and any
 * subdomain. A cookie without the leading dot is host-only: it matches that
 * exact host and nothing below it.
 *
 * An empty domain (CDP omitted the attribute) is treated as unscoped and
 * matches, preserving the pre-existing lenient behaviour for such entries.
 */
function domainMatches(cookieDomain: string, host: string): boolean {
  const domain = cookieDomainKey(cookieDomain);
  if (domain.length === 0) return true;
  if (domain.startsWith(".")) {
    const suffix = domain.slice(1);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  // Host-only: no subdomain suffix match.
  return host === domain;
}

/** Plain code-unit comparison: deterministic and host-independent. */
function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** RFC 6265 §5.1.4 path-match. */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  const scoped = cookiePath.length === 0 ? "/" : cookiePath;
  if (requestPath === scoped) return true;
  if (scoped.endsWith("/")) return requestPath.startsWith(scoped);
  return requestPath.startsWith(`${scoped}/`);
}

/** Path used for scope checks: absolute, no query/fragment, defaults to `/`. */
function requestPathKey(requestPath: string): string {
  const withoutQuery = requestPath.trim().split(/[?#]/, 1)[0] ?? "";
  if (withoutQuery.length === 0) return "/";
  return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}

/**
 * Select the cookies whose domain/expiry scope covers a host.
 *
 * Path scope is **opt-in**: when `requestPath` is undefined every
 * domain/expiry-eligible cookie is returned (the whole-domain jar), because a
 * caller that does not know the target path must not drop cookies scoped to
 * `/cloud`, `/manager`, etc. When `requestPath` is provided it is matched with
 * RFC 6265 §5.1.4 semantics — `/cloud` covers `/cloud` and `/cloud/api/x` but
 * not `/cloudy`.
 *
 * Transport scope is opt-in too: `options.requestSecure === false` drops
 * `secure` cookies because a plain-http request must not carry them. The
 * default (undefined/true) keeps them, since an https request may carry both.
 *
 * Ordering follows RFC 6265 §5.4: most specific path first (longer `path`
 * wins), then name — then `domain` and `path` as deterministic tie-breaks so a
 * same-name cookie on two domains resolves the same way on every run. If two
 * selected cookies share a name only the first after ordering survives, so a
 * header can never carry a stale `path=/` value ahead of the `path=/cloud`
 * value that the server would actually use.
 *
 * Expired cookies are dropped. Setting `now` makes the expiry decision testable.
 */
export function selectCookiesForHost(
  cookies: readonly CdpCookie[],
  host: string,
  requestPath?: string,
  now: number = Date.now(),
  options?: CookieSelectionOptions,
): CdpCookie[] {
  const normalizedHost = hostKey(host);
  const path =
    requestPath === undefined ? undefined : requestPathKey(requestPath);
  const requestSecure = options?.requestSecure !== false;
  const selected = cookies.filter((cookie) => {
    if (!requestSecure && cookie.secure === true) return false;
    if (!domainMatches(cookie.domain, normalizedHost)) return false;
    if (path !== undefined && !pathMatches(cookie.path, path)) return false;
    if (cookie.expires !== undefined && cookie.expires > 0) {
      if (cookie.expires * 1000 <= now) return false;
    }
    return true;
  });
  const ordered = selected.sort((left, right) => {
    const lengthDiff = right.path.length - left.path.length;
    if (lengthDiff !== 0) return lengthDiff;
    const nameDiff = compareText(left.name, right.name);
    if (nameDiff !== 0) return nameDiff;
    const domainDiff = compareText(left.domain, right.domain);
    if (domainDiff !== 0) return domainDiff;
    return compareText(left.path, right.path);
  });
  // Dedupe by name after ordering: the first occurrence is the most specific
  // path, which is the value a browser would send for that path.
  const seen = new Set<string>();
  const deduped: CdpCookie[] = [];
  for (const cookie of ordered) {
    if (seen.has(cookie.name)) continue;
    seen.add(cookie.name);
    deduped.push(cookie);
  }
  return deduped;
}

/** Build a `Cookie` header value from selected cookies. */
export function buildCookieHeader(cookies: readonly CdpCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/** Redact every cookie value while preserving the names for diagnostics. */
export function redactCookieHeader(header: string): string {
  const trimmed = header.trim();
  if (trimmed.length === 0) return "";
  return trimmed
    .split(";")
    .map((part) => {
      const equals = part.indexOf("=");
      if (equals <= 0) return REDACTED;
      return `${part.slice(0, equals).trim()}=${REDACTED}`;
    })
    .join("; ");
}

/** Cookie names only — the only cookie shape that is ever persisted. */
export function summarizeCookies(
  cookies: readonly CdpCookie[],
  header: string = buildCookieHeader(cookies),
): CookieSummary {
  const names = [...new Set(cookies.map((cookie) => cookie.name))].sort();
  return {
    count: cookies.length,
    names,
    headerPresent: header.trim().length > 0,
    redactedHeader: redactCookieHeader(header),
  };
}

export interface CookieHandoff {
  header: string;
  summary: CookieSummary;
}

/**
 * Produce the session cookie header for one host, or throw when the
 * authenticated browser has no scoped cookies (better than capturing 401s).
 *
 * With no `requestPath` this hands off the whole domain jar — the shape the
 * evidence-capture call needs, since it captures many endpoints whose paths are
 * not known at login time. Pass a path to narrow the header to that request.
 *
 * `options.requestSecure: false` scopes the handoff to a plain-http request and
 * drops secure cookies; the default keeps them for an https request.
 */
export function cookieHandoffForHost(
  cookies: readonly CdpCookie[],
  host: string,
  requestPath?: string,
  now?: number,
  options?: CookieSelectionOptions,
): CookieHandoff {
  const selected = selectCookiesForHost(
    cookies,
    host,
    requestPath,
    now,
    options,
  );
  const header = buildCookieHeader(selected);
  if (header.length === 0) {
    throw new CookieError(
      `no session cookies were scoped to ${hostKey(host) || "<unknown host>"} after login`,
    );
  }
  return { header, summary: summarizeCookies(selected, header) };
}
