import { describe, expect, test } from "bun:test";
import { projectLiveWagerRow } from "@sportsdesk-ops/backend";
import { parseShortDesc } from "../lib/live_wagers.ts";

/**
 * Regression case for ticket 769414122, captured 2026-11-18 20:39:53 ET.
 *
 * The raw wire row says `WagerType: "S"` (Spread) and carries no price, but its `ShortDesc`
 * holds four legs and its payout (537,685 on a 50,000 risk) is a ~+1075 parlay price, not the
 * -110 the projection used to print. `VolumeAmount` (45,455) is the straight-equivalent payout,
 * so the ticket's own fields disagree and only the leg parse can tell what the ticket is.
 */
const RAW_PARLAY = {
  WagerNumber: 769414122,
  AgentID: "ATEAM",
  CustomerID: "AT10359   ",
  Login: "AT10359",
  WagerType: "S",
  AmountWagered: 50000,
  InsertDateTime: "2026-11-18 20:39:53.360",
  ToWinAmount: 537685,
  TicketWriter: "Internet                                          ",
  VolumeAmount: 45455,
  ShortDesc:
    "P.Basketball #572 Nuggets +1 -110 - For 1st Half Basketball #571 Celtics/Nuggets O 113½ -115 - For 1st Half Basketball #575 Suns -3½ -110 - For 1st Half Basketball #578 Lakers -7 -110 - For 1st Half ",
  VIP: "0         ",
  AgentLogin: "ATEAM",
} as const;

const deps = {
  parseShortDesc,
  sharpCustomerIds: new Set<string>(),
  customerBookLookup: () => ({ clvBps: 3770, sharpScore: 2 }),
};

const projected = projectLiveWagerRow({ ...RAW_PARLAY }, 0, deps);

describe("ticket 769414122 — parlay vs straight", () => {
  test("the leg parse wins over the wire's single-leg WagerType", () => {
    expect(projected.legCount).toBe(4);
    expect(projected.wagerTypeCode).toBe("S");
    expect(projected.betType).toBe("Parlay");
    expect(projected.event).toBe("4-leg parlay");
    expect(projected.selection).toBe("4 legs");
    expect(projected.lineDisplay).toBe("—");
  });

  test("the price is implied from risk/payout, not fabricated as -110", () => {
    // 537,685 / 50,000 = 10.7537 → +1075 American.
    expect(projected.oddsAmerican).toBe("+1075");
  });

  test("the wire's risk, volume and payout are preserved, not reconciled away", () => {
    expect(projected.riskUsd).toBe(50000);
    expect(projected.volumeUsd).toBe(45455);
    expect(projected.toWinUsd).toBe(537685);
  });
});

describe("directive gate — risk above the cap", () => {
  test("a 50,000 ticket never keeps Accept Normal at a 25,000 cap", () => {
    expect(projected.maxRecommendedStake).toBe(25000);
    expect(projected.riskUsd).toBeGreaterThan(projected.maxRecommendedStake);
    expect(projected.operatorDirective).not.toContain("Accept Normal");
    expect(projected.operatorDirective).toContain("Oversize");
    expect(projected.operatorDirective).toContain("50,000");
    expect(projected.operatorDirective).toContain("25,000");
    expect(projected.alertBadge).toContain("OVERSIZE");
    expect(projected.autoExecute).toBe(false);
  });

  test("the gate applies to a straight ticket too", () => {
    const straight = projectLiveWagerRow(
      {
        CustomerID: "REC9",
        WagerType: "S",
        AmountWagered: 50000,
        ToWinAmount: 45455,
        ShortDesc: "P.Basketball #572 Nuggets +1 -110 - For 1st Half",
      },
      1,
      deps,
    );
    expect(straight.legCount).toBe(1);
    expect(straight.betType).toBe("Spread");
    expect(straight.oddsAmerican).toBe("-110");
    expect(straight.operatorDirective).not.toContain("Accept Normal");
    expect(straight.operatorDirective).toContain("Oversize");
  });

  test("a ticket inside the cap keeps the normal directive", () => {
    const normal = projectLiveWagerRow(
      {
        CustomerID: "REC9",
        WagerType: "S",
        AmountWagered: 5000,
        ToWinAmount: 4545,
        ShortDesc: "P.Basketball #572 Nuggets +1 -110 - For 1st Half",
      },
      2,
      deps,
    );
    expect(normal.operatorDirective).toBe("Accept Normal (autoExecute: false)");
    expect(normal.alertBadge).not.toContain("OVERSIZE");
  });
});

describe("book-level CLV and score are passed through, never rescaled", () => {
  test("customerClvBps keeps the source unit and the score stays as reported", () => {
    // 3770 is the source value for this customer; the projection's job is not to divide it.
    expect(projected.customerClvBps).toBe(3770);
    expect(projected.customerSharpScore).toBe(2);
  });

  test("no closing-line join means clvCents stays null", () => {
    expect(projected.clvCents).toBeNull();
  });
});

describe("unknowns stay unknown instead of becoming plausible strings", () => {
  test("subSport is null when the wire carries no league", () => {
    expect(projected.subSport).toBeNull();
  });

  test("a wire price, when present, is preserved verbatim", () => {
    const withPrice = projectLiveWagerRow(
      {
        CustomerID: "REC9",
        WagerType: "M",
        AmountWagered: 100,
        ToWinAmount: 150,
        oddsAmerican: "+150",
        ShortDesc: "P.Basketball #572 Nuggets +1 - For 1st Half",
      },
      3,
      deps,
    );
    expect(withPrice.oddsAmerican).toBe("+150");
  });
});
