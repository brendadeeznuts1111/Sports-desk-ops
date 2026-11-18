import { describe, expect, test } from "bun:test";
import {
  buildAllCustomerDecisionRankingSystem,
  computePlainUncalibratedLimitScore,
  renderAllCustomerDecisionRankingMarkdown,
} from "./f402_customer_decision_ranking.ts";
import type { GradedWagerRawRow } from "./f402_ccc88412_decision_instrument.ts";
import type { ReportPlayerAnalysisRowRaw } from "./f402_report_player_analysis.ts";

describe("f402_customer_decision_ranking (v3.0.0)", () => {
  test("computePlainUncalibratedLimitScore returns bounded plain rubric score without curve-fitting", () => {
    const negEvScore = computePlainUncalibratedLimitScore(
      -4.76,
      0.2393,
      0.2853,
      "POWERED",
    );
    const posEvSharpScore = computePlainUncalibratedLimitScore(
      2.06,
      0.585,
      0.2853,
      "POWERED",
    );
    const underpoweredScore = computePlainUncalibratedLimitScore(
      2.06,
      0.585,
      0.2853,
      "INSUFFICIENT_EVIDENCE",
    );

    expect(negEvScore).toBeGreaterThanOrEqual(0.005);
    expect(negEvScore).toBeLessThan(0.1);
    expect(posEvSharpScore).toBeGreaterThan(0.6027);
    expect(underpoweredScore).toBeLessThan(posEvSharpScore);
  });

  test("synthetic corpus enforces exact conservation oracles, GSBUILDER batch-insert exclusion, and tier partitioning", () => {
    const summaryRows: ReportPlayerAnalysisRowRaw[] = [
      {
        AgentID: "CAKEJAKE",
        CustomerID: "JKK1099",
        PlayerLogin: "JKK1099",
        InetTarget: "vip365.com",
        SuspectedBot: "Y",
        SuspectedBotType: "0",
        TOTALBETS: 44,
        BETTERPOINTSLINES: 32,
        BETTERPRICELINES: 2,
        POINTS: -0.95,
        PRICE: -4.2,
        WINLOSE: -2797,
      },
      {
        AgentID: "FATSNOBOT",
        CustomerID: "CCC88412",
        PlayerLogin: "CCC88412",
        InetTarget: "betolive.com",
        SuspectedBot: "Y",
        SuspectedBotType: "0",
        TOTALBETS: 118,
        BETTERPOINTSLINES: 11,
        BETTERPRICELINES: 18,
        POINTS: -0.22,
        PRICE: 0.25,
        WINLOSE: 293375,
      },
      {
        AgentID: "1VIPROB",
        CustomerID: "BB7884",
        PlayerLogin: "BB7884",
        InetTarget: "Fire22.com",
        SuspectedBot: "N",
        SuspectedBotType: "-1",
        TOTALBETS: 73,
        BETTERPOINTSLINES: 4,
        BETTERPRICELINES: 42,
        POINTS: 0.1,
        PRICE: -8.5,
        WINLOSE: -11410,
      },
      {
        AgentID: "JOEY",
        CustomerID: "J4406",
        PlayerLogin: "J4406",
        InetTarget: "89Blue.com",
        SuspectedBot: "N",
        SuspectedBotType: "0",
        TOTALBETS: 50,
        BETTERPOINTSLINES: 6,
        BETTERPRICELINES: 6,
        POINTS: 0.1,
        PRICE: 1.0,
        WINLOSE: -1313,
      },
    ];

    const detailRows: ReportPlayerAnalysisRowRaw[] = [
      {
        AgentID: "FATSNOBOT",
        CustomerID: "CCC88412",
        PlayerLogin: "CCC88412",
        DESCRIPTION: "Hockey #65 Oilers -1½ +215 - For Game",
        POSTEDDATETIME: "2026-10-31 13:56:29.917",
        PERIODNUMBER: "0",
        POINTS: 0,
        PRICE: 0,
      },
      {
        AgentID: "FATSNOBOT",
        CustomerID: "CCC88412",
        PlayerLogin: "CCC88412",
        DESCRIPTION: "Hockey #65 Oilers -110 - For Game",
        POSTEDDATETIME: "2026-10-31 13:56:29.917",
        PERIODNUMBER: "0",
        POINTS: 0,
        PRICE: 0,
      },
      {
        AgentID: "FATSNOBOT",
        CustomerID: "CCC88412",
        PlayerLogin: "CCC88412",
        DESCRIPTION: "Hockey #83 Utah Mammoth -170 - For Game",
        POSTEDDATETIME: "2026-10-31 13:56:43.480",
        PERIODNUMBER: "0",
        POINTS: 0,
        PRICE: 0,
      },
    ];

    // J4406 has GSBUILDER tickets 3ms apart (which must NOT be misclassified as sub-5s Internet ticket automation)
    const gradedRows: GradedWagerRawRow[] = [
      {
        CustomerID: "J4406",
        TicketNumber: "1001",
        WagerNumber: "1",
        PlayNumber: "1",
        WagerType: "M",
        AmountWagered: "6500",
        AmountWon: "0",
        AmountLost: "6500",
        AcceptedDateTime: "2026-10-01 16:04:15.500",
        TicketWriter: "GSBUILDER",
      } as GradedWagerRawRow,
      {
        CustomerID: "J4406",
        TicketNumber: "1002",
        WagerNumber: "1",
        PlayNumber: "1",
        WagerType: "M",
        AmountWagered: "6500",
        AmountWon: "0",
        AmountLost: "6500",
        AcceptedDateTime: "2026-10-01 16:04:15.503",
        TicketWriter: "GSBUILDER",
      } as GradedWagerRawRow,
      {
        CustomerID: "J4406",
        TicketNumber: "1003",
        WagerNumber: "1",
        PlayNumber: "1",
        WagerType: "M",
        AmountWagered: "6500",
        AmountWon: "0",
        AmountLost: "6500",
        AcceptedDateTime: "2026-10-01 16:04:15.507",
        TicketWriter: "GSBUILDER",
      } as GradedWagerRawRow,
    ];

    const sys1 = buildAllCustomerDecisionRankingSystem({
      allSummaryRows: summaryRows,
      suspectedBotDetailRows: detailRows,
      gradedWagerRows: gradedRows,
    });
    const sys2 = buildAllCustomerDecisionRankingSystem({
      allSummaryRows: summaryRows,
      suspectedBotDetailRows: detailRows,
      gradedWagerRows: gradedRows,
    });

    expect(sys1.schemaVersion).toBe("3.0.0");
    expect(sys1.deterministicDigestSha256).toBe(sys2.deterministicDigestSha256);
    expect(sys1.conservationOracles.passed).toBe(true);
    expect(sys1.conservationOracles.maxAbsDiscrepancy).toBe(0);
    expect(sys1.conservationOracles.totalCustomersObserved).toBe(4);
    expect(sys1.conservationOracles.totalBetsObservedCustomerSum).toBe(285);

    const j44 = sys1.allCustomerRows.find((r) => r.playerLogin === "J4406");
    expect(j44).toBeDefined();
    expect(j44!.distinctTicketSub5SecBurstsCount).toBe(0);
    expect(j44!.systematicSignatureClass).toBe("NONE_OBSERVED");

    const ccc = sys1.ccc88412BenchmarkRow;
    expect(ccc).not.toBeNull();
    expect(ccc!.limitHeuristicScore).toBe(0.029);
    expect(ccc!.minDistinctTicketGapSeconds).toBe(13.563);
    expect(ccc!.distinctTicketSub5SecBurstsCount).toBe(0);
    expect(ccc!.recommendedAction).toBe(
      "KEEP_BOT_FLAG_ACTIVE_SYSTEMATIC_PATTERN_NEGATIVE_EV",
    );

    const md = renderAllCustomerDecisionRankingMarkdown(sys1);
    expect(md).toContain(
      "# Book-Wide Customer Decision-Instrument & Systematic Pattern Ranking (`v3.0.0`)",
    );
    expect(md).toContain("CCC88412");
  });

  test("detail and graded maps key by verbatim CustomerID, not by shared PlayerLogin", () => {
    const summaryRows: ReportPlayerAnalysisRowRaw[] = [
      {
        AgentID: "AGONE",
        CustomerID: "DUP1",
        PlayerLogin: "DUPLE",
        InetTarget: "skin1.com",
        SuspectedBot: "N",
        SuspectedBotType: "0",
        TOTALBETS: 10,
        BETTERPOINTSLINES: 2,
        BETTERPRICELINES: 2,
        POINTS: -1,
        PRICE: -2,
        WINLOSE: -100,
      },
      {
        AgentID: "AGTWO",
        CustomerID: "DUP1_1",
        PlayerLogin: "DUPLE",
        InetTarget: "skin2.com",
        SuspectedBot: "N",
        SuspectedBotType: "0",
        TOTALBETS: 2,
        BETTERPOINTSLINES: 1,
        BETTERPRICELINES: 0,
        POINTS: 0.5,
        PRICE: 0.5,
        WINLOSE: 50,
      },
    ];
    const detailRow = (
      customerId: string,
      agent: string,
      points: number,
      minute: string,
    ): ReportPlayerAnalysisRowRaw => ({
      AgentID: agent,
      CustomerID: customerId,
      PlayerLogin: "DUPLE",
      DESCRIPTION: `Hockey #${minute} Team -110 - For Game`,
      POSTEDDATETIME: `2026-10-31 13:${minute}:00.000`,
      PERIODNUMBER: "0",
      POINTS: points,
      PRICE: points,
    });
    const detailRows: ReportPlayerAnalysisRowRaw[] = [
      detailRow("DUP1", "AGONE", -1, "00"),
      detailRow("DUP1", "AGONE", -1, "01"),
      detailRow("DUP1", "AGONE", -1, "02"),
      detailRow("DUP1_1", "AGTWO", 0.5, "03"),
    ];

    const sys = buildAllCustomerDecisionRankingSystem({
      allSummaryRows: summaryRows,
      suspectedBotDetailRows: detailRows,
      gradedWagerRows: [],
    });
    const one = sys.allCustomerRows.find((r) => r.customerId === "DUP1");
    const two = sys.allCustomerRows.find((r) => r.customerId === "DUP1_1");

    // A login-keyed map pools both accounts (4 each); verbatim ids keep them separate.
    expect(one?.observedDetailWagersN).toBe(3);
    expect(two?.observedDetailWagersN).toBe(1);
    expect(one?.estimatedNetEvAfterVigPct).not.toBe(
      two?.estimatedNetEvAfterVigPct,
    );
  });
});
