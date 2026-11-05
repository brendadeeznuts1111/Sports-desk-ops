import type { ColumnRow, KeyRow, TableSummary } from "./schema_report.ts";

function inspectTable<const R extends Record<string, unknown>>(
  rows: readonly R[],
  props?: readonly (keyof R & string)[],
  opts?: { colors?: boolean },
): string {
  return Bun.inspect.table(rows as R[], props as string[] | undefined, opts);
}

export const inspectSummary = (rows: readonly TableSummary[]) =>
  inspectTable(rows, ["table", "domain", "columns", "keys", "appendOnly"], {
    colors: true,
  });

export const inspectColumns = (rows: readonly ColumnRow[]) =>
  inspectTable(
    rows,
    ["table", "column", "sqlType", "kind", "nullable", "keyRoles"],
    { colors: true },
  );

export const inspectKeys = (rows: readonly KeyRow[]) =>
  inspectTable(rows, ["table", "keyKind", "name", "columns", "partial"], {
    colors: true,
  });
