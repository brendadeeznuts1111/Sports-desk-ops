import { describe, expect, test } from "bun:test";

import {
  ELIGIBLE_LEG_KINDS,
  isEligibleLegKind,
  kindFromF402Row,
  kindFromF402WagerType,
  kindFromKalshiSeries,
  kindFromPolymarketLeg,
  kindFromPolymarketMarket,
  kindFromTypeName,
  kindFromVenue,
} from "../lib/venue_market_kinds.ts";

describe("canonical type names", () => {
  test("the plural and singular venue spellings resolve to one canonical kind", () => {
    expect(kindFromTypeName("moneyline")).toBe("moneyline");
    expect(kindFromTypeName("spreads")).toBe("spread");
    expect(kindFromTypeName("spread")).toBe("spread");
    expect(kindFromTypeName("totals")).toBe("total");
    expect(kindFromTypeName("total")).toBe("total");
    expect(kindFromTypeName("team_total")).toBe("team_total");
    expect(kindFromTypeName("player_props")).toBe("player_prop");
  });

  test("an unrecognised or empty token is unknown, never a guess", () => {
    expect(kindFromTypeName("")).toBe("unknown");
    expect(kindFromTypeName("sportsbook mystery")).toBe("unknown");
  });
});

describe("eligibility policy", () => {
  test("the policy is the canonical three, not the raw strings", () => {
    expect([...ELIGIBLE_LEG_KINDS]).toEqual(["moneyline", "spread", "total"]);
    expect(isEligibleLegKind("spread")).toBe(true);
    expect(isEligibleLegKind("team_total")).toBe(false);
    expect(isEligibleLegKind("player_prop")).toBe(false);
    expect(isEligibleLegKind("unknown")).toBe(false);
  });
});

describe("Polymarket", () => {
  test("reads sports_market_type in both spellings", () => {
    expect(kindFromPolymarketMarket({ sports_market_type: "spreads" })).toBe(
      "spread",
    );
    expect(kindFromPolymarketMarket({ sportsMarketType: "totals" })).toBe(
      "total",
    );
  });

  test("falls back to the picker label when the type field is absent (Gamma today)", () => {
    // Measured 2026-11-09: Gamma returned no sports_market_type on 40/40 open events.
    expect(kindFromPolymarketMarket({ groupItemTitle: "Point spread" })).toBe(
      "spread",
    );
    expect(kindFromPolymarketMarket({})).toBe("unknown");
    expect(kindFromPolymarketMarket(null)).toBe("unknown");
  });

  test("a leg is typed from its nested market before its own fields", () => {
    expect(
      kindFromPolymarketLeg({ market: { sports_market_type: "totals" } }),
    ).toBe("total");
    expect(kindFromPolymarketLeg({ sports_market_type: "moneyline" })).toBe(
      "moneyline",
    );
  });
});

describe("Kalshi", () => {
  test("the series ticker carries the kind because market_type is always binary", () => {
    expect(kindFromKalshiSeries("KXNBAGAME-26NOV09LALATL")).toBe("moneyline");
    expect(kindFromKalshiSeries("KXNBASPREAD-26NOV09LALATL")).toBe("spread");
    expect(kindFromKalshiSeries("KXNBATOTAL-26NOV09LALATL")).toBe("total");
    expect(kindFromKalshiSeries("KXNBAPRA-26NOV09LALATL")).toBe("player_prop");
    expect(kindFromKalshiSeries("KXNBA")).toBe("moneyline");
    expect(kindFromKalshiSeries("KXFOOBAR")).toBe("unknown");
  });

  test("a prop token wins over a league prefix", () => {
    expect(kindFromKalshiSeries("KXNBAPTS")).toBe("player_prop");
    expect(kindFromKalshiSeries("KXNFLTEAMTOTAL")).toBe("team_total");
  });
});

describe("F402 / GSLive", () => {
  test("the picker label wins over the product code", () => {
    // `S` is Straight: it says nothing about the pick, so the label decides.
    expect(kindFromF402Row({ WagerType: "S", SubSport: "Point spread" })).toBe(
      "spread",
    );
    expect(kindFromF402Row({ WagerType: "M" })).toBe("moneyline");
  });

  test("only the codes whose name is a kind map; products stay unknown", () => {
    expect(kindFromF402WagerType("M")).toBe("moneyline");
    expect(kindFromF402WagerType("L")).toBe("total");
    expect(kindFromF402WagerType("E")).toBe("team_total");
    expect(kindFromF402WagerType("T")).toBe("teaser");
    expect(kindFromF402WagerType("S")).toBe("unknown");
    expect(kindFromF402WagerType("P")).toBe("unknown");
    expect(kindFromF402WagerType("C")).toBe("unknown");
  });
});

describe("dispatch", () => {
  test("each venue gets its own reader", () => {
    expect(kindFromVenue("polymarket", "spreads")).toBe("spread");
    expect(kindFromVenue("kalshi", "KXNBAGAME-26NOV09LALATL")).toBe(
      "moneyline",
    );
    expect(kindFromVenue("f402", "L")).toBe("total");
  });
});
