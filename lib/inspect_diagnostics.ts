/**
 * @file lib/inspect_diagnostics.ts
 * @description Diagnostic cards for Bun routing primitives: `Bun.MatchedRoute` and the
 * `BunRequest` handed to a `Bun.serve` route handler.
 *
 * Both cards keep the raw Bun object in a `#private` field, so `Bun.inspect(diag, { showHidden:
 * true, depth: null })` renders the card's `[Bun.inspect.custom]` string and can never reach the
 * live route. Measured on Bun 1.4.4, inspecting the raw match prints the absolute `filePath` and
 * the decoded query string; inspecting a class whose fields are `#private` shows only the
 * formatter's output.
 *
 * `MatchedRoute.query` is params-merged in Bun 1.4.4: for `/modes/6/weblog?0=live` the match
 * reports `params: { 0: "6" }` and `query: { 0: "6", slug: "weblog" }`, with the param winning the
 * collision. `splitRouteQuery()` removes the param keys so the card shows query-only state, and a
 * colliding query key that Bun discarded cannot be recovered — the card never invents it.
 */

import { basename, isAbsolute, relative, resolve } from "node:path";

import { formatByteCount } from "./format_bytes.ts";
import { DEFAULT_MAX_PIXELS } from "./image_limits.ts";
import {
  type InspectVisibility,
  redactDiagnosticSurface,
  resolveInspectVisibility,
  sanitizeDiagnosticUrl,
  sanitizeRouteRecord,
} from "./inspect_redactor.ts";

type InspectOptions = NonNullable<Parameters<typeof Bun.inspect>[1]>;

const SGR = {
  elevatedBg: "\x1b[48;2;24;30;44m",
  raisedBg: "\x1b[48;2;51;65;85m",
  focusFg: "\x1b[38;2;125;211;252m",
  codeFg: "\x1b[38;2;226;232;240m",
  secondaryFg: "\x1b[38;2;148;163;184m",
  reset: "\x1b[0m",
} as const;

interface DiagnosticTheme {
  readonly colors: boolean;
}

function themeFrom(options: InspectOptions): DiagnosticTheme {
  return { colors: options.colors === true };
}

function paint(text: string, sgr: string, theme: DiagnosticTheme): string {
  return theme.colors ? `${sgr}${text}${SGR.reset}` : text;
}

const ROUTE_KIND_LABEL: Readonly<Record<Bun.MatchedRoute["kind"], string>> =
  Object.freeze({
    exact: "ROUTE_EXACT",
    dynamic: "ROUTE_DYNAMIC",
    "catch-all": "ROUTE_CATCH_ALL",
    "optional-catch-all": "ROUTE_OPT_CATCH_ALL",
  });

export function formatRouteKindBadge(
  kind: Bun.MatchedRoute["kind"],
  theme: DiagnosticTheme,
): string {
  const label = ROUTE_KIND_LABEL[kind] ?? "ROUTE_UNKNOWN";
  if (!theme.colors) return `[${label}]`;
  switch (kind) {
    case "exact":
      return paint(`◆ ${label}`, `${SGR.elevatedBg}${SGR.focusFg}`, theme);
    case "dynamic":
      return paint(`◇ ${label}`, `${SGR.raisedBg}${SGR.codeFg}`, theme);
    case "catch-all":
    case "optional-catch-all":
      return paint(`◈ ${label}`, `${SGR.elevatedBg}${SGR.secondaryFg}`, theme);
    default:
      return `[${label}]`;
  }
}

/**
 * The router-relative script path. `MatchedRoute.src` is already relative when the router has no
 * `origin`/`assetPrefix`; when it is an absolute URL or prefixed path, the route `name` is located
 * inside it and everything before that is dropped so an origin cannot leak.
 */
function routerRelativeRouteSrc(
  route: Pick<Bun.MatchedRoute, "name" | "src">,
): string {
  const name = route.name.replace(/^\//, "");
  if (name !== "") {
    const at = route.src.indexOf(name);
    if (at !== -1) return route.src.slice(at);
  }
  return route.src.replace(/^[a-z]+:\/\/[^/]+\//i, "").replace(/^\//, "");
}

/**
 * Masks the absolute host path of the matched route file.
 *
 * - `OWNER_ADMIN`: absolute path, scrubbed of secrets.
 * - `RISK_MANAGER`: workspace-relative route target, never the host directory.
 * - `AUDITOR_SANITIZED`: `[REDACTED_DIR]/<basename>` only.
 */
export function maskRouteFilePath(
  route: Pick<Bun.MatchedRoute, "filePath" | "name" | "src">,
  visibility: InspectVisibility = resolveInspectVisibility(),
): string {
  if (visibility === "OWNER_ADMIN") {
    return redactDiagnosticSurface(route.filePath, visibility);
  }
  const relative = routerRelativeRouteSrc(route);
  if (visibility === "RISK_MANAGER") {
    return redactDiagnosticSurface(relative, visibility);
  }
  const leaf = basename(route.filePath || relative);
  return leaf === "" ? "[REDACTED_PATH]" : `[REDACTED_DIR]/${leaf}`;
}

/**
 * Query-only state of a match. Bun 1.4.4 merges `params` into `query` and lets the param win, so
 * removing the param keys recovers what the URL actually carried. A query key that collides with
 * a param name was already discarded by Bun and is not reconstructed here.
 */
export function splitRouteQuery(
  route: Pick<Bun.MatchedRoute, "params" | "query">,
): Readonly<Record<string, string>> {
  const out = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(route.query)) {
    if (Object.hasOwn(route.params, key)) continue;
    out[key] = route.query[key] ?? "";
  }
  return Object.freeze(out);
}

/**
 * `MatchedRoute.pathname` carries the decoded query string, so scrubbing it as plain text misses
 * account and address keys. Each key whose sanitized value differs from the raw one is rewritten
 * in place, keeping the URL readable instead of re-encoding placeholders.
 */
function safeRoutePathname(
  route: Pick<Bun.MatchedRoute, "pathname" | "query">,
  visibility: InspectVisibility,
): string {
  let out = redactDiagnosticSurface(route.pathname, visibility);
  const sanitized = sanitizeRouteRecord(route.query, visibility);
  for (const key of Object.keys(route.query)) {
    const raw = route.query[key] ?? "";
    const safe = sanitized[key] ?? "";
    if (raw === "" || raw === safe) continue;
    out = out.split(`${key}=${raw}`).join(`${key}=${safe}`);
  }
  return out;
}

function safeRequestUrl(url: string, visibility: InspectVisibility): string {
  let out = sanitizeDiagnosticUrl(url, visibility);
  const queryAt = out.indexOf("?");
  if (queryAt === -1) return out;
  const bag = Object.create(null) as Record<string, string>;
  for (const [key, value] of new URLSearchParams(out.slice(queryAt + 1))) {
    bag[key] = value;
  }
  const sanitized = sanitizeRouteRecord(bag, visibility);
  for (const key of Object.keys(bag)) {
    const raw = bag[key] ?? "";
    const safe = sanitized[key] ?? "";
    if (raw === "" || raw === safe) continue;
    out = out.split(`${key}=${raw}`).join(`${key}=${safe}`);
  }
  return out;
}

function formatFlatRecordInline(
  record: Readonly<Record<string, string>>,
  theme: DiagnosticTheme,
): string {
  const keys = Object.keys(record);
  if (keys.length === 0) return "{}";
  const parts: string[] = [];
  for (const key of keys) {
    const value = JSON.stringify(record[key] ?? "");
    parts.push(
      theme.colors
        ? `${SGR.secondaryFg}${key}${SGR.reset}=${value}`
        : `${key}=${value}`,
    );
  }
  return `{ ${parts.join(", ")} }`;
}

function styleKey(label: string, theme: DiagnosticTheme): string {
  return paint(label, SGR.secondaryFg, theme);
}

function formatOsc8Link(
  label: string,
  url: string,
  theme: DiagnosticTheme,
): string {
  if (!theme.colors) return `${label} ${url}`;
  return `\x1b]8;;${encodeURI(url)}\x07${label}\x1b]8;;\x07`;
}

export interface MatchedRouteDiagnosticInit {
  readonly route: Bun.MatchedRoute;
  readonly assetPrefix?: string | null | undefined;
  readonly deskBaseUrl?: string | undefined;
  readonly visibility?: InspectVisibility | undefined;
}

function isMatchedRouteInit(
  value: Bun.MatchedRoute | MatchedRouteDiagnosticInit,
): value is MatchedRouteDiagnosticInit {
  const candidate = value as { route?: unknown };
  return (
    typeof candidate.route === "object" &&
    candidate.route !== null &&
    "filePath" in candidate.route
  );
}

export class MatchedRouteDiagnostic {
  readonly #route: Bun.MatchedRoute;
  readonly #assetPrefix: string | null;
  readonly #deskBaseUrl: string | undefined;
  readonly #visibility: InspectVisibility | undefined;

  constructor(init: Bun.MatchedRoute | MatchedRouteDiagnosticInit) {
    if (isMatchedRouteInit(init)) {
      this.#route = init.route;
      this.#assetPrefix = init.assetPrefix ?? null;
      this.#deskBaseUrl = init.deskBaseUrl;
      this.#visibility = init.visibility;
    } else {
      this.#route = init;
      this.#assetPrefix = null;
      this.#deskBaseUrl = undefined;
      this.#visibility = undefined;
    }
    Object.freeze(this);
  }

  #role(): InspectVisibility {
    return resolveInspectVisibility(this.#visibility);
  }

  get kind(): Bun.MatchedRoute["kind"] {
    return this.#route.kind;
  }

  get name(): string {
    return redactDiagnosticSurface(this.#route.name, this.#role());
  }

  get pathname(): string {
    return safeRoutePathname(this.#route, this.#role());
  }

  get params(): Readonly<Record<string, string>> {
    return sanitizeRouteRecord(this.#route.params, this.#role());
  }

  get query(): Readonly<Record<string, string>> {
    return sanitizeRouteRecord(splitRouteQuery(this.#route), this.#role());
  }

  get filePath(): string {
    return maskRouteFilePath(this.#route, this.#role());
  }

  get assetPrefix(): string | null {
    return this.#assetPrefix;
  }

  toJSON(): Record<string, unknown> {
    const role = this.#role();
    return {
      type: "MatchedRouteDiagnostic",
      visibility: role,
      kind: this.#route.kind,
      name: redactDiagnosticSurface(this.#route.name, role),
      pathname: safeRoutePathname(this.#route, role),
      params: sanitizeRouteRecord(this.#route.params, role),
      query: sanitizeRouteRecord(splitRouteQuery(this.#route), role),
      filePath: maskRouteFilePath(this.#route, role),
      assetPrefix: this.#assetPrefix,
    };
  }

  [Bun.inspect.custom](
    depth: number,
    options: InspectOptions,
    _inspect: typeof Bun.inspect,
  ): string {
    const theme = themeFrom(options);
    const role = this.#role();
    const kindBadge = formatRouteKindBadge(this.#route.kind, theme);
    const safePathname = safeRoutePathname(this.#route, role);

    // Bun passes `0` for `{ depth: 0 }` and clamps everything else to `0..8`; a negative depth is
    // rejected before the formatter runs (measured on 1.4.4), so `<= 0` is the shallow branch.
    if (depth <= 0) {
      return `[MatchedRoute ${kindBadge} ${safePathname}]`;
    }

    const safeParams = sanitizeRouteRecord(this.#route.params, role);
    const safeQuery = sanitizeRouteRecord(splitRouteQuery(this.#route), role);
    const safePath = maskRouteFilePath(this.#route, role);
    const safeName = redactDiagnosticSurface(this.#route.name, role);
    const prefix =
      this.#assetPrefix === null ? "null" : JSON.stringify(this.#assetPrefix);

    const lines: string[] = [
      `${paint("MatchedRoute", `${SGR.elevatedBg}${SGR.focusFg}`, theme)} ${kindBadge}`,
      `  ${styleKey("route:", theme)}    ${safePathname} (name=${JSON.stringify(safeName)}, assetPrefix=${prefix})`,
      `  ${styleKey("params:", theme)}   ${formatFlatRecordInline(safeParams, theme)}`,
      `  ${styleKey("query:", theme)}    ${formatFlatRecordInline(safeQuery, theme)}`,
      `  ${styleKey("target:", theme)}   ${safePath} (visibility=${role})`,
    ];

    if (this.#deskBaseUrl !== undefined) {
      const base = this.#deskBaseUrl.endsWith("/")
        ? this.#deskBaseUrl.slice(0, -1)
        : this.#deskBaseUrl;
      const safeUrl = sanitizeDiagnosticUrl(`${base}${safePathname}`, role);
      lines.push(
        `  ${styleKey("desk:", theme)}     ${formatOsc8Link("Open Matched Route", safeUrl, theme)}`,
      );
    }

    return lines.join("\n");
  }
}

export function wrapMatchedRouteDiagnostic(
  match: Bun.MatchedRoute | null,
  opts?: Omit<MatchedRouteDiagnosticInit, "route">,
): MatchedRouteDiagnostic | null {
  if (match === null) return null;
  return new MatchedRouteDiagnostic(
    opts ? { ...opts, route: match } : { route: match },
  );
}

/**
 * Structural shape of the request a `Bun.serve` route handler receives. `BunRequest` is a type in
 * 1.4.4, not a runtime global (`typeof BunRequest === "undefined"`), so the card duck-types this
 * surface instead of using `instanceof`. `cookies` is an optional getter so a caller can pass a
 * request-like object without one, and it is only read when the card asks for cookie state.
 */
export interface DiagnosticRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly params?: Readonly<Record<string, string>> | undefined;
  readonly cookies?: Iterable<readonly [string, string]> | undefined;
}

export interface BunRequestDiagnosticInit {
  readonly request: DiagnosticRequest;
  readonly deskBaseUrl?: string | undefined;
  readonly visibility?: InspectVisibility | undefined;
}

const SENSITIVE_HEADER_RE =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|cf-access-jwt-assertion|x-amz-.*)$/i;

const UNREADABLE_COOKIE_JAR = "[UNREADABLE_COOKIE_JAR]";

function isRequestInit(
  value: DiagnosticRequest | BunRequestDiagnosticInit,
): value is BunRequestDiagnosticInit {
  const candidate = value as { request?: unknown };
  return (
    typeof candidate.request === "object" &&
    candidate.request !== null &&
    "url" in candidate.request &&
    "method" in candidate.request
  );
}

export class BunRequestDiagnostic {
  readonly #request: DiagnosticRequest;
  readonly #deskBaseUrl: string | undefined;
  readonly #visibility: InspectVisibility | undefined;

  constructor(init: DiagnosticRequest | BunRequestDiagnosticInit) {
    if (isRequestInit(init)) {
      this.#request = init.request;
      this.#deskBaseUrl = init.deskBaseUrl;
      this.#visibility = init.visibility;
    } else {
      this.#request = init;
      this.#deskBaseUrl = undefined;
      this.#visibility = undefined;
    }
    Object.freeze(this);
  }

  #role(): InspectVisibility {
    return resolveInspectVisibility(this.#visibility);
  }

  get method(): string {
    return this.#request.method;
  }

  get url(): string {
    return safeRequestUrl(this.#request.url, this.#role());
  }

  get params(): Readonly<Record<string, string>> {
    return sanitizeRouteRecord(this.#request.params ?? {}, this.#role());
  }

  get headers(): Readonly<Record<string, string>> {
    const role = this.#role();
    const out = Object.create(null) as Record<string, string>;
    for (const [name, value] of this.#request.headers) {
      out[name.toLowerCase()] = SENSITIVE_HEADER_RE.test(name)
        ? "[REDACTED_HEADER]"
        : redactDiagnosticSurface(value, role);
    }
    return Object.freeze(out);
  }

  #cookieNames(): readonly string[] {
    const jar = this.#request.cookies;
    if (jar === undefined) return Object.freeze([]);
    try {
      const names: string[] = [];
      for (const [name] of jar) names.push(name);
      return Object.freeze(names);
    } catch {
      // A cookie-jar parse error can quote the raw header, so only the sentinel is surfaced.
      return Object.freeze([UNREADABLE_COOKIE_JAR]);
    }
  }

  get cookieNames(): readonly string[] {
    return this.#cookieNames();
  }

  get cookies(): Readonly<Record<string, string>> {
    const out = Object.create(null) as Record<string, string>;
    for (const name of this.#cookieNames()) out[name] = "[REDACTED_COOKIE]";
    return Object.freeze(out);
  }

  toJSON(): Record<string, unknown> {
    const role = this.#role();
    return {
      type: "BunRequestDiagnostic",
      visibility: role,
      method: this.#request.method,
      url: safeRequestUrl(this.#request.url, role),
      params: sanitizeRouteRecord(this.#request.params ?? {}, role),
      cookies: this.cookies,
      headers: this.headers,
    };
  }

  [Bun.inspect.custom](
    depth: number,
    options: InspectOptions,
    _inspect: typeof Bun.inspect,
  ): string {
    const theme = themeFrom(options);
    const role = this.#role();
    const methodBadge = paint(
      this.#request.method,
      `${SGR.raisedBg}${SGR.codeFg}`,
      theme,
    );
    const safeUrl = safeRequestUrl(this.#request.url, role);

    if (depth <= 0) {
      return `[BunRequest ${methodBadge} ${safeUrl}]`;
    }

    const names = this.#cookieNames();
    const cookieLine =
      names.length === 0
        ? "(none)"
        : `${names.join(", ")} (${names.length}, values redacted)`;
    const lines: string[] = [
      `${paint("BunRequest", `${SGR.elevatedBg}${SGR.focusFg}`, theme)} ${methodBadge} ${safeUrl}`,
      `  ${styleKey("params:", theme)}   ${formatFlatRecordInline(sanitizeRouteRecord(this.#request.params ?? {}, role), theme)}`,
      `  ${styleKey("cookies:", theme)}  ${cookieLine}`,
      `  ${styleKey("headers:", theme)}  ${formatFlatRecordInline(this.headers, theme)}`,
    ];

    if (this.#deskBaseUrl !== undefined) {
      const base = this.#deskBaseUrl.endsWith("/")
        ? this.#deskBaseUrl.slice(0, -1)
        : this.#deskBaseUrl;
      const pathname = safeUrl.replace(/^[a-z]+:\/\/[^/]+/i, "");
      const safeLink = safeRequestUrl(`${base}${pathname}`, role);
      lines.push(
        `  ${styleKey("desk:", theme)}     ${formatOsc8Link("Open Request", safeLink, theme)}`,
      );
    }

    return lines.join("\n");
  }
}

export function wrapBunRequestDiagnostic(
  request: DiagnosticRequest,
  opts?: Omit<BunRequestDiagnosticInit, "request">,
): BunRequestDiagnostic {
  return new BunRequestDiagnostic(opts ? { ...opts, request } : { request });
}

// -----------------------------------------------------------------------------
// 3. Bun.Image Asset Attributes
// `Bun.Image.Metadata` reads the header only, so a dashboard asset probe does not decode pixels.
// The source is masked per visibility tier before it reaches a card or JSON body.
// -----------------------------------------------------------------------------

export type BunImageAssetInput = Uint8Array | ArrayBuffer | Blob | string;

export interface BunImageAssetInit {
  readonly source: string;
  readonly width: number;
  readonly height: number;
  readonly format: Bun.Image.Metadata["format"];
  readonly bytes?: number | undefined;
  readonly backend?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly visibility?: InspectVisibility | undefined;
}

/**
 * Masks an image source.
 *
 * - URLs go through `sanitizeDiagnosticUrl`, so a presigned R2 link loses its signature.
 * - Paths inside the workspace become workspace-relative for `RISK_MANAGER`.
 * - `AUDITOR_SANITIZED` keeps the leaf filename only.
 */
export function maskAssetSource(
  source: string,
  visibility: InspectVisibility = resolveInspectVisibility(),
): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    return sanitizeDiagnosticUrl(source, visibility);
  }
  if (visibility === "OWNER_ADMIN") {
    return redactDiagnosticSurface(source, visibility);
  }
  const absolute = isAbsolute(source) ? source : resolve(source);
  const rel = relative(process.cwd(), absolute);
  const insideWorkspace =
    rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (visibility === "RISK_MANAGER" && insideWorkspace) {
    return redactDiagnosticSurface(rel, visibility);
  }
  return `[REDACTED_DIR]/${basename(source)}`;
}

export class BunImageAssetDiagnostic {
  readonly #asset: BunImageAssetInit;

  constructor(asset: BunImageAssetInit) {
    this.#asset = asset;
    Object.freeze(this);
  }

  #role(): InspectVisibility {
    return resolveInspectVisibility(this.#asset.visibility);
  }

  get type(): "BunImageAssetDiagnostic" {
    return "BunImageAssetDiagnostic";
  }

  get source(): string {
    return maskAssetSource(this.#asset.source, this.#role());
  }

  get width(): number {
    return this.#asset.width;
  }

  get height(): number {
    return this.#asset.height;
  }

  get format(): Bun.Image.Metadata["format"] {
    return this.#asset.format;
  }

  get bytes(): number | null {
    return this.#asset.bytes ?? null;
  }

  get backend(): string | null {
    return this.#asset.backend ?? null;
  }

  get aspectRatio(): number {
    return this.#asset.height === 0
      ? 0
      : this.#asset.width / this.#asset.height;
  }

  get placeholderBytes(): number | null {
    return this.#asset.placeholder === undefined
      ? null
      : this.#asset.placeholder.length;
  }

  toJSON(): Record<string, unknown> {
    return {
      type: this.type,
      visibility: this.#role(),
      source: this.source,
      format: this.#asset.format,
      width: this.#asset.width,
      height: this.#asset.height,
      aspectRatio: Number(this.aspectRatio.toFixed(4)),
      bytes: this.#asset.bytes ?? null,
      backend: this.#asset.backend ?? null,
      placeholderBytes: this.placeholderBytes,
    };
  }

  [Bun.inspect.custom](
    depth: number,
    options: InspectOptions,
    _inspect: typeof Bun.inspect,
  ): string {
    const theme = themeFrom(options);
    const role = this.#role();
    const label = this.#asset.format.toUpperCase();
    const dimensions = `${this.#asset.width}×${this.#asset.height}`;
    const header = `${paint("BunImageAsset", `${SGR.elevatedBg}${SGR.focusFg}`, theme)} ${label} ${dimensions}`;

    if (depth <= 0) {
      return `[BunImageAsset ${label} ${dimensions}]`;
    }

    const lines: string[] = [
      header,
      `  ${styleKey("source:", theme)}      ${maskAssetSource(this.#asset.source, role)} (visibility=${role})`,
      `  ${styleKey("dimensions:", theme)}  ${dimensions} (aspect ${this.aspectRatio.toFixed(2)})`,
    ];
    if (this.#asset.bytes !== undefined) {
      lines.push(
        `  ${styleKey("bytes:", theme)}       ${formatByteCount(this.#asset.bytes)}`,
      );
    }
    if (this.#asset.backend !== undefined) {
      lines.push(`  ${styleKey("backend:", theme)}     ${this.#asset.backend}`);
    }
    if (this.#asset.placeholder !== undefined) {
      lines.push(
        `  ${styleKey("placeholder:", theme)} present (${formatByteCount(this.#asset.placeholder.length)} data URL)`,
      );
    }
    return lines.join("\n");
  }
}

export interface InspectBunImageAssetOptions {
  /** Display source; defaults to the file path, or `<buffer>` for in-memory bytes. */
  readonly displaySource?: string | undefined;
  readonly bytes?: number | undefined;
  readonly backend?: string | undefined;
  readonly placeholder?: string | undefined;
  /** Decode the image to compute its ThumbHash placeholder data URL (slower than metadata). */
  readonly computePlaceholder?: boolean | undefined;
  readonly visibility?: InspectVisibility | undefined;
  readonly maxPixels?: number | undefined;
}

/** Reads image attributes from the header (no pixel decode) and wraps them in a diagnostic. */
export async function inspectBunImageAsset(
  input: BunImageAssetInput,
  options: InspectBunImageAssetOptions = {},
): Promise<BunImageAssetDiagnostic> {
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const pipeline =
    typeof input === "string"
      ? Bun.file(input).image({ maxPixels })
      : new Bun.Image(input, { maxPixels });
  const metadata = await pipeline.metadata();
  const placeholder =
    options.placeholder ??
    (options.computePlaceholder === true
      ? await pipeline.placeholder()
      : undefined);
  const byteLength =
    options.bytes ??
    (typeof input === "string"
      ? Bun.file(input).size
      : input instanceof Blob
        ? input.size
        : input.byteLength);
  return new BunImageAssetDiagnostic({
    source:
      options.displaySource ?? (typeof input === "string" ? input : "<buffer>"),
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    bytes: byteLength,
    backend: options.backend ?? Bun.Image.backend,
    placeholder,
    visibility: options.visibility,
  });
}
