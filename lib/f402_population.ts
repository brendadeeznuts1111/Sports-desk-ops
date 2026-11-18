/**
 * @file lib/f402_population.ts
 * @description Population boundary for the f402 decision artifacts (#234).
 *
 * The two datasets behind these artifacts were never reconciled 1:1:
 *
 * - the summary book is one downline (`agentID=BILLY666`, 610 offices), captured for
 *   2026-10-31..2026-11-14, 6,228 customer rows;
 * - the graded wager exports are bare arrays with no scope metadata, and their events span a
 *   wider population.
 *
 * Decision (2026-11-15, #234): the artifact is the desk's instrument about the desk's book, so it
 * is built from the summary book only. Mixing graded events from outside that downline into the
 * peer baseline is a population-boundary error, not missing data. 13,236 of 70,869 deduped graded
 * rows (2,181 customers) fall outside the 6,228 and leave the analysis; the subject account
 * `CCC88412` is inside the book, so nothing about it is dropped.
 *
 * The restriction is applied once per builder and the *whole* builder sees the restricted rows, so
 * every derived count, ratio and z-score in an artifact describes one population. Filtering at one
 * call site only would leave a report whose headline and appendix describe different books.
 */

export interface PopulationRestriction<T> {
  /** The rows that survive the boundary. */
  readonly rows: T[];
  /** Counts for the artifact's provenance block — both sides, so the exclusion is auditable. */
  readonly summaryCustomerCount: number;
  readonly rowsBefore: number;
  readonly rowsAfter: number;
  readonly droppedRows: number;
  readonly droppedCustomers: number;
  readonly rule: string;
}

export const SUMMARY_BOOK_ONLY_RULE =
  "graded wager rows are restricted to CustomerIDs present in the summary book " +
  "(agentID=BILLY666, 610 offices, captured 2026-10-31..2026-11-14); rows from outside " +
  "that downline are excluded from every count, baseline and z-score in this artifact";

function customerIdOf(row: { CustomerID?: unknown }): string {
  const value = row.CustomerID;
  return value === undefined || value === null ? "" : String(value).trim();
}

/**
 * Restricts graded rows to the summary book's customers.
 *
 * A row with a blank `CustomerID` cannot be attributed to the book, so it is dropped like any
 * other out-of-population row — silently keeping it would reintroduce the mismatch this closes.
 */
export function restrictGradedRowsToSummaryBook<
  T extends { CustomerID?: unknown },
>(
  gradedRows: readonly T[],
  summaryRows: ReadonlyArray<{ CustomerID?: unknown }>,
): PopulationRestriction<T> {
  const summaryIds = new Set<string>();
  for (const row of summaryRows) {
    const id = customerIdOf(row);
    if (id !== "") summaryIds.add(id);
  }

  const kept: T[] = [];
  const dropped = new Set<string>();
  for (const row of gradedRows) {
    const id = customerIdOf(row);
    if (id !== "" && summaryIds.has(id)) kept.push(row);
    else dropped.add(id === "" ? "<blank>" : id);
  }

  return {
    rows: kept,
    summaryCustomerCount: summaryIds.size,
    rowsBefore: gradedRows.length,
    rowsAfter: kept.length,
    droppedRows: gradedRows.length - kept.length,
    droppedCustomers: dropped.size,
    rule: SUMMARY_BOOK_ONLY_RULE,
  };
}

/** The provenance shape emitted into an artifact — the counts a reader can audit the boundary by. */
export interface PopulationRestrictionSummary {
  readonly rule: string;
  readonly summaryCustomerCount: number;
  readonly gradedRowsBefore: number;
  readonly gradedRowsAfter: number;
  readonly droppedRows: number;
  readonly droppedCustomers: number;
}

export function summarizePopulationRestriction<T>(
  restriction: PopulationRestriction<T>,
): PopulationRestrictionSummary {
  return {
    rule: restriction.rule,
    summaryCustomerCount: restriction.summaryCustomerCount,
    gradedRowsBefore: restriction.rowsBefore,
    gradedRowsAfter: restriction.rowsAfter,
    droppedRows: restriction.droppedRows,
    droppedCustomers: restriction.droppedCustomers,
  };
}
