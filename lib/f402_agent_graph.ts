/**
 * Hierarchy envelope → SQLite → Cytoscape export (GENERAL-only ingest path).
 */

import type { Database } from "bun:sqlite";

import {
  buildListAgentsReplayPlan,
  fetchListAgentsEnvelope,
  loadAccountInfoOwnerFixture,
  type AccountInfoOwnerFixture,
  type ListAgentsRequestFixture,
} from "./f402_hierarchy_replay.ts";
import {
  ingestManagerHierarchy,
  type ManagerHierarchyIngestResult,
} from "./f402_manager_hierarchy_ingest.ts";
import type { ListAgentsByAgentEnvelope } from "./f402_list_agents_by_agent.ts";
import type { PortalHierarchyParserContext } from "./f402_portal_hierarchy_parser.ts";
import { AGENTS_TABLE_DDL } from "./f402_sqlite_agents_ingest.ts";
import type { F402ReplayTransport } from "./f402_replay_transport.ts";
import { openSportsdeskSqlite } from "./sportsdesk_sqlite.ts";
import {
  fetchWeeklyFigureByAgentLite,
  type StoredWeeklyFigureLite,
  type WeeklyFigureLiteRequest,
} from "./f402_weekly_figure_lite.ts";

export interface AgentGraphNodeData {
  readonly id: string;
  readonly label: string;
  readonly level: number;
  readonly seqNumber: number | null;
  readonly metrics: unknown | null;
}

export interface AgentGraphEdgeData {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface CytoscapeGraphExport {
  readonly nodes: readonly { readonly data: AgentGraphNodeData }[];
  readonly edges: readonly { readonly data: AgentGraphEdgeData }[];
  readonly weekly?: StoredWeeklyFigureLite;
}

interface AgentRow {
  readonly agent_id: string;
  readonly login: string;
  readonly level: number;
  readonly parent_id: string | null;
  readonly seq_number: number | null;
}

export function cytoscapeGraphFromAgentsDb(
  db: Database,
  options?: { readonly weekly?: StoredWeeklyFigureLite | null },
): CytoscapeGraphExport {
  const agents = db
    .query(
      "SELECT agent_id, login, level, parent_id, seq_number FROM agents ORDER BY level, agent_id",
    )
    .all() as AgentRow[];
  const nodes = agents.map((a) => ({
    data: {
      id: a.agent_id,
      label: a.login,
      level: Number(a.level),
      seqNumber: a.seq_number === null ? null : Number(a.seq_number),
      metrics: null,
    },
  }));
  const edges = agents
    .filter((a) => a.parent_id !== null && a.parent_id !== "")
    .map((a) => ({
      data: {
        id: `${a.parent_id}->${a.agent_id}`,
        source: a.parent_id as string,
        target: a.agent_id,
      },
    }));
  return options?.weekly ? { nodes, edges, weekly: options.weekly } : { nodes, edges };
}

export async function fetchHierarchyEnvelopeForGraph(
  transport: F402ReplayTransport,
  account: AccountInfoOwnerFixture,
  bodyFixture?: ListAgentsRequestFixture,
): Promise<{
  readonly envelope: ListAgentsByAgentEnvelope;
  readonly envelopeText: string;
}> {
  const plan = buildListAgentsReplayPlan(account, {
    agentOwner: bodyFixture?.agentOwner ?? account.agentID,
    ...bodyFixture,
  });
  const { envelope, envelopeText } = await fetchListAgentsEnvelope(
    plan,
    transport,
  );
  return { envelope, envelopeText };
}

export interface BuildAgentGraphOptions {
  readonly dbPath: string;
  readonly parserContext: PortalHierarchyParserContext;
  readonly rootAgentId: string;
  readonly envelope?: Pick<ListAgentsByAgentEnvelope, "GENERAL">;
  readonly transport?: F402ReplayTransport;
  readonly account?: AccountInfoOwnerFixture;
  readonly bodyFixture?: ListAgentsRequestFixture;
  readonly fetchWeeklyForRoot?: boolean;
}

export interface BuildAgentGraphResult {
  readonly ingest: ManagerHierarchyIngestResult;
  readonly graph: CytoscapeGraphExport;
  readonly weeklyMetrics: StoredWeeklyFigureLite | null;
}

export async function buildAgentGraph(
  options: BuildAgentGraphOptions,
): Promise<BuildAgentGraphResult> {
  let envelope: Pick<ListAgentsByAgentEnvelope, "GENERAL">;
  if (options.envelope !== undefined) {
    envelope = options.envelope;
  } else if (
    options.transport !== undefined &&
    options.account !== undefined
  ) {
    const { envelope: full } = await fetchHierarchyEnvelopeForGraph(
      options.transport,
      options.account,
      options.bodyFixture,
    );
    envelope = { GENERAL: full.GENERAL };
  } else {
    throw new Error(
      "buildAgentGraph requires envelope or (transport + account)",
    );
  }

  const db = openSportsdeskSqlite(options.dbPath);
  try {
    db.exec(AGENTS_TABLE_DDL);
    const ingest = ingestManagerHierarchy(db, envelope, options.parserContext);
    let weeklyMetrics: StoredWeeklyFigureLite | null = null;
    if (options.fetchWeeklyForRoot && options.transport !== undefined) {
      const weeklyReq: WeeklyFigureLiteRequest = {
        agentID: options.rootAgentId,
        agentOwner: options.rootAgentId,
      };
      const figure = await fetchWeeklyFigureByAgentLite(
        options.transport,
        weeklyReq,
      );
      weeklyMetrics = {
        agentId: options.rootAgentId,
        figure,
        fetchedAt: new Date().toISOString(),
      };
    }
    const graph = cytoscapeGraphFromAgentsDb(db, { weekly: weeklyMetrics });
    return { ingest, graph, weeklyMetrics };
  } finally {
    db.close();
  }
}

export async function loadAccountFixtureFromFile(
  path: string,
): Promise<AccountInfoOwnerFixture> {
  const raw = JSON.parse(await Bun.file(path).text()) as unknown;
  return loadAccountInfoOwnerFixture(raw);
}
