/**
 * @file tests/market_edge_engine.test.ts
 * @description Invariant and edge detection tests for the Market Edge & Leakage Engine.
 */

import { describe, expect, it } from "bun:test";
import {
  aggregateMarketEdges,
  classifyMarketType,
  computeEdgeStatus,
  streamAndAggregateMarketEdges,
  MarketEdgeInspection,
} from "../lib/market_edge_engine.ts";

describe("Market Edge Engine > Market Classification", () => {
  it("classifies Derivative Points Lines accurately", () => {
    expect(
      classifyMarketType({
        ShortDesc: "E.Football #101 Patriots derivative points Over 24.5",
        WagerType: "E",
      }).marketType,
    ).toBe("derivative_points");

    expect(
      classifyMarketType({
        ShortDesc: "Ohio State individual points Under 31.5 -115",
      }).marketType,
    ).toBe("derivative_points");
  });

  it("classifies standard core markets (Spread, Total, Moneyline)", () => {
    expect(
      classifyMarketType({
        ShortDesc: "Chiefs -3.5 -110",
      }).marketType,
    ).toBe("spread");

    expect(
      classifyMarketType({
        ShortDesc: "Total Points Over 48.5 -110",
      }).marketType,
    ).toBe("total");

    expect(
      classifyMarketType({
        ShortDesc: "Lakers ML -150",
      }).marketType,
    ).toBe("moneyline");

    expect(
      classifyMarketType({
        ShortDesc: "Celtics Winner (2 way) -140",
      }).marketType,
    ).toBe("moneyline");
  });

  it("classifies Puck Lines and Run Lines", () => {
    expect(
      classifyMarketType({
        ShortDesc: "NHL Edmonton Oilers Puck Line -1.5 +140",
      }).marketType,
    ).toBe("puck_line");

    expect(
      classifyMarketType({
        ShortDesc: "MLB Dodgers Run Line -1.5 +110",
      }).marketType,
    ).toBe("run_line");
  });

  it("classifies Player Propositions", () => {
    expect(
      classifyMarketType({
        ShortDesc: "Patrick Mahomes Pass Yds Over 275.5 -115",
      }).marketType,
    ).toBe("prop");

    expect(
      classifyMarketType({
        ShortDesc: "LeBron James Reb Over 8.5 -120",
      }).marketType,
    ).toBe("prop");
  });
});

describe("Market Edge Engine > Edge Status Evaluation", () => {
  it("flags insufficient sample size when below threshold", () => {
    const { edgeStatus, statusSymbol } = computeEdgeStatus(60.0, -10.0, 5, 10);
    expect(edgeStatus).toBe("INSUFFICIENT_SAMPLE");
    expect(statusSymbol).toContain("LOW SAMPLE");
  });

  it("flags CRITICAL_LEAK when desk hold is <= -5.0% or win rate >= 57%", () => {
    const leakByHold = computeEdgeStatus(52.0, -6.5, 50, 10);
    expect(leakByHold.edgeStatus).toBe("CRITICAL_LEAK");
    expect(leakByHold.statusSymbol).toContain("CRITICAL LEAK");

    const leakByWinRate = computeEdgeStatus(58.5, -2.0, 50, 10);
    expect(leakByWinRate.edgeStatus).toBe("CRITICAL_LEAK");
  });

  it("flags PLAYER_EDGE when desk hold is negative or win rate >= 53.5%", () => {
    const edge = computeEdgeStatus(54.0, -1.2, 50, 10);
    expect(edge.edgeStatus).toBe("PLAYER_EDGE");
    expect(edge.statusSymbol).toContain("PLAYER EDGE");
  });

  it("flags BOOK_EDGE and HIGH_MARGIN for profitable desk flows", () => {
    const solidBook = computeEdgeStatus(48.0, 5.5, 50, 10);
    expect(solidBook.edgeStatus).toBe("BOOK_EDGE");
    expect(solidBook.statusSymbol).toContain("BOOK EDGE");

    const highMargin = computeEdgeStatus(42.0, 12.0, 50, 10);
    expect(highMargin.edgeStatus).toBe("HIGH_MARGIN");
    expect(highMargin.statusSymbol).toContain("HIGH MARGIN");
  });

  it("flags NEUTRAL when markets are balanced", () => {
    const balanced = computeEdgeStatus(51.0, 2.5, 50, 10);
    expect(balanced.edgeStatus).toBe("NEUTRAL");
    expect(balanced.statusSymbol).toContain("NEUTRAL");
  });
});

describe("Market Edge Engine > Aggregation & Telemetry Slicing", () => {
  const sampleWagers = [
    // 1. CFB 1st Half Derivative Points Line (Critical Leak: 3 wins, 0 losses = 100% win rate, negative desk hold)
    {
      SportType: "FOOTBALL",
      SportSubType: "CFB",
      PeriodDescription: "1st Half",
      PeriodNumber: 1,
      ShortDesc: "Ohio State derivative points Over 17.5 -110",
      WagerType: "E",
      AmountWagered: 100.0,
      AmountWon: 90.91,
      AmountLost: 0.0,
      Outcome: "W",
      latencySeconds: 30, // late steam
    },
    {
      SportType: "FOOTBALL",
      SportSubType: "CFB",
      PeriodDescription: "1st Half",
      PeriodNumber: 1,
      ShortDesc: "Ohio State derivative points Over 17.5 -110",
      WagerType: "E",
      AmountWagered: 100.0,
      AmountWon: 90.91,
      AmountLost: 0.0,
      Outcome: "W",
      latencySeconds: 28, // late steam
    },
    {
      SportType: "FOOTBALL",
      SportSubType: "CFB",
      PeriodDescription: "1st Half",
      PeriodNumber: 1,
      ShortDesc: "Michigan derivative points Over 14.5 -110",
      WagerType: "E",
      AmountWagered: 100.0,
      AmountWon: 90.91,
      AmountLost: 0.0,
      Outcome: "W",
      latencySeconds: 10,
    },
    // 2. NBA Game Spread (Recreational Book Edge: 1 win, 3 losses = 25% win rate, positive desk hold)
    {
      SportType: "BASKETBALL",
      SportSubType: "NBA",
      PeriodDescription: "Game",
      PeriodNumber: 0,
      ShortDesc: "Lakers -4.5 -110",
      AmountWagered: 100.0,
      AmountWon: 0.0,
      AmountLost: 100.0,
      Outcome: "L",
      buyPoints: 0.5,
    },
    {
      SportType: "BASKETBALL",
      SportSubType: "NBA",
      PeriodDescription: "Game",
      PeriodNumber: 0,
      ShortDesc: "Lakers -4.5 -110",
      AmountWagered: 100.0,
      AmountWon: 0.0,
      AmountLost: 100.0,
      Outcome: "L",
    },
    {
      SportType: "BASKETBALL",
      SportSubType: "NBA",
      PeriodDescription: "Game",
      PeriodNumber: 0,
      ShortDesc: "Warriors +4.5 -110",
      AmountWagered: 100.0,
      AmountWon: 90.91,
      AmountLost: 0.0,
      Outcome: "W",
    },
    {
      SportType: "BASKETBALL",
      SportSubType: "NBA",
      PeriodDescription: "Game",
      PeriodNumber: 0,
      ShortDesc: "Celtics -6 -110",
      AmountWagered: 100.0,
      AmountWon: 0.0,
      AmountLost: 100.0,
      Outcome: "L",
    },
    // 3. NHL Game Puck Line (High Margin Book Flow: 0 wins, 2 losses)
    {
      SportType: "HOCKEY",
      SportSubType: "NHL",
      PeriodDescription: "Game",
      PeriodNumber: 0,
      ShortDesc: "Oilers Puck Line -1.5 +135",
      AmountWagered: 50.0,
      AmountWon: 0.0,
      AmountLost: 50.0,
      Outcome: "L",
    },
    {
      SportType: "HOCKEY",
      SportSubType: "NHL",
      PeriodDescription: "Game",
      PeriodNumber: 0,
      ShortDesc: "Rangers Puck Line -1.5 +140",
      AmountWagered: 50.0,
      AmountWon: 0.0,
      AmountLost: 50.0,
      Outcome: "L",
    },
  ];

  it("aggregates wagers and identifies critical leaks and book edges", () => {
    const report = aggregateMarketEdges(sampleWagers, { minWagers: 2 });
    expect(report.universe.totalWagers).toBe(9);
    expect(report.universe.totalSettled).toBe(9);
    expect(report.universe.totalRiskDollars).toBe(800.0);

    // CFB 1st Half Derivative Points Line check
    const cfbRow = report.rows.find(
      (r) => r.subSport === "CFB" && r.marketType === "derivative_points",
    );
    expect(cfbRow).toBeDefined();
    expect(cfbRow!.periodLabel).toBe("1st Half");
    expect(cfbRow!.wins).toBe(3);
    expect(cfbRow!.losses).toBe(0);
    expect(cfbRow!.bettorWinRatePct).toBe(100.0);
    // Desk Lost 3 * 90.91 = 272.73 on 300.0 risk = -90.91% hold
    expect(cfbRow!.deskHoldPct).toBeLessThan(-50.0);
    expect(cfbRow!.edgeStatus).toBe("CRITICAL_LEAK");
    expect(cfbRow!.lateSteamCount).toBe(2);
    expect(cfbRow!.lateSteamPct).toBe(66.67);

    // NBA Game Spread check
    const nbaRow = report.rows.find(
      (r) => r.subSport === "NBA" && r.marketType === "spread",
    );
    expect(nbaRow).toBeDefined();
    expect(nbaRow!.periodLabel).toBe("Game");
    expect(nbaRow!.wins).toBe(1);
    expect(nbaRow!.losses).toBe(3);
    expect(nbaRow!.bettorWinRatePct).toBe(25.0);
    expect(nbaRow!.deskHoldPct).toBeGreaterThan(40.0);
    expect(nbaRow!.edgeStatus).toBe("HIGH_MARGIN");
    expect(nbaRow!.buyPointsWagers).toBe(1);
  });

  it("honors sort criteria: leak, hold, volume, steam", () => {
    // Sort by leak: lowest hold % first
    const byLeak = aggregateMarketEdges(sampleWagers, {
      sort: "leak",
      minWagers: 2,
    });
    expect(byLeak.rows[0]!.subSport).toBe("CFB"); // Biggest leak at top

    // Sort by hold: highest hold % first
    const byHold = aggregateMarketEdges(sampleWagers, {
      sort: "hold",
      minWagers: 2,
    });
    expect(byHold.rows[0]!.deskHoldPct).toBeGreaterThanOrEqual(
      byHold.rows[1]!.deskHoldPct,
    );

    // Sort by volume: highest risk first
    const byVol = aggregateMarketEdges(sampleWagers, {
      sort: "volume",
      minWagers: 2,
    });
    expect(byVol.rows[0]!.totalRiskDollars).toBe(400.0); // NBA has $400 risk

    // Sort by steam: highest steam pct first
    const bySteam = aggregateMarketEdges(sampleWagers, {
      sort: "steam",
      minWagers: 2,
    });
    expect(bySteam.rows[0]!.subSport).toBe("CFB");
    expect(bySteam.rows[0]!.lateSteamPct).toBe(66.67);
  });

  it("filters by sport, period, and sub-sport", () => {
    const onlyFootball = aggregateMarketEdges(sampleWagers, {
      sport: "Football",
      minWagers: 1,
    });
    expect(onlyFootball.rows.length).toBe(1);
    expect(onlyFootball.rows[0]!.sport).toBe("Football");

    const onlyHalves = aggregateMarketEdges(sampleWagers, {
      period: 1,
      minWagers: 1,
    });
    expect(onlyHalves.rows.length).toBe(1);
    expect(onlyHalves.rows[0]!.period).toBe(1);
  });

  it("guarantees MarketEdgeInspection is strictly pure and formats output with [Bun.inspect.custom]", () => {
    const report = aggregateMarketEdges(sampleWagers, { minWagers: 2 });
    const inspection = new MarketEdgeInspection(report);

    const before = JSON.stringify(inspection);
    const renderedColors = Bun.inspect(inspection, { colors: true });
    const renderedPlain = Bun.inspect(inspection, { colors: false });

    expect(JSON.stringify(inspection)).toBe(before);
    expect(renderedPlain).toContain(
      "=== Fantasy402 Market Edge & Leakage Matrix ===",
    );
    expect(renderedPlain).toContain("Total Wagers     : 9");
    expect(renderedPlain).toContain("CRITICAL LEAK");
    expect(renderedColors).toContain("\u001b[");
  });

  it("streams and aggregates wagers from an in-memory File instance", async () => {
    const jsonlContent = sampleWagers.map((w) => JSON.stringify(w)).join("\n");
    const memFile = new File([jsonlContent], "edge_test_wagers.jsonl", {
      type: "application/x-ndjson",
    });

    const report = await streamAndAggregateMarketEdges(memFile, {
      minWagers: 2,
    });
    expect(report.universe.totalWagers).toBe(9);
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.durationMs).toBeDefined();
    expect(report.throughputRowsPerSec).toBeDefined();
  });

  it("infers sport, period, and market from ShortDesc ticker lines when wire types are omitted", async () => {
    const tickerEnvelope = {
      LIST: [
        {
          WagerNumber: 101,
          AmountWagered: 5000,
          ToWinAmount: 4000,
          ShortDesc:
            "Hockey - Seattle Kraken vs Calgary Flames / Match (Including OT) / Total / Flames/Kraken O 1½ -150\n",
        },
        {
          WagerNumber: 102,
          AmountWagered: 10000,
          ToWinAmount: 9090,
          ShortDesc:
            "Football - Los Angeles Rams vs Los Angeles Chargers / Game / Winner (2 way) / Rams -140\n",
        },
      ],
    };

    const memFile = new File([JSON.stringify(tickerEnvelope)], "ticker.json", {
      type: "application/json",
    });

    const report = await streamAndAggregateMarketEdges(memFile);
    expect(report.universe.totalWagers).toBe(2);
    expect(report.universe.totalPending).toBe(2);

    const hockeyTotal = report.rows.find(
      (r) => r.sport === "Hockey" && r.marketType === "total",
    );
    expect(hockeyTotal).toBeDefined();
    expect(hockeyTotal!.subSport).toBe("NHL");
    expect(hockeyTotal!.totalRiskDollars).toBe(50);

    const footballMl = report.rows.find(
      (r) => r.sport === "Football" && r.marketType === "moneyline",
    );
    expect(footballMl).toBeDefined();
    expect(footballMl!.subSport).toBe("NFL");
    expect(footballMl!.totalRiskDollars).toBe(100);
  });

  it("handles betreport structured results and computes desk hold accurately", async () => {
    const betReportEnvelope = {
      r: {
        bets: [
          {
            id: "901",
            bet: "100",
            result: "-100", // bettor lost $100 -> desk won +$100
            displaySportId: "8",
          },
          {
            id: "902",
            bet: "200",
            result: "180", // bettor won $180 -> desk lost -$180
            displaySportId: "8",
          },
        ],
      },
    };

    const memFile = new File(
      [JSON.stringify(betReportEnvelope)],
      "betreport.json",
      {
        type: "application/json",
      },
    );

    const report = await streamAndAggregateMarketEdges(memFile, {
      minWagers: 1,
    });
    expect(report.universe.totalWagers).toBe(2);
    expect(report.universe.totalSettled).toBe(2);
    expect(report.universe.totalRiskDollars).toBe(300);
    // Desk Net PnL = +100 - 180 = -80
    expect(report.universe.totalDeskPnlDollars).toBe(-80);
    // Hold = -80 / 300 = -26.67%
    expect(report.universe.overallHoldPct).toBe(-26.67);
  });
});
