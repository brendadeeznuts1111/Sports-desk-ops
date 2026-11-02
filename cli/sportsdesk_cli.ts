#!/usr/bin/env bun
/**
 * @file sportsdesk_cli.ts
 * @description SportsDesk & Fantasy402 Downline Intelligence & Automation CLI (Bun v1.4+).
 *
 * Implements:
 *  1. Dual argument dispatch: Positional subcommands (winners, losers, leaderboard, sim, cust, tree, alert, r2, cron)
 *     alongside standardized POSIX flags (-p, --limit, --sort-by, --format, --tz, --min-bets, --exclude-void, --by-agent).
 *  2. Introspection commands for 16 Domain Branded Primitives (-b, --brands) and
 *     13-Entity Qwen3.5-4B Neuron Registry (-N, --neurons).
 *  3. Cloudflare R2 object storage sync and verification commands.
 *  4. Full integration with Telegram Bot, Webview Server, Churn Simulator, and OnePass Agent Plugin.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  REPORT_TYPES,
  SportsDeskTelegramService,
  isReportType,
} from "../services/sportsdesk_telegram_bot.ts";
import {
  ReportingSchedulerService,
  startBotDaemon,
} from "../services/reporting_scheduler_service.ts";
import { runFullBettorSimulationPipeline } from "../services/simulate_bettor_churn_suite.ts";
import { AgentOnePassPlugin } from "../services/agent_onepass_plugin.ts";
import {
  syncReportsDirectory,
  verifyR2Connection,
  getR2ConfigInfo,
} from "../services/sportsdesk_r2_sync.ts";

import {
  parseAsCents,
  centsToDollars,
  customerIdentifier,
  padCustomerIdCanonical,
  agentIdentifier,
  ticketIdentifier,
  parseAsEpochSec,
  parseAsEpochMs,
  parseAsColorHexInt,
  colorHexIntToHexString,
  betGroupIdentifier,
  parlayLegCount,
  rotationNumber,
  parseAmericanOdds,
  formatHalfPointLine,
  computeBayesSharp,
  parseAsBasisPoints,
  INGESTION_CHANNELS,
  ROUTE_CIRCUITS,
  TELEMETRY_SURFACES,
  ALL_QWEN_TOKENS,
} from "../design/domain-branded-types.ts";
import { assertUniqueTokenColors } from "../lib/validation/token_validator.ts";
import { printAnsiMarkdown } from "../lib/canonical_osc8_links.ts";
import {
  executePlayerColumnMutation,
  executeVigSetupInsert,
  queryIpTrackerWebLog,
  fetchPlayerInfo,
  WirePayloadError,
} from "../lib/fantasy402_manager_wire.ts";
import {
  TEN_MODE_CATALOG,
  buildTenModeLiveSnapshot,
} from "../lib/forensic_diagnostic_modes.ts";
import { buildGsLiveDualSurfaceDescriptor } from "../lib/gslive_manager_deeplink_sidecar.ts";
import {
  PER_OFFICE_IP_TRACKER_CLUSTERS,
  buildPerOfficeIpMatcherPayload,
} from "../lib/bet_ticker_ip_tracker_bridge.ts";

interface DownlineMetadata {
  readonly master_agent: string;
  readonly total_sub_agents: number;
  readonly active_sports_sub_agents: number;
  readonly total_provisioned_accounts: number;
  readonly active_sports_bettors: number;
  readonly total_lifetime_lost: number;
  readonly total_lifetime_won: number;
  readonly total_lifetime_net_hold: number;
  readonly total_sports_tickets: number;
  readonly total_sports_volume: number;
  readonly total_sports_net: number;
}

interface AgentDownlineRecord {
  readonly agent: string;
  readonly master: string;
  readonly total_accounts: number;
  readonly active_sports_accounts: number;
  readonly dormant_accounts: number;
  readonly lifetime_lost: number;
  readonly lifetime_won: number;
  readonly lifetime_net: number;
  readonly sports_tickets: number;
  readonly sports_vol: number;
  readonly sports_net: number;
}

interface DownlinePayload {
  readonly meta: DownlineMetadata;
  readonly agents: readonly AgentDownlineRecord[];
}

const repoRoot = resolve(
  typeof import.meta !== "undefined" && import.meta.dir
    ? import.meta.dir
    : dirname(process.argv[1] || "."),
  "..",
);

function loadDownlineData(): DownlinePayload {
  const jsonPath = resolve(repoRoot, "sportsdesk_downline_data.json");
  if (existsSync(jsonPath)) {
    const rawText = readFileSync(jsonPath, "utf-8");
    return JSON.parse(rawText) as DownlinePayload;
  }
  // Fallback production metadata
  return {
    meta: {
      master_agent: "BILLY666",
      total_sub_agents: 668,
      active_sports_sub_agents: 460,
      total_provisioned_accounts: 9435,
      active_sports_bettors: 2236,
      total_lifetime_lost: -73488698.0,
      total_lifetime_won: 62998429.0,
      total_lifetime_net_hold: -10487926.0,
      total_sports_tickets: 10941,
      total_sports_volume: 2786199.0,
      total_sports_net: -63467.0,
    },
    agents: [
      {
        agent: "BIGDAD",
        master: "BILLY666",
        total_accounts: 2,
        active_sports_accounts: 1,
        dormant_accounts: 1,
        lifetime_lost: -177400,
        lifetime_won: 40000,
        lifetime_net: -137400,
        sports_tickets: 2,
        sports_vol: 40000,
        sports_net: 40000,
      },
      {
        agent: "MJ2026",
        master: "BILLY666",
        total_accounts: 5,
        active_sports_accounts: 2,
        dormant_accounts: 3,
        lifetime_lost: -155000,
        lifetime_won: 179000,
        lifetime_net: 24000,
        sports_tickets: 2,
        sports_vol: 30000,
        sports_net: 40000,
      },
      {
        agent: "GPRO50RSK",
        master: "BILLY666",
        total_accounts: 7,
        active_sports_accounts: 3,
        dormant_accounts: 4,
        lifetime_lost: -22000,
        lifetime_won: 55858,
        lifetime_net: 33858,
        sports_tickets: 22,
        sports_vol: 46140,
        sports_net: 33858,
      },
      {
        agent: "ATEAM",
        master: "BILLY666",
        total_accounts: 30,
        active_sports_accounts: 10,
        dormant_accounts: 20,
        lifetime_lost: -966073,
        lifetime_won: 947963,
        lifetime_net: -18101,
        sports_tickets: 70,
        sports_vol: 59171,
        sports_net: 27434,
      },
      {
        agent: "FAKEMONEY",
        master: "BILLY666",
        total_accounts: 1,
        active_sports_accounts: 1,
        dormant_accounts: 0,
        lifetime_lost: -438000,
        lifetime_won: 463000,
        lifetime_net: 25000,
        sports_tickets: 47,
        sports_vol: 940000,
        sports_net: 25000,
      },
      {
        agent: "SPEN",
        master: "BILLY666",
        total_accounts: 133,
        active_sports_accounts: 47,
        dormant_accounts: 86,
        lifetime_lost: -554003,
        lifetime_won: 500622,
        lifetime_net: -53335,
        sports_tickets: 297,
        sports_vol: 43949,
        sports_net: 10258,
      },
      {
        agent: "GOLD22",
        master: "BILLY666",
        total_accounts: 3,
        active_sports_accounts: 1,
        dormant_accounts: 2,
        lifetime_lost: -5000,
        lifetime_won: 15000,
        lifetime_net: 10000,
        sports_tickets: 1,
        sports_vol: 10000,
        sports_net: 10000,
      },
      {
        agent: "MACHR",
        master: "BILLY666",
        total_accounts: 1,
        active_sports_accounts: 1,
        dormant_accounts: 0,
        lifetime_lost: -102666,
        lifetime_won: 10000,
        lifetime_net: -92666,
        sports_tickets: 1,
        sports_vol: 10000,
        sports_net: 10000,
      },
      {
        agent: "TEXANS",
        master: "BILLY666",
        total_accounts: 50,
        active_sports_accounts: 11,
        dormant_accounts: 39,
        lifetime_lost: -239248,
        lifetime_won: 202425,
        lifetime_net: -36814,
        sports_tickets: 31,
        sports_vol: 11389,
        sports_net: 7936,
      },
      {
        agent: "AA2300C",
        master: "BILLY666",
        total_accounts: 25,
        active_sports_accounts: 3,
        dormant_accounts: 22,
        lifetime_lost: -125484,
        lifetime_won: 6600,
        lifetime_net: -118884,
        sports_tickets: 2,
        sports_vol: 6088,
        sports_net: 6600,
      },
    ],
  };
}

export function printHelp(): void {
  const helpMd = `
# SportsDesk & Fantasy402 Operations & Intelligence CLI (Bun v1.4+)
> Grounded in [Sports-desk-ops](https://github.com/bw496915-cmyk/Sports-desk-ops) • [Official API Reference](https://fantasy402-docs-4ay.pages.dev) • [Telegram Bot](https://t.me/demodevdeskbot)

Usage: \`bun sportsdesk_cli.ts [command|option] [parameters...]\`

### 1. SURVEILLANCE & LEADERBOARDS:
* **winners** [\`-p\` PERIOD] [\`--limit\` N] [\`--sort-by\` net|volume] [\`--format\` table|json|csv]
* **losers** [\`-p\` PERIOD] [\`--limit\` N] [\`--sort-by\` net|gross_hold] [\`--format\` table|json|csv]
* **leaderboard** [\`-p\` PERIOD] [\`--limit\` N] [\`--format\` table|json|csv]
  *(Periods: 24h, 48h, 7d, month, lifetime, all)*

### 2. CORE FORENSICS & SIMULATION:
* **-f, --forensics, --sharps, --audit-sharps**: Run forensic sharp audit (deficit drivers & playbooks)
* **-S, --simulate, --sim, --run-sim**: Run full 52-week dual-basis bettor churn simulation
* **-o, --onepass, --liability, --agent-risk**: Run streaming Agent OnePass 50% liability aggregator

### 3. HIERARCHY & SURVEILLANCE:
* **-k, --walk-tree, --tree** [AGENT_ID]: Walk downline tree and display customer snapshot telemetry
* **-C, --customer, --cust** <CUSTOMER_ID>: Lookup individual bettor profile across 9,435 accounts
* **-d, --downline, --agent** [AGENT_ID]: Query specific sub-agent volume and 50% hold share
* **-s, --summary**: Display executive master overview (668 agents, 9,435 bettors)

### 4. PLANE 3 INGESTION REPLAY:
* **replay** [\`--path\` FILE] [\`--pull-raw\` [URL]] [\`--pull-raw-only\`] [\`--channel\` CODE]...
  *(Self-healing JSONL replay; --pull-raw fetches source bytes before replay)*

### 5. CLOUDFLARE R2 & BACKUP:
* **r2 --info**: Display Cloudflare R2 bucket & [Public Gateway](https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev)
* **r2 --verify**: Verify Cloudflare API Token status via HTTPS REST API
* **r2 --sync** [DIR]: Sync report files to Cloudflare R2 bucket
* **r2 --list**: List remote report objects in R2 bucket

### 6. DOMAIN SPECIFICATIONS & TELEGRAM:
* **-b, --brands, --types**: Inspect 16 specification-grade nominal branded types
* **-N, --neurons, --layers**: Inspect 13-entity Qwen3.5-4B (Layers 18-28) neuron registry
* **-L, --lkeys, --l-keys**: Inspect complete L-key dictionary (Neuron Layers 18-28 & Manager DOM data-language keys)
* **-W, --writers, --ticket-writers**: Inspect TicketWriter ingestion channel contracts & wire exposure
* **-t, --telegram, --bot**: Launch Telegram Bot & Scheduled Reporting Service daemon
* **-A, --telegram-alert** [CUST_ID]: Dispatch instant watch list wager alert (default: RF2003)
* **-R, --telegram-report** [TYPE]: Dispatch executive report (MORNING_BRIEFING, MIDDAY_STEAM, EVENING_SETTLEMENT)

### 7. API DOCUMENTATION & WIRE SPEC:
* **docs** [\`--test\`] [\`--dry-run\`] [\`--project\` NAME]: Verify, stage, or deploy [Official API Portal](https://fantasy402-docs-4ay.pages.dev)

### 8. FANTASY402 WIRE OPERATIONS:
* **wire mutate** [\`-c\` CUST_ID] [\`-a\` AGENT_ID] [\`--col\` COL] [\`--val\` VAL]: Execute updateByColumn with 11-char padding & scope checks
* **wire vig** [\`-c\` CUST_ID] [\`-s\` SPORT] [\`--spread\` 15] [\`--derivative\` 20]: Set +15c/+20c vig shading via vigSetupInsert
* **wire weblog** [\`-m\` A|B|C|I] [\`-c\` CUST_ID] [\`--ip\` IP]: Query getWebLog IP Tracker across modes A, B, C, I
* **wire info** [\`-c\` CUST_ID]: Execute getInfoPlayer read-back verification

### 9. OPERATOR SURFACES (GSLive, stale lines, screenshots):
* **gslive** [LOGIN] [\`--date\` YYYY-MM-DD] [\`--json\`]: GSLive 7-param report + bet-history sidecar links
* **profile** <0x|username> [\`--json\`]: Polymarket PnL, win rate, positions, categories, strategy
* **combo** legs|price|wallet: CFB combo legs, product-of-legs pricing, wallet combo positions
* **bridge** coverage|value|match: cross-domain join between the customer book and Polymarket wallets
* **stale** \`-i\` FILE [\`--window-min\` N] [\`--json\`]: Stale-line / post-move bet cohort
* **shot** <URL> [\`--out\` PATH] [\`--f402-login\`] [\`--format\` png|jpeg|webp]: Bun.WebView screenshot (default \`scratch/shots/\`)
`;
  printAnsiMarkdown(helpMd);
  return;
}

export function printHelpOld(): void {
  console.log(`

1. SURVEILLANCE & LEADERBOARDS:
  winners [-p PERIOD] [--limit N] [--sort-by net|volume] [--format table|json|csv]
  losers [-p PERIOD] [--limit N] [--sort-by net|gross_hold] [--format table|json|csv]
  leaderboard [-p PERIOD] [--limit N] [--format table|json|csv]
      Periods: 24h, 48h, 7d, month, lifetime (or all)

2. CORE FORENSICS & SIMULATION:
  -f, --forensics, --sharps, --audit-sharps    Run forensic sharp audit (deficit drivers & playbooks)
  -S, --simulate, --sim, --run-sim            Run full 52-week dual-basis bettor churn simulation
  -o, --onepass, --liability, --agent-risk     Run streaming Agent OnePass 50% liability aggregator

3. HIERARCHY & SURVEILLANCE:
  -k, --walk-tree, --tree [AGENT_ID]          Walk downline tree and display customer snapshot telemetry
  -C, --customer, --cust <CUSTOMER_ID>        Lookup individual bettor profile across 9,435 accounts
  -d, --downline, --agent [AGENT_ID]          Query specific sub-agent volume and 50% hold share
  -s, --summary                               Display executive master overview (668 agents, 9,435 bettors)

4. PLANE 3 INGESTION REPLAY:
  replay [--path FILE] [--pull-raw [URL]] [--pull-raw-only] [--channel CODE] …
      Self-healing JSONL replay; --pull-raw fetches source bytes before replay

5. CLOUDFLARE R2 & BACKUP:
  r2 --info                                   Display Cloudflare R2 bucket & public gateway config
  r2 --verify                                 Verify Cloudflare API Token status via HTTPS REST API
  r2 --sync [DIR]                             Sync report files to Cloudflare R2 bucket
  r2 --list                                   List remote report objects in R2 bucket

6. DOMAIN SPECIFICATIONS & TELEGRAM:
  -b, --brands, --types                       Inspect 16 specification-grade nominal branded types
  -N, --neurons, --layers                     Inspect 13-entity Qwen3.5-4B (Layers 18-28) neuron registry
  -t, --telegram, --bot                       Launch Telegram Bot & Scheduled Reporting Service daemon
  -A, --telegram-alert [CUST_ID]              Dispatch instant watch list wager alert (default: RF2003)
  -R, --telegram-report [TYPE]                Dispatch executive report (MORNING_BRIEFING, MIDDAY_STEAM, EVENING_SETTLEMENT)

7. API DOCUMENTATION & WIRE SPEC:
  docs [--test] [--dry-run] [--project NAME]  Verify, stage, or deploy official OpenAPI 3.1 portal
`);
}

export function printDomainBrandedTypes(): void {
  console.log(
    "================================================================================",
  );
  console.log(
    "16 SPECIFICATION-GRADE NOMINAL BRANDED TYPES (domain-branded-types.ts)",
  );
  console.log(
    "================================================================================",
  );

  const testCents = parseAsCents(1330000);
  const testDollars = centsToDollars(testCents);
  const testCust = customerIdentifier("rf2003");
  const testPadded = padCustomerIdCanonical("rf2003");
  const testAgent = agentIdentifier("fakemoney");
  const testTicket = ticketIdentifier("rf2003", 894112);
  const testEpochSec = parseAsEpochSec(1793040268);
  const testEpochMs = parseAsEpochMs(1793040268000);
  const testColor = parseAsColorHexInt("#28a745");
  const testHexStr = colorHexIntToHexString(testColor);
  const testBetGroup = betGroupIdentifier("M.G908412 (GS 118)");
  const testLegs = parlayLegCount(3);
  const testRot = rotationNumber(451);
  const testOdds = parseAmericanOdds("-115");
  const testLine = formatHalfPointLine(-3.5);
  const testSharp = computeBayesSharp(86.2, 47);
  const testBps = parseAsBasisPoints(0.082);

  const tableRows = [
    {
      Type: "Cents",
      Primitive: "number",
      Constructor: "parseAsCents(1330000)",
      Value: String(testCents),
      Invariant: "Strict integer cents; SQLite storage unit",
    },
    {
      Type: "Dollars",
      Primitive: "number",
      Constructor: "centsToDollars(c)",
      Value: `${testDollars} USD`,
      Invariant: "Display-boundary float only; never in risk math",
    },
    {
      Type: "CustomerIdentifier",
      Primitive: "string",
      Constructor: 'customerIdentifier("rf2003")',
      Value: `"${testCust}"`,
      Invariant: "Trimmed uppercase login for queries & joins",
    },
    {
      Type: "PaddedCustomerId",
      Primitive: "string",
      Constructor: 'padCustomerIdCanonical("rf2003")',
      Value: `"${testPadded}"`,
      Invariant: "11-char space-padded for updateByColumn mutations",
    },
    {
      Type: "AgentIdentifier",
      Primitive: "string",
      Constructor: 'agentIdentifier("fakemoney")',
      Value: `"${testAgent}"`,
      Invariant: "Direct owning sub-agent (never BILLY666 on writes)",
    },
    {
      Type: "TicketIdentifier",
      Primitive: "string",
      Constructor: 'ticketIdentifier("RF2003", 894112)',
      Value: `"${testTicket}"`,
      Invariant: "Composite parent key ${login}|${wagerNumber}",
    },
    {
      Type: "EpochSec",
      Primitive: "number",
      Constructor: "parseAsEpochSec(1793040268)",
      Value: `${testEpochSec}s`,
      Invariant: "Whole seconds integer for SLA & delta joins",
    },
    {
      Type: "EpochMs",
      Primitive: "number",
      Constructor: "parseAsEpochMs(1793040268000)",
      Value: `${testEpochMs}ms`,
      Invariant: "High-resolution millisecond monotonic timestamp",
    },
    {
      Type: "ColorHexInt",
      Primitive: "number",
      Constructor: 'parseAsColorHexInt("#28a745")',
      Value: `${testColor} (${testHexStr})`,
      Invariant: "24-bit packed RGB integer; discards alpha by design",
    },
    {
      Type: "BetGroupIdentifier",
      Primitive: "string",
      Constructor: 'betGroupIdentifier("M.G908412")',
      Value: `"${testBetGroup}"`,
      Invariant: "Cross-book GS Buckeye Partner 118 join key",
    },
    {
      Type: "ParlayLegCount",
      Primitive: "number",
      Constructor: "parlayLegCount(3)",
      Value: `${testLegs}`,
      Invariant: "Proposition leg count integer strictly > 1 on GSBUILDER",
    },
    {
      Type: "RotationNumber",
      Primitive: "number",
      Constructor: "rotationNumber(451)",
      Value: `#${testRot}`,
      Invariant: "3-to-6 digit board rotation integer (100..999999)",
    },
    {
      Type: "AmericanOdds",
      Primitive: "number",
      Constructor: 'parseAmericanOdds("-115")',
      Value: `${testOdds}`,
      Invariant: "American odds validated outside [-99..+99] deadband",
    },
    {
      Type: "HalfPointLine",
      Primitive: "string",
      Constructor: "formatHalfPointLine(-3.5)",
      Value: `"${testLine}"`,
      Invariant: "ASCII/Unicode ½ (\\u00BD) hook preserved for parser",
    },
    {
      Type: "SharpScore",
      Primitive: "number",
      Constructor: "computeBayesSharp(86.2, 47)",
      Value: `${testSharp}`,
      Invariant: "Empirical Bayes shrunk score [0.00..100.00]",
    },
    {
      Type: "BasisPoints",
      Primitive: "number",
      Constructor: "parseAsBasisPoints(0.082)",
      Value: `${testBps} bps (8.20%)`,
      Invariant: "Integer basis points (100 bps = 1.00%, 10,000 = 100%)",
    },
  ];

  console.log(
    " # | Branded Type         | Primitive | Sample Constructor Output      | Domain Invariant Guarantee",
  );
  console.log(
    "---+----------------------+-----------+--------------------------------+-------------------------------------------------------",
  );
  tableRows.forEach((r, idx) => {
    const num = String(idx + 1).padStart(2);
    console.log(
      `${num} | ` +
        `${r.Type.padEnd(20)} | ` +
        `${r.Primitive.padEnd(9)} | ` +
        `${r.Value.padEnd(30)} | ` +
        `${r.Invariant}`,
    );
  });
  console.log(
    "================================================================================\n",
  );
}

export const QWEN_NEURON_TOKENS = ALL_QWEN_TOKENS;

export function printNeuronRegistry(): void {
  // 1. CI Integrity Assertion: Enforce 1-to-1 uniqueness across tokens, layers, and hex codes
  assertUniqueTokenColors(ALL_QWEN_TOKENS);

  const reset = "\x1b[0m";

  console.log(
    "========================================================================================================================",
  );
  console.log(
    "QWEN3.5-4B (LAYERS 18-28) NEURON REGISTRY & DECOUPLED THREE-AXIS ARCHITECTURE",
  );
  console.log(
    "========================================================================================================================",
  );

  // Table 1: Ingestion Signal Channels (Layers 18-24)
  console.log(
    "\n--- AXIS 1: INGESTION SIGNAL CHANNELS (LAYERS 18-24) • TRANSPORT SLA (ms / POLICY) ---",
  );
  console.log(
    " # | Layer ID    | CSS Token          | Hex Code | ANSI Preview  | Channel Code | SLA Policy & Target | Status     | Twin / Volume Rule",
  );
  console.log(
    "---+-------------+--------------------+----------+---------------+--------------+---------------------+------------+------------------------------------------",
  );
  INGESTION_CHANNELS.forEach((n, idx) => {
    const num = String(idx + 1).padStart(2);
    const ansi = Bun.color(n.hex, "ansi-16m") ?? "";
    const preview = `${ansi}████████${reset}`;
    const slaStr =
      n.sla.kind === "latency"
        ? `${n.sla.latencySlaMs.toLocaleString()} ms (Latency)`
        : "POLICY_DROP (Sentinel)";
    console.log(
      `${num} | ` +
        `${n.layerId.padEnd(11)} | ` +
        `${n.tokenName.padEnd(18)} | ` +
        `${n.hex.padEnd(8)} | ` +
        `${preview.padEnd(17)} | ` +
        `${n.channelCode.padEnd(12)} | ` +
        `${slaStr.padEnd(21)} | ` +
        `${n.channelStatus.padEnd(10)} | ` +
        `${n.volumeRule}`,
    );
  });

  // Table 2: Risk Decision & Route Continuum (Layers 25-28)
  console.log(
    "\n--- AXIS 2: RISK DECISION & ROUTE CONTINUUM (LAYERS 25-28) • TYPED THRESHOLDS & DIRECTIVES ---",
  );
  console.log(
    " # | Layer ID    | CSS Token          | Hex Code | ANSI Preview  | Decision Route              | Move Flag           | Trigger Predicate    | Algorithmic Threshold       | Directive Action",
  );
  console.log(
    "---+-------------+--------------------+----------+---------------+-----------------------------+---------------------+----------------------+-----------------------------+-----------------------",
  );
  ROUTE_CIRCUITS.forEach((n, idx) => {
    const num = String(idx + 8).padStart(2);
    const ansi = Bun.color(n.hex, "ansi-16m") ?? "";
    const preview = `${ansi}████████${reset}`;

    let threshStr = "";
    if (n.threshold.kind === "consensus_lag") {
      threshStr = `Lag <= ${n.threshold.maxLagMs.toLocaleString()} ms`;
    } else if (n.threshold.kind === "bayes_shrinkage") {
      threshStr = `tau* = ${n.threshold.tauStar}, N >= ${n.threshold.minTickets}`;
    } else if (n.threshold.kind === "liquidity_depth") {
      threshStr = `Depth < $${(n.threshold.minDepthCents / 100).toLocaleString()}`;
    } else if (n.threshold.kind === "composite_risk_gate") {
      threshStr = `Tox >= ${n.threshold.minToxicityScore} || Hold <= ${n.threshold.maxHoldRateBasisPoints / 100}%`;
    }

    console.log(
      `${num} | ` +
        `${n.layerId.padEnd(11)} | ` +
        `${n.tokenName.padEnd(18)} | ` +
        `${n.hex.padEnd(8)} | ` +
        `${preview.padEnd(17)} | ` +
        `${n.routeName.padEnd(27)} | ` +
        `${n.moveFlag.padEnd(19)} | ` +
        `${n.triggerKind.padEnd(20)} | ` +
        `${threshStr.padEnd(27)} | ` +
        `${n.mitigationKind}`,
    );
  });

  // Table 3: Telemetry Viewports & Rendering Surfaces
  console.log("\n--- AXIS 3: TELEMETRY VIEWPORTS & RENDERING SURFACES ---");
  console.log(
    " # | Surface ID   | CSS Token          | Hex Code | ANSI Preview  | Surface Name                 | Target Viewport / Protocol                | Color Depth",
  );
  console.log(
    "---+--------------+--------------------+----------+---------------+------------------------------+-------------------------------------------+-----------------------",
  );
  TELEMETRY_SURFACES.forEach((n, idx) => {
    const num = String(idx + 12).padStart(2);
    const ansi = Bun.color(n.hex, "ansi-16m") ?? "";
    const preview = `${ansi}████████${reset}`;
    console.log(
      `${num} | ` +
        `${n.layerId.padEnd(12)} | ` +
        `${n.tokenName.padEnd(18)} | ` +
        `${n.hex.padEnd(8)} | ` +
        `${preview.padEnd(17)} | ` +
        `${n.surfaceName.padEnd(28)} | ` +
        `${n.targetViewport.padEnd(41)} | ` +
        `${n.colorDepth}`,
    );
  });
  console.log(
    "========================================================================================================================\n",
  );
}

export function printLKeyDictionary(): void {
  const reset = "\x1b[0m";

  console.log(
    "========================================================================================================================",
  );
  console.log(
    "L-KEY DICTIONARY: QWEN3.5-4B NEURON TOKENS (LAYERS 18-28) & FANTASY402 MANAGER DOM LOCALIZATION",
  );
  console.log(
    "========================================================================================================================",
  );

  console.log(
    "\n--- PART 1: NEURON LAYER TOKENS (LAYERS 18-28) • COLOR SWATCHES & OPERATIONAL ROLES ---",
  );
  console.log(
    " Token ID    | Channel / Route      | Hex Code | ANSI Swatch   | Latency / Gate Threshold | Operational Role",
  );
  console.log(
    "-------------+----------------------+----------+---------------+--------------------------+-------------------------------------------------------",
  );

  const neuronRows = [
    {
      id: "L18.N0204",
      chan: "Internet",
      hex: "#1d84b5",
      gate: "1,500 ms SLA",
      role: "Retail pregame baseline; target twin counterpart",
    },
    {
      id: "L19.N0518",
      chan: "BLOCKED",
      hex: "#64748b",
      gate: "Sentinel Drop",
      role: "Noise sentinel; dropped before parent ticket grouping",
    },
    {
      id: "L20.N1105",
      chan: "GATEWAY",
      hex: "#10b981",
      gate: "1,000 ms SLA",
      role: "Equilibrium sweep; monitors hold & +15c/+20c vig persist",
    },
    {
      id: "L21.N0884",
      chan: "ALERT",
      hex: "#ef4444",
      gate: "250 ms SLA",
      role: "Syndicate alert twin; canonicalVolumeCents = 0 buffer",
    },
    {
      id: "L22.N1402",
      chan: "GSBUILDER",
      hex: "#f59e0b",
      gate: "1,000 ms SLA",
      role: "Same-game prop builder; M.G<id> join; steerable",
    },
    {
      id: "L23.N0412",
      chan: "GSLIVE",
      hex: "#28a745",
      gate: "500 ms SLA",
      role: "In-play whale sizing ($2k+); M.G<id>; +20c vig tax",
    },
    {
      id: "L24.N2019",
      chan: "CSLEVEL2",
      hex: "#38bdf8",
      gate: "2,000 ms SLA",
      role: "Clerk telephone orders; longshot recreational bias",
    },
    {
      id: "L25.N1882",
      chan: "--sd-route-devig",
      hex: "#06b6d4",
      gate: "Lag <= 5,000 ms",
      role: "Steam convergence; consensus devig reprice",
    },
    {
      id: "L26.N3104",
      chan: "--sd-route-sharp",
      hex: "#a855f7",
      gate: "tau*=0.68, N>=8",
      role: "Online Empirical Bayes sharp shrinkage detector",
    },
    {
      id: "L27.N0912",
      chan: "--sd-route-pending",
      hex: "#d97706",
      gate: "Depth < $1,000",
      role: "Liquidity exhaustion circuit breaker trip",
    },
    {
      id: "L28.N2501",
      chan: "--sd-route-manager",
      hex: "#f43f5e",
      gate: "MFCS >= 80",
      role: "Terminal execution write-gate; 6s delay & limit clamp",
    },
  ];

  neuronRows.forEach((n) => {
    let ansi = "";
    try {
      if (typeof Bun !== "undefined") {
        ansi = Bun.color(n.hex, "ansi-16m") ?? "";
      }
    } catch {}
    const swatch = `${ansi}████████${reset}`;
    console.log(
      `${n.id.padEnd(12)} | ` +
        `${n.chan.padEnd(20)} | ` +
        `${n.hex.padEnd(8)} | ` +
        `${swatch.padEnd(15)} | ` +
        `${n.gate.padEnd(24)} | ` +
        `${n.role}`,
    );
  });

  console.log(
    '\n--- PART 2: FANTASY402 MANAGER DOM LOCALIZATION KEYS (data-language="L-xxxx") ---',
  );
  console.log(
    " DOM L-Key  | DOM Header / Element | Wire Mapping Property | Purpose & Telemetry Binding",
  );
  console.log(
    "------------+----------------------+-----------------------+----------------------------------------------------------------------",
  );

  const domRows = [
    {
      key: "L-1029",
      label: "Source",
      prop: "TicketWriter",
      desc: "Channel discriminator (Internet, ALERT, GSLIVE, GSBUILDER, CSLEVEL2)",
    },
    {
      key: "L-1028",
      label: "Ticket #",
      prop: "WagerNumber",
      desc: "Monotonic parent wager ID; half of composite key ${Login}|${WagerNumber}",
    },
    {
      key: "L-1031",
      label: "Player / Account",
      prop: "Login / customerID",
      desc: "Customer login; trimmed for queries, 11-char space-padded on writes",
    },
    {
      key: "L-1032",
      label: "Agent",
      prop: "agentOwner / agentID",
      desc: "Direct owning sub-agent hierarchy; prevents REJECTED_SCOPE (-1)",
    },
    {
      key: "L-1033",
      label: "Date / Time",
      prop: "PlacedTimestamp",
      desc: "Placed timestamp (UTC); calculates post-login dwell velocity (<15s)",
    },
    {
      key: "L-1034",
      label: "Sport",
      prop: "SportType",
      desc: "Sport name; padded to strictly 20 chars on vigSetupInsert",
    },
    {
      key: "L-1035",
      label: "Description",
      prop: "ShortDesc",
      desc: "Market description, ShortDesc[0] code, <br> legs, M.G<id> headers",
    },
    {
      key: "L-1036",
      label: "Risk",
      prop: "Risk",
      desc: "Stake in USD; integer Cents in SQLite; zeroed out on ALERT slips",
    },
    {
      key: "L-1037",
      label: "To Win",
      prop: "Win / ToWin",
      desc: "Potential payout in USD; integer Cents in SQLite",
    },
    {
      key: "L-1038",
      label: "Result / Status",
      prop: "Result / Status",
      desc: "Resolution status (Pending, Won, Lost, Pushed, Canceled)",
    },
    {
      key: "L-1039",
      label: "IP Address",
      prop: "ipAddress",
      desc: "Client auth IP; feeds Mode B global matcher and /24 subnet clustering",
    },
    {
      key: "L-1040",
      label: "Delay",
      prop: "Delay",
      desc: "Dynamic delay gate in seconds; mutated via updateByColumn (0s to 15s)",
    },
    {
      key: "L-1045",
      label: "Balance",
      prop: "CurrentBalance",
      desc: "Player outstanding balance; verified via getInfoPlayer read-back",
    },
    {
      key: "L-1050",
      label: "Weekly Total",
      prop: "grandTotalWeekly",
      desc: "Mobile header KPI; verified against Report/getWeeklyFigure",
    },
  ];

  domRows.forEach((d) => {
    console.log(
      `${d.key.padEnd(11)} | ` +
        `${d.label.padEnd(20)} | ` +
        `${d.prop.padEnd(21)} | ` +
        `${d.desc}`,
    );
  });

  console.log(
    "========================================================================================================================\n",
  );
}

export function printTicketWriters(): void {
  const reset = "\x1b[0m";

  console.log(
    "========================================================================================================================",
  );
  console.log(
    "FANTASY402 TICKETWRITER INGESTION CHANNELS & WIRE CONTRACT MATRIX",
  );
  console.log(
    "========================================================================================================================",
  );

  console.log(
    " Channel Name | Neuron Layer | Hex Code | ANSI Swatch   | ShortDesc[0] | SLA Target | Volume Rule (Cents) | Core Forensic Exposure",
  );
  console.log(
    "--------------+--------------+-----------+---------------+--------------+------------+---------------------+---------------------------------------------------",
  );

  const writerRows = [
    {
      name: "Internet",
      layer: "L18.N0204",
      hex: "#1d84b5",
      code: "S,P,T,C,E",
      sla: "1,500 ms",
      vol: "min(Risk, Win)",
      desc: "Retail pregame baseline; target twin counterpart",
    },
    {
      name: "ALERT",
      layer: "L21.N0884",
      hex: "#ef4444",
      code: "S,P,L,G,M",
      sla: "250 ms",
      vol: "STRICTLY 0",
      desc: "Syndicate sub-account mirror; gapDurationSeconds <= 6s",
    },
    {
      name: "GSLIVE",
      layer: "L23.N0412",
      hex: "#28a745",
      code: "M (tick)/G (pend)",
      sla: "500 ms",
      vol: "min(Risk, Win)",
      desc: "In-play whale sizing; M.G<id> header; empty Team/Line; +20c vig",
    },
    {
      name: "GSBUILDER",
      layer: "L22.N1402",
      hex: "#f59e0b",
      code: "C,M,P",
      sla: "1,000 ms",
      vol: "min(Risk, Win)",
      desc: "Same-Game Parlay builder; <br> delimited legs; correlated props",
    },
    {
      name: "CSLEVEL2",
      layer: "L24.N2019",
      hex: "#38bdf8",
      code: "L,S,C,E",
      sla: "2,000 ms",
      vol: "min(Risk, Win)",
      desc: "Clerk telephone desk entries; doubles tennis; longshot bias",
    },
    {
      name: "BLOCKED",
      layer: "L19.N0518",
      hex: "#64748b",
      code: "Empty / any",
      sla: "DROP",
      vol: "DROPPED (0)",
      desc: "Noise filter sentinel; must drop before multi-leg grouping",
    },
    {
      name: "GATEWAY",
      layer: "L20.N1105",
      hex: "#10b981",
      code: "Empty",
      sla: "1,000 ms",
      vol: "DIAGNOSTIC",
      desc: "Equilibrium telemetry; verifies +15c/+20c vig persist read-backs",
    },
  ];

  writerRows.forEach((w) => {
    let ansi = "";
    try {
      if (typeof Bun !== "undefined") {
        ansi = Bun.color(w.hex, "ansi-16m") ?? "";
      }
    } catch {}
    const swatch = `${ansi}████████${reset}`;
    console.log(
      `${w.name.padEnd(13)} | ` +
        `${w.layer.padEnd(12)} | ` +
        `${w.hex.padEnd(9)} | ` +
        `${swatch.padEnd(15)} | ` +
        `${w.code.padEnd(12)} | ` +
        `${w.sla.padEnd(10)} | ` +
        `${w.vol.padEnd(19)} | ` +
        `${w.desc}`,
    );
  });

  console.log(
    "========================================================================================================================\n",
  );
}

export function printWinners(args: string[]): void {
  const period = getArgValue(args, ["-p", "--period"], "24h");
  const limit = parseInt(getArgValue(args, ["--limit"], "10"), 10);
  const format = getArgValue(args, ["--format"], "table");

  const winnersData = [
    {
      rank: 1,
      customerId: "BGD101",
      agentId: "BIGDAD",
      league: "NFL",
      market: "SPREAD",
      tickets: 2,
      volumeUSD: 40000,
      netUSD: 40000,
      winPct: 100.0,
      details: "NFL • 2 Max Spread Bets (-110)",
    },
    {
      rank: 2,
      customerId: "MJ102",
      agentId: "MJ2026",
      league: "CFB",
      market: "MONEYLINE",
      tickets: 1,
      volumeUSD: 20000,
      netUSD: 30000,
      winPct: 100.0,
      details: "CFB • Underdog ML (+150)",
    },
    {
      rank: 3,
      customerId: "GX195",
      agentId: "GOLD22",
      league: "NFL",
      market: "SPREAD",
      tickets: 1,
      volumeUSD: 10000,
      netUSD: 10000,
      winPct: 100.0,
      details: "NFL • KC Chiefs -3½",
    },
    {
      rank: 4,
      customerId: "PEY101",
      agentId: "MACHR",
      league: "CFB",
      market: "MONEYLINE",
      tickets: 1,
      volumeUSD: 10000,
      netUSD: 10000,
      winPct: 100.0,
      details: "CFB • Heavy Favorite Lock ML",
    },
    {
      rank: 5,
      customerId: "GP300",
      agentId: "GPRO50RSK",
      league: "NFL",
      market: "LIVE",
      tickets: 5,
      volumeUSD: 12000,
      netUSD: 8500,
      winPct: 80.0,
      details: "NFL • In-Play Under 41½",
    },
    {
      rank: 6,
      customerId: "TEX500",
      agentId: "TEXANS",
      league: "NFL",
      market: "SPREAD",
      tickets: 2,
      volumeUSD: 8000,
      netUSD: 8000,
      winPct: 100.0,
      details: "NFL • 2 Straight Point Spreads",
    },
    {
      rank: 7,
      customerId: "AL1279",
      agentId: "AA2300C",
      league: "NBA",
      market: "TOTAL",
      tickets: 2,
      volumeUSD: 6000,
      netUSD: 6600,
      winPct: 100.0,
      details: "NBA • Over 224½ Points",
    },
    {
      rank: 8,
      customerId: "DAN245",
      agentId: "DAN318",
      league: "NBA",
      market: "SPREAD",
      tickets: 3,
      volumeUSD: 6000,
      netUSD: 6000,
      winPct: 100.0,
      details: "NBA • Boston Celtics -6½",
    },
  ];

  if (format === "json") {
    console.log(JSON.stringify(winnersData.slice(0, limit), null, 2));
    return;
  }

  if (format === "csv") {
    console.log(
      "Rank,CustomerID,AgentID,League,Market,Tickets,VolumeUSD,NetUSD,WinPct,Details",
    );
    winnersData.slice(0, limit).forEach((w) => {
      console.log(
        `${w.rank},${w.customerId},${w.agentId},${w.league},${w.market},${w.tickets},${w.volumeUSD},${w.netUSD},${w.winPct},"${w.details}"`,
      );
    });
    return;
  }

  console.log(
    "================================================================================",
  );
  console.log(
    `BIGGEST WINNERS (HOUSE LEAKAGES) • PERIOD: ${period.toUpperCase()}`,
  );
  console.log(
    "================================================================================",
  );
  console.log(
    " # | Bettor ID   | Owning Agent | League | Market    | Tix | Volume ($)    | Net P&L ($)     | Win %  | Market Details",
  );
  console.log(
    "---+-------------+--------------+--------+-----------+-----+---------------+-----------------+--------+-----------------------------",
  );
  winnersData.slice(0, limit).forEach((w) => {
    const netStr = `+$${w.netUSD.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    const volStr = `$${w.volumeUSD.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    console.log(
      `${String(w.rank).padStart(2)} | ` +
        `${w.customerId.padEnd(11)} | ` +
        `${w.agentId.padEnd(12)} | ` +
        `${w.league.padEnd(6)} | ` +
        `${w.market.padEnd(9)} | ` +
        `${String(w.tickets).padStart(3)} | ` +
        `${volStr.padStart(13)} | ` +
        `${netStr.padStart(15)} | ` +
        `${w.winPct.toFixed(1).padStart(5)}% | ` +
        `${w.details}`,
    );
  });
  console.log(
    "================================================================================\n",
  );
}

export function printLosers(args: string[]): void {
  const period = getArgValue(args, ["-p", "--period"], "48h");
  const limit = parseInt(getArgValue(args, ["--limit"], "10"), 10);
  const format = getArgValue(args, ["--format"], "table");

  const losersData = [
    {
      rank: 1,
      customerId: "RF2003",
      agentId: "FAKEMONEY",
      league: "NFL",
      market: "SPREAD",
      tickets: 47,
      volumeUSD: 940000,
      netUSD: -1006530,
      grossHold: 1006530,
      details: "Lifetime Whale Loss Pillar",
    },
    {
      rank: 2,
      customerId: "STEIN_P04",
      agentId: "STEIN421",
      league: "NFL",
      market: "SPREAD",
      tickets: 8,
      volumeUSD: 32000,
      netUSD: -14200,
      grossHold: 14200,
      details: "NFL • Stale Numbers",
    },
    {
      rank: 3,
      customerId: "FAT_P02",
      agentId: "FATSSIDE",
      league: "NFL",
      market: "MONEYLINE",
      tickets: 3,
      volumeUSD: 18000,
      netUSD: -12000,
      grossHold: 12000,
      details: "NFL • Heavy Favorite ML",
    },
    {
      rank: 4,
      customerId: "SHELBY_P01",
      agentId: "SHELBY101",
      league: "CFB",
      market: "SPREAD",
      tickets: 6,
      volumeUSD: 6200,
      netUSD: -4600,
      grossHold: 4600,
      details: "CFB • Dog Spreads",
    },
    {
      rank: 5,
      customerId: "CUB_P15",
      agentId: "CUB22A",
      league: "NBA",
      market: "LIVE",
      tickets: 11,
      volumeUSD: 5500,
      netUSD: -3800,
      grossHold: 3800,
      details: "NBA • Live Spreads",
    },
  ];

  if (format === "json") {
    console.log(JSON.stringify(losersData.slice(0, limit), null, 2));
    return;
  }

  if (format === "csv") {
    console.log(
      "Rank,CustomerID,AgentID,League,Market,Tickets,VolumeUSD,NetUSD,GrossHold,Details",
    );
    losersData.slice(0, limit).forEach((l) => {
      console.log(
        `${l.rank},${l.customerId},${l.agentId},${l.league},${l.market},${l.tickets},${l.volumeUSD},${l.netUSD},${l.grossHold},"${l.details}"`,
      );
    });
    return;
  }

  console.log(
    "================================================================================",
  );
  console.log(
    `BIGGEST LOSERS (HOUSE HOLD GENERATORS) • PERIOD: ${period.toUpperCase()}`,
  );
  console.log(
    "================================================================================",
  );
  console.log(
    " # | Bettor ID   | Owning Agent | League | Market    | Tix | Volume ($)    | Net House Hold ($) | Context / Playbook",
  );
  console.log(
    "---+-------------+--------------+--------+-----------+-----+---------------+--------------------+-----------------------------",
  );
  losersData.slice(0, limit).forEach((l) => {
    const netStr = `-$${Math.abs(l.netUSD).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    const volStr = `$${l.volumeUSD.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    console.log(
      `${String(l.rank).padStart(2)} | ` +
        `${l.customerId.padEnd(11)} | ` +
        `${l.agentId.padEnd(12)} | ` +
        `${l.league.padEnd(6)} | ` +
        `${l.market.padEnd(9)} | ` +
        `${String(l.tickets).padStart(3)} | ` +
        `${volStr.padStart(13)} | ` +
        `${netStr.padStart(18)} | ` +
        `${l.details}`,
    );
  });
  console.log(
    "================================================================================\n",
  );
}

export function printLeaderboard(args: string[]): void {
  const period = getArgValue(args, ["-p", "--period"], "month");

  console.log(
    "================================================================================",
  );
  console.log(`DUAL-SIDED P&L LEADERBOARD • PERIOD: ${period.toUpperCase()}`);
  console.log(
    "================================================================================",
  );
  console.log("TOP 5 WINNERS (LEAKAGES):");
  printWinners(["-p", period, "--limit", "5"]);
  console.log("TOP 5 LOSERS (HOUSE HOLD):");
  printLosers(["-p", period, "--limit", "5"]);
}

function getArgValue(
  args: string[],
  flags: string[],
  defaultValue: string,
): string {
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag !== undefined && flags.includes(flag) && value !== undefined) {
      return value;
    }
  }
  return defaultValue;
}

export async function handleWireCommand(args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase();
  if (sub === "mutate" || sub === "mutation" || sub === "update") {
    const custId = getArgValue(
      args,
      ["-c", "--customer", "--customer-id"],
      "CB112_1",
    );
    const agentId = getArgValue(
      args,
      ["-a", "--agent", "--agent-owner"],
      "CUB22HR",
    );
    const col = getArgValue(
      args,
      ["--col", "--column"],
      "confirmationDelaySeconds",
    );
    const val = getArgValue(args, ["--val", "--value"], "5");
    const verify = !args.includes("--no-verify");

    console.log(
      `[Wire Mutation] Executing updateByColumn for ${custId} (Agent: ${agentId}, Col: ${col}, Val: ${val})...`,
    );
    try {
      const res = await executePlayerColumnMutation({
        customerIdentifier: custId,
        agentOwnerIdentifier: agentId,
        column: col,
        value: val,
        verifyReadBack: verify,
      });
      console.log(
        `[Wire Mutation] Classification: ${res.classification} (Committed: ${res.isCommitted}, ReadBack: ${res.readBackVerified})`,
      );
      console.log(`  Customer (padded) : "${res.customerId}"`);
      console.log(`  Agent Owner       : "${res.agentOwner}"`);
      console.log(`  Column / Value    : ${res.column} = ${res.value}`);
    } catch (err) {
      console.error(
        `[Wire Mutation Error] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = err instanceof WirePayloadError ? err.exitCode : 1;
    }
    return;
  }

  if (sub === "vig" || sub === "vig-setup" || sub === "vigsetup") {
    const custId = getArgValue(
      args,
      ["-c", "--customer", "--customer-id"],
      "CB112_1",
    );
    const sport = getArgValue(args, ["-s", "--sport"], "Football");
    const spread = getArgValue(args, ["--spread"], "15");
    const deriv = getArgValue(args, ["--derivative"], "20");
    const verify = !args.includes("--no-verify");

    console.log(
      `[Wire Vig] Executing vigSetupInsert for ${custId} (${sport}, +${spread}c spread, +${deriv}c derivative)...`,
    );
    try {
      const res = await executeVigSetupInsert({
        customerIdentifier: custId,
        sportType: sport,
        vigSpread: spread,
        vigDerivative: deriv,
        verifyReadBack: verify,
      });
      console.log(
        `[Wire Vig] Success: ${res.success} (ReadBack: ${res.readBackVerified})`,
      );
      console.log(`  Sport (20-pad)    : "${res.sportType}"`);
      console.log(`  Player (11-pad)   : "${res.player}"`);
      console.log(
        `  Vig Spread / Deriv: +${res.vigSpread}c / +${res.vigDerivative}c`,
      );
    } catch (err) {
      console.error(
        `[Wire Vig Error] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "weblog" || sub === "ip-tracker" || sub === "iptracker") {
    const mode = getArgValue(args, ["-m", "--mode"], "B").toUpperCase() as
      "A" | "B" | "C" | "I";
    const custId = getArgValue(args, ["-c", "--customer"], "0");
    const ip = getArgValue(args, ["--ip"], "");
    console.log(
      `[Wire IP Tracker] Querying getWebLog mode ${mode} (Customer: ${custId}, IP: ${ip || "ALL"})...`,
    );
    try {
      const res = await queryIpTrackerWebLog({
        mode,
        customerId: custId,
        ip,
      });
      console.log(
        `[Wire IP Tracker] Mode ${res.mode} returned ${res.rowCount} row(s) at ${res.queryTimestamp}`,
      );
    } catch (err) {
      console.error(
        `[Wire IP Tracker Error] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "info" || sub === "player") {
    const custId = getArgValue(args, ["-c", "--customer"], "CB112_1");
    console.log(`[Wire Read-Back] Fetching getInfoPlayer for ${custId}...`);
    try {
      const res = await fetchPlayerInfo({ customerIdentifier: custId });
      console.log(`[Wire Read-Back] Result:`, res);
    } catch (err) {
      console.error(
        `[Wire Read-Back Error] ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "gslive" || sub === "gs-live") {
    const custId = getArgValue(args, ["-c", "--customer"], "CHURN_003");
    const dateYmd = getArgValue(args, ["--date"], "");
    const desc = buildGsLiveDualSurfaceDescriptor(custId, {
      ...(dateYmd ? { dateYmd } : {}),
      tickEpochMs: Date.now(),
    });
    console.log(JSON.stringify(desc, null, 2));
    return;
  }

  console.log(`
Usage: bun sportsdesk_cli.ts wire <subcommand> [options]

Subcommands:
  mutate   Execute updateByColumn mutation (-c <CUST_ID> -a <AGENT_ID> --col <COL> --val <VAL>)
  vig      Execute vigSetupInsert (+15c/+20c) (-c <CUST_ID> -s <SPORT> --spread 15 --derivative 20)
  weblog   Query getWebLog IP Tracker (-m A|B|C|I -c <CUST_ID> --ip <IP>)
  info     Fetch getInfoPlayer read-back (-c <CUST_ID>)
  gslive   Emit GSLive 7-param deep-link & live sidecar JSON (-c <CUST_ID> --date YYYY-MM-DD)
`);
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0) {
    printHelp();
    return;
  }

  const cmdArg = rawArgs[0];
  if (cmdArg === undefined) {
    printHelp();
    return;
  }
  const cmd = cmdArg.toLowerCase();

  if (cmd === "wire" || rawArgs.includes("--wire")) {
    await handleWireCommand(rawArgs.slice(1));
    return;
  }

  if (cmd === "modes" || cmd === "mode" || rawArgs.includes("--modes")) {
    const snap = buildTenModeLiveSnapshot();
    const modeFilterArg =
      rawArgs[1] && !rawArgs[1].startsWith("-") ? Number(rawArgs[1]) : null;
    if (rawArgs.includes("--json")) {
      console.log(JSON.stringify(snap, null, 2));
      return;
    }
    console.log(
      "========================================================================================================================",
    );
    console.log(
      "  🔬 10-MODE FORENSIC, RISK, CROSS-MARKET & DATA INTEGRITY ENGINE (Modes 1..10)",
    );
    console.log(
      "========================================================================================================================",
    );
    for (const spec of TEN_MODE_CATALOG) {
      if (modeFilterArg && spec.modeNumber !== modeFilterArg) continue;
      console.log(
        `  [${spec.domain.padEnd(18)}] ${spec.modeLabel.padEnd(25)} | Checks: ${spec.checksSummary.padEnd(55)} | Output: ${spec.outputSummary}`,
      );
    }
    console.log(
      "========================================================================================================================",
    );
    return;
  }

  if (cmd === "combo") {
    const { runPolymarketCombo } =
      await import("../scripts/polymarket_combo_cli.ts");
    await runPolymarketCombo(rawArgs.slice(1));
    return;
  }

  if (cmd === "profile") {
    const { runPolymarketProfile } =
      await import("../scripts/polymarket_profile_cli.ts");
    await runPolymarketProfile(rawArgs.slice(1));
    return;
  }

  if (cmd === "bridge" || cmd === "crossdomain") {
    const { runCustomerBridge } =
      await import("../scripts/customer_bridge_cli.ts");
    await runCustomerBridge(rawArgs.slice(1));
    return;
  }

  if (cmd === "shot" || cmd === "screenshot") {
    const { runWebviewShot } = await import("../scripts/webview_shot_cli.ts");
    await runWebviewShot(rawArgs.slice(1));
    return;
  }

  if (
    cmd === "gslive" ||
    cmd === "gs-live" ||
    rawArgs.includes("--gslive") ||
    rawArgs.includes("-G")
  ) {
    // Flags that consume the next token; skip both so `--date 2026-11-01 MJ102` resolves MJ102.
    const gsliveFlagValues = new Set(["-c", "--customer", "--date"]);
    let positionalLogin: string | undefined;
    const gsliveArgs = rawArgs.slice(1);
    for (let index = 0; index < gsliveArgs.length; index += 1) {
      const arg = gsliveArgs[index]!;
      if (gsliveFlagValues.has(arg)) {
        index += 1;
        continue;
      }
      if (arg.startsWith("-")) continue;
      positionalLogin = arg;
      break;
    }
    const targetLogin =
      positionalLogin ||
      getArgValue(rawArgs, ["-c", "--customer"], "CHURN_003");
    const dateYmd = getArgValue(rawArgs, ["--date"], "");
    const desc = buildGsLiveDualSurfaceDescriptor(targetLogin, {
      ...(dateYmd ? { dateYmd } : {}),
      tickEpochMs: Date.now(),
    });
    if (rawArgs.includes("--json")) {
      console.log(JSON.stringify(desc, null, 2));
      return;
    }
    console.log(
      "========================================================================================================================",
    );
    console.log(
      `  🎯 GSLIVE MANAGER (PARTNER 118) DUAL-SURFACE DEEP-LINK & LIVE SIDECAR (${desc.gsLivePlayerId})`,
    );
    console.log(
      "========================================================================================================================",
    );
    console.log(
      "  1. CANONICAL 7-PARAMETER #/reports/users DEEP LINKS (bot=true + desk-day ISO window, America/Chicago):",
    );
    console.log(`     • 7-Day Window  : ${desc.usersReportDeepLink7Day}`);
    console.log(`     • 14-Day Window : ${desc.usersReportDeepLink14Day}`);
    console.log(
      `     • Churn Window  : ${desc.usersReportChurnWindowDeepLink}`,
    );
    console.log(
      "  2. LIVE POPULATING #/events/bet-history SIDECAR STREAM (desk-day window, minVolume=0, DST-aware toTime):",
    );
    console.log(
      `     • Live calcTime : ${desc.liveBetHistorySidecarCalcTimeUrl}`,
    );
    console.log(
      `     • Live betTime  : ${desc.liveBetHistorySidecarBetTimeUrl}`,
    );
    console.log(`     • Player Filter : ${desc.playerBetHistoryDeepLinkUrl}`);
    console.log(
      "  3. API DOCS: ./bin/dx docs gslive  ·  Scalar: https://fantasy402-docs-4ay.pages.dev/",
    );
    console.log(
      "========================================================================================================================",
    );
    return;
  }

  if (
    cmd === "iptracker" ||
    cmd === "ip-tracker" ||
    rawArgs.includes("--iptracker")
  ) {
    const officeFilter = getArgValue(
      rawArgs,
      ["--office", "-a"],
      "ALL",
    ).toUpperCase();
    const clusters = PER_OFFICE_IP_TRACKER_CLUSTERS.filter(
      (c) => officeFilter === "ALL" || c.officeAgentId === officeFilter,
    );
    if (rawArgs.includes("--json")) {
      console.log(JSON.stringify(clusters, null, 2));
      return;
    }
    console.log(
      "================================================================================================================",
    );
    console.log(
      "  🌐 BET-TICKER <-> IP-TRACKER (getWebLog Modes A/B/C/I) PER-OFFICE & CROSS-OFFICE MATCH REPORT",
    );
    console.log(
      "================================================================================================================",
    );
    for (const c of clusters) {
      const payload = buildPerOfficeIpMatcherPayload({
        officeAgentId: c.officeAgentId,
      });
      const cross = c.crossOfficeLogins.length
        ? " | Cross-Office: " +
          c.crossOfficeLogins
            .map((x) => x.officeAgentId + "/" + x.loginId)
            .join(", ")
        : "";
      console.log(
        `  • Office: ${c.officeAgentId.padEnd(10)} [Mode B customerID="${payload.customerID}"] | ${c.matchClassification.padEnd(32)} | IP: ${c.sharedIpOrSubnet.padEnd(28)} | Dwell: ${c.modeASessionDwellSeconds}s | MFCS: ${c.mfcsCompositeScore}/100 | Logins: ${c.matchedLoginsInOffice.join(", ")}${cross}`,
      );
    }
    console.log(
      "================================================================================================================",
    );
    return;
  }

  if (cmd === "winners" || cmd === "win") {
    printWinners(rawArgs.slice(1));
    return;
  }

  if (cmd === "losers" || cmd === "lose") {
    printLosers(rawArgs.slice(1));
    return;
  }

  if (cmd === "leaderboard" || cmd === "board") {
    printLeaderboard(rawArgs.slice(1));
    return;
  }

  if (cmd === "replay" || cmd === "ingestion-replay") {
    const replayArgs = ["bun", "run", "cli/sportsdesk_replay_cli.ts"];
    for (const a of rawArgs.slice(1)) replayArgs.push(a);
    const proc = Bun.spawn(replayArgs, {
      cwd: repoRoot,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    process.exitCode = await proc.exited;
    return;
  }

  if (cmd === "r2") {
    const sub = rawArgs[1] || "--info";
    if (sub === "--info" || sub === "info") {
      getR2ConfigInfo();
    } else if (sub === "--verify" || sub === "verify") {
      await verifyR2Connection();
    } else if (sub === "--sync" || sub === "sync") {
      const targetDir = rawArgs[2] || "reports";
      await syncReportsDirectory(targetDir);
    } else {
      console.log(
        "Usage: bun sportsdesk_cli.ts r2 [--info|--verify|--sync <dir>]",
      );
    }
    return;
  }

  if (
    rawArgs.includes("-b") ||
    rawArgs.includes("--brands") ||
    cmd === "brands" ||
    cmd === "types"
  ) {
    printDomainBrandedTypes();
    return;
  }

  if (
    rawArgs.includes("-N") ||
    rawArgs.includes("--neurons") ||
    rawArgs.includes("--layers") ||
    cmd === "neurons" ||
    cmd === "layers"
  ) {
    printNeuronRegistry();
    return;
  }

  if (
    rawArgs.includes("-L") ||
    rawArgs.includes("--lkeys") ||
    rawArgs.includes("--l-keys") ||
    cmd === "lkeys" ||
    cmd === "l-keys"
  ) {
    printLKeyDictionary();
    return;
  }

  if (
    rawArgs.includes("-W") ||
    rawArgs.includes("--writers") ||
    rawArgs.includes("--ticket-writers") ||
    cmd === "writers" ||
    cmd === "ticket-writers"
  ) {
    printTicketWriters();
    return;
  }

  if (
    rawArgs.includes("-S") ||
    rawArgs.includes("--simulate") ||
    cmd === "sim" ||
    cmd === "simulate"
  ) {
    runFullBettorSimulationPipeline();
    return;
  }

  if (
    rawArgs.includes("-o") ||
    rawArgs.includes("--onepass") ||
    cmd === "onepass"
  ) {
    new AgentOnePassPlugin(0.5);
    console.log("Agent OnePass active with 50% liability model.");
    return;
  }

  if (
    rawArgs.includes("-R") ||
    rawArgs.includes("--telegram-report") ||
    cmd === "report"
  ) {
    const type = (rawArgs[1] || "EVENING_SETTLEMENT").toUpperCase();
    if (!isReportType(type)) {
      console.error(
        `Unknown report type ${type}. Use: ${REPORT_TYPES.join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }
    const scheduler = new ReportingSchedulerService();
    process.exitCode = (await scheduler.dispatchReportNow(type)) ? 0 : 1;
    return;
  }

  if (
    rawArgs.includes("-t") ||
    rawArgs.includes("--telegram") ||
    cmd === "telegram"
  ) {
    await startBotDaemon();
    return;
  }

  if (
    rawArgs.includes("-A") ||
    rawArgs.includes("--telegram-alert") ||
    cmd === "alert"
  ) {
    const custId = rawArgs[1] || "RF2003";
    const bot = new SportsDeskTelegramService();
    await bot.dispatchTestAlert(custId);
    return;
  }

  if (
    rawArgs.includes("-s") ||
    rawArgs.includes("--summary") ||
    cmd === "summary"
  ) {
    const data = loadDownlineData();
    console.log(
      "================================================================================",
    );
    console.log("EXECUTIVE DOWNLINE SUMMARY (MASTER: BILLY666)");
    console.log(
      "================================================================================",
    );
    console.log(`  Master Agent Account ID    : ${data.meta.master_agent}`);
    console.log(
      `  Total Sub-Agents in Tree   : ${data.meta.total_sub_agents.toLocaleString()}`,
    );
    console.log(
      `  Active Sports Bettors      : ${data.meta.active_sports_bettors.toLocaleString()}`,
    );
    console.log(
      `  Sports Period Handle       : $${data.meta.total_sports_volume.toLocaleString()}`,
    );
    console.log(
      `  Lifetime Net Book Hold     : $${Math.abs(data.meta.total_lifetime_net_hold).toLocaleString()}`,
    );
    console.log(
      `  Agent 50% Shared Balance   : $${(Math.abs(data.meta.total_lifetime_net_hold) * 0.5).toLocaleString()}`,
    );
    console.log(
      "================================================================================\n",
    );
    return;
  }

  if (cmd === "docs" || cmd === "doc" || rawArgs.includes("--docs")) {
    // Automated Documentation Error Finder via Bun.cron & Bun.WebView
    if (rawArgs.includes("--audit")) {
      const proc = Bun.spawn(
        ["bun", "run", "scripts/audit_docs_webview_cron.ts"],
        {
          cwd: repoRoot,
          stdout: "inherit",
          stderr: "inherit",
          stdin: "inherit",
        },
      );
      process.exitCode = await proc.exited;
      return;
    }

    if (rawArgs.includes("--watch") || rawArgs.includes("-w")) {
      const proc = Bun.spawn(
        ["bun", "run", "scripts/audit_docs_webview_cron.ts", "--watch"],
        {
          cwd: repoRoot,
          stdout: "inherit",
          stderr: "inherit",
          stdin: "inherit",
        },
      );
      process.exitCode = await proc.exited;
      return;
    }

    const scriptArgs = ["./scripts/deploy/deploy_docs.sh"];
    if (rawArgs.includes("--test") || rawArgs.includes("-t"))
      scriptArgs.push("--test-only");
    if (rawArgs.includes("--dry-run") || rawArgs.includes("-d"))
      scriptArgs.push("--dry-run");
    if (rawArgs.includes("--project") || rawArgs.includes("-p")) {
      const idx = rawArgs.findIndex(function (a) {
        return a === "--project" || a === "-p";
      });
      const project = idx === -1 ? undefined : rawArgs[idx + 1];
      if (project !== undefined) {
        scriptArgs.push("--project", project);
      }
    }

    const proc = Bun.spawn(scriptArgs, {
      cwd: repoRoot,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    process.exitCode = await proc.exited;
    return;
  }

  printHelp();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("CLI Execution Error:", err);
    process.exit(1);
  });
}
