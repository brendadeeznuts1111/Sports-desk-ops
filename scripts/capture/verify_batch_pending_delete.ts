#!/usr/bin/env bun
/**
 * Re-runnable proof for single-webview batch PendingDelete.
 * Exit 0 only when summary + artifacts match expectations.
 *
 *   bun run scripts/capture/verify_batch_pending_delete.ts
 *   bun run scripts/capture/verify_batch_pending_delete.ts --run-live --limit 3
 */

import { join } from "node:path";

import {
  countPendingInResponseText,
  parsePendingDeleteBatchRows,
} from "../../lib/f402_pending_delete_batch.ts";

const root = join(import.meta.dir, "../..");
const args = process.argv.slice(2);
const runLive = args.includes("--run-live");
const limitIdx = args.indexOf("--limit");
const liveLimit = limitIdx === -1 ? 3 : Number(args[limitIdx + 1] ?? "3");

const summaryPath = join(
  root,
  "scratch/f402-deleted-wagers/batch-pending-delete-summary.json",
);

function fail(msg: string): never {
  console.error(`verify_batch_pending_delete: FAIL ${msg}`);
  process.exit(1);
}

if (runLive) {
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      "scripts/capture/batch_pending_delete_session.ts",
      "--limit",
      String(liveLimit),
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit", env: Bun.env },
  );
  const code = await proc.exited;
  if (code !== 0) fail(`live batch exited ${code}`);
}

const summary = (await Bun.file(summaryPath).json()) as {
  schemaVersion?: number;
  mode?: string;
  total?: number;
  failed?: number;
  outDir?: string;
  results?: Array<{
    customerId: string;
    ticketNumber: string;
    status: number;
    pendingCount: number;
    error?: string;
  }>;
};

if (summary.schemaVersion !== 2) fail(`schemaVersion ${summary.schemaVersion}`);
if (summary.mode !== "single-webview-pending-delete")
  fail(`mode ${summary.mode}`);
if (!summary.outDir || summary.outDir.length === 0) fail("missing outDir");
if (!Array.isArray(summary.results) || summary.results.length === 0) {
  fail("empty results");
}

const runFile = Bun.file(join(summary.outDir, "run.json"));
if (!(await runFile.exists())) fail(`missing ${summary.outDir}/run.json`);
const run = (await runFile.json()) as { mode?: string; ticketCount?: number };
if (run.mode !== "single-webview-pending-delete")
  fail("run.json mode mismatch");
if (run.ticketCount !== summary.total) {
  fail(`ticketCount ${run.ticketCount} !== summary.total ${summary.total}`);
}

let artifactMismatch = 0;
for (const row of summary.results) {
  if (row.error)
    fail(`row error ${row.customerId} ${row.ticketNumber}: ${row.error}`);
  if (row.status < 200 || row.status >= 300) {
    fail(`bad status ${row.status} for ${row.ticketNumber}`);
  }
  const artifactPath = join(
    summary.outDir,
    `PendingDelete-${row.customerId}-${row.ticketNumber}.json`,
  );
  const artifact = (await Bun.file(artifactPath).json()) as {
    pendingCount?: number;
    preview?: string;
  };
  if (artifact.pendingCount !== row.pendingCount) {
    fail(
      `pendingCount drift artifact=${artifact.pendingCount} summary=${row.pendingCount} ticket=${row.ticketNumber}`,
    );
  }
  const preview = artifact.preview ?? "";
  if (/"Password"\s*:\s*"[^<]/.test(preview)) {
    fail(`unredacted Password in preview for ${row.ticketNumber}`);
  }
  if (row.pendingCount > 0 && !preview.includes('"Pending"')) {
    fail(`pendingCount>0 but preview missing Pending for ${row.ticketNumber}`);
  }
  if (row.pendingCount === 0 && !/"Pending"\s*:\s*\[\s*\]/.test(preview)) {
    // allow truncated preview with tickets
    if (countPendingInResponseText(preview) !== 0) {
      fail(
        `pendingCount=0 but preview suggests pending for ${row.ticketNumber}`,
      );
    }
  }
  artifactMismatch++;
}

// Expression parser sanity (no browser)
const fakeRows = parsePendingDeleteBatchRows([
  {
    ticketNumber: "1",
    status: 200,
    bytes: 20,
    bodyText: '{"Pending":[{"TicketNumber":"1"}]}',
  },
]);
if (countPendingInResponseText(fakeRows[0]?.bodyText ?? "") !== 1) {
  fail("countPendingInResponseText regression");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      live: runLive,
      total: summary.total,
      failed: summary.failed ?? 0,
      artifactsChecked: artifactMismatch,
      outDir: summary.outDir,
    },
    null,
    2,
  ),
);
