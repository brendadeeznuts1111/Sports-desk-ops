/**
 * @file tests/f402_figure_date_enricher.test.ts
 * @description Unit tests for the figure date enrichment pipeline.
 */

import { describe, expect, it } from "bun:test";
import {
  buildActiveFigureDateDrilldownPayloads,
  buildCanonicalEventId,
  buildCompositeMatchKey,
  computeWagerLineWindows,
  hashCompositeMatchKey,
  canonicalTeamToken,
  computeExecutionLatency,
  enrichWagerRecord,
  inferMarketType,
  inferTotalPicks,
  isLiveSubSport,
  matchesWagerSlice,
  parseBuyPointsFromDesc,
  parsePerformancePlayerDateLabel,
  rankCustomersBySlice,
  reconcilePerformanceWithCarryOver,
  summarizePerformancePlayer,
  FigureDateEnrichmentInspection,
  formatEnrichedWagerInspect,
  createEnrichedWagersDirectStream,
  type FigureDateWager,
  type LiveTickerWager,
} from "../lib/f402_figure_date_enricher.ts";

describe("Figure Date Enrichment Engine", () => {
  const sampleTicker: LiveTickerWager = {
    WagerNumber: 767671201,
    AgentID: "DAN318",
    AgentLogin: "DAN318",
    CustomerID: "DAN245    ",
    Login: "DAN245",
    WagerType: "S",
    AmountWagered: 230000,
    ToWinAmount: 200000,
    VolumeAmount: 200000,
    InsertDateTime: "2026-11-06 20:09:35.080",
    TicketWriter: "Internet",
    ShortDesc: "S.Basketball #546 Grizzlies +1 -115 - For 1st Quarter",
    VIP: "0         ",
  };

  const sampleFigure: FigureDateWager = {
    TicketNumber: 1075710577,
    WagerNumber: 1,
    PlayNumber: 1,
    AmountWagered: 230000,
    ToWinAmount: 200000,
    WagerType: "S",
    AmountWon: 0,
    AmountLost: 230000,
    WagerStatus: "L",
    Description: "Basketball #546 Grizzlies +1 -115 - For 1st Quarter",
    AcceptedDateTime: "2026-11-06 20:09:35.077",
    CustomerID: "DAN245    ",
    TicketWriter: "Internet",
    GameDateTime: "2026-11-06 20:10:00.000",
    SportType: "Basketball          ",
    SportSubType: "NBA                 ",
    AdjSpread: 1,
    AdjTotalPoints: 0,
    FinalMoney: -115,
    TotalPicks: 1,
    ChosenTeamID: "Memphis Grizzlies",
    Outcome: "L",
    PeriodDescription: "1st Quarter         ",
    Team1ID: "Oklahoma City Thunder",
    Team1FinalScore: 35,
    Team2ID: "Memphis Grizzlies",
    Team2FinalScore: 28,
  };

  it("builds identical composite match keys across ticker and settlement records", () => {
    const tickerKey = buildCompositeMatchKey(
      sampleTicker.CustomerID,
      sampleTicker.InsertDateTime,
      sampleTicker.AmountWagered,
      sampleTicker.ToWinAmount,
      sampleTicker.ShortDesc,
    );
    const figureKey = buildCompositeMatchKey(
      sampleFigure.CustomerID,
      sampleFigure.AcceptedDateTime,
      sampleFigure.AmountWagered,
      sampleFigure.ToWinAmount,
      sampleFigure.Description,
    );

    expect(tickerKey).toBe("DAN245|2026-11-06 20:09|230000|200000|546");
    expect(tickerKey).toBe(figureKey);
  });

  it("builds canonical EventID resolving away and home opponents", () => {
    const eventId = buildCanonicalEventId(
      sampleFigure.SportSubType,
      sampleFigure.GameDateTime,
      sampleFigure.Team1ID!,
      sampleFigure.Team2ID!,
    );
    expect(eventId).toBe("NBA-20261106-OklahomaCityThunder@MemphisGrizzlies");
  });

  it("computes execution latency detecting 25-second late steam entry", () => {
    const latency = computeExecutionLatency(
      sampleFigure.AcceptedDateTime,
      sampleFigure.GameDateTime,
    );
    expect(latency).toBe(25);
  });

  it("infers market type accurately", () => {
    expect(inferMarketType("S", "Grizzlies +1 -115", 1, 0)).toBe("spread");
    expect(inferMarketType("S", "Total Over 220.5", 0, 220.5)).toBe("total");
    expect(inferMarketType("E", "Patriots Derivative Points", 0, 0)).toBe(
      "derivative_points",
    );
  });

  it("enriches raw live ticker into unified golden master record", () => {
    const enriched = enrichWagerRecord(sampleTicker, sampleFigure);

    expect(enriched.ticketNumber).toBe("1075710577");
    expect(enriched.liveWagerNumber).toBe(767671201);
    expect<string>(enriched.customerId).toBe("DAN245");
    expect(enriched.totalPicks).toBe(1);
    expect(enriched.eventId).toBe(
      "NBA-20261106-OklahomaCityThunder@MemphisGrizzlies",
    );
    expect(enriched.sport).toBe("Basketball");
    expect(enriched.subSport).toBe("NBA");
    expect(enriched.dailyFigureDate).toBe("2026-11-06");
    expect(enriched.opponents.away).toBe("Oklahoma City Thunder");
    expect(enriched.opponents.home).toBe("Memphis Grizzlies");
    expect(enriched.latencySeconds).toBe(25);
    expect(enriched.isLateSteam).toBe(true);
    expect(enriched.portalPeriod).toBe(3); // 1st Quarter maps to 3
    expect(enriched.periodNumber).toBe(3);
    expect(enriched.periodDescription).toBe("1st Quarter");
    expect(enriched.marketType).toBe("spread");
    expect(enriched.selection.chosenTeam).toBe("Memphis Grizzlies");
    expect(enriched.selection.line).toBe(1);
    expect<number | null>(enriched.selection.price).toBe(-115);
    expect(enriched.settlement.isSettled).toBe(true);
    expect(enriched.settlement.outcome).toBe("L");
    expect<number>(enriched.settlement.amountLostCents).toBe(230000);
    expect<number>(enriched.settlement.netPnlCents).toBe(-230000);
    expect(enriched.settlement.awayScore).toBe(35);
    expect(enriched.settlement.homeScore).toBe(28);
  });

  it("correctly resolves native ASI EZLive SportType LIVE into canonical sport and flags isLive", () => {
    const liveTicker: LiveTickerWager = {
      WagerNumber: 767691466,
      CustomerID: "DAN245    ",
      WagerType: "L",
      AmountWagered: 230000,
      ToWinAmount: 200000,
      InsertDateTime: "2026-11-06 22:47:47.357",
      TicketWriter: "Internet",
      ShortDesc:
        "L.LIVE #9547 Blazers (Live)/Lakers (Live) O 220½ -115 - For Game",
    };

    const liveFigure: FigureDateWager = {
      TicketNumber: 1075808604,
      WagerNumber: 1,
      AmountWagered: 230000,
      ToWinAmount: 200000,
      WagerType: "L",
      AmountWon: 200000,
      AmountLost: 0,
      WagerStatus: "W",
      Description:
        "LIVE #9547 Blazers (Live)/Lakers (Live) O 220½ -115 - For Game",
      AcceptedDateTime: "2026-11-06 22:47:47.350",
      CustomerID: "DAN245    ",
      TicketWriter: "Internet",
      GameDateTime: "2026-11-06 23:59:00.000",
      SportType: "LIVE                ",
      SportSubType: "NBA Live            ",
      AdjSpread: 0,
      AdjTotalPoints: 220.5,
      TotalPointsOU: "O",
      FinalMoney: -115,
      ChosenTeamID: "Blazers (Live)/Lakers (Live)",
      Outcome: "W",
      PeriodDescription: "Game                ",
      PeriodNumber: 0,
      Team1ID: "Blazers (Live)",
      Team1FinalScore: 118,
      Team2ID: "Lakers (Live)",
      Team2FinalScore: 124,
    };

    const enriched = enrichWagerRecord(liveTicker, liveFigure);
    expect(enriched.sport).toBe("Basketball");
    expect(enriched.subSport).toBe("NBA Live");
    expect(enriched.dailyFigureDate).toBe("2026-11-06");
    expect(enriched.isLive).toBe(true);
    expect(enriched.portalPeriod).toBe(0);
    expect(enriched.periodNumber).toBe(0);
    expect(enriched.periodDescription).toBe("Game");
    expect(enriched.selection.overUnder).toBe("O");
    expect(enriched.selection.line).toBe(220.5);
    expect<number>(enriched.settlement.netPnlCents).toBe(200000);
    expect(enriched.buyPoints).toBe(0);
    expect(enriched.selection.buyPoints).toBe(0);
  });

  it("extracts point purchases (BuyPoints) from description and figure fields", () => {
    expect(
      parseBuyPointsFromDesc(
        "S.Football #112 Northwestern 3 -130 - buying ½ For Game",
      ),
    ).toBe(0.5);
    expect(
      parseBuyPointsFromDesc(
        "Football #479 Cowboys -2&#189; -140 - buying &#189; For Game",
      ),
    ).toBe(0.5);
    expect(
      parseBuyPointsFromDesc(
        "S.Football #107 Pittsburgh 3½ -155 - buying 1 For Game",
      ),
    ).toBe(1.0);
    expect(
      parseBuyPointsFromDesc(
        "P.Football #196 Missouri 7 -145 - buying 1½ For Game",
      ),
    ).toBe(1.5);
    expect(
      parseBuyPointsFromDesc(
        "P.Football #189 Alabama -4 -150 - buying 2 For Game",
      ),
    ).toBe(2.0);
    expect(
      parseBuyPointsFromDesc("S.Basketball #546 Grizzlies +1 -115 - For Game"),
    ).toBe(0);

    const boughtTicker: LiveTickerWager = {
      WagerNumber: 767699999,
      CustomerID: "DAN245",
      WagerType: "S",
      AmountWagered: 110000,
      ToWinAmount: 100000,
      InsertDateTime: "2026-11-06 18:00:00.000",
      TicketWriter: "Internet",
      ShortDesc: "S.Football #112 Northwestern 3 -130 - buying ½ For Game",
    };

    const boughtFigure: FigureDateWager = {
      TicketNumber: 1075999999,
      WagerNumber: 1,
      AmountWagered: 110000,
      ToWinAmount: 100000,
      WagerType: "S",
      AmountWon: 0,
      AmountLost: 110000,
      WagerStatus: "L",
      Description: "Football #112 Northwestern 3 -130 - buying ½ For Game",
      AcceptedDateTime: "2026-11-06 18:00:00.000",
      CustomerID: "DAN245",
      TicketWriter: "Internet",
      GameDateTime: "2026-11-06 19:00:00.000",
      SportType: "Football            ",
      SportSubType: "NCAAF               ",
      OrigSpread: 3.5,
      AdjSpread: 3.0,
      BuyPoints: 0.5,
      FinalMoney: -130,
      ChosenTeamID: "Northwestern",
      PeriodDescription: "Game                ",
    };

    const enriched = enrichWagerRecord(boughtTicker, boughtFigure);
    expect(enriched.buyPoints).toBe(0.5);
    expect(enriched.selection.buyPoints).toBe(0.5);
    expect(enriched.selection.line).toBe(3.0);
    expect(enriched.selection.origLine).toBe(3.5);
    expect(enriched.origSpread).toBe(3.5);
    expect(enriched.adjSpread).toBe(3.0);
  });

  it("resolves TotalPicks for straight and multi-leg parlay wagers", () => {
    expect(inferTotalPicks("S", "Basketball #546 Grizzlies +1 -115")).toBe(1);
    expect(inferTotalPicks("M", "Football #101 Patriots -150")).toBe(1);
    expect(inferTotalPicks("L", "Total Over 220.5")).toBe(1);
    expect(
      inferTotalPicks(
        "P",
        "Football #101 Patriots -3 -110 Football #103 Bills -7 -110 Football #105 Chiefs -4 -110",
      ),
    ).toBe(3);
    expect(
      inferTotalPicks(
        "P",
        "Baseball - San Diego Padres vs Milwaukee Brewers / Game / Run Line\nBaseball - Atlanta Braves vs Los Angeles Dodgers / Game / Moneyline",
      ),
    ).toBe(2);

    const parlayTicker: LiveTickerWager = {
      WagerNumber: 767700000,
      CustomerID: "DAN245",
      WagerType: "P",
      AmountWagered: 5000,
      ToWinAmount: 30000,
      InsertDateTime: "2026-11-06 18:00:00.000",
      TicketWriter: "Internet",
      ShortDesc:
        "Football #101 Patriots -3 -110 Football #103 Bills -7 -110 Football #105 Chiefs -4 -110",
    };

    const parlayFigure: FigureDateWager = {
      TicketNumber: 1076000000,
      WagerNumber: 1,
      AmountWagered: 5000,
      ToWinAmount: 30000,
      WagerType: "P",
      AmountWon: 0,
      AmountLost: 5000,
      WagerStatus: "L",
      Description: "3 Team Parlay",
      AcceptedDateTime: "2026-11-06 18:00:00.000",
      CustomerID: "DAN245",
      TicketWriter: "Internet",
      GameDateTime: "2026-11-06 19:00:00.000",
      SportType: "Football            ",
      SportSubType: "NFL                 ",
      TotalPicks: 3,
    };

    const enriched = enrichWagerRecord(parlayTicker, parlayFigure);
    expect(enriched.totalPicks).toBe(3);
  });

  it("handles LIVE in-play Lakers spread with PeriodDescription Game and PeriodNumber 0", () => {
    const ticker: LiveTickerWager = {
      WagerNumber: 767691433,
      CustomerID: "DAN245    ",
      WagerType: "S",
      AmountWagered: 220000,
      ToWinAmount: 200000,
      InsertDateTime: "2026-11-06 22:47:29.367",
      TicketWriter: "Internet",
      ShortDesc: "S.LIVE #9548 Lakers (Live) +3½ -110 - For Game",
    };

    const figure: FigureDateWager = {
      TicketNumber: 1075808451,
      WagerNumber: 1,
      AmountWagered: 220000,
      ToWinAmount: 200000,
      WagerType: "S",
      AmountWon: 200000,
      AmountLost: 0,
      WagerStatus: "W",
      Description: "LIVE #9548 Lakers (Live) +3&#189; -110 - For Game",
      AcceptedDateTime: "2026-11-06 22:47:29.360",
      CustomerID: "DAN245    ",
      TicketWriter: "Internet",
      GameDateTime: "2026-11-06 23:59:00.000",
      DailyFigureDate: "2026-11-06 00:00:00.000",
      SportType: "LIVE                ",
      SportSubType: "NBA Live            ",
      AdjSpread: 3.5,
      FinalMoney: -110,
      ChosenTeamID: "Lakers (Live)",
      PeriodDescription: "Game                ",
      PeriodNumber: 0,
      Team1ID: "Blazers (Live)",
      Team1RotNum: 9547,
      Team2ID: "Lakers (Live)",
      Team2RotNum: 9548,
    };

    const enriched = enrichWagerRecord(ticker, figure);
    expect(enriched.ticketNumber).toBe("1075808451");
    expect(enriched.liveWagerNumber).toBe(767691433);
    expect<string>(enriched.customerId).toBe("DAN245");
    expect(enriched.sport).toBe("Basketball");
    expect(enriched.subSport).toBe("NBA Live");
    expect(enriched.dailyFigureDate).toBe("2026-11-06");
    expect(enriched.isLive).toBe(true);
    expect(enriched.periodDescription).toBe("Game");
    expect(enriched.periodNumber).toBe(0);
    expect(enriched.portalPeriod).toBe(0);
    expect(enriched.selection.chosenTeam).toBe("Lakers (Live)");
    expect(enriched.selection.line).toBe(3.5);
    expect<number | null>(enriched.selection.price).toBe(-110);
    expect(enriched.buyPoints).toBe(0);
  });

  it("handles 2nd Half derivative period with PeriodDescription 2nd Half and PeriodNumber 2", () => {
    const ticker: LiveTickerWager = {
      WagerNumber: 763351436,
      CustomerID: "CC364     ",
      WagerType: "S",
      AmountWagered: 224000,
      ToWinAmount: 200000,
      InsertDateTime: "2026-11-01 14:33:47.900",
      TicketWriter: "Internet",
      ShortDesc: "Football #244 Cowboys -4 -112 - For 2nd Half",
    };

    const figure: FigureDateWager = {
      TicketNumber: 1073351436,
      WagerNumber: 1,
      AmountWagered: 224000,
      ToWinAmount: 200000,
      WagerType: "S",
      AmountWon: 0,
      AmountLost: 0,
      WagerStatus: "P",
      Description: "Football #244 Cowboys -4 -112 - For 2nd Half",
      AcceptedDateTime: "2026-11-01 14:33:47.900",
      CustomerID: "CC364     ",
      TicketWriter: "Internet",
      GameDateTime: "2026-11-01 13:00:00.000",
      DailyFigureDate: "2026-11-01 00:00:00.000",
      SportType: "Football            ",
      SportSubType: "NFL                 ",
      AdjSpread: -4,
      FinalMoney: -112,
      ChosenTeamID: "Dallas Cowboys",
      PeriodDescription: "2nd Half            ",
      PeriodNumber: 2,
      Team1ID: "Arizona Cardinals",
      Team1RotNum: 243,
      Team2ID: "Dallas Cowboys",
      Team2RotNum: 244,
    };

    const enriched = enrichWagerRecord(ticker, figure);
    expect(enriched.sport).toBe("Football");
    expect(enriched.subSport).toBe("NFL");
    expect(enriched.dailyFigureDate).toBe("2026-11-01");
    expect(enriched.isLive).toBe(false);
    expect(enriched.periodDescription).toBe("2nd Half");
    expect(enriched.periodNumber).toBe(2);
    expect(enriched.portalPeriod).toBe(2);
    expect(enriched.selection.chosenTeam).toBe("Dallas Cowboys");
    expect(enriched.selection.line).toBe(-4);
    expect<number | null>(enriched.selection.price).toBe(-112);
    expect(enriched.buyPoints).toBe(0);
  });

  it("reconciles daily schedule rotation variance: Stars #40 (Home, DailyFigureDate 2026-10-02) vs Stars #9 (Away, DailyFigureDate 2026-11-03)", () => {
    // Ticket 762839079 placed on 2026-10-02: Stars are Home (#40, even)
    const octTicker: LiveTickerWager = {
      WagerNumber: 762839079,
      CustomerID: "JACKLOB1",
      WagerType: "S",
      AmountWagered: 1000,
      ToWinAmount: 1450,
      InsertDateTime: "2026-10-02 14:52:13.380",
      TicketWriter: "Internet",
      ShortDesc: "S:Hockey #40 Stars -1&#189; +145 - For Game ",
    };

    const octFigure: FigureDateWager = {
      TicketNumber: 1071839079,
      WagerNumber: 1,
      AmountWagered: 1000,
      ToWinAmount: 1450,
      WagerType: "S",
      AmountWon: 0,
      AmountLost: 1000,
      WagerStatus: "L",
      Description: "Hockey #40 Stars -1&#189; +145 - For Game",
      AcceptedDateTime: "2026-10-02 14:52:13.380",
      CustomerID: "JACKLOB1",
      TicketWriter: "Internet",
      GameDateTime: "2026-10-02 19:00:00.000",
      DailyFigureDate: "2026-10-02 00:00:00.000",
      SportType: "Hockey              ",
      SportSubType: "NHL                 ",
      AdjSpread: -1.5,
      FinalMoney: 145,
      ChosenTeamID: "Dallas Stars",
      PeriodDescription: "Game                ",
      PeriodNumber: 0,
      Team1ID: "St. Louis Blues",
      Team1RotNum: 39,
      Team2ID: "Dallas Stars",
      Team2RotNum: 40,
    };

    const octEnriched = enrichWagerRecord(octTicker, octFigure);
    expect(octEnriched.dailyFigureDate).toBe("2026-10-02");
    expect(octEnriched.opponents.away).toBe("St. Louis Blues");
    expect(octEnriched.opponents.home).toBe("Dallas Stars");
    expect(octEnriched.selection.chosenTeam).toBe("Dallas Stars");
    expect(octEnriched.selection.line).toBe(-1.5);
    expect<number | null>(octEnriched.selection.price).toBe(145);

    // Ticket 1074473813 placed on 2026-11-03: Stars are Away (#9, odd)
    const novTicker: LiveTickerWager = {
      WagerNumber: 764473813,
      CustomerID: "GX195",
      WagerType: "M",
      AmountWagered: 802500,
      ToWinAmount: 750000,
      InsertDateTime: "2026-11-03 14:34:47.900",
      TicketWriter: "Internet",
      ShortDesc: "Hockey #9 Stars -107 - For Game",
    };

    const novFigure: FigureDateWager = {
      TicketNumber: 1074473813,
      WagerNumber: 1,
      AmountWagered: 802500,
      ToWinAmount: 750000,
      WagerType: "M",
      AmountWon: 750000,
      AmountLost: 0,
      WagerStatus: "W",
      Description: "Hockey #9 Stars -107 - For Game",
      AcceptedDateTime: "2026-11-03 14:34:47.900",
      CustomerID: "GX195",
      TicketWriter: "Internet",
      GameDateTime: "2026-11-03 19:07:00.000",
      DailyFigureDate: "2026-11-03 00:00:00.000",
      SportType: "Hockey              ",
      SportSubType: "NHL                 ",
      FinalMoney: -107,
      ChosenTeamID: "Dallas Stars",
      PeriodDescription: "Game                ",
      PeriodNumber: 0,
      Team1ID: "Dallas Stars",
      Team1RotNum: 9,
      Team2ID: "Washington Capitals",
      Team2RotNum: 10,
    };

    const novEnriched = enrichWagerRecord(novTicker, novFigure);
    expect(novEnriched.dailyFigureDate).toBe("2026-11-03");
    expect(novEnriched.opponents.away).toBe("Dallas Stars");
    expect(novEnriched.opponents.home).toBe("Washington Capitals");
    expect(novEnriched.selection.chosenTeam).toBe("Dallas Stars");
    expect<number | null>(novEnriched.selection.price).toBe(-107);

    // Verify canonical event ID differentiation by DailyFigureDate and Home/Away venue
    expect(octEnriched.eventId).toBe("NHL-20261002-St.LouisBlues@DallasStars");
    expect(novEnriched.eventId).toBe(
      "NHL-20261103-DallasStars@WashingtonCapitals",
    );
  });

  it("canonicalizes team tokens across variations of punctuation, spacing, and Saint/St", () => {
    // Tests for St. Louis / St Louis / Saint Louis
    expect(canonicalTeamToken("St. Louis Blues")).toBe("St.LouisBlues");
    expect(canonicalTeamToken("St Louis Blues")).toBe("St.LouisBlues");
    expect(canonicalTeamToken("Saint Louis Blues")).toBe("St.LouisBlues");
    expect(canonicalTeamToken("St. Louis")).toBe("St.Louis");
    expect(canonicalTeamToken("St Louis")).toBe("St.Louis");
    expect(canonicalTeamToken("Saint Louis")).toBe("St.Louis");

    // Other multi-word teams
    expect(canonicalTeamToken("Dallas Stars")).toBe("DallasStars");
    expect(canonicalTeamToken("Washington Capitals")).toBe(
      "WashingtonCapitals",
    );
    expect(canonicalTeamToken("Tampa Bay Lightning")).toBe("TampaBayLightning");

    // Canonical event ID generation invariance across team naming representations
    const event1 = buildCanonicalEventId(
      "NHL",
      "2026-10-02 19:00:00.000",
      "St. Louis Blues",
      "Dallas Stars",
    );
    const event2 = buildCanonicalEventId(
      "NHL",
      "2026-10-02 19:00:00.000",
      "St Louis Blues",
      "Dallas Stars",
    );
    const event3 = buildCanonicalEventId(
      "NHL",
      "2026-10-02 19:00:00.000",
      "Saint Louis Blues",
      "Dallas Stars",
    );

    expect(event1).toBe("NHL-20261002-St.LouisBlues@DallasStars");
    expect(event2).toBe("NHL-20261002-St.LouisBlues@DallasStars");
    expect(event3).toBe("NHL-20261002-St.LouisBlues@DallasStars");
  });

  it("identifies in-play live sub-sports across SportType, SportSubType, and team name markers", () => {
    expect(isLiveSubSport("LIVE", undefined, undefined)).toBe(true);
    expect(isLiveSubSport("Basketball", "NBA Live", undefined)).toBe(true);
    expect(isLiveSubSport("Football", "NFL Live", undefined)).toBe(true);
    expect(isLiveSubSport("Basketball", "NBA", "Lakers (Live)")).toBe(true);
    expect(isLiveSubSport("Basketball", "NBA", "Lakers")).toBe(false);
    expect(isLiveSubSport("Hockey", "NHL", "Dallas Stars")).toBe(false);
    expect(isLiveSubSport(undefined, undefined, undefined)).toBe(false);
  });

  it("formats enriched wagers and honors Bun.inspect.custom on FigureDateEnrichmentInspection", () => {
    const enriched = enrichWagerRecord(sampleTicker, sampleFigure);
    const line = formatEnrichedWagerInspect(enriched, { colors: false });

    expect(line).toContain("#1075710577");
    expect(line).toContain("[DAN245]");
    expect(line).toContain("Basketball/NBA");
    expect(line).toContain("Risk:$2,300.00");
    expect(line).toContain("Outcome:L (-$2,300.00)");
    expect(line).toContain("Latency:25s [LATE STEAM]");

    const inspection = new FigureDateEnrichmentInspection(
      {
        figureRecordsIndexed: 1,
        tickerRowsStreamed: 1,
        exactMatchedRows: 1,
        unmatchedRows: 0,
        matchRatePct: 100.0,
        totalRiskCents: enriched.settlement.amountWageredCents,
        totalNetPnlCents: enriched.settlement.netPnlCents,
      },
      [enriched],
    );

    const rendered = Bun.inspect(inspection, { colors: false });
    expect(rendered).toContain(
      "=== Fantasy402 Figure Date Enrichment Inspection ===",
    );
    expect(rendered).toContain("Figure Records Indexed : 1");
    expect(rendered).toContain("Ticker Rows Streamed  : 1");
    expect(rendered).toContain("Exact Matched Rows     : 1 (100.00%)");
    expect(rendered).toContain("Total Risk Monitored   : $2,300.00");
    expect(rendered).toContain("Net Settlement PnL     : -$2,300.00");
    expect(rendered).toContain("Sample Enriched Wagers (1):");
    expect(rendered).toContain("#1075710577");

    const json = inspection.toJSON();
    expect(json.stats.figureRecordsIndexed).toBe(1);
    expect(json.samples.length).toBe(1);
  });

  it("streams enriched wagers via Bun native direct ReadableStream (type: direct)", async () => {
    const enriched = enrichWagerRecord(sampleTicker, sampleFigure);
    const stream = createEnrichedWagersDirectStream([enriched]);
    expect(stream).toBeInstanceOf(ReadableStream);

    const text = await new Response(stream).text();
    expect(text).toContain("DAN245");
    expect(text.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(text.trim());
    expect(parsed.ticketNumber).toBe("1075710577");
    expect(parsed.settlement.amountWageredCents).toBe(230000);
  });

  it("pipes direct stream through CompressionStream with automatic backpressure", async () => {
    const enriched = enrichWagerRecord(sampleTicker, sampleFigure);
    const directStream = createEnrichedWagersDirectStream([enriched]);

    // Pipe through standard Web TransformStream with native backpressure
    const gzipCompressed = directStream.pipeThrough(
      new CompressionStream("gzip"),
    );
    const gzipDecompressed = gzipCompressed.pipeThrough(
      new DecompressionStream("gzip"),
    );

    const text = await new Response(gzipDecompressed).text();
    expect(text).toContain("1075710577");
    expect(text).toContain("DAN245");
  });

  it("guarantees FigureDateEnrichmentInspection is strictly pure and mutation-free during Bun.inspect", () => {
    const enriched = enrichWagerRecord(sampleTicker, sampleFigure);
    const inspection = new FigureDateEnrichmentInspection(
      {
        figureRecordsIndexed: 1,
        tickerRowsStreamed: 1,
        exactMatchedRows: 1,
        unmatchedRows: 0,
        matchRatePct: 100.0,
        totalRiskCents: enriched.settlement.amountWageredCents,
        totalNetPnlCents: enriched.settlement.netPnlCents,
      },
      [enriched],
    );

    const before = JSON.stringify(inspection);
    Bun.inspect(inspection, { colors: true });
    Bun.inspect(inspection, { colors: false });
    expect(JSON.stringify(inspection)).toBe(before);
  });

  it("hashCompositeMatchKey computes 64-bit wyhash bigint fingerprints deterministically", () => {
    const key = "DAN245|2026-11-06 20:09|2300|2000|546";
    const h1 = hashCompositeMatchKey(key);
    const h2 = hashCompositeMatchKey(key);
    expect(typeof h1).toBe("bigint");
    expect(h1).toBe(h2);

    const diffKey = "DAN245|2026-11-06 20:09|2300|2000|547";
    const hDiff = hashCompositeMatchKey(diffKey);
    expect(h1).not.toBe(hDiff);
  });

  it("formats throughput and duration in FigureDateEnrichmentInspection when present", () => {
    const enriched = enrichWagerRecord(sampleTicker, sampleFigure);
    const inspection = new FigureDateEnrichmentInspection(
      {
        figureRecordsIndexed: 100,
        tickerRowsStreamed: 1000,
        exactMatchedRows: 950,
        unmatchedRows: 50,
        matchRatePct: 95.0,
        totalRiskCents: enriched.settlement.amountWageredCents,
        totalNetPnlCents: enriched.settlement.netPnlCents,
        durationMs: 4.2,
        throughputRowsPerSec: 238095,
      },
      [enriched],
    );

    const report = Bun.inspect(inspection, { colors: false });
    expect(report).toContain(
      "Throughput             : 238,095 rows/sec (4.2ms total)",
    );
  });

  it("reconstructs pre/post-bet board line windows and ranks customers beating the desk in NCAAB 1H and GSLive NCAAB", () => {
    // 1. Sharp originator BRT106 bets Duke 1H -3.5 (-110) before the board steams to -4.5
    const brt1hTicker: LiveTickerWager = {
      WagerNumber: 800001,
      AgentID: "BILLY666",
      AgentLogin: "BILLY666",
      CustomerID: "BRT106",
      WagerType: "S",
      AmountWagered: 110000,
      ToWinAmount: 100000,
      InsertDateTime: "2026-11-12 18:10:00.000",
      TicketWriter: "Internet",
      ShortDesc: "S.Basketball #701 Duke -3½ -110 - For 1st Half",
    };
    const brt1hFigure: FigureDateWager = {
      TicketNumber: 900001,
      WagerNumber: 1,
      AmountWagered: 110000,
      ToWinAmount: 100000,
      WagerType: "S",
      AmountWon: 100000,
      AmountLost: 0,
      WagerStatus: "W",
      Outcome: "W",
      Description: "Basketball #701 Duke -3½ -110 - For 1st Half",
      AcceptedDateTime: "2026-11-12 18:10:00.000",
      CustomerID: "BRT106",
      TicketWriter: "Internet",
      GameDateTime: "2026-11-12 19:00:00.000",
      DailyFigureDate: "2026-11-12",
      SportType: "Basketball",
      SportSubType: "NCAAB",
      OrigSpread: -3.5,
      AdjSpread: -3.5,
      FinalMoney: -110,
      ChosenTeamID: "Duke",
      PeriodDescription: "1st Half",
      PeriodNumber: 1,
      Team1ID: "Duke",
      Team2ID: "North Carolina",
    };

    // 2. Recreational chaser SQ202 bets Duke 1H at -4.0 (buying 0.5 off board -4.5) 5 minutes later and loses
    const sq1hTicker: LiveTickerWager = {
      WagerNumber: 800002,
      AgentID: "BILLY666",
      AgentLogin: "BILLY666",
      CustomerID: "SQ202",
      WagerType: "S",
      AmountWagered: 55000,
      ToWinAmount: 50000,
      InsertDateTime: "2026-11-12 18:15:00.000",
      TicketWriter: "Internet",
      ShortDesc: "S.Basketball #701 Duke -4 -120 - buying ½ For 1st Half",
    };
    const sq1hFigure: FigureDateWager = {
      TicketNumber: 900002,
      WagerNumber: 1,
      AmountWagered: 55000,
      ToWinAmount: 50000,
      WagerType: "S",
      AmountWon: 0,
      AmountLost: 55000,
      WagerStatus: "L",
      Outcome: "L",
      Description: "Basketball #701 Duke -4 -120 - buying ½ For 1st Half",
      AcceptedDateTime: "2026-11-12 18:15:00.000",
      CustomerID: "SQ202",
      TicketWriter: "Internet",
      GameDateTime: "2026-11-12 19:00:00.000",
      DailyFigureDate: "2026-11-12",
      SportType: "Basketball",
      SportSubType: "NCAAB",
      OrigSpread: -4.5,
      AdjSpread: -4.0,
      BuyPoints: 0.5,
      FinalMoney: -120,
      ChosenTeamID: "Duke",
      PeriodDescription: "1st Half",
      PeriodNumber: 1,
      Team1ID: "Duke",
      Team2ID: "North Carolina",
    };

    // 3. BRT106 also hits GSLive Live NCAAB (EZL - INTERNET) and wins
    const brtLiveTicker: LiveTickerWager = {
      WagerNumber: 800003,
      AgentID: "BILLY666",
      AgentLogin: "BILLY666",
      CustomerID: "BRT106",
      WagerType: "L",
      AmountWagered: 220000,
      ToWinAmount: 200000,
      InsertDateTime: "2026-11-12 19:42:00.000",
      TicketWriter: "EZL - INTERNET",
      ShortDesc: "L.LIVE #9701 Duke (Live) -5½ -110 - For Game",
    };
    const brtLiveFigure: FigureDateWager = {
      TicketNumber: 900003,
      WagerNumber: 1,
      AmountWagered: 220000,
      ToWinAmount: 200000,
      WagerType: "L",
      AmountWon: 200000,
      AmountLost: 0,
      WagerStatus: "W",
      Outcome: "W",
      Description: "LIVE #9701 Duke (Live) -5½ -110 - For Game",
      AcceptedDateTime: "2026-11-12 19:42:00.000",
      CustomerID: "BRT106",
      TicketWriter: "EZL - INTERNET",
      GameDateTime: "2026-11-12 19:00:00.000",
      DailyFigureDate: "2026-11-12",
      SportType: "LIVE",
      SportSubType: "NCAAB Live",
      OrigSpread: -5.5,
      AdjSpread: -5.5,
      FinalMoney: -110,
      ChosenTeamID: "Duke (Live)",
      PeriodDescription: "Game",
      PeriodNumber: 0,
      Team1ID: "Duke (Live)",
      Team2ID: "North Carolina (Live)",
    };

    const w1 = enrichWagerRecord(brt1hTicker, brt1hFigure);
    const w2 = enrichWagerRecord(sq1hTicker, sq1hFigure);
    const w3 = enrichWagerRecord(brtLiveTicker, brtLiveFigure);
    const corpus = [w1, w2, w3];

    const windows = computeWagerLineWindows(corpus);
    const win1 = windows.get("900001")!;
    const win2 = windows.get("900002")!;
    expect(win1).toBeDefined();
    expect(win1.boardLineBefore).toBeNull();
    expect(win1.boardLineAtBet).toBe(-3.5);
    expect(win1.boardLineAfter).toBe(-4.5);
    expect(win1.closingBoardLine).toBe(-4.5);
    expect(win1.immediateLineMoveDelta).toBe(1);
    expect(win1.closingLineMoveDelta).toBe(1);
    expect(win1.beatLineMove).toBe(true);

    // SQ202 bought 0.5 pts (-4.5 -> -4.0), so boardLineAtBet is -4.5 while ticketLineAtBet is -4.0
    expect(win2.boardLineBefore).toBe(-3.5);
    expect(win2.boardLineAtBet).toBe(-4.5);
    expect(win2.ticketLineAtBet).toBe(-4.0);
    expect(win2.buyPoints).toBe(0.5);
    expect(win2.beatLineMove).toBe(false);

    // Slice 1: College Basketball 1st Halves
    expect(
      matchesWagerSlice(w1, { subSport: "NCAAB", portalPeriod: "1H" }),
    ).toBe(true);
    expect(
      matchesWagerSlice(w3, { subSport: "NCAAB", portalPeriod: "1H" }),
    ).toBe(false);

    const ncaab1hLeaders = rankCustomersBySlice(corpus, {
      subSport: "NCAAB",
      portalPeriod: "1H",
    });
    expect(ncaab1hLeaders).toHaveLength(2);
    expect<string>(ncaab1hLeaders[0]!.customerId).toBe("BRT106");
    expect<number>(ncaab1hLeaders[0]!.customerNetPnlCents).toBe(100000);
    expect(ncaab1hLeaders[0]!.beatLineMoveCount).toBe(1);
    expect(ncaab1hLeaders[0]!.avgClosingLineDelta).toBe(1);
    expect(ncaab1hLeaders[0]!.bookHoldPct).toBeCloseTo(-90.91, 2);
    expect<string>(ncaab1hLeaders[1]!.customerId).toBe("SQ202");
    expect<number>(ncaab1hLeaders[1]!.customerNetPnlCents).toBe(-55000);

    // Slice 2: Live NCAA Basketball from GSLive
    const gsLiveNcaabLeaders = rankCustomersBySlice(corpus, {
      subSport: "NCAAB",
      isLive: true,
      gsLiveOnly: true,
    });
    expect(gsLiveNcaabLeaders).toHaveLength(1);
    expect<string>(gsLiveNcaabLeaders[0]!.customerId).toBe("BRT106");
    expect<number>(gsLiveNcaabLeaders[0]!.customerNetPnlCents).toBe(200000);
    expect(gsLiveNcaabLeaders[0]!.winRatePct).toBe(100);
  });

  it("summarizes the observed BRT106 getPerformancePlayer 31-day wire payload and extracts active figureDates", () => {
    expect(parsePerformancePlayerDateLabel("11/12/2026 Thursday")).toEqual({
      figureDate: "2026-11-12",
      dayOfWeek: "Thursday",
    });

    const brt106WireRows = [
      { Date: "11/13/2026 Friday", Won: 0, Lost: 0 },
      { Date: "11/12/2026 Thursday", Won: 1500000, Lost: 1150000 },
      { Date: "11/11/2026 Wednesday", Won: 0, Lost: 0 },
      { Date: "11/10/2026 Tuesday", Won: 1500000, Lost: 2087500 },
      { Date: "11/09/2026 Monday", Won: 250000, Lost: 0 },
      { Date: "11/08/2026 Sunday", Won: 4800000, Lost: 1455000 },
      { Date: "11/07/2026 Saturday", Won: 0, Lost: 587500 },
      { Date: "11/06/2026 Friday", Won: 3000000, Lost: 2465000 },
      { Date: "11/05/2026 Thursday", Won: 2300000, Lost: 550000 },
      { Date: "11/04/2026 Wednesday", Won: 0, Lost: 0 },
      { Date: "11/03/2026 Tuesday", Won: 1700000, Lost: 1235000 },
      { Date: "11/02/2026 Monday", Won: 1700000, Lost: 525000 },
      { Date: "11/01/2026 Sunday", Won: 1000000, Lost: 0 },
      { Date: "10/31/2026 Saturday", Won: 0, Lost: 0 },
      { Date: "10/30/2026 Friday", Won: 0, Lost: 0 },
      { Date: "10/29/2026 Thursday", Won: 0, Lost: 0 },
      { Date: "10/28/2026 Wednesday", Won: 0, Lost: 0 },
      { Date: "10/27/2026 Tuesday", Won: 0, Lost: 0 },
      { Date: "10/26/2026 Monday", Won: 0, Lost: 0 },
      { Date: "10/25/2026 Sunday", Won: 0, Lost: 0 },
      { Date: "10/24/2026 Saturday", Won: 0, Lost: 0 },
      { Date: "10/23/2026 Friday", Won: 0, Lost: 0 },
      { Date: "10/22/2026 Thursday", Won: 0, Lost: 0 },
      { Date: "10/21/2026 Wednesday", Won: 0, Lost: 0 },
      { Date: "10/20/2026 Tuesday", Won: 0, Lost: 0 },
      { Date: "10/19/2026 Monday", Won: 0, Lost: 0 },
      { Date: "10/18/2026 Sunday", Won: 0, Lost: 0 },
      { Date: "10/17/2026 Saturday", Won: 0, Lost: 0 },
      { Date: "10/16/2026 Friday", Won: 0, Lost: 0 },
      { Date: "10/15/2026 Thursday", Won: 0, Lost: 0 },
      { Date: "10/14/2026 Wednesday", Won: 0, Lost: 0 },
    ];

    const summary = summarizePerformancePlayer(brt106WireRows);
    expect(summary.totalDays).toBe(31);
    expect(summary.activeDays).toBe(10);
    expect(summary.winningDays).toBe(8);
    expect(summary.losingDays).toBe(2);
    expect(summary.dailyWinRatePct).toBe(80);
    expect<number>(summary.totalWonCents).toBe(17750000);
    expect<number>(summary.totalLostCents).toBe(10055000);
    expect<number>(summary.customerNetCents).toBe(7695000);
    expect(summary.totalWonUsd).toBe(177500);
    expect(summary.totalLostUsd).toBe(100550);
    expect(summary.customerNetUsd).toBe(76950);
    expect(summary.activeFigureDates).toEqual([
      "2026-11-12",
      "2026-11-10",
      "2026-11-09",
      "2026-11-08",
      "2026-11-07",
      "2026-11-06",
      "2026-11-05",
      "2026-11-03",
      "2026-11-02",
      "2026-11-01",
    ]);

    // 1. Active figureDate drill-down payloads match the observed getWagersByFigureDate JSON body
    const drilldownPayloads = buildActiveFigureDateDrilldownPayloads(
      brt106WireRows,
      {
        agentID: "BILLY666",
        agentOwner: "BILLY666",
        customerID: "BRT106",
      },
    );
    expect(drilldownPayloads).toHaveLength(10);
    expect(drilldownPayloads[0]).toEqual({
      RRO: 1,
      agentID: "BILLY666",
      agentOwner: "BILLY666",
      customerID: "BRT106",
      date: "2026-11-13",
      figureDate: "2026-11-12",
      graded: 0,
      path: "/cloud/api/Report/getWagersByFigureDate",
      sort: 1,
      typeSort: 2,
      week: 0,
    });
    expect(drilldownPayloads[9]?.figureDate).toBe("2026-11-01");

    // 2. Explicit per-day table of all 10 active figureDates (chronological) and partition sum check
    const activeChronologicalTable = summary.days
      .filter((d) => d.isActive)
      .sort((a, b) => a.figureDate.localeCompare(b.figureDate))
      .map((d) => ({
        figureDate: d.figureDate,
        dayOfWeek: d.dayOfWeek,
        wonCents: Number(d.wonCents),
        lostCents: Number(d.lostCents),
        customerNetCents: Number(d.customerNetCents),
      }));

    expect(activeChronologicalTable).toEqual([
      // Carryover prefix (Nov 1 – Nov 9, 8 active days; Nov 4 inactive): sum = +7,932,500 cents (+$79,325.00)
      {
        figureDate: "2026-11-01",
        dayOfWeek: "Sunday",
        wonCents: 1000000,
        lostCents: 0,
        customerNetCents: 1000000,
      },
      {
        figureDate: "2026-11-02",
        dayOfWeek: "Monday",
        wonCents: 1700000,
        lostCents: 525000,
        customerNetCents: 1175000,
      },
      {
        figureDate: "2026-11-03",
        dayOfWeek: "Tuesday",
        wonCents: 1700000,
        lostCents: 1235000,
        customerNetCents: 465000,
      },
      {
        figureDate: "2026-11-05",
        dayOfWeek: "Thursday",
        wonCents: 2300000,
        lostCents: 550000,
        customerNetCents: 1750000,
      },
      {
        figureDate: "2026-11-06",
        dayOfWeek: "Friday",
        wonCents: 3000000,
        lostCents: 2465000,
        customerNetCents: 535000,
      },
      {
        figureDate: "2026-11-07",
        dayOfWeek: "Saturday",
        wonCents: 0,
        lostCents: 587500,
        customerNetCents: -587500,
      },
      {
        figureDate: "2026-11-08",
        dayOfWeek: "Sunday",
        wonCents: 4800000,
        lostCents: 1455000,
        customerNetCents: 3345000,
      },
      {
        figureDate: "2026-11-09",
        dayOfWeek: "Monday",
        wonCents: 250000,
        lostCents: 0,
        customerNetCents: 250000,
      },
      // Post-carryover figure week (Nov 10 & Nov 12, 2 active days; Nov 11 & Nov 13 inactive): sum = -237,500 cents (-$2,375.00)
      {
        figureDate: "2026-11-10",
        dayOfWeek: "Tuesday",
        wonCents: 1500000,
        lostCents: 2087500,
        customerNetCents: -587500,
      },
      {
        figureDate: "2026-11-12",
        dayOfWeek: "Thursday",
        wonCents: 1500000,
        lostCents: 1150000,
        customerNetCents: 350000,
      },
    ]);

    const prefixSumCents = activeChronologicalTable
      .slice(0, 8)
      .reduce((acc, row) => acc + row.customerNetCents, 0);
    const postSumCents = activeChronologicalTable
      .slice(8)
      .reduce((acc, row) => acc + row.customerNetCents, 0);
    expect(prefixSumCents).toBe(7932500);
    expect(postSumCents).toBe(-237500);
    expect(prefixSumCents + postSumCents).toBe(7695000);

    // 3. Reconcile cumulative daily P&L against BOTH getInfoPlayer CarryOverAmount (7,932,500 cents) AND thisWeek.PreviousBalance ($79,325)
    const carryOverRec = reconcilePerformanceWithCarryOver(
      brt106WireRows,
      7932500,
      79325,
    );
    expect(carryOverRec.previousBalanceParityMatched).toBe(true);
    expect(carryOverRec.previousBalanceParityDeltaCents).toBe(0);
    expect(carryOverRec.prefixSumMatched).toBe(true);
    expect(carryOverRec.matched).toBe(true);
    expect<number>(carryOverRec.targetCarryOverCents).toBe(7932500);
    expect(carryOverRec.targetCarryOverUsd).toBe(79325);
    expect(carryOverRec.windowStartFigureDate).toBe("2026-11-01");
    expect(carryOverRec.windowEndFigureDate).toBe("2026-11-09");
    expect(carryOverRec.carryOverFigureDates).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
    ]);
    expect(carryOverRec.postCarryOverFigureDates).toEqual([
      "2026-11-10",
      "2026-11-12",
    ]);
    expect<number>(carryOverRec.postCarryOverNetCents).toBe(-237500);
    expect(carryOverRec.postCarryOverNetUsd).toBe(-2375);
    expect<number>(
      carryOverRec.targetCarryOverCents + carryOverRec.postCarryOverNetCents,
    ).toBe(summary.customerNetCents);

    // If PreviousBalance disagrees with CarryOverAmount, matched is false even when prefixSumMatched is true
    const disagreedRec = reconcilePerformanceWithCarryOver(
      brt106WireRows,
      7932500,
      79000,
    );
    expect(disagreedRec.prefixSumMatched).toBe(true);
    expect(disagreedRec.previousBalanceParityMatched).toBe(false);
    expect(disagreedRec.previousBalanceParityDeltaCents).toBe(32500);
    expect(disagreedRec.matched).toBe(false);
  });
});
