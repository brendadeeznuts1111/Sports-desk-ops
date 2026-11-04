/**
 * The CLI's customer rankings must be DERIVED from `enriched_customers_full.json`, never
 * hardcoded. The expectations here are themselves computed from the book at run time, so a
 * changed book changes what the test expects — no literal customer id or count appears.
 */
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildCustomerRanking,
  loadCustomerBook,
  periodWindow,
} from "../lib/customer_rankings.ts";

// The book is gitignored, so CI and fresh clones do not have it: skip then, as the other
// book-backed suites do. A book that exists but fails to load still throws.
const bookPresent = await Bun.file(
  resolve(import.meta.dir, "..", "enriched_customers_full.json"),
).exists();
const book = bookPresent ? await loadCustomerBook() : [];
const LIMIT = 3;

describe.skipIf(!bookPresent)("derived customer rankings", () => {
  test("winners are the top positive 7d nets from the source rows", async () => {
    const rows = await buildCustomerRanking({
      direction: "winners",
      period: "7d",
      sortBy: "net",
      limit: LIMIT,
    });
    const expected = book
      .filter((row) => (row.sports_7d_net_usd ?? 0) > 0)
      .sort(
        (left, right) =>
          (right.sports_7d_net_usd ?? 0) - (left.sports_7d_net_usd ?? 0),
      )
      .slice(0, LIMIT)
      .map((row) => row.customer_id);

    expect(rows.map((row) => row.customerId)).toEqual(expected);
    expect(rows.length).toBe(Math.min(LIMIT, expected.length));
    expect(rows.every((row) => row.netUSD > 0)).toBe(true);
    expect(rows.map((row) => row.rank)).toEqual(
      rows.map((_, index) => index + 1),
    );
  });

  test("losers are the most negative lifetime nets from the source rows", async () => {
    const rows = await buildCustomerRanking({
      direction: "losers",
      period: "lifetime",
      sortBy: "net",
      limit: LIMIT,
    });
    const expected = book
      .filter((row) => row.lifetime_net_usd < 0)
      .sort((left, right) => left.lifetime_net_usd - right.lifetime_net_usd)
      .slice(0, LIMIT)
      .map((row) => row.customer_id);

    expect(rows.map((row) => row.customerId)).toEqual(expected);
    expect(rows.every((row) => row.netUSD < 0)).toBe(true);
    expect(rows.every((row) => row.grossHold === Math.abs(row.netUSD))).toBe(
      true,
    );
  });

  test("volume ranking is the source volume order, not a fixed list", async () => {
    const rows = await buildCustomerRanking({
      direction: "winners",
      period: "lifetime",
      sortBy: "volume",
      limit: LIMIT,
    });
    const expected = book
      .filter((row) => row.lifetime_net_usd > 0)
      .sort(
        (left, right) => right.lifetime_volume_usd - left.lifetime_volume_usd,
      )
      .slice(0, LIMIT)
      .map((row) => row.customer_id);
    expect(rows.map((row) => row.customerId)).toEqual(expected);
  });

  test("win percent is derived from the sampled tickets, null when undecidable", async () => {
    const rows = await buildCustomerRanking({
      direction: "winners",
      period: "lifetime",
      sortBy: "net",
      limit: 500,
    });
    for (const row of rows) {
      const source = book.find((entry) => entry.customer_id === row.customerId);
      expect(source).toBeDefined();
      const decisive = (source?.recent_tickets ?? []).filter(
        (ticket) => ticket.result === "WIN" || ticket.result === "LOSS",
      );
      if (decisive.length === 0) {
        expect(row.winPct).toBeNull();
      } else {
        const wins = decisive.filter(
          (ticket) => ticket.result === "WIN",
        ).length;
        expect(row.winPct).toBeCloseTo((wins / decisive.length) * 100, 6);
      }
    }
  });

  test("periods the book cannot answer are refused, not remapped", () => {
    expect(periodWindow("7d")).toBe("7d");
    expect(periodWindow("lifetime")).toBe("lifetime");
    expect(periodWindow("all")).toBe("lifetime");
    for (const period of ["24h", "48h", "month", "1y"]) {
      expect(() => periodWindow(period)).toThrow(RangeError);
      expect(() => periodWindow(period)).toThrow("[PERIOD_UNAVAILABLE]");
    }
  });
});
