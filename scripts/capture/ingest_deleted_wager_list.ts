#!/usr/bin/env bun
/**
 * Read Manager deleted-transactions JSON (INFO.LIST), strip passwords, emit probe targets.
 *
 *   bun run scripts/capture/ingest_deleted_wager_list.ts < envelope.json
 *   bun run scripts/capture/ingest_deleted_wager_list.ts --in scratch/f402-deleted-wagers/envelope.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { auditRunId } from "../../lib/audit_run_id.ts";
import {
  auditDeletedWagerEnvelope,
  parseDeletedWagerEnvelope,
  redactDeletedWagerEnvelope,
  targetsFromEnvelope,
} from "../../lib/f402_deleted_wager_list.ts";
import { assertRedactedCaptureSweep } from "../../lib/f402_har_redaction_sweep.ts";
import { createWagerSettlementStore } from "../../lib/fantasy402_settlement_ingest.ts";
import { openSportsdeskSqlite } from "../../lib/sportsdesk_sqlite.ts";

function usage(): void {
  console.error(`Usage:
  ingest_deleted_wager_list.ts [--in path] [--out-redacted path] [--out-targets path] [--db sqlite-path]

Defaults:
  --out-redacted  scratch/f402-deleted-wagers/envelope.redacted.json
  --out-targets   scratch/f402-deleted-wagers/probe-targets.json
`);
}

async function readInput(inPath: string | undefined): Promise<string> {
  if (inPath) return await Bun.file(inPath).text();
  return await Bun.stdin.text();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    usage();
    process.exit(0);
  }

  let inPath: string | undefined;
  let outRedacted = "scratch/f402-deleted-wagers/envelope.redacted.json";
  let outTargets = "scratch/f402-deleted-wagers/probe-targets.json";
  let dbPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--in") inPath = args[++i];
    else if (a === "--out-redacted") outRedacted = args[i + 1] ?? outRedacted;
    else if (a === "--out-targets") outTargets = args[i + 1] ?? outTargets;
    else if (a === "--db") dbPath = args[++i];
  }

  const text = await readInput(inPath);
  const envelope = parseDeletedWagerEnvelope(JSON.parse(text));
  const redacted = redactDeletedWagerEnvelope(envelope);
  const redactedJson = `${JSON.stringify(redacted, null, 2)}\n`;
  assertRedactedCaptureSweep(redactedJson);

  const targets = targetsFromEnvelope(redacted);
  const audit = auditDeletedWagerEnvelope(redacted);

  for (const p of [outRedacted, outTargets]) {
    await mkdir(dirname(resolve(p)), { recursive: true });
  }

  await writeFile(resolve(outRedacted), redactedJson, "utf8");
  await writeFile(
    resolve(outTargets),
    `${JSON.stringify({ schemaVersion: 1, capturedAt: new Date().toISOString(), targets }, null, 2)}\n`,
    "utf8",
  );

  let sqliteInserted: number | null = null;
  if (dbPath) {
    const db = openSportsdeskSqlite(resolve(dbPath));
    const store = createWagerSettlementStore(db);
    sqliteInserted = store.ingestBatch(
      {
        feed: "getDeleteWager",
        polledAt: new Date().toISOString(),
        rows: redacted.INFO.LIST as unknown as Record<string, unknown>[],
      },
      auditRunId(),
    );
    db.close();
  }

  console.log(
    JSON.stringify(
      {
        legs: redacted.INFO.LIST.length,
        uniqueTickets: targets.length,
        buyoutTickets: audit.buyoutTickets,
        deletedTickets: audit.deletedTickets,
        openParlayBuyouts: audit.openParlayBuyouts,
        zeroPendingOpenParlayBuyouts: audit.zeroPendingOpenParlayBuyouts,
        multiPendingLegBuyouts: audit.multiPendingLegBuyouts,
        inPlayOrPostStartBuyouts: audit.inPlayOrPostStartBuyouts,
        postGameStartDeletes: audit.postGameStartDeletes,
        sqliteInserted,
        outRedacted: resolve(outRedacted),
        outTargets: resolve(outTargets),
        topByWager: targets.slice(0, 5).map((t) => ({
          customerId: t.customerId,
          ticketNumber: t.ticketNumber,
          amountWagered: t.amountWagered,
        })),
      },
      null,
      2,
    ),
  );
}

await main();
