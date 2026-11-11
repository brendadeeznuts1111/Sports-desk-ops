#!/usr/bin/env bun
/**
 * @file sportsdesk_layoff_risk_cli.ts
 * @description Cross-Market Parlay Matching & Layoff Risk Surveillance CLI (CFB, NFL, NBA, All Periods).
 *
 * Implements:
 * 1. Line Delta evaluation across Polymarket & Fantasy402 (±0.5 to ±1.0 points).
 * 2. Layoff Risk Alerts across CFB, NFL, and NBA (including Key 3/7 for Football & Key 3/4/5/6/7/8 for NBA).
 * 3. Wallet / Customer Attribution across BILLY666, CUB22HR, MJ2026, BIGDAD, GPRO50RSK, ATEAM, LAKERS, KOBE24.
 * 4. Period-by-Period Matrix (Game=0, 1H=1, 2H=2, Q1..Q4=3..6, Live=0G).
 * 5. 5-minute surveillance daemon loop.
 */

import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";
import { createComboObservationsLegsStore } from "../lib/combo_observations_legs_store.ts";
import { LayoffRiskEngine } from "../lib/layoff_risk_engine.ts";
import { parseLineHundredths } from "../lib/combo_identity.ts";
import { resolve } from "node:path";

function printHelp(): void {
  console.log(`Cross-Market Parlay Matching & Layoff Risk Surveillance CLI (CFB • NFL • NBA)

Commands:
  scan       Run intersection query across CFB, NFL, and NBA and emit layoff risk alerts
  seed       Seed database with full CFB, NFL, and NBA multi-period scenario data
  daemon     Continuous 5-minute interval surveillance loop

Flags:
  --db <path>             Path to SQLite database (default: ./cross_market_combos.sqlite)
  --delta <hundredths>    Max line delta in hundredths (default: 100 = ±1.0 points)
  --sport <CFB|NFL|NBA>   Optional filter by sport family
  --period <game|1h|2h..> Optional filter by period
  --interval <seconds>    Poll interval for daemon mode (default: 300 = 5 minutes)
  --json                  Output raw JSON telemetry

Examples:
  bun run sportsdesk_layoff_risk_cli.ts seed --db ./test.sqlite
  bun run sportsdesk_layoff_risk_cli.ts scan --db ./test.sqlite
  bun run sportsdesk_layoff_risk_cli.ts scan --db ./test.sqlite --sport NBA
`);
}

function seedDashboardScenario(dbPath: string): void {
  const db = openSportsdeskSqlite(dbPath);
  const store = createComboObservationsLegsStore(db);

  // 1. Wallet -> CustomerID Attributions across CFB, NFL, and NBA
  const attributions = [
    {
      proxyWallet: "0x3af8392189d021cfa82",
      customerId: "CB112_1",
      agentOwner: "CUB22HR",
      attributionType: "IP_CLUSTER_OR_SYNDICATE",
    },
    {
      proxyWallet: "0x3af8771189d099bf71",
      customerId: "RF2003",
      agentOwner: "BILLY666",
      attributionType: "TOUT_BURST_CLUSTER",
    },
    {
      proxyWallet: "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
      customerId: "BGD101",
      agentOwner: "BIGDAD",
      attributionType: "WHALE_CTF_BRIDGE",
    },
    {
      proxyWallet: "0x07db5765beba17be154cbfbd6324a15f3c81fa4f",
      customerId: "MJ102",
      agentOwner: "MJ2026",
      attributionType: "WHALE_CTF_BRIDGE",
    },
    {
      proxyWallet: "0x120640a1deffe6b53e291eba74acf1dbe8274528",
      customerId: "GP300",
      agentOwner: "GPRO50RSK",
      attributionType: "STEAM_ORIGINATOR_CTF",
    },
    {
      proxyWallet: "0x53224176b413f20ac63d61f1a0e19002ffb38acb",
      customerId: "AT10359",
      agentOwner: "ATEAM",
      attributionType: "STEAM_ORIGINATOR_CTF",
    },
    {
      proxyWallet: "0x22e29a644a9d14564967b3f9f50346b7ad425c32",
      customerId: "ABC700",
      agentOwner: "JUICEPLUS",
      attributionType: "NBA_SGP_SHARP",
    },
    {
      proxyWallet: "0x231699490d08919d8f1d3f0b90fd2a677e3e9819",
      customerId: "DAN245",
      agentOwner: "DAN318",
      attributionType: "NBA_SGP_SHARP",
    },
    {
      proxyWallet: "0x50cc8708aff3791f2d6125645c82bda532baa534",
      customerId: "EJ8834",
      agentOwner: "MJ2026",
      attributionType: "SUBNET_104_28_34_CLUSTER",
    },
    {
      proxyWallet: "0xaa7789219c17e180dcb5933099c90d885f1d15a5",
      customerId: "DA4401",
      agentOwner: "JUICEPLUS",
      attributionType: "NBA_TOTAL_MIDDLE",
    },
  ];
  for (const attr of attributions) {
    store.insertAttribution(attr);
  }

  // 2. NFL: Patriots Key 7 Spread (PM -6.5 vs F402 -7.5)
  store.ingestPolymarketCombo(
    "0xpm_order_patriots_1",
    "0x3af8392189d021cfa82",
    [
      {
        competitionFamily: "NFL",
        period: "game",
        team: "PATRIOTS",
        marketKind: "spread",
        side: "FAVORITE",
        line: -6.5,
        productClass: "parlay",
      },
    ],
  );
  store.ingestF402Ticket("9982", "1", "CB112_1", "CUB22HR", [
    {
      ticketNumber: "9982",
      wagerNumber: "1",
      customerId: "CB112_1",
      agentId: "CUB22HR",
      sportType: "NFL",
      period: 0,
      team: "PATRIOTS",
      shortDesc: "P PATRIOTS -7.5 -110",
      line: -7.5,
    },
  ]);

  // 3. CFB: Baylor Total 48 Cluster (14 F402 tickets Over 48.0 vs PM Over 47.5) + Baylor Spread (+1.5 PM vs +2.0 F402) + Sac St (+9.5 PM vs +10.0 F402)
  for (let i = 1; i <= 14; i++) {
    store.ingestF402Ticket(`880${i}`, "1", `CUST_BAY_${i}`, "BILLY666", [
      {
        ticketNumber: `880${i}`,
        wagerNumber: "1",
        customerId: `CUST_BAY_${i}`,
        agentId: "BILLY666",
        sportType: "CFB",
        period: 0,
        team: "BAYLOR",
        shortDesc: "P BAYLOR OVER 48 -110",
        line: 48.0,
      },
    ]);
  }
  store.ingestPolymarketCombo("0xpm_order_baylor_1", "0x3af8771189d099bf71", [
    {
      competitionFamily: "CFB",
      period: "game",
      team: "BAYLOR",
      marketKind: "total",
      side: "OVER",
      line: 47.5,
      productClass: "parlay",
    },
  ]);

  store.ingestPolymarketCombo(
    "0xpm_order_sacst_1",
    "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
    [
      {
        competitionFamily: "CFB",
        period: "game",
        team: "SAC_ST",
        marketKind: "spread",
        side: "UNDERDOG",
        line: 9.5,
        productClass: "parlay",
      },
    ],
  );
  store.ingestF402Ticket("7741", "1", "BGD101", "BIGDAD", [
    {
      ticketNumber: "7741",
      wagerNumber: "1",
      customerId: "BGD101",
      agentId: "BIGDAD",
      sportType: "CFB",
      period: 0,
      team: "SAC_ST",
      shortDesc: "P SAC_ST +10.0 -110",
      line: 10.0,
    },
  ]);

  // CFB Non-Game Period Pending Wagers (1H, 2H, Q1, Live) on F402 (No Polymarket match due to Period 0 API gate)
  store.ingestF402Ticket("7750", "1", "GP300", "GPRO50RSK", [
    {
      ticketNumber: "7750",
      wagerNumber: "1",
      customerId: "GP300",
      agentId: "GPRO50RSK",
      sportType: "CFB",
      period: 1,
      team: "ALA",
      shortDesc: "P 1H ALABAMA -7.0 -110",
      line: -7.0,
    },
    {
      ticketNumber: "7750",
      wagerNumber: "2",
      customerId: "GP300",
      agentId: "GPRO50RSK",
      sportType: "CFB",
      period: 2,
      team: "OSU",
      shortDesc: "P 2H OHIO ST OVER 24.5 -110",
      line: 24.5,
    },
  ]);

  // 4. NBA: Full Game Parlays & SGPs vs Polymarket + Derivative Periods (1H, 2H, Q1-Q4, Live)
  // NBA Match 1: Lakers Spread (PM -2.5 bought across Key 3 vs F402 -3.5) -> Sharp Layoff Risk across NBA Key 3!
  store.ingestPolymarketCombo(
    "0xpm_order_nba_lal_1",
    "0x07db5765beba17be154cbfbd6324a15f3c81fa4f",
    [
      {
        competitionFamily: "NBA",
        period: "game",
        team: "LAL",
        marketKind: "spread",
        side: "FAVORITE",
        line: -2.5,
        productClass: "sgp",
      },
      {
        competitionFamily: "NBA",
        period: "game",
        team: "LAL",
        marketKind: "total",
        side: "OVER",
        line: 228.5,
        productClass: "sgp",
      },
    ],
  );
  for (let i = 1; i <= 9; i++) {
    store.ingestF402Ticket(
      `910${i}`,
      "1",
      i <= 5 ? "MJ102" : "EJ8834",
      "MJ2026",
      [
        {
          ticketNumber: `910${i}`,
          wagerNumber: "1",
          customerId: i <= 5 ? "MJ102" : "EJ8834",
          agentId: "MJ2026",
          sportType: "NBA",
          period: 0,
          team: "LAL",
          shortDesc: "C LAKERS -3.5 -110",
          line: -3.5,
        },
        {
          ticketNumber: `910${i}`,
          wagerNumber: "2",
          customerId: i <= 5 ? "MJ102" : "EJ8834",
          agentId: "MJ2026",
          sportType: "NBA",
          period: 0,
          team: "LAL",
          shortDesc: "C LAKERS OVER 229.0 -110",
          line: 229.0,
        },
      ],
    );
  }

  // NBA Match 2: Celtics Spread (PM -5.5 vs F402 -6.5 across NBA Key 6)
  store.ingestPolymarketCombo(
    "0xpm_order_nba_bos_1",
    "0x120640a1deffe6b53e291eba74acf1dbe8274528",
    [
      {
        competitionFamily: "NBA",
        period: "game",
        team: "BOS",
        marketKind: "spread",
        side: "FAVORITE",
        line: -5.5,
        productClass: "parlay",
      },
    ],
  );
  for (let i = 1; i <= 6; i++) {
    store.ingestF402Ticket(`920${i}`, "1", "GP300", "GPRO50RSK", [
      {
        ticketNumber: `920${i}`,
        wagerNumber: "1",
        customerId: "GP300",
        agentId: "GPRO50RSK",
        sportType: "NBA",
        period: 0,
        team: "BOS",
        shortDesc: "P CELTICS -6.5 -110",
        line: -6.5,
      },
    ]);
  }

  // NBA Match 3: Nuggets vs Suns Total Middle (PM Over 224.5 vs F402 Over 225.0)
  store.ingestPolymarketCombo(
    "0xpm_order_nba_den_1",
    "0x53224176b413f20ac63d61f1a0e19002ffb38acb",
    [
      {
        competitionFamily: "NBA",
        period: "game",
        team: "DEN",
        marketKind: "total",
        side: "OVER",
        line: 224.5,
        productClass: "parlay",
      },
    ],
  );
  for (let i = 1; i <= 5; i++) {
    store.ingestF402Ticket(`930${i}`, "1", "AT10359", "ATEAM", [
      {
        ticketNumber: `930${i}`,
        wagerNumber: "1",
        customerId: "AT10359",
        agentId: "ATEAM",
        sportType: "NBA",
        period: 0,
        team: "DEN",
        shortDesc: "P NUGGETS OVER 225.0 -110",
        line: 225.0,
      },
    ]);
  }

  // NBA Derivative Periods on F402 (1H, 2H, Q1, Q3, Live GSLIVE)
  store.ingestF402Ticket("9401", "1", "CHURN_059", "LAKERS", [
    {
      ticketNumber: "9401",
      wagerNumber: "1",
      customerId: "CHURN_059",
      agentId: "LAKERS",
      sportType: "NBA",
      period: 1,
      team: "LAL",
      shortDesc: "P 1H LAKERS -1.5 -110",
      line: -1.5,
    },
    {
      ticketNumber: "9401",
      wagerNumber: "2",
      customerId: "CHURN_059",
      agentId: "LAKERS",
      sportType: "NBA",
      period: 3,
      team: "BOS",
      shortDesc: "P 1Q CELTICS -2.0 -110",
      line: -2.0,
    },
    {
      ticketNumber: "9401",
      wagerNumber: "3",
      customerId: "CHURN_059",
      agentId: "LAKERS",
      sportType: "NBA",
      period: "live",
      team: "GSW",
      shortDesc: "G LIVE WARRIORS OVER 231.5 -115",
      line: 231.5,
    },
  ]);

  // 5. Settled Troy Tickets (42 tickets) for CLV calibration
  for (let i = 1; i <= 42; i++) {
    store.insertFlatLeg({
      sourceVenue: "f402",
      sourceTicket: `TROY_SETTLED_${i}:1`,
      walletOrAccount: `TROY_REC_${i}`,
      agentId: "BILLY666",
      gameId: "CFB:TROY_VS_OPP",
      period: "game",
      subject: "TROY",
      marketKind: "spread",
      side: "FAVORITE",
      lineHundredths: parseLineHundredths(-3.5),
      productClass: "straight",
      stakeCents: 5000,
      oddsAmerican: -110,
      identitySha256: `troy_ident_${i}`,
      shapeSha256: "troy_shape_base",
      pickShapeSha256: "troy_pick_base",
      placedAt: "2026-10-25T12:00:00Z",
      status: "settled",
    });
  }

  console.log(
    `[SEED] Ingested CFB, NFL, and NBA scenario data into ${dbPath} (Total leg rows: ${store.countLegs()})`,
  );
}

function runScan(
  dbPath: string,
  maxDelta: number,
  isJson: boolean,
  filterSport?: string,
  filterPeriod?: string,
): void {
  const db = openSportsdeskSqlite(dbPath);
  const engine = new LayoffRiskEngine(db);
  let matches = engine.queryLineDeltaMatches(maxDelta);
  if (filterSport) {
    matches = matches.filter((m) =>
      m.gameId.startsWith(`${filterSport.toUpperCase()}:`),
    );
  }
  if (filterPeriod) {
    matches = matches.filter(
      (m) => m.period.toLowerCase() === filterPeriod.toLowerCase(),
    );
  }
  const summary = engine.computeSummary(matches);
  const alerts = engine.formatLayoffRiskAlerts(matches);

  if (isJson) {
    console.log(JSON.stringify({ summary, matches, alerts }, null, 2));
    return;
  }

  console.log(
    "\n================================================================================",
  );
  console.log(
    "  📊 CROSS-MARKET PARLAY MATCHING: CFB • NFL • NBA SLIDING-WINDOW ENGINE",
  );
  console.log(
    "================================================================================",
  );
  console.log(`  System Status:       \x1b[32mGREEN (ACTIVE)\x1b[0m`);
  console.log(`  Analysis Window:     300s (5-minute rolling window)`);
  console.log(
    `  Risk Status:         \x1b[33mTEASER LEAK / NBA & CFB CLV CAPTURE\x1b[0m`,
  );
  console.log(
    `  Line Delta Window:   ±${(maxDelta / 100).toFixed(1)} pts (${maxDelta} hundredths)`,
  );
  console.log(
    "--------------------------------------------------------------------------------",
  );
  console.log(`  Total Correlated Matches:   ${summary.totalMatches}`);
  console.log(`  Exact Matches (Identical):  ${summary.exactMatches}`);
  console.log(`  Adjacent Matches (±0.5..1): ${summary.adjacentMatches}`);
  console.log(
    `  CFB Baylor Open Cluster:    ${summary.baylorClusterCount} pending legs`,
  );
  console.log(
    `  NBA Active Open Cluster:    ${summary.nbaClusterCount} pending legs`,
  );
  console.log(
    `  Settled Troy CLV Baseline:  ${summary.settledTroyCount} settled legs`,
  );
  console.log(
    "--------------------------------------------------------------------------------",
  );
  console.log(
    "  SPORT & PERIOD BREAKDOWN (F402 PENDING vs POLYMARKET COMBO API):",
  );
  for (const b of summary.sportPeriodBreakdown) {
    const elig = b.polymarketEligible
      ? "PM_TRADABLE"
      : "INTERNAL_ONLY (Period > 0)";
    console.log(
      `   • ${b.sport.padEnd(4)} | Period: ${b.period.padEnd(5)} | Pending: ${String(b.pendingLegs).padStart(2)} | Matched: ${String(b.matchedLegs).padStart(2)} | Layoff Risks: ${String(b.layoffRisks).padStart(2)} | ${elig}`,
    );
  }
  console.log(
    "--------------------------------------------------------------------------------",
  );

  if (alerts.length > 0) {
    console.log(
      `\n  \x1b[31;1m⚠️  ACTIVE LAYOFF RISKS DETECTED (${alerts.length} ALERTS):\x1b[0m`,
    );
    for (const alert of alerts.slice(0, 15)) {
      console.log(`  \x1b[33m${alert}\x1b[0m`);
    }
    if (alerts.length > 15) {
      console.log(
        `  ... and ${alerts.length - 15} additional correlated cluster alerts.`,
      );
    }
  } else {
    console.log(
      "\n  \x1b[32m✓ No active Layoff Risks detected (Book lines hold EV edge).\x1b[0m",
    );
  }
  console.log(
    "================================================================================\n",
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    printHelp();
    return;
  }

  let dbPath = "./cross_market_combos.sqlite";
  let maxDelta = 100;
  let intervalSec = 300;
  let isJson = false;
  let filterSport: string | undefined;
  let filterPeriod: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--db" && argv[i + 1]) dbPath = resolve(argv[i + 1]!);
    else if (argv[i] === "--delta" && argv[i + 1])
      maxDelta = parseInt(argv[i + 1]!, 10);
    else if (argv[i] === "--interval" && argv[i + 1])
      intervalSec = parseInt(argv[i + 1]!, 10);
    else if (argv[i] === "--sport" && argv[i + 1]) filterSport = argv[++i];
    else if (argv[i] === "--period" && argv[i + 1]) filterPeriod = argv[++i];
    else if (argv[i] === "--json") isJson = true;
  }

  if (cmd === "seed") {
    seedDashboardScenario(dbPath);
    return;
  }

  if (cmd === "scan") {
    runScan(dbPath, maxDelta, isJson, filterSport, filterPeriod);
    return;
  }

  if (cmd === "daemon") {
    console.log(
      `[DAEMON] Starting 5-minute Cross-Market Surveillance Daemon (Interval: ${intervalSec}s)`,
    );
    runScan(dbPath, maxDelta, isJson, filterSport, filterPeriod);
    setInterval(() => {
      console.log(
        `[DAEMON POLL ${new Date().toISOString()}] Re-running intersection query...`,
      );
      runScan(dbPath, maxDelta, isJson, filterSport, filterPeriod);
    }, intervalSec * 1000);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

await main();
