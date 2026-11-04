/**
 * Byte pins for the CDN assets a portal document executes.
 *
 * Detection, not prevention: this module fetches the bytes a document names, hashes them, and
 * compares against `verification/manager-boot-oracle/pinned/cdn-manifest.json`. Prevention —
 * `integrity=` — is enforced offline by `bin/check-innerhtml.ts` against the same manifest.
 *
 * The measurement point is the origin response, not the CDN's headers: `ETag`/`Last-Modified` are
 * written by a mutable origin and a heuristically cached copy can outlive a fix, so only the bytes
 * are trustworthy.
 */

import { join } from "node:path";

import { z } from "zod";

import {
  assetRole,
  extractCssReferences,
  extractExternalAssets,
  isSriIneligibleUrl,
  type AssetRole,
} from "./f402_cdn_assets.ts";
import { PROBE_HOST } from "./f402_hierarchy_config.ts";

export const CDN_MANIFEST_PATH = join(
  import.meta.dir,
  "..",
  "verification",
  "manager-boot-oracle",
  "pinned",
  "cdn-manifest.json",
);

export const PORTAL_DOCUMENT_URL = `${PROBE_HOST}/manager.html`;

const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_CONCURRENCY = 8;

/**
 * Assets no tag points at, but the document's stylesheet chain pulls in. Pinned explicitly so a
 * change to the compiled CSS base is visible even when no `<link>` moved.
 */
export const EXPLICIT_CDN_ASSETS: readonly string[] = [
  // Imported by the .less chain, so no tag names it.
  "https://cdn.fastassets.io/css/setting.less?v=1521666264242",
  "https://cdn.fastassets.io/css/setting.less?v=15216662642435",
  // Loaded by this repository's own pages, not by the vendor document.
  "https://telegram.org/js/telegram-web-app.js",
  // docs/index.html renders the API reference with this immutable-version Scalar bundle;
  // `verify:docs` already requires its SRI, and the manifest keeps that hash and the others
  // from drifting apart.
  "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.4/dist/browser/standalone.js",
] as const;

export type CdnAssetSource = "document" | "explicit" | "app";

/**
 * `/app/` AMD modules the shell needs before any controller code runs. The controller's own
 * `require`/`define` lists are discovered from its bytes at pin time, so a module the loader can
 * reach is either pinned or reported.
 */
export const APP_BOOT_MODULES: readonly string[] = [
  "setting/version",
  "setting/config-manager",
  "main-manager",
  "manager/manager",
  "system/security",
  "util/http",
  "util/util",
  "util/message",
  "system/log",
  "ui/ui",
  "ui/load",
  "core/class",
  "language/language",
] as const;

/** Absolute URL for one `/app/` AMD module id, no query. */
export function appModuleUrl(host: string, moduleId: string): string | null {
  let clean = moduleId.trim();
  if (clean.startsWith("/app/")) clean = clean.slice("/app/".length);
  else if (clean.startsWith("/")) return null;
  clean = clean.replace(/\.js$/, "");
  if (!/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/.test(clean)) return null;
  const base = host.startsWith("http") ? host : `https://${host}`;
  return `${base.replace(/\/$/, "")}/app/${clean}.js`;
}

/** AMD module ids from `define([...])` / `require([...])` arrays; plugin resources are skipped. */
export function extractAmdModuleIds(js: string): string[] {
  const ids = new Set<string>();
  for (const match of js.matchAll(/(?:define|require)\s*\(\s*\[([^\]]*)\]/g)) {
    for (const quoted of (match[1] ?? "").matchAll(/["']([^"']+)["']/g)) {
      const id = quoted[1];
      if (id === undefined) continue;
      // Skip plugin resources and concatenated ids such as `"manager/module/" + name`:
      // only a fully spelled module path can be resolved to a file.
      if (!/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/.test(id)) continue;
      ids.add(id);
    }
  }
  return [...ids].sort();
}

/** `/app/` module URLs the controller requires that the manifest does not pin. */
export function appModuleCoverage(
  managerJs: string,
  manifest: CdnManifest,
): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const id of [...APP_BOOT_MODULES, ...extractAmdModuleIds(managerJs)]) {
    const url = appModuleUrl(manifest.host, id);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    if (manifest.assets[url]?.source !== "app") missing.push(url);
  }
  return missing.sort();
}

/** Fetch URL for a pin: `/app/` modules carry the AMD loader's `?bust=<version>` value. */
export function pinnedAssetFetchUrl(
  url: string,
  pin: CdnAssetPin,
  vendorVersion: string,
): string {
  if (!pin.sameOrigin) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("bust", vendorVersion);
  return parsed.toString();
}

export interface CdnAssetPin {
  readonly sha256: string;
  /** `sha384-<base64>`, ready for an `integrity=` attribute. */
  readonly sri: string;
  /** False when the origin sends no `Access-Control-Allow-Origin`; `integrity=` would block it. */
  readonly sriEnforceable: boolean;
  /** True for `/app/` AMD modules: same-origin, fetched with the AMD loader's `?bust=` value. */
  readonly sameOrigin: boolean;
  readonly bytes: number;
  readonly role: AssetRole;
  readonly source: CdnAssetSource;
  /** `url(...)`/`@import` targets resolved out of a stylesheet; empty for scripts. */
  readonly externalReferences: readonly string[];
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly fetchedAt: string;
}

export interface CdnManifest {
  readonly schemaVersion: 1;
  readonly host: string;
  readonly documentUrl: string;
  readonly pinnedAt: string;
  /** Vendor release the pins belong to; a hash change must move this or be forced. */
  readonly vendorVersion: string;
  /** Keyed by normalized URL (see `normalizeAssetUrl`). */
  readonly assets: Readonly<Record<string, CdnAssetPin>>;
}

export type FetchOutcome =
  | {
      readonly kind: "ok";
      readonly bytes: Uint8Array;
      readonly etag: string | null;
      readonly lastModified: string | null;
    }
  | { readonly kind: "http_error"; readonly status: number }
  | { readonly kind: "tls_trust"; readonly error: string }
  | { readonly kind: "network"; readonly error: string };

export type CdnDriftKind =
  | "none"
  | "byte_drift"
  | "sri_mismatch"
  | "tls_trust"
  | "http_error"
  | "unreachable";

export async function fetchAssetOutcome(url: string): Promise<FetchOutcome> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { kind: "http_error", status: res.status };
    return {
      kind: "ok",
      bytes: await res.bytes(),
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
    };
  } catch (error) {
    const message = String(error);
    const tlsLike =
      /certificate|cert|TLS|SSL|UNABLE_TO_VERIFY|unknown ca|self signed/i.test(
        message,
      );
    return tlsLike
      ? { kind: "tls_trust", error: message }
      : { kind: "network", error: message };
  }
}

async function digestBytes(
  algorithm: "SHA-256" | "SHA-384",
  bytes: Uint8Array,
): Promise<Uint8Array> {
  // Copy into an ArrayBuffer-backed view: `crypto.subtle.digest` refuses a view whose buffer
  // could be a SharedArrayBuffer.
  return new Uint8Array(
    await crypto.subtle.digest(algorithm, new Uint8Array(bytes)),
  );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return (await digestBytes("SHA-256", bytes)).toHex();
}

/** Subresource Integrity value for a byte string (`sha384-<base64>`). */
export async function sriFor(bytes: Uint8Array): Promise<string> {
  return `sha384-${(await digestBytes("SHA-384", bytes)).toBase64()}`;
}

export async function buildPin(
  url: string,
  outcome: Extract<FetchOutcome, { kind: "ok" }>,
  source: CdnAssetSource,
  now: string = new Date().toISOString(),
): Promise<CdnAssetPin> {
  const [sha256, sri] = await Promise.all([
    sha256Hex(outcome.bytes),
    sriFor(outcome.bytes),
  ]);
  const role = assetRole(url);
  const externalReferences =
    role === "portal-css"
      ? extractCssReferences(new TextDecoder().decode(outcome.bytes), url)
      : [];
  return {
    sha256,
    sri,
    sriEnforceable: !isSriIneligibleUrl(url),
    bytes: outcome.bytes.length,
    role,
    source,
    sameOrigin: source === "app",
    externalReferences,
    etag: outcome.etag,
    lastModified: outcome.lastModified,
    fetchedAt: now,
  };
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= items.length) return;
      next += 1;
      const item = items[index] as T;
      results[index] = await fn(item, index);
    }
  };
  const workers = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

const CdnAssetPinSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sri: z.string().regex(/^sha384-[A-Za-z0-9+/]+=*$/),
  sriEnforceable: z.boolean(),
  bytes: z.number().int().nonnegative(),
  role: z.enum(["portal-js", "portal-css", "telegram-web-app"]),
  source: z.enum(["document", "explicit", "app"]),
  sameOrigin: z.boolean(),
  externalReferences: z.array(z.string()),
  etag: z.string().nullable(),
  lastModified: z.string().nullable(),
  fetchedAt: z.string().min(1),
});

const CdnManifestSchema = z.object({
  schemaVersion: z.literal(1),
  host: z.string().min(1),
  documentUrl: z.string().min(1),
  pinnedAt: z.string().min(1),
  vendorVersion: z.string().min(1),
  assets: z.record(z.string(), CdnAssetPinSchema),
});

export function parseCdnManifest(value: unknown, source: string): CdnManifest {
  const parsed = CdnManifestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path =
      issue === undefined ? "<root>" : issue.path.join(".") || "<root>";
    throw new Error(
      `${source}: ${path} — ${issue?.message ?? "invalid manifest"}`,
    );
  }
  return {
    schemaVersion: 1,
    host: parsed.data.host,
    documentUrl: parsed.data.documentUrl,
    pinnedAt: parsed.data.pinnedAt,
    vendorVersion: parsed.data.vendorVersion,
    assets: parsed.data.assets,
  };
}

export async function loadCdnManifest(
  path: string = CDN_MANIFEST_PATH,
): Promise<CdnManifest> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `${path} missing — run \`bun run pin:cdn:update\` to pin the assets`,
    );
  }
  const value: unknown = await file.json();
  return parseCdnManifest(value, path);
}

export function serializeCdnManifest(manifest: CdnManifest): string {
  const assets: Record<string, CdnAssetPin> = {};
  for (const url of Object.keys(manifest.assets).sort()) {
    const pin = manifest.assets[url];
    if (pin !== undefined) assets[url] = pin;
  }
  return `${JSON.stringify({ ...manifest, assets }, null, 2)}\n`;
}

export function classifyCdnDrift(
  pin: CdnAssetPin,
  outcome: FetchOutcome,
): CdnDriftKind {
  if (outcome.kind === "ok") {
    return pin.bytes === outcome.bytes.length ? "none" : "byte_drift";
  }
  if (outcome.kind === "tls_trust") return "tls_trust";
  if (outcome.kind === "http_error") return "http_error";
  return "unreachable";
}

/**
 * Stylesheet-internal resources that moved: a font/background swap changes neither the CSS bytes
 * the page names nor the tag list, so it is compared separately.
 */
export function cssReferenceDrift(
  pin: CdnAssetPin,
  bytes: Uint8Array,
  url: string,
): string[] {
  if (pin.role !== "portal-css") return [];
  const live = extractCssReferences(new TextDecoder().decode(bytes), url);
  const pinned = pin.externalReferences;
  return [
    ...live.filter((ref) => !pinned.includes(ref)).map((ref) => `+${ref}`),
    ...pinned.filter((ref) => !live.includes(ref)).map((ref) => `-${ref}`),
  ];
}

export interface CdnCoverageReport {
  /** Loaded by the document but absent from the manifest. */
  readonly unpinned: readonly string[];
  /** Pinned as a document asset but no longer loaded. */
  readonly removed: readonly string[];
}

export function checkDocumentCoverage(
  html: string,
  manifest: CdnManifest,
): CdnCoverageReport {
  const live = new Set(
    extractExternalAssets(html).map((asset) => asset.normalizedUrl),
  );
  const pinned = new Set(
    Object.entries(manifest.assets)
      .filter(([, pin]) => pin.source === "document")
      .map(([url]) => url),
  );
  const unpinned = [...live].filter(
    (url) => manifest.assets[url] === undefined,
  );
  const removed = [...pinned].filter((url) => !live.has(url));
  return { unpinned: unpinned.sort(), removed: removed.sort() };
}

export function describeOutcome(outcome: FetchOutcome): string {
  switch (outcome.kind) {
    case "ok":
      return `${outcome.bytes.length} bytes`;
    case "http_error":
      return `HTTP ${outcome.status}`;
    case "tls_trust":
      return `TLS trust error: ${outcome.error}`;
    case "network":
      return `network error: ${outcome.error}`;
  }
}

/**
 * Every difference between the pinned manifest and what the live document loads, as signal-ready
 * strings. Used by the portal drift cron and `pin:cdn check`.
 */
export async function collectLiveCdnAssetDrift(options?: {
  readonly documentUrl?: string;
  readonly concurrency?: number;
}): Promise<string[]> {
  const manifest = await loadCdnManifest();
  const documentUrl = options?.documentUrl ?? manifest.documentUrl;
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const details: string[] = [];

  const documentOutcome = await fetchAssetOutcome(documentUrl);
  if (documentOutcome.kind === "ok") {
    const coverage = checkDocumentCoverage(
      new TextDecoder().decode(documentOutcome.bytes),
      manifest,
    );
    for (const url of coverage.unpinned) {
      details.push(`cdn_unpinned ${url}: loaded by ${documentUrl}`);
    }
    for (const url of coverage.removed) {
      details.push(`cdn_removed ${url}: pinned but no longer loaded`);
    }
  } else {
    details.push(
      `cdn_document_unreachable ${documentUrl}: ${describeOutcome(documentOutcome)}`,
    );
  }

  const rows = await mapConcurrent(
    Object.entries(manifest.assets),
    concurrency,
    async ([url, pin]) => ({
      url,
      pin,
      outcome: await fetchAssetOutcome(
        pinnedAssetFetchUrl(url, pin, manifest.vendorVersion),
      ),
    }),
  );

  const managerUrl = appModuleUrl(manifest.host, "manager/manager");
  const managerPin =
    managerUrl === null ? undefined : manifest.assets[managerUrl];
  if (managerUrl !== null && managerPin !== undefined) {
    const managerOutcome = await fetchAssetOutcome(
      pinnedAssetFetchUrl(managerUrl, managerPin, manifest.vendorVersion),
    );
    if (managerOutcome.kind === "ok") {
      for (const missing of appModuleCoverage(
        new TextDecoder().decode(managerOutcome.bytes),
        manifest,
      )) {
        details.push(
          `cdn_app_module_unpinned ${missing}: required but not pinned`,
        );
      }
    } else {
      details.push(
        `cdn_app_manager_unreachable ${managerUrl}: ${describeOutcome(managerOutcome)}`,
      );
    }
  }

  for (const { url, pin, outcome } of rows) {
    if (outcome.kind === "ok") {
      const liveSha256 = await sha256Hex(outcome.bytes);
      if (liveSha256 !== pin.sha256) {
        details.push(
          `cdn_byte_drift ${url}: live ${liveSha256} (${outcome.bytes.length}B) != pinned ${pin.sha256} (${pin.bytes}B)`,
        );
        continue;
      }
      if ((await sriFor(outcome.bytes)) !== pin.sri) {
        details.push(
          `cdn_sri_mismatch ${url}: manifest sri does not match bytes`,
        );
      }
      continue;
    }
    details.push(
      `cdn_${classifyCdnDrift(pin, outcome)} ${url}: ${describeOutcome(outcome)}`,
    );
  }

  return details;
}
