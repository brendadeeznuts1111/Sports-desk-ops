/**
 * The four previously-missing CLI commands now derive their answers from source. Like the
 * ranking tests, every expectation here is computed from the book at run time — no literal
 * customer id, count or ranking is written down.
 */
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildSharpAudit,
  loadCustomerBook,
  lookupCustomer,
  summarizeSample,
} from "../lib/customer_rankings.ts";

// The book is gitignored, so CI and fresh clones do not have it: skip then, as the other
// book-backed suites do. A book that exists but fails to load still throws.
const bookPresent = await Bun.file(
  resolve(import.meta.dir, "..", "enriched_customers_full.json"),
).exists();
const book = bookPresent ? await loadCustomerBook() : [];

describe.skipIf(!bookPresent)("derived customer profile", () => {
  test("lookup is case-insensitive and derives the sample from the row", async () => {
    const first = book[0];
    if (first === undefined) throw new Error("customer book is empty");
    const found = await lookupCustomer(first.customer_id.toLowerCase());
    expect(found.found).toBe(true);
    expect(found.customerId).toBe(first.customer_id);
    expect(found.totalCustomers).toBe(book.length);
    expect(found.sample?.tickets).toBe((first.recent_tickets ?? []).length);
    expect(found.record?.agent_id).toBe(first.agent_id);
  });

  test("unknown id reports not-found with the source size", async () => {
    const missing = await lookupCustomer("NO_SUCH_CUSTOMER_ANYWHERE");
    expect(missing.found).toBe(false);
    expect(missing.totalCustomers).toBe(book.length);
    expect(missing.record).toBeNull();
    expect(missing.sample).toBeNull();
  });

  test("sample summary divides decisive sampled tickets only", () => {
    const sample = summarizeSample([
      { result: "WIN" },
      { result: "LOSS" },
      { result: "LOSS" },
      { result: "VOID" },
    ]);
    expect(sample.tickets).toBe(4);
    expect(sample.winPct).toBeCloseTo(100 / 3, 6);
    expect(sample.results).toEqual({ WIN: 1, LOSS: 2, VOID: 1 });
    expect(summarizeSample([]).winPct).toBeNull();
  });

  test("sharp audit candidates are derived from threshold and positive CLV", async () => {
    const threshold = 70;
    const limit = 5;
    const audit = await buildSharpAudit({
      minSharpScore: threshold,
      limit,
    });
    expect(audit.threshold).toBe(threshold);
    expect(audit.bookCustomers).toBe(book.length);

    const expected = book.filter(
      (row) =>
        (row.sharp_score ?? Number.NEGATIVE_INFINITY) >= threshold ||
        (row.clv_bps ?? 0) > 0,
    );
    expect(audit.candidates).toBe(expected.length);
    expect(audit.rows.length).toBe(Math.min(limit, expected.length));
    expect(audit.rows.map((row) => row.rank)).toEqual(
      audit.rows.map((_, index) => index + 1),
    );

    const scores = audit.rows.map((row) => row.sharpScore ?? 0);
    for (let index = 1; index < scores.length; index += 1) {
      expect(scores[index - 1] ?? 0).toBeGreaterThanOrEqual(scores[index] ?? 0);
    }
    for (const row of audit.rows) {
      const candidate =
        (row.sharpScore ?? Number.NEGATIVE_INFINITY) >= threshold ||
        (row.clvBps ?? 0) > 0;
      expect(candidate).toBe(true);
    }
  });
});
