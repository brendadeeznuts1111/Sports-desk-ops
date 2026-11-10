import React, { useEffect, useState, useRef } from "react";
import { renderAnsiReact } from "./ansi.tsx";
import { ShadowPricingPanel } from "./ShadowPricingPanel.tsx";
import {
  debugDashboardTrace,
  getDashboardRuntimeFlags,
} from "./runtime_flags.ts";

export interface DashboardData {
  readonly markdown: string;
  readonly html: string;
  readonly updatedAt: string;
}

export interface DnsData {
  readonly telemetry: {
    readonly size: number;
    readonly hitRatePercent: number;
    readonly cacheHitsCompleted: number;
    readonly cacheHitsInflight: number;
    readonly cacheMisses: number;
    readonly defaultTtlSeconds: number;
  };
  readonly hosts: readonly {
    readonly hostname: string;
    readonly serviceName: string;
  }[];
}

export interface ShowcaseCustomer {
  readonly id: string;
  readonly name: string;
  readonly agentId: string;
  readonly masterAgent: string;
  readonly tier:
    | "TIER_1_ELITE_ORIGINATOR"
    | "TIER_2_STEAM_SYNDICATE"
    | "TIER_3_SHARP_DISCIPLINED"
    | "TIER_4_SEMI_SHARP"
    | "TIER_5_RECREATIONAL";
  readonly score: number;
  readonly clvScore: number;
  readonly skillScore: number;
  readonly sizingScore: number;
  readonly sigScore: number;
  readonly timingScore: number;
  readonly sizingStrategy: string;
  readonly gini: number;
  readonly meanStake: number;
  readonly specialization: string;
  readonly timingArchetype: string;
  readonly correlatedRisk: "NONE" | "MODERATE" | "HIGH" | "CRITICAL";
  readonly correlatedExploitRate: number;
  readonly syndicateRisk: "LOW" | "ELEVATED" | "HIGH";
  readonly syndicateProb: number;
  readonly subAccountIndex: number | null;
  readonly var95Usd: number;
  readonly cvar95Usd: number;
  readonly holdPct: number;
  readonly ltvUsd: number;
  readonly recommendedLimitUsd: number;
  readonly inPlayDelaySec: number;
  readonly lineShadeCents: number;
  readonly shadowCopyMultiplier: number;
  readonly action: string;
  readonly ipAddress: string;
}

const SAMPLE_PROFILE_DATA: ShowcaseCustomer[] = [
  {
    id: "GP301",
    name: "Golden Punter Syndicate Seat 1",
    agentId: "AG99",
    masterAgent: "MASTER_VEND",
    tier: "TIER_1_ELITE_ORIGINATOR",
    score: 9.6,
    clvScore: 3.0,
    skillScore: 2.5,
    sizingScore: 1.5,
    sigScore: 2.0,
    timingScore: 0.6,
    sizingStrategy: "PROPORTIONAL_KELLY",
    gini: 0.21,
    meanStake: 5500,
    specialization: "NFL SPREAD (Under Bias)",
    timingArchetype: "CLOSING_SNIPER",
    correlatedRisk: "CRITICAL",
    correlatedExploitRate: 0.65,
    syndicateRisk: "HIGH",
    syndicateProb: 0.85,
    subAccountIndex: null,
    var95Usd: 18500,
    cvar95Usd: 23200,
    holdPct: -8.4,
    ltvUsd: -45000,
    recommendedLimitUsd: 250,
    inPlayDelaySec: 3,
    lineShadeCents: 20,
    shadowCopyMultiplier: 1.0,
    action: "ALERT_OPERATOR",
    ipAddress: "146.190.10.20", // DigitalOcean
  },
  {
    id: "BRT5229",
    name: "Barrett Sharp Downline Root",
    agentId: "AG_SHARP",
    masterAgent: "MASTER_SYNDICATE",
    tier: "TIER_1_ELITE_ORIGINATOR",
    score: 8.9,
    clvScore: 2.8,
    skillScore: 2.2,
    sizingScore: 1.2,
    sigScore: 1.9,
    timingScore: 0.8,
    sizingStrategy: "FLAT_UNIT",
    gini: 0.12,
    meanStake: 5000,
    specialization: "NFL / CFB SPREAD",
    timingArchetype: "STEAM_CHASER",
    correlatedRisk: "HIGH",
    correlatedExploitRate: 0.5,
    syndicateRisk: "HIGH",
    syndicateProb: 0.75,
    subAccountIndex: null,
    var95Usd: 14200,
    cvar95Usd: 17800,
    holdPct: -6.2,
    ltvUsd: -32000,
    recommendedLimitUsd: 250,
    inPlayDelaySec: 3,
    lineShadeCents: 20,
    shadowCopyMultiplier: 1.0,
    action: "ALERT_OPERATOR",
    ipAddress: "54.210.88.92", // AWS
  },
  {
    id: "BRT5229_0",
    name: "Barrett Sub-Wallet Seat 0",
    agentId: "AG_SHARP",
    masterAgent: "MASTER_SYNDICATE",
    tier: "TIER_2_STEAM_SYNDICATE",
    score: 8.4,
    clvScore: 2.6,
    skillScore: 2.0,
    sizingScore: 1.2,
    sigScore: 1.8,
    timingScore: 0.8,
    sizingStrategy: "FLAT_UNIT",
    gini: 0.14,
    meanStake: 2500,
    specialization: "CFB TOTAL (Over Bias)",
    timingArchetype: "STEAM_CHASER",
    correlatedRisk: "HIGH",
    correlatedExploitRate: 0.45,
    syndicateRisk: "HIGH",
    syndicateProb: 0.9,
    subAccountIndex: 0,
    var95Usd: 8500,
    cvar95Usd: 10600,
    holdPct: -5.1,
    ltvUsd: -18000,
    recommendedLimitUsd: 500,
    inPlayDelaySec: 3,
    lineShadeCents: 15,
    shadowCopyMultiplier: 0.75,
    action: "ALERT_OPERATOR",
    ipAddress: "54.210.88.92",
  },
  {
    id: "ST100",
    name: "Steam Runner 100",
    agentId: "AG12",
    masterAgent: "MASTER_A",
    tier: "TIER_2_STEAM_SYNDICATE",
    score: 8.2,
    clvScore: 2.5,
    skillScore: 2.1,
    sizingScore: 1.2,
    sigScore: 1.5,
    timingScore: 0.9,
    sizingStrategy: "FLAT_UNIT",
    gini: 0.13,
    meanStake: 2000,
    specialization: "NFL / NBA SPREAD",
    timingArchetype: "STEAM_CHASER",
    correlatedRisk: "MODERATE",
    correlatedExploitRate: 0.3,
    syndicateRisk: "ELEVATED",
    syndicateProb: 0.4,
    subAccountIndex: null,
    var95Usd: 6800,
    cvar95Usd: 8500,
    holdPct: -4.5,
    ltvUsd: -15000,
    recommendedLimitUsd: 500,
    inPlayDelaySec: 3,
    lineShadeCents: 15,
    shadowCopyMultiplier: 0.75,
    action: "ALERT_OPERATOR",
    ipAddress: "138.68.44.12", // DigitalOcean
  },
  {
    id: "LIVE99",
    name: "In-Play Latency Hunter",
    agentId: "AG44",
    masterAgent: "MASTER_B",
    tier: "TIER_3_SHARP_DISCIPLINED",
    score: 7.8,
    clvScore: 2.4,
    skillScore: 2.0,
    sizingScore: 1.0,
    sigScore: 1.5,
    timingScore: 0.9,
    sizingStrategy: "VARIABLE_STAKE",
    gini: 0.28,
    meanStake: 1500,
    specialization: "NBA / NCAAB LIVE QUARTERS",
    timingArchetype: "HALFTIME_SPECIALIST",
    correlatedRisk: "MODERATE",
    correlatedExploitRate: 0.25,
    syndicateRisk: "ELEVATED",
    syndicateProb: 0.35,
    subAccountIndex: null,
    var95Usd: 5200,
    cvar95Usd: 6500,
    holdPct: -3.8,
    ltvUsd: -11000,
    recommendedLimitUsd: 1000,
    inPlayDelaySec: 3,
    lineShadeCents: 10,
    shadowCopyMultiplier: 0.5,
    action: "ALERT_OPERATOR",
    ipAddress: "185.12.33.4", // Hetzner
  },
  {
    id: "BK119",
    name: "Halftime Middle Specialist",
    agentId: "AG81",
    masterAgent: "MASTER_C",
    tier: "TIER_4_SEMI_SHARP",
    score: 6.4,
    clvScore: 1.8,
    skillScore: 1.6,
    sizingScore: 1.0,
    sigScore: 1.2,
    timingScore: 0.8,
    sizingStrategy: "VARIABLE_STAKE",
    gini: 0.32,
    meanStake: 800,
    specialization: "CFB / NFL 2H TOTALS",
    timingArchetype: "HALFTIME_SPECIALIST",
    correlatedRisk: "NONE",
    correlatedExploitRate: 0.0,
    syndicateRisk: "LOW",
    syndicateProb: 0.15,
    subAccountIndex: null,
    var95Usd: 2800,
    cvar95Usd: 3500,
    holdPct: -1.2,
    ltvUsd: -3000,
    recommendedLimitUsd: 2500,
    inPlayDelaySec: 2,
    lineShadeCents: 5,
    shadowCopyMultiplier: 0.25,
    action: "MONITOR",
    ipAddress: "72.14.201.5", // Residential Comcast
  },
  {
    id: "RF2003",
    name: "Recreational Retail Whale",
    agentId: "AG12",
    masterAgent: "MASTER_VEND",
    tier: "TIER_5_RECREATIONAL",
    score: 3.8,
    clvScore: 0.5,
    skillScore: 0.8,
    sizingScore: 1.2,
    sigScore: 0.5,
    timingScore: 0.4,
    sizingStrategy: "FLAT_UNIT",
    gini: 0.11,
    meanStake: 1000,
    specialization: "NFL / MLB SPREAD",
    timingArchetype: "CASUAL_GAMEDAY",
    correlatedRisk: "NONE",
    correlatedExploitRate: 0.0,
    syndicateRisk: "LOW",
    syndicateProb: 0.05,
    subAccountIndex: null,
    var95Usd: 3500,
    cvar95Usd: 4400,
    holdPct: 6.5,
    ltvUsd: 48000,
    recommendedLimitUsd: 25000,
    inPlayDelaySec: 0,
    lineShadeCents: 0,
    shadowCopyMultiplier: 0.0,
    action: "ACCEPT",
    ipAddress: "68.80.12.99", // Residential Verizon
  },
  {
    id: "SQUARE1",
    name: "Martingale Chaser Square",
    agentId: "AG05",
    masterAgent: "MASTER_RETAIL",
    tier: "TIER_5_RECREATIONAL",
    score: 1.2,
    clvScore: 0.0,
    skillScore: 0.2,
    sizingScore: 0.0,
    sigScore: 0.2,
    timingScore: 0.3,
    sizingStrategy: "MARTINGALE_CHASER",
    gini: 0.68,
    meanStake: 2500,
    specialization: "CFB PARLAYS",
    timingArchetype: "CASUAL_GAMEDAY",
    correlatedRisk: "NONE",
    correlatedExploitRate: 0.0,
    syndicateRisk: "LOW",
    syndicateProb: 0.05,
    subAccountIndex: null,
    var95Usd: 12000,
    cvar95Usd: 15000,
    holdPct: 14.2,
    ltvUsd: 95000,
    recommendedLimitUsd: 25000,
    inPlayDelaySec: 0,
    lineShadeCents: 0,
    shadowCopyMultiplier: 0.0,
    action: "ACCEPT",
    ipAddress: "99.104.22.18", // Residential AT&T
  },
];

const CLIENT_AUTOCOMPLETE_COMMANDS = [
  "profile",
  "find",
  "sharps",
  "syndicates",
  "key-numbers",
  "gini",
  "directives",
  "risk",
  "stats",
  "who",
  "dns",
  "reverse",
  "cron",
  "markdown",
  "capabilities",
  "clear",
  "help",
  "keybindings",
  "p",
  "f",
  "sh",
  "syn",
  "k",
  "g",
  "dir",
  "var",
  "stat",
  "w",
  "d",
  "r",
  "cr",
  "md",
  "cls",
  "h",
  "kb",
];

const KNOWN_ID_LIST = [
  "GP301",
  "BRT5229",
  "BRT5229_0",
  "BRT5229_1",
  "ST100",
  "LIVE99",
  "BK119",
  "RF2003",
  "SQUARE1",
  "BRT5235",
  "CCC88412",
  "MJ107",
];

const RANKED_30D_PLAYERS = [
  {
    rank: 1,
    id: "B121",
    agentId: "CHIEFXX",
    masterAgent: "NOLAWOLF",
    handleUsd: 34000,
    wagers: 6,
    gini: 0.01,
    alertRate: 67,
    score: 7.4,
    tier: "TIER_3",
    tierLabel: "Tier 3: Disciplined Sharp",
    dominantSport: "FOOTBALL",
    isProxy: false,
    limitUsd: 1000,
  },
  {
    rank: 2,
    id: "AX39",
    agentId: "ANTONIOXX",
    masterAgent: "ANTONIOXX",
    handleUsd: 800,
    wagers: 4,
    gini: 0.0,
    alertRate: 75,
    score: 7.38,
    tier: "TIER_3",
    tierLabel: "Tier 3: Disciplined Sharp",
    dominantSport: "FOOTBALL",
    isProxy: false,
    limitUsd: 1000,
  },
  {
    rank: 3,
    id: "BNN320",
    agentId: "WESTCC",
    masterAgent: "NOLAWOLF",
    handleUsd: 189250,
    wagers: 101,
    gini: 0.16,
    alertRate: 51,
    score: 7.24,
    tier: "TIER_3",
    tierLabel: "Tier 3: Disciplined Sharp",
    dominantSport: "FOOTBALL",
    isProxy: false,
    limitUsd: 1000,
  },
  {
    rank: 4,
    id: "MJ109",
    agentId: "MJ2026",
    masterAgent: "NOLAWOLF",
    handleUsd: 1280750,
    wagers: 166,
    gini: 0.213,
    alertRate: 60,
    score: 7.17,
    tier: "TIER_3",
    tierLabel: "Tier 3: Disciplined Sharp",
    dominantSport: "FOOTBALL",
    isProxy: false,
    limitUsd: 1000,
  },
  {
    rank: 5,
    id: "CCC88412",
    agentId: "FATSNOBOT",
    masterAgent: "NOLAWOLF",
    handleUsd: 6213950,
    wagers: 472,
    gini: 0.236,
    alertRate: 51,
    score: 7.16,
    tier: "TIER_3",
    tierLabel: "Tier 3: Disciplined Sharp",
    dominantSport: "FOOTBALL",
    isProxy: true,
    limitUsd: 500,
  },
  {
    rank: 6,
    id: "DAN900",
    agentId: "DAN318",
    masterAgent: "DAN318",
    handleUsd: 53288,
    wagers: 14,
    gini: 0.087,
    alertRate: 50,
    score: 7.02,
    tier: "TIER_3",
    tierLabel: "Tier 3: Disciplined Sharp",
    dominantSport: "FOOTBALL",
    isProxy: false,
    limitUsd: 1000,
  },
  {
    rank: 7,
    id: "LLB105",
    agentId: "LAND225",
    masterAgent: "NOLAWOLF",
    handleUsd: 2430275,
    wagers: 632,
    gini: 0.218,
    alertRate: 54,
    score: 6.98,
    tier: "TIER_4",
    tierLabel: "Tier 4: Semi-Sharp",
    dominantSport: "FOOTBALL",
    isProxy: true,
    limitUsd: 2500,
  },
  {
    rank: 8,
    id: "CUB109",
    agentId: "CUB22A",
    masterAgent: "CUB22A",
    handleUsd: 138100,
    wagers: 127,
    gini: 0.067,
    alertRate: 51,
    score: 6.98,
    tier: "TIER_4",
    tierLabel: "Tier 4: Semi-Sharp",
    dominantSport: "FOOTBALL",
    isProxy: false,
    limitUsd: 2500,
  },
  {
    rank: 9,
    id: "BGD101",
    agentId: "BIGDAD",
    masterAgent: "BIGDAD",
    handleUsd: 1061600,
    wagers: 50,
    gini: 0.022,
    alertRate: 50,
    score: 6.97,
    tier: "TIER_4",
    tierLabel: "Tier 4: Semi-Sharp",
    dominantSport: "CFB / NBA",
    isProxy: false,
    limitUsd: 2500,
  },
  {
    rank: 10,
    id: "RF2003",
    agentId: "FAKEMONEY",
    masterAgent: "NOLAWOLF",
    handleUsd: 53159633,
    wagers: 2207,
    gini: 0.118,
    alertRate: 4,
    score: 6.85,
    tier: "TIER_4",
    tierLabel: "Tier 4: Semi-Sharp (Whale)",
    dominantSport: "FOOTBALL / SOCCER",
    isProxy: true,
    limitUsd: 2500,
  },
  {
    rank: 11,
    id: "VIPM126",
    agentId: "VIPMIAMI",
    masterAgent: "NOLAWOLF",
    handleUsd: 9999500,
    wagers: 109,
    gini: 0.23,
    alertRate: 15,
    score: 6.82,
    tier: "TIER_4",
    tierLabel: "Tier 4: Semi-Sharp (Sniper)",
    dominantSport: "FOOTBALL",
    isProxy: true,
    limitUsd: 2500,
  },
  {
    rank: 12,
    id: "MJ107",
    agentId: "MJ2026",
    masterAgent: "NOLAWOLF",
    handleUsd: 3905000,
    wagers: 142,
    gini: 0.031,
    alertRate: 51,
    score: 6.8,
    tier: "TIER_4",
    tierLabel: "Tier 4: Semi-Sharp (Flat-Unit)",
    dominantSport: "FOOTBALL",
    isProxy: false,
    limitUsd: 2500,
  },
];

const PROXY_CONDUITS_30D = [
  {
    agentId: "FAKEMONEY",
    masterAgent: "NOLAWOLF",
    handleUsd: 53159633,
    wagers: 2207,
    topCust: "RF2003",
    concPct: 100.0,
  },
  {
    agentId: "VIPMIAMI",
    masterAgent: "NOLAWOLF",
    handleUsd: 10974400,
    wagers: 157,
    topCust: "VIPM126",
    concPct: 91.1,
  },
  {
    agentId: "FATSSIDE",
    masterAgent: "NOLAWOLF",
    handleUsd: 10032126,
    wagers: 2604,
    topCust: "CCC109",
    concPct: 81.9,
  },
  {
    agentId: "FATSNOBOT",
    masterAgent: "NOLAWOLF",
    handleUsd: 6536776,
    wagers: 1818,
    topCust: "CCC88412",
    concPct: 95.1,
  },
  {
    agentId: "MACHR25",
    masterAgent: "NOLAWOLF",
    handleUsd: 6337320,
    wagers: 86,
    topCust: "RFF2000",
    concPct: 100.0,
  },
  {
    agentId: "DWREF",
    masterAgent: "NOLAWOLF",
    handleUsd: 3695570,
    wagers: 80,
    topCust: "CCC3801",
    concPct: 87.0,
  },
  {
    agentId: "JUICEPLUS",
    masterAgent: "NOLAWOLF",
    handleUsd: 3690975,
    wagers: 324,
    topCust: "ABC700",
    concPct: 100.0,
  },
  {
    agentId: "MACHR",
    masterAgent: "NOLAWOLF",
    handleUsd: 3507200,
    wagers: 79,
    topCust: "PEY101",
    concPct: 100.0,
  },
  {
    agentId: "LAZER22",
    masterAgent: "NOLAWOLF",
    handleUsd: 3210700,
    wagers: 161,
    topCust: "GL205",
    concPct: 100.0,
  },
  {
    agentId: "LAND225",
    masterAgent: "NOLAWOLF",
    handleUsd: 2435849,
    wagers: 718,
    topCust: "LLB105",
    concPct: 99.8,
  },
];

interface BuildMatrixRow {
  readonly target: string;
  readonly features: readonly string[];
  readonly totalJsBytes: number;
  readonly totalCssBytes: number;
  readonly hasDebugSentinel: boolean;
  readonly hasExperimentalSentinel: boolean;
  readonly hasProdSentinel: boolean;
}

type DashboardTabId =
  "surveillance" | "customers" | "terminal" | "rankings" | "shadow";

function resolveInitialTab(): DashboardTabId {
  if (typeof window === "undefined") return "customers";
  const raw = new URLSearchParams(window.location.search).get("tab");
  if (
    raw === "shadow" ||
    raw === "surveillance" ||
    raw === "customers" ||
    raw === "terminal" ||
    raw === "rankings"
  ) {
    return raw;
  }
  return "customers";
}

export function App(): React.ReactElement {
  const runtimeFlags = getDashboardRuntimeFlags();
  const [activeTab, setActiveTab] = useState<DashboardTabId>(resolveInitialTab);
  const [showBuildMatrix, setShowBuildMatrix] = useState<boolean>(() =>
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("matrix") === "1"
      : false,
  );
  const [buildMatrixRows, setBuildMatrixRows] = useState<
    readonly BuildMatrixRow[] | null
  >(null);
  const [buildMatrixLoading, setBuildMatrixLoading] = useState<boolean>(false);
  const [rankingsFilter, setRankingsFilter] = useState<
    "ALL" | "CONDUITS" | "TIER3" | "WHALES"
  >("ALL");
  const [rankingsSearch, setRankingsSearch] = useState<string>("");
  const [data, setData] = useState<DashboardData | null>(null);
  const [dnsData, setDnsData] = useState<DnsData | null>(null);
  const [viewMode, setViewMode] = useState<"interactive" | "raw">(
    "interactive",
  );
  const [connected, setConnected] = useState(false);
  const [benchResult, setBenchResult] = useState<string | null>(null);
  const [benchLoading, setBenchLoading] = useState(false);
  const [reverseIp, setReverseIp] = useState("1.1.1.1");
  const [reverseResult, setReverseResult] = useState<string | null>(null);

  // Customer Showcase state
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTier, setFilterTier] = useState<string>("ALL");
  const [copiedCliId, setCopiedCliId] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] =
    useState<ShowcaseCustomer | null>(SAMPLE_PROFILE_DATA[0] ?? null);
  const [customerForensicResult, setCustomerForensicResult] = useState<
    string | null
  >(null);

  // Terminal Emulator state
  const [terminalHistory, setTerminalHistory] = useState<
    Array<{
      command: string;
      stdout: string;
      exitCode: number;
      durationMs: number;
      timestamp: number;
    }>
  >([
    {
      command: "help",
      stdout:
        "\x1b[1;36m╔════════════════════════════════════════════════════════════════════════════╗\x1b[0m\n" +
        "\x1b[1;36m║   ⚡ SPORTSDESK & FANTASY402 INTERACTIVE PTY TERMINAL (Bun.Terminal)     ║\x1b[0m\n" +
        "\x1b[1;36m╚════════════════════════════════════════════════════════════════════════════╝\x1b[0m\n" +
        "\x1b[90mEngine: Bun.spawn + Bun.Terminal PTY · Host: sportsdesk-ops · Invariant: autoExecute: false\x1b[0m\n\n" +
        "\x1b[1;33mCommands & Canonical Shortcodes:\x1b[0m\n" +
        "  \x1b[1;32mprofile <id>\x1b[0m (aliases: \x1b[32mp, c\x1b[0m) Inspect multidimensional sharpness radar (flags: \x1b[36m--radar\x1b[0m, \x1b[36m--json\x1b[0m, \x1b[36m--wagers\x1b[0m)\n" +
        "  \x1b[1;32mfind <query>\x1b[0m (aliases: \x1b[32mf, s\x1b[0m) Search accounts (flags: \x1b[36m-t <tier>\x1b[0m, \x1b[36m-s <sport>\x1b[0m, \x1b[36m-a <action>\x1b[0m)\n" +
        "  \x1b[1;32msharps\x1b[0m (aliases: \x1b[32msh, top\x1b[0m)    Top sharp originators ranked by Sharpness Composite Index\n" +
        "  \x1b[1;32msyndicates\x1b[0m (aliases: \x1b[32msyn\x1b[0m)       Detected hook syndicate clusters & sub-accounts\n" +
        "  \x1b[1;32mkey-numbers\x1b[0m (aliases: \x1b[32mk, keys\x1b[0m) Football key number buyers (3, 7, 10, 14, 21) hit rates & edge\n" +
        "  \x1b[1;32mgini\x1b[0m (alias: \x1b[32mg\x1b[0m)               Stake inequality Gini rankings (flat unit vs Kelly vs martingale)\n" +
        "  \x1b[1;32mdirectives\x1b[0m (aliases: \x1b[32mdir\x1b[0m)     Actionable desk directives, limit caps & in-play delays\n" +
        "  \x1b[1;32mrisk\x1b[0m (aliases: \x1b[32mvar, cvar\x1b[0m)       7d Value-at-Risk (95%), CVaR shortfall & hold %\n" +
        "  \x1b[1;32mstats\x1b[0m (aliases: \x1b[32mstat\x1b[0m)          Full cohort breakdown & capital protection metrics\n" +
        "  \x1b[1;32mwho\x1b[0m (alias: \x1b[32mw\x1b[0m)                Operator desk, session, worktree & Bun runtime info\n" +
        "  \x1b[1;32mkeybindings\x1b[0m (alias: \x1b[32mkb\x1b[0m)        Terminal & GUI keyboard shortcuts cheat sheet\n" +
        "  \x1b[1;32mdns <host>\x1b[0m (alias: \x1b[32md\x1b[0m)         Benchmark c-ares vs system DNS resolver latency\n" +
        "  \x1b[1;32mreverse <ip>\x1b[0m (alias: \x1b[32mr, ip\x1b[0m)     Reverse DNS forensics & datacenter/residential IP lookup\n" +
        "  \x1b[1;32mcron <expr>\x1b[0m (alias: \x1b[32mcr\x1b[0m)        Inspect Bun.cron() schedule triggers\n" +
        "  \x1b[1;32mmarkdown\x1b[0m (alias: \x1b[32mmd\x1b[0m)           Render Markdown via native Bun.markdown.ansi\n" +
        "  \x1b[1;32mclear\x1b[0m (alias: \x1b[32mcls\x1b[0m)             Clear terminal screen buffer\n" +
        "  \x1b[1;32mhelp\x1b[0m (aliases: \x1b[32mh, ?\x1b[0m)           Display this reference manual\n\n" +
        "\x1b[1;33mKeyboard Shortcuts:\x1b[0m \x1b[36m[Tab]\x1b[0m Autocomplete · \x1b[36m[Ctrl+` / Cmd+K]\x1b[0m Toggle PTY · \x1b[36m[Ctrl+1/2/3]\x1b[0m Tabs · \x1b[36m[Ctrl+L]\x1b[0m Clear",
      exitCode: 0,
      durationMs: 0,
      timestamp: Date.now(),
    },
  ]);
  const [terminalCommand, setTerminalCommand] = useState("");
  const [commandHistory, setCommandHistory] = useState<string[]>([
    "help",
    "p GP301",
    "sh",
    "k",
    "g",
    "dir",
    "var",
    "stat",
    "w",
    "kb",
  ]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [terminalLoading, setTerminalLoading] = useState(false);
  const terminalBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey && e.key === "`") ||
        ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")
      ) {
        e.preventDefault();
        setActiveTab("terminal");
        setTimeout(() => {
          const inputEl = document.querySelector<HTMLInputElement>(
            "input[data-terminal-input]",
          );
          inputEl?.focus();
        }, 50);
      } else if (e.ctrlKey && e.key === "1") {
        e.preventDefault();
        setActiveTab("customers");
      } else if (e.ctrlKey && e.key === "2") {
        e.preventDefault();
        setActiveTab("surveillance");
      } else if (e.ctrlKey && e.key === "3") {
        e.preventDefault();
        setActiveTab("terminal");
        setTimeout(() => {
          const inputEl = document.querySelector<HTMLInputElement>(
            "input[data-terminal-input]",
          );
          inputEl?.focus();
        }, 50);
      } else if (e.ctrlKey && e.key === "4") {
        e.preventDefault();
        setActiveTab("rankings");
      } else if (e.ctrlKey && e.key === "5") {
        e.preventDefault();
        setActiveTab("shadow");
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  const handleAutocomplete = () => {
    const trimmed = terminalCommand.trimStart();
    if (!trimmed) {
      setTerminalCommand("help");
      return;
    }

    const tokens = trimmed.split(/\s+/);
    if (tokens.length === 1) {
      const prefix = tokens[0]!.toLowerCase();
      const cmdMatch = CLIENT_AUTOCOMPLETE_COMMANDS.find((c) =>
        c.toLowerCase().startsWith(prefix),
      );
      if (cmdMatch) {
        setTerminalCommand(cmdMatch + " ");
        return;
      }
      const idMatch = KNOWN_ID_LIST.find((id) =>
        id.toLowerCase().startsWith(prefix),
      );
      if (idMatch) {
        setTerminalCommand("p " + idMatch);
        return;
      }
    } else if (tokens.length === 2) {
      const cmd = tokens[0]!.toLowerCase();
      const argPrefix = tokens[1]!.toUpperCase();
      if (cmd === "profile" || cmd === "p" || cmd === "c") {
        const idMatch = KNOWN_ID_LIST.find((id) =>
          id.toUpperCase().startsWith(argPrefix),
        );
        if (idMatch) {
          setTerminalCommand(`${tokens[0]} ${idMatch}`);
          return;
        }
      } else if (cmd === "find" || cmd === "f") {
        const candidates = [
          "-t",
          "-s",
          "-a",
          "sharp",
          "syndicate",
          "CFB",
          "NFL",
        ];
        const match = candidates.find((c) =>
          c.toLowerCase().startsWith(tokens[1]!.toLowerCase()),
        );
        if (match) {
          setTerminalCommand(`${tokens[0]} ${match} `);
          return;
        }
      }
    }
  };

  const runTerminalCommand = async (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    if (trimmed.toLowerCase() === "clear") {
      setTerminalHistory([]);
      setTerminalCommand("");
      return;
    }

    setCommandHistory((prev) => [
      ...prev.filter((c) => c !== trimmed),
      trimmed,
    ]);
    setHistoryIndex(-1);
    setTerminalLoading(true);

    try {
      const res = await fetch("/api/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: trimmed, cols: 100, rows: 30 }),
      });

      if (res.ok) {
        const json = await res.json();
        setTerminalHistory((prev) => [...prev, json]);
      } else {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setTerminalHistory((prev) => [
          ...prev,
          {
            command: trimmed,
            stdout: `\x1b[31m[TERMINAL_ERROR] ${err.error || "Failed execution"}\x1b[0m`,
            exitCode: 1,
            durationMs: 0,
            timestamp: Date.now(),
          },
        ]);
      }
    } catch {
      // Local client fallback
      const upper = trimmed.toUpperCase();
      const cust = SAMPLE_PROFILE_DATA.find((c) => c.id === upper);
      let stdout = "";
      if (cust) {
        stdout =
          `\x1b[1;36m🎯 SPORTSDESK BEHAVIORAL PROFILE: ${cust.id}\x1b[0m\n` +
          `  Name: ${cust.name} | Agent: ${cust.agentId} | Tier: \x1b[1;33m${cust.tier}\x1b[0m (Score: \x1b[1m${cust.score}/10\x1b[0m)\n` +
          `  Strategy: ${cust.sizingStrategy} | Stake Gini: \x1b[1m${cust.gini}\x1b[0m | Mean Stake: $${cust.meanStake}\n` +
          `  Timing: ${cust.timingArchetype} | Correlated Risk: \x1b[31m${cust.correlatedRisk}\x1b[0m\n` +
          `  7d VaR (95%): $${cust.var95Usd.toLocaleString()} | Hold: ${cust.holdPct}%\n` +
          `  Recommended Limit: \x1b[1m$${cust.recommendedLimitUsd.toLocaleString()}\x1b[0m | Action: \x1b[1;31m${cust.action}\x1b[0m`;
      } else {
        stdout = `\x1b[33m[OFFLINE_FALLBACK] Executed: ${trimmed}\x1b[0m\n\x1b[90m(Start dev server via 'bun run dev' for live Bun.Terminal PTY)\x1b[0m`;
      }
      setTerminalHistory((prev) => [
        ...prev,
        {
          command: trimmed,
          stdout,
          exitCode: 0,
          durationMs: 5,
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setTerminalLoading(false);
      setTerminalCommand("");
      setTimeout(() => {
        terminalBottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 50);
    }
  };

  const runBenchmark = async () => {
    setBenchLoading(true);
    try {
      const res = await fetch("/api/dns/benchmark?host=fantasy402.com");
      if (res.ok) {
        const json = await res.json();
        const metricsStr = (
          json.metrics as Array<{ backend: string; meanMs: number }>
        )
          .map((m) => `${m.backend}: ${m.meanMs}ms`)
          .join(" vs ");
        setBenchResult(
          `⚡ Fastest: ${json.fastestBackend} (${json.speedupFactor}x speedup) | ${metricsStr}`,
        );
      }
    } catch {
      setBenchResult("Benchmark failed");
    } finally {
      setBenchLoading(false);
    }
  };

  const runReverseLookup = async (ipToLookup?: string) => {
    const ip = ipToLookup || reverseIp;
    try {
      const res = await fetch(`/api/dns/reverse?ip=${encodeURIComponent(ip)}`);
      if (res.ok) {
        const json = await res.json();
        const resultMsg = `🔍 ${json.organization} | Cloud/DC: ${json.isDatacenterOrCloud ? "🚨 YES" : "NO"} | Proxy/VPN: ${json.isVpnOrProxySuspicious ? "⚠️ YES" : "NO"} | Host: ${json.primaryHostname || "none"}`;
        if (ipToLookup) {
          setCustomerForensicResult(resultMsg);
        } else {
          setReverseResult(resultMsg);
        }
      }
    } catch {
      if (ipToLookup) {
        setCustomerForensicResult("Lookup failed");
      } else {
        setReverseResult("Lookup failed");
      }
    }
  };

  const fetchDashboard = async () => {
    try {
      const [dashRes, dnsRes] = await Promise.all([
        fetch("/api/dashboard"),
        fetch("/api/dns"),
      ]);
      if (dashRes.ok) {
        const json = (await dashRes.json()) as DashboardData;
        setData(json);
      }
      if (dnsRes.ok) {
        const json = (await dnsRes.json()) as DnsData;
        setDnsData(json);
      }
    } catch (err) {
      console.error("Failed to load dashboard data:", err);
    }
  };

  useEffect(() => {
    fetchDashboard();

    // Hot-reload WebSocket connection
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (event) => {
      if (event.data === "reload" || event.data === "dashboard-updated") {
        fetchDashboard();
      }
    };

    return () => ws.close();
  }, []);

  const filteredCustomers = SAMPLE_PROFILE_DATA.filter((cust) => {
    const matchesSearch =
      cust.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cust.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cust.specialization.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cust.agentId.toLowerCase().includes(searchQuery.toLowerCase());

    if (!matchesSearch) return false;
    if (filterTier === "ALL") return true;
    if (filterTier === "ELITE")
      return (
        cust.tier === "TIER_1_ELITE_ORIGINATOR" ||
        cust.tier === "TIER_2_STEAM_SYNDICATE"
      );
    if (filterTier === "SYNDICATE") return cust.syndicateRisk === "HIGH";
    if (filterTier === "STEAM") return cust.timingArchetype === "STEAM_CHASER";
    if (filterTier === "RECREATIONAL")
      return cust.tier === "TIER_5_RECREATIONAL";
    return true;
  });

  return (
    <div style={styles.container}>
      {/* Global Header */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <h1 style={styles.title}>⚡ SportsDesk & Fantasy402 Operations</h1>
          <span style={styles.badge(connected)}>
            {connected ? "● Live Hot-Reload Connected" : "○ Disconnected"}
          </span>
          <button
            type="button"
            className="sd-pill sd-mono"
            style={{ cursor: "pointer" }}
            onClick={() => {
              const next = !showBuildMatrix;
              setShowBuildMatrix(next);
              if (next && !buildMatrixRows && !buildMatrixLoading) {
                setBuildMatrixLoading(true);
                fetch("/api/build-matrix")
                  .then((r) =>
                    r.ok
                      ? (r.json() as Promise<{
                          targets?: readonly BuildMatrixRow[];
                        }>)
                      : null,
                  )
                  .then((json) => {
                    if (json?.targets) {
                      debugDashboardTrace("loaded DCE build matrix", json);
                      setBuildMatrixRows(json.targets);
                    }
                  })
                  .catch((err) => {
                    console.warn("Build matrix probe unavailable:", err);
                  })
                  .finally(() => setBuildMatrixLoading(false));
              }
            }}
            title="Inspect compile-time bun:bundle dead-code elimination & tokens.toml CSS Houdini registry"
          >
            🧬 Target: {runtimeFlags.target.toUpperCase()} (
            {runtimeFlags.enabledFeatures.length > 0
              ? runtimeFlags.enabledFeatures.join("+")
              : "HMR"}
            )
          </button>
        </div>
        <div style={styles.tabNav}>
          <button
            style={styles.tabBtn(activeTab === "customers")}
            onClick={() => setActiveTab("customers")}
          >
            👥 Customer Profiling
          </button>
          <button
            style={styles.tabBtn(activeTab === "shadow")}
            onClick={() => setActiveTab("shadow")}
          >
            ⚖️ Shadow Pricing (#135)
          </button>
          <button
            style={styles.tabBtn(activeTab === "surveillance")}
            onClick={() => setActiveTab("surveillance")}
          >
            📊 Surveillance Telemetry
          </button>
          <button
            style={styles.tabBtn(activeTab === "terminal")}
            onClick={() => setActiveTab("terminal")}
          >
            💻 Terminal (Bun.Terminal)
          </button>
          <button
            style={styles.tabBtn(activeTab === "rankings")}
            onClick={() => setActiveTab("rankings")}
          >
            🏆 30D Sharps & Agency
          </button>
        </div>
      </header>

      {showBuildMatrix ? (
        <section
          style={{
            padding: "14px 24px",
            backgroundColor: "var(--sd-surface-cli)",
            borderBottom: "1px solid var(--sd-surface-border)",
          }}
        >
          <div
            style={{
              maxWidth: "1600px",
              margin: "0 auto",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "8px",
              }}
            >
              <strong style={{ fontSize: "13px" }}>
                🧬 Compile-Time <code>bun:bundle</code> DCE Matrix &amp;{" "}
                <code>design/tokens.toml</code> Houdini Palette
              </strong>
              <span
                className="sd-mono"
                style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}
              >
                Active Bundle Sentinel: {runtimeFlags.dceMarker}
              </span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {[
                ["--sd-surface-bg", "Obsidian"],
                ["--sd-surface-card", "Card"],
                ["--sd-tier-alert", "Alert L21"],
                ["--sd-tier-steam", "Steam L22"],
                ["--sd-tier-whale", "Whale L23"],
                ["--sd-tier-rec-bias", "Rec L24"],
                ["--sd-theme-emerald", "Gateway L20"],
                ["--sd-route-sharp", "Sharp R02"],
                ["--sd-route-devig", "Devig R04"],
                ["--sd-route-manager", "Manager R03"],
              ].map(([token, label]) => (
                <span key={token} className="sd-pill sd-mono">
                  <span
                    className="sd-token-swatch"
                    style={{ backgroundColor: `var(${token})` }}
                  />
                  {label}: {token}
                </span>
              ))}
            </div>
            {buildMatrixLoading ? (
              <div style={{ fontSize: "12px", color: "var(--sd-text-muted)" }}>
                Compiling live <code>prod</code> / <code>dev</code> /{" "}
                <code>test</code> bundles via <code>Bun.build</code>…
              </div>
            ) : buildMatrixRows ? (
              <table style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <th>Target</th>
                    <th>Enabled bun:bundle Flags</th>
                    <th>JS Bundle</th>
                    <th>CSS Tokens + Chrome</th>
                    <th>PROD Branch</th>
                    <th>DEBUG Branch</th>
                    <th>EXPERIMENTAL Branch</th>
                  </tr>
                </thead>
                <tbody>
                  {buildMatrixRows.map((r) => (
                    <tr key={r.target}>
                      <td className="sd-mono">
                        <strong>{r.target}</strong>
                      </td>
                      <td className="sd-mono">{r.features.join(", ")}</td>
                      <td className="sd-mono">
                        {(r.totalJsBytes / 1024).toFixed(1)} KB
                      </td>
                      <td className="sd-mono">
                        {(r.totalCssBytes / 1024).toFixed(1)} KB
                      </td>
                      <td className="sd-mono">
                        {r.hasProdSentinel ? "✅ Kept" : "✂️ Pruned (DCE)"}
                      </td>
                      <td className="sd-mono">
                        {r.hasDebugSentinel ? "✅ Kept" : "✂️ Pruned (DCE)"}
                      </td>
                      <td className="sd-mono">
                        {r.hasExperimentalSentinel
                          ? "✅ Kept"
                          : "✂️ Pruned (DCE)"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Main View Area */}
      <main style={styles.main}>
        {activeTab === "customers" ? (
          <div>
            {/* Session Notice Banner */}
            <div
              style={{
                marginBottom: "16px",
                padding: "10px 14px",
                borderRadius: "8px",
                background: "rgba(245, 158, 11, 0.1)",
                border: "1px solid rgba(245, 158, 11, 0.2)",
                fontSize: "12px",
                color: "#fbbf24",
                display: "flex",
                alignItems: "flex-start",
                gap: "10px",
              }}
            >
              <span style={{ fontSize: "16px", lineHeight: "1" }}>⚠️</span>
              <div>
                <b>Fantasy402 Portal Session Notice:</b> Direct portal links
                require an active, authenticated manager session in your
                browser. If you encounter <i>"Your session has expired"</i>, log
                into fantasy402.com first. For instant local telemetry, all
                accounts are profiled below; click any row/ID to inspect or use{" "}
                <b>📋 Copy CLI</b>.
              </div>
            </div>

            {/* KPI Summary Cards */}
            <div style={styles.kpiGrid}>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Backtest Cohort</div>
                <div style={styles.kpiVal}>49 Accounts</div>
                <div style={styles.kpiSub}>4-Wk CFB/NBA Backtest (docs/)</div>
              </div>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Key Number Sharps</div>
                <div style={styles.kpiVal}>5 Elite Accounts</div>
                <div style={styles.kpiSub}>
                  Football 3, 7, 10, 14, 21 Watchlist
                </div>
              </div>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Hook Syndicates</div>
                <div style={styles.kpiVal}>5 Downlines</div>
                <div style={styles.kpiSub}>Half-Point Syndicate Clusters</div>
              </div>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>CI Synthetic Fixtures</div>
                <div style={styles.kpiVal}>6 Accounts</div>
                <div style={styles.kpiSub}>Regression Testing Fixtures</div>
              </div>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Local Customer Book</div>
                <div style={styles.kpiVal}>220 Accounts</div>
                <div style={styles.kpiSub}>
                  1,100 Sampled Tickets (29 Agents)
                </div>
              </div>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Broad Surveillance</div>
                <div style={styles.kpiVal}>4,914 IDs</div>
                <div style={styles.kpiSub}>Captures & Weblog Streams</div>
              </div>
            </div>

            {/* Filter and Search Bar */}
            <div style={styles.filterBar}>
              <input
                style={styles.searchInput}
                placeholder="🔍 Search by Customer ID, Name, Agent or Sport..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <div style={styles.filterPills}>
                <button
                  style={styles.pill(filterTier === "ALL")}
                  onClick={() => setFilterTier("ALL")}
                >
                  All Profiles
                </button>
                <button
                  style={styles.pill(filterTier === "ELITE")}
                  onClick={() => setFilterTier("ELITE")}
                >
                  🚨 Elite Sharps
                </button>
                <button
                  style={styles.pill(filterTier === "SYNDICATE")}
                  onClick={() => setFilterTier("SYNDICATE")}
                >
                  🔗 Syndicates
                </button>
                <button
                  style={styles.pill(filterTier === "STEAM")}
                  onClick={() => setFilterTier("STEAM")}
                >
                  ⚡ Steam Chasers
                </button>
                <button
                  style={styles.pill(filterTier === "RECREATIONAL")}
                  onClick={() => setFilterTier("RECREATIONAL")}
                >
                  ✅ High-Hold Whales
                </button>
              </div>
            </div>

            {/* Two-Column Grid: Customer Table & Deep Inspector */}
            <div style={styles.showcaseGrid}>
              {/* Left Column: Customers Table */}
              <div style={styles.tablePanel}>
                <h3 style={styles.panelTitle}>
                  Profiled Bettors ({filteredCustomers.length})
                </h3>
                <div style={styles.tableContainer}>
                  <table style={styles.table}>
                    <thead>
                      <tr style={styles.thRow}>
                        <th style={styles.th}>Customer</th>
                        <th style={styles.th}>Unified Sharpness</th>
                        <th style={styles.th}>Sizing Strategy</th>
                        <th style={styles.th}>Specialization</th>
                        <th style={styles.th}>Correlated Par</th>
                        <th style={styles.th}>7d VaR (95%)</th>
                        <th style={styles.th}>Desk Directive</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCustomers.map((cust) => {
                        const isSelected = selectedCustomer?.id === cust.id;
                        return (
                          <tr
                            key={cust.id}
                            style={styles.tr(isSelected)}
                            onClick={() => {
                              setSelectedCustomer(cust);
                              setCustomerForensicResult(null);
                            }}
                          >
                            <td style={styles.td}>
                              <div style={styles.custCell}>
                                <span
                                  style={{
                                    ...styles.custLink,
                                    cursor: "pointer",
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedCustomer(cust);
                                    setCustomerForensicResult(null);
                                  }}
                                >
                                  {cust.id}
                                </span>
                                {cust.subAccountIndex !== null && (
                                  <span style={styles.subBadge}>
                                    Seat #{cust.subAccountIndex}
                                  </span>
                                )}
                              </div>
                              <div style={styles.custAgent}>
                                Agent: {cust.agentId}
                              </div>
                            </td>
                            <td style={styles.td}>
                              <span style={styles.tierBadge(cust.tier)}>
                                {cust.score.toFixed(1)}/10 ·{" "}
                                {cust.tier.replace("TIER_", "T")}
                              </span>
                            </td>
                            <td style={styles.td}>
                              <div>{cust.sizingStrategy}</div>
                              <div style={styles.custSub}>
                                Gini: {cust.gini.toFixed(3)}
                              </div>
                            </td>
                            <td style={styles.td}>
                              <div>{cust.specialization}</div>
                              <div style={styles.custSub}>
                                {cust.timingArchetype}
                              </div>
                            </td>
                            <td style={styles.td}>
                              <span
                                style={styles.corrBadge(cust.correlatedRisk)}
                              >
                                {cust.correlatedRisk}
                              </span>
                            </td>
                            <td style={styles.td}>
                              <div>${cust.var95Usd.toLocaleString()}</div>
                              <div
                                style={{
                                  ...styles.custSub,
                                  color:
                                    cust.holdPct < 0 ? "#f87171" : "#4ade80",
                                }}
                              >
                                Hold: {cust.holdPct}%
                              </div>
                            </td>
                            <td style={styles.td}>
                              <span style={styles.actionBadge(cust.action)}>
                                {cust.action}
                              </span>
                              <div style={styles.custSub}>
                                Cap: $
                                {cust.recommendedLimitUsd.toLocaleString()}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Right Column: Deep-Dive Inspector */}
              <div style={styles.inspectorPanel}>
                {selectedCustomer ? (
                  <div>
                    <div style={styles.inspectorHeader}>
                      <div>
                        <h2 style={styles.inspectorTitle}>
                          {selectedCustomer.id}
                        </h2>
                        <div style={styles.inspectorSub}>
                          {selectedCustomer.name} · Agent:{" "}
                          <b>{selectedCustomer.agentId}</b> (Master:{" "}
                          <b>{selectedCustomer.masterAgent}</b>)
                        </div>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <button
                          type="button"
                          style={{
                            ...styles.actionBtn,
                            padding: "4px 8px",
                            fontSize: "11px",
                            cursor: "pointer",
                          }}
                          onClick={() => {
                            setActiveTab("terminal");
                            runTerminalCommand(
                              `profile ${selectedCustomer.id}`,
                            );
                          }}
                          title="Inspect this customer in Bun.Terminal emulator"
                        >
                          💻 Terminal
                        </button>
                        <button
                          type="button"
                          style={{
                            ...styles.actionBtn,
                            padding: "4px 8px",
                            fontSize: "11px",
                            cursor: "pointer",
                          }}
                          onClick={() => {
                            const cmd = `bun run cli -C ${selectedCustomer.id}`;
                            navigator.clipboard.writeText(cmd);
                            setCopiedCliId(selectedCustomer.id);
                            setTimeout(() => setCopiedCliId(null), 2000);
                          }}
                          title="Copy terminal CLI command to clipboard"
                        >
                          {copiedCliId === selectedCustomer.id
                            ? "✓ Copied CLI"
                            : "📋 Copy CLI"}
                        </button>
                        <a
                          href={`https://fantasy402.com/manager.html?customer=${selectedCustomer.id}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            ...styles.actionBtn,
                            padding: "4px 8px",
                            fontSize: "11px",
                            textDecoration: "none",
                            color: "#38bdf8",
                          }}
                          title="Requires active Fantasy402 manager session in your browser"
                        >
                          Portal ↗
                        </a>
                        <span style={styles.tierBadge(selectedCustomer.tier)}>
                          {selectedCustomer.tier} (Score:{" "}
                          {selectedCustomer.score.toFixed(1)}/10.0)
                        </span>
                      </div>
                    </div>

                    {/* Decomposed Score Progress Bars */}
                    <div style={styles.radarCard}>
                      <h4 style={styles.cardHeader}>
                        🎯 Decomposed Sharpness Radars
                      </h4>
                      <div style={styles.radarRow}>
                        <span>
                          CLV Beat Margin ({selectedCustomer.clvScore}/3.0):
                        </span>
                        <div style={styles.progressBarBg}>
                          <div
                            style={styles.progressBarFill(
                              (selectedCustomer.clvScore / 3.0) * 100,
                              "#38bdf8",
                            )}
                          />
                        </div>
                      </div>
                      <div style={styles.radarRow}>
                        <span>
                          Bayesian Skill ({selectedCustomer.skillScore}/2.5):
                        </span>
                        <div style={styles.progressBarBg}>
                          <div
                            style={styles.progressBarFill(
                              (selectedCustomer.skillScore / 2.5) * 100,
                              "#a855f7",
                            )}
                          />
                        </div>
                      </div>
                      <div style={styles.radarRow}>
                        <span>
                          Sizing Discipline ({selectedCustomer.sizingScore}
                          /1.5):
                        </span>
                        <div style={styles.progressBarBg}>
                          <div
                            style={styles.progressBarFill(
                              (selectedCustomer.sizingScore / 1.5) * 100,
                              "#22c55e",
                            )}
                          />
                        </div>
                      </div>
                      <div style={styles.radarRow}>
                        <span>
                          Signature Specialization ({selectedCustomer.sigScore}
                          /2.0):
                        </span>
                        <div style={styles.progressBarBg}>
                          <div
                            style={styles.progressBarFill(
                              (selectedCustomer.sigScore / 2.0) * 100,
                              "#f59e0b",
                            )}
                          />
                        </div>
                      </div>
                      <div style={styles.radarRow}>
                        <span>
                          Timing / Parlay Exploitation (
                          {selectedCustomer.timingScore}/1.0):
                        </span>
                        <div style={styles.progressBarBg}>
                          <div
                            style={styles.progressBarFill(
                              (selectedCustomer.timingScore / 1.0) * 100,
                              "#ef4444",
                            )}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Sizing & Portfolio Risk */}
                    <div style={styles.detailGrid}>
                      <div style={styles.detailCard}>
                        <h4 style={styles.cardHeader}>
                          💰 Stake Sizing & Variance
                        </h4>
                        <div>
                          Strategy: <b>{selectedCustomer.sizingStrategy}</b>
                        </div>
                        <div>
                          Gini Inequality: <b>{selectedCustomer.gini}</b>
                        </div>
                        <div>
                          Mean Stake:{" "}
                          <b>${selectedCustomer.meanStake.toLocaleString()}</b>
                        </div>
                      </div>
                      <div style={styles.detailCard}>
                        <h4 style={styles.cardHeader}>
                          📊 Risk & Expected Value
                        </h4>
                        <div>
                          7d 95% VaR:{" "}
                          <b>${selectedCustomer.var95Usd.toLocaleString()}</b>
                        </div>
                        <div>
                          Expected Shortfall (CVaR):{" "}
                          <b>${selectedCustomer.cvar95Usd.toLocaleString()}</b>
                        </div>
                        <div>
                          Lifetime Hold:{" "}
                          <b
                            style={{
                              color:
                                selectedCustomer.holdPct < 0
                                  ? "#f87171"
                                  : "#4ade80",
                            }}
                          >
                            {selectedCustomer.holdPct}%
                          </b>
                        </div>
                        <div>
                          Projected LTV:{" "}
                          <b>
                            $
                            {Math.abs(selectedCustomer.ltvUsd).toLocaleString()}
                            {selectedCustomer.ltvUsd < 0
                              ? " (Loss to Desk)"
                              : " (Desk Hold)"}
                          </b>
                        </div>
                      </div>
                    </div>

                    {/* Correlated Parlay & Timing */}
                    <div style={styles.detailGrid}>
                      <div style={styles.detailCard}>
                        <h4 style={styles.cardHeader}>🔗 Correlated Parlays</h4>
                        <div>
                          Risk Tier:{" "}
                          <span
                            style={styles.corrBadge(
                              selectedCustomer.correlatedRisk,
                            )}
                          >
                            {selectedCustomer.correlatedRisk}
                          </span>
                        </div>
                        <div>
                          Exploit Rate:{" "}
                          <b>
                            {(
                              selectedCustomer.correlatedExploitRate * 100
                            ).toFixed(0)}
                            %
                          </b>
                        </div>
                      </div>
                      <div style={styles.detailCard}>
                        <h4 style={styles.cardHeader}>⏱️ Timing Fingerprint</h4>
                        <div>
                          Archetype: <b>{selectedCustomer.timingArchetype}</b>
                        </div>
                        <div>
                          Downline Syndicate:{" "}
                          <b>
                            {(selectedCustomer.syndicateProb * 100).toFixed(0)}%
                            Prob
                          </b>
                        </div>
                      </div>
                    </div>

                    {/* Actionable Operator Directives */}
                    <div style={styles.directiveCard}>
                      <h4 style={styles.cardHeader}>
                        🚨 Actionable Desk Directives
                      </h4>
                      <div style={styles.directiveRow}>
                        <span>Action:</span>
                        <span
                          style={styles.actionBadge(selectedCustomer.action)}
                        >
                          {selectedCustomer.action}
                        </span>
                      </div>
                      <div style={styles.directiveRow}>
                        <span>Max Stake Ceiling:</span>
                        <b>
                          $
                          {selectedCustomer.recommendedLimitUsd.toLocaleString()}
                        </b>
                      </div>
                      <div style={styles.directiveRow}>
                        <span>In-Play Submission Delay:</span>
                        <b>{selectedCustomer.inPlayDelaySec} seconds</b>
                      </div>
                      <div style={styles.directiveRow}>
                        <span>Line Shading:</span>
                        <b>{selectedCustomer.lineShadeCents}¢ against action</b>
                      </div>
                      <div style={styles.directiveRow}>
                        <span>Shadow Copy Multiplier:</span>
                        <b>
                          {selectedCustomer.shadowCopyMultiplier.toFixed(2)}x
                        </b>
                      </div>
                    </div>

                    {/* Real-time Reverse DNS Forensics Trigger */}
                    <div style={styles.forensicCard}>
                      <h4 style={styles.cardHeader}>
                        🌐 Reverse DNS & Proxy Forensics
                      </h4>
                      <div style={styles.forensicRow}>
                        <span>Observed Login IP:</span>
                        <code>{selectedCustomer.ipAddress}</code>
                        <button
                          style={styles.actionBtnSmall}
                          onClick={() =>
                            runReverseLookup(selectedCustomer.ipAddress)
                          }
                        >
                          🔍 Run Reverse DNS
                        </button>
                      </div>
                      {customerForensicResult && (
                        <div style={styles.forensicResult}>
                          {customerForensicResult}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div style={styles.loading}>
                    Select a customer to inspect deep multidimensional profile.
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : activeTab === "surveillance" ? (
          <div>
            {/* Existing Surveillance & Telemetry View */}
            {dnsData && (
              <div style={styles.dnsBar}>
                <span style={styles.dnsLabel}>🌐 Bun.dns Cache Telemetry:</span>
                <span>
                  Size: <b>{dnsData.telemetry.size}/256</b>
                </span>
                <span>
                  Hit Rate: <b>{dnsData.telemetry.hitRatePercent}%</b>
                </span>
                <span>
                  Hits (Completed):{" "}
                  <b>{dnsData.telemetry.cacheHitsCompleted}</b>
                </span>
                <span>
                  Hits (Inflight): <b>{dnsData.telemetry.cacheHitsInflight}</b>
                </span>
                <span>
                  Misses: <b>{dnsData.telemetry.cacheMisses}</b>
                </span>
                <span>
                  TTL: <b>{dnsData.telemetry.defaultTtlSeconds}s</b>
                </span>
              </div>
            )}

            <div style={styles.toolsBar}>
              <div style={styles.toolItem}>
                <button
                  style={styles.actionBtn}
                  onClick={runBenchmark}
                  disabled={benchLoading}
                >
                  {benchLoading
                    ? "Benchmarking..."
                    : "⚡ Benchmark c-ares vs system (fantasy402.com)"}
                </button>
                {benchResult && (
                  <span style={styles.toolResult}>{benchResult}</span>
                )}
              </div>
              <div style={styles.toolItem}>
                <input
                  style={styles.input}
                  value={reverseIp}
                  onChange={(e) => setReverseIp(e.target.value)}
                  placeholder="IP (e.g. 1.1.1.1)"
                />
                <button
                  style={styles.actionBtn}
                  onClick={() => runReverseLookup()}
                >
                  🔍 Reverse DNS & Forensics
                </button>
                {reverseResult && (
                  <span style={styles.toolResult}>{reverseResult}</span>
                )}
              </div>
              <div style={styles.viewToggleGroup}>
                <button
                  style={styles.toggleBtn(viewMode === "interactive")}
                  onClick={() => setViewMode("interactive")}
                >
                  Interactive
                </button>
                <button
                  style={styles.toggleBtn(viewMode === "raw")}
                  onClick={() => setViewMode("raw")}
                >
                  Raw Markdown
                </button>
              </div>
            </div>

            {data ? (
              viewMode === "interactive" ? (
                <div
                  style={styles.renderedHtml}
                  dangerouslySetInnerHTML={{ __html: data.html }}
                />
              ) : (
                <pre style={styles.rawMarkdown}>{data.markdown}</pre>
              )
            ) : (
              <div style={styles.loading}>
                Loading real-time surveillance dashboard...
              </div>
            )}
          </div>
        ) : activeTab === "terminal" ? (
          <div style={styles.terminalContainer}>
            {/* Window title bar */}
            <div style={styles.terminalBar}>
              <div style={styles.terminalWindowButtons}>
                <span style={styles.terminalDot("#ef4444")} />
                <span style={styles.terminalDot("#f59e0b")} />
                <span style={styles.terminalDot("#10b981")} />
                <span style={styles.terminalTitle}>
                  SportsDesk Operator Terminal · Bun.Terminal (PTY) + Bun.spawn
                </span>
              </div>
              <div
                style={{ display: "flex", alignItems: "center", gap: "10px" }}
              >
                <span
                  style={{
                    fontSize: "11px",
                    color: "#4ade80",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  }}
                >
                  ● PTY Engine Ready (Bun v1.4.4)
                </span>
                <button
                  type="button"
                  style={{
                    ...styles.actionBtn,
                    padding: "3px 8px",
                    fontSize: "11px",
                  }}
                  onClick={() => setTerminalHistory([])}
                  title="Clear terminal buffer"
                >
                  Clear Screen
                </button>
              </div>
            </div>

            {/* Quick Query Toolbar */}
            <div style={styles.terminalChips}>
              <span
                style={{
                  fontSize: "11px",
                  color: "#64748b",
                  alignSelf: "center",
                  marginRight: "4px",
                }}
              >
                Quick Queries:
              </span>
              {[
                { label: "⚡ p GP301", cmd: "p GP301" },
                { label: "⚡ p BRT5229", cmd: "p BRT5229" },
                { label: "🏆 rank-all", cmd: "rank-all" },
                { label: "🚨 conduits", cmd: "conduits" },
                { label: "⚡ bursts", cmd: "bursts" },
                { label: "🛡️ quarantine", cmd: "quarantine" },
                { label: "🌐 ws", cmd: "ws" },
                { label: "🌲 trunks", cmd: "trunks" },
                { label: "🏢 sa", cmd: "sa" },
                { label: "🔍 f syndicate", cmd: "f syndicate" },
                { label: "🏆 sh", cmd: "sh" },
                { label: "🔑 k", cmd: "k" },
                { label: "📊 g", cmd: "g" },
                { label: "🚨 dir", cmd: "dir" },
                { label: "📈 var", cmd: "var" },
                { label: "📊 stat", cmd: "stat" },
                { label: "👤 w", cmd: "w" },
                { label: "🌐 d fantasy402.com", cmd: "d fantasy402.com" },
                { label: "🛡️ r 1.1.1.1", cmd: "r 1.1.1.1" },
                { label: "⌨️ kb", cmd: "kb" },
                { label: "❓ h", cmd: "h" },
              ].map((chip) => (
                <button
                  key={chip.cmd}
                  type="button"
                  style={styles.terminalChip}
                  onClick={() => runTerminalCommand(chip.cmd)}
                >
                  {chip.label}
                </button>
              ))}
            </div>

            {/* Scrollable Terminal Screen */}
            <div style={styles.terminalBody}>
              {terminalHistory.map((item, idx) => (
                <div key={idx} style={styles.terminalEntry}>
                  <div style={styles.terminalPromptLine}>
                    <span>
                      sportsdesk&gt;{" "}
                      <span style={{ color: "#f8fafc" }}>{item.command}</span>
                    </span>
                    <span style={styles.terminalMeta}>
                      {item.durationMs > 0 && `[${item.durationMs}ms] `}
                      exit: {item.exitCode}
                    </span>
                  </div>
                  <div style={styles.terminalOutput}>
                    {renderAnsiReact(item.stdout)}
                  </div>
                </div>
              ))}

              {terminalLoading && (
                <div style={{ color: "#38bdf8", padding: "8px 0" }}>
                  <span>sportsdesk&gt; </span>
                  <span style={{ opacity: 0.8 }}>
                    Executing in native Bun.Terminal PTY...
                  </span>
                  <span style={{ animation: "pulse 1s infinite" }}> █</span>
                </div>
              )}
              <div ref={terminalBottomRef} />
            </div>

            {/* Keyboard Shortcuts Legend Bar */}
            <div style={styles.terminalKeyLegend}>
              <span>
                <kbd style={styles.kbd}>Tab</kbd> Autocomplete
              </span>
              <span>
                <kbd style={styles.kbd}>Ctrl + `</kbd> /{" "}
                <kbd style={styles.kbd}>Cmd + K</kbd> Toggle PTY
              </span>
              <span>
                <kbd style={styles.kbd}>Ctrl + 1/2/3</kbd> Tabs
              </span>
              <span>
                <kbd style={styles.kbd}>Ctrl + L</kbd> Clear Screen
              </span>
              <span>
                <kbd style={styles.kbd}>Ctrl + C</kbd> Cancel
              </span>
              <span>
                <kbd style={styles.kbd}>↑ / ↓</kbd> History
              </span>
              <span>
                <kbd style={styles.kbd}>Esc</kbd> Blur
              </span>
            </div>

            {/* Bottom Input Line */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                runTerminalCommand(terminalCommand);
              }}
              style={styles.terminalInputBar}
            >
              <span style={styles.terminalPromptSymbol}>sportsdesk$</span>
              <input
                data-terminal-input="true"
                type="text"
                value={terminalCommand}
                onChange={(e) => setTerminalCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Tab") {
                    e.preventDefault();
                    handleAutocomplete();
                  } else if (e.ctrlKey && e.key.toLowerCase() === "l") {
                    e.preventDefault();
                    setTerminalHistory([]);
                  } else if (e.ctrlKey && e.key.toLowerCase() === "c") {
                    e.preventDefault();
                    setTerminalCommand("");
                  } else if (e.key === "Escape") {
                    e.currentTarget.blur();
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    if (commandHistory.length > 0) {
                      const nextIdx =
                        historyIndex === -1
                          ? commandHistory.length - 1
                          : Math.max(0, historyIndex - 1);
                      setHistoryIndex(nextIdx);
                      setTerminalCommand(commandHistory[nextIdx] ?? "");
                    }
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    if (historyIndex !== -1) {
                      const nextIdx = historyIndex + 1;
                      if (nextIdx >= commandHistory.length) {
                        setHistoryIndex(-1);
                        setTerminalCommand("");
                      } else {
                        setHistoryIndex(nextIdx);
                        setTerminalCommand(commandHistory[nextIdx] ?? "");
                      }
                    }
                  }
                }}
                placeholder="Type command or shortcode (e.g. 'p GP301', 'f syndicate', 'k', 'g', 'dir', 'var', 'stat', 'w', 'kb')..."
                style={styles.terminalInput}
                autoFocus
              />
              <button
                type="submit"
                disabled={terminalLoading}
                style={{
                  ...styles.actionBtn,
                  backgroundColor: "#0284c7",
                  borderColor: "#38bdf8",
                  cursor: "pointer",
                }}
              >
                {terminalLoading ? "Running..." : "Run (PTY)"}
              </button>
            </form>
          </div>
        ) : activeTab === "rankings" ? (
          <div
            style={{ display: "flex", flexDirection: "column", gap: "20px" }}
          >
            {/* 30-Day Sharps & Agency Downlines View */}
            <div style={styles.kpiGrid}>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>30-Day Total Handle</div>
                <div style={styles.kpiVal}>$268.9M</div>
                <div style={styles.kpiSub}>
                  627,710 Wagers Placed (Oct 10 – Nov 09)
                </div>
              </div>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Active Player Downline</div>
                <div style={styles.kpiVal}>9,134 Accounts</div>
                <div style={styles.kpiSub}>
                  672 Sub-Agents · 107 Master Forests
                </div>
              </div>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Proxy Conduits Detected</div>
                <div style={{ ...styles.kpiVal, color: "#f87171" }}>
                  21 Agencies
                </div>
                <div style={styles.kpiSub}>
                  Single-Customer Concentration ≥ 80%
                </div>
              </div>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Desk Exposure (ToWin)</div>
                <div style={styles.kpiVal}>$424.7M</div>
                <div style={styles.kpiSub}>
                  Median: $51.00 · P99: $6,750 · Max: $240k
                </div>
              </div>
            </div>

            {/* Filter Bar & Search */}
            <div style={styles.filterBar}>
              <div style={styles.searchBox}>
                <span style={styles.searchIcon}>🔍</span>
                <input
                  style={styles.searchInput}
                  value={rankingsSearch}
                  onChange={(e) => setRankingsSearch(e.target.value)}
                  placeholder="Filter by Customer (e.g. 'B121', 'RF2003'), Sub-Agent ('FAKEMONEY'), or Master..."
                />
              </div>

              <div style={styles.tierFilterGroup}>
                {[
                  { id: "ALL", label: "All Top Sharps" },
                  { id: "CONDUITS", label: "🚨 Proxy Conduits (21)" },
                  { id: "TIER3", label: "🎯 Tier 3 Sharps" },
                  { id: "WHALES", label: "🐋 Whales (>$1M)" },
                ].map((pill) => (
                  <button
                    key={pill.id}
                    type="button"
                    style={styles.filterPill(rankingsFilter === pill.id)}
                    onClick={() =>
                      setRankingsFilter(
                        pill.id as "ALL" | "CONDUITS" | "TIER3" | "WHALES",
                      )
                    }
                  >
                    {pill.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Main Rankings Table */}
            <div style={styles.tableCard}>
              <div style={styles.tableHeader}>
                <h3 style={styles.tableTitle}>
                  🏆 30-Day Sharp Bettor Rankings & Downline Profiling
                </h3>
                <span style={{ fontSize: "11px", color: "#64748b" }}>
                  Streaming batched evaluation (50k lines/chunk) · autoExecute:
                  false
                </span>
              </div>

              <div style={styles.tableScroll}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Rank</th>
                      <th style={styles.th}>Customer ID</th>
                      <th style={styles.th}>Sub-Agent / Master</th>
                      <th style={styles.th}>30d Volume</th>
                      <th style={styles.th}>Wagers</th>
                      <th style={styles.th}>Stake Gini</th>
                      <th style={styles.th}>Alert Rate</th>
                      <th style={styles.th}>Composite Score</th>
                      <th style={styles.th}>Classification & Tier</th>
                      <th style={styles.th}>Risk Directives</th>
                      <th style={styles.th}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RANKED_30D_PLAYERS.filter((p) => {
                      const q = rankingsSearch.toLowerCase();
                      const matchesSearch =
                        !q ||
                        p.id.toLowerCase().includes(q) ||
                        p.agentId.toLowerCase().includes(q) ||
                        p.masterAgent.toLowerCase().includes(q);
                      if (!matchesSearch) return false;
                      if (rankingsFilter === "CONDUITS") return p.isProxy;
                      if (rankingsFilter === "TIER3")
                        return p.tier === "TIER_3";
                      if (rankingsFilter === "WHALES")
                        return p.handleUsd >= 1000000;
                      return true;
                    }).map((p) => (
                      <tr key={p.id}>
                        <td style={styles.td}>
                          <span style={{ fontWeight: 700, color: "#38bdf8" }}>
                            #{p.rank}
                          </span>
                        </td>
                        <td style={styles.td}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                            }}
                          >
                            <span style={styles.custLogin}>{p.id}</span>
                            {p.isProxy && (
                              <span
                                style={{
                                  fontSize: "9px",
                                  padding: "1px 5px",
                                  borderRadius: "3px",
                                  backgroundColor: "rgba(239, 68, 68, 0.2)",
                                  border: "1px solid #ef4444",
                                  color: "#ef4444",
                                  fontWeight: 700,
                                }}
                              >
                                PROXY
                              </span>
                            )}
                          </div>
                          <div style={styles.custSub}>{p.dominantSport}</div>
                        </td>
                        <td style={styles.td}>
                          <div style={{ fontWeight: 600 }}>{p.agentId}</div>
                          <div style={styles.custSub}>
                            Master: {p.masterAgent}
                          </div>
                        </td>
                        <td style={styles.td}>
                          <div style={{ fontWeight: 600 }}>
                            ${p.handleUsd.toLocaleString()}
                          </div>
                          <div style={styles.custSub}>
                            Avg: ${(p.handleUsd / p.wagers).toFixed(0)}
                          </div>
                        </td>
                        <td style={styles.td}>
                          <div>{p.wagers}</div>
                        </td>
                        <td style={styles.td}>
                          <span
                            style={{
                              color: p.gini <= 0.15 ? "#4ade80" : "#f59e0b",
                              fontWeight: 600,
                            }}
                          >
                            {p.gini.toFixed(3)}
                          </span>
                          <div style={styles.custSub}>
                            {p.gini <= 0.15 ? "Flat-Unit" : "Variable"}
                          </div>
                        </td>
                        <td style={styles.td}>
                          <span
                            style={{
                              color: p.alertRate >= 50 ? "#ef4444" : "#94a3b8",
                              fontWeight: 600,
                            }}
                          >
                            {p.alertRate}%
                          </span>
                        </td>
                        <td style={styles.td}>
                          <span
                            style={{
                              fontSize: "14px",
                              fontWeight: 700,
                              color: p.score >= 7.0 ? "#f59e0b" : "#38bdf8",
                            }}
                          >
                            {p.score.toFixed(2)}
                          </span>
                        </td>
                        <td style={styles.td}>
                          <span
                            style={styles.tierBadge(
                              p.tier as
                                | "TIER_1_ELITE_ORIGINATOR"
                                | "TIER_2_STEAM_SYNDICATE"
                                | "TIER_3_SHARP_DISCIPLINED"
                                | "TIER_4_SEMI_SHARP"
                                | "TIER_5_RECREATIONAL",
                            )}
                          >
                            {p.tierLabel}
                          </span>
                        </td>
                        <td style={styles.td}>
                          <div style={{ fontSize: "11px", color: "#f87171" }}>
                            Limit: ${p.limitUsd.toLocaleString()}
                          </div>
                          <div style={styles.custSub}>Live Delay: 2-3s</div>
                        </td>
                        <td style={styles.td}>
                          <button
                            type="button"
                            style={{
                              ...styles.actionBtn,
                              padding: "4px 8px",
                              fontSize: "11px",
                              cursor: "pointer",
                            }}
                            onClick={() => {
                              setActiveTab("terminal");
                              runTerminalCommand(`p ${p.id} --radar`);
                            }}
                          >
                            Inspect PTY
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Sub-Agent Proxy Conduits Section */}
            <div style={styles.tableCard}>
              <div style={styles.tableHeader}>
                <h3 style={{ ...styles.tableTitle, color: "#f87171" }}>
                  🚨 Identified Agency Proxy Conduits (Top Customer
                  Concentration ≥ 80%)
                </h3>
                <span style={{ fontSize: "11px", color: "#64748b" }}>
                  Bypassing individual bettor limits via dedicated sub-agent
                  conduits
                </span>
              </div>

              <div style={styles.tableScroll}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Sub-Agent ID</th>
                      <th style={styles.th}>Master Forest</th>
                      <th style={styles.th}>30d Handle (USD)</th>
                      <th style={styles.th}>Tickets</th>
                      <th style={styles.th}>Top Customer</th>
                      <th style={styles.th}>Concentration (%)</th>
                      <th style={styles.th}>
                        Risk Assessment & Countermeasure
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {PROXY_CONDUITS_30D.map((c) => (
                      <tr key={c.agentId}>
                        <td style={styles.td}>
                          <span style={{ fontWeight: 700, color: "#f59e0b" }}>
                            {c.agentId}
                          </span>
                        </td>
                        <td style={styles.td}>
                          <span>{c.masterAgent}</span>
                        </td>
                        <td style={styles.td}>
                          <span style={{ fontWeight: 600 }}>
                            ${c.handleUsd.toLocaleString()}
                          </span>
                        </td>
                        <td style={styles.td}>
                          <span>{c.wagers}</span>
                        </td>
                        <td style={styles.td}>
                          <span style={{ fontWeight: 700, color: "#38bdf8" }}>
                            {c.topCust}
                          </span>
                        </td>
                        <td style={styles.td}>
                          <span
                            style={{
                              fontWeight: 700,
                              color: c.concPct >= 95 ? "#ef4444" : "#f59e0b",
                            }}
                          >
                            {c.concPct.toFixed(1)}%
                          </span>
                        </td>
                        <td style={styles.td}>
                          <div
                            style={{
                              color: "#ef4444",
                              fontWeight: 600,
                              fontSize: "12px",
                            }}
                          >
                            SINGLE BETTOR PROXY CONDUIT
                          </div>
                          <div style={styles.custSub}>
                            Cap sub-agent total exposure to prevent account
                            rotation
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : activeTab === "shadow" ? (
          <ShadowPricingPanel
            onInspectAccount={(accountId) => {
              const found = SAMPLE_PROFILE_DATA.find(
                (c) => c.id.toUpperCase() === accountId.toUpperCase(),
              );
              if (found) {
                setSelectedCustomer(found);
              }
              setSearchQuery(accountId);
              setActiveTab("customers");
            }}
            onRunPtyCommand={(cmd) => {
              setActiveTab("terminal");
              void runTerminalCommand(cmd);
            }}
          />
        ) : null}
      </main>

      {/* Global Footer */}
      <footer style={styles.footer}>
        <span>Updated: {data?.updatedAt ?? "—"}</span>
        <span>
          Native Bun HTML Bundler + Bun.serve Routes + bun:bundle (
          {runtimeFlags.target}) + tokens.toml v1.1.0 · autoExecute: false
          invariant active
        </span>
      </footer>
    </div>
  );
}

const styles = {
  container: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    backgroundColor: "var(--sd-surface-bg, #070b14)",
    color: "var(--sd-text-primary, #f1f5f9)",
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column" as const,
  },
  header: {
    padding: "16px 24px",
    backgroundColor: "var(--sd-surface-card, #0d1527)",
    borderBottom: "1px solid var(--sd-surface-border, #1e293b)",
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "12px",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
  },
  title: {
    margin: 0,
    fontSize: "20px",
    fontWeight: 700,
    color: "#f8fafc",
  },
  badge: (active: boolean) => ({
    padding: "4px 10px",
    borderRadius: "12px",
    fontSize: "12px",
    fontWeight: 600,
    backgroundColor: active
      ? "rgba(34, 197, 94, 0.15)"
      : "rgba(239, 68, 68, 0.15)",
    color: active ? "#4ade80" : "#f87171",
    border: `1px solid ${active ? "rgba(34, 197, 94, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
  }),
  tabNav: {
    display: "flex",
    gap: "8px",
  },
  tabBtn: (active: boolean) => ({
    padding: "8px 16px",
    borderRadius: "6px",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    backgroundColor: active ? "#38bdf8" : "#1e293b",
    color: active ? "#0f172a" : "#94a3b8",
    border: "none",
    transition: "all 0.15s ease",
  }),
  main: {
    flex: 1,
    padding: "24px",
    maxWidth: "1600px",
    margin: "0 auto",
    width: "100%",
    boxSizing: "border-box" as const,
  },
  kpiGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: "16px",
    marginBottom: "20px",
  },
  kpiCard: {
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "8px",
    padding: "16px",
  },
  kpiLabel: {
    fontSize: "12px",
    color: "#94a3b8",
    textTransform: "uppercase" as const,
    fontWeight: 600,
    marginBottom: "4px",
  },
  kpiVal: {
    fontSize: "22px",
    fontWeight: 700,
    color: "#38bdf8",
    marginBottom: "4px",
  },
  kpiSub: {
    fontSize: "11px",
    color: "#64748b",
  },
  filterBar: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "12px",
    alignItems: "center",
    marginBottom: "20px",
  },
  searchInput: {
    flex: "1 1 300px",
    padding: "10px 14px",
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "6px",
    color: "#f1f5f9",
    fontSize: "13px",
    outline: "none",
  },
  filterPills: {
    display: "flex",
    gap: "8px",
  },
  pill: (active: boolean) => ({
    padding: "8px 14px",
    borderRadius: "20px",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    backgroundColor: active ? "rgba(56, 189, 248, 0.2)" : "#0d1527",
    color: active ? "#38bdf8" : "#94a3b8",
    border: `1px solid ${active ? "#38bdf8" : "#1e293b"}`,
  }),
  showcaseGrid: {
    display: "grid",
    gridTemplateColumns: "3fr 2fr",
    gap: "24px",
  },
  tablePanel: {
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "8px",
    padding: "16px",
    overflow: "hidden",
  },
  panelTitle: {
    margin: "0 0 16px 0",
    fontSize: "16px",
    color: "#f8fafc",
  },
  tableContainer: {
    overflowX: "auto" as const,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "12px",
  },
  thRow: {
    borderBottom: "2px solid #1e293b",
    textAlign: "left" as const,
  },
  th: {
    padding: "10px 12px",
    color: "#94a3b8",
    fontWeight: 600,
  },
  tr: (selected: boolean) => ({
    borderBottom: "1px solid #1e293b",
    cursor: "pointer",
    backgroundColor: selected ? "rgba(56, 189, 248, 0.08)" : "transparent",
    transition: "background 0.15s ease",
  }),
  td: {
    padding: "10px 12px",
    verticalAlign: "top" as const,
  },
  custCell: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  custLink: {
    color: "#38bdf8",
    textDecoration: "none",
    fontWeight: 600,
  },
  custAgent: {
    fontSize: "11px",
    color: "#64748b",
  },
  custSub: {
    fontSize: "11px",
    color: "#64748b",
  },
  subBadge: {
    fontSize: "10px",
    padding: "1px 5px",
    borderRadius: "4px",
    backgroundColor: "rgba(239, 68, 68, 0.2)",
    color: "#f87171",
  },
  tierBadge: (tier: string) => {
    let color = "#94a3b8";
    let bg = "rgba(148, 163, 184, 0.1)";
    if (tier.includes("TIER_1") || tier.includes("ELITE")) {
      color = "#f87171";
      bg = "rgba(239, 68, 68, 0.2)";
    } else if (tier.includes("TIER_2") || tier.includes("STEAM")) {
      color = "#fb923c";
      bg = "rgba(251, 146, 60, 0.2)";
    } else if (tier.includes("TIER_3") || tier.includes("DISCIPLINED")) {
      color = "#fbbf24";
      bg = "rgba(251, 191, 36, 0.2)";
    } else if (tier.includes("RECREATIONAL")) {
      color = "#4ade80";
      bg = "rgba(34, 197, 94, 0.15)";
    }
    return {
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: "4px",
      fontSize: "11px",
      fontWeight: 600,
      backgroundColor: bg,
      color,
    };
  },
  corrBadge: (tier: string) => {
    let color = "#94a3b8";
    if (tier === "CRITICAL") color = "#f87171";
    if (tier === "HIGH") color = "#fb923c";
    if (tier === "MODERATE") color = "#fbbf24";
    return {
      color,
      fontWeight: 600,
      fontSize: "11px",
    };
  },
  actionBadge: (act: string) => ({
    display: "inline-block",
    padding: "2px 6px",
    borderRadius: "4px",
    fontSize: "10px",
    fontWeight: 600,
    backgroundColor:
      act === "ALERT_OPERATOR"
        ? "rgba(239, 68, 68, 0.2)"
        : act === "MONITOR"
          ? "rgba(251, 191, 36, 0.2)"
          : "rgba(34, 197, 94, 0.15)",
    color:
      act === "ALERT_OPERATOR"
        ? "#f87171"
        : act === "MONITOR"
          ? "#fbbf24"
          : "#4ade80",
  }),
  inspectorPanel: {
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "8px",
    padding: "20px",
  },
  inspectorHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: "16px",
    borderBottom: "1px solid #1e293b",
    paddingBottom: "12px",
  },
  inspectorTitle: {
    margin: "0 0 4px 0",
    fontSize: "22px",
    color: "#f8fafc",
  },
  inspectorSub: {
    fontSize: "12px",
    color: "#94a3b8",
  },
  radarCard: {
    backgroundColor: "#070b14",
    border: "1px solid #1e293b",
    borderRadius: "6px",
    padding: "14px",
    marginBottom: "16px",
  },
  cardHeader: {
    margin: "0 0 10px 0",
    fontSize: "13px",
    color: "#38bdf8",
    fontWeight: 600,
  },
  radarRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: "11px",
    marginBottom: "8px",
  },
  progressBarBg: {
    width: "140px",
    height: "6px",
    backgroundColor: "#1e293b",
    borderRadius: "3px",
    overflow: "hidden",
  },
  progressBarFill: (pct: number, color: string) => ({
    width: `${Math.min(100, Math.max(0, pct))}%`,
    height: "100%",
    backgroundColor: color,
  }),
  detailGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "12px",
    marginBottom: "16px",
  },
  detailCard: {
    backgroundColor: "#070b14",
    border: "1px solid #1e293b",
    borderRadius: "6px",
    padding: "12px",
    fontSize: "12px",
    lineHeight: "1.6",
  },
  directiveCard: {
    backgroundColor: "rgba(239, 68, 68, 0.05)",
    border: "1px solid rgba(239, 68, 68, 0.3)",
    borderRadius: "6px",
    padding: "12px",
    fontSize: "12px",
    marginBottom: "16px",
  },
  directiveRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "4px 0",
    borderBottom: "1px dashed rgba(239, 68, 68, 0.15)",
  },
  forensicCard: {
    backgroundColor: "#070b14",
    border: "1px solid #1e293b",
    borderRadius: "6px",
    padding: "12px",
    fontSize: "12px",
  },
  forensicRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "6px",
  },
  forensicResult: {
    marginTop: "8px",
    padding: "8px",
    backgroundColor: "#0d1527",
    borderRadius: "4px",
    fontSize: "11px",
    color: "#38bdf8",
    border: "1px solid #1e293b",
  },
  actionBtnSmall: {
    padding: "4px 8px",
    borderRadius: "4px",
    backgroundColor: "#38bdf8",
    color: "#0f172a",
    fontSize: "11px",
    fontWeight: 600,
    border: "none",
    cursor: "pointer",
  },
  dnsBar: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "16px",
    padding: "10px 16px",
    backgroundColor: "#0d1527",
    borderRadius: "6px",
    border: "1px solid #1e293b",
    fontSize: "12px",
    color: "#cbd5e1",
    alignItems: "center",
    marginBottom: "16px",
  },
  dnsLabel: {
    fontWeight: 600,
    color: "#38bdf8",
  },
  toolsBar: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "16px",
    alignItems: "center",
    marginBottom: "20px",
  },
  toolItem: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  viewToggleGroup: {
    marginLeft: "auto",
    display: "flex",
    gap: "8px",
  },
  actionBtn: {
    padding: "8px 14px",
    borderRadius: "6px",
    backgroundColor: "#38bdf8",
    color: "#0f172a",
    fontSize: "12px",
    fontWeight: 600,
    border: "none",
    cursor: "pointer",
  },
  toggleBtn: (active: boolean) => ({
    padding: "6px 12px",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    backgroundColor: active ? "#38bdf8" : "#1e293b",
    color: active ? "#0f172a" : "#94a3b8",
    border: "none",
  }),
  input: {
    padding: "8px 12px",
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "6px",
    color: "#f1f5f9",
    fontSize: "12px",
    outline: "none",
  },
  toolResult: {
    fontSize: "12px",
    color: "#38bdf8",
    backgroundColor: "#0d1527",
    padding: "6px 10px",
    borderRadius: "4px",
    border: "1px solid #1e293b",
  },
  renderedHtml: {
    backgroundColor: "#0d1527",
    padding: "24px",
    borderRadius: "8px",
    border: "1px solid #1e293b",
    lineHeight: 1.6,
  },
  rawMarkdown: {
    backgroundColor: "#0d1527",
    padding: "24px",
    borderRadius: "8px",
    border: "1px solid #1e293b",
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: "13px",
    overflowX: "auto" as const,
    whiteSpace: "pre-wrap" as const,
  },
  loading: {
    padding: "48px",
    textAlign: "center" as const,
    color: "#94a3b8",
  },
  footer: {
    padding: "16px 24px",
    borderTop: "1px solid #1e293b",
    backgroundColor: "#0d1527",
    fontSize: "12px",
    color: "#64748b",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  terminalContainer: {
    backgroundColor: "#060913",
    border: "1px solid #1e293b",
    borderRadius: "10px",
    display: "flex",
    flexDirection: "column" as const,
    boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.5)",
    overflow: "hidden",
  },
  terminalBar: {
    padding: "10px 16px",
    backgroundColor: "#0d1527",
    borderBottom: "1px solid #1e293b",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  terminalWindowButtons: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
  },
  terminalDot: (color: string) => ({
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    backgroundColor: color,
    display: "inline-block",
  }),
  terminalTitle: {
    fontSize: "12px",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    color: "#94a3b8",
    fontWeight: 600,
    marginLeft: "6px",
  },
  terminalChips: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "6px",
    padding: "8px 16px",
    backgroundColor: "#090e1c",
    borderBottom: "1px solid #1e293b",
  },
  terminalChip: {
    padding: "3px 8px",
    borderRadius: "4px",
    fontSize: "11px",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    backgroundColor: "rgba(56, 189, 248, 0.1)",
    border: "1px solid rgba(56, 189, 248, 0.25)",
    color: "#38bdf8",
    cursor: "pointer",
  },
  terminalBody: {
    padding: "16px",
    minHeight: "480px",
    maxHeight: "600px",
    overflowY: "auto" as const,
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "12px",
    lineHeight: "1.5",
    color: "#f8fafc",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    backgroundColor: "#060913",
  },
  terminalEntry: {
    marginBottom: "16px",
  },
  terminalPromptLine: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "6px",
    color: "#4ade80",
    fontWeight: 600,
  },
  terminalMeta: {
    color: "#64748b",
    fontSize: "10px",
  },
  terminalOutput: {
    paddingLeft: "8px",
    borderLeft: "2px solid rgba(56, 189, 248, 0.2)",
  },
  terminalInputBar: {
    display: "flex",
    alignItems: "center",
    padding: "10px 16px",
    backgroundColor: "#0d1527",
    borderTop: "1px solid #1e293b",
    gap: "10px",
  },
  terminalPromptSymbol: {
    color: "#4ade80",
    fontWeight: 700,
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  terminalInput: {
    flex: 1,
    backgroundColor: "transparent",
    border: "none",
    outline: "none",
    color: "#f8fafc",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "13px",
  },
  terminalKeyLegend: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "14px",
    padding: "6px 16px",
    backgroundColor: "#070c18",
    borderTop: "1px solid #1e293b",
    fontSize: "11px",
    color: "#64748b",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  kbd: {
    padding: "1px 5px",
    borderRadius: "3px",
    backgroundColor: "#1e293b",
    border: "1px solid #334155",
    color: "#38bdf8",
    fontSize: "10px",
    fontWeight: 600,
  },
  searchBox: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flex: "1 1 300px",
    padding: "0 12px",
    backgroundColor: "var(--sd-surface-card, #0d1527)",
    border: "1px solid var(--sd-surface-border, #1e293b)",
    borderRadius: "6px",
  },
  searchIcon: {
    fontSize: "13px",
    color: "var(--sd-text-muted, #94a3b8)",
  },
  tierFilterGroup: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "8px",
  },
  filterPill: (active: boolean) => ({
    padding: "8px 14px",
    borderRadius: "20px",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    backgroundColor: active
      ? "rgba(56, 189, 248, 0.2)"
      : "var(--sd-surface-card, #0d1527)",
    color: active
      ? "var(--sd-tier-rec-bias, #38bdf8)"
      : "var(--sd-text-muted, #94a3b8)",
    border: `1px solid ${active ? "var(--sd-tier-rec-bias, #38bdf8)" : "var(--sd-surface-border, #1e293b)"}`,
  }),
  tableCard: {
    backgroundColor: "var(--sd-surface-card, #0d1527)",
    border: "1px solid var(--sd-surface-border, #1e293b)",
    borderRadius: "8px",
    padding: "16px",
    overflow: "hidden",
  },
  tableHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap" as const,
    gap: "8px",
    marginBottom: "12px",
  },
  tableTitle: {
    margin: 0,
    fontSize: "15px",
    fontWeight: 700,
    color: "var(--sd-text-primary, #f1f5f9)",
  },
  tableScroll: {
    overflowX: "auto" as const,
  },
  custLogin: {
    color: "var(--sd-tier-rec-bias, #38bdf8)",
    fontWeight: 600,
    cursor: "pointer",
  },
};
