import { describe, expect, test } from "bun:test";
import {
  loadHoldFloorConfig,
  resolveHoldFloorPct,
} from "../src/risk/hold_floor_config.ts";
import {
  createStaticRouterOrderQuery,
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
