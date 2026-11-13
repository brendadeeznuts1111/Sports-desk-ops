import { describe, expect, test } from "bun:test";
import {
  classifyLegIntoTaxonomy,
  getValidPeriodsForSelection,
  isPeriodValidForSportId,
  isPeriodValidForSubSportId,
  MARKET_CODES,
  MARKET_COUNT,
  MARKET_ID_MONEYLINE,
  MARKET_ID_SPREAD,
  MARKET_ID_TEAM_TOTAL,
  MARKET_ID_TOTAL,
  MARKET_LABELS,
  marketIndexOf,
  PERIOD_CODES,
  PERIOD_COUNT,
  PERIOD_DEFAULT_LABELS,
  PERIOD_ID_3Q,
  PERIOD_ID_GAME,
  PERIOD_PORTAL_NUMBERS,
  periodIndexOf,
  resolveSlicePolicyAndRisk,
  SPORT_CODES,
  SPORT_COUNT,
  SPORT_ID_BASKETBALL,
  SPORT_ID_FOOTBALL,
  SPORT_ID_LIVE,
  SPORT_LABELS,
  sportIndexOf,
  SUB_ID_NFL,
  SUB_ID_NFL_LIVE,
  SUBSPORT_BUY_ELIGIBLE_PERIOD_MASK,
  SUBSPORT_CODES,
  SUBSPORT_COUNT,
  SUBSPORT_PARENT_SPORT_ID,
  SUBSPORT_TAXONOMY_CATALOG,
  SUBSPORT_VALID_PERIOD_MASK,
  subSportIndexOf,
} from "../lib/market_taxonomy_catalog.ts";

describe("catalog invariants", () => {
  test("count constants match their lists and labels", () => {
    expect(SPORT_CODES).toHaveLength(SPORT_COUNT);
    expect(SPORT_LABELS).toHaveLength(SPORT_COUNT);
    expect(SUBSPORT_CODES).toHaveLength(SUBSPORT_COUNT);
    expect(PERIOD_CODES).toHaveLength(PERIOD_COUNT);
    expect(PERIOD_DEFAULT_LABELS).toHaveLength(PERIOD_COUNT);
    expect(PERIOD_PORTAL_NUMBERS).toHaveLength(PERIOD_COUNT);
    expect(MARKET_CODES).toHaveLength(MARKET_COUNT);
    expect(MARKET_LABELS).toHaveLength(MARKET_COUNT);
    expect(SUBSPORT_TAXONOMY_CATALOG).toHaveLength(SUBSPORT_COUNT);
  });

  test("every code list is unique", () => {
    expect(new Set(SPORT_CODES).size).toBe(SPORT_CODES.length);
    expect(new Set(SUBSPORT_CODES).size).toBe(SUBSPORT_CODES.length);
    expect(new Set(PERIOD_CODES).size).toBe(PERIOD_CODES.length);
    expect(new Set(MARKET_CODES).size).toBe(MARKET_CODES.length);
  });

  test("every catalog spec is internally consistent with the code lists", () => {
    for (let i = 0; i < SUBSPORT_TAXONOMY_CATALOG.length; i++) {
      const spec = SUBSPORT_TAXONOMY_CATALOG[i]!;
      expect(spec.code).toBe(SUBSPORT_CODES[i]!);
      expect(SPORT_CODES).toContain(spec.sport);
      expect(SUBSPORT_PARENT_SPORT_ID[i]).toBe(
        sportIndexOf(spec.sport) === -1 ? 6 : sportIndexOf(spec.sport),
      );
      const codes = spec.validPeriods.map((period) => period.code);
      expect(new Set(codes).size).toBe(codes.length);
      for (const code of codes) expect(PERIOD_CODES).toContain(code);
    }
  });

  test("the bitmask tables agree with the catalog declarations", () => {
    for (let i = 0; i < SUBSPORT_TAXONOMY_CATALOG.length; i++) {
      const spec = SUBSPORT_TAXONOMY_CATALOG[i]!;
      let validMask = 0;
      let buyMask = 0;
      for (let p = 0; p < PERIOD_CODES.length; p++) {
        const declared = spec.validPeriods.find(
          (period) => period.code === PERIOD_CODES[p],
        );
        if (declared !== undefined) {
          validMask |= 1 << p;
          if (declared.allowsPointBuys) buyMask |= 1 << p;
        }
      }
      expect(SUBSPORT_VALID_PERIOD_MASK[i]).toBe(validMask);
      expect(SUBSPORT_BUY_ELIGIBLE_PERIOD_MASK[i]).toBe(buyMask);
    }
  });
});

describe("index lookups", () => {
  test("map known codes to their catalog positions", () => {
    expect(sportIndexOf("Football")).toBe(0);
    expect(sportIndexOf("LIVE")).toBe(5);
    expect(subSportIndexOf("NFL")).toBe(0);
    expect(subSportIndexOf("NBA_Live")).toBe(12);
    expect(periodIndexOf("game")).toBe(0);
    expect(periodIndexOf("round")).toBe(14);
    expect(marketIndexOf("team_total")).toBe(3);
    expect(marketIndexOf("other")).toBe(5);
  });

  test("return -1 for ALL, missing and unknown filters", () => {
    expect(sportIndexOf("ALL")).toBe(-1);
    expect(sportIndexOf(undefined)).toBe(-1);
    expect(sportIndexOf("Nope" as never)).toBe(-1);
    expect(subSportIndexOf("ALL")).toBe(-1);
    expect(periodIndexOf(undefined)).toBe(-1);
    expect(marketIndexOf("ALL")).toBe(-1);
  });
});

describe("period validity", () => {
  test("reads the sub-sport mask, failing open only on an out-of-range sub-sport", () => {
    expect(isPeriodValidForSubSportId(SUB_ID_NFL, PERIOD_ID_GAME)).toBe(true);
    expect(isPeriodValidForSubSportId(SUB_ID_NFL, 1)).toBe(true);
    expect(isPeriodValidForSubSportId(SUB_ID_NFL, PERIOD_ID_3Q)).toBe(true);
    expect(isPeriodValidForSubSportId(SUB_ID_NFL, 99)).toBe(false);
    expect(isPeriodValidForSubSportId(99, PERIOD_ID_GAME)).toBe(true);
  });

  test("unions the sub-sports of a sport", () => {
    expect(isPeriodValidForSportId(SPORT_ID_FOOTBALL, PERIOD_ID_3Q)).toBe(true);
    expect(isPeriodValidForSportId(SPORT_ID_FOOTBALL, PERIOD_ID_GAME)).toBe(
      true,
    );
    expect(isPeriodValidForSportId(SPORT_ID_BASKETBALL, 14)).toBe(false);
  });

  test("returns the catalog periods for a specific sub-sport", () => {
    const codes = getValidPeriodsForSelection(
      SPORT_ID_FOOTBALL,
      SUB_ID_NFL,
    ).map((period) => period.code);
    expect(codes).toEqual(["game", "1h", "2h", "1q", "2q", "3q", "4q"]);
  });

  test("returns the deduped union for ALL, allowing point buys only at game", () => {
    const all = getValidPeriodsForSelection(-1, -1);
    expect(all).toHaveLength(PERIOD_COUNT);
    expect(
      all
        .filter((period) => period.allowsPointBuys)
        .map((period) => period.code),
    ).toEqual(["game"]);
  });
});

describe("resolveSlicePolicyAndRisk", () => {
  const policy = (
    sportId: number,
    subSportId: number,
    periodId: number,
    marketId: number,
    holdPct = 0,
    buyLegs = 0,
  ) =>
    resolveSlicePolicyAndRisk(
      sportId,
      subSportId,
      periodId,
      marketId,
      holdPct,
      buyLegs,
    );

  test("football spread defaults to key-leak exposure and escalates with buying legs", () => {
    expect(
      policy(SPORT_ID_FOOTBALL, SUB_ID_NFL, PERIOD_ID_GAME, MARKET_ID_SPREAD),
    ).toMatchObject({
      pointBuyPolicy: "KEY_LEAK_EXPOSED",
      riskStatus: "POSITIVE_HOLD",
    });
    expect(
      policy(
        SPORT_ID_FOOTBALL,
        SUB_ID_NFL,
        PERIOD_ID_GAME,
        MARKET_ID_SPREAD,
        0,
        1,
      ).riskStatus,
    ).toBe("SEVERE_LEAK");
    expect(
      policy(
        SPORT_ID_FOOTBALL,
        SUB_ID_NFL,
        PERIOD_ID_GAME,
        MARKET_ID_SPREAD,
        -3,
        1,
      ).riskStatus,
    ).toBe("CRITICAL_LEAK");
  });

  test("football totals carry positive hold; basketball carries desk advantage", () => {
    expect(
      policy(SPORT_ID_FOOTBALL, SUB_ID_NFL, PERIOD_ID_GAME, MARKET_ID_TOTAL),
    ).toMatchObject({
      pointBuyPolicy: "HOUSE_HOLD_ADVANTAGE",
      riskStatus: "POSITIVE_HOLD",
    });
    expect(
      policy(SPORT_ID_BASKETBALL, 2, PERIOD_ID_GAME, MARKET_ID_SPREAD),
    ).toMatchObject({
      pointBuyPolicy: "HOUSE_HOLD_ADVANTAGE",
      riskStatus: "DESK_ADVANTAGE",
    });
  });

  test("derivative periods, non-buy markets, other sports and live are strictly blocked", () => {
    const blocked = [
      policy(SPORT_ID_FOOTBALL, SUB_ID_NFL, PERIOD_ID_3Q, MARKET_ID_SPREAD),
      policy(
        SPORT_ID_FOOTBALL,
        SUB_ID_NFL,
        PERIOD_ID_GAME,
        MARKET_ID_MONEYLINE,
      ),
      policy(
        SPORT_ID_FOOTBALL,
        SUB_ID_NFL,
        PERIOD_ID_GAME,
        MARKET_ID_TEAM_TOTAL,
      ),
      policy(2, 5, PERIOD_ID_GAME, MARKET_ID_SPREAD),
      policy(SPORT_ID_LIVE, 10, PERIOD_ID_GAME, MARKET_ID_SPREAD),
      policy(-1, SUB_ID_NFL_LIVE, PERIOD_ID_GAME, MARKET_ID_SPREAD),
    ];
    for (const result of blocked) {
      expect(result).toMatchObject({
        pointBuyPolicy: "STRICTLY_BLOCKED",
        riskStatus: "IMMUNE_BLOCKED",
      });
    }
  });

  test("the ALL selection falls back to the football spread vector", () => {
    expect(policy(-1, -1, PERIOD_ID_GAME, MARKET_ID_SPREAD)).toMatchObject({
      pointBuyPolicy: "KEY_LEAK_EXPOSED",
      riskStatus: "POSITIVE_HOLD",
    });
  });
});

describe("classifyLegIntoTaxonomy", () => {
  test("prefers relational hints over description text", () => {
    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "Kansas City Chiefs -3 -110",
        sportCode: "football",
        leagueName: "NFL",
        marketPeriod: "full_game",
        marketType: "spread",
        hasPositiveBuyPoints: false,
      }),
    ).toEqual({
      sportId: 0,
      subSportId: 0,
      periodId: 0,
      marketId: 0,
      hasPointBuy: false,
    });

    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "Alabama Crimson Tide O 55.5",
        sportCode: "football",
        leagueName: "NCAAF",
        marketPeriod: "full_game",
        marketType: "total",
        hasPositiveBuyPoints: false,
      }),
    ).toEqual({
      sportId: 0,
      subSportId: 1,
      periodId: 0,
      marketId: 1,
      hasPointBuy: false,
    });

    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "New York Liberty",
        sportCode: "basketball",
        leagueName: "WNBA",
        marketType: "spread",
        hasPositiveBuyPoints: false,
      }),
    ).toEqual({
      sportId: 1,
      subSportId: 4,
      periodId: 0,
      marketId: 0,
      hasPointBuy: false,
    });

    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "Duke Blue Devils",
        sportCode: "basketball",
        leagueName: "NCAAB",
        marketPeriod: "1h",
        marketType: "total",
        hasPositiveBuyPoints: false,
      }),
    ).toEqual({
      sportId: 1,
      subSportId: 3,
      periodId: 1,
      marketId: 1,
      hasPointBuy: false,
    });

    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "hockey alter Rangers",
        sportCode: "hockey",
        leagueName: "NHL",
        marketType: "spread",
        hasPositiveBuyPoints: false,
      }),
    ).toEqual({
      sportId: 2,
      subSportId: 6,
      periodId: 0,
      marketId: 0,
      hasPointBuy: false,
    });

    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "Yankees vs Red Sox",
        sportCode: "baseball",
        leagueName: "SERIES",
        marketType: "moneyline",
        hasPositiveBuyPoints: false,
      }),
    ).toEqual({
      sportId: 3,
      subSportId: 8,
      periodId: 0,
      marketId: 2,
      hasPointBuy: false,
    });
  });

  test("falls back to the description and infers team, period and market", () => {
    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "NFL Football Kansas City Chiefs -3 -110",
        hasPositiveBuyPoints: false,
      }),
    ).toEqual({
      sportId: 0,
      subSportId: 0,
      periodId: 0,
      marketId: 0,
      hasPointBuy: false,
    });

    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "NBA Basketball O 226.5",
        hasPositiveBuyPoints: false,
      }),
    ).toEqual({
      sportId: 1,
      subSportId: 2,
      periodId: 0,
      marketId: 1,
      hasPointBuy: false,
    });

    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "MLB Baseball Yankees +150",
        hasPositiveBuyPoints: false,
      }),
    ).toEqual({
      sportId: 3,
      subSportId: 7,
      periodId: 0,
      marketId: 2,
      hasPointBuy: false,
    });

    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "NFL Football Chiefs team total over 27.5",
        hasPositiveBuyPoints: false,
      }),
    ).toEqual({
      sportId: 0,
      subSportId: 0,
      periodId: 0,
      marketId: 3,
      hasPointBuy: false,
    });

    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "NFL Football player prop Mahomes passing yards",
        hasPositiveBuyPoints: false,
      }),
    ).toEqual({
      sportId: 0,
      subSportId: 0,
      periodId: 0,
      marketId: 4,
      hasPointBuy: false,
    });
  });

  test("promotes marked and #9000-series legs to the live sub-sport", () => {
    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "NBA Basketball Los Angeles Lakers (Live)",
        hasPositiveBuyPoints: false,
      }),
    ).toEqual({
      sportId: 5,
      subSportId: 12,
      periodId: 0,
      marketId: 5,
      hasPointBuy: false,
    });

    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "Football #9012 Buffalo Bills -7",
        hasPositiveBuyPoints: false,
      }),
    ).toEqual({
      sportId: 5,
      subSportId: 10,
      periodId: 0,
      marketId: 5,
      hasPointBuy: false,
    });
  });

  test("only #9000+ rotations are live", () => {
    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "Football #8999 Buffalo Bills -7",
        hasPositiveBuyPoints: false,
      }).sportId,
    ).toBe(SPORT_ID_FOOTBALL);
    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "Football #9000 Buffalo Bills -7",
        hasPositiveBuyPoints: false,
      }).sportId,
    ).toBe(SPORT_ID_LIVE);
  });

  test("coerces quarter periods to a hockey period", () => {
    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "NHL Hockey Boston Bruins 3rd quarter",
        hasPositiveBuyPoints: false,
      }),
    ).toEqual({
      sportId: 2,
      subSportId: 5,
      periodId: 9,
      marketId: 5,
      hasPointBuy: false,
    });
  });

  test("detects point buying from the flag or the description", () => {
    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "Football Kansas City Chiefs -3 (-120)",
        hasPositiveBuyPoints: true,
      }).hasPointBuy,
    ).toBe(true);
    expect(
      classifyLegIntoTaxonomy({
        rawDescription: "Football Chiefs buying 1.5",
        hasPositiveBuyPoints: false,
      }).hasPointBuy,
    ).toBe(true);
  });
});
