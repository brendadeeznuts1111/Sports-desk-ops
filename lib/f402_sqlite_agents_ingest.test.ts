import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  normalizeNested,
  parsePortalGeneralRows,
} from "./f402_portal_hierarchy_oracle.ts";
import { parseProductionOracleFixtureText } from "./f402_production_fixture_redaction.ts";
import {
  countAgentTreeCteRows,
  flatAgentsFromPortalParse,
  flattenNormalizedHierarchyTree,
  ingestFlatAgentsWithTiming,
  ingestGeneralToSqlite,
} from "./f402_sqlite_agents_ingest.ts";
import { openSportsdeskSqlite } from "./sportsdesk_sqlite.ts";

describe("f402_sqlite_agents_ingest", () => {
  test("production fixture → 2466 flat rows and CTE parity", async () => {
    const fixturePath = join(
      import.meta.dir,
      "../tests/fixtures/f402-general-oracle-production.json",
    );
    const text = await Bun.file(fixturePath).text();
    const fixture = parseProductionOracleFixtureText(text);
    const general = parsePortalGeneralRows(fixture.GENERAL);
    expect(general.length).toBe(2466);

    const ctx = { masterId: "MASTER1", masterLogin: "MASTER1" };
    const flat = flatAgentsFromPortalParse(general, ctx);
    expect(flat.length).toBe(2277);

    const dir = mkdtempSync(join(tmpdir(), "f402-agents-"));
    const dbPath = join(dir, "agents.sqlite");
    try {
      const result = ingestGeneralToSqlite(general, ctx, dbPath);
      expect(result.rowCount).toBe(2277);
      expect(result.cteRowCount).toBe(2277);
      expect(result.ingestMs).toBeLessThan(500);

      const db = openSportsdeskSqlite(dbPath, { readonly: true });
      const level2 = db
        .query(`SELECT agent_id, parent_id FROM agents WHERE level = 2 LIMIT 1`)
        .get() as { agent_id: string; parent_id: string | null };
      expect(level2.parent_id).toBeString();
      const parent = db
        .query(`SELECT level FROM agents WHERE agent_id = ?`)
        .get(level2.parent_id!) as { level: number | bigint };
      expect(Number(parent.level)).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Levels 1–3 chain parent_id links", () => {
    const tree = normalizeNested({
      ROOT: {
        AgentID: "ROOT ",
        Login: "ROOT",
        Level: 1,
        AgentType: "M",
        SeqNumber: 1,
        CHILD: {
          AgentID: "CHILD ",
          Login: "CHILD",
          Level: 2,
          AgentType: "M",
          SeqNumber: 2,
          GRAND: {
            AgentID: "GRAND ",
            Login: "GRAND",
            Level: 3,
            AgentType: "A",
            SeqNumber: 3,
          },
        },
      },
    });
    const flat = flattenNormalizedHierarchyTree(tree);
    expect(flat).toHaveLength(3);
    const byId = new Map(flat.map((r) => [r.agent_id, r]));
    expect(byId.get("ROOT")?.parent_id).toBeNull();
    expect(byId.get("CHILD")?.parent_id).toBe("ROOT");
    expect(byId.get("GRAND")?.parent_id).toBe("CHILD");

    const db = openSportsdeskSqlite(":memory:");
    ingestFlatAgentsWithTiming(db, flat);
    expect(countAgentTreeCteRows(db)).toBe(3);
    db.close();
  });
});
