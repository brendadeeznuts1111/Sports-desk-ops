import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "bun:sqlite";

import {
  exportSettlementOutcomes,
  settlementOutcomesJsonl,
} from "../lib/settlement_outcomes.ts";
import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function newDbPath(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `settlement-${label}-`));
  roots.push(root);
  return join(root, "lifecycle.sqlite");
}

function withSchema(
  path: string,
  ddl: string,
  insert?: (db: Database) => void,
): string {
  const db = openSportsdeskSqlite(path);
  try {
    db.exec(ddl);
    insert?.(db);
  } finally {
    db.close();
  }
  return path;
}

const FULL_DDL = `
  CREATE TABLE wager_settlement_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    outcome TEXT,
    risk_cents INTEGER,
    to_win_cents INTEGER,
    amount_cents INTEGER,
    amount_refunded_cents INTEGER,
    valid_time TEXT NOT NULL
  );
`;

/** Legacy store created before the outcome/money split: no run_at, no amount columns. */
const LEGACY_DDL = `
  CREATE TABLE wager_settlement_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL,
    outcome TEXT,
    risk_cents INTEGER,
    to_win_cents INTEGER,
    valid_time TEXT NOT NULL
  );
`;

interface FullRow {
  run_at?: string | null;
  ticket_id: string;
  outcome: string | null;
  risk_cents?: number | null;
  to_win_cents?: number | null;
  amount_cents?: number | null;
  amount_refunded_cents?: number | null;
  valid_time: string;
}

const FULL_INSERT = `INSERT INTO wager_settlement_observations
  (run_at, ticket_id, outcome, risk_cents, to_win_cents, amount_cents, amount_refunded_cents, valid_time)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`;

function insertFull(db: Database, row: FullRow): void {
  db.query(FULL_INSERT).run(
    row.run_at ?? null,
    row.ticket_id,
    row.outcome,
    row.risk_cents ?? null,
    row.to_win_cents ?? null,
    row.amount_cents ?? null,
    row.amount_refunded_cents ?? null,
    row.valid_time,
  );
}

function dbWithRows(): string {
  return withSchema(newDbPath("full"), FULL_DDL, (db) => {
    // Older loss then newer win for the same ticket: the latest observation wins.
    insertFull(db, {
      run_at: "2026-11-04T10:00:00Z",
      ticket_id: "ALPHA|1",
      outcome: "L",
      risk_cents: 10000,
      to_win_cents: 9500,
      amount_cents: 0,
      amount_refunded_cents: 0,
      valid_time: "2026-11-04T10:00:00Z",
    });
    insertFull(db, {
      run_at: "2026-11-04T12:00:00Z",
      ticket_id: "ALPHA|1",
      outcome: "W",
      risk_cents: 10000,
      to_win_cents: 9500,
      amount_cents: 9500,
      amount_refunded_cents: 0,
      valid_time: "2026-11-04T12:00:00Z",
    });
    insertFull(db, {
      run_at: "2026-11-04T11:00:00Z",
      ticket_id: "BETA|2",
      outcome: "L",
      risk_cents: 5000,
      to_win_cents: 4000,
      amount_cents: 0,
      amount_refunded_cents: 0,
      valid_time: "2026-11-04T11:00:00Z",
    });
    insertFull(db, {
      run_at: "2026-11-04T11:00:00Z",
      ticket_id: "GAMMA|3",
      outcome: "V",
      risk_cents: 1000,
      to_win_cents: 900,
      amount_cents: 0,
      amount_refunded_cents: 1000,
      valid_time: "2026-11-04T11:00:00Z",
    });
    insertFull(db, {
      run_at: "2026-11-04T11:00:00Z",
      ticket_id: "DELTA|4",
      outcome: "P",
      risk_cents: 1000,
      to_win_cents: 900,
      amount_cents: 0,
      amount_refunded_cents: 1000,
      valid_time: "2026-11-04T11:00:00Z",
    });
    insertFull(db, {
      run_at: "2026-11-04T11:00:00Z",
      ticket_id: "NO-OUTCOME|5",
      outcome: null,
      risk_cents: 1000,
      to_win_cents: 900,
      amount_cents: 0,
      amount_refunded_cents: 0,
      valid_time: "2026-11-04T11:00:00Z",
    });
  });
}

describe("settlement outcomes export", () => {
  test("exports the latest decisive outcome per ticket with signed net", () => {
    const exported = exportSettlementOutcomes(dbWithRows());
    const byCustomer = new Map(
      exported.rows.map((row) => [row.customerId, row]),
    );
    expect(byCustomer.get("ALPHA")).toMatchObject({
      wagerNumber: "1",
      outcome: "win",
      netUsd: 95,
      source: "settlement_store",
    });
    expect(byCustomer.get("BETA")).toMatchObject({
      outcome: "loss",
      netUsd: -50,
    });
    expect(byCustomer.get("GAMMA")?.netUsd).toBe(0);
    expect(byCustomer.get("DELTA")?.netUsd).toBe(0);
    expect(byCustomer.has("NO-OUTCOME")).toBe(false);
    expect(exported.ok).toBe(true);
    expect(exported.tickets).toBe(5);
    expect(exported.skipped).toBe(1);
  });

  test("reports asOf as the freshest observation and the exported window", () => {
    const exported = exportSettlementOutcomes(dbWithRows());
    // All five tickets' latest observations span 11:00–12:00; asOf is the store maximum.
    expect(exported.asOf).toBe("2026-11-04T12:00:00Z");
    expect(exported.outcomeWindow).toEqual({
      from: "2026-11-04T11:00:00Z",
      to: "2026-11-04T12:00:00Z",
    });
  });

  test("JSONL output round-trips as normalized outcome rows", () => {
    const exported = exportSettlementOutcomes(dbWithRows());
    const lines = settlementOutcomesJsonl(exported.rows)
      .split("\n")
      .filter((line) => line !== "");
    expect(lines).toHaveLength(exported.rows.length);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      customerId: "ALPHA",
      wagerNumber: "1",
      outcome: "win",
    });
  });

  test("a missing database is MISSING, not an empty outcome set", () => {
    const path = newDbPath("missing");
    const exported = exportSettlementOutcomes(path);
    expect(exported.ok).toBe(false);
    expect(exported.reason).toBe("db_missing");
    expect(exported.rows).toEqual([]);
    expect(exported.asOf).toBeNull();
    expect(exported.outcomeWindow).toEqual({ from: null, to: null });
    // Never create the store as a side effect of a read.
    expect(existsSync(path)).toBe(false);
  });

  test("a present file without the observations table is schema_missing", () => {
    const path = withSchema(
      newDbPath("no-table"),
      "CREATE TABLE unrelated (id INTEGER PRIMARY KEY);",
    );
    const exported = exportSettlementOutcomes(path);
    expect(exported.ok).toBe(false);
    expect(exported.reason).toBe("schema_missing");
    expect(exported.rows).toEqual([]);
  });

  test("a table without ticket_id or a time column is schema_missing", () => {
    const noTicket = withSchema(
      newDbPath("no-ticket"),
      `CREATE TABLE wager_settlement_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        outcome TEXT,
        valid_time TEXT NOT NULL
      );`,
    );
    expect(exportSettlementOutcomes(noTicket).reason).toBe("schema_missing");

    const noTime = withSchema(
      newDbPath("no-time"),
      `CREATE TABLE wager_settlement_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL,
        outcome TEXT
      );`,
    );
    expect(exportSettlementOutcomes(noTime).reason).toBe("schema_missing");
  });

  test("a legacy store without run_at or amount columns still exports", () => {
    const path = withSchema(newDbPath("legacy"), LEGACY_DDL, (db) => {
      const insert = db.query(
        `INSERT INTO wager_settlement_observations
          (ticket_id, outcome, risk_cents, to_win_cents, valid_time)
          VALUES (?1, ?2, ?3, ?4, ?5)`,
      );
      insert.run("LEG1|1", "L", 1000, 900, "2026-11-04T10:00:00Z");
      insert.run("LEG1|1", "W", 1000, 900, "2026-11-04T12:00:00Z");
      insert.run("LEG2|2", "P", 500, 450, "2026-11-04T11:00:00Z");
    });

    const exported = exportSettlementOutcomes(path);
    expect(exported.ok).toBe(true);
    expect(exported.reason).toBeNull();
    expect(exported.tickets).toBe(2);
    expect(exported.skipped).toBe(0);
    const byCustomer = new Map(
      exported.rows.map((row) => [row.customerId, row]),
    );
    // amount_cents is absent, so the win falls back to to_win_cents (900¢ → $9).
    expect(byCustomer.get("LEG1")).toMatchObject({
      outcome: "win",
      netUsd: 9,
    });
    // amount_refunded_cents is absent, so push/void fall back to net 0.
    expect(byCustomer.get("LEG2")).toMatchObject({
      outcome: "push",
      netUsd: 0,
    });
    expect(exported.asOf).toBe("2026-11-04T12:00:00Z");
    expect(exported.outcomeWindow).toEqual({
      from: "2026-11-04T11:00:00Z",
      to: "2026-11-04T12:00:00Z",
    });
  });

  test("a null run_at falls back to valid_time for ordering and asOf", () => {
    const path = withSchema(
      newDbPath("null-run-at"),
      `CREATE TABLE wager_settlement_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_at TEXT,
        ticket_id TEXT NOT NULL,
        outcome TEXT,
        risk_cents INTEGER,
        to_win_cents INTEGER,
        amount_cents INTEGER,
        amount_refunded_cents INTEGER,
        valid_time TEXT NOT NULL
      );`,
      (db) => {
        insertFull(db, {
          run_at: "2026-11-04T09:00:00Z",
          ticket_id: "X|1",
          outcome: "L",
          risk_cents: 1000,
          valid_time: "2026-11-04T09:00:00Z",
        });
        insertFull(db, {
          run_at: null,
          ticket_id: "X|1",
          outcome: "W",
          risk_cents: 1000,
          to_win_cents: 1000,
          amount_cents: 1200,
          valid_time: "2026-11-04T10:00:00Z",
        });
      },
    );

    const exported = exportSettlementOutcomes(path);
    expect(exported.rows).toHaveLength(1);
    expect(exported.rows[0]?.outcome).toBe("win");
    expect(exported.rows[0]?.netUsd).toBe(12);
    expect(exported.asOf).toBe("2026-11-04T10:00:00Z");
    expect(exported.outcomeWindow).toEqual({
      from: "2026-11-04T10:00:00Z",
      to: "2026-11-04T10:00:00Z",
    });
  });

  test("duplicate observations on one instant pick the highest id", () => {
    const path = withSchema(newDbPath("tie-break"), FULL_DDL, (db) => {
      insertFull(db, {
        run_at: "2026-11-04T10:00:00Z",
        ticket_id: "TIE|1",
        outcome: "L",
        risk_cents: 1000,
        amount_cents: 0,
        valid_time: "2026-11-04T10:00:00Z",
      });
      insertFull(db, {
        run_at: "2026-11-04T10:00:00Z",
        ticket_id: "TIE|1",
        outcome: "W",
        risk_cents: 1000,
        to_win_cents: 500,
        amount_cents: 500,
        valid_time: "2026-11-04T10:00:00Z",
      });
    });

    const exported = exportSettlementOutcomes(path);
    expect(exported.rows).toHaveLength(1);
    expect(exported.rows[0]).toMatchObject({ outcome: "win", netUsd: 5 });
  });

  test("asOf spans skipped rows while the window covers only exported ones", () => {
    const path = withSchema(newDbPath("asof"), FULL_DDL, (db) => {
      insertFull(db, {
        run_at: "2026-11-04T10:00:00Z",
        ticket_id: "ONE|1",
        outcome: "W",
        risk_cents: 1000,
        amount_cents: 1100,
        valid_time: "2026-11-04T10:00:00Z",
      });
      insertFull(db, {
        run_at: "2026-11-04T11:00:00Z",
        ticket_id: "TWO|2",
        outcome: "L",
        risk_cents: 1000,
        amount_cents: 0,
        valid_time: "2026-11-04T11:00:00Z",
      });
      insertFull(db, {
        run_at: "2026-11-04T13:00:00Z",
        ticket_id: "SKIPPED|9",
        outcome: null,
        risk_cents: 1000,
        valid_time: "2026-11-04T13:00:00Z",
      });
    });

    const exported = exportSettlementOutcomes(path);
    expect(exported.rows).toHaveLength(2);
    expect(exported.tickets).toBe(3);
    expect(exported.skipped).toBe(1);
    expect(exported.asOf).toBe("2026-11-04T13:00:00Z");
    expect(exported.outcomeWindow).toEqual({
      from: "2026-11-04T10:00:00Z",
      to: "2026-11-04T11:00:00Z",
    });
  });

  test("a table with neither outcome nor result is schema_missing, not an empty success", () => {
    const path = withSchema(
      newDbPath("no-outcome"),
      `CREATE TABLE wager_settlement_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL,
        risk_cents INTEGER,
        to_win_cents INTEGER,
        valid_time TEXT NOT NULL
      );`,
      (db) => {
        db.query(
          `INSERT INTO wager_settlement_observations
            (ticket_id, risk_cents, to_win_cents, valid_time)
            VALUES ('N|1', 1000, 900, '2026-11-04T10:00:00Z')`,
        ).run();
      },
    );

    const exported = exportSettlementOutcomes(path);
    expect(exported.ok).toBe(false);
    expect(exported.reason).toBe("schema_missing");
    expect(exported.rows).toEqual([]);
  });

  test("a table without an id column still orders via rowid", () => {
    const path = withSchema(
      newDbPath("no-id"),
      `CREATE TABLE wager_settlement_observations (
        run_at TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        outcome TEXT,
        risk_cents INTEGER,
        amount_cents INTEGER,
        valid_time TEXT NOT NULL
      );`,
      (db) => {
        db.query(
          `INSERT INTO wager_settlement_observations
            (run_at, ticket_id, outcome, risk_cents, amount_cents, valid_time)
            VALUES ('2026-11-04T10:00:00Z', 'R|1', 'L', 1000, 0, '2026-11-04T10:00:00Z')`,
        ).run();
        db.query(
          `INSERT INTO wager_settlement_observations
            (run_at, ticket_id, outcome, risk_cents, amount_cents, valid_time)
            VALUES ('2026-11-04T11:00:00Z', 'R|1', 'W', 1000, 2000, '2026-11-04T11:00:00Z')`,
        ).run();
      },
    );

    const exported = exportSettlementOutcomes(path);
    expect(exported.rows).toHaveLength(1);
    expect(exported.rows[0]).toMatchObject({ outcome: "win", netUsd: 20 });
  });

  test("an empty observations table still exports with null metadata", () => {
    const path = withSchema(newDbPath("empty"), FULL_DDL);
    const exported = exportSettlementOutcomes(path);
    expect(exported.ok).toBe(true);
    expect(exported.rows).toEqual([]);
    expect(exported.tickets).toBe(0);
    expect(exported.skipped).toBe(0);
    expect(exported.asOf).toBeNull();
    expect(exported.outcomeWindow).toEqual({ from: null, to: null });
  });

  test("exporting is read-only: it does not mutate or create the store", () => {
    const path = dbWithRows();
    const before = openSportsdeskSqlite(path);
    const beforeCount = before
      .query("SELECT COUNT(*) AS n FROM wager_settlement_observations")
      .get() as { n: number };
    before.close();

    const first = exportSettlementOutcomes(path);
    const second = exportSettlementOutcomes(path);
    expect(second.rows).toEqual(first.rows);
    expect(second.asOf).toBe(first.asOf);

    const after = openSportsdeskSqlite(path);
    const afterCount = after
      .query("SELECT COUNT(*) AS n FROM wager_settlement_observations")
      .get() as { n: number };
    after.close();
    expect(Number(afterCount.n)).toBe(Number(beforeCount.n));
  });

  test("a migrated legacy store with only a result column still exports", () => {
    const path = withSchema(
      newDbPath("result-only"),
      `CREATE TABLE wager_settlement_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL,
        result TEXT,
        risk_cents INTEGER,
        to_win_cents INTEGER,
        valid_time TEXT NOT NULL
      );`,
      (db) => {
        const insert = db.query(
          `INSERT INTO wager_settlement_observations
            (ticket_id, result, risk_cents, to_win_cents, valid_time)
            VALUES (?1, ?2, ?3, ?4, ?5)`,
        );
        insert.run("LEGACY|1", "WIN", 1000, 900, "2026-11-04T10:00:00Z");
        insert.run("LEGACY|2", "LOSS", 1000, 900, "2026-11-04T10:01:00Z");
      },
    );
    const exported = exportSettlementOutcomes(path);
    expect(exported.ok).toBe(true);
    expect(exported.rows).toHaveLength(2);
    expect(exported.rows.find((row) => row.wagerNumber === "1")).toMatchObject({
      outcome: "win",
      netUsd: 9,
    });
    expect(exported.rows.find((row) => row.wagerNumber === "2")).toMatchObject({
      outcome: "loss",
      netUsd: -10,
    });
  });

  test("mixed run_at offsets are ordered by parsed instant, not text", () => {
    const path = withSchema(
      newDbPath("mixed-offset"),
      `CREATE TABLE wager_settlement_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_at TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        outcome TEXT,
        risk_cents INTEGER,
        to_win_cents INTEGER,
        amount_cents INTEGER,
        amount_refunded_cents INTEGER,
        valid_time TEXT NOT NULL
      );`,
      (db) => {
        const insert = db.query(
          `INSERT INTO wager_settlement_observations
            (run_at, ticket_id, outcome, risk_cents, to_win_cents, amount_cents, amount_refunded_cents, valid_time)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        );
        // 17:00Z observation (written with a -05:00 offset) must beat the earlier 16:00Z row.
        insert.run(
          "2026-11-04T12:00:00-05:00",
          "MIXED|1",
          "W",
          1000,
          900,
          900,
          0,
          "2026-11-04T10:00:00Z",
        );
        insert.run(
          "2026-11-04T16:00:00Z",
          "MIXED|1",
          "L",
          1000,
          900,
          0,
          0,
          "2026-11-04T16:00:00Z",
        );
      },
    );
    const exported = exportSettlementOutcomes(path);
    expect(exported.rows[0]).toMatchObject({ outcome: "win", netUsd: 9 });
  });

  test("a WIN with non-positive money exports null, never a negative winner", () => {
    const path = withSchema(
      newDbPath("sign-guard"),
      `CREATE TABLE wager_settlement_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_at TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        outcome TEXT,
        risk_cents INTEGER,
        to_win_cents INTEGER,
        amount_cents INTEGER,
        amount_refunded_cents INTEGER,
        valid_time TEXT NOT NULL
      );`,
      (db) => {
        db.query(
          `INSERT INTO wager_settlement_observations
            (run_at, ticket_id, outcome, risk_cents, to_win_cents, amount_cents, amount_refunded_cents, valid_time)
            VALUES ('2026-11-04T10:00:00Z', 'SIGN|1', 'W', 1000, 0, -500, 0, '2026-11-04T10:00:00Z')`,
        ).run();
      },
    );
    const exported = exportSettlementOutcomes(path);
    expect(exported.rows[0]?.outcome).toBe("win");
    expect(exported.rows[0]?.netUsd).toBeNull();
  });
});
