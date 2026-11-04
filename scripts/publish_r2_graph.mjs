#!/usr/bin/env bun
/**
 * @file publish_r2_graph.mjs
 * @description Publish the docs portal and rich-metadata pipeline assets to the
 * public Cloudflare R2 edge, using the shared Bun.S3Client adapter
 * (lib/r2_s3_client.ts) for credential resolution, presigned metadata uploads and
 * object writes. `--list-json` prints the manifest without requiring credentials so
 * bin/dx can fall back to Wrangler OAuth uploads.
 */
import path from "node:path";

import {
  R2S3Client,
  resolveR2S3Options,
  sha256Hex,
} from "../lib/r2_s3_client.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const listJson = process.argv.includes("--list-json");

const filesToPublish = [
  {
    file: "dist/graph.html",
    key: "graph.html",
    type: "text/html; charset=utf-8",
    meta: {
      surface: "6-tab-surveillance-and-10-mode-portal",
      modes: "1-2-3-4-5-6-7-8-9-10",
    },
  },
  {
    file: "dist/graph.js",
    key: "graph.js",
    type: "application/javascript; charset=utf-8",
    meta: { surface: "graph-controller" },
  },
  {
    file: "dist/gslive-links.js",
    key: "gslive-links.js",
    type: "application/javascript; charset=utf-8",
    meta: { surface: "gslive-link-hydration" },
  },
  {
    file: "dist/graph-live-feed.json",
    key: "graph-live-feed.json",
    type: "application/json; charset=utf-8",
    meta: { surface: "live-feed-and-10-mode-snapshot" },
  },
  {
    file: "dist/backtest-4wk-cfb-nba.json",
    key: "backtest-4wk-cfb-nba.json",
    type: "application/json; charset=utf-8",
    meta: { surface: "4wk-cfb-nba-parlay-backtest" },
  },
  {
    file: "dist/combo-uniqueness.json",
    key: "combo-uniqueness.json",
    type: "application/json; charset=utf-8",
    meta: {
      surface: "cfb-combo-gate-artifact",
      gates: "permissive,all-legs-cfb,full-game",
    },
  },
  {
    file: "dist/cross-domain-bridge.json",
    key: "cross-domain-bridge.json",
    type: "application/json; charset=utf-8",
    meta: {
      surface: "customer-polymarket-bridge-artifact",
      evidence: "live-or-fixture",
    },
  },
  {
    file: "dist/index.html",
    key: "index.html",
    type: "text/html; charset=utf-8",
    meta: { surface: "scalar-openapi-portal" },
  },
  {
    file: "dist/openapi.json",
    key: "openapi.json",
    type: "application/json; charset=utf-8",
    meta: { surface: "openapi-3-1-spec" },
  },
  {
    file: "dist/api-reference.md",
    key: "api-reference.md",
    type: "text/markdown; charset=utf-8",
    meta: {
      surface: "generated-api-reference",
      includes: "gslive-operator-deep-links",
    },
  },
  {
    file: "dist/assets/pipeline-artifacts-metadata.json",
    key: "assets/pipeline-artifacts-metadata.json",
    type: "application/json; charset=utf-8",
    meta: {
      artifact: "pipeline-metadata-catalog",
      standards: "XMP-RDF-DublinCore-SchemaOrg-PNG-iTXt",
    },
  },
  {
    file: "dist/assets/pipeline-10-mode-architecture.svg",
    key: "assets/pipeline-10-mode-architecture.svg",
    type: "image/svg+xml; charset=utf-8",
    meta: {
      artifact: "SD-ARTIFACT-01-10MODE-PIPELINE",
      modes: "1,2,3,4,5,6,7,8,9,10",
      cli: "./bin/dx modes",
    },
  },
  {
    file: "dist/assets/pipeline-10-mode-architecture.png",
    key: "assets/pipeline-10-mode-architecture.png",
    type: "image/png",
    meta: {
      artifact: "SD-ARTIFACT-01-10MODE-PIPELINE",
      modes: "1,2,3,4,5,6,7,8,9,10",
      cli: "./bin/dx modes",
      metadata: "tEXt+iTXt+XMP+JSON-LD",
    },
  },
  {
    file: "dist/assets/pipeline-10-mode-architecture.webp",
    key: "assets/pipeline-10-mode-architecture.webp",
    type: "image/webp",
    meta: {
      artifact: "SD-ARTIFACT-01-10MODE-PIPELINE",
      modes: "1,2,3,4,5,6,7,8,9,10",
      metadata: "none (raster sibling)",
    },
  },
  {
    file: "dist/assets/pipeline-6-layer-data-cleaning.svg",
    key: "assets/pipeline-6-layer-data-cleaning.svg",
    type: "image/svg+xml; charset=utf-8",
    meta: {
      artifact: "SD-ARTIFACT-02-6LAYER-CLEANING",
      modules: "report.js,help-report.js,bet-ticker.js,ip-tracker.js",
    },
  },
  {
    file: "dist/assets/pipeline-6-layer-data-cleaning.png",
    key: "assets/pipeline-6-layer-data-cleaning.png",
    type: "image/png",
    meta: {
      artifact: "SD-ARTIFACT-02-6LAYER-CLEANING",
      modules: "report.js,help-report.js,bet-ticker.js,ip-tracker.js",
      metadata: "tEXt+iTXt+XMP+JSON-LD",
    },
  },
  {
    file: "dist/assets/pipeline-6-layer-data-cleaning.webp",
    key: "assets/pipeline-6-layer-data-cleaning.webp",
    type: "image/webp",
    meta: {
      artifact: "SD-ARTIFACT-02-6LAYER-CLEANING",
      modules: "report.js,help-report.js,bet-ticker.js,ip-tracker.js",
      metadata: "none (raster sibling)",
    },
  },
  {
    file: "dist/assets/pipeline-per-office-ip-and-reconciliation.svg",
    key: "assets/pipeline-per-office-ip-and-reconciliation.svg",
    type: "image/svg+xml; charset=utf-8",
    meta: {
      artifact: "SD-ARTIFACT-03-IP-AND-RECONCILIATION",
      modes: "1,2,3,4,5,6,8,9,10",
      cli: "./bin/dx iptracker",
    },
  },
  {
    file: "dist/assets/pipeline-per-office-ip-and-reconciliation.png",
    key: "assets/pipeline-per-office-ip-and-reconciliation.png",
    type: "image/png",
    meta: {
      artifact: "SD-ARTIFACT-03-IP-AND-RECONCILIATION",
      modes: "1,2,3,4,5,6,8,9,10",
      cli: "./bin/dx iptracker",
      metadata: "tEXt+iTXt+XMP+JSON-LD",
    },
  },
  {
    file: "dist/assets/pipeline-per-office-ip-and-reconciliation.webp",
    key: "assets/pipeline-per-office-ip-and-reconciliation.webp",
    type: "image/webp",
    meta: {
      artifact: "SD-ARTIFACT-03-IP-AND-RECONCILIATION",
      modes: "1,2,3,4,5,6,8,9,10",
      metadata: "none (raster sibling)",
    },
  },
  {
    file: "dist/assets/pipeline-dual-surface-gslive-model.svg",
    key: "assets/pipeline-dual-surface-gslive-model.svg",
    type: "image/svg+xml; charset=utf-8",
    meta: {
      artifact: "SD-ARTIFACT-04-DUAL-SURFACE-GSLIVE",
      surfaces: "#/reports/users,#/events/bet-history",
      deskDay: "America/Chicago",
    },
  },
  {
    file: "dist/assets/pipeline-dual-surface-gslive-model.png",
    key: "assets/pipeline-dual-surface-gslive-model.png",
    type: "image/png",
    meta: {
      artifact: "SD-ARTIFACT-04-DUAL-SURFACE-GSLIVE",
      surfaces: "#/reports/users,#/events/bet-history",
      metadata: "tEXt+iTXt+XMP+JSON-LD",
    },
  },
  {
    file: "dist/assets/pipeline-dual-surface-gslive-model.webp",
    key: "assets/pipeline-dual-surface-gslive-model.webp",
    type: "image/webp",
    meta: {
      artifact: "SD-ARTIFACT-04-DUAL-SURFACE-GSLIVE",
      surfaces: "#/reports/users,#/events/bet-history",
      metadata: "none (raster sibling)",
    },
  },
  {
    file: "dist/assets/ARCH-Guide.jpg",
    key: "assets/ARCH-Guide.jpg",
    type: "image/jpeg",
    meta: { artifact: "ARCH-GUIDE-BASELINE", modes: "1,2,3,4,5,6,7,8,9,10" },
  },
];

const resolved = resolveR2S3Options(Bun.env);
const bucket =
  resolved?.bucket ?? Bun.env.R2_BUCKET_NAME ?? "sportsdesk-ops-reports";
const publicBase =
  resolved?.publicBase ??
  Bun.env.R2_PUBLIC_URL ??
  "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev";

if (listJson) {
  console.log(
    JSON.stringify({
      bucket,
      publicBase,
      files: filesToPublish.map(({ file, key, type, meta }) => ({
        file,
        key,
        type,
        metadataKeys: meta ? Object.keys(meta) : [],
      })),
    }),
  );
  process.exit(0);
}

if (resolved === null) {
  console.error(
    "publish_r2_graph: no S3/R2 credentials (R2_*, S3_*, AWS_* or CLOUDFLARE_R2_TOKEN_ID + CLOUDFLARE_R2_API_TOKEN)",
  );
  process.exit(2);
}

const client = R2S3Client.fromOptions(resolved);

console.log(
  "================================================================================",
);
console.log(
  "  ☁️  PUBLISHING SURVEILLANCE GRAPH, LIVE FEED & RICH-METADATA IMAGES TO R2 EDGE",
);
console.log(
  "================================================================================",
);

for (const item of filesToPublish) {
  const file = Bun.file(path.join(repoRoot, item.file));
  if (!(await file.exists())) continue;
  const bytes = await file.bytes();
  await client.writeWithMetadata(item.key, bytes, {
    type: item.type,
    metadata: item.meta ?? {},
  });
  const stored = await client.stat(item.key);
  if (stored.size !== bytes.length) {
    throw new Error(
      `R2 stat mismatch for ${item.key}: wrote ${bytes.length}, stat ${stored.size}`,
    );
  }
  console.log(
    `  ✓ Published ${item.key.padEnd(46)} (${String(bytes.length).padStart(7)} B | sha256 ${new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 12)}…) -> ${publicBase}/${item.key}`,
  );
}

const verifyRes = await fetch(`${publicBase}/graph.html`);
const verifyBytes = new Uint8Array(await verifyRes.arrayBuffer());
const feedRes = await fetch(`${publicBase}/graph-live-feed.json`);
const feedJson = await feedRes.json();
const metaRes = await fetch(
  `${publicBase}/assets/pipeline-artifacts-metadata.json`,
);
console.log(
  "--------------------------------------------------------------------------------",
);
console.log(
  `  🌐 LIVE EDGE VERIFICATION:\n` +
    `    • GET ${publicBase}/graph.html                                -> HTTP ${verifyRes.status} (${verifyBytes.length} B)\n` +
    `    • GET ${publicBase}/graph-live-feed.json                      -> HTTP ${feedRes.status} (Last Updated: ${feedJson.lastUpdatedCdt})\n` +
    `    • GET ${publicBase}/assets/pipeline-artifacts-metadata.json   -> HTTP ${metaRes.status}`,
);
console.log(
  "================================================================================",
);
