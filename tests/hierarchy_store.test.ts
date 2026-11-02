import { describe, expect, test } from "bun:test";
import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";
import {
  descendantsOf,
  HIERARCHY_TABLE_DDL,
  loadHierarchy,
  subtreeCounts,
} from "../lib/hierarchy_store.ts";
import type { RawHierarchyTree } from "../lib/hierarchy_view.ts";

/**
 * The store exists so the tree's two hard questions — "how many under this node" and "where does
 * the level field disagree with the edges" — are queries, not per-reader walks.
 */

const tree = (await Bun.file(
  new URL("../data/agent-tree.json", import.meta.url),
).json()) as RawHierarchyTree;

function freshDb() {
  const db = openSportsdeskSqlite(":memory:");
  db.run(HIERARCHY_TABLE_DDL);
  return db;
}

describe("loadHierarchy", () => {
  test("loads every node, including the one with no level", () => {
    const db = freshDb();
    const loaded = loadHierarchy(db, tree, 1_700_000_000_000);
    expect(loaded.rowCount).toBe(2276);
    expect(loaded.roots).toEqual([
      "BILLY667",
      "NOLAWOLF",
      "RTEST5",
      "SAINTS2009",
    ]);
    expect(loaded.collisions).toBe(1);
    expect(loaded.unlevelled).toBe(1);
    // Roots have no parent, so their delta is null too: 4 roots + the collision subtree.
    expect(loaded.levelDeltas).toEqual({
      "1": 1951,
      "2": 208,
      "0": 110,
      null: 7,
    });
    db.close();
  });

  test("is idempotent: a second load rewrites, it does not duplicate", () => {
    const db = freshDb();
    loadHierarchy(db, tree, 1);
    loadHierarchy(db, tree, 2);
    const count = db
      .query("SELECT COUNT(*) AS n FROM hierarchy_nodes")
      .get() as {
      n: number | bigint;
    };
    expect(Number(count.n)).toBe(2276);
    const br = db
      .query(
        "SELECT portal_level, level_delta FROM hierarchy_nodes WHERE login = 'BRANDON'",
      )
      .get() as { portal_level: number | null; level_delta: number | null };
    expect(br.portal_level).toBeNull();
    expect(br.level_delta).toBeNull();
    db.close();
  });

  test("stores the level delta that makes the defect queryable", () => {
    const db = freshDb();
    loadHierarchy(db, tree, 1);
    const row = db
      .query(
        "SELECT level_delta, capture_depth FROM hierarchy_nodes WHERE login = 'CSLEVEL1'",
      )
      .get() as { level_delta: number; capture_depth: number | bigint };
    expect(Number(row.level_delta)).toBe(2); // parent TESTMA9 is level 4, this node is level 6
    expect(Number(row.capture_depth)).toBe(4);
    db.close();
  });
});

describe("queries", () => {
  test("subtreeCounts is inclusive and matches the fold", () => {
    const db = freshDb();
    loadHierarchy(db, tree, 1);
    const wolf = subtreeCounts(db, "NOLAWOLF");
    expect(wolf.total).toBe(2273); // 2,272 descendants + itself
    expect(wolf.byKind).toEqual({ agent: 1677, master: 595, unknown: 1 });
    expect(subtreeCounts(db, "YASKYY").total).toBe(1); // a leaf
    db.close();
  });

  test("descendantsOf returns each login once", () => {
    const db = freshDb();
    loadHierarchy(db, tree, 1);
    const logins = descendantsOf(db, "NOLAWOLF");
    expect(logins).toHaveLength(2273);
    expect(new Set(logins).size).toBe(2273);
    db.close();
  });

  test("a cycle in the table terminates instead of hanging", () => {
    const db = freshDb();
    const insert = db.prepare(
      "INSERT INTO hierarchy_nodes (login, parent_login, kind, portal_level, capture_depth, level_delta, collision, loaded_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    insert.run("A", "B", "agent", 1, 0, null, 0, 1);
    insert.run("B", "A", "agent", 1, 0, null, 0, 1);
    // UNION dedupes, so the walk stops; UNION ALL would not.
    expect([...descendantsOf(db, "A")].sort()).toEqual(["A", "B"]);
    db.close();
  });
});
