import React, { useEffect, useState, useRef, useMemo } from "react";
import "./desk.css";
import { renderAnsiReact } from "./ansi.tsx";
import { ShadowPricingPanel } from "./ShadowPricingPanel.tsx";
import {
  debugDashboardTrace,
  getDashboardRuntimeFlags,
} from "./runtime_flags.ts";
import { type WagerTier, wagerBadge } from "../../lib/wager_tokens.ts";

export interface DashboardData {
  readonly markdown: string;
  readonly html: string;
  readonly updatedAt: string;
}

export interface DnsData {
  readonly success?: boolean;
  readonly telemetry: {
    readonly size: number;
    readonly hitRatePercent: number;
    readonly cacheHitsCompleted: number;
    readonly cacheHitsInflight: number;
    readonly cacheMisses: number;
    readonly defaultTtlSeconds: number;
  };
  readonly hosts?: readonly {
    readonly hostname: string;
    readonly serviceName?: string;
  }[];
  readonly coreHosts?: readonly {
    readonly hostname: string;
    readonly port?: number;
    readonly serviceName?: string;
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
    id: "CCC88412",
    name: "Fatsnobot Syndicate Originator",
    agentId: "FATSNOBOT",
    masterAgent: "NOLAWOLF",
    tier: "TIER_1_ELITE_ORIGINATOR",
    score: 9.4,
    clvScore: 2.9,
    skillScore: 2.4,
    sizingScore: 1.4,
    sigScore: 2.0,
    timingScore: 0.7,
    sizingStrategy: "PROPORTIONAL_KELLY",
    gini: 0.236,
    meanStake: 5250,
    specialization: "NFL SPREAD (Key Number 3 / +11.5¢)",
    timingArchetype: "EARLY_OPENER_SNIPER",
    correlatedRisk: "CRITICAL",
    correlatedExploitRate: 0.58,
    syndicateRisk: "HIGH",
    syndicateProb: 0.95,
    subAccountIndex: null,
    var95Usd: 17200,
    cvar95Usd: 21500,
    holdPct: -7.8,
    ltvUsd: -41000,
    recommendedLimitUsd: 250,
    inPlayDelaySec: 3,
    lineShadeCents: 20,
    shadowCopyMultiplier: 1.0,
    action: "ALERT_OPERATOR",
    ipAddress: "104.244.72.15", // Datacenter / ASN 54113 Fastly
  },
  {
    id: "MJ107",
    name: "MJ Syndicate Lead",
    agentId: "MJ2026",
    masterAgent: "NOLAWOLF",
    tier: "TIER_1_ELITE_ORIGINATOR",
    score: 9.2,
    clvScore: 2.8,
    skillScore: 2.3,
    sizingScore: 1.5,
    sigScore: 1.9,
    timingScore: 0.7,
    sizingStrategy: "FLAT_UNIT",
    gini: 0.031,
    meanStake: 4600,
    specialization: "CFB SPREAD (Line Mover)",
    timingArchetype: "STEAM_CHASER",
    correlatedRisk: "HIGH",
    correlatedExploitRate: 0.52,
    syndicateRisk: "HIGH",
    syndicateProb: 0.88,
    subAccountIndex: null,
    var95Usd: 15800,
    cvar95Usd: 19600,
    holdPct: -6.9,
    ltvUsd: -36500,
    recommendedLimitUsd: 250,
    inPlayDelaySec: 3,
    lineShadeCents: 20,
    shadowCopyMultiplier: 1.0,
    action: "ALERT_OPERATOR",
    ipAddress: "64.225.80.12", // DigitalOcean
  },
  {
    id: "BRT5235",
    name: "Barrett Hook Syndicate Seat 5",
    agentId: "AG_SHARP",
    masterAgent: "MASTER_SYNDICATE",
    tier: "TIER_1_ELITE_ORIGINATOR",
    score: 9.05,
    clvScore: 2.8,
    skillScore: 2.2,
    sizingScore: 1.3,
    sigScore: 1.95,
    timingScore: 0.8,
    sizingStrategy: "PROPORTIONAL_KELLY",
    gini: 0.165,
    meanStake: 3300,
    specialization: "NCAAB 2H (Hook Syndicate)",
    timingArchetype: "STEAM_CHASER",
    correlatedRisk: "CRITICAL",
    correlatedExploitRate: 0.62,
    syndicateRisk: "HIGH",
    syndicateProb: 0.92,
    subAccountIndex: 5,
    var95Usd: 13500,
    cvar95Usd: 16900,
    holdPct: -6.5,
    ltvUsd: -29000,
    recommendedLimitUsd: 250,
    inPlayDelaySec: 3,
    lineShadeCents: 20,
    shadowCopyMultiplier: 1.0,
    action: "ALERT_OPERATOR",
    ipAddress: "54.210.88.94", // AWS
  },
  {
    id: "BGD101",
    name: "BigDad Hook Syndicate Lead",
    agentId: "BIGDAD",
    masterAgent: "BIGDAD",
    tier: "TIER_2_STEAM_SYNDICATE",
    score: 8.7,
    clvScore: 2.7,
    skillScore: 2.1,
    sizingScore: 1.4,
    sigScore: 1.7,
    timingScore: 0.8,
    sizingStrategy: "FLAT_UNIT",
    gini: 0.022,
    meanStake: 2200,
    specialization: "NFL / CFB (Key Number 3 / Hook)",
    timingArchetype: "STEAM_CHASER",
    correlatedRisk: "HIGH",
    correlatedExploitRate: 0.48,
    syndicateRisk: "HIGH",
    syndicateProb: 0.82,
    subAccountIndex: null,
    var95Usd: 9800,
    cvar95Usd: 12400,
    holdPct: -5.4,
    ltvUsd: -22000,
    recommendedLimitUsd: 500,
    inPlayDelaySec: 3,
    lineShadeCents: 15,
    shadowCopyMultiplier: 0.75,
    action: "ALERT_OPERATOR",
    ipAddress: "198.51.100.42", // Datacenter / ASN 16509 AWS
  },
  {
    id: "BAR301",
    name: "Barrett Early Opener Sweeper",
    agentId: "BAR01",
    masterAgent: "MASTER_SYNDICATE",
    tier: "TIER_2_STEAM_SYNDICATE",
    score: 8.5,
    clvScore: 2.6,
    skillScore: 2.1,
    sizingScore: 1.2,
    sigScore: 1.8,
    timingScore: 0.8,
    sizingStrategy: "FLAT_UNIT",
    gini: 0.08,
    meanStake: 3300,
    specialization: "NFL SPREAD (Sunday Night Early)",
    timingArchetype: "EARLY_OPENER_SNIPER",
    correlatedRisk: "HIGH",
    correlatedExploitRate: 0.44,
    syndicateRisk: "ELEVATED",
    syndicateProb: 0.65,
    subAccountIndex: null,
    var95Usd: 8800,
    cvar95Usd: 11200,
    holdPct: -4.9,
    ltvUsd: -19500,
    recommendedLimitUsd: 500,
    inPlayDelaySec: 3,
    lineShadeCents: 15,
    shadowCopyMultiplier: 0.75,
    action: "ALERT_OPERATOR",
    ipAddress: "142.93.18.5", // DigitalOcean
  },
  {
    id: "KENT99",
    name: "Kent Halftime Latency Runner",
    agentId: "KENT02",
    masterAgent: "MASTER_B",
    tier: "TIER_2_STEAM_SYNDICATE",
    score: 8.1,
    clvScore: 2.4,
    skillScore: 2.1,
    sizingScore: 1.2,
    sigScore: 1.6,
    timingScore: 0.8,
    sizingStrategy: "VARIABLE_STAKE",
    gini: 0.19,
    meanStake: 2200,
    specialization: "NBA / CFB 2H TOTALS",
    timingArchetype: "HALFTIME_SPECIALIST",
    correlatedRisk: "MODERATE",
    correlatedExploitRate: 0.35,
    syndicateRisk: "ELEVATED",
    syndicateProb: 0.55,
    subAccountIndex: null,
    var95Usd: 6500,
    cvar95Usd: 8200,
    holdPct: -4.1,
    ltvUsd: -14000,
    recommendedLimitUsd: 500,
    inPlayDelaySec: 3,
    lineShadeCents: 15,
    shadowCopyMultiplier: 0.75,
    action: "ALERT_OPERATOR",
    ipAddress: "167.99.145.22", // DigitalOcean
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
  "CCC88412",
  "MJ107",
  "BRT5235",
  "BRT5229",
  "BRT5229_0",
  "BRT5229_1",
  "BGD101",
  "BAR301",
  "ST100",
  "KENT99",
  "LIVE99",
  "BK119",
  "RF2003",
  "SQUARE1",
  "B121",
  "AX39",
  "BNN320",
  "MJ109",
  "DAN900",
  "LLB105",
  "CUB109",
  "VIPM126",
  "PEY101",
  "GL205",
  "ABC700",
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
  {
    agentId: "AG_SHARP",
    masterAgent: "MASTER_SYNDICATE",
    handleUsd: 18420000,
    wagers: 3421,
    topCust: "BRT5229",
    concPct: 72.4,
  },
  {
    agentId: "MJ2026",
    masterAgent: "NOLAWOLF",
    handleUsd: 5185750,
    wagers: 308,
    topCust: "MJ107",
    concPct: 75.3,
  },
  {
    agentId: "AG99",
    masterAgent: "MASTER_VEND",
    handleUsd: 2140000,
    wagers: 312,
    topCust: "GP301",
    concPct: 84.2,
  },
  {
    agentId: "BIGDAD",
    masterAgent: "BIGDAD",
    handleUsd: 1061600,
    wagers: 50,
    topCust: "BGD101",
    concPct: 100.0,
  },
];

export interface LiveWager {
  readonly ticketId: string;
  readonly timestamp: string;
  readonly customerId: string;
  readonly agentId: string;
  readonly masterAgent: string;
  readonly sport: "NFL" | "CFB" | "NBA" | "NCAAB" | "SOCCER";
  readonly betType: "Spread" | "Total" | "Moneyline" | "Parlay";
  readonly event: string;
  readonly selection: string;
  readonly lineDisplay: string;
  readonly oddsAmerican: string;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  readonly clvCents: number;
  readonly alertTier: WagerTier;
  readonly alertBadge: string;
  readonly operatorDirective: string;
  readonly maxRecommendedStake: number;
  readonly autoExecute: false;
}

const SAMPLE_LIVE_WAGERS: LiveWager[] = [
  {
    ticketId: "W-109281",
    timestamp: "14:32:01 ET",
    customerId: "GP301",
    agentId: "AG99",
    masterAgent: "MASTER_VEND",
    sport: "NFL",
    betType: "Total",
    event: "Kansas City Chiefs @ Buffalo Bills",
    selection: "Under",
    lineDisplay: "47½",
    oddsAmerican: "-110",
    riskUsd: 5500,
    toWinUsd: 5000,
    clvCents: 14.2,
    alertTier: "CRITICAL",
    alertBadge: "🚨 CRITICAL (T1 Originator)",
    operatorDirective: "Clamp Max $250 (autoExecute: false)",
    maxRecommendedStake: 250,
    autoExecute: false,
  },
  {
    ticketId: "W-109282",
    timestamp: "14:32:15 ET",
    customerId: "CCC88412",
    agentId: "FATSNOBOT",
    masterAgent: "NOLAWOLF",
    sport: "CFB",
    betType: "Spread",
    event: "Georgia @ Texas",
    selection: "Texas",
    lineDisplay: "+3½",
    oddsAmerican: "-105",
    riskUsd: 5250,
    toWinUsd: 5000,
    clvCents: 11.5,
    alertTier: "STEAM",
    alertBadge: "🚨 STEAM (Key Number 3)",
    operatorDirective: "Clamp Max $250 (autoExecute: false)",
    maxRecommendedStake: 250,
    autoExecute: false,
  },
  {
    ticketId: "W-109283",
    timestamp: "14:32:44 ET",
    customerId: "BRT5235",
    agentId: "AG_SHARP",
    masterAgent: "MASTER_SYNDICATE",
    sport: "CFB",
    betType: "Spread",
    event: "Duke @ North Carolina",
    selection: "North Carolina",
    lineDisplay: "+7½",
    oddsAmerican: "-110",
    riskUsd: 3300,
    toWinUsd: 3000,
    clvCents: 9.8,
    alertTier: "STEAM",
    alertBadge: "🚨 STEAM (Hook Syndicate)",
    operatorDirective: "Clamp Max $250 (autoExecute: false)",
    maxRecommendedStake: 250,
    autoExecute: false,
  },
  {
    ticketId: "W-109284",
    timestamp: "14:33:02 ET",
    customerId: "MJ107",
    agentId: "MJ2026",
    masterAgent: "NOLAWOLF",
    sport: "CFB",
    betType: "Spread",
    event: "Ohio State @ Penn State",
    selection: "Ohio State",
    lineDisplay: "-3½",
    oddsAmerican: "-115",
    riskUsd: 4600,
    toWinUsd: 4000,
    clvCents: 8.4,
    alertTier: "STEAM",
    alertBadge: "⚡ STEAM (Line Mover)",
    operatorDirective: "Clamp Max $250 (autoExecute: false)",
    maxRecommendedStake: 250,
    autoExecute: false,
  },
  {
    ticketId: "W-109285",
    timestamp: "14:33:28 ET",
    customerId: "BGD101",
    agentId: "BIGDAD",
    masterAgent: "BIGDAD",
    sport: "NFL",
    betType: "Spread",
    event: "Baltimore Ravens @ Pittsburgh Steelers",
    selection: "Pittsburgh",
    lineDisplay: "+3½",
    oddsAmerican: "-110",
    riskUsd: 2200,
    toWinUsd: 2000,
    clvCents: 7.9,
    alertTier: "STEAM",
    alertBadge: "⚡ STEAM (Key Number 3)",
    operatorDirective: "Clamp Max $500 (autoExecute: false)",
    maxRecommendedStake: 500,
    autoExecute: false,
  },
  {
    ticketId: "W-109286",
    timestamp: "14:33:51 ET",
    customerId: "BAR301",
    agentId: "BAR01",
    masterAgent: "MASTER_SYNDICATE",
    sport: "NFL",
    betType: "Spread",
    event: "Detroit Lions @ Green Bay Packers",
    selection: "Detroit",
    lineDisplay: "-6½",
    oddsAmerican: "-110",
    riskUsd: 3300,
    toWinUsd: 3000,
    clvCents: 7.1,
    alertTier: "STEAM",
    alertBadge: "⚡ STEAM (Early Opener)",
    operatorDirective: "Clamp Max $500 (autoExecute: false)",
    maxRecommendedStake: 500,
    autoExecute: false,
  },
  {
    ticketId: "W-109287",
    timestamp: "14:34:10 ET",
    customerId: "KENT99",
    agentId: "KENT02",
    masterAgent: "MASTER_B",
    sport: "NBA",
    betType: "Total",
    event: "Boston Celtics @ Miami Heat",
    selection: "Miami Heat 2H",
    lineDisplay: "+4½",
    oddsAmerican: "-110",
    riskUsd: 2200,
    toWinUsd: 2000,
    clvCents: 6.8,
    alertTier: "LATENCY",
    alertBadge: "⚠️ LATENCY (Halftime)",
    operatorDirective: "Delay 3s + Cap $500 (autoExecute: false)",
    maxRecommendedStake: 500,
    autoExecute: false,
  },
  {
    ticketId: "W-109288",
    timestamp: "14:34:25 ET",
    customerId: "RF2003",
    agentId: "FAKEMONEY",
    masterAgent: "NOLAWOLF",
    sport: "SOCCER",
    betType: "Total",
    event: "Real Madrid vs Barcelona",
    selection: "Over",
    lineDisplay: "3½ Goals",
    oddsAmerican: "+130",
    riskUsd: 25000,
    toWinUsd: 32500,
    clvCents: -4.2,
    alertTier: "RECREATIONAL",
    alertBadge: "✅ RECREATIONAL (Whale)",
    operatorDirective: "Accept Normal ($25k) (autoExecute: false)",
    maxRecommendedStake: 25000,
    autoExecute: false,
  },
  {
    ticketId: "W-109289",
    timestamp: "14:34:42 ET",
    customerId: "LIVE99",
    agentId: "AG44",
    masterAgent: "MASTER_B",
    sport: "NBA",
    betType: "Moneyline",
    event: "Denver Nuggets @ LA Lakers",
    selection: "Lakers In-Play",
    lineDisplay: "ML",
    oddsAmerican: "+165",
    riskUsd: 1500,
    toWinUsd: 2475,
    clvCents: 5.4,
    alertTier: "LATENCY",
    alertBadge: "⚠️ LATENCY (In-Play)",
    operatorDirective: "Delay 3s + Cap $1,000 (autoExecute: false)",
    maxRecommendedStake: 1000,
    autoExecute: false,
  },
  {
    ticketId: "W-109290",
    timestamp: "14:35:05 ET",
    customerId: "SQUARE1",
    agentId: "AG05",
    masterAgent: "MASTER_RETAIL",
    sport: "CFB",
    betType: "Parlay",
    event: "4-Leg CFB Parlay",
    selection: "MIA -7 / TEX -3 / OSU -3 / ORE -14",
    lineDisplay: "4-Leg",
    oddsAmerican: "+1100",
    riskUsd: 1000,
    toWinUsd: 11000,
    clvCents: -12.5,
    alertTier: "RECREATIONAL",
    alertBadge: "✅ RECREATIONAL (Square Parlay)",
    operatorDirective: "Accept Normal ($25k) (autoExecute: false)",
    maxRecommendedStake: 25000,
    autoExecute: false,
  },
  {
    ticketId: "W-109291",
    timestamp: "14:35:30 ET",
    customerId: "BRT5229",
    agentId: "AG_SHARP",
    masterAgent: "MASTER_SYNDICATE",
    sport: "NFL",
    betType: "Spread",
    event: "Philadelphia Eagles @ Dallas Cowboys",
    selection: "Philadelphia",
    lineDisplay: "-3½",
    oddsAmerican: "-110",
    riskUsd: 5000,
    toWinUsd: 4545,
    clvCents: 12.1,
    alertTier: "CRITICAL",
    alertBadge: "🚨 CRITICAL (Steam Root)",
    operatorDirective: "Clamp Max $250 (autoExecute: false)",
    maxRecommendedStake: 250,
    autoExecute: false,
  },
  {
    ticketId: "W-109292",
    timestamp: "14:35:55 ET",
    customerId: "BK119",
    agentId: "AG81",
    masterAgent: "MASTER_C",
    sport: "CFB",
    betType: "Total",
    event: "Michigan @ Michigan State",
    selection: "2H Under",
    lineDisplay: "21½",
    oddsAmerican: "-105",
    riskUsd: 800,
    toWinUsd: 762,
    clvCents: 3.2,
    alertTier: "STEAM",
    alertBadge: "⚡ SEMI-SHARP (2H Total)",
    operatorDirective: "Cap Max $2,500 (autoExecute: false)",
    maxRecommendedStake: 2500,
    autoExecute: false,
  },
];

export interface DashboardAlertRecord {
  deliveryId: string;
  wagerId: string;
  tier: WagerTier;
  status: "queued" | "delivered" | "dead" | "acknowledged";
  payload: {
    customerId: string;
    sport?: string;
    event?: string;
    selection?: string;
    oddsAmerican?: string;
    amountUsd?: number;
    clvCents?: number;
    directive?: string;
  };
  createdAt: string;
  updatedAt: string;
  attempts?: number;
  finalError?: string;
  retriedFrom?: string;
  acknowledgedBy?: string;
  acknowledgedNotes?: string;
  messageId?: number;
}

export interface HealthData {
  status: "ok" | "warning" | "degraded";
  uptimeSeconds: number;
  alerts?: {
    status: "ok" | "warning" | "degraded";
    queued: number;
    delivered: number;
    dead: number;
    backlog: number;
    acknowledged?: number;
  };
}

export interface ShiftSummaryData {
  date: string;
  operatorId: string;
  totalAlerts: number;
  deliveredAlerts: number;
  failedAttempts: number;
  deadLetterAlerts: number;
  acknowledgedAlerts: number;
  terminalCommandsCount: number;
  loginEventsCount: number;
}

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)sd_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1] ?? "") : "";
}

function apiPostHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const csrf = getCsrfToken();
  if (csrf) {
    headers["x-csrf-token"] = csrf;
  }
  return headers;
}

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
  | "surveillance"
  | "customers"
  | "terminal"
  | "rankings"
  | "wagers"
  | "alerts"
  | "shadow";

function resolveInitialTab(): DashboardTabId {
  if (typeof window === "undefined") return "customers";
  const raw = new URLSearchParams(window.location.search).get("tab");
  if (
    raw === "shadow" ||
    raw === "surveillance" ||
    raw === "customers" ||
    raw === "terminal" ||
    raw === "rankings" ||
    raw === "wagers" ||
    raw === "alerts"
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
  const [wagerSearch, setWagerSearch] = useState("");
  const [wagerSportFilter, setWagerSportFilter] = useState<string>("ALL");
  const [wagerAlertFilter, setWagerAlertFilter] = useState<string>("ALL");
  const [wagerTypeFilter, setWagerTypeFilter] = useState<string>("ALL");
  const [copiedTicketId, setCopiedTicketId] = useState<string | null>(null);
  const [selectedWager, setSelectedWager] = useState<LiveWager | null>(
    SAMPLE_LIVE_WAGERS[0] ?? null,
  );
  const [wagerSortField, setWagerSortField] = useState<
    "timestamp" | "riskUsd" | "toWinUsd" | "clvCents" | "alertTier"
  >("timestamp");
  const [wagerSortDir, setWagerSortDir] = useState<"asc" | "desc">("desc");
  const [clockTime, setClockTime] = useState<string>("");
  const [terminalCategory, setTerminalCategory] = useState<
    "ALL" | "SHARPS" | "DOWNLINES" | "RISK" | "NET"
  >("ALL");
  const [copiedTerminalIdx, setCopiedTerminalIdx] = useState<number | null>(
    null,
  );
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

  // Runtime Declarative Wager Tiers (fetched dynamically from /api/config/tiers)
  const [tiersConfig, setTiersConfig] = useState<Record<
    string,
    { fg: string; bg: string; border: string }
  > | null>(null);

  useEffect(() => {
    fetch("/api/config/tiers")
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          cfg: {
            tiers?: Record<string, { fg: string; bg: string; border: string }>;
          } | null,
        ) => {
          if (cfg?.tiers) {
            setTiersConfig(cfg.tiers);
          }
        },
      )
      .catch((err) => {
        console.warn(
          "[dashboard] failed to load /api/config/tiers, keeping defaults:",
          err,
        );
      });
  }, []);

  // UI enhancement states: banner dismissal & collapsible KPI cards
  const [bannerDismissed, setBannerDismissed] = useState(
    () =>
      typeof sessionStorage !== "undefined" &&
      sessionStorage.getItem("portalBannerDismissed") === "1",
  );
  const [kpisCollapsed, setKpisCollapsed] = useState(() => {
    try {
      return localStorage.getItem("kpisCollapsed") === "1";
    } catch {
      return false;
    }
  });

  // Alerts, DLQ, and Operator Shift state
  const [alertRecords, setAlertRecords] = useState<DashboardAlertRecord[]>([]);
  const [alertFilter, setAlertFilter] = useState<
    "ALL" | "DEAD" | "QUEUED" | "DELIVERED" | "ACKNOWLEDGED"
  >("ALL");
  const [alertLoading, setAlertLoading] = useState(false);
  const [alertToast, setAlertToast] = useState<{
    message: string;
    type: "success" | "error" | "info";
  } | null>(null);
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [isShiftModalOpen, setIsShiftModalOpen] = useState(false);
  const [shiftSummary, setShiftSummary] = useState<ShiftSummaryData | null>(
    null,
  );
  const [shiftOperator, setShiftOperator] = useState<string>("operator");
  const [shiftLoading, setShiftLoading] = useState(false);

  const fetchHealth = () => {
    fetch("/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setHealthData(data);
        }
      })
      .catch(() => {});
  };

  const fetchAlerts = (filter = alertFilter) => {
    setAlertLoading(true);
    const param = filter.toLowerCase();
    fetch(`/api/alerts?status=${param}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((res) => {
        if (res?.alerts) {
          setAlertRecords(res.alerts);
        }
      })
      .catch((err) => {
        console.warn("[alerts] fetch failed:", err);
      })
      .finally(() => setAlertLoading(false));
  };

  const fetchShiftSummary = async (operatorId = shiftOperator) => {
    setShiftLoading(true);
    try {
      const res = await fetch(
        `/api/shift/summary?operatorId=${encodeURIComponent(operatorId)}`,
      );
      if (res.ok) {
        const data = await res.json();
        setShiftSummary(data);
      }
    } catch (e) {
      console.warn("[shift] summary fetch failed:", e);
    } finally {
      setShiftLoading(false);
    }
  };

  const handleAckAlert = async (deliveryId: string, notes?: string) => {
    try {
      const res = await fetch(`/api/alerts/${deliveryId}/ack`, {
        method: "POST",
        headers: apiPostHeaders(),
        body: JSON.stringify({ operatorId: shiftOperator, notes }),
      });
      if (res.ok) {
        setAlertToast({
          message: `Alert ${deliveryId.slice(0, 8)} acknowledged`,
          type: "success",
        });
        fetchAlerts(alertFilter);
        fetchHealth();
      } else {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        setAlertToast({
          message: `Ack failed: ${err.error ?? res.statusText}`,
          type: "error",
        });
      }
    } catch (e) {
      setAlertToast({ message: `Ack failed: ${String(e)}`, type: "error" });
    }
  };

  const handleRetryAlert = async (deliveryId: string) => {
    try {
      const res = await fetch(`/api/alerts/${deliveryId}/retry`, {
        method: "POST",
        headers: apiPostHeaders(),
        body: JSON.stringify({ operatorId: shiftOperator }),
      });
      if (res.ok) {
        const data = await res.json();
        setAlertToast({
          message: `DLQ Replayed! New UUID: ${data.newDeliveryId?.slice(0, 8)}`,
          type: "success",
        });
        fetchAlerts(alertFilter);
        fetchHealth();
      } else {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        setAlertToast({
          message: `Retry failed: ${err.error ?? res.statusText}`,
          type: "error",
        });
      }
    } catch (e) {
      setAlertToast({ message: `Retry failed: ${String(e)}`, type: "error" });
    }
  };

  const handleSweepAlerts = async () => {
    try {
      const res = await fetch(`/api/alerts/sweep`, {
        method: "POST",
        headers: apiPostHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setAlertToast({
          message: `Queue Swept: ${data.sweep?.sent ?? 0} sent, ${data.sweep?.failed ?? 0} failed, ${data.sweep?.dead ?? 0} dead`,
          type: "info",
        });
        fetchAlerts(alertFilter);
        fetchHealth();
      }
    } catch (e) {
      setAlertToast({ message: `Sweep failed: ${String(e)}`, type: "error" });
    }
  };

  // Poll /health every 15s (0 disk I/O, in-memory probe)
  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 15000);
    return () => clearInterval(interval);
  }, []);

  // When switching to alerts tab, fetch alerts
  useEffect(() => {
    if (activeTab === "alerts") {
      fetchAlerts(alertFilter);
    }
  }, [activeTab, alertFilter]);

  // Auto-dismiss toast after 4s
  useEffect(() => {
    if (!alertToast) return;
    const t = setTimeout(() => setAlertToast(null), 4000);
    return () => clearTimeout(t);
  }, [alertToast]);

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
        setActiveTab("wagers");
      } else if (e.ctrlKey && e.key === "6") {
        e.preventDefault();
        setActiveTab("alerts");
      } else if (e.ctrlKey && e.key === "7") {
        e.preventDefault();
        setActiveTab("shadow");
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const et = now.toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      const ct = now.toLocaleTimeString("en-US", {
        timeZone: "America/Chicago",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      setClockTime(`${et} ET · ${ct} CT`);
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleWagerSort = (
    field: "timestamp" | "riskUsd" | "toWinUsd" | "clvCents" | "alertTier",
  ) => {
    if (wagerSortField === field) {
      setWagerSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setWagerSortField(field);
      setWagerSortDir("desc");
    }
  };

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
        fetch("/api/dns/telemetry").then(async (res) => {
          if (!res.ok) return fetch("/api/dns");
          return res;
        }),
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

    // Hot-reload WebSocket connection with React StrictMode-safe lifecycle
    let isMounted = true;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      if (isMounted) {
        setConnected(true);
      } else {
        ws.close();
      }
    };
    ws.onclose = () => {
      if (isMounted) setConnected(false);
    };
    ws.onmessage = (event) => {
      if (
        isMounted &&
        (event.data === "reload" || event.data === "dashboard-updated")
      ) {
        fetchDashboard();
      }
    };

    return () => {
      isMounted = false;
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      } else if (ws.readyState === WebSocket.CONNECTING) {
        // Wait for handshake to finish before closing to avoid browser
        // "WebSocket is closed before the connection is established" warning in React StrictMode
        ws.onopen = () => ws.close();
      }
    };
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

  type CustomerSortKey = "id" | "score" | "gini" | "var95Usd" | "holdPct";
  const [customerSort, setCustomerSort] = useState<{
    key: CustomerSortKey;
    dir: 1 | -1;
  }>({ key: "score", dir: -1 });

  const onCustomerSort = (key: CustomerSortKey) =>
    setCustomerSort((s) =>
      s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: -1 },
    );

  const sortedCustomers = useMemo(() => {
    return [...filteredCustomers].sort((a, b) => {
      const v =
        customerSort.key === "id"
          ? a.id.localeCompare(b.id)
          : (a[customerSort.key] as number) - (b[customerSort.key] as number);
      return v * customerSort.dir;
    });
  }, [filteredCustomers, customerSort]);

  return (
    <div style={styles.container}>
      {/* Global Header */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
            <h1 style={styles.title}>⚡ SportsDesk & Fantasy402 Operations</h1>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                fontSize: "11px",
                color: "#94a3b8",
              }}
            >
              <span style={{ color: "#38bdf8", fontWeight: 600 }}>
                ● Local :4022 SPA
              </span>
              <span>·</span>
              <span style={{ color: "#4ade80", fontWeight: 600 }}>
                ● API :4020
              </span>
              <span>·</span>
              <span style={{ color: "#f59e0b", fontWeight: 600 }}>
                🛡️ autoExecute: false
              </span>
              {clockTime && (
                <>
                  <span>·</span>
                  <span
                    style={{
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      color: "#f1f5f9",
                    }}
                  >
                    🕒 {clockTime}
                  </span>
                </>
              )}
            </div>
          </div>
          <span style={styles.badge(connected)}>
            {connected ? "● Live Hot-Reload Connected" : "○ Disconnected"}
          </span>
          {/* Live Alert Health Pill */}
          <button
            onClick={() => {
              fetchShiftSummary();
              setIsShiftModalOpen(true);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "4px 10px",
              borderRadius: "6px",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
              border: `1px solid ${
                healthData?.alerts?.status === "degraded"
                  ? "#ef4444"
                  : healthData?.alerts?.status === "warning"
                    ? "#f59e0b"
                    : "#22c55e"
              }`,
              background:
                healthData?.alerts?.status === "degraded"
                  ? "rgba(239, 68, 68, 0.15)"
                  : healthData?.alerts?.status === "warning"
                    ? "rgba(245, 158, 11, 0.15)"
                    : "rgba(34, 197, 94, 0.15)",
              color:
                healthData?.alerts?.status === "degraded"
                  ? "#f87171"
                  : healthData?.alerts?.status === "warning"
                    ? "#fbbf24"
                    : "#4ade80",
            }}
            title="Surveillance Alert Health (O(1) in-memory probe) · Click to view Shift Handoff Summary"
          >
            <span>
              {healthData?.alerts?.status === "degraded"
                ? "🚨 DEGRADED"
                : healthData?.alerts?.status === "warning"
                  ? "⚠️ WARNING"
                  : "● System OK"}
            </span>
            {healthData?.alerts && (
              <span style={{ color: "#94a3b8", fontSize: "10px" }}>
                (DLQ: {healthData.alerts.dead} · Backlog:{" "}
                {healthData.alerts.backlog})
              </span>
            )}
          </button>
          <button
            onClick={() => {
              fetchShiftSummary();
              setIsShiftModalOpen(true);
            }}
            style={{
              padding: "4px 9px",
              borderRadius: "6px",
              fontSize: "11px",
              fontWeight: 600,
              background: "#1e293b",
              color: "#94a3b8",
              border: "1px solid #334155",
              cursor: "pointer",
            }}
            title="Operator Shift Summary Handoff"
          >
            📋 Shift Handoff
          </button>
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
            title="Inspect individual sharp originators, sizing models, and risk (Ctrl+1)"
          >
            👥 Profiles ({SAMPLE_PROFILE_DATA.length})
            <span style={styles.keyShortcutBadge}>Ctrl+1</span>
          </button>
          <button
            style={styles.tabBtn(activeTab === "shadow")}
            onClick={() => setActiveTab("shadow")}
            title="Counterfactual Shadow Pricing & Slice Hold-Floor Cube (Ctrl+7)"
          >
            ⚖️ Shadow Pricing (#135)
            <span style={styles.keyShortcutBadge}>Ctrl+7</span>
          </button>
          <button
            style={styles.tabBtn(activeTab === "surveillance")}
            onClick={() => setActiveTab("surveillance")}
            title="Bun.dns latency benchmarks and surveillance markdown (Ctrl+2)"
          >
            📊 Telemetry
            <span style={styles.keyShortcutBadge}>Ctrl+2</span>
          </button>
          <button
            style={styles.tabBtn(activeTab === "terminal")}
            onClick={() => setActiveTab("terminal")}
            title="Native Bun.Terminal PTY query engine (Ctrl+3 or Cmd+K)"
          >
            💻 Terminal (PTY)
            <span style={styles.keyShortcutBadge}>Ctrl+3</span>
          </button>
          <button
            style={styles.tabBtn(activeTab === "rankings")}
            onClick={() => setActiveTab("rankings")}
            title="Rolling 30-day handle rankings & proxy conduits (Ctrl+4)"
          >
            🏆 Downlines ({PROXY_CONDUITS_30D.length})
            <span style={styles.keyShortcutBadge}>Ctrl+4</span>
          </button>
          <button
            style={{
              ...styles.tabBtn(activeTab === "wagers"),
              position: "relative",
            }}
            onClick={() => setActiveTab("wagers")}
            title="Real-time incoming wager tape with CLV alerts (Ctrl+5)"
          >
            ⚡ Live Wagers ({SAMPLE_LIVE_WAGERS.length})
            <span
              className="live-alert-pulse"
              style={{
                fontSize: "10px",
                padding: "1px 5px",
                borderRadius: "8px",
                backgroundColor: "#ef4444",
                color: "#ffffff",
                fontWeight: 700,
                marginLeft: "4px",
              }}
            >
              🚨{" "}
              {
                SAMPLE_LIVE_WAGERS.filter(
                  (w) => w.alertTier === "CRITICAL" || w.alertTier === "STEAM",
                ).length
              }
            </span>
            <span style={styles.keyShortcutBadge}>Ctrl+5</span>
          </button>
          <button
            style={{
              ...styles.tabBtn(activeTab === "alerts"),
              position: "relative",
            }}
            onClick={() => {
              setActiveTab("alerts");
              fetchAlerts();
            }}
            title="Surveillance Alert Queue, Dead-Letter Queue (DLQ), and Replay Controls (Ctrl+6)"
          >
            🚨 DLQ & Alerts ({alertRecords.length})
            {healthData?.alerts?.dead && healthData.alerts.dead > 0 ? (
              <span
                style={{
                  fontSize: "10px",
                  padding: "1px 5px",
                  borderRadius: "8px",
                  backgroundColor: "#ef4444",
                  color: "#ffffff",
                  fontWeight: 700,
                  marginLeft: "4px",
                }}
              >
                {healthData.alerts.dead} DEAD
              </span>
            ) : null}
            <span style={styles.keyShortcutBadge}>Ctrl+6</span>
          </button>
        </div>
      </header>

      {showBuildMatrix ? (
        <section
          style={{
            padding: "14px 24px",
            backgroundColor: "var(--sd-surface-cli, #0a1020)",
            borderBottom: "1px solid var(--sd-surface-border, #1e293b)",
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
                style={{
                  fontSize: "11px",
                  color: "var(--sd-text-muted, #94a3b8)",
                }}
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
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--sd-text-muted, #94a3b8)",
                }}
              >
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
            {/* Session Notice Banner (Dismissible) */}
            {!bannerDismissed && (
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
                  justifyContent: "space-between",
                  gap: "10px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "10px",
                  }}
                >
                  <span style={{ fontSize: "16px", lineHeight: "1" }}>⚠️</span>
                  <div>
                    <b>Fantasy402 Portal Session Notice:</b> Direct portal links
                    require an active, authenticated manager session in your
                    browser. If you encounter <i>"Your session has expired"</i>,
                    log into fantasy402.com first. For instant local telemetry,
                    all accounts are profiled below; click any row/ID to inspect
                    or use <b>📋 Copy CLI</b>.
                  </div>
                </div>
                <button
                  type="button"
                  style={{
                    background: "none",
                    border: "none",
                    color: "#fbbf24",
                    fontSize: "16px",
                    cursor: "pointer",
                    padding: "0 4px",
                    lineHeight: "1",
                  }}
                  onClick={() => {
                    setBannerDismissed(true);
                    try {
                      sessionStorage.setItem("portalBannerDismissed", "1");
                    } catch {}
                  }}
                  title="Dismiss notice"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Collapsible KPI Strip Header */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "8px",
              }}
            >
              <span
                style={{
                  fontSize: "11px",
                  color: "#64748b",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  fontWeight: 600,
                }}
              >
                Corpora & Surveillance Cohorts
              </span>
              <button
                type="button"
                style={{
                  background: "none",
                  border: "none",
                  color: "#38bdf8",
                  fontSize: "11px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                  padding: "2px 6px",
                }}
                onClick={() => {
                  const next = !kpisCollapsed;
                  setKpisCollapsed(next);
                  try {
                    localStorage.setItem("kpisCollapsed", next ? "1" : "0");
                  } catch {}
                }}
              >
                {kpisCollapsed ? "Show Corpora ▼" : "Hide Corpora ▲"}
              </button>
            </div>

            {/* KPI Summary Cards (Collapsible) */}
            {!kpisCollapsed && (
              <div className="kpi-strip" style={styles.kpiGrid}>
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
            )}

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
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "12px",
                  }}
                >
                  <h3 style={{ margin: 0, fontSize: "16px", color: "#f8fafc" }}>
                    Profiled Bettors ({sortedCustomers.length})
                  </h3>
                  <span style={{ fontSize: "11px", color: "#64748b" }}>
                    Click header to sort · Pinned Directive
                  </span>
                </div>
                <div className="profiles-wrap">
                  <table style={styles.table}>
                    <thead>
                      <tr style={styles.thRow}>
                        <th
                          className="sortable"
                          style={styles.th}
                          onClick={() => onCustomerSort("id")}
                        >
                          Customer
                          <span className="sort-arrow">
                            {customerSort.key === "id"
                              ? customerSort.dir === 1
                                ? "▲"
                                : "▼"
                              : ""}
                          </span>
                        </th>
                        <th
                          className="sortable"
                          style={styles.th}
                          onClick={() => onCustomerSort("score")}
                        >
                          Unified Sharpness
                          <span className="sort-arrow">
                            {customerSort.key === "score"
                              ? customerSort.dir === 1
                                ? "▲"
                                : "▼"
                              : ""}
                          </span>
                        </th>
                        <th
                          className="sortable"
                          style={styles.th}
                          onClick={() => onCustomerSort("gini")}
                        >
                          Sizing Strategy
                          <span className="sort-arrow">
                            {customerSort.key === "gini"
                              ? customerSort.dir === 1
                                ? "▲"
                                : "▼"
                              : ""}
                          </span>
                        </th>
                        <th style={styles.th}>Specialization</th>
                        <th style={styles.th}>Correlated Par</th>
                        <th
                          className="sortable"
                          style={styles.th}
                          onClick={() => onCustomerSort("var95Usd")}
                        >
                          7d VaR (95%)
                          <span className="sort-arrow">
                            {customerSort.key === "var95Usd"
                              ? customerSort.dir === 1
                                ? "▲"
                                : "▼"
                              : ""}
                          </span>
                        </th>
                        <th
                          className="sortable directive"
                          style={styles.th}
                          onClick={() => onCustomerSort("holdPct")}
                        >
                          Desk Directive
                          <span className="sort-arrow">
                            {customerSort.key === "holdPct"
                              ? customerSort.dir === 1
                                ? "▲"
                                : "▼"
                              : ""}
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedCustomers.map((cust) => {
                        const isSelected = selectedCustomer?.id === cust.id;
                        const tierClass = cust.tier.includes("TIER_1")
                          ? "tier-1"
                          : cust.tier.includes("TIER_2")
                            ? "tier-2"
                            : cust.tier.includes("TIER_3")
                              ? "tier-3"
                              : cust.tier.includes("TIER_4")
                                ? "tier-4"
                                : "tier-5";

                        const actionClass = cust.action.includes("ALERT")
                          ? "action-alert"
                          : cust.action.includes("MONITOR") ||
                              cust.action.includes("THROTTLE")
                            ? "action-monitor"
                            : "action-accept";

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
                                <a
                                  href={`https://fantasy402.com/manager.html?customer=${cust.id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  style={{
                                    color: "#94a3b8",
                                    textDecoration: "none",
                                    fontSize: "11px",
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  title="Open in Fantasy402 Manager Portal"
                                >
                                  ↗
                                </a>
                                {cust.subAccountIndex !== null && (
                                  <span style={styles.subBadge}>
                                    Seat #{cust.subAccountIndex}
                                  </span>
                                )}
                              </div>
                              <div style={styles.custAgent}>
                                Agent:{" "}
                                <a
                                  href={`https://desk.bookdeskops.com/agent/${cust.agentId}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  style={{
                                    color: "#38bdf8",
                                    textDecoration: "none",
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  title="Open Agent Desk Profile"
                                >
                                  {cust.agentId} ↗
                                </a>
                              </div>
                            </td>
                            <td style={styles.td}>
                              <span className={`chip ${tierClass}`}>
                                {cust.score >= 9.0
                                  ? "🚨 "
                                  : cust.score >= 8.0
                                    ? "⚡ "
                                    : cust.score >= 7.0
                                      ? "⚠️ "
                                      : "✅ "}
                                {cust.score.toFixed(1)} ·{" "}
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
                                className={
                                  cust.holdPct < 0 ? "hold-neg" : "hold-pos"
                                }
                                style={{ fontSize: "11px" }}
                              >
                                Hold: {cust.holdPct}%
                              </div>
                            </td>
                            <td className="directive" style={styles.td}>
                              <span className={`chip ${actionClass}`}>
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
              <div className="detail-panel" style={styles.inspectorPanel}>
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
                          flexWrap: "wrap",
                          justifyContent: "flex-end",
                          alignItems: "center",
                          gap: "6px",
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
                            color: "#0f172a",
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

            {/* Category Filter & Quick Query Toolbar */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                padding: "8px 12px",
                borderBottom: "1px solid #1e293b",
                backgroundColor: "#0b1222",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontSize: "11px",
                    color: "#64748b",
                    marginRight: "4px",
                  }}
                >
                  Categories:
                </span>
                {[
                  { id: "ALL", label: "All Commands" },
                  { id: "SHARPS", label: "🎯 Sharps & Profiling" },
                  { id: "DOWNLINES", label: "🌲 Downlines & Conduits" },
                  { id: "RISK", label: "🛡️ Risk & Directives" },
                  { id: "NET", label: "🌐 Network & System" },
                ].map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    style={styles.filterPill(terminalCategory === cat.id)}
                    onClick={() =>
                      setTerminalCategory(
                        cat.id as
                          "ALL" | "SHARPS" | "DOWNLINES" | "RISK" | "NET",
                      )
                    }
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

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
                  { label: "⚡ p GP301", cmd: "p GP301", cat: "SHARPS" },
                  { label: "⚡ p BRT5229", cmd: "p BRT5229", cat: "SHARPS" },
                  { label: "🏆 rank-all", cmd: "rank-all", cat: "SHARPS" },
                  { label: "🏆 sh", cmd: "sh", cat: "SHARPS" },
                  {
                    label: "🔍 f syndicate",
                    cmd: "f syndicate",
                    cat: "SHARPS",
                  },
                  { label: "🚨 conduits", cmd: "conduits", cat: "DOWNLINES" },
                  { label: "🌲 trunks", cmd: "trunks", cat: "DOWNLINES" },
                  { label: "🏢 sa", cmd: "sa", cat: "DOWNLINES" },
                  { label: "⚡ bursts", cmd: "bursts", cat: "RISK" },
                  { label: "🛡️ quarantine", cmd: "quarantine", cat: "RISK" },
                  { label: "🚨 dir", cmd: "dir", cat: "RISK" },
                  { label: "📈 var", cmd: "var", cat: "RISK" },
                  { label: "🔑 k", cmd: "k", cat: "RISK" },
                  { label: "📊 g", cmd: "g", cat: "RISK" },
                  { label: "📊 stat", cmd: "stat", cat: "RISK" },
                  { label: "📝 md", cmd: "markdown", cat: "RISK" },
                  { label: "🌐 ws", cmd: "ws", cat: "NET" },
                  {
                    label: "🌐 d fantasy402.com",
                    cmd: "d fantasy402.com",
                    cat: "NET",
                  },
                  { label: "🛡️ r 1.1.1.1", cmd: "r 1.1.1.1", cat: "NET" },
                  { label: "👤 w", cmd: "w", cat: "NET" },
                  { label: "⌨️ kb", cmd: "kb", cat: "NET" },
                  { label: "❓ h", cmd: "h", cat: "NET" },
                ]
                  .filter(
                    (chip) =>
                      terminalCategory === "ALL" ||
                      chip.cat === terminalCategory,
                  )
                  .map((chip) => (
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
                          background: "none",
                          border: "none",
                          color: "#64748b",
                          cursor: "pointer",
                          fontSize: "11px",
                          padding: "0 4px",
                        }}
                        title="Copy raw terminal output"
                        onClick={() => {
                          navigator.clipboard.writeText(item.stdout);
                          setCopiedTerminalIdx(idx);
                          setTimeout(() => setCopiedTerminalIdx(null), 1500);
                        }}
                      >
                        {copiedTerminalIdx === idx ? "✓ Copied" : "📋 Copy"}
                      </button>
                      <span style={styles.terminalMeta}>
                        {item.durationMs > 0 && `[${item.durationMs}ms] `}
                        exit: {item.exitCode}
                      </span>
                    </div>
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
                            <a
                              href={`https://fantasy402.com/manager.html?customer=${p.id}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                ...styles.custLogin,
                                textDecoration: "none",
                              }}
                              title="Fantasy402 Customer Portal"
                            >
                              {p.id} ↗
                            </a>
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
                          <div style={{ fontWeight: 600 }}>
                            <a
                              href={`https://desk.bookdeskops.com/agent/${p.agentId}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                color: "#38bdf8",
                                textDecoration: "none",
                              }}
                              title="Agent Desk Profile"
                            >
                              {p.agentId} ↗
                            </a>
                          </div>
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
                            <a
                              href={`https://desk.bookdeskops.com/agent/${c.agentId}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                color: "#f59e0b",
                                textDecoration: "none",
                              }}
                              title="Agent Desk Profile"
                            >
                              {c.agentId} ↗
                            </a>
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
                            <a
                              href={`https://fantasy402.com/manager.html?customer=${c.topCust}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                color: "#38bdf8",
                                textDecoration: "none",
                              }}
                              title="Fantasy402 Customer Portal"
                            >
                              {c.topCust} ↗
                            </a>
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
        ) : activeTab === "alerts" ? (
          <div
            style={{ display: "flex", flexDirection: "column", gap: "20px" }}
          >
            {/* Alert Toast Notification Banner */}
            {alertToast && (
              <div
                style={{
                  padding: "12px 18px",
                  borderRadius: "8px",
                  background:
                    alertToast.type === "success"
                      ? "rgba(34, 197, 94, 0.15)"
                      : alertToast.type === "error"
                        ? "rgba(239, 68, 68, 0.15)"
                        : "rgba(56, 189, 248, 0.15)",
                  border: `1px solid ${
                    alertToast.type === "success"
                      ? "#22c55e"
                      : alertToast.type === "error"
                        ? "#ef4444"
                        : "#38bdf8"
                  }`,
                  color:
                    alertToast.type === "success"
                      ? "#4ade80"
                      : alertToast.type === "error"
                        ? "#f87171"
                        : "#38bdf8",
                  fontSize: "13px",
                  fontWeight: 600,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>{alertToast.message}</span>
                <button
                  type="button"
                  onClick={() => setAlertToast(null)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "inherit",
                    cursor: "pointer",
                    fontSize: "16px",
                  }}
                >
                  ✕
                </button>
              </div>
            )}

            {/* Alert Health & DLQ KPI Grid */}
            <div style={styles.kpiGrid}>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Surveillance Status</div>
                <div
                  style={{
                    ...styles.kpiVal,
                    color:
                      healthData?.alerts?.status === "degraded"
                        ? "#f87171"
                        : healthData?.alerts?.status === "warning"
                          ? "#fbbf24"
                          : "#4ade80",
                  }}
                >
                  {healthData?.alerts?.status?.toUpperCase() ?? "OK"}
                </div>
                <div style={styles.kpiSub}>
                  O(1) in-memory probe · zero disk parse
                </div>
              </div>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Dead-Letter Queue (DLQ)</div>
                <div
                  style={{
                    ...styles.kpiVal,
                    color:
                      (healthData?.alerts?.dead ?? 0) > 0
                        ? "#f87171"
                        : "#4ade80",
                  }}
                >
                  {healthData?.alerts?.dead ?? 0} Dead
                </div>
                <div style={styles.kpiSub}>
                  Exceeded max attempts · operator ack or replay
                </div>
              </div>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Active Queue Backlog</div>
                <div style={styles.kpiVal}>
                  {healthData?.alerts?.backlog ?? 0} Pending
                </div>
                <div style={styles.kpiSub}>Draining on 5s sweep interval</div>
              </div>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Telegram Dispatched</div>
                <div style={{ ...styles.kpiVal, color: "#38bdf8" }}>
                  {healthData?.alerts?.delivered ?? 0} Dispatched
                </div>
                <div style={styles.kpiSub}>
                  Auto-formatted HTML cards · autoExecute: false
                </div>
              </div>
            </div>

            {/* Filter and Action Bar */}
            <div style={styles.filterBar}>
              <div style={styles.tierFilterGroup}>
                {(
                  [
                    { id: "ALL", label: "All Alerts" },
                    {
                      id: "DEAD",
                      label: `🚨 Dead DLQ (${healthData?.alerts?.dead ?? 0})`,
                    },
                    {
                      id: "QUEUED",
                      label: `⏳ Queued (${healthData?.alerts?.backlog ?? 0})`,
                    },
                    {
                      id: "DELIVERED",
                      label: `📬 Delivered (${healthData?.alerts?.delivered ?? 0})`,
                    },
                    {
                      id: "ACKNOWLEDGED",
                      label: `✅ Acknowledged (${healthData?.alerts?.acknowledged ?? 0})`,
                    },
                  ] as const
                ).map((pill) => (
                  <button
                    key={pill.id}
                    type="button"
                    style={styles.filterPill(alertFilter === pill.id)}
                    onClick={() => {
                      setAlertFilter(pill.id);
                      fetchAlerts(pill.id);
                    }}
                  >
                    {pill.label}
                  </button>
                ))}
              </div>

              <div
                style={{ display: "flex", gap: "8px", alignItems: "center" }}
              >
                <button
                  type="button"
                  onClick={handleSweepAlerts}
                  style={{
                    padding: "7px 14px",
                    borderRadius: "6px",
                    fontSize: "12px",
                    fontWeight: 600,
                    background: "rgba(56, 189, 248, 0.15)",
                    border: "1px solid #38bdf8",
                    color: "#38bdf8",
                    cursor: "pointer",
                  }}
                  title="Immediately sweep active queue without waiting for 5s daemon tick"
                >
                  ⚡ Sweep Queue Now
                </button>
                <button
                  type="button"
                  onClick={() => fetchAlerts(alertFilter)}
                  disabled={alertLoading}
                  style={{
                    padding: "7px 14px",
                    borderRadius: "6px",
                    fontSize: "12px",
                    fontWeight: 600,
                    background: "#1e293b",
                    border: "1px solid #334155",
                    color: "#f1f5f9",
                    cursor: alertLoading ? "wait" : "pointer",
                  }}
                >
                  {alertLoading ? "Loading..." : "🔄 Refresh"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    fetchShiftSummary();
                    setIsShiftModalOpen(true);
                  }}
                  style={{
                    padding: "7px 14px",
                    borderRadius: "6px",
                    fontSize: "12px",
                    fontWeight: 600,
                    background: "rgba(168, 85, 247, 0.15)",
                    border: "1px solid #a855f7",
                    color: "#c084fc",
                    cursor: "pointer",
                  }}
                >
                  📋 Shift Handoff
                </button>
              </div>
            </div>

            {/* Alerts Table Card */}
            <div style={styles.tableCard}>
              <div style={styles.tableHeader}>
                <h3 style={styles.tableTitle}>
                  🚨 Surveillance Alert Audit Stream & Dead-Letter Management
                </h3>
                <span style={{ fontSize: "11px", color: "#64748b" }}>
                  Durable JSONL audit log · Replay lineage tracked via
                  retriedFrom · Total: {alertRecords.length}
                </span>
              </div>

              <div style={styles.tableScroll}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Timestamp</th>
                      <th style={styles.th}>Status</th>
                      <th style={styles.th}>Delivery ID</th>
                      <th style={styles.th}>Ticket / Wager</th>
                      <th style={styles.th}>Customer</th>
                      <th style={styles.th}>Tier</th>
                      <th style={styles.th}>Amount / CLV</th>
                      <th style={styles.th}>Attempts</th>
                      <th style={styles.th}>Directive / Final Error</th>
                      <th style={styles.th}>Operator Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alertRecords.length === 0 ? (
                      <tr>
                        <td
                          colSpan={10}
                          style={{
                            padding: "36px",
                            textAlign: "center",
                            color: "#64748b",
                            fontSize: "13px",
                          }}
                        >
                          No alerts matching filter "{alertFilter}".
                        </td>
                      </tr>
                    ) : (
                      alertRecords.map((alert) => {
                        const isDead = alert.status === "dead";
                        const isAcked = alert.status === "acknowledged";
                        const isQueued = alert.status === "queued";
                        const isDelivered = alert.status === "delivered";

                        return (
                          <tr
                            key={alert.deliveryId}
                            style={{
                              borderBottom: "1px solid #1e293b",
                              background: isDead
                                ? "rgba(239, 68, 68, 0.06)"
                                : "transparent",
                            }}
                          >
                            <td style={styles.td}>
                              <div
                                style={{ fontSize: "12px", color: "#f1f5f9" }}
                              >
                                {new Date(alert.createdAt).toLocaleTimeString()}
                              </div>
                              <div
                                style={{ fontSize: "10px", color: "#64748b" }}
                              >
                                {
                                  new Date(alert.createdAt)
                                    .toISOString()
                                    .split("T")[0]
                                }
                              </div>
                            </td>
                            <td style={styles.td}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "2px 8px",
                                  borderRadius: "4px",
                                  fontSize: "10px",
                                  fontWeight: 700,
                                  background: isDead
                                    ? "rgba(239, 68, 68, 0.2)"
                                    : isQueued
                                      ? "rgba(245, 158, 11, 0.2)"
                                      : isDelivered
                                        ? "rgba(34, 197, 94, 0.2)"
                                        : "rgba(168, 85, 247, 0.2)",
                                  color: isDead
                                    ? "#f87171"
                                    : isQueued
                                      ? "#fbbf24"
                                      : isDelivered
                                        ? "#4ade80"
                                        : "#c084fc",
                                  border: `1px solid ${
                                    isDead
                                      ? "#ef4444"
                                      : isQueued
                                        ? "#f59e0b"
                                        : isDelivered
                                          ? "#22c55e"
                                          : "#a855f7"
                                  }`,
                                }}
                              >
                                {alert.status.toUpperCase()}
                              </span>
                            </td>
                            <td style={styles.td}>
                              <span
                                style={{
                                  fontFamily:
                                    "ui-monospace, SFMono-Regular, Menlo, monospace",
                                  fontSize: "11px",
                                  color: "#94a3b8",
                                  cursor: "pointer",
                                }}
                                title={`Click to copy: ${alert.deliveryId}`}
                                onClick={() => {
                                  navigator.clipboard?.writeText(
                                    alert.deliveryId,
                                  );
                                  setAlertToast({
                                    message: `Copied delivery UUID: ${alert.deliveryId}`,
                                    type: "info",
                                  });
                                }}
                              >
                                {alert.deliveryId.slice(0, 8)}...
                              </span>
                              {alert.retriedFrom && (
                                <div
                                  style={{
                                    fontSize: "9px",
                                    color: "#64748b",
                                  }}
                                  title={`Retried from prior delivery: ${alert.retriedFrom}`}
                                >
                                  ↳ retried from {alert.retriedFrom.slice(0, 6)}
                                </div>
                              )}
                            </td>
                            <td style={styles.td}>
                              <span
                                style={{
                                  fontFamily:
                                    "ui-monospace, SFMono-Regular, Menlo, monospace",
                                  fontWeight: 600,
                                  color: "#38bdf8",
                                }}
                              >
                                {alert.wagerId || "—"}
                              </span>
                            </td>
                            <td style={styles.td}>
                              <span
                                style={{ fontWeight: 600, color: "#f1f5f9" }}
                              >
                                {alert.payload.customerId}
                              </span>
                            </td>
                            <td style={styles.td}>
                              <span
                                style={{
                                  ...styles.wagerBadge(alert.tier, tiersConfig),
                                  display: "inline-block",
                                  padding: "2px 6px",
                                  borderRadius: "4px",
                                  fontSize: "11px",
                                  fontWeight: 700,
                                }}
                              >
                                {alert.tier}
                              </span>
                            </td>
                            <td style={styles.td}>
                              <div
                                style={{ fontWeight: 600, color: "#f1f5f9" }}
                              >
                                $
                                {alert.payload.amountUsd?.toLocaleString() ??
                                  "—"}
                              </div>
                              <div
                                style={{
                                  fontSize: "10px",
                                  color:
                                    (alert.payload.clvCents ?? 0) >= 7
                                      ? "#4ade80"
                                      : "#94a3b8",
                                }}
                              >
                                CLV: {alert.payload.clvCents ?? 0}¢
                              </div>
                            </td>
                            <td style={styles.td}>
                              <span
                                style={{ fontSize: "11px", color: "#94a3b8" }}
                              >
                                {alert.attempts ?? 1} / 5
                              </span>
                            </td>
                            <td style={styles.td}>
                              {isDead ? (
                                <div
                                  style={{
                                    fontSize: "11px",
                                    color: "#f87171",
                                    fontFamily:
                                      "ui-monospace, SFMono-Regular, Menlo, monospace",
                                  }}
                                >
                                  ❌{" "}
                                  {alert.finalError ??
                                    "Max delivery attempts exceeded"}
                                </div>
                              ) : isAcked ? (
                                <div
                                  style={{ fontSize: "11px", color: "#c084fc" }}
                                >
                                  ✓ Acked by{" "}
                                  {alert.acknowledgedBy ?? "operator"}
                                  {alert.acknowledgedNotes
                                    ? ` · "${alert.acknowledgedNotes}"`
                                    : ""}
                                </div>
                              ) : isDelivered ? (
                                <div
                                  style={{ fontSize: "11px", color: "#4ade80" }}
                                >
                                  📬 Delivered (Msg #{alert.messageId ?? "sent"}
                                  )
                                </div>
                              ) : (
                                <div
                                  style={{ fontSize: "11px", color: "#38bdf8" }}
                                >
                                  ⏳{" "}
                                  {alert.payload.directive ?? "Pending sweep"}
                                </div>
                              )}
                            </td>
                            <td style={styles.td}>
                              <div style={{ display: "flex", gap: "6px" }}>
                                {isDead && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleAckAlert(alert.deliveryId)
                                      }
                                      style={{
                                        padding: "3px 8px",
                                        borderRadius: "4px",
                                        fontSize: "11px",
                                        fontWeight: 600,
                                        background: "rgba(168, 85, 247, 0.2)",
                                        border: "1px solid #a855f7",
                                        color: "#c084fc",
                                        cursor: "pointer",
                                      }}
                                      title="Clear dead status and acknowledge alert"
                                    >
                                      Ack
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleRetryAlert(alert.deliveryId)
                                      }
                                      style={{
                                        padding: "3px 8px",
                                        borderRadius: "4px",
                                        fontSize: "11px",
                                        fontWeight: 600,
                                        background: "rgba(56, 189, 248, 0.2)",
                                        border: "1px solid #38bdf8",
                                        color: "#38bdf8",
                                        cursor: "pointer",
                                      }}
                                      title="Replay from DLQ with linkage and trigger immediate send"
                                    >
                                      Retry DLQ
                                    </button>
                                  </>
                                )}
                                {isQueued && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleAckAlert(
                                        alert.deliveryId,
                                        "Discarded from queue",
                                      )
                                    }
                                    style={{
                                      padding: "3px 8px",
                                      borderRadius: "4px",
                                      fontSize: "11px",
                                      fontWeight: 600,
                                      background: "#1e293b",
                                      border: "1px solid #334155",
                                      color: "#94a3b8",
                                      cursor: "pointer",
                                    }}
                                  >
                                    Ack / Clear
                                  </button>
                                )}
                                {isAcked && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleRetryAlert(alert.deliveryId)
                                    }
                                    style={{
                                      padding: "3px 8px",
                                      borderRadius: "4px",
                                      fontSize: "11px",
                                      fontWeight: 600,
                                      background: "rgba(56, 189, 248, 0.15)",
                                      border: "1px solid #38bdf8",
                                      color: "#38bdf8",
                                      cursor: "pointer",
                                    }}
                                  >
                                    Re-queue
                                  </button>
                                )}
                                {isDelivered && (
                                  <span
                                    style={{
                                      fontSize: "11px",
                                      color: "#4ade80",
                                    }}
                                  >
                                    ✓ Sent
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
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
        ) : (
          <div
            style={{ display: "flex", flexDirection: "column", gap: "20px" }}
          >
            {/* Live Wagers KPI Grid */}
            <div style={styles.kpiGrid}>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Live Streaming Feed</div>
                <div style={styles.kpiVal}>
                  {SAMPLE_LIVE_WAGERS.length} Wagers
                </div>
                <div style={styles.kpiSub}>
                  Real-Time Ingestion (Sub-second)
                </div>
              </div>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Flagged Steam / Originator</div>
                <div style={{ ...styles.kpiVal, color: "#f87171" }}>
                  {
                    SAMPLE_LIVE_WAGERS.filter(
                      (w) =>
                        w.alertTier === "CRITICAL" || w.alertTier === "STEAM",
                    ).length
                  }{" "}
                  Alerts
                </div>
                <div style={styles.kpiSub}>
                  Key Numbers 3 & 7 / Syndicate Hooks
                </div>
              </div>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Live Exposure at Risk</div>
                <div style={styles.kpiVal}>
                  $
                  {SAMPLE_LIVE_WAGERS.reduce(
                    (acc, w) => acc + w.riskUsd,
                    0,
                  ).toLocaleString()}
                </div>
                <div style={styles.kpiSub}>
                  To Win: $
                  {SAMPLE_LIVE_WAGERS.reduce(
                    (acc, w) => acc + w.toWinUsd,
                    0,
                  ).toLocaleString()}
                </div>
              </div>
              <div style={styles.kpiCard}>
                <div style={styles.kpiLabel}>Operator Guardrails</div>
                <div style={{ ...styles.kpiVal, color: "#4ade80" }}>
                  autoExecute: false
                </div>
                <div style={styles.kpiSub}>
                  Production Safety Invariant Active
                </div>
              </div>
            </div>

            {/* Filter and Search Bar */}
            <div style={styles.filterBar}>
              <div style={styles.searchBox}>
                <span style={styles.searchIcon}>🔍</span>
                <input
                  style={styles.searchInput}
                  value={wagerSearch}
                  onChange={(e) => setWagerSearch(e.target.value)}
                  placeholder="Filter by Ticket (#W-...), Customer ('GP301'), Agent, Event, Selection..."
                />
              </div>

              <div style={styles.tierFilterGroup}>
                {[
                  { id: "ALL", label: "All Sports" },
                  { id: "NFL", label: "🏈 NFL" },
                  { id: "CFB", label: "🎓 CFB" },
                  { id: "NBA", label: "🏀 NBA" },
                  { id: "SOCCER", label: "⚽ Soccer" },
                ].map((pill) => (
                  <button
                    key={pill.id}
                    type="button"
                    style={styles.filterPill(wagerSportFilter === pill.id)}
                    onClick={() => setWagerSportFilter(pill.id)}
                  >
                    {pill.label}
                  </button>
                ))}
              </div>

              <div style={styles.tierFilterGroup}>
                {[
                  { id: "ALL", label: "All Alerts" },
                  { id: "CRITICAL", label: "🚨 Critical" },
                  { id: "STEAM", label: "⚡ Steam" },
                  { id: "LATENCY", label: "⚠️ Latency" },
                  { id: "RECREATIONAL", label: "✅ Recreational" },
                ].map((pill) => (
                  <button
                    key={pill.id}
                    type="button"
                    style={styles.filterPill(wagerAlertFilter === pill.id)}
                    onClick={() => setWagerAlertFilter(pill.id)}
                  >
                    {pill.label}
                  </button>
                ))}
              </div>

              <div style={styles.tierFilterGroup}>
                {[
                  { id: "ALL", label: "All Bet Types" },
                  { id: "Spread", label: "Spread" },
                  { id: "Total", label: "Total" },
                  { id: "Moneyline", label: "Moneyline" },
                  { id: "Parlay", label: "Parlay" },
                ].map((pill) => (
                  <button
                    key={pill.id}
                    type="button"
                    style={styles.filterPill(wagerTypeFilter === pill.id)}
                    onClick={() => setWagerTypeFilter(pill.id)}
                  >
                    {pill.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Live Wagers Table Card */}
            <div style={styles.tableCard}>
              <div style={styles.tableHeader}>
                <h3 style={styles.tableTitle}>
                  ⚡ Live Incoming Wagers & Real-Time Action Directives
                </h3>
                <span style={{ fontSize: "11px", color: "#64748b" }}>
                  Real-time wager feed · autoExecute: false invariant active
                </span>
              </div>

              <div style={styles.tableScroll}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th
                        style={{
                          ...styles.th,
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                        onClick={() => handleWagerSort("timestamp")}
                        title="Sort by Timestamp"
                      >
                        Ticket / Time{" "}
                        {wagerSortField === "timestamp"
                          ? wagerSortDir === "asc"
                            ? "▲"
                            : "▼"
                          : ""}
                      </th>
                      <th style={styles.th}>Customer</th>
                      <th style={styles.th}>Sub-Agent / Master</th>
                      <th style={styles.th}>Sport / Type</th>
                      <th style={styles.th}>Event & Market Selection</th>
                      <th
                        style={{
                          ...styles.th,
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                        onClick={() => handleWagerSort("riskUsd")}
                        title="Sort by Risk Amount"
                      >
                        Risk / To Win{" "}
                        {wagerSortField === "riskUsd"
                          ? wagerSortDir === "asc"
                            ? "▲"
                            : "▼"
                          : ""}
                      </th>
                      <th
                        style={{
                          ...styles.th,
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                        onClick={() => handleWagerSort("clvCents")}
                        title="Sort by CLV Edge"
                      >
                        CLV Edge{" "}
                        {wagerSortField === "clvCents"
                          ? wagerSortDir === "asc"
                            ? "▲"
                            : "▼"
                          : ""}
                      </th>
                      <th
                        style={{
                          ...styles.th,
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                        onClick={() => handleWagerSort("alertTier")}
                        title="Sort by Alert Severity"
                      >
                        Alert Classification{" "}
                        {wagerSortField === "alertTier"
                          ? wagerSortDir === "asc"
                            ? "▲"
                            : "▼"
                          : ""}
                      </th>
                      <th style={styles.th}>Action Directive</th>
                      <th style={styles.th}>Operator Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SAMPLE_LIVE_WAGERS.filter((w) => {
                      const q = wagerSearch.toLowerCase();
                      const matchesSearch =
                        !q ||
                        w.ticketId.toLowerCase().includes(q) ||
                        w.customerId.toLowerCase().includes(q) ||
                        w.agentId.toLowerCase().includes(q) ||
                        w.event.toLowerCase().includes(q) ||
                        w.selection.toLowerCase().includes(q);
                      if (!matchesSearch) return false;
                      if (
                        wagerSportFilter !== "ALL" &&
                        w.sport !== wagerSportFilter
                      )
                        return false;
                      if (
                        wagerAlertFilter !== "ALL" &&
                        w.alertTier !== wagerAlertFilter
                      )
                        return false;
                      if (
                        wagerTypeFilter !== "ALL" &&
                        w.betType !== wagerTypeFilter
                      )
                        return false;
                      return true;
                    })
                      .sort((a, b) => {
                        const TIER_ORDER: Record<string, number> = {
                          CRITICAL: 4,
                          STEAM: 3,
                          LATENCY: 2,
                          RECREATIONAL: 1,
                        };
                        let cmp = 0;
                        if (wagerSortField === "timestamp") {
                          cmp = a.timestamp.localeCompare(b.timestamp);
                        } else if (wagerSortField === "riskUsd") {
                          cmp = a.riskUsd - b.riskUsd;
                        } else if (wagerSortField === "toWinUsd") {
                          cmp = a.toWinUsd - b.toWinUsd;
                        } else if (wagerSortField === "clvCents") {
                          cmp = a.clvCents - b.clvCents;
                        } else if (wagerSortField === "alertTier") {
                          cmp =
                            (TIER_ORDER[a.alertTier] ?? 0) -
                            (TIER_ORDER[b.alertTier] ?? 0);
                        }
                        return wagerSortDir === "asc" ? cmp : -cmp;
                      })
                      .map((w) => (
                        <tr
                          key={w.ticketId}
                          style={styles.wagerRow(
                            selectedWager?.ticketId === w.ticketId,
                          )}
                          onClick={() => setSelectedWager(w)}
                        >
                          <td style={styles.td}>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                              }}
                            >
                              <span
                                style={{
                                  fontFamily:
                                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                  fontWeight: 700,
                                  color: "#38bdf8",
                                }}
                              >
                                #{w.ticketId}
                              </span>
                              <button
                                type="button"
                                style={{
                                  background: "none",
                                  border: "none",
                                  cursor: "pointer",
                                  fontSize: "11px",
                                  color: "#94a3b8",
                                  padding: "0 2px",
                                }}
                                title="Copy Ticket ID"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigator.clipboard.writeText(w.ticketId);
                                  setCopiedTicketId(w.ticketId);
                                  setTimeout(
                                    () => setCopiedTicketId(null),
                                    1500,
                                  );
                                }}
                              >
                                {copiedTicketId === w.ticketId ? "✓" : "📋"}
                              </button>
                            </div>
                            <div style={styles.custSub}>{w.timestamp}</div>
                          </td>
                          <td style={styles.td}>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                              }}
                            >
                              <span
                                style={{
                                  ...styles.custLink,
                                  cursor: "pointer",
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const found = SAMPLE_PROFILE_DATA.find(
                                    (c) => c.id === w.customerId,
                                  );
                                  if (found) {
                                    setSelectedCustomer(found);
                                    setActiveTab("customers");
                                  }
                                }}
                                title="Inspect full profile in Customer Showcase"
                              >
                                {w.customerId}
                              </span>
                              <a
                                href={`https://fantasy402.com/manager.html?customer=${w.customerId}`}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  color: "#94a3b8",
                                  textDecoration: "none",
                                  fontSize: "11px",
                                }}
                                onClick={(e) => e.stopPropagation()}
                                title="Open in Fantasy402 Manager Portal"
                              >
                                ↗
                              </a>
                            </div>
                          </td>
                          <td style={styles.td}>
                            <div>
                              <a
                                href={`https://desk.bookdeskops.com/agent/${w.agentId}`}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  color: "#38bdf8",
                                  textDecoration: "none",
                                  fontWeight: 600,
                                }}
                                onClick={(e) => e.stopPropagation()}
                                title="Open Agent Desk Profile"
                              >
                                {w.agentId} ↗
                              </a>
                            </div>
                            <div style={styles.custSub}>
                              Master: {w.masterAgent}
                            </div>
                          </td>
                          <td style={styles.td}>
                            <div style={{ fontWeight: 600 }}>{w.sport}</div>
                            <div style={styles.custSub}>{w.betType}</div>
                          </td>
                          <td style={styles.td}>
                            <div style={{ fontWeight: 600 }}>{w.event}</div>
                            <div style={{ color: "#f59e0b", fontWeight: 700 }}>
                              {w.selection} {w.lineDisplay} ({w.oddsAmerican})
                            </div>
                          </td>
                          <td style={styles.td}>
                            <div style={{ fontWeight: 600 }}>
                              ${w.riskUsd.toLocaleString()}
                            </div>
                            <div style={styles.custSub}>
                              To Win: ${w.toWinUsd.toLocaleString()}
                            </div>
                          </td>
                          <td style={styles.td}>
                            <span
                              style={{
                                fontWeight: 700,
                                color:
                                  w.clvCents > 0
                                    ? w.clvCents >= 10
                                      ? "#ef4444"
                                      : "#f59e0b"
                                    : "#4ade80",
                              }}
                            >
                              {w.clvCents > 0
                                ? `+${w.clvCents}¢`
                                : `${w.clvCents}¢`}
                            </span>
                          </td>
                          <td style={styles.td}>
                            <span
                              style={styles.wagerBadge(
                                w.alertTier,
                                tiersConfig,
                              )}
                            >
                              {w.alertBadge}
                            </span>
                          </td>
                          <td style={styles.td}>
                            <div
                              style={{
                                fontSize: "11px",
                                color:
                                  w.alertTier === "CRITICAL" ||
                                  w.alertTier === "STEAM"
                                    ? "#f87171"
                                    : "#4ade80",
                                fontWeight: 600,
                              }}
                            >
                              {w.operatorDirective}
                            </div>
                            <div style={styles.custSub}>
                              Cap: ${w.maxRecommendedStake.toLocaleString()}
                            </div>
                          </td>
                          <td style={styles.td}>
                            <div style={{ display: "flex", gap: "6px" }}>
                              <button
                                type="button"
                                style={{
                                  ...styles.actionBtn,
                                  padding: "4px 8px",
                                  fontSize: "11px",
                                  cursor: "pointer",
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveTab("terminal");
                                  runTerminalCommand(
                                    `profile ${w.customerId} --radar`,
                                  );
                                }}
                                title="Inspect Customer in PTY Terminal"
                              >
                                💻 PTY
                              </button>
                              <a
                                href={`https://fantasy402.com/manager.html?customer=${w.customerId}`}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  ...styles.actionBtn,
                                  padding: "4px 8px",
                                  fontSize: "11px",
                                  textDecoration: "none",
                                  color: "#0f172a",
                                }}
                                onClick={(e) => e.stopPropagation()}
                                title="Open Customer in Portal"
                              >
                                Portal ↗
                              </a>
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Interactive Selected Wager Inspector */}
            {selectedWager && (
              <div style={styles.wagerInspectorCard}>
                <div style={styles.inspectorHeader}>
                  <div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        marginBottom: "4px",
                      }}
                    >
                      <h3
                        style={{
                          margin: 0,
                          fontSize: "18px",
                          color: "#f8fafc",
                        }}
                      >
                        Ticket Inspector: #{selectedWager.ticketId}
                      </h3>
                      <span
                        style={styles.wagerBadge(
                          selectedWager.alertTier,
                          tiersConfig,
                        )}
                      >
                        {selectedWager.alertBadge}
                      </span>
                    </div>
                    <div style={styles.inspectorSub}>
                      Placed {selectedWager.timestamp} · Sport:{" "}
                      {selectedWager.sport} · Market: {selectedWager.betType} ·
                      Line: {selectedWager.lineDisplay} (
                      {selectedWager.oddsAmerican})
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      style={styles.actionBtn}
                      onClick={() => {
                        setActiveTab("terminal");
                        runTerminalCommand(
                          `profile ${selectedWager.customerId} --radar`,
                        );
                      }}
                      title="Inspect Customer in Terminal PTY"
                    >
                      💻 PTY Profile
                    </button>
                    <button
                      type="button"
                      style={styles.actionBtn}
                      onClick={() => {
                        const cust = SAMPLE_PROFILE_DATA.find(
                          (c) => c.id === selectedWager.customerId,
                        );
                        if (cust) {
                          setSelectedCustomer(cust);
                          setActiveTab("customers");
                        }
                      }}
                      title="Inspect in Customer Showcase"
                    >
                      👤 Customer Card
                    </button>
                    <button
                      type="button"
                      style={styles.actionBtn}
                      onClick={() => {
                        navigator.clipboard.writeText(
                          JSON.stringify(selectedWager, null, 2),
                        );
                        setCopiedTicketId(selectedWager.ticketId);
                        setTimeout(() => setCopiedTicketId(null), 1500);
                      }}
                      title="Copy Full Ticket Payload"
                    >
                      {copiedTicketId === selectedWager.ticketId
                        ? "✓ Payload Copied"
                        : "📋 Copy Payload"}
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: "12px",
                    marginBottom: "16px",
                  }}
                >
                  <div style={styles.radarCard}>
                    <div style={styles.cardHeader}>EVENT & SELECTION</div>
                    <div
                      style={{
                        fontSize: "13px",
                        fontWeight: 700,
                        color: "#f8fafc",
                        marginBottom: "4px",
                      }}
                    >
                      {selectedWager.event}
                    </div>
                    <div
                      style={{
                        fontSize: "12px",
                        color: "#f59e0b",
                        fontWeight: 600,
                      }}
                    >
                      Pick: {selectedWager.selection}{" "}
                      {selectedWager.lineDisplay} ({selectedWager.oddsAmerican})
                    </div>
                  </div>

                  <div style={styles.radarCard}>
                    <div style={styles.cardHeader}>
                      FINANCIAL EXPOSURE & EDGE
                    </div>
                    <div style={styles.radarRow}>
                      <span style={{ color: "#94a3b8" }}>Risk / To Win:</span>
                      <span style={{ fontWeight: 700, color: "#f8fafc" }}>
                        ${selectedWager.riskUsd.toLocaleString()} / $
                        {selectedWager.toWinUsd.toLocaleString()}
                      </span>
                    </div>
                    <div style={styles.radarRow}>
                      <span style={{ color: "#94a3b8" }}>CLV Edge Delta:</span>
                      <span
                        style={{
                          fontWeight: 700,
                          color:
                            selectedWager.clvCents > 0
                              ? selectedWager.clvCents >= 10
                                ? "#ef4444"
                                : "#f59e0b"
                              : "#4ade80",
                        }}
                      >
                        {selectedWager.clvCents > 0
                          ? `+${selectedWager.clvCents}¢`
                          : `${selectedWager.clvCents}¢`}
                      </span>
                    </div>
                  </div>

                  <div style={styles.radarCard}>
                    <div style={styles.cardHeader}>
                      AGENT & SYNDICATE ROUTING
                    </div>
                    <div style={styles.radarRow}>
                      <span style={{ color: "#94a3b8" }}>Customer Login:</span>
                      <span style={{ fontWeight: 700, color: "#38bdf8" }}>
                        {selectedWager.customerId}
                      </span>
                    </div>
                    <div style={styles.radarRow}>
                      <span style={{ color: "#94a3b8" }}>
                        Sub-Agent / Master:
                      </span>
                      <span style={{ fontWeight: 600, color: "#f8fafc" }}>
                        {selectedWager.agentId} / {selectedWager.masterAgent}
                      </span>
                    </div>
                  </div>

                  <div style={styles.radarCard}>
                    <div style={styles.cardHeader}>
                      DESK DIRECTIVE (autoExecute: false)
                    </div>
                    <div
                      style={{
                        fontSize: "12px",
                        fontWeight: 700,
                        color:
                          selectedWager.alertTier === "CRITICAL" ||
                          selectedWager.alertTier === "STEAM"
                            ? "#f87171"
                            : "#4ade80",
                        marginBottom: "4px",
                      }}
                    >
                      {selectedWager.operatorDirective}
                    </div>
                    <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                      Max Recommended Stake: $
                      {selectedWager.maxRecommendedStake.toLocaleString()}
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: "6px",
                    backgroundColor:
                      selectedWager.alertTier === "CRITICAL"
                        ? "rgba(239, 68, 68, 0.12)"
                        : selectedWager.alertTier === "STEAM"
                          ? "rgba(251, 146, 60, 0.12)"
                          : "rgba(34, 197, 94, 0.12)",
                    border: `1px solid ${
                      selectedWager.alertTier === "CRITICAL"
                        ? "rgba(239, 68, 68, 0.3)"
                        : selectedWager.alertTier === "STEAM"
                          ? "rgba(251, 146, 60, 0.3)"
                          : "rgba(34, 197, 94, 0.3)"
                    }`,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div style={{ fontSize: "12px", color: "#f1f5f9" }}>
                    <b>Action Directive:</b> {selectedWager.operatorDirective} ·
                    Safety Invariant: <code>autoExecute: false</code> (Requires
                    operator manual override in Fantasy402 Manager)
                  </div>
                  <span
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      fontWeight: 600,
                    }}
                  >
                    Cap: ${selectedWager.maxRecommendedStake.toLocaleString()}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
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

      {/* Operator Shift Summary & Handoff Modal */}
      {isShiftModalOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(3, 7, 18, 0.75)",
            backdropFilter: "blur(6px)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsShiftModalOpen(false);
          }}
        >
          <div
            style={{
              width: "580px",
              maxWidth: "100%",
              backgroundColor: "#0d1527",
              border: "1px solid #1e293b",
              borderRadius: "12px",
              boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)",
              overflow: "hidden",
            }}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: "16px 20px",
                borderBottom: "1px solid #1e293b",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "rgba(15, 23, 42, 0.6)",
              }}
            >
              <div
                style={{ display: "flex", alignItems: "center", gap: "10px" }}
              >
                <span style={{ fontSize: "18px" }}>📋</span>
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", color: "#f8fafc" }}>
                    Operator Shift Handoff Summary
                  </h3>
                  <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                    Surveillance alerts, DLQ disposition, and security audit log
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsShiftModalOpen(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#94a3b8",
                  fontSize: "18px",
                  cursor: "pointer",
                  padding: "4px 8px",
                }}
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div
              style={{
                padding: "20px",
                display: "flex",
                flexDirection: "column",
                gap: "16px",
              }}
            >
              {/* Operator & Window Selector */}
              <div
                style={{
                  display: "flex",
                  gap: "10px",
                  alignItems: "center",
                  background: "#131d35",
                  padding: "10px 14px",
                  borderRadius: "8px",
                  border: "1px solid #1e293b",
                }}
              >
                <label
                  style={{
                    fontSize: "12px",
                    color: "#94a3b8",
                    fontWeight: 600,
                  }}
                >
                  Operator:
                </label>
                <input
                  value={shiftOperator}
                  onChange={(e) => setShiftOperator(e.target.value)}
                  style={{
                    background: "#070b14",
                    border: "1px solid #334155",
                    color: "#f1f5f9",
                    padding: "4px 8px",
                    borderRadius: "4px",
                    fontSize: "12px",
                    flex: 1,
                  }}
                  placeholder="operator_id"
                />
                <button
                  type="button"
                  onClick={() => fetchShiftSummary(shiftOperator)}
                  disabled={shiftLoading}
                  style={{
                    padding: "4px 10px",
                    borderRadius: "4px",
                    fontSize: "12px",
                    fontWeight: 600,
                    background: "#2563eb",
                    border: "none",
                    color: "#ffffff",
                    cursor: shiftLoading ? "wait" : "pointer",
                  }}
                >
                  {shiftLoading ? "..." : "Refresh"}
                </button>
              </div>

              {/* Shift Date Label */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "11px",
                  color: "#94a3b8",
                }}
              >
                <span>
                  <b>Handoff Window:</b> {shiftSummary?.date ?? "Today"}{" "}
                  (Rolling 24h & Shift Span)
                </span>
                <span>
                  <b>Audit Ledger:</b> JSONL Verified
                </span>
              </div>

              {/* Shift Metrics Grid */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, 1fr)",
                  gap: "10px",
                }}
              >
                <div
                  style={{
                    background: "#0a1020",
                    border: "1px solid #1e293b",
                    borderRadius: "8px",
                    padding: "12px 14px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      marginBottom: "4px",
                    }}
                  >
                    Total Surveillance Alerts
                  </div>
                  <div
                    style={{
                      fontSize: "20px",
                      fontWeight: 700,
                      color: "#38bdf8",
                    }}
                  >
                    {shiftSummary?.totalAlerts ?? 0}
                  </div>
                  <div style={{ fontSize: "10px", color: "#64748b" }}>
                    Classified by TOML risk engine
                  </div>
                </div>

                <div
                  style={{
                    background: "#0a1020",
                    border: "1px solid #1e293b",
                    borderRadius: "8px",
                    padding: "12px 14px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      marginBottom: "4px",
                    }}
                  >
                    Delivered to Telegram
                  </div>
                  <div
                    style={{
                      fontSize: "20px",
                      fontWeight: 700,
                      color: "#4ade80",
                    }}
                  >
                    {shiftSummary?.deliveredAlerts ?? 0}
                  </div>
                  <div style={{ fontSize: "10px", color: "#64748b" }}>
                    200 OK from Bot API
                  </div>
                </div>

                <div
                  style={{
                    background: "#0a1020",
                    border: "1px solid #1e293b",
                    borderRadius: "8px",
                    padding: "12px 14px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      marginBottom: "4px",
                    }}
                  >
                    Dead-Letter DLQ Alerts
                  </div>
                  <div
                    style={{
                      fontSize: "20px",
                      fontWeight: 700,
                      color:
                        (shiftSummary?.deadLetterAlerts ?? 0) > 0
                          ? "#f87171"
                          : "#4ade80",
                    }}
                  >
                    {shiftSummary?.deadLetterAlerts ?? 0}
                  </div>
                  <div style={{ fontSize: "10px", color: "#64748b" }}>
                    Exceeded retry ceiling
                  </div>
                </div>

                <div
                  style={{
                    background: "#0a1020",
                    border: "1px solid #1e293b",
                    borderRadius: "8px",
                    padding: "12px 14px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      marginBottom: "4px",
                    }}
                  >
                    Operator Acknowledged
                  </div>
                  <div
                    style={{
                      fontSize: "20px",
                      fontWeight: 700,
                      color: "#c084fc",
                    }}
                  >
                    {shiftSummary?.acknowledgedAlerts ?? 0}
                  </div>
                  <div style={{ fontSize: "10px", color: "#64748b" }}>
                    Cleared via Ack or Replay
                  </div>
                </div>

                <div
                  style={{
                    background: "#0a1020",
                    border: "1px solid #1e293b",
                    borderRadius: "8px",
                    padding: "12px 14px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      marginBottom: "4px",
                    }}
                  >
                    Delivery Retries & Errors
                  </div>
                  <div
                    style={{
                      fontSize: "20px",
                      fontWeight: 700,
                      color: "#fbbf24",
                    }}
                  >
                    {shiftSummary?.failedAttempts ?? 0}
                  </div>
                  <div style={{ fontSize: "10px", color: "#64748b" }}>
                    429 backoff or network retries
                  </div>
                </div>

                <div
                  style={{
                    background: "#0a1020",
                    border: "1px solid #1e293b",
                    borderRadius: "8px",
                    padding: "12px 14px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      marginBottom: "4px",
                    }}
                  >
                    PTY Terminal Commands
                  </div>
                  <div
                    style={{
                      fontSize: "20px",
                      fontWeight: 700,
                      color: "#e2e8f0",
                    }}
                  >
                    {shiftSummary?.terminalCommandsCount ?? 0}
                  </div>
                  <div style={{ fontSize: "10px", color: "#64748b" }}>
                    Interactive terminal forensics
                  </div>
                </div>
              </div>

              {/* Handoff Status Note */}
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: "6px",
                  background:
                    (shiftSummary?.deadLetterAlerts ?? 0) > 0
                      ? "rgba(239, 68, 68, 0.1)"
                      : "rgba(34, 197, 94, 0.1)",
                  border: `1px solid ${
                    (shiftSummary?.deadLetterAlerts ?? 0) > 0
                      ? "#ef4444"
                      : "#22c55e"
                  }`,
                  fontSize: "12px",
                  color:
                    (shiftSummary?.deadLetterAlerts ?? 0) > 0
                      ? "#f87171"
                      : "#4ade80",
                }}
              >
                {(shiftSummary?.deadLetterAlerts ?? 0) > 0
                  ? `⚠️ Handoff Warning: ${shiftSummary?.deadLetterAlerts} dead alert(s) in DLQ require operator acknowledgment or replay before shift close.`
                  : "✓ Shift Handoff Ready: Zero dead-letter alerts pending. All critical and steam wagers accounted for."}
              </div>
            </div>

            {/* Modal Footer */}
            <div
              style={{
                padding: "12px 20px",
                borderTop: "1px solid #1e293b",
                display: "flex",
                justifyContent: "flex-end",
                background: "rgba(15, 23, 42, 0.6)",
              }}
            >
              <button
                type="button"
                onClick={() => setIsShiftModalOpen(false)}
                style={{
                  padding: "6px 16px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontWeight: 600,
                  background: "#1e293b",
                  border: "1px solid #334155",
                  color: "#f1f5f9",
                  cursor: "pointer",
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  container: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    backgroundColor: "#070b14",
    color: "#f1f5f9",
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column" as const,
  },
  header: {
    padding: "14px 24px",
    backgroundColor: "#0d1527",
    borderBottom: "1px solid #1e293b",
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "12px",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerLeft: {
    display: "flex",
    flexWrap: "wrap" as const,
    alignItems: "center",
    gap: "10px",
  },
  title: {
    margin: 0,
    fontSize: "20px",
    fontWeight: 700,
    color: "#f1f5f9",
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
    flexWrap: "wrap" as const,
    gap: "6px",
  },
  tabBtn: (active: boolean) => ({
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "7px 12px",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
    cursor: "pointer",
    backgroundColor: active ? "#38bdf8" : "#1e293b",
    color: active ? "#0f172a" : "#94a3b8",
    border: "none",
    transition: "all 0.15s ease",
  }),
  keyShortcutBadge: {
    marginLeft: "2px",
    padding: "1px 5px",
    borderRadius: "4px",
    fontSize: "10px",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontWeight: 600,
    backgroundColor: "rgba(15, 23, 42, 0.22)",
    opacity: 0.85,
  },
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
      color = "#f59e0b";
      bg = "rgba(245, 158, 11, 0.2)";
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
    position: "sticky" as const,
    top: "20px",
    maxHeight: "calc(100vh - 40px)",
    overflowY: "auto" as const,
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
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "6px",
    padding: "0 10px",
    flex: "1 1 320px",
  },
  searchIcon: {
    color: "#64748b",
    marginRight: "6px",
    fontSize: "14px",
  },
  tierFilterGroup: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "6px",
  },
  filterPill: (active: boolean) => ({
    padding: "6px 12px",
    borderRadius: "16px",
    fontSize: "11px",
    fontWeight: 600,
    cursor: "pointer",
    backgroundColor: active ? "rgba(56, 189, 248, 0.2)" : "#0d1527",
    color: active ? "#38bdf8" : "#94a3b8",
    border: `1px solid ${active ? "#38bdf8" : "#1e293b"}`,
    transition: "all 0.15s ease",
  }),
  tableCard: {
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "8px",
    padding: "16px",
    overflow: "hidden",
    minWidth: 0,
  },
  tableHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "12px",
  },
  tableTitle: {
    margin: 0,
    fontSize: "15px",
    fontWeight: 700,
    color: "#f8fafc",
  },
  tableScroll: {
    overflowX: "auto" as const,
    minWidth: 0,
  },
  custLogin: {
    fontWeight: 700,
    color: "#38bdf8",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  wagerBadge: (
    tier: string,
    dynamic?: Record<string, { fg: string; bg: string; border: string }> | null,
  ): React.CSSProperties => {
    if (dynamic && tier in dynamic) {
      const t = dynamic[tier]!;
      return {
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "4px",
        fontSize: "11px",
        fontWeight: 600,
        whiteSpace: "nowrap",
        color: t.fg,
        backgroundColor: t.bg,
        border: `1px solid ${t.border}`,
      };
    }
    return wagerBadge(tier);
  },
  wagerRow: (selected: boolean) => ({
    cursor: "pointer",
    backgroundColor: selected ? "rgba(56, 189, 248, 0.08)" : "transparent",
    borderLeft: selected ? "3px solid #38bdf8" : "3px solid transparent",
    transition: "background-color 0.15s ease",
  }),
  wagerInspectorCard: {
    marginTop: "20px",
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "8px",
    padding: "20px",
  },
};
