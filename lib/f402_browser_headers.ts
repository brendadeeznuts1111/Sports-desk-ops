/**
 * @file lib/f402_browser_headers.ts
 * @description The one header the Fantasy402 manager API treats as "a browser did this".
 *
 * The manager portal is a jQuery app. Its own Ajax transport adds
 * `X-Requested-With: XMLHttpRequest` for same-origin requests only, and the API's handlers were
 * written against that. A replay that reproduces the cookie but not the header is therefore not
 * the same request, and a replay over a cross-origin proxy is a request jQuery itself would never
 * have made.
 *
 * It is not authentication — any client can send it — so it belongs on every manager call and
 * nowhere in a trust decision.
 */

/** Header name, lowercase because every writer here uses the lowercase form. */
export const F402_BROWSER_HEADER = "x-requested-with";

/** The only value the manager portal's jQuery build sends. */
export const F402_BROWSER_HEADER_VALUE = "XMLHttpRequest";

/**
 * The header as a `HeadersInit`-shaped object. Callers that build a plain object spread this;
 * callers that already hold a `Headers` use the constants with `set`.
 */
export const F402_BROWSER_HEADERS: Readonly<Record<string, string>> =
  Object.freeze({ [F402_BROWSER_HEADER]: F402_BROWSER_HEADER_VALUE });
