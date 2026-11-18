import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sqlCol } from "../lib/brand.ts";
import { SchemaBrandError } from "../lib/schema_brand_error.ts";
import {
  findColumnLine,
  formatSchemaError,
  formatSchemaJumpLink,
  parseSchemaErrorTarget,
  resolveSchemaErrorJump,
} from "../lib/schema_cli_errors.ts";

describe("schema_cli_errors", () => {
  test("sqlCol throws SchemaBrandError with invalid column name message", () => {
    const bad = "Run_at_typo";
    expect(() => (sqlCol as (name: string) => unknown)(bad)).toThrow(
      SchemaBrandError,
    );
    try {
      (sqlCol as (name: string) => unknown)(bad);
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaBrandError);
      expect((e as SchemaBrandError).message).toBe(
        "invalid column name: Run_at_typo",
      );
      expect((e as SchemaBrandError).identifier).toBe("Run_at_typo");
    }
  });

  test("findColumnLine locates SSOT column entry", () => {
    const sample = `
  match_evaluations: {
    columns: {
      run_at: { kind: "text_iso_time", nullable: "NO" },
      run_at_typo: { kind: "text", nullable: "NO" },
    },
  },
`;
    expect(findColumnLine(sample, "run_at_typo")).toBe(5);
    expect(findColumnLine(sample, "run_at")).toBe(4);
  });

  test("parseSchemaErrorTarget and resolveSchemaErrorJump", async () => {
    const err = new SchemaBrandError(
      "invalid column name: run_at",
      "column",
      "run_at",
    );
    const target = parseSchemaErrorTarget(err);
    expect(target?.tag).toBe("brand");
    if (target?.tag === "brand") {
      expect(target.kind).toBe("column");
      expect(target.identifier).toBe("run_at");
    }
    const ssot = await Bun.file(
      join(import.meta.dir, "../lib/sqlite_schema_ssot.ts"),
    ).text();
    const line = findColumnLine(ssot, "run_at");
    expect(line).toBeGreaterThan(1);
    const resolved = await resolveSchemaErrorJump(target!);
    expect(resolved.line).toBe(line);

    const oscLink = formatSchemaJumpLink(resolved);
    expect(oscLink).toContain(`line=${line}&column=1`);
    expect(oscLink).toContain(`sqlite_schema_ssot.ts:${line}:1`);
  });

  test("formatSchemaError includes message", () => {
    const text = formatSchemaError(
      new SchemaBrandError("invalid column name: x", "column", "x"),
    );
    expect(text).toContain("invalid column name: x");
    expect(text).toContain("column");
    expect(text).toContain("schema error:");
  });
});
