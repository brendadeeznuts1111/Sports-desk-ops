import { describe, expect, test } from "bun:test";
import {
  ANALYSIS_AGENT_ID_PADDED_WIDTH,
  ANALYSIS_CUSTOMER_ID_PADDED_WIDTH,
  ANALYSIS_LINE_TYPES,
  ANALYSIS_REPORT_TYPES,
  ANALYSIS_SPORT_SUBTYPE_PADDED_WIDTH,
  americanOddsToCentIndex,
  buildLineTypesFormBody,
  buildReportPlayerAnalysisFormBody,
  buildReportPlayerAnalysisFormFields,
  computeExpectedPointsDelta,
  computeExpectedPriceDelta,
  defaultAnalysisDateWindow,
  detectBoughtPointsInDescription,
  fetchCustomerPlayerAnalysisDetail,
  fetchLineTypes,
  fetchReportPlayerAnalysis,
  normalizeReportPlayerAnalysisRow,
  parseCloseLine,
  parseReportPlayerAnalysisEnvelope,
  summarizeCombinedCustomerDetail,
  summarizeReportPlayerAnalysis,
  summarizeSuspectedBotCohort,
  type ReportPlayerAnalysisEnvelope,
} from "./f402_report_player_analysis.ts";
import type { F402ReplayTransport } from "./f402_replay_transport.ts";

/** Live wire capture from POST /cloud/api/Manager/getReportPlayerAnalysis (2026-11-14, CUST04_1 under AGNT_A). */
const CUST04_1_OBSERVED_ENVELOPE: ReportPlayerAnalysisEnvelope = {
  LIST: [
    {
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: "-6.0",
      JUICE: "-110.0",
      CLOSELINE: "-6 -110",
      PRICE: 0,
      POINTS: null,
      DESCRIPTION: "Football #187 Oregon St -6 -110 - For Game",
      DAILYFIGUREDATE: "2026-10-31 00:00:00.000",
      RISK: "11000",
      TOWIN: "10000",
      WINLOSE: "11000",
      WAGERSTATUS: "L",
      SPORTSUBTYPE: "College             ",
      PERIODNUMBER: "0",
      POSTEDDATETIME: "2026-10-31 17:26:13.313",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    },
    {
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: "-2.5",
      JUICE: "-110.0",
      CLOSELINE: "-2.5 -110",
      PRICE: 0,
      POINTS: null,
      DESCRIPTION: "Football #202 Iowa -2½ -110 - For Game",
      DAILYFIGUREDATE: "2026-10-31 00:00:00.000",
      RISK: "11000",
      TOWIN: "10000",
      WINLOSE: "10000",
      WAGERSTATUS: "W",
      SPORTSUBTYPE: "College             ",
      PERIODNUMBER: "0",
      POSTEDDATETIME: "2026-10-31 00:19:58.600",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    },
    {
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: "3.0",
      JUICE: "100.0",
      CLOSELINE: "3 -110",
      PRICE: -10,
      POINTS: null,
      DESCRIPTION: "Football #365 Colorado +3 +100 - For Game",
      DAILYFIGUREDATE: "2026-11-07 00:00:00.000",
      RISK: "10000",
      TOWIN: "10000",
      WINLOSE: "10000",
      WAGERSTATUS: "L",
      SPORTSUBTYPE: "College             ",
      PERIODNUMBER: "0",
      POSTEDDATETIME: "2026-11-07 12:51:20.310",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    },
    {
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: null,
      JUICE: "140.0",
      CLOSELINE: "135",
      PRICE: -5,
      POINTS: null,
      DESCRIPTION: "Football #365 Colorado +140 - For Game",
      DAILYFIGUREDATE: "2026-11-07 00:00:00.000",
      RISK: "5000",
      TOWIN: "7000",
      WINLOSE: "5000",
      WAGERSTATUS: "L",
      SPORTSUBTYPE: "College             ",
      PERIODNUMBER: "0",
      POSTEDDATETIME: "2026-11-07 12:51:46.603",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    },
    {
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: "57.5",
      JUICE: "-110.0",
      CLOSELINE: "57.5 -110",
      PRICE: 0,
      POINTS: null,
      DESCRIPTION: "Football #334 Maryland/Purdue U 57½ -110 - For Game",
      DAILYFIGUREDATE: "2026-11-07 00:00:00.000",
      RISK: "5500",
      TOWIN: "5000",
      WINLOSE: "5500",
      WAGERSTATUS: "L",
      SPORTSUBTYPE: "College             ",
      PERIODNUMBER: "0",
      POSTEDDATETIME: "2026-11-07 12:19:11.337",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    },
    {
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: "-7.0",
      JUICE: "-110.0",
      CLOSELINE: "-7 -110",
      PRICE: 0,
      POINTS: null,
      DESCRIPTION: "Football #338 GA Southern -7 -110 - For Game",
      DAILYFIGUREDATE: "2026-11-07 00:00:00.000",
      RISK: "11000",
      TOWIN: "10000",
      WINLOSE: "10000",
      WAGERSTATUS: "W",
      SPORTSUBTYPE: "College             ",
      PERIODNUMBER: "0",
      POSTEDDATETIME: "2026-11-07 13:58:39.667",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    },
    {
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: "5.5",
      JUICE: "-103.0",
      CLOSELINE: "5.5 -110",
      PRICE: -7,
      POINTS: null,
      DESCRIPTION: "Football #470 Chargers +5½ -103 - For Game",
      DAILYFIGUREDATE: "2026-11-08 00:00:00.000",
      RISK: "20600",
      TOWIN: "20000",
      WINLOSE: "20600",
      WAGERSTATUS: "L",
      SPORTSUBTYPE: "NFL                 ",
      PERIODNUMBER: "0",
      POSTEDDATETIME: "2026-11-08 14:36:02.357",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    },
    {
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: "-3.0",
      JUICE: "102.0",
      CLOSELINE: "-3 -125",
      PRICE: -27,
      POINTS: null,
      DESCRIPTION: "Football #472 Patriots -3 +102 - For Game",
      DAILYFIGUREDATE: "2026-11-08 00:00:00.000",
      RISK: "5000",
      TOWIN: "5100",
      WINLOSE: "5000",
      WAGERSTATUS: "L",
      SPORTSUBTYPE: "NFL                 ",
      PERIODNUMBER: "0",
      POSTEDDATETIME: "2026-11-03 15:46:09.583",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    },
    {
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: "6.0",
      JUICE: "102.0",
      CLOSELINE: "6 -105",
      PRICE: -7,
      POINTS: null,
      DESCRIPTION: "Football #475 Buccaneers  6½ -108 - buying ½ For Game",
      DAILYFIGUREDATE: "2026-11-08 00:00:00.000",
      RISK: "5400",
      TOWIN: "5000",
      WINLOSE: "5000",
      WAGERSTATUS: "W",
      SPORTSUBTYPE: "NFL                 ",
      PERIODNUMBER: "0",
      POSTEDDATETIME: "2026-11-08 20:19:06.113",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    },
    {
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: "23.0",
      JUICE: "-105.0",
      CLOSELINE: "23 -115",
      PRICE: -10,
      POINTS: null,
      DESCRIPTION: "Football #477 Bills/Vikings O 23 -105 - For 1st Half",
      DAILYFIGUREDATE: "2026-11-09 00:00:00.000",
      RISK: "5250",
      TOWIN: "5000",
      WINLOSE: "5250",
      WAGERSTATUS: "L",
      SPORTSUBTYPE: "NFL                 ",
      PERIODNUMBER: "1",
      POSTEDDATETIME: "2026-11-09 19:45:24.653",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    },
    {
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: "52.0",
      JUICE: "-110.0",
      CLOSELINE: "52 -110",
      PRICE: 0,
      POINTS: null,
      DESCRIPTION: "Football #107 U Mass/Toledo O 52 -110 - For Game",
      DAILYFIGUREDATE: "2026-11-11 00:00:00.000",
      RISK: "5500",
      TOWIN: "5000",
      WINLOSE: "5500",
      WAGERSTATUS: "L",
      SPORTSUBTYPE: "College             ",
      PERIODNUMBER: "0",
      POSTEDDATETIME: "2026-11-11 18:34:26.627",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    },
    {
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: "24.5",
      JUICE: "-120.0",
      CLOSELINE: "24.5 -120",
      PRICE: 0,
      POINTS: null,
      DESCRIPTION: "Football #115 Memphis/S Florida O 24½ -120 - For 1st Half",
      DAILYFIGUREDATE: "2026-11-12 00:00:00.000",
      RISK: "6000",
      TOWIN: "5000",
      WINLOSE: "5000",
      WAGERSTATUS: "W",
      SPORTSUBTYPE: "College             ",
      PERIODNUMBER: "1",
      POSTEDDATETIME: "2026-11-12 19:54:47.930",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    },
    {
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: "-3.0",
      JUICE: "-110.0",
      CLOSELINE: "-3 -115",
      PRICE: -5,
      POINTS: null,
      DESCRIPTION: "Football #120 Pittsburgh -3 -110 - For Game",
      DAILYFIGUREDATE: "2026-11-13 00:00:00.000",
      RISK: "11000",
      TOWIN: "10000",
      WINLOSE: "11000",
      WAGERSTATUS: "L",
      SPORTSUBTYPE: "College             ",
      PERIODNUMBER: "0",
      POSTEDDATETIME: "2026-11-13 18:47:21.990",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    },
    {
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: "6.5",
      JUICE: "-115.0",
      CLOSELINE: "6.5 -130",
      PRICE: -15,
      POINTS: null,
      DESCRIPTION: "Hockey #31 Senators/Sabres O 6½ -115 - For Game",
      DAILYFIGUREDATE: "2026-11-04 00:00:00.000",
      RISK: "5750",
      TOWIN: "5000",
      WINLOSE: "5750",
      WAGERSTATUS: "L",
      SPORTSUBTYPE: "NHL                 ",
      PERIODNUMBER: "0",
      POSTEDDATETIME: "2026-11-04 18:59:46.880",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    },
    {
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: "6.5",
      JUICE: "-120.0",
      CLOSELINE: "6.5 -120",
      PRICE: 0,
      POINTS: null,
      DESCRIPTION: "Hockey #59 Predators/Avalanche O 6½ -120 - For Game",
      DAILYFIGUREDATE: "2026-11-05 00:00:00.000",
      RISK: "6000",
      TOWIN: "5000",
      WINLOSE: "6000",
      WAGERSTATUS: "L",
      SPORTSUBTYPE: "NHL                 ",
      PERIODNUMBER: "0",
      POSTEDDATETIME: "2026-11-05 21:27:17.437",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    },
  ],
};

describe("f402_report_player_analysis", () => {
  test("builds form fields and URL-encoded body in manager.js:93668 wire order", () => {
    const window = defaultAnalysisDateWindow(
      new Date("2026-11-14T18:00:00Z"),
      14,
    );
    expect(window).toEqual({
      startDate: "2026-10-31",
      endDate: "2026-11-14",
    });

    const fields = buildReportPlayerAnalysisFormFields({
      agentID: "AGENT_BB",
      startDate: window.startDate,
      endDate: window.endDate,
    });
    expect(Object.keys(fields)).toEqual([
      "agentID",
      "agentOwner",
      "customerID",
      "reportType",
      "startDate",
      "endDate",
      "lineType",
      "operation",
      "RRO",
    ]);
    expect(fields.customerID).toBe("");
    expect(
      buildReportPlayerAnalysisFormBody({
        agentID: "AGENT_BB",
        customerID: "CUST04_1",
        startDate: "2026-10-31",
        endDate: "2026-11-14",
      }),
    ).toBe(
      "agentID=AGENT_BB&agentOwner=AGENT_BB&customerID=CUST04_1&reportType=1&startDate=2026-10-31&endDate=2026-11-14&lineType=1&operation=getReportPlayerAnalysis&RRO=1",
    );
  });

  test("verifies padding widths, CLV PRICE formula, bought points, and WINLOSE invariants on all 15 observed CUST04_1 rows", () => {
    const parsed = parseReportPlayerAnalysisEnvelope(
      CUST04_1_OBSERVED_ENVELOPE,
    );
    expect(parsed.LIST).toHaveLength(15);

    const rows = parsed.LIST.map(normalizeReportPlayerAnalysisRow);
    for (const row of rows) {
      expect(row.customerId).toBe("CUST04_1");
      expect(row.customerIdRawWidth).toBe(ANALYSIS_CUSTOMER_ID_PADDED_WIDTH);
      expect(row.playerLogin).toBe("CUST04");
      expect(row.agentId).toBe("AGNT_A");
      expect(row.agentIdRawWidth).toBe(ANALYSIS_AGENT_ID_PADDED_WIDTH);
      expect(row.agentLogin).toBe("CUST04");
      expect(row.sportSubTypeRawWidth).toBe(
        ANALYSIS_SPORT_SUBTYPE_PADDED_WIDTH,
      );
      expect(row.priceFormulaMatchesWire).toBe(true);
      expect(row.winLoseMatchesOutcome).toBe(true);
      expect(row.inetTarget).toBe("betolive.com");
      expect(row.suspectedBot).toBe("N");
      expect(row.botLabel).toBe("None");
    }

    // Row 3: Moneyline (#365 Colorado +140 vs close 135 -> PRICE = -5)
    const mlRow = rows[3]!;
    expect(mlRow.betPoints).toBeNull();
    expect(mlRow.isMoneyline).toBe(true);
    expect(mlRow.closePoints).toBeNull();
    expect(mlRow.closeJuice).toBe(135);
    expect(mlRow.priceDelta).toBe(-5);
    expect(mlRow.expectedPriceDelta).toBe(-5);

    // Row 7: Early-week NFL Patriots -3 +102 vs close -3 -125 -> PRICE = -27, placed 5 days before figure date
    const patsRow = rows[7]!;
    expect(patsRow.juice).toBe(102);
    expect(patsRow.closeJuice).toBe(-125);
    expect(patsRow.priceDelta).toBe(-27);
    expect(patsRow.expectedPriceDelta).toBe(-27);
    expect(patsRow.leadTimeHours).toBe(120);

    // Row 8: Bought half-point Buccaneers 6½ -108 - buying ½ For Game (wire BETPOINTS=6.0, JUICE=102.0 vs close 6 -105 -> PRICE = -7)
    const bucsRow = rows[8]!;
    expect(bucsRow.boughtPointsDetail).toEqual({
      hasBoughtPoints: true,
      boughtPoints: 0.5,
      displayedJuice: -108,
    });
    expect(bucsRow.betPoints).toBe(6);
    expect(bucsRow.juice).toBe(102);
    expect(bucsRow.closePoints).toBe(6);
    expect(bucsRow.closeJuice).toBe(-105);
    expect(bucsRow.priceDelta).toBe(-7);
    expect(bucsRow.playerNetCents).toBe(5000);
  });

  test("summarizes CUST04_1 and multi-customer / summary-mode rollups accurately", () => {
    const summary = summarizeReportPlayerAnalysis(CUST04_1_OBSERVED_ENVELOPE);
    expect(summary.rowCount).toBe(15);
    expect(summary.detailRowCount).toBe(15);
    expect(summary.summaryRowCount).toBe(0);
    expect(summary.customerCount).toBe(1);
    expect(summary.officeCount).toBe(1);
    expect(summary.totalRiskCents).toBe(124000);
    expect(summary.totalToWinCents).toBe(117100);
    expect(summary.totalPlayerNetCents).toBe(-60600);
    expect(summary.totalHouseNetCents).toBe(60600);
    expect(summary.beatClosingPriceCount).toBe(8);
    expect(summary.worseClosingPriceCount).toBe(0);
    expect(summary.matchedClosingPriceCount).toBe(7);
    expect(summary.beatClosingPriceRate).toBeCloseTo(0.5333, 4);
    expect(summary.meanPriceDelta).toBe(-5.73);
    expect(summary.priceFormulaMatchCount).toBe(15);
    expect(summary.winLoseInvariantMatchCount).toBe(15);

    const cust = summary.customers[0]!;
    expect(cust.customerId).toBe("CUST04_1");
    expect(cust.agentId).toBe("AGNT_A");
    expect(cust.winCount).toBe(4);
    expect(cust.lossCount).toBe(11);
    expect(cust.boughtPointsWagerCount).toBe(1);
    expect(cust.maxLeadTimeHours).toBe(120);
    expect(cust.minPriceDelta).toBe(-27);
    expect(cust.maxPriceDelta).toBe(0);
    expect(cust.unflaggedSharpSignal).toBe(true);
    expect(cust.subSports).toEqual({
      College: 9,
      NFL: 4,
      NHL: 2,
    });
    expect(summary.unflaggedSharpCustomers).toHaveLength(1);
  });

  test("supports summary-mode rows (TOTALBETS / BETTERPRICELINES / BETTERPOINTSLINES / signed WINLOSE) and transport fetch", async () => {
    const summaryModeEnvelope: ReportPlayerAnalysisEnvelope = {
      LIST: [
        {
          CustomerID: "CUST03    ",
          PlayerLogin: "CUST03",
          AgentID: "DAN318    ",
          AgentLogin: "CUST03",
          SuspectedBot: "Y",
          SuspectedBotType: "3",
          InetTarget: "play402.com",
          PRICE: -8.5,
          POINTS: -1.1,
          TOTALBETS: 20,
          BETTERPRICELINES: 14,
          BETTERPOINTSLINES: 9,
          WINLOSE: "125000",
        },
        {
          CustomerID: "CUST04_1  ",
          PlayerLogin: "CUST04",
          AgentID: "AGNT_A    ",
          AgentLogin: "CUST04",
          SuspectedBot: "N",
          SuspectedBotType: "0",
          InetTarget: "betolive.com",
          PRICE: -5.73,
          POINTS: -0.61,
          BETTERPRICELINES: 8,
          BETTERPOINTSLINES: 18,
          TOTALBETS: 37,
          WINLOSE: "-52350",
        },
      ],
    };
    const rollup = summarizeReportPlayerAnalysis(summaryModeEnvelope);
    expect(rollup.summaryRowCount).toBe(2);
    expect(rollup.totalWagerCount).toBe(57);
    expect(rollup.totalPlayerNetCents).toBe(72650);
    expect(rollup.totalHouseNetCents).toBe(-72650);
    expect(rollup.beatClosingPriceCount).toBe(22);
    expect(rollup.beatClosingPointsCount).toBe(27);
    expect(rollup.byOffice).toHaveLength(2);
    expect(rollup.byInetTarget).toHaveLength(2);

    const brt = rollup.customers.find((c) => c.customerId === "CUST03")!;
    expect(brt.wagerCount).toBe(20);
    expect(brt.beatClosingPriceCount).toBe(14);
    expect(brt.beatClosingPointsCount).toBe(9);
    expect(brt.playerNetCents).toBe(125000);
    expect(brt.botLabel).toBe("Sharp Player");
    expect(brt.unflaggedSharpSignal).toBe(false);

    const mm = rollup.customers.find((c) => c.customerId === "CUST04_1")!;
    expect(mm.wagerCount).toBe(37);
    expect(mm.beatClosingPriceCount).toBe(8);
    expect(mm.beatClosingPointsCount).toBe(18);
    expect(mm.meanPriceDelta).toBe(-5.73);
    expect(mm.meanPointsDelta).toBe(-0.61);
    expect(mm.playerNetCents).toBe(-52350);
    expect(mm.houseNetCents).toBe(52350);
    expect(mm.unflaggedSharpSignal).toBe(true);

    const calls: { url: string; body: string }[] = [];
    const mockTransport: F402ReplayTransport = {
      label: "session-file",
      async fetch(url, init) {
        calls.push({ url, body: String(init.body ?? "") });
        if (url.endsWith("/getLineTypes")) {
          return new Response(
            JSON.stringify({
              LIST: [{ lineType: "1", DisplayLineType: "Spread / Total / ML" }],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify(CUST04_1_OBSERVED_ENVELOPE), {
          status: 200,
        });
      },
      async close() {},
    };

    const lineTypes = await fetchLineTypes(
      mockTransport,
      { agentID: "AGENT_BB" },
      { readSession: () => null },
    );
    expect(lineTypes).toEqual([
      { lineType: "1", displayLineType: "Spread / Total / ML" },
    ]);
    expect(buildLineTypesFormBody({ agentID: "AGENT_BB" })).toBe(
      "agentID=AGENT_BB&agentOwner=AGENT_BB&sportType=&operation=getLineTypes&RRO=1",
    );

    const res = await fetchReportPlayerAnalysis(
      mockTransport,
      {
        agentID: "AGENT_BB",
        startDate: "2026-10-31",
        endDate: "2026-11-14",
      },
      { readSession: () => null },
    );
    expect(res.summary.rowCount).toBe(15);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(
      "https://www.fantasy402.com/cloud/api/Manager/getReportPlayerAnalysis",
    );

    expect(americanOddsToCentIndex(-110)).toBe(-10);
    expect(americanOddsToCentIndex(102)).toBe(2);
    expect(computeExpectedPriceDelta(102, -125)).toBe(-27);
    expect(parseCloseLine("-2.5 -110")).toEqual({
      raw: "-2.5 -110",
      closePoints: -2.5,
      closeJuice: -110,
      isMoneyline: false,
    });
    expect(
      detectBoughtPointsInDescription(
        "Football #475 Buccaneers  6½ -108 - buying ½ For Game",
      ),
    ).toEqual({
      hasBoughtPoints: true,
      boughtPoints: 0.5,
      displayedJuice: -108,
    });

    // Over vs Spread/Under POINTS sign convention:
    // Over: betPoints - closePoints; Spread/Under: closePoints - betPoints
    expect(
      computeExpectedPointsDelta(
        212.5,
        212,
        "Basketball #507 Hornets/Nets O 212½ -110 - For Game",
      ),
    ).toBe(0.5);
    expect(
      computeExpectedPointsDelta(
        221.5,
        222.5,
        "Basketball #529 Magic/Suns O 221½ -110 - For Game",
      ),
    ).toBe(-1);
    expect(
      computeExpectedPointsDelta(
        236,
        235.5,
        "Basketball #564 Cavaliers/Heat U 236 -110 - For Game",
      ),
    ).toBe(-0.5);
    expect(
      computeExpectedPointsDelta(
        -10,
        -12,
        "Basketball #506 Celtics -10 -110 - For Game",
      ),
    ).toBe(-2);

    const overRow = normalizeReportPlayerAnalysisRow({
      CustomerID: "CUST04_1  ",
      PlayerLogin: "CUST04",
      AgentID: "AGNT_A    ",
      AgentLogin: "CUST04",
      BETPOINTS: "221.5",
      JUICE: "-110.0",
      CLOSELINE: "222.5 -110",
      PRICE: null,
      POINTS: -1,
      DESCRIPTION: "Basketball #529 Magic/Suns O 221½ -110 - For Game",
      DAILYFIGUREDATE: "2026-11-05 00:00:00.000",
      RISK: "5500",
      TOWIN: "5000",
      WINLOSE: "5500",
      WAGERSTATUS: "L",
      SPORTSUBTYPE: "NBA                 ",
      PERIODNUMBER: "0",
      POSTEDDATETIME: "2026-11-05 15:36:46.520",
      SuspectedBot: "N",
      SuspectedBotType: "0",
      InetTarget: "betolive.com",
      TOTALBETS: null,
      BETTERPRICELINES: null,
      BETTERPOINTSLINES: null,
    });
    expect(overRow.pointsDelta).toBe(-1);
    expect(overRow.expectedPointsDelta).toBe(-1);
    expect(overRow.pointsFormulaMatchesWire).toBe(true);
    expect(overRow.beatClosingPoints).toBe(true);
    expect(overRow.worseThanClosingPoints).toBe(false);
  });

  test("summarizeSuspectedBotCohort computes bot count, sub-sport of choice, and primary specialization", () => {
    const cohort = summarizeSuspectedBotCohort({
      LIST: [
        // Non-bot row should be ignored
        ...CUST04_1_OBSERVED_ENVELOPE.LIST.slice(0, 2),
        // Bot 1: NICWEL2432 (SuspectedBot="Y", SuspectedBotType="3" Sharp Player) — 2 NCAA, 1 College
        {
          CustomerID: "NICWEL2432",
          PlayerLogin: "NICWEL2432",
          AgentID: "TANTUR50  ",
          AgentLogin: "NICWEL2432",
          BETPOINTS: "-4.5",
          JUICE: "-110.0",
          CLOSELINE: "-5.5 -110",
          PRICE: null,
          POINTS: -1,
          DESCRIPTION: "Basketball #701 Duke -4½ -110 - For Game",
          DAILYFIGUREDATE: "2026-11-10 00:00:00.000",
          RISK: "1100",
          TOWIN: "1000",
          WINLOSE: "1000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "NCAA                ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-10 14:00:00.000",
          SuspectedBot: "Y",
          SuspectedBotType: "3",
          InetTarget: "BetsElite.com",
          TOTALBETS: null,
          BETTERPRICELINES: null,
          BETTERPOINTSLINES: null,
        },
        {
          CustomerID: "NICWEL2432",
          PlayerLogin: "NICWEL2432",
          AgentID: "TANTUR50  ",
          AgentLogin: "NICWEL2432",
          BETPOINTS: "145.5",
          JUICE: "-110.0",
          CLOSELINE: "147.0 -110",
          PRICE: null,
          POINTS: -1.5,
          DESCRIPTION: "Basketball #702 Kansas/UNC O 145½ -110 - For Game",
          DAILYFIGUREDATE: "2026-11-10 00:00:00.000",
          RISK: "1100",
          TOWIN: "1000",
          WINLOSE: "1000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "NCAA                ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-10 15:00:00.000",
          SuspectedBot: "Y",
          SuspectedBotType: "3",
          InetTarget: "BetsElite.com",
          TOTALBETS: null,
          BETTERPRICELINES: null,
          BETTERPOINTSLINES: null,
        },
        {
          CustomerID: "NICWEL2432",
          PlayerLogin: "NICWEL2432",
          AgentID: "TANTUR50  ",
          AgentLogin: "NICWEL2432",
          BETPOINTS: "-3.0",
          JUICE: "-110.0",
          CLOSELINE: "-3.5 -110",
          PRICE: null,
          POINTS: -0.5,
          DESCRIPTION: "Football #301 Georgia -3 -110 - For Game",
          DAILYFIGUREDATE: "2026-11-11 00:00:00.000",
          RISK: "1100",
          TOWIN: "1000",
          WINLOSE: "1100",
          WAGERSTATUS: "L",
          SPORTSUBTYPE: "College             ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-11 12:00:00.000",
          SuspectedBot: "Y",
          SuspectedBotType: "3",
          InetTarget: "BetsElite.com",
          TOTALBETS: null,
          BETTERPRICELINES: null,
          BETTERPOINTSLINES: null,
        },
        // Bot 2: CUST0001 (SuspectedBot="Y", SuspectedBotType="0" BOT/Syndicate Acct) — 1 NHL (high risk), 1 College
        {
          CustomerID: "CUST0001  ",
          PlayerLogin: "CUST0001",
          AgentID: "FATSNOBOT ",
          AgentLogin: "CUST0001",
          BETPOINTS: null,
          JUICE: "-135.0",
          CLOSELINE: "-145",
          PRICE: -10,
          POINTS: null,
          DESCRIPTION: "Hockey #51 Rangers -135 - For Game",
          DAILYFIGUREDATE: "2026-11-12 00:00:00.000",
          RISK: "13500",
          TOWIN: "10000",
          WINLOSE: "10000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "NHL                 ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-12 18:00:00.000",
          SuspectedBot: "Y",
          SuspectedBotType: "0",
          InetTarget: "betolive.com",
          TOTALBETS: null,
          BETTERPRICELINES: null,
          BETTERPOINTSLINES: null,
        },
        {
          CustomerID: "CUST0001  ",
          PlayerLogin: "CUST0001",
          AgentID: "FATSNOBOT ",
          AgentLogin: "CUST0001",
          BETPOINTS: "52.5",
          JUICE: "-110.0",
          CLOSELINE: "51.5 -110",
          PRICE: null,
          POINTS: -1,
          DESCRIPTION: "Football #305 Texas/Arkansas U 52½ -110 - For 1st Half",
          DAILYFIGUREDATE: "2026-11-12 00:00:00.000",
          RISK: "2200",
          TOWIN: "2000",
          WINLOSE: "2000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "College             ",
          PERIODNUMBER: "1",
          POSTEDDATETIME: "2026-11-12 19:00:00.000",
          SuspectedBot: "Y",
          SuspectedBotType: "0",
          InetTarget: "betolive.com",
          TOTALBETS: null,
          BETTERPRICELINES: null,
          BETTERPOINTSLINES: null,
        },
      ],
    });

    expect(cohort.suspectedBotCustomerCount).toBe(2);
    expect(cohort.byBotType).toEqual({
      "Y:3 (Sharp Player)": 1,
      "Y:0 (BOT/Syndicate Acct)": 1,
    });
    expect(cohort.totalBotWagerCount).toBe(5);
    expect(cohort.detailRowCount).toBe(5);
    expect(cohort.topSubSportByWagers).toBe("College"); // tied at 2 wagers with NCAA, College has 3300 risk vs 2200
    expect(cohort.topSubSportByCustomerReach).toBe("College"); // 2/2 bots
    expect(cohort.topSubSportByRiskCents).toBe("NHL"); // 13500 risk cents
    expect(cohort.marketTypeDistribution).toEqual({
      spread: 2,
      over: 1,
      under: 1,
      moneyline: 1,
    });
    expect(cohort.periodDistribution).toEqual({ "0": 4, "1": 1 });
    expect(cohort.customers[0]?.customerId).toBe("NICWEL2432");
    expect(cohort.customers[0]?.primarySubSport).toBe("NCAA");
    expect(cohort.customers[1]?.customerId).toBe("CUST0001");
    expect(cohort.customers[1]?.primarySubSport).toBe("NHL");
  });

  test("distinguishes reduced-juice VIP artifacts (CUST002/GX195) from true spread CLV movers (CUST04_1) and reconciles lineType 2+3 detail", async () => {
    expect(ANALYSIS_REPORT_TYPES).toEqual({
      BOOK_SUMMARY: 1,
      PLAYER_DETAIL: 2,
    });
    expect(ANALYSIS_LINE_TYPES).toEqual({
      SUMMARY_DEFAULT: 1,
      POINTS: 2,
      PRICE: 3,
    });

    const summaryRollup = summarizeReportPlayerAnalysis({
      LIST: [
        {
          CustomerID: "CUST002   ",
          PlayerLogin: "CUST002",
          AgentID: "VIPMIAMI  ",
          AgentLogin: "CUST002",
          SuspectedBot: "N",
          SuspectedBotType: "-1",
          InetTarget: "Fire22.com",
          PRICE: -3.5,
          POINTS: 0.2,
          BETTERPRICELINES: 31,
          BETTERPOINTSLINES: 5,
          TOTALBETS: 59,
          WINLOSE: "1136500",
        },
        {
          CustomerID: "CUST04_1  ",
          PlayerLogin: "CUST04",
          AgentID: "AGNT_A    ",
          AgentLogin: "CUST04",
          SuspectedBot: "N",
          SuspectedBotType: "0",
          InetTarget: "betolive.com",
          PRICE: -5.73,
          POINTS: -0.61,
          BETTERPRICELINES: 8,
          BETTERPOINTSLINES: 18,
          TOTALBETS: 37,
          WINLOSE: "-52350",
        },
      ],
    });

    const vip = summaryRollup.customers.find(
      (c) => c.customerId === "CUST002",
    )!;
    expect(vip.combinedBeatCount).toBe(36);
    expect(vip.combinedBeatRate).toBe(0.6102);
    expect(vip.likelyReducedJuiceArtifact).toBe(true);
    expect(vip.trueSpreadSharpSignal).toBe(false);
    expect(vip.unflaggedSharpSignal).toBe(false);

    const mm = summaryRollup.customers.find(
      (c) => c.customerId === "CUST04_1",
    )!;
    expect(mm.combinedBeatCount).toBe(26);
    expect(mm.combinedBeatRate).toBe(0.7027);
    expect(mm.likelyReducedJuiceArtifact).toBe(false);
    expect(mm.trueSpreadSharpSignal).toBe(true);
    expect(mm.unflaggedSharpSignal).toBe(true);

    const pointsRows = [
      {
        CustomerID: "CUST002   ",
        PlayerLogin: "CUST002",
        AgentID: "VIPMIAMI  ",
        AgentLogin: "CUST002",
        BETPOINTS: "-14.0",
        JUICE: "-105.0",
        CLOSELINE: "-13 -110",
        PRICE: null,
        POINTS: 1,
        DESCRIPTION: "Football #141 Miami FL -14 -105 - For Game",
        DAILYFIGUREDATE: "2026-10-31 00:00:00.000",
        RISK: "78750",
        TOWIN: "75000",
        WINLOSE: "78750",
        WAGERSTATUS: "L",
        SPORTSUBTYPE: "College             ",
        PERIODNUMBER: "0",
        POSTEDDATETIME: "2026-10-31 17:10:48.030",
        SuspectedBot: "N",
        SuspectedBotType: "-1",
        InetTarget: "Fire22.com",
      },
    ];
    const priceRows = [
      {
        CustomerID: "CUST002   ",
        PlayerLogin: "CUST002",
        AgentID: "VIPMIAMI  ",
        AgentLogin: "CUST002",
        BETPOINTS: "-7.0",
        JUICE: "-105.0",
        CLOSELINE: "-7 -110",
        PRICE: -5,
        POINTS: null,
        DESCRIPTION: "Football #150 Duke -7 -105 - For Game",
        DAILYFIGUREDATE: "2026-10-31 00:00:00.000",
        RISK: "78750",
        TOWIN: "75000",
        WINLOSE: "75000",
        WAGERSTATUS: "W",
        SPORTSUBTYPE: "College             ",
        PERIODNUMBER: "0",
        POSTEDDATETIME: "2026-10-31 11:22:00.000",
        SuspectedBot: "N",
        SuspectedBotType: "-1",
        InetTarget: "Fire22.com",
      },
      {
        CustomerID: "CUST002   ",
        PlayerLogin: "CUST002",
        AgentID: "VIPMIAMI  ",
        AgentLogin: "CUST002",
        BETPOINTS: "-7.0",
        JUICE: "-110.0",
        CLOSELINE: "-7 -120",
        PRICE: -10,
        POINTS: null,
        DESCRIPTION: "Football #261 Patriots -7 -110 - For 2nd Half",
        DAILYFIGUREDATE: "2026-11-01 00:00:00.000",
        RISK: "110000",
        TOWIN: "100000",
        WINLOSE: "100000",
        WAGERSTATUS: "W",
        SPORTSUBTYPE: "NBAPlayerPro        ",
        PERIODNUMBER: "2",
        POSTEDDATETIME: "2026-11-01 17:56:00.000",
        SuspectedBot: "N",
        SuspectedBotType: "-1",
        InetTarget: "Fire22.com",
      },
    ];

    const summaryRaw = {
      CustomerID: "CUST002   ",
      PlayerLogin: "CUST002",
      AgentID: "VIPMIAMI  ",
      AgentLogin: "CUST002",
      SuspectedBot: "N",
      SuspectedBotType: "-1",
      InetTarget: "Fire22.com",
      PRICE: -7.5,
      POINTS: 1,
      BETTERPRICELINES: 2,
      BETTERPOINTSLINES: 0,
      TOTALBETS: 3,
      WINLOSE: "96250",
    };

    const detail = summarizeCombinedCustomerDetail(
      pointsRows,
      priceRows,
      summaryRaw,
    );
    expect(detail.customerId).toBe("CUST002");
    expect(detail.pointsWagerCount).toBe(1);
    expect(detail.priceWagerCount).toBe(2);
    expect(detail.totalWagerCount).toBe(3);
    expect(detail.beatPointsCount).toBe(0);
    expect(detail.beatPriceCount).toBe(2);
    expect(detail.combinedBeatCount).toBe(2);
    expect(detail.playerNetCents).toBe(96250);
    expect(detail.nonGameWagerCount).toBe(1);
    expect(detail.nonGameWagerPct).toBe(33.33);
    expect(detail.oddBallWagerCount).toBe(1);
    expect(detail.oddBallWagerPct).toBe(33.33);
    expect(detail.reducedJuicePerkWagerCount).toBe(1);
    expect(detail.summaryReconciliation.allMatch).toBe(true);

    const mockDetailTransport: F402ReplayTransport = {
      label: "session-file",
      async fetch(_url, init) {
        const body = String(init.body ?? "");
        if (body.includes("lineType=2")) {
          return new Response(JSON.stringify({ LIST: pointsRows }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ LIST: priceRows }), {
          status: 200,
        });
      },
      async close() {},
    };

    const fetched = await fetchCustomerPlayerAnalysisDetail(
      mockDetailTransport,
      {
        agentID: "AGENT_BB",
        customerID: "CUST002",
        startDate: "2026-10-31",
        endDate: "2026-11-14",
        summaryRowRaw: summaryRaw,
      },
      { readSession: () => null },
    );
    expect(fetched.detail.summaryReconciliation.allMatch).toBe(true);
  });
});
