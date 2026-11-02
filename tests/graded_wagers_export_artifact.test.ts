import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The Graded Wagers export, reduced to its shape.
 *
 * The workbook itself is 2.4 MB of customer logins, ticket numbers and descriptions, so it is not
 * committed. What is committed is what the file *is*: five columns, 9,387 rows, one row per graded
 * wager. This test exists so the artifact cannot quietly grow row data later.
 */
const exported = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../data/graded-wagers-export-2026-11-01.json"),
    "utf8",
  ),
) as {
  source: string;
  observedAt: string;
  columns: string[];
  rowCount: number;
  headerRowCount: number;
  cellsPerRow: number;
  fileCommitted: boolean;
  notes: string[];
};

describe("graded wagers export artifact", () => {
  test("records the shape, not the rows", () => {
    expect(exported.columns).toEqual([
      "Customer",
      "Ticket Number",
      "Accepted",
      "Description",
      "Amount",
    ]);
    expect(exported.rowCount).toBe(9387);
    expect(exported.headerRowCount).toBe(1);
    expect(exported.cellsPerRow).toBe(5);
  });

  test("carries no per-row data at all", () => {
    // No array of records, no sample rows, no logins. Anything row-shaped here would be PII.
    const raw = JSON.stringify(exported);
    expect(Object.keys(exported)).not.toContain("rows");
    expect(Object.keys(exported)).not.toContain("wagers");
    expect(Object.keys(exported)).not.toContain("sample");
    expect(raw).not.toMatch(/[A-Z]{2,}[0-9]{2,}/); // login/ticket shapes
    expect(raw).not.toContain("eyJ");
  });

  test("says the workbook is not committed, and why", () => {
    expect(exported.fileCommitted).toBe(false);
    const raw = readFileSync(
      resolve(import.meta.dir, "../data/graded-wagers-export-2026-11-01.json"),
      "utf8",
    );
    expect(raw).toContain("customer login");
  });

  test("is labelled as an export, with a timestamp", () => {
    expect(exported.source).toBe("export:xlsx");
    expect(exported.observedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
    );
  });

  test("distinguishes itself from the Analysis grid", () => {
    // Five wager-level columns here; seven aggregate columns on the Analysis table. Confusing the
    // two would produce a report that cannot be reconciled.
    const notes = exported.notes.join(" ");
    expect(notes).toContain("wager-level export");
    expect(notes).toContain("not the Analysis grid");
    expect(notes).toContain("seven aggregate columns");
  });
});
