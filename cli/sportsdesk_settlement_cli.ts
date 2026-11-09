#!/usr/bin/env bun
/**
 * Fantasy402 settlement/history poll — append-only wager lifecycle ingest (Option A).
 */

import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditRunId, type AuditRunId } from "../lib/audit_run_id.ts";
import {
  createWagerSettlementStore,
  pollManagerGetHistory,
  SETTLEMENT_EXIT_STORE_INVARIANT,
  type SettlementPollBatch,
} from "../lib/fantasy402_settlement_ingest.ts";
import {
  activeWagerObservationSlicesForSettlementCount,
  patternProvability,
} from "../lib/fantasy402_wager_universe_scope.ts";
import {
  exportSettlementOutcomes,
  settlementOutcomesJsonl,
} from "../lib/settlement_outcomes.ts";

type GlobalOpts = { json: boolean };

function printRootHelp(): void {
  console.log(`Fantasy402 wager settlement / history ingest

Commands:
  ingest    Append-only rows from fixture JSON
  poll      Live POST Manager/getHistory → SQLite (requires SPORTSDESK_PORTAL_HTTP_BASE)
  verify    Payload drift + valid_time fork invariants
  status    Outcome counts + pattern provability on active slices
  outcomes  Export latest per-ticket outcomes as JSONL for alert performance

Global:
  -h, --help
  --json

Examples:
  bun run settlement ingest --db ./lifecycle.sqlite --fixture tests/fixtures/fantasy402-history-poll.json
  bun run settlement poll --db ./lifecycle.sqlite
  bun run settlement verify --db ./lifecycle.sqlite
  bun run settlement outcomes --db ./lifecycle.sqlite --out Scratch/settlement/outcomes.jsonl
`);
}

function printIngestHelp(): void {
  console.log(`settlement ingest

Options:
  --db <path>         SQLite store (required)
  --fixture <path>    { feed, polledAt?, rows[] } (required)
  --run-id <id>       Batch marker (default: random UUID)

Exit: 0 ok · 1 usage
`);
}

function printOutcomesHelp(): void {
  console.log(`settlement outcomes

Options:
  --db <path>    SQLite settlement store (required)
  --out <path>   Write JSONL outcomes; omit to print the summary only

Rows: {customerId, wagerNumber, outcome: win|loss|push|void, netUsd, source}
Latest observation per ticket wins; tickets without a decisive outcome are skipped.
`);
}

function parseGlobal(argv: string[]): { rest: string[]; opts: GlobalOpts } {
  const opts: GlobalOpts = { json: false };
  const rest: string[] = [];
  for (const a of argv) {
    if (a === "--json") opts.json = true;
    else rest.push(a);
  }
  return { rest, opts };
}

function loadBatchFixture(path: string): SettlementPollBatch {
  const raw = JSON.parse(readFileSync(path, "utf8")) as SettlementPollBatch;
  if (!raw.feed || !Array.isArray(raw.rows)) {
    throw new Error(`Invalid fixture: ${path}`);
  }
  return {
    feed: raw.feed,
    polledAt: raw.polledAt ?? new Date().toISOString(),
    rows: raw.rows,
  };
}

async function cmdIngest(args: string[], opts: GlobalOpts): Promise<number> {
  let dbPath: string | undefined;
  let fixturePath: string | undefined;
  let runId: AuditRunId = auditRunId();

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      printIngestHelp();
      return 0;
    }
    if (a === "--db" && args[i + 1]) dbPath = resolve(args[++i]!);
    else if (a === "--fixture" && args[i + 1])
      fixturePath = resolve(args[++i]!);
    else if (a === "--run-id" && args[i + 1]) runId = auditRunId(args[++i]!);
  }

  if (!dbPath || !fixturePath) {
    console.error("ingest requires --db and --fixture");
    printIngestHelp();
    return 1;
  }

  const batch = loadBatchFixture(fixturePath);
  const db = openSportsdeskSqlite(dbPath);
  const store = createWagerSettlementStore(db);
  const inserted = store.ingestBatch(batch, runId);

  if (opts.json) {
    console.log(
      JSON.stringify({
        ok: true,
        runId,
        inserted,
        observationCount: store.countObservations(),
      }),
    );
  } else {
    console.log(`ingest ok: ${inserted} row(s), run_id=${runId}`);
  }
  return 0;
}

async function cmdPoll(args: string[], opts: GlobalOpts): Promise<number> {
  let dbPath: string | undefined;
  let runId: AuditRunId = auditRunId();

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--db" && args[i + 1]) dbPath = resolve(args[++i]!);
    else if (a === "--run-id" && args[i + 1]) runId = auditRunId(args[++i]!);
  }

  if (!dbPath) {
    console.error("poll requires --db");
    return 1;
  }

  const { polledAt, rows } = await pollManagerGetHistory();
  const batch: SettlementPollBatch = {
    feed: "getHistory",
    polledAt,
    rows,
  };
  const db = openSportsdeskSqlite(dbPath);
  const store = createWagerSettlementStore(db);
  const inserted = store.ingestBatch(batch, runId);

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, runId, inserted, polledAt }));
  } else {
    console.log(`poll ok: ${inserted} row(s) from getHistory`);
  }
  return 0;
}

async function cmdVerify(args: string[], opts: GlobalOpts): Promise<number> {
  let dbPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db" && args[i + 1]) dbPath = resolve(args[++i]!);
  }

  if (!dbPath) {
    console.error("verify requires --db");
    return 1;
  }

  const db = openSportsdeskSqlite(dbPath);
  const store = createWagerSettlementStore(db);
  const report = store.runStoreInvariants();

  if (!report.ok) {
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            payloadDrift: report.payloadDrift,
            validTimeFork: report.validTimeFork,
          },
          null,
          2,
        ),
      );
    } else console.error("settlement store invariant failure");
    return SETTLEMENT_EXIT_STORE_INVARIANT;
  }

  if (opts.json) {
    console.log(
      JSON.stringify({
        ok: true,
        payloadDrift: report.payloadDrift,
        validTimeFork: report.validTimeFork,
      }),
    );
  } else console.log("verify ok (settlement invariants clean)");
  return 0;
}

async function cmdStatus(args: string[], opts: GlobalOpts): Promise<number> {
  let dbPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db" && args[i + 1]) dbPath = resolve(args[++i]!);
  }
  if (!dbPath) {
    console.error("status requires --db");
    return 1;
  }

  const db = openSportsdeskSqlite(dbPath);
  const store = createWagerSettlementStore(db);
  const rates = store.summarizeOutcomeRates();
  const slices = activeWagerObservationSlicesForSettlementCount(
    store.countObservations(),
  );

  const body = {
    observationCount: store.countObservations(),
    activeSlices: [...slices],
    outcomes: rates,
    patterns: {
      win_loss_rate: patternProvability("win_loss_rate", slices),
      cancel_rate: patternProvability("cancel_rate", slices),
    },
  };

  if (opts.json) console.log(JSON.stringify(body, null, 2));
  else {
    console.log(`observations: ${body.observationCount}`);
    console.log(`slices: ${body.activeSlices.join(", ")}`);
    console.log(
      `settled=${rates.settled} canceled=${rates.canceled} wins=${rates.wins} losses=${rates.losses}`,
    );
    console.log(
      `win_loss_rate: ${body.patterns.win_loss_rate}, cancel_rate: ${body.patterns.cancel_rate}`,
    );
  }
  return 0;
}

function cmdOutcomes(args: string[], opts: GlobalOpts): number {
  let dbPath: string | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      printOutcomesHelp();
      return 0;
    }
    if (a === "--db" && args[i + 1]) dbPath = resolve(args[++i]!);
    else if (a === "--out" && args[i + 1]) outPath = resolve(args[++i]!);
  }
  if (!dbPath) {
    console.error("outcomes requires --db");
    printOutcomesHelp();
    return 1;
  }
  const exported = exportSettlementOutcomes(dbPath);
  if (!exported.ok) {
    if (opts.json) {
      console.log(
        JSON.stringify({
          ok: false,
          error: exported.reason,
          dbPath: exported.dbPath,
        }),
      );
    } else {
      console.error(`outcomes: ${exported.reason} (${exported.dbPath})`);
    }
    return 1;
  }
  // Never write a file for an empty export: a blank file is indistinguishable from a real
  // (empty) outcome set.
  const wroteFile = outPath !== undefined && exported.rows.length > 0;
  if (wroteFile && outPath !== undefined) {
    writeFileSync(outPath, settlementOutcomesJsonl(exported.rows));
  }
  if (opts.json) {
    console.log(
      JSON.stringify({
        ok: true,
        dbPath: exported.dbPath,
        tickets: exported.tickets,
        rows: exported.rows.length,
        skipped: exported.skipped,
        out: outPath ?? null,
        wroteFile,
      }),
    );
  } else {
    console.log(
      `outcomes: ${exported.rows.length}/${exported.tickets} ticket(s) exported` +
        (exported.skipped === 0 ? "" : ` (${exported.skipped} skipped)`) +
        (outPath === undefined
          ? ""
          : wroteFile
            ? ` → ${outPath}`
            : " (no outcome rows; file not written)"),
    );
  }
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { rest, opts } = parseGlobal(argv);
  const [cmd, ...args] = rest;

  if (!cmd || cmd === "-h" || cmd === "--help") {
    printRootHelp();
    return 0;
  }

  switch (cmd) {
    case "ingest":
      return cmdIngest(args, opts);
    case "poll":
      return cmdPoll(args, opts);
    case "verify":
      return cmdVerify(args, opts);
    case "status":
      return cmdStatus(args, opts);
    case "outcomes":
      return cmdOutcomes(args, opts);
    default:
      console.error(`Unknown command: ${cmd}`);
      printRootHelp();
      return 1;
  }
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
