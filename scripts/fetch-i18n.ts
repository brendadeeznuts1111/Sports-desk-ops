#!/usr/bin/env bun
/**
 * Fetch Manager Tools i18n translation resources.
 *
 * GET https://plive.sportswidgets.pro/manager-tools/translations/v2/getI18nResources/index.php?lng=en&ns=translation&appId=2
 *
 * Auth: GSID session cookie from Bun.env.GSID (.env, gitignored).
 * Bun's `fetch` auto-decodes gzip/br/deflate; we send accept + cookie + referer + user-agent only.
 *
 * Fail-closed: 302 = GSID expired, non-ok = error, non-JSON content-type = login HTML trap
 * (avoids JSON.parse throwing "Unexpected token '<'").
 *
 * Usage:
 *   echo 'GSID=...' > .env
 *   bun run scripts/fetch-i18n.ts
 *   ./bin/dx fetch-i18n
 */

import { z } from "zod";
import {
  assertBunFloor,
  getJsonWithRetry,
  requireGsid,
  writeJsonFileIfChanged,
} from "../lib/manager_fetch.ts";

const I18N_URL =
  "https://plive.sportswidgets.pro/manager-tools/translations/v2/getI18nResources/index.php";

interface FetchI18nOpts {
  readonly lng: string;
  readonly ns: string;
  readonly appId: string;
}

function buildI18nUrl(opts: FetchI18nOpts): string {
  const url = new URL(I18N_URL);
  url.searchParams.set("lng", opts.lng);
  url.searchParams.set("ns", opts.ns);
  url.searchParams.set("appId", opts.appId);
  return url.toString();
}

/** zod boundary schema — parse external JSON once. */
const i18nSchema = z.record(z.string(), z.unknown());

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `Usage: bun run scripts/fetch-i18n.ts [--help|-h]

Fetch Manager Tools i18n translation resources.

  GET https://plive.sportswidgets.pro/manager-tools/translations/v2/getI18nResources/index.php?lng=en&ns=translation&appId=2

Auth is cookie-based: the GSID session GUID (from Bun.env.GSID / .env).

Output:
  - i18n-resources.json  (atomic write, gitignored)
  - pretty-printed JSON to stdout

Exit codes:
  0  success
  1  missing GSID, non-ok HTTP, non-JSON body, or redirect-to-login

Set GSID in .env (gitignored) or export Bun.env.GSID before running.`,
    );
    return;
  }

  assertBunFloor("fetch-i18n");

  const cookie = requireGsid("fetch-i18n");

  const opts: FetchI18nOpts = {
    lng: "en",
    ns: "translation",
    appId: "2",
  };

  const response = await getJsonWithRetry(
    buildI18nUrl(opts),
    cookie,
    "fetch-i18n",
  );

  const raw: unknown = await response.json();
  const parsed = i18nSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `fetch-i18n: unexpected response shape — ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }

  const resources = parsed.data;
  const namespace = resources[opts.ns];
  const keyCount = namespace ? Object.keys(namespace).length : 0;

  const outPath = "i18n-resources.json";
  const { pretty, wrote } = await writeJsonFileIfChanged(outPath, resources);

  console.log(
    `fetch-i18n → ${outPath} (namespace: ${opts.ns}, keys: ${keyCount}, total namespaces: ${Object.keys(resources).length})${wrote ? "" : " (unchanged)"}`,
  );
  console.log(pretty);
}

void (async () => {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`fetch-i18n: ${message}`);
    process.exit(1);
  }
})();
