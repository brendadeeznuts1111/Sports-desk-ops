/**
 * @file lib/hostname_extract.ts
 * @description Pure hostname extraction and normalization primitives backed by Bun's WHATWG `URL`.
 * No classification rulesets, categories, or reporting live here.
 */

export const URL_RE: RegExp =
  /(?:https?|wss?):\/\/(?:\[[0-9a-fA-F:.]+\][^\s"'`)<>\]\\}]*|[^\s"'`)<>\]\\}]+)/gi;

export const FILE_TLDS: ReadonlySet<string> = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonl",
  "toml",
  "yaml",
  "yml",
  "md",
  "txt",
  "html",
  "css",
  "less",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "ico",
  "sql",
  "sqlite",
  "dodbin",
  "lock",
  "map",
  "wasm",
]);

export interface HostHitSummary {
  count: number;
  readonly sources: string[];
}

/** Return true for bracketed IPv6 literals (`[::1]`) or dotted IPv4 addresses (`127.0.0.1`). */
export function isIp(host: string): boolean {
  if (host.startsWith("[") && host.endsWith("]")) return true;
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
}

/**
 * Normalize a bare host, host:port, or URL into a canonical lowercase/IDNA WHATWG hostname.
 * Returns null when the input is empty or rejected by the WHATWG URL parser.
 */
export function normalizeHost(raw: string): string | null {
  let s = raw.trim();
  if (s === "") return null;

  // Strip any leading scheme case-insensitively so "HTTPS://..." doesn't become "http://HTTPS://..."
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // Keep only authority before first '/', '?', or '#'
  s = s.split(/[/?#]/, 1)[0] ?? "";
  // Strip userinfo (defensive; WHATWG URL also discards it)
  s = s.replace(/^[^/@]*@/, "");
  // Strip trailing port on non-IPv6 hosts while preserving bracketed IPv6 literals like [::1]
  if (!s.startsWith("[")) {
    s = s.replace(/:\d+$/, "");
  }
  s = s.replace(/\.+$/, "");
  if (s === "" || s.endsWith(".")) return null;

  try {
    const h = new URL(`http://${s}`).hostname;
    return h === "" ? null : h;
  } catch {
    return null;
  }
}

/**
 * Normalize and record a hostname hit, rejecting single-label truncation artifacts
 * (except `localhost` and bracketed IPv6 literals) and file-extension pseudo-hosts.
 */
export function bump(
  out: Map<string, HostHitSummary>,
  rawHost: string,
  source: string,
  maxSources = 5,
): void {
  const host = normalizeHost(rawHost);
  if (host === null) return;

  const ip = isIp(host);
  if (!host.includes(".") && !ip && host !== "localhost") return;

  if (!ip && host.includes(".")) {
    const lastLabel = host.slice(host.lastIndexOf(".") + 1);
    if (FILE_TLDS.has(lastLabel)) return;
  }

  let entry = out.get(host);
  if (entry === undefined) {
    entry = { count: 0, sources: [] };
    out.set(host, entry);
  }
  entry.count += 1;
  if (entry.sources.length < maxSources && !entry.sources.includes(source)) {
    entry.sources.push(source);
  }
}

/** Extract and normalize HTTP/HTTPS/WS/WSS URLs from text into `out`. */
export function collect(
  out: Map<string, HostHitSummary>,
  text: string,
  source: string,
  maxSources = 5,
): void {
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(text)) !== null) {
    const rawUrl = match[0].split("${", 1)[0] ?? "";
    if (rawUrl === "" || rawUrl.includes("*")) continue;
    try {
      const hostname = new URL(rawUrl).hostname;
      if (
        hostname.includes("${") ||
        hostname.includes(";") ||
        hostname.endsWith("-")
      ) {
        continue;
      }
      bump(out, hostname, source, maxSources);
    } catch {
      // Ignore malformed URL literals caught by regex
    }
  }
}

/** Convenience wrapper that scans `text` into a fresh `Map<string, HostHitSummary>`. */
export function extractFromText(
  text: string,
  source = "<inline>",
  maxSources = 5,
): Map<string, HostHitSummary> {
  const out = new Map<string, HostHitSummary>();
  collect(out, text, source, maxSources);
  return out;
}
