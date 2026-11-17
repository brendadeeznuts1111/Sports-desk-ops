#!/usr/bin/env bun
/**
 * @file bin/sql-query.ts
 * @description Read-only unified SQL inspector powered by `Bun.SQL` & `Bun.sql`.
 *
 * Supports:
 *  - Default `Bun.sql` global client (`DATABASE_URL` / `PG*` env) when `--url` is omitted
 *  - Explicit `sqlite://...`, `postgres://...`, `mysql://...`, or bare `.sqlite`/`.db` paths via `new Bun.SQL(url)`
 *  - `--tables` to list tables + row counts (`sqlite_master` or `pg_catalog.pg_tables`)
 *  - Read-only enforcement (`SELECT`, `WITH`, `EXPLAIN` only — refuses DDL/DML mutations)
 *  - `--timeout <seconds>` cancels a query through `query.cancel()` (0 disables)
 *  - Output via `Bun.inspect.table` (default), `--json`, or `--yaml`; JSON/YAML include
 *    PostgreSQL/MySQL `columns` and `statement` metadata (null on SQLite)
 */

import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  isLocalDbHost,
  resolveDbChannelBinding,
  resolveDbConnectionTimeout,
  resolveDbTlsConfig,
} from "../lib/db.ts";

const HELP = `sql-query — read-only unified SQL inspector (Bun.SQL / Bun.sql)

Usage:
  bun x sql-query [--url <url|sqlite-path>] "<SELECT ...>" [--limit <n>] [--timeout <s>] [--json | --yaml]
  bun x sql-query [--url <url|sqlite-path>] --tables [--limit <n>] [--timeout <s>] [--json | --yaml]

Targets:
  --url <target>   sqlite://<path>, :memory:, ./path/to/file.sqlite, or postgres://...
                   When omitted, uses the default Bun.sql client (DATABASE_URL / PG* env).
  --tables         List tables in the target database
  --limit <n>      Cap returned rows in memory (default: 200)
  --timeout <s>    Cancel the query after s seconds; 0 disables (default: 30)
  --json           Emit JSON { adapter, rowCount, rows, columns, statement }
  --yaml           Emit YAML via Bun.YAML.stringify
  -h, --help       Print this usage

Safety:
  Read-only by contract: only single-statement SELECT / WITH / EXPLAIN queries are executed.
`;

const READ_ONLY_PREFIX = /^\s*(?:SELECT|WITH|EXPLAIN)\b/i;
const MUTATION_KEYWORDS =
  /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|ATTACH|DETACH|VACUUM|GRANT|REVOKE|COPY)\b/i;

export function normalizeSqlTarget(raw?: string): {
  readonly mode: "default-bun-sql" | "explicit-url";
  readonly url: string | null;
  readonly sqliteKind: boolean;
} {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") {
    const envUrl = Bun.env.DATABASE_URL?.trim() ?? "";
    return {
      mode: "default-bun-sql",
      url: null,
      sqliteKind:
        envUrl.startsWith("sqlite:") ||
        envUrl === ":memory:" ||
        envUrl.endsWith(".sqlite") ||
        envUrl.endsWith(".db"),
    };
  }
  if (trimmed === ":memory:" || trimmed === "sqlite://:memory:") {
    return {
      mode: "explicit-url",
      url: "sqlite://:memory:",
      sqliteKind: true,
    };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return {
      mode: "explicit-url",
      url: trimmed,
      sqliteKind: trimmed.toLowerCase().startsWith("sqlite://"),
    };
  }
  const abs = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
  return {
    mode: "explicit-url",
    url: `sqlite://${abs}`,
    sqliteKind: true,
  };
}

export function validateReadOnlyQuery(query: string): string {
  const trimmed = query.trim().replace(/;+\s*$/, "");
  if (trimmed === "") {
    throw new Error("empty SQL query");
  }
  if (trimmed.includes(";")) {
    throw new Error("multi-statement SQL queries are refused");
  }
  if (!READ_ONLY_PREFIX.test(trimmed) || MUTATION_KEYWORDS.test(trimmed)) {
    throw new Error(
      "read-only guard: only SELECT, WITH, or EXPLAIN queries are allowed",
    );
  }
  return trimmed;
}

export interface SqlColumnMetadata {
  readonly name: string;
  readonly type: number;
  readonly [key: string]: unknown;
}

export interface SqlStatementMetadata {
  readonly string: string;
  readonly types: readonly number[];
  readonly [key: string]: unknown;
}

export async function runReadOnlySql(options: {
  readonly url?: string | undefined;
  readonly query?: string | undefined;
  readonly tables?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly timeoutSeconds?: number | undefined;
}): Promise<{
  readonly adapter: "sqlite" | "postgres-or-other";
  readonly source: string;
  readonly rowCount: number;
  readonly rows: Record<string, unknown>[];
  readonly columns: SqlColumnMetadata[] | null;
  readonly statement: SqlStatementMetadata | null;
}> {
  const target = normalizeSqlTarget(options.url);
  const limit = Math.max(1, Math.trunc(options.limit ?? 200));
  const timeoutSeconds = Math.max(0, options.timeoutSeconds ?? 30);
  let db: InstanceType<typeof Bun.SQL>;
  if (target.mode === "default-bun-sql") {
    db = Bun.sql;
  } else if (target.sqliteKind) {
    db = new Bun.SQL(target.url as string);
  } else {
    const url = new URL(target.url as string);
    const local = isLocalDbHost(url.hostname);
    const forceTls = Bun.env.SPORTSDESK_DB_TLS === "1";
    const tls = resolveDbTlsConfig(Bun.env, { local, forceTls });
    const channelBinding = resolveDbChannelBinding(Bun.env);
    db = new Bun.SQL(target.url as string, {
      connectionTimeout: resolveDbConnectionTimeout(
        Bun.env,
        url.searchParams.get("connect_timeout"),
      ),
      ...(tls === false ? {} : { tls }),
      ...(channelBinding === undefined ? {} : { channelBinding }),
    });
  }

  try {
    let sqlText: string;
    if (options.tables === true) {
      sqlText = target.sqliteKind
        ? "SELECT name AS table_name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
        : "SELECT tablename AS table_name, 'table' AS type FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename";
    } else {
      sqlText = validateReadOnlyQuery(options.query ?? "");
    }

    const pending = db.unsafe(sqlText);
    const timer =
      timeoutSeconds > 0
        ? setTimeout(() => {
            try {
              void pending.cancel();
            } catch {
              // The awaited query below reports the cancellation failure.
            }
          }, timeoutSeconds * 1000)
        : undefined;
    timer?.unref?.();

    try {
      const result = (await pending) as Iterable<Record<string, unknown>> & {
        columns?: SqlColumnMetadata[] | null;
        statement?: SqlStatementMetadata | null;
      };
      const allRows = [...result].map((row) => ({ ...row }));
      const capped = allRows.slice(0, limit);
      return {
        adapter: target.sqliteKind ? "sqlite" : "postgres-or-other",
        source:
          target.mode === "default-bun-sql"
            ? "Bun.sql"
            : (target.url as string),
        rowCount: capped.length,
        rows: capped,
        columns: result.columns ?? null,
        statement: result.statement ?? null,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } finally {
    if (target.mode === "explicit-url") {
      await db.close();
    }
  }
}

async function main(): Promise<number> {
  let parsedArgs: ReturnType<typeof parseArgs>;
  try {
    parsedArgs = parseArgs({
      args: Bun.argv.slice(2),
      options: {
        url: { type: "string", short: "u" },
        tables: { type: "boolean", default: false },
        limit: { type: "string", default: "200" },
        timeout: { type: "string", default: "30" },
        json: { type: "boolean", default: false },
        yaml: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(
      `sql-query: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }

  const { values, positionals } = parsedArgs;
  if (values.help) {
    console.log(HELP.trimEnd());
    return 0;
  }

  const limitNum = Number(values.limit ?? "200");
  if (!Number.isFinite(limitNum) || limitNum < 1) {
    console.error("sql-query: --limit must be a positive integer");
    return 2;
  }

  const timeoutSeconds = Number(values.timeout ?? "30");
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    console.error(
      "sql-query: --timeout must be a non-negative number of seconds",
    );
    return 2;
  }

  const query = positionals.join(" ").trim();
  if (!values.tables && query === "") {
    console.error(
      "sql-query: provide a SELECT query or pass --tables (see --help)",
    );
    return 2;
  }

  try {
    const out = await runReadOnlySql({
      url: typeof values.url === "string" ? values.url : undefined,
      query,
      tables: Boolean(values.tables),
      limit: limitNum,
      timeoutSeconds,
    });

    if (values.yaml) {
      console.log(Bun.YAML.stringify(out, null, 2).trimEnd());
    } else if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else if (out.rows.length === 0) {
      console.log(`(0 rows from ${out.source})`);
    } else {
      console.log(Bun.inspect.table(out.rows).trimEnd());
      console.log(`${out.rowCount} row(s) · ${out.source}`);
    }
    return 0;
  } catch (err) {
    console.error(
      `sql-query: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
