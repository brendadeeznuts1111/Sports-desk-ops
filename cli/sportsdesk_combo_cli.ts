#!/usr/bin/env bun
/**
 * Universal combo index + venue lead-lag (not actor copy-trading).
 */

import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  auditRunAt,
  auditRunId,
  type AuditRunId,
} from "../lib/audit_run_id.ts";
import {
  canonicalComboFromWire,
  deriveCanonicalComboId,
  type InternalComboWire,
  type PolymarketComboWire,
} from "../lib/canonical_combo_index.ts";
import { createComboVenueStore } from "../lib/combo_venue_store.ts";
import {
  formatLeadLagReport,
  summarizeVenueLeadLag,
} from "../lib/venue_lead_lag.ts";

type GlobalOpts = { json: boolean };

function printRootHelp(): void {
  console.log(`Canonical combo index + venue lead-lag

Commands:
  derive     Print canonical_combo_id from fixture (debug)
  ingest     Append combo_legs rows for internal or polymarket side
  lead-lag   Report shared-combo venue lead-lag (seconds-scale)

Global:
  -h, --help
  --json

Examples:
  bun run combo derive --side internal --fixture tests/fixtures/canonical-combo-internal.json
  bun run combo ingest --db ./combo.sqlite --side polymarket --fixture tests/fixtures/canonical-combo-polymarket.json
  bun run combo lead-lag --db ./combo.sqlite
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

type IngestFixture = {
  venueRef: string;
  validTime: string;
  wire: InternalComboWire | PolymarketComboWire;
};

async function cmdDerive(args: string[], opts: GlobalOpts): Promise<number> {
  let side: "internal" | "polymarket" = "internal";
  let fixturePath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--side" && args[i + 1]) {
      side = args[++i] as "internal" | "polymarket";
    } else if (args[i] === "--fixture" && args[i + 1]) {
      fixturePath = resolve(args[++i]!);
    }
  }
  if (!fixturePath) {
    console.error("derive requires --fixture");
    return 1;
  }
  const wire = JSON.parse(readFileSync(fixturePath, "utf8")) as
    InternalComboWire | PolymarketComboWire;
  const projected = canonicalComboFromWire(side, wire);
  if (!projected) {
    console.error("could not project combo from wire");
    return 2;
  }
  if (opts.json) {
    console.log(JSON.stringify(projected, null, 2));
  } else {
    console.log(projected.canonicalComboId);
    console.log(deriveCanonicalComboId(projected.input));
  }
  return 0;
}

async function cmdIngest(args: string[], opts: GlobalOpts): Promise<number> {
  let dbPath: string | undefined;
  let side: "internal" | "polymarket" = "internal";
  let fixturePath: string | undefined;
  let runId: AuditRunId = auditRunId();

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--db" && args[i + 1]) dbPath = resolve(args[++i]!);
    else if (a === "--side" && args[i + 1]) {
      side = args[++i] as "internal" | "polymarket";
    } else if (a === "--fixture" && args[i + 1]) {
      fixturePath = resolve(args[++i]!);
    } else if (a === "--run-id" && args[i + 1]) runId = auditRunId(args[++i]!);
  }

  if (!dbPath || !fixturePath) {
    console.error("ingest requires --db and --fixture");
    return 1;
  }

  const batch = JSON.parse(readFileSync(fixturePath, "utf8")) as IngestFixture;
  const projected = canonicalComboFromWire(side, batch.wire);
  if (!projected) {
    console.error("ingest: wire did not project to canonical combo");
    return 2;
  }

  const db = openSportsdeskSqlite(dbPath);
  const store = createComboVenueStore(db);
  store.insertObservation({
    canonicalComboId: projected.canonicalComboId,
    venue: side,
    venueRef: batch.venueRef,
    validTime: batch.validTime,
    legs: projected.input.legs,
    runId,
    runAt: auditRunAt(),
    wireJson: batch.wire as Record<string, unknown>,
  });

  if (opts.json) {
    console.log(
      JSON.stringify({
        ok: true,
        canonicalComboId: projected.canonicalComboId,
        legRows: store.countLegRows(),
      }),
    );
  } else {
    console.log(`ingest ok: ${projected.canonicalComboId}`);
  }
  return 0;
}

async function cmdLeadLag(args: string[], opts: GlobalOpts): Promise<number> {
  let dbPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db" && args[i + 1]) dbPath = resolve(args[++i]!);
  }
  if (!dbPath) {
    console.error("lead-lag requires --db");
    return 1;
  }

  const db = openSportsdeskSqlite(dbPath);
  const store = createComboVenueStore(db);
  const summary = summarizeVenueLeadLag(store);

  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(formatLeadLagReport(summary));
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
    case "derive":
      return cmdDerive(args, opts);
    case "ingest":
      return cmdIngest(args, opts);
    case "lead-lag":
      return cmdLeadLag(args, opts);
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
