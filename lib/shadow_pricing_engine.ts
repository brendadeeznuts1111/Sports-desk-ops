/**
 * @file lib/shadow_pricing_engine.ts
 * @description Arena-backed Hierarchical Taxonomy Cube (Sport -> SubSport -> Period per SubSport -> Market)
 * and counterfactual point-buy shadow-pricing & retail elasticity engine (#135).
 *
 * Adheres to AGENTS.md data-handling budgets & Signal Honesty invariants:
 *  - Fixed-capacity TypedArray Structure-of-Arrays (SoA) leg arena + Uint32Array bitsets
 *  - Zero Map, Set, boolean[], Array.from, .filter().map(), or sync fs calls on hot aggregation paths
 *  - Explicit Signal Honesty provenance ("live_db" vs "fixture")
 *  - Single-digit millisecond interactive slice & counterfactual re-evaluation across 650k+ legs
 */

import { Database } from "bun:sqlite";
import { isKeyNumberBuy } from "./customer_profile.ts";
import {
  parseBuyPointsFromDesc,
  parseSpreadAndBuyFromShortDesc,
} from "./f402_figure_date_enricher.ts";
import {
  classifyLegIntoTaxonomy,
  getValidPeriodsForSelection,
  isPeriodValidForSportId,
  isPeriodValidForSubSportId,
  MARKET_CODES,
  MARKET_COUNT,
  MARKET_ID_SPREAD,
  MARKET_ID_TOTAL,
  MARKET_LABELS,
  marketIndexOf,
  PERIOD_CODES,
  PERIOD_COUNT,
  PERIOD_DEFAULT_LABELS,
  PERIOD_ID_GAME,
  PERIOD_PORTAL_NUMBERS,
  periodIndexOf,
  resolveSlicePolicyAndRisk,
  SPORT_CODES,
  SPORT_COUNT,
  SPORT_ID_FOOTBALL,
  SPORT_LABELS,
  SUB_ID_COMBAT_GOLF,
  SUB_ID_MLB,
  SUB_ID_NBA,
  SUB_ID_NCAAB,
  SUB_ID_NCAAF,
  SUB_ID_NFL,
  SUB_ID_NHL,
  SUB_ID_SOCCER_TOP,
  SUB_ID_TENNIS_TOUR,
  SUB_ID_WNBA,
  SUBSPORT_CODES,
  SUBSPORT_COUNT,
  SUBSPORT_PARENT_SPORT_ID,
  SUBSPORT_TAXONOMY_CATALOG,
  sportIndexOf,
  subSportIndexOf,
} from "./market_taxonomy_catalog.ts";
import wagerTiersTomlDoc from "../config/wager_tiers.toml";
import {
  FALLBACK_DB_PATH,
  type ShadowSimulationResult,
} from "../scripts/shadow_price.ts";
import {
  type HoldFloorConfig,
  loadHoldFloorConfig,
  parseHoldFloorConfigDocument,
  resolveHoldFloorPct,
} from "../src/risk/hold_floor_config.ts";
import {
  createStaticRouterOrderQuery,
  deriveRouterBlockEnforcedPredicate,
} from "../src/risk/router_block_audit.ts";
import { diffSlicePolicyPairs } from "../src/risk/slice_diff_view.ts";
import {
  computeBlendedHoldSlo,
  deriveSliceMetrics,
  type SliceMetrics,
  type SlicePolicy,
} from "../src/risk/slice_metrics.ts";
import {
  isBlockedSlice,
  SLICE_REGISTRY,
  type SliceSpec,
} from "../src/risk/slice_registry.ts";
import type {
  ElasticityFrontierPoint,
  KeyNumberBucketRow,
  LadderPresetSummary,
  MarketFilter,
  PeriodFilter,
  PolicyRecommendation,
  RouterAuditMode,
  ShadowPricingDashboardPayload,
  ShadowProvenance,
  ShadowRepriceMode,
  SportFilter,
  SubSportFilter,
  TaxonomyCubeSummary,
  TaxonomyRollupRow,
} from "../types/shadow_pricing.ts";

export type {
  ElasticityFrontierPoint,
  KeyNumberBucketRow,
  LadderPresetSummary,
  MarketFilter,
  PeriodFilter,
  PolicyRecommendation,
  RouterAuditMode,
  ShadowPricingDashboardPayload,
  ShadowProvenance,
  ShadowRepriceMode,
  SportFilter,
  SubSportFilter,
  TaxonomyCubeSummary,
  TaxonomyRollupRow,
};

const DEFAULT_HOLD_FLOOR_CONFIG: HoldFloorConfig =
  parseHoldFloorConfigDocument(wagerTiersTomlDoc);

/**
 * Internal derived coordinate table compiled from `SLICE_REGISTRY` (never hand-maintained,
 * never exposed as canonical identity; `-1` denotes wildcard on that axis).
 */
interface DerivedArenaSliceTable {
  readonly count: number;
  readonly sportIds: Int8Array;
  readonly subSportIds: Int8Array;
  readonly periodIds: Int8Array;
  readonly marketIds: Int8Array;
}

function compileArenaSliceTable(
  registry: readonly SliceSpec[],
): DerivedArenaSliceTable {
  const count = registry.length;
  const sportIds = new Int8Array(count);
  const subSportIds = new Int8Array(count);
  const periodIds = new Int8Array(count);
  const marketIds = new Int8Array(count);
  for (let i = 0; i < count; i++) {
    const sel = registry[i]!.selector;
    sportIds[i] = sel.sport !== undefined ? sportIndexOf(sel.sport) : -1;
    subSportIds[i] =
      sel.subSport !== undefined ? subSportIndexOf(sel.subSport) : -1;
    periodIds[i] = sel.period !== undefined ? periodIndexOf(sel.period) : -1;
    marketIds[i] = sel.market !== undefined ? marketIndexOf(sel.market) : -1;
  }
  return { count, sportIds, subSportIds, periodIds, marketIds };
}

const DERIVED_ARENA_SLICES: DerivedArenaSliceTable =
  compileArenaSliceTable(SLICE_REGISTRY);

function twoWayBalancedOverroundPctFromAmerican(odds: number): number {
  if (!Number.isFinite(odds) || odds === 0) {
    return (10 / 220) * 100;
  }
  const abs = Math.abs(odds);
  let p1 = 0.5238095238;
  let p2 = 0.5238095238;
  if (odds < 0) {
    p1 = abs / (abs + 100);
    if (abs < 120) {
      const mirrorNeg = Math.max(100, 220 - abs);
      p2 = mirrorNeg / (mirrorNeg + 100);
    } else {
      const dog = abs - 20;
      p2 = 100 / (dog + 100);
    }
  } else {
    p1 = 100 / (abs + 100);
    const fav = abs + 20;
    p2 = fav / (fav + 100);
  }
  const sum = p1 + p2;
  return sum > 0 ? Math.max(0, ((sum - 1) / sum) * 100) : 0;
}

export interface TaxonomyRawRow {
  readonly account_id: number;
  readonly account_key: string;
  readonly bet_id: number;
  readonly stake: number | null;
  readonly price_taken_american: number | null;
  readonly raw_description: string;
  readonly result: string | null;
  readonly sport_code?: string | null | undefined;
  readonly league_name?: string | null | undefined;
  readonly market_period?: string | null | undefined;
  readonly market_type?: string | null | undefined;
}

export interface ShadowDashboardQuery {
  readonly dbPath?: string | undefined;
  readonly forceFixture?: boolean | undefined;
  readonly ladderKey3?: number | undefined;
  readonly ladderKey7?: number | undefined;
  readonly ladderKey14_21?: number | undefined;
  readonly minVolume?: number | undefined;
  readonly retailElasticity?: number | undefined;
  readonly repriceMode?: ShadowRepriceMode | undefined;
  readonly sport?: SportFilter | undefined;
  readonly subSport?: SubSportFilter | undefined;
  readonly period?: PeriodFilter | undefined;
  readonly market?: MarketFilter | undefined;
  readonly routerAuditMode?: RouterAuditMode | undefined;
  readonly holdFloorConfig?: HoldFloorConfig | undefined;
}

const OUTCOME_OTHER = 0;
const OUTCOME_WON = 1;
const OUTCOME_LOST = 2;
const OUTCOME_PUSH = 3;

const KEY_BUCKET_NON_KEY = 0;
const KEY_BUCKET_3 = 1;
const KEY_BUCKET_7 = 2;
const KEY_BUCKET_10 = 3;
const KEY_BUCKET_14 = 4;
const KEY_BUCKET_21 = 5;
const KEY_BUCKET_COUNT = 6;

const KEY_NUMBERS_BY_BUCKET: readonly (number | null)[] = [
  null,
  3,
  7,
  10,
  14,
  21,
];
const KEY_LABELS_BY_BUCKET: readonly string[] = [
  "Dead / Non-Key (or Bell-Curve)",
  "Key 3 (FG)",
  "Key 7 (TD)",
  "Key 10 (TD+FG)",
  "Key 14 (2 TD)",
  "Key 21 (3 TD)",
];
const FAIR_BREAKEVEN_BY_BUCKET: readonly number[] = [
  -118, -138, -132, -123, -123, -123,
];

const ELASTICITY_STEPS: readonly number[] = [
  0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4,
];

export const SHADOW_LADDER_PRESETS: readonly {
  readonly id: LadderPresetSummary["id"];
  readonly label: string;
  readonly subtitle: string;
  readonly ladderKey3: number;
  readonly ladderKey7: number;
  readonly ladderKey14_21: number;
}[] = [
  {
    id: "retail_flat",
    label: "Flat Retail Catalog",
    subtitle: "-120 / -125 baseline",
    ladderKey3: -120,
    ladderKey7: -120,
    ladderKey14_21: -120,
  },
  {
    id: "indifference",
    label: "Indifference Ladder",
    subtitle: "0.0% EV fair breakeven (-138 / -132 / -123)",
    ladderKey3: -138,
    ladderKey7: -132,
    ladderKey14_21: -123,
  },
  {
    id: "shadow_default",
    label: "Calibrated Shadow",
    subtitle: "dx shadow-price default (-140 / -135 / -128)",
    ladderKey3: -140,
    ladderKey7: -135,
    ladderKey14_21: -128,
  },
  {
    id: "house_hold",
    label: "Standard House Hold",
    subtitle: "~4.5% hold margin (-150 / -142 / -130)",
    ladderKey3: -150,
    ladderKey7: -142,
    ladderKey14_21: -130,
  },
];

/**
 * Compact Structure-of-Arrays (SoA) arena holding classified multi-sport legs
 * across Sport -> SubSport -> Period per SubSport -> Market.
 */
export interface ShadowPricingArena {
  readonly provenance: ShadowProvenance;
  readonly sourceLabel: string;
  readonly loadedInMs: number;
  readonly legCount: number;
  readonly accountCount: number;
  readonly accountNames: readonly string[];
  readonly legAccountIdx: Int32Array;
  readonly legStakeUsd: Float64Array;
  readonly legPriceTaken: Int32Array;
  readonly legKeyBucket: Uint8Array;
  readonly legOutcome: Uint8Array;
  readonly legSportId: Uint8Array;
  readonly legSubSportId: Uint8Array;
  readonly legPeriodId: Uint8Array;
  readonly legMarketId: Uint8Array;
  /** Dense bitset: 1 when `parseBuyPointsFromDesc > 0` (exact CLI parity cohort). */
  readonly legPositiveBuyBits: Uint32Array;
  /** Dense bitset: 1 when leg has any point buy (including Over totals `buying -0.5`). */
  readonly legAnyBuyBits: Uint32Array;
}

function toWinMultiplier(odds: number): number {
  if (odds === 0) return 1;
  if (odds < 0) return 100 / -odds;
  return odds / 100;
}

function encodeKeyBucket(key: number | null): number {
  if (key === 3) return KEY_BUCKET_3;
  if (key === 7) return KEY_BUCKET_7;
  if (key === 10) return KEY_BUCKET_10;
  if (key === 14) return KEY_BUCKET_14;
  if (key === 21) return KEY_BUCKET_21;
  return KEY_BUCKET_NON_KEY;
}

function encodeOutcome(raw: string): number {
  const lower = raw.toLowerCase();
  if (lower === "won") return OUTCOME_WON;
  if (lower === "lost") return OUTCOME_LOST;
  if (lower === "push") return OUTCOME_PUSH;
  return OUTCOME_OTHER;
}

export function buildArenaFromRows(
  rows: readonly TaxonomyRawRow[],
  provenance: ShadowProvenance,
  sourceLabel: string,
  loadedInMs: number,
  dynamicTeamMap?: Record<string, number>,
): ShadowPricingArena {
  const cap = rows.length;
  const legAccountIdx = new Int32Array(cap);
  const legStakeUsd = new Float64Array(cap);
  const legPriceTaken = new Int32Array(cap);
  const legKeyBucket = new Uint8Array(cap);
  const legOutcome = new Uint8Array(cap);
  const legSportId = new Uint8Array(cap);
  const legSubSportId = new Uint8Array(cap);
  const legPeriodId = new Uint8Array(cap);
  const legMarketId = new Uint8Array(cap);
  const wordCap = (cap + 31) >>> 5;
  const legPositiveBuyBits = new Uint32Array(wordCap);
  const legAnyBuyBits = new Uint32Array(wordCap);

  const accountIndexByKey = Object.create(null) as Record<string, number>;
  const accountNames: string[] = [];

  let legCount = 0;
  let accountCount = 0;

  for (let i = 0; i < cap; i++) {
    const row = rows[i]!;
    const desc = row.raw_description ?? "";
    const buyPts = parseBuyPointsFromDesc(desc);
    const hasPositiveBuy = buyPts > 0;

    const coords = classifyLegIntoTaxonomy({
      rawDescription: desc,
      sportCode: row.sport_code,
      leagueName: row.league_name,
      marketPeriod: row.market_period,
      marketType: row.market_type,
      hasPositiveBuyPoints: hasPositiveBuy,
      dynamicTeamMap,
    });

    // Football key-number margin clustering strictly applies to Pre-Game Football Game (P0) Spreads
    let bucket = KEY_BUCKET_NON_KEY;
    if (
      hasPositiveBuy &&
      coords.sportId === SPORT_ID_FOOTBALL &&
      coords.periodId === PERIOD_ID_GAME &&
      coords.marketId === MARKET_ID_SPREAD
    ) {
      const parsed = parseSpreadAndBuyFromShortDesc(desc);
      const keyCheck = isKeyNumberBuy(parsed.adjSpread, buyPts);
      bucket = encodeKeyBucket(keyCheck.key);
    }

    const account = row.account_key || "UNKNOWN";
    let accIdx = accountIndexByKey[account];
    if (accIdx === undefined) {
      accIdx = accountCount++;
      accountIndexByKey[account] = accIdx;
      accountNames.push(account);
    }

    const stake = row.stake !== null && row.stake > 0 ? row.stake : 100;
    const rawPrice = row.price_taken_american;
    const price =
      rawPrice !== null && rawPrice !== undefined && rawPrice !== 0
        ? rawPrice
        : -110;
    const outcome = encodeOutcome(row.result ?? "");

    const idx = legCount++;
    legAccountIdx[idx] = accIdx;
    legStakeUsd[idx] = stake;
    legPriceTaken[idx] = price;
    legKeyBucket[idx] = bucket;
    legOutcome[idx] = outcome;
    legSportId[idx] = coords.sportId;
    legSubSportId[idx] = coords.subSportId;
    legPeriodId[idx] = coords.periodId;
    legMarketId[idx] = coords.marketId;

    if (hasPositiveBuy) {
      legPositiveBuyBits[idx >>> 5] =
        (legPositiveBuyBits[idx >>> 5] ?? 0) | (1 << (idx & 31));
    }
    if (coords.hasPointBuy) {
      legAnyBuyBits[idx >>> 5] =
        (legAnyBuyBits[idx >>> 5] ?? 0) | (1 << (idx & 31));
    }
  }

  const usedWords = (legCount + 31) >>> 5;
  return {
    provenance,
    sourceLabel,
    loadedInMs,
    legCount,
    accountCount,
    accountNames,
    legAccountIdx: legAccountIdx.subarray(0, legCount),
    legStakeUsd: legStakeUsd.subarray(0, legCount),
    legPriceTaken: legPriceTaken.subarray(0, legCount),
    legKeyBucket: legKeyBucket.subarray(0, legCount),
    legOutcome: legOutcome.subarray(0, legCount),
    legSportId: legSportId.subarray(0, legCount),
    legSubSportId: legSubSportId.subarray(0, legCount),
    legPeriodId: legPeriodId.subarray(0, legCount),
    legMarketId: legMarketId.subarray(0, legCount),
    legPositiveBuyBits: legPositiveBuyBits.subarray(0, usedWords),
    legAnyBuyBits: legAnyBuyBits.subarray(0, usedWords),
  };
}

function buildDeterministicFixtureRows(): TaxonomyRawRow[] {
  const specs: readonly {
    readonly accountId: number;
    readonly accountKey: string;
    readonly count: number;
    readonly stake: number;
    readonly price: number;
    readonly desc: string;
    readonly winEvery: number;
    readonly sportCode?: string;
    readonly leagueName?: string;
    readonly marketPeriod?: string;
    readonly marketType?: string;
  }[] = [
    // --- Football: NFL (Game Spread Key Buys + 1H + 1Q + Total + Props) ---
    {
      accountId: 1,
      accountKey: "GP301",
      count: 24,
      stake: 5500,
      price: -120,
      desc: "Football #452 Chiefs  3 -120 - buying ½ For Game",
      winEvery: 2,
      sportCode: "football",
      leagueName: "NFL",
      marketPeriod: "full_game",
      marketType: "spread",
    },
    {
      accountId: 1,
      accountKey: "GP301",
      count: 14,
      stake: 4800,
      price: -125,
      desc: "Football #458 Ravens  7 -125 - buying ½ For Game",
      winEvery: 2,
      sportCode: "football",
      leagueName: "NFL",
      marketPeriod: "full_game",
      marketType: "spread",
    },
    {
      accountId: 4,
      accountKey: "GP300",
      count: 18,
      stake: 3500,
      price: -145,
      desc: "Football #462 Bills  3 -145 - buying 1 For Game",
      winEvery: 2,
      sportCode: "football",
      leagueName: "NFL",
      marketPeriod: "full_game",
      marketType: "spread",
    },
    {
      accountId: 5,
      accountKey: "DD008",
      count: 16,
      stake: 2500,
      price: -120,
      desc: "Football #466 Eagles  14 -120 - buying ½ For Game",
      winEvery: 2,
      sportCode: "football",
      leagueName: "NFL",
      marketPeriod: "full_game",
      marketType: "spread",
    },
    {
      accountId: 6,
      accountKey: "RF2003",
      count: 22,
      stake: 350,
      price: -120,
      desc: "Football #470 Cowboys  5 -120 - buying ½ For Game",
      winEvery: 3,
      sportCode: "football",
      leagueName: "NFL",
      marketPeriod: "full_game",
      marketType: "spread",
    },
    {
      accountId: 7,
      accountKey: "SQUARE1",
      count: 20,
      stake: 300,
      price: -120,
      desc: "Football #474 Chiefs Ravens U 47.5 -120 - buying ½ For Game",
      winEvery: 3,
      sportCode: "football",
      leagueName: "NFL",
      marketPeriod: "full_game",
      marketType: "total",
    },
    {
      accountId: 10,
      accountKey: "DRV101",
      count: 16,
      stake: 1200,
      price: -110,
      desc: "Football - Kansas City Chiefs vs Buffalo Bills 1st Half Point spread Chiefs -1.5 -110",
      winEvery: 2,
      sportCode: "football",
      leagueName: "1H-NFL",
      marketPeriod: "1h",
      marketType: "spread",
    },
    {
      accountId: 10,
      accountKey: "DRV101",
      count: 12,
      stake: 800,
      price: -115,
      desc: "Football - Philadelphia Eagles vs Dallas Cowboys 1st Quarter Total Over 9.5 -115",
      winEvery: 3,
      sportCode: "football",
      leagueName: "NFL",
      marketPeriod: "full_game",
      marketType: "total",
    },
    {
      accountId: 11,
      accountKey: "PRP404",
      count: 14,
      stake: 400,
      price: -114,
      desc: "Football NFL Josh Allen Over 254.5 Passing Yards -114",
      winEvery: 3,
      sportCode: "football",
      leagueName: "NFL",
      marketPeriod: "full_game",
      marketType: "prop",
    },

    // --- Football: NCAAF (Game Spread Key Buys + 1H + Team Total) ---
    {
      accountId: 2,
      accountKey: "BRT5229",
      count: 20,
      stake: 4200,
      price: -120,
      desc: "Football #184 Georgia  3 -120 - buying ½ For Game",
      winEvery: 2,
      sportCode: "football",
      leagueName: "NCAAF",
      marketPeriod: "full_game",
      marketType: "spread",
    },
    {
      accountId: 3,
      accountKey: "BRT5235",
      count: 18,
      stake: 3000,
      price: -125,
      desc: "Football #188 Texas  7 -125 - buying ½ For Game",
      winEvery: 2,
      sportCode: "football",
      leagueName: "NCAAF",
      marketPeriod: "full_game",
      marketType: "spread",
    },
    {
      accountId: 8,
      accountKey: "RET882",
      count: 18,
      stake: 400,
      price: -120,
      desc: "Football #192 Oregon  3 -120 - buying ½ For Game",
      winEvery: 3,
      sportCode: "football",
      leagueName: "NCAAF",
      marketPeriod: "full_game",
      marketType: "spread",
    },
    {
      accountId: 9,
      accountKey: "RET914",
      count: 16,
      stake: 300,
      price: -125,
      desc: "Football #196 LSU  10 -125 - buying ½ For Game",
      winEvery: 3,
      sportCode: "football",
      leagueName: "NCAAF",
      marketPeriod: "full_game",
      marketType: "spread",
    },
    {
      accountId: 10,
      accountKey: "DRV101",
      count: 15,
      stake: 1500,
      price: -110,
      desc: "Football - Alabama vs Georgia 1st Half Point spread Georgia -3.5 -110",
      winEvery: 2,
      sportCode: "football",
      leagueName: "1H-NCAAF",
      marketPeriod: "1h",
      marketType: "spread",
    },
    {
      accountId: 11,
      accountKey: "PRP404",
      count: 10,
      stake: 500,
      price: -115,
      desc: "Football - Texas vs Oklahoma Game Texas team total Over 31.5 -115",
      winEvery: 3,
      sportCode: "football",
      leagueName: "NCAAF",
      marketPeriod: "full_game",
      marketType: "team_total",
    },

    // --- Basketball: NBA, NCAAB (Halves only!), WNBA ---
    {
      accountId: 12,
      accountKey: "HOOP01",
      count: 24,
      stake: 650,
      price: -120,
      desc: "Lakers  4.5 -120 - buying 0.5 For Game",
      winEvery: 3,
      sportCode: "basketball",
      leagueName: "NBA",
      marketPeriod: "full_game",
      marketType: "spread",
    },
    {
      accountId: 12,
      accountKey: "HOOP01",
      count: 16,
      stake: 800,
      price: -150,
      desc: "Celtics  6.5 -150 - buying 2 For Game",
      winEvery: 3,
      sportCode: "basketball",
      leagueName: "NBA",
      marketPeriod: "full_game",
      marketType: "spread",
    },
    {
      accountId: 13,
      accountKey: "NBAQTR",
      count: 14,
      stake: 900,
      price: -115,
      desc: "Basketball - Golden State Warriors vs Los Angeles Lakers 3rd Quarter Point spread Lakers -2.5 -115",
      winEvery: 2,
      sportCode: "basketball",
      leagueName: "NBA",
      marketPeriod: "full_game",
      marketType: "spread",
    },
    {
      accountId: 14,
      accountKey: "CBB20M",
      count: 18,
      stake: 500,
      price: -120,
      desc: "Basketball #612 Duke  -4.5 -120 - buying 0.5 For Game",
      winEvery: 3,
      sportCode: "basketball",
      leagueName: "NCAAB",
      marketPeriod: "full_game",
      marketType: "spread",
    },
    {
      accountId: 14,
      accountKey: "CBB20M",
      count: 12,
      stake: 750,
      price: -110,
      desc: "Basketball - Duke vs North Carolina 1st Half Total Under 69.5 -110",
      winEvery: 2,
      sportCode: "basketball",
      leagueName: "NCAAB",
      marketPeriod: "1h",
      marketType: "total",
    },
    {
      accountId: 15,
      accountKey: "WNBA99",
      count: 12,
      stake: 400,
      price: -120,
      desc: "Liberty  -5.5 -120 - buying 0.5 For Game",
      winEvery: 3,
      sportCode: "basketball",
      leagueName: "WNBA",
      marketPeriod: "full_game",
      marketType: "spread",
    },

    // --- Hockey: NHL (Game OT, 60m Reg, P1) & Hockey Alter ---
    {
      accountId: 16,
      accountKey: "ICE100",
      count: 18,
      stake: 1100,
      price: -135,
      desc: "Hockey - Colorado Avalanche vs Calgary Flames Match (Including OT) Winner (2 way) Avalanche -135",
      winEvery: 2,
      sportCode: "hockey",
      leagueName: "NHL",
      marketPeriod: "full_game",
      marketType: "moneyline",
    },
    {
      accountId: 16,
      accountKey: "ICE100",
      count: 12,
      stake: 700,
      price: -110,
      desc: "Hockey - Edmonton Oilers vs Vancouver Canucks 1st Period Total Over 1.5 -110",
      winEvery: 3,
      sportCode: "hockey",
      leagueName: "NHL",
      marketPeriod: "full_game",
      marketType: "total",
    },
    {
      accountId: 16,
      accountKey: "ICE100",
      count: 10,
      stake: 600,
      price: -105,
      desc: "Mammoth (Reg Time) -0.5 -105",
      winEvery: 3,
      sportCode: "hockey",
      leagueName: "NHL",
      marketPeriod: "full_game",
      marketType: "spread",
    },
    {
      accountId: 16,
      accountKey: "ICE100",
      count: 8,
      stake: 500,
      price: 185,
      desc: "Hockey Alter - Bruins -2.5 +185",
      winEvery: 4,
      sportCode: "hockey",
      leagueName: "NHL",
      marketPeriod: "full_game",
      marketType: "spread",
    },

    // --- Baseball: MLB (9 Inn, F5, Single Inning) ---
    {
      accountId: 17,
      accountKey: "F5SHARP",
      count: 16,
      stake: 1400,
      price: -115,
      desc: "Baseball - Los Angeles Dodgers vs San Diego Padres 1st 5 Innings Point spread Dodgers -0.5 -115",
      winEvery: 2,
      sportCode: "baseball",
      leagueName: "F5-MLB",
      marketPeriod: "f5",
      marketType: "spread",
    },
    {
      accountId: 17,
      accountKey: "F5SHARP",
      count: 14,
      stake: 950,
      price: -125,
      desc: "Baseball - New York Yankees vs Boston Red Sox Game Money Line Yankees -125",
      winEvery: 3,
      sportCode: "baseball",
      leagueName: "MLB",
      marketPeriod: "full_game",
      marketType: "moneyline",
    },
    {
      accountId: 17,
      accountKey: "F5SHARP",
      count: 10,
      stake: 350,
      price: -130,
      desc: "Baseball - San Diego Padres vs Colorado Rockies 1st Inning Total Under 0.5 -130",
      winEvery: 3,
      sportCode: "baseball",
      leagueName: "MLB",
      marketPeriod: "full_game",
      marketType: "total",
    },

    // --- Soccer: 90m & 1H ---
    {
      accountId: 18,
      accountKey: "EPL90",
      count: 14,
      stake: 850,
      price: -112,
      desc: "Soccer - Arsenal vs Liverpool Game Point spread Arsenal -0.25 -112",
      winEvery: 3,
      sportCode: "soccer",
      leagueName: "PREMIER-LEAGUE",
      marketPeriod: "full_game",
      marketType: "spread",
    },
    {
      accountId: 18,
      accountKey: "EPL90",
      count: 10,
      stake: 500,
      price: -118,
      desc: "Soccer - Real Madrid vs Barcelona 1st Half Total Over 1.25 -118",
      winEvery: 3,
      sportCode: "soccer",
      leagueName: "1H-LA-LIGA",
      marketPeriod: "1h",
      marketType: "total",
    },

    // --- LIVE In-Play (#9000-series: Point Buys Strictly Blocked) ---
    {
      accountId: 19,
      accountKey: "LIVESNP",
      count: 16,
      stake: 1800,
      price: -115,
      desc: "Football #9452 Chiefs (Live) -3.5 -115",
      winEvery: 2,
    },
    {
      accountId: 19,
      accountKey: "LIVESNP",
      count: 12,
      stake: 1300,
      price: -115,
      desc: "Basketball #9512 Lakers (Live) Celtics (Live) O 224.5 -115",
      winEvery: 2,
    },
    {
      accountId: 19,
      accountKey: "LIVESNP",
      count: 10,
      stake: 900,
      price: 115,
      desc: "Flames (Live) Avalanche (Live) O 5.5 +115",
      winEvery: 3,
    },

    // --- Other: Tennis & Golf ---
    {
      accountId: 20,
      accountKey: "TOUR77",
      count: 10,
      stake: 600,
      price: -120,
      desc: "Tennis - Alcaraz vs Sinner 1st Set Winner Alcaraz -120",
      winEvery: 3,
      sportCode: "tennis",
      leagueName: "ATP",
      marketPeriod: "set",
      marketType: "moneyline",
    },
    {
      accountId: 20,
      accountKey: "TOUR77",
      count: 8,
      stake: 450,
      price: -110,
      desc: "Golf Round 1 Matchup Scheffler -110",
      winEvery: 3,
      sportCode: "golf",
      leagueName: "ROUND-1-FED-EX-500",
      marketPeriod: "round",
      marketType: "moneyline",
    },
  ];

  const rows: TaxonomyRawRow[] = [];
  let betId = 1;
  for (let s = 0; s < specs.length; s++) {
    const spec = specs[s]!;
    for (let k = 0; k < spec.count; k++) {
      const won = k % spec.winEvery === 0;
      const push = !won && k % 11 === 0;
      rows.push({
        account_id: spec.accountId,
        account_key: spec.accountKey,
        bet_id: betId++,
        stake: spec.stake,
        price_taken_american: spec.price,
        raw_description: spec.desc,
        result: won ? "won" : push ? "push" : "lost",
        sport_code: spec.sportCode ?? null,
        league_name: spec.leagueName ?? null,
        market_period: spec.marketPeriod ?? null,
        market_type: spec.marketType ?? null,
      });
    }
  }
  return rows;
}

function buildDynamicEventTeamMap(db: Database): Record<string, number> {
  const map = Object.create(null) as Record<string, number>;
  const rows = db
    .query<
      {
        home_participant: string | null;
        away_participant: string | null;
        sport_code: string;
        league_name: string;
      },
      []
    >(
      `
      SELECT DISTINCT e.home_participant, e.away_participant, sp.code as sport_code, lg.name as league_name
      FROM event e
      JOIN league lg ON lg.league_id = e.league_id
      JOIN sport sp ON sp.sport_id = lg.sport_id
      WHERE e.home_participant IS NOT NULL OR e.away_participant IS NOT NULL
    `,
    )
    .all();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const sp = r.sport_code.toLowerCase();
    const lg = r.league_name.toUpperCase();
    let subId = -1;
    if (sp === "football") {
      subId = lg.includes("NCAAF") ? SUB_ID_NCAAF : SUB_ID_NFL;
    } else if (sp === "basketball") {
      subId = lg.includes("WNBA")
        ? SUB_ID_WNBA
        : lg.includes("NCAAB")
          ? SUB_ID_NCAAB
          : SUB_ID_NBA;
    } else if (sp === "hockey") {
      subId = SUB_ID_NHL;
    } else if (sp === "baseball") {
      subId = SUB_ID_MLB;
    } else if (sp === "soccer") {
      subId = SUB_ID_SOCCER_TOP;
    } else if (sp === "tennis") {
      subId = SUB_ID_TENNIS_TOUR;
    } else if (sp === "fighting" || sp === "golf") {
      subId = SUB_ID_COMBAT_GOLF;
    }
    if (subId === -1) continue;

    if (r.home_participant) {
      const h = r.home_participant.trim().toLowerCase();
      if (h !== "" && map[h] === undefined) map[h] = subId;
    }
    if (r.away_participant) {
      const a = r.away_participant.trim().toLowerCase();
      if (a !== "" && map[a] === undefined) map[a] = subId;
    }
  }
  return map;
}

function hasFullTaxonomyTables(db: Database): boolean {
  const row = db
    .query<{ c: number }, []>(
      `SELECT COUNT(*) as c FROM sqlite_master WHERE type = 'table' AND name IN ('selection', 'market', 'event', 'league', 'sport')`,
    )
    .get();
  return (row?.c ?? 0) === 5;
}

let cachedLiveDbPath: string | null = null;
let cachedLiveArena: ShadowPricingArena | null = null;
let cachedFixtureArena: ShadowPricingArena | null = null;

export async function loadShadowPricingArena(options?: {
  readonly dbPath?: string | undefined;
  readonly forceFixture?: boolean | undefined;
}): Promise<ShadowPricingArena> {
  if (options?.forceFixture) {
    if (!cachedFixtureArena) {
      const t0 = performance.now();
      const rows = buildDeterministicFixtureRows();
      cachedFixtureArena = buildArenaFromRows(
        rows,
        "fixture",
        "fixture://multi-sport-taxonomy-cohort",
        Number((performance.now() - t0).toFixed(2)),
      );
    }
    return cachedFixtureArena;
  }

  const candidatePath =
    options?.dbPath ?? Bun.env.SHADOW_PRICE_DB ?? FALLBACK_DB_PATH;
  const dbExists = await Bun.file(candidatePath).exists();

  if (!dbExists) {
    if (!cachedFixtureArena) {
      const t0 = performance.now();
      const rows = buildDeterministicFixtureRows();
      cachedFixtureArena = buildArenaFromRows(
        rows,
        "fixture",
        `fixture://fallback (missing ${candidatePath.split("/").pop() ?? "hist-mine.db"})`,
        Number((performance.now() - t0).toFixed(2)),
      );
    }
    return cachedFixtureArena;
  }

  if (cachedLiveArena && cachedLiveDbPath === candidatePath) {
    return cachedLiveArena;
  }

  const t0 = performance.now();
  const db = new Database(candidatePath, { readonly: true });
  try {
    try {
      db.run("PRAGMA cache_size = -64000;");
      db.run("PRAGMA temp_store = MEMORY;");
    } catch {
      // signal-honesty: intentional-readonly-pragma-fallback
    }

    let rows: TaxonomyRawRow[];
    let dynamicTeamMap: Record<string, number> | undefined;

    if (hasFullTaxonomyTables(db)) {
      dynamicTeamMap = buildDynamicEventTeamMap(db);
      rows = db
        .query<TaxonomyRawRow, []>(
          `
          WITH filtered AS MATERIALIZED (
            SELECT bet_leg_id, bet_id, selection_id, stake as leg_stake, price_taken_american, raw_description, result
            FROM bet_leg
            WHERE selection_id IS NOT NULL
               OR raw_description LIKE '%buying%'
               OR raw_description LIKE '%(Live)%'
               OR raw_description LIKE '%1st Half%'
               OR raw_description LIKE '%2nd Half%'
               OR raw_description LIKE '%Quarter%'
               OR raw_description LIKE '%Period%'
          )
          SELECT
            b.account_id,
            a.account_key,
            b.bet_id,
            COALESCE(f.leg_stake, b.stake) as stake,
            f.price_taken_american,
            f.raw_description,
            f.result,
            sp.code as sport_code,
            lg.name as league_name,
            m.period as market_period,
            m.market_type as market_type
          FROM filtered f
          JOIN bet b ON f.bet_id = b.bet_id
          JOIN account a ON b.account_id = a.account_id
          LEFT JOIN selection s ON s.selection_id = f.selection_id
          LEFT JOIN market m ON m.market_id = s.market_id
          LEFT JOIN event e ON e.event_id = m.event_id
          LEFT JOIN league lg ON lg.league_id = e.league_id
          LEFT JOIN sport sp ON sp.sport_id = lg.sport_id
        `,
        )
        .all();
    } else {
      rows = db
        .query<TaxonomyRawRow, []>(
          `
          SELECT
            b.account_id,
            a.account_key,
            b.bet_id,
            b.stake,
            bl.price_taken_american,
            bl.raw_description,
            bl.result
          FROM bet_leg bl
          JOIN bet b ON bl.bet_id = b.bet_id
          JOIN account a ON b.account_id = a.account_id
        `,
        )
        .all();
    }

    const loadedInMs = Number((performance.now() - t0).toFixed(2));
    const arena = buildArenaFromRows(
      rows,
      "live_db",
      candidatePath.split("/").pop() ?? "hist-mine.db",
      loadedInMs,
      dynamicTeamMap,
    );

    if (!options?.dbPath) {
      cachedLiveDbPath = candidatePath;
      cachedLiveArena = arena;
    }
    return arena;
  } finally {
    db.close();
  }
}

function resolveShadowOdds(
  priceTaken: number,
  bucket: number,
  ladderKey3: number,
  ladderKey7: number,
  ladderKey14_21: number,
  repriceMode: ShadowRepriceMode,
): number {
  let candidate = priceTaken;
  if (bucket === KEY_BUCKET_3) candidate = ladderKey3;
  else if (bucket === KEY_BUCKET_7) candidate = ladderKey7;
  else if (
    bucket === KEY_BUCKET_10 ||
    bucket === KEY_BUCKET_14 ||
    bucket === KEY_BUCKET_21
  ) {
    candidate = ladderKey14_21;
  } else {
    return priceTaken;
  }

  if (repriceMode === "floor") {
    return toWinMultiplier(candidate) < toWinMultiplier(priceTaken)
      ? candidate
      : priceTaken;
  }
  return candidate;
}

interface PresetPassResult {
  readonly sharpActualPnl: number;
  readonly sharpShadowPnl: number;
  readonly retailActualPnl: number;
  readonly retailUnscaledShadowPnl: number;
}

function runSlicePresetPass(
  arena: ShadowPricingArena,
  fSport: number,
  fSubSport: number,
  fPeriod: number,
  fMarket: number,
  sharpBits: Uint32Array,
  ladderKey3: number,
  ladderKey7: number,
  ladderKey14_21: number,
  repriceMode: ShadowRepriceMode,
): PresetPassResult {
  let sharpActualPnl = 0;
  let sharpShadowPnl = 0;
  let retailActualPnl = 0;
  let retailUnscaledShadowPnl = 0;

  const n = arena.legCount;
  const sportArr = arena.legSportId;
  const subArr = arena.legSubSportId;
  const perArr = arena.legPeriodId;
  const mktArr = arena.legMarketId;
  const buyBits =
    fMarket === MARKET_ID_TOTAL
      ? arena.legAnyBuyBits
      : arena.legPositiveBuyBits;
  const accIdxArr = arena.legAccountIdx;
  const stakeArr = arena.legStakeUsd;
  const priceArr = arena.legPriceTaken;
  const bucketArr = arena.legKeyBucket;
  const outArr = arena.legOutcome;

  for (let i = 0; i < n; i++) {
    if (((buyBits[i >>> 5] ?? 0) & (1 << (i & 31))) === 0) continue;
    if (fSport !== -1 && sportArr[i] !== fSport) continue;
    if (fSubSport !== -1 && subArr[i] !== fSubSport) continue;
    if (fPeriod !== -1 && perArr[i] !== fPeriod) continue;
    if (fMarket !== -1 && mktArr[i] !== fMarket) continue;

    const outcome = outArr[i]!;
    if (outcome !== OUTCOME_LOST && outcome !== OUTCOME_WON) continue;

    const stake = stakeArr[i]!;
    const price = priceArr[i]!;
    const bucket = bucketArr[i]!;
    const shadowOdds = resolveShadowOdds(
      price,
      bucket,
      ladderKey3,
      ladderKey7,
      ladderKey14_21,
      repriceMode,
    );

    const actualPnl =
      outcome === OUTCOME_LOST ? stake : -stake * toWinMultiplier(price);
    const shadowPnl =
      outcome === OUTCOME_LOST ? stake : -stake * toWinMultiplier(shadowOdds);

    const accIdx = accIdxArr[i]!;
    const isSharp =
      ((sharpBits[accIdx >>> 5] ?? 0) & (1 << (accIdx & 31))) !== 0;
    if (isSharp) {
      sharpActualPnl += actualPnl;
      sharpShadowPnl += shadowPnl;
    } else {
      retailActualPnl += actualPnl;
      retailUnscaledShadowPnl += shadowPnl;
    }
  }

  return {
    sharpActualPnl,
    sharpShadowPnl,
    retailActualPnl,
    retailUnscaledShadowPnl,
  };
}

function buildRollupRow(params: {
  readonly dimension: "sport" | "subSport" | "period" | "market";
  readonly code: string;
  readonly label: string;
  readonly parentCode?: string | undefined;
  readonly portalPeriodNumber?: number | undefined;
  readonly sportId: number;
  readonly subSportId: number;
  readonly periodId: number;
  readonly marketId: number;
  readonly totalLegs: number;
  readonly settledLegs: number;
  readonly decidedLegs: number;
  readonly wins: number;
  readonly handleUsd: number;
  readonly buyLegs: number;
  readonly buyHandleUsd: number;
  readonly actualPnl: number;
  readonly shadowPnl: number;
}): TaxonomyRollupRow {
  const settledHandleApprox = params.handleUsd;
  const holdPct =
    settledHandleApprox > 0 && params.settledLegs > 0
      ? Number(((params.actualPnl / settledHandleApprox) * 100).toFixed(2))
      : 0;
  const winRatePct =
    params.decidedLegs > 0
      ? Number(((params.wins / params.decidedLegs) * 100).toFixed(1))
      : 0;
  const buyRatePct =
    params.totalLegs > 0
      ? Number(((params.buyLegs / params.totalLegs) * 100).toFixed(1))
      : 0;

  const policy = resolveSlicePolicyAndRisk(
    params.sportId,
    params.subSportId,
    params.periodId,
    params.marketId,
    holdPct,
    params.buyLegs,
  );

  const row: TaxonomyRollupRow = {
    dimension: params.dimension,
    code: params.code,
    label: params.label,
    ...(params.parentCode !== undefined
      ? { parentCode: params.parentCode }
      : {}),
    ...(params.portalPeriodNumber !== undefined
      ? { portalPeriodNumber: params.portalPeriodNumber }
      : {}),
    totalLegs: params.totalLegs,
    settledLegs: params.settledLegs,
    decidedLegs: params.decidedLegs,
    winRatePct,
    handleUsd: Math.round(params.handleUsd),
    buyLegs: params.buyLegs,
    buyRatePct,
    buyHandleUsd: Math.round(params.buyHandleUsd),
    actualDeskPnlUsd: Math.round(params.actualPnl),
    holdPct,
    shadowDeskPnlUsd: Math.round(params.shadowPnl),
    netDeltaUsd: Math.round(params.shadowPnl - params.actualPnl),
    pointBuyPolicy: policy.pointBuyPolicy,
    riskStatus: policy.riskStatus,
    primaryRiskVector: policy.primaryRiskVector,
  };
  return row;
}

export function evaluateArenaShadowPricing(
  arena: ShadowPricingArena,
  query: ShadowDashboardQuery = {},
): ShadowPricingDashboardPayload {
  const t0 = performance.now();

  const defaultMinVolume = Number(Bun.env.SHADOW_PRICE_MIN_VOLUME ?? 15);
  const defaultElasticity = Number(Bun.env.SHADOW_PRICE_ELASTICITY ?? 0.15);

  const ladderKey3 = query.ladderKey3 ?? -140;
  const ladderKey7 = query.ladderKey7 ?? -135;
  const ladderKey14_21 = query.ladderKey14_21 ?? -128;
  const minVolume = Math.max(
    1,
    Math.round(query.minVolume ?? defaultMinVolume),
  );
  const retailElasticity = Math.min(
    1,
    Math.max(0, query.retailElasticity ?? defaultElasticity),
  );
  const repriceMode: ShadowRepriceMode = query.repriceMode ?? "exact";

  // 1. Resolve & validate 4-level hierarchical filter coordinates
  let fSport = sportIndexOf(query.sport);
  let fSubSport = subSportIndexOf(query.subSport);
  let fPeriod = periodIndexOf(query.period);
  const fMarket = marketIndexOf(query.market);
  let periodNormalizedFromInvalid = false;

  if (fSubSport !== -1) {
    const parentSport = SUBSPORT_PARENT_SPORT_ID[fSubSport]!;
    if (fSport !== -1 && fSport !== parentSport) {
      // Sport filter explicitly changed to a different parent -> reset subSport
      fSubSport = -1;
    } else if (fSport === -1) {
      fSport = parentSport;
    }
  }

  if (fPeriod !== -1) {
    if (fSubSport !== -1 && !isPeriodValidForSubSportId(fSubSport, fPeriod)) {
      fPeriod = -1;
      periodNormalizedFromInvalid = true;
    } else if (
      fSubSport === -1 &&
      fSport !== -1 &&
      !isPeriodValidForSportId(fSport, fPeriod)
    ) {
      fPeriod = -1;
      periodNormalizedFromInvalid = true;
    }
  }

  const resolvedSportFilter: SportFilter =
    fSport >= 0 ? SPORT_CODES[fSport]! : "ALL";
  const resolvedSubSportFilter: SubSportFilter =
    fSubSport >= 0 ? SUBSPORT_CODES[fSubSport]! : "ALL";
  const resolvedPeriodFilter: PeriodFilter =
    fPeriod >= 0 ? PERIOD_CODES[fPeriod]! : "ALL";
  const resolvedMarketFilter: MarketFilter =
    fMarket >= 0 ? MARKET_CODES[fMarket]! : "ALL";

  const n = arena.legCount;
  const accountCount = arena.accountCount;
  const sportArr = arena.legSportId;
  const subArr = arena.legSubSportId;
  const perArr = arena.legPeriodId;
  const mktArr = arena.legMarketId;
  const accIdxArr = arena.legAccountIdx;
  const stakeArr = arena.legStakeUsd;
  const priceArr = arena.legPriceTaken;
  const bucketArr = arena.legKeyBucket;
  const outArr = arena.legOutcome;
  const posBuyBits = arena.legPositiveBuyBits;
  const anyBuyBits = arena.legAnyBuyBits;
  const simBuyBits = fMarket === MARKET_ID_TOTAL ? anyBuyBits : posBuyBits;

  // 2. Pass 1: Compute per-account buy volume & Key 3/7 rate within active slice -> sharpBits
  const sliceAccTotalBuyLegs = new Int32Array(accountCount);
  const sliceAccKey3or7Legs = new Int32Array(accountCount);

  for (let i = 0; i < n; i++) {
    if (((simBuyBits[i >>> 5] ?? 0) & (1 << (i & 31))) === 0) continue;
    if (fSport !== -1 && sportArr[i] !== fSport) continue;
    if (fSubSport !== -1 && subArr[i] !== fSubSport) continue;
    if (fPeriod !== -1 && perArr[i] !== fPeriod) continue;
    if (fMarket !== -1 && mktArr[i] !== fMarket) continue;

    const accIdx = accIdxArr[i]!;
    sliceAccTotalBuyLegs[accIdx] = (sliceAccTotalBuyLegs[accIdx] ?? 0) + 1;
    const b = bucketArr[i]!;
    if (b === KEY_BUCKET_3 || b === KEY_BUCKET_7) {
      sliceAccKey3or7Legs[accIdx] = (sliceAccKey3or7Legs[accIdx] ?? 0) + 1;
    }
  }

  const sharpBits = new Uint32Array((accountCount + 31) >>> 5);
  let activeBuyAccountCount = 0;
  let sharpBettorCount = 0;

  for (let a = 0; a < accountCount; a++) {
    const total = sliceAccTotalBuyLegs[a]!;
    if (total === 0) continue;
    activeBuyAccountCount++;
    const k37 = sliceAccKey3or7Legs[a]!;
    const keyRate = k37 / total;
    if (total >= minVolume && keyRate >= 0.4) {
      sharpBits[a >>> 5] = (sharpBits[a >>> 5] ?? 0) | (1 << (a & 31));
      sharpBettorCount++;
    }
  }

  // 3. Pass 2: Unified Single-Pass Cube Accumulators + Active Slice Point-Buy Simulation!
  // Fixed-capacity TypedArray accumulators for Sport(7), SubSport(18), Period(15), Market(6)
  const spLegs = new Int32Array(SPORT_COUNT);
  const spSettled = new Int32Array(SPORT_COUNT);
  const spDecided = new Int32Array(SPORT_COUNT);
  const spWins = new Int32Array(SPORT_COUNT);
  const spHandle = new Float64Array(SPORT_COUNT);
  const spBuyLegs = new Int32Array(SPORT_COUNT);
  const spBuyHandle = new Float64Array(SPORT_COUNT);
  const spActualPnl = new Float64Array(SPORT_COUNT);
  const spShadowPnl = new Float64Array(SPORT_COUNT);

  const subLegs = new Int32Array(SUBSPORT_COUNT);
  const subSettled = new Int32Array(SUBSPORT_COUNT);
  const subDecided = new Int32Array(SUBSPORT_COUNT);
  const subWins = new Int32Array(SUBSPORT_COUNT);
  const subHandle = new Float64Array(SUBSPORT_COUNT);
  const subBuyLegs = new Int32Array(SUBSPORT_COUNT);
  const subBuyHandle = new Float64Array(SUBSPORT_COUNT);
  const subActualPnl = new Float64Array(SUBSPORT_COUNT);
  const subShadowPnl = new Float64Array(SUBSPORT_COUNT);

  const perLegs = new Int32Array(PERIOD_COUNT);
  const perSettled = new Int32Array(PERIOD_COUNT);
  const perDecided = new Int32Array(PERIOD_COUNT);
  const perWins = new Int32Array(PERIOD_COUNT);
  const perHandle = new Float64Array(PERIOD_COUNT);
  const perBuyLegs = new Int32Array(PERIOD_COUNT);
  const perBuyHandle = new Float64Array(PERIOD_COUNT);
  const perActualPnl = new Float64Array(PERIOD_COUNT);
  const perShadowPnl = new Float64Array(PERIOD_COUNT);

  const mktLegs = new Int32Array(MARKET_COUNT);
  const mktSettled = new Int32Array(MARKET_COUNT);
  const mktDecided = new Int32Array(MARKET_COUNT);
  const mktWins = new Int32Array(MARKET_COUNT);
  const mktHandle = new Float64Array(MARKET_COUNT);
  const mktBuyLegs = new Int32Array(MARKET_COUNT);
  const mktBuyHandle = new Float64Array(MARKET_COUNT);
  const mktActualPnl = new Float64Array(MARKET_COUNT);
  const mktShadowPnl = new Float64Array(MARKET_COUNT);

  // Active Slice ALL-leg totals (includes non-buy legs!)
  let sliceTotalLegs = 0;
  let sliceSettledLegs = 0;
  let sliceDecidedLegs = 0;
  let sliceWins = 0;
  let sliceHandleUsd = 0;
  let sliceBuyLegs = 0;
  let sliceBuyHandleUsd = 0;
  let sliceActualDeskPnl = 0;

  // Point-Buy Simulator accumulators (strictly buy legs in active slice)
  const sharpAccLegs = new Int32Array(accountCount);
  const sharpAccStake = new Float64Array(accountCount);
  const sharpAccActualPnl = new Float64Array(accountCount);
  const sharpAccShadowPnl = new Float64Array(accountCount);

  const bucketLegs = new Int32Array(KEY_BUCKET_COUNT);
  const bucketSettled = new Int32Array(KEY_BUCKET_COUNT);
  const bucketWins = new Int32Array(KEY_BUCKET_COUNT);
  const bucketDecided = new Int32Array(KEY_BUCKET_COUNT);
  const bucketStake = new Float64Array(KEY_BUCKET_COUNT);
  const bucketActualPnl = new Float64Array(KEY_BUCKET_COUNT);
  const bucketShadowPnl = new Float64Array(KEY_BUCKET_COUNT);

  let simAnalyzedLegs = 0;
  let simSettledLegs = 0;
  let simStakedUsd = 0;
  let simActualDeskPnlUsd = 0;

  let sharpLegs = 0;
  let sharpStaked = 0;
  let sharpActualPnl = 0;
  let sharpShadowPnl = 0;

  let retailLegs = 0;
  let retailStaked = 0;
  let retailActualPnl = 0;
  let retailUnscaledShadowPnl = 0;

  // Derived SLICE_REGISTRY TypedArray accumulators (count derived from SLICE_REGISTRY, never hardcoded)
  const sliceRegCount = DERIVED_ARENA_SLICES.count;
  const regSportIds = DERIVED_ARENA_SLICES.sportIds;
  const regSubIds = DERIVED_ARENA_SLICES.subSportIds;
  const regPerIds = DERIVED_ARENA_SLICES.periodIds;
  const regMktIds = DERIVED_ARENA_SLICES.marketIds;
  const csLegs = new Int32Array(sliceRegCount);
  const csSettled = new Int32Array(sliceRegCount);
  const csBuyLegs = new Int32Array(sliceRegCount);
  const csHandle = new Float64Array(sliceRegCount);
  const csActualPnl = new Float64Array(sliceRegCount);
  const csOverroundStakeSum = new Float64Array(sliceRegCount);

  const sliceHasKeyLadderSurface =
    (fSport === -1 || fSport === SPORT_ID_FOOTBALL) &&
    (fPeriod === -1 || fPeriod === PERIOD_ID_GAME) &&
    (fMarket === -1 || fMarket === MARKET_ID_SPREAD);
  const effectiveElasticity = sliceHasKeyLadderSurface ? retailElasticity : 0;
  const retainedFactor = 1 - effectiveElasticity;

  for (let i = 0; i < n; i++) {
    const sp = sportArr[i]!;
    const sub = subArr[i]!;
    const per = perArr[i]!;
    const mkt = mktArr[i]!;
    const stake = stakeArr[i]!;
    const price = priceArr[i]!;
    const bucket = bucketArr[i]!;
    const outcome = outArr[i]!;
    const hasAnyBuy = ((anyBuyBits[i >>> 5] ?? 0) & (1 << (i & 31))) !== 0;
    const isSimBuy = ((simBuyBits[i >>> 5] ?? 0) & (1 << (i & 31))) !== 0;

    let actualPnl = 0;
    let rawShadowPnl = 0;
    let isSettled = 0;
    let isDecided = 0;
    let isWin = 0;

    const shadowOdds = isSimBuy
      ? resolveShadowOdds(
          price,
          bucket,
          ladderKey3,
          ladderKey7,
          ladderKey14_21,
          repriceMode,
        )
      : price;

    if (outcome === OUTCOME_LOST) {
      actualPnl = stake;
      rawShadowPnl = stake;
      isSettled = 1;
      isDecided = 1;
    } else if (outcome === OUTCOME_WON) {
      actualPnl = -stake * toWinMultiplier(price);
      rawShadowPnl = -stake * toWinMultiplier(shadowOdds);
      isSettled = 1;
      isDecided = 1;
      isWin = 1;
    } else if (outcome === OUTCOME_PUSH) {
      isSettled = 1;
    }

    const matchSport = fSport === -1 || sp === fSport;
    const matchSub = fSubSport === -1 || sub === fSubSport;
    const matchPeriod = fPeriod === -1 || per === fPeriod;
    const matchMarket = fMarket === -1 || mkt === fMarket;

    // Cube Level 1: Sport rollup (filtered by market if selected)
    if (matchMarket) {
      spLegs[sp] = (spLegs[sp] ?? 0) + 1;
      spSettled[sp] = (spSettled[sp] ?? 0) + isSettled;
      spDecided[sp] = (spDecided[sp] ?? 0) + isDecided;
      spWins[sp] = (spWins[sp] ?? 0) + isWin;
      spHandle[sp] = (spHandle[sp] ?? 0) + stake;
      spActualPnl[sp] = (spActualPnl[sp] ?? 0) + actualPnl;
      spShadowPnl[sp] = (spShadowPnl[sp] ?? 0) + rawShadowPnl;
      if (hasAnyBuy) {
        spBuyLegs[sp] = (spBuyLegs[sp] ?? 0) + 1;
        spBuyHandle[sp] = (spBuyHandle[sp] ?? 0) + stake;
      }
    }

    // Cube Level 2: SubSport rollup (scoped to selected Sport + Market)
    if (matchSport && matchMarket) {
      subLegs[sub] = (subLegs[sub] ?? 0) + 1;
      subSettled[sub] = (subSettled[sub] ?? 0) + isSettled;
      subDecided[sub] = (subDecided[sub] ?? 0) + isDecided;
      subWins[sub] = (subWins[sub] ?? 0) + isWin;
      subHandle[sub] = (subHandle[sub] ?? 0) + stake;
      subActualPnl[sub] = (subActualPnl[sub] ?? 0) + actualPnl;
      subShadowPnl[sub] = (subShadowPnl[sub] ?? 0) + rawShadowPnl;
      if (hasAnyBuy) {
        subBuyLegs[sub] = (subBuyLegs[sub] ?? 0) + 1;
        subBuyHandle[sub] = (subBuyHandle[sub] ?? 0) + stake;
      }
    }

    // Cube Level 3: Period per SubSport rollup (scoped to Sport + SubSport + Market)
    if (matchSport && matchSub && matchMarket) {
      perLegs[per] = (perLegs[per] ?? 0) + 1;
      perSettled[per] = (perSettled[per] ?? 0) + isSettled;
      perDecided[per] = (perDecided[per] ?? 0) + isDecided;
      perWins[per] = (perWins[per] ?? 0) + isWin;
      perHandle[per] = (perHandle[per] ?? 0) + stake;
      perActualPnl[per] = (perActualPnl[per] ?? 0) + actualPnl;
      perShadowPnl[per] = (perShadowPnl[per] ?? 0) + rawShadowPnl;
      if (hasAnyBuy) {
        perBuyLegs[per] = (perBuyLegs[per] ?? 0) + 1;
        perBuyHandle[per] = (perBuyHandle[per] ?? 0) + stake;
      }
    }

    // Cube Level 4: Market rollup (scoped to Sport + SubSport + Period)
    if (matchSport && matchSub && matchPeriod) {
      mktLegs[mkt] = (mktLegs[mkt] ?? 0) + 1;
      mktSettled[mkt] = (mktSettled[mkt] ?? 0) + isSettled;
      mktDecided[mkt] = (mktDecided[mkt] ?? 0) + isDecided;
      mktWins[mkt] = (mktWins[mkt] ?? 0) + isWin;
      mktHandle[mkt] = (mktHandle[mkt] ?? 0) + stake;
      mktActualPnl[mkt] = (mktActualPnl[mkt] ?? 0) + actualPnl;
      mktShadowPnl[mkt] = (mktShadowPnl[mkt] ?? 0) + rawShadowPnl;
      if (hasAnyBuy) {
        mktBuyLegs[mkt] = (mktBuyLegs[mkt] ?? 0) + 1;
        mktBuyHandle[mkt] = (mktBuyHandle[mkt] ?? 0) + stake;
      }
    }

    // Active Slice intersection (all 4 dimensions matched)
    if (matchSport && matchSub && matchPeriod && matchMarket) {
      sliceTotalLegs++;
      sliceSettledLegs += isSettled;
      sliceDecidedLegs += isDecided;
      sliceWins += isWin;
      sliceHandleUsd += stake;
      sliceActualDeskPnl += actualPnl;
      if (hasAnyBuy) {
        sliceBuyLegs++;
        sliceBuyHandleUsd += stake;
      }

      // Point-Buy Cohort Simulator (strictly buy legs in active slice)
      if (isSimBuy) {
        const accIdx = accIdxArr[i]!;
        const isSharp =
          ((sharpBits[accIdx >>> 5] ?? 0) & (1 << (accIdx & 31))) !== 0;
        const effectiveLegShadowPnl = isSharp
          ? rawShadowPnl
          : rawShadowPnl * retainedFactor;

        simAnalyzedLegs++;
        simSettledLegs += isSettled;
        simStakedUsd += stake;
        simActualDeskPnlUsd += actualPnl;

        bucketLegs[bucket] = (bucketLegs[bucket] ?? 0) + 1;
        bucketSettled[bucket] = (bucketSettled[bucket] ?? 0) + isSettled;
        bucketDecided[bucket] = (bucketDecided[bucket] ?? 0) + isDecided;
        bucketWins[bucket] = (bucketWins[bucket] ?? 0) + isWin;
        bucketStake[bucket] = (bucketStake[bucket] ?? 0) + stake;
        bucketActualPnl[bucket] = (bucketActualPnl[bucket] ?? 0) + actualPnl;
        bucketShadowPnl[bucket] =
          (bucketShadowPnl[bucket] ?? 0) + effectiveLegShadowPnl;

        if (isSharp) {
          sharpLegs++;
          sharpStaked += stake;
          sharpActualPnl += actualPnl;
          sharpShadowPnl += rawShadowPnl;

          sharpAccLegs[accIdx] = (sharpAccLegs[accIdx] ?? 0) + 1;
          sharpAccStake[accIdx] = (sharpAccStake[accIdx] ?? 0) + stake;
          sharpAccActualPnl[accIdx] =
            (sharpAccActualPnl[accIdx] ?? 0) + actualPnl;
          sharpAccShadowPnl[accIdx] =
            (sharpAccShadowPnl[accIdx] ?? 0) + rawShadowPnl;
        } else {
          retailLegs++;
          retailStaked += stake;
          retailActualPnl += actualPnl;
          retailUnscaledShadowPnl += rawShadowPnl;
        }
      }
    }

    // Derived SLICE_REGISTRY rollup (matches against compiled AoS selector coordinates)
    for (let sIdx = 0; sIdx < sliceRegCount; sIdx++) {
      const reqSp = regSportIds[sIdx]!;
      if (reqSp !== -1 && sp !== reqSp) continue;
      const reqSub = regSubIds[sIdx]!;
      if (reqSub !== -1 && sub !== reqSub) continue;
      const reqPer = regPerIds[sIdx]!;
      if (reqPer !== -1 && per !== reqPer) continue;
      const reqMkt = regMktIds[sIdx]!;
      if (reqMkt !== -1 && mkt !== reqMkt) continue;

      csLegs[sIdx] = (csLegs[sIdx] ?? 0) + 1;
      csSettled[sIdx] = (csSettled[sIdx] ?? 0) + isSettled;
      csHandle[sIdx] = (csHandle[sIdx] ?? 0) + stake;
      csActualPnl[sIdx] = (csActualPnl[sIdx] ?? 0) + actualPnl;
      csOverroundStakeSum[sIdx] =
        (csOverroundStakeSum[sIdx] ?? 0) +
        stake * twoWayBalancedOverroundPctFromAmerican(price);
      if (hasAnyBuy) {
        csBuyLegs[sIdx] = (csBuyLegs[sIdx] ?? 0) + 1;
      }
      break;
    }
  }

  // 4. Materialize Taxonomy Rollup Arrays
  const bySport: TaxonomyRollupRow[] = [];
  for (let s = 0; s < SPORT_COUNT; s++) {
    bySport.push(
      buildRollupRow({
        dimension: "sport",
        code: SPORT_CODES[s]!,
        label: SPORT_LABELS[s]!,
        sportId: s,
        subSportId: -1,
        periodId: -1,
        marketId: fMarket,
        totalLegs: spLegs[s]!,
        settledLegs: spSettled[s]!,
        decidedLegs: spDecided[s]!,
        wins: spWins[s]!,
        handleUsd: spHandle[s]!,
        buyLegs: spBuyLegs[s]!,
        buyHandleUsd: spBuyHandle[s]!,
        actualPnl: spActualPnl[s]!,
        shadowPnl: spShadowPnl[s]!,
      }),
    );
  }

  const bySubSport: TaxonomyRollupRow[] = [];
  for (let sub = 0; sub < SUBSPORT_COUNT; sub++) {
    const parentSp = SUBSPORT_PARENT_SPORT_ID[sub]!;
    if (fSport !== -1 && parentSp !== fSport) continue;
    const spec = SUBSPORT_TAXONOMY_CATALOG[sub]!;
    bySubSport.push(
      buildRollupRow({
        dimension: "subSport",
        code: spec.code,
        label: spec.label,
        parentCode: spec.sport,
        sportId: parentSp,
        subSportId: sub,
        periodId: -1,
        marketId: fMarket,
        totalLegs: subLegs[sub]!,
        settledLegs: subSettled[sub]!,
        decidedLegs: subDecided[sub]!,
        wins: subWins[sub]!,
        handleUsd: subHandle[sub]!,
        buyLegs: subBuyLegs[sub]!,
        buyHandleUsd: subBuyHandle[sub]!,
        actualPnl: subActualPnl[sub]!,
        shadowPnl: subShadowPnl[sub]!,
      }),
    );
  }

  const validPeriodsForSelection = getValidPeriodsForSelection(
    fSport,
    fSubSport,
  );
  const byPeriod: TaxonomyRollupRow[] = [];
  for (let pi = 0; pi < validPeriodsForSelection.length; pi++) {
    const vp = validPeriodsForSelection[pi]!;
    const pid = periodIndexOf(vp.code);
    if (pid < 0) continue;
    byPeriod.push(
      buildRollupRow({
        dimension: "period",
        code: vp.code,
        label: vp.label,
        portalPeriodNumber:
          vp.portalPeriodNumber ?? PERIOD_PORTAL_NUMBERS[pid] ?? 0,
        sportId: fSport,
        subSportId: fSubSport,
        periodId: pid,
        marketId: fMarket,
        totalLegs: perLegs[pid]!,
        settledLegs: perSettled[pid]!,
        decidedLegs: perDecided[pid]!,
        wins: perWins[pid]!,
        handleUsd: perHandle[pid]!,
        buyLegs: perBuyLegs[pid]!,
        buyHandleUsd: perBuyHandle[pid]!,
        actualPnl: perActualPnl[pid]!,
        shadowPnl: perShadowPnl[pid]!,
      }),
    );
  }

  const byMarket: TaxonomyRollupRow[] = [];
  for (let m = 0; m < MARKET_COUNT; m++) {
    byMarket.push(
      buildRollupRow({
        dimension: "market",
        code: MARKET_CODES[m]!,
        label: MARKET_LABELS[m]!,
        sportId: fSport,
        subSportId: fSubSport,
        periodId: fPeriod,
        marketId: m,
        totalLegs: mktLegs[m]!,
        settledLegs: mktSettled[m]!,
        decidedLegs: mktDecided[m]!,
        wins: mktWins[m]!,
        handleUsd: mktHandle[m]!,
        buyLegs: mktBuyLegs[m]!,
        buyHandleUsd: mktBuyHandle[m]!,
        actualPnl: mktActualPnl[m]!,
        shadowPnl: mktShadowPnl[m]!,
      }),
    );
  }

  const sliceHoldPct =
    sliceHandleUsd > 0 && sliceSettledLegs > 0
      ? Number(((sliceActualDeskPnl / sliceHandleUsd) * 100).toFixed(2))
      : 0;
  const sliceWinRatePct =
    sliceDecidedLegs > 0
      ? Number(((sliceWins / sliceDecidedLegs) * 100).toFixed(1))
      : 0;
  const sliceBuyRatePct =
    sliceTotalLegs > 0
      ? Number(((sliceBuyLegs / sliceTotalLegs) * 100).toFixed(1))
      : 0;

  const activePolicy = resolveSlicePolicyAndRisk(
    fSport,
    fSubSport,
    fPeriod,
    fMarket,
    sliceHoldPct,
    sliceBuyLegs,
  );

  const crumbSport = fSport >= 0 ? SPORT_CODES[fSport]! : "All Sports";
  const crumbSub =
    fSubSport >= 0
      ? SUBSPORT_TAXONOMY_CATALOG[fSubSport]!.shortLabel
      : "All Sub-Sports";
  let crumbPeriod = "All Valid Periods";
  if (fPeriod >= 0) {
    let customLabel: string | undefined;
    for (let k = 0; k < validPeriodsForSelection.length; k++) {
      if (validPeriodsForSelection[k]!.code === resolvedPeriodFilter) {
        customLabel = validPeriodsForSelection[k]!.label;
        break;
      }
    }
    crumbPeriod = customLabel ?? PERIOD_DEFAULT_LABELS[fPeriod]!;
  }
  const crumbMarket = fMarket >= 0 ? MARKET_LABELS[fMarket]! : "All Markets";

  const taxonomy: TaxonomyCubeSummary = {
    activeFilters: {
      sport: resolvedSportFilter,
      subSport: resolvedSubSportFilter,
      period: resolvedPeriodFilter,
      market: resolvedMarketFilter,
      periodNormalizedFromInvalid,
    },
    activeSlice: {
      breadcrumb: `${crumbSport} ▸ ${crumbSub} ▸ ${crumbPeriod} ▸ ${crumbMarket}`,
      totalLegs: sliceTotalLegs,
      settledLegs: sliceSettledLegs,
      winRatePct: sliceWinRatePct,
      handleUsd: Math.round(sliceHandleUsd),
      actualDeskPnlUsd: Math.round(sliceActualDeskPnl),
      holdPct: sliceHoldPct,
      buyLegs: sliceBuyLegs,
      buyRatePct: sliceBuyRatePct,
      buyHandleUsd: Math.round(sliceBuyHandleUsd),
      pointBuyPolicy: activePolicy.pointBuyPolicy,
      riskStatus: activePolicy.riskStatus,
      primaryRiskVector: activePolicy.primaryRiskVector,
      validPeriodsForSelection,
    },
    catalog: SUBSPORT_TAXONOMY_CATALOG,
    bySport,
    bySubSport,
    byPeriod,
    byMarket,
  };

  // 5. Point-Buy Cohort Simulation Results
  const retailShadowPnl = retailUnscaledShadowPnl * retainedFactor;

  const sharpRows: {
    readonly account: string;
    readonly legs: number;
    readonly stakedUsd: number;
    readonly keyRatePct: string;
    readonly actualDeskPnlUsd: number;
    readonly shadowDeskPnlUsd: number;
    readonly netDeskImprovementUsd: number;
  }[] = [];

  for (let a = 0; a < accountCount; a++) {
    const legsForAcc = sharpAccLegs[a]!;
    if (legsForAcc === 0) continue;
    const totalAccLegs = sliceAccTotalBuyLegs[a]!;
    const k37 = sliceAccKey3or7Legs[a]!;
    const keyRate = totalAccLegs > 0 ? (k37 / totalAccLegs) * 100 : 0;
    const actualAcc = sharpAccActualPnl[a]!;
    const shadowAcc = sharpAccShadowPnl[a]!;
    sharpRows.push({
      account: arena.accountNames[a]!,
      legs: legsForAcc,
      stakedUsd: Math.round(sharpAccStake[a]!),
      keyRatePct: `${keyRate.toFixed(1)}%`,
      actualDeskPnlUsd: Math.round(actualAcc),
      shadowDeskPnlUsd: Math.round(shadowAcc),
      netDeskImprovementUsd: Math.round(shadowAcc - actualAcc),
    });
  }

  sharpRows.sort((a, b) => b.stakedUsd - a.stakedUsd);
  const topSharpBuyers = sharpRows.slice(0, 15);

  const simulation: ShadowSimulationResult = {
    summary: {
      totalAnalyzedLegs: simAnalyzedLegs,
      totalSettledLegs: simSettledLegs,
      totalStakedUsd: Math.round(simStakedUsd),
      actualDeskPnlUsd: Math.round(simActualDeskPnlUsd),
      shadowDeskPnlUsd: Math.round(sharpShadowPnl + retailShadowPnl),
      netDeskSavingsUsd: Math.round(
        sharpShadowPnl + retailShadowPnl - simActualDeskPnlUsd,
      ),
    },
    sharpCohort: {
      bettorCount: sharpBettorCount,
      legCount: sharpLegs,
      stakedUsd: Math.round(sharpStaked),
      actualDeskPnlUsd: Math.round(sharpActualPnl),
      shadowDeskPnlUsd: Math.round(sharpShadowPnl),
      sharpSavingsUsd: Math.round(sharpShadowPnl - sharpActualPnl),
    },
    retailCohort: {
      bettorCount: Math.max(0, activeBuyAccountCount - sharpBettorCount),
      legCount: retailLegs,
      stakedUsd: Math.round(retailStaked),
      actualDeskPnlUsd: Math.round(retailActualPnl),
      shadowDeskPnlUsd: Math.round(retailShadowPnl),
      retailNetImpactUsd: Math.round(retailShadowPnl - retailActualPnl),
      elasticityAssumed: retailElasticity,
    },
    topSharpBuyers,
  };

  const bucketOrder = [
    KEY_BUCKET_3,
    KEY_BUCKET_7,
    KEY_BUCKET_10,
    KEY_BUCKET_14,
    KEY_BUCKET_21,
    KEY_BUCKET_NON_KEY,
  ];
  const keyBreakdown: KeyNumberBucketRow[] = [];
  for (let bi = 0; bi < bucketOrder.length; bi++) {
    const b = bucketOrder[bi]!;
    const decided = bucketDecided[b]!;
    const wins = bucketWins[b]!;
    const configuredOdds =
      b === KEY_BUCKET_3
        ? ladderKey3
        : b === KEY_BUCKET_7
          ? ladderKey7
          : b === KEY_BUCKET_NON_KEY
            ? null
            : ladderKey14_21;
    const actB = bucketActualPnl[b]!;
    const shdB = bucketShadowPnl[b]!;
    keyBreakdown.push({
      keyNumber: KEY_NUMBERS_BY_BUCKET[b] ?? null,
      keyLabel: KEY_LABELS_BY_BUCKET[b]!,
      fairBreakevenOdds: FAIR_BREAKEVEN_BY_BUCKET[b]!,
      configuredShadowOdds: configuredOdds,
      legs: bucketLegs[b]!,
      settledLegs: bucketSettled[b]!,
      winRatePct: decided > 0 ? Number(((wins / decided) * 100).toFixed(1)) : 0,
      stakedUsd: Math.round(bucketStake[b]!),
      actualDeskPnlUsd: Math.round(actB),
      shadowDeskPnlUsd: Math.round(shdB),
      netDeltaUsd: Math.round(shdB - actB),
    });
  }

  const sharpDeltaExact = sharpShadowPnl - sharpActualPnl;
  const elasticityFrontier: ElasticityFrontierPoint[] = [];
  for (let ei = 0; ei < ELASTICITY_STEPS.length; ei++) {
    const e = ELASTICITY_STEPS[ei]!;
    const effE = sliceHasKeyLadderSurface ? e : 0;
    const scaledRetailShadow = retailUnscaledShadowPnl * (1 - effE);
    const retailDelta = scaledRetailShadow - retailActualPnl;
    const totalShadow = sharpShadowPnl + scaledRetailShadow;
    elasticityFrontier.push({
      elasticity: e,
      elasticityPct: Math.round(e * 100),
      sharpSavingsUsd: Math.round(sharpDeltaExact),
      retailNetImpactUsd: Math.round(retailDelta),
      netDeskSavingsUsd: Math.round(totalShadow - simActualDeskPnlUsd),
      shadowDeskPnlUsd: Math.round(totalShadow),
    });
  }

  let breakevenElasticityPct: number | null = null;
  if (sliceHasKeyLadderSurface && Math.abs(retailUnscaledShadowPnl) > 1e-6) {
    const eStar =
      1 - (simActualDeskPnlUsd - sharpShadowPnl) / retailUnscaledShadowPnl;
    if (eStar >= 0 && eStar <= 1) {
      breakevenElasticityPct = Number((eStar * 100).toFixed(1));
    }
  }

  const presetComparison: LadderPresetSummary[] = [];
  for (let pi = 0; pi < SHADOW_LADDER_PRESETS.length; pi++) {
    const preset = SHADOW_LADDER_PRESETS[pi]!;
    const pass = runSlicePresetPass(
      arena,
      fSport,
      fSubSport,
      fPeriod,
      fMarket,
      sharpBits,
      preset.ladderKey3,
      preset.ladderKey7,
      preset.ladderKey14_21,
      repriceMode,
    );
    const retScaled = pass.retailUnscaledShadowPnl * retainedFactor;
    presetComparison.push({
      id: preset.id,
      label: preset.label,
      subtitle: preset.subtitle,
      ladderKey3: preset.ladderKey3,
      ladderKey7: preset.ladderKey7,
      ladderKey14_21: preset.ladderKey14_21,
      sharpSavingsUsd: Math.round(pass.sharpShadowPnl - pass.sharpActualPnl),
      retailNetImpactUsd: Math.round(retScaled - pass.retailActualPnl),
      netDeskSavingsUsd: Math.round(
        pass.sharpShadowPnl + retScaled - simActualDeskPnlUsd,
      ),
    });
  }

  // 6. Domain-Specific Policy Directive per (Sport, SubSport, Period, Market)
  const netDelta = simulation.summary.netDeskSavingsUsd;
  const sharpDelta = simulation.sharpCohort.sharpSavingsUsd;
  const retailDelta = simulation.retailCohort.retailNetImpactUsd;
  const fmtSigned = (v: number): string => {
    const abs = Math.abs(Math.round(v)).toLocaleString();
    if (v > 0) return `+$${abs}`;
    if (v < 0) return `-$${abs}`;
    return "$0";
  };

  let policyRecommendation: PolicyRecommendation;
  if (activePolicy.pointBuyPolicy === "STRICTLY_BLOCKED") {
    policyRecommendation = {
      directive: "DERIVATIVE_AND_LIVE_LOCKOUT",
      headline: `Point-Buy Catalog Locked Out (${crumbSub} · ${crumbPeriod} · ${crumbMarket})`,
      rationale: `Point buying is strictly disabled by catalog on this slice (${sliceTotalLegs.toLocaleString()} legs, $${Math.round(sliceHandleUsd).toLocaleString()} handle, ${fmtSigned(sliceActualDeskPnl)} actual P&L / ${sliceHoldPct}% hold). Primary desk focus: ${activePolicy.primaryRiskVector}.`,
      recommendedMaxKeyRiskUsd: 0,
    };
  } else if (activePolicy.pointBuyPolicy === "HOUSE_HOLD_ADVANTAGE") {
    policyRecommendation = {
      directive: "PRESERVE_BELL_CURVE_VIG",
      headline:
        "Preserve Retail Point-Buy Menu · House Extracts Positive Vig Advantage",
      rationale: `In ${crumbSport} (${crumbSub}), continuous scoring margins make 0.5pt worth ~3.2¢ (-117 fair) while retail pays 10¢ (-120) to 40¢ (-150). Slice shows ${sliceBuyLegs.toLocaleString()} buy legs ($${Math.round(sliceBuyHandleUsd).toLocaleString()} handle) with ${fmtSigned(simActualDeskPnlUsd)} actual buy-leg P&L. Keep menu open to recreational flow.`,
      recommendedMaxKeyRiskUsd: 5000,
    };
  } else if (netDelta <= 0) {
    policyRecommendation = {
      directive: "TARGETED_LIMITS_AND_ALERTS",
      headline:
        "Preserve Retail Catalog · Enforce Per-Account Key-Number Caps ($2,500)",
      rationale: `At ${(retailElasticity * 100).toFixed(0)}% retail elasticity, global repricing yields ${fmtSigned(netDelta)} net desk delta (retail impact ${fmtSigned(retailDelta)} vs sharp delta ${fmtSigned(sharpDelta)}). Route flagged accounts to real-time alerts and $2,500 key-buy stake caps.`,
      recommendedMaxKeyRiskUsd: 2500,
    };
  } else if (repriceMode === "floor" || retailDelta < 0) {
    policyRecommendation = {
      directive: "SELECTIVE_KEY_PRICE_FLOOR",
      headline: "Apply Sharp Tier Price Floor + Syndicate Burst Guard",
      rationale: `Counterfactual yields ${fmtSigned(netDelta)} net improvement (${fmtSigned(sharpDelta)} on sharp cohort), while retail turnover attrition impacts hold by ${fmtSigned(retailDelta)}. Apply key-number price floor selectively to high-key-rate profiles.`,
      recommendedMaxKeyRiskUsd: 2500,
    };
  } else {
    policyRecommendation = {
      directive: "GLOBAL_CATALOG_REPRICE",
      headline: "Positive Counterfactual Hold Across Both Cohorts",
      rationale: `Both sharp (${fmtSigned(sharpDelta)}) and retail (${fmtSigned(retailDelta)}) cohorts improve desk P&L by ${fmtSigned(netDelta)} at ${(retailElasticity * 100).toFixed(0)}% elasticity.`,
      recommendedMaxKeyRiskUsd: 5000,
    };
  }

  // 7. Typed SliceMetrics Ledger, Ex-Blocked / Ex-Directional Blended Hold SLO & Pre/Post-Trade DiffView
  const holdFloorConfig = query.holdFloorConfig ?? DEFAULT_HOLD_FLOOR_CONFIG;
  const routerAuditMode: RouterAuditMode =
    query.routerAuditMode === "enforced_lockout"
      ? "enforced_lockout"
      : "observed_ledger";

  const postBlockAcceptedBySlice: Record<string, number> = {};
  for (let k = 0; k < sliceRegCount; k++) {
    const spec = SLICE_REGISTRY[k]!;
    if (isBlockedSlice(spec.slice_id)) {
      postBlockAcceptedBySlice[spec.slice_id] =
        routerAuditMode === "enforced_lockout" ? 0 : csLegs[k]!;
    } else {
      postBlockAcceptedBySlice[spec.slice_id] = 0;
    }
  }
  const routerQuery = createStaticRouterOrderQuery(postBlockAcceptedBySlice);
  const isSliceBlockEnforced = deriveRouterBlockEnforcedPredicate(
    routerQuery,
    SLICE_REGISTRY,
  );

  const sliceMetricsRows: SliceMetrics[] = [];
  const preTradePolicyPairs: {
    readonly slice_id: string;
    readonly policy: SlicePolicy;
    readonly block_enforced: boolean;
  }[] = [];
  const postTradePolicyPairs: {
    readonly slice_id: string;
    readonly policy: SlicePolicy;
    readonly block_enforced: boolean;
  }[] = [];

  for (let k = 0; k < sliceRegCount; k++) {
    const spec = SLICE_REGISTRY[k]!;
    const legs = csLegs[k]!;
    const settled = csSettled[k]!;
    const handle = Math.round(csHandle[k]!);
    const buySharePct =
      legs > 0 ? Number(((csBuyLegs[k]! / legs) * 100).toFixed(2)) : 0;
    const holdTotalPct =
      csHandle[k]! > 0 && settled > 0
        ? Number(((csActualPnl[k]! / csHandle[k]!) * 100).toFixed(2))
        : 0;
    const balancedOverroundPct =
      csHandle[k]! > 0 ? csOverroundStakeSum[k]! / csHandle[k]! : null;
    const holdFloorPct = resolveHoldFloorPct(holdFloorConfig, {
      slice_id: spec.slice_id,
      sport: spec.sport,
      market: spec.market,
    });
    const blockEnforced = isSliceBlockEnforced(spec.slice_id);

    sliceMetricsRows.push(
      deriveSliceMetrics({
        slice_id: spec.slice_id,
        sport: spec.sport,
        league: spec.league,
        period: spec.period,
        market: spec.market,
        legs,
        buy_share_pct: buySharePct,
        handle_usd: handle,
        hold_total_pct: holdTotalPct,
        hold_floor_pct: holdFloorPct,
        policy: spec.policy,
        policy_mechanism: spec.policy_mechanism,
        policy_qualifier: spec.policy_qualifier,
        block_enforced: blockEnforced,
        balanced_overround_pct: balancedOverroundPct,
      }),
    );

    preTradePolicyPairs.push({
      slice_id: spec.slice_id,
      policy: spec.policy,
      block_enforced: true,
    });
    postTradePolicyPairs.push({
      slice_id: spec.slice_id,
      policy: spec.policy,
      block_enforced: blockEnforced,
    });
  }

  const blendedHoldSlo = computeBlendedHoldSlo(
    sliceMetricsRows,
    holdFloorConfig.slo_blended_hold_floor_pct,
  );
  const policyDiff = diffSlicePolicyPairs(
    preTradePolicyPairs,
    postTradePolicyPairs,
  );

  const evaluatedInMs = Number((performance.now() - t0).toFixed(2));

  return {
    provenance: arena.provenance,
    sourceLabel: arena.sourceLabel,
    loadedInMs: arena.loadedInMs,
    evaluatedInMs,
    parameters: {
      ladderKey3,
      ladderKey7,
      ladderKey14_21,
      minVolume,
      retailElasticity,
      repriceMode,
      sport: resolvedSportFilter,
      subSport: resolvedSubSportFilter,
      period: resolvedPeriodFilter,
      market: resolvedMarketFilter,
    },
    taxonomy,
    simulation,
    keyBreakdown,
    elasticityFrontier,
    breakevenElasticityPct,
    presetComparison,
    policyRecommendation,
    sliceMetrics: {
      routerAuditMode,
      rows: sliceMetricsRows,
      blendedHoldSlo,
      policyDiff,
    },
  };
}

let cachedHoldFloorConfigPromise: Promise<HoldFloorConfig> | null = null;

function getCachedHoldFloorConfig(): Promise<HoldFloorConfig> {
  if (cachedHoldFloorConfigPromise === null) {
    cachedHoldFloorConfigPromise = loadHoldFloorConfig(
      "config/wager_tiers.toml",
    );
  }
  return cachedHoldFloorConfigPromise;
}

export async function runShadowPricingDashboard(
  query: ShadowDashboardQuery = {},
): Promise<ShadowPricingDashboardPayload> {
  const [arena, holdFloorConfig] = await Promise.all([
    loadShadowPricingArena({
      dbPath: query.dbPath,
      forceFixture: query.forceFixture,
    }),
    query.holdFloorConfig !== undefined
      ? Promise.resolve(query.holdFloorConfig)
      : getCachedHoldFloorConfig(),
  ]);
  return evaluateArenaShadowPricing(arena, {
    ...query,
    holdFloorConfig,
  });
}
