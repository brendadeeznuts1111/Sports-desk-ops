#!/usr/bin/env bun
/**
 * Fetch Manager Tools common reference data.
 *
 * GET https://plive.sportswidgets.pro/api/v3/manager-tools/common/
 *
 * Auth: GSID session cookie from Bun.env.GSID (.env, gitignored).
 * Bun's `fetch` auto-decodes gzip/br/deflate; we send accept + cookie + referer + user-agent only.
 *
 * Fail-closed: 302 = GSID expired, non-ok = error, non-JSON content-type = login HTML trap.
 *
 * Usage:
 *   echo 'GSID=...' > .env
 *   bun run scripts/fetch-common.ts
 *   ./bin/dx fetch-common
 */

import { z } from "zod";
import {
  assertBunFloor,
  getJsonWithRetry,
  requireGsid,
  writeJsonFileIfChanged,
} from "../lib/manager_fetch.ts";

const COMMON_URL =
  "https://plive.sportswidgets.pro/api/v3/manager-tools/common/";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `Usage: bun run scripts/fetch-common.ts [--help|-h]

Fetch Manager Tools common reference data.

  GET https://plive.sportswidgets.pro/api/v3/manager-tools/common/

Auth is cookie-based: the GSID session GUID (from Bun.env.GSID / .env).

Output:
  - manager-common.json  (atomic write, gitignored)
  - pretty-printed JSON to stdout

Exit codes:
  0  success
  1  missing GSID, non-ok HTTP, non-JSON body, or redirect-to-login

Set GSID in .env (gitignored) or export Bun.env.GSID before running.`,
    );
    return;
  }

  assertBunFloor("fetch-common");

  const cookie = requireGsid("fetch-common");

  const response = await getJsonWithRetry(COMMON_URL, cookie, "fetch-common");

  const raw: unknown = await response.json();
  const parsed = z.unknown().safeParse(raw); // shape varies; zod boundary once
  if (!parsed.success) {
    throw new Error("fetch-common: response is not valid JSON");
  }

  const common = parsed.data as Record<string, unknown>;
  const topKeys = Object.keys(common);
  const entryCount = Array.isArray(common) ? common.length : topKeys.length;

  const outPath = "manager-common.json";
  const { pretty, wrote } = await writeJsonFileIfChanged(outPath, common);

  console.log(
    `fetch-common → ${outPath} (top-level entries: ${entryCount}, keys: ${topKeys.join(", ")})${wrote ? "" : " (unchanged)"}`,
  );
  console.log(pretty);
}

void (async () => {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`fetch-common: ${message}`);
    process.exit(1);
  }
})();
