/**
 * Bun documentation URLs in one shape: `https://bun.com` + path, no trailing slash.
 *
 * bun.sh serves the same paths, but its pages declare the bun.com URL as `rel="canonical"`, and
 * www.bun.com / www.bun.sh / a trailing slash redirect to the bare form (all checked 2026-11-02).
 * Reference symbols live under `/reference/<module>/<symbol>`, e.g.
 * `/reference/bun/ImportKind`. The older `/reference/globals/bun/ImportKind`
 * shape now returns 404 (checked 2026-11-14); legacy paths are still accepted as
 * input and canonicalized.
 *
 * @see https://bun.com/reference/bun/ImportKind
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

/** `bunReferenceUrl("bun/ImportKind")` → `https://bun.com/reference/bun/ImportKind`. */
export function bunReferenceUrl<const S extends string>(
  symbolPath: S,
): BunUrl<`/reference/${S}`> {
  return bunUrl(`/reference/${symbolPath}`);
}

/**
 * Canonical reference URL for Bun's AnsiTheme documentation.
 * @see https://bun.com/reference/bun/markdown/AnsiTheme
 */
export const BUN_ANSI_THEME_REFERENCE_URL = bunReferenceUrl(
  "bun/markdown/AnsiTheme",
);

/**
 * Canonical reference URL for Bun's Markdown parser options (`Bun.markdown.Options`).
 * @see https://bun.com/reference/bun/markdown/Options
 */
export const BUN_MARKDOWN_OPTIONS_REFERENCE_URL = bunReferenceUrl(
  "bun/markdown/Options",
);

export interface BunReferenceSymbol {
  readonly canonicalUrl: BunUrl;
  readonly symbolPath: string;
  readonly modulePath: string;
  readonly symbolName: string;
}

/**
 * Parses a Bun reference URL (e.g. `https://bun.com/reference/bun/markdown/AnsiTheme`)
 * into its constituent module path and symbol name. The legacy
 * `/reference/globals/bun/...` shape still parses. Returns `null` when the input
 * is not a valid Bun reference URL.
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
 * E.g. `matchBunReferenceSymbol("https://bun.sh/reference/bun/markdown/AnsiTheme", "AnsiTheme")` → `true`.
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
 * Verified top-level `bun` reference symbol inventory from `https://bun.com/reference/bun.props.json`
 * (functions, classes, interfaces, variables, and namespaces).
 */
export const BUN_ROOT_REFERENCE_SYMBOLS = [
  "$",
  "AbstractWorker",
  "AbstractWorkerEventMap",
  "AddEventListenerOptions",
  "Archive",
  "ArchiveExtractOptions",
  "ArchiveOptions",
  "ArrayBufferSink",
  "BinaryTypeList",
  "BuildArtifact",
  "BuildConfig",
  "BuildMetafile",
  "BuildOutput",
  "BunFile",
  "BunInspectOptions",
  "BunMessageEvent",
  "BunPlugin",
  "BunRegisterPlugin",
  "BunRequest",
  "CSRF",
  "CSRFGenerateOptions",
  "CSRFVerifyOptions",
  "CloseEventInit",
  "CompileBuildOptions",
  "Cookie",
  "CookieInit",
  "CookieMap",
  "CookieStoreDeleteOptions",
  "CookieStoreGetOptions",
  "CronController",
  "CronJob",
  "CronOptions",
  "CryptoHashInterface",
  "CryptoHasher",
  "CustomEventInit",
  "DNSLookup",
  "DirectUnderlyingSource",
  "EditorOptions",
  "Env",
  "ErrorEventInit",
  "ErrorLike",
  "EventInit",
  "EventListener",
  "EventListenerObject",
  "EventListenerOptions",
  "EventMap",
  "EventSource",
  "EventSourceEventMap",
  "FdSocketOptions",
  "FetchEvent",
  "FetchSession",
  "FetchSessionInit",
  "FileBlob",
  "FileSink",
  "FileSystemRouter",
  "FileSystemRouterOptions",
  "GenericTransformStream",
  "Glob",
  "GlobScanOptions",
  "HTMLBundle",
  "Hash",
  "HeapSnapshot",
  "Image",
  "Import",
  "ImportMetaGlobOptions",
  "JSON5",
  "JSONC",
  "JSONL",
  "LibdeflateCompressionOptions",
  "MD4",
  "MD5",
  "MMapOptions",
  "MatchedRoute",
  "MessageEventInit",
  "ModuleGraph",
  "ModuleGraphOptions",
  "NetworkSink",
  "OnLoadArgs",
  "OnLoadResultObject",
  "OnLoadResultSourceCode",
  "OnResolveArgs",
  "OnResolveResult",
  "PluginBuilder",
  "PluginConstraints",
  "ReadableStreamDefaultReadManyResult",
  "RedisClient",
  "RedisOptions",
  "ReservedSQL",
  "ResourceUsage",
  "S3Client",
  "S3File",
  "S3FilePresignOptions",
  "S3ListObjectsOptions",
  "S3ListObjectsResponse",
  "S3Options",
  "S3Stats",
  "SHA1",
  "SHA224",
  "SHA256",
  "SHA384",
  "SHA512",
  "SHA512_256",
  "SQL",
  "SQLArrayParameter",
  "SQLJSONParameter",
  "SavepointSQL",
  "Server",
  "ServerWebSocket",
  "SliceAnsiOptions",
  "Socket",
  "SocketAddress",
  "SocketHandler",
  "SocketListener",
  "SocketOptions",
  "StringWidthOptions",
  "StructuredSerializeOptions",
  "Subprocess",
  "SyncSubprocess",
  "SystemError",
  "TCPSocket",
  "TCPSocketConnectOptions",
  "TCPSocketListenOptions",
  "TCPSocketListener",
  "TLSOptions",
  "TLSSocket",
  "TLSUpgradeOptions",
  "TOML",
  "TSConfig",
  "Terminal",
  "TerminalOptions",
  "TransactionSQL",
  "TransformerFlushCallback",
  "TransformerStartCallback",
  "TransformerTransformCallback",
  "Transpiler",
  "TranspilerOptions",
  "TrimOptions",
  "UnderlyingSink",
  "UnderlyingSinkAbortCallback",
  "UnderlyingSinkCloseCallback",
  "UnderlyingSinkStartCallback",
  "UnderlyingSinkWriteCallback",
  "UnderlyingSource",
  "UnderlyingSourceCancelCallback",
  "UnderlyingSourcePullCallback",
  "UnderlyingSourceStartCallback",
  "UnixSocketListener",
  "UnixSocketOptions",
  "WebSocket",
  "WebSocketEventMap",
  "WebSocketHandler",
  "WebView",
  "WhichOptions",
  "Worker",
  "WorkerEventMap",
  "WorkerOptions",
  "WrapAnsiOptions",
  "XML",
  "YAML",
  "ZlibCompressionOptions",
  "allocUnsafe",
  "argv",
  "build",
  "color",
  "concatArrayBuffers",
  "connect",
  "cron",
  "deepEquals",
  "deepMatch",
  "deflateSync",
  "dns",
  "embeddedFiles",
  "enableANSIColors",
  "env",
  "escapeHTML",
  "fetch",
  "file",
  "fileURLToPath",
  "gc",
  "generateHeapSnapshot",
  "gunzipSync",
  "gzipSync",
  "hash",
  "indexOfLine",
  "inflateSync",
  "inspect",
  "isMainThread",
  "isStandaloneExecutable",
  "listen",
  "main",
  "markdown",
  "mmap",
  "nanoseconds",
  "openInEditor",
  "password",
  "pathToFileURL",
  "peek",
  "plugin",
  "randomUUIDv5",
  "randomUUIDv7",
  "readableStreamToArray",
  "readableStreamToArrayBuffer",
  "readableStreamToFormData",
  "redis",
  "resolve",
  "resolveSync",
  "revision",
  "s3",
  "secrets",
  "semver",
  "serve",
  "sha",
  "sleep",
  "sleepSync",
  "sliceAnsi",
  "spawn",
  "spawnSync",
  "sql",
  "stderr",
  "stdin",
  "stdout",
  "stringWidth",
  "stripANSI",
  "udpSocket",
  "unsafe",
  "version",
  "version_with_sha",
  "which",
  "wrapAnsi",
  "write",
  "zstdCompress",
  "zstdCompressSync",
  "zstdDecompress",
  "zstdDecompressSync",
] as const;

const BUN_NESTED_AND_ALIAS_REFERENCE_SYMBOLS: Readonly<Record<string, string>> =
  {
    AnsiTheme: "bun/markdown/AnsiTheme",
    "Bun.markdown.AnsiTheme": "bun/markdown/AnsiTheme",
    "Bun.markdown.Options": "bun/markdown/Options",
    "Bun.markdown.ReactOptions": "bun/markdown/ReactOptions",
    "Bun.markdown.RenderCallbacks": "bun/markdown/RenderCallbacks",
    "Bun.markdown.ComponentOverrides": "bun/markdown/ComponentOverrides",
    "Bun.markdown.Component": "bun/markdown/Component",
    "Bun.markdown.HeadingMeta": "bun/markdown/HeadingMeta",
    "Bun.markdown.CodeBlockMeta": "bun/markdown/CodeBlockMeta",
    "Bun.markdown.ListMeta": "bun/markdown/ListMeta",
    "Bun.markdown.ListItemMeta": "bun/markdown/ListItemMeta",
    "Bun.markdown.CellMeta": "bun/markdown/CellMeta",
    "Bun.markdown.LinkMeta": "bun/markdown/LinkMeta",
    "Bun.markdown.ImageMeta": "bun/markdown/ImageMeta",
    "Bun.markdown.ChildrenProps": "bun/markdown/ChildrenProps",
    "Bun.markdown.HeadingProps": "bun/markdown/HeadingProps",
    "Bun.markdown.OrderedListProps": "bun/markdown/OrderedListProps",
    "Bun.markdown.ListItemProps": "bun/markdown/ListItemProps",
    "Bun.markdown.CodeBlockProps": "bun/markdown/CodeBlockProps",
    "Bun.markdown.CellProps": "bun/markdown/CellProps",
    "Bun.markdown.LinkProps": "bun/markdown/LinkProps",
    "Bun.markdown.ImageProps": "bun/markdown/ImageProps",
    "Bun.markdown.html": "bun/markdown/html",
    "Bun.markdown.ansi": "bun/markdown/ansi",
    "Bun.markdown.render": "bun/markdown/render",
    "Bun.markdown.react": "bun/markdown/react",
    "Bun.inspect.custom": "bun/inspect",
    "Bun.inspect.table": "bun/inspect",
    "Bun.Archive.blob": "bun/Archive/blob",
    "Bun.Archive.bytes": "bun/Archive/bytes",
    "Bun.Archive.extract": "bun/Archive/extract",
    "Bun.Archive.files": "bun/Archive/files",
    "Bun.Archive.write": "bun/Archive/write",
    ArchiveExtractOptions: "bun/ArchiveExtractOptions",
    ArchiveInput: "bun/ArchiveInput",
    "Bun.ArchiveInput": "bun/ArchiveInput",
    ArchiveOptions: "bun/ArchiveOptions",
    "Bun.TOML.parse": "bun/TOML/parse",
    "Bun.TOML.stringify": "bun/TOML/stringify",
    "dns.lookup": "bun/dns/lookup",
    "dns.prefetch": "bun/dns/prefetch",
    "dns.getCacheStats": "bun/dns/getCacheStats",
    ImportKind: "bun/ImportKind",
    "bun:bundle": "bun/bundle",
    "bun:ffi": "bun/ffi",
    "bun:jsc": "bun/jsc",
    "bun:sqlite": "bun/sqlite",
    "bun:test": "bun/test",
  };

/**
 * Known Bun reference symbols and their canonical symbol paths under `/reference/`.
 */
export const BUN_KNOWN_REFERENCE_SYMBOLS: Readonly<Record<string, string>> = {
  ...BUN_NESTED_AND_ALIAS_REFERENCE_SYMBOLS,
  ...Object.fromEntries(
    BUN_ROOT_REFERENCE_SYMBOLS.map((sym) => [`Bun.${sym}`, `bun/${sym}`]),
  ),
};

const REFERENCE_SYMBOL_EXACT = new Map<string, string>(
  Object.entries(BUN_KNOWN_REFERENCE_SYMBOLS),
);

const REFERENCE_SYMBOL_LOWER = new Map<string, string>();
for (const [key, path] of Object.entries(BUN_KNOWN_REFERENCE_SYMBOLS)) {
  const lower = key.toLowerCase();
  if (!REFERENCE_SYMBOL_LOWER.has(lower)) {
    REFERENCE_SYMBOL_LOWER.set(lower, path);
  }
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const REFERENCE_SYMBOL_ALTERNATION = Object.keys(BUN_KNOWN_REFERENCE_SYMBOLS)
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join("|");

const FIND_REFERENCE_SYMBOLS_REGEX = new RegExp(
  `(?<=^|[^a-zA-Z0-9_.])\`?(${REFERENCE_SYMBOL_ALTERNATION})\`?(?=[^a-zA-Z0-9_.]|$)`,
  "g",
);

const LINKIFY_REFERENCE_SYMBOLS_REGEX = new RegExp(
  `(?<!\\[)\`(${REFERENCE_SYMBOL_ALTERNATION})\`(?!\\]|\\()`,
  "g",
);

/**
 * Resolves a Bun symbol name (e.g. `"AnsiTheme"`, `"Bun.markdown.ansi"`, `"bun/markdown/AnsiTheme"`,
 * `"globals/bun/markdown/AnsiTheme"` (legacy), or `"https://bun.com/reference/bun/markdown/AnsiTheme"`)
 * to its canonical Bun reference URL.
 */
export function resolveBunSymbolReferenceUrl(symbol: string): BunUrl | null {
  const trimmed = symbol.trim().replace(/^`|`$/g, "");
  if (!trimmed) return null;

  // Direct match in known symbols catalog
  const exactPath = REFERENCE_SYMBOL_EXACT.get(trimmed);
  if (exactPath !== undefined) {
    return bunReferenceUrl(exactPath);
  }

  // Case-insensitive match in known symbols catalog
  const lowerPath = REFERENCE_SYMBOL_LOWER.get(trimmed.toLowerCase());
  if (lowerPath !== undefined) {
    return bunReferenceUrl(lowerPath);
  }

  // Full Bun reference URL (e.g. https://bun.com/reference/bun/markdown/AnsiTheme)
  const parsedRef = parseBunReferenceUrl(trimmed);
  if (parsedRef) {
    // Accept the legacy `globals/bun/...` shape; always emit the current one.
    const normalizedPath = parsedRef.symbolPath.startsWith("globals/")
      ? parsedRef.symbolPath.slice("globals/".length)
      : parsedRef.symbolPath;
    try {
      return bunReferenceUrl(normalizedPath);
    } catch {
      return parsedRef.canonicalUrl;
    }
  }

  // If path format provided directly (bun/markdown/AnsiTheme, or the legacy
  // globals/bun/markdown/AnsiTheme which canonicalizes to the same page).
  const directPath = trimmed.startsWith("globals/")
    ? trimmed.slice("globals/".length)
    : trimmed;
  if (directPath.startsWith("bun/")) {
    try {
      return bunReferenceUrl(directPath);
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

  FIND_REFERENCE_SYMBOLS_REGEX.lastIndex = 0;
  for (const match of text.matchAll(FIND_REFERENCE_SYMBOLS_REGEX)) {
    const symbolName = match[1];
    if (!symbolName) continue;
    const symbolPath = REFERENCE_SYMBOL_EXACT.get(symbolName);
    if (!symbolPath || seen.has(symbolPath)) continue;
    seen.add(symbolPath);
    const parsed = parseBunReferenceUrl(bunReferenceUrl(symbolPath));
    if (parsed) results.push(parsed);
  }

  return results;
}

/**
 * Automatically transforms occurrences of recognized Bun symbols in Markdown into
 * canonical OSC 8 Markdown hyperlinks pointing to Bun's official documentation.
 */
export function linkifyBunSymbolsInMarkdown(markdown: string): string {
  LINKIFY_REFERENCE_SYMBOLS_REGEX.lastIndex = 0;
  return markdown.replace(
    LINKIFY_REFERENCE_SYMBOLS_REGEX,
    (full, symbolName: string) => {
      const symbolPath = REFERENCE_SYMBOL_EXACT.get(symbolName);
      if (!symbolPath) return full;
      return `[\`${symbolName}\`](${bunReferenceUrl(symbolPath)})`;
    },
  );
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
