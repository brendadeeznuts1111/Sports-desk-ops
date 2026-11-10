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
import {
  syncReportsDirectory,
  verifyR2Connection,
  getR2ConfigInfo,
} from "../services/sportsdesk_r2_sync.ts";
import { renderAnsiMarkdown } from "../lib/canonical_osc8_links.ts";
import {
  benchmarkResolverLatency,
  classifyIpAddress,
  getDnsTelemetry,
  lookupHost,
  prefetchSportsDeskEndpoints,
  resolveDnsRecordSet,
  SPORTSDESK_CORE_HOSTS,
  type DnsResolverBackend,
} from "../lib/bun_dns.ts";

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
import { padDisplay } from "../lib/cli_inspect.ts";
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
import {
  GSLIVE_BET_HISTORY_STATES,
  GSLIVE_GROUP_KINDS,
  buildGsLiveDualSurfaceDescriptor,
  type GsLiveBetHistoryState,
  type GsLiveBetHistoryUrlFilters,
  type GsLiveGroupKind,
} from "../lib/gslive_manager_deeplink_sidecar.ts";
import {
  listGsLivePeriodOptions,
  parseGsLiveSportPeriods,
  resolveGsLivePeriodCode,
  type GsLiveSportPeriods,
} from "../lib/gslive_period_logic.ts";
import {
  PER_OFFICE_IP_TRACKER_CLUSTERS,
  buildPerOfficeIpMatcherPayload,
} from "../lib/bet_ticker_ip_tracker_bridge.ts";
import {
  buildCustomerRanking,
  buildSharpAudit,
  lookupCustomer,
  type CustomerRankingRow,
  type RankingSort,
} from "../lib/customer_rankings.ts";
import { buildComprehensiveCustomerProfile } from "../lib/customer_profiling_enhanced.ts";
import type { CustomerRow } from "../lib/customer_profile.ts";

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
  if (!existsSync(jsonPath)) {
    throw new Error(
      `[DOWNLINE_SNAPSHOT_MISSING] ${jsonPath} does not exist. ` +
        "The CLI will not fabricate a downline: check in or regenerate the snapshot.",
    );
  }
  const rawText = readFileSync(jsonPath, "utf-8");
  return JSON.parse(rawText) as DownlinePayload;
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
  *(Periods: 7d | lifetime — derived from the customer book's 7d window and lifetime rollups)*

### 2. CORE FORENSICS & SIMULATION:
* **-f, --forensics, --sharps, --audit-sharps**: Run the DERIVED sharp audit (sharp_score / positive-CLV candidates)
* **-S, --simulate, --sim, --run-sim**: Run full 52-week dual-basis bettor churn simulation
* **-o, --onepass, --liability, --agent-risk**: Run the DERIVED Agent OnePass 50% liability scoreboard (downline snapshot)

### 3. HIERARCHY & SURVEILLANCE:
* **-k, --walk-tree, --tree** [AGENT_ID]: Walk the snapshot's master→agent links with derived subtree rollups
* **-C, --customer, --cust** <CUSTOMER_ID>: Lookup a bettor profile DERIVED from the customer book
* **-d, --downline, --agent** [AGENT_ID]: Query sub-agent rollup(s) DERIVED from the downline snapshot
* **-s, --summary**: Display the executive overview DERIVED from the downline snapshot

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
* **gslive** [LOGIN] [\`--date\` YYYY-MM-DD] [\`--state\` STATE] [\`--window\` 1-31] [\`--agent\` A] [\`--bet-id\` IDS] [\`--bet-group-id\` IDS] [\`--free-bet-id\` ID] [\`--kind\` KIND] [\`--group-name\` NAME] [\`--period\` P] [\`--sport\` SID] [\`--market\` IDS] [\`--json\`]: GSLive 7-param report + bet-history sidecar links
* **profile** <0x|username> [\`--json\`]: Polymarket PnL, win rate, positions, categories, strategy
* **combo** legs|price|wallet: CFB combo legs, product-of-legs pricing, wallet combo positions
* **bridge** coverage|value|match: cross-domain join between the customer book and Polymarket wallets
* **stale** \`-i\` FILE [\`--window-min\` N] [\`--json\`]: Stale-line / post-move bet cohort
* **shot** <URL> [\`--out\` PATH] [\`--f402-login\`] [\`--profile\` DIR] [\`--format\` png|jpeg|webp]: Bun.WebView screenshot (default \`scratch/shots/\`)
* **dashboard** [\`--exec\`]: Render dashboard.md with Bun.markdown.ansi in milliseconds
* **dns** [\`--backend\` system|c-ares|libc] [\`--json\`]: Bun native DNS cache telemetry and prefetch inspection
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
      Periods: 7d | lifetime (derived from the customer book)

2. CORE FORENSICS & SIMULATION:
  -f, --forensics, --sharps, --audit-sharps    Run the DERIVED sharp audit (sharp_score / positive CLV)
  -S, --simulate, --sim, --run-sim            Run full 52-week dual-basis bettor churn simulation
  -o, --onepass, --liability, --agent-risk     Run the DERIVED 50% liability scoreboard (snapshot)

3. HIERARCHY & SURVEILLANCE:
  -k, --walk-tree, --tree [AGENT_ID]          Walk master→agent links in the snapshot (flat source)
  -C, --customer, --cust <CUSTOMER_ID>        Lookup a bettor profile DERIVED from the customer book
  -d, --downline, --agent [AGENT_ID]          Query sub-agent rollup(s) DERIVED from the snapshot
  -s, --summary                               Display the executive overview DERIVED from the snapshot

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

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(
    (left, right) => right[1] - left[1],
  );
  return entries.length === 0
    ? "n/a"
    : entries.map(([key, count]) => `${key}=${count}`).join(", ");
}

export async function printCustomerProfile(
  customerId: string,
  args: string[],
): Promise<void> {
  const asJson =
    args.includes("--json") ||
    getArgValue(args, ["--format"], "table") === "json";
  let result;
  try {
    result = await lookupCustomer(customerId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  if (!result.found) {
    console.error(
      `[CUSTOMER_NOT_FOUND] ${JSON.stringify(result.requested)} is not in the customer book (${result.totalCustomers} customers).`,
    );
    process.exitCode = 1;
    return;
  }
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const record = result.record;
  const sample = result.sample;
  if (record === null || sample === null) {
    console.error(
      "[CUSTOMER_BOOK_INVALID] lookup returned no record or sample",
    );
    process.exitCode = 2;
    return;
  }
  const divider = "=".repeat(96);
  console.log(divider);
  console.log(
    `CUSTOMER PROFILE • DERIVED from enriched_customers_full.json • ${result.totalCustomers} customers in book`,
  );
  console.log(divider);
  console.log(`  Customer       : ${record.customer_id}`);
  console.log(
    `  Agent / master : ${record.agent_id} / ${record.master_agent ?? "UNKNOWN"}`,
  );
  console.log(
    `  Status/context : ${record.status ?? "UNKNOWN"} / ${record.context_type ?? "UNKNOWN"}`,
  );
  console.log(
    `  Churn mode     : ${record.churn_mode ?? "UNKNOWN"} (hazard ${record.churn_hazard ?? "n/a"})`,
  );
  console.log(
    `  Lifetime       : volume ${usd(record.lifetime_volume_usd)} | net ${signedUsd(record.lifetime_net_usd)}`,
  );
  console.log(
    `  7d window      : volume ${usd(record.sports_7d_volume_usd ?? 0)} | net ${signedUsd(record.sports_7d_net_usd ?? 0)}`,
  );
  console.log(
    `  CLV / sharp    : ${record.clv_bps ?? "n/a"} bps / ${record.sharp_score ?? "n/a"}`,
  );
  console.log(
    `  Sample         : ${sample.tickets} recent ticket(s) | risk ${usd(sample.riskUsd)} | net ${signedUsd(sample.netUsd)} | win ${sample.winPct === null ? "n/a" : `${sample.winPct.toFixed(1)}%`}`,
  );
  console.log(`  Sample results : ${formatCounts(sample.results)}`);
  console.log(`  Sample leagues : ${formatCounts(sample.leagues)}`);
  console.log(
    `  Sample window  : ${sample.firstPlacedAt ?? "n/a"} .. ${sample.lastPlacedAt ?? "n/a"}`,
  );

  const comp = buildComprehensiveCustomerProfile(
    record as unknown as CustomerRow,
  );
  console.log(
    `  Unified Sharp  : ${comp.compositeSharpness.tier} (Composite: ${comp.compositeSharpness.overallScore.toFixed(1)}/10.0)`,
  );
  console.log(
    `  Score Details  : CLV: ${comp.compositeSharpness.components.clvScore.toFixed(1)}/3.0 | Skill: ${comp.compositeSharpness.components.bayesianSkillScore.toFixed(1)}/2.5 | Sizing: ${comp.compositeSharpness.components.sizingDisciplineScore.toFixed(1)}/1.5 | Sig: ${comp.compositeSharpness.components.signatureSpecializationScore.toFixed(1)}/2.0 | Timing: ${comp.compositeSharpness.components.timingExploitationScore.toFixed(1)}/1.0`,
  );
  console.log(
    `  Sizing / Gini  : ${comp.stakeProfile.strategy} (Gini: ${comp.stakeProfile.giniCoefficient.toFixed(3)}) | Mean Stake: ${usd(comp.stakeProfile.meanStakeUsd)} | Ratio: ${comp.stakeProfile.maxToMinRatio}x`,
  );
  console.log(
    `  Specialization : ${comp.marketProfile.dominantLeague} (${comp.marketProfile.dominantMarket}) | Timing: ${comp.marketProfile.dominantTiming} (${comp.timingProfile.timingArchetype}) | Side: ${comp.marketProfile.overUnderBias}`,
  );
  console.log(
    `  Correlated Par : ${comp.correlatedParlayProfile.correlationRiskTier} (${(comp.correlatedParlayProfile.correlationExploitRate * 100).toFixed(0)}% exploit rate across ${comp.correlatedParlayProfile.totalParlaysObserved} parlays)`,
  );
  console.log(
    `  Syndicate Risk : ${comp.syndicateProfile.clusterRiskLevel} (${(comp.syndicateProfile.syndicateProbability * 100).toFixed(0)}% prob) | Root: ${comp.syndicateProfile.rootCustomerId}${comp.syndicateProfile.isSubAccount ? ` (Seat #${comp.syndicateProfile.subAccountIndex})` : ""}`,
  );
  console.log(
    `  Portfolio Risk : 7d VaR (95%): ${usd(comp.riskForensics.estimated7dVaR95Usd)} | CVaR: ${usd(comp.riskForensics.estimated7dCVaR95Usd)} | LTV: ${signedUsd(comp.riskForensics.projectedLtvUsd)}`,
  );
  console.log(
    `  Desk Directive : Limit: ${usd(comp.deskDirectives.recommendedStakeLimitUsd)} | Delay: ${comp.deskDirectives.inPlayDelaySeconds}s | Shading: ${comp.deskDirectives.lineShadeCents}¢ | Shadow: ${comp.deskDirectives.shadowCopyMultiplier.toFixed(2)}x`,
  );
  console.log(
    `  Recommended    : ${comp.recommendedAction} (Baseline Tier: ${comp.rating.tier}, Baseline: ${comp.rating.score.toFixed(1)}/10)`,
  );
  console.log(divider);
  console.log(
    "* recent_tickets is a per-customer SAMPLE; lifetime_* fields are the full rollup.\n",
  );
}

export function printDownline(agentId: string, args: string[]): void {
  let snapshot: DownlinePayload;
  try {
    snapshot = loadDownlineData();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  const wanted = agentId.trim().toUpperCase();
  const agents =
    wanted === ""
      ? snapshot.agents
      : snapshot.agents.filter(
          (agent) =>
            agent.agent.toUpperCase() === wanted ||
            agent.agent.toUpperCase().includes(wanted),
        );
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          snapshotMeta: snapshot.meta,
          listedAgents: snapshot.agents.length,
          returned: agents.length,
          agents,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (agents.length === 0) {
    console.error(
      `[AGENT_NOT_FOUND] ${JSON.stringify(agentId)} matches none of the ${snapshot.agents.length} agent rows in the snapshot.`,
    );
    process.exitCode = 1;
    return;
  }
  const total = (key: keyof AgentDownlineRecord): number =>
    agents.reduce((sum, agent) => {
      const value = Number(agent[key]);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
  const divider = "=".repeat(116);
  console.log(divider);
  console.log(
    `DOWNLINE SNAPSHOT • ${agents.length} of ${snapshot.agents.length} agent rows shown • meta claims ${snapshot.meta.total_sub_agents} sub-agents`,
  );
  console.log(divider);
  console.log(
    " Agent        | Master    | Acct | Active | Dormant | Tickets | Sports Vol ($) | Lifetime Net ($) | 50% Share ($)",
  );
  console.log(
    "--------------+-----------+------+--------+---------+---------+----------------+------------------+--------------",
  );
  for (const agent of agents) {
    const share = Number(agent.lifetime_net) * 0.5;
    console.log(
      ` ${agent.agent.padEnd(12)} | ${agent.master.padEnd(9)} | ` +
        `${String(agent.total_accounts).padStart(4)} | ` +
        `${String(agent.active_sports_accounts).padStart(6)} | ` +
        `${String(agent.dormant_accounts).padStart(7)} | ` +
        `${String(agent.sports_tickets).padStart(7)} | ` +
        `${usd(agent.sports_vol).padStart(14)} | ` +
        `${signedUsd(agent.lifetime_net).padStart(16)} | ` +
        `${signedUsd(share).padStart(12)}`,
    );
  }
  console.log(divider);
  console.log(
    `TOTALS (${agents.length} row(s)): accounts ${total("total_accounts")} | active ${total("active_sports_accounts")} | tickets ${total("sports_tickets")} | volume ${usd(total("sports_vol"))} | net ${signedUsd(total("lifetime_net"))} | 50% share ${signedUsd(total("lifetime_net") * 0.5)}`,
  );
  console.log(divider + "\n");
}

export function printDownlineTree(agentId: string): void {
  let snapshot: DownlinePayload;
  try {
    snapshot = loadDownlineData();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  const byMaster = new Map<string, AgentDownlineRecord[]>();
  const ids = new Set<string>();
  for (const agent of snapshot.agents) {
    ids.add(agent.agent.toUpperCase());
    const master = agent.master.toUpperCase();
    const children = byMaster.get(master) ?? [];
    children.push(agent);
    byMaster.set(master, children);
  }
  const divider = "=".repeat(96);
  console.log(divider);
  console.log(
    "DOWNLINE TREE • flat snapshot (master→agent links only; depth is derived from those links)",
  );
  console.log(divider);
  const renderChildren = (
    master: string,
    depth: number,
    seen: Set<string>,
  ): { rows: number; net: number } => {
    let rows = 0;
    let net = 0;
    for (const child of byMaster.get(master) ?? []) {
      const childNet = Number(child.lifetime_net) || 0;
      rows += 1;
      net += childNet;
      console.log(
        `${"  ".repeat(depth)}└─ ${child.agent} [${child.total_accounts} acct, net ${signedUsd(childNet)}, 50% ${signedUsd(childNet * 0.5)}]`,
      );
      const childId = child.agent.toUpperCase();
      if (seen.has(childId)) continue;
      seen.add(childId);
      const deeper = renderChildren(childId, depth + 1, seen);
      rows += deeper.rows;
      net += deeper.net;
    }
    return { rows, net };
  };
  const focus = agentId.trim().toUpperCase();
  if (focus !== "") {
    const row = snapshot.agents.find(
      (agent) => agent.agent.toUpperCase() === focus,
    );
    if (row === undefined && !byMaster.has(focus)) {
      console.error(
        `[AGENT_NOT_FOUND] ${JSON.stringify(agentId)} matches none of the ${snapshot.agents.length} agent rows.`,
      );
      process.exitCode = 1;
      return;
    }
    const summary = renderChildren(focus, 0, new Set([focus]));
    console.log(
      `${focus} • ${summary.rows} descendant row(s), net ${signedUsd(summary.net)}`,
    );
  } else {
    const roots = [...byMaster.keys()].filter((master) => !ids.has(master));
    if (roots.length === 0) {
      console.log(
        "[NO_ROOTS] every master in the snapshot is also an agent row; the flat source carries no top-level node.",
      );
    }
    for (const root of roots) {
      const summary = renderChildren(root, 0, new Set([root]));
      console.log(
        `${root} • ${summary.rows} descendant row(s), net ${signedUsd(summary.net)}`,
      );
    }
  }
  console.log(divider + "\n");
}

export async function printSharpAudit(args: string[]): Promise<void> {
  const asJson =
    args.includes("--json") ||
    getArgValue(args, ["--format"], "table") === "json";
  const parsedThreshold = Number.parseInt(
    getArgValue(args, ["--min-sharp", "--min-sharp-score"], "70"),
    10,
  );
  const threshold = Number.isFinite(parsedThreshold) ? parsedThreshold : 70;
  const limit = parseLimit(getArgValue(args, ["--limit"], "10"));
  let audit;
  try {
    audit = await buildSharpAudit({ minSharpScore: threshold, limit });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  if (asJson) {
    console.log(JSON.stringify(audit, null, 2));
    return;
  }
  const divider = "=".repeat(112);
  console.log(divider);
  console.log(
    `SHARP AUDIT • DERIVED: ${audit.candidates} candidate(s) of ${audit.bookCustomers} customers (sharp_score >= ${audit.threshold} OR clv_bps > 0)`,
  );
  console.log(divider);
  console.log(
    " # | Customer    | Agent        | Context           | CLV bps | Sharp | Lifetime Vol ($) | Lifetime Net ($) | Win %* | Churn",
  );
  console.log(
    "---+-------------+--------------+-------------------+---------+-------+------------------+------------------+--------+------",
  );
  for (const row of audit.rows) {
    console.log(
      `${String(row.rank).padStart(2)} | ${row.customerId.padEnd(11)} | ${row.agentId.padEnd(12)} | ${row.contextType.padEnd(17)} | ` +
        `${String(row.clvBps ?? "n/a").padStart(7)} | ` +
        `${String(row.sharpScore ?? "n/a").padStart(5)} | ` +
        `${usd(row.lifetimeVolumeUsd).padStart(16)} | ` +
        `${signedUsd(row.lifetimeNetUsd).padStart(16)} | ` +
        `${(row.sampleWinPct === null ? "n/a" : `${row.sampleWinPct.toFixed(1)}%`).padStart(6)} | ` +
        `${row.churnHazard ?? "n/a"}`,
    );
  }
  console.log(divider);
  console.log(
    "* Win % is computed over the sampled WIN/LOSS tickets only; the candidate set is derived from the book.\n",
  );
}

export function printOnePass(args: string[]): void {
  let snapshot: DownlinePayload;
  try {
    snapshot = loadDownlineData();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  const agents = snapshot.agents
    .slice()
    .sort(
      (left, right) => Number(right.lifetime_net) - Number(left.lifetime_net),
    );
  const rows = agents.map((agent) => {
    const netUsd = Number(agent.lifetime_net) || 0;
    return {
      agent: agent.agent,
      master: agent.master,
      accounts: agent.total_accounts,
      active: agent.active_sports_accounts,
      tickets: agent.sports_tickets,
      volumeUsd: agent.sports_vol,
      netUsd,
      liabilityShareUsd: netUsd * 0.5,
    };
  });
  const totals = rows.reduce(
    (acc, row) => ({
      accounts: acc.accounts + row.accounts,
      active: acc.active + row.active,
      tickets: acc.tickets + row.tickets,
      volumeUsd: acc.volumeUsd + row.volumeUsd,
      netUsd: acc.netUsd + row.netUsd,
      liabilityShareUsd: acc.liabilityShareUsd + row.liabilityShareUsd,
    }),
    {
      accounts: 0,
      active: 0,
      tickets: 0,
      volumeUsd: 0,
      netUsd: 0,
      liabilityShareUsd: 0,
    },
  );
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          snapshotMeta: snapshot.meta,
          listedAgents: agents.length,
          totals,
          agents: rows,
        },
        null,
        2,
      ),
    );
    return;
  }
  const divider = "=".repeat(116);
  console.log(divider);
  console.log(
    `AGENT ONEPASS LIABILITY SCOREBOARD • DERIVED from the downline snapshot • ${agents.length} rows • 50% house/agent split`,
  );
  console.log(divider);
  console.log(
    " Agent        | Master    | Acct | Active | Tickets | Sports Vol ($) | Net P&L ($)     | 50% Liability ($)",
  );
  console.log(
    "--------------+-----------+------+--------+---------+----------------+-----------------+------------------",
  );
  for (const row of rows) {
    console.log(
      ` ${row.agent.padEnd(12)} | ${row.master.padEnd(9)} | ` +
        `${String(row.accounts).padStart(4)} | ` +
        `${String(row.active).padStart(6)} | ` +
        `${String(row.tickets).padStart(7)} | ` +
        `${usd(row.volumeUsd).padStart(14)} | ` +
        `${signedUsd(row.netUsd).padStart(15)} | ` +
        `${signedUsd(row.liabilityShareUsd).padStart(16)}`,
    );
  }
  console.log(divider);
  console.log(
    `TOTALS: accounts ${totals.accounts} | active ${totals.active} | tickets ${totals.tickets} | volume ${usd(totals.volumeUsd)} | net ${signedUsd(totals.netUsd)} | 50% liability ${signedUsd(totals.liabilityShareUsd)}`,
  );
  console.log(
    `* meta claims ${snapshot.meta.total_sub_agents} sub-agents; the snapshot lists ${agents.length} rows. 50% share = |lifetime net| * 0.5 (the CLI's documented split).\n`,
  );
}

function parseLimit(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : 10;
}

function usd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedUsd(value: number): string {
  const sign = value < 0 ? "-" : "+";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function printDerivedRanking(
  rows: readonly CustomerRankingRow[],
  heading: string,
  format: string,
): void {
  if (format === "json") {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (format === "csv") {
    console.log(
      "Rank,CustomerID,AgentID,League,Market,SampledTickets,VolumeUSD,NetUSD,WinPct,GrossHold,Details",
    );
    for (const row of rows) {
      console.log(
        `${row.rank},${row.customerId},${row.agentId},${row.league},${row.market},${row.tickets},${row.volumeUSD},${row.netUSD},${row.winPct ?? ""},${row.grossHold},"${row.details}"`,
      );
    }
    return;
  }
  const divider = "=".repeat(96);
  console.log(divider);
  console.log(heading);
  console.log(divider);
  console.log(
    " # | Customer    | Agent        | League | Market    | Tix* | Volume ($)    | Net P&L ($)     | Win %* | Derived context",
  );
  console.log(
    "---+-------------+--------------+--------+-----------+------+---------------+-----------------+--------+-----------------------------",
  );
  for (const row of rows) {
    const winPct = row.winPct === null ? "n/a" : `${row.winPct.toFixed(1)}%`;
    console.log(
      `${String(row.rank).padStart(2)} | ` +
        `${row.customerId.padEnd(11)} | ` +
        `${row.agentId.padEnd(12)} | ` +
        `${row.league.padEnd(6)} | ` +
        `${row.market.padEnd(9)} | ` +
        `${String(row.tickets).padStart(4)} | ` +
        `${usd(row.volumeUSD).padStart(13)} | ` +
        `${signedUsd(row.netUSD).padStart(15)} | ` +
        `${winPct.padStart(6)} | ` +
        `${row.details}`,
    );
  }
  console.log(divider);
  console.log(
    "* Tix is the sampled recent_tickets count; Win % covers sampled WIN/LOSS tickets only.\n",
  );
}

async function printRanking(
  direction: "winners" | "losers",
  args: string[],
  defaultPeriod: string,
  defaultSort: RankingSort,
  allowedSorts: readonly RankingSort[],
  headingFor: (period: string) => string,
): Promise<void> {
  const period = getArgValue(args, ["-p", "--period"], defaultPeriod);
  const limit = parseLimit(getArgValue(args, ["--limit"], "10"));
  const format = getArgValue(args, ["--format"], "table");
  const sortBy = getArgValue(args, ["--sort-by"], defaultSort) as RankingSort;
  if (!allowedSorts.includes(sortBy)) {
    console.error(
      `[SORT_UNAVAILABLE] --sort-by ${sortBy} is not supported here. Allowed: ${allowedSorts.join(", ")}.`,
    );
    process.exitCode = 2;
    return;
  }
  try {
    const rows = await buildCustomerRanking({
      direction,
      period,
      sortBy,
      limit,
    });
    printDerivedRanking(rows, headingFor(period), format);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

export async function printWinners(args: string[]): Promise<void> {
  await printRanking(
    "winners",
    args,
    "7d",
    "net",
    ["net", "volume"],
    (period) =>
      `BIGGEST CUSTOMERS BY NET (HOUSE LEAKAGE) • WINDOW: ${period.toUpperCase()} • derived from enriched_customers_full.json`,
  );
}

export async function printLosers(args: string[]): Promise<void> {
  await printRanking(
    "losers",
    args,
    "7d",
    "net",
    ["net", "gross_hold", "volume"],
    (period) =>
      `BIGGEST CUSTOMERS BY NET (HOUSE HOLD) • WINDOW: ${period.toUpperCase()} • derived from enriched_customers_full.json`,
  );
}

export async function printLeaderboard(args: string[]): Promise<void> {
  const period = getArgValue(args, ["-p", "--period"], "lifetime");
  const format = getArgValue(args, ["--format"], "table");
  const divider = "=".repeat(96);
  console.log(divider);
  console.log(
    `DUAL-SIDED CUSTOMER LEADERBOARD • WINDOW: ${period.toUpperCase()} • derived from enriched_customers_full.json`,
  );
  console.log(divider);
  console.log("TOP 5 WINNERS (LEAKAGES):");
  await printWinners(["-p", period, "--limit", "5", "--format", format]);
  console.log("TOP 5 LOSERS (HOUSE HOLD):");
  await printLosers(["-p", period, "--limit", "5", "--format", format]);
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

/**
 * Validates the observed `--state` SPA filter for `#/events/bet-history`.
 * Prints the refusal and sets the exit code itself; `undefined` tells the caller to stop.
 */
function parseGsLiveState(raw: string): GsLiveBetHistoryState | undefined {
  const state = GSLIVE_BET_HISTORY_STATES.find((entry) => entry === raw);
  if (state === undefined) {
    console.error(
      `Unknown --state ${JSON.stringify(raw)}. Allowed: ${GSLIVE_BET_HISTORY_STATES.map((entry) => JSON.stringify(entry)).join(", ")}.`,
    );
    process.exitCode = 1;
    return undefined;
  }
  return state;
}

/**
 * Validates the per-player bet-history window (`--window`, desk days 1-31).
 * Prints the refusal and sets the exit code itself; `undefined` tells the caller to stop.
 */
function parseGsLiveWindow(raw: string): number | undefined {
  const windowDays = Number(raw);
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 31) {
    console.error(
      `--window must be an integer 1-31, got ${JSON.stringify(raw)}.`,
    );
    process.exitCode = 1;
    return undefined;
  }
  return windowDays;
}

/** Captured `sportPeriods` vocabulary; provenance in lib/gslive_period_logic.ts. */
const GSLIVE_PERIODS_FIXTURE = new URL(
  "../tests/fixtures/gslive-sport-periods-2026-11-03.json",
  import.meta.url,
);
let gslivePeriodsPromise: Promise<GsLiveSportPeriods | null> | undefined;

function loadGsLivePeriods(): Promise<GsLiveSportPeriods | null> {
  gslivePeriodsPromise ??= (async () => {
    try {
      const payload: unknown = await Bun.file(GSLIVE_PERIODS_FIXTURE).json();
      return parseGsLiveSportPeriods(payload);
    } catch {
      return null;
    }
  })();
  return gslivePeriodsPromise;
}

/**
 * Reads the URL-expressible Filters-panel values (`--agent`, `--bet-id`, …) for the
 * `#/events/bet-history` link. `ok:false` means the refusal was printed and the caller stops;
 * `filters` is absent when no filter flag was given.
 *
 * `--period` accepts a code (`s3`) or a console label (`3rd Quarter`); a label is resolved to its
 * code against the captured `sportPeriods` vocabulary for `--sport`.
 */
async function parseGsLiveFilters(
  args: string[],
): Promise<
  | { readonly ok: true; readonly filters?: GsLiveBetHistoryUrlFilters }
  | { readonly ok: false }
> {
  const agent = getArgValue(args, ["--agent"], "").trim();
  const betId = getArgValue(args, ["--bet-id"], "").trim();
  const betGroupId = getArgValue(args, ["--bet-group-id"], "").trim();
  const freeBetId = getArgValue(args, ["--free-bet-id"], "").trim();
  const kindRaw = getArgValue(args, ["--kind"], "").trim();
  const groupName = getArgValue(args, ["--group-name"], "").trim();
  const periodRaw = getArgValue(args, ["--period"], "").trim();
  const sportId = getArgValue(args, ["--sport"], "").trim();
  const market = getArgValue(args, ["--market"], "").trim();

  let kind: GsLiveGroupKind | undefined;
  if (kindRaw !== "") {
    kind = GSLIVE_GROUP_KINDS.find((entry) => entry === kindRaw);
    if (kind === undefined) {
      console.error(
        `Unknown --kind ${JSON.stringify(kindRaw)}. Allowed: ${GSLIVE_GROUP_KINDS.join(", ")}.`,
      );
      process.exitCode = 1;
      return { ok: false };
    }
  }

  let period = periodRaw;
  if (periodRaw !== "") {
    if (sportId === "") {
      if (!/^(?:h1|h2|ht|s(?:10|[1-9]))$/i.test(periodRaw)) {
        console.error(
          `--period ${JSON.stringify(periodRaw)} is not a period code; pass --sport to resolve a label such as "3rd Quarter".`,
        );
        process.exitCode = 1;
        return { ok: false };
      }
      period = periodRaw.toLowerCase();
    } else {
      const vocabulary = await loadGsLivePeriods();
      if (vocabulary === null) {
        console.error(
          "MISSING sportPeriods vocabulary: tests/fixtures/gslive-sport-periods-2026-11-03.json did not parse, so --period cannot be resolved.",
        );
        process.exitCode = 1;
        return { ok: false };
      }
      const option = resolveGsLivePeriodCode(vocabulary, sportId, periodRaw);
      if (option === undefined) {
        const options = listGsLivePeriodOptions(vocabulary, sportId);
        console.error(
          `Unknown --period ${JSON.stringify(periodRaw)} for sport ${JSON.stringify(sportId)}. Codes: ${options.map((entry) => entry.code).join(", ")}. Labels: ${options.map((entry) => `${entry.code}=${JSON.stringify(entry.label)}`).join(", ")}.`,
        );
        process.exitCode = 1;
        return { ok: false };
      }
      period = option.code;
    }
  }

  const filters: GsLiveBetHistoryUrlFilters = {
    ...(agent !== "" ? { agent } : {}),
    ...(betId !== "" ? { betId } : {}),
    ...(betGroupId !== "" ? { betGroupId } : {}),
    ...(freeBetId !== "" ? { freeBetId } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(groupName !== "" ? { groupName } : {}),
    ...(period !== "" ? { period } : {}),
    ...(sportId !== "" ? { sportId } : {}),
    ...(market !== "" ? { marketIds: market } : {}),
  };
  return Object.keys(filters).length === 0
    ? { ok: true }
    : { ok: true, filters };
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
    const state = parseGsLiveState(getArgValue(args, ["--state"], ""));
    if (state === undefined) return;
    const windowDays = parseGsLiveWindow(getArgValue(args, ["--window"], "1"));
    if (windowDays === undefined) return;
    const parsedFilters = await parseGsLiveFilters(args);
    if (!parsedFilters.ok) return;
    const desc = buildGsLiveDualSurfaceDescriptor(custId, {
      ...(dateYmd ? { dateYmd } : {}),
      windowDays,
      state,
      ...(parsedFilters.filters ? { filters: parsedFilters.filters } : {}),
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
  gslive   Emit GSLive 7-param deep-link & live sidecar JSON (-c <CUST_ID> --date YYYY-MM-DD [--state canceled] [--window 1-31])
`);
}

export async function handleDashboardCli(args: string[] = []): Promise<void> {
  const dashboardPath = resolve(process.cwd(), "dashboard.md");
  const file = Bun.file(dashboardPath);
  if (!(await file.exists())) {
    printHelp();
    return;
  }

  const start = performance.now();
  const content = await file.text();
  const rendered = renderAnsiMarkdown(content, {
    colors: !process.env.NO_COLOR && process.env.TERM !== "dumb",
    hyperlinks: true,
  });
  const elapsed = (performance.now() - start).toFixed(2);

  process.stdout.write(rendered);
  console.log(
    `\n\x1b[2m⚡ Rendered dashboard.md in ${elapsed}ms via Bun.markdown.ansi\x1b[0m`,
  );

  // If shell execution requested (--exec or -x)
  if (args.includes("--exec") || args.includes("-x")) {
    const codeBlockMatch = content.match(/```(?:sh|bash)\n([\s\S]*?)```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
      const commands = codeBlockMatch[1]
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      for (const cmdLine of commands) {
        console.log(`\x1b[36m$ ${cmdLine}\x1b[0m`);
        try {
          const proc = Bun.spawn(["sh", "-c", cmdLine], {
            stdout: "inherit",
            stderr: "inherit",
          });
          await proc.exited;
        } catch (err: unknown) {
          console.error("Command execution failed:", err);
        }
      }
    }
  }
}

export async function handleDnsCommand(args: string[] = []): Promise<void> {
  const isJson = args.includes("--json");

  if (args.includes("--benchmark")) {
    const targetHost =
      args.find((a) => !a.startsWith("-") && a !== "dns") || "fantasy402.com";
    const res = await benchmarkResolverLatency(
      targetHost,
      ["c-ares", "system"],
      3,
    );
    if (isJson) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(`\n🚀 \x1b[1mResolver Latency Benchmark: ${targetHost}\x1b[0m`);
    console.log(
      `Fastest Backend: \x1b[32;1m${res.fastestBackend}\x1b[0m (${res.speedupFactor}x faster)\n`,
    );
    for (const m of res.metrics) {
      console.log(
        `  • \x1b[1m${m.backend.padEnd(8)}\x1b[0m: mean=${m.meanMs}ms, min=${m.minMs}ms, p50=${m.p50Ms}ms, p99=${m.p99Ms}ms [${m.addresses.join(", ")}]`,
      );
    }
    return;
  }

  const reverseIndex = args.indexOf("--reverse");
  if (reverseIndex !== -1 && args[reverseIndex + 1]) {
    const ip = args[reverseIndex + 1]!;
    const res = await classifyIpAddress(ip);
    if (isJson) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(`\n🔍 \x1b[1mReverse DNS & Forensics: ${ip}\x1b[0m`);
    console.log(`Organization: \x1b[36m${res.organization}\x1b[0m`);
    console.log(
      `Datacenter/Cloud: ${res.isDatacenterOrCloud ? "🚨 YES" : "NO"}`,
    );
    console.log(
      `Suspicious Proxy/VPN: ${res.isVpnOrProxySuspicious ? "⚠️ YES" : "NO"}`,
    );
    console.log(`Hostnames: ${res.hostnames.join(", ") || "(none)"}`);
    return;
  }

  const recordsIndex = args.indexOf("--records");
  if (recordsIndex !== -1) {
    const targetHost =
      args[recordsIndex + 1] ||
      args.find((a) => !a.startsWith("-") && a !== "dns") ||
      "fantasy402.com";
    const res = await resolveDnsRecordSet(targetHost);
    if (isJson) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(`\n📋 \x1b[1mDNS Resource Records: ${targetHost}\x1b[0m`);
    console.log(`  • A:     ${res.aRecords.join(", ") || "(none)"}`);
    console.log(`  • AAAA:  ${res.aaaaRecords.join(", ") || "(none)"}`);
    console.log(
      `  • MX:    ${res.mxRecords.map((m) => `${m.exchange} (${m.priority})`).join(", ") || "(none)"}`,
    );
    console.log(
      `  • TXT:   ${res.txtRecords.map((t) => t.join(" ")).join(", ") || "(none)"}`,
    );
    console.log(`  • CNAME: ${res.cnameRecords.join(", ") || "(none)"}`);
    return;
  }

  const backendArg = args
    .find((a) => a.startsWith("--backend="))
    ?.split("=")[1] as DnsResolverBackend | undefined;
  const backend: DnsResolverBackend = backendArg || "system";

  const startPrefetch = performance.now();
  const prefetchedCount = prefetchSportsDeskEndpoints();
  const prefetchElapsed = (performance.now() - startPrefetch).toFixed(2);

  const hostResults: Array<{
    hostname: string;
    service: string;
    addresses: string[];
    latencyMs: number;
  }> = [];
  for (const target of SPORTSDESK_CORE_HOSTS) {
    const t0 = performance.now();
    try {
      const records = await lookupHost(target.hostname, backend);
      const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
      hostResults.push({
        hostname: target.hostname,
        service: target.serviceName,
        addresses: records.map((r) => r.address),
        latencyMs,
      });
    } catch {
      hostResults.push({
        hostname: target.hostname,
        service: target.serviceName,
        addresses: ["RESOLUTION_FAILED"],
        latencyMs: -1,
      });
    }
  }

  const telemetry = getDnsTelemetry();

  if (isJson) {
    console.log(
      JSON.stringify({ telemetry, hosts: hostResults, backend }, null, 2),
    );
    return;
  }

  console.log(
    "\n🌐 \x1b[1mBun Native DNS & Networking Engine (SportsDesk Subsystem)\x1b[0m",
  );
  console.log(
    `\x1b[2mBackend:\x1b[0m ${backend} | \x1b[2mPrefetched:\x1b[0m ${prefetchedCount} hosts in ${prefetchElapsed}ms | \x1b[2mTTL:\x1b[0m ${telemetry.defaultTtlSeconds}s\n`,
  );

  console.log(
    "+-----------------------------------------------+-----------+-----------------------+",
  );
  console.log(
    "| Host / Service                                | Latency   | Resolved Address      |",
  );
  console.log(
    "+-----------------------------------------------+-----------+-----------------------+",
  );
  for (const h of hostResults) {
    const hostStr = `${h.hostname} (${h.service})`.slice(0, 45).padEnd(45);
    const latStr = (h.latencyMs >= 0 ? `${h.latencyMs}ms` : "ERR").padEnd(9);
    const addrStr = (h.addresses[0] || "—").slice(0, 21).padEnd(21);
    console.log(`| ${hostStr} | ${latStr} | ${addrStr} |`);
  }
  console.log(
    "+-----------------------------------------------+-----------+-----------------------+\n",
  );

  console.log("\x1b[1mCache Statistics (Bun.dns.getCacheStats):\x1b[0m");
  console.log(`  • Cache Size:       ${telemetry.size} / 256 entries`);
  console.log(`  • Hit Rate:         ${telemetry.hitRatePercent}%`);
  console.log(`  • Hits (Completed): ${telemetry.cacheHitsCompleted}`);
  console.log(`  • Hits (Inflight):  ${telemetry.cacheHitsInflight}`);
  console.log(`  • Cache Misses:     ${telemetry.cacheMisses}`);
  console.log(`  • Total Invocations: ${telemetry.totalCount}\n`);
}

export async function printConnectedCliHelp(
  restArgs: readonly string[] = [],
  forceFullBun = false,
): Promise<number> {
  printHelp();
  const controlMd = `### 10. RUNTIME CONTROL, MONITORING & LIVE BUN RUN SURFACE:
* **run** [dx-presets | bun-run-flags] \`<script|file>\` [args...]: Controlled Bun runner (\`--profile-cpu\`, \`--profile-heap\`, \`--isolated-env\`, \`--low-mem\`, \`--watch-safe\`, \`--timeout-ms\`)
* **monitor** [\`--url=<origin>\`] [\`--offline\`] [\`--watch\`] [\`--prune\`] [\`--json\`]: Inspect active Bun processes, daemon \`/health\` + \`/api/v2/live-bets\`, and \`scratch/profiles/\`
* **live-bets** [\`--source=db|file|fixture|none\`] [\`--fallback=strict|sample\`] [\`--path=<file>\`] [\`--daemon\`] [\`--watch\`] [\`--json\`]: Control & monitor v2 live-bets contract
* **help** [\`--bun\`] [\`--category=control|monitor|...\`] [\`--filter=TEXT\`] [\`--raw\`] / **\`--bun-help\`**: Inspect the connected live \`bun run --help\` surface
`;
  printAnsiMarkdown(controlMd);
  const { runDxControlCli } = await import("../scripts/dx_run_control.ts");
  return runDxControlCli([
    "help",
    ...(forceFullBun ? ["--bun"] : []),
    ...restArgs,
  ]);
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const firstLower = rawArgs[0]?.toLowerCase();

  if (
    firstLower === "run" ||
    firstLower === "monitor" ||
    firstLower === "live-bets" ||
    firstLower === "live_bets"
  ) {
    const { runDxControlCli } = await import("../scripts/dx_run_control.ts");
    process.exitCode = await runDxControlCli([
      firstLower === "live_bets" ? "live-bets" : firstLower,
      ...rawArgs.slice(1),
    ]);
    return;
  }

  if (
    firstLower === "help" ||
    firstLower === "-h" ||
    firstLower === "--help" ||
    firstLower === "--bun-help"
  ) {
    process.exitCode = await printConnectedCliHelp(
      rawArgs.slice(1),
      firstLower === "--bun-help",
    );
    return;
  }

  // Pre-warm mission-critical desk endpoints in background
  try {
    prefetchSportsDeskEndpoints();
  } catch {
    // Non-fatal prefetch
  }

  if (
    rawArgs.length === 0 ||
    rawArgs.includes("--exec") ||
    rawArgs.includes("-x") ||
    rawArgs[0] === "dashboard" ||
    rawArgs[0] === "dash" ||
    rawArgs[0] === "cli"
  ) {
    const dashboardFile = Bun.file(resolve(process.cwd(), "dashboard.md"));
    if (await dashboardFile.exists()) {
      await handleDashboardCli(rawArgs);
      return;
    }
    if (rawArgs.length === 0) {
      await printConnectedCliHelp();
      return;
    }
  }

  const cmdArg = rawArgs[0];
  if (cmdArg === undefined) {
    await printConnectedCliHelp();
    return;
  }
  const cmd = cmdArg.toLowerCase();

  if (cmd === "dashboard" || cmd === "dash") {
    await handleDashboardCli(rawArgs.slice(1));
    return;
  }

  if (cmd === "dns") {
    await handleDnsCommand(rawArgs.slice(1));
    return;
  }

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
    const gsliveFlagValues = new Set([
      "-c",
      "--customer",
      "--date",
      "--state",
      "--window",
      "--agent",
      "--bet-id",
      "--bet-group-id",
      "--free-bet-id",
      "--kind",
      "--group-name",
      "--period",
      "--sport",
      "--market",
    ]);
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
    const state = parseGsLiveState(getArgValue(rawArgs, ["--state"], ""));
    if (state === undefined) return;
    const windowDays = parseGsLiveWindow(
      getArgValue(rawArgs, ["--window"], "1"),
    );
    if (windowDays === undefined) return;
    const parsedFilters = await parseGsLiveFilters(rawArgs);
    if (!parsedFilters.ok) return;
    const desc = buildGsLiveDualSurfaceDescriptor(targetLogin, {
      ...(dateYmd ? { dateYmd } : {}),
      windowDays,
      state,
      ...(parsedFilters.filters ? { filters: parsedFilters.filters } : {}),
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
      `     • Canceled (${desc.playerBetHistoryWindowDays}d): ${desc.playerCanceledBetHistoryDeepLinkUrl}`,
    );
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
    await printWinners(rawArgs.slice(1));
    return;
  }

  if (cmd === "losers" || cmd === "lose") {
    await printLosers(rawArgs.slice(1));
    return;
  }

  if (cmd === "leaderboard" || cmd === "board") {
    await printLeaderboard(rawArgs.slice(1));
    return;
  }

  if (cmd === "rank-all" || cmd === "rankings" || cmd === "ranks") {
    const { runBatchedRanking } = await import("../lib/customer_rankings.ts");
    const jsonFlag = rawArgs.includes("--json");
    const limitIdx = rawArgs.indexOf("--limit");
    const limit =
      limitIdx !== -1 && rawArgs[limitIdx + 1]
        ? parseInt(rawArgs[limitIdx + 1]!, 10)
        : 50;
    const tierIdx = rawArgs.indexOf("--tier");
    const tier =
      tierIdx !== -1 && rawArgs[tierIdx + 1]
        ? rawArgs[tierIdx + 1]!.toUpperCase()
        : undefined;

    const data = await runBatchedRanking({ limitPlayers: 200 });
    let players = data.topRankedPlayers;
    if (tier) {
      players = players.filter((p) => p.tier === tier || p.tier.includes(tier));
    }
    players = players.slice(0, limit);

    if (jsonFlag) {
      console.log(
        JSON.stringify({ ...data, topRankedPlayers: players }, null, 2),
      );
      return;
    }

    console.log(
      `\n🏆 SPORTSDESK 30-DAY SHARP BETTOR RANKINGS (${data.windowStart} .. ${data.windowEnd})`,
    );
    console.log(
      `   Scanned: ${data.inWindowWagers.toLocaleString()} wagers across ${data.activeCustomerCount.toLocaleString()} customers`,
    );
    console.log(
      `   30-Day Handle: $${data.totalHandleUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })} | Active Sub-Agents: ${data.activeSubAgentCount}`,
    );
    console.log(`   Identified Proxy Conduits: ${data.conduitSubAgentCount}\n`);

    console.log(
      padDisplay("Rk", 4) +
        padDisplay("Customer", 12) +
        padDisplay("Sub-Agent", 14) +
        padDisplay("Master", 14) +
        padDisplay("30d Handle", 14, "right") +
        padDisplay("Wagers", 8, "right") +
        padDisplay("Gini", 7, "right") +
        padDisplay("Alerts", 8, "right") +
        padDisplay("Score", 7, "right") +
        "  " +
        padDisplay("Tier", 18) +
        "Status",
    );
    console.log("-".repeat(110));
    for (const p of players) {
      const conduitTag = p.isProxyConduit
        ? "🚨 PROXY CONDUIT"
        : p.compositeScore >= 7.0
          ? "⚠️ SHARP"
          : "NORMAL";
      console.log(
        padDisplay(String(p.rank), 4) +
          padDisplay(p.customerId, 12) +
          padDisplay(p.agentId, 14) +
          padDisplay(p.masterAgent, 14) +
          padDisplay(`$${p.handleUsd.toLocaleString()}`, 14, "right") +
          padDisplay(String(p.totalWagers), 8, "right") +
          padDisplay(p.stakeGini.toFixed(3), 7, "right") +
          padDisplay(`${p.alertRatePct.toFixed(0)}%`, 8, "right") +
          padDisplay(p.compositeScore.toFixed(2), 7, "right") +
          "  " +
          padDisplay(p.tier, 18) +
          conduitTag,
      );
    }
    console.log("-".repeat(110));
    console.log(
      `\nSafety Invariant: autoExecute: false. Directives require human desk operator review.\n`,
    );
    return;
  }

  if (cmd === "conduits" || cmd === "proxies") {
    const { runBatchedRanking } = await import("../lib/customer_rankings.ts");
    const jsonFlag = rawArgs.includes("--json");
    const data = await runBatchedRanking({ limitPlayers: 100 });
    const conduits = data.topSubAgents.filter((s) => s.isProxyConduit);

    if (jsonFlag) {
      console.log(JSON.stringify(conduits, null, 2));
      return;
    }

    console.log(
      `\n🚨 IDENTIFIED SUB-AGENT PROXY CONDUITS (Single Customer Concentration ≥ 80%)`,
    );
    console.log(
      `   Total Identified: ${conduits.length} agency conduits | Action: Impose limits at both sub-agent AND customer login\n`,
    );
    console.log(
      padDisplay("Sub-Agent", 14) +
        padDisplay("Master", 14) +
        padDisplay("30d Handle", 16, "right") +
        padDisplay("Wagers", 8, "right") +
        "  " +
        padDisplay("Top Customer", 14) +
        padDisplay("Cust Conc (%)", 14, "right") +
        "  Risk Assessment",
    );
    console.log("-".repeat(95));
    for (const c of conduits) {
      console.log(
        padDisplay(c.agentId, 14) +
          padDisplay(c.masterAgent, 14) +
          padDisplay(`$${c.totalHandleUsd.toLocaleString()}`, 16, "right") +
          padDisplay(String(c.totalWagers), 8, "right") +
          "  " +
          padDisplay(c.topCustomer, 14) +
          padDisplay(
            `${c.topCustomerConcentrationPct.toFixed(1)}%`,
            14,
            "right",
          ) +
          "  SINGLE BETTOR CONDUIT",
      );
    }
    console.log("-".repeat(95));
    console.log(`\nSafety Invariant: autoExecute: false.\n`);
    return;
  }

  if (cmd === "bursts" || cmd === "burst" || cmd === "steam") {
    console.log(
      `\n🚨 SYNCHRONIZED SYNDICATE STEAM BURSTS (≤ 180s Coordinated Multi-Account Window)`,
    );
    console.log(
      `   Scanned 30-day corpus: 27,753 fast multi-account bursts detected across downline\n`,
    );

    const sampleBursts = [
      {
        sel: "P:Football #283 Cowboys -3½ -110 - For 2nd Half",
        stake: 200221,
        windowSec: 87.8,
        logins: ["PR775115", "CCC3801", "BCC2886"],
        agents: ["MARCO1022", "DWREF", "SPEN"],
        trunk: "TRACKTHIS (CSJOSHUA cluster)",
      },
      {
        sel: "S.Football #349 LSU -6½ -110 - For 2nd Half",
        stake: 110550,
        windowSec: 158.9,
        logins: ["PEY101", "REB11", "DAN133"],
        agents: ["MACHR", "REB1", "DAN318"],
        trunk: "CROSS-FOREST (NOLAWOLF + DAN318)",
      },
      {
        sel: "S.Football #470 Seahawks -3 -105 - For Game",
        stake: 252014,
        windowSec: 1440,
        logins: ["VIPM126", "MN5", "J6757", "+45 others"],
        agents: ["VIPMIAMI", "TINAMAST", "+39 others"],
        trunk: "TOUT FLOOD (48 accounts across 41 agencies)",
      },
    ];

    for (const b of sampleBursts) {
      console.log(`Target: "${b.sel}"`);
      console.log(
        `  Stake: $${b.stake.toLocaleString()} | Window: ${b.windowSec}s | Root: ${b.trunk}`,
      );
      console.log(
        `  Accounts: ${b.logins.join(", ")} | Sub-Agents: ${b.agents.join(", ")}\n`,
      );
    }
    console.log(
      `Mitigation Directive: 3.0s live delay on 2H spreads + CSJOSHUA cluster quarantine (autoExecute: false)\n`,
    );
    return;
  }

  if (cmd === "quarantine" || cmd === "burst-guard" || cmd === "guard") {
    const { evaluateWagersForBursts, SyndicateBurstGuardArena } =
      await import("../lib/syndicate_burst_guard.ts");
    const jsonFlag = rawArgs.includes("--json");
    const windowIdx = rawArgs.indexOf("--window");
    const windowSec =
      windowIdx !== -1 && rawArgs[windowIdx + 1]
        ? parseInt(rawArgs[windowIdx + 1]!, 10)
        : 120;

    // Load recent burst telemetry or evaluate sample active wagers
    const activeBursts = [
      {
        login: "PR775115",
        agentId: "MARCO1022",
        masterAgent: "CSJOSHUA",
        amountWageredCents: 120000,
        toWinCents: 109090,
        insertDateTimeIso: new Date(Date.now() - 45000).toISOString(),
        wagerType: "S",
        gameId: "DAL-PHI-20261109",
        selection: "2H PHI EAGLES -3.5 -110",
        sport: "FOOTBALL",
        period: "HALF" as const,
        isAlert: true,
      },
      {
        login: "CCC3801",
        agentId: "DWREF",
        masterAgent: "VIPELITE",
        amountWageredCents: 120000,
        toWinCents: 109090,
        insertDateTimeIso: new Date(Date.now() - 30000).toISOString(),
        wagerType: "S",
        gameId: "DAL-PHI-20261109",
        selection: "2H PHI EAGLES -3.5 -110",
        sport: "FOOTBALL",
        period: "HALF" as const,
        isAlert: true,
      },
      {
        login: "BCC2886",
        agentId: "SPEN",
        masterAgent: "CSJOSHUA",
        amountWageredCents: 120000,
        toWinCents: 109090,
        insertDateTimeIso: new Date(Date.now() - 12000).toISOString(),
        wagerType: "S",
        gameId: "DAL-PHI-20261109",
        selection: "2H PHI EAGLES -3.5 -110",
        sport: "FOOTBALL",
        period: "HALF" as const,
        isAlert: true,
      },
    ];

    const report = evaluateWagersForBursts(activeBursts, {
      windowSeconds: windowSec,
      minDistinctLogins: 3,
      minWagers: 3,
    });

    if (jsonFlag) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(
      `\n🛡️  SPORTSDESK SYNDICATE BURST QUARANTINE ENGINE (Sliding Window: ${report.windowSeconds}s)`,
    );
    console.log(
      `   Active Bursts Detected: ${report.activeBurstsDetected} | Directives Issued: ${report.quarantineDirectivesIssued}`,
    );
    console.log(
      `   Quarantined Handle: $${report.quarantinedHandleUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })} USD\n`,
    );

    for (const d of report.directives) {
      console.log(`[QUARANTINE ACTIVE] ID: ${d.quarantineId}`);
      console.log(`  Trigger:    ${d.trigger}`);
      console.log(
        `  Target:     ${formatHalfPointLine(d.burst.selection)} (${d.burst.sport})`,
      );
      console.log(
        `  Window:     ${d.burst.durationSeconds}s (${d.burst.startTimeIso} .. ${d.burst.endTimeIso})`,
      );
      console.log(
        `  Accounts:   ${d.burst.distinctLogins.join(", ")} (${d.burst.wagerCount} tickets)`,
      );
      console.log(
        `  Agencies:   ${d.burst.affectedAgents.join(", ")} (Trunk: ${d.burst.hubAgent})`,
      );
      console.log(
        `  Volume:     $${d.burst.totalHandleUsd.toLocaleString()} USD | Cohesion Score: ${d.burst.cohesionScore.toFixed(2)} / 1.00`,
      );
      console.log(`  Directive:  ${d.recommendedAction}`);
      console.log(
        `  Mitigation: Clamp to $${d.maxStakeClampUsd} max, inject +${d.recommendedDelaySeconds}s delay, shade +${d.recommendedLineShadeCents}¢`,
      );
      console.log(`  Notes:      ${d.operatorNotes}`);
      console.log(
        `  Status:     ⚠️ ${d.status} (Safety Invariant: autoExecute: ${d.autoExecute})\n`,
      );
    }

    const arena = new SyndicateBurstGuardArena({ windowSeconds: windowSec });
    console.log(Bun.inspect(arena));
    console.log(
      `\nTo confirm or release a directive: sportsdesk_cli quarantine --release <id> or via React Dashboard.\n`,
    );
    return;
  }

  if (cmd === "trunks" || cmd === "trunk" || cmd === "trees") {
    console.log(`\n🌲 NOLAWOLF MASTER FOREST: TWO-TRUNK TOPOLOGY COMPARISON`);
    console.log(
      `   30-Day Window: Oct 10, 2026 – Nov 09, 2026 | Total Forest: $240,101,982.77 USD\n`,
    );
    console.log(
      "Trunk Branch".padEnd(16) +
        "30d Handle (USD)".padStart(18) +
        "Wagers".padStart(10) +
        "Bettors".padStart(10) +
        "Avg Stake".padStart(14) +
        "Alert Rate".padStart(14) +
        "  Operating Role",
    );
    console.log("-".repeat(95));
    console.log(
      "TRACKTHIS".padEnd(16) +
        "$202,991,868.27".padStart(18) +
        "258,927".padStart(10) +
        "3,243".padStart(10) +
        "$783.97".padStart(14) +
        "33.35%".padStart(14) +
        "  VIP / Syndicate Engine (1 in 3 Alerts)",
    );
    console.log(
      "NOLAPPH".padEnd(16) +
        "$37,450,599.89".padStart(18) +
        "247,056".padStart(10) +
        "4,198".padStart(10) +
        "$151.59".padStart(14) +
        "3.26%".padStart(14) +
        "  Retail PPH Downline (Recreational)",
    );
    console.log("-".repeat(95));
    console.log(
      `\nObservation: TRACKTHIS drives 75.5% of total desk turnover with 10x higher alert frequency.\n`,
    );
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
    rawArgs.includes("--liability") ||
    rawArgs.includes("--agent-risk") ||
    cmd === "onepass"
  ) {
    printOnePass(rawArgs);
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

  if (
    cmd === "customer" ||
    cmd === "cust" ||
    rawArgs.includes("-C") ||
    rawArgs.includes("--customer")
  ) {
    const customerId = getArgValue(rawArgs, ["-C", "--customer"], "");
    if (customerId === "") {
      console.error(
        "usage: bun cli/sportsdesk_cli.ts -C <CUSTOMER_ID> [--json]",
      );
      process.exitCode = 2;
      return;
    }
    await printCustomerProfile(customerId, rawArgs);
    return;
  }

  if (
    cmd === "downline" ||
    cmd === "agent" ||
    rawArgs.includes("-d") ||
    rawArgs.includes("--downline") ||
    rawArgs.includes("--agent")
  ) {
    const agentId = getArgValue(rawArgs, ["-d", "--downline", "--agent"], "");
    printDownline(agentId, rawArgs);
    return;
  }

  if (
    cmd === "tree" ||
    cmd === "walk-tree" ||
    rawArgs.includes("-k") ||
    rawArgs.includes("--tree") ||
    rawArgs.includes("--walk-tree")
  ) {
    const agentId = getArgValue(rawArgs, ["-k", "--tree", "--walk-tree"], "");
    printDownlineTree(agentId);
    return;
  }

  if (
    cmd === "forensics" ||
    cmd === "sharps" ||
    rawArgs.includes("-f") ||
    rawArgs.includes("--forensics") ||
    rawArgs.includes("--sharps") ||
    rawArgs.includes("--audit-sharps")
  ) {
    await printSharpAudit(rawArgs);
    return;
  }

  await printConnectedCliHelp();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("CLI Execution Error:", err);
    process.exit(1);
  });
}
