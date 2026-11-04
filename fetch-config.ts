#!/usr/bin/env bun
/**
 * Fetch the partner (white-label) config from the Manager Tools SPA and persist it.
 *
 * GET https://plive.sportswidgets.pro/manager-tools/partnerConfig/
 *
 * Auth is cookie-based: the `GSID` session GUID (from Bun.env.GSID / .env). Bun's `fetch`
 * auto-decodes gzip/br/deflate and silently drops forbidden headers (sec-*), so we send
 * accept + cookie + referer + user-agent only.
 *
 * Guards against the HTML-login trap: an expired GSID returns 200 with an HTML login page
 * or a 302 to /login, which would otherwise crash `JSON.parse` with "Unexpected token '<'".
 *
 * Usage:
 *   echo 'GSID=...' > .env            # .env is gitignored
 *   bun run fetch-config              # writes partnerConfig.json (gitignored) and prints it
 *   ./bin/dx fetch-config
 */

import { z } from "zod";
import {
  assertBunFloor,
  assertJsonResponse,
  getJsonWithRetry,
  requireGsid,
  writeJsonFileIfChanged,
} from "./lib/manager_fetch.ts";

const PARTNER_CONFIG_URL =
  "https://plive.sportswidgets.pro/manager-tools/partnerConfig/";

export type PartnerConfigShape =
  "partners-array" | "keyed-map" | "data-meta" | "unknown";

export interface PartnerConfigSummary {
  readonly shape: PartnerConfigShape;
  readonly entryCount: number;
}

/** Boundary schemas — parse external JSON once with zod, no hand-rolled guards. */
const dataMetaSchema = z.object({ data: z.unknown(), meta: z.unknown() });
const partnersArraySchema = z.object({ partners: z.array(z.unknown()) });
const keyedMapSchema = z.record(z.string(), z.unknown());

export function parsePartnerConfig(cfg: unknown): {
  readonly shape: PartnerConfigShape;
  readonly data: unknown;
  readonly entryCount: number;
} {
  const dataMeta = dataMetaSchema.safeParse(cfg);
  if (dataMeta.success) {
    const entryCount = countEntries(dataMeta.data.data);
    return { shape: "data-meta", data: dataMeta.data, entryCount };
  }

  const partnersArray = partnersArraySchema.safeParse(cfg);
  if (partnersArray.success) {
    return {
      shape: "partners-array",
      data: partnersArray.data,
      entryCount: partnersArray.data.partners.length,
    };
  }

  const keyedMap = keyedMapSchema.safeParse(cfg);
  if (keyedMap.success) {
    return {
      shape: "keyed-map",
      data: keyedMap.data,
      entryCount: Object.keys(keyedMap.data).length,
    };
  }

  return { shape: "unknown", data: cfg, entryCount: 0 };
}

function countEntries(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object")
    return Object.keys(value).length;
  return 0;
}

export function isJsonContentType(
  contentType: string | null | undefined,
): boolean {
  const ct = contentType ?? "";
  return ct.includes("json");
}

/**
 * Fail-closed response validation. Throws before any body is parsed so we never
 * feed an HTML login page to JSON.parse. Delegates to the shared guard.
 *
 * `redirect: "manual"` is used by the caller so a 302-to-login surfaces here
 * instead of being silently followed to a 200 HTML page.
 */
export function assertOkJson(response: Response): void {
  assertJsonResponse(response, "partnerConfig");
}

export async function fetchPartnerConfig(cookie: string): Promise<Response> {
  return await getJsonWithRetry(PARTNER_CONFIG_URL, cookie, "partnerConfig");
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `Usage: bun run fetch-config.ts [--help|-h]

Fetch the partner (white-label) config from the Manager Tools SPA and persist it.

  GET https://plive.sportswidgets.pro/manager-tools/partnerConfig/

Auth is cookie-based: the GSID session GUID (from Bun.env.GSID / .env).

Output:
  - partnerConfig.json  (atomic write, gitignored)
  - pretty-printed JSON to stdout

Exit codes:
  0  success
  1  missing GSID, non-ok HTTP, non-JSON body, or redirect-to-login

Set GSID in .env (gitignored) or export Bun.env.GSID before running.`,
    );
    return;
  }

  assertBunFloor("fetch-config");
  const cookie = requireGsid("fetch-config");

  const response = await fetchPartnerConfig(cookie);
  assertOkJson(response);

  const cfg: unknown = await response.json();
  const summary = parsePartnerConfig(cfg);
  const { pretty, wrote } = await writeJsonFileIfChanged(
    "partnerConfig.json",
    cfg,
  );

  console.log(
    `partnerConfig → partnerConfig.json (shape: ${summary.shape}, entries: ${summary.entryCount})${wrote ? "" : " (unchanged)"}`,
  );
  console.log(pretty);
}

if (import.meta.main) {
  void (async () => {
    try {
      await main();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`fetch-config: ${message}`);
      process.exit(1);
    }
  })();
}
