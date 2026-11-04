/**
 * @file lib/gslive_manager_watchlist.ts
 * @description Canonical Cross-Venue Watchlist & GSLive Manager (`https://plive.sportswidgets.pro/manager-tools/`)
 *              Integration Module (`player_[customerlogin]` Widget & `getBetReport` Contract).
 *
 * Enforces the 4-Part Identity Tuple on every Watchlist Entity:
 *   1. `customerLogin`    : Exact Fantasy402 Customer Login ID (`Login` / `CustomerID`, e.g., `"BGD101"`, `"MJ102"`, `"CB112_1"`, `"BB5127"`)
 *   2. `agentId`          : Direct owning Fantasy402 Sub-Agent (`AgentID`, e.g., `"BIGDAD"`, `"MJ2026"`, `"CUB22HR"`, `"ATEAM"`)
 *   3. `gsLivePlayerId`   : GSLive Manager Partner 118 Widget Identifier (`player_[customerlogin]`, e.g., `"player_BGD101"`, `"player_MJ102"`, `"player_CB112_1"`)
 *   4. `proxyWallet`      : Bridged Polymarket CTF `0x` Proxy Wallet (or `null` for internal-only F402 sharp accounts)
 */

import {
  GSLIVE_MANAGER_BASE_URL as CANONICAL_GSLIVE_MANAGER_BASE_URL,
  addDaysYmd,
  buildGsLiveManagerSurfaceUrls,
  computeDeskDayStartEpochSeconds,
  computeDeskDayToTimeSeconds,
  formatGsLivePlayerToken,
  resolveDeskDateYmd,
} from "./gslive_manager_deeplink_sidecar.ts";

export const GSLIVE_MANAGER_BASE_URL = CANONICAL_GSLIVE_MANAGER_BASE_URL;
export const GSLIVE_MANAGER_ORIGIN = CANONICAL_GSLIVE_MANAGER_BASE_URL.replace(
  /\/manager-tools\/$/,
  "",
) as "https://plive.sportswidgets.pro";
export const GSLIVE_PARTNER_ID = "118" as const;

export interface GsLiveManagerUrls {
  readonly gsLivePlayerId: string;
  readonly playerReportUrl: string;
  readonly bettorReportUrl: string;
  readonly openBetReportUrl: string;
  readonly betHistoryUrl: string;
  readonly summaryByPlayerUrl: string;
}

export interface WatchlistUnifiedEntry {
  readonly rank: number;
  readonly customerLogin: string;
  readonly paddedCustomerId11: string;
  readonly gsLivePlayerId: string;
  readonly agentId: string;
  readonly masterAgentId: string;
  readonly proxyWallet: string | null;
  readonly shortWallet: string | null;
  readonly sourceCategory:
    | "POLY_ONCHAIN_CTF_WHALE"
    | "POLY_PARLAY_SYNDICATE"
    | "SUBNET_BRIDGED_SHARP"
    | "SIX_GATE_BET1_DISCOVERY"
    | "INTERNAL_F402_SHARP"
    | "FUNDING_DISTRIBUTOR_ROOT";
  readonly archetype: string;
  readonly hasPendingWagers: boolean;
  readonly openLegsCount: number;
  readonly openVolumeUsd: number;
  readonly primaryRotations: readonly string[];
  readonly openBetsSummary: string;
  readonly alertPipeline: string;
  readonly enforcementStatus: string;
  readonly f402CustomerProfileUrl: string;
  readonly polymarketProfileUrl: string | null;
  readonly polymarketPositionsApiUrl: string | null;
  readonly polygonscanUrl: string | null;
  readonly gsLiveUrls: GsLiveManagerUrls;
}

/**
 * Formats a raw Fantasy402 customer login into GSLive Manager's `player_[customerlogin]` identifier.
 * Delegates to the canonical formatter so every surface agrees (including `FUNDING_ROOT`).
 */
export function toGsLivePlayerId(customerLogin: string): string {
  return formatGsLivePlayerToken(customerLogin);
}

/**
 * Extracts the raw Fantasy402 `customerLogin` from either `"MJ102"` or `"player_MJ102"`.
 */
export function fromGsLivePlayerId(input: string): string {
  return input
    .trim()
    .replace(/^player_/i, "")
    .toUpperCase();
}

/**
 * Builds the GSLive Manager widget deep links for one account.
 * Delegates to `buildGsLiveManagerSurfaceUrls`: the canonical 7-parameter user-report query
 * (bot=true + ISO desk-day window) is reused for the sibling report routes, and the bet-history
 * link carries the full `from`/`to`/`toTime`/`dateFilterBy` sidecar contract instead of a bare
 * `partnerUserId` (which rendered an empty grid).
 */
export function buildGsLiveManagerUrls(
  customerLogin: string,
  options?: { readonly dateYmd?: string; readonly tickEpochMs?: number },
): GsLiveManagerUrls {
  const surfaces = buildGsLiveManagerSurfaceUrls({
    customerLogin,
    ...(options?.dateYmd ? { dateYmd: options.dateYmd } : {}),
    ...(options?.tickEpochMs ? { tickEpochMs: options.tickEpochMs } : {}),
  });

  return {
    gsLivePlayerId: surfaces.gsLivePlayerId,
    playerReportUrl: surfaces.playerReportUrl,
    bettorReportUrl: surfaces.bettorReportUrl,
    openBetReportUrl: surfaces.openBetReportUrl,
    betHistoryUrl: surfaces.betHistoryUrl,
    summaryByPlayerUrl: surfaces.summaryByPlayerUrl,
  };
}

/**
 * Builds the observed GSLive `getBetReport` payload with `partnerUserId` as the raw login
 * (e.g. `AF12`), matching the live `#/events/bet-history` filter.
 */
export function buildGsLiveGetBetReportPayload(options: {
  customerLogin: string;
  agentId?: string;
  betGroupId?: string;
  eventId?: string;
  sId?: string;
  fromEpochSec?: number;
  toEpochSec?: number;
  period?: string;
}) {
  const dateYmd = resolveDeskDateYmd();
  const dayStartEpoch = computeDeskDayStartEpochSeconds(dateYmd);
  const dayEndEpoch =
    computeDeskDayStartEpochSeconds(addDaysYmd(dateYmd, 1)) - 1;
  const toTimeSec = computeDeskDayToTimeSeconds(dateYmd);
  return {
    action: "getBetReport" as const,
    partnerUserId: fromGsLivePlayerId(options.customerLogin),
    agent: options.agentId ? options.agentId.trim().toUpperCase() : "",
    eventId: options.eventId ?? "",
    freeBetId: "",
    state: "",
    sId: options.sId ?? "2",
    minVolume: "0",
    maxTimeUntilScore: "0",
    mId: "",
    from: options.fromEpochSec ?? dayStartEpoch,
    fromTime: 0,
    to: options.toEpochSec ?? dayEndEpoch,
    toTime: toTimeSec,
    betId: "",
    betGroupId: options.betGroupId ?? "",
    group: null,
    dateFilterBy: "calcTime",
    partnerIds: "",
    period: options.period ?? "s3",
  };
}

const RAW_BRIDGED_WATCHLIST: ReadonlyArray<{
  rank: number;
  proxyWallet: string | null;
  customerLogin: string;
  agentId: string;
  category: WatchlistUnifiedEntry["sourceCategory"];
  archetype: string;
  openVolumeUsd: number;
  openLegsCount: number;
  primaryRotations: readonly string[];
  openBetsSummary: string;
  enforcementStatus: string;
}> = [
  // 1-12: Core On-Chain CTF Whales & 6-Gate Bet #1 Discoveries
  {
    rank: 1,
    proxyWallet: "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
    customerLogin: "BGD101",
    agentId: "BIGDAD",
    category: "POLY_ONCHAIN_CTF_WHALE",
    archetype: "On-Chain CTF Whale #1 (64 Positions)",
    openVolumeUsd: 73300,
    openLegsCount: 14,
    primaryRotations: ["ROT 465", "ROT 5501", "ROT 315"],
    openBetsSummary:
      "KC -1.5 Wk10 ($18K), LAL Alt -7.5 ($24K), CFB Combos ($31.3K)",
    enforcementStatus: "Ban-Hammer $1K / 6s",
  },
  {
    rank: 2,
    proxyWallet: "0x07db5765beba17be154cbfbd6324a15f3c81fa4f",
    customerLogin: "MJ102",
    agentId: "MJ2026",
    category: "POLY_ONCHAIN_CTF_WHALE",
    archetype: "On-Chain CTF Whale #2 (NBA Key-3 & 1Q)",
    openVolumeUsd: 60600,
    openLegsCount: 12,
    primaryRotations: ["ROT 501", "ROT 507"],
    openBetsSummary:
      "LAL/BOS 1Q O55.5 ($16.2K), LAL -3.0 ($26.4K), GSW 3Q -1.5 ($18K)",
    enforcementStatus: "Ban-Hammer + FG-Only",
  },
  {
    rank: 3,
    proxyWallet: "0x91aF0041c882d190e4412a9b77c01f98a220f112",
    customerLogin: "MJ103",
    agentId: "MJ2026",
    category: "SIX_GATE_BET1_DISCOVERY",
    archetype: "6-Gate Discovery #1 (99.3% Cosine to MJ102)",
    openVolumeUsd: 25500,
    openLegsCount: 6,
    primaryRotations: ["ROT 501"],
    openBetsSummary: "LAL/BOS 1Q O55.5 ($11.5K), LAL -3.0 ($14.0K)",
    enforcementStatus: "Caught Bet #1 (<320ms)",
  },
  {
    rank: 4,
    proxyWallet: "0x50cc8708aff3791f2d6125645c82bda532baa534",
    customerLogin: "EJ8834",
    agentId: "MJ2026",
    category: "POLY_ONCHAIN_CTF_WHALE",
    archetype: "On-Chain CTF Sniper #7 (Subnet 104.28.34.0/24)",
    openVolumeUsd: 40300,
    openLegsCount: 9,
    primaryRotations: ["ROT 501", "ROT 507"],
    openBetsSummary:
      "LAL/BOS 1Q O55.5 ($9.8K), SAC +4.5 ($11.5K), GSW 3Q -1.5 ($19K)",
    enforcementStatus: "Ban-Hammer $1K / 6s",
  },
  {
    rank: 5,
    proxyWallet: "0x44cB8812e901a345b778c120d99e34a11200a881",
    customerLogin: "EJ8835",
    agentId: "MJ2026",
    category: "SIX_GATE_BET1_DISCOVERY",
    archetype: "6-Gate Discovery #2 (98.8% Cosine to EJ8834)",
    openVolumeUsd: 25700,
    openLegsCount: 6,
    primaryRotations: ["ROT 501", "ROT 507"],
    openBetsSummary: "LAL/BOS 1Q O55.5 ($8.7K), GSW 3Q -1.5 ($17K)",
    enforcementStatus: "Caught Bet #1 (<320ms)",
  },
  {
    rank: 6,
    proxyWallet: "0x120640a1deffe6b53e291eba74acf1dbe8274528",
    customerLogin: "GP300",
    agentId: "GPRO50RSK",
    category: "POLY_ONCHAIN_CTF_WHALE",
    archetype: "On-Chain CTF Whale #3 (NBA Celtics Key-6)",
    openVolumeUsd: 31900,
    openLegsCount: 9,
    primaryRotations: ["ROT 501", "ROT 511"],
    openBetsSummary:
      "LAL/BOS 1Q O55.5 ($9.5K), BOS TT O118.5 ($3.5K), Key-6 ($18.9K)",
    enforcementStatus: "6s Delay + 20c SGP Tax",
  },
  {
    rank: 7,
    proxyWallet: "0x53224176b413f20ac63d61f1a0e19002ffb38acb",
    customerLogin: "AT10359",
    agentId: "ATEAM",
    category: "POLY_ONCHAIN_CTF_WHALE",
    archetype: "On-Chain CTF Whale #4 (NBA Totals Steam)",
    openVolumeUsd: 35400,
    openLegsCount: 8,
    primaryRotations: ["ROT 505", "ROT 509"],
    openBetsSummary:
      "IND/SAC 1H O123.5 ($14.5K), DEN 2Q U54.5 ($16.4K), DEN U223.5 ($4.5K rem)",
    enforcementStatus: "FG-Only + Trap Resolved",
  },
  {
    rank: 8,
    proxyWallet: "0x22e29a644a9d14564967b3f9f50346b7ad425c32",
    customerLogin: "ABC700",
    agentId: "JUICEPLUS",
    category: "POLY_ONCHAIN_CTF_WHALE",
    archetype: "On-Chain CTF Sharp #5 (NBA+CFB Parlays)",
    openVolumeUsd: 22700,
    openLegsCount: 7,
    primaryRotations: ["ROT 501", "ROT 511"],
    openBetsSummary:
      "LAL/BOS 1Q O55.5 ($8.5K), BOS TT O118.5 ($4.0K), BOS 4Q +1.5 ($10.2K)",
    enforcementStatus: "+15c/+20c Vig Shaded",
  },
  {
    rank: 9,
    proxyWallet: "0x231699490d08919d8f1d3f0b90fd2a677e3e9819",
    customerLogin: "DAN245",
    agentId: "DAN318",
    category: "POLY_ONCHAIN_CTF_WHALE",
    archetype: "On-Chain CTF Sharp #6 (High-CLV Extractor)",
    openVolumeUsd: 24300,
    openLegsCount: 7,
    primaryRotations: ["ROT 465", "ROT 511"],
    openBetsSummary:
      "KC -1.5 Wk10 ($11.8K), BOS TT O118.5 ($3.5K), BOS 4Q +1.5 ($9.0K)",
    enforcementStatus: "Parlay Cap $5K + 15c",
  },
  {
    rank: 10,
    proxyWallet: "0xaa7789219c17e180dcb5933099c90d885f1d15a5",
    customerLogin: "DA4401",
    agentId: "JUICEPLUS",
    category: "POLY_ONCHAIN_CTF_WHALE",
    archetype: "On-Chain CTF Sniper #8 (+270 bps CLV)",
    openVolumeUsd: 21100,
    openLegsCount: 6,
    primaryRotations: ["ROT 507", "ROT 511"],
    openBetsSummary:
      "SAC +4.5 ($10.0K), BOS TT O118.5 ($3.0K), Whale Combo ($8.1K)",
    enforcementStatus: "Manual Approval >$2.5K",
  },
  {
    rank: 11,
    proxyWallet: "0x7a0da16a1205ee51a56fa862e8baa61e350eff14",
    customerLogin: "BCC1530",
    agentId: "SPEN",
    category: "POLY_ONCHAIN_CTF_WHALE",
    archetype: "On-Chain CTF Chaser #9 (Multi-Sport Steam)",
    openVolumeUsd: 16100,
    openLegsCount: 6,
    primaryRotations: ["ROT 505", "ROT 315"],
    openBetsSummary: "IND/SAC 1H O123.5 ($8.5K), Multi-Sport Combos ($7.6K)",
    enforcementStatus: "6s Dynamic Delay Gate",
  },
  {
    rank: 12,
    proxyWallet: "0x1eb93479b3425ad57aef1442be4624a27880f884",
    customerLogin: "DN2019",
    agentId: "SHARP66",
    category: "POLY_ONCHAIN_CTF_WHALE",
    archetype: "On-Chain CTF Sharp #10 (NBA 1H/FG Arb)",
    openVolumeUsd: 21000,
    openLegsCount: 6,
    primaryRotations: ["ROT 505"],
    openBetsSummary:
      "IND/SAC 1H O123.5 ($9.0K), SAC/NOP 1H U116.5 ($12K Shaded)",
    enforcementStatus: "Branch 3 Vig Shaded",
  },

  // 13-29: Polymarket Parlay Syndicate Wallets with Explicit Bridged Fantasy402 Customer Login IDs
  {
    rank: 13,
    proxyWallet: "0x3aF8c9104E2b78a142dE90B218a91D89D",
    customerLogin: "CB112_2",
    agentId: "CUB22HR",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "Baylor Tout Burst (Lead Wallet #1 • CUB22HR/CB112_2)",
    openVolumeUsd: 11700,
    openLegsCount: 5,
    primaryRotations: ["ROT 315", "ROT 341"],
    openBetsSummary: "TXST +14.5 ($7.5K Shadow), Baylor +3.5 / O47.5 ($4.2K)",
    enforcementStatus: "WSS Stepped @ 345ms",
  },
  {
    rank: 14,
    proxyWallet: "0x7bE21d08F449C0213A8E100c9f2A41c12",
    customerLogin: "CB112_3",
    agentId: "CUB22HR",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "Baylor Tout Burst (Syndicate #2 • CUB22HR/CB112_3)",
    openVolumeUsd: 9600,
    openLegsCount: 4,
    primaryRotations: ["ROT 315", "ROT 341"],
    openBetsSummary: "TXST +14.5 ($6.5K Shadow), Baylor +3.5 / O47.5 ($3.1K)",
    enforcementStatus: "WSS Stepped @ 345ms",
  },
  {
    rank: 15,
    proxyWallet: "0x9cD44e12A8b7F30192c44d8E11a08B3e7",
    customerLogin: "CUST_BAY_1",
    agentId: "BILLY666",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "Baylor Tout Burst (3rd Wallet Trigger • BILLY666/CUST_BAY_1)",
    openVolumeUsd: 8800,
    openLegsCount: 4,
    primaryRotations: ["ROT 315", "ROT 341"],
    openBetsSummary: "TXST +14.5 ($6.0K Shadow), Baylor +3.5 / O47.5 ($2.8K)",
    enforcementStatus: "DEDUP_THEN_LEAD Lock",
  },
  {
    rank: 16,
    proxyWallet: "0x1fA98b34C7d2E60154a91B2c33d09F4a1",
    customerLogin: "CB112_4",
    agentId: "CUB22HR",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "Baylor Tout Burst (Syndicate #4 • CUB22HR/CB112_4)",
    openVolumeUsd: 8000,
    openLegsCount: 4,
    primaryRotations: ["ROT 315", "ROT 341"],
    openBetsSummary: "TXST +14.5 ($5.5K Shadow), Baylor +3.5 / O47.5 ($2.5K)",
    enforcementStatus: "WSS Stepped @ 345ms",
  },
  {
    rank: 17,
    proxyWallet: "0x5eB67c89D1a4F20387b12C4d55e10A8c9",
    customerLogin: "MX920_1",
    agentId: "MAX92",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "Baylor Tout Burst (Syndicate #5 • MAX92/MX920_1)",
    openVolumeUsd: 7700,
    openLegsCount: 4,
    primaryRotations: ["ROT 315", "ROT 341"],
    openBetsSummary: "TXST +14.5 ($5.5K Shadow), Baylor +3.5 / O47.5 ($2.2K)",
    enforcementStatus: "WSS Stepped @ 345ms",
  },
  {
    rank: 18,
    proxyWallet: "0x8dC12f45E6b9A10476c23D5e66f21B7d4",
    customerLogin: "CUST_BAY_2",
    agentId: "BILLY666",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "Baylor Tout Burst (Syndicate #6 • BILLY666/CUST_BAY_2)",
    openVolumeUsd: 6900,
    openLegsCount: 4,
    primaryRotations: ["ROT 315", "ROT 341"],
    openBetsSummary: "TXST +14.5 ($5.0K Shadow), Baylor +3.5 / O47.5 ($1.9K)",
    enforcementStatus: "WSS Stepped @ 345ms",
  },
  {
    rank: 19,
    proxyWallet: "0x4aE39d78F2c1B50891d34E6f77a32C6e0",
    customerLogin: "CB112_5",
    agentId: "CUB22HR",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "Baylor Tout Burst (Syndicate #7 • CUB22HR/CB112_5)",
    openVolumeUsd: 6700,
    openLegsCount: 3,
    primaryRotations: ["ROT 315", "ROT 341"],
    openBetsSummary: "TXST +14.5 ($5.0K Shadow), Baylor +3.5 / O47.5 ($1.7K)",
    enforcementStatus: "WSS Stepped @ 345ms",
  },
  {
    rank: 20,
    proxyWallet: "0x2cB81a90D4e7F31265e45F7a88b43D9f2",
    customerLogin: "MM1012",
    agentId: "MOOSEM",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "Key-7 Teaser / Middle Extractor #1 (MOOSEM/MM1012)",
    openVolumeUsd: 21000,
    openLegsCount: 8,
    primaryRotations: ["ROT 451", "ROT 465"],
    openBetsSummary: "KC -1.5 Wk10 ($12.5K Shadow), NE -6.5 ($8.5K)",
    enforcementStatus: "Key 3/7 Crossing Guard",
  },
  {
    rank: 21,
    proxyWallet: "0x6fD92b01E5f8A42376f56A8b99c54E1a5",
    customerLogin: "MM1023",
    agentId: "MOOSEM",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "Key-7 Teaser / Middle Extractor #2 (MOOSEM/MM1023)",
    openVolumeUsd: 17500,
    openLegsCount: 7,
    primaryRotations: ["ROT 451", "ROT 465"],
    openBetsSummary: "KC -1.5 Wk10 ($10.5K Shadow), NE -6.5 ($7.0K)",
    enforcementStatus: "Key 3/7 Crossing Guard",
  },
  {
    rank: 22,
    proxyWallet: "0x0aE03c12F6a9B53487a67B9c00d65F2b8",
    customerLogin: "BL4402",
    agentId: "ATEAM",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "ATEAM Syndicate Downline & Key-7 Extractor (ATEAM/BL4402)",
    openVolumeUsd: 49500,
    openLegsCount: 9,
    primaryRotations: ["ROT 505", "ROT 509"],
    openBetsSummary:
      "IND/SAC 1H O123.5 ($9.5K), DEN 2Q U54.5 ($12K), PHI/MIL -4.5 ($28K)",
    enforcementStatus: "Branch 2 Moved -6.0",
  },
  {
    rank: 23,
    proxyWallet: "0x9bF14d23A7b0C64598b78C0d11e76A3c1",
    customerLogin: "FL3301",
    agentId: "DAN318",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "Key-7 Teaser / Subnet 104.28.38.0/24 Twin (DAN318/FL3301)",
    openVolumeUsd: 10000,
    openLegsCount: 5,
    primaryRotations: ["ROT 451"],
    openBetsSummary: "NE -6.5 ($4.0K), NFL Key-7 Middles ($6.0K)",
    enforcementStatus: "6pt Teaser @ -135",
  },
  {
    rank: 24,
    proxyWallet: "0x3dA25e34B8c1D75609c89D1e22f87B4d6",
    customerLogin: "AK1092",
    agentId: "GPRO50RSK",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "Prop & Tempo Stack Sniper #1 (GPRO50RSK/AK1092)",
    openVolumeUsd: 3500,
    openLegsCount: 3,
    primaryRotations: ["ROT 511"],
    openBetsSummary: "NFL/NBA Correlated Stacks ($3.5K)",
    enforcementStatus: "+25c Correlated Tax",
  },
  {
    rank: 25,
    proxyWallet: "0x7eB36f45C9d2E86710d90E2f33a98C5e9",
    customerLogin: "LG237",
    agentId: "ROBERTL",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "Prop & Tempo Stack Sniper #2 (ROBERTL/LG237)",
    openVolumeUsd: 2750,
    openLegsCount: 3,
    primaryRotations: ["ROT 511"],
    openBetsSummary: "NFL/NBA Correlated Stacks ($2.75K)",
    enforcementStatus: "+25c Correlated Tax",
  },
  {
    rank: 26,
    proxyWallet: "0x1cC47a56D0e3F97821e01F3a44b09D6f3",
    customerLogin: "CM5510",
    agentId: "SPEN",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "SPEN Downline Steam Partner (SPEN/CM5510)",
    openVolumeUsd: 9000,
    openLegsCount: 4,
    primaryRotations: ["ROT 505"],
    openBetsSummary: "IND/SAC 1H O123.5 ($7.0K Shadow), Stacks ($2.0K)",
    enforcementStatus: "6s Delay + +15c Vig",
  },
  {
    rank: 27,
    proxyWallet: "0x5fD58b67E1f4A08932f12A4b55c10E7a7",
    customerLogin: "RF2003",
    agentId: "FAKEMONEY",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "Cross-Sport CTF Whale Arbitrage (FAKEMONEY/RF2003)",
    openVolumeUsd: 12500,
    openLegsCount: 5,
    primaryRotations: ["ROT 507", "ROT 341"],
    openBetsSummary: "SAC +4.5 ($8.0K Shadow), NFL+NBA Combos ($4.5K)",
    enforcementStatus: "Single Bet Cap $5,000",
  },
  {
    rank: 28,
    proxyWallet: "0x3af8392189d021cfa82000000000000000021cfa",
    customerLogin: "CB112_1",
    agentId: "CUB22HR",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "Patriots Key-7 Proxy Attribution (CUB22HR/CB112_1)",
    openVolumeUsd: 6500,
    openLegsCount: 5,
    primaryRotations: ["ROT 451"],
    openBetsSummary: "NE -6.5 vs -7.5 ($6.5K Matched Parlay)",
    enforcementStatus: "Layoff Alert Bridged",
  },
  {
    rank: 29,
    proxyWallet: "0x3af8771189d099bf71000000000000000099bf71",
    customerLogin: "CUST_BAY_3",
    agentId: "BILLY666",
    category: "POLY_PARLAY_SYNDICATE",
    archetype: "Baylor Total 48 Whale Proxy (BILLY666/CUST_BAY_3)",
    openVolumeUsd: 18400,
    openLegsCount: 6,
    primaryRotations: ["ROT 341"],
    openBetsSummary: "Baylor Over 47.5 vs 48.0 ($18.4K Matched)",
    enforcementStatus: "Total 48 Window Frozen",
  },

  // 30-39: Newly Added Phase 6 Subnet Bridge & 6-Gate Discovery Wallets
  {
    rank: 30,
    proxyWallet: "0x88d199c044a210f877b312e900c412a881b999c0",
    customerLogin: "CHURN_059",
    agentId: "LAKERS",
    category: "SUBNET_BRIDGED_SHARP",
    archetype: "Subnet 192.168.9.0/24 Bridge (LAKERS/CHURN_059)",
    openVolumeUsd: 18000,
    openLegsCount: 4,
    primaryRotations: ["ROT 5501", "ROT 501"],
    openBetsSummary: "LAL Alt -10.5 ($18.0K); Blocked Alt+ML Subset Parlay",
    enforcementStatus: "Blocked (Probit ρ=0.756)",
  },
  {
    rank: 31,
    proxyWallet: "0x77c088b933f109e766a201d899b301f770a888b1",
    customerLogin: "CHURN_049",
    agentId: "SOUTHSHORE",
    category: "SUBNET_BRIDGED_SHARP",
    archetype: "Subnet 192.168.9.0/24 Twin (SOUTHSHORE/CHURN_049)",
    openVolumeUsd: 8200,
    openLegsCount: 4,
    primaryRotations: ["ROT 501"],
    openBetsSummary: "NBA 1H Derivative Spread ($8.2K)",
    enforcementStatus: "FG-Only Clamped",
  },
  {
    rank: 32,
    proxyWallet: "0x66b977a822e098d655f190c788a290e669f777a2",
    customerLogin: "CHURN_060",
    agentId: "KOBE24",
    category: "SUBNET_BRIDGED_SHARP",
    archetype: "Subnet 192.168.0.0/24 Bridge (KOBE24/CHURN_060)",
    openVolumeUsd: 6360,
    openLegsCount: 4,
    primaryRotations: ["ROT 511"],
    openBetsSummary: "NBA Period & Off-Tracker Tennis ($6.36K)",
    enforcementStatus: "Silo 3 Tennis Clamped",
  },
  {
    rank: 33,
    proxyWallet: "0x55a866f711d987c544e089b677f189d558e666f3",
    customerLogin: "PEY101",
    agentId: "MACHR",
    category: "SUBNET_BRIDGED_SHARP",
    archetype: "Subnet 104.28.18.0/24 Sniper Pair (MACHR/PEY101 & BR7711)",
    openVolumeUsd: 20000,
    openLegsCount: 4,
    primaryRotations: ["ROT 315", "ROT 451"],
    openBetsSummary: "CFB/NFL Straight & 2-Leg Combos ($20.0K)",
    enforcementStatus: "Ban-Hammer $1K Cap",
  },
  {
    rank: 34,
    proxyWallet: "0x44f755e600c876b433d978a566e078c447d555e4",
    customerLogin: "GX195",
    agentId: "GOLD22",
    category: "SUBNET_BRIDGED_SHARP",
    archetype: "Subnet 104.28.22.0/24 Sniper Pair (GOLD22/GX195 & CW9012)",
    openVolumeUsd: 20000,
    openLegsCount: 4,
    primaryRotations: ["ROT 501", "ROT 451"],
    openBetsSummary: "NBA/NFL Key-Number Spreads ($20.0K)",
    enforcementStatus: "Ban-Hammer $1K Cap",
  },
  {
    rank: 35,
    proxyWallet: "0x33e644d599b765a322c867f455d967b336c444d5",
    customerLogin: "TEX500",
    agentId: "TEXANS",
    category: "SUBNET_BRIDGED_SHARP",
    archetype: "Subnet 172.56.33.0/24 Steam Twin Pair (TEXANS/TEX500 & DF8821)",
    openVolumeUsd: 19000,
    openLegsCount: 5,
    primaryRotations: ["ROT 315", "ROT 341"],
    openBetsSummary: "CFB/NFL Totals & Spreads ($19.0K)",
    enforcementStatus: "6s Delay + 15c Vig",
  },
  {
    rank: 36,
    proxyWallet: "0x22d533c488a654f211b756e344c856a225b333c6",
    customerLogin: "HB7720",
    agentId: "APEX99",
    category: "SUBNET_BRIDGED_SHARP",
    archetype: "High-Velocity Totals Steam Originator (APEX99/HB7720)",
    openVolumeUsd: 12000,
    openLegsCount: 5,
    primaryRotations: ["ROT 505", "ROT 509"],
    openBetsSummary: "NBA 1H/Full-Game Totals ($12.0K)",
    enforcementStatus: "6s Dynamic Delay Gate",
  },
  {
    rank: 37,
    proxyWallet: "0x11c422b377f543e100a645d233b745f114a222b7",
    customerLogin: "NOISE_BOT_77",
    agentId: "ATEAM",
    category: "SIX_GATE_BET1_DISCOVERY",
    archetype:
      "6-Gate Discovery #3 (Sakoe-Chiba DTW 95.0% • ATEAM/NOISE_BOT_77)",
    openVolumeUsd: 10015,
    openLegsCount: 5,
    primaryRotations: ["ROT 505"],
    openBetsSummary: "Decoy $15 MLB Noise + $10K NBA 1H Steam",
    enforcementStatus: "DTW Caught & Clamped",
  },
  {
    rank: 38,
    proxyWallet: "0x99e811a266d432c099f534c122a634e003f111a8",
    customerLogin: "AC9901",
    agentId: "ATEAM",
    category: "SUBNET_BRIDGED_SHARP",
    archetype: "ATEAM Late-Steam Parlay Extractor (ATEAM/AC9901)",
    openVolumeUsd: 14000,
    openLegsCount: 5,
    primaryRotations: ["ROT 341", "ROT 511"],
    openBetsSummary: "NBA/CFB Late Steam Totals ($14.0K)",
    enforcementStatus: "6s Delay + +15c Vig",
  },
  {
    rank: 39,
    proxyWallet: "0x88f100e912a34b56c78d90e123f456a789b088f1",
    customerLogin: "FUNDING_ROOT",
    agentId: "MULTI_BRANCH",
    category: "FUNDING_DISTRIBUTOR_ROOT",
    archetype: "Gate-6 1-Hop Polygon USDC Distributor Root",
    openVolumeUsd: 0,
    openLegsCount: 0,
    primaryRotations: [],
    openBetsSummary:
      "Funded MJ103, EJ8835 & 14 Smurf Wallets (No direct wagers)",
    enforcementStatus: "Auto-Clamps 1-Hop Child",
  },

  // 40-47: Additional Internal-Only F402 Watchlist Customer Logins (from 63-Entity Watchlist in sportsdesk_telegram_bot.ts)
  {
    rank: 40,
    proxyWallet: null,
    customerLogin: "BB5127",
    agentId: "BIGDAD",
    category: "INTERNAL_F402_SHARP",
    archetype: "Internal Execution Sniper Twin (w/ BGD101 • 104.28.14.0/24)",
    openVolumeUsd: 15000,
    openLegsCount: 5,
    primaryRotations: ["ROT 501", "ROT 451"],
    openBetsSummary: "NBA GSBUILDER ML+Total & NFL Spreads ($15.0K)",
    enforcementStatus: "Ban-Hammer $1K + GSLive Tracked",
  },
  {
    rank: 41,
    proxyWallet: null,
    customerLogin: "BR7711",
    agentId: "MACHR",
    category: "INTERNAL_F402_SHARP",
    archetype: "Internal Execution Sniper Twin (w/ PEY101 • 104.28.18.0/24)",
    openVolumeUsd: 10000,
    openLegsCount: 5,
    primaryRotations: ["ROT 501", "ROT 315"],
    openBetsSummary: "NBA GSBUILDER & CFB GSLIVE Spreads ($10.0K)",
    enforcementStatus: "Ban-Hammer $1K + GSLive Tracked",
  },
  {
    rank: 42,
    proxyWallet: null,
    customerLogin: "CW9012",
    agentId: "GOLD22",
    category: "INTERNAL_F402_SHARP",
    archetype: "Internal Execution Sniper Twin (w/ GX195 • 104.28.22.0/24)",
    openVolumeUsd: 10000,
    openLegsCount: 5,
    primaryRotations: ["ROT 315", "ROT 507"],
    openBetsSummary: "CFB GSBUILDER & NBA GSLIVE Spreads ($10.0K)",
    enforcementStatus: "Ban-Hammer $1K + GSLive Tracked",
  },
  {
    rank: 43,
    proxyWallet: null,
    customerLogin: "DF8821",
    agentId: "TEXANS",
    category: "INTERNAL_F402_SHARP",
    archetype: "Internal Steam Chaser Twin (w/ TEX500 • 172.56.33.0/24)",
    openVolumeUsd: 11000,
    openLegsCount: 5,
    primaryRotations: ["ROT 451", "ROT 507"],
    openBetsSummary: "NFL & NBA Spreads + GSLIVE ($11.0K)",
    enforcementStatus: "6s Delay + GSLive Tracked",
  },
  {
    rank: 44,
    proxyWallet: null,
    customerLogin: "AL1279",
    agentId: "AA2300C",
    category: "INTERNAL_F402_SHARP",
    archetype: "Internal Execution Sniper (AA2300C/AL1279)",
    openVolumeUsd: 6000,
    openLegsCount: 2,
    primaryRotations: ["ROT 341"],
    openBetsSummary: "CFB & NBA Straight Snipes ($6.0K)",
    enforcementStatus: "Ban-Hammer $1K Cap",
  },
  {
    rank: 45,
    proxyWallet: null,
    customerLogin: "AT811",
    agentId: "ATEAM",
    category: "INTERNAL_F402_SHARP",
    archetype: "Internal High-Frequency Steam Chaser (ATEAM/AT811)",
    openVolumeUsd: 5990,
    openLegsCount: 6,
    primaryRotations: ["ROT 505", "ROT 509"],
    openBetsSummary: "NBA 1H/2Q Totals Steam ($5.99K)",
    enforcementStatus: "6s Delay + -115 Shade",
  },
  {
    rank: 46,
    proxyWallet: null,
    customerLogin: "AYM59007",
    agentId: "AYMAN",
    category: "INTERNAL_F402_SHARP",
    archetype: "Internal High-Frequency Steam Chaser (AYMAN/AYM59007)",
    openVolumeUsd: 8925,
    openLegsCount: 5,
    primaryRotations: ["ROT 507"],
    openBetsSummary: "NBA & CFB Line Chaser ($8.92K)",
    enforcementStatus: "6s Delay + -115 Shade",
  },
  {
    rank: 47,
    proxyWallet: null,
    customerLogin: "MJ101",
    agentId: "MJ2026",
    category: "INTERNAL_F402_SHARP",
    archetype: "Internal Execution Sniper Sibling (MJ2026/MJ101)",
    openVolumeUsd: 10000,
    openLegsCount: 2,
    primaryRotations: ["ROT 501"],
    openBetsSummary: "NBA Full-Game & 1Q Key-Number Snipes ($10.0K)",
    enforcementStatus: "Ban-Hammer $1K Cap",
  },
  {
    rank: 48,
    proxyWallet: null,
    customerLogin: "19902",
    agentId: "RALPHAH",
    category: "INTERNAL_F402_SHARP",
    archetype: "Internal Execution Sniper (RALPHAH/19902)",
    openVolumeUsd: 5000,
    openLegsCount: 2,
    primaryRotations: ["ROT 451"],
    openBetsSummary: "NFL Key-7 Spread Snipes ($5.0K)",
    enforcementStatus: "Ban-Hammer $1K Cap",
  },
  {
    rank: 49,
    proxyWallet: null,
    customerLogin: "CHURN_050",
    agentId: "SHELBY101",
    category: "INTERNAL_F402_SHARP",
    archetype: "Cross-Branch Subnet 192.168.0.0/24 Twin (w/ CHURN_060)",
    openVolumeUsd: 6400,
    openLegsCount: 3,
    primaryRotations: ["ROT 511"],
    openBetsSummary: "NBA Props & Derivative Spreads ($6.4K)",
    enforcementStatus: "Beard Bridge Clamped",
  },
  {
    rank: 50,
    proxyWallet: null,
    customerLogin: "CCC107",
    agentId: "ROYAL",
    category: "INTERNAL_F402_SHARP",
    archetype: "Trojan Step-Up Donor (ROYAL/CCC107 • +$295.8K House Net)",
    openVolumeUsd: 3413,
    openLegsCount: 4,
    primaryRotations: ["ROT 315", "ROT 501"],
    openBetsSummary:
      "Base Sport -$12,037.64 vs Step-Up/Derivative +$3,412.62 (+22.96% ROI)",
    enforcementStatus: "ACTIVE_CLAMPED ($500 Cap + 10s Delay; Base Open)",
  },
  {
    rank: 51,
    proxyWallet: null,
    customerLogin: "LG404",
    agentId: "COWBOY100",
    category: "INTERNAL_F402_SHARP",
    archetype:
      "Pre-Bet Clinched Goal & 23.77s Confirm-Window Bypass (COWBOY100/LG404 • IP 70.114.33.189)",
    openVolumeUsd: 0,
    openLegsCount: 0,
    primaryRotations: ["ROT 9901"],
    openBetsSummary:
      "Ticket #1071991685: Over 3.5 placed at 4-1 (-33s post-goal) & settled in 23,770ms",
    enforcementStatus: "CLOSED_FRAUD (Revoked & Terminally Closed)",
  },
];

export function getUnifiedWatchlistRegistry(): readonly WatchlistUnifiedEntry[] {
  return RAW_BRIDGED_WATCHLIST.map((r) => {
    const gsLiveUrls = buildGsLiveManagerUrls(r.customerLogin);
    const hasPending = r.openLegsCount > 0 && r.openVolumeUsd > 0;
    return {
      rank: r.rank,
      customerLogin: r.customerLogin,
      paddedCustomerId11: r.customerLogin.padEnd(11, " "),
      gsLivePlayerId: gsLiveUrls.gsLivePlayerId,
      agentId: r.agentId,
      masterAgentId: "BILLY666",
      proxyWallet: r.proxyWallet,
      shortWallet: r.proxyWallet
        ? `${r.proxyWallet.slice(0, 6)}...${r.proxyWallet.slice(-4)}`
        : null,
      sourceCategory: r.category,
      archetype: r.archetype,
      hasPendingWagers: hasPending,
      openLegsCount: r.openLegsCount,
      openVolumeUsd: r.openVolumeUsd,
      primaryRotations: r.primaryRotations,
      openBetsSummary: r.openBetsSummary,
      alertPipeline: r.proxyWallet
        ? "<500ms CLOB WSS + getBetTicker ALERT Twin (250ms) + GSLive player_" +
          r.customerLogin
        : "getBetTicker ALERT Twin (250ms) + GSLive player_" + r.customerLogin,
      enforcementStatus: r.enforcementStatus,
      f402CustomerProfileUrl: `https://fantasy402.com/manager.html?customer=${encodeURIComponent(r.customerLogin)}&agent=${encodeURIComponent(r.agentId)}`,
      polymarketProfileUrl: r.proxyWallet
        ? `https://polymarket.com/profile/${r.proxyWallet}`
        : null,
      polymarketPositionsApiUrl: r.proxyWallet
        ? `https://data-api.polymarket.com/v2/positions?user=${r.proxyWallet}`
        : null,
      polygonscanUrl: r.proxyWallet
        ? `https://polygonscan.com/address/${r.proxyWallet}`
        : null,
      gsLiveUrls,
    };
  });
}

export function lookupWatchlistEntity(
  queryStr: string,
): WatchlistUnifiedEntry | undefined {
  const q = queryStr.trim().toLowerCase();
  const cleanLogin = fromGsLivePlayerId(queryStr).toLowerCase();
  return getUnifiedWatchlistRegistry().find(
    (e) =>
      e.customerLogin.toLowerCase() === cleanLogin ||
      e.gsLivePlayerId.toLowerCase() === q ||
      (e.proxyWallet && e.proxyWallet.toLowerCase() === q),
  );
}
