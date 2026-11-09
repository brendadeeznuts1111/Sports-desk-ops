#!/usr/bin/env bun
/**
 * @file gslive_tally_bridge3c.ts
 * @description Bridge 3c CLI: stream a GSLive bet-report capture, fold the deduped tally, run
 * GATE-01..06 + GATE-08, and publish `gslive-tally/<desk-date>/rollup.json` plus the
 * `gslive-tally/latest.json` pointer to R2. No raw row, identifier or free text is written.
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

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: { type: "string", default: "scratch/betReport-all.json" },
    "desk-date": { type: "string" },
    "chunk-bytes": { type: "string" },
    out: { type: "string" },
    "fetch-open": { type: "boolean", default: false },
    timeout: { type: "string", default: "60000" },
    "open-from": { type: "string" },
    "open-to": { type: "string" },
    "save-capture": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "no-r2": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(
    "Usage: bun run bridge3c:rollup [--from <betReport-all.json>] [--fetch-open] [--open-from epoch] [--open-to epoch] [--save-capture path] [--out path] [--desk-date YYYY-MM-DD] [--chunk-bytes n] [--timeout ms] [--dry-run] [--no-r2]",
  );
  process.exit(0);
}

function isOpenState(value: unknown): boolean {
  const state = String(value ?? "")
    .trim()
    .toLowerCase();
  return (
    state === "" || state === "0" || state === "open" || state === "pending"
  );
}

async function fetchOpenCapture(path: string): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const from =
    values["open-from"] === undefined
      ? nowSec - 86_400
      : Number(values["open-from"]);
  const to =
    values["open-to"] === undefined ? nowSec : Number(values["open-to"]);
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
  const rows = await fetchBetReportRows({
    fromEpochSec: from,
    toEpochSec: to,
    cookieHeader: session.cookieHeader,
    sessionGate,
    timeoutMs: Number(values.timeout),
  });
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

const chunkBytes = (() => {
  const raw = values["chunk-bytes"];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("--chunk-bytes must be a positive integer");
  return parsed;
})();

let fromPath = values.from as string;
if (values["fetch-open"] === true) {
  fromPath =
    (values["save-capture"] as string | undefined) ??
    "scratch/open-bets-capture.json";
  await fetchOpenCapture(fromPath);
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
console.log(JSON.stringify({ ...result, publicStatus, gateSummary }, null, 2));
