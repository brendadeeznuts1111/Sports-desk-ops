#!/usr/bin/env bun
/**
 * @file scripts/r2_verify.ts
 * @description Verify an R2 upload against the local files, using Bun.S3Client.
 *
 *   bun run r2:verify:local --prefix reports/
 *
 * Size is the check that matters: it catches a truncated upload without downloading the object.
 * Note what this does *not* cover: the docs artifacts deploy through Cloudflare Pages, not R2, so
 * they are verified by the deploy gate rather than here.
 */

import { Glob } from "bun";

import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";

const HELP = `
r2:verify:local — compare local files with the objects uploaded to R2

Options:
  --prefix <path>    Local directory to verify (default: dist/, the published set)
  --bucket <name>    Bucket (default: R2_BUCKET_NAME or sportsdesk-ops-reports)
  --strict           Fail when a local file is missing from the bucket (default: report only)
  -h, --help         This text

Environment:
  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_ENDPOINT or CLOUDFLARE_ACCOUNT_ID
  (the endpoint is derived from the account id when R2_ENDPOINT is unset, the same rule
  R2S3Client.fromEnvOrSecrets uses)

Examples:
  bun run r2:verify:local
  bun run r2:verify:local --prefix dist --strict

Skipped by design (Pages-only, never mirrored): _headers, assets/live-ops.d.ts, dashboard-view.html.

The bucket stores files at the root (openapi.json, assets/…), which is why the key is the path
relative to --prefix. Verify the published set (dist/, built by bun run docs:stage), not every
markdown/evidence file under docs/ — those are Pages content, not mirror objects.
`.trim();

const parsed = parseCliArgs(process.argv.slice(2), {
  valueFlags: ["--prefix", "--bucket"],
});
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const prefix = flagValue(parsed, "--prefix", "dist");
const bucket = flagValue(
  parsed,
  "--bucket",
  Bun.env.R2_BUCKET_NAME ?? "sportsdesk-ops-reports",
);
const strict = hasFlag(parsed, "--strict");
/**
 * Published-set files that are Pages-only or type surfaces, not R2 mirror objects: the Pages
 * `_headers` file, the generated declaration beside the browser asset, and the standalone
 * dashboard page (served by Pages). They stay in the repo and in `dist/` but are not expected in
 * the bucket, so the freshness gate skips them explicitly instead of counting them as missing.
 */
const PAGES_ONLY_PATHS: ReadonlySet<string> = new Set([
  "_headers",
  "assets/live-ops.d.ts",
  "dashboard-view.html",
]);
const accessKeyId = Bun.env.R2_ACCESS_KEY_ID ?? "";
const secretAccessKey = Bun.env.R2_SECRET_ACCESS_KEY ?? "";
// Mirror `R2S3Client.fromEnvOrSecrets`: an explicit endpoint wins, otherwise derive it from the
// account id. That keeps R2_ENDPOINT a single optional override instead of a second config surface
// (and a drift risk) next to the keychain-injected CLOUDFLARE_ACCOUNT_ID.
const accountId = Bun.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const endpoint =
  Bun.env.R2_ENDPOINT ??
  (accountId === ""
    ? undefined
    : `https://${accountId}.r2.cloudflarestorage.com`);

if (endpoint === undefined || accessKeyId === "" || secretAccessKey === "") {
  console.error("r2:verify:local: R2 credentials are not configured.");
  console.error(
    "  Need CLOUDFLARE_ACCOUNT_ID (to derive the endpoint) or R2_ENDPOINT, plus R2_ACCESS_KEY_ID " +
      "and R2_SECRET_ACCESS_KEY; or run ./bin/dx exec --with r2 -- bun run r2:verify:local.",
  );
  process.exit(2);
}

const client = new Bun.S3Client({
  endpoint,
  bucket,
  accessKeyId,
  secretAccessKey,
});

// `stat()` and `size()` return empty values against this endpoint, so the size map comes from a
// single list call, which does report size and eTag.
const remote = new Map<string, number>();
let cursor: string | undefined;
do {
  const page = await client.list(
    cursor === undefined
      ? { maxKeys: 1000 }
      : { maxKeys: 1000, continuationToken: cursor },
  );
  for (const object of page?.contents ?? [])
    remote.set(String(object.key), Number(object.size ?? 0));
  cursor =
    page?.isTruncated === true
      ? String(page.nextContinuationToken ?? "")
      : undefined;
} while (cursor !== undefined && cursor !== "");

const files: string[] = [];
for await (const rel of new Glob("**/*").scan({ cwd: prefix, onlyFiles: true }))
  files.push(rel);
files.sort();

let checked = 0;
let missing = 0;
let mismatched = 0;
let skipped = 0;

for (const rel of files) {
  if (PAGES_ONLY_PATHS.has(rel)) {
    skipped += 1;
    continue;
  }
  const path = `${prefix.replace(/\/$/, "")}/${rel}`;
  const localSize = Bun.file(path).size;
  const remoteSize = remote.get(rel);
  if (remoteSize === undefined) {
    missing += 1;
    if (strict) console.log(`missing   ${rel}`);
    continue;
  }
  checked += 1;
  if (remoteSize !== localSize) {
    mismatched += 1;
    console.log(`size      ${rel}  local ${localSize} != remote ${remoteSize}`);
  }
}

console.error(
  `r2:verify:local: ${bucket}/${prefix}: ${checked} matched, ${mismatched} size mismatch(es), ${missing} not uploaded, ${skipped} skipped (Pages-only)`,
);

if (mismatched > 0) process.exit(1);
if (strict && missing > 0) process.exit(1);
