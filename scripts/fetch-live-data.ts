#!/usr/bin/env bun
/**
 * Fetch Manager Tools live sports/reference data.
 *
 * GET https://plive.sportswidgets.pro/live/data?countries=true&leagues=true&sports=true
 *
 * Auth: GSID session cookie from Bun.env.GSLIVE_SESSION_ID (.env, gitignored; legacy GSID also read).
 * Bun's `fetch` auto-decodes gzip/br/deflate; we send accept + cookie + referer + user-agent only.
 *
 * Fail-closed: 302 = GSID expired, non-ok = error, non-JSON content-type = login HTML trap.
 *
 * Usage:
 *   echo 'GSID=...' > .env
 *   bun run scripts/fetch-live-data.ts
 *   ./bin/dx fetch-live-data
 */

import { z } from "zod";
import {
  assertBunFloor,
  getJsonWithRetry,
  requireGsid,
  writeJsonFileIfChanged,
} from "../lib/manager_fetch.ts";

const LIVE_DATA_URL = "https://plive.sportswidgets.pro/live/data";

function buildLiveDataUrl(): string {
  const url = new URL(LIVE_DATA_URL);
  url.searchParams.set("countries", "true");
  url.searchParams.set("leagues", "true");
  url.searchParams.set("sports", "true");
  return url.toString();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `Usage: bun run scripts/fetch-live-data.ts [--help|-h]

Fetch Manager Tools live sports/reference data.

  GET https://plive.sportswidgets.pro/live/data?countries=true&leagues=true&sports=true

Auth is cookie-based: the GSID session GUID (from Bun.env.GSLIVE_SESSION_ID / .env; legacy GSID also read).

Output:
  - live-data.json  (atomic write, gitignored)
  - pretty-printed JSON to stdout

Exit codes:
  0  success
  1  missing GSLIVE_SESSION_ID, non-ok HTTP, non-JSON body, or redirect-to-login

Set GSLIVE_SESSION_ID in .env (gitignored) or export it before running (legacy GSID also read).`,
    );
    return;
  }

  assertBunFloor("fetch-live-data");

  const cookie = requireGsid("fetch-live-data");

  const response = await getJsonWithRetry(
    buildLiveDataUrl(),
    cookie,
    "fetch-live-data",
  );

  const raw: unknown = await response.json();
  const parsed = z.unknown().safeParse(raw); // shape varies; zod boundary once
  if (!parsed.success) {
    throw new Error("fetch-live-data: response is not valid JSON");
  }

  const data = parsed.data as Record<string, unknown>;
  const topKeys = Object.keys(data);
  const entryCount = topKeys.length;

  const outPath = "live-data.json";
  const { pretty, wrote } = await writeJsonFileIfChanged(outPath, data);

  console.log(
    `fetch-live-data → ${outPath} (top-level keys: ${entryCount}, ${topKeys.join(", ")})${wrote ? "" : " (unchanged)"}`,
  );
  console.log(pretty);
}

void (async () => {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`fetch-live-data: ${message}`);
    process.exit(1);
  }
})();
