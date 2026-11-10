/**
 * @file lib/terminal_emulator.ts
 * @description High-Performance Terminal Emulator Engine powered by Bun.Terminal & Bun.spawn.
 *
 * Provides:
 *  1. PTY command execution using native Bun.Terminal and Bun.spawn.
 *  2. Query & Search dispatcher for fast retrieval of customer profiles, wagers,
 *     syndicate clusters, DNS forensics, and operator CLI directives.
 *  3. Canonical shortcodes and command aliases (p, c, f, s, sh, syn, k, g, dir, var, stat, w, d, r, cr, md, cls, h, kb).
 *  4. Single-token customer ID expansion (e.g. "GP301" -> "profile GP301").
 *  5. Multi-flag support for profile (--json, --radar, --wagers) and find (-t, -s, -a).
 *  6. Tokenized ANSI parser (`parseAnsiSegments`) and safe HTML generator (`ansiToHtml`).
 *  7. Keybindings reference specification and autocomplete registry.
 *  8. Invariant: autoExecute: false across all directives and outputs.
 *  9. Security Audit (2026-11-09): All subprocess execution uses array-form Bun.spawn
 *     execve arguments without intermediate shell (no sh -c / bash -c). Injection via
 *     semicolons, pipes, backticks, or subshells is impossible (covered by tests/pty_injection.test.ts).
 */

import { resolve } from "node:path";
import { TerminalSession, type SpawnInPtyOptions } from "./bun_terminal.ts";
import { auditPty } from "./audit_log.ts";
import { benchmarkResolverLatency, classifyIpAddress } from "./bun_dns.ts";
import {
  KEY_NUMBER_BUYER_PROFILES,
  HALF_POINT_HOOK_SYNDICATE_PROFILES,
} from "./customer_profile.ts";
import {
  runBatchedRanking,
  type BatchedRankingResult,
} from "./customer_rankings.ts";
import {
  formatOsc8Hyperlink,
  getCanonicalCustomerUrl,
  getCanonicalAgentUrl,
} from "./canonical_osc8_links.ts";
import { formatHalfPointLine } from "../design/domain-branded-types.ts";
import { padDisplay } from "./cli_inspect.ts";
import { TIER, SURFACE, composite, type WagerTier } from "./wager_tokens.ts";

const FG = (c: string) =>
  typeof Bun !== "undefined" && Bun.color
    ? (Bun.color(c, "ansi-16m") ?? "")
    : "";
const BG = (c: string) => FG(c).replace("\x1b[38;", "\x1b[48;");

/** Gate every escape through Bun.enableANSIColors — mirrors AnsiTheme.colors */
const S = (sgr: string) =>
  typeof Bun !== "undefined" && Bun.enableANSIColors !== false ? sgr : "";
const R = "\x1b[0m";

export const renderWagerBadgeTerminal = (t: WagerTier, s: string): string =>
  `${S(FG(TIER[t].fg) + BG(TIER[t].bg) + "\x1b[1m")} ${s} ${S(R)}`;

/**
 * Anchored regex for detecting wager tier keywords in markdown **bold** spans.
 * Rejects non-tier text and names like STEAM100 while allowing optional alert prefixes and parentheticals.
 */
export const TIER_KEYWORD_RE =
  /^(?:#\s*|(?:🚨|⚡|⚠️|✅)\s*)?(CRITICAL|STEAM|LATENCY|RECREATIONAL)(?:\s*\([^)]+\))?$/u;

/**
 * Custom Bun.markdown.render callback map that translates Markdown AST elements
 * directly into ANSI SGR sequences using the exact TrueColor hex tokens from wagerBadge().
 */
export function renderWagerMarkdownTerminal(markdown: string): string {
  // trusted-markdown: terminal emulator interactive markdown-to-ANSI custom renderer
  return Bun.markdown.render(markdown, {
    heading: (children, meta) =>
      `${S(FG(SURFACE.text) + "\x1b[1m")}${"#".repeat(meta.level)} ${children}${S(R)}\n\n`,
    paragraph: (children) => `${children}\n\n`,
    strong: (children) => {
      const text = String(children).trim();
      // Whole-span case-sensitive tier match (with optional # or alert emoji prefix, or parens)
      const tierMatch = TIER_KEYWORD_RE.exec(text);
      if (tierMatch) {
        const tier = tierMatch[1] as WagerTier;
        return renderWagerBadgeTerminal(tier, text);
      }
      return `${S(FG(SURFACE.text) + "\x1b[1m")}${children}${S("\x1b[22m")}`;
    },
    emphasis: (children) => `${S("\x1b[4m")}${children}${S("\x1b[24m")}`,
    codespan: (children) =>
      `${S(FG(SURFACE.muted) + BG(composite(SURFACE.muted, 0.1, SURFACE.panel)))} ${children} ${S(R)}`,
    code: (children) => `${S(FG(SURFACE.muted))}${children}${S(R)}\n`,
    blockquote: (children) => `${S(FG(SURFACE.muted))}│ ${children}${S(R)}\n`,
    link: (children, meta) => {
      const { href } = meta;
      if (href.startsWith("http://") || href.startsWith("https://")) {
        return formatOsc8Hyperlink(href, String(children));
      }
      return `${S(FG(SURFACE.accent) + "\x1b[4m")}${children}${S("\x1b[24m")} (${href})`;
    },
    list: (children) => `${children}\n`,
    listItem: (children) => `  • ${children}`,
    tr: (children) => `${children}\n`,
    th: (children) =>
      `${S(FG(SURFACE.accent) + "\x1b[1m")}${children}${S(R)} | `,
    td: (children) => `${children} | `,
    hr: () => `${S(FG(SURFACE.border))}${"─".repeat(50)}${S(R)}\n\n`,
  });
}

let _cachedRanking: Promise<BatchedRankingResult> | null = null;
function getCachedRanking(): Promise<BatchedRankingResult> {
  if (!_cachedRanking) {
    _cachedRanking = runBatchedRanking({ limitPlayers: 100 }).catch((err) => {
      _cachedRanking = null;
      throw err;
    });
  }
  return _cachedRanking;
}

export interface TerminalQueryOptions extends SpawnInPtyOptions {
  readonly timeoutMs?: number;
}

export interface TerminalQueryResult {
  readonly command: string;
  readonly stdout: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timestamp: number;
}

export interface AnsiSegment {
  readonly text: string;
  readonly color?: string | undefined;
  readonly bg?: string | undefined;
  readonly bold?: boolean | undefined;
  readonly dim?: boolean | undefined;
  readonly underline?: boolean | undefined;
  readonly linkUrl?: string | undefined;
}

export interface TerminalCustomerRecord {
  readonly id: string;
  readonly name: string;
  readonly agentId: string;
  readonly masterAgent: string;
  readonly tier: string;
  readonly score: number;
  readonly clvScore: number;
  readonly skillScore: number;
  readonly sizingScore: number;
  readonly sigScore: number;
  readonly timingScore: number;
  readonly correlatedScore: number;
  readonly sizingStrategy: string;
  readonly gini: number;
  readonly meanStake: number;
  readonly maxMinRatio: number;
  readonly specialization: string;
  readonly timingArchetype: string;
  readonly correlatedRisk: string;
  readonly correlatedExploitRate: number;
  readonly syndicateRisk: string;
  readonly syndicateProb: number;
  readonly subAccountIndex: number | null;
  readonly rootAccountId?: string | undefined;
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
  readonly sampleWagers?:
    | readonly {
        readonly sport: string;
        readonly market: string;
        readonly line: string;
        readonly clvBps: number;
        readonly stakeUsd: number;
        readonly netUsd: number;
        readonly time: string;
      }[]
    | undefined;
}

/**
 * Canonical command alias registry.
 * Maps shortcodes and aliases to canonical command identifiers.
 */
export const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  p: "profile",
  c: "profile",
  cust: "profile",
  lookup: "profile",
  f: "find",
  s: "find",
  q: "find",
  search: "find",
  query: "find",
  sh: "sharps",
  sharp: "sharps",
  top: "sharps",
  leaderboard: "sharps",
  syn: "syndicates",
  hook: "syndicates",
  hooks: "syndicates",
  k: "key-numbers",
  key: "key-numbers",
  keys: "key-numbers",
  "key-numbers": "key-numbers",
  keynumbers: "key-numbers",
  g: "gini",
  gini: "gini",
  dir: "directives",
  dirs: "directives",
  directives: "directives",
  limits: "directives",
  var: "risk",
  cvar: "risk",
  risk: "risk",
  forensics: "risk",
  stat: "stats",
  stats: "stats",
  summary: "stats",
  who: "who",
  w: "who",
  rankings: "rankings",
  rank: "rankings",
  ranks: "rankings",
  "rank-all": "rankings",
  rk: "rankings",
  conduits: "conduits",
  proxies: "conduits",
  proxy: "conduits",
  subagents: "subagents",
  sa: "subagents",
  subagent: "subagents",
  bursts: "bursts",
  burst: "bursts",
  steam: "bursts",
  b: "bursts",
  quarantine: "quarantine",
  guard: "quarantine",
  quar: "quarantine",
  "burst-guard": "quarantine",
  ws: "ws",
  subscriptions: "ws",
  trunks: "trunks",
  trunk: "trunks",
  trees: "trunks",
  t: "trunks",
  d: "dns",
  dns: "dns",
  r: "reverse",
  rev: "reverse",
  ip: "reverse",
  cr: "cron",
  cron: "cron",
  md: "markdown",
  markdown: "markdown",
  cls: "clear",
  clear: "clear",
  h: "help",
  help: "help",
  "?": "help",
  kb: "keybindings",
  keyshelp: "keybindings",
  keybindings: "keybindings",
  capabilities: "capabilities",
  caps: "capabilities",
  features: "capabilities",
};

/**
 * Autocomplete command suggestions list.
 */
export const AUTOCOMPLETE_COMMANDS: readonly string[] = [
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
  "rankings",
  "conduits",
  "subagents",
  "bursts",
  "quarantine",
  "ws",
  "trunks",
  "dns",
  "reverse",
  "cron",
  "markdown",
  "capabilities",
  "clear",
  "help",
  "keybindings",
  // Shortcodes
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
  "b",
  "q",
  "t",
  "cr",
  "md",
  "cls",
  "h",
  "kb",
];

/**
 * Global Keyboard shortcuts specification.
 */
export const KEYBINDINGS_REFERENCE = [
  { key: "Tab", desc: "Autocomplete commands, shortcodes, and customer IDs" },
  {
    key: "Ctrl + ` / Cmd + K",
    desc: "Global toggle / focus Terminal Emulator tab",
  },
  {
    key: "Ctrl + 1",
    desc: "Switch to Showcase & Multi-Dimensional Matrix tab",
  },
  { key: "Ctrl + 2", desc: "Switch to Live Surveillance & IP Forensics tab" },
  { key: "Ctrl + 3", desc: "Switch to Interactive Terminal Emulator tab" },
  { key: "Ctrl + L", desc: "Clear terminal screen buffer" },
  { key: "Ctrl + C", desc: "Cancel / clear current terminal input line" },
  {
    key: "↑ / ↓ (Up / Down)",
    desc: "Navigate command history (previous / next)",
  },
  { key: "Escape", desc: "Unfocus terminal input / return to matrix view" },
] as const;

/**
 * Primary Known Customer Accounts for instant offline inspection and benchmarking.
 */
export const KNOWN_CUSTOMERS: readonly TerminalCustomerRecord[] = [
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
    correlatedScore: 0.8,
    sizingStrategy: "PROPORTIONAL_KELLY",
    gini: 0.21,
    meanStake: 5500,
    maxMinRatio: 2.8,
    specialization: "Key number buyer (NFL SPREAD, Under Bias)",
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
    sampleWagers: [
      {
        sport: "NFL",
        market: "Spread",
        line: "KC -3.0",
        clvBps: 180,
        stakeUsd: 5500,
        netUsd: 5000,
        time: "2026-11-09T18:12:00Z",
      },
      {
        sport: "NFL",
        market: "Spread",
        line: "BUF -7.0",
        clvBps: 220,
        stakeUsd: 6000,
        netUsd: 5450,
        time: "2026-11-08T20:45:00Z",
      },
      {
        sport: "NFL",
        market: "Spread",
        line: "DET -3.0",
        clvBps: 195,
        stakeUsd: 5000,
        netUsd: -5500,
        time: "2026-11-08T17:30:00Z",
      },
    ],
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
    correlatedScore: 0.7,
    sizingStrategy: "FLAT_UNIT",
    gini: 0.12,
    meanStake: 5000,
    maxMinRatio: 1.5,
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
    sampleWagers: [
      {
        sport: "CFB",
        market: "Spread",
        line: "TEX -6.5",
        clvBps: 240,
        stakeUsd: 5000,
        netUsd: 4545,
        time: "2026-11-09T16:00:00Z",
      },
      {
        sport: "NFL",
        market: "Spread",
        line: "BAL -2.5",
        clvBps: 160,
        stakeUsd: 5000,
        netUsd: 4545,
        time: "2026-11-09T14:15:00Z",
      },
    ],
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
    correlatedScore: 0.6,
    sizingStrategy: "FLAT_UNIT",
    gini: 0.14,
    meanStake: 2500,
    maxMinRatio: 1.8,
    specialization: "CFB TOTAL (Over Bias)",
    timingArchetype: "STEAM_CHASER",
    correlatedRisk: "HIGH",
    correlatedExploitRate: 0.45,
    syndicateRisk: "HIGH",
    syndicateProb: 0.9,
    subAccountIndex: 0,
    rootAccountId: "BRT5229",
    var95Usd: 8500,
    cvar95Usd: 10600,
    holdPct: -5.1,
    ltvUsd: -18000,
    recommendedLimitUsd: 500,
    inPlayDelaySec: 3,
    lineShadeCents: 15,
    shadowCopyMultiplier: 0.75,
    action: "ALERT_OPERATOR",
    ipAddress: "54.210.88.92", // AWS
  },
  {
    id: "BRT5229_1",
    name: "Barrett Sub-Wallet Seat 1",
    agentId: "AG_SHARP",
    masterAgent: "MASTER_SYNDICATE",
    tier: "TIER_2_STEAM_SYNDICATE",
    score: 8.3,
    clvScore: 2.5,
    skillScore: 2.0,
    sizingScore: 1.2,
    sigScore: 1.8,
    timingScore: 0.8,
    correlatedScore: 0.6,
    sizingStrategy: "FLAT_UNIT",
    gini: 0.13,
    meanStake: 2500,
    maxMinRatio: 1.7,
    specialization: "CFB TOTAL (Over Bias)",
    timingArchetype: "STEAM_CHASER",
    correlatedRisk: "HIGH",
    correlatedExploitRate: 0.45,
    syndicateRisk: "HIGH",
    syndicateProb: 0.9,
    subAccountIndex: 1,
    rootAccountId: "BRT5229",
    var95Usd: 8200,
    cvar95Usd: 10200,
    holdPct: -4.9,
    ltvUsd: -17500,
    recommendedLimitUsd: 500,
    inPlayDelaySec: 3,
    lineShadeCents: 15,
    shadowCopyMultiplier: 0.75,
    action: "ALERT_OPERATOR",
    ipAddress: "54.210.88.92", // AWS
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
    correlatedScore: 0.5,
    sizingStrategy: "FLAT_UNIT",
    gini: 0.13,
    meanStake: 2000,
    maxMinRatio: 1.6,
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
    correlatedScore: 0.4,
    sizingStrategy: "VARIABLE_STAKE",
    gini: 0.28,
    meanStake: 1500,
    maxMinRatio: 3.5,
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
    correlatedScore: 0.2,
    sizingStrategy: "VARIABLE_STAKE",
    gini: 0.32,
    meanStake: 800,
    maxMinRatio: 4.0,
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
    correlatedScore: 0.0,
    sizingStrategy: "FLAT_UNIT",
    gini: 0.11,
    meanStake: 1000,
    maxMinRatio: 1.4,
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
    correlatedScore: 0.0,
    sizingStrategy: "MARTINGALE_CHASER",
    gini: 0.68,
    meanStake: 2500,
    maxMinRatio: 16.0,
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
    ltvUsd: 72000,
    recommendedLimitUsd: 10000,
    inPlayDelaySec: 0,
    lineShadeCents: 0,
    shadowCopyMultiplier: 0.0,
    action: "ACCEPT",
    ipAddress: "24.180.3.11", // Residential Spectrum
  },
  {
    id: "BRT5235",
    name: "Barrett Key Buyer",
    agentId: "AG_SHARP",
    masterAgent: "MASTER_SYNDICATE",
    tier: "TIER_2_STEAM_SYNDICATE",
    score: 8.7,
    clvScore: 2.7,
    skillScore: 2.1,
    sizingScore: 1.2,
    sigScore: 1.9,
    timingScore: 0.8,
    correlatedScore: 0.6,
    sizingStrategy: "FLAT_UNIT",
    gini: 0.15,
    meanStake: 3000,
    maxMinRatio: 1.9,
    specialization: "NFL KEY SPREADS (3, 7)",
    timingArchetype: "STEAM_CHASER",
    correlatedRisk: "HIGH",
    correlatedExploitRate: 0.48,
    syndicateRisk: "HIGH",
    syndicateProb: 0.85,
    subAccountIndex: null,
    var95Usd: 10500,
    cvar95Usd: 13100,
    holdPct: -5.8,
    ltvUsd: -24000,
    recommendedLimitUsd: 500,
    inPlayDelaySec: 3,
    lineShadeCents: 15,
    shadowCopyMultiplier: 0.75,
    action: "ALERT_OPERATOR",
    ipAddress: "54.210.88.92",
  },
  {
    id: "CCC88412",
    name: "Cross-Conference Syndicate",
    agentId: "AG_SHARP",
    masterAgent: "MASTER_SYNDICATE",
    tier: "TIER_1_ELITE_ORIGINATOR",
    score: 9.1,
    clvScore: 2.9,
    skillScore: 2.3,
    sizingScore: 1.4,
    sigScore: 1.9,
    timingScore: 0.6,
    correlatedScore: 0.7,
    sizingStrategy: "PROPORTIONAL_KELLY",
    gini: 0.18,
    meanStake: 4500,
    maxMinRatio: 2.4,
    specialization: "CFB / NFL KEY NUMBERS",
    timingArchetype: "CLOSING_SNIPER",
    correlatedRisk: "HIGH",
    correlatedExploitRate: 0.55,
    syndicateRisk: "HIGH",
    syndicateProb: 0.8,
    subAccountIndex: null,
    var95Usd: 16000,
    cvar95Usd: 20000,
    holdPct: -7.5,
    ltvUsd: -38000,
    recommendedLimitUsd: 250,
    inPlayDelaySec: 3,
    lineShadeCents: 20,
    shadowCopyMultiplier: 1.0,
    action: "ALERT_OPERATOR",
    ipAddress: "146.190.10.20",
  },
  {
    id: "MJ107",
    name: "Mid-Atlantic Originator",
    agentId: "AG_SHARP",
    masterAgent: "MASTER_SYNDICATE",
    tier: "TIER_1_ELITE_ORIGINATOR",
    score: 8.8,
    clvScore: 2.8,
    skillScore: 2.2,
    sizingScore: 1.3,
    sigScore: 1.8,
    timingScore: 0.7,
    correlatedScore: 0.6,
    sizingStrategy: "FLAT_UNIT",
    gini: 0.16,
    meanStake: 4000,
    maxMinRatio: 2.0,
    specialization: "NFL KEY SPREADS (3, 7, 10)",
    timingArchetype: "STEAM_CHASER",
    correlatedRisk: "HIGH",
    correlatedExploitRate: 0.52,
    syndicateRisk: "HIGH",
    syndicateProb: 0.8,
    subAccountIndex: null,
    var95Usd: 13500,
    cvar95Usd: 16800,
    holdPct: -6.0,
    ltvUsd: -30000,
    recommendedLimitUsd: 250,
    inPlayDelaySec: 3,
    lineShadeCents: 20,
    shadowCopyMultiplier: 1.0,
    action: "ALERT_OPERATOR",
    ipAddress: "138.68.44.12",
  },
];

export const KNOWN_CUSTOMER_MAP: ReadonlyMap<string, TerminalCustomerRecord> =
  new Map(KNOWN_CUSTOMERS.map((c) => [c.id.toUpperCase(), c]));

export const KNOWN_CUSTOMER_IDS: readonly string[] = KNOWN_CUSTOMERS.map(
  (c) => c.id,
);

const ANSI_COLOR_MAP: Record<number, string> = {
  30: "#64748b",
  31: "#f87171",
  32: "#4ade80",
  33: "#fbbf24",
  34: "#60a5fa",
  35: "#c084fc",
  36: "#38bdf8",
  37: "#f8fafc",
  90: "#94a3b8",
  91: "#ef4444",
  92: "#22c55e",
  93: "#f59e0b",
  94: "#3b82f6",
  95: "#a855f7",
  96: "#06b6d4",
  97: "#ffffff",
};

const ANSI_BG_MAP: Record<number, string> = {
  40: "#0f172a",
  41: "rgba(239, 68, 68, 0.2)",
  42: "rgba(34, 197, 94, 0.2)",
  43: "rgba(245, 158, 11, 0.2)",
  44: "rgba(59, 130, 246, 0.2)",
  45: "rgba(168, 85, 247, 0.2)",
  46: "rgba(6, 182, 212, 0.2)",
  47: "#e2e8f0",
  100: "#1e293b",
  101: "rgba(239, 68, 68, 0.3)",
  102: "rgba(34, 197, 94, 0.3)",
};

/**
 * Parses raw terminal text with ANSI SGR escape codes and OSC 8 hyperlinks into structured segments.
 */
/* eslint-disable no-control-regex */
export function parseAnsiSegments(raw: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  const tokenRegex =
    /\x1b]8;[^\x1b\\]*(?:\x1b\\|\x07)([^\x1b]*)\x1b]8;;\x1b\\|\x1b\[([0-9;]*)m/g;

  let lastIndex = 0;
  let currentColor: string | undefined;
  let currentBg: string | undefined;
  let currentBold = false;
  let currentDim = false;
  let currentUnderline = false;
  let currentLink: string | undefined;

  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      const text = raw.slice(lastIndex, match.index);
      if (text.length > 0) {
        segments.push({
          text,
          color: currentColor,
          bg: currentBg,
          bold: currentBold,
          dim: currentDim,
          underline: currentUnderline,
          linkUrl: currentLink,
        });
      }
    }

    if (match[1] !== undefined) {
      const wholeMatch = match[0];
      const urlMatch = /^\x1b]8;([^\x1b\\]*)(?:\x1b\\|\x07)/.exec(wholeMatch);
      currentLink = urlMatch?.[1] ? urlMatch[1].replace(/^;/, "") : undefined;

      segments.push({
        text: match[1],
        color: "#38bdf8",
        underline: true,
        linkUrl: currentLink,
      });
      currentLink = undefined;
    } else if (match[2] !== undefined) {
      const paramStr = match[2];
      const codes =
        paramStr === ""
          ? [0]
          : paramStr
              .split(";")
              .filter((c, idx, arr) => !(idx === arr.length - 1 && c === ""))
              .map((c) => (c === "" ? 0 : Number.parseInt(c, 10)));
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]!;
        if (code === 0) {
          currentColor = undefined;
          currentBg = undefined;
          currentBold = false;
          currentDim = false;
          currentUnderline = false;
        } else if (code === 39) {
          currentColor = undefined;
        } else if (code === 49) {
          currentBg = undefined;
        } else if (code === 1) {
          currentBold = true;
        } else if (code === 2) {
          currentDim = true;
        } else if (code === 4) {
          currentUnderline = true;
        } else if (code === 22) {
          currentBold = false;
          currentDim = false;
        } else if (code === 24) {
          currentUnderline = false;
        } else if (
          code === 38 &&
          codes[i + 1] === 2 &&
          codes[i + 4] !== undefined
        ) {
          // ANSI 24-bit TrueColor foreground: 38;2;r;g;b
          const r = codes[i + 2]!;
          const g = codes[i + 3]!;
          const b = codes[i + 4]!;
          currentColor = `rgb(${r}, ${g}, ${b})`;
          i += 4;
        } else if (
          code === 48 &&
          codes[i + 1] === 2 &&
          codes[i + 4] !== undefined
        ) {
          // ANSI 24-bit TrueColor background: 48;2;r;g;b
          const r = codes[i + 2]!;
          const g = codes[i + 3]!;
          const b = codes[i + 4]!;
          currentBg = `rgb(${r}, ${g}, ${b})`;
          i += 4;
        } else if (code >= 30 && code <= 37) {
          currentColor = ANSI_COLOR_MAP[code];
        } else if (code >= 40 && code <= 47) {
          currentBg = ANSI_BG_MAP[code];
        } else if (code >= 90 && code <= 97) {
          currentColor = ANSI_COLOR_MAP[code];
        } else if (code >= 100 && code <= 107) {
          currentBg = ANSI_BG_MAP[code];
        }
      }
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < raw.length) {
    const text = raw.slice(lastIndex);
    if (text.length > 0) {
      segments.push({
        text,
        color: currentColor,
        bg: currentBg,
        bold: currentBold,
        dim: currentDim,
        underline: currentUnderline,
        linkUrl: currentLink,
      });
    }
  }

  return segments;
}

/** Escapes special HTML characters. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Converts raw ANSI terminal output to sanitized, styled HTML for web terminals.
 */
export function ansiToHtml(raw: string): string {
  const segments = parseAnsiSegments(raw);
  return segments
    .map((seg) => {
      const styles: string[] = [];
      if (seg.color) styles.push(`color: ${seg.color}`);
      if (seg.bg) styles.push(`background-color: ${seg.bg}`);
      if (seg.bold) styles.push("font-weight: 700");
      if (seg.dim) styles.push("opacity: 0.75");
      if (seg.underline) styles.push("text-decoration: underline");

      const styleAttr =
        styles.length > 0 ? ` style="${styles.join("; ")}"` : "";
      const escaped = escapeHtml(seg.text);

      if (seg.linkUrl) {
        return `<a href="${escapeHtml(seg.linkUrl)}" target="_blank" rel="noopener noreferrer"${styleAttr}>${escaped}</a>`;
      }
      return styles.length > 0
        ? `<span${styleAttr}>${escaped}</span>`
        : escaped;
    })
    .join("");
}

/**
 * Formats a terminal banner for the SportsDesk Terminal Emulator.
 */
export function getTerminalWelcomeBanner(): string {
  return [
    "\x1b[1;36m╔════════════════════════════════════════════════════════════════════════════╗\x1b[0m",
    "\x1b[1;36m║   ⚡ SPORTSDESK & FANTASY402 INTERACTIVE PTY TERMINAL (Bun.Terminal)     ║\x1b[0m",
    "\x1b[1;36m╚════════════════════════════════════════════════════════════════════════════╝\x1b[0m",
    "\x1b[90mEngine: Bun.spawn + Bun.Terminal PTY · Host: sportsdesk-ops · Invariant: autoExecute: false\x1b[0m",
    "",
    "\x1b[1;33mCommands & Canonical Shortcodes:\x1b[0m",
    "  \x1b[1;32mprofile <id>\x1b[0m (aliases: \x1b[32mp, c\x1b[0m) Inspect multidimensional sharpness radar (flags: \x1b[36m--radar\x1b[0m, \x1b[36m--json\x1b[0m, \x1b[36m--wagers\x1b[0m)",
    "  \x1b[1;32mfind <query>\x1b[0m (aliases: \x1b[32mf, s\x1b[0m) Search accounts (flags: \x1b[36m-t <tier>\x1b[0m, \x1b[36m-s <sport>\x1b[0m, \x1b[36m-a <action>\x1b[0m)",
    "  \x1b[1;32msharps\x1b[0m (aliases: \x1b[32msh, top\x1b[0m)    Top sharp originators ranked by Sharpness Composite Index",
    "  \x1b[1;32msyndicates\x1b[0m (aliases: \x1b[32msyn\x1b[0m)       Detected hook syndicate clusters & sub-accounts",
    "  \x1b[1;32mkey-numbers\x1b[0m (aliases: \x1b[32mk, keys\x1b[0m) Football key number buyers (3, 7, 10, 14, 21) hit rates & edge",
    "  \x1b[1;32mgini\x1b[0m (alias: \x1b[32mg\x1b[0m)               Stake inequality Gini rankings (flat unit vs Kelly vs martingale)",
    "  \x1b[1;32mdirectives\x1b[0m (aliases: \x1b[32mdir\x1b[0m)     Actionable desk directives, limit caps & in-play delays",
    "  \x1b[1;32mrisk\x1b[0m (aliases: \x1b[32mvar, cvar\x1b[0m)       7d Value-at-Risk (95%), CVaR shortfall & hold %",
    "  \x1b[1;32mstats\x1b[0m (aliases: \x1b[32mstat\x1b[0m)          Full cohort breakdown & capital protection metrics",
    "  \x1b[1;32mwho\x1b[0m (alias: \x1b[32mw\x1b[0m)                Operator desk, session, worktree & Bun runtime info",
    "  \x1b[1;32mkeybindings\x1b[0m (alias: \x1b[32mkb\x1b[0m)        Terminal & GUI keyboard shortcuts cheat sheet",
    "  \x1b[1;32mbursts\x1b[0m (alias: \x1b[32mb, steam\x1b[0m)       Detected multi-account steam bursts (≤ 180s coordinated window)",
    "  \x1b[1;32mquarantine\x1b[0m (aliases: \x1b[32mq, guard\x1b[0m)   Real-time sliding window syndicate burst quarantine directives",
    "  \x1b[1;32mws\x1b[0m (alias: \x1b[32msubscriptions\x1b[0m)         Inspect connected WebSocket clients and active topic channels",
    "  \x1b[1;32mtrunks\x1b[0m (alias: \x1b[32mt, trees\x1b[0m)        Two-trunk downline comparison (TRACKTHIS VIP vs NOLAPPH Retail)",
    "  \x1b[1;32mdns <host>\x1b[0m (alias: \x1b[32md\x1b[0m)         Benchmark c-ares vs system DNS resolver latency",
    "  \x1b[1;32mreverse <ip>\x1b[0m (alias: \x1b[32mr, ip\x1b[0m)     Reverse DNS forensics & datacenter/residential IP lookup",
    "  \x1b[1;32mcron <expr>\x1b[0m (alias: \x1b[32mcr\x1b[0m)        Inspect Bun.cron() schedule triggers",
    "  \x1b[1;32mmarkdown\x1b[0m (alias: \x1b[32mmd\x1b[0m)           Render Markdown via native Bun.markdown.ansi",
    "  \x1b[1;32mcapabilities\x1b[0m                  Inspect Bun v1.4 native engine capabilities",
    "  \x1b[1;32mclear\x1b[0m (alias: \x1b[32mcls\x1b[0m)             Clear terminal screen buffer",
    "  \x1b[1;32mhelp\x1b[0m (aliases: \x1b[32mh, ?\x1b[0m)           Display this reference manual",
    "",
    "\x1b[1;33mKeyboard Shortcuts:\x1b[0m \x1b[36m[Tab]\x1b[0m Autocomplete · \x1b[36m[Ctrl+` / Cmd+K]\x1b[0m Toggle PTY · \x1b[36m[Ctrl+1/2/3]\x1b[0m Tabs · \x1b[36m[Ctrl+L]\x1b[0m Clear",
    "",
  ].join("\n");
}

/**
 * Renders an ASCII radar chart for sharpness pillars.
 */
function renderRadarAscii(cust: TerminalCustomerRecord): string {
  const bar = (val: number, max: number, len = 12) => {
    const filled = Math.round((val / max) * len);
    return "█".repeat(filled).padEnd(len, "░");
  };

  return [
    `┌────────────────────────────────────────────────────────┐`,
    `│ 📊 SHARPNESS RADAR DECOMPOSITION: ${padDisplay(cust.id, 20)} │`,
    `├───────────────────────┬──────┬─────────────────────────┤`,
    `│ Pillar                │ Score│ Visual Intensity Radar  │`,
    `├───────────────────────┼──────┼─────────────────────────┤`,
    `│ CLV Alpha             │  ${cust.clvScore.toFixed(1)} │ \x1b[32m${bar(cust.clvScore, 3.0)}\x1b[0m ${cust.clvScore.toFixed(1)}/3.0      │`,
    `│ Bayesian Skill        │  ${cust.skillScore.toFixed(1)} │ \x1b[32m${bar(cust.skillScore, 2.5)}\x1b[0m ${cust.skillScore.toFixed(1)}/2.5      │`,
    `│ Stake Sizing (Gini)   │  ${cust.sizingScore.toFixed(1)} │ \x1b[33m${bar(cust.sizingScore, 1.5)}\x1b[0m ${cust.sizingScore.toFixed(1)}/1.5      │`,
    `│ Behavioral Signatures │  ${cust.sigScore.toFixed(1)} │ \x1b[35m${bar(cust.sigScore, 2.0)}\x1b[0m ${cust.sigScore.toFixed(1)}/2.0      │`,
    `│ Execution Timing      │  ${cust.timingScore.toFixed(1)} │ \x1b[36m${bar(cust.timingScore, 1.0)}\x1b[0m ${cust.timingScore.toFixed(1)}/1.0      │`,
    `│ Correlated Exploit    │  ${cust.correlatedScore.toFixed(1)} │ \x1b[31m${bar(cust.correlatedScore, 1.0)}\x1b[0m ${cust.correlatedScore.toFixed(1)}/1.0      │`,
    `└───────────────────────┴──────┴─────────────────────────┘`,
  ].join("\n");
}

/**
 * Renders sample wagers table for a customer.
 */
function renderWagersTable(cust: TerminalCustomerRecord): string {
  const wagers = cust.sampleWagers ?? [];
  if (wagers.length === 0) {
    return `\x1b[33mNo recent ticket samples available for ${cust.id}\x1b[0m`;
  }

  const rows = [
    `\x1b[1;36m🎟️ Recent Ticket Sample for ${cust.id} (${wagers.length} wagers):\x1b[0m`,
    "┌──────┬──────────┬─────────────┬──────────┬──────────┬──────────┬──────────────────────┐",
    "│ Sport│ Market   │ Selection   │ CLV(bps) │ Stake    │ Net USD  │ Submitted Time       │",
    "├──────┼──────────┼─────────────┼──────────┼──────────┼──────────┼──────────────────────┤",
  ];

  for (const w of wagers) {
    const sportPad = padDisplay(w.sport, 5);
    const mktPad = padDisplay(w.market, 8);
    const lineFormatted = formatHalfPointLine(w.line);
    const linePad = padDisplay(lineFormatted, 11);
    const clvStr = padDisplay(
      `${w.clvBps > 0 ? "+" : ""}${w.clvBps}`,
      8,
      "right",
    );
    const stakeStr = padDisplay(`$${w.stakeUsd.toLocaleString()}`, 8, "right");
    const netStr = padDisplay(
      `${w.netUsd >= 0 ? "+" : ""}$${w.netUsd.toLocaleString()}`,
      8,
      "right",
    );
    const timePad = padDisplay(w.time, 20);

    const netColored =
      w.netUsd > 0
        ? `\x1b[32m${netStr}\x1b[0m`
        : w.netUsd < 0
          ? `\x1b[31m${netStr}\x1b[0m`
          : netStr;

    rows.push(
      `│ ${sportPad} │ ${mktPad} │ \x1b[1m${linePad}\x1b[0m │ \x1b[32m${clvStr}\x1b[0m │ ${stakeStr} │ ${netColored} │ ${timePad} │`,
    );
  }

  rows.push(
    "└──────┴──────────┴─────────────┴──────────┴──────────┴──────────┴──────────────────────┘",
  );
  return rows.join("\n");
}

/**
 * Renders key number buyers table.
 */
function renderKeyNumbersTable(): string {
  const rows = [
    "\x1b[1;36m🔑 FOOTBALL KEY NUMBER BUYER COHORT (Spreads: 3, 7, 10, 14, 21)\x1b[0m",
    "┌──────────┬──────────────┬──────────┬──────────────┬──────┬──────────────────────────────┬────────────┬──────┐",
    "│ Customer │ Agent        │ Tickets  │ Risk Volume  │ 2H % │ Key Numbers Dist (3/7/10/14) │ Edge (Bps) │ Conf │",
    "├──────────┼──────────────┼──────────┼──────────────┼──────┼──────────────────────────────┼────────────┼──────┤",
  ];

  let totalRisk = 0;
  let totalEdge = 0;
  let count = 0;

  for (const [custId, prof] of KEY_NUMBER_BUYER_PROFILES) {
    count++;
    totalRisk += prof.totalRiskUsd;
    totalEdge += prof.evidence.avgEdgeCents;

    const agentId =
      KNOWN_CUSTOMER_MAP.get(custId)?.agentId ??
      (custId === "GP301" ? "AG99" : "AG_SHARP");
    const idLink = formatOsc8Hyperlink(
      getCanonicalCustomerUrl(custId),
      padDisplay(custId, 8),
    );
    const agentLink = formatOsc8Hyperlink(
      getCanonicalAgentUrl(agentId),
      padDisplay(agentId, 12),
    );
    const tixPad = padDisplay(String(prof.nTickets), 8, "right");
    const riskPad = padDisplay(
      `$${Math.round(prof.totalRiskUsd).toLocaleString()}`,
      12,
      "right",
    );
    const twoHPad = padDisplay(
      `${Math.round(prof.evidence.twoHalfBetRate * 100)}%`,
      4,
      "right",
    );
    const dist = prof.evidence.keyNumberConcentration;
    const distStr = `3:${dist["3"] ?? 0} 7:${dist["7"] ?? 0} 10:${dist["10"] ?? 0} 14:${dist["14"] ?? 0} 21:${dist["21"] ?? 0}`;
    const distPad = padDisplay(distStr, 28);
    const edgeColored = `\x1b[32m${padDisplay(`+${prof.evidence.avgEdgeCents.toFixed(1)}¢`, 10, "right")}\x1b[0m`;
    const confPad = padDisplay(prof.confidence.toFixed(2), 4, "right");

    rows.push(
      `│ \x1b[1;36m${idLink}\x1b[0m │ ${agentLink} │ ${tixPad} │ ${riskPad} │ ${twoHPad} │ ${distPad} │ ${edgeColored} │ ${confPad} │`,
    );
  }

  const meanEdge = count > 0 ? (totalEdge / count).toFixed(1) : "0.0";
  const riskM = (totalRisk / 1_000_000).toFixed(2);
  rows.push(
    "└──────────┴──────────────┴──────────┴──────────────┴──────┴──────────────────────────────┴────────────┴──────┘",
    `\x1b[90mCohort Summary: ${count} verified originators · Mean Edge: +${meanEdge}¢ · Combined Risk: $${riskM}M\x1b[0m`,
    "\x1b[90mTip: Type 'p GP301' or 'p CCC88412' to inspect individual behavioral radar.\x1b[0m",
  );
  return rows.join("\n");
}

/**
 * Renders stake Gini ranking table.
 */
function renderGiniRankingsTable(): string {
  const sorted = [...KNOWN_CUSTOMERS].sort((a, b) => a.gini - b.gini);
  const rows = [
    "\x1b[1;36m📊 STAKE INEQUALITY GINI RANKINGS (Flat Unit vs Kelly vs Martingale)\x1b[0m",
    "┌──────┬──────────┬──────────────────────┬───────┬────────────┬─────────┬──────────────────────────────┐",
    "│ Rank │ Customer │ Sizing Strategy      │ Gini  │ Mean Stake │ Max/Min │ Sizing Risk Profile          │",
    "├──────┼──────────┼──────────────────────┼───────┼────────────┼─────────┼──────────────────────────────┤",
  ];

  let rank = 1;
  for (const c of sorted) {
    const rankStr = String(rank++).padStart(4);
    const idPad = formatOsc8Hyperlink(
      getCanonicalCustomerUrl(c.id),
      padDisplay(c.id, 8),
    );
    const stratPad = padDisplay(c.sizingStrategy.slice(0, 20), 20);
    const giniStr = c.gini.toFixed(2).padStart(5);
    const meanStr = `$${c.meanStake.toLocaleString()}`.padStart(10);
    const ratioStr = `${c.maxMinRatio.toFixed(1)}x`.padStart(7);

    let profileDesc = "Low Variance (Unit Discipline)";
    let giniColored = `\x1b[32m${giniStr}\x1b[0m`;
    if (c.gini > 0.4) {
      profileDesc = "EXTREME (Martingale Chaser)";
      giniColored = `\x1b[31m${giniStr}\x1b[0m`;
    } else if (c.gini > 0.2) {
      profileDesc = "Advantage (Kelly Proportional)";
      giniColored = `\x1b[33m${giniStr}\x1b[0m`;
    }

    rows.push(
      `│ ${rankStr} │ \x1b[1;36m${idPad}\x1b[0m │ ${stratPad} │ ${giniColored} │ ${meanStr} │ ${ratioStr} │ ${padDisplay(profileDesc, 28)} │`,
    );
  }

  rows.push(
    "└──────┴──────────┴──────────────────────┴───────┴────────────┴─────────┴──────────────────────────────┘",
    "\x1b[90mInterpretation: Flat unit bettors (Gini < 0.15) signal disciplined syndicates; Gini > 0.5 signals square volatility.\x1b[0m",
  );
  return rows.join("\n");
}

/**
 * Renders desk directives table.
 */
function renderDirectivesTable(): string {
  const rows = [
    "\x1b[1;36m🚨 ACTIONABLE DESK DIRECTIVES (Limit Ceilings, Live Delays & Line Shading)\x1b[0m",
    "\x1b[90mInvariant: autoExecute: false | Human operator approval mandatory before committing changes\x1b[0m",
    "┌────────────┬────────────────┬───────────┬─────────┬──────────┬────────┬─────────────────────────────┐",
    "│ Customer   │ Desk Action    │ Max Limit │ Delay   │ Shading  │ Shadow │ Target Specialization       │",
    "├────────────┼────────────────┼───────────┼─────────┼──────────┼────────┼─────────────────────────────┤",
  ];

  for (const c of KNOWN_CUSTOMERS) {
    const idPad = formatOsc8Hyperlink(
      getCanonicalCustomerUrl(c.id),
      padDisplay(c.id, 10),
    );
    const actRaw =
      c.action === "ALERT_OPERATOR"
        ? `\x1b[31m${c.action}\x1b[0m`
        : c.action === "MONITOR"
          ? `\x1b[33m${c.action}\x1b[0m`
          : `\x1b[32m${c.action}\x1b[0m`;
    const actColored = padDisplay(actRaw, 14);
    const limitPad = padDisplay(
      `$${c.recommendedLimitUsd.toLocaleString()}`,
      9,
      "right",
    );
    const delayPad = padDisplay(`${c.inPlayDelaySec}s`, 7, "right");
    const shadePad = padDisplay(`${c.lineShadeCents}¢`, 8, "right");
    const shadowPad = padDisplay(
      `${c.shadowCopyMultiplier.toFixed(2)}x`,
      6,
      "right",
    );
    const specPad = padDisplay(c.specialization.slice(0, 27), 27);

    rows.push(
      `│ \x1b[1;36m${idPad}\x1b[0m │ ${actColored} │ \x1b[1m${limitPad}\x1b[0m │ ${delayPad} │ ${shadePad} │ ${shadowPad} │ ${specPad} │`,
    );
  }

  rows.push(
    "└────────────┴────────────────┴───────────┴─────────┴──────────┴────────┴─────────────────────────────┘",
  );
  return rows.join("\n");
}

/**
 * Renders risk & 7d VaR forensics table.
 */
function renderRiskForensicsTable(): string {
  const rows = [
    "\x1b[1;36m📈 PORTFOLIO RISK FORENSICS (95% 7d VaR, CVaR Shortfall & Hold %)\x1b[0m",
    "┌────────────┬─────────────────────────────┬─────────────┬─────────────┬────────┬──────────────┬───────────┐",
    "│ Customer   │ Sharpness Tier              │ 7d VaR(95%) │ 7d CVaR(95%)│ Hold % │ Lifetime Net │ Action    │",
    "├────────────┼─────────────────────────────┼─────────────┼─────────────┼────────┼──────────────┼───────────┤",
  ];

  let totalVar = 0;
  let totalCvar = 0;

  for (const c of KNOWN_CUSTOMERS) {
    totalVar += c.var95Usd;
    totalCvar += c.cvar95Usd;
    const idPad = formatOsc8Hyperlink(
      getCanonicalCustomerUrl(c.id),
      padDisplay(c.id, 10),
    );
    const tierPad = padDisplay(c.tier.slice(0, 27), 27);
    const varStr = `$${c.var95Usd.toLocaleString()}`.padStart(11);
    const cvarStr = `$${c.cvar95Usd.toLocaleString()}`.padStart(11);
    const holdStr = `${c.holdPct.toFixed(1)}%`.padStart(6);
    const netStr =
      `${c.ltvUsd <= 0 ? "-" : "+"}$${Math.abs(c.ltvUsd).toLocaleString()}`.padStart(
        12,
      );
    const actPad = padDisplay(c.action.slice(0, 9), 9);

    const holdColored =
      c.holdPct < 0 ? `\x1b[31m${holdStr}\x1b[0m` : `\x1b[32m${holdStr}\x1b[0m`;

    rows.push(
      `│ \x1b[1;36m${idPad}\x1b[0m │ ${tierPad} │ \x1b[1m${varStr}\x1b[0m │ ${cvarStr} │ ${holdColored} │ ${netStr} │ ${actPad} │`,
    );
  }

  rows.push(
    "└────────────┴─────────────────────────────┴─────────────┴─────────────┴────────┴──────────────┴───────────┘",
    `\x1b[1;33mAggregate Portfolio Risk:\x1b[0m 7d VaR(95%): \x1b[1m$${totalVar.toLocaleString()}\x1b[0m | 7d CVaR(95%): \x1b[1m$${totalCvar.toLocaleString()}\x1b[0m | Desk Savings: \x1b[1;32m+$195,600\x1b[0m`,
  );
  return rows.join("\n");
}

/**
 * Renders stats summary for customer database.
 */
function renderStatsSummary(): string {
  return [
    "\x1b[1;36m⚡ SPORTSDESK PORTFOLIO PROFILING INTELLIGENCE (Full 4,914 ID Surface)\x1b[0m",
    "═".repeat(80),
    "  • \x1b[1;33mTotal Provisioned Accounts  \x1b[0m: 4,914 accounts across operator downline",
    "  • \x1b[1;33mActive Enriched Customer Book\x1b[0m: 220 accounts (1,100 ticket sample, full PnL)",
    "  • \x1b[1;33mBacktest Evaluated Cohort   \x1b[0m: 49 accounts ($310,000 handle, $195,600 counterfactual savings)",
    "  • \x1b[1;33mElite Originators (Tier 1)  \x1b[0m: 4 accounts (GP301, BRT5229, CCC88412, MJ107)",
    "  • \x1b[1;33mSteam Syndicates (Tier 2)   \x1b[0m: 4 accounts (BRT5229_0, BRT5229_1, ST100, BRT5235)",
    "  • \x1b[1;33mDisciplined Sharps (Tier 3) \x1b[0m: 1 account  (LIVE99 - In-Play Latency Hunter)",
    "  • \x1b[1;33mKey Number Buyer Cohort     \x1b[0m: 5 accounts (mean edge +10.9¢, 827+ tickets)",
    "  • \x1b[1;33mDownline Hook Syndicates    \x1b[0m: 2 clusters (Barrett root + 2 sub-wallets, Golden Punter ring)",
    "  • \x1b[1;33mAverage Composite Sharpness \x1b[0m: 7.2 / 10.0 (monitored sharp cohort)",
    "  • \x1b[1;33mAggregate Hold Percentage   \x1b[0m: -5.8% (unmanaged sharps) vs +8.2% (recreational house hold)",
    "  • \x1b[1;33mDirectives Invariant        \x1b[0m: autoExecute: false active · Zero automated bet mutations",
    "═".repeat(80),
    "\x1b[90mTip: Type 'sharps' for leaderboard, 'gini' for stake dispersion, or 'k' for key numbers.\x1b[0m",
  ].join("\n");
}

/**
 * Renders operator identity & session info.
 */
function renderWhoSession(): string {
  return [
    "\x1b[1;36m👤 SPORTSDESK OPERATOR IDENTITY & RUNTIME FORENSICS\x1b[0m",
    "═".repeat(80),
    "  • \x1b[1;33mOperator Desk      \x1b[0m: SportsDesk Ops (Fantasy402 / GSLive / GSBuilder)",
    "  • \x1b[1;33mWorktree           \x1b[0m: customer_wager_profiling_rating",
    "  • \x1b[1;33mRuntime Engine     \x1b[0m: Bun v1.4.4 (Darwin arm64)",
    "  • \x1b[1;33mTerminal Driver    \x1b[0m: Bun.Terminal (native PTY /dev/ptmx) via Bun.spawn",
    "  • \x1b[1;33mActive DNS Engine  \x1b[0m: c-ares (asynchronous) + system fallback (continuous warming)",
    "  • \x1b[1;33mInvariant Contract \x1b[0m: autoExecute: false (Signal Honesty ADR #69/#85)",
    "  • \x1b[1;33mProduction Policy  \x1b[0m: READ-ONLY (No ad-hoc database mutations)",
    "═".repeat(80),
  ].join("\n");
}

/**
 * Renders keybindings reference cheat sheet.
 */
function renderKeybindingsCheatSheet(): string {
  const rows = [
    "\x1b[1;36m⌨️  SPORTSDESK KEYBOARD SHORTCUTS & NAVIGATION\x1b[0m",
    "┌──────────────────────┬────────────────────────────────────────────────────────────┐",
    "│ Keybinding           │ Action Description                                         │",
    "├──────────────────────┼────────────────────────────────────────────────────────────┤",
  ];

  for (const kb of KEYBINDINGS_REFERENCE) {
    const keyPad = kb.key.padEnd(20);
    const descPad = kb.desc.padEnd(58);
    rows.push(`│ \x1b[1;33m${keyPad}\x1b[0m │ ${descPad} │`);
  }

  rows.push(
    "└──────────────────────┴────────────────────────────────────────────────────────────┘",
    "\x1b[90mTip: Press [Tab] to auto-complete commands, shortcodes, and customer IDs in real-time.\x1b[0m",
  );
  return rows.join("\n");
}

/**
 * High-Level Terminal Query Dispatcher.
 * Uses Bun.Terminal PTY with Bun.spawn for authentic command execution,
 * with fast in-memory fallbacks for instant searches.
 */
async function executeTerminalQueryInner(
  rawInput: string,
  options: TerminalQueryOptions = {},
): Promise<TerminalQueryResult> {
  const startedAt = Date.now();
  const trimmed = rawInput.trim();

  if (trimmed === "") {
    return {
      command: "",
      stdout: "",
      exitCode: 0,
      durationMs: 0,
      timestamp: startedAt,
    };
  }

  // Parse command tokens and flags
  const tokens = trimmed.split(/\s+/);
  const rawFirstToken = tokens[0]?.toLowerCase() ?? "";
  const cmdArgs = tokens.slice(1);

  // Normalize command via alias registry
  let canonicalCmd = COMMAND_ALIASES[rawFirstToken] ?? rawFirstToken;

  // Single-token customer ID shorthand expansion: e.g. "GP301", "BRT5229", "ST100"
  if (tokens.length === 1 && !COMMAND_ALIASES[rawFirstToken]) {
    const upper = trimmed.toUpperCase();
    if (
      KNOWN_CUSTOMER_MAP.has(upper) ||
      KEY_NUMBER_BUYER_PROFILES.has(upper) ||
      HALF_POINT_HOOK_SYNDICATE_PROFILES.has(upper) ||
      /^(?:GP|BRT|ST|RF|BK|BGD|CCC|MJ|SYNTH|VIP)\d+/i.test(trimmed)
    ) {
      canonicalCmd = "profile";
      cmdArgs.push(upper);
    }
  }

  // Built-in 'clear' / 'cls'
  if (canonicalCmd === "clear") {
    return {
      command: trimmed,
      stdout: "\x1b[2J\x1b[H",
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Built-in 'help' / 'h' / '?'
  if (canonicalCmd === "help") {
    return {
      command: trimmed,
      stdout: getTerminalWelcomeBanner(),
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Quick Command: Keybindings cheat sheet
  if (canonicalCmd === "keybindings") {
    return {
      command: trimmed,
      stdout: renderKeybindingsCheatSheet(),
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Quick Command: Key Number Buyers Cohort
  if (canonicalCmd === "key-numbers") {
    return {
      command: trimmed,
      stdout: renderKeyNumbersTable(),
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Quick Command: Stake Gini Rankings
  if (canonicalCmd === "gini") {
    return {
      command: trimmed,
      stdout: renderGiniRankingsTable(),
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Quick Command: Desk Action Directives
  if (canonicalCmd === "directives") {
    return {
      command: trimmed,
      stdout: renderDirectivesTable(),
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Quick Command: Risk & VaR Forensics
  if (canonicalCmd === "risk") {
    return {
      command: trimmed,
      stdout: renderRiskForensicsTable(),
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Quick Command: Portfolio Stats Summary
  if (canonicalCmd === "stats") {
    return {
      command: trimmed,
      stdout: renderStatsSummary(),
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Quick Command: Operator Session Identity (who)
  if (canonicalCmd === "who") {
    return {
      command: trimmed,
      stdout: renderWhoSession(),
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Quick Command: Sharps / Leaderboard
  if (canonicalCmd === "sharps") {
    return await executeTerminalQuery("find -t sharp", options);
  }

  // Quick Command: Syndicates & Hook Rings
  if (canonicalCmd === "syndicates") {
    return await executeTerminalQuery("find -t syndicate", options);
  }

  // Quick Command: Profile Inspector
  if (canonicalCmd === "profile") {
    const flags = new Set(cmdArgs.filter((a) => a.startsWith("-")));
    const idArg = cmdArgs.find((a) => !a.startsWith("-")) || "GP301";
    const upperId = idArg.toUpperCase();

    const cust = KNOWN_CUSTOMER_MAP.get(upperId);
    if (!cust) {
      // Check behavioral profiles
      const keyProf =
        KEY_NUMBER_BUYER_PROFILES.get(upperId) ??
        HALF_POINT_HOOK_SYNDICATE_PROFILES.get(upperId);
      if (keyProf) {
        const inspectFn = keyProf[Bun.inspect.custom];
        const customOutput =
          typeof inspectFn === "function"
            ? String(inspectFn.call(keyProf, 0, {}))
            : String(keyProf);
        const stdout = [
          `\x1b[1;36m🎯 SPORTSDESK BEHAVIORAL PROFILE: ${upperId}\x1b[0m`,
          "═".repeat(80),
          customOutput,
          "═".repeat(80),
          `\x1b[1;33mDesk Directives:\x1b[0m \x1b[31mALERT_OPERATOR\x1b[0m | Max Limit: \x1b[1m$1,000\x1b[0m | In-Play Delay: \x1b[1m3s\x1b[0m | Shading: \x1b[1m15¢\x1b[0m`,
        ].join("\n");
        return {
          command: trimmed,
          stdout,
          exitCode: 0,
          durationMs: Date.now() - startedAt,
          timestamp: startedAt,
        };
      }

      return {
        command: trimmed,
        stdout: `\x1b[33mCustomer '${idArg}' not found in local active profile matrix.\x1b[0m\n\x1b[90mTry: profile GP301, profile BRT5229, profile ST100, or type 'find <query>'\x1b[0m`,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    }

    // Flag: --json
    if (flags.has("--json")) {
      return {
        command: trimmed,
        stdout: JSON.stringify(cust, null, 2),
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    }

    // Flag: --wagers
    if (flags.has("--wagers")) {
      return {
        command: trimmed,
        stdout: renderWagersTable(cust),
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    }

    // Flag: --radar
    if (flags.has("--radar")) {
      return {
        command: trimmed,
        stdout: renderRadarAscii(cust),
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    }

    // Default: Comprehensive Profile View
    const idLink = formatOsc8Hyperlink(
      getCanonicalCustomerUrl(cust.id),
      cust.id,
    );
    const agentLink = formatOsc8Hyperlink(
      getCanonicalAgentUrl(cust.agentId),
      cust.agentId,
    );
    const masterLink = formatOsc8Hyperlink(
      getCanonicalAgentUrl(cust.masterAgent),
      cust.masterAgent,
    );

    const stdout = [
      `\x1b[1;36m🎯 SPORTSDESK BEHAVIORAL PROFILE: ${cust.id} (COMPREHENSIVE)\x1b[0m`,
      "═".repeat(80),
      `  Name: \x1b[1m${cust.name}\x1b[0m | Portal: \x1b[36m${idLink}\x1b[0m | Agent: \x1b[36m${agentLink}\x1b[0m | Master: \x1b[36m${masterLink}\x1b[0m`,
      `  Sharpness Tier : \x1b[1;33m${cust.tier}\x1b[0m (Composite Score: \x1b[1;32m${cust.score.toFixed(1)}/10.0\x1b[0m)`,
      `  Specialization : ${cust.specialization} | Archetype: \x1b[35m${cust.timingArchetype}\x1b[0m`,
      `  Stake Sizing   : ${cust.sizingStrategy} | Gini: \x1b[1m${cust.gini}\x1b[0m | Mean Stake: \x1b[1m$${cust.meanStake.toLocaleString()}\x1b[0m`,
      `  Risk Forensics : 95% 7d VaR \x1b[1;31m$${cust.var95Usd.toLocaleString()}\x1b[0m | CVaR \x1b[1;31m$${cust.cvar95Usd.toLocaleString()}\x1b[0m | Hold: \x1b[1m${cust.holdPct}%\x1b[0m`,
      `  Syndicate Risk : ${cust.syndicateRisk} (${Math.round(cust.syndicateProb * 100)}% prob) | Correlated: ${cust.correlatedRisk} (${Math.round(cust.correlatedExploitRate * 100)}% exploit)`,
      cust.rootAccountId
        ? `  Sub-Account    : \x1b[31mSeat #${cust.subAccountIndex} (Parent: ${cust.rootAccountId})\x1b[0m`
        : `  Account Type   : Root Account`,
      "",
      renderRadarAscii(cust),
      "",
      `\x1b[1;33mOperator Action Directives:\x1b[0m Action: \x1b[1;31m${cust.action}\x1b[0m | Max Limit: \x1b[1m$${cust.recommendedLimitUsd.toLocaleString()}\x1b[0m | In-Play Delay: \x1b[1m${cust.inPlayDelaySec}s\x1b[0m | Shading: \x1b[1m${cust.lineShadeCents}¢\x1b[0m | Shadow: \x1b[1m${cust.shadowCopyMultiplier}x\x1b[0m`,
      "═".repeat(80),
      `\x1b[90mFlags: Try 'profile ${cust.id} --radar', 'profile ${cust.id} --wagers', or 'profile ${cust.id} --json'\x1b[0m`,
    ].join("\n");

    return {
      command: trimmed,
      stdout,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Quick Command: Find / Search across customer datasets
  if (canonicalCmd === "find") {
    let tierFilter: string | null = null;
    let sportFilter: string | null = null;
    let actionFilter: string | null = null;
    const queryWords: string[] = [];

    for (let i = 0; i < cmdArgs.length; i++) {
      const arg = cmdArgs[i]!;
      if ((arg === "-t" || arg === "--tier") && i + 1 < cmdArgs.length) {
        tierFilter = cmdArgs[++i]!.toLowerCase();
      } else if (
        (arg === "-s" || arg === "--sport") &&
        i + 1 < cmdArgs.length
      ) {
        sportFilter = cmdArgs[++i]!.toLowerCase();
      } else if (
        (arg === "-a" || arg === "--action") &&
        i + 1 < cmdArgs.length
      ) {
        actionFilter = cmdArgs[++i]!.toLowerCase();
      } else {
        queryWords.push(arg.toLowerCase());
      }
    }

    const query = queryWords.join(" ");

    const matches: Array<{
      id: string;
      agent: string;
      tier: string;
      score: number;
      action: string;
      detail: string;
    }> = [];

    // Search known customer records
    for (const c of KNOWN_CUSTOMERS) {
      if (tierFilter && !c.tier.toLowerCase().includes(tierFilter)) continue;
      if (
        sportFilter &&
        !c.specialization.toLowerCase().includes(sportFilter)
      ) {
        continue;
      }
      if (actionFilter && !c.action.toLowerCase().includes(actionFilter)) {
        continue;
      }

      const text =
        `${c.id} ${c.name} ${c.agentId} ${c.masterAgent} ${c.tier} ${c.specialization} ${c.sizingStrategy} ${c.ipAddress}`.toLowerCase();
      if (query === "" || text.includes(query)) {
        matches.push({
          id: c.id,
          agent: c.agentId,
          tier: c.tier,
          score: c.score,
          action: c.action,
          detail: `${c.specialization} (${c.sizingStrategy})`,
        });
      }
    }

    // Search Backtest Cohort (docs/backtest-4wk-cfb-nba.json)
    try {
      const backtestFile = Bun.file("docs/backtest-4wk-cfb-nba.json");
      if (await backtestFile.exists()) {
        const json = (await backtestFile.json()) as {
          customerLeaderboard?: Array<{
            customerId: string;
            agentId?: string;
            score?: number;
            tier?: string;
            sports?: string;
            sharpScore?: number;
          }>;
        };
        for (const c of json.customerLeaderboard ?? []) {
          const cTier = c.tier ?? "TIER_SHARP";
          const cSport = c.sports ?? "CFB/NBA";
          if (tierFilter && !cTier.toLowerCase().includes(tierFilter)) continue;
          if (sportFilter && !cSport.toLowerCase().includes(sportFilter)) {
            continue;
          }

          const text =
            `${c.customerId} ${c.agentId ?? ""} ${cTier} ${cSport}`.toLowerCase();
          if (query === "" || text.includes(query)) {
            if (!matches.some((m) => m.id === c.customerId)) {
              const scoreVal = c.sharpScore
                ? c.sharpScore / 10
                : (c.score ?? 7.5);
              matches.push({
                id: c.customerId,
                agent: c.agentId ?? "UNKNOWN",
                tier: cTier,
                score: scoreVal,
                action: scoreVal >= 8.5 ? "ALERT_OPERATOR" : "MONITOR",
                detail: `Backtest cohort record (${cSport})`,
              });
            }
          }
        }
      }
    } catch {
      // Ignored
    }

    if (matches.length === 0) {
      return {
        command: trimmed,
        stdout: `\x1b[33mNo accounts found matching search filters: "${trimmed}"\x1b[0m\n\x1b[90mTry: find GP301, find -t sharp, find -s CFB, find syndicate, or sharps\x1b[0m`,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    }

    const rows = [
      `\x1b[1;36m🔍 Search Results (${matches.length} matches):\x1b[0m`,
      "┌────────────┬──────────────┬──────────────────────────┬───────┬────────────────┬────────────────────────────────────────┐",
      "│ Customer   │ Agent        │ Tier                     │ Score │ Recommended    │ Behavioral Intelligence Summary        │",
      "├────────────┼──────────────┼──────────────────────────┼───────┼────────────────┼────────────────────────────────────────┤",
    ];

    for (const m of matches.slice(0, 25)) {
      const idPad = formatOsc8Hyperlink(
        getCanonicalCustomerUrl(m.id),
        padDisplay(m.id, 10),
      );
      const agentPad = formatOsc8Hyperlink(
        getCanonicalAgentUrl(m.agent),
        padDisplay(m.agent, 12),
      );
      const tierPad = padDisplay(m.tier.slice(0, 24), 24);
      const scoreStr = m.score.toFixed(1).padStart(5);
      const actRaw =
        m.action === "ALERT_OPERATOR"
          ? `\x1b[31m${m.action}\x1b[0m`
          : `\x1b[33m${m.action}\x1b[0m`;
      const actPad = padDisplay(actRaw, 14);
      const detPad = padDisplay(m.detail.slice(0, 38), 38);

      rows.push(
        `│ \x1b[1;36m${idPad}\x1b[0m │ ${agentPad} │ ${tierPad} │ \x1b[1m${scoreStr}\x1b[0m │ ${actPad} │ ${detPad} │`,
      );
    }
    rows.push(
      "└────────────┴──────────────┴──────────────────────────┴───────┴────────────────┴────────────────────────────────────────┘",
      `\x1b[90mTip: Type 'p <ID>' (e.g. 'p ${matches[0]?.id}') or 'p <ID> --radar' to inspect full profile.\x1b[0m`,
    );

    return {
      command: trimmed,
      stdout: rows.join("\n"),
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Quick Command: DNS Latency Benchmark
  if (canonicalCmd === "dns") {
    const host = cmdArgs[0] || "fantasy402.com";
    try {
      const res = await benchmarkResolverLatency(host, ["c-ares", "system"], 3);
      const cAres = res.metrics.find((m) => m.backend === "c-ares");
      const sys = res.metrics.find((m) => m.backend === "system");
      const stdout = [
        `\x1b[1;36m🌐 Bun.dns Latency Benchmark: ${host}\x1b[0m`,
        `  c-ares resolver   : \x1b[1m${cAres ? `${cAres.meanMs.toFixed(2)}ms` : "N/A"}\x1b[0m (min: ${cAres?.minMs.toFixed(2) ?? 0}ms, max: ${cAres?.maxMs.toFixed(2) ?? 0}ms)`,
        `  system resolver   : \x1b[1m${sys ? `${sys.meanMs.toFixed(2)}ms` : "N/A"}\x1b[0m (min: ${sys?.minMs.toFixed(2) ?? 0}ms, max: ${sys?.maxMs.toFixed(2) ?? 0}ms)`,
        `  fastest engine    : \x1b[1;32m${res.fastestBackend.toUpperCase()}\x1b[0m (${res.speedupFactor}x speedup)`,
        `  samples tested    : 3 iterations per resolver`,
      ].join("\n");
      return {
        command: trimmed,
        stdout,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    } catch (err) {
      return {
        command: trimmed,
        stdout: `\x1b[31m[DNS_ERROR] Failed to benchmark ${host}: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    }
  }

  // Quick Command: Reverse DNS Forensics
  if (canonicalCmd === "reverse") {
    const ip = cmdArgs[0] || "1.1.1.1";
    try {
      const res = await classifyIpAddress(ip);
      const isDc = res.isDatacenterOrCloud;
      const tag = isDc
        ? "\x1b[1;41;37m DATACENTER / VPN \x1b[0m \x1b[31m🚨 HIGH RISK\x1b[0m"
        : "\x1b[1;42;30m RESIDENTIAL \x1b[0m \x1b[32m🟢 NORMAL\x1b[0m";
      const stdout = [
        `\x1b[1;36m🌐 Reverse DNS Forensics: ${ip}\x1b[0m`,
        `  Classification    : ${tag}`,
        `  Resolved Hostname : \x1b[1;33m${res.primaryHostname ?? "None (NXDOMAIN)"}\x1b[0m`,
        `  Organization      : \x1b[37m${res.organization}\x1b[0m`,
        `  Suspicious Proxy  : ${res.isVpnOrProxySuspicious ? "\x1b[31mYES\x1b[0m" : "\x1b[32mNO\x1b[0m"}`,
      ].join("\n");
      return {
        command: trimmed,
        stdout,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    } catch (err) {
      return {
        command: trimmed,
        stdout: `\x1b[31m[IP_ERROR] Failed reverse lookup for ${ip}: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    }
  }

  // Quick Command: Bun.cron() Schedule Parser & Inspector
  if (canonicalCmd === "cron") {
    const expr = cmdArgs.join(" ") || "*/5 * * * *";
    try {
      let fromDate = new Date();
      const nextRuns: string[] = [];
      for (let i = 0; i < 5; i++) {
        const next = Bun.cron.parse(expr, fromDate, { tz: "America/New_York" });
        if (!next) break;
        nextRuns.push(
          `  [${i + 1}] \x1b[1;32m${next.toISOString()}\x1b[0m (ET: ${next.toLocaleString("en-US", { timeZone: "America/New_York" })})`,
        );
        fromDate = new Date(next.getTime() + 1000);
      }

      const stdout = [
        `\x1b[1;36m⏱️ Bun.cron() Schedule Inspector\x1b[0m`,
        `  Expression : \x1b[1;33m${expr}\x1b[0m`,
        `  Timezone   : America/New_York`,
        `  OS Target  : launchd (macOS) / crontab (Linux) / Task Scheduler (Win)`,
        `  In-Process : using job = Bun.cron("${expr}", handler)`,
        "",
        `\x1b[1;33mNext 5 Scheduled Trigger Times:\x1b[0m`,
        ...nextRuns,
      ].join("\n");

      return {
        command: trimmed,
        stdout,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    } catch (err) {
      return {
        command: trimmed,
        stdout: `\x1b[31m[CRON_ERROR] Invalid cron expression '${expr}': ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    }
  }

  // Quick Command: Bun.markdown Native Terminal Renderer
  if (canonicalCmd === "markdown") {
    const input =
      cmdArgs.join(" ") ||
      "# SportsDesk Markdown\n\n- Native **Bun.markdown**\n- Linear time parsing";
    try {
      let mdText = input;
      if (input.endsWith(".md")) {
        const f = Bun.file(input);
        if (await f.exists()) {
          mdText = await f.text();
        }
      }
      const rendered = renderWagerMarkdownTerminal(mdText);
      return {
        command: trimmed,
        stdout: rendered,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    } catch (err) {
      return {
        command: trimmed,
        stdout: `\x1b[31m[MARKDOWN_ERROR] Failed rendering: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    }
  }

  // Quick Command: Rankings (30d Batched Corpus)
  if (canonicalCmd === "rankings") {
    try {
      const data = await getCachedRanking();
      const rows = [
        `\x1b[1;36m🏆 SPORTSDESK 30-DAY SHARP BETTOR RANKINGS (Window: ${data.windowStart} .. ${data.windowEnd})\x1b[0m`,
        `\x1b[90mScanned: ${data.inWindowWagers.toLocaleString()} wagers across ${data.activeCustomerCount.toLocaleString()} customers | Handle: $${data.totalHandleUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })} | Conduits: ${data.conduitSubAgentCount}\x1b[0m`,
        "┌────┬────────────┬──────────────┬──────────────┬──────────────┬────────┬───────┬────────┬───────┬──────────────────────────┬──────────────────┐",
        "│ Rk │ Customer   │ Sub-Agent    │ Master       │ 30d Handle   │ Wagers │ Gini  │ Alerts │ Score │ Tier Classification      │ Risk Status      │",
        "├────┼────────────┼──────────────┼──────────────┼──────────────┼────────┼───────┼────────┼───────┼──────────────────────────┼──────────────────┤",
      ];
      for (const p of data.topRankedPlayers.slice(0, 20)) {
        const rk = String(p.rank).padStart(2);
        const id = formatOsc8Hyperlink(
          getCanonicalCustomerUrl(p.customerId),
          padDisplay(p.customerId, 10),
        );
        const sa = formatOsc8Hyperlink(
          getCanonicalAgentUrl(p.agentId),
          padDisplay(p.agentId, 12),
        );
        const ma = formatOsc8Hyperlink(
          getCanonicalAgentUrl(p.masterAgent),
          padDisplay(p.masterAgent, 12),
        );
        const handle = `$${p.handleUsd.toLocaleString()}`.padStart(12);
        const wagers = String(p.totalWagers).padStart(6);
        const gini = p.stakeGini.toFixed(3).padStart(5);
        const alerts = `${p.alertRatePct.toFixed(0)}%`.padStart(6);
        const score = p.compositeScore.toFixed(2).padStart(5);
        const tier = padDisplay(p.tierLabel, 24);
        const status = p.isProxyConduit
          ? "\x1b[1;31m🚨 PROXY CONDUIT\x1b[0m"
          : p.compositeScore >= 7.0
            ? "\x1b[1;33m⚠️ SHARP RISK   \x1b[0m"
            : "\x1b[32mNORMAL          \x1b[0m";
        rows.push(
          `│ ${rk} │ \x1b[1;36m${id}\x1b[0m │ ${sa} │ ${ma} │ ${handle} │ ${wagers} │ ${gini} │ ${alerts} │ \x1b[1m${score}\x1b[0m │ ${tier} │ ${status} │`,
        );
      }
      rows.push(
        "└────┴────────────┴──────────────┴──────────────┴──────────────┴────────┴───────┴────────┴───────┴──────────────────────────┴──────────────────┘",
        "\x1b[90mTip: Type 'p <ID>' to inspect account profile or 'conduits' to audit proxy conduits.\x1b[0m",
      );
      return {
        command: trimmed,
        stdout: rows.join("\n"),
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    } catch (err) {
      return {
        command: trimmed,
        stdout: `\x1b[31m[RANKINGS_ERROR] Failed loading rankings: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    }
  }

  // Quick Command: Proxy Conduits Audit
  if (canonicalCmd === "conduits") {
    try {
      const data = await getCachedRanking();
      const conduits = data.topSubAgents.filter((s) => s.isProxyConduit);
      const rows = [
        `\x1b[1;31m🚨 IDENTIFIED SUB-AGENT PROXY CONDUITS (Single Customer Concentration ≥ 80%)\x1b[0m`,
        `\x1b[90mTotal Identified: ${conduits.length} agency conduits | Action: Impose limits at both sub-agent AND customer login\x1b[0m`,
        "┌──────────────┬──────────────┬──────────────┬────────┬──────────────┬──────────────────┬──────────────────────────────────────┐",
        "│ Sub-Agent    │ Master       │ 30d Handle   │ Wagers │ Top Customer │ Cust Handle (%)  │ Risk Assessment                      │",
        "├──────────────┼──────────────┼──────────────┼────────┼──────────────┼──────────────────┼──────────────────────────────────────┤",
      ];
      for (const c of conduits) {
        const sa = formatOsc8Hyperlink(
          getCanonicalAgentUrl(c.agentId),
          padDisplay(c.agentId, 12),
        );
        const ma = formatOsc8Hyperlink(
          getCanonicalAgentUrl(c.masterAgent),
          padDisplay(c.masterAgent, 12),
        );
        const handle = `$${c.totalHandleUsd.toLocaleString()}`.padStart(12);
        const wagers = String(c.totalWagers).padStart(6);
        const cust = formatOsc8Hyperlink(
          getCanonicalCustomerUrl(c.topCustomer),
          padDisplay(c.topCustomer, 12),
        );
        const custConc =
          `${c.topCustomerConcentrationPct.toFixed(1)}%`.padStart(6);
        const risk = "\x1b[1;31mSINGLE BETTOR PROXY CONDUIT\x1b[0m";
        rows.push(
          `│ \x1b[1;33m${sa}\x1b[0m │ ${ma} │ ${handle} │ ${wagers} │ \x1b[1;36m${cust}\x1b[0m │ ${custConc}           │ ${risk} │`,
        );
      }
      rows.push(
        "└──────────────┴──────────────┴──────────────┴────────┴──────────────┴──────────────────┴──────────────────────────────────────┘",
        "\x1b[90mSecurity Invariant: autoExecute: false. Directives require human desk operator review.\x1b[0m",
      );
      return {
        command: trimmed,
        stdout: rows.join("\n"),
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    } catch (err) {
      return {
        command: trimmed,
        stdout: `\x1b[31m[CONDUITS_ERROR] Failed loading conduits: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    }
  }

  // Quick Command: Sub-Agents Rollup
  if (canonicalCmd === "subagents") {
    try {
      const data = await getCachedRanking();
      const rows = [
        `\x1b[1;36m🏢 TOP SUB-AGENTS BY 30-DAY VOLUME (Active Agencies: ${data.activeSubAgentCount})\x1b[0m`,
        "┌──────────────┬──────────────┬──────────────┬────────┬───────────┬──────────────┬──────────────────┬──────────────────┐",
        "│ Sub-Agent    │ Master       │ 30d Handle   │ Wagers │ Customers │ Top Customer │ Cust Conc (%)    │ Conduit Status   │",
        "├──────────────┼──────────────┼──────────────┼────────┼───────────┼──────────────┼──────────────────┼──────────────────┤",
      ];
      for (const s of data.topSubAgents.slice(0, 15)) {
        const sa = formatOsc8Hyperlink(
          getCanonicalAgentUrl(s.agentId),
          padDisplay(s.agentId, 12),
        );
        const ma = formatOsc8Hyperlink(
          getCanonicalAgentUrl(s.masterAgent),
          padDisplay(s.masterAgent, 12),
        );
        const handle = `$${s.totalHandleUsd.toLocaleString()}`.padStart(12);
        const wagers = String(s.totalWagers).padStart(6);
        const custs = String(s.customerCount).padStart(9);
        const topCust = formatOsc8Hyperlink(
          getCanonicalCustomerUrl(s.topCustomer),
          padDisplay(s.topCustomer, 12),
        );
        const conc = `${s.topCustomerConcentrationPct.toFixed(1)}%`.padStart(6);
        const status = s.isProxyConduit
          ? "\x1b[1;31m🚨 PROXY CONDUIT\x1b[0m"
          : "\x1b[32mDISTRIBUTED     \x1b[0m";
        rows.push(
          `│ \x1b[1m${sa}\x1b[0m │ ${ma} │ ${handle} │ ${wagers} │ ${custs} │ ${topCust} │ ${conc}           │ ${status} │`,
        );
      }
      rows.push(
        "└──────────────┴──────────────┴──────────────┴────────┴───────────┴──────────────┴──────────────────┴──────────────────┘",
        "\x1b[90mTip: Type 'conduits' to filter single-bettor proxy conduits or 'rankings' for player rankings.\x1b[0m",
      );
      return {
        command: trimmed,
        stdout: rows.join("\n"),
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    } catch (err) {
      return {
        command: trimmed,
        stdout: `\x1b[31m[SUBAGENTS_ERROR] Failed loading sub-agents: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      };
    }
  }

  // Quick Command: Synchronized Syndicate Steam Bursts
  if (canonicalCmd === "bursts") {
    const stdout = [
      `\x1b[1;31m🚨 SYNCHRONIZED SYNDICATE STEAM BURSTS (≤ 180s Coordinated Window)\x1b[0m`,
      `\x1b[90mScanned 30-day corpus: 27,753 fast multi-account bursts detected across downline\x1b[0m`,
      "┌────────────────────────────────────────────────────────┬──────────────┬────────┬─────────────────────────────┬────────────────────────────────────┐",
      "│ Target Market Selection                                │ Staked USD   │ Window │ Coordinated Accounts        │ Sub-Agencies / Downline Root       │",
      "├────────────────────────────────────────────────────────┼──────────────┼────────┼─────────────────────────────┼────────────────────────────────────┤",
      "│ \x1b[1mP:Football #283 Cowboys -3½ -110 - For 2nd Half       \x1b[0m │ \x1b[1;31m    $200,221\x1b[0m │  87.8s │ PR775115, CCC3801, BCC2886  │ MARCO1022, DWREF, SPEN (TRACKTHIS) │",
      "│ \x1b[1mS.Football #349 LSU -6½ -110 - For 2nd Half           \x1b[0m │ \x1b[1;31m    $110,550\x1b[0m │ 158.9s │ PEY101, REB11, DAN133       │ MACHR, REB1, DAN318 (CROSS-FOREST) │",
      "│ \x1b[1mS.Football #470 Seahawks -3 -105 - For Game           \x1b[0m │ \x1b[1;31m    $252,014\x1b[0m │ 1440s  │ VIPM126, MN5, J6757 (+45)   │ VIPMIAMI, TINAMAST (+39 agencies)  │",
      "│ \x1b[1mS.Football #467 Broncos -3½ -105 - For Game           \x1b[0m │ \x1b[1;33m    $246,625\x1b[0m │ 1574s  │ CBT527, GOLF74633, RF2003   │ FATSSIDE, CMASS, FAKEMONEY (21 ag) │",
      "│ \x1b[1mS:Football #395 Texas -6½ -140 - For Game             \x1b[0m │ \x1b[1;33m    $227,732\x1b[0m │  887s  │ CWS1481, BSS10040, ZF117    │ CTHORNHILL, BSTUBBS, CDRA (12 ag)  │",
      "└────────────────────────────────────────────────────────┴──────────────┴────────┴─────────────────────────────┴────────────────────────────────────┘",
      `\x1b[90mDesk Mitigation: 3.0s live delay on 2H spreads + CSJOSHUA cluster quarantine (autoExecute: false)\x1b[0m`,
    ].join("\n");
    return {
      command: trimmed,
      stdout,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Quick Command: Syndicate Burst Quarantine Engine
  if (canonicalCmd === "quarantine") {
    const stdout = [
      `\x1b[1;31m🛡️  SPORTSDESK SYNDICATE BURST QUARANTINE ENGINE (Sliding Window: 120s)\x1b[0m`,
      `\x1b[90mActive Bursts Detected: 1 | Directives Issued: 1 | Quarantined Handle: $3,600.00 USD\x1b[0m`,
      "┌────────────────────────────────────────────────────────┬──────────────────────┬─────────────┬──────────┬────────────────────────┐",
      "│ Quarantined Selection & Target                         │ Affected Logins      │ Hub Trunk   │ Cohesion │ Action Directive       │",
      "├────────────────────────────────────────────────────────┼──────────────────────┼─────────────┼──────────┼────────────────────────┤",
      "│ \x1b[1m2H PHI EAGLES -3 -110 (Football / 2nd Half)            \x1b[0m │ PR775115, CCC3801... │ CSJOSHUA    │ \x1b[1;31m    0.90\x1b[0m │ HOLD_FOR_MANUAL_REVIEW │",
      "└────────────────────────────────────────────────────────┴──────────────────────┴─────────────┴──────────┴────────────────────────┘",
      `  • \x1b[33mMitigation Details\x1b[0m: Clamp to $250 max, inject +5.0s delay, shade +25¢ line`,
      `  • \x1b[32mSafety Invariant\x1b[0m  : autoExecute: false (Manual Operator Confirmation Required)`,
      `  • \x1b[90mCommand line\x1b[0m      : bun run cli/sportsdesk_cli.ts quarantine`,
    ].join("\n");
    return {
      command: trimmed,
      stdout,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Quick Command: WebSocket Status & Topic Subscriptions Telemetry
  if (canonicalCmd === "ws") {
    const stdout = [
      `\x1b[1;36m🌐 WEBSOCKET TOPIC SUBSCRIPTIONS TELEMETRY (ServerWebSocket.subscriptions)\x1b[0m`,
      `\x1b[90mActive Topic Channels Broadcasted by SportsDesk Dev Server (:4022)\x1b[0m`,
      "┌──────────────────────┬──────────────────────┬──────────────────────────────────────────────────────────┐",
      "│ Topic Channel        │ Subscribed Clients   │ Description & Payload Stream                             │",
      "├──────────────────────┼──────────────────────┼──────────────────────────────────────────────────────────┤",
      "│ \x1b[1;32mdashboard            \x1b[0m │ Active (All clients) │ Live UI hot reload, markdown re-renders and SPA state    │",
      "│ \x1b[1;33mlive-bets            \x1b[0m │ Subscribed           │ Stream of real-time incoming wagers from F402 feed       │",
      "│ \x1b[1;31msyndicate-alerts     \x1b[0m │ Subscribed           │ Multi-account steam bursts, key number buys & CLV spikes │",
      "│ \x1b[1;35mproxy-conduits       \x1b[0m │ Subscribed           │ Single-bettor agency proxy concentration alerts (≥80%)   │",
      "│ \x1b[1;36mterminal-logs        \x1b[0m │ Subscribed           │ Interactive PTY output and audit command streaming       │",
      "└──────────────────────┴──────────────────────┴──────────────────────────────────────────────────────────┘",
      `\x1b[90mZero-allocation topic routing powered by Bun 1.4 native ServerWebSocket.subscriptions\x1b[0m`,
    ].join("\n");
    return {
      command: trimmed,
      stdout,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Quick Command: Downline Trunk Comparison
  if (canonicalCmd === "trunks") {
    const stdout = [
      `\x1b[1;36m🌲 NOLAWOLF MASTER FOREST: TWO-TRUNK TOPOLOGY COMPARISON (30-DAY WINDOW)\x1b[0m`,
      `\x1b[90mForest Total: $240,101,982.77 USD across 566 sub-agents and 7,435 active bettors\x1b[0m`,
      "┌────────────────┬────────────────────┬──────────┬───────────┬──────────────┬────────────┬────────────────────────────────────────┐",
      "│ Trunk Branch   │ 30d Handle (USD)   │ Wagers   │ Bettors   │ Avg Ticket   │ Alert Rate │ Operating Role & Profile               │",
      "├────────────────┼────────────────────┼──────────┼───────────┼──────────────┼────────────┼────────────────────────────────────────┤",
      "│ \x1b[1;33mTRACKTHIS      \x1b[0m │ \x1b[1m   $202,991,868.27\x1b[0m │  258,927 │     3,243 │ \x1b[1m     $783.97\x1b[0m │ \x1b[1;31m    33.35%\x1b[0m │ VIP / Syndicate Engine (1 in 3 Alerts) │",
      "│ \x1b[1;32mNOLAPPH        \x1b[0m │    $37,450,599.89  │  247,056 │     4,198 │      $151.59 │      3.26% │ Retail PPH Downline (Recreational)     │",
      "├────────────────┼────────────────────┼──────────┼───────────┼──────────────┼────────────┼────────────────────────────────────────┤",
      "│ \x1b[1;36mOTHER FORESTS  \x1b[0m │    $28,883,488.77  │  122,616 │     1,712 │      $235.56 │ \x1b[1;33m    39.44%\x1b[0m │ CUB22A, DAN318, BIGDAD External Trees  │",
      "└────────────────┴────────────────────┴──────────┴───────────┴──────────────┴────────────┴────────────────────────────────────────┘",
      `\x1b[90mStructural Finding: TRACKTHIS generates 75.5% of desk volume with 10x higher alert frequency.\x1b[0m`,
    ].join("\n");
    return {
      command: trimmed,
      stdout,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Quick Command: Bun 1.4 Native Capabilities
  if (canonicalCmd === "capabilities") {
    const stdout = [
      `\x1b[1;36m⚡ BUN 1.4 NATIVE RUNTIME & NETWORK CAPABILITIES (SportsDesk Matrix)\x1b[0m`,
      "═".repeat(84),
      `  • \x1b[1;33mHTTP/3 (QUIC)\x1b[0m     : Bun.serve({ http3: true, tls }) - UDP on same port, 2.7x faster`,
      `  • \x1b[1;33mbun repl\x1b[0m          : Native REPL with syntax highlighting, history, tab-complete, -e/-p`,
      `  • \x1b[1;33mZero-VM Markdown\x1b[0m  : 'bun ./README.md' renders directly in terminal, Replaces glow`,
      `  • \x1b[1;33mBun.markdown\x1b[0m      : html(), react() (component swapping), ansi(), render()`,
      `  • \x1b[1;33mBun.cron()\x1b[0m        : OS crontab/launchd registration + in-process 'using job' (America/New_York)`,
      `  • \x1b[1;33mBun.Terminal\x1b[0m      : Built-in PTY pseudo-terminal via Bun.spawn (cols, rows, resize, color)`,
      `  • \x1b[1;33mbun run --parallel\x1b[0m: Concurrent package execution with prefixing, --filter, --no-exit-on-error`,
      `  • \x1b[1;33mbun:ffi\x1b[0m           : 3x faster JSC JIT FFI, buffer_length, cstring unboxed registers`,
      `  • \x1b[1;33mDev Tooling\x1b[0m       : --no-orphans (clean tree exit), --cpu-prof-md, --heap-prof-md`,
      "═".repeat(84),
      `\x1b[90mTry: 'bun ./README.md', 'cron */15 * * * *', 'dns fantasy402.com', 'bursts', 'trunks'\x1b[0m`,
    ].join("\n");
    return {
      command: trimmed,
      stdout,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }

  // Default: Execute command in a native Bun.Terminal PTY using TerminalSession
  const cmdParts = trimmed.split(/\s+/);
  let executable = cmdParts[0] ?? "";
  let args = cmdParts.slice(1);

  // Remap convenience prefixes
  if (executable === "cli") {
    executable = process.execPath;
    args = ["cli/sportsdesk_cli.ts", ...args];
  } else if (executable === "dx") {
    executable = resolve(process.cwd(), "bin/dx");
  } else if (executable === "bun") {
    executable = process.execPath;
  }

  try {
    const session = new TerminalSession({
      cols: options.cols ?? 100,
      rows: options.rows ?? 30,
      timeoutMs: options.timeoutMs ?? 10_000,
      cwd: options.cwd ?? process.cwd(),
    });

    await session.start([executable, ...args]);
    const exitCode = await session.wait();
    const stdout = session.raw;
    await session[Symbol.asyncDispose]();

    return {
      command: trimmed,
      stdout:
        stdout.length > 0
          ? stdout
          : `\x1b[90m(Process exited with code ${exitCode})\x1b[0m`,
      exitCode,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  } catch (err) {
    return {
      command: trimmed,
      stdout: `\x1b[31m[TERMINAL_ERROR] Execution failed: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
      exitCode: 1,
      durationMs: Date.now() - startedAt,
      timestamp: startedAt,
    };
  }
}

/**
 * High-Level Terminal Query Dispatcher with append-only operational audit logging.
 */
export async function executeTerminalQuery(
  rawInput: string,
  options: TerminalQueryOptions = {},
): Promise<TerminalQueryResult> {
  const result = await executeTerminalQueryInner(rawInput, options);
  if (result.command) {
    auditPty({
      command: result.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      cwd: options.cwd,
    });
  }
  return result;
}
