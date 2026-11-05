import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { checkWagerOrdering } from "../cli/analyze.ts";
import { inspectHtmlFilters } from "../cli/html.ts";
import { assessConfidence } from "../cli/info.ts";

describe("HTML table filters", () => {
  test("detects VIP-only", () => {
    expect(
      inspectHtmlFilters(
        '<input type="checkbox" data-action="vip-active" checked>',
      ).vipOnly,
    ).toBe(true);
  });

  test("detects the bets-over value", () => {
    expect(
      inspectHtmlFilters(
        '<input type="number" data-field="bets-over" value="500">',
      ).betsOver,
    ).toBe(500);
  });

  test("detects hidden wager types", () => {
    const html = `
      <input type="checkbox" data-field="flag-straight" checked>
      <input type="checkbox" data-field="flag-parlay">
      <input type="checkbox" data-field="flag-prop" checked>
    `;
    expect(inspectHtmlFilters(html).hiddenWagerTypes).toEqual([
      "Parlay",
      "Teaser",
      "If-Bet",
    ]);
  });

  test("the default fixture has no filter controls", async () => {
    const html = await Bun.file(
      join(import.meta.dir, "fixtures/bet-ticker.html"),
    ).text();
    const filters = inspectHtmlFilters(html);
    expect(filters.vipOnly).toBe(false);
    expect(filters.betsOver).toBeNull();
    expect(filters.hiddenWagerTypes).toEqual([]);
  });

  test("an HTML capture with active filters is low confidence", () => {
    const filters = inspectHtmlFilters(
      '<input type="checkbox" data-action="vip-active" checked>',
    );
    expect(
      assessConfidence({
        format: "html",
        statusOk: null,
        hasAmounts: false,
        filters,
      }),
    ).toBe("low");
  });
});

describe("wager ordering", () => {
  test("in-order rows have no violations", () => {
    const tickets = [
      { wagerNumber: "100", insertedAt: "2026-11-04T21:00:00" },
      { wagerNumber: "101", insertedAt: "2026-11-04T21:00:05" },
    ];
    expect(checkWagerOrdering(tickets).inOrder).toBe(true);
  });

  test("catches an out-of-order insert", () => {
    const report = checkWagerOrdering([
      { wagerNumber: "100", insertedAt: "2026-11-04T21:00:00" },
      { wagerNumber: "101", insertedAt: "2026-11-04T21:00:05" },
      { wagerNumber: "102", insertedAt: "2026-11-04T21:00:03" },
    ]);
    expect(report.inOrder).toBe(false);
    expect(report.outOfOrder).toHaveLength(1);
    expect(report.outOfOrder[0]?.wager).toBe("102");
  });
});
