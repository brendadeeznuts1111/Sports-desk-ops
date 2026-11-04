#!/usr/bin/env bun
/**
 * @file capture_all_live.ts
 * @description Capture every read-only live Fantasy402 operation in one run, rebuild the desk
 * artifacts that have builders, and write one PII-free health snapshot.
 *
 * Why this exists: the live feeds were captured by separate scripts, so "is the desk's live data
 * fresh?" had no single answer. This runs the plan from `lib/live_capture.ts` (derived from the
 * probe catalog) and records, per source, status / rows / bytes / artifact / error. A failed or
 * empty response never replaces a good artifact.
 *
 * Auth goes through `createF402ReplayTransport()` — session file or replay proxy. No tokens on the
 * command line, no tokens written to an artifact. Raw bodies are PII-bearing and land in
 * `scratch/f402-captures/` (gitignored); the health snapshot carries no body and no customer id.
 *
 * Usage:
 *   bun run capture:all --agent BILLY666 --customer H1716
 *   bun run capture:all --agent BILLY666 --customer H1716 --only Pending,getBetTicker
 *   bun run capture:all --agent BILLY666 --customer H1716 --dry-run
 */

import { join, resolve } from "node:path";
import {
  buildCaptureRequest,
  CAPTURE_HEALTH_PATH,
  liveCapturePlan,
  mergeCaptureHealth,
  probeOpFor,
  readCaptureHealth,
  runCapturePlan,
  writeCaptureHealth,
  type CaptureHttpResponse,
  type LiveCaptureRecord,
  type LiveCaptureSource,
} from "../../lib/live_capture.ts";

const root = join(import.meta.dir, "../..");
const DEFAULT_BASE = "https://fantasy402.com";

const HELP = [
  "Usage: bun run capture:all [flags]",
  "",
  "  --agent <id>       agent whose session is used (falls back to F402_AGENT_ID)",
  "  --customer <id>    customer id for customer-scoped operations (falls back to F402_CUSTOMER_ID)",
  "  --only <a,b>       capture only these operations (default: every read-only operation)",
  "  --artifacts-only   skip raw-only operations; capture just the artifact sources",
  "  --dry-run          print the plan and exit without a request",
  "  --json             print the run records as JSON",
  "  --out-raw <dir>    raw body directory (default scratch/f402-captures/live-<timestamp>)",
  "",
  "Auth: bun run session:login, F402_SESSION_FILE or F402_REPLAY_PROXY_URL.",
  "Artifacts: data/live-bets.json (Pending), data/live-wagers.json (getBetTicker).",
  "Health: data/capture-health.json — one record per source, latest run wins.",
].join("\n");

function flagValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? "";
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function describeRecord(record: LiveCaptureRecord): string {
  const status = record.httpStatus === null ? "-" : String(record.httpStatus);
  const rows = record.rows === null ? "-" : String(record.rows);
  const artifact = record.artifact === null ? "(raw only)" : record.artifact;
  const outcome = record.outcome === "captured" ? "captured" : "FAILED";
  const error = record.error === null ? "" : ` — ${record.error}`;
  return `${record.operation.padEnd(32)} ${outcome.padEnd(8)} HTTP ${status.padEnd(4)} rows ${rows.padEnd(5)} ${artifact}${error}`;
}

async function requireSession(): Promise<void> {
  const { readF402Session } = await import("../../lib/f402_session.ts");
  const proxyConfigured = (Bun.env.F402_REPLAY_PROXY_URL ?? "").trim() !== "";
  if (proxyConfigured || readF402Session() !== null) return;
  throw new Error(
    [
      "no F402 session available for a live capture.",
      "Configure one of:",
      "  bun run session:login                       (one WebView login; writes the 0600 cache)",
      "  F402_SESSION_FILE=<session json>            (see lib/f402_session.ts)",
      "  F402_REPLAY_PROXY_URL=<localhost proxy>",
      "F402_WEBVIEW_PROFILE alone is not enough: the transport does not read WebView cookies.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(HELP);
    return;
  }

  const agentId = (
    flagValue(args, "--agent") ??
    Bun.env.F402_AGENT_ID ??
    ""
  ).trim();
  const customerId = (
    flagValue(args, "--customer") ??
    Bun.env.F402_CUSTOMER_ID ??
    ""
  ).trim();
  const onlyFlag = flagValue(args, "--only");
  const only =
    onlyFlag === null
      ? undefined
      : onlyFlag
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== "");
  if (agentId === "") {
    throw new Error(
      "--agent is required (or set F402_AGENT_ID): the wire body sends agentID.",
    );
  }

  const plan = liveCapturePlan({
    ...(only === undefined ? {} : { only }),
    includeRaw: !hasFlag(args, "--artifacts-only"),
  });
  if (plan.length === 0) {
    throw new Error("the capture plan is empty; check --only operation names.");
  }

  // Operations that send a customerID cannot run without one. Report the skip instead of
  // sending an empty customer id and recording a server error as a capture failure.
  const runnable: LiveCaptureSource[] = [];
  const skipped: string[] = [];
  for (const source of plan) {
    if (source.needsCustomer && customerId === "")
      skipped.push(source.operation);
    else runnable.push(source);
  }
  if (runnable.length === 0) {
    throw new Error(
      "every planned operation needs a customer id; pass --customer (or set F402_CUSTOMER_ID).",
    );
  }

  console.log(
    `[capture:all] plan ${runnable.length} source(s)${skipped.length > 0 ? `, skipping ${skipped.length} without a customer id (${skipped.join(", ")})` : ""}`,
  );
  if (hasFlag(args, "--dry-run")) {
    for (const source of runnable) {
      console.log(
        `  ${source.operation.padEnd(32)} ${source.builder.padEnd(11)} ${source.artifact ?? "(raw only)"} every ${source.freshnessMinutes}m`,
      );
    }
    return;
  }

  await requireSession();
  const { createF402ReplayTransport } =
    await import("../../lib/f402_replay_transport.ts");
  const transport = await createF402ReplayTransport();
  const base = (Bun.env.F402_BASE_URL ?? DEFAULT_BASE).trim();
  const rawDir = resolve(
    root,
    flagValue(args, "--out-raw") ??
      join("scratch", "f402-captures", `live-${timestamp()}`),
  );
  const healthPath = resolve(root, CAPTURE_HEALTH_PATH);

  let records: readonly LiveCaptureRecord[] = [];
  try {
    records = await runCapturePlan(runnable, {
      transport: transport.label,
      async request(source): Promise<CaptureHttpResponse> {
        const op = probeOpFor(source.operation);
        if (op === null)
          throw new Error(`unknown operation ${source.operation}`);
        const built = buildCaptureRequest(op, { base, agentId, customerId });
        const response = await transport.fetch(built.url, {
          method: "POST",
          headers: {
            "content-type": built.contentType,
            accept: "application/json, text/plain, */*",
            "x-requested-with": "XMLHttpRequest",
          },
          body: built.body,
        });
        return { status: response.status, body: await response.text() };
      },
      async writeRaw(source, body) {
        const path = join(rawDir, `${source.operation}.json`);
        await Bun.write(path, body);
        console.error(`[capture:all] raw ${source.operation} -> ${path}`);
      },
      async writeArtifact(source, text) {
        if (source.artifact === null) return;
        await Bun.write(join(root, source.artifact), text);
      },
      async artifactExists(source) {
        if (source.artifact === null) return false;
        return Bun.file(join(root, source.artifact)).exists();
      },
    });
  } finally {
    await transport.close();
  }

  const previous = await readCaptureHealth(healthPath);
  const updatedAt = new Date().toISOString();
  await writeCaptureHealth(
    healthPath,
    mergeCaptureHealth(previous, records, updatedAt, transport.label),
  );

  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify({ updatedAt, skipped, records }, null, 2));
  } else {
    for (const record of records) console.log(describeRecord(record));
    const captured = records.filter((record) => record.outcome === "captured");
    const failed = records.filter((record) => record.outcome === "failed");
    console.log(
      `[capture:all] captured ${captured.length}/${records.length}, failed ${failed.length}; health -> ${CAPTURE_HEALTH_PATH}`,
    );
  }

  const failed = records.filter((record) => record.outcome === "failed");
  if (failed.length > 0 && failed.length === records.length) {
    throw new Error(
      "every source failed; the previous artifacts were left in place.",
    );
  }
  if (failed.length > 0) {
    console.error(
      `[capture:all] ${failed.length} source(s) failed: ${failed
        .map((record) => record.operation)
        .join(", ")}`,
    );
  }
}

await main();
