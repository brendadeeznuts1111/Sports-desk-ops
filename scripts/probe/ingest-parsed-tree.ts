#!/usr/bin/env bun
/**
 * Ingest scratch/parsed-tree.json → scratch/manager-agents.sqlite (agents table + CTE proof).
 */
import { join } from "node:path";

import { generalProbeFromWireText } from "../../lib/f402_list_agents_general_probe.ts";
import { ingestManagerHierarchyFile } from "../../lib/f402_manager_hierarchy_ingest.ts";
import { ingestNormalizedTreeToSqlite } from "../../lib/f402_sqlite_agents_ingest.ts";
const REPO = join(import.meta.dir, "../..");
const SCRATCH = join(REPO, "scratch");

const ingestFrom = (Bun.env.F402_INGEST_FROM ?? "tree").trim().toLowerCase();
const treePath =
  Bun.env.F402_PARSED_TREE_IN?.trim() || join(SCRATCH, "parsed-tree.json");
const rawEnvelopePath =
  Bun.env.F402_RAW_ENVELOPE?.trim() ||
  join(SCRATCH, "raw-f402-list-agents.json");
const dbPath =
  Bun.env.F402_AGENTS_DB?.trim() || join(SCRATCH, "manager-agents.sqlite");

if (!treePath.startsWith(`${SCRATCH}/`)) {
  throw new Error("F402_PARSED_TREE_IN must be under scratch/");
}
if (!dbPath.startsWith(`${SCRATCH}/`)) {
  throw new Error("F402_AGENTS_DB must be under scratch/");
}

const generalResult =
  ingestFrom === "general"
    ? await (async () => {
        if (!rawEnvelopePath.startsWith(`${SCRATCH}/`)) {
          throw new Error("F402_RAW_ENVELOPE must be under scratch/");
        }
        const probe = generalProbeFromWireText(
          await Bun.file(rawEnvelopePath).text(),
        );
        const master = {
          masterId: Bun.env.F402_MASTER_ID?.trim() || "MASTER1",
          masterLogin: Bun.env.F402_MASTER_LOGIN?.trim() || "MASTER1",
        };
        return ingestManagerHierarchyFile(
          dbPath,
          { GENERAL: probe.general },
          master,
        );
      })()
    : null;
const result =
  generalResult ??
  ingestNormalizedTreeToSqlite(await Bun.file(treePath).json(), dbPath);

const log: Record<string, unknown> = {
  signal: "F402_AGENTS_INGESTED",
  dbPath: dbPath.replace(`${REPO}/`, ""),
  ingestFrom,
  rowCount: result.rowCount,
  cteRowCount: result.cteRowCount,
  ingestMs: result.ingestMs,
};
if (generalResult !== null) {
  log.envelopePath = rawEnvelopePath.replace(`${REPO}/`, "");
  log.generalRowCount = generalResult.generalRowCount;
  log.skippedOverflowCount = generalResult.skippedOverflow.length;
}
console.error(JSON.stringify(log));

if (result.rowCount !== result.cteRowCount) {
  throw new Error(
    `agents count ${result.rowCount} !== recursive CTE rows ${result.cteRowCount}`,
  );
}
