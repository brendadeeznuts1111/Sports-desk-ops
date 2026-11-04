/**
 * External assets a portal document loads: extraction, URL normalization, and SRI eligibility.
 *
 * The Manager SPA loads ~60 scripts and stylesheets from four origins. Pinning their bytes makes
 * a silent swap visible (detection). `integrity=` makes a swapped copy fail closed (prevention),
 * but only where two conditions hold:
 *
 *  - the tag is `<script>` or `<link rel="stylesheet">` — a `rel="stylesheet/less"` tag is fetched
 *    by less.js over XHR and compiled client-side, and browsers never consult SRI for that fetch;
 *  - the origin sends `Access-Control-Allow-Origin` — an SRI check on a cross-origin asset is also
 *    a CORS check, and `maps.googleapis.com` does not send the header.
 */

export type ExternalAssetKind = "script" | "stylesheet" | "stylesheet-less";

export interface ExternalAssetRef {
  /** URL exactly as the document wrote it. */
  readonly url: string;
  /** URL with credential-bearing query parameters masked; the manifest key. */
  readonly normalizedUrl: string;
  readonly kind: ExternalAssetKind;
  /** Byte offset of the tag in the document, for splicing in `applySriToHtml`. */
  readonly index: number;
  /** 1-based line of the tag's first character. */
  readonly line: number;
  /** The raw `<script …>` / `<link …>` tag. */
  readonly tag: string;
}

export type AssetRole = "portal-js" | "portal-css" | "telegram-web-app";

const EXTERNAL_TAG_RE = /<(script|link)\b[^>]*>/gi;
const SRC_ATTR_RE = /\bsrc\s*=\s*["']([^"']+)["']/i;
const HREF_ATTR_RE = /\bhref\s*=\s*["']([^"']+)["']/i;
const REL_ATTR_RE = /\brel\s*=\s*["']([^"']+)["']/i;

/** Query parameters whose values are credentials, not cache keys. */
const CREDENTIAL_QUERY_KEYS = [
  "key",
  "api_key",
  "apikey",
  "access_token",
  "token",
  "signature",
  "sig",
] as const;

/** Hosts that do not send `Access-Control-Allow-Origin`, so SRI cannot be enforced there. */
const NO_CORS_HOSTS = ["maps.googleapis.com"] as const;

function lineAt(html: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < html.length; i += 1) {
    if (html.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Absolute http(s) scripts and stylesheets a document loads. Preloads, icons and inline scripts
 * are skipped: nothing about them can be integrity-checked at load time.
 */
export function extractExternalAssets(
  html: string,
  options?: { readonly dedupe?: boolean },
): ExternalAssetRef[] {
  const dedupe = options?.dedupe ?? true;
  const seen = new Set<string>();
  const refs: ExternalAssetRef[] = [];

  for (const match of html.matchAll(EXTERNAL_TAG_RE)) {
    const tag = match[0];
    const tagName = (match[1] ?? "").toLowerCase();
    const index = match.index ?? 0;

    let kind: ExternalAssetKind;
    let rawUrl: string | undefined;
    if (tagName === "script") {
      kind = "script";
      rawUrl = SRC_ATTR_RE.exec(tag)?.[1];
    } else {
      const rel = (REL_ATTR_RE.exec(tag)?.[1] ?? "").toLowerCase();
      if (!rel.includes("stylesheet")) continue;
      kind = rel.includes("stylesheet/less") ? "stylesheet-less" : "stylesheet";
      rawUrl = HREF_ATTR_RE.exec(tag)?.[1];
    }

    if (rawUrl === undefined || !/^https?:\/\//i.test(rawUrl)) continue;
    const normalizedUrl = normalizeAssetUrl(rawUrl);
    const key = `${kind}\u0000${normalizedUrl}`;
    if (dedupe && seen.has(key)) continue;
    seen.add(key);
    refs.push({
      url: rawUrl,
      normalizedUrl,
      kind,
      index,
      line: lineAt(html, index),
      tag,
    });
  }

  return refs;
}

/**
 * Stable manifest key for an asset URL. Volatile query values (`.less` cache-busters) stay, because
 * a changed bump is a change the vendor made; credential values are replaced so a rotated Google
 * Maps key does not read as asset drift and never reaches a tracked file.
 */
export function normalizeAssetUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  for (const key of CREDENTIAL_QUERY_KEYS) {
    if (url.searchParams.has(key)) url.searchParams.set(key, "<redacted>");
  }
  return url.toString();
}

export function assetRole(url: string): AssetRole {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "portal-js";
  }
  if (parsed.host === "telegram.org") return "telegram-web-app";
  return /\.(?:css|less)$/i.test(parsed.pathname) ? "portal-css" : "portal-js";
}

/** True when the origin sends no `Access-Control-Allow-Origin`, so `integrity=` would block it. */
export function isSriIneligibleUrl(url: string): boolean {
  try {
    return (NO_CORS_HOSTS as readonly string[]).includes(new URL(url).host);
  } catch {
    return false;
  }
}

/** Caps a pathological stylesheet from turning the manifest into a URL dump. */
const MAX_CSS_REFERENCES = 500;

const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi;
const CSS_IMPORT_RE =
  /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^)';]+))/gi;

/**
 * Absolute resources a stylesheet pulls in: `url(...)` targets and `@import` chains, resolved
 * against the stylesheet URL. `data:`/`blob:`/`#fragment`/`javascript:` are not network fetches and
 * are skipped. Sorted and deduped so a byte-identical stylesheet yields an identical list.
 *
 * The manifest can only see `<script>`/`<link>` tags; a compromised stylesheet could swap a font or
 * background without changing the CSS bytes the page names. Recording these references makes that
 * swap visible at the next check.
 */
export function extractCssReferences(
  cssText: string,
  baseUrl: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (raw: string): void => {
    const value = raw.trim();
    if (value === "" || value.length > 2048) return;
    if (/^(?:data:|blob:|about:|javascript:|mailto:|#)/i.test(value)) return;
    let resolved: URL;
    try {
      resolved = new URL(value, baseUrl);
    } catch {
      return;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return;
    }
    const normalized = normalizeAssetUrl(resolved.toString());
    if (seen.has(normalized)) return;
    seen.add(normalized);
    if (out.length < MAX_CSS_REFERENCES) out.push(normalized);
  };

  for (const match of cssText.matchAll(CSS_URL_RE)) {
    add(match[1] ?? match[2] ?? match[3] ?? "");
  }
  for (const match of cssText.matchAll(CSS_IMPORT_RE)) {
    add(match[1] ?? match[2] ?? match[3] ?? "");
  }

  return out.sort();
}
