#!/usr/bin/env node
/**
 * @file scripts/publish_r2_graph.mjs
 * @description Zero-dependency AWS SigV4 uploader for Cloudflare R2 Object Storage.
 * Publishes `dist/graph.html`, `dist/graph.js`, `dist/gslive-links.js`, `dist/graph-live-feed.json`, `dist/index.html`,
 * `dist/openapi.json`, and all rich-metadata pipeline visual reference artifacts under `dist/assets/`
 * (with custom `x-amz-meta-*` headers) directly to the public Cloudflare R2 edge domain
 * (`https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/`).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const envPath = path.join(repoRoot, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(
      `publish_r2_graph: ${name} is required (set it in .env or the environment)`,
    );
    process.exit(2);
  }
  return value;
}

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

const listJson = process.argv.includes("--list-json");
if (listJson) {
  console.log(
    JSON.stringify({
      bucket: process.env.R2_BUCKET_NAME || "sportsdesk-ops-reports",
      publicBase:
        process.env.R2_PUBLIC_URL ||
        "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev",
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

const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const bucket = process.env.R2_BUCKET_NAME || "sportsdesk-ops-reports";
const publicBase =
  process.env.R2_PUBLIC_URL ||
  "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev";
const host = `${accountId}.r2.cloudflarestorage.com`;
const region = "auto";
const service = "s3";

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = hmac(`AWS4${key}`, dateStamp);
  const kRegion = hmac(kDate, regionName);
  const kService = hmac(kRegion, serviceName);
  return hmac(kService, "aws4_request");
}

async function putObject(key, bodyBuf, contentType, customMeta = {}) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(bodyBuf);
  const canonicalUri = `/${bucket}/${key}`;

  const headerMap = {
    "content-type": contentType,
    host: host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  for (const [k, v] of Object.entries(customMeta)) {
    if (v) {
      headerMap[`x-amz-meta-${k.toLowerCase()}`] = String(v)
        .replace(/[\r\n]+/g, " ")
        .trim();
    }
  }

  const sortedHeaderKeys = Object.keys(headerMap).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${headerMap[k]}\n`)
    .join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = getSignatureKey(
    secretAccessKey,
    dateStamp,
    region,
    service,
  );
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");

  const authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${host}${canonicalUri}`;
  const fetchHeaders = { Authorization: authorization };
  for (const k of sortedHeaderKeys) {
    if (k !== "host") fetchHeaders[k] = headerMap[k];
  }

  const res = await fetch(url, {
    method: "PUT",
    headers: fetchHeaders,
    body: bodyBuf,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 PUT ${key} failed (${res.status}): ${text}`);
  }
  return `${publicBase}/${key}`;
}

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
  const fullPath = path.join(repoRoot, item.file);
  if (!fs.existsSync(fullPath)) continue;
  const buf = fs.readFileSync(fullPath);
  const url = await putObject(item.key, buf, item.type, item.meta || {});
  console.log(
    `  ✓ Published ${item.key.padEnd(46)} (${String(buf.length).padStart(7)} B | sha256 ${sha256Hex(buf).slice(0, 12)}…) -> ${url}`,
  );
}

// Verify live HTTP 200 on the public R2 edge URL
const verifyRes = await fetch(`${publicBase}/graph.html`);
const verifyBytes = Buffer.from(await verifyRes.arrayBuffer());
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
