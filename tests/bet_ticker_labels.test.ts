import { describe, expect, test } from "bun:test";

import {
  periodCode,
  SUB_TYPE,
  TICKET_STRUCTURE,
  WAGER_TYPE_LABEL,
  wagerTypeLabel,
} from "../lib/bet_ticker_labels.ts";
import { wagerTypeLabel as legacyPositionLabel } from "../lib/game_admin.ts";

/**
 * Labels from `app/util/util.js` (`getTypeInfo`, `BET.SUB_TYPE`, `typePeriod`). The Game
 * Admin position map is a different namespace and is asserted separately so the discrepancy
 * cannot quietly disappear.
 */
describe("bet ticker labels", () => {
  test("getTypeInfo maps every wire WagerType code", () => {
    expect(WAGER_TYPE_LABEL).toEqual({
      A: "Manual Play",
      M: "Moneyline",
      C: "Future/Props",
      S: "Spread",
      T: "Teaser",
      L: "Total",
      E: "Team Total",
      I: "If-Bet",
      P: "Parlay",
      G: "Live/Racebook",
    });
    expect(wagerTypeLabel("S")).toBe("Spread");
    expect(wagerTypeLabel(" m ")).toBe("Moneyline");
    expect(wagerTypeLabel("P")).toBe("Parlay");
    expect(wagerTypeLabel("L")).toBe("Total");
    expect(wagerTypeLabel("E")).toBe("Team Total");
    expect(wagerTypeLabel("C")).toBe("Future/Props");
    expect(wagerTypeLabel("A")).toBe("Manual Play");
    expect(wagerTypeLabel("T")).toBe("Teaser");
    expect(wagerTypeLabel("I")).toBe("If-Bet");
    expect(wagerTypeLabel("G")).toBe("Live/Racebook");
    expect(wagerTypeLabel("Z")).toBe("Other");
    expect(wagerTypeLabel("")).toBe("Other");
  });

  test("leg SUB_TYPE is a separate namespace", () => {
    expect(SUB_TYPE).toEqual({
      L: "total",
      E: "team-total",
      S: "spread",
      M: "money",
      G: "live",
    });
  });

  test("periodCode uses the canonical typePeriod abbreviations", () => {
    expect(periodCode("Game")).toBe("Game");
    expect(periodCode("Prop")).toBe("Prop");
    expect(periodCode("1st Half")).toBe("1H");
    expect(periodCode("2nd Half")).toBe("2H");
    expect(periodCode("3rd Quarter")).toBe("3Q");
    expect(periodCode("1st Period")).toBe("1P");
    expect(periodCode("1st 5 Innings")).toBe("1st 5");
    expect(periodCode("Last 4 Innings")).toBe("Last 4");
    expect(periodCode(" Match (Including OT) ")).toBe("Match (Including OT)");
  });

  test("the HTML Type column is ticket structure, not WagerType", () => {
    expect(TICKET_STRUCTURE).toEqual(["Straight", "Parlay", "Prop", "Teaser"]);
    // The legacy Game Admin map treats S as Straight; the client says S is Spread.
    expect(wagerTypeLabel("S")).toBe("Spread");
    expect(legacyPositionLabel("S")).toBe("Straight");
  });
});
