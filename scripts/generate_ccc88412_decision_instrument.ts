#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCcc88412DecisionInstrument,
  renderCcc88412DecisionInstrumentMarkdown,
  type GradedWagerRawRow,
} from "../lib/f402_ccc88412_decision_instrument.ts";
import type { ReportPlayerAnalysisRowRaw } from "../lib/f402_report_player_analysis.ts";

export const CCC88412_WEBLOG_NOV1_TSV = `Time(EST)	IP Address	Action
08:29:03 PM	156.146.132.48	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
08:09:43 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
08:09:43 PM	70.134.7.166	API LOG | Ticket: 1073746222 Risk:24000 Win:20000
08:09:43 PM	70.134.7.166	API LOG | Bet :
Football #263 Eagles 6 -120 - buying &#189; For Game
08:09:09 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
08:00:29 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
08:00:29 PM	70.134.7.166	API LOG | Ticket: 1073740218 Risk:20000 Win:24000
08:00:29 PM	70.134.7.166	API LOG | Bet :
Hockey #88 Senators/Ducks U 6&#189; +120 - For Game
07:59:45 PM	70.134.7.166	(M) Login successful (M) [ v1.0.280 | betolive.ag ]
07:59:44 PM	70.134.7.166	Login successful Token
07:41:48 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
07:37:31 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
07:27:14 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
07:27:10 PM	70.134.7.166	(M) Login successful (M) [ v1.0.280 | betolive.ag ]
07:27:10 PM	70.134.7.166	Login successful Token
06:01:14 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
06:01:14 PM	70.134.7.166	API LOG | Bet :
Football #260 Broncos -1 -115 - For 2nd Half
06:01:14 PM	70.134.7.166	API LOG | Ticket: 1073617888 Risk:17250 Win:15000
05:50:07 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
05:50:06 PM	70.134.7.166	API LOG | Bet :
Hockey #86 Oilers/Rangers U 6&#189; +100 - For Game
05:50:06 PM	70.134.7.166	API LOG | Ticket: 1073612763 Risk:20000 Win:20000
05:49:40 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
05:49:39 PM	70.134.7.166	API LOG | Bet :
Football #261 Patriots -7 -115 - For 2nd Half
05:49:39 PM	70.134.7.166	API LOG | Ticket: 1073612665 Risk:11500 Win:10000
05:49:07 PM	70.134.7.166	(M) Login successful (M) [ v1.0.280 | betolive.ag ]
05:49:06 PM	70.134.7.166	Login successful Token
05:28:30 PM	70.134.7.166	(M) Straight Lines Displayed (M) [ v1.0.280 | betolive.ag ]
05:28:30 PM	70.134.7.166	(M) Parlay Lines Displayed (M) [ v1.0.280 | betolive.ag ]
05:28:28 PM	70.134.7.166	(M) Parlay Lines Displayed (M) [ v1.0.280 | betolive.ag ]
05:28:28 PM	70.134.7.166	(M) Straight Lines Displayed (M) [ v1.0.280 | betolive.ag ]
05:16:58 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
05:16:55 PM	70.134.7.166	(M) Login successful (M) [ v1.0.280 | betolive.ag ]
05:16:54 PM	70.134.7.166	Login successful Token
04:54:12 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
04:49:48 PM	70.134.7.166	(M) Login successful (M) [ v1.0.280 | betolive.ag ]
04:49:47 PM	70.134.7.166	Login successful Token
04:14:35 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
04:14:31 PM	70.134.7.166	(M) Straight Lines Displayed (M) [ v1.0.280 | betolive.ag ]
04:14:31 PM	70.134.7.166	(M) Straight Lines Displayed (M) [ v1.0.280 | betolive.ag ]
04:08:13 PM	70.134.7.166	(M) Straight Lines Displayed (M) [ v1.0.280 | betolive.ag ]
04:08:13 PM	70.134.7.166	(M) Straight Lines Displayed (M) [ v1.0.280 | betolive.ag ]
04:07:15 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
04:04:57 PM	70.134.7.166	(M) Straight Lines Displayed (M) [ v1.0.280 | betolive.ag ]
04:04:57 PM	70.134.7.166	(M) Straight Lines Displayed (M) [ v1.0.280 | betolive.ag ]
03:59:59 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
03:57:02 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
03:57:01 PM	70.134.7.166	API LOG | Bet :
Football #257 Chargers 7 -125 - buying &#189; For Game
03:57:01 PM	70.134.7.166	API LOG | Ticket: 1073413299 Risk:12500 Win:10000
03:56:33 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
03:51:35 PM	70.134.7.166	(M) View Pending (M) [ v1.0.280 | betolive.ag ]
03:51:34 PM	70.134.7.166	API LOG | Bet :
Hockey #83 Utah Mammoth -1&#189; +145 - For Game
03:51:34 PM	70.134.7.166	API LOG | Ticket: 1073380892 Risk:15000 Win:21750
03:51:34 PM	70.134.7.166	API LOG | Bet :
Hockey #83 Utah Mammoth -170 - For Game
03:51:34 PM	70.134.7.166	API LOG | Ticket: 1073380892 Risk:25500 Win:15000
03:51:12 PM	70.134.7.166	(M) Login successful (M) [ v1.0.280 | betolive.ag ]
03:51:11 PM	70.134.7.166	Login successful Token
02:42:51 PM	107.115.171.78	View Daily Figures [ v1.0.280 | betolive.ag ]
02:42:37 PM	107.115.171.78	View Pending [ v1.0.280 | betolive.ag ]
02:42:33 PM	107.115.171.78	Login successful [ v1.0.280 | betolive.ag ]
02:42:33 PM	107.115.171.78	Login successful Token
02:39:23 PM	107.115.171.78	View Pending [ v1.0.280 | betolive.ag ]
02:39:23 PM	107.115.171.78	API LOG | Ticket: 1073358528 Risk:22000 Win:20000
02:39:23 PM	107.115.171.78	API LOG | Bet :
Football #240 Lions -3 -110 - For 2nd Half
02:35:19 PM	107.115.171.78	View Pending [ v1.0.280 | betolive.ag ]
02:35:19 PM	107.115.171.78	API LOG | Bet :
Football #243 Cardinals/Cowboys O 26&#189; -115 - For 2nd Half
02:35:19 PM	107.115.171.78	API LOG | Ticket: 1073353143 Risk:17250 Win:15000
02:25:53 PM	107.115.171.78	View Pending [ v1.0.280 | betolive.ag ]
02:25:52 PM	107.115.171.78	API LOG | Bet :
Football #241 Raiders -3 -110 - For 2nd Half
02:25:52 PM	107.115.171.78	API LOG | Ticket: 1073348189 Risk:16500 Win:15000
02:22:07 PM	107.115.171.78	Login successful [ v1.0.280 | betolive.ag ]
02:22:06 PM	107.115.171.78	Login successful Token
01:26:20 PM	107.115.171.78	Straight Lines Displayed [ v1.0.280 | betolive.ag ]
01:26:20 PM	107.115.171.78	Straight Lines Displayed [ v1.0.280 | betolive.ag ]
01:23:44 PM	107.115.171.78	Login successful [ v1.0.280 | betolive.ag ]
01:23:43 PM	107.115.171.78	Login successful Token
12:29:05 PM	107.115.171.78	View Pending [ v1.0.280 | betolive.ag ]
12:29:04 PM	107.115.171.78	API LOG | Ticket: 1073291892 Risk:11500 Win:10000
12:29:04 PM	107.115.171.78	API LOG | Bet :
Football #241 Raiders +&#189; -115 - For 1st Half
12:28:35 PM	107.115.171.78	View Pending [ v1.0.280 | betolive.ag ]
12:09:27 PM	107.115.171.78	View Pending [ v1.0.280 | betolive.ag ]
12:09:23 PM	107.115.171.78	Login successful [ v1.0.280 | betolive.ag ]
12:09:23 PM	107.115.171.78	Login successful Token
10:48:50 AM	107.115.171.78	View Pending [ v1.0.280 | betolive.ag ]
10:48:49 AM	107.115.171.78	API LOG | Bet :
Football #241 Raiders +1&#189; -110 - For Game
10:48:49 AM	107.115.171.78	API LOG | Ticket: 1073245645 Risk:11000 Win:10000
10:48:35 AM	107.115.171.78	View Pending [ v1.0.280 | betolive.ag ]
10:48:35 AM	107.115.171.78	API LOG | Bet :
Football #240 Lions -3 -115 - For Game
10:48:35 AM	107.115.171.78	API LOG | Ticket: 1073245580 Risk:23000 Win:20000
10:48:20 AM	107.115.171.78	API LOG | BLOCK BET | BOT BLOCK LINE ST| #[{"key":"bot_619115908_0_S__0","val":"CCC88412"}]
10:48:07 AM	107.115.171.78	View Pending [ v1.0.280 | betolive.ag ]
10:47:49 AM	107.115.171.78	View Pending [ v1.0.280 | betolive.ag ]
10:47:46 AM	107.115.171.78	Login successful [ v1.0.280 | betolive.ag ]
10:47:45 AM	107.115.171.78	Login successful Token
09:46:07 AM	156.146.132.48	View Pending [ v1.0.280 | betolive.ag ]
09:46:07 AM	156.146.132.48	API LOG | Bet :
Football #256 Steelers -2&#189; -115 - For 1st Half
09:46:07 AM	156.146.132.48	API LOG | Ticket: 1073230489 Risk:11500 Win:10000
09:45:54 AM	156.146.132.48	View Pending [ v1.0.280 | betolive.ag ]
09:45:53 AM	156.146.132.48	API LOG | Bet :
Football #240 Lions -2&#189; -115 - For 1st Half
09:45:53 AM	156.146.132.48	API LOG | Ticket: 1073230448 Risk:11500 Win:10000
09:45:35 AM	156.146.132.48	Login successful [ v1.0.280 | betolive.ag ]
09:45:34 AM	156.146.132.48	Login successful Token
06:38:41 AM	156.146.132.48	(M) Login successful (M) [ v1.0.280 | betolive.ag ]
06:38:40 AM	156.146.132.48	Login successful Token`;

function main(): void {
  const root = process.cwd();
  const allSummaryPath = resolve(root, "scratch/f402-player-analysis-all.json");
  const detailPath = resolve(root, "scratch/f402-suspected-bots-detail.json");
  const bundlePath = resolve(
    root,
    "scratch/f402-suspected-bots-raw-ledger-bundle.json",
  );
  const octPath = "/tmp/graded-oct-window.json";
  const todayPath = "/tmp/graded-today.json";

  const allSummaryJson = JSON.parse(readFileSync(allSummaryPath, "utf8")) as {
    LIST: ReportPlayerAnalysisRowRaw[];
  };
  const detailJson = JSON.parse(readFileSync(detailPath, "utf8")) as {
    detailRows: ReportPlayerAnalysisRowRaw[];
  };
  const bundleJson = JSON.parse(readFileSync(bundlePath, "utf8")) as {
    rawTicketLedgerForFlagged?: GradedWagerRawRow[];
  };

  let gradedRows: GradedWagerRawRow[] = [];
  if (existsSync(octPath) && existsSync(todayPath)) {
    const oct = JSON.parse(
      readFileSync(octPath, "utf8"),
    ) as GradedWagerRawRow[];
    const today = JSON.parse(
      readFileSync(todayPath, "utf8"),
    ) as GradedWagerRawRow[];
    gradedRows = [...oct, ...today];
  } else if (bundleJson.rawTicketLedgerForFlagged) {
    gradedRows = bundleJson.rawTicketLedgerForFlagged;
  }

  const run1 = buildCcc88412DecisionInstrument({
    allSummaryRows: allSummaryJson.LIST,
    suspectedBotDetailRows: detailJson.detailRows,
    gradedWagerRows: gradedRows,
    cccRawWebLogText20261101: CCC88412_WEBLOG_NOV1_TSV,
  });

  const run2 = buildCcc88412DecisionInstrument({
    allSummaryRows: allSummaryJson.LIST,
    suspectedBotDetailRows: detailJson.detailRows,
    gradedWagerRows: gradedRows,
    cccRawWebLogText20261101: CCC88412_WEBLOG_NOV1_TSV,
  });

  const json1 = JSON.stringify(run1, null, 2) + "\n";
  const json2 = JSON.stringify(run2, null, 2) + "\n";
  const md1 = renderCcc88412DecisionInstrumentMarkdown(run1);
  const md2 = renderCcc88412DecisionInstrumentMarkdown(run2);

  const shaJson1 = createHash("sha256").update(json1).digest("hex");
  const shaJson2 = createHash("sha256").update(json2).digest("hex");
  const shaMd1 = createHash("sha256").update(md1).digest("hex");
  const shaMd2 = createHash("sha256").update(md2).digest("hex");

  if (shaJson1 !== shaJson2 || shaMd1 !== shaMd2) {
    throw new Error(
      `Byte-identical regeneration check failed: JSON ${shaJson1} vs ${shaJson2}, MD ${shaMd1} vs ${shaMd2}`,
    );
  }

  const outJsonPath = resolve(
    root,
    "scratch/ccc88412-decision-instrument.json",
  );
  const outMdPath = resolve(root, "scratch/ccc88412-decision-instrument.md");
  writeFileSync(outJsonPath, json1, "utf8");
  writeFileSync(outMdPath, md1, "utf8");

  console.log(
    JSON.stringify(
      {
        status: "OK",
        subjectCustomerId: run1.subjectCustomerId,
        recommendedAction: run1.decisionScorecard.recommendedAction,
        botFlagClassificationDecision:
          run1.decisionScorecard.botFlagClassificationDecision,
        limitHeuristicScore: run1.decisionScorecard.limitHeuristicScore,
        limitCostRatioThreshold: run1.decisionScorecard.limitCostRatioThreshold,
        linkHeuristicScore: run1.decisionScorecard.linkToAymanHeuristicScore,
        linkCostRatioThreshold: run1.decisionScorecard.linkCostRatioThreshold,
        conservationOraclesPassed: run1.conservationOracles.passed,
        totalBets: run1.conservationOracles.totalBetsObservedSportPeriodSum,
        totalNetUsd: run1.conservationOracles.totalNetUsdObservedSportPeriodSum,
        byteIdenticalJsonSha256: shaJson1,
        byteIdenticalMdSha256: shaMd1,
        outJsonPath,
        outMdPath,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  main();
}
