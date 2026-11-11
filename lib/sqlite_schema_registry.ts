/**
 * SSOT for audit SQLite tables — column/key types + DDL generator + Bun.inspect report.
 */

import {
  sqlCol,
  sqlDomain,
  sqlIndex,
  sqlTable,
  type Brand,
  type SqlDomain,
} from "./brand.ts";
import { count, type Count } from "./units.ts";
import { isSsotTableName } from "./ssot_table_name.ts";

export { sqlCol, sqlDomain, sqlIndex, sqlTable };
export type SqlColumnName<T extends string = string> = Brand<
  T,
  "SqlColumnName"
>;
export type SqlIndexName<T extends string = string> = Brand<T, "SqlIndexName">;
export type SqlTableName<T extends string = string> = Brand<T, "SqlTableName">;

export type SqliteStorageKind =
  | "integer_pk"
  | "integer"
  | "real"
  | "text"
  | "text_iso_time"
  | "text_sha256"
  | "text_json"
  | "text_enum";

export type SqliteColumnDef = {
  readonly name: SqlColumnName<string>;
  readonly sqlType: "INTEGER" | "REAL" | "TEXT";
  readonly kind: SqliteStorageKind;
  readonly nullable: boolean;
  readonly description?: string;
};

export type SqliteKeyDef =
  | {
      readonly kind: "primary";
      readonly columns: readonly SqlColumnName<string>[];
      readonly autoincrement?: boolean;
    }
  | {
      readonly kind: "unique";
      readonly name: SqlIndexName<string>;
      readonly columns: readonly SqlColumnName<string>[];
      readonly where?: string;
    }
  | {
      readonly kind: "index";
      readonly name: SqlIndexName<string>;
      readonly columns: readonly SqlColumnName<string>[];
    };

export type SqliteTableDef = {
  readonly name: SqlTableName<string>;
  readonly domain: SqlDomain;
  readonly appendOnly?: boolean;
  readonly columns: readonly SqliteColumnDef[];
  readonly keys: readonly SqliteKeyDef[];
};

const c = sqlCol;
const idx = sqlIndex;

export const MATCH_EVALUATIONS_TABLE = sqlTable("match_evaluations");
export const MATCH_EVALUATIONS_SCHEMA: SqliteTableDef = {
  name: MATCH_EVALUATIONS_TABLE,
  domain: sqlDomain("candidate overlay audit"),
  appendOnly: true,
  columns: [
    { name: c("id"), sqlType: "INTEGER", kind: "integer_pk", nullable: false },
    { name: c("run_id"), sqlType: "TEXT", kind: "text", nullable: false },
    {
      name: c("run_at"),
      sqlType: "TEXT",
      kind: "text_iso_time",
      nullable: false,
      description: "tx_time — evaluation run",
    },
    {
      name: c("valid_time"),
      sqlType: "TEXT",
      kind: "text_iso_time",
      nullable: true,
      description: "market valid time (denormalized from replay_input_json)",
    },
    {
      name: c("policy_sha256"),
      sqlType: "TEXT",
      kind: "text_sha256",
      nullable: false,
    },
    {
      name: c("ticker_sha256"),
      sqlType: "TEXT",
      kind: "text_sha256",
      nullable: false,
    },
    {
      name: c("pending_sha256"),
      sqlType: "TEXT",
      kind: "text_sha256",
      nullable: false,
    },
    {
      name: c("state"),
      sqlType: "TEXT",
      kind: "text_enum",
      nullable: false,
      description: "candidate | unresolved",
    },
    { name: c("reject_reason"), sqlType: "TEXT", kind: "text", nullable: true },
    { name: c("review_flag"), sqlType: "TEXT", kind: "text", nullable: true },
    { name: c("time_diff_ms"), sqlType: "REAL", kind: "real", nullable: false },
    {
      name: c("evaluation_json"),
      sqlType: "TEXT",
      kind: "text_json",
      nullable: false,
      description: "canonical evaluation bytes",
    },
    {
      name: c("evaluation_json_sha256"),
      sqlType: "TEXT",
      kind: "text_sha256",
      nullable: false,
    },
    {
      name: c("replay_input_json"),
      sqlType: "TEXT",
      kind: "text_json",
      nullable: false,
      description: "RAW ticker/pending capture",
    },
  ],
  keys: [
    { kind: "primary", columns: [c("id")], autoincrement: true },
    {
      kind: "index",
      name: idx("idx_match_eval_run_at"),
      columns: [c("run_at")],
    },
    {
      kind: "index",
      name: idx("idx_match_eval_valid_time"),
      columns: [c("valid_time")],
    },
    {
      kind: "index",
      name: idx("idx_match_eval_policy"),
      columns: [c("policy_sha256")],
    },
    {
      kind: "index",
      name: idx("idx_match_eval_pair_policy"),
      columns: [
        c("ticker_sha256"),
        c("pending_sha256"),
        c("policy_sha256"),
        c("run_at"),
      ],
    },
  ],
};

export const WAGER_SETTLEMENT_OBSERVATIONS_TABLE = sqlTable(
  "wager_settlement_observations",
);
export const WAGER_SETTLEMENT_SCHEMA: SqliteTableDef = {
  name: WAGER_SETTLEMENT_OBSERVATIONS_TABLE,
  domain: sqlDomain("Manager/getHistory lifecycle"),
  appendOnly: true,
  columns: [
    { name: c("id"), sqlType: "INTEGER", kind: "integer_pk", nullable: false },
    { name: c("run_id"), sqlType: "TEXT", kind: "text", nullable: false },
    {
      name: c("run_at"),
      sqlType: "TEXT",
      kind: "text_iso_time",
      nullable: false,
    },
    {
      name: c("valid_time"),
      sqlType: "TEXT",
      kind: "text_iso_time",
      nullable: false,
    },
    { name: c("ticket_id"), sqlType: "TEXT", kind: "text", nullable: false },
    {
      name: c("wager_status"),
      sqlType: "TEXT",
      kind: "text_enum",
      nullable: false,
    },
    {
      name: c("source_feed"),
      sqlType: "TEXT",
      kind: "text_enum",
      nullable: false,
    },
    {
      name: c("leg_number"),
      sqlType: "INTEGER",
      kind: "integer",
      nullable: true,
    },
    { name: c("result"), sqlType: "TEXT", kind: "text", nullable: true },
    {
      name: c("amount_cents"),
      sqlType: "INTEGER",
      kind: "integer",
      nullable: true,
    },
    {
      name: c("payload_json"),
      sqlType: "TEXT",
      kind: "text_json",
      nullable: false,
    },
    {
      name: c("payload_sha256"),
      sqlType: "TEXT",
      kind: "text_sha256",
      nullable: false,
    },
  ],
  keys: [
    { kind: "primary", columns: [c("id")], autoincrement: true },
    { kind: "index", name: idx("idx_wso_ticket"), columns: [c("ticket_id")] },
    {
      kind: "index",
      name: idx("idx_wso_valid_time"),
      columns: [c("valid_time")],
    },
    { kind: "index", name: idx("idx_wso_run_at"), columns: [c("run_at")] },
  ],
};

export const COMBO_LEGS_TABLE = sqlTable("combo_legs");
export const COMBO_LEGS_SCHEMA: SqliteTableDef = {
  name: COMBO_LEGS_TABLE,
  domain: sqlDomain("cross-venue canonical combo index"),
  appendOnly: true,
  columns: [
    { name: c("id"), sqlType: "INTEGER", kind: "integer_pk", nullable: false },
    { name: c("run_id"), sqlType: "TEXT", kind: "text", nullable: false },
    {
      name: c("run_at"),
      sqlType: "TEXT",
      kind: "text_iso_time",
      nullable: false,
    },
    {
      name: c("canonical_combo_id"),
      sqlType: "TEXT",
      kind: "text",
      nullable: false,
    },
    {
      name: c("venue"),
      sqlType: "TEXT",
      kind: "text_enum",
      nullable: false,
      description: "internal | polymarket",
    },
    { name: c("venue_ref"), sqlType: "TEXT", kind: "text", nullable: false },
    {
      name: c("valid_time"),
      sqlType: "TEXT",
      kind: "text_iso_time",
      nullable: false,
    },
    {
      name: c("leg_index"),
      sqlType: "INTEGER",
      kind: "integer",
      nullable: false,
    },
    {
      name: c("leg_json"),
      sqlType: "TEXT",
      kind: "text_json",
      nullable: false,
    },
    {
      name: c("wire_json"),
      sqlType: "TEXT",
      kind: "text_json",
      nullable: true,
    },
  ],
  keys: [
    { kind: "primary", columns: [c("id")], autoincrement: true },
    {
      kind: "index",
      name: idx("idx_combo_legs_combo_venue"),
      columns: [c("canonical_combo_id"), c("venue"), c("valid_time")],
    },
    {
      kind: "index",
      name: idx("idx_combo_legs_valid_time"),
      columns: [c("valid_time")],
    },
  ],
};

export const CANDIDATE_TICKETS_TABLE = sqlTable("candidate_tickets");
export const CANDIDATE_TICKETS_SCHEMA: SqliteTableDef = {
  name: CANDIDATE_TICKETS_TABLE,
  domain: sqlDomain("GATEWAY candidate enrich unit store"),
  appendOnly: true,
  columns: [
    { name: c("match_key"), sqlType: "TEXT", kind: "text", nullable: false },
    {
      name: c("candidate_status"),
      sqlType: "TEXT",
      kind: "text_enum",
      nullable: false,
    },
    { name: c("reject_reason"), sqlType: "TEXT", kind: "text", nullable: true },
    { name: c("time_diff"), sqlType: "REAL", kind: "real", nullable: false },
    {
      name: c("policy_sha256"),
      sqlType: "TEXT",
      kind: "text_sha256",
      nullable: false,
    },
    {
      name: c("participant_1_code"),
      sqlType: "TEXT",
      kind: "text",
      nullable: true,
    },
    {
      name: c("participant_2_code"),
      sqlType: "TEXT",
      kind: "text",
      nullable: true,
    },
    {
      name: c("raw_json"),
      sqlType: "TEXT",
      kind: "text_json",
      nullable: false,
    },
  ],
  keys: [],
};

export const INGESTION_TRADES_TABLE = sqlTable("ingestion_trades");
export const INGESTION_TRADES_SCHEMA: SqliteTableDef = {
  name: INGESTION_TRADES_TABLE,
  domain: sqlDomain("Plane 3 bitemporal replay WAL"),
  appendOnly: false,
  columns: [
    {
      name: c("rowid"),
      sqlType: "INTEGER",
      kind: "integer_pk",
      nullable: false,
    },
    { name: c("id"), sqlType: "INTEGER", kind: "integer", nullable: false },
    { name: c("channel_id"), sqlType: "TEXT", kind: "text", nullable: false },
    {
      name: c("channel_status"),
      sqlType: "TEXT",
      kind: "text_enum",
      nullable: false,
    },
    {
      name: c("valid_from"),
      sqlType: "INTEGER",
      kind: "integer",
      nullable: false,
    },
    {
      name: c("valid_to"),
      sqlType: "INTEGER",
      kind: "integer",
      nullable: true,
    },
    {
      name: c("tx_from"),
      sqlType: "INTEGER",
      kind: "integer",
      nullable: false,
    },
    { name: c("tx_to"), sqlType: "INTEGER", kind: "integer", nullable: true },
    { name: c("price"), sqlType: "INTEGER", kind: "integer", nullable: false },
    { name: c("link_id"), sqlType: "TEXT", kind: "text", nullable: true },
    {
      name: c("xml_hash"),
      sqlType: "TEXT",
      kind: "text_sha256",
      nullable: false,
    },
    {
      name: c("latency_ms"),
      sqlType: "INTEGER",
      kind: "integer",
      nullable: true,
    },
  ],
  keys: [
    { kind: "primary", columns: [c("rowid")], autoincrement: true },
    {
      kind: "unique",
      name: idx("one_open_tx_per_lane_id"),
      columns: [c("channel_id"), c("id")],
      where: "tx_to IS NULL",
    },
  ],
};

export const SPORTSDESK_SQLITE_TABLES: readonly SqliteTableDef[] = [
  MATCH_EVALUATIONS_SCHEMA,
  WAGER_SETTLEMENT_SCHEMA,
  COMBO_LEGS_SCHEMA,
  CANDIDATE_TICKETS_SCHEMA,
  INGESTION_TRADES_SCHEMA,
];

export type RenderCreateTableDdlOptions = {
  readonly ifNotExists?: boolean;
  readonly includeIndexes?: boolean;
  readonly recreateUniqueIndexes?: boolean;
  readonly extraChecks?: readonly string[];
};

/**
 * Generates canonical SQLite `CREATE TABLE` (and index) DDL directly from a
 * registered `SqliteTableDef` so runtime stores cannot drift from SSOT column
 * names, types, nullability, or index definitions.
 */
export function renderCreateTableDdl(
  table: SqliteTableDef,
  options: RenderCreateTableDdlOptions = {},
): string {
  const ifNotExists = options.ifNotExists !== false;
  const includeIndexes = options.includeIndexes !== false;
  const recreateUnique = options.recreateUniqueIndexes === true;
  const pkKey = table.keys.find((k) => k.kind === "primary");
  const singlePkCol =
    pkKey && pkKey.kind === "primary" && pkKey.columns.length === 1
      ? pkKey.columns[0]
      : undefined;
  const pkAutoincrement =
    pkKey && pkKey.kind === "primary" && pkKey.autoincrement === true;

  const colLines: string[] = [];
  for (const col of table.columns) {
    if (col.kind === "integer_pk" && col.name === singlePkCol) {
      colLines.push(
        `  ${col.name} INTEGER PRIMARY KEY${pkAutoincrement ? " AUTOINCREMENT" : ""}`,
      );
      continue;
    }
    colLines.push(
      `  ${col.name} ${col.sqlType}${col.nullable ? "" : " NOT NULL"}`,
    );
  }

  for (const checkExpr of options.extraChecks ?? []) {
    colLines.push(`  CHECK (${checkExpr})`);
  }

  const statements: string[] = [
    `CREATE TABLE${ifNotExists ? " IF NOT EXISTS" : ""} ${table.name} (\n${colLines.join(",\n")}\n);`,
  ];

  if (includeIndexes) {
    for (const key of table.keys) {
      if (key.kind === "primary") continue;
      const cols = key.columns.join(", ");
      if (key.kind === "unique") {
        if (recreateUnique) {
          statements.push(`DROP INDEX IF EXISTS ${key.name};`);
          statements.push(
            `CREATE UNIQUE INDEX ${key.name} ON ${table.name} (${cols})${key.where ? ` WHERE ${key.where}` : ""};`,
          );
        } else {
          statements.push(
            `CREATE UNIQUE INDEX${ifNotExists ? " IF NOT EXISTS" : ""} ${key.name} ON ${table.name} (${cols})${key.where ? ` WHERE ${key.where}` : ""};`,
          );
        }
      } else {
        statements.push(
          `CREATE INDEX${ifNotExists ? " IF NOT EXISTS" : ""} ${key.name} ON ${table.name}(${cols});`,
        );
      }
    }
  }

  return statements.join("\n");
}

export type SqliteQueryableHandle = {
  query(sql: string): { all(...params: unknown[]): unknown[] };
};

/**
 * Verifies at store initialization time that every column in `table` exists on
 * the live SQLite table with matching SQLite type affinity and `NOT NULL` state
 * (while permitting additive runtime migration columns on evolving stores).
 */
export function assertSqliteStoreMatchesRegistry(
  db: SqliteQueryableHandle,
  table: SqliteTableDef,
): void {
  const tableIdent = String(table.name);
  if (!/^[a-z][a-z0-9_]*$/.test(tableIdent)) {
    throw new Error(`unsafe sqlite table identifier: ${tableIdent}`);
  }
  const pragmaRows = db
    .query(`PRAGMA table_xinfo("${tableIdent}")`)
    .all() as Array<{
    name: string;
    type: string;
    notnull: number | bigint;
    pk: number | bigint;
  }>;

  const byName = new Map(pragmaRows.map((r) => [r.name, r] as const));
  const drifts: string[] = [];

  for (const col of table.columns) {
    const colName = String(col.name);
    const live = byName.get(colName);
    if (!live) {
      drifts.push(`missing column "${colName}"`);
      continue;
    }
    const liveType = live.type.trim().toUpperCase();
    if (liveType !== col.sqlType) {
      drifts.push(
        `column "${colName}" type live=${liveType || "(empty)"} registry=${col.sqlType}`,
      );
    }
    if (col.kind !== "integer_pk") {
      const liveNotNull = Number(live.notnull) === 1;
      const expectedNotNull = !col.nullable;
      if (liveNotNull !== expectedNotNull) {
        drifts.push(
          `column "${colName}" notnull live=${liveNotNull} registry=${expectedNotNull}`,
        );
      }
    }
  }

  if (drifts.length > 0) {
    throw new Error(
      `SQLite store "${tableIdent}" drifted from SPORTSDESK_SQLITE_TABLES:\n  ${drifts.join("\n  ")}`,
    );
  }
}

export type SchemaColumnRow = {
  table: string;
  column: string;
  sqlType: string;
  kind: SqliteStorageKind;
  nullable: "YES" | "NO";
  keyRoles: string;
  description: string;
};

export type SchemaKeyRow = {
  table: string;
  keyKind: "primary" | "unique" | "index";
  name: string;
  columns: string;
  partial: string;
};

function columnKeyRoles(
  table: SqliteTableDef,
  col: SqlColumnName<string>,
): string {
  const roles: string[] = [];
  for (const key of table.keys) {
    if (!key.columns.includes(col)) continue;
    if (key.kind === "primary") roles.push("PK");
    else if (key.kind === "unique") roles.push(`UQ:${key.name}`);
    else roles.push(`IDX:${key.name}`);
  }
  return roles.length > 0 ? roles.join(",") : "—";
}

export function flattenSchemaColumns(
  tables: readonly SqliteTableDef[] = SPORTSDESK_SQLITE_TABLES,
): SchemaColumnRow[] {
  const rows: SchemaColumnRow[] = [];
  for (const table of tables) {
    for (const col of table.columns) {
      rows.push({
        table: table.name,
        column: col.name,
        sqlType: col.sqlType,
        kind: col.kind,
        nullable: col.nullable ? "YES" : "NO",
        keyRoles: columnKeyRoles(table, col.name),
        description: col.description ?? "",
      });
    }
  }
  return rows;
}

export function flattenSchemaKeys(
  tables: readonly SqliteTableDef[] = SPORTSDESK_SQLITE_TABLES,
): SchemaKeyRow[] {
  const rows: SchemaKeyRow[] = [];
  for (const table of tables) {
    for (const key of table.keys) {
      if (key.kind === "primary") {
        rows.push({
          table: table.name,
          keyKind: "primary",
          name: "PRIMARY KEY",
          columns: key.columns.join(", "),
          partial: key.autoincrement ? "AUTOINCREMENT" : "",
        });
      } else {
        rows.push({
          table: table.name,
          keyKind: key.kind,
          name: key.name,
          columns: key.columns.join(", "),
          partial: key.kind === "unique" ? (key.where ?? "") : "",
        });
      }
    }
  }
  return rows;
}

export type SchemaSummaryRow = {
  table: SqlTableName;
  domain: SqlDomain;
  columns: Count;
  keys: Count;
  appendOnly: "yes" | "no";
  /** Registry fragment — serialize with `.href` in JSON. */
  docsUrl: URL;
};

export function schemaTableDocsUrl(tableName: string): URL {
  return new URL(
    `#${encodeURIComponent(tableName)}`,
    new URL("./sqlite_schema_registry.ts", import.meta.url),
  );
}

export function flattenSchemaSummary(
  tables: readonly SqliteTableDef[] = SPORTSDESK_SQLITE_TABLES,
): SchemaSummaryRow[] {
  return tables.map((t) => ({
    table: t.name as SqlTableName,
    domain: t.domain,
    columns: count(t.columns.length),
    keys: count(t.keys.length),
    appendOnly: t.appendOnly ? ("yes" as const) : ("no" as const),
    docsUrl: schemaTableDocsUrl(String(t.name)),
  }));
}

export type KnownSqliteTableName =
  (typeof SPORTSDESK_SQLITE_TABLES)[number]["name"];

export function isKnownSqliteTableName(
  name: string,
): name is KnownSqliteTableName {
  return isSsotTableName(name);
}

export function getTableSchema(
  tableName: KnownSqliteTableName | string,
): SqliteTableDef | undefined {
  return SPORTSDESK_SQLITE_TABLES.find((t) => t.name === tableName);
}
