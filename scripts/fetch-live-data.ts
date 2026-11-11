#!/usr/bin/env bun
/**
 * Fetch the public Manager Tools `live/data` catalog (sports, leagues, countries).
 *
 *   GET https://plive.sportswidgets.pro/live/data?countries=true&leagues=true&sports=true
 *
 * This endpoint is public (no GSID required); if GSLIVE_SESSION_ID/GSID is set it is sent
 * anyway so the request matches the signed-in browser. The response is validated once at the
 * boundary and written atomically; an HTML login page can never be written as JSON.
 *
 * Usage:
 *   bun run fetch-live-data
 *   bun x dx fetch-live-data [--out live-data.json]
 */

import {
  GSLIVE_LIVE_DATA_URL,
  parseLiveDataCatalog,
} from "../lib/gslive_manager_endpoints.ts";
import {
  assertBunFloor,
  MANAGER_REFERER,
  MANAGER_USER_AGENT,
  writeJsonFileIfChanged,
} from "../lib/manager_fetch.ts";

export interface FetchLiveDataOptions {
  readonly outPath: string;
  readonly cookieHeader: string;
  readonly fetchImpl?: typeof fetch;
}

export async function fetchLiveData(options: FetchLiveDataOptions): Promise<{
  summary: NonNullable<ReturnType<typeof parseLiveDataCatalog>>;
  wrote: boolean;
  outPath: string;
}> {
  const headers: Record<string, string> = {
    accept: "application/json",
    referer: MANAGER_REFERER,
    "user-agent": MANAGER_USER_AGENT,
  };
  if (options.cookieHeader.trim() !== "") headers.cookie = options.cookieHeader;
  const response = await (options.fetchImpl ?? fetch)(GSLIVE_LIVE_DATA_URL, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `fetch-live-data: redirected to ${response.headers.get("location") ?? "(unknown)"} — session expired`,
    );
  }
  if (!response.ok) {
    throw new Error(`fetch-live-data: HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    throw new Error(
      `fetch-live-data: not JSON (content-type: ${contentType || "<none>"}) — login HTML`,
    );
  }
  const raw: unknown = await response.json();
  const summary = parseLiveDataCatalog(raw);
  if (summary === null) {
    throw new Error(
      "fetch-live-data: catalog JSON lacks sports/leagues/countries maps",
    );
  }
  const { wrote } = await writeJsonFileIfChanged(options.outPath, raw);
  return { summary, wrote, outPath: options.outPath };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: bun run scripts/fetch-live-data.ts [--out <path>]

Fetch the public Manager Tools live-data catalog (sports, leagues, countries).

  GET https://plive.sportswidgets.pro/live/data?countries=true&leagues=true&sports=true

Auth: none required; GSLIVE_SESSION_ID/GSID is sent when present.
Output: live-data.json by default (atomic write, gitignored), summary on stdout.
Exit: 0 success · 1 HTTP/non-JSON/shape failure.
`);
    return;
  }
  assertBunFloor("fetch-live-data");
  let outPath = "live-data.json";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1] !== undefined) {
      outPath = args[++i] as string;
    }
  }
  const cookieHeader =
    (Bun.env.GSLIVE_SESSION_ID ?? "").trim() !== ""
      ? `GSID=${(Bun.env.GSLIVE_SESSION_ID as string).trim()}`
      : (Bun.env.GSID ?? "").trim() !== ""
        ? `GSID=${(Bun.env.GSID as string).trim()}`
        : "";
  const result = await fetchLiveData({ outPath, cookieHeader });
  console.log(
    `live-data → ${result.outPath} (sports: ${result.summary.sports}, leagues: ${result.summary.leagues}, countries: ${result.summary.countries})${result.wrote ? "" : " (unchanged)"}`,
  );
}

if (import.meta.main) {
  void (async () => {
    try {
      await main();
    } catch (error) {
      console.error(
        `fetch-live-data: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  })();
}
