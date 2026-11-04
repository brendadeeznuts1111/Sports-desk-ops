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
  --prefix <path>    Local directory to verify (default: docs/)
  --bucket <name>    Bucket (default: R2_BUCKET_NAME or sportsdesk-ops-reports)
  --strict           Fail when a local file is missing from the bucket (default: report only)
  -h, --help         This text

Environment:
  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT (or CLOUDFLARE_R2_API_TOKEN)

Examples:
  bun run r2:verify:local
  bun run r2:verify:local --prefix docs --strict

The bucket stores files at the root (openapi.json, assets/…), which is why the key is the path
relative to --prefix.
`.trim();

const parsed = parseCliArgs(process.argv.slice(2), {
  valueFlags: ["--prefix", "--bucket"],
});
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const prefix = flagValue(parsed, "--prefix", "docs");
const bucket = flagValue(
  parsed,
  "--bucket",
  Bun.env.R2_BUCKET_NAME ?? "sportsdesk-ops-reports",
);
const strict = hasFlag(parsed, "--strict");
const endpoint = Bun.env.R2_ENDPOINT ?? "";
const accessKeyId = Bun.env.R2_ACCESS_KEY_ID ?? "";
const secretAccessKey = Bun.env.R2_SECRET_ACCESS_KEY ?? "";

if (endpoint === "" || accessKeyId === "" || secretAccessKey === "") {
  console.error("r2:verify:local: R2 credentials are not configured.");
  console.error(
    "  R2_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... bun run r2:verify:local",
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

for (const rel of files) {
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
  `r2:verify:local: ${bucket}/${prefix}: ${checked} matched, ${mismatched} size mismatch(es), ${missing} not uploaded`,
);

if (mismatched > 0) process.exit(1);
if (strict && missing > 0) process.exit(1);
