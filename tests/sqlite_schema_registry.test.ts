import { describe, expect, test } from "bun:test";
import {
  buildSqliteSchemaReport,
  buildSqliteSchemaReportForTable,
} from "../lib/schema_report.ts";
import {
  COMBO_LEGS_SCHEMA,
  flattenSchemaColumns,
  flattenSchemaKeys,
  getTableSchema,
  MATCH_EVALUATIONS_SCHEMA,
  sqlCol,
  sqlTable,
} from "../lib/sqlite_schema_registry.ts";

describe("sqlite_schema_registry", () => {
  test("column rows include keyRoles for match_evaluations PK and indexes", () => {
    const cols = flattenSchemaColumns([MATCH_EVALUATIONS_SCHEMA]);
    const id = cols.find((r) => r.column === "id");
    const policy = cols.find((r) => r.column === "policy_sha256");
    expect(id?.keyRoles).toContain("PK");
    expect(policy?.keyRoles).toContain("IDX:idx_match_eval_policy");
    expect(id?.kind).toBe("integer_pk");
    expect(policy?.kind).toBe("text_sha256");
  });

  test("keys table lists partial unique index on ingestion_trades", () => {
    const keys = flattenSchemaKeys().filter(
      (k) => k.name === "one_open_tx_per_lane_id",
    );
    expect(keys.length).toBe(1);
    expect(keys[0]?.partial).toBe("tx_to IS NULL");
  });

  test("Bun.inspect.custom renders box tables", () => {
    const report = buildSqliteSchemaReportForTable(COMBO_LEGS_SCHEMA.name)!;
    const text = Bun.inspect(report);
    expect(text).toContain("combo_legs");
    expect(text).toContain("canonical_combo_id");
    expect(text).toContain("columns:");
    expect(text).toContain("keys:");
    expect(text).toContain("database  sqlite:///:memory:");
    expect(text).toContain("source    file://");
    expect(text).toContain("generated ");
    expect(report.databaseUrl.href).toBe("sqlite:///:memory:");
    expect(report.sourceUrl.pathname).toContain("sqlite_schema_registry.ts");
    expect(report.summary).toHaveLength(1);
    expect(report.columns.length).toBeGreaterThan(0);
  });

  test("buildSqliteSchemaReport materializes summary/columns/keys", () => {
    const report = buildSqliteSchemaReport();
    expect(report.summary.length).toBeGreaterThanOrEqual(5);
    expect(report.columns.length).toBeGreaterThan(report.summary.length);
  });

  test("branded sqlCol preserves literal type", () => {
    const col = sqlCol("run_at");
    expect(col).toBe(sqlCol("run_at"));
    expect(getTableSchema(sqlTable("match_evaluations"))?.name).toBe(
      sqlTable("match_evaluations"),
    );
  });

  test("schema CLI list exits 0", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "cli/sportsdesk_schema_cli.ts", "--list"],
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const out = await proc.stdout.text();
    expect(out).toContain("match_evaluations");
  });
});
