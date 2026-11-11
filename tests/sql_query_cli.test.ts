/**
 * @file tests/sql_query_cli.test.ts
 * @description Verifies `bin/sql-query.ts` (`bun x sql-query` / `./bin/dx sql`), `Bun.SQL` / `Bun.sql`
 * global surface, read-only SQL guardrails, and `lib/db.ts` `DATABASE_URL` + `Bun.env` resolution.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  normalizeSqlTarget,
  runReadOnlySql,
  validateReadOnlyQuery,
} from "../bin/sql-query.ts";

const ROOT = resolve(import.meta.dir, "..");

describe("Bun.sql / Bun.SQL global surface & sql-query CLI", () => {
  test("1. Bun.sql is an instance of Bun.SQL and normalizeSqlTarget resolves default vs explicit targets", () => {
    expect(typeof Bun.SQL).toBe("function");
    expect(Bun.sql).toBeInstanceOf(Bun.SQL);

    expect(normalizeSqlTarget("")).toMatchObject({
      mode: "default-bun-sql",
      url: null,
    });
    expect(normalizeSqlTarget(":memory:")).toEqual({
      mode: "explicit-url",
      url: "sqlite://:memory:",
      sqliteKind: true,
    });
    expect(
      normalizeSqlTarget("postgres://user:pass@127.0.0.1:5432/sportsdesk"),
    ).toEqual({
      mode: "explicit-url",
      url: "postgres://user:pass@127.0.0.1:5432/sportsdesk",
      sqliteKind: false,
    });
  });

  test("2. validateReadOnlyQuery allows SELECT/WITH/EXPLAIN and refuses DDL, DML, and multi-statement queries", () => {
    expect(validateReadOnlyQuery("SELECT 1 AS ok;")).toBe("SELECT 1 AS ok");
    expect(
      validateReadOnlyQuery("WITH cte AS (SELECT 2 AS n) SELECT n FROM cte"),
    ).toBe("WITH cte AS (SELECT 2 AS n) SELECT n FROM cte");
    expect(validateReadOnlyQuery("EXPLAIN QUERY PLAN SELECT 1")).toBe(
      "EXPLAIN QUERY PLAN SELECT 1",
    );

    expect(() => validateReadOnlyQuery("")).toThrow(/empty SQL query/);
    expect(() => validateReadOnlyQuery("SELECT 1; SELECT 2")).toThrow(
      /multi-statement/,
    );
    expect(() => validateReadOnlyQuery("DROP TABLE operators")).toThrow(
      /read-only guard/,
    );
    expect(() =>
      validateReadOnlyQuery("WITH x AS (SELECT 1) DELETE FROM operators"),
    ).toThrow(/read-only guard/);
  });

  test("3. runReadOnlySql and `bun x --no-install sql-query` inspect a SQLite file via Bun.SQL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sql-query-test-"));
    const dbPath = join(dir, "sample.sqlite");
    try {
      const seed = new Bun.SQL(`sqlite://${dbPath}`);
      await seed.unsafe(
        "CREATE TABLE desk_metrics (id INTEGER PRIMARY KEY, venue TEXT NOT NULL, latency_ms INTEGER NOT NULL)",
      );
      await seed`INSERT INTO desk_metrics (venue, latency_ms) VALUES (${"polymarket"}, ${12}), (${"kalshi"}, ${8})`;
      await seed.close();

      const tables = await runReadOnlySql({ url: dbPath, tables: true });
      expect(tables.adapter).toBe("sqlite");
      expect(tables.rows).toEqual([
        { table_name: "desk_metrics", type: "table" },
      ]);

      const cliProc = Bun.spawn(
        [
          process.execPath,
          "x",
          "--no-install",
          "sql-query",
          "--url",
          dbPath,
          "SELECT venue, latency_ms FROM desk_metrics ORDER BY latency_ms ASC",
          "--yaml",
        ],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(cliProc.stdout).text();
      expect(await cliProc.exited).toBe(0);

      const parsed = Bun.YAML.parse(stdout) as {
        adapter: string;
        rowCount: number;
        rows: Array<{ venue: string; latency_ms: number }>;
      };
      expect(parsed.adapter).toBe("sqlite");
      expect(parsed.rowCount).toBe(2);
      expect(parsed.rows).toEqual([
        { venue: "kalshi", latency_ms: 8 },
        { venue: "polymarket", latency_ms: 12 },
      ]);

      // Verify Bun.sql default global client works when DATABASE_URL=sqlite://<path>
      const defaultProc = Bun.spawn(
        [
          process.execPath,
          "x",
          "--no-install",
          "sql-query",
          "SELECT COUNT(*) AS cnt FROM desk_metrics",
          "--json",
        ],
        {
          cwd: ROOT,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...Bun.env, DATABASE_URL: `sqlite://${dbPath}` },
        },
      );
      const defaultOut = await new Response(defaultProc.stdout).text();
      expect(await defaultProc.exited).toBe(0);
      const defaultJson = JSON.parse(defaultOut) as {
        source: string;
        rows: Array<{ cnt: number }>;
      };
      expect(defaultJson.source).toBe("Bun.sql");
      expect(defaultJson.rows).toEqual([{ cnt: 2 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("4. lib/db.ts enforces non-local password guard for DATABASE_URL and reuses Bun.sql for local URLs", () => {
    const badRemote = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `
        const { createConfiguredSql } = await import("./lib/db.ts");
        try {
          createConfiguredSql();
          process.exit(0);
        } catch (e) {
          console.error(e.message);
          process.exit(1);
        }
        `,
      ],
      {
        cwd: ROOT,
        env: {
          ...Bun.env,
          DATABASE_URL:
            "postgres://postgres@db.remote.internal:5432/sportsdesk",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(badRemote.exitCode).toBe(1);
    expect(badRemote.stderr.toString()).toContain(
      "PGPASSWORD required for non-local host db.remote.internal",
    );

    const localDefault = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `
        const { createConfiguredSql } = await import("./lib/db.ts");
        const cfg = createConfiguredSql();
        console.log(JSON.stringify({ isDefaultGlobal: cfg.isDefaultGlobal, sameRef: cfg.db === Bun.sql }));
        `,
      ],
      {
        cwd: ROOT,
        env: {
          ...Bun.env,
          DATABASE_URL: "postgres://postgres@127.0.0.1:5432/sportsdesk_test",
          SPORTSDESK_DB_TLS: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(localDefault.exitCode).toBe(0);
    expect(JSON.parse(localDefault.stdout.toString())).toEqual({
      isDefaultGlobal: true,
      sameRef: true,
    });
  });
});
