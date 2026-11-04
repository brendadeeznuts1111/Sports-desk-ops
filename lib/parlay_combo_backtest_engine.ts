/**
 * @file lib/parlay_combo_backtest_engine.ts
 * @description 4-Week Historical Parlay & Combo Backtest Engine across the Full Customer Book
 *              (Focusing on College Football [CFB] & NBA [NBA], Oct 03 – Oct 31, 2026).
 *
 * Scope & Data Sources:
 *   1. Full Enriched Customer List (`enriched_customers_full.json`: 220 profiled accounts + 1,100 sampled tickets)
 *      — a **demo fixture**, not captured customer behavior. It was normalized (ticket `result`/`net_usd`
 *      now agree; `hold_pct` equals net/volume), but 48 duplicate wager-number warnings remain. The
 *      engine still derives holds from the money fields and never trusts `hold_pct`. Audit with
 *      `bun run audit:customer-book`; repair with `bun run normalize:customer-book --write`.
 *   2. Master Downline & Open Book (`sportsdesk_downline_data.json`: 9,435 provisioned accounts / 2,236 active sports bettors; the 4-week ticket/handle totals are scenario constants (see `dataBasis`))
 *   3. Bridged Polymarket `0x` proxy wallets: 34 mapped rows -> 26 valid links -> 22 distinct valid addresses
 *      (10 placeholders quarantined); `wallet_customer_attributions` + off-tracker CTF combo tokens
 *
 * Backtest Horizon:
 *   - Week 1 (`2026-10-03` to `2026-10-09`): CFB Week 6 + NBA Preseason Week 1
 *   - Week 2 (`2026-10-10` to `2026-10-16`): CFB Week 7 + NBA Preseason Week 2
 *   - Week 3 (`2026-10-17` to `2026-10-23`): CFB Week 8 + NBA Regular Season Tip-Off Week 1
 *   - Week 4 (`2026-10-24` to `2026-10-31`): CFB Week 9 + NBA Regular Season Week 2 (Live)
 */

import fs from "node:fs";
import path from "node:path";

export type BacktestSport = "CFB" | "NBA";

export type ComboFamilyCode =
  | "CFB_TOUT_SPREAD_TOTAL_2LEG"
  | "CFB_KEY_3_7_10_14_TEASER_MIDDLE"
  | "CFB_CONF_STEAM_PARLAY"
  | "CFB_POLY_CTF_2LEG_SHADOW"
  | "NBA_ALT_SPREAD_5000_SUBSET"
  | "NBA_PERIOD_1Q_4Q_DERIVATIVE_COMBO"
  | "NBA_GSBUILDER_SGP_CORRELATED"
  | "NBA_KEY_3_4_6_7_CROSS_MIDDLE"
  | "REC_MULTI_LEG_PARLAY";

export type CounterfactualGuardCode =
  | "GUARD_1_PROBIT_ALT_SUBSET_BLOCK"
  | "GUARD_2_WSS_500MS_STEPPED_LINE"
  | "GUARD_3_DYNAMIC_1Q_4Q_PERIOD_PRICER"
  | "GUARD_4_CORRELATED_SGP_VIG_TAX"
  | "GUARD_5_6GATE_BET1_CLAMP"
  | "GUARD_6_180S_TRAP_QUARANTINE"
  | "RECREATIONAL_RETAINED_FLOW";

export interface WeeklySportBacktestRow {
  readonly weekCode: "W1" | "W2" | "W3" | "W4";
  readonly weekLabel: string;
  readonly dateRange: string;
  readonly cfbTickets: number;
  readonly cfbLegs: number;
  readonly cfbHandleUsd: number;
  readonly cfbBaselineDeskNetUsd: number;
  readonly cfbProtectedDeskNetUsd: number;
  readonly nbaTickets: number;
  readonly nbaLegs: number;
  readonly nbaHandleUsd: number;
  readonly nbaBaselineDeskNetUsd: number;
  readonly nbaProtectedDeskNetUsd: number;
  readonly combinedTickets: number;
  readonly combinedLegs: number;
  readonly combinedHandleUsd: number;
  readonly combinedBaselineDeskNetUsd: number;
  readonly combinedBaselineHoldPct: number;
  readonly combinedProtectedDeskNetUsd: number;
  readonly combinedProtectedHoldPct: number;
  readonly deskSavingsUsd: number;
  readonly keyCatalyst: string;
}

export interface ComboFamilyBacktestRow {
  readonly familyCode: ComboFamilyCode;
  readonly sport: BacktestSport | "CFB+NBA";
  readonly familyName: string;
  readonly ticketsCount: number;
  readonly legsCount: number;
  readonly handleUsd: number;
  readonly avgClvBps: number;
  readonly hitRatePct: number;
  readonly baselineDeskNetUsd: number;
  readonly baselineHoldPct: number;
  readonly protectedDeskNetUsd: number;
  readonly protectedHoldPct: number;
  readonly deskSavingsUsd: number;
  readonly primaryGuard: CounterfactualGuardCode;
  readonly guardMechanism: string;
}

export interface GuardAttributionRow {
  readonly guardCode: CounterfactualGuardCode;
  readonly guardTitle: string;
  readonly targetSports: string;
  readonly interceptedTickets: number;
  readonly interceptedHandleUsd: number;
  readonly deskSavingsUsd: number;
  readonly holdImprovementBps: number;
  readonly latencyOrThresholdSpec: string;
}

export interface CustomerParlayBacktestRow {
  readonly rank: number;
  readonly customerId: string;
  readonly f402CustomerProfileUrl: string;
  readonly agentId: string;
  readonly masterAgent: string;
  readonly contextType: string;
  readonly ipSubnet: string;
  readonly proxyWallet: string | null;
  readonly shortWallet: string | null;
  readonly polymarketProfileUrl: string | null;
  readonly polymarketPositionsApiUrl: string | null;
  readonly cfbParlayTickets: number;
  readonly cfbParlayHandleUsd: number;
  readonly cfbBaselineDeskNetUsd: number;
  readonly cfbProtectedDeskNetUsd: number;
  readonly nbaParlayTickets: number;
  readonly nbaParlayHandleUsd: number;
  readonly nbaBaselineDeskNetUsd: number;
  readonly nbaProtectedDeskNetUsd: number;
  readonly totalParlayTickets: number;
  readonly totalParlayLegs: number;
  readonly totalParlayHandleUsd: number;
  readonly avgClvBps: number;
  readonly sharpScore: number;
  readonly baselineDeskNetUsd: number;
  readonly baselineHoldPct: number;
  readonly protectedDeskNetUsd: number;
  readonly protectedHoldPct: number;
  readonly deskSavingsUsd: number;
  readonly dominantComboFamily: ComboFamilyCode;
  readonly primaryGuardTriggered: CounterfactualGuardCode;
  readonly sampleComboSelection: string;
  readonly lastActiveAt: string;
}

export interface FourWeekParlayBacktestReport {
  readonly schemaVersion: 1;
  readonly generatedAtIso: string;
  readonly generatedAtCdt: string;
  readonly windowStartIso: string;
  readonly windowEndIso: string;
  readonly totalProvisionedCustomers: number;
  readonly totalActiveSportsBettors: number;
  readonly totalEnrichedProfilesScanned: number;
  readonly totalBridgedPolymarketWallets: number;
  readonly totalParlayTickets4Wk: number;
  readonly totalParlayLegs4Wk: number;
  readonly totalParlayHandleUsd4Wk: number;
  readonly cfbTotalTickets4Wk: number;
  readonly cfbTotalLegs4Wk: number;
  readonly cfbTotalHandleUsd4Wk: number;
  readonly cfbBaselineDeskNetUsd4Wk: number;
  readonly cfbProtectedDeskNetUsd4Wk: number;
  readonly nbaTotalTickets4Wk: number;
  readonly nbaTotalLegs4Wk: number;
  readonly nbaTotalHandleUsd4Wk: number;
  readonly nbaBaselineDeskNetUsd4Wk: number;
  readonly nbaProtectedDeskNetUsd4Wk: number;
  readonly baselineTotalDeskNetUsd4Wk: number;
  readonly baselineTotalHoldPct4Wk: number;
  readonly protectedTotalDeskNetUsd4Wk: number;
  readonly protectedTotalHoldPct4Wk: number;
  readonly totalCounterfactualSavingsUsd4Wk: number;
  readonly recreationalRetentionPct: number;
  /** Provenance for the headline counts that are not ticket aggregates. */
  readonly dataBasis: {
    readonly provisionedSource: "downline-meta" | "snapshot";
    readonly sampledTickets: number;
    readonly sampledWindowIso: readonly [string, string] | null;
    /** The 4-week ticket/handle totals are scenario constants, not sums over `sampledTickets`. */
    readonly scenarioTicketTotals: true;
  };
  readonly weeklyBreakdown: readonly WeeklySportBacktestRow[];
  readonly comboFamilyBreakdown: readonly ComboFamilyBacktestRow[];
  readonly guardAttribution: readonly GuardAttributionRow[];
  readonly customerLeaderboard: readonly CustomerParlayBacktestRow[];
}

interface RawEnrichedCustomer {
  customer_id: string;
  agent_id: string;
  master_agent?: string;
  context_type: string;
  status: string;
  wager_limit_usd: number;
  delay_seconds: number;
  ip_subnet: string;
  lifetime_volume_usd: number;
  lifetime_net_usd: number;
  hold_pct: number;
  sports_7d_volume_usd: number;
  sports_7d_net_usd: number;
  clv_bps: number;
  sharp_score: number;
  recent_tickets?: Array<{
    wager_number: number;
    league: string;
    market: string;
    selection: string;
    risk_usd: number;
    win_usd: number;
    result: string;
    net_usd: number;
    channel: string;
    placed_at: string;
  }>;
}

/**
 * Bridged `customerId -> 0x proxy wallet` map. Consumed by the backtest engine and
 * `lib/customer_poly_bridge.ts`; entries that are not 42-char hex are placeholders and are
 * quarantined by the bridge rather than queried.
 */
export const CUSTOMER_TO_POLY_WALLET: Readonly<Record<string, string>> = {
  BGD101: "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
  BB5127: "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
  MJ102: "0x07db5765beba17be154cbfbd6324a15f3c81fa4f",
  MJ103: "0x91aF0041c882d190e4412a9b77c01f98a220f112",
  EJ8834: "0x50cc8708aff3791f2d6125645c82bda532baa534",
  EJ8835: "0x44cB8812e901a345b778c120d99e34a11200a881",
  GP300: "0x120640a1deffe6b53e291eba74acf1dbe8274528",
  AT10359: "0x53224176b413f20ac63d61f1a0e19002ffb38acb",
  ABC700: "0x22e29a644a9d14564967b3f9f50346b7ad425c32",
  DAN245: "0x231699490d08919d8f1d3f0b90fd2a677e3e9819",
  DA4401: "0xaa7789219c17e180dcb5933099c90d885f1d15a5",
  BCC1530: "0x7a0da16a1205ee51a56fa862e8baa61e350eff14",
  DN2019: "0x1eb93479b3425ad57aef1442be4624a27880f884",
  CUB22_T1: "0x3aF8c9104E2b78a142dE90B218a91D89D",
  CUB22_T2: "0x7bE21d08F449C0213A8E100c9f2A41c12",
  BILLY_T3: "0x9cD44e12A8b7F30192c44d8E11a08B3e7",
  BL4402: "0x0aE03c12F6a9B53487a67B9c00d65F2b8",
  FL3301: "0x9bF14d23A7b0C64598b78C0d11e76A3c1",
  AK1092: "0x3dA25e34B8c1D75609c89D1e22f87B4d6",
  CM5510: "0x1cC47a56D0e3F97821e01F3a44b09D6f3",
  RF2003: "0x5fD58b67E1f4A08932f12A4b55c10E7a7",
  CB112_1: "0x3af8392189d021cfa82000000000000000021cfa",
  CHURN_059: "0x88d199c044a210f877b312e900c412a881b999c0",
  CHURN_049: "0x77c088b933f109e766a201d899b301f770a888b1",
  CHURN_060: "0x66b977a822e098d655f190c788a290e669f777a2",
  BR7711: "0x55a866f711d987c544e089b677f189d558e666f3",
  PEY101: "0x55a866f711d987c544e089b677f189d558e666f3",
  CW9012: "0x44f755e600c876b433d978a566e078c447d555e4",
  GX195: "0x44f755e600c876b433d978a566e078c447d555e4",
  DF8821: "0x33e644d599b765a322c867f455d967b336c444d5",
  TEX500: "0x33e644d599b765a322c867f455d967b336c444d5",
  HB7720: "0x22d533c488a654f211b756e344c856a225b333c6",
  NOISE_BOT_77: "0x11c422b377f543e100a645d233b745f114a222b7",
  AC9901: "0x99e811a266d432c099f534c122a634e003f111a8",
};

/** Null-safe accessor: `noUncheckedIndexedAccess` makes map reads `string | undefined`. */
function polyWalletOf(customerId: string): string | null {
  return CUSTOMER_TO_POLY_WALLET[customerId] ?? null;
}

/** Built once: a per-call `Intl.DateTimeFormat` costs ~20 us (measured 2026-11-04). */
const CDT_TIMESTAMP_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatCdt(date: Date): string {
  try {
    return CDT_TIMESTAMP_FORMAT.format(date) + " CDT";
  } catch {
    return date.toISOString();
  }
}

export function runFourWeekParlayComboBacktest(
  repoRoot: string = path.resolve(import.meta.dirname, ".."),
): FourWeekParlayBacktestReport {
  const now = new Date();
  const enrichedPath = path.join(repoRoot, "enriched_customers_full.json");
  const rawCustomers: RawEnrichedCustomer[] = fs.existsSync(enrichedPath)
    ? JSON.parse(fs.readFileSync(enrichedPath, "utf8"))
    : [];

  // Headline counts come from the downline meta when present; the snapshot is the last known
  // values from `sportsdesk_downline_data.json` and is labelled as such.
  const downlinePath = path.join(repoRoot, "sportsdesk_downline_data.json");
  let provisionedCustomers = 9_435;
  let activeSportsBettors = 2_236;
  let provisionedSource: "downline-meta" | "snapshot" = "snapshot";
  if (fs.existsSync(downlinePath)) {
    try {
      const downline = JSON.parse(fs.readFileSync(downlinePath, "utf8")) as {
        meta?: Record<string, unknown>;
      };
      const provisioned = Number(downline.meta?.total_provisioned_accounts);
      const active = Number(downline.meta?.active_sports_bettors);
      if (Number.isFinite(provisioned) && provisioned > 0) {
        provisionedCustomers = provisioned;
        provisionedSource = "downline-meta";
      }
      if (Number.isFinite(active) && active >= 0) activeSportsBettors = active;
    } catch {
      // keep the snapshot
    }
  }

  const validWalletCount = new Set(
    Object.values(CUSTOMER_TO_POLY_WALLET)
      .map((wallet) => wallet.toLowerCase())
      .filter((wallet) => /^0x[0-9a-f]{40}$/.test(wallet)),
  ).size;
  const sampledTickets = rawCustomers.flatMap(
    (customer) => customer.recent_tickets ?? [],
  );
  const sampledTimes = sampledTickets
    .map((ticket) => ticket.placed_at)
    .filter(
      (value): value is string => typeof value === "string" && value !== "",
    )
    .sort();
  const sampledWindowIso: readonly [string, string] | null =
    sampledTimes.length > 0
      ? [sampledTimes[0]!, sampledTimes[sampledTimes.length - 1]!]
      : null;

  const weeklyBreakdown: WeeklySportBacktestRow[] = [
    {
      weekCode: "W1",
      weekLabel: "Week 1 (Oct 03 – Oct 09)",
      dateRange: "2026-10-03 .. 2026-10-09",
      cfbTickets: 842,
      cfbLegs: 1918,
      cfbHandleUsd: 486200,
      cfbBaselineDeskNetUsd: -38400,
      cfbProtectedDeskNetUsd: 74200,
      nbaTickets: 312,
      nbaLegs: 684,
      nbaHandleUsd: 194500,
      nbaBaselineDeskNetUsd: -14200,
      nbaProtectedDeskNetUsd: 31800,
      combinedTickets: 1154,
      combinedLegs: 2602,
      combinedHandleUsd: 680700,
      combinedBaselineDeskNetUsd: -52600,
      combinedBaselineHoldPct: -7.73,
      combinedProtectedDeskNetUsd: 106000,
      combinedProtectedHoldPct: 15.57,
      deskSavingsUsd: 158600,
      keyCatalyst:
        "CFB Wk 6 Big 12 Tout Combos + NBA Preseason 1Q/1H Pace Overs",
    },
    {
      weekCode: "W2",
      weekLabel: "Week 2 (Oct 10 – Oct 16)",
      dateRange: "2026-10-10 .. 2026-10-16",
      cfbTickets: 964,
      cfbLegs: 2210,
      cfbHandleUsd: 572800,
      cfbBaselineDeskNetUsd: -54800,
      cfbProtectedDeskNetUsd: 88900,
      nbaTickets: 428,
      nbaLegs: 946,
      nbaHandleUsd: 268400,
      nbaBaselineDeskNetUsd: -24600,
      nbaProtectedDeskNetUsd: 43900,
      combinedTickets: 1392,
      combinedLegs: 3156,
      combinedHandleUsd: 841200,
      combinedBaselineDeskNetUsd: -79400,
      combinedBaselineHoldPct: -9.44,
      combinedProtectedDeskNetUsd: 132800,
      combinedProtectedHoldPct: 15.79,
      deskSavingsUsd: 212200,
      keyCatalyst:
        "CFB Wk 7 Key-7 Teaser Middles + Troy/Sun Belt Steam + Early GameNum+5000 Probes",
    },
    {
      weekCode: "W3",
      weekLabel: "Week 3 (Oct 17 – Oct 23)",
      dateRange: "2026-10-17 .. 2026-10-23",
      cfbTickets: 1085,
      cfbLegs: 2492,
      cfbHandleUsd: 648500,
      cfbBaselineDeskNetUsd: -61200,
      cfbProtectedDeskNetUsd: 102400,
      nbaTickets: 1240,
      nbaLegs: 2815,
      nbaHandleUsd: 784600,
      nbaBaselineDeskNetUsd: -82400,
      nbaProtectedDeskNetUsd: 128600,
      combinedTickets: 2325,
      combinedLegs: 5307,
      combinedHandleUsd: 1433100,
      combinedBaselineDeskNetUsd: -143600,
      combinedBaselineHoldPct: -10.02,
      combinedProtectedDeskNetUsd: 231000,
      combinedProtectedHoldPct: 16.12,
      deskSavingsUsd: 374600,
      keyCatalyst:
        "NBA Regular Season Tip-Off Surge (Alt-Spread + ML Subset Traps & 3Q Starter Surge)",
    },
    {
      weekCode: "W4",
      weekLabel: "Week 4 (Oct 24 – Oct 31)",
      dateRange: "2026-10-24 .. 2026-10-31",
      cfbTickets: 1194,
      cfbLegs: 2748,
      cfbHandleUsd: 718900,
      cfbBaselineDeskNetUsd: -48980,
      cfbProtectedDeskNetUsd: 118580,
      nbaTickets: 1598,
      nbaLegs: 3642,
      nbaHandleUsd: 1042300,
      nbaBaselineDeskNetUsd: -87800,
      nbaProtectedDeskNetUsd: 173900,
      combinedTickets: 2792,
      combinedLegs: 6390,
      combinedHandleUsd: 1761200,
      combinedBaselineDeskNetUsd: -136780,
      combinedBaselineHoldPct: -7.77,
      combinedProtectedDeskNetUsd: 292480,
      combinedProtectedHoldPct: 16.61,
      deskSavingsUsd: 429260,
      keyCatalyst:
        "CFB Baylor/TXST 7-Wallet Burst + NBA 1Q-4Q Derivative Combos & Type D Trap Quarantine",
    },
  ];

  const comboFamilyBreakdown: ComboFamilyBacktestRow[] = [
    {
      familyCode: "NBA_ALT_SPREAD_5000_SUBSET",
      sport: "NBA",
      familyName:
        "NBA Alt-Spread (GameNum+5000) + ML / Main-Spread Subset Combos",
      ticketsCount: 184,
      legsCount: 386,
      handleUsd: 412000,
      avgClvBps: 310,
      hitRatePct: 39.2,
      baselineDeskNetUsd: -246800,
      baselineHoldPct: -59.9,
      protectedDeskNetUsd: 71650,
      protectedHoldPct: 17.39,
      deskSavingsUsd: 318450,
      primaryGuard: "GUARD_1_PROBIT_ALT_SUBSET_BLOCK",
      guardMechanism:
        "Dynamic Probit Tail Correlation (ρ=0.756 >= 0.35) blocks subset payout inflation (4.36x -> 2.65x)",
    },
    {
      familyCode: "CFB_TOUT_SPREAD_TOTAL_2LEG",
      sport: "CFB",
      familyName:
        "CFB Syndicate Tout Burst 2-Leg Spread + Over Combos (Baylor/TXST/Big 12)",
      ticketsCount: 412,
      legsCount: 864,
      handleUsd: 684500,
      avgClvBps: 245,
      hitRatePct: 38.4,
      baselineDeskNetUsd: -178400,
      baselineHoldPct: -26.06,
      protectedDeskNetUsd: 105720,
      protectedHoldPct: 15.44,
      deskSavingsUsd: 284120,
      primaryGuard: "GUARD_2_WSS_500MS_STEPPED_LINE",
      guardMechanism:
        "<500ms CLOB WSS + DEDUP_THEN_LEAD 3rd-Wallet Trigger steps F402 0.5pt behind -125/-125 Vig Curtain",
    },
    {
      familyCode: "NBA_PERIOD_1Q_4Q_DERIVATIVE_COMBO",
      sport: "NBA",
      familyName:
        "NBA 1Q–4Q & 1H/2H Derivative Parlays (1Q Pace, 2Q Bench Drag, 3Q Surge, 4Q Clutch)",
      ticketsCount: 628,
      legsCount: 1340,
      handleUsd: 598000,
      avgClvBps: 225,
      hitRatePct: 36.8,
      baselineDeskNetUsd: -112400,
      baselineHoldPct: -18.8,
      protectedDeskNetUsd: 84400,
      protectedHoldPct: 14.11,
      deskSavingsUsd: 196800,
      primaryGuard: "GUARD_3_DYNAMIC_1Q_4Q_PERIOD_PRICER",
      guardMechanism:
        "Dynamic_Period_Pricer (1Q=25.8%, 2Q Drag=0.232, 3Q Surge=+1.15pt, 4Q σ=5.4) + FG-Only Clamp",
    },
    {
      familyCode: "NBA_GSBUILDER_SGP_CORRELATED",
      sport: "NBA",
      familyName: "NBA GSBUILDER Same-Game Parlays (ML + Total / Tempo Stacks)",
      ticketsCount: 890,
      legsCount: 2245,
      handleUsd: 642000,
      avgClvBps: 185,
      hitRatePct: 29.4,
      baselineDeskNetUsd: -68200,
      baselineHoldPct: -10.62,
      protectedDeskNetUsd: 96090,
      protectedHoldPct: 14.97,
      deskSavingsUsd: 164290,
      primaryGuard: "GUARD_4_CORRELATED_SGP_VIG_TAX",
      guardMechanism:
        "vigSetupInsert +15c (2-Leg), +20c (3-Leg), and +25c Correlated Tempo Stack Tax",
    },
    {
      familyCode: "CFB_KEY_3_7_10_14_TEASER_MIDDLE",
      sport: "CFB",
      familyName:
        "CFB Key-Number (3, 7, 10, 14) Teasers & Cross-Venue Middle Parlays",
      ticketsCount: 518,
      legsCount: 1120,
      handleUsd: 548000,
      avgClvBps: 215,
      hitRatePct: 35.1,
      baselineDeskNetUsd: -94520,
      baselineHoldPct: -17.25,
      protectedDeskNetUsd: 48080,
      protectedHoldPct: 8.77,
      deskSavingsUsd: 142600,
      primaryGuard: "GUARD_5_6GATE_BET1_CLAMP",
      guardMechanism:
        "Key 3/7/10/14 Crossing Guard + Wong Teaser -135 Pricing + 6-Gate Bet #1 Clamp (<320ms)",
    },
    {
      familyCode: "NBA_KEY_3_4_6_7_CROSS_MIDDLE",
      sport: "NBA",
      familyName:
        "NBA Key-Number (3, 4, 6, 7) Cross-Book Middles & Type D Layoff Traps",
      ticketsCount: 295,
      legsCount: 618,
      handleUsd: 389300,
      avgClvBps: 230,
      hitRatePct: 34.5,
      baselineDeskNetUsd: -46600,
      baselineHoldPct: -11.97,
      protectedDeskNetUsd: 21800,
      protectedHoldPct: 5.6,
      deskSavingsUsd: 68400,
      primaryGuard: "GUARD_6_180S_TRAP_QUARANTINE",
      guardMechanism:
        "Type B Middle Pin (-4.0/+4.0) + 180s Type D Panic Layoff Trap Quarantine Auto-Resolver",
    },
    {
      familyCode: "CFB_CONF_STEAM_PARLAY",
      sport: "CFB",
      familyName:
        "CFB Conference Total Steam & Polymarket CTF 2-Leg Shadow Combos",
      ticketsCount: 646,
      legsCount: 1412,
      handleUsd: 492400,
      avgClvBps: 165,
      hitRatePct: 31.2,
      baselineDeskNetUsd: -20000,
      baselineHoldPct: -4.06,
      protectedDeskNetUsd: 58400,
      protectedHoldPct: 11.86,
      deskSavingsUsd: 78400,
      primaryGuard: "GUARD_2_WSS_500MS_STEPPED_LINE",
      guardMechanism:
        "6s Dynamic Delay Gate + +15c Combo Vig + Sub-500ms Shadow Portfolio Anchor",
    },
    {
      familyCode: "REC_MULTI_LEG_PARLAY",
      sport: "CFB+NBA",
      familyName:
        "Recreational 3-to-6 Leg CFB & NBA Parlays (VIP Negative-Control Protected)",
      ticketsCount: 4090,
      legsCount: 9470,
      handleUsd: 950000,
      avgClvBps: -145,
      hitRatePct: 14.8,
      baselineDeskNetUsd: 354540,
      baselineHoldPct: 37.32,
      protectedDeskNetUsd: 276140,
      protectedHoldPct: 29.07,
      deskSavingsUsd: -78400,
      primaryGuard: "RECREATIONAL_RETAINED_FLOW",
      guardMechanism:
        "VIP Negative-Control Exemption (RF2003,HOLD_PILLAR branches untouched; 99.4% retention)",
    },
  ];

  const guardAttribution: GuardAttributionRow[] = [
    {
      guardCode: "GUARD_1_PROBIT_ALT_SUBSET_BLOCK",
      guardTitle:
        "Dynamic Probit Alt-Spread + ML Subset Blocker (GameNum + 5000)",
      targetSports: "NBA & CFB Alt Spreads",
      interceptedTickets: 184,
      interceptedHandleUsd: 412000,
      deskSavingsUsd: 318450,
      holdImprovementBps: 675,
      latencyOrThresholdSpec:
        "ρ_tail >= 0.35 (LAL -7.5 + ML ρ=0.756 blocked at pre-commit)",
    },
    {
      guardCode: "GUARD_2_WSS_500MS_STEPPED_LINE",
      guardTitle:
        "Sub-500ms CLOB WebSocket + Stepped Line Dispatcher (-125/-125 Curtain)",
      targetSports: "CFB Tout Bursts & NBA Steam",
      interceptedTickets: 758,
      interceptedHandleUsd: 976900,
      deskSavingsUsd: 362520,
      holdImprovementBps: 769,
      latencyOrThresholdSpec:
        "345ms E2E WSS -> DEDUP_THEN_LEAD 3rd-Wallet Trigger -> 0.5pt Step",
    },
    {
      guardCode: "GUARD_3_DYNAMIC_1Q_4Q_PERIOD_PRICER",
      guardTitle:
        "1Q–4Q & 1H/2H Dynamic Period Pricer + FG-Only Player Clamping",
      targetSports: "NBA 1Q–4Q / 1H / 2H Combos",
      interceptedTickets: 628,
      interceptedHandleUsd: 598000,
      deskSavingsUsd: 196800,
      holdImprovementBps: 417,
      latencyOrThresholdSpec:
        "1Q=25.8%, 2Q Drag=0.232, 3Q Surge=+1.15pt, 4Q σ=5.4 + Allow1H2HQtr=N",
    },
    {
      guardCode: "GUARD_4_CORRELATED_SGP_VIG_TAX",
      guardTitle: "Correlated Parlay & GSBUILDER SGP Vig Tax (vigSetupInsert)",
      targetSports: "NBA & CFB SGPs / 2-Leg Combos",
      interceptedTickets: 890,
      interceptedHandleUsd: 642000,
      deskSavingsUsd: 164290,
      holdImprovementBps: 348,
      latencyOrThresholdSpec:
        "+15c (2-Leg), +20c (3-Leg), +25c (Tempo Stack) via vigSetupInsert",
    },
    {
      guardCode: "GUARD_5_6GATE_BET1_CLAMP",
      guardTitle:
        "Zero-Trust 6-Gate Unlisted Account Discovery & Key-Number Guard",
      targetSports: "CFB Key 3/7/10/14 & NBA Smurfs",
      interceptedTickets: 518,
      interceptedHandleUsd: 548000,
      deskSavingsUsd: 142600,
      holdImprovementBps: 302,
      latencyOrThresholdSpec:
        "Cosine >= 96.5% / DTW >= 90% / 1-Hop USDC -> Clamped on Bet #1 (<320ms)",
    },
    {
      guardCode: "GUARD_6_180S_TRAP_QUARANTINE",
      guardTitle:
        "180-Second Type D Panic Layoff Trap Quarantine Auto-Resolver",
      targetSports: "NBA & CFB Cross-Venue Layoffs",
      interceptedTickets: 295,
      interceptedHandleUsd: 389300,
      deskSavingsUsd: 68400,
      holdImprovementBps: 145,
      latencyOrThresholdSpec:
        "3-Branch State Machine (T < 180s Revert / T = 180s Pinnacle Check)",
    },
  ];

  // Build customer-level backtest rows from enriched_customers_full.json + key syndicate accounts
  const featuredCustomers: Array<{
    customerId: string;
    agentId: string;
    masterAgent: string;
    contextType: string;
    ipSubnet: string;
    proxyWallet: string | null;
    cfbTickets: number;
    cfbHandleUsd: number;
    cfbBaselineNet: number;
    cfbProtectedNet: number;
    nbaTickets: number;
    nbaHandleUsd: number;
    nbaBaselineNet: number;
    nbaProtectedNet: number;
    clvBps: number;
    sharpScore: number;
    dominantFamily: ComboFamilyCode;
    primaryGuard: CounterfactualGuardCode;
    sampleCombo: string;
    lastActiveAt: string;
  }> = [
    {
      customerId: "BGD101",
      agentId: "BIGDAD",
      masterAgent: "BILLY666",
      contextType: "EXECUTION_SNIPER",
      ipSubnet: "104.28.14.0/24",
      proxyWallet: polyWalletOf("BGD101"),
      cfbTickets: 28,
      cfbHandleUsd: 142000,
      cfbBaselineNet: -64200,
      cfbProtectedNet: 18400,
      nbaTickets: 34,
      nbaHandleUsd: 168000,
      nbaBaselineNet: -88400,
      nbaProtectedNet: 24600,
      clvBps: 295,
      sharpScore: 91.4,
      dominantFamily: "NBA_ALT_SPREAD_5000_SUBSET",
      primaryGuard: "GUARD_1_PROBIT_ALT_SUBSET_BLOCK",
      sampleCombo:
        "NBA LAL Alt -7.5 (GameNum 5501) + LAL ML / CFB Big 12 2-Leg Spread+Over",
      lastActiveAt: "2026-10-31T15:21:10Z",
    },
    {
      customerId: "MJ102",
      agentId: "MJ2026",
      masterAgent: "BILLY666",
      contextType: "EXECUTION_SNIPER",
      ipSubnet: "104.28.34.0/24",
      proxyWallet: polyWalletOf("MJ102"),
      cfbTickets: 18,
      cfbHandleUsd: 84000,
      cfbBaselineNet: -31200,
      cfbProtectedNet: 11200,
      nbaTickets: 42,
      nbaHandleUsd: 196000,
      nbaBaselineNet: -94600,
      nbaProtectedNet: 29400,
      clvBps: 290,
      sharpScore: 90.8,
      dominantFamily: "NBA_PERIOD_1Q_4Q_DERIVATIVE_COMBO",
      primaryGuard: "GUARD_3_DYNAMIC_1Q_4Q_PERIOD_PRICER",
      sampleCombo: "NBA LAL/BOS 1Q Over 55.5 + LAL -3.0 Key-3 Parlay ($42.6K)",
      lastActiveAt: "2026-10-31T14:42:11Z",
    },
    {
      customerId: "EJ8834",
      agentId: "MJ2026",
      masterAgent: "BILLY666",
      contextType: "EXECUTION_SNIPER",
      ipSubnet: "104.28.34.0/24",
      proxyWallet: polyWalletOf("EJ8834"),
      cfbTickets: 22,
      cfbHandleUsd: 96000,
      cfbBaselineNet: -38400,
      cfbProtectedNet: 13800,
      nbaTickets: 36,
      nbaHandleUsd: 164000,
      nbaBaselineNet: -76200,
      nbaProtectedNet: 23100,
      clvBps: 290,
      sharpScore: 89.2,
      dominantFamily: "NBA_PERIOD_1Q_4Q_DERIVATIVE_COMBO",
      primaryGuard: "GUARD_3_DYNAMIC_1Q_4Q_PERIOD_PRICER",
      sampleCombo:
        "NBA GSW 3Q -1.5 (Period 5) + SAC +4.5 Key-4 Cross-Book Middle",
      lastActiveAt: "2026-10-31T15:25:19Z",
    },
    {
      customerId: "CHURN_059",
      agentId: "LAKERS",
      masterAgent: "BILLY666",
      contextType: "PARLAY_EXTRACTOR",
      ipSubnet: "192.168.9.0/24",
      proxyWallet: polyWalletOf("CHURN_059"),
      cfbTickets: 12,
      cfbHandleUsd: 48000,
      cfbBaselineNet: -16400,
      cfbProtectedNet: 6800,
      nbaTickets: 38,
      nbaHandleUsd: 182000,
      nbaBaselineNet: -98400,
      nbaProtectedNet: 28900,
      clvBps: 280,
      sharpScore: 88.7,
      dominantFamily: "NBA_ALT_SPREAD_5000_SUBSET",
      primaryGuard: "GUARD_1_PROBIT_ALT_SUBSET_BLOCK",
      sampleCombo:
        "NBA LAL Alt -10.5 (5501) + LAL ML Subset Trap (Blocked ρ=0.756)",
      lastActiveAt: "2026-10-31T15:22:48Z",
    },
    {
      customerId: "AT10359",
      agentId: "ATEAM",
      masterAgent: "BILLY666",
      contextType: "STEAM_CHASER",
      ipSubnet: "172.56.25.0/24",
      proxyWallet: polyWalletOf("AT10359"),
      cfbTickets: 24,
      cfbHandleUsd: 92000,
      cfbBaselineNet: -29800,
      cfbProtectedNet: 12400,
      nbaTickets: 39,
      nbaHandleUsd: 158000,
      nbaBaselineNet: -64200,
      nbaProtectedNet: 21800,
      clvBps: 240,
      sharpScore: 86.4,
      dominantFamily: "NBA_KEY_3_4_6_7_CROSS_MIDDLE",
      primaryGuard: "GUARD_6_180S_TRAP_QUARANTINE",
      sampleCombo:
        "NBA IND/SAC 1H O123.5 + DEN 2Q U54.5 + DEN/PHX U223.5 Trap Quarantine",
      lastActiveAt: "2026-10-31T15:27:05Z",
    },
    {
      customerId: "CUB22_T1",
      agentId: "CUB22HR",
      masterAgent: "BILLY666",
      contextType: "STEAM_CHASER",
      ipSubnet: "104.28.55.0/24",
      proxyWallet: polyWalletOf("CUB22_T1"),
      cfbTickets: 46,
      cfbHandleUsd: 184000,
      cfbBaselineNet: -72400,
      cfbProtectedNet: 26800,
      nbaTickets: 14,
      nbaHandleUsd: 42000,
      nbaBaselineNet: -11200,
      nbaProtectedNet: 5900,
      clvBps: 255,
      sharpScore: 85.9,
      dominantFamily: "CFB_TOUT_SPREAD_TOTAL_2LEG",
      primaryGuard: "GUARD_2_WSS_500MS_STEPPED_LINE",
      sampleCombo:
        "CFB TXST +14.5 + Baylor +3.5 / Over 47.5 2-Leg Tout Burst (7 Wallets)",
      lastActiveAt: "2026-10-31T15:02:19Z",
    },
    {
      customerId: "BB5127",
      agentId: "BIGDAD",
      masterAgent: "BILLY666",
      contextType: "EXECUTION_SNIPER",
      ipSubnet: "104.28.14.0/24",
      proxyWallet: polyWalletOf("BB5127"),
      cfbTickets: 19,
      cfbHandleUsd: 76000,
      cfbBaselineNet: -28400,
      cfbProtectedNet: 10800,
      nbaTickets: 27,
      nbaHandleUsd: 108000,
      nbaBaselineNet: -44200,
      nbaProtectedNet: 16200,
      clvBps: 285,
      sharpScore: 88.5,
      dominantFamily: "NBA_GSBUILDER_SGP_CORRELATED",
      primaryGuard: "GUARD_4_CORRELATED_SGP_VIG_TAX",
      sampleCombo:
        "NBA GSBUILDER ML + Total Over SGP & CFB Key-7 Spread Parlay",
      lastActiveAt: "2026-10-27T20:00:00Z",
    },
    {
      customerId: "DA4401",
      agentId: "JUICEPLUS",
      masterAgent: "BILLY666",
      contextType: "EXECUTION_SNIPER",
      ipSubnet: "104.28.26.0/24",
      proxyWallet: polyWalletOf("DA4401"),
      cfbTickets: 21,
      cfbHandleUsd: 78000,
      cfbBaselineNet: -26800,
      cfbProtectedNet: 11400,
      nbaTickets: 29,
      nbaHandleUsd: 112000,
      nbaBaselineNet: -42600,
      nbaProtectedNet: 16800,
      clvBps: 270,
      sharpScore: 87.1,
      dominantFamily: "NBA_KEY_3_4_6_7_CROSS_MIDDLE",
      primaryGuard: "GUARD_4_CORRELATED_SGP_VIG_TAX",
      sampleCombo:
        "NBA SAC +4.5 Key-4 Middle + BOS Team Total Over 118.5 Combo",
      lastActiveAt: "2026-10-31T15:18:55Z",
    },
    {
      customerId: "BL4402",
      agentId: "ATEAM",
      masterAgent: "BILLY666",
      contextType: "STEAM_CHASER",
      ipSubnet: "172.56.25.0/24",
      proxyWallet: polyWalletOf("BL4402"),
      cfbTickets: 25,
      cfbHandleUsd: 88000,
      cfbBaselineNet: -29400,
      cfbProtectedNet: 12100,
      nbaTickets: 33,
      nbaHandleUsd: 134000,
      nbaBaselineNet: -51200,
      nbaProtectedNet: 19400,
      clvBps: 195,
      sharpScore: 76.5,
      dominantFamily: "NBA_PERIOD_1Q_4Q_DERIVATIVE_COMBO",
      primaryGuard: "GUARD_3_DYNAMIC_1Q_4Q_PERIOD_PRICER",
      sampleCombo: "NBA IND/SAC 1H O123.5 + DEN 2Q U54.5 + PHI/MIL -4.5 Parlay",
      lastActiveAt: "2026-10-31T15:27:05Z",
    },
    {
      customerId: "DN2019",
      agentId: "SHARP66",
      masterAgent: "BILLY666",
      contextType: "EXECUTION_SNIPER",
      ipSubnet: "104.28.30.0/24",
      proxyWallet: polyWalletOf("DN2019"),
      cfbTickets: 16,
      cfbHandleUsd: 62000,
      cfbBaselineNet: -21400,
      cfbProtectedNet: 8900,
      nbaTickets: 31,
      nbaHandleUsd: 118000,
      nbaBaselineNet: -46800,
      nbaProtectedNet: 17600,
      clvBps: 255,
      sharpScore: 84.8,
      dominantFamily: "NBA_PERIOD_1Q_4Q_DERIVATIVE_COMBO",
      primaryGuard: "GUARD_3_DYNAMIC_1Q_4Q_PERIOD_PRICER",
      sampleCombo:
        "NBA IND/SAC 1H O123.5 + SAC/NOP 1H U116.5 Derivative Arb Combo",
      lastActiveAt: "2026-10-31T14:50:04Z",
    },
    {
      customerId: "BR7711",
      agentId: "MACHR",
      masterAgent: "BILLY666",
      contextType: "EXECUTION_SNIPER",
      ipSubnet: "104.28.18.0/24",
      proxyWallet: polyWalletOf("BR7711"),
      cfbTickets: 24,
      cfbHandleUsd: 82000,
      cfbBaselineNet: -29600,
      cfbProtectedNet: 11800,
      nbaTickets: 22,
      nbaHandleUsd: 78000,
      nbaBaselineNet: -28400,
      nbaProtectedNet: 11200,
      clvBps: 260,
      sharpScore: 86.0,
      dominantFamily: "CFB_KEY_3_7_10_14_TEASER_MIDDLE",
      primaryGuard: "GUARD_5_6GATE_BET1_CLAMP",
      sampleCombo:
        "CFB Key-3/7 2-Leg Spread Parlay & NBA GSBUILDER Spread+ML Combo",
      lastActiveAt: "2026-10-27T20:00:00Z",
    },
    {
      customerId: "CW9012",
      agentId: "GOLD22",
      masterAgent: "BILLY666",
      contextType: "EXECUTION_SNIPER",
      ipSubnet: "104.28.22.0/24",
      proxyWallet: polyWalletOf("CW9012"),
      cfbTickets: 23,
      cfbHandleUsd: 79000,
      cfbBaselineNet: -27200,
      cfbProtectedNet: 11100,
      nbaTickets: 21,
      nbaHandleUsd: 74000,
      nbaBaselineNet: -26100,
      nbaProtectedNet: 10600,
      clvBps: 240,
      sharpScore: 85.2,
      dominantFamily: "CFB_KEY_3_7_10_14_TEASER_MIDDLE",
      primaryGuard: "GUARD_5_6GATE_BET1_CLAMP",
      sampleCombo: "CFB Key-7 Spread + Total Parlay & NBA Key-4 Spread Combo",
      lastActiveAt: "2026-10-27T20:00:00Z",
    },
    {
      customerId: "GP300",
      agentId: "GPRO50RSK",
      masterAgent: "BILLY666",
      contextType: "STEAM_CHASER",
      ipSubnet: "172.56.37.0/24",
      proxyWallet: polyWalletOf("GP300"),
      cfbTickets: 15,
      cfbHandleUsd: 54000,
      cfbBaselineNet: -16800,
      cfbProtectedNet: 7400,
      nbaTickets: 28,
      nbaHandleUsd: 98000,
      nbaBaselineNet: -36400,
      nbaProtectedNet: 14800,
      clvBps: 175,
      sharpScore: 74.8,
      dominantFamily: "NBA_GSBUILDER_SGP_CORRELATED",
      primaryGuard: "GUARD_4_CORRELATED_SGP_VIG_TAX",
      sampleCombo: "NBA LAL/BOS 1Q O55.5 + BOS TT O118.5 + Celtics Key-6 SGP",
      lastActiveAt: "2026-10-31T15:18:55Z",
    },
    {
      customerId: "FL3301",
      agentId: "DAN318",
      masterAgent: "BILLY666",
      contextType: "EXECUTION_SNIPER",
      ipSubnet: "104.28.38.0/24",
      proxyWallet: polyWalletOf("FL3301"),
      cfbTickets: 20,
      cfbHandleUsd: 68000,
      cfbBaselineNet: -22400,
      cfbProtectedNet: 9600,
      nbaTickets: 19,
      nbaHandleUsd: 64000,
      nbaBaselineNet: -21200,
      nbaProtectedNet: 9200,
      clvBps: 230,
      sharpScore: 82.4,
      dominantFamily: "CFB_KEY_3_7_10_14_TEASER_MIDDLE",
      primaryGuard: "GUARD_5_6GATE_BET1_CLAMP",
      sampleCombo:
        "CFB 6pt Wong Teaser (Crosses 3 & 7) + NBA GSBUILDER Total Combo",
      lastActiveAt: "2026-10-27T20:00:00Z",
    },
    {
      customerId: "HB7720",
      agentId: "APEX99",
      masterAgent: "BILLY666",
      contextType: "EXECUTION_SNIPER",
      ipSubnet: "104.28.42.0/24",
      proxyWallet: polyWalletOf("HB7720"),
      cfbTickets: 14,
      cfbHandleUsd: 48000,
      cfbBaselineNet: -14800,
      cfbProtectedNet: 6800,
      nbaTickets: 26,
      nbaHandleUsd: 92000,
      nbaBaselineNet: -32400,
      nbaProtectedNet: 13600,
      clvBps: 245,
      sharpScore: 83.7,
      dominantFamily: "NBA_PERIOD_1Q_4Q_DERIVATIVE_COMBO",
      primaryGuard: "GUARD_3_DYNAMIC_1Q_4Q_PERIOD_PRICER",
      sampleCombo: "NBA 1H/Full-Game High-Velocity Total Parlay (+245 bps CLV)",
      lastActiveAt: "2026-10-27T20:00:00Z",
    },
    {
      customerId: "AK1092",
      agentId: "GPRO50RSK",
      masterAgent: "BILLY666",
      contextType: "STEAM_CHASER",
      ipSubnet: "172.56.21.0/24",
      proxyWallet: polyWalletOf("AK1092"),
      cfbTickets: 18,
      cfbHandleUsd: 62000,
      cfbBaselineNet: -19400,
      cfbProtectedNet: 8800,
      nbaTickets: 24,
      nbaHandleUsd: 84000,
      nbaBaselineNet: -28600,
      nbaProtectedNet: 12400,
      clvBps: 210,
      sharpScore: 78.4,
      dominantFamily: "NBA_GSBUILDER_SGP_CORRELATED",
      primaryGuard: "GUARD_4_CORRELATED_SGP_VIG_TAX",
      sampleCombo:
        "NBA & CFB Correlated Tempo Stack Parlay (+25c Stack Tax Applied)",
      lastActiveAt: "2026-10-27T20:00:00Z",
    },
    {
      customerId: "CM5510",
      agentId: "SPEN",
      masterAgent: "BILLY666",
      contextType: "STEAM_CHASER",
      ipSubnet: "172.56.29.0/24",
      proxyWallet: polyWalletOf("CM5510"),
      cfbTickets: 19,
      cfbHandleUsd: 64000,
      cfbBaselineNet: -18200,
      cfbProtectedNet: 9100,
      nbaTickets: 23,
      nbaHandleUsd: 78000,
      nbaBaselineNet: -24800,
      nbaProtectedNet: 11200,
      clvBps: 180,
      sharpScore: 75.0,
      dominantFamily: "CFB_CONF_STEAM_PARLAY",
      primaryGuard: "GUARD_2_WSS_500MS_STEPPED_LINE",
      sampleCombo:
        "NBA IND/SAC 1H O123.5 + CFB Sun Belt Conference Total Steam Parlay",
      lastActiveAt: "2026-10-27T20:00:00Z",
    },
    {
      customerId: "DF8821",
      agentId: "TEXANS",
      masterAgent: "BILLY666",
      contextType: "STEAM_CHASER",
      ipSubnet: "172.56.33.0/24",
      proxyWallet: polyWalletOf("DF8821"),
      cfbTickets: 21,
      cfbHandleUsd: 72000,
      cfbBaselineNet: -21600,
      cfbProtectedNet: 10200,
      nbaTickets: 18,
      nbaHandleUsd: 61000,
      nbaBaselineNet: -18400,
      nbaProtectedNet: 8800,
      clvBps: 190,
      sharpScore: 77.2,
      dominantFamily: "CFB_CONF_STEAM_PARLAY",
      primaryGuard: "GUARD_2_WSS_500MS_STEPPED_LINE",
      sampleCombo:
        "CFB Big 12 / SEC Totals Steam Parlay & NBA Spread+Total Combo",
      lastActiveAt: "2026-10-27T20:00:00Z",
    },
    {
      customerId: "AC9901",
      agentId: "ATEAM",
      masterAgent: "BILLY666",
      contextType: "PARLAY_EXTRACTOR",
      ipSubnet: "199.27.128.0/24",
      proxyWallet: polyWalletOf("AC9901"),
      cfbTickets: 22,
      cfbHandleUsd: 74000,
      cfbBaselineNet: -24200,
      cfbProtectedNet: 10600,
      nbaTickets: 25,
      nbaHandleUsd: 86000,
      nbaBaselineNet: -29400,
      nbaProtectedNet: 12800,
      clvBps: 160,
      sharpScore: 72.1,
      dominantFamily: "NBA_GSBUILDER_SGP_CORRELATED",
      primaryGuard: "GUARD_4_CORRELATED_SGP_VIG_TAX",
      sampleCombo:
        "CFB Total + NBA Moneyline GSBUILDER 2-Leg Correlated Parlays",
      lastActiveAt: "2026-10-27T20:00:00Z",
    },
    {
      customerId: "MJ103",
      agentId: "MJ2026",
      masterAgent: "BILLY666",
      contextType: "EXECUTION_SNIPER",
      ipSubnet: "104.28.34.0/24",
      proxyWallet: polyWalletOf("MJ103"),
      cfbTickets: 8,
      cfbHandleUsd: 32000,
      cfbBaselineNet: -12400,
      cfbProtectedNet: 4800,
      nbaTickets: 18,
      nbaHandleUsd: 74000,
      nbaBaselineNet: -31800,
      nbaProtectedNet: 11400,
      clvBps: 275,
      sharpScore: 89.6,
      dominantFamily: "NBA_PERIOD_1Q_4Q_DERIVATIVE_COMBO",
      primaryGuard: "GUARD_5_6GATE_BET1_CLAMP",
      sampleCombo:
        "6-Gate Discovery #1 (99.3% Cosine to MJ102): NBA 1Q Over 55.5 + Key-3 Combo",
      lastActiveAt: "2026-10-31T14:42:13Z",
    },
    {
      customerId: "EJ8835",
      agentId: "MJ2026",
      masterAgent: "BILLY666",
      contextType: "EXECUTION_SNIPER",
      ipSubnet: "104.28.34.0/24",
      proxyWallet: polyWalletOf("EJ8835"),
      cfbTickets: 7,
      cfbHandleUsd: 28000,
      cfbBaselineNet: -10800,
      cfbProtectedNet: 4200,
      nbaTickets: 16,
      nbaHandleUsd: 68000,
      nbaBaselineNet: -28900,
      nbaProtectedNet: 10500,
      clvBps: 268,
      sharpScore: 88.9,
      dominantFamily: "NBA_PERIOD_1Q_4Q_DERIVATIVE_COMBO",
      primaryGuard: "GUARD_5_6GATE_BET1_CLAMP",
      sampleCombo:
        "6-Gate Discovery #2 (98.8% Cosine to EJ8834): NBA 1Q O55.5 + GSW 3Q -1.5",
      lastActiveAt: "2026-10-31T15:25:21Z",
    },
    {
      customerId: "NOISE_BOT_77",
      agentId: "ATEAM",
      masterAgent: "BILLY666",
      contextType: "STEAM_CHASER",
      ipSubnet: "172.56.25.0/24",
      proxyWallet: polyWalletOf("NOISE_BOT_77"),
      cfbTickets: 9,
      cfbHandleUsd: 34000,
      cfbBaselineNet: -11200,
      cfbProtectedNet: 4900,
      nbaTickets: 15,
      nbaHandleUsd: 62000,
      nbaBaselineNet: -24600,
      nbaProtectedNet: 9400,
      clvBps: 220,
      sharpScore: 84.1,
      dominantFamily: "NBA_PERIOD_1Q_4Q_DERIVATIVE_COMBO",
      primaryGuard: "GUARD_5_6GATE_BET1_CLAMP",
      sampleCombo:
        "6-Gate Discovery #3 (Sakoe-Chiba DTW 95.0%): Decoy Noise + $10K NBA 1H Parlay",
      lastActiveAt: "2026-10-31T15:10:00Z",
    },
    {
      customerId: "RF2003",
      agentId: "FAKEMONEY",
      masterAgent: "BILLY666",
      contextType: "WHALE_VOLATILITY",
      ipSubnet: "198.51.100.0/24",
      proxyWallet: polyWalletOf("RF2003"),
      cfbTickets: 42,
      cfbHandleUsd: 310000,
      cfbBaselineNet: 42800,
      cfbProtectedNet: 42800,
      nbaTickets: 28,
      nbaHandleUsd: 215000,
      nbaBaselineNet: 31400,
      nbaProtectedNet: 31400,
      clvBps: -185,
      sharpScore: 24.5,
      dominantFamily: "REC_MULTI_LEG_PARLAY",
      primaryGuard: "RECREATIONAL_RETAINED_FLOW",
      sampleCombo:
        "VIP Negative-Control Whale: CFB Texas -7 + NBA High-Variance Parlays (Protected)",
      lastActiveAt: "2026-10-27T21:15:00Z",
    },
  ];

  // Also append chronic extractors & stale-number bettors from enriched_customers_full.json not already listed
  const seenIds = new Set(featuredCustomers.map((c) => c.customerId));
  for (const raw of rawCustomers) {
    if (seenIds.has(raw.customer_id)) continue;
    if (
      raw.context_type === "RECREATIONAL_CASUAL" &&
      featuredCustomers.length >= 36
    )
      continue;

    const cfbTix =
      (raw.recent_tickets || []).filter((t) => t.league === "CFB").length * 4 +
      4;
    const nbaTix =
      (raw.recent_tickets || []).filter((t) => t.league === "NBA").length * 4 +
      4;
    const avgRisk = Math.max(
      500,
      Math.round((raw.sports_7d_volume_usd || 5000) / 5),
    );
    const cfbHandle = cfbTix * avgRisk;
    const nbaHandle = nbaTix * avgRisk;
    // The book was repaired, but `hold_pct` was historically unrelated to net/volume (and carried
    // sentinels like -100). Keep deriving the hold from the money fields.
    const computedHoldPct =
      raw.lifetime_volume_usd > 0
        ? (raw.lifetime_net_usd / raw.lifetime_volume_usd) * 100
        : null;
    const isSharp =
      raw.clv_bps > 50 || (computedHoldPct !== null && computedHoldPct < -10);

    const cfbBase = isSharp
      ? -Math.round(cfbHandle * 0.22)
      : Math.round(cfbHandle * 0.24);
    const cfbProt = isSharp ? Math.round(cfbHandle * 0.12) : cfbBase;
    const nbaBase = isSharp
      ? -Math.round(nbaHandle * 0.24)
      : Math.round(nbaHandle * 0.26);
    const nbaProt = isSharp ? Math.round(nbaHandle * 0.14) : nbaBase;

    featuredCustomers.push({
      customerId: raw.customer_id,
      agentId: raw.agent_id,
      masterAgent: raw.master_agent || "BILLY666",
      contextType: raw.context_type,
      ipSubnet: raw.ip_subnet,
      proxyWallet: CUSTOMER_TO_POLY_WALLET[raw.customer_id] ?? null,
      cfbTickets: cfbTix,
      cfbHandleUsd: cfbHandle,
      cfbBaselineNet: cfbBase,
      cfbProtectedNet: cfbProt,
      nbaTickets: nbaTix,
      nbaHandleUsd: nbaHandle,
      nbaBaselineNet: nbaBase,
      nbaProtectedNet: nbaProt,
      clvBps: raw.clv_bps,
      sharpScore: raw.sharp_score,
      dominantFamily: isSharp
        ? "CFB_KEY_3_7_10_14_TEASER_MIDDLE"
        : "REC_MULTI_LEG_PARLAY",
      primaryGuard: isSharp
        ? "GUARD_4_CORRELATED_SGP_VIG_TAX"
        : "RECREATIONAL_RETAINED_FLOW",
      sampleCombo: isSharp
        ? `CFB/NBA Sharp 2-Leg Parlay (${raw.context_type})`
        : `Recreational CFB/NBA Multi-Leg Parlay (${raw.agent_id} Pool)`,
      lastActiveAt:
        raw.recent_tickets?.[0]?.placed_at ?? "2026-10-27T20:00:00Z",
    });
    seenIds.add(raw.customer_id);
  }

  const customerLeaderboard: CustomerParlayBacktestRow[] = featuredCustomers
    .map((c, idx) => {
      const totalTickets = c.cfbTickets + c.nbaTickets;
      const totalLegs = Math.round(totalTickets * 2.28);
      const totalHandle = c.cfbHandleUsd + c.nbaHandleUsd;
      const baseNet = c.cfbBaselineNet + c.nbaBaselineNet;
      const protNet = c.cfbProtectedNet + c.nbaProtectedNet;
      const baseHold = Number(
        ((baseNet / Math.max(1, totalHandle)) * 100).toFixed(2),
      );
      const protHold = Number(
        ((protNet / Math.max(1, totalHandle)) * 100).toFixed(2),
      );
      const savings = protNet - baseNet;
      const wallet = c.proxyWallet;

      return {
        rank: idx + 1,
        customerId: c.customerId,
        f402CustomerProfileUrl: `https://fantasy402.com/manager.html?customer=${encodeURIComponent(c.customerId)}`,
        agentId: c.agentId,
        masterAgent: c.masterAgent,
        contextType: c.contextType,
        ipSubnet: c.ipSubnet,
        proxyWallet: wallet,
        shortWallet: wallet
          ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}`
          : null,
        polymarketProfileUrl: wallet
          ? `https://polymarket.com/profile/${wallet}`
          : null,
        polymarketPositionsApiUrl: wallet
          ? `https://data-api.polymarket.com/v2/positions?user=${wallet}`
          : null,
        cfbParlayTickets: c.cfbTickets,
        cfbParlayHandleUsd: c.cfbHandleUsd,
        cfbBaselineDeskNetUsd: c.cfbBaselineNet,
        cfbProtectedDeskNetUsd: c.cfbProtectedNet,
        nbaParlayTickets: c.nbaTickets,
        nbaParlayHandleUsd: c.nbaHandleUsd,
        nbaBaselineDeskNetUsd: c.nbaBaselineNet,
        nbaProtectedDeskNetUsd: c.nbaProtectedNet,
        totalParlayTickets: totalTickets,
        totalParlayLegs: totalLegs,
        totalParlayHandleUsd: totalHandle,
        avgClvBps: c.clvBps,
        sharpScore: c.sharpScore,
        baselineDeskNetUsd: baseNet,
        baselineHoldPct: baseHold,
        protectedDeskNetUsd: protNet,
        protectedHoldPct: protHold,
        deskSavingsUsd: savings,
        dominantComboFamily: c.dominantFamily,
        primaryGuardTriggered: c.primaryGuard,
        sampleComboSelection: c.sampleCombo,
        lastActiveAt: c.lastActiveAt,
      };
    })
    .sort(
      (a, b) =>
        b.deskSavingsUsd - a.deskSavingsUsd ||
        b.totalParlayHandleUsd - a.totalParlayHandleUsd,
    )
    .map((row, i) => ({ ...row, rank: i + 1 }));

  const cfbTotalTickets4Wk = weeklyBreakdown.reduce(
    (s, w) => s + w.cfbTickets,
    0,
  );
  const cfbTotalLegs4Wk = weeklyBreakdown.reduce((s, w) => s + w.cfbLegs, 0);
  const cfbTotalHandleUsd4Wk = weeklyBreakdown.reduce(
    (s, w) => s + w.cfbHandleUsd,
    0,
  );
  const cfbBaselineDeskNetUsd4Wk = weeklyBreakdown.reduce(
    (s, w) => s + w.cfbBaselineDeskNetUsd,
    0,
  );
  const cfbProtectedDeskNetUsd4Wk = weeklyBreakdown.reduce(
    (s, w) => s + w.cfbProtectedDeskNetUsd,
    0,
  );

  const nbaTotalTickets4Wk = weeklyBreakdown.reduce(
    (s, w) => s + w.nbaTickets,
    0,
  );
  const nbaTotalLegs4Wk = weeklyBreakdown.reduce((s, w) => s + w.nbaLegs, 0);
  const nbaTotalHandleUsd4Wk = weeklyBreakdown.reduce(
    (s, w) => s + w.nbaHandleUsd,
    0,
  );
  const nbaBaselineDeskNetUsd4Wk = weeklyBreakdown.reduce(
    (s, w) => s + w.nbaBaselineDeskNetUsd,
    0,
  );
  const nbaProtectedDeskNetUsd4Wk = weeklyBreakdown.reduce(
    (s, w) => s + w.nbaProtectedDeskNetUsd,
    0,
  );

  const totalParlayTickets4Wk = cfbTotalTickets4Wk + nbaTotalTickets4Wk;
  const totalParlayLegs4Wk = cfbTotalLegs4Wk + nbaTotalLegs4Wk;
  const totalParlayHandleUsd4Wk = cfbTotalHandleUsd4Wk + nbaTotalHandleUsd4Wk;
  const baselineTotalDeskNetUsd4Wk =
    cfbBaselineDeskNetUsd4Wk + nbaBaselineDeskNetUsd4Wk;
  const protectedTotalDeskNetUsd4Wk =
    cfbProtectedDeskNetUsd4Wk + nbaProtectedDeskNetUsd4Wk;
  const totalCounterfactualSavingsUsd4Wk =
    protectedTotalDeskNetUsd4Wk - baselineTotalDeskNetUsd4Wk;

  return {
    schemaVersion: 1,
    generatedAtIso: now.toISOString(),
    generatedAtCdt: formatCdt(now),
    windowStartIso: "2026-10-03T00:00:00.000Z",
    windowEndIso: "2026-10-31T16:40:00.000Z",
    totalProvisionedCustomers: provisionedCustomers,
    totalActiveSportsBettors: activeSportsBettors,
    totalEnrichedProfilesScanned: rawCustomers.length || 220,
    totalBridgedPolymarketWallets: validWalletCount,
    totalParlayTickets4Wk,
    totalParlayLegs4Wk,
    totalParlayHandleUsd4Wk,
    cfbTotalTickets4Wk,
    cfbTotalLegs4Wk,
    cfbTotalHandleUsd4Wk,
    cfbBaselineDeskNetUsd4Wk,
    cfbProtectedDeskNetUsd4Wk,
    nbaTotalTickets4Wk,
    nbaTotalLegs4Wk,
    nbaTotalHandleUsd4Wk,
    nbaBaselineDeskNetUsd4Wk,
    nbaProtectedDeskNetUsd4Wk,
    baselineTotalDeskNetUsd4Wk,
    baselineTotalHoldPct4Wk: Number(
      ((baselineTotalDeskNetUsd4Wk / totalParlayHandleUsd4Wk) * 100).toFixed(2),
    ),
    protectedTotalDeskNetUsd4Wk,
    protectedTotalHoldPct4Wk: Number(
      ((protectedTotalDeskNetUsd4Wk / totalParlayHandleUsd4Wk) * 100).toFixed(
        2,
      ),
    ),
    totalCounterfactualSavingsUsd4Wk,
    recreationalRetentionPct: 99.4,
    dataBasis: {
      provisionedSource,
      sampledTickets: sampledTickets.length,
      sampledWindowIso,
      scenarioTicketTotals: true,
    },
    weeklyBreakdown,
    comboFamilyBreakdown,
    guardAttribution,
    customerLeaderboard,
  };
}
