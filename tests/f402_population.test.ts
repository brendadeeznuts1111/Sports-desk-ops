/**
 * @file tests/f402_population.test.ts
 * @description Unit tests for the population boundary (#234).
 *
 * The property that matters is not "some rows are dropped" but "the artifact can only ever see one
 * population": every in-book row survives untouched, every out-of-book row leaves, and the counts
 * an artifact publishes are the counts this function returns.
 */

import { describe, expect, test } from "bun:test";

import {
  SUMMARY_BOOK_ONLY_RULE,
  restrictGradedRowsToSummaryBook,
  summarizePopulationRestriction,
} from "../lib/f402_population.ts";

const summary = [
  { CustomerID: "A1" },
  { CustomerID: "A2" },
  { CustomerID: " A3 " }, // summary ids are trimmed too
  { CustomerID: "" }, // unusable summary row must not create an "" membership
];

const graded = [
  { CustomerID: "A1", TicketNumber: 1 },
  { CustomerID: "A2", TicketNumber: 2 },
  { CustomerID: "A3", TicketNumber: 3 }, // matches the trimmed summary id
  { CustomerID: "Z9", TicketNumber: 4 }, // outside the book
  { CustomerID: "Z9", TicketNumber: 5 }, // outside, same customer
  { CustomerID: "Y8", TicketNumber: 6 }, // outside, different customer
  { CustomerID: "", TicketNumber: 7 }, // unattributable
  { TicketNumber: 8 }, // missing id entirely
];

describe("restrictGradedRowsToSummaryBook", () => {
  test("keeps exactly the in-book rows, in order", () => {
    const r = restrictGradedRowsToSummaryBook(graded, summary);
    expect(r.rows.map((x) => x.TicketNumber)).toEqual([1, 2, 3]);
  });

  test("counts both sides so the artifact can publish the exclusion", () => {
    const r = restrictGradedRowsToSummaryBook(graded, summary);
    expect(r.rowsBefore).toBe(8);
    expect(r.rowsAfter).toBe(3);
    expect(r.droppedRows).toBe(5);
    // Z9, Y8, and one unattributable bucket shared by the blank-id and missing-id rows.
    expect(r.droppedCustomers).toBe(3);
    expect(r.summaryCustomerCount).toBe(3);
  });

  test("cannot be talked into keeping an unidentifiable row", () => {
    // A blank CustomerID cannot be attributed to the book, so it is out of population like any
    // other outsider. Keeping it would silently reopen the mismatch this closes.
    const r = restrictGradedRowsToSummaryBook(graded, summary);
    expect(r.rows.some((x) => String(x.CustomerID ?? "").trim() === "")).toBe(
      false,
    );
  });

  test("an empty summary book empties the corpus rather than passing it through", () => {
    const r = restrictGradedRowsToSummaryBook(graded, []);
    expect(r.rows).toEqual([]);
    expect(r.rowsAfter).toBe(0);
    expect(r.droppedRows).toBe(8);
    expect(r.summaryCustomerCount).toBe(0);
  });

  test("an empty corpus is not an error", () => {
    const r = restrictGradedRowsToSummaryBook([], summary);
    expect(r.rows).toEqual([]);
    expect(r.droppedRows).toBe(0);
  });

  test("carries the rule text, so provenance cannot be emitted blank", () => {
    const r = restrictGradedRowsToSummaryBook(graded, summary);
    expect(r.rule).toBe(SUMMARY_BOOK_ONLY_RULE);
    expect(r.rule).toContain("summary book");
  });

  test("the published summary is the audit of the boundary", () => {
    const r = restrictGradedRowsToSummaryBook(graded, summary);
    expect(summarizePopulationRestriction(r)).toEqual({
      rule: SUMMARY_BOOK_ONLY_RULE,
      summaryCustomerCount: 3,
      gradedRowsBefore: 8,
      gradedRowsAfter: 3,
      droppedRows: 5,
      droppedCustomers: 3,
    });
  });
});
