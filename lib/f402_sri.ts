/**
 * Offline Subresource Integrity enforcement for documents this repository owns or reviews.
 *
 * `findSriIssues` is the gate: every external asset must be pinned, every SRI-eligible tag must
 * carry the manifest's `integrity=` and `crossorigin="anonymous"`, and a tag whose origin sends no
 * ACAO must not carry `integrity=` (the browser would block the asset).
 *
 * `applySriToHtml` is the build step: rewrite a document from the manifest so the two cannot drift
 * apart. It is used for our own pages and to generate the patch the vendor would apply; the live
 * `manager.html` is served by the vendor, so this repo cannot rewrite it in place.
 */

import { extractExternalAssets } from "./f402_cdn_assets.ts";
import type { CdnManifest } from "./f402_cdn_pin.ts";

export interface SriIssue {
  readonly line: number;
  readonly url: string;
  readonly message: string;
}

const INTEGRITY_ATTR_RE = /\bintegrity\s*=\s*["']([^"']*)["']/i;
const CROSSORIGIN_ATTR_RE =
  /\bcrossorigin\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

function crossOriginValue(tag: string): string | null {
  const match = CROSSORIGIN_ATTR_RE.exec(tag);
  if (match === null) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

/** Every reason a document's external tags are not covered by the pinned manifest. */
export function findSriIssues(html: string, manifest: CdnManifest): SriIssue[] {
  const issues: SriIssue[] = [];

  for (const asset of extractExternalAssets(html)) {
    const pin = manifest.assets[asset.normalizedUrl];
    if (pin === undefined) {
      issues.push({
        line: asset.line,
        url: asset.normalizedUrl,
        message:
          "external asset is not pinned in cdn-manifest.json — review and run `bun run pin:cdn:update`",
      });
      continue;
    }

    // Browsers do not consult SRI for rel="stylesheet/less": less.js fetches it over XHR and
    // compiles it, so pin coverage is the only control until the vendor precompiles to .css.
    if (asset.kind === "stylesheet-less") continue;

    if (!pin.sriEnforceable) {
      if (INTEGRITY_ATTR_RE.test(asset.tag)) {
        issues.push({
          line: asset.line,
          url: asset.normalizedUrl,
          message:
            "integrity= is set on an asset whose origin sends no Access-Control-Allow-Origin; the browser will block it",
        });
      }
      continue;
    }

    const integrity = INTEGRITY_ATTR_RE.exec(asset.tag)?.[1];
    if (integrity === undefined) {
      issues.push({
        line: asset.line,
        url: asset.normalizedUrl,
        message: `missing integrity= — expected ${pin.sri}`,
      });
      continue;
    }
    if (integrity !== pin.sri) {
      issues.push({
        line: asset.line,
        url: asset.normalizedUrl,
        message: `integrity= does not match the pinned bytes (expected ${pin.sri})`,
      });
    }
    if (crossOriginValue(asset.tag)?.toLowerCase() !== "anonymous") {
      issues.push({
        line: asset.line,
        url: asset.normalizedUrl,
        message:
          'missing crossorigin="anonymous" (required for SRI on a cross-origin asset)',
      });
    }
  }

  return issues;
}

export interface SriApplyResult {
  readonly html: string;
  readonly applied: readonly string[];
  readonly skipped: readonly {
    readonly url: string;
    readonly reason: string;
  }[];
}

function withSri(tag: string, sri: string): string {
  const stripped = tag
    .replace(/\s+integrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+crossorigin\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+$/, "");
  const close = stripped.endsWith("/>") ? "/>" : ">";
  const body = stripped.slice(0, -close.length).replace(/\s+$/, "");
  return `${body} integrity="${sri}" crossorigin="anonymous"${close}`;
}

/** Rewrite every SRI-eligible external tag from the manifest; never invent a hash. */
export function applySriToHtml(
  html: string,
  manifest: CdnManifest,
): SriApplyResult {
  const assets = extractExternalAssets(html, { dedupe: false });
  const applied: string[] = [];
  const skipped: { url: string; reason: string }[] = [];
  let out = "";
  let cursor = 0;

  for (const asset of assets) {
    out += html.slice(cursor, asset.index);
    cursor = asset.index + asset.tag.length;

    const pin = manifest.assets[asset.normalizedUrl];
    if (pin === undefined) {
      skipped.push({ url: asset.normalizedUrl, reason: "not pinned" });
      out += asset.tag;
      continue;
    }
    if (asset.kind === "stylesheet-less") {
      skipped.push({
        url: asset.normalizedUrl,
        reason: "SRI is not honoured on rel=stylesheet/less",
      });
      out += asset.tag;
      continue;
    }
    if (!pin.sriEnforceable) {
      skipped.push({
        url: asset.normalizedUrl,
        reason: "origin sends no Access-Control-Allow-Origin",
      });
      out += asset.tag;
      continue;
    }
    out += withSri(asset.tag, pin.sri);
    applied.push(asset.normalizedUrl);
  }

  out += html.slice(cursor);
  return { html: out, applied, skipped };
}
