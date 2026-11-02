/**
 * Manager boot: envelope → flat `agents` SQLite (CLI-ready, probe-proven).
 * Uses GENERAL only; PLAYERS must not be retained by callers before invoke.
 */

import type { Database } from "bun:sqlite";

import type { ListAgentsByAgentGeneralWireRow } from "./f402_list_agents_by_agent.ts";
import type { PortalHierarchyParserContext } from "./f402_portal_hierarchy_parser.ts";
import {
  parsePortalGeneralRows,
  type PortalGeneralRow,
} from "./f402_portal_hierarchy_oracle.ts";
import {
  countAgentTreeCteRows,
  flatAgentsFromPortalParse,
  ingestFlatAgentsWithTiming,
  type IngestAgentsResult,
} from "./f402_sqlite_agents_ingest.ts";
import { openSportsdeskSqlite } from "./sportsdesk_sqlite.ts";

/** Matches pinned portal `baseHeriarchy` (levels 1–12). */
export const PORTAL_HIERARCHY_PARSER_MAX_LEVEL = 12;

export interface SkippedOverflowAgent {
  readonly agent_id: string;
  readonly level: number;
}

type GeneralRowsEnvelope = {
  readonly GENERAL: readonly ListAgentsByAgentGeneralWireRow[];
};

export interface ManagerHierarchyIngestResult extends IngestAgentsResult {
  readonly generalRowCount: number;
  readonly skippedOverflow: readonly SkippedOverflowAgent[];
}

export function listSkippedOverflowAgents(
  general: readonly PortalGeneralRow[],
): SkippedOverflowAgent[] {
  const out: SkippedOverflowAgent[] = [];
  for (const row of general) {
    const level = Number(row.Level);
    if (level > PORTAL_HIERARCHY_PARSER_MAX_LEVEL) {
      out.push({
        agent_id: String(row.AgentID).trim(),
        level,
      });
    }
  }
  return out;
}

/**
 * Ingest manager hierarchy into an open SQLite database.
 * Level 13+ rows are skipped (not in agentMap); returned in `skippedOverflow`.
 */
export function ingestManagerHierarchy(
  db: Database,
  envelope: GeneralRowsEnvelope,
  ctx: PortalHierarchyParserContext,
): ManagerHierarchyIngestResult {
  const general = parsePortalGeneralRows(envelope.GENERAL);
  const skippedOverflow = listSkippedOverflowAgents(general);
  const flat = flatAgentsFromPortalParse(general, ctx);
  const { rowCount, ingestMs } = ingestFlatAgentsWithTiming(db, flat);
  const cteRowCount = countAgentTreeCteRows(db);
  return {
    generalRowCount: general.length,
    skippedOverflow,
    rowCount,
    ingestMs,
    cteRowCount,
  };
}

export function ingestManagerHierarchyFile(
  dbPath: string,
  envelope: GeneralRowsEnvelope,
  ctx: PortalHierarchyParserContext,
): ManagerHierarchyIngestResult {
  const db = openSportsdeskSqlite(dbPath);
  try {
    return ingestManagerHierarchy(db, envelope, ctx);
  } finally {
    db.close();
  }
}
