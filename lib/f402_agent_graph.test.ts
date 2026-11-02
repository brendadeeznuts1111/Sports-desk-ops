import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  buildAgentGraph,
  cytoscapeGraphFromAgentsDb,
} from "./f402_agent_graph.ts";
import { openSportsdeskSqlite } from "./sportsdesk_sqlite.ts";
import { AGENTS_TABLE_DDL } from "./f402_sqlite_agents_ingest.ts";
import { ingestManagerHierarchy } from "./f402_manager_hierarchy_ingest.ts";
import type { ListAgentsByAgentGeneralWireRow } from "./f402_list_agents_by_agent.ts";
import type { PortalHierarchyParserContext } from "./f402_portal_hierarchy_parser.ts";

const REPO = join(import.meta.dir, "..");
const SNIPPET = join(
  REPO,
  "tests/fixtures/f402-list-agents-by-agent-snippet.json",
);

const CTX: PortalHierarchyParserContext = {
  masterId: "MASTER1",
  masterLogin: "MASTER1",
};

describe("f402_agent_graph", () => {
  test("buildAgentGraph from envelope ingests GENERAL only and exports edges", async () => {
    const envelope = JSON.parse(await Bun.file(SNIPPET).text()) as {
      GENERAL: ListAgentsByAgentGeneralWireRow[];
      PLAYERS: unknown[];
    };
    const result = await buildAgentGraph({
      dbPath: ":memory:",
      parserContext: CTX,
      rootAgentId: "MASTER1",
      envelope: { GENERAL: envelope.GENERAL },
    });
    expect(result.ingest.rowCount).toBeGreaterThan(0);
    expect(result.graph.nodes.length).toBe(result.ingest.rowCount);
    expect(result.graph.edges.length).toBeGreaterThan(0);
    expect(result.weeklyMetrics).toBeNull();
  });

  test("cytoscapeGraphFromAgentsDb carries the weekly figure at graph level, never on nodes", async () => {
    const db = openSportsdeskSqlite(":memory:");
    try {
      db.exec(AGENTS_TABLE_DDL);
      const envelope = JSON.parse(await Bun.file(SNIPPET).text()) as {
        GENERAL: ListAgentsByAgentGeneralWireRow[];
      };
      ingestManagerHierarchy(db, { GENERAL: envelope.GENERAL }, CTX);
      const bare = cytoscapeGraphFromAgentsDb(db);
      const weekly = {
        agentId: "BILLY666",
        figure: { kind: "figures", activePlayers: 7, thisWeek: 100, today: null },
        fetchedAt: "2026-11-01T18:00:00.000Z",
      } as const;
      const withWeekly = cytoscapeGraphFromAgentsDb(db, { weekly });
      expect("weekly" in bare).toBe(false);
      expect(withWeekly.weekly).toEqual(weekly);
      expect(withWeekly.nodes.some((n) => n.data.id === "BILLY666")).toBe(false);
      expect(withWeekly.nodes.every((n) => n.data.metrics === null)).toBe(true);
    } finally {
      db.close();
    }
  });
});
