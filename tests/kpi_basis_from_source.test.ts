/**
 * URL families from docs/INTEGRATION-SOURCES.md — Book KPI `dataSource` / provenance strings only.
 * Market/graph HTTPS URLs are documented as N/A for this classifier.
 */
import { describe, expect, test } from "bun:test";
import { kpiBasisFromSource, type KpiBasis } from "../lib/desk_kpis.ts";
import { R2_PUBLIC_BASE } from "../lib/r2_staleness.ts";

type FamilyCase = {
  readonly source: string;
  readonly expected: KpiBasis;
  readonly note: string;
};

const BOOK_KPI_FAMILIES: readonly FamilyCase[] = [
  {
    source: "live:/cloud/api/Manager/getBetTicker@2026-11-09T03:55:51.106Z",
    expected: "capture",
    note: "F402 ticker live stamp",
  },
  {
    source: "live:/cloud/api/Report/Pending@2026-11-09T03:55:11.528Z",
    expected: "capture",
    note: "F402 pending live stamp",
  },
  {
    source: "capture:/cloud/api/Manager/getBetTicker@2026-11-01T18:00:00Z",
    expected: "capture",
    note: "stored capture",
  },
  {
    source: "paste:clipboard-ticker",
    expected: "paste",
    note: "operator paste",
  },
  {
    source: `${R2_PUBLIC_BASE}/f402-bet-ticker/latest.json`,
    expected: "capture",
    note: "public R2 rollup mirror",
  },
  {
    source: "data/agent-tree.json",
    expected: "capture",
    note: "built agent tree on disk",
  },
  {
    source: "scratch/agent-graph.json",
    expected: "fixture",
    note: "demo graph",
  },
  {
    source: "./enriched_customers_full.json",
    expected: "fixture",
    note: "customer book fixture path",
  },
  {
    source: "tests/fixtures/f402/pending-small.json",
    expected: "fixture",
    note: "test fixture path",
  },
];

describe("kpiBasisFromSource (INTEGRATION-SOURCES families)", () => {
  for (const row of BOOK_KPI_FAMILIES) {
    test(`${row.note}: ${row.expected}`, () => {
      expect(kpiBasisFromSource(row.source)).toBe(row.expected);
    });
  }

  test("external market HTTPS URLs are not Book KPI sources (documented N/A)", () => {
    const external = [
      "https://gamma-api.polymarket.com/public-search?q=test",
      "https://api.elections.kalshi.com/trade-api/v2/markets",
      "https://desk.bookdeskops.com/agent/FOO",
    ];
    for (const source of external) {
      // Today these must not appear on /api/kpis artifacts; if they do, this assertion forces an explicit classifier change.
      expect(kpiBasisFromSource(source)).toBe("fixture");
    }
  });
});
