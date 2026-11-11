#!/usr/bin/env bun
/**
 * Manager hierarchy SQLite ingest (`bun run manager:ingest-hierarchy`).
 */
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";

const REPO = join(import.meta.dir, "..");
const SCRATCH = join(REPO, "scratch");

import { generalProbeFromWireText } from "../lib/f402_list_agents_general_probe.ts";
import { ingestManagerHierarchyFile } from "../lib/f402_manager_hierarchy_ingest.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    db: { type: "string" },
    envelope: { type: "string" },
    "master-id": { type: "string", default: "MASTER1" },
    "master-login": { type: "string", default: "MASTER1" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`f402_manager_hierarchy_ingest — GENERAL → agents table (levels 1–12)

Options:
  --db <path>           SQLite file (created if missing)
  --envelope <path>     Raw getListAgenstByAgent JSON (PLAYERS not written; only GENERAL read)
  --master-id           Parser context MASTER_ID (default MASTER1)
  --master-login        Parser context account login (default MASTER1)
  -h, --help

Levels 13–19 are reported in skippedOverflow and are not inserted (portal baseHeriarchy cap).

Defaults: F402_AGENTS_DB / F402_RAW_ENVELOPE, else scratch/manager-agents.sqlite and scratch/raw-f402-list-agents.json.
`);
  process.exit(0);
}

const dbPath =
  values.db?.trim() ||
  Bun.env.F402_AGENTS_DB?.trim() ||
  join(SCRATCH, "manager-agents.sqlite");
const envelopePath =
  values.envelope?.trim() ||
  Bun.env.F402_RAW_ENVELOPE?.trim() ||
  join(SCRATCH, "raw-f402-list-agents.json");

const probe = generalProbeFromWireText(
  await Bun.file(resolve(envelopePath)).text(),
);
const result = ingestManagerHierarchyFile(
  resolve(dbPath),
  { GENERAL: probe.general },
  {
    masterId: values["master-id"] ?? "MASTER1",
    masterLogin: values["master-login"] ?? "MASTER1",
  },
);

console.log(
  JSON.stringify({
    signal: "F402_MANAGER_HIERARCHY_INGESTED",
    generalRowCount: result.generalRowCount,
    rowCount: result.rowCount,
    cteRowCount: result.cteRowCount,
    skippedOverflowCount: result.skippedOverflow.length,
    skippedOverflowSample: result.skippedOverflow.slice(0, 5),
    ingestMs: result.ingestMs,
  }),
);

if (result.rowCount !== result.cteRowCount) {
  console.error(
    "CTE row count does not match agents table — parent graph broken",
  );
  process.exit(1);
}
