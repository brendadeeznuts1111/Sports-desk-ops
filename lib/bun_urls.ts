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

function isBunPath(path: string): path is BunPath {
  return path.startsWith("/");
}
