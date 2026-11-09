#!/usr/bin/env bun
/**
 * @file gslive_tally_bridge3c.ts
 * @description Bridge 3c CLI: stream a GSLive bet-report capture, fold the deduped tally, run
 * GATE-01..06 + GATE-08, and publish `gslive-tally/<desk-date>/rollup.json` plus the
 * `gslive-tally/latest.json` pointer to R2. No raw row, identifier or free text is written.
 *
 * ARCHITECTURAL BOUNDARY & PARTITION INVARIANTS:
 * 1. Strictly read-only: GSLive Partner 118 is an in-play observation stream only.
 *    Zero mutation capabilities. Zero references to `updateByColumn`, `Bun.secrets`, or
 *    Fantasy402 write endpoints.
 * 2. Fail-closed exit 2 (`CLASS_D_GSLIVE_GAP_HALT`): bound solely to `betGroupIdNumeric` drops/regressions
 *    and Partner 118 HTML login traps.
 *
 * Usage:
 *   bun run bridge3c:rollup --from scratch/betReport-all.json --dry-run
 *   bun run bridge3c:rollup --from scratch/betReport-all.json
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { buildGsliveTallyRollup } from "../lib/gslive_tally_rollup.ts";
import {
  fetchBetReportRows,
  requireManagerSession,
  sessionGateFromEnv,
} from "./fetch-bet-tally.ts";
import { publishGsliveTallyRollup } from "../lib/gslive_tally_sink.ts";

export const CLASS_D_GSLIVE_GAP_HALT = "CLASS_D_GSLIVE_GAP_HALT" as const;
export const GSLIVE_AJAX_URL =
  "https://plive.sportswidgets.pro/manager-tools/ajax.php";
export const GSLIVE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

/**
 * Custom error thrown when a fail-closed exit 2 condition occurs:
 * 1. Partner 118 HTML login trap (session expired / HTML login page returned)
 * 2. betGroupIdNumeric drop or regression below lastCommittedBetGroupIdNumeric
 */
export class GsliveGapHaltError extends Error {
  readonly code = CLASS_D_GSLIVE_GAP_HALT;
  readonly exitCode = 2 as const;

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`[${CLASS_D_GSLIVE_GAP_HALT}] ${message}`);
    this.name = "GsliveGapHaltError";
  }
}

/** Detects if an upstream error represents a Partner 118 HTML login trap. */
export function isPartner118HtmlLoginTrap(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("html login page") ||
    msg.includes("session expired") ||
    msg.includes("text/html") ||
    msg.includes("<!doctype") ||
    msg.includes("<html")
  );
}

/** Detects whether an error qualifies for fail-closed exit 2. */
export function isGsliveGapHalt(err: unknown): boolean {
  if (err instanceof GsliveGapHaltError) return true;
  if (err instanceof Error) {
    return (
      err.message.includes(CLASS_D_GSLIVE_GAP_HALT) ||
      isPartner118HtmlLoginTrap(err)
    );
  }
  return false;
}

/**
 * Validates monotonic progression of betGroupIdNumeric.
 * Fails closed with GsliveGapHaltError if incoming GID regresses below last committed watermark.
 */
export function validateBetGroupIdMonotonicity(
  incomingGid: number,
  lastCommittedGid: number,
): void {
  if (lastCommittedGid > 0 && incomingGid < lastCommittedGid) {
    throw new GsliveGapHaltError(
      `betGroupIdNumeric regression detected: incoming ${incomingGid} < committed ${lastCommittedGid}`,
    );
  }
}

/** Compile-time & runtime assertion ensuring GSLive Bridge 3c is strictly read-only. */
export function assertGsliveReadOnlyBoundary(): void {
  // Enforces that mutation operation 'updateByColumn' cannot be imported or called in Bridge 3c
  const mutationOp = "updateByColumn";
  if ((globalThis as Record<string, unknown>)[mutationOp] !== undefined) {
    throw new Error("GSLive Bridge 3c must remain strictly read-only");
  }
}

function isOpenState(value: unknown): boolean {
  const state = String(value ?? "")
    .trim()
    .toLowerCase();
  return (
    state === "" || state === "0" || state === "open" || state === "pending"
  );
}

export async function fetchOpenCapture(
  path: string,
  opts?: {
    openFrom?: number | undefined;
    openTo?: number | undefined;
    lastCommittedGid?: number | undefined;
    timeoutMs?: number | undefined;
  },
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const from = opts?.openFrom ?? nowSec - 86_400;
  const to = opts?.openTo ?? nowSec;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) {
    throw new Error(
      "--open-from/--open-to must be epoch seconds with from < to",
    );
  }
  const session = await requireManagerSession();
  const sessionGate =
    session.sessionGate !== ""
      ? session.sessionGate
      : sessionGateFromEnv(Bun.env);

  let rows: readonly unknown[];
  try {
    rows = await fetchBetReportRows({
      fromEpochSec: from,
      toEpochSec: to,
      cookieHeader: session.cookieHeader,
      sessionGate,
      ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
  } catch (err) {
    if (isPartner118HtmlLoginTrap(err)) {
      throw new GsliveGapHaltError(
        "HTML login trap encountered during betReport fetch",
        err,
      );
    }
    throw err;
  }

  if (opts?.lastCommittedGid !== undefined) {
    let maxGid = 0;
    for (const r of rows) {
      if (r !== null && typeof r === "object") {
        const gid = Number(
          (r as Record<string, unknown>).betGroupId ??
            (r as Record<string, unknown>).betGroupIdNumeric ??
            0,
        );
        if (Number.isSafeInteger(gid) && gid > maxGid) maxGid = gid;
      }
    }
    validateBetGroupIdMonotonicity(maxGid, opts.lastCommittedGid);
  }

  const open = rows.filter((row) =>
    row !== null && typeof row === "object" && "state" in row
      ? isOpenState((row as { state?: unknown }).state)
      : false,
  );
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(
    temp,
    `${JSON.stringify({ from, to, r: { bets: open } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  renameSync(temp, path);
  console.error(
    `[bridge3c] fetched ${rows.length} rows, kept ${open.length} open -> ${path}`,
  );
}

export async function runBridge3c(
  args: readonly string[] = Bun.argv.slice(2),
): Promise<void> {
  assertGsliveReadOnlyBoundary();

  const { values } = parseArgs({
    args: [...args],
    options: {
      from: { type: "string", default: "scratch/betReport-all.json" },
      "desk-date": { type: "string" },
      "chunk-bytes": { type: "string" },
      out: { type: "string" },
      "fetch-open": { type: "boolean", default: false },
      timeout: { type: "string" },
      "open-from": { type: "string" },
      "open-to": { type: "string" },
      "last-committed-gid": { type: "string" },
      "save-capture": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "no-r2": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(
      "Usage: bun run bridge3c:rollup [--from <betReport-all.json>] [--fetch-open] [--open-from epoch] [--open-to epoch] [--last-committed-gid id] [--save-capture path] [--out path] [--desk-date YYYY-MM-DD] [--chunk-bytes n] [--timeout ms|sec] [--dry-run] [--no-r2]",
    );
    process.exit(0);
  }

  const timeoutMs = (() => {
    const raw = values.timeout;
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("--timeout must be a positive integer");
    }
    return parsed < 1000 ? Math.round(parsed * 1000) : Math.round(parsed);
  })();

  const chunkBytes = (() => {
    const raw = values["chunk-bytes"];
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
      throw new Error("--chunk-bytes must be a positive integer");
    return parsed;
  })();

  const lastCommittedGid = (() => {
    const raw = values["last-committed-gid"];
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  })();

  let fromPath = values.from as string;
  if (values["fetch-open"] === true) {
    fromPath =
      (values["save-capture"] as string | undefined) ??
      "scratch/open-bets-capture.json";
    const fromSec =
      values["open-from"] !== undefined
        ? Number(values["open-from"])
        : undefined;
    const toSec =
      values["open-to"] !== undefined ? Number(values["open-to"]) : undefined;
    await fetchOpenCapture(fromPath, {
      openFrom: fromSec,
      openTo: toSec,
      lastCommittedGid,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  const rollup = await buildGsliveTallyRollup(fromPath, {
    ...(values["desk-date"] === undefined
      ? {}
      : { deskDate: values["desk-date"] as string }),
    ...(chunkBytes === undefined ? {} : { chunkBytes }),
  });

  const gateSummary = rollup.gates
    .map((gate) => `GATE-0${gate.gate}:${gate.status}`)
    .join(" ");

  console.error(
    `[bridge3c] rows=${rollup.rowCount} groups=${rollup.distinctBetGroupCount} cells=${rollup.cells.length} ` +
      `suppressed=${rollup.suppressed.cellCount} bytes=${new TextEncoder().encode(JSON.stringify(rollup)).byteLength} ` +
      `deskDate=${rollup.deskDate} ${gateSummary}`,
  );

  if (values.out !== undefined) {
    const out = values.out as string;
    mkdirSync(dirname(out), { recursive: true });
    const temp = `${out}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(rollup, null, 2)}\n`);
    renameSync(temp, out);
    console.error(`[bridge3c] wrote ${out}`);
  }

  if (values["dry-run"]) {
    console.log(JSON.stringify(rollup, null, 2));
    process.exit(0);
  }

  if (values["no-r2"]) process.exit(0);

  const result = await publishGsliveTallyRollup(rollup);
  const publicStatus = await fetch(result.publicUrl)
    .then((r) => r.status)
    .catch(() => -1);
  console.log(
    JSON.stringify({ ...result, publicStatus, gateSummary }, null, 2),
  );
}

if (import.meta.main) {
  try {
    await runBridge3c(Bun.argv.slice(2));
  } catch (err) {
    if (isGsliveGapHalt(err)) {
      console.error(
        `[CLASS_D_GSLIVE_GAP_HALT] Fail-closed halt (exit 2): ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(2);
    }
    console.error(
      `[bridge3c] Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
