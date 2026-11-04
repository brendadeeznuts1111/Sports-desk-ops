#!/usr/bin/env bun
/**
 * Pin, or verify, the external assets a portal document loads.
 *
 *   bun run pin:cdn            # fetch live bytes; exit 1 on drift, 2 on an unreachable origin
 *   bun run pin:cdn:update     # recompute the manifest (human action; review the diff)
 *
 * The asset set is discovered from the live document, not a hand-written list: a new `<script>`
 * on the portal is unpinned until someone reviews it, and a removed one is reported as stale.
 * Only the bytes are trusted; `ETag`/`Last-Modified` come from a mutable origin and a heuristically
 * cached copy can outlive a fix.
 */

import { parseArgs } from "node:util";

import {
  buildPin,
  CDN_MANIFEST_PATH,
  checkDocumentCoverage,
  describeOutcome,
  EXPLICIT_CDN_ASSETS,
  fetchAssetOutcome,
  loadCdnManifest,
  mapConcurrent,
  PORTAL_DOCUMENT_URL,
  serializeCdnManifest,
  sha256Hex,
  sriFor,
} from "../lib/f402_cdn_pin.ts";
import type { CdnAssetPin, CdnManifest } from "../lib/f402_cdn_pin.ts";
import { extractExternalAssets } from "../lib/f402_cdn_assets.ts";

const CONCURRENCY = 8;
const { positionals } = parseArgs({ allowPositionals: true, strict: false });
const mode = positionals[0] ?? "check";

if (mode !== "check" && mode !== "update") {
  console.error("usage: bun scripts/pin_cdn_assets.ts check|update");
  process.exit(2);
}

async function fetchDocumentHtml(): Promise<string> {
  const outcome = await fetchAssetOutcome(PORTAL_DOCUMENT_URL);
  if (outcome.kind !== "ok") {
    console.error(
      `pin:cdn: ${PORTAL_DOCUMENT_URL} unavailable — ${describeOutcome(outcome)}`,
    );
    process.exit(2);
  }
  return new TextDecoder().decode(outcome.bytes);
}

async function update(): Promise<void> {
  const html = await fetchDocumentHtml();
  const documentUrls = [
    ...new Set(extractExternalAssets(html).map((asset) => asset.normalizedUrl)),
  ].sort();
  const allUrls = [...new Set([...documentUrls, ...EXPLICIT_CDN_ASSETS])];

  const fetched = await mapConcurrent(allUrls, CONCURRENCY, async (url) => {
    const outcome = await fetchAssetOutcome(url);
    if (outcome.kind !== "ok") {
      throw new Error(`${url}: ${describeOutcome(outcome)}`);
    }
    const source = documentUrls.includes(url) ? "document" : "explicit";
    return { url, pin: await buildPin(url, outcome, source) };
  });

  const assets: Record<string, CdnAssetPin> = {};
  for (const { url, pin } of fetched) assets[url] = pin;

  const manifest: CdnManifest = {
    schemaVersion: 1,
    host: new URL(PORTAL_DOCUMENT_URL).host,
    documentUrl: PORTAL_DOCUMENT_URL,
    pinnedAt: new Date().toISOString(),
    assets,
  };

  await Bun.write(CDN_MANIFEST_PATH, serializeCdnManifest(manifest));
  console.log(
    `pin:cdn: pinned ${fetched.length} asset(s) → ${CDN_MANIFEST_PATH}`,
  );
  console.log(
    `  ${documentUrls.length} loaded by ${PORTAL_DOCUMENT_URL}, ${EXPLICIT_CDN_ASSETS.length} explicit`,
  );
  console.log(
    "  review the diff; a changed hash without a vendor version bump is an incident",
  );
}

async function check(): Promise<void> {
  const manifest = await loadCdnManifest();
  const html = await fetchDocumentHtml();
  const coverage = checkDocumentCoverage(html, manifest);
  const details: string[] = [];
  let driftCount = 0;
  let infrastructureCount = 0;

  for (const url of coverage.unpinned) {
    driftCount += 1;
    details.push(
      `unpinned ${url}: loaded by ${manifest.documentUrl}, absent from cdn-manifest.json`,
    );
  }
  for (const url of coverage.removed) {
    driftCount += 1;
    details.push(`removed ${url}: pinned but no longer loaded by the document`);
  }

  const rows = await mapConcurrent(
    Object.entries(manifest.assets),
    CONCURRENCY,
    async ([url, pin]) => ({
      url,
      pin,
      outcome: await fetchAssetOutcome(url),
    }),
  );

  for (const { url, pin, outcome } of rows) {
    if (outcome.kind === "ok") {
      const liveSha256 = await sha256Hex(outcome.bytes);
      if (liveSha256 !== pin.sha256) {
        driftCount += 1;
        details.push(
          `byte_drift ${url}: live ${liveSha256} (${outcome.bytes.length}B) != pinned ${pin.sha256} (${pin.bytes}B)`,
        );
        continue;
      }
      if ((await sriFor(outcome.bytes)) !== pin.sri) {
        driftCount += 1;
        details.push(
          `sri_mismatch ${url}: manifest sri is not the sri of the pinned bytes`,
        );
      }
      continue;
    }
    infrastructureCount += 1;
    details.push(`${outcome.kind} ${url}: ${describeOutcome(outcome)}`);
  }

  if (details.length > 0) {
    console.error(
      JSON.stringify({
        signal: "CDN_ASSET_DRIFT",
        documentUrl: manifest.documentUrl,
        details,
      }),
    );
    for (const detail of details) console.error(`  ${detail}`);
    process.exit(driftCount > 0 ? 1 : 2);
  }

  console.log(
    `pin:cdn: ok — ${Object.keys(manifest.assets).length} asset(s) match ${CDN_MANIFEST_PATH}`,
  );
}

if (mode === "update") {
  await update();
} else {
  await check();
}
