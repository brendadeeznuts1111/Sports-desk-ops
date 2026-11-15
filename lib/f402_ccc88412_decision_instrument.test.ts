import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCcc88412DecisionInstrument,
  buildPreRegistrationEnvelope,
  computeBenjaminiHochbergQValues,
  computeBinomialPowerOneSided,
  computeMinimumSampleSizePower80,
  computeWagerClvEvMetrics,
  computeWilson95,
  collectNonCccHockeyEvents,
  indexSummariesByCustomerId,
  renderCcc88412DecisionInstrumentMarkdown,
  shrinkRateBetaBinomial,
  type GradedWagerRawRow,
} from "./f402_ccc88412_decision_instrument.ts";
import type { ReportPlayerAnalysisRowRaw } from "./f402_report_player_analysis.ts";
import { CCC88412_WEBLOG_NOV1_TSV } from "../scripts/generate_ccc88412_decision_instrument.ts";

describe("lib/f402_ccc88412_decision_instrument", () => {
  test("computes pre-registered cost-matrix thresholds, power sample sizes, Wilson intervals, shrinkage, and BH FDR", () => {
    const preReg = buildPreRegistrationEnvelope(0.1609, 0.1483, 0.5238);
    expect(preReg.specVersion).toBe("3.0.0");
    expect(preReg.integrityAudit.integrityClassification).toBe(
      "POST_HOC_PREREGISTERED_RETROSPECTIVE_SPLIT",
    );
    expect(preReg.integrityAudit.wasCommittedWithSignedGitTagBeforeW2).toBe(
      false,
    );
    expect(preReg.integrityAudit.executiveTableFootnote).toContain("post-hoc");
    expect(preReg.costMatrix.limit.derivedPosteriorThreshold).toBe(0.6027);
    expect(preReg.costMatrix.link.derivedPosteriorThreshold).toBe(0.7);
    expect(preReg.minimumSampleSizeClv15PctLift).toBe(42);
    expect(preReg.minimumSampleSizeWinRate15PctLift).toBe(66);
    expect(preReg.minimumSampleSizeWinRate10PctLift).toBe(152);
    expect(preReg.hypotheses).toHaveLength(7);
    expect(preReg.hypotheses.find((h) => h.id === "H7")?.hypothesisClass).toBe(
      "SYSTEMATIC_STRATEGY_SIGNATURE",
    );

    const nMin = computeMinimumSampleSizePower80(0.1483, 0.2983);
    expect(nMin).toBe(42);
    expect(
      computeBinomialPowerOneSided(54, 0.1483, 0.2983),
    ).toBeGreaterThanOrEqual(0.8);
    expect(computeBinomialPowerOneSided(22, 0.1483, 0.2983)).toBeLessThan(0.8);

    const ci = computeWilson95(7, 54);
    expect(ci.low).toBeGreaterThan(0.06);
    expect(ci.high).toBeLessThan(0.25);

    const shrunk = shrinkRateBetaBinomial(7, 54, 0.1483, 20);
    expect(shrunk).toBeGreaterThan(7 / 54);
    expect(shrunk).toBeLessThan(0.1483);

    const qs = computeBenjaminiHochbergQValues([0.01, 0.04, 0.2]);
    expect(qs).toHaveLength(3);
    expect(qs[0]!).toBeLessThanOrEqual(qs[1]!);
    expect(qs[1]!).toBeLessThanOrEqual(qs[2]!);
  });

  test("converts point-move + opposite-juice rows into negative EV% against close without summing raw points", () => {
    // Football #240 Lions -2.5 -115 vs close -3 100 (1st Half):
    // Raw F402 marks POINTS = -0.5 ("beat points"), but bettor paid -115 while close was -3 +100
    const lions1H: ReportPlayerAnalysisRowRaw = {
      CustomerID: "CCC88412",
      PlayerLogin: "CCC88412",
      AgentID: "FATSNOBOT",
      BETPOINTS: "-2.5",
      JUICE: "-115.0",
      CLOSELINE: "-3 100",
      PRICE: null,
      POINTS: -0.5,
      DESCRIPTION: "Football #240 Lions -2½ -115 - For 1st Half",
      RISK: "11500",
      TOWIN: "10000",
      WINLOSE: "11500",
      WAGERSTATUS: "L",
      SPORTSUBTYPE: "NFL",
      PERIODNUMBER: "1",
      POSTEDDATETIME: "2026-11-01 09:45:53.977",
    };
    const ev = computeWagerClvEvMetrics(lions1H);
    expect(ev.beatPoints).toBe(true);
    expect(ev.beatPrice).toBe(false);
    // Once the 15-cent juice differential (-115 vs +100) is priced against the 0.5-pt 1H spread move,
    // zero-centered CLV edge is slightly negative and post-vig net EV is strongly negative
    expect(ev.clvEdgePct).toBeLessThan(0);
    expect(ev.netEvAfterVigPct).toBeLessThan(-4);
  });

  test("verifies conservation oracles, power gates, null tests, walk-forward, and byte-identical regeneration on staging data", () => {
    const root = process.cwd();
    const allSummaryPath = resolve(
      root,
      "scratch/f402-player-analysis-all.json",
    );
    const detailPath = resolve(root, "scratch/f402-suspected-bots-detail.json");
    const bundlePath = resolve(
      root,
      "scratch/f402-suspected-bots-raw-ledger-bundle.json",
    );
    if (
      !existsSync(allSummaryPath) ||
      !existsSync(detailPath) ||
      !existsSync(bundlePath)
    ) {
      return;
    }

    const allSummaryJson = JSON.parse(readFileSync(allSummaryPath, "utf8")) as {
      LIST: ReportPlayerAnalysisRowRaw[];
    };
    const detailJson = JSON.parse(readFileSync(detailPath, "utf8")) as {
      detailRows: ReportPlayerAnalysisRowRaw[];
    };
    const bundleJson = JSON.parse(readFileSync(bundlePath, "utf8")) as {
      rawTicketLedgerForFlagged: GradedWagerRawRow[];
    };

    const inst1 = buildCcc88412DecisionInstrument({
      allSummaryRows: allSummaryJson.LIST,
      suspectedBotDetailRows: detailJson.detailRows,
      gradedWagerRows: bundleJson.rawTicketLedgerForFlagged,
      cccRawWebLogText20261101: CCC88412_WEBLOG_NOV1_TSV,
    });
    const inst2 = buildCcc88412DecisionInstrument({
      allSummaryRows: allSummaryJson.LIST,
      suspectedBotDetailRows: detailJson.detailRows,
      gradedWagerRows: bundleJson.rawTicketLedgerForFlagged,
      cccRawWebLogText20261101: CCC88412_WEBLOG_NOV1_TSV,
    });

    // 1. Conservation Oracles
    expect(inst1.conservationOracles.passed).toBe(true);
    expect(inst1.conservationOracles.totalBetsObservedSportPeriodSum).toBe(118);
    expect(inst1.conservationOracles.totalBetsObservedPeriodSum).toBe(118);
    expect(inst1.conservationOracles.totalBetsObservedWindowSum).toBe(118);
    expect(inst1.conservationOracles.totalNetUsdObservedSportPeriodSum).toBe(
      2933.75,
    );
    expect(inst1.conservationOracles.totalNetUsdObservedPeriodSum).toBe(
      2933.75,
    );
    expect(inst1.conservationOracles.totalNetUsdObservedWindowSum).toBe(
      2933.75,
    );
    expect(inst1.conservationOracles.totalRiskUsdObserved).toBe(18630.0);
    expect(inst1.conservationOracles.totalToWinUsdObserved).toBe(18303.75);
    expect(inst1.conservationOracles.totalWonUsdObserved).toBe(10203.75);
    expect(inst1.conservationOracles.totalLostUsdObserved).toBe(7270.0);
    expect(inst1.conservationOracles.wonMinusLostReconciledUsd).toBe(2933.75);
    expect(inst1.conservationOracles.maxAbsDiscrepancyUsd).toBe(0);

    // 2. Power gates & corrected union P(A U B) = p1 + p2 - p1*p2
    const nhlRow = inst1.segmentTable.find((r) => r.segmentId === "NHL:Game")!;
    expect(nhlRow.n).toBe(54);
    expect(nhlRow.powerStatus).toBe("POWERED");
    expect(nhlRow.beatPointsRateP1Raw).toBe(0);
    expect(nhlRow.beatPriceRateP2Raw).toBeCloseTo(7 / 54, 3);
    expect(nhlRow.correctedUnionRateRaw).toBeCloseTo(7 / 54, 3);

    const p2Row = inst1.segmentTable.find((r) => r.segmentId === "Period:2H")!;
    expect(p2Row.n).toBe(22);
    expect(p2Row.powerStatus).toBe("INSUFFICIENT_EVIDENCE");
    const expectedUnion2H =
      p2Row.beatPointsRateP1Raw +
      p2Row.beatPriceRateP2Raw -
      p2Row.beatPointsRateP1Raw * p2Row.beatPriceRateP2Raw;
    expect(p2Row.correctedUnionRateRaw).toBeCloseTo(expectedUnion2H, 3);

    // 3. Coordination Branch B Null Test
    expect(inst1.coordinationAnalysis.leadershipClaimFalsified).toBe(true);
    expect(
      inst1.coordinationAnalysis.branchBNullTestCccAbsent
        .total2hFootballGamesBetByAym,
    ).toBe(33);
    expect(
      inst1.coordinationAnalysis.branchBNullTestCccAbsent
        .aym2hGamesWithCccAbsent,
    ).toBe(25);
    expect(
      inst1.coordinationAnalysis.branchBNullTestCccAbsent
        .aym2hGamesWithCccPresent,
    ).toBe(8);
    expect(
      inst1.coordinationAnalysis.branchBNullTestCccAbsent
        .aym2hAbsentMultiAccountBurstCount,
    ).toBe(18);

    // 4. BOT BLOCK LINE ST TTL-expiry vs price-chase
    expect(inst1.botBlockAudit.totalBotBlockEventsN).toBe(1);
    expect(inst1.botBlockAudit.powerStatus).toBe("INSUFFICIENT_EVIDENCE");
    expect(inst1.botBlockAudit.events[0]?.classification).toBe("TTL_EXPIRY");
    expect(inst1.botBlockAudit.events[0]?.deltaPoints).toBe(0);
    expect(inst1.botBlockAudit.events[0]?.deltaPrice).toBe(0);

    // 5. Retrospective temporal split & W2 null-denominator recall
    expect(inst1.walkForwardValidation.splitIntegrityStatus).toBe(
      "POST_HOC_RETROSPECTIVE_TEMPORAL_SPLIT_NOT_FIREWALLED_WALK_FORWARD",
    );
    expect(inst1.walkForwardValidation.windows.w0PriorOct.n).toBe(26);
    expect(inst1.walkForwardValidation.windows.w0PriorOct.netUsd).toBe(-582.5);
    expect(inst1.walkForwardValidation.windows.w1Fit.n).toBe(69);
    expect(inst1.walkForwardValidation.windows.w2HeldOut.n).toBe(49);
    expect(
      inst1.walkForwardValidation.alertingSpecOutOfSample
        .w2OutOfSamplePrecision,
    ).toBe(0);
    expect(
      inst1.walkForwardValidation.alertingSpecOutOfSample.w2AymanTotal2hWagers,
    ).toBe(0);
    expect(
      inst1.walkForwardValidation.alertingSpecOutOfSample.w2OutOfSampleRecall,
    ).toBeNull();

    // 6. H7 Systematic Strategy Signature Test, Log-Level Timing, NHL Sub-Breakdown, Correlated Variance & Cost Sensitivity
    expect(inst1.automationSignatureTestH7.verdict).toBe("SUPPORTED");
    expect(inst1.automationSignatureTestH7.signatureClassification).toBe(
      "SUPPORTED_SYSTEMATIC_STRATEGY_SIGNATURE",
    );
    expect(inst1.automationSignatureTestH7.automationInferenceStatus).toBe(
      "CONSISTENT_WITH_NOT_PROVEN_BY_SAME_TICKET_DATA",
    );
    expect(
      inst1.automationSignatureTestH7.distinctTicketTimingAudit
        .minInterTicketGapSeconds,
    ).toBeCloseTo(13.563, 3);
    expect(
      inst1.automationSignatureTestH7.distinctTicketTimingAudit
        .sub10SecondDistinctTicketTransitionsCount,
    ).toBe(0);
    expect(
      inst1.automationSignatureTestH7.baselineFlagCompositionAudit
        .baselinePairAccounts,
    ).toHaveLength(3);
    expect(inst1.automationSignatureTestH7.powerStatus).toBe("POWERED");
    expect(inst1.automationSignatureTestH7.cccSameSecondDualTicketPairsK).toBe(
      11,
    );
    expect(inst1.automationSignatureTestH7.cccNhlDistinctEventsN).toBe(43);
    expect(
      inst1.automationSignatureTestH7.rateLiftMultipleOverBookBaseline,
    ).toBeGreaterThan(50);
    expect(
      inst1.automationSignatureTestH7.oneSidedBinomialPValueVsBookBaseline,
    ).toBeLessThan(1e-12);

    expect(inst1.nhlMarketSubBreakdown.moneylineWagersN).toBe(21);
    expect(inst1.nhlMarketSubBreakdown.pucklineWagersN).toBe(15);
    expect(inst1.nhlMarketSubBreakdown.totalOuwagersN).toBe(18);
    expect(inst1.nhlMarketSubBreakdown.pointBearingNhlWagersN).toBe(33);
    expect(inst1.nhlMarketSubBreakdown.pointBearingPowerStatus).toBe(
      "INSUFFICIENT_EVIDENCE",
    );
    expect(inst1.nhlMarketSubBreakdown.pointBearingBeatPointsCount).toBe(0);
    expect(
      inst1.nhlMarketSubBreakdown
        .pointBearingZeroBeatExactLeftTailProbVsBookPrior,
    ).toBeCloseTo(0.0031, 3);

    expect(inst1.nhlVarianceDecomposition.correlatedPairSdUsd).toBeGreaterThan(
      inst1.nhlVarianceDecomposition.independentLegSdUsd,
    );
    expect(inst1.nhlVarianceDecomposition.correlatedPairZScore).toBeCloseTo(
      1.27,
      2,
    );

    expect(
      inst1.decisionScorecard.costMatrixSensitivity.timeHorizonAudit
        .baselineHorizonDays,
    ).toBe(36);
    expect(
      inst1.decisionScorecard.costMatrixSensitivity.timeHorizonAudit
        .flipFrontier6MonthMatchedUsd,
    ).toBeCloseTo(216.55, 1);
    expect(
      inst1.decisionScorecard.costMatrixSensitivity.limitFlipFrontier
        .maxCFpToFlipAtBaselineCFnUsd,
    ).toBeCloseTo(43.31, 1);
    expect(
      inst1.decisionScorecard.costMatrixSensitivity.linkFlipFrontier
        .maxCFpToFlipAtBaselineCFnUsd,
    ).toBeCloseTo(204.55, 1);
    expect(
      inst1.empiricalBayesSensitivity.every((r) => !r.verdictFlipsAcrossKappa),
    ).toBe(true);
    expect(inst1.decisionScorecard.monitorOperationalTriggers).toHaveLength(4);
    expect(
      inst1.decisionScorecard.v1ToV3ProseReconciliationAudit
        .proseVsTableDiscrepanciesInV3,
    ).toBe(0);

    // 7. Independent blind re-analysis & final decision
    expect(inst1.independentBlindReAnalysis.exactVerdictAgreement).toBe(true);
    expect(inst1.decisionScorecard.recommendedAction).toBe("MONITOR");
    expect(inst1.decisionScorecard.botFlagClassificationDecision).toBe(
      "KEEP_BOT_FLAG_ACTIVE_SYSTEMATIC_PATTERN_NEGATIVE_EV",
    );

    // 8. Byte-identical deterministic regeneration
    expect(inst1.deterministicDigestSha256).toBe(
      inst2.deterministicDigestSha256,
    );
    const md1 = renderCcc88412DecisionInstrumentMarkdown(inst1);
    const md2 = renderCcc88412DecisionInstrumentMarkdown(inst2);
    const sha1 = createHash("sha256").update(md1).digest("hex");
    const sha2 = createHash("sha256").update(md2).digest("hex");
    expect(sha1).toBe(sha2);
  });

  test("H7 event corpus excludes CCC88412 and counts same-ticket M+S pairs", () => {
    const rows = [
      {
        CustomerID: "CCC88412",
        TicketNumber: "1",
        Description: "Hockey #10 A -110 - For Game",
        WagerType: "M",
      },
      {
        CustomerID: "CCC88412",
        TicketNumber: "1",
        Description: "Hockey #10 B -110 - For Game",
        WagerType: "S",
      },
      {
        CustomerID: "X1",
        TicketNumber: "2",
        Description: "Hockey #11 C -110 - For Game",
        WagerType: "M",
      },
      {
        CustomerID: "X1",
        TicketNumber: "2",
        Description: "Hockey #11 D -110 - For Game",
        WagerType: "S",
      },
      {
        CustomerID: "X2",
        TicketNumber: "3",
        Description: "Hockey #12 E -110 - For Game",
        WagerType: "M",
      },
      {
        CustomerID: "X3",
        TicketNumber: "4",
        Description: "Football #1 F -110 - For Game",
        WagerType: "M",
      },
    ] as const satisfies readonly GradedWagerRawRow[];

    const corpus = collectNonCccHockeyEvents(rows);
    // CCC88412 is a Hockey account but never an event in its own baseline.
    expect(corpus.accounts.has("CCC88412")).toBe(true);
    expect(corpus.byTicketRotation.size).toBe(2);
    expect(corpus.sameTicketPairsK).toBe(1);
  });

  test("H7 non-CCC Hockey counts match the pinned corpus (2,519 events, 12 pairs)", () => {
    // CI-skipped by design: the corpus is gitignored. A committed fixture cannot reproduce the
    // 2,519-event number; it can only exercise the counting rule, which the fixture test above
    // does in CI. Run locally with `scratch/graded/` staged to assert the number itself.
    const root = process.cwd();
    const allSummaryPath = resolve(
      root,
      "scratch/f402-player-analysis-all.json",
    );
    const detailPath = resolve(root, "scratch/f402-suspected-bots-detail.json");
    const octPath = resolve(root, "scratch/graded/graded-oct-window.json");
    const todayPath = resolve(root, "scratch/graded/graded-today.json");
    if (
      !existsSync(allSummaryPath) ||
      !existsSync(detailPath) ||
      !existsSync(octPath) ||
      !existsSync(todayPath)
    ) {
      return;
    }
    const graded = [
      ...(JSON.parse(readFileSync(octPath, "utf8")) as GradedWagerRawRow[]),
      ...(JSON.parse(readFileSync(todayPath, "utf8")) as GradedWagerRawRow[]),
    ];
    const inst = buildCcc88412DecisionInstrument({
      allSummaryRows: (
        JSON.parse(readFileSync(allSummaryPath, "utf8")) as {
          LIST: ReportPlayerAnalysisRowRaw[];
        }
      ).LIST,
      suspectedBotDetailRows: (
        JSON.parse(readFileSync(detailPath, "utf8")) as {
          detailRows: ReportPlayerAnalysisRowRaw[];
        }
      ).detailRows,
      gradedWagerRows: graded,
      cccRawWebLogText20261101: CCC88412_WEBLOG_NOV1_TSV,
    });
    // `nonCccEventsN` excludes CCC88412 and the comment names its value, so a change to the
    // exclusion or the corpus must move the comment and these assertions together.
    expect(
      inst.automationSignatureTestH7.fullGradedCorpusNonCccHockeyEventsN,
    ).toBe(2519);
    expect(
      inst.automationSignatureTestH7.fullGradedCorpusNonCccSameTicketPairsK,
    ).toBe(12);
  });

  test("H7 summary index keys by verbatim customerId, not by shared PlayerLogin", () => {
    const rows = [
      {
        CustomerID: "A119",
        PlayerLogin: "A119",
        AgentID: "ADKINSON",
        InetTarget: "FiresideSports.com",
      },
      {
        CustomerID: "A119_1",
        PlayerLogin: "A119",
        AgentID: "JKN",
        InetTarget: "vip365.com",
      },
      {
        CustomerID: "CC103.",
        PlayerLogin: "CC103",
        AgentID: "DOTCO",
        InetTarget: "betolive.com",
      },
    ] as const satisfies readonly ReportPlayerAnalysisRowRaw[];

    const index = indexSummariesByCustomerId(rows);
    expect([...index.keys()]).toEqual(["A119", "A119_1", "CC103."]);
    expect(index.get("A119")?.AgentID).toBe("ADKINSON");
    expect(index.get("A119_1")?.AgentID).toBe("JKN");
    expect(index.get("A119_1")?.InetTarget).toBe("vip365.com");
    expect(index.get("CC103.")?.AgentID).toBe("DOTCO");
    // A trailing-dot id keeps its dot; the bare login is not a key.
    expect(index.get("CC103")).toBeUndefined();

    // The login-keyed shape cannot represent both A119 records: one silently wins.
    const byLogin = new Map<string, ReportPlayerAnalysisRowRaw>();
    for (const row of rows) {
      byLogin.set(String(row.PlayerLogin ?? "").trim(), row);
    }
    expect(byLogin.size).toBe(2);
    expect(byLogin.get("A119")?.CustomerID).toBe("A119_1");
  });
});
