#!/usr/bin/env bun
/**
 * Fantasy402 settlement/history poll — append-only wager lifecycle ingest (Option A).
 */

import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";
import { readFileSync } from "node:fs";
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

type GlobalOpts = { json: boolean };

function printRootHelp(): void {
  console.log(`Fantasy402 wager settlement / history ingest

Commands:
  ingest    Append-only rows from fixture JSON
  poll      Live POST Manager/getHistory → SQLite (requires SPORTSDESK_PORTAL_HTTP_BASE)
  verify    Payload drift + valid_time fork invariants
  status    Outcome counts + pattern provability on active slices

Global:
  -h, --help
  --json

Examples:
  bun run settlement ingest --db ./lifecycle.sqlite --fixture tests/fixtures/fantasy402-history-poll.json
  bun run settlement poll --db ./lifecycle.sqlite
  bun run settlement verify --db ./lifecycle.sqlite
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
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  if (typeof parsed.feed === "string" && Array.isArray(parsed.rows)) {
    return {
      feed: parsed.feed as SettlementPollBatch["feed"],
      polledAt:
        typeof parsed.polledAt === "string"
          ? parsed.polledAt
          : new Date().toISOString(),
      rows: parsed.rows as Record<string, unknown>[],
    };
  }
  const info = parsed.INFO as { LIST?: unknown } | undefined;
  if (info && Array.isArray(info.LIST)) {
    return {
      feed: "getDeleteWager",
      polledAt:
        typeof parsed.capturedAt === "string"
          ? parsed.capturedAt
          : new Date().toISOString(),
      rows: info.LIST as Record<string, unknown>[],
    };
  }
  if (Array.isArray(parsed.LIST)) {
    return {
      feed: "getTransactions",
      polledAt:
        typeof parsed.capturedAt === "string"
          ? parsed.capturedAt
          : new Date().toISOString(),
      rows: parsed.LIST as Record<string, unknown>[],
    };
  }
  throw new Error(`Invalid fixture: ${path}`);
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
  const accounting = store.summarizeBuyoutAndDeleteAccounting();
  const slices = activeWagerObservationSlicesForSettlementCount(
    store.countObservations(),
  );

  const body = {
    observationCount: store.countObservations(),
    activeSlices: [...slices],
    outcomes: rates,
    accounting,
    patterns: {
      win_loss_rate: patternProvability("win_loss_rate", slices),
      cancel_rate: patternProvability("cancel_rate", slices),
      parlay_buyout_audit: patternProvability("parlay_buyout_audit", slices),
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
      `buyoutTickets=${accounting.distinctBuyoutTickets} deletedTickets=${accounting.distinctOperatorDeletedTickets} buyoutCredits=${accounting.buyoutCreditRows} ($${(accounting.buyoutCreditTotalCents / 100).toFixed(2)})`,
    );
    console.log(
      `win_loss_rate: ${body.patterns.win_loss_rate}, cancel_rate: ${body.patterns.cancel_rate}, parlay_buyout_audit: ${body.patterns.parlay_buyout_audit}`,
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
