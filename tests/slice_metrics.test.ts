import { describe, expect, test } from "bun:test";
import {
  auditSliceBitsetFiles,
  auditSliceBitsetVirtualSource,
} from "../bin/check-slice-bitsets.ts";
import {
  loadHoldFloorConfig,
  parseHoldFloorConfigToml,
  resolveHoldFloorPct,
} from "../src/risk/hold_floor_config.ts";
import {
  createStaticRouterOrderQuery,
  deriveRouterBlockEnforcedPredicate,
  queryBlockEnforced,
} from "../src/risk/router_block_audit.ts";
import { SliceMetricsSoASpine } from "../src/risk/slice_data_table.ts";
import { diffSlicePolicyPairs } from "../src/risk/slice_diff_view.ts";
import {
  computeBlendedHoldSlo,
  computeFlags,
  derive,
  deriveFloorDelta,
  deriveGrossHold,
  deriveNetPosition,
  deriveSellShare,
  deriveSliceMetrics,
  deriveVigAndDirectionalSplit,
  gateBuyShareExtreme,
  gateDirectionalDominant,
  gateHoldBelowFloor,
  gateMissingVigSplit,
  gatePolicyDataConflict,
  type SliceMetricsInput,
} from "../src/risk/slice_metrics.ts";
import {
  assertValidSliceRegistry,
  buildSliceIndexLookup,
  deriveSliceBitsetPredicate,
  getSliceSpec,
  getSliceUnknownTelemetry,
  isAdvantageSlice,
  isBlockedSlice,
  isLeakSlice,
  isLiveLockoutSlice,
  isPreserveSlice,
  isRegisteredSliceId,
  resetSliceUnknownTelemetry,
  resolveDefaultUnknownSlicePolicy,
  SLICE_REGISTRY,
  type SliceSpec,
  UnknownSliceIdError,
  validateHoldFloorSliceOverrides,
} from "../src/risk/slice_registry.ts";

/**
 * Deterministic Mulberry32 PRNG for reproducible property-based tests.
 */
function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard -110/-110 two-sided balanced book hold:
 * implied prob per side = 110 / 210 = 0.5238095...
 * sum S = 220 / 210 = 1.047619...
 * balanced vig hold on matched handle = ((S - 1) / S) * 100 = (10 / 220) * 100 = 4.5454545...%
 */
const STANDARD_MINUS_110_BALANCED_HOLD_PCT = (10 / 220) * 100;

/**
 * Raw 7-slice desk report seeds matching the empirical sports desk exposure audit:
 * Total handle = $67,677,705; BLOCKED handle = $26,751,795 (39.53%);
 * Naive blended hold = 1.74%; NCAAB ADVANTAGE at -5.84%.
 */
interface RawReportRowSeed {
  readonly slice_id: string;
  readonly sport: string;
  readonly league: string;
  readonly period: string;
  readonly market: string;
  readonly legs: number;
  readonly buy_share_pct: number;
  readonly handle_usd: number;
  readonly hold_total_pct: number;
  readonly policy: SliceMetricsInput["policy"];
  readonly policy_mechanism: SliceMetricsInput["policy_mechanism"];
  readonly policy_qualifier: string;
  readonly post_block_accepted_orders: number;
}

const REPORT_SEVEN_ROW_FIXTURE: readonly RawReportRowSeed[] = [
  {
    slice_id: "football:nfl:p0_game:spread",
    sport: "Football",
    league: "NFL",
    period: "P0 Game",
    market: "Spread",
    legs: 41_093,
    buy_share_pct: 62.2,
    handle_usd: 13_624_919,
    hold_total_pct: 0.48,
    policy: "LEAK",
    policy_mechanism: "VIG",
    policy_qualifier: "+$5,190 floor delta",
    post_block_accepted_orders: 0,
  },
  {
    slice_id: "football:ncaaf:p0_game:spread",
    sport: "Football",
    league: "College FB",
    period: "P0 Game",
    market: "Spread",
    legs: 66_652,
    buy_share_pct: 66.6,
    handle_usd: 16_475_414,
    hold_total_pct: 2.23,
    policy: "LEAK",
    policy_mechanism: "VIG",
    policy_qualifier: "+$26,945 floor delta",
    post_block_accepted_orders: 0,
  },
  {
    slice_id: "basketball:nba:p0_game:spread",
    sport: "Basketball",
    league: "NBA",
    period: "P0 Game",
    market: "Spread",
    legs: 31_115,
    buy_share_pct: 49.0,
    handle_usd: 7_518_881,
    hold_total_pct: 4.12,
    policy: "ADVANTAGE",
    policy_mechanism: "BELL_CURVE",
    policy_qualifier: "PRESERVE_BELL_CURVE_VIG",
    post_block_accepted_orders: 0,
  },
  {
    slice_id: "basketball:ncaab:halves:all",
    sport: "Basketball",
    league: "NCAAB",
    period: "P0/1H/2H",
    market: "All Markets",
    legs: 5_590,
    buy_share_pct: 21.1,
    handle_usd: 3_306_696,
    hold_total_pct: -5.84,
    policy: "ADVANTAGE",
    policy_mechanism: "BELL_CURVE",
    policy_qualifier: "20m halves only",
    post_block_accepted_orders: 0,
  },
  {
    slice_id: "hockey:nhl:periods:all",
    sport: "Hockey",
    league: "NHL",
    period: "OT/Reg/P1-P3",
    market: "All Markets",
    legs: 27_816,
    buy_share_pct: 5.9,
    handle_usd: 12_418_166,
    hold_total_pct: 0.85,
    policy: "BLOCKED",
    policy_mechanism: "DERIVATIVE",
    policy_qualifier: "DERIVATIVE_AND_LIVE_LOCKOUT",
    post_block_accepted_orders: 27_816,
  },
  {
    slice_id: "baseball:mlb:f5:spread",
    sport: "Baseball",
    league: "MLB",
    period: "F5",
    market: "Spread",
    legs: 1_846,
    buy_share_pct: 2.5,
    handle_usd: 1_150_993,
    hold_total_pct: -3.96,
    policy: "BLOCKED",
    policy_mechanism: "DERIVATIVE",
    policy_qualifier: "DERIVATIVE_AND_LIVE_LOCKOUT",
    post_block_accepted_orders: 1_846,
  },
  {
    slice_id: "live:all:p0_inplay:all",
    sport: "LIVE",
    league: "In-Play #9000",
    period: "P0 In-Play",
    market: "All Markets",
    legs: 7_704,
    buy_share_pct: 0.03,
    handle_usd: 13_182_636,
    hold_total_pct: 4.3,
    policy: "BLOCKED",
    policy_mechanism: "LIVE_LOCKOUT",
    policy_qualifier: "Clock/feed latency focus",
    post_block_accepted_orders: 7_704,
  },
];

describe("SliceMetrics pure column derivations", () => {
  test("deriveSellShare: known value and complement property", () => {
    expect(deriveSellShare(62.2)).toBeCloseTo(37.8, 8);
    expect(deriveSellShare(0.03)).toBeCloseTo(99.97, 8);

    const nextRand = createPrng(0x51ce_0001);
    for (let i = 0; i < 200; i++) {
      const buy = nextRand() * 100;
      const sell = deriveSellShare(buy);
      expect(buy + sell).toBeCloseTo(100, 10);
      expect(deriveSellShare(sell)).toBeCloseTo(buy, 10);
    }
  });

  test("deriveNetPosition: known value and antisymmetry/linearity property", () => {
    // NFL: $13,624,919 * (0.622 - 0.5) = $13,624,919 * 0.122 = +$1,662,240.118
    expect(deriveNetPosition(13_624_919, 62.2)).toBeCloseTo(1_662_240.118, 3);
    // Balanced 50/50 book -> $0 net directional position
    expect(deriveNetPosition(10_000_000, 50)).toBe(0);

    const nextRand = createPrng(0x51ce_0002);
    for (let i = 0; i < 200; i++) {
      const handle = nextRand() * 50_000_000;
      const buy = nextRand() * 100;
      const net = deriveNetPosition(handle, buy);
      const mirrorNet = deriveNetPosition(handle, 100 - buy);
      expect(net + mirrorNet).toBeCloseTo(0, 6);
      expect(deriveNetPosition(2 * handle, buy)).toBeCloseTo(2 * net, 6);
      expect(Math.abs(net)).toBeLessThanOrEqual(0.5 * handle + 1e-6);
    }
  });

  test("deriveGrossHold: known value and bilinear scaling property", () => {
    // NCAAB: $3,306,696 * (-5.84 / 100) = -$193,111.0464
    expect(deriveGrossHold(3_306_696, -5.84)).toBeCloseTo(-193_111.0464, 4);
    expect(deriveGrossHold(13_182_636, 4.3)).toBeCloseTo(566_853.348, 3);

    const nextRand = createPrng(0x51ce_0003);
    for (let i = 0; i < 200; i++) {
      const handle = nextRand() * 30_000_000;
      const holdA = (nextRand() - 0.5) * 30;
      const holdB = (nextRand() - 0.5) * 30;
      expect(deriveGrossHold(handle, holdA + holdB)).toBeCloseTo(
        deriveGrossHold(handle, holdA) + deriveGrossHold(handle, holdB),
        5,
      );
    }
  });

  test("deriveFloorDelta: known value and gross-hold difference identity", () => {
    // NFL: hold 0.48% vs floor 3.50% on $13,624,919 -> -3.02% / -$411,472.5538
    const nflDelta = deriveFloorDelta(0.48, 3.5, 13_624_919);
    expect(nflDelta.floor_delta_pct).toBeCloseTo(-3.02, 8);
    expect(nflDelta.floor_delta_usd).toBeCloseTo(-411_472.5538, 4);

    const nextRand = createPrng(0x51ce_0004);
    for (let i = 0; i < 200; i++) {
      const handle = nextRand() * 25_000_000;
      const holdPct = (nextRand() - 0.3) * 20;
      const floorPct = 2 + nextRand() * 4;
      const { floor_delta_pct, floor_delta_usd } = deriveFloorDelta(
        holdPct,
        floorPct,
        handle,
      );
      expect(floor_delta_pct + floorPct).toBeCloseTo(holdPct, 10);
      expect(floor_delta_usd).toBeCloseTo(
        deriveGrossHold(handle, holdPct) - deriveGrossHold(handle, floorPct),
        5,
      );
    }
  });

  test("deriveVigAndDirectionalSplit: known values, conservation law, and null emission when unsplit", () => {
    // Perfectly balanced 50/50 book at -110/-110 (4.54545% vig) with 4.54545% total hold -> 0 directional PnL
    const balanced = deriveVigAndDirectionalSplit({
      handle_usd: 10_000_000,
      buy_share_pct: 50,
      hold_total_pct: STANDARD_MINUS_110_BALANCED_HOLD_PCT,
      balanced_overround_pct: STANDARD_MINUS_110_BALANCED_HOLD_PCT,
    });
    expect(balanced.vig_capture_pct).toBeCloseTo(
      STANDARD_MINUS_110_BALANCED_HOLD_PCT,
      8,
    );
    expect(balanced.directional_pnl_usd).toBeCloseTo(0, 6);

    // Missing balanced-book source -> MUST emit null rather than guessing
    const missing = deriveVigAndDirectionalSplit({
      handle_usd: 10_000_000,
      buy_share_pct: 62.2,
      hold_total_pct: 0.48,
      balanced_overround_pct: null,
    });
    expect(missing.vig_capture_pct).toBeNull();
    expect(missing.directional_pnl_usd).toBeNull();

    // Conservation property: vig_usd + directional_pnl_usd === gross_hold_usd
    const nextRand = createPrng(0x51ce_0005);
    for (let i = 0; i < 200; i++) {
      const handle = 100_000 + nextRand() * 20_000_000;
      const buy = nextRand() * 100;
      const holdTotal = (nextRand() - 0.4) * 20;
      const overround = 2 + nextRand() * 6;
      const split = deriveVigAndDirectionalSplit({
        handle_usd: handle,
        buy_share_pct: buy,
        hold_total_pct: holdTotal,
        balanced_overround_pct: overround,
      });
      expect(split.vig_capture_pct).not.toBeNull();
      expect(split.directional_pnl_usd).not.toBeNull();
      const vigUsd = handle * ((split.vig_capture_pct ?? 0) / 100);
      const grossUsd = deriveGrossHold(handle, holdTotal);
      expect(vigUsd + (split.directional_pnl_usd ?? 0)).toBeCloseTo(
        grossUsd,
        5,
      );
    }
  });
});

describe("SliceMetrics pure gate predicates", () => {
  test("BUY_SHARE_EXTREME: positive (<5 or >95 with handle > $5M) and negative cases", () => {
    expect(
      gateBuyShareExtreme({ buy_share_pct: 0.03, handle_usd: 13_182_636 }),
    ).toBe(true);
    expect(
      gateBuyShareExtreme({ buy_share_pct: 96.4, handle_usd: 5_000_001 }),
    ).toBe(true);

    // Negative: extreme buy share but handle <= $5M (e.g. MLB F5 at $1.15M, 2.5%)
    expect(
      gateBuyShareExtreme({ buy_share_pct: 2.5, handle_usd: 1_150_993 }),
    ).toBe(false);
    expect(
      gateBuyShareExtreme({ buy_share_pct: 1.0, handle_usd: 5_000_000 }),
    ).toBe(false);
    // Negative: high handle but buy share within [5, 95] (e.g. NHL at 5.9%, $12.42M)
    expect(
      gateBuyShareExtreme({ buy_share_pct: 5.9, handle_usd: 12_418_166 }),
    ).toBe(false);
  });

  test("POLICY_DATA_CONFLICT: positive (ADVANTAGE<0 or BLOCKED&&!enforced) and negative cases", () => {
    expect(
      gatePolicyDataConflict({
        policy: "ADVANTAGE",
        hold_total_pct: -5.84,
        block_enforced: true,
      }),
    ).toBe(true);
    expect(
      gatePolicyDataConflict({
        policy: "BLOCKED",
        hold_total_pct: 4.3,
        block_enforced: false,
      }),
    ).toBe(true);

    // Negative: ADVANTAGE with positive hold, BLOCKED with router enforcement, LEAK with negative hold
    expect(
      gatePolicyDataConflict({
        policy: "ADVANTAGE",
        hold_total_pct: 4.12,
        block_enforced: true,
      }),
    ).toBe(false);
    expect(
      gatePolicyDataConflict({
        policy: "BLOCKED",
        hold_total_pct: -3.96,
        block_enforced: true,
      }),
    ).toBe(false);
    expect(
      gatePolicyDataConflict({
        policy: "LEAK",
        hold_total_pct: -1.5,
        block_enforced: false,
      }),
    ).toBe(false);
  });

  test("HOLD_BELOW_FLOOR: positive (floor_delta_pct < 0) and negative (>= 0) cases", () => {
    expect(gateHoldBelowFloor({ floor_delta_pct: -3.02 })).toBe(true);
    expect(gateHoldBelowFloor({ floor_delta_pct: 0 })).toBe(false);
    expect(gateHoldBelowFloor({ floor_delta_pct: 0.62 })).toBe(false);
  });

  test("DIRECTIONAL_DOMINANT: positive and negative cases (including null vig split)", () => {
    // LIVE: directional PnL ~$566.5k >> vig capture ~$360
    expect(
      gateDirectionalDominant({
        handle_usd: 13_182_636,
        vig_capture_pct: 0.0027,
        directional_pnl_usd: 566_497,
      }),
    ).toBe(true);

    // NBA: directional PnL |-$25.1k| <= vig capture |+$334.9k|
    expect(
      gateDirectionalDominant({
        handle_usd: 7_518_881,
        vig_capture_pct: 4.4545,
        directional_pnl_usd: -25_154,
      }),
    ).toBe(false);

    // Null split does not guess directional dominance; MISSING_VIG_SPLIT fires instead
    expect(
      gateDirectionalDominant({
        handle_usd: 10_000_000,
        vig_capture_pct: null,
        directional_pnl_usd: null,
      }),
    ).toBe(false);
    expect(
      gateMissingVigSplit({
        vig_capture_pct: null,
        directional_pnl_usd: null,
      }),
    ).toBe(true);
    expect(
      gateMissingVigSplit({
        vig_capture_pct: 3.4,
        directional_pnl_usd: -100_000,
      }),
    ).toBe(false);
  });
});

describe("SportsDesk 7-row report regression, Blended Hold SLO & round-trip determinism", () => {
  test("reproduces all 7 report rows from config/wager_tiers.toml + router block fixture", async () => {
    const holdConfig = await loadHoldFloorConfig("config/wager_tiers.toml");

    // Fixture A: Router reports actual historical post-block accepted orders (non-zero on BLOCKED slices -> false)
    const unenforcedRouter = createStaticRouterOrderQuery({
      "hockey:nhl:periods:all": 27_816,
      "baseball:mlb:f5:spread": 1_846,
      "live:all:p0_inplay:all": 7_704,
    });

    const rowsUnenforced = REPORT_SEVEN_ROW_FIXTURE.map((seed) =>
      deriveSliceMetrics({
        slice_id: seed.slice_id,
        sport: seed.sport,
        league: seed.league,
        period: seed.period,
        market: seed.market,
        legs: seed.legs,
        buy_share_pct: seed.buy_share_pct,
        handle_usd: seed.handle_usd,
        hold_total_pct: seed.hold_total_pct,
        hold_floor_pct: resolveHoldFloorPct(holdConfig, seed),
        policy: seed.policy,
        policy_mechanism: seed.policy_mechanism,
        policy_qualifier: seed.policy_qualifier,
        block_enforced: queryBlockEnforced(unenforcedRouter, seed.slice_id),
        balanced_overround_pct: STANDARD_MINUS_110_BALANCED_HOLD_PCT,
      }),
    );

    const byId = Object.fromEntries(rowsUnenforced.map((r) => [r.slice_id, r]));

    // 1. NCAAB -> POLICY_DATA_CONFLICT (ADVANTAGE at -5.84%)
    expect(byId["basketball:ncaab:halves:all"]?.flags).toContain(
      "POLICY_DATA_CONFLICT",
    );
    expect(byId["basketball:ncaab:halves:all"]?.flags).toContain(
      "HOLD_BELOW_FLOOR",
    );

    // 2. LIVE -> BUY_SHARE_EXTREME + DIRECTIONAL_DOMINANT
    expect(byId["live:all:p0_inplay:all"]?.flags).toContain(
      "BUY_SHARE_EXTREME",
    );
    expect(byId["live:all:p0_inplay:all"]?.flags).toContain(
      "DIRECTIONAL_DOMINANT",
    );

    // 3. NFL & CFB -> HOLD_BELOW_FLOOR
    expect(byId["football:nfl:p0_game:spread"]?.flags).toContain(
      "HOLD_BELOW_FLOOR",
    );
    expect(byId["football:ncaaf:p0_game:spread"]?.flags).toContain(
      "HOLD_BELOW_FLOOR",
    );

    // 4. All three BLOCKED rows checked against router block_enforced fixture:
    // When router accepted post-block orders (>0), block_enforced === false -> POLICY_DATA_CONFLICT
    const blockedIds = [
      "hockey:nhl:periods:all",
      "baseball:mlb:f5:spread",
      "live:all:p0_inplay:all",
    ] as const;
    for (const id of blockedIds) {
      expect(byId[id]?.block_enforced).toBe(false);
      expect(byId[id]?.flags).toContain("POLICY_DATA_CONFLICT");
    }

    // Fixture B: Router enforces hard lockout (0 post-block accepted orders) -> block_enforced === true
    const enforcedRouter = createStaticRouterOrderQuery({
      "hockey:nhl:periods:all": 0,
      "baseball:mlb:f5:spread": 0,
      "live:all:p0_inplay:all": 0,
    });
    const rowsEnforced = REPORT_SEVEN_ROW_FIXTURE.map((seed) =>
      deriveSliceMetrics({
        slice_id: seed.slice_id,
        sport: seed.sport,
        league: seed.league,
        period: seed.period,
        market: seed.market,
        legs: seed.legs,
        buy_share_pct: seed.buy_share_pct,
        handle_usd: seed.handle_usd,
        hold_total_pct: seed.hold_total_pct,
        hold_floor_pct: resolveHoldFloorPct(holdConfig, seed),
        policy: seed.policy,
        policy_mechanism: seed.policy_mechanism,
        policy_qualifier: seed.policy_qualifier,
        block_enforced: queryBlockEnforced(enforcedRouter, seed.slice_id),
        balanced_overround_pct: STANDARD_MINUS_110_BALANCED_HOLD_PCT,
      }),
    );
    for (const row of rowsEnforced) {
      if (row.policy === "BLOCKED") {
        expect(row.block_enforced).toBe(true);
        expect(row.flags).not.toContain("POLICY_DATA_CONFLICT");
      }
    }

    // Acceptance: reproducing the report yields >= 4 rows with non-empty flags in BOTH router states
    const flaggedCountUnenforced = rowsUnenforced.filter(
      (r) => r.flags.length > 0,
    ).length;
    const flaggedCountEnforced = rowsEnforced.filter(
      (r) => r.flags.length > 0,
    ).length;
    expect(flaggedCountUnenforced).toBeGreaterThanOrEqual(4);
    expect(flaggedCountEnforced).toBeGreaterThanOrEqual(4);

    // Acceptance: Blended hold SLO reads ex-blocked and ex-directional
    const slo = computeBlendedHoldSlo(
      rowsUnenforced,
      holdConfig.slo_blended_hold_floor_pct,
    );
    expect(slo.total_handle_usd).toBe(67_677_705);
    expect(slo.blocked_handle_usd).toBe(26_751_795);
    expect(slo.blocked_handle_share_pct).toBeCloseTo(39.53, 1);
    expect(slo.raw_blended_hold_pct).toBeCloseTo(1.74, 2);
    // Ex-blocked drops the $566.8k lucky LIVE hold -> 1.34%
    expect(slo.ex_blocked_hold_pct).toBeCloseTo(1.34, 2);
    // Ex-blocked & ex-directional measures pure balanced-book vig capture across active slices (~3.34% < 3.50% SLO)
    expect(slo.ex_blocked_ex_directional_hold_pct).toBeCloseTo(3.34, 2);
    expect(slo.slo_hold_pct).toBe(slo.ex_blocked_ex_directional_hold_pct);
    expect(slo.reads_ex_blocked).toBe(true);
    expect(slo.reads_ex_directional).toBe(true);
    expect(slo.slo_met).toBe(false);
  });

  test("round-trip: computeFlags(derive(row)) is deterministic and idempotent", async () => {
    const holdConfig = await loadHoldFloorConfig("config/wager_tiers.toml");
    const router = createStaticRouterOrderQuery({
      "hockey:nhl:periods:all": 27_816,
      "baseball:mlb:f5:spread": 0,
      "live:all:p0_inplay:all": 7_704,
    });

    for (const seed of REPORT_SEVEN_ROW_FIXTURE) {
      const input: SliceMetricsInput = {
        slice_id: seed.slice_id,
        sport: seed.sport,
        league: seed.league,
        period: seed.period,
        market: seed.market,
        legs: seed.legs,
        buy_share_pct: seed.buy_share_pct,
        handle_usd: seed.handle_usd,
        hold_total_pct: seed.hold_total_pct,
        hold_floor_pct: resolveHoldFloorPct(holdConfig, seed),
        policy: seed.policy,
        policy_mechanism: seed.policy_mechanism,
        policy_qualifier: seed.policy_qualifier,
        block_enforced: queryBlockEnforced(router, seed.slice_id),
        balanced_overround_pct: STANDARD_MINUS_110_BALANCED_HOLD_PCT,
      };

      const derivedOnce = derive(input);
      const flagsFirst = computeFlags(derivedOnce);
      const derivedTwice = derive(derivedOnce);
      const flagsSecond = computeFlags(derivedTwice);

      expect(flagsFirst).toEqual(derivedOnce.flags);
      expect(flagsSecond).toEqual(flagsFirst);
      expect(derivedTwice).toEqual(derivedOnce);
    }
  });
});

describe("DataTable SoA spine and DiffView pre/post-trade pair wiring", () => {
  test("DataTable SoA spine computes derived columns & flags once per stream flush, not per render", async () => {
    const holdConfig = await loadHoldFloorConfig("config/wager_tiers.toml");
    const router = createStaticRouterOrderQuery({
      "hockey:nhl:periods:all": 27_816,
      "baseball:mlb:f5:spread": 1_846,
      "live:all:p0_inplay:all": 7_704,
    });

    const inputs: SliceMetricsInput[] = REPORT_SEVEN_ROW_FIXTURE.map(
      (seed) => ({
        slice_id: seed.slice_id,
        sport: seed.sport,
        league: seed.league,
        period: seed.period,
        market: seed.market,
        legs: seed.legs,
        buy_share_pct: seed.buy_share_pct,
        handle_usd: seed.handle_usd,
        hold_total_pct: seed.hold_total_pct,
        hold_floor_pct: resolveHoldFloorPct(holdConfig, seed),
        policy: seed.policy,
        policy_mechanism: seed.policy_mechanism,
        policy_qualifier: seed.policy_qualifier,
        block_enforced: queryBlockEnforced(router, seed.slice_id),
        balanced_overround_pct: STANDARD_MINUS_110_BALANCED_HOLD_PCT,
      }),
    );

    const spine = new SliceMetricsSoASpine(16);
    spine.flush(inputs);

    expect(spine.rowCount).toBe(7);
    expect(spine.flushCount).toBe(1);
    expect(spine.derivedRowComputeCount).toBe(7);

    // Simulate 25 React render passes reading the SoA columns — zero recomputation allowed
    let snapshot = spine.readAllRows();
    for (let renderPass = 0; renderPass < 24; renderPass++) {
      snapshot = spine.readAllRows();
    }

    expect(spine.renderReadCount).toBe(25);
    expect(spine.flushCount).toBe(1);
    expect(spine.derivedRowComputeCount).toBe(7);

    // Verify SoA TypedArray columns match derived SliceMetrics row-for-row
    for (let i = 0; i < inputs.length; i++) {
      const expected = deriveSliceMetrics(inputs[i]!);
      const fromSoA = snapshot[i]!;
      expect(spine.columns.net_position_usd[i]).toBeCloseTo(
        expected.net_position_usd,
        6,
      );
      expect(spine.columns.gross_hold_usd[i]).toBeCloseTo(
        expected.gross_hold_usd,
        6,
      );
      expect(spine.columns.floor_delta_pct[i]).toBeCloseTo(
        expected.floor_delta_pct,
        8,
      );
      expect(spine.columns.vig_capture_pct[i]).toBeCloseTo(
        expected.vig_capture_pct ?? Number.NaN,
        8,
      );
      expect(spine.columns.directional_pnl_usd[i]).toBeCloseTo(
        expected.directional_pnl_usd ?? Number.NaN,
        6,
      );
      expect(fromSoA.flags).toEqual(expected.flags);
    }
  });

  test("DiffView alerts iff block_enforced flips true -> false on a BLOCKED slice", () => {
    const preTrade = [
      {
        slice_id: "live:all:p0_inplay:all",
        policy: "BLOCKED" as const,
        block_enforced: true,
      },
      {
        slice_id: "hockey:nhl:periods:all",
        policy: "BLOCKED" as const,
        block_enforced: false,
      },
      {
        slice_id: "basketball:nba:p0_game:spread",
        policy: "ADVANTAGE" as const,
        block_enforced: true,
      },
    ];

    const postTrade = [
      // Regression: BLOCKED slice flipped true -> false -> CRITICAL ALERT
      {
        slice_id: "live:all:p0_inplay:all",
        policy: "BLOCKED" as const,
        block_enforced: false,
      },
      // Recovery: BLOCKED slice flipped false -> true -> changed, NO alert
      {
        slice_id: "hockey:nhl:periods:all",
        policy: "BLOCKED" as const,
        block_enforced: true,
      },
      // Non-blocked slice flipped true -> false -> NO block-leak alert
      {
        slice_id: "basketball:nba:p0_game:spread",
        policy: "ADVANTAGE" as const,
        block_enforced: false,
      },
    ];

    const diff = diffSlicePolicyPairs(preTrade, postTrade);
    expect(diff.has_critical_alert).toBe(true);
    expect(diff.alerts).toHaveLength(1);
    expect(diff.alerts[0]?.slice_id).toBe("live:all:p0_inplay:all");
    expect(diff.alerts[0]?.alert).toBe("BLOCK_ENFORCED_FLIPPED_FALSE");
  });
});

describe("SLICE_REGISTRY AoS source-of-truth & derived handle invariants", () => {
  test("SLICE_REGISTRY is valid AoS policy data and matches all report slice_ids without bit-packed handles", () => {
    expect(() => assertValidSliceRegistry(SLICE_REGISTRY)).not.toThrow();

    const indexLookup = buildSliceIndexLookup(SLICE_REGISTRY);
    for (let i = 0; i < SLICE_REGISTRY.length; i++) {
      const spec = SLICE_REGISTRY[i]!;
      expect(isRegisteredSliceId(spec.slice_id)).toBe(true);
      expect(getSliceSpec(spec.slice_id)).toEqual(spec);
      // Derived index equals plain 0..N-1 position with zero upper-bit packing
      expect(indexLookup.indexOf(spec.slice_id)).toBe(i);
      expect(spec.slice_id.split(":")).toHaveLength(4);
    }

    for (const fixtureRow of REPORT_SEVEN_ROW_FIXTURE) {
      const reg = getSliceSpec(fixtureRow.slice_id);
      expect(reg).not.toBeNull();
      expect(reg?.sport).toBe(fixtureRow.sport);
      expect(reg?.league).toBe(fixtureRow.league);
      expect(reg?.policy).toBe(fixtureRow.policy);
      expect(reg?.policy_mechanism).toBe(fixtureRow.policy_mechanism);
    }
  });

  test("reordering SLICE_REGISTRY shifts internal indices but never changes canonical slice_id joins", async () => {
    const holdConfig = await loadHoldFloorConfig("config/wager_tiers.toml");
    const reversedRegistry: readonly SliceSpec[] = [
      ...SLICE_REGISTRY,
    ].toReversed();
    const forwardIdx = buildSliceIndexLookup(SLICE_REGISTRY);
    const reversedIdx = buildSliceIndexLookup(reversedRegistry);

    // Internal handles shift when registry order changes...
    expect(forwardIdx.indexOf("football:nfl:p0_game:spread")).not.toBe(
      reversedIdx.indexOf("football:nfl:p0_game:spread"),
    );

    // ...yet every join by slice_id (floors, router enforcement, SLO, DiffView) stays invariant
    const router = createStaticRouterOrderQuery({
      "live:all:p0_inplay:all": 7_704,
    });
    const evaluateInOrder = (registry: readonly SliceSpec[]) =>
      registry.map((spec) => {
        const seed = REPORT_SEVEN_ROW_FIXTURE.find(
          (r) => r.slice_id === spec.slice_id,
        )!;
        return deriveSliceMetrics({
          slice_id: spec.slice_id,
          sport: spec.sport,
          league: spec.league,
          period: spec.period,
          market: spec.market,
          legs: seed.legs,
          buy_share_pct: seed.buy_share_pct,
          handle_usd: seed.handle_usd,
          hold_total_pct: seed.hold_total_pct,
          hold_floor_pct: resolveHoldFloorPct(holdConfig, spec),
          policy: spec.policy,
          policy_mechanism: spec.policy_mechanism,
          policy_qualifier: spec.policy_qualifier,
          block_enforced: queryBlockEnforced(router, spec.slice_id),
          balanced_overround_pct: STANDARD_MINUS_110_BALANCED_HOLD_PCT,
        });
      });

    const rowsA = evaluateInOrder(SLICE_REGISTRY);
    const rowsB = evaluateInOrder(reversedRegistry);

    for (const rowA of rowsA) {
      const rowB = rowsB.find((r) => r.slice_id === rowA.slice_id);
      expect(rowB).toEqual(rowA);
    }
    expect(
      computeBlendedHoldSlo(rowsB, holdConfig.slo_blended_hold_floor_pct)
        .slo_hold_pct,
    ).toBeCloseTo(
      computeBlendedHoldSlo(rowsA, holdConfig.slo_blended_hold_floor_pct)
        .slo_hold_pct,
      10,
    );
  });

  test("wager_tiers.toml [hold_floors.by_slice] rejects numeric array indices and unregistered slice_ids", () => {
    expect(
      validateHoldFloorSliceOverrides({
        "football:nfl:p0_game:spread": 3.75,
      }),
    ).toEqual([]);

    expect(validateHoldFloorSliceOverrides({ "0": 3.5 })).toEqual(["0"]);
    expect(
      validateHoldFloorSliceOverrides({ "unknown:sport:p0:spread": 3.5 }),
    ).toEqual(["unknown:sport:p0:spread"]);

    expect(() =>
      parseHoldFloorConfigToml(`
[hold_floors]
default_pct = 3.50
[hold_floors.by_slice]
"0" = 4.00
`),
    ).toThrow(/by_slice/);
  });

  test("no-packing invariant: buildSliceIndexLookup returns plain 0..n-1 positions with zero upper-bit flags", () => {
    const lookup = buildSliceIndexLookup(SLICE_REGISTRY);
    expect(lookup.size).toBe(SLICE_REGISTRY.length);

    for (let i = 0; i < SLICE_REGISTRY.length; i++) {
      const idx = lookup.indexOf(SLICE_REGISTRY[i]!.slice_id);
      expect(Number.isInteger(idx)).toBe(true);
      expect(idx).toBe(i);
      // Zero upper-bit policy/axis/specificity packing in registry handles
      expect(idx >>> 5).toBe(0);
    }
    expect(lookup.indexOf("missing:slice:p0:all")).toBe(-1);

    // Synthetic 40-slice registry still returns plain 0..39 positions without upper-bit flags
    const synthetic40: SliceSpec[] = [];
    for (let k = 0; k < 40; k++) {
      synthetic40.push({
        slice_id: `football:synth_${k}:p0:spread`,
        sport: "Football",
        league: `S${k}`,
        period: "P0 Game",
        market: "Spread",
        selector: { sport: "Football" },
        policy: "LEAK",
        policy_mechanism: "VIG",
        policy_qualifier: "",
      });
    }
    const lookup40 = buildSliceIndexLookup(synthetic40);
    expect(lookup40.size).toBe(40);
    for (let k = 0; k < 40; k++) {
      expect(lookup40.indexOf(`football:synth_${k}:p0:spread`)).toBe(k);
    }
  });

  test("coverage: derived bitset predicates exhaustively match SLICE_REGISTRY AoS fields and policy bitCount sums to registry.length", () => {
    expect(typeof isBlockedSlice).toBe("function");
    expect(typeof isAdvantageSlice).toBe("function");
    expect(typeof isLeakSlice).toBe("function");
    expect(typeof isPreserveSlice).toBe("function");
    expect(typeof isLiveLockoutSlice).toBe("function");

    const registrySpecs: readonly SliceSpec[] = SLICE_REGISTRY;
    expect(registrySpecs.length).toBeGreaterThan(0);

    let blockedBits = 0;
    let advantageBits = 0;
    let leakBits = 0;
    let preserveBits = 0;
    let liveLockoutBits = 0;
    let expectedLiveLockoutBits = 0;

    for (let i = 0; i < registrySpecs.length; i++) {
      const spec = registrySpecs[i]!;
      const b = isBlockedSlice(spec.slice_id);
      const a = isAdvantageSlice(spec.slice_id);
      const l = isLeakSlice(spec.slice_id);
      const p = isPreserveSlice(spec.slice_id);
      const live = isLiveLockoutSlice(spec.slice_id);

      // Exhaustive per-slice AoS equivalence across the entire registry
      expect(b).toBe(spec.policy === "BLOCKED");
      expect(a).toBe(spec.policy === "ADVANTAGE");
      expect(l).toBe(spec.policy === "LEAK");
      expect(p).toBe(spec.policy === "PRESERVE");
      expect(live).toBe(spec.policy_mechanism === "LIVE_LOCKOUT");

      // Policy bitsets form a strict 1-of-4 partition for every slice
      const perSlicePolicyBitSum =
        Number(b) + Number(a) + Number(l) + Number(p);
      expect(perSlicePolicyBitSum).toBe(1);

      blockedBits += Number(b);
      advantageBits += Number(a);
      leakBits += Number(l);
      preserveBits += Number(p);
      liveLockoutBits += Number(live);
      if (spec.policy_mechanism === "LIVE_LOCKOUT") {
        expectedLiveLockoutBits += 1;
      }
    }

    // Coverage invariant: partition bitCount sums to SLICE_REGISTRY.length
    expect(blockedBits + advantageBits + leakBits + preserveBits).toBe(
      registrySpecs.length,
    );
    expect(liveLockoutBits).toBe(expectedLiveLockoutBits);
  });

  test("multi-word synthetic registry: crosses bit 31/32 unsigned boundary cleanly and leaves >= registry.length bits unset", () => {
    // Synthetic 40-slice registry (distinct from 7-slice SLICE_REGISTRY; spans 2 Uint32 words)
    const syntheticRegistry: SliceSpec[] = [];
    for (let k = 0; k < 40; k++) {
      syntheticRegistry.push({
        slice_id: `football:league_${k}:p0:spread`,
        sport: "Football",
        league: `L${k}`,
        period: "P0 Game",
        market: "Spread",
        selector: { sport: "Football" },
        policy: k % 3 === 0 ? "BLOCKED" : "LEAK",
        policy_mechanism: "VIG",
        policy_qualifier: "",
      });
    }
    expect(syntheticRegistry.length).toBe(40);
    expect(syntheticRegistry.length).not.toBe(SLICE_REGISTRY.length);

    // 1. Explicit bit 31 (word 0 sign bit: 1 << 31) vs bit 32 (word 1 bit 0) crossing
    const onlyBit31 = deriveSliceBitsetPredicate(
      (s) => s.slice_id === "football:league_31:p0:spread",
      syntheticRegistry,
    );
    const onlyBit32 = deriveSliceBitsetPredicate(
      (s) => s.slice_id === "football:league_32:p0:spread",
      syntheticRegistry,
    );
    const bothBit31And32 = deriveSliceBitsetPredicate(
      (s) =>
        s.slice_id === "football:league_31:p0:spread" ||
        s.slice_id === "football:league_32:p0:spread",
      syntheticRegistry,
    );

    let count31 = 0;
    let count32 = 0;
    let countBoth = 0;
    for (let k = 0; k < 40; k++) {
      const id = `football:league_${k}:p0:spread`;
      if (onlyBit31(id)) count31 += 1;
      if (onlyBit32(id)) count32 += 1;
      if (bothBit31And32(id)) countBoth += 1;
    }
    expect(onlyBit31("football:league_31:p0:spread")).toBe(true);
    expect(onlyBit31("football:league_32:p0:spread")).toBe(false);
    expect(count31).toBe(1);

    expect(onlyBit32("football:league_31:p0:spread")).toBe(false);
    expect(onlyBit32("football:league_32:p0:spread")).toBe(true);
    expect(count32).toBe(1);

    expect(bothBit31And32("football:league_30:p0:spread")).toBe(false);
    expect(bothBit31And32("football:league_31:p0:spread")).toBe(true);
    expect(bothBit31And32("football:league_32:p0:spread")).toBe(true);
    expect(bothBit31And32("football:league_33:p0:spread")).toBe(false);
    expect(countBoth).toBe(2);

    // 2. Reorder invariance across multi-word synthetic registry
    const predForward = deriveSliceBitsetPredicate(
      (s) => s.policy === "BLOCKED",
      syntheticRegistry,
    );
    const predReversed = deriveSliceBitsetPredicate(
      (s) => s.policy === "BLOCKED",
      syntheticRegistry.toReversed(),
    );
    for (let k = 0; k < 40; k++) {
      const id = `football:league_${k}:p0:spread`;
      expect(predForward(id)).toBe(k % 3 === 0);
      expect(predReversed(id)).toBe(k % 3 === 0);
    }

    // 3. Truncation correctness: all-true predicate sets bits 0..39 only; indices >= 40 stay unset
    resetSliceUnknownTelemetry();
    const allSetTelemetryMode = deriveSliceBitsetPredicate(
      () => true,
      syntheticRegistry,
      { onUnknownSlice: "telemetry" },
    );
    let activeTrueBits = 0;
    for (let k = 0; k < 40; k++) {
      if (allSetTelemetryMode(`football:league_${k}:p0:spread`)) {
        activeTrueBits += 1;
      }
    }
    expect(activeTrueBits).toBe(40);
    expect(getSliceUnknownTelemetry().slice_unknown_total).toBe(0);

    // Probe trailing unused bits in word 1 (40..63) and beyond word 1 (64..67)
    for (let k = 40; k < 68; k++) {
      expect(allSetTelemetryMode(`football:league_${k}:p0:spread`)).toBe(false);
    }
    expect(getSliceUnknownTelemetry().slice_unknown_total).toBe(28);
  });

  test("unknown slice_id: throws UnknownSliceIdError in dev/default mode and increments slice_unknown_total{slice_id} in telemetry mode", async () => {
    expect(resolveDefaultUnknownSlicePolicy("production")).toBe("telemetry");
    expect(resolveDefaultUnknownSlicePolicy("development")).toBe("throw");
    expect(resolveDefaultUnknownSlicePolicy("test")).toBe("throw");
    expect(resolveDefaultUnknownSlicePolicy(undefined)).toBe("throw");

    resetSliceUnknownTelemetry();

    // 1. Default (non-production) mode fails closed with UnknownSliceIdError AND records telemetry
    expect(() => isBlockedSlice("typo:slice:p0:spread")).toThrow(
      UnknownSliceIdError,
    );
    expect(() => isBlockedSlice("typo:slice:p0:spread")).toThrow(
      /typo:slice:p0:spread/,
    );
    expect(() => isBlockedSlice("0")).toThrow(UnknownSliceIdError);

    const router = createStaticRouterOrderQuery({
      "hockey:nhl:periods:all": 27_816,
      "baseball:mlb:f5:spread": 0,
      "live:all:p0_inplay:all": 7_704,
    });
    const isEnforcedStrict = deriveRouterBlockEnforcedPredicate(
      router,
      SLICE_REGISTRY,
    );
    expect(isEnforcedStrict("hockey:nhl:periods:all")).toBe(false);
    expect(isEnforcedStrict("baseball:mlb:f5:spread")).toBe(true);
    expect(isEnforcedStrict("live:all:p0_inplay:all")).toBe(false);
    expect(isEnforcedStrict("football:nfl:p0_game:spread")).toBe(true);
    expect(() => isEnforcedStrict("unregistered:slice:p0:all")).toThrow(
      UnknownSliceIdError,
    );

    const afterStrict = getSliceUnknownTelemetry();
    expect(afterStrict.slice_unknown_total).toBe(4);
    expect(afterStrict.by_slice_id["typo:slice:p0:spread"]).toBe(2);
    expect(afterStrict.by_slice_id["0"]).toBe(1);
    expect(afterStrict.by_slice_id["unregistered:slice:p0:all"]).toBe(1);

    // 2. Production / telemetry mode returns false without throwing AND increments slice_unknown_total{slice_id}
    const isEnforcedProd = deriveRouterBlockEnforcedPredicate(
      router,
      SLICE_REGISTRY,
      { onUnknownSlice: "telemetry" },
    );
    expect(isEnforcedProd("unregistered:slice:p0:all")).toBe(false);
    expect(getSliceUnknownTelemetry().slice_unknown_total).toBe(5);
    expect(
      getSliceUnknownTelemetry().by_slice_id["unregistered:slice:p0:all"],
    ).toBe(2);

    // 3. DataTable SoA spine encapsulates bitsets behind rowIndex & slice_id predicates
    const holdConfig = await loadHoldFloorConfig("config/wager_tiers.toml");
    const spine = new SliceMetricsSoASpine(16);
    spine.flush(
      SLICE_REGISTRY.map((spec) => ({
        slice_id: spec.slice_id,
        sport: spec.sport,
        league: spec.league,
        period: spec.period,
        market: spec.market,
        legs: 1000,
        buy_share_pct: 50,
        handle_usd: 1_000_000,
        hold_total_pct: 2.0,
        hold_floor_pct: resolveHoldFloorPct(holdConfig, spec),
        policy: spec.policy,
        policy_mechanism: spec.policy_mechanism,
        policy_qualifier: spec.policy_qualifier,
        block_enforced: isEnforcedStrict(spec.slice_id),
        balanced_overround_pct: STANDARD_MINUS_110_BALANCED_HOLD_PCT,
      })),
    );
    expect("block_enforced_bits" in spine.columns).toBe(false);
    expect("flags_mask" in spine.columns).toBe(false);
    for (let rowIndex = 0; rowIndex < SLICE_REGISTRY.length; rowIndex++) {
      const id = SLICE_REGISTRY[rowIndex]!.slice_id;
      expect(spine.isBlockEnforcedAt(rowIndex)).toBe(isEnforcedStrict(id));
      expect(spine.isSliceBlockEnforced(id)).toBe(isEnforcedStrict(id));
      expect(spine.hasFlagAt(rowIndex, "HOLD_BELOW_FLOOR")).toBe(true);
      expect(spine.hasFlagAt(rowIndex, "POLICY_DATA_CONFLICT")).toBe(
        isBlockedSlice(id) && !isEnforcedStrict(id),
      );
    }
    expect(() => spine.isSliceBlockEnforced("missing:slice:p0:all")).toThrow(
      UnknownSliceIdError,
    );
    expect(
      spine.isSliceBlockEnforced("missing:slice:p0:all", {
        onUnknownSlice: "telemetry",
      }),
    ).toBe(false);
    expect(getSliceUnknownTelemetry().by_slice_id["missing:slice:p0:all"]).toBe(
      2,
    );
  });

  test("TypeScript type-checked AST scan: verifies src/risk/*.ts and catches all boolean-array evasion vectors", async () => {
    const riskFiles: string[] = [];
    const glob = new Bun.Glob("src/risk/*.ts");
    for await (const relPath of glob.scan(".")) {
      riskFiles.push(relPath);
    }
    expect(riskFiles.length).toBeGreaterThanOrEqual(6);
    expect(auditSliceBitsetFiles(riskFiles)).toEqual([]);

    // Evasion 1: direct boolean[] / readonly boolean[]
    expect(
      auditSliceBitsetVirtualSource(
        "src/risk/evasion_direct.ts",
        `export const flags: readonly boolean[] = [false, true];`,
      ).length,
    ).toBeGreaterThan(0);

    // Evasion 2: ReadonlyArray<boolean> and boxed Array<Boolean>
    expect(
      auditSliceBitsetVirtualSource(
        "src/risk/evasion_readonly_generic.ts",
        `export const ro: ReadonlyArray<boolean> = [];`,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      auditSliceBitsetVirtualSource(
        "src/risk/evasion_boxed_boolean.ts",
        `export const boxed: Array<Boolean> = [];`,
      ).length,
    ).toBeGreaterThan(0);

    // Evasion 3: type alias indirection (`type FlagArray = boolean[]`)
    expect(
      auditSliceBitsetVirtualSource(
        "src/risk/evasion_type_alias.ts",
        `type FlagArray = boolean[];\nexport function countSet(f: FlagArray): number { return f.length; }`,
      ).length,
    ).toBeGreaterThan(0);

    // Evasion 4: unannotated inferred boolean array (`new Array(n).fill(false)` & literal `[false, true]`)
    expect(
      auditSliceBitsetVirtualSource(
        "src/risk/evasion_inferred_fill.ts",
        `export const flags = new Array(8).fill(false);`,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      auditSliceBitsetVirtualSource(
        "src/risk/evasion_inferred_literal.ts",
        `export const flags = [false, true, false];`,
      ).length,
    ).toBeGreaterThan(0);

    // Evasion 5: Uint8Array used as a 0/1 boolean array
    expect(
      auditSliceBitsetVirtualSource(
        "src/risk/evasion_uint8_bool.ts",
        `export const blockedFlags = new Uint8Array(7);`,
      ).length,
    ).toBeGreaterThan(0);
  });
});
