import { describe, expect, test } from "bun:test";
import { groupByOfficeStore, parseAccountInfo } from "../lib/account_info.ts";
import {
  applyAccountInfo,
  enrichedRows,
  HIERARCHY_TABLE_DDL,
  loadHierarchy,
} from "../lib/hierarchy_store.ts";
import type { RawHierarchyTree } from "../lib/hierarchy_view.ts";
import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";

/**
 * `getAccountInfoOwner` is the only thing that can say which office a tree node sits in — the tree
 * itself carries `{ l, p, t }` and nothing else. The values below are the fields observed on
 * 2026-11-02 for BILLY666; the second envelope is synthetic and is labelled as such.
 */

const observedBilly = {
  accountInfo: {
    customerID: "BILLY666",
    AgentID: null,
    AgentType: "M",
    Office: "NOLAROSE",
    Store: "PPHINSIDER          ",
    Login: "BILLY666  ",
    DefaultSiteSkin: "RiseOfSnake",
    AgentMenuStyle: "Tile Menu",
    Password: "",
  },
  SERVER: { date: "2026-11-01 22:25:16.233" },
  site: [],
  SKIN: "M",
};

describe("parseAccountInfo", () => {
  test("trims the padded login and keeps customerID unpadded", () => {
    const info = parseAccountInfo(observedBilly);
    expect(info.login).toBe("BILLY666");
    expect(info.customerId).toBe("BILLY666");
    expect(info.key).toBe("BILLY666");
    expect(info.store).toBe("PPHINSIDER");
    expect(info.office).toBe("NOLAROSE");
  });

  test("AgentID null on a master account stays null", () => {
    const info = parseAccountInfo(observedBilly);
    expect(info.agentType).toBe("M");
    expect(info.agentId).toBeNull();
  });

  test("accepts the inner object as well as the envelope", () => {
    const info = parseAccountInfo(observedBilly.accountInfo);
    expect(info.key).toBe("BILLY666");
    expect(info.skin).toBeNull(); // SKIN lives on the envelope
  });

  test("falls back to customerID when Login is absent", () => {
    const info = parseAccountInfo({ accountInfo: { customerID: "KOBE8" } });
    expect(info.key).toBe("KOBE8");
    expect(info.login).toBe("");
  });

  test("rejects a response with neither field, and non-objects", () => {
    expect(() => parseAccountInfo({ accountInfo: {} })).toThrow();
    expect(() => parseAccountInfo("nope")).toThrow();
  });
});

describe("groupByOfficeStore", () => {
  test("groups nodes and lists the roots of each group", () => {
    const groups = groupByOfficeStore([
      { login: "A", office: "NOLAROSE", store: "PPHINSIDER", isRoot: true },
      { login: "B", office: "NOLAROSE", store: "PPHINSIDER", isRoot: false },
      { login: "C", office: "NOLAROSE", store: "GSLIVE", isRoot: true },
      { login: "D", office: null, store: null, isRoot: true },
    ]);
    expect(
      groups.map((group) => `${group.office}/${group.store}:${group.nodes}`),
    ).toEqual(["/:1", "NOLAROSE/GSLIVE:1", "NOLAROSE/PPHINSIDER:2"]);
    const office = groups.find((group) => group.store === "PPHINSIDER");
    expect(office?.roots).toEqual(["A"]);
  });

  test("empty fields are a group, not dropped — they are the unenriched set", () => {
    const groups = groupByOfficeStore([
      { login: "X", office: "", store: "", isRoot: true },
    ]);
    expect(groups).toEqual([{ office: "", store: "", nodes: 1, roots: ["X"] }]);
  });
});

describe("applyAccountInfo", () => {
  const tree: RawHierarchyTree = {
    roots: ["ROOT"],
    nodes: {
      ROOT: { l: 1, t: "M" },
      CHILD: { l: 2, p: "ROOT", t: "A" },
    },
  };

  test("writes office/store/skin and reports responses the tree does not know", () => {
    const db = openSportsdeskSqlite(":memory:");
    db.run(HIERARCHY_TABLE_DDL);
    loadHierarchy(db, tree, 1);

    const result = applyAccountInfo(db, [
      { key: "ROOT", office: "NOLAROSE", store: "PPHINSIDER", skin: "M" },
      { key: "GHOST", office: "NOLAROSE", store: "PPHINSIDER", skin: null },
    ]);
    expect(result.matched).toBe(1);
    expect(result.unmatched).toEqual(["GHOST"]);

    const rows = enrichedRows(db);
    const root = rows.find((row) => row.login === "ROOT");
    expect(root).toMatchObject({
      office: "NOLAROSE",
      store: "PPHINSIDER",
      isRoot: true,
    });
    const child = rows.find((row) => row.login === "CHILD");
    expect(child?.office).toBeNull();
    expect(child?.isRoot).toBe(false);
    db.close();
  });

  test("adds the enrichment columns to a table created without them", () => {
    const db = openSportsdeskSqlite(":memory:");
    db.run(`CREATE TABLE hierarchy_nodes (
      login TEXT PRIMARY KEY, parent_login TEXT, kind TEXT NOT NULL,
      portal_level INTEGER, capture_depth INTEGER NOT NULL, level_delta INTEGER,
      collision INTEGER NOT NULL DEFAULT 0, loaded_at INTEGER NOT NULL
    )`);
    db.run(
      "INSERT INTO hierarchy_nodes (login, kind, capture_depth, loaded_at) VALUES ('OLD','agent',0,1)",
    );
    expect(
      applyAccountInfo(db, [
        { key: "OLD", office: "NOLAROSE", store: "PPHINSIDER", skin: null },
      ]).matched,
    ).toBe(1);
    db.close();
  });
});
