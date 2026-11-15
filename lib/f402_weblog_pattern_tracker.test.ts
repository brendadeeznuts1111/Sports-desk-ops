import { describe, expect, test } from "bun:test";
import {
  analyzeWeblogPatterns,
  classifyWeblogIpExtended,
  decodeHtmlFractionEntities,
  parsePastedWeblogTable,
  parseWeblogBetLeg,
} from "./f402_weblog_pattern_tracker.ts";
import type { ReportPlayerAnalysisRowRaw } from "./f402_report_player_analysis.ts";

const USER_PASTED_WEBLOG_NOV1 = `Time(EST)	IP Address	Action
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

describe("lib/f402_weblog_pattern_tracker", () => {
  test("decodes HTML fraction entities and parses spread, total, moneyline, puckline, and bought points", () => {
    expect(
      decodeHtmlFractionEntities(
        "Football #263 Eagles 6 -120 - buying &#189; For Game",
      ),
    ).toBe("Football #263 Eagles 6 -120 - buying ½ For Game");

    const boughtSpread = parseWeblogBetLeg(
      "Football #263 Eagles 6 -120 - buying &#189; For Game",
    );
    expect(boughtSpread.sport).toBe("Football");
    expect(boughtSpread.rotationNumber).toBe(263);
    expect(boughtSpread.inferredSubSport).toBe("NFL");
    expect(boughtSpread.selectionText).toBe("Eagles");
    expect(boughtSpread.marketType).toBe("SPREAD");
    expect(boughtSpread.linePoints).toBe(6);
    expect(boughtSpread.juiceOdds).toBe(-120);
    expect(boughtSpread.boughtPoints).toBe(0.5);
    expect(boughtSpread.periodLabel).toBe("Game");
    expect(boughtSpread.periodNumber).toBe(0);

    const puckline = parseWeblogBetLeg(
      "Hockey #83 Utah Mammoth -1&#189; +145 - For Game",
    );
    expect(puckline.sport).toBe("Hockey");
    expect(puckline.rotationNumber).toBe(83);
    expect(puckline.inferredSubSport).toBe("NHL");
    expect(puckline.marketType).toBe("PUCKLINE_OR_RUNLINE");
    expect(puckline.linePoints).toBe(-1.5);
    expect(puckline.juiceOdds).toBe(145);

    const moneyline = parseWeblogBetLeg(
      "Hockey #83 Utah Mammoth -170 - For Game",
    );
    expect(moneyline.marketType).toBe("MONEYLINE");
    expect(moneyline.linePoints).toBeNull();
    expect(moneyline.juiceOdds).toBe(-170);

    const halfTotal = parseWeblogBetLeg(
      "Football #243 Cardinals/Cowboys O 26&#189; -115 - For 2nd Half",
    );
    expect(halfTotal.marketType).toBe("TOTAL_OVER");
    expect(halfTotal.linePoints).toBe(26.5);
    expect(halfTotal.periodLabel).toBe("2nd Half");
    expect(halfTotal.periodNumber).toBe(2);
  });

  test("classifies VPN datacenter and AT&T mobility/broadband subnets", () => {
    expect(classifyWeblogIpExtended("156.146.132.48")).toBe(
      "VPN_DATACENTER_156_146",
    );
    expect(classifyWeblogIpExtended("107.115.171.78")).toBe(
      "ATT_MOBILITY_107_112",
    );
    expect(classifyWeblogIpExtended("70.134.7.166")).toBe(
      "ATT_BROADBAND_70_128",
    );
  });

  test("parses the user's pasted Nov 1 WebLog table, pairs all 16 wagers across 15 tickets, decodes BOT BLOCK LINE ST, and joins with CCC88412 detail wagers", () => {
    const events = parsePastedWeblogTable(USER_PASTED_WEBLOG_NOV1, {
      dateYmd: "2026-11-01",
    });
    expect(events.length).toBeGreaterThan(80);

    const mockAnalysisRows: ReportPlayerAnalysisRowRaw[] = [
      {
        CustomerID: "CCC88412  ",
        PlayerLogin: "CCC88412",
        AgentID: "FATSNOBOT ",
        AgentLogin: "CCC88412",
        BETPOINTS: "-3.0",
        JUICE: "-115.0",
        CLOSELINE: "-3.5 -110",
        PRICE: null,
        POINTS: -0.5,
        DESCRIPTION: "Football #240 Lions -3 -115 - For Game",
        DAILYFIGUREDATE: "2026-11-01 00:00:00.000",
        RISK: "23000",
        TOWIN: "20000",
        WINLOSE: "20000",
        WAGERSTATUS: "W",
        SPORTSUBTYPE: "NFL                 ",
        PERIODNUMBER: "0",
        POSTEDDATETIME: "2026-11-01 10:48:35.460",
        SuspectedBot: "Y",
        SuspectedBotType: "0",
        InetTarget: "betolive.com",
        TOTALBETS: null,
        BETTERPRICELINES: null,
        BETTERPOINTSLINES: null,
      },
    ];

    const report = analyzeWeblogPatterns(events, {
      analysisDetailRows: mockAnalysisRows,
    });

    expect(report.wagerCount).toBe(16);
    expect(report.distinctTicketCount).toBe(15);
    expect(report.multiBetTicketNumbers).toEqual(["1073380892"]);
    expect(report.distinctIpCount).toBe(3);
    expect(report.attributedCustomerId).toBe("CCC88412");
    expect(report.attributionMatchCount).toBe(1);

    // Verify BOT BLOCK LINE ST event and 15-second post-block retry
    expect(report.botBlocks).toHaveLength(1);
    const block = report.botBlocks[0]!;
    expect(block.blockType).toBe("BOT BLOCK LINE ST");
    expect(block.gameId).toBe("619115908");
    expect(block.periodNumber).toBe(0);
    expect(block.wagerType).toBe("S");
    expect(block.slotIndex).toBe(0);
    expect(block.blockingCustomerId).toBe("CCC88412");
    expect(block.isSelfCollision).toBe(true);
    expect(block.postBlockRetryWager).toEqual({
      delaySec: 15,
      ticketNumber: "1073245580",
      description: "Football #240 Lions -3 -115 - For Game",
      riskCents: 23000,
      toWinCents: 20000,
    });

    // Verify IP summaries
    const vpnIp = report.byIp.find((i) => i.ip === "156.146.132.48")!;
    expect(vpnIp.ipClass).toBe("VPN_DATACENTER_156_146");
    expect(vpnIp.wagerCount).toBe(2);
    expect(vpnIp.periods).toEqual({ "1st Half": 2 });

    const attMobilityIp = report.byIp.find((i) => i.ip === "107.115.171.78")!;
    expect(attMobilityIp.ipClass).toBe("ATT_MOBILITY_107_112");
    expect(attMobilityIp.wagerCount).toBe(6);
    expect(attMobilityIp.botBlockCount).toBe(1);
    expect(attMobilityIp.periods).toEqual({
      Game: 2,
      "1st Half": 1,
      "2nd Half": 3,
    });

    const attBroadbandIp = report.byIp.find((i) => i.ip === "70.134.7.166")!;
    expect(attBroadbandIp.ipClass).toBe("ATT_BROADBAND_70_128");
    expect(attBroadbandIp.wagerCount).toBe(8);
    expect(attBroadbandIp.boughtPointsWagerCount).toBe(2);
    expect(attBroadbandIp.subSports).toEqual({ NFL: 4, NHL: 4 });
  });
});
