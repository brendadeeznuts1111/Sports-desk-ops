#!/usr/bin/env bun
/**
 * Fetch the Manager Tools report period vocabulary.
 *
 *   GET https://plive.sportswidgets.pro/manager-tools/reports/periods/index.php
 *
 * Auth: GSID cookie; the endpoint returns a JSON array of period labels. Written atomically
 * so an HTML login page can never be persisted as JSON.
 *
 * Usage:
 *   ./bin/dx fetch-report-periods [--out report-periods.json]
 */

import {
  fetchReportPeriods,
  GSLIVE_REPORT_PERIODS_URL,
} from "./lib/gslive_manager_endpoints.ts";
import { assertBunFloor, writeJsonFileIfChanged } from "./lib/manager_fetch.ts";

export interface FetchReportPeriodsOptions {
  readonly outPath: string;
  readonly cookieHeader: string;
  readonly fetchImpl?: typeof fetch;
}

export async function fetchAndWriteReportPeriods(
  options: FetchReportPeriodsOptions,
): Promise<{ periods: readonly string[]; wrote: boolean; outPath: string }> {
  const periods = await fetchReportPeriods({
    cookieHeader: options.cookieHeader,
    ...(options.fetchImpl !== undefined
      ? { fetchImpl: options.fetchImpl }
      : {}),
  });
  if (periods === null) {
    throw new Error(
      `fetch-report-periods: ${GSLIVE_REPORT_PERIODS_URL} did not return a JSON string array — session expired or shape drift`,
    );
  }
  const { wrote } = await writeJsonFileIfChanged(options.outPath, periods);
  return { periods, wrote, outPath: options.outPath };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: bun run fetch-report-periods.ts [--out <path>]

Fetch the Manager Tools report period vocabulary.

  GET https://plive.sportswidgets.pro/manager-tools/reports/periods/index.php

Auth: GSLIVE_SESSION_ID (legacy GSID) from Bun.env/.env.
Output: report-periods.json by default (atomic write, gitignored), count on stdout.
Exit: 0 success · 1 HTTP/non-JSON/shape failure.
`);
    return;
  }
  assertBunFloor("fetch-report-periods");
  let outPath = "report-periods.json";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1] !== undefined)
      outPath = args[++i] as string;
  }
  const modern = (Bun.env.GSLIVE_SESSION_ID ?? "").trim();
  const legacy = (Bun.env.GSID ?? "").trim();
  const gsid = modern !== "" ? modern : legacy;
  const result = await fetchAndWriteReportPeriods({
    outPath,
    cookieHeader: gsid === "" ? "" : `GSID=${gsid}`,
  });
  console.log(
    `report-periods → ${result.outPath} (${result.periods.length} labels)${result.wrote ? "" : " (unchanged)"}`,
  );
}

if (import.meta.main) {
  void (async () => {
    try {
      await main();
    } catch (error) {
      console.error(
        `fetch-report-periods: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  })();
}
