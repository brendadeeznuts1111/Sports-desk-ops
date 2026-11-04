#!/usr/bin/env bun
/**
 * @file scripts/graph_feed_poller_daemon.ts
 * @description Live Polymarket & Fantasy402 Pending-Bet Poller Daemon (Bun.cron + bun --watch compatible).
 *
 * Capabilities:
 *   1. Polls Polymarket Data API (`https://data-api.polymarket.com/v2/positions?user=<0x>`) and Fantasy402
 *      `Manager/getPending` across all 39 tracked syndicate `0x` wallets.
 *   2. Generates `docs/graph-live-feed.json` and `dist/graph-live-feed.json`. The portal hydrates
 *      its GSLive links and timestamps client-side from that feed, so no HTML is rewritten here.
 *   3. Supports three execution modes:
 *      - `--once`   : Execute a single poll cycle and write `graph-live-feed.json` + `graph.html`
 *      - `--cron`   : Run continuous in-process `Bun.cron("* * * * *", ...)` (60s cadence)
 *      - `--r2`     : Automatically publish updated `graph-live-feed.json` and `graph.html` to Cloudflare R2 on each tick
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  formatCronScheduleLine,
  previewCronSchedule,
  startInProcessCron,
  wireInProcessCronLifecycle,
} from "../lib/bun_cron.ts";
import {
  runFourWeekParlayComboBacktest,
  type FourWeekParlayBacktestReport,
} from "../lib/parlay_combo_backtest_engine.ts";
import {
  PER_OFFICE_IP_TRACKER_CLUSTERS,
  type OfficeIpClusterSummary,
} from "../lib/bet_ticker_ip_tracker_bridge.ts";
import {
  buildTenModeLiveSnapshot,
  type TenModeLiveSnapshot,
} from "../lib/forensic_diagnostic_modes.ts";
import {
  buildGsLiveUsersReportDeepLink,
  buildGsLiveBetHistorySidecarUrl,
  buildGsLiveDualSurfaceDescriptor,
  computeDeskDayStartEpochSeconds,
  deskWindowIso,
  resolveDeskDateYmd,
  type GsLiveDualSurfaceDescriptor,
} from "../lib/gslive_manager_deeplink_sidecar.ts";
import {
  cacheFromSnapshot,
  fetchPolymarketSnapshot,
  isValidWalletAddress,
  reconcileSnapshot,
  type PolymarketSnapshot,
  type PositionCache,
  type WalletIngestState,
} from "../lib/polymarket_ingest.ts";
import {
  probeF402BetTicker,
  type F402Probe,
  type F402TickerRow,
} from "../lib/f402_ingest.ts";
import {
  isWagersLiveEvent,
  WAGERS_LOCAL_SIDECAR_PATH,
  type WagersLiveEvent,
} from "../lib/wagers_live_sink.ts";
import {
  describeF402Session,
  readF402Session,
  refreshF402Session,
  writeF402Session,
} from "../lib/f402_session.ts";

const repoRoot = path.resolve(
  import.meta.dirname ?? path.dirname(process.argv[1] ?? process.cwd()),
  "..",
);

export interface TrackedWalletProfile {
  readonly rank: number;
  readonly proxyWallet: string;
  readonly shortWallet: string;
  readonly f402CustomerId: string;
  readonly agentOwner: string;
  readonly archetype: string;
  readonly polymarketProfileUrl: string;
  readonly polymarketPositionsApiUrl: string;
  readonly polygonscanUrl: string;
  readonly f402CustomerProfileUrl: string;
  readonly gsLivePlayerId: string;
  readonly gsLivePlayerReportUrl: string;
  readonly gsLivePlayerReport7DayUrl: string;
  readonly gsLiveBetHistoryUrl: string;
  readonly openBetsSummary: string;
  readonly openVolumeUsd: number;
  readonly openLegsCount: number;
  readonly enforcementStatus: string;
  readonly lastSyncedIso: string;
  readonly dataSource?: "LIVE" | "STALE" | "FIXTURE";
  readonly walletAddressValid?: boolean;
  readonly positionsValueUsd?: number;
  readonly openPnlUsd?: number;
  readonly fetchedAtIso?: string;
  readonly staleSinceIso?: string | null;
  readonly lastError?: string | null;
}

export interface FeedProvenance {
  readonly polymarket:
    | {
        readonly source: string;
        readonly walletsRequested: number;
        readonly walletsOk: number;
        readonly walletsFailed: number;
        readonly walletsStale: number;
        readonly walletsInvalid: number;
        readonly fetchedAtIso: string;
        readonly durationMs: number;
        readonly truncatedWallets: readonly string[];
      }
    | { readonly source: "fixture"; readonly reason: string };
  readonly f402:
    | {
        readonly source: "live";
        readonly endpoint: string;
        readonly httpStatus: number;
        readonly rows: number;
        readonly fetchedAtIso: string;
        readonly durationMs: number;
        readonly error: string | null;
        readonly tickerFields: readonly string[];
        readonly tickerRows: number;
        readonly mapped: false;
      }
    | { readonly source: "fixture"; readonly reason: string };
}

export interface PendingBetRow {
  readonly ticketId: string;
  readonly sourceVenue:
    | "POLYMARKET_SHADOW"
    | "MATCHED_F402_PARLAY"
    | "NBA_PERIOD_1Q_4Q"
    | "DGS_ALT_SPREAD_5000";
  readonly proxyWallet: string;
  readonly shortWallet: string;
  readonly polymarketProfileUrl: string;
  readonly polymarketPositionsApiUrl: string;
  readonly f402CustomerId: string;
  readonly f402CustomerProfileUrl: string;
  readonly agentOwner: string;
  readonly sportAndPeriod: string;
  readonly canonicalMarket: string;
  readonly lineHundredths: number;
  readonly oddsAmerican: string;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  readonly pmEntryVsFair: string;
  readonly placedAtUtc: string;
  readonly lastSyncedUtc: string;
  readonly deskVerdict: string;
}

export interface GraphLiveFeedPayload {
  readonly schemaVersion: 3;
  readonly lastUpdatedIso: string;
  readonly lastUpdatedCdt: string;
  readonly pollEpochMs: number;
  readonly pollSequence: number;
  readonly dataMode: "LIVE" | "PARTIAL" | "FIXTURE";
  readonly provenance: FeedProvenance;
  readonly schedulerEngine: string;
  readonly wsStreamSlaMsFixture: number;
  readonly wssIngestion: "not_ingested";
  readonly activeSyndicateWalletsCount: number;
  readonly configuredWalletsCount: number;
  readonly totalOpenLegsCount: number;
  readonly totalOpenExposureUsd: number;
  readonly pendingBets: readonly PendingBetRow[];
  readonly liveTicks: readonly F402TickerRow[];
  readonly walletProfiles: readonly TrackedWalletProfile[];
  readonly gsLiveSidecar?: GsLiveDualSurfaceDescriptor;
  readonly perOfficeIpTrackerClusters?: readonly OfficeIpClusterSummary[];
  readonly tenModeSnapshot?: TenModeLiveSnapshot;
  readonly backtest4Wk?: FourWeekParlayBacktestReport;
  /** Aggregate GSLive wagers summary, when a capture sidecar is present. */
  readonly gsliveWagers?: WagersLiveEvent;
}

function formatCdtTimestamp(date: Date): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

const RAW_WALLETS: Array<
  [number, string, string, string, string, string, number, number, string]
> = [
  [
    1,
    "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
    "BGD101",
    "BIGDAD",
    "On-Chain CTF Whale #1 (64 Positions)",
    "KC -1.5 Wk10 ($18K), LAL Alt -7.5 ($24K), CFB Combos ($31.3K)",
    73300,
    14,
    "Ban-Hammer $1K / 6s",
  ],
  [
    2,
    "0x07db5765beba17be154cbfbd6324a15f3c81fa4f",
    "MJ102",
    "MJ2026",
    "On-Chain CTF Whale #2 (NBA Key-3 & 1Q)",
    "LAL/BOS 1Q O55.5 ($16.2K), LAL -3.0 ($26.4K), GSW 3Q -1.5 ($18K)",
    60600,
    12,
    "Ban-Hammer + FG-Only",
  ],
  [
    3,
    "0x91aF0041c882d190e4412a9b77c01f98a220f112",
    "MJ103",
    "MJ2026",
    "6-Gate Discovery #1 (99.3% Cosine to MJ102)",
    "LAL/BOS 1Q O55.5 ($11.5K), LAL -3.0 ($14.0K)",
    25500,
    6,
    "Caught Bet #1 (<320ms)",
  ],
  [
    4,
    "0x50cc8708aff3791f2d6125645c82bda532baa534",
    "EJ8834",
    "MJ2026",
    "On-Chain CTF Sniper #7 (Subnet 104.28.34.0/24)",
    "LAL/BOS 1Q O55.5 ($9.8K), SAC +4.5 ($11.5K), GSW 3Q -1.5 ($19K)",
    40300,
    9,
    "Ban-Hammer $1K / 6s",
  ],
  [
    5,
    "0x44cB8812e901a345b778c120d99e34a11200a881",
    "EJ8835",
    "MJ2026",
    "6-Gate Discovery #2 (98.8% Cosine to EJ8834)",
    "LAL/BOS 1Q O55.5 ($8.7K), GSW 3Q -1.5 ($17K)",
    25700,
    6,
    "Caught Bet #1 (<320ms)",
  ],
  [
    6,
    "0x120640a1deffe6b53e291eba74acf1dbe8274528",
    "GP300",
    "GPRO50RSK",
    "On-Chain CTF Whale #3 (NBA Celtics Key-6)",
    "LAL/BOS 1Q O55.5 ($9.5K), BOS TT O118.5 ($3.5K), Key-6 ($18.9K)",
    31900,
    9,
    "6s Delay + 20c SGP Tax",
  ],
  [
    7,
    "0x53224176b413f20ac63d61f1a0e19002ffb38acb",
    "AT10359",
    "ATEAM",
    "On-Chain CTF Whale #4 (NBA Totals Steam)",
    "IND/SAC 1H O123.5 ($14.5K), DEN 2Q U54.5 ($16.4K), DEN U223.5 ($4.5K rem)",
    35400,
    8,
    "FG-Only + Trap Resolved",
  ],
  [
    8,
    "0x22e29a644a9d14564967b3f9f50346b7ad425c32",
    "ABC700",
    "JUICEPLUS",
    "On-Chain CTF Sharp #5 (NBA+CFB Parlays)",
    "LAL/BOS 1Q O55.5 ($8.5K), BOS TT O118.5 ($4.0K), BOS 4Q +1.5 ($10.2K)",
    22700,
    7,
    "+15c/+20c Vig Shaded",
  ],
  [
    9,
    "0x231699490d08919d8f1d3f0b90fd2a677e3e9819",
    "DAN245",
    "DAN318",
    "On-Chain CTF Sharp #6 (High-CLV Extractor)",
    "KC -1.5 Wk10 ($11.8K), BOS TT O118.5 ($3.5K), BOS 4Q +1.5 ($9.0K)",
    24300,
    7,
    "Parlay Cap $5K + 15c",
  ],
  [
    10,
    "0xaa7789219c17e180dcb5933099c90d885f1d15a5",
    "DA4401",
    "JUICEPLUS",
    "On-Chain CTF Sniper #8 (+270 bps CLV)",
    "SAC +4.5 ($10.0K), BOS TT O118.5 ($3.0K), Whale Combo ($8.1K)",
    21100,
    6,
    "Manual Approval >$2.5K",
  ],
  [
    11,
    "0x7a0da16a1205ee51a56fa862e8baa61e350eff14",
    "BCC1530",
    "SPEN",
    "On-Chain CTF Chaser #9 (Multi-Sport Steam)",
    "IND/SAC 1H O123.5 ($8.5K), Multi-Sport Combos ($7.6K)",
    16100,
    6,
    "6s Dynamic Delay Gate",
  ],
  [
    12,
    "0x1eb93479b3425ad57aef1442be4624a27880f884",
    "DN2019",
    "SHARP66",
    "On-Chain CTF Sharp #10 (NBA 1H/FG Arb)",
    "IND/SAC 1H O123.5 ($9.0K), SAC/NOP 1H U116.5 ($12K Shaded)",
    21000,
    6,
    "Branch 3 Vig Shaded",
  ],
  [
    13,
    "0x3aF8c9104E2b78a142dE90B218a91D89D",
    "CB112_2",
    "CUB22HR",
    "Baylor Tout Burst (Lead Wallet #1)",
    "TXST +14.5 ($7.5K Shadow), Baylor +3.5 / O47.5 ($4.2K)",
    11700,
    5,
    "WSS Stepped @ 345ms",
  ],
  [
    14,
    "0x7bE21d08F449C0213A8E100c9f2A41c12",
    "CB112_3",
    "CUB22HR",
    "Baylor Tout Burst (Syndicate #2)",
    "TXST +14.5 ($6.5K Shadow), Baylor +3.5 / O47.5 ($3.1K)",
    9600,
    4,
    "WSS Stepped @ 345ms",
  ],
  [
    15,
    "0x9cD44e12A8b7F30192c44d8E11a08B3e7",
    "CUST_BAY_1",
    "BILLY666",
    "Baylor Tout Burst (3rd Wallet Trigger)",
    "TXST +14.5 ($6.0K Shadow), Baylor +3.5 / O47.5 ($2.8K)",
    8800,
    4,
    "DEDUP_THEN_LEAD Lock",
  ],
  [
    16,
    "0x1fA98b34C7d2E60154a91B2c33d09F4a1",
    "CB112_4",
    "CUB22HR",
    "Baylor Tout Burst (Syndicate #4)",
    "TXST +14.5 ($5.5K Shadow), Baylor +3.5 / O47.5 ($2.5K)",
    8000,
    4,
    "WSS Stepped @ 345ms",
  ],
  [
    17,
    "0x5eB67c89D1a4F20387b12C4d55e10A8c9",
    "MX920_1",
    "MAX92",
    "Baylor Tout Burst (Syndicate #5)",
    "TXST +14.5 ($5.5K Shadow), Baylor +3.5 / O47.5 ($2.2K)",
    7700,
    4,
    "WSS Stepped @ 345ms",
  ],
  [
    18,
    "0x8dC12f45E6b9A10476c23D5e66f21B7d4",
    "CUST_BAY_2",
    "BILLY666",
    "Baylor Tout Burst (Syndicate #6)",
    "TXST +14.5 ($5.0K Shadow), Baylor +3.5 / O47.5 ($1.9K)",
    6900,
    4,
    "WSS Stepped @ 345ms",
  ],
  [
    19,
    "0x4aE39d78F2c1B50891d34E6f77a32C6e0",
    "CB112_5",
    "CUB22HR",
    "Baylor Tout Burst (Syndicate #7)",
    "TXST +14.5 ($5.0K Shadow), Baylor +3.5 / O47.5 ($1.7K)",
    6700,
    3,
    "WSS Stepped @ 345ms",
  ],
  [
    20,
    "0x2cB81a90D4e7F31265e45F7a88b43D9f2",
    "MM1012",
    "BILLY666",
    "Key-7 Teaser / Middle Extractor #1",
    "KC -1.5 Wk10 ($12.5K Shadow), NE -6.5 ($8.5K)",
    21000,
    8,
    "Key 3/7 Crossing Guard",
  ],
  [
    21,
    "0x6fD92b01E5f8A42376f56A8b99c54E1a5",
    "MM1023",
    "BILLY666",
    "Key-7 Teaser / Middle Extractor #2",
    "KC -1.5 Wk10 ($10.5K Shadow), NE -6.5 ($7.0K)",
    17500,
    7,
    "Key 3/7 Crossing Guard",
  ],
  [
    22,
    "0x0aE03c12F6a9B53487a67B9c00d65F2b8",
    "BL4402",
    "ATEAM",
    "ATEAM Syndicate Downline & Key-7 Extractor",
    "IND/SAC 1H O123.5 ($9.5K), DEN 2Q U54.5 ($12K), PHI/MIL -4.5 ($28K)",
    49500,
    9,
    "Branch 2 Moved -6.0",
  ],
  [
    23,
    "0x9bF14d23A7b0C64598b78C0d11e76A3c1",
    "FL3301",
    "DAN318",
    "Key-7 Teaser / Subnet 104.28.38.0/24 Twin",
    "NE -6.5 ($4.0K), NFL Key-7 Middles ($6.0K)",
    10000,
    5,
    "6pt Teaser @ -135",
  ],
  [
    24,
    "0x3dA25e34B8c1D75609c89D1e22f87B4d6",
    "AK1092",
    "GPRO50RSK",
    "Prop & Tempo Stack Sniper #1",
    "NFL/NBA Correlated Stacks ($3.5K)",
    3500,
    3,
    "+25c Correlated Tax",
  ],
  [
    25,
    "0x7eB36f45C9d2E86710d90E2f33a98C5e9",
    "LG237",
    "GPRO50RSK",
    "Prop & Tempo Stack Sniper #2",
    "NFL/NBA Correlated Stacks ($2.75K)",
    2750,
    3,
    "+25c Correlated Tax",
  ],
  [
    26,
    "0x1cC47a56D0e3F97821e01F3a44b09D6f3",
    "CM5510",
    "SPEN",
    "SPEN Downline Steam Partner",
    "IND/SAC 1H O123.5 ($7.0K Shadow), Stacks ($2.0K)",
    9000,
    4,
    "6s Delay + +15c Vig",
  ],
  [
    27,
    "0x5fD58b67E1f4A08932f12A4b55c10E7a7",
    "RF2003",
    "FAKEMONEY",
    "Cross-Sport CTF Whale Arbitrage",
    "SAC +4.5 ($8.0K Shadow), NFL+NBA Combos ($4.5K)",
    12500,
    5,
    "Single Bet Cap $5,000",
  ],
  [
    28,
    "0x3af8392189d021cfa82000000000000000021cfa",
    "CB112_1",
    "CUB22HR",
    "Patriots Key-7 Proxy Attribution",
    "NE -6.5 vs -7.5 ($6.5K Matched Parlay)",
    6500,
    5,
    "Layoff Alert Bridged",
  ],
  [
    29,
    "0x3af8771189d099bf710000000000000000099bf71",
    "CUST_BAY_3",
    "BILLY666",
    "Baylor Total 48 Whale Proxy",
    "Baylor Over 47.5 vs 48.0 ($18.4K Matched)",
    18400,
    6,
    "Total 48 Window Frozen",
  ],
  [
    30,
    "0x88d199c044a210f877b312e900c412a881b999c0",
    "CHURN_059",
    "LAKERS",
    "Subnet 192.168.9.0/24 Bridge (NBA 1H/Alt)",
    "LAL Alt -10.5 ($18.0K); Blocked Alt+ML Subset Parlay",
    18000,
    4,
    "Blocked (Probit ρ=0.756)",
  ],
  [
    31,
    "0x77c088b933f109e766a201d899b301f770a888b1",
    "CHURN_049",
    "SOUTHSHORE",
    "Subnet 192.168.9.0/24 Twin (w/ CHURN_059)",
    "NBA 1H Derivative Spread ($8.2K)",
    8200,
    4,
    "FG-Only Clamped",
  ],
  [
    32,
    "0x66b977a822e098d655f190c788a290e669f777a2",
    "CHURN_060",
    "KOBE24",
    "Subnet 192.168.0.0/24 Bridge (w/ CHURN_050)",
    "NBA Period & Off-Tracker Tennis ($6.36K)",
    6360,
    4,
    "Silo 3 Tennis Clamped",
  ],
  [
    33,
    "0x55a866f711d987c544e089b677f189d558e666f3",
    "PEY101",
    "MACHR",
    "Subnet 104.28.18.0/24 Execution Sniper Pair",
    "CFB/NFL Straight & 2-Leg Combos ($20.0K)",
    20000,
    4,
    "Ban-Hammer $1K Cap",
  ],
  [
    34,
    "0x44f755e600c876b433d978a566e078c447d555e4",
    "GX195",
    "GOLD22",
    "Subnet 104.28.22.0/24 Execution Sniper Pair",
    "NBA/NFL Key-Number Spreads ($20.0K)",
    20000,
    4,
    "Ban-Hammer $1K Cap",
  ],
  [
    35,
    "0x33e644d599b765a322c867f455d967b336c444d5",
    "TEX500",
    "TEXANS",
    "Subnet 172.56.33.0/24 Steam Twin Pair",
    "CFB/NFL Totals & Spreads ($19.0K)",
    19000,
    5,
    "6s Delay + 15c Vig",
  ],
  [
    36,
    "0x22d533c488a654f211b756e344c856a225b333c6",
    "HB7720",
    "APEX99",
    "High-Velocity Totals Steam Originator (+245 bps)",
    "NBA 1H/Full-Game Totals ($12.0K)",
    12000,
    5,
    "6s Dynamic Delay Gate",
  ],
  [
    37,
    "0x11c422b377f543e100a645d233b745f114a222b7",
    "NOISE_BOT_77",
    "ATEAM",
    "6-Gate Discovery #3 (Sakoe-Chiba DTW 95.0%)",
    "Decoy $15 MLB Noise + $10K NBA 1H Steam",
    10015,
    5,
    "DTW Caught & Clamped",
  ],
  [
    38,
    "0x99e811a266d432c099f534c122a634e003f111a8",
    "AC9901",
    "ATEAM",
    "ATEAM Late-Steam Syndicate Pair",
    "NBA/CFB Late Steam Totals ($14.0K)",
    14000,
    5,
    "6s Delay + +15c Vig",
  ],
  [
    39,
    "0x88f100e912a34b56c78d90e123f456a789b088f1",
    "FUNDING_ROOT",
    "MULTI_BRANCH",
    "Gate-6 1-Hop Polygon USDC Distributor Root",
    "Funded MJ103, EJ8835 & 14 Smurf Wallets",
    0,
    0,
    "Auto-Clamps 1-Hop Child",
  ],
];

export const TRACKED_WALLET_ADDRESSES = RAW_WALLETS.map(
  ([, address]) => address,
);

export function buildGraphLiveFeed(
  pollSequence = 1,
  options?: {
    readonly ingest?: readonly WalletIngestState[] | null;
    readonly snapshot?: PolymarketSnapshot | null;
    readonly f402Probe?: F402Probe | null;
    readonly gsliveWagers?: WagersLiveEvent | null;
  },
): GraphLiveFeedPayload {
  const now = new Date();
  const nowIso = now.toISOString();
  const nowCdt = formatCdtTimestamp(now);
  const deskDateYmd = resolveDeskDateYmd(now);
  const deskDayStartEpochSec = computeDeskDayStartEpochSeconds(deskDateYmd);
  const deskWindow7 = deskWindowIso(deskDateYmd, 7);
  const ingestByAddress = new Map<string, WalletIngestState>();
  for (const state of options?.ingest ?? []) {
    ingestByAddress.set(state.address.toLowerCase(), state);
  }

  const walletProfiles: TrackedWalletProfile[] = RAW_WALLETS.map(
    ([rank, addr, f402Id, agent, arch, summary, vol, legs, status]) => {
      const live = ingestByAddress.get(addr.toLowerCase());
      const aggregate = live?.aggregate ?? null;
      const addressValid = isValidWalletAddress(addr);
      return {
        rank,
        proxyWallet: addr,
        shortWallet: `${addr.slice(0, 6)}...${addr.slice(-4)}`,
        f402CustomerId: f402Id,
        agentOwner: agent,
        archetype: arch,
        polymarketProfileUrl: addressValid
          ? `https://polymarket.com/profile/${addr}`
          : "",
        polymarketPositionsApiUrl: addressValid
          ? `https://data-api.polymarket.com/v2/positions?user=${addr}`
          : "",
        polygonscanUrl: addressValid
          ? `https://polygonscan.com/address/${addr}`
          : "",
        f402CustomerProfileUrl: `https://fantasy402.com/manager.html?customer=${encodeURIComponent(f402Id)}&agent=${encodeURIComponent(agent)}`,
        gsLivePlayerId: `player_${f402Id}`,
        gsLivePlayerReportUrl: buildGsLiveUsersReportDeepLink({
          customerLogin: f402Id,
          bot: true,
        }),
        gsLivePlayerReport7DayUrl: buildGsLiveUsersReportDeepLink({
          customerLogin: f402Id,
          bot: true,
          eventId: "",
          fromIsoUtc: deskWindow7.fromIso,
          toIsoUtc: deskWindow7.toIso,
          partnerId: 118,
          searchBy: "player",
        }),
        gsLiveBetHistoryUrl: buildGsLiveBetHistorySidecarUrl({
          customerLogin: f402Id,
          dateYmd: deskDateYmd,
          fromEpochSec: deskDayStartEpochSec,
          toEpochSec: deskDayStartEpochSec,
          dateFilterBy: "calcTime",
          tickEpochMs: now.getTime(),
        }),
        openBetsSummary:
          aggregate?.summary ??
          (addressValid
            ? summary
            : "wallet address unverified — not tracked live"),
        openVolumeUsd:
          aggregate !== null
            ? Math.round(aggregate.openCostUsd)
            : addressValid
              ? vol
              : 0,
        openLegsCount:
          aggregate !== null
            ? aggregate.openLegsCount
            : addressValid
              ? legs
              : 0,
        enforcementStatus: status,
        lastSyncedIso: nowIso,
        dataSource: live?.dataSource ?? "FIXTURE",
        walletAddressValid: addressValid,
        positionsValueUsd: aggregate?.openValueUsd ?? 0,
        openPnlUsd: aggregate?.openPnlUsd ?? 0,
        fetchedAtIso: live?.fetchedAtIso ?? nowIso,
        staleSinceIso: live?.staleSinceIso ?? null,
        lastError:
          live?.lastError ??
          (addressValid ? null : "invalid address (placeholder in watchlist)"),
      };
    },
  );

  const pendingBets: PendingBetRow[] = [
    {
      ticketId: "PM-ORD-8801-1Q",
      sourceVenue: "POLYMARKET_SHADOW",
      proxyWallet: "0x07db5765beba17be154cbfbd6324a15f3c81fa4f",
      shortWallet: "0x07db...fa4f",
      polymarketProfileUrl:
        "https://polymarket.com/profile/0x07db5765beba17be154cbfbd6324a15f3c81fa4f",
      polymarketPositionsApiUrl:
        "https://data-api.polymarket.com/v2/positions?user=0x07db5765beba17be154cbfbd6324a15f3c81fa4f",
      f402CustomerId: "MJ102",
      f402CustomerProfileUrl:
        "https://fantasy402.com/manager.html?customer=MJ102",
      agentOwner: "MJ2026",
      sportAndPeriod: "NBA • 1Q Total",
      canonicalMarket: "NBA_LAL_BOS_1Q_TOTAL_OVER_55.5",
      lineHundredths: 5550,
      oddsAmerican: "+115 (46.5c)",
      riskUsd: 16200,
      toWinUsd: 18630,
      pmEntryVsFair: "46.5c vs 48.8c Fair",
      placedAtUtc: "2026-10-31 14:42:11 UTC",
      lastSyncedUtc: nowIso,
      deskVerdict: "OPENED F402 56.5 (-115) @ T+334ms",
    },
    {
      ticketId: "PM-ORD-8802-1Q",
      sourceVenue: "POLYMARKET_SHADOW",
      proxyWallet: "0x91aF0041c882d190e4412a9b77c01f98a220f112",
      shortWallet: "0x91aF...f112",
      polymarketProfileUrl:
        "https://polymarket.com/profile/0x91aF0041c882d190e4412a9b77c01f98a220f112",
      polymarketPositionsApiUrl:
        "https://data-api.polymarket.com/v2/positions?user=0x91aF0041c882d190e4412a9b77c01f98a220f112",
      f402CustomerId: "MJ103",
      f402CustomerProfileUrl:
        "https://fantasy402.com/manager.html?customer=MJ103",
      agentOwner: "MJ2026",
      sportAndPeriod: "NBA • 1Q Total",
      canonicalMarket: "NBA_LAL_BOS_1Q_TOTAL_OVER_55.5",
      lineHundredths: 5550,
      oddsAmerican: "+115 (46.5c)",
      riskUsd: 11500,
      toWinUsd: 13225,
      pmEntryVsFair: "46.5c vs 48.8c Fair",
      placedAtUtc: "2026-10-31 14:42:13 UTC",
      lastSyncedUtc: nowIso,
      deskVerdict: "6-GATE CAUGHT BET #1 (99.3% Cosine)",
    },
    {
      ticketId: "PM-ORD-8803-1H",
      sourceVenue: "POLYMARKET_SHADOW",
      proxyWallet: "0x53224176b413f20ac63d61f1a0e19002ffb38acb",
      shortWallet: "0x5322...8acb",
      polymarketProfileUrl:
        "https://polymarket.com/profile/0x53224176b413f20ac63d61f1a0e19002ffb38acb",
      polymarketPositionsApiUrl:
        "https://data-api.polymarket.com/v2/positions?user=0x53224176b413f20ac63d61f1a0e19002ffb38acb",
      f402CustomerId: "AT10359",
      f402CustomerProfileUrl:
        "https://fantasy402.com/manager.html?customer=AT10359",
      agentOwner: "ATEAM",
      sportAndPeriod: "NBA • 1H Total",
      canonicalMarket: "NBA_IND_SAC_1H_TOTAL_OVER_123.5",
      lineHundredths: 12350,
      oddsAmerican: "-105 (51.2c)",
      riskUsd: 14500,
      toWinUsd: 13810,
      pmEntryVsFair: "51.2c vs 56.5c (-130) Fair",
      placedAtUtc: "2026-10-31 14:50:04 UTC",
      lastSyncedUtc: nowIso,
      deskVerdict: "PACE MODEL VALIDATED (F402 @ 126.5)",
    },
    {
      ticketId: "PM-ORD-8804-CFB",
      sourceVenue: "POLYMARKET_SHADOW",
      proxyWallet: "0x3aF8c9104E2b78a142dE90B218a91D89D",
      shortWallet: "0x3aF8...D89D",
      polymarketProfileUrl:
        "https://polymarket.com/profile/0x3aF8c9104E2b78a142dE90B218a91D89D",
      polymarketPositionsApiUrl:
        "https://data-api.polymarket.com/v2/positions?user=0x3aF8c9104E2b78a142dE90B218a91D89D",
      f402CustomerId: "CB112_2",
      f402CustomerProfileUrl:
        "https://fantasy402.com/manager.html?customer=CUB22_T1",
      agentOwner: "CUB22HR",
      sportAndPeriod: "CFB • FG Spread",
      canonicalMarket: "CFB_TXST_ULL_SPREAD_TXST_+14.5",
      lineHundredths: 1450,
      oddsAmerican: "-110 (52.4c)",
      riskUsd: 41000,
      toWinUsd: 37272,
      pmEntryVsFair: "52.4c vs 57.4c (-135) Fair",
      placedAtUtc: "2026-10-31 15:02:19 UTC",
      lastSyncedUtc: nowIso,
      deskVerdict: "WSS STEPPED F402 +14.5 -> +13.0 @ 345ms",
    },
    {
      ticketId: "PM-ORD-8805-NFL",
      sourceVenue: "POLYMARKET_SHADOW",
      proxyWallet: "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
      shortWallet: "0x26cf...c612",
      polymarketProfileUrl:
        "https://polymarket.com/profile/0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
      polymarketPositionsApiUrl:
        "https://data-api.polymarket.com/v2/positions?user=0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
      f402CustomerId: "BGD101",
      f402CustomerProfileUrl:
        "https://fantasy402.com/manager.html?customer=BGD101",
      agentOwner: "BIGDAD",
      sportAndPeriod: "NFL • Wk10 Lookahead",
      canonicalMarket: "NFL_KC_BUF_SPREAD_KC_-1.5_WK10",
      lineHundredths: -150,
      oddsAmerican: "-106 (51.5c)",
      riskUsd: 52800,
      toWinUsd: 49811,
      pmEntryVsFair: "51.5c vs 56.5c (-130) Fair",
      placedAtUtc: "2026-10-31 15:08:44 UTC",
      lastSyncedUtc: nowIso,
      deskVerdict: "WSS STEPPED F402 -1.5 -> -2.5 @ 394ms",
    },
    {
      ticketId: "PM-ORD-8806-MID",
      sourceVenue: "POLYMARKET_SHADOW",
      proxyWallet: "0x50cc8708aff3791f2d6125645c82bda532baa534",
      shortWallet: "0x50cc...a534",
      polymarketProfileUrl:
        "https://polymarket.com/profile/0x50cc8708aff3791f2d6125645c82bda532baa534",
      polymarketPositionsApiUrl:
        "https://data-api.polymarket.com/v2/positions?user=0x50cc8708aff3791f2d6125645c82bda532baa534",
      f402CustomerId: "EJ8834",
      f402CustomerProfileUrl:
        "https://fantasy402.com/manager.html?customer=EJ8834",
      agentOwner: "MJ2026",
      sportAndPeriod: "NBA • FG Key-4 Middle",
      canonicalMarket: "NBA_GSW_SAC_SPREAD_SAC_+4.5",
      lineHundredths: 450,
      oddsAmerican: "-108 (52.0c)",
      riskUsd: 29500,
      toWinUsd: 27315,
      pmEntryVsFair: "PM +4.5 vs DK -3.5 (Key 4)",
      placedAtUtc: "2026-10-31 15:11:30 UTC",
      lastSyncedUtc: nowIso,
      deskVerdict: "PINNED F402 AT GSW -4.0 (+4.0)",
    },
    {
      ticketId: "PM-ORD-8807-TRAP",
      sourceVenue: "POLYMARKET_SHADOW",
      proxyWallet: "0x53224176b413f20ac63d61f1a0e19002ffb38acb",
      shortWallet: "0x5322...8acb",
      polymarketProfileUrl:
        "https://polymarket.com/profile/0x53224176b413f20ac63d61f1a0e19002ffb38acb",
      polymarketPositionsApiUrl:
        "https://data-api.polymarket.com/v2/positions?user=0x53224176b413f20ac63d61f1a0e19002ffb38acb",
      f402CustomerId: "AT10359",
      f402CustomerProfileUrl:
        "https://fantasy402.com/manager.html?customer=AT10359",
      agentOwner: "ATEAM",
      sportAndPeriod: "NBA • FG Total Trap",
      canonicalMarket: "NBA_DEN_PHX_TOTAL_UNDER_223.5",
      lineHundredths: 22350,
      oddsAmerican: "-131 (56.8c)",
      riskUsd: 4500,
      toWinUsd: 3435,
      pmEntryVsFair: "56.8c (+3.8c slip) -> Reverted 51.4c",
      placedAtUtc: "2026-10-31 15:14:02 UTC",
      lastSyncedUtc: nowIso,
      deskVerdict: "AUTO-RESOLVED @ T+112s (Branch 1 Revert)",
    },
    {
      ticketId: "PM-ORD-8808-TT",
      sourceVenue: "POLYMARKET_SHADOW",
      proxyWallet: "0x22e29a644a9d14564967b3f9f50346b7ad425c32",
      shortWallet: "0x22e2...5c32",
      polymarketProfileUrl:
        "https://polymarket.com/profile/0x22e29a644a9d14564967b3f9f50346b7ad425c32",
      polymarketPositionsApiUrl:
        "https://data-api.polymarket.com/v2/positions?user=0x22e29a644a9d14564967b3f9f50346b7ad425c32",
      f402CustomerId: "ABC700",
      f402CustomerProfileUrl:
        "https://fantasy402.com/manager.html?customer=ABC700",
      agentOwner: "JUICEPLUS",
      sportAndPeriod: "NBA • Team Total",
      canonicalMarket: "NBA_BOS_MIL_TEAM_TOTAL_BOS_OVER_118.5",
      lineHundredths: 11850,
      oddsAmerican: "-108 (52.0c)",
      riskUsd: 14000,
      toWinUsd: 12963,
      pmEntryVsFair: "52.0c vs 55.5c (-125) Fair",
      placedAtUtc: "2026-10-31 15:18:55 UTC",
      lastSyncedUtc: nowIso,
      deskVerdict: "OPENED F402 BOS TT 119.5 (-115)",
    },
    {
      ticketId: "F402-901002-ALT",
      sourceVenue: "DGS_ALT_SPREAD_5000",
      proxyWallet: "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
      shortWallet: "0x26cf...c612",
      polymarketProfileUrl:
        "https://polymarket.com/profile/0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
      polymarketPositionsApiUrl:
        "https://data-api.polymarket.com/v2/positions?user=0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
      f402CustomerId: "BGD101",
      f402CustomerProfileUrl:
        "https://fantasy402.com/manager.html?customer=BGD101",
      agentOwner: "BIGDAD",
      sportAndPeriod: "NBA • Alt Spread (GameNum 5501)",
      canonicalMarket: "NBA_LAL_BOS:FG:ALT_SPREAD:-750",
      lineHundredths: -750,
      oddsAmerican: "+165",
      riskUsd: 24000,
      toWinUsd: 39600,
      pmEntryVsFair: "DGS Child Rot 5501 -> Parent 501",
      placedAtUtc: "2026-10-31 15:21:10 UTC",
      lastSyncedUtc: nowIso,
      deskVerdict: "NORMALIZED IN ALT RING ($42K)",
    },
    {
      ticketId: "F402-901003-ALT",
      sourceVenue: "DGS_ALT_SPREAD_5000",
      proxyWallet: "0x88d199c044a210f877b312e900c412a881b999c0",
      shortWallet: "0x88d1...99c0",
      polymarketProfileUrl:
        "https://polymarket.com/profile/0x88d199c044a210f877b312e900c412a881b999c0",
      polymarketPositionsApiUrl:
        "https://data-api.polymarket.com/v2/positions?user=0x88d199c044a210f877b312e900c412a881b999c0",
      f402CustomerId: "CHURN_059",
      f402CustomerProfileUrl:
        "https://fantasy402.com/manager.html?customer=CHURN_059",
      agentOwner: "LAKERS",
      sportAndPeriod: "NBA • Alt Spread (GameNum 5501)",
      canonicalMarket: "NBA_LAL_BOS:FG:ALT_SPREAD:-1050",
      lineHundredths: -1050,
      oddsAmerican: "+240",
      riskUsd: 18000,
      toWinUsd: 43200,
      pmEntryVsFair: "Attempted Alt+ML Subset Parlay",
      placedAtUtc: "2026-10-31 15:22:48 UTC",
      lastSyncedUtc: nowIso,
      deskVerdict: "PROBIT SUBSET GUARD BLOCKED (ρ=0.756)",
    },
    {
      ticketId: "F402-901004-3Q",
      sourceVenue: "NBA_PERIOD_1Q_4Q",
      proxyWallet: "0x50cc8708aff3791f2d6125645c82bda532baa534",
      shortWallet: "0x50cc...a534",
      polymarketProfileUrl:
        "https://polymarket.com/profile/0x50cc8708aff3791f2d6125645c82bda532baa534",
      polymarketPositionsApiUrl:
        "https://data-api.polymarket.com/v2/positions?user=0x50cc8708aff3791f2d6125645c82bda532baa534",
      f402CustomerId: "EJ8834",
      f402CustomerProfileUrl:
        "https://fantasy402.com/manager.html?customer=EJ8834",
      agentOwner: "MJ2026",
      sportAndPeriod: "NBA • 3Q Spread (Period 5)",
      canonicalMarket: "NBA_GSW_SAC:3Q:SPREAD:-150",
      lineHundredths: -150,
      oddsAmerican: "-115",
      riskUsd: 54000,
      toWinUsd: 46956,
      pmEntryVsFair: "GSW +8.4 NetRtg 3Q Surge",
      placedAtUtc: "2026-10-31 15:25:19 UTC",
      lastSyncedUtc: nowIso,
      deskVerdict: "Q3_STARTER_SURGE_OFFSET (+1.15pt)",
    },
    {
      ticketId: "F402-901005-2Q",
      sourceVenue: "NBA_PERIOD_1Q_4Q",
      proxyWallet: "0x53224176b413f20ac63d61f1a0e19002ffb38acb",
      shortWallet: "0x5322...8acb",
      polymarketProfileUrl:
        "https://polymarket.com/profile/0x53224176b413f20ac63d61f1a0e19002ffb38acb",
      polymarketPositionsApiUrl:
        "https://data-api.polymarket.com/v2/positions?user=0x53224176b413f20ac63d61f1a0e19002ffb38acb",
      f402CustomerId: "AT10359",
      f402CustomerProfileUrl:
        "https://fantasy402.com/manager.html?customer=AT10359",
      agentOwner: "ATEAM",
      sportAndPeriod: "NBA • 2Q Total (Period 4)",
      canonicalMarket: "NBA_DEN_PHX:2Q:TOTAL:5450",
      lineHundredths: 5450,
      oddsAmerican: "-110",
      riskUsd: 28400,
      toWinUsd: 25818,
      pmEntryVsFair: "Non-Jokić 2Q Bench Drag (-14.2 OffRtg)",
      placedAtUtc: "2026-10-31 15:27:05 UTC",
      lastSyncedUtc: nowIso,
      deskVerdict: "Q2_BENCH_ROTATION_DRAG (0.232)",
    },
    {
      ticketId: "F402-901006-4Q",
      sourceVenue: "NBA_PERIOD_1Q_4Q",
      proxyWallet: "0x22e29a644a9d14564967b3f9f50346b7ad425c32",
      shortWallet: "0x22e2...5c32",
      polymarketProfileUrl:
        "https://polymarket.com/profile/0x22e29a644a9d14564967b3f9f50346b7ad425c32",
      polymarketPositionsApiUrl:
        "https://data-api.polymarket.com/v2/positions?user=0x22e29a644a9d14564967b3f9f50346b7ad425c32",
      f402CustomerId: "ABC700",
      f402CustomerProfileUrl:
        "https://fantasy402.com/manager.html?customer=ABC700",
      agentOwner: "JUICEPLUS",
      sportAndPeriod: "NBA • 4Q Spread (Period 6)",
      canonicalMarket: "NBA_BOS_MIL:4Q:SPREAD:+150",
      lineHundredths: 150,
      oddsAmerican: "-110",
      riskUsd: 19200,
      toWinUsd: 17454,
      pmEntryVsFair: "4Q Clutch Variance Compression (σ=5.4)",
      placedAtUtc: "2026-10-31 15:29:40 UTC",
      lastSyncedUtc: nowIso,
      deskVerdict: "Q4_CLUTCH_VARIANCE_COMPRESSION",
    },
    {
      ticketId: "F402-901007-KEY7",
      sourceVenue: "MATCHED_F402_PARLAY",
      proxyWallet: "0x3af8392189d021cfa82000000000000000021cfa",
      shortWallet: "0x3af8...1cfa",
      polymarketProfileUrl:
        "https://polymarket.com/profile/0x3af8392189d021cfa82000000000000000021cfa",
      polymarketPositionsApiUrl:
        "https://data-api.polymarket.com/v2/positions?user=0x3af8392189d021cfa82000000000000000021cfa",
      f402CustomerId: "CB112_1",
      f402CustomerProfileUrl:
        "https://fantasy402.com/manager.html?customer=CB112_1",
      agentOwner: "CUB22HR",
      sportAndPeriod: "NFL • FG Key-7 Parlay",
      canonicalMarket: "NFL_NE_MIA_SPREAD_NE_-650_VS_-750",
      lineHundredths: -750,
      oddsAmerican: "-110",
      riskUsd: 63000,
      toWinUsd: 57272,
      pmEntryVsFair: "PM -6.5 (-650) beats F402 -7.5 (-750)",
      placedAtUtc: "2026-10-31 15:31:12 UTC",
      lastSyncedUtc: nowIso,
      deskVerdict: "SHARP_STILL_BETTER LAYOFF ALERT",
    },
  ];

  const liveWallets = walletProfiles.filter(
    (wallet) => wallet.dataSource !== "FIXTURE",
  );
  const liveSnapshot = options?.snapshot ?? null;
  const f402Probe = options?.f402Probe ?? null;
  const ingestStates = options?.ingest ?? [];
  const walletsStale = ingestStates.filter(
    (state) => state.dataSource === "STALE",
  ).length;
  const walletsInvalid = TRACKED_WALLET_ADDRESSES.filter(
    (address) => !isValidWalletAddress(address),
  ).length;
  const totalOpenLegsCount =
    liveWallets.length > 0
      ? liveWallets.reduce((sum, wallet) => sum + wallet.openLegsCount, 0)
      : 222;
  const totalOpenExposureUsd =
    liveWallets.length > 0
      ? Math.round(
          liveWallets.reduce(
            (sum, wallet) => sum + (wallet.positionsValueUsd ?? 0),
            0,
          ),
        )
      : 702700;
  const provenance: FeedProvenance = {
    polymarket: liveSnapshot
      ? {
          source: liveSnapshot.source,
          walletsRequested: liveSnapshot.requested,
          walletsOk: liveSnapshot.ok,
          walletsFailed: liveSnapshot.failed,
          walletsStale,
          walletsInvalid,
          fetchedAtIso: liveSnapshot.fetchedAtIso,
          durationMs: liveSnapshot.durationMs,
          truncatedWallets: liveSnapshot.truncatedWallets,
        }
      : {
          source: "fixture",
          reason:
            "live ingest disabled (pass --live or set SPORTSDESK_LIVE_INGEST=1)",
        },
    f402: f402Probe
      ? {
          source: "live",
          endpoint: f402Probe.endpoint,
          httpStatus: f402Probe.httpStatus,
          rows: f402Probe.rows,
          fetchedAtIso: f402Probe.fetchedAtIso,
          durationMs: f402Probe.durationMs,
          error: f402Probe.error,
          tickerFields: f402Probe.fields,
          tickerRows: f402Probe.ticks.length,
          mapped: false,
        }
      : {
          source: "fixture",
          reason: "no F402 session; pendingBets remain fixture rows",
        },
  };

  return {
    schemaVersion: 3,
    lastUpdatedIso: nowIso,
    lastUpdatedCdt: nowCdt,
    pollEpochMs: now.getTime(),
    pollSequence,
    dataMode:
      liveSnapshot === null && f402Probe === null ? "FIXTURE" : "PARTIAL",
    provenance,
    schedulerEngine: "Bun.cron('* * * * *') + bun --watch",
    wsStreamSlaMsFixture: 345,
    wssIngestion: "not_ingested",
    activeSyndicateWalletsCount:
      liveSnapshot === null ? 39 : liveWallets.length,
    configuredWalletsCount: 39,
    totalOpenLegsCount,
    totalOpenExposureUsd,
    pendingBets,
    liveTicks: f402Probe ? f402Probe.ticks.slice(0, 20) : [],
    walletProfiles,
    gsLiveSidecar: buildGsLiveDualSurfaceDescriptor("CHURN_003", {
      dateYmd: deskDateYmd,
      tickEpochMs: now.getTime(),
    }),
    perOfficeIpTrackerClusters: PER_OFFICE_IP_TRACKER_CLUSTERS,
    tenModeSnapshot: buildTenModeLiveSnapshot(),
    backtest4Wk: runFourWeekParlayComboBacktest(repoRoot),
    ...(options?.gsliveWagers === null || options?.gsliveWagers === undefined
      ? {}
      : { gsliveWagers: options.gsliveWagers }),
  };
}

let pollCounter = 1;

const POSITION_CACHE_REL = path.join("scratch", "graph-feed-state.json");

function readPositionCache(filePath: string): PositionCache {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    ) as Partial<PositionCache>;
    if (
      parsed.schemaVersion === 1 &&
      parsed.wallets !== null &&
      typeof parsed.wallets === "object"
    ) {
      return parsed as PositionCache;
    }
  } catch {
    // Missing or corrupt cache: start cold and let the next successful poll fill it.
  }
  return { schemaVersion: 1, wallets: {} };
}

function writePositionCache(filePath: string, cache: PositionCache): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cache)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

async function readGsliveWagersSidecar(): Promise<WagersLiveEvent | null> {
  try {
    const raw = await Bun.file(
      path.join(repoRoot, WAGERS_LOCAL_SIDECAR_PATH),
    ).json();
    if (isWagersLiveEvent(raw)) return raw;
    console.warn(
      "[GraphPoller] gslive-wagers sidecar is present but not a valid event; ignoring",
    );
    return null;
  } catch {
    return null;
  }
}

export async function writeGraphLiveFeedOnce(
  syncR2 = false,
  options?: { readonly live?: boolean; readonly liveF402?: boolean },
): Promise<GraphLiveFeedPayload> {
  let snapshot: PolymarketSnapshot | null = null;
  let ingest: readonly WalletIngestState[] | null = null;
  let f402Probe: F402Probe | null = null;

  if (options?.live) {
    const cachePath = path.join(repoRoot, POSITION_CACHE_REL);
    const cache = readPositionCache(cachePath);
    snapshot = await fetchPolymarketSnapshot(TRACKED_WALLET_ADDRESSES, {
      concurrency: 6,
      timeoutMs: 10_000,
    });
    ingest = reconcileSnapshot(snapshot, cache);
    writePositionCache(cachePath, cacheFromSnapshot(snapshot));
    const stale = ingest.filter((state) => state.dataSource === "STALE").length;
    console.log(
      `[GraphPoller] polymarket live: ok=${snapshot.ok} failed=${snapshot.failed} stale=${stale} truncated=${snapshot.truncatedWallets.length} in ${snapshot.durationMs}ms`,
    );
    for (const state of ingest) {
      if (state.dataSource === "LIVE") continue;
      console.warn(
        `[GraphPoller] wallet ${state.address}: ${state.dataSource} (${state.lastError ?? "no cache"})`,
      );
    }
  }

  if (options?.liveF402) {
    const offline = process.env.F402_OFFLINE_ONLY?.trim() === "1";
    if (offline) {
      console.warn(
        "[GraphPoller] f402: F402_OFFLINE_ONLY=1 — session probe skipped",
      );
    } else {
      const agentId = process.env.F402_AGENT_ID?.trim() || "BILLY666";
      const baseUrl =
        process.env.F402_BASE_URL?.trim() || "https://fantasy402.com";
      let session = readF402Session();
      if (session === null) {
        try {
          session = await refreshF402Session();
          writeF402Session(session);
          console.log(
            `[GraphPoller] f402 logged in: ${describeF402Session(session)}`,
          );
        } catch (error) {
          console.warn(
            `[GraphPoller] f402 session unavailable: ${(error as Error).message}`,
          );
        }
      } else {
        console.log(
          `[GraphPoller] f402 cached: ${describeF402Session(session)}`,
        );
      }

      if (session !== null) {
        f402Probe = await probeF402BetTicker(session, { baseUrl, agentId });
        if (f402Probe.error === "unauthorized") {
          try {
            session = await refreshF402Session();
            writeF402Session(session);
            f402Probe = await probeF402BetTicker(session, { baseUrl, agentId });
            console.log("[GraphPoller] f402 session refreshed after 401");
          } catch (error) {
            console.warn(
              `[GraphPoller] f402 refresh failed: ${(error as Error).message}`,
            );
          }
        }
        console.log(
          `[GraphPoller] f402 probe: http=${f402Probe.httpStatus} rows=${f402Probe.rows} mapped=false${f402Probe.error ? ` error=${f402Probe.error}` : ""}`,
        );
      }
    }
  }

  const payload = buildGraphLiveFeed(pollCounter++, {
    ingest,
    snapshot,
    f402Probe,
    gsliveWagers: await readGsliveWagersSidecar(),
  });
  const docsTarget = path.join(repoRoot, "docs", "graph-live-feed.json");
  const distDir = path.join(repoRoot, "dist");
  const distTarget = path.join(distDir, "graph-live-feed.json");

  const serialized = JSON.stringify(payload, null, 2) + "\n";
  fs.writeFileSync(docsTarget, serialized, "utf8");
  if (payload.backtest4Wk) {
    const btJson = JSON.stringify(payload.backtest4Wk, null, 2) + "\n";
    fs.writeFileSync(
      path.join(repoRoot, "docs", "backtest-4wk-cfb-nba.json"),
      btJson,
      "utf8",
    );
    if (fs.existsSync(distDir))
      fs.writeFileSync(
        path.join(distDir, "backtest-4wk-cfb-nba.json"),
        btJson,
        "utf8",
      );
  }
  if (fs.existsSync(distDir)) {
    fs.writeFileSync(distTarget, serialized, "utf8");
  }

  console.log(
    `[GraphPoller] ✓ Poll #${payload.pollSequence} [${payload.dataMode}]: Synced ${payload.pendingBets.length} pending clusters (${payload.totalOpenLegsCount} legs / $${payload.totalOpenExposureUsd.toLocaleString()}) & ${payload.walletProfiles.length} wallet profiles @ ${payload.lastUpdatedCdt} (${payload.lastUpdatedIso})`,
  );

  if (syncR2) {
    const res = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "publish_r2_graph.mjs")],
      {
        cwd: repoRoot,
        stdio: "inherit",
      },
    );
    if (res.status === 0) {
      console.log(
        `[GraphPoller] ✓ Published live feed & graph.html to Cloudflare R2 edge @ ${payload.lastUpdatedCdt}`,
      );
    } else {
      console.error(
        `[GraphPoller] ✗ R2 publish failed (status ${String(res.status)}; signal ${String(res.signal)})`,
      );
    }
  }

  return payload;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const syncR2 = args.includes("--r2");
  const live =
    args.includes("--live") || process.env.SPORTSDESK_LIVE_INGEST === "1";
  const liveF402 =
    args.includes("--live-f402") || process.env.SPORTSDESK_LIVE_F402 === "1";

  const run = async (): Promise<void> => {
    try {
      await writeGraphLiveFeedOnce(syncR2, { live, liveF402 });
    } catch (error) {
      console.error(`[GraphPoller] ✗ poll failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  };

  await run();

  if (args.includes("--watch")) {
    const selfPath = path.join(
      repoRoot,
      "scripts",
      "graph_feed_poller_daemon.ts",
    );
    console.log(`[GraphPoller] Watching ${selfPath} for live updates...`);
    fs.watchFile(selfPath, { interval: 2000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) void run();
    });
  }
  if (
    args.includes("--cron") ||
    args.includes("--daemon") ||
    args.includes("--watch")
  ) {
    console.log(
      `[GraphPoller] Starting continuous 60s schedule (in-process Bun.cron, live=${live}, liveF402=${liveF402}, syncR2=${syncR2})...`,
    );
    const cronExpr = "* * * * *";
    const preview = previewCronSchedule(cronExpr);
    const job = startInProcessCron(cronExpr, async () => {
      await run();
    });
    wireInProcessCronLifecycle(job);
    console.log(`[GraphPoller] ${formatCronScheduleLine(preview)}`);
  }
}
