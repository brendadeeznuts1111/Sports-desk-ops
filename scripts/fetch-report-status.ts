#!/usr/bin/env bun
/**
 * Report the status of every Manager Tools endpoint the desk reads, with structured failure
 * classes (session expired, permission gap, challenge, throttled, transport, shape).
 *
 * Read-only. Never prints the GSID or x-gs-session value; only cookie names are reported.
 *
 * Usage:
 *   ./bin/dx fetch-report-status
 *   ./bin/dx fetch-report-status --from 1793509200 --to 1794203999 --json
 */

import {
  DEFAULT_MANAGER_PARTNER_ID,
  defaultManagerWindow,
  formatManagerProbeTable,
  isBlockingManagerStatus,
  probeManagerEndpoints,
  type GsliveManagerWindow,
} from "../lib/gslive_manager_endpoints.ts";
import { gsliveCookieNames } from "../lib/gslive_session_health.ts";
import { bootstrapGanchrowSession } from "./fetch-bet-tally.ts";

export interface ReportStatusArgs {
  readonly window: GsliveManagerWindow;
  readonly json: boolean;
  readonly outPath: string | null;
  readonly partnerId: number;
}

function usage(): void {
  console.log(`Usage: bun run scripts/fetch-report-status.ts [options]

Probe the read-only Manager Tools endpoints and print a status matrix.

Options:
  --from <epoch-seconds>   window start (default: now - 7d)
  --to <epoch-seconds>     window end (default: now)
  --partner <id>           partner id (default ${DEFAULT_MANAGER_PARTNER_ID})
  --json                   machine-readable document
  --out <path>             write the JSON document to a file
  -h, --help

Auth: GSLIVE_SESSION_ID (legacy GSID), read from Bun.env/.env. Missing cookie still probes
live-data (public) and reports the other endpoints as session_expired.

Status classes: ok · not_permitted · session_expired · challenge · forbidden · throttled ·
server_error · unreachable · invalid_json · shape_error.
Exit: 0 no blocking failures (permission gaps are reported, not fatal) · 1 blocking failure
(session/transport/shape).`);
}

export function parseStatusArgs(
  argv: readonly string[],
  nowMs: number = Date.now(),
): ReportStatusArgs | null {
  const defaults = defaultManagerWindow(nowMs);
  let from = defaults.fromEpochSec;
  let to = defaults.toEpochSec;
  let json = false;
  let outPath: string | null = null;
  let partnerId = DEFAULT_MANAGER_PARTNER_ID;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return null;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (
      (arg === "--from" ||
        arg === "--to" ||
        arg === "--out" ||
        arg === "--partner") &&
      argv[i + 1] !== undefined
    ) {
      const value = argv[++i] as string;
      if (arg === "--from") from = Number(value);
      else if (arg === "--to") to = Number(value);
      else if (arg === "--out") outPath = value;
      else if (arg === "--partner") partnerId = Number(value);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new Error("--from/--to must be epoch seconds with from < to");
  }
  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    throw new Error("--partner must be a positive number");
  }
  return {
    window: { fromEpochSec: Math.floor(from), toEpochSec: Math.floor(to) },
    json,
    outPath,
    partnerId,
  };
}

function cookieHeader(): string {
  const modern = (Bun.env.GSLIVE_SESSION_ID ?? "").trim();
  const legacy = (Bun.env.GSID ?? "").trim();
  const gsid = modern !== "" ? modern : legacy;
  return gsid === "" ? "" : `GSID=${gsid}`;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const parsed = parseStatusArgs(argv);
  if (parsed === null) {
    usage();
    return 0;
  }
  const cookie = cookieHeader();
  // v4 report GETs work cookie-only for the session probe, but this account's report reads
  // return the login HTML unless the per-run `x-gs-session` handshake is present. Mint it from
  // the same cookie; a failure is reported, never fatal (the probe still shows the failure).
  let sessionGate = "";
  let gateState: "minted" | "unavailable" | "absent" = "absent";
  if (cookie !== "") {
    try {
      sessionGate = await bootstrapGanchrowSession({ cookieHeader: cookie });
      gateState = sessionGate !== "" ? "minted" : "unavailable";
    } catch {
      gateState = "unavailable";
    }
  }
  const endpoints = await probeManagerEndpoints({
    cookieHeader: cookie,
    ...(sessionGate !== "" ? { xGsSession: sessionGate } : {}),
    window: parsed.window,
    partnerId: parsed.partnerId,
  });
  const blocking = endpoints.filter((endpoint) =>
    isBlockingManagerStatus(endpoint.status),
  );
  const permission = endpoints.filter(
    (endpoint) =>
      endpoint.status === "not_permitted" || endpoint.status === "forbidden",
  );
  const generatedAt = new Date().toISOString();
  const document = {
    success: blocking.length === 0,
    generatedAt,
    window: parsed.window,
    partnerId: parsed.partnerId,
    session: {
      configured: cookie !== "",
      cookieNames: gsliveCookieNames(cookie),
      sessionGate: gateState,
    },
    endpoints,
    blockingFailures: blocking.length,
    permissionGaps: permission.length,
  };
  if (parsed.outPath !== null) {
    await Bun.write(parsed.outPath, `${JSON.stringify(document, null, 2)}\n`);
  }
  if (parsed.json) {
    console.log(JSON.stringify(document));
  } else {
    console.log(
      `Manager endpoint status · window ${parsed.window.fromEpochSec}–${parsed.window.toEpochSec} · cookie ${cookie === "" ? "missing" : `present (${gsliveCookieNames(cookie).join(",")})`} · x-gs-session ${gateState}`,
    );
    console.log(formatManagerProbeTable(endpoints));
    console.log(
      `blocking=${blocking.length} permissionGaps=${permission.length}${permission.length > 0 ? ` (${permission.map((endpoint) => endpoint.kind).join(", ")})` : ""}`,
    );
  }
  return blocking.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(
      `fetch-report-status: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
