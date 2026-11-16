import { describe, expect, test } from "bun:test";

import {
  classifySuspectedBot,
  computeDailyFigureActualBalance,
  extractBuyoutTicketNumber,
  normalizeReportPlayerAnalysisRow,
  normalizeTransactionListRow,
  parseManagerHeaderHtml,
  parseReportPlayerAnalysisEnvelope,
  parseTransactionListEnvelope,
  parseTransactionPlayerDesktopHtml,
  reconstructReportGetTransactions,
  resolveDeletedTransactionActorDisplay,
  resolvePlayerAccountState,
  resolvePresetParamAgents,
  resolveWagersByFigureDateGradedMode,
  rollupTransactionListToPerformanceDays,
  simulateFigureDateMode3DivisorBug,
  simulateJhxlsxSingleCommaParse,
  simulatePlayerInfoPreSetTransaction,
  simulateSecurityAuthenticate,
  simulateWagerPlayerModule,
  summarizeReportPlayerAnalysis,
  summarizeTransactionList,
} from "./f402_transaction_list.ts";

const SAMPLE_ENVELOPE = {
  LIST: [
    {
      DocumentNumber: 1076219808,
      TranCode: "D",
      TranType: "L",
      Amount: 550000,
      Description: "Wager Loss",
      TranDateTime: "2026-11-07 15:56:10.280",
      HoldAmount: 0,
      GradeNum: 807476193,
      EnteredBy: "Internet",
      Balance: -5650000,
    },
    {
      DocumentNumber: 1076323291,
      TranCode: "C",
      TranType: "W",
      Amount: 1000000,
      Description: "Wager Won",
      TranDateTime: "2026-11-07 18:53:55.363",
      HoldAmount: 0,
      GradeNum: 807527592,
      EnteredBy: "Internet",
      Balance: -4650000,
    },
    {
      DocumentNumber: 1076523580,
      TranCode: "C",
      TranType: "W",
      Amount: 1000000,
      Description: "Wager Won",
      TranDateTime: "2026-11-07 22:27:35.373",
      HoldAmount: 0,
      GradeNum: 807661606,
      EnteredBy: "Internet",
      Balance: -3650000,
    },
    {
      DocumentNumber: 1076535933,
      TranCode: "D",
      TranType: "L",
      Amount: 1000000,
      Description: "Wager Loss",
      TranDateTime: "2026-11-07 22:45:44.357",
      HoldAmount: 0,
      GradeNum: 807671197,
      EnteredBy: "Internet",
      Balance: -4650000,
    },
    {
      DocumentNumber: 1076535934,
      TranCode: "D",
      TranType: "L",
      Amount: 500000,
      Description: "Wager Loss",
      TranDateTime: "2026-11-07 22:45:44.357",
      HoldAmount: 0,
      GradeNum: 807671767,
      EnteredBy: "Internet",
      Balance: -5150000,
    },
    {
      DocumentNumber: 1076959253,
      TranCode: "C",
      TranType: "W",
      Amount: 300000,
      Description: "Wager Won",
      TranDateTime: "2026-11-08 16:08:11.313",
      HoldAmount: 0,
      GradeNum: 807911264,
      EnteredBy: "Internet",
      Balance: -4850000,
    },
    {
      DocumentNumber: 1077191146,
      TranCode: "D",
      TranType: "L",
      Amount: 2060000,
      Description: "Wager Loss",
      TranDateTime: "2026-11-08 19:29:49.113",
      HoldAmount: 0,
      GradeNum: 808107612,
      EnteredBy: "Internet",
      Balance: -6910000,
    },
    {
      DocumentNumber: 1077213303,
      TranCode: "D",
      TranType: "L",
      Amount: 500000,
      Description: "Wager Loss",
      TranDateTime: "2026-11-08 19:43:51.107",
      HoldAmount: 0,
      GradeNum: 808126129,
      EnteredBy: "Internet",
      Balance: -7410000,
    },
    {
      DocumentNumber: 1077363707,
      TranCode: "C",
      TranType: "W",
      Amount: 500000,
      Description: "Wager Won",
      TranDateTime: "2026-11-08 23:41:03.000",
      HoldAmount: 0,
      GradeNum: 808201267,
      EnteredBy: "Internet",
      Balance: -6910000,
    },
    {
      DocumentNumber: 1077598039,
      TranCode: "C",
      TranType: "E",
      Amount: 6910000,
      Description: "Customer Deposit",
      TranDateTime: "2026-11-09 18:39:06.600",
      HoldAmount: 0,
      GradeNum: null,
      EnteredBy: "Internet - NOLAROSE  ",
      Balance: 0,
    },
    {
      DocumentNumber: 1077695370,
      TranCode: "D",
      TranType: "L",
      Amount: 525000,
      Description: "Wager Loss",
      TranDateTime: "2026-11-09 21:53:03.353",
      HoldAmount: 0,
      GradeNum: 808279581,
      EnteredBy: "Internet",
      Balance: -525000,
    },
    {
      DocumentNumber: 1078135680,
      TranCode: "C",
      TranType: "W",
      Amount: 1000000,
      Description: "Wager Won",
      TranDateTime: "2026-11-10 22:37:54.970",
      HoldAmount: 0,
      GradeNum: 808438132,
      EnteredBy: "Internet",
      Balance: 475000,
    },
    {
      DocumentNumber: 1078454665,
      TranCode: "C",
      TranType: "W",
      Amount: 1000000,
      Description: "Wager Won",
      TranDateTime: "2026-11-11 21:40:48.820",
      HoldAmount: 0,
      GradeNum: 808524898,
      EnteredBy: "Internet",
      Balance: 1475000,
    },
    {
      DocumentNumber: 1078502577,
      TranCode: "D",
      TranType: "L",
      Amount: 550000,
      Description: "Wager Loss",
      TranDateTime: "2026-11-11 22:52:38.050",
      HoldAmount: 0,
      GradeNum: 808556077,
      EnteredBy: "Internet",
      Balance: 925000,
    },
    {
      DocumentNumber: 1078805719,
      TranCode: "D",
      TranType: "L",
      Amount: 500000,
      Description: "Wager Loss",
      TranDateTime: "2026-11-12 21:35:33.473",
      HoldAmount: 0,
      GradeNum: 808641035,
      EnteredBy: "Internet",
      Balance: 425000,
    },
    {
      DocumentNumber: 1078823322,
      TranCode: "C",
      TranType: "W",
      Amount: 500000,
      Description: "Wager Won",
      TranDateTime: "2026-11-12 21:52:33.970",
      HoldAmount: 0,
      GradeNum: 808652814,
      EnteredBy: "Internet",
      Balance: 925000,
    },
    {
      DocumentNumber: 1078924315,
      TranCode: "C",
      TranType: "W",
      Amount: 500000,
      Description: "Wager Won",
      TranDateTime: "2026-11-12 23:54:05.667",
      HoldAmount: 0,
      GradeNum: 808717051,
      EnteredBy: "Internet",
      Balance: 1425000,
    },
    {
      DocumentNumber: 1079183113,
      TranCode: "C",
      TranType: "W",
      Amount: 100000,
      Description: "Wager Won",
      TranDateTime: "2026-11-13 21:49:37.430",
      HoldAmount: 0,
      GradeNum: 808775952,
      EnteredBy: "Internet",
      Balance: 1525000,
    },
    {
      DocumentNumber: 1079203414,
      TranCode: "D",
      TranType: "L",
      Amount: 1100000,
      Description: "Wager Loss",
      TranDateTime: "2026-11-13 22:31:28.030",
      HoldAmount: 0,
      GradeNum: 808784284,
      EnteredBy: "Internet",
      Balance: 425000,
    },
    {
      DocumentNumber: 1079220426,
      TranCode: "D",
      TranType: "L",
      Amount: 550000,
      Description: "Wager Loss",
      TranDateTime: "2026-11-13 22:46:50.887",
      HoldAmount: 0,
      GradeNum: 808796243,
      EnteredBy: "Internet",
      Balance: -125000,
    },
    {
      DocumentNumber: 1079257364,
      TranCode: "C",
      TranType: "W",
      Amount: 500000,
      Description: "Wager Won",
      TranDateTime: "2026-11-13 23:56:04.507",
      HoldAmount: 0,
      GradeNum: 808816128,
      EnteredBy: "Internet",
      Balance: 375000,
    },
    {
      DocumentNumber: 1079264914,
      TranCode: "C",
      TranType: "W",
      Amount: 500000,
      Description: "Wager Won",
      TranDateTime: "2026-11-14 00:05:49.320",
      HoldAmount: 0,
      GradeNum: 808818038,
      EnteredBy: "Internet",
      Balance: 875000,
    },
    {
      DocumentNumber: 1079324876,
      TranCode: "C",
      TranType: "W",
      Amount: 500000,
      Description: "Wager Won",
      TranDateTime: "2026-11-14 01:54:01.800",
      HoldAmount: 0,
      GradeNum: 808858287,
      EnteredBy: "Internet",
      Balance: 1375000,
    },
    {
      DocumentNumber: 1079469498,
      TranCode: "C",
      TranType: "W",
      Amount: 500000,
      Description: "Wager Won",
      TranDateTime: "2026-11-14 13:37:53.647",
      HoldAmount: 0,
      GradeNum: 808880496,
      EnteredBy: "Internet",
      Balance: 1875000,
    },
    {
      DocumentNumber: 1079552847,
      TranCode: "C",
      TranType: "W",
      Amount: 500000,
      Description: "Wager Won",
      TranDateTime: "2026-11-14 15:31:23.917",
      HoldAmount: 0,
      GradeNum: 808918190,
      EnteredBy: "Internet",
      Balance: 2375000,
    },
    {
      DocumentNumber: 1079553239,
      TranCode: "C",
      TranType: "W",
      Amount: 1500000,
      Description: "Wager Won",
      TranDateTime: "2026-11-14 15:31:23.917",
      HoldAmount: 0,
      GradeNum: 808918229,
      EnteredBy: "NOLAROSE",
      Balance: 3875000,
    },
    {
      DocumentNumber: 1079587053,
      TranCode: "D",
      TranType: "L",
      Amount: 550000,
      Description: "Wager Loss",
      TranDateTime: "2026-11-14 15:46:41.823",
      HoldAmount: 0,
      GradeNum: 808942220,
      EnteredBy: "Internet",
      Balance: 3325000,
    },
  ],
  SL: "OK",
};

describe("f402_transaction_list", () => {
  test("parses, conserves running balance, and detects same-ms settlement clusters across 27 live rows", () => {
    const envelope = parseTransactionListEnvelope(SAMPLE_ENVELOPE);
    const summary = summarizeTransactionList(envelope);
    expect(summary.rowCount).toBe(27);
    expect(summary.sl).toBe("OK");
    expect(summary.openingPriorBalanceCents).toBe(-5100000);
    expect(summary.closingBalanceCents).toBe(3325000);
    expect(summary.conserved).toBe(true);
    expect(summary.driftCount).toBe(0);
    expect(summary.byTranType).toEqual({
      L: { count: 11, totalCents: 8385000 },
      W: { count: 15, totalCents: 9900000 },
      E: { count: 1, totalCents: 6910000 },
    });
    expect(summary.enteredByCounts).toEqual({
      Internet: 25,
      "Internet - NOLAROSE": 1,
      NOLAROSE: 1,
    });
    expect(summary.sameTimestampClusters).toEqual([
      {
        tranDateTime: "2026-11-07 22:45:44.357",
        documentNumbers: [1076535933, 1076535934],
        gradeNums: [807671197, 807671767],
        enteredByList: ["Internet", "Internet"],
        mixedActors: false,
        netSignedCents: -1500000,
      },
      {
        tranDateTime: "2026-11-14 15:31:23.917",
        documentNumbers: [1079552847, 1079553239],
        gradeNums: [808918190, 808918229],
        enteredByList: ["Internet", "NOLAROSE"],
        mixedActors: true,
        netSignedCents: 2000000,
      },
    ]);
  });

  test("normalizes cent scaling, clearSpaces, UI rollback mutation, and delete/date guards", () => {
    const deposit = normalizeTransactionListRow(SAMPLE_ENVELOPE.LIST[9]!);
    expect(deposit.enteredBy).toBe("Internet - NOLAROSE");
    expect(deposit.clearSpacesEnterBy).toBe("Internet-NOLAROSE");
    expect(deposit.isFigureDateLockedOnInsert).toBe(true);
    expect(deposit.isDeletable).toBe(true);

    const rollback = normalizeTransactionListRow({
      DocumentNumber: 999,
      TranCode: "C",
      TranType: "C",
      Amount: 25000,
      Description: "Deleted Wager Rollback #123",
      TranDateTime: "2026-11-14 10:00:00.000",
      EnteredBy: " system ",
      Balance: 25000,
    });
    expect(rollback.amountUsd).toBe(250);
    expect(rollback.rawTranType).toBe("C");
    expect(rollback.effectiveUiTranType).toBe("W");
    expect(rollback.uiTranTypeMutated).toBe(true);
    // Because the UI mutates TranType to "W" in data-param, deleteTransaction blocks it!
    expect(rollback.isDeletable).toBe(false);
    expect(rollback.isFigureDateLockedOnInsert).toBe(false);

    const liveDealer = normalizeTransactionListRow({
      DocumentNumber: 1000,
      TranCode: "D",
      TranType: "E",
      Amount: 10000,
      Description: "Live Dealer",
      TranDateTime: "2026-11-14 10:05:00.000",
      EnteredBy: "GGL-LIVEDEALER",
      Balance: 15000,
    });
    expect(liveDealer.signedAmountCents).toBe(-10000);
    expect(liveDealer.isDeletable).toBe(false);
  });

  test('parses desktop HTML tbody with <span class="NaN">NaN</span> sentinels', () => {
    const html = `<tbody><tr class="cl-odd" data-group="W" data-param="{&quot;docNum&quot;:753975008,&quot;tranType&quot;:&quot;W&quot;,&quot;enterBy&quot;:&quot;Internet&quot;}" style="display: table-row;"> <td style="width:150px;">07-12-2024 09:23 pm</td><td>Wager Won</td><td><span class="7,500.00">7,500.00</span></td><td><span class="NaN">NaN</span></td><td>7,500.00</td> </tr><tr class="" data-group="L" data-param="{&quot;docNum&quot;:753990471,&quot;tranType&quot;:&quot;L&quot;,&quot;enterBy&quot;:&quot;Internet&quot;}" style="display: table-row;"> <td style="width:150px;">07-12-2024 09:42 pm</td><td>Wager Loss</td><td><span class="NaN">NaN</span></td><td><span class="3,390.00">3,390.00</span></td><td>4,110.00</td> </tr></tbody>`;
    const rows = parseTransactionPlayerDesktopHtml(html);
    expect(rows).toEqual([
      {
        dataGroup: "W",
        docNum: 753975008,
        tranType: "W",
        enterBy: "Internet",
        dateText: "07-12-2024 09:23 pm",
        description: "Wager Won",
        creditCents: 750000,
        debitCents: null,
        signedAmountCents: 750000,
        balanceCents: 750000,
      },
      {
        dataGroup: "L",
        docNum: 753990471,
        tranType: "L",
        enterBy: "Internet",
        dateText: "07-12-2024 09:42 pm",
        description: "Wager Loss",
        creditCents: null,
        debitCents: 339000,
        signedAmountCents: -339000,
        balanceCents: 411000,
      },
    ]);
  });

  test("proves Jhxlsx.export single-comma bug, presetParam swap, and Cust Serv masking", () => {
    expect(simulateJhxlsxSingleCommaParse("7,500.00")).toEqual({
      trueValueUsd: 7500,
      exportedValueUsd: 7500,
      truncatedBySecondComma: false,
    });
    expect(simulateJhxlsxSingleCommaParse("1,234,567.89")).toEqual({
      trueValueUsd: 1234567.89,
      exportedValueUsd: 1234,
      truncatedBySecondComma: true,
    });

    expect(
      resolvePresetParamAgents({
        masterId: "AGENT_BB",
        agentType: "M",
        dataAgentId: "SUBAGENT1",
      }),
    ).toEqual({
      injected: true,
      wireAgentId: "AGENT_BB",
      wireAgentOwner: "SUBAGENT1",
      swappedCallerAgentIntoOwner: true,
    });

    expect(
      resolveDeletedTransactionActorDisplay({
        lastUpdateLoginId: "ROOT_ADMIN ",
        masterId: "AGENT_BB",
        knownAgentIds: ["AGENT_BB", "SUBAGENT1"],
      }),
    ).toEqual({
      displayLabel: "Cust Serv",
      maskedAsCustServ: true,
    });
  });

  test("proves report.js getTransactions Promo/Transfer drift, /1e3 DepWith bug, casinoDaily sign bug, and Buyout ticket extraction", () => {
    // Promo Credit (B, +$50.00) shifts openingBalanceCents in Pass 1 via TranCode="C",
    // but is missing from Pass 2 switch(h.TranType), leaving closingBalanceCents -$50.00 off!
    const recon = reconstructReportGetTransactions({
      currentBalanceCents: 15000,
      rows: [
        {
          TranCode: "C",
          TranType: "E",
          Amount: 10000,
          TranDateTime: "2026-11-10 10:00:00.0",
        },
        {
          TranCode: "C",
          TranType: "W",
          Amount: 2000,
          TranDateTime: "2026-11-10 11:00:00.0",
        },
        {
          TranCode: "C",
          TranType: "B",
          Amount: 5000,
          TranDateTime: "2026-11-10 12:00:00.0",
        },
      ],
    });
    expect(recon.openingBalanceCents).toBe(-2000);
    expect(recon.closingBalanceCents).toBe(10000);
    expect(recon.closingBalanceDriftCents).toBe(-5000);
    expect(recon.unhandledTranTypeCount).toBe(1);
    // W row (index 1) is buffered to the bottom after non-wager rows (0 and 2)
    expect(recon.domOrderRows.map((r) => r.index)).toEqual([0, 2, 1]);

    // Clicking DepWith in getDailyFigures runs getWagersByFigureDate with graded=undefined -> m=3,
    // which divides Amount by 1e3 instead of 100 (10x understatement)
    expect(simulateFigureDateMode3DivisorBug(100000, "C")).toEqual({
      trueSignedUsd: 1000,
      displayedSignedUsd: 100,
      understatedRatio: 10,
    });

    // S < 0 ? D += S : D -= S subtracts |S| for both +$250 and -$250 casinoDaily
    expect(computeDailyFigureActualBalance(1000, 25000)).toEqual({
      displayedActualBalanceUsd: 750,
      effectiveDeltaUsd: -250,
    });
    expect(computeDailyFigureActualBalance(1000, -25000)).toEqual({
      displayedActualBalanceUsd: 750,
      effectiveDeltaUsd: -250,
    });

    expect(extractBuyoutTicketNumber("Buyout parlay ticket 984512341")).toBe(
      "984512341",
    );

    const perfRollup = rollupTransactionListToPerformanceDays(
      parseTransactionListEnvelope(SAMPLE_ENVELOPE),
    );
    expect(perfRollup.days).toHaveLength(8);
    expect(perfRollup.totalWonCents).toBe(9900000);
    expect(perfRollup.totalLostCents).toBe(8385000);
    expect(perfRollup.totalCustomerNetCents).toBe(1515000);
    expect(perfRollup.totalNonWagerSignedCents).toBe(6910000);
    // +$15,150 wager net + $69,100 deposit = +$84,250 total balance shift (-$51,000 -> +$33,250)
    expect(perfRollup.totalBalanceDeltaCents).toBe(8425000);
  });

  test("classifies player-info SuspectedBot tiers, tri-state status, and Promo Credit/Debit preSetTransaction zero-balance bug", () => {
    expect(
      classifySuspectedBot({ suspectedBot: "Y", suspectedBotType: 1 }),
    ).toEqual({
      badgeClassSuffix: "1",
      label: "Steam Player",
      visibleInUi: true,
    });
    expect(
      classifySuspectedBot({ suspectedBot: "Y", suspectedBotType: 2 }),
    ).toEqual({
      badgeClassSuffix: "2",
      label: "Suspected RAS",
      visibleInUi: true,
    });
    expect(
      classifySuspectedBot({ suspectedBot: "Y", suspectedBotType: 3 }),
    ).toEqual({
      badgeClassSuffix: "3",
      label: "Sharp Player",
      visibleInUi: true,
    });
    expect(
      classifySuspectedBot({ suspectedBot: "Y", suspectedBotType: 4 }),
    ).toEqual({
      badgeClassSuffix: "4",
      label: "BOT/Syndicate Acct",
      visibleInUi: true,
    });

    expect(
      resolvePlayerAccountState({
        active: "Y",
        suspendAccount: "Y",
        zeroBalanceFlag: "Y",
        weeklyLimitFlag: "N",
        parlayAlwaysTrueOdds: "N",
        payTableForAllSports: "N",
        noTrueOdds: "Y",
      }),
    ).toEqual({
      status: "read-only",
      settlementMode: "Z",
      parlayOddsMode: "True Odds Minus",
    });

    expect(
      simulatePlayerInfoPreSetTransaction({
        currentBalanceCents: 500000,
        availableBalanceCents: 500000,
        tranType: "B",
        amountUsd: 100,
      }),
    ).toEqual({
      previewNewBalanceUsd: 0,
      previewNewAvailableUsd: 0,
      expectedNewBalanceUsd: 5100,
      zeroedByUnhandledPromoBug: true,
    });
  });

  test("proves help-report binary graded coercion and security.js dead Captcha gate, SavePass case mismatch, and refresh token desync", () => {
    expect(
      resolveWagersByFigureDateGradedMode({
        gradedInput: 2,
        apiPath: "/cloud/",
      }),
    ).toEqual({
      helpReportGraded: 0,
      customerReportGraded: 2,
      collapsedCasinoOrDepWithInHelpReport: true,
      rewrittenUrl: "/cloud/api/Report/getWagersByFigureDate",
    });

    const sec = simulateSecurityAuthenticate({
      rawUser: " CUST03 ",
      rawPassword: "Secret99",
      rawNewPasswordForSavePass: "Secret99",
      agTokenValue: "",
      useCaptchaFlag: "Y",
      agentType: "M",
      agentSkinOverride: "Classic",
      initialSessionToken: "jwt-initial",
      renewedTokenCode: "jwt-renewed",
    });
    expect(sec.operation).toBe("authenticateCustomer");
    expect(sec.customerID).toBe("CUST03");
    expect(sec.clientId).toBe(" CUST03 ");
    expect(sec.clientIdHasUntrimmedWhitespace).toBe(true);
    expect(sec.loginPasswordSent).toBe("SECRET99");
    expect(sec.savePassPasswordSent).toBe("Secret99");
    expect(sec.savePassCaseMismatchOnNextLogin).toBe(true);
    expect(sec.captchaGateEvaluatedTrue).toBe(false);
    expect(sec.postAuthAction).toBe("authenticate_normal_lostSession");
    expect(sec.verifySessionReturnValue).toBe(false);
    expect(sec.tokenDesyncAfterRefresh).toBe(true);
  });

  test("parses and verifies 22 live getReportPlayerAnalysis rows (CHAR padding, POINTS CLV sign convention, and cent PnL)", () => {
    const rawEnvelope = {
      LIST: [
        {
          CustomerID: "CUST04_1  ",
          PlayerLogin: "CUST04",
          AgentID: "AGNT_A    ",
          AgentLogin: "CUST04",
          BETPOINTS: "0.0",
          JUICE: "-110.0",
          CLOSELINE: "-1 -110",
          PRICE: null,
          POINTS: -1,
          DESCRIPTION: "Basketball #523 76ers PK -110 - For Game",
          DAILYFIGUREDATE: "2026-10-31 00:00:00.000",
          RISK: "11000",
          TOWIN: "10000",
          WINLOSE: "10000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "NBA                 ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-10-31 16:04:26.603",
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
          BETPOINTS: "-10.0",
          JUICE: "-110.0",
          CLOSELINE: "-12 -110",
          PRICE: null,
          POINTS: -2,
          DESCRIPTION: "Basketball #506 Celtics -10 -110 - For Game",
          DAILYFIGUREDATE: "2026-11-04 00:00:00.000",
          RISK: "11000",
          TOWIN: "10000",
          WINLOSE: "11000",
          WAGERSTATUS: "L",
          SPORTSUBTYPE: "NBA                 ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-04 12:54:42.900",
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
          BETPOINTS: "212.5",
          JUICE: "-110.0",
          CLOSELINE: "212 -110",
          PRICE: null,
          POINTS: 0.5,
          DESCRIPTION: "Basketball #507 Hornets/Nets O 212½ -110 - For Game",
          DAILYFIGUREDATE: "2026-11-04 00:00:00.000",
          RISK: "5500",
          TOWIN: "5000",
          WINLOSE: "5000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "NBA                 ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-04 15:11:43.170",
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
        },
        {
          CustomerID: "CUST04_1  ",
          PlayerLogin: "CUST04",
          AgentID: "AGNT_A    ",
          AgentLogin: "CUST04",
          BETPOINTS: "5.5",
          JUICE: "-105.0",
          CLOSELINE: "5 -110",
          PRICE: null,
          POINTS: -0.5,
          DESCRIPTION: "Basketball #529 Cavaliers +5½ -105 - For Game",
          DAILYFIGUREDATE: "2026-11-11 00:00:00.000",
          RISK: "10500",
          TOWIN: "10000",
          WINLOSE: "10000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "NBA                 ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-11 17:47:01.220",
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
          BETPOINTS: "-1.0",
          JUICE: "-110.0",
          CLOSELINE: "-1.5 -110",
          PRICE: null,
          POINTS: -0.5,
          DESCRIPTION: "Basketball #871 Wright St -1 -110 - For Game",
          DAILYFIGUREDATE: "2026-11-13 00:00:00.000",
          RISK: "1100",
          TOWIN: "1000",
          WINLOSE: "1000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "NCAA                ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-13 19:39:51.227",
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
          BETPOINTS: "236.0",
          JUICE: "-110.0",
          CLOSELINE: "235.5 -110",
          PRICE: null,
          POINTS: -0.5,
          DESCRIPTION: "Basketball #564 Cavaliers/Heat U 236 -110 - For Game",
          DAILYFIGUREDATE: "2026-11-13 00:00:00.000",
          RISK: "5500",
          TOWIN: "5000",
          WINLOSE: "5500",
          WAGERSTATUS: "L",
          SPORTSUBTYPE: "NBA                 ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-13 18:32:01.480",
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
          BETPOINTS: "216.5",
          JUICE: "-110.0",
          CLOSELINE: "217.5 -110",
          PRICE: null,
          POINTS: 1,
          DESCRIPTION: "Basketball #570 Warriors/Spurs U 216½ -110 - For Game",
          DAILYFIGUREDATE: "2026-11-13 00:00:00.000",
          RISK: "5500",
          TOWIN: "5000",
          WINLOSE: "5000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "NBA                 ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-13 20:14:25.030",
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
          BETPOINTS: "-9.5",
          JUICE: "-110.0",
          CLOSELINE: "-10 -110",
          PRICE: null,
          POINTS: -0.5,
          DESCRIPTION: "Football #173 Oklahoma St -9½ -110 - For Game",
          DAILYFIGUREDATE: "2026-10-31 00:00:00.000",
          RISK: "11000",
          TOWIN: "10000",
          WINLOSE: "11000",
          WAGERSTATUS: "L",
          SPORTSUBTYPE: "College             ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-10-31 15:14:21.957",
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
          JUICE: "-113.0",
          CLOSELINE: "-3.5 -110",
          PRICE: null,
          POINTS: -0.5,
          DESCRIPTION: "Football #240 Lions -3 -113 - For Game",
          DAILYFIGUREDATE: "2026-11-01 00:00:00.000",
          RISK: "5650",
          TOWIN: "5000",
          WINLOSE: "5000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "NFL                 ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-10-30 23:25:05.143",
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
          BETPOINTS: "-6.0",
          JUICE: "-110.0",
          CLOSELINE: "-7 100",
          PRICE: null,
          POINTS: -1,
          DESCRIPTION: "Football #302 Miami Ohio -6 -110 - For Game",
          DAILYFIGUREDATE: "2026-11-03 00:00:00.000",
          RISK: "11000",
          TOWIN: "10000",
          WINLOSE: "11000",
          WAGERSTATUS: "L",
          SPORTSUBTYPE: "College             ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-03 16:13:51.260",
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
          BETPOINTS: "45.5",
          JUICE: "-105.0",
          CLOSELINE: "45 -110",
          PRICE: null,
          POINTS: -0.5,
          DESCRIPTION: "Football #302 Buffalo/Miami Ohio U 45½ -105 - For Game",
          DAILYFIGUREDATE: "2026-11-03 00:00:00.000",
          RISK: "5250",
          TOWIN: "5000",
          WINLOSE: "5250",
          WAGERSTATUS: "L",
          SPORTSUBTYPE: "College             ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-03 16:51:48.237",
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
          BETPOINTS: "46.0",
          JUICE: "-110.0",
          CLOSELINE: "45 -110",
          PRICE: null,
          POINTS: -1,
          DESCRIPTION: "Football #302 Buffalo/Miami Ohio U 46 -110 - For Game",
          DAILYFIGUREDATE: "2026-11-03 00:00:00.000",
          RISK: "5500",
          TOWIN: "5000",
          WINLOSE: "5500",
          WAGERSTATUS: "L",
          SPORTSUBTYPE: "College             ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-03 16:44:01.137",
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
          BETPOINTS: "53.0",
          JUICE: "-110.0",
          CLOSELINE: "52.5 -110",
          PRICE: null,
          POINTS: -0.5,
          DESCRIPTION:
            "Football #310 Toledo/Sacramento St U 53 -110 - For Game",
          DAILYFIGUREDATE: "2026-11-04 00:00:00.000",
          RISK: "5500",
          TOWIN: "5000",
          WINLOSE: "5000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "College             ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-04 17:12:34.030",
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
          CLOSELINE: "-2.5 -110",
          PRICE: null,
          POINTS: 0.5,
          DESCRIPTION: "Football #308 U Mass -3 -110 - For Game",
          DAILYFIGUREDATE: "2026-11-04 00:00:00.000",
          RISK: "11000",
          TOWIN: "10000",
          WINLOSE: "11000",
          WAGERSTATUS: "L",
          SPORTSUBTYPE: "College             ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-03 21:39:37.787",
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
          BETPOINTS: "-16.5",
          JUICE: "-110.0",
          CLOSELINE: "-17 -110",
          PRICE: null,
          POINTS: -0.5,
          DESCRIPTION: "Football #416 JAX State -16½ -110 - For Game",
          DAILYFIGUREDATE: "2026-11-07 00:00:00.000",
          RISK: "11000",
          TOWIN: "10000",
          WINLOSE: "10000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "College             ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-07 11:46:45.907",
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
          BETPOINTS: "46.5",
          JUICE: "-108.0",
          CLOSELINE: "47.5 -110",
          PRICE: null,
          POINTS: -1,
          DESCRIPTION: "Football #463 Jets/Chiefs O 46½ -108 - For Game",
          DAILYFIGUREDATE: "2026-11-08 00:00:00.000",
          RISK: "3240",
          TOWIN: "3000",
          WINLOSE: "3000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "NFL                 ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-03 15:21:48.640",
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
          JUICE: "-110.0",
          CLOSELINE: "3.5 -110",
          PRICE: null,
          POINTS: -2,
          DESCRIPTION: "Football #101 Kent St +5½ -110 - For Game",
          DAILYFIGUREDATE: "2026-11-10 00:00:00.000",
          RISK: "11000",
          TOWIN: "10000",
          WINLOSE: "10000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "College             ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-10 12:05:11.730",
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
          BETPOINTS: "50.0",
          JUICE: "-110.0",
          CLOSELINE: "51 -110",
          PRICE: null,
          POINTS: -1,
          DESCRIPTION: "Football #115 Memphis/S Florida O 50 -110 - For Game",
          DAILYFIGUREDATE: "2026-11-12 00:00:00.000",
          RISK: "5500",
          TOWIN: "5000",
          WINLOSE: "5000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "College             ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-12 17:02:55.677",
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
          BETPOINTS: "20.5",
          JUICE: "100.0",
          CLOSELINE: "20 -120",
          PRICE: null,
          POINTS: 0.5,
          DESCRIPTION:
            "Football #113 Commanders/Giants O 20½ +100 - For 1st Half",
          DAILYFIGUREDATE: "2026-11-12 00:00:00.000",
          RISK: "5000",
          TOWIN: "5000",
          WINLOSE: "5000",
          WAGERSTATUS: "L",
          SPORTSUBTYPE: "NFL                 ",
          PERIODNUMBER: "1",
          POSTEDDATETIME: "2026-11-12 16:56:30.553",
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
          CLOSELINE: "53.5 -110",
          PRICE: null,
          POINTS: -1.5,
          DESCRIPTION: "Football #123 Houston/Colorado O 52 -110 - For Game",
          DAILYFIGUREDATE: "2026-11-13 00:00:00.000",
          RISK: "5500",
          TOWIN: "5000",
          WINLOSE: "5000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "College             ",
          PERIODNUMBER: "0",
          POSTEDDATETIME: "2026-11-13 19:39:36.217",
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
          BETPOINTS: "26.5",
          JUICE: "-115.0",
          CLOSELINE: "27 -115",
          PRICE: null,
          POINTS: -0.5,
          DESCRIPTION:
            "Football #123 Houston/Colorado O 26½ -115 - For 1st Half",
          DAILYFIGUREDATE: "2026-11-13 00:00:00.000",
          RISK: "5750",
          TOWIN: "5000",
          WINLOSE: "5000",
          WAGERSTATUS: "W",
          SPORTSUBTYPE: "College             ",
          PERIODNUMBER: "1",
          POSTEDDATETIME: "2026-11-13 21:24:17.403",
          SuspectedBot: "N",
          SuspectedBotType: "0",
          InetTarget: "betolive.com",
          TOTALBETS: null,
          BETTERPRICELINES: null,
          BETTERPOINTSLINES: null,
        },
      ],
    };

    const rows = parseReportPlayerAnalysisEnvelope(rawEnvelope);
    expect(rows).toHaveLength(22);

    const first = normalizeReportPlayerAnalysisRow(rows[0]!);
    expect(first.customerId).toBe("CUST04_1");
    expect(first.rawCustomerIdLength).toBe(10);
    expect(first.playerLogin).toBe("CUST04");
    expect(first.isSubAccountCustomerId).toBe(true);
    expect(first.agentId).toBe("AGNT_A");
    expect(first.rawAgentIdLength).toBe(10);
    expect(first.agentLoginEqualsPlayerLogin).toBe(true);
    expect(first.sportSubType).toBe("NBA");
    expect(first.rawSportSubTypeLength).toBe(20);
    expect(first.marketKind).toBe("SPREAD");
    expect(first.playerClvPoints).toBe(1);
    expect(first.beatClosingPoints).toBe(true);

    const summary = summarizeReportPlayerAnalysis(rows);
    expect(summary).toEqual({
      rowCount: 22,
      winCount: 13,
      lossCount: 9,
      totalRiskCents: 157490,
      totalToWinCents: 144000,
      totalWonCents: 79000,
      totalLostCents: 70750,
      totalSignedCustomerNetCents: 8250,
      positiveClvCount: 18,
      negativeClvCount: 4,
      neutralClvCount: 0,
      positiveClvRate: 18 / 22,
      totalRawPointsField: -13.5,
      totalPlayerClvPoints: 13.5,
      avgPlayerClvPoints: 13.5 / 22,
      allPointsFormulasMatch: true,
      allWinLoseInvariantsHold: true,
      advanceWagerCount: 3,
      bySportSubType: {
        NBA: 7,
        NCAA: 1,
        College: 11,
        NFL: 3,
      },
    });
  });

  test("parses Manager #header DOM (3 CHAR(10)-padded agent spans, 4 search-agents mounts, autofill honeypots, and glypth-* typos)", () => {
    const headerHtml = `<section class="header-navbar navbar navbar-with-menu navbar-fixed-top navbar-semi-dark navbar-shadow" id="header">
      <div class="navbar-wrapper">
        <div class="navbar-header">
          <ul class="nav navbar-nav">
            <li class="nav-item agent-header-h">
              <div class="component-search-panel hide">
                <div data-panel="search-agents"></div>
              </div>
              <div class="panel-information">
                <a href="#tree" class="navbar-brand nav-link t-a-c">
                  <span data-field="agent" data-action="show-hierarchy" class="hidden-md-up agent-mobile-label">AGENT_BB  </span>
                  <img alt="" src="images/throwdown.png" data-expand="images/throwdown.png" data-collapse="" class="brand-logo">
                </a>
              </div>
            </li>
          </ul>
        </div>
        <div class="navbar-container content container-fluid">
          <div class="panel-quick-menu" style="display:none;">
            <ul class="l-menu-mobile mme" style="float:left">
              <li data-action="go-home-menu" class="li-a"><i class="fa fa-home"></i></li>
              <li data-action="get-weekly-figure" data-type="heavy" class="li-b"><i class="glypth-line-chart"></i></li>
              <li data-action="get-pending" class="li-c"><i class="glypth-calendar-and-clock"></i></li>
              <li data-action="get-game-admin" class="li-d"><i class="glypth-gamese"></i></li>
              <li data-action="get-messaging" class="li-f"><i class="glypth-close-envelope"></i></li>
              <li data-action="show-search-mobile-icons" style="display: none;" class="li-g"><i class="ficon icon-search7"></i></li>
            </ul>
            <div class="nav-item nav-search search-desk">
              <div data-panel="search-agents"><div class="search-component" data-type="all"><input type="password" name="password" style="display:none"><fieldset><div class="input-group"><div class="input-group-prepend"><span class="input-group-text" id="basic-addon1"><i class="ficon icon-search7"></i></span></div><input data-search="true" type="text" autocomplete="new-password" class="form-control" placeholder="Search accounts..." aria-describedby="basic-addon1"><i class="fa fa-times close-panel hide"></i><div data-list="result"><ul></ul></div></div></fieldset></div></div>
            </div>
            <ul class="r-menu-mobile mme" style="display:none">
              <li class="hery">
                <a href="#" data-action="show-hierarchy" class="tet1">
                  <span data-field="agent">AGENT_BB  </span>
                </a>
              </li>
            </ul>
            <div class="search-panel-mobile hidden agent-header-h component-search-panel hide">
              <div class="" data-panel="search-agents"><p>Loading your customer list</p></div>
            </div>
          </div>
          <div id="navbar-mobile" class="collapse navbar-toggleable-sm">
            <div class="nav-item nav-search search-desk menu-left-version" style="display:none;">
              <div data-panel="search-agents"><div class="search-component" data-type="all"><input type="password" name="password" style="display:none"><fieldset><div class="input-group"><div class="input-group-prepend"><span class="input-group-text" id="basic-addon1"><i class="ficon icon-search7"></i></span></div><input data-search="true" type="text" autocomplete="new-password" class="form-control" placeholder="Search accounts..." aria-describedby="basic-addon1"><i class="fa fa-times close-panel hide"></i><div data-list="result"><ul></ul></div></div></fieldset></div></div>
            </div>
            <ul class="nav navbar-nav float-xs-right">
              <li class="dropdown dropdown-user nav-item">
                <a href="#" data-toggle="dropdown" data-action="show-hierarchy" class="dropdown-toggle nav-link dropdown-user-link">
                  <span data-field="agent">AGENT_BB  </span>
                </a>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>`;

    expect(parseManagerHeaderHtml(headerHtml)).toEqual({
      rawAgentTexts: ["AGENT_BB  ", "AGENT_BB  ", "AGENT_BB  "],
      trimmedAgentId: "AGENT_BB",
      rawAgentFieldLength: 10,
      jqueryTextConcatenationTrap: "AGENT_BB  AGENT_BB  AGENT_BB  ",
      searchAgentsPanelCount: 4,
      activeSearchComponentCount: 2,
      hiddenPasswordHoneypotCount: 2,
      newPasswordSearchInputCount: 2,
      duplicateBasicAddon1IdCount: 2,
      quickMenuActions: [
        "go-home-menu",
        "get-weekly-figure",
        "get-pending",
        "get-game-admin",
        "get-messaging",
        "show-search-mobile-icons",
      ],
      glypthIconTypoClasses: [
        "glypth-line-chart",
        "glypth-calendar-and-clock",
        "glypth-gamese",
        "glypth-close-envelope",
      ],
      brandLogoSrc: "images/throwdown.png",
    });
  });

  test("proves wager-player 730-day pending-thin lookback, inModule semicolon no-op bug, undefined deleteTransaction listener, and missing agentID on time change", () => {
    const firstOpen = simulateWagerPlayerModule({
      currentUiModule: "player-info",
      player: "A.B.C101",
      playerAgentId: "AGNT_A",
      managerId: "AGENT_BB",
      nowIsoDate: "2026-11-14",
      timeSelectDays: 30,
    });
    expect(firstOpen.getTriggeredRefresh).toBe(true);
    expect(firstOpen.displayedPlayerLabel).toBe("AB.C101");
    expect(firstOpen.auditLogEntries).toEqual([
      { customerID: "AGENT_BB", description: "View Section Wagers" },
      { customerID: "AGENT_BB", description: "Get Data / Wagers / Pending" },
    ]);
    expect(firstOpen.initialPendingThinArgs).toEqual({
      customerID: "A.B.C101",
      agentID: "AGNT_A",
      totals: false,
      typeReport: "wager-tab",
      date: "2024-11-14",
      sort: 5,
      typeSort: 2,
    });
    expect(firstOpen.timeChangePendingThinArgs).toEqual({
      customerID: "A.B.C101",
      agentID: undefined,
      totals: undefined,
      typeReport: "wager-tab",
      date: "2026-10-15",
      sort: 5,
      typeSort: 2,
    });
    expect(firstOpen.hasUndefinedDeleteTransactionMethodBug).toBe(true);
    expect(firstOpen.timeChangeOmitsAgentIdAndTotals).toBe(true);

    // Switching players while already in "wager-player" hits the empty `;` statement!
    const secondOpen = simulateWagerPlayerModule({
      currentUiModule: "wager-player",
      player: "CUST04_1",
      playerAgentId: "AGNT_A",
      managerId: "AGENT_BB",
      nowIsoDate: "2026-11-14",
    });
    expect(secondOpen.getTriggeredRefresh).toBe(false);
    expect(secondOpen.initialPendingThinArgs).toBeNull();
    expect(secondOpen.auditLogEntries).toEqual([]);
  });
});
