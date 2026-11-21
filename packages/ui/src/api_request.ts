/**
 * @file packages/ui/src/api_request.ts
 * @description Request headers for every desk API call, aligned with the daemon's contract.
 *
 * Two rules, both measured rather than stylistic:
 *
 * 1. **GETs send no headers.** `trackedFetch` only coalesces a request when its `init` carries
 *    nothing but `method` (`packages/ui/src/api_usage.ts` `coalescableGet`), so adding an
 *    `Accept` header to a plain read would disable the StrictMode double-mount reuse for every
 *    feed. The daemon answers JSON regardless.
 * 2. **Mutating calls send `Content-Type` and `x-csrf-token`.** Today the token comes from the
 *    `sd_csrf` cookie the daemon issues; `lib/csrf.ts` owns both names, but it imports `bun` and
 *    cannot be bundled into the browser build, so they are repeated here and a test keeps the two
 *    copies equal.
 *
 * `verifyCsrf` currently has no call site in the daemon (only `lib/csrf.ts` and its tests), so the
 * header is not yet enforced — it is sent consistently so enabling the check cannot break some
 * POSTs and not others.
 */

/** Cookie the daemon sets; must equal `CSRF_COOKIE_NAME` in `lib/csrf.ts`. */
export const CSRF_COOKIE_NAME = "sd_csrf";

/** Header the daemon would verify; must equal `CSRF_HEADER_NAME` in `lib/csrf.ts`. */
export const CSRF_HEADER_NAME = "x-csrf-token";

/** Read one cookie value from a `document.cookie` string. */
export function csrfTokenFromCookie(cookie: string): string {
  const pattern = new RegExp(`(?:^|;\\s*)${CSRF_COOKIE_NAME}=([^;]*)`);
  const match = pattern.exec(cookie);
  if (match?.[1] === undefined) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

/**
 * Headers for a desk API call. Reads are header-free by design; body-carrying verbs get
 * `Content-Type` plus the token when the cookie carries one.
 */
export function deskRequestHeaders(
  method: string | undefined,
  cookie = "",
): Record<string, string> {
  const verb = (method ?? "GET").toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") return {};
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = csrfTokenFromCookie(cookie);
  if (token !== "") headers[CSRF_HEADER_NAME] = token;
  return headers;
}

/** `deskRequestHeaders` against the live page; empty during SSR or a non-DOM runtime. */
export function browserDeskRequestHeaders(
  method: string | undefined,
): Record<string, string> {
  // Resolved off `globalThis` so the module also type-checks in the server project
  // (whose lib has no DOM); SSR and non-DOM runtimes legitimately have no cookie.
  const doc = (globalThis as { document?: { cookie?: string } }).document;
  const cookie = doc?.cookie ?? "";
  return deskRequestHeaders(method, cookie);
}
