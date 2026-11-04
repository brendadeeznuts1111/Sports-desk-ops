#!/usr/bin/env bun
/**
 * Pin, or verify, the external assets a portal document loads.
 *
 *   bun run pin:cdn            # fetch live bytes; exit 1 on drift, 2 on an unreachable origin
 *   bun run pin:cdn:update --vendor-version <version> [--force]
 *
 * The asset set is discovered from the live document, not a hand-written list: a new `<script>`
 * on the portal is unpinned until someone reviews it, and a removed one is reported as stale.
 * Only the bytes are trusted; `ETag`/`Last-Modified` come from a mutable origin and a heuristically
 * cached copy can outlive a fix.
 *
 * `update` is a human action, never CI. It prints the per-asset diff, requires the vendor release
 * the pins belong to, and refuses to bless a byte change that does not come with a version bump —
 * a silent swap and a release look identical to a hash, so the version is the human's assertion
 * that the change matches the vendor's changelog. See `docs/runbooks/cdn-pin-update.md`.
 */

import { parseArgs } from "node:util";

import { extractExternalAssets } from "../lib/f402_cdn_assets.ts";
import {
  missingExternalViewGuardAnchors,
  missingModuleSinkAnchors,
} from "../lib/f402_client_seams.ts";
import {
  appModuleCoverage,
  appModuleUrl,
  APP_BOOT_MODULES,
  buildPin,
  CDN_MANIFEST_PATH,
  checkDocumentCoverage,
  cssReferenceDrift,
  describeOutcome,
  EXPLICIT_CDN_ASSETS,
  fetchAssetOutcome,
  extractAmdModuleIds,
  loadCdnManifest,
  mapConcurrent,
  pinnedAssetFetchUrl,
  PORTAL_DOCUMENT_URL,
  serializeCdnManifest,
  sha256Hex,
  sriFor,
} from "../lib/f402_cdn_pin.ts";
import type { CdnAssetPin, CdnManifest } from "../lib/f402_cdn_pin.ts";

const CONCURRENCY = 8;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    "vendor-version": { type: "string" },
    force: { type: "boolean", default: false },
  },
});

const mode = positionals[0] ?? "check";
const vendorVersion =
  typeof values["vendor-version"] === "string"
    ? values["vendor-version"].trim()
    : "";
const force = values.force === true;

if (mode !== "check" && mode !== "update") {
  console.error(
    "usage: bun scripts/pin_cdn_assets.ts check|update [--vendor-version <v>] [--force]",
  );
  process.exit(2);
}

interface AssetChange {
  readonly kind: "added" | "removed" | "changed";
  readonly url: string;
  readonly detail: string;
}

function diffManifests(
  previous: CdnManifest | null,
  next: CdnManifest,
): AssetChange[] {
  const changes: AssetChange[] = [];
  const previousAssets = previous?.assets ?? {};

  for (const url of Object.keys(next.assets)) {
    const before = previousAssets[url];
    const after = next.assets[url];
    if (after === undefined) continue;
    if (before === undefined) {
      changes.push({ kind: "added", url, detail: `${after.bytes}B` });
      continue;
    }
    if (before.sha256 !== after.sha256) {
      changes.push({
        kind: "changed",
        url,
        detail: `sha256 ${before.sha256.slice(0, 12)}… -> ${after.sha256.slice(0, 12)}… (${after.bytes}B)`,
      });
      continue;
    }
    if (
      before.externalReferences.join("\n") !==
      after.externalReferences.join("\n")
    ) {
      changes.push({
        kind: "changed",
        url,
        detail: "stylesheet url()/@import references moved",
      });
    }
  }

  for (const url of Object.keys(previousAssets)) {
    if (next.assets[url] === undefined) {
      changes.push({ kind: "removed", url, detail: "" });
    }
  }

  return changes;
}

function printChanges(changes: readonly AssetChange[]): void {
  for (const change of changes) {
    const marker =
      change.kind === "added" ? "+" : change.kind === "removed" ? "-" : "~";
    const detail = change.detail === "" ? "" : ` (${change.detail})`;
    console.log(`  ${marker} ${change.url}${detail}`);
  }
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
  if (vendorVersion === "") {
    console.error(
      "pin:cdn:update requires --vendor-version <version> — the vendor release these pins belong to",
    );
    process.exit(2);
  }

  const host = new URL(PORTAL_DOCUMENT_URL).host;
  const html = await fetchDocumentHtml();
  const documentUrls = [
    ...new Set(extractExternalAssets(html).map((asset) => asset.normalizedUrl)),
  ].sort();

  // Phase 1: the controller, fetched the way the AMD loader would fetch it, so its require list
  // can be discovered from the bytes that are live for this vendor version.
  const managerUrl = appModuleUrl(host, "manager/manager");
  if (managerUrl === null)
    throw new Error("manager/manager is not a valid app module");
  const managerOutcome = await fetchAssetOutcome(
    `${managerUrl}?bust=${encodeURIComponent(vendorVersion)}`,
  );
  if (managerOutcome.kind !== "ok") {
    throw new Error(`manager/manager: ${describeOutcome(managerOutcome)}`);
  }
  const managerJs = new TextDecoder().decode(managerOutcome.bytes);
  const missingAnchors = missingExternalViewGuardAnchors(managerJs);
  if (missingAnchors.length > 0) {
    console.error(
      `pin:cdn:update refuses to pin manager/manager.js — the external-view guard anchors moved: ${missingAnchors.join(", ")}. Update the client overlay and its tests first, then re-run.`,
    );
    process.exit(2);
  }

  const appUrls = [
    ...new Set(
      [...APP_BOOT_MODULES, ...extractAmdModuleIds(managerJs)]
        .map((id) => appModuleUrl(host, id))
        .filter((url): url is string => url !== null),
    ),
  ].sort();
  const appUrlSet = new Set(appUrls);

  // Phase 2: pin everything. Each asset records whether it came from the document, the explicit
  // list, or the same-origin AMD graph.
  const allUrls = [
    ...new Set([...documentUrls, ...EXPLICIT_CDN_ASSETS, ...appUrls]),
  ];
  const fetched = await mapConcurrent(allUrls, CONCURRENCY, async (url) => {
    const isApp = appUrlSet.has(url);
    const fetchUrl = isApp
      ? `${url}?bust=${encodeURIComponent(vendorVersion)}`
      : url;
    const outcome = await fetchAssetOutcome(fetchUrl);
    if (outcome.kind !== "ok") {
      throw new Error(`${url}: ${describeOutcome(outcome)}`);
    }
    const source = isApp
      ? "app"
      : documentUrls.includes(url)
        ? "document"
        : "explicit";
    return { url, pin: await buildPin(url, outcome, source) };
  });

  const assets: Record<string, CdnAssetPin> = {};
  for (const { url, pin } of fetched) assets[url] = pin;

  const next: CdnManifest = {
    schemaVersion: 1,
    host,
    documentUrl: PORTAL_DOCUMENT_URL,
    pinnedAt: new Date().toISOString(),
    vendorVersion,
    assets,
  };

  let previous: CdnManifest | null = null;
  try {
    previous = await loadCdnManifest();
  } catch {
    previous = null;
  }

  const changes = diffManifests(previous, next);
  if (changes.length > 0) {
    console.log(
      `pin:cdn:update ${previous?.vendorVersion ?? "(none)"} -> ${vendorVersion}`,
    );
    printChanges(changes);
  }

  if (
    previous !== null &&
    previous.vendorVersion === vendorVersion &&
    changes.length > 0 &&
    !force
  ) {
    console.error(
      "pin:cdn: asset bytes changed without a vendor version bump — treat as an incident, not a pin update.",
    );
    console.error(
      "  Verify the change against the vendor's release notes. If confirmed, rerun with --force and say so in the commit message.",
    );
    process.exit(1);
  }

  if (
    previous !== null &&
    changes.length === 0 &&
    previous.vendorVersion === vendorVersion
  ) {
    console.log("pin:cdn: no asset changes; manifest unchanged");
    return;
  }

  await Bun.write(CDN_MANIFEST_PATH, serializeCdnManifest(next));
  console.log(
    `pin:cdn: pinned ${fetched.length} asset(s) at vendor ${vendorVersion} → ${CDN_MANIFEST_PATH}`,
  );
  console.log(
    `  ${documentUrls.length} from the document, ${EXPLICIT_CDN_ASSETS.length} explicit, ${appUrls.length} app module(s)`,
  );
  if (previous !== null && previous.vendorVersion !== vendorVersion) {
    console.log(
      `  vendor version ${previous.vendorVersion} -> ${vendorVersion}: record this delta in the commit message`,
    );
  }
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
      outcome: await fetchAssetOutcome(
        pinnedAssetFetchUrl(url, pin, manifest.vendorVersion),
      ),
    }),
  );

  let managerRow: (typeof rows)[number] | undefined;
  const managerUrl = appModuleUrl(manifest.host, "manager/manager");
  if (managerUrl !== null) {
    managerRow = rows.find((row) => row.url === managerUrl);
    if (managerRow === undefined) {
      driftCount += 1;
      details.push(
        `unpinned ${managerUrl}: controller module not in the manifest`,
      );
    }
  }

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
        continue;
      }
      const referenceDrift = cssReferenceDrift(pin, outcome.bytes, url);
      if (referenceDrift.length > 0) {
        driftCount += 1;
        details.push(
          `css_reference_drift ${url}: ${referenceDrift.join(", ")}`,
        );
      }
      const sinkAnchors = missingModuleSinkAnchors(
        url,
        new TextDecoder().decode(outcome.bytes),
      );
      if (sinkAnchors.length > 0) {
        driftCount += 1;
        details.push(
          `module_sink_anchor_missing ${url}: ${sinkAnchors.join(", ")} — the overlay wrapper is inert`,
        );
      }
      continue;
    }
    infrastructureCount += 1;
    details.push(`${outcome.kind} ${url}: ${describeOutcome(outcome)}`);
  }

  if (managerUrl !== null && managerRow?.outcome.kind === "ok") {
    const managerJs = new TextDecoder().decode(managerRow.outcome.bytes);
    for (const missing of appModuleCoverage(managerJs, manifest)) {
      driftCount += 1;
      details.push(
        `app_module_unpinned ${missing}: required by the controller but not pinned`,
      );
    }
    for (const anchor of missingExternalViewGuardAnchors(managerJs)) {
      driftCount += 1;
      details.push(
        `guard_anchor_missing ${anchor}: manager.js no longer contains the external-view target; the wrapper is inert`,
      );
    }
  }

  if (details.length > 0) {
    console.error(
      JSON.stringify({
        signal: "CDN_ASSET_DRIFT",
        documentUrl: manifest.documentUrl,
        vendorVersion: manifest.vendorVersion,
        details,
      }),
    );
    for (const detail of details) console.error(`  ${detail}`);
    process.exit(driftCount > 0 ? 1 : 2);
  }

  console.log(
    `pin:cdn: ok — ${Object.keys(manifest.assets).length} asset(s) match ${CDN_MANIFEST_PATH} (vendor ${manifest.vendorVersion})`,
  );
}

if (mode === "update") {
  await update();
} else {
  await check();
}
