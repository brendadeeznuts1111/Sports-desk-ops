/**
 * @file lib/row_parse.ts
 * @description Read a database row without coercing absent values into plausible ones.
 *
 * `String(row["x"])` turns a missing column into `"undefined"` and `Number(null)` into `0`, so a
 * schema drift becomes a wrong fact instead of an error. These helpers fail with the column name.
 */

export type Row = Record<string, unknown>;

export function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function column(row: Row, name: string): unknown {
  if (!(name in row)) throw new Error(`missing column "${name}"`);
  return row[name];
}

export function stringColumn(row: Row, name: string): string {
  const value = column(row, name);
  if (typeof value !== "string") {
    throw new Error(
      `column "${name}" is ${value === null ? "null" : typeof value}, expected string`,
    );
  }
  return value;
}

export function numberColumn(row: Row, name: string): number {
  const value = column(row, name);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `column "${name}" is ${typeof value}, expected finite number`,
    );
  }
  return value;
}

/** SQLite can return `null` for a nullable TEXT column; anything else is an error. */
export function nullableStringColumn(row: Row, name: string): string | null {
  const value = column(row, name);
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(
      `column "${name}" is ${typeof value}, expected string or null`,
    );
  }
  return value;
}

/** Map every row through a parser, keeping the failure attached to its index. */
export function parseRows<T>(
  rows: readonly unknown[],
  parse: (row: Row) => T,
): T[] {
  return rows.map((value, index) => {
    if (!isRow(value)) throw new Error(`row ${index} is not an object`);
    try {
      return parse(value);
    } catch (error) {
      throw new Error(`row ${index}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  });
}
