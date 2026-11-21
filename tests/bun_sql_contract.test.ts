/**
 * @file tests/bun_sql_contract.test.ts
 * @description Offline contract tests for Bun's `sql` and `SQL` exports (`sqlite://:memory:`).
 */
import { describe, expect, test } from "bun:test";
import { sql, SQL } from "bun";

// @bun-behavior: bun-sql-globals

describe("Bun sql / SQL contract", () => {
  test("named exports from 'bun' match Bun.sql and Bun.SQL", () => {
    expect(sql).toBe(Bun.sql);
    expect(SQL).toBe(Bun.SQL);
    expect(typeof SQL).toBe("function");
    expect(sql).toBeInstanceOf(SQL);
  });

  test("tagged template interpolation binds parameters and blocks SQL injection", async () => {
    const db = new SQL("sqlite://:memory:");
    try {
      await db`
        CREATE TABLE wagers (
          id INTEGER PRIMARY KEY,
          status TEXT NOT NULL,
          stake_cents INTEGER NOT NULL
        )
      `;
      await db`
        INSERT INTO wagers (id, status, stake_cents) VALUES
          (${1}, ${"OPEN"}, ${15000}),
          (${2}, ${"OPEN"}, ${5000}),
          (${3}, ${"SETTLED"}, ${25000})
      `;

      const active = await db`
        SELECT id, status FROM wagers
        WHERE status = ${"OPEN"} AND stake_cents >= ${10000}
      `;
      expect([...active]).toEqual([{ id: 1, status: "OPEN" }]);

      const injection = "OPEN' OR 1=1 --";
      const injected = await db`
        SELECT id FROM wagers WHERE status = ${injection}
      `;
      expect([...injected]).toEqual([]);
    } finally {
      await db.close();
    }
  });

  test("db(rows) performs bulk insert and db(column) emits identifiers while ${val} binds parameters", async () => {
    const db = new SQL("sqlite://:memory:");
    try {
      await db`
        CREATE TABLE wagers (
          id INTEGER PRIMARY KEY,
          status TEXT NOT NULL,
          stake_cents INTEGER NOT NULL
        )
      `;
      const rows = [
        { id: 1, status: "OPEN", stake_cents: 15000 },
        { id: 2, status: "SETTLED", stake_cents: 25000 },
      ];
      await db`INSERT INTO wagers ${db(rows)}`;

      const column = "status";
      const selected = await db`
        SELECT id, ${db(column)} FROM wagers ORDER BY id ASC
      `;
      expect([...selected]).toEqual([
        { id: 1, status: "OPEN" },
        { id: 2, status: "SETTLED" },
      ]);

      // Gotcha: `${column}` binds the string literal as a parameter rather than an identifier.
      const boundLiteral = await db`
        SELECT id, ${column} AS col_val FROM wagers WHERE id = ${1}
      `;
      expect([...boundLiteral]).toEqual([{ id: 1, col_val: "status" }]);
    } finally {
      await db.close();
    }
  });

  test("db.begin commits successful transactions and rolls back on error", async () => {
    const db = new SQL("sqlite://:memory:");
    try {
      await db`CREATE TABLE balances (id INTEGER PRIMARY KEY, cents INTEGER NOT NULL)`;
      await db`INSERT INTO balances (id, cents) VALUES (1, 1000), (2, 1000)`;

      await db.begin(async (tx) => {
        await tx`UPDATE balances SET cents = cents - ${500} WHERE id = ${1}`;
        await tx`UPDATE balances SET cents = cents + ${500} WHERE id = ${2}`;
      });

      const afterCommit =
        await db`SELECT id, cents FROM balances ORDER BY id ASC`;
      expect([...afterCommit]).toEqual([
        { id: 1, cents: 500 },
        { id: 2, cents: 1500 },
      ]);

      await expect(
        db.begin(async (tx) => {
          await tx`UPDATE balances SET cents = cents - ${999} WHERE id = ${1}`;
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");

      const afterRollback = await db`
        SELECT id, cents FROM balances ORDER BY id ASC
      `;
      expect([...afterRollback]).toEqual([
        { id: 1, cents: 500 },
        { id: 2, cents: 1500 },
      ]);
    } finally {
      await db.close();
    }
  });

  test("default sql resolves DATABASE_URL and falls back to POSTGRES_URL", () => {
    const script =
      'import { sql } from "bun"; console.log(JSON.stringify(await sql`SELECT 1 AS n`));';

    const fromDatabaseUrl = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, DATABASE_URL: "sqlite://:memory:" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(fromDatabaseUrl.exitCode).toBe(0);
    expect(JSON.parse(fromDatabaseUrl.stdout.toString())).toEqual([{ n: 1 }]);

    const fromPostgresUrl = Bun.spawnSync([process.execPath, "-e", script], {
      env: {
        ...process.env,
        DATABASE_URL: "",
        POSTGRES_URL: "sqlite://:memory:",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(fromPostgresUrl.exitCode).toBe(0);
    expect(JSON.parse(fromPostgresUrl.stdout.toString())).toEqual([{ n: 1 }]);
  });
});
