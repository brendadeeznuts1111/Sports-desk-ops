/**
 * Bun documentation URLs in one shape: `https://bun.com` + path, no trailing slash.
 *
 * bun.sh serves the same paths, but its pages declare the bun.com URL as `rel="canonical"`, and
 * www.bun.com / www.bun.sh / a trailing slash redirect to the bare form (all checked 2026-11-02).
 * Reference symbols live under `/reference/<module>/<symbol>`, e.g.
 * `/reference/globals/bun/ImportKind`; `/reference/bun/ImportKind` is a 404.
 *
 * @see https://bun.com/reference/globals/bun/ImportKind
 */

export const BUN_ORIGIN = "https://bun.com" as const;

/** Hosts that serve bun.com's paths; {@link canonicalBunUrl} maps all of them to {@link BUN_ORIGIN}. */
export const BUN_HOSTS: ReadonlySet<string> = new Set([
  "bun.com",
  "www.bun.com",
  "bun.sh",
  "www.bun.sh",
]);

type BunPath = `/${string}`;
export type BunUrl<P extends BunPath = BunPath> = `${typeof BUN_ORIGIN}${P}`;

function assertCanonicalPath(path: string): void {
  const pathname = path.replace(/[?#].*$/s, "");
  if (!pathname.startsWith("/") || pathname.includes("//")) {
    throw new TypeError(`Bun URL path must be one absolute path: ${path}`);
  }
  if (pathname.length > 1 && pathname.endsWith("/")) {
    throw new TypeError(
      `Bun URL path must not end in "/" (bun.com 308-redirects it): ${path}`,
    );
  }
}

/** `bunUrl("/docs/runtime/cron")` → `"https://bun.com/docs/runtime/cron"`, typed as that literal. */
export function bunUrl<const P extends BunPath>(path: P): BunUrl<P> {
  assertCanonicalPath(path);
  return `${BUN_ORIGIN}${path}`;
}

/** `bunReferenceUrl("globals/bun/ImportKind")` → `https://bun.com/reference/globals/bun/ImportKind`. */
export function bunReferenceUrl<const S extends string>(
  symbolPath: S,
): BunUrl<`/reference/${S}`> {
  return bunUrl(`/reference/${symbolPath}`);
}

/**
 * Canonical reference URL for Bun's AnsiTheme documentation.
 * @see https://bun.com/reference/globals/bun/markdown/AnsiTheme
 */
export const BUN_ANSI_THEME_REFERENCE_URL = bunReferenceUrl(
  "globals/bun/markdown/AnsiTheme",
);

export interface BunReferenceSymbol {
  readonly canonicalUrl: BunUrl;
  readonly symbolPath: string;
  readonly modulePath: string;
  readonly symbolName: string;
}

/**
 * Parses a Bun reference URL (e.g. `https://bun.sh/reference/globals/bun/markdown/AnsiTheme`
 * or `/reference/globals/bun/ImportKind`) into its constituent module path and symbol name.
 * Returns `null` if the input is not a valid Bun reference URL.
 */
export function parseBunReferenceUrl(raw: string): BunReferenceSymbol | null {
  const canonical = canonicalBunUrl(raw);
  if (canonical === null) return null;

  try {
    const url = new URL(canonical);
    const prefix = "/reference/";
    if (!url.pathname.startsWith(prefix)) return null;

    const symbolPath = url.pathname.slice(prefix.length);
    if (symbolPath === "" || symbolPath.endsWith("/")) return null;

    const lastSlash = symbolPath.lastIndexOf("/");
    if (lastSlash <= 0) return null;

    const modulePath = symbolPath.slice(0, lastSlash);
    const symbolName = symbolPath.slice(lastSlash + 1);

    if (symbolName === "") return null;

    return {
      canonicalUrl: canonical,
      symbolPath,
      modulePath,
      symbolName,
    };
  } catch {
    return null;
  }
}

/**
 * Checks whether a given URL points to a Bun reference documentation page for a specific symbol name.
 * Case-insensitive by default.
 *
 * E.g. `matchBunReferenceSymbol("https://bun.sh/reference/globals/bun/markdown/AnsiTheme", "AnsiTheme")` → `true`.
 */
export function matchBunReferenceSymbol(
  raw: string,
  expectedSymbol: string,
  options?: { exactCase?: boolean },
): boolean {
  const parsed = parseBunReferenceUrl(raw);
  if (parsed === null) return false;

  const target =
    options?.exactCase === true ? expectedSymbol : expectedSymbol.toLowerCase();
  const actual =
    options?.exactCase === true
      ? parsed.symbolName
      : parsed.symbolName.toLowerCase();
  return actual === target;
}

/**
 * Known Bun reference symbols and their canonical symbol paths under `/reference/`.
 */
export const BUN_KNOWN_REFERENCE_SYMBOLS: Readonly<Record<string, string>> = {
  AnsiTheme: "globals/bun/markdown/AnsiTheme",
  "Bun.markdown.ansi": "globals/bun/markdown/ansi",
  "Bun.markdown": "globals/bun/markdown",
  "Bun.inspect.custom": "globals/bun/inspect",
  "Bun.inspect": "globals/bun/inspect",
  "Bun.serve": "globals/bun/serve",
  "Bun.Terminal": "globals/bun/Terminal",
  "Bun.file": "globals/bun/file",
  "Bun.write": "globals/bun/write",
  "Bun.spawn": "globals/bun/spawn",
  "Bun.Transpiler": "globals/bun/Transpiler",
  "Bun.dns": "globals/bun/dns",
  "dns.lookup": "globals/bun/dns/lookup",
  "dns.prefetch": "globals/bun/dns/prefetch",
  "dns.getCacheStats": "globals/bun/dns/getCacheStats",
  ImportKind: "globals/bun/ImportKind",
};

/**
 * Resolves a Bun symbol name (e.g. `"AnsiTheme"`, `"Bun.markdown.ansi"`, `"globals/bun/markdown/AnsiTheme"`)
 * to its canonical Bun reference URL.
 */
export function resolveBunSymbolReferenceUrl(symbol: string): BunUrl | null {
  const trimmed = symbol.trim().replace(/^`|`$/g, "");
  if (!trimmed) return null;

  // Direct match in known symbols catalog
  if (trimmed in BUN_KNOWN_REFERENCE_SYMBOLS) {
    const symbolPath = BUN_KNOWN_REFERENCE_SYMBOLS[trimmed]!;
    return bunReferenceUrl(symbolPath);
  }

  // Case-insensitive match in known symbols catalog
  const lower = trimmed.toLowerCase();
  for (const [key, path] of Object.entries(BUN_KNOWN_REFERENCE_SYMBOLS)) {
    if (key.toLowerCase() === lower) {
      return bunReferenceUrl(path);
    }
  }

  // If path format provided directly (e.g. globals/bun/markdown/AnsiTheme)
  if (trimmed.startsWith("globals/bun/")) {
    try {
      return bunReferenceUrl(trimmed);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Scans a text or markdown string for occurrences of known Bun reference symbols
 * and returns their extracted symbol metadata.
 */
export function findBunReferenceSymbolsInText(
  text: string,
): readonly BunReferenceSymbol[] {
  const results: BunReferenceSymbol[] = [];
  const seen = new Set<string>();

  for (const [symbolName, symbolPath] of Object.entries(
    BUN_KNOWN_REFERENCE_SYMBOLS,
  )) {
    // Match word boundaries or backticked symbols
    const escaped = symbolName.replace(/\./g, "\\.");
    const regex = new RegExp(
      `(?<=^|[^a-zA-Z0-9_.])\`?${escaped}\`?(?=[^a-zA-Z0-9_.]|$)`,
      "g",
    );
    if (regex.test(text) && !seen.has(symbolPath)) {
      seen.add(symbolPath);
      const parsed = parseBunReferenceUrl(bunReferenceUrl(symbolPath));
      if (parsed) results.push(parsed);
    }
  }

  return results;
}

/**
 * Automatically transforms occurrences of recognized Bun symbols in Markdown into
 * canonical OSC 8 Markdown hyperlinks pointing to Bun's official documentation.
 */
export function linkifyBunSymbolsInMarkdown(markdown: string): string {
  let output = markdown;
  for (const [symbolName, symbolPath] of Object.entries(
    BUN_KNOWN_REFERENCE_SYMBOLS,
  )) {
    const targetUrl = bunReferenceUrl(symbolPath);
    // Replace backticked `Symbol` not already inside a markdown link
    const backtickedRegex = new RegExp(
      `(?<!\\[)\`(${symbolName.replace(/\./g, "\\.")})\`(?!\\]|\\()`,
      "g",
    );
    output = output.replace(backtickedRegex, `[\`$1\`](${targetUrl})`);
  }
  return output;
}

export interface TextDirective {
  readonly prefix?: string;
  readonly start: string;
  readonly end?: string;
  readonly suffix?: string;
}

/**
 * `-`, `,` and `&` delimit a text directive, so each part escapes them on top of URI encoding. `/` is
 * legal in a fragment and stays literal, as browser "copy link to highlight" output has it.
 */
function encodeTextPart(part: string): string {
  if (part === "") throw new TypeError("text fragment parts must not be empty");
  return encodeURIComponent(part).replaceAll("-", "%2D").replaceAll("%2F", "/");
}

/**
 * A `:~:text=[prefix-,]start[,end][,-suffix]` fragment directive, appended after an optional element
 * id: `bunUrl(\`/blog/bun-v1.4#bun-terminal${textFragment({ start })}\`)`.
 *
 * @see https://wicg.github.io/scroll-to-text-fragment/#syntax
 */
export function textFragment(directive: TextDirective): `:~:text=${string}` {
  const { prefix, start, end, suffix } = directive;
  const parts = [
    ...(prefix === undefined ? [] : [`${encodeTextPart(prefix)}-`]),
    encodeTextPart(start),
    ...(end === undefined ? [] : [encodeTextPart(end)]),
    ...(suffix === undefined ? [] : [`-${encodeTextPart(suffix)}`]),
  ];
  return `:~:text=${parts.join(",")}`;
}

/**
 * Any bun.com / bun.sh link (with or without scheme or `www.`) in canonical form; query and fragment,
 * including `:~:text=` text fragments, are kept verbatim. `null` for anything that is not Bun's site.
 */
export function canonicalBunUrl(raw: string): BunUrl | null {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!BUN_HOSTS.has(url.hostname) || url.port !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  const pathname = url.pathname.replace(/(.)\/+$/, "$1");
  if (!isBunPath(pathname)) return null;
  return `${BUN_ORIGIN}${pathname}${url.search}${url.hash}`;
}

/**
 * Strips tracking parameters (`_gl`, `_ga`, `utm_*`, `fbclid`) from a Bun URL
 * while preserving valid query parameters, hash fragments, and `:~:text=` text directives.
 */
export function sanitizeBunUrl(raw: string): BunUrl | null {
  const canonical = canonicalBunUrl(raw);
  if (!canonical) return null;
  try {
    const url = new URL(canonical);
    const trackingKeys = ["_gl", "_ga", "fbclid"];
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        trackingKeys.includes(key) ||
        key.startsWith("_ga_") ||
        key.startsWith("utm_")
      ) {
        url.searchParams.delete(key);
      }
    }
    const search = url.searchParams.toString();
    const query = search ? `?${search}` : "";
    const pathname = url.pathname.replace(/(.)\/+$/, "$1");
    if (!isBunPath(pathname)) return null;
    return `${BUN_ORIGIN}${pathname}${query}${url.hash}`;
  } catch {
    return canonical;
  }
}

function isBunPath(path: string): path is BunPath {
  return path.startsWith("/");
}
