import { describe, expect, test } from "bun:test";
import {
  PendingPanelParseError,
  parsePendingPanelHtml,
} from "./parse_data_tables_html.ts";

const fixtureUrl = new URL(
  "../tests/fixtures/pending-panel-datatables-2026-11-03.html",
  import.meta.url,
);

const panel = parsePendingPanelHtml(await Bun.file(fixtureUrl).text());

describe("parse_data_tables_html", () => {
  test("reads page totals, both filter selects and the pagination labels", () => {
    expect(panel.totals).toEqual({ riskUsd: 61_737.7, toWinUsd: 109_724.24 });
    expect(panel.filters.time.map((option) => option.value)).toEqual([
      "730",
      "0",
      "3",
      "7",
      "14",
    ]);
    expect(panel.filters.type).toHaveLength(9);
    expect(
      panel.filters.type.find((option) => option.value === "G")?.label,
    ).toBe("Racebook");
    expect(panel.pages).toEqual(["1", "2", "3", "4"]);
  });

  test("carries every row data-type through, including codes the filter omits", () => {
    expect(panel.typeCounts).toEqual({
      S: 1,
      M: 1,
      L: 1,
      P: 1,
      T: 1,
      C: 1,
      G: 1,
      X: 1,
    });

    const moneyline = panel.rows.find(
      (row) => row.ticketNumber === "9000000002",
    );
    expect(moneyline?.wagerType).toBe("M");
    expect(moneyline?.legs[0]?.selection).toBe("Paris Saint Germain");
    expect(moneyline?.legs[0]?.line).toBe("ML -140");

    const total = panel.rows.find((row) => row.ticketNumber === "9000000003");
    expect(total?.wagerType).toBe("L");
    expect(total?.legs[0]?.line).toBe("O 76 -110");
    expect(total?.legs[0]?.period).toBe("2nd Half");
  });

  test("splits multi-leg tickets into their legs", () => {
    const parlay = panel.rows.find((row) => row.ticketNumber === "9000000004");
    expect(parlay?.legs).toHaveLength(2);
    expect(parlay?.legs.map((leg) => leg.line)).toEqual([
      "-2½ -110",
      "O 76 -115",
    ]);

    const teaser = panel.rows.find((row) => row.ticketNumber === "9000000005");
    expect(teaser?.legs).toHaveLength(4);
    expect(teaser?.legs[3]?.selection).toBe("Green Bay Packers");
    expect(teaser?.legs[3]?.line).toBe("+16");
  });

  test("G rows expose the game id and the li game lines as legs", () => {
    const game = panel.rows.find((row) => row.ticketNumber === "9000000007");
    expect(game?.gameNumber).toBe("319983682");
    expect(game?.gameLines).toHaveLength(2);
    expect(game?.legs).toHaveLength(2);
    expect(game?.legs[0]?.selection).toContain("Hawaii vs Seattle U");
    expect(game?.legs[1]?.selection).toContain("Toronto Raptors");
  });

  test("an unknown code is carried and flagged, not dropped", () => {
    const unknown = panel.rows.find((row) => row.ticketNumber === "9000000008");
    expect(unknown?.wagerType).toBe("X");
    expect(unknown?.wagerTypeKnown).toBe(false);
    expect(unknown?.status).toBe("Open");
    expect(panel.rows).toHaveLength(8);
  });

  test("normalizes padded accounts, money cells and header fields", () => {
    const straight = panel.rows.find(
      (row) => row.ticketNumber === "9000000001",
    );
    expect(straight?.agent).toBe("AGENT01");
    expect(straight?.customer).toBe("CUST001");
    expect(straight?.riskUsd).toBe(110);
    expect(straight?.toWinUsd).toBe(100);
    expect(straight?.wagerNumber).toBe("9000000001-1");
    expect(straight?.status).toBe("Pending");
    expect(straight?.accepted).toBe("Nov 2, 2026 11:48 PM - (CST)");
    expect(straight?.scheduled).toBe("Nov 8, 2026 12:00 PM - (CST)");
  });

  test("refuses HTML with no wager rows instead of returning an empty list", () => {
    expect(() => parsePendingPanelHtml("<div>no table</div>")).toThrow(
      PendingPanelParseError,
    );
    expect(() => parsePendingPanelHtml("<div>no table</div>")).toThrow(
      "no tr[data-ticket] rows found",
    );
  });
});
