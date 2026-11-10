/**
 * @file src/risk/slice_metrics.ts
 * @description Typed SliceMetrics schema, pure column derivations, pure policy/risk
 * gates, and ex-blocked / ex-directional Blended Hold SLO evaluation.
 */

export type SlicePolicy = "BLOCKED" | "LEAK" | "ADVANTAGE" | "PRESERVE";

export type SlicePolicyMechanism =
  "LIVE_LOCKOUT" | "DERIVATIVE" | "VIG" | "BELL_CURVE";

export type SliceFlag =
  | "BUY_SHARE_EXTREME"
  | "POLICY_DATA_CONFLICT"
  | "HOLD_BELOW_FLOOR"
  | "DIRECTIONAL_DOMINANT"
  | "MISSING_VIG_SPLIT";

export interface BalancedBookLegDistribution {
  readonly buy_stake_usd: number;
  readonly sell_stake_usd: number;
  readonly mean_buy_implied_prob: number | null;
  readonly mean_sell_implied_prob: number | null;
}

export interface SliceMetrics {
  readonly slice_id: string;
  readonly sport: string;
  readonly league: string;
  readonly period: string;
  readonly market: string;
  readonly legs: number;
  readonly buy_share_pct: number;
  readonly sell_share_pct: number;
  readonly handle_usd: number;
  readonly net_position_usd: number;
  readonly vig_capture_pct: number | null;
  readonly directional_pnl_usd: number | null;
  readonly hold_total_pct: number;
  readonly gross_hold_usd: number;
  readonly hold_floor_pct: number;
  readonly floor_delta_pct: number;
  readonly floor_delta_usd: number;
  readonly policy: SlicePolicy;
  readonly policy_mechanism: SlicePolicyMechanism;
  readonly policy_qualifier: string;
  readonly block_enforced: boolean;
  readonly flags: SliceFlag[];
}

export interface SliceMetricsInput {
  readonly slice_id: string;
  readonly sport: string;
  readonly league: string;
  readonly period: string;
  readonly market: string;
  readonly legs: number;
  readonly buy_share_pct: number;
  readonly handle_usd: number;
  readonly hold_total_pct: number;
  readonly hold_floor_pct: number;
  readonly policy: SlicePolicy;
  readonly policy_mechanism: SlicePolicyMechanism;
  readonly policy_qualifier: string;
  readonly block_enforced: boolean;
  /**
   * Stake-weighted balanced two-sided book hold percentage (e.g. ~4.545% at -110/-110).
   * When omitted and `leg_distribution` / `vig_capture_pct` are absent, or when explicitly
   * `null`, `vig_capture_pct` and `directional_pnl_usd` emit `null` and flag `MISSING_VIG_SPLIT`.
   */
  readonly balanced_overround_pct?: number | null;
  readonly leg_distribution?: BalancedBookLegDistribution | null;
  readonly vig_capture_pct?: number | null;
  readonly directional_pnl_usd?: number | null;
}

export interface FloorDeltaResult {
  readonly floor_delta_pct: number;
  readonly floor_delta_usd: number;
}

export interface VigDirectionalSplitResult {
  readonly vig_capture_pct: number | null;
  readonly directional_pnl_usd: number | null;
}

export interface BlendedHoldSloSummary {
  readonly total_handle_usd: number;
  readonly total_gross_hold_usd: number;
  readonly raw_blended_hold_pct: number;
  readonly blocked_handle_usd: number;
  readonly blocked_handle_share_pct: number;
  readonly active_handle_usd: number;
  readonly ex_blocked_hold_pct: number;
  readonly active_split_handle_usd: number;
  readonly active_vig_capture_usd: number;
  readonly active_directional_pnl_usd: number;
  readonly ex_blocked_ex_directional_hold_pct: number;
  readonly slo_hold_pct: number;
  readonly slo_floor_pct: number;
  readonly slo_delta_pct: number;
  readonly slo_met: boolean;
  readonly reads_ex_blocked: true;
  readonly reads_ex_directional: true;
}

const EXTREME_BUY_LOW_PCT = 5;
const EXTREME_BUY_HIGH_PCT = 95;
const EXTREME_HANDLE_THRESHOLD_USD = 5_000_000;

/**
 * Pure derivation: `sell_share_pct = 100 - buy_share_pct`.
 */
export function deriveSellShare(buy_share_pct: number): number {
  return 100 - buy_share_pct;
}

/**
 * Pure derivation: `net_position_usd = handle_usd * (buy_share_pct / 100 - 0.5)`.
 */
export function deriveNetPosition(
  handle_usd: number,
  buy_share_pct: number,
): number {
  return handle_usd * (buy_share_pct / 100 - 0.5);
}

/**
 * Pure derivation: `gross_hold_usd = handle_usd * (hold_total_pct / 100)`.
 */
export function deriveGrossHold(
  handle_usd: number,
  hold_total_pct: number,
): number {
  return handle_usd * (hold_total_pct / 100);
}

/**
 * Pure derivation: `floor_delta_pct = hold_total_pct - hold_floor_pct` and
 * `floor_delta_usd = handle_usd * (floor_delta_pct / 100)`.
 */
export function deriveFloorDelta(
  hold_total_pct: number,
  hold_floor_pct: number,
  handle_usd: number,
): FloorDeltaResult {
  const floor_delta_pct = hold_total_pct - hold_floor_pct;
  const floor_delta_usd = handle_usd * (floor_delta_pct / 100);
  return { floor_delta_pct, floor_delta_usd };
}

/**
 * Computes two-sided balanced book hold percentage from observed buy/sell leg
 * implied probabilities (`((p_buy + p_sell - 1) / (p_buy + p_sell)) * 100`).
 * Returns `null` when either side's pricing distribution is unavailable.
 */
export function computeBalancedOverroundFromLegDistribution(
  dist: BalancedBookLegDistribution | null | undefined,
): number | null {
  if (dist === undefined || dist === null) {
    return null;
  }
  const pBuy = dist.mean_buy_implied_prob;
  const pSell = dist.mean_sell_implied_prob;
  if (
    pBuy === null ||
    pSell === null ||
    !Number.isFinite(pBuy) ||
    !Number.isFinite(pSell) ||
    pBuy <= 0 ||
    pBuy >= 1 ||
    pSell <= 0 ||
    pSell >= 1
  ) {
    return null;
  }
  const impliedSum = pBuy + pSell;
  if (impliedSum <= 0) {
    return null;
  }
  const holdRate = Math.max(0, (impliedSum - 1) / impliedSum);
  return holdRate * 100;
}

/**
 * Recomputes `vig_capture_pct` and `directional_pnl_usd` from balanced-book
 * leg distribution (`matched_fraction = 2 * min(buy_share, 1 - buy_share)`).
 * Emits `{ vig_capture_pct: null, directional_pnl_usd: null }` if the source
 * cannot split vig vs directional rather than guessing.
 */
export function deriveVigAndDirectionalSplit(params: {
  readonly handle_usd: number;
  readonly buy_share_pct: number;
  readonly hold_total_pct: number;
  readonly balanced_overround_pct?: number | null;
  readonly leg_distribution?: BalancedBookLegDistribution | null;
  readonly existing_vig_capture_pct?: number | null;
}): VigDirectionalSplitResult {
  let resolvedOverroundPct: number | null = null;

  if (params.leg_distribution !== undefined) {
    resolvedOverroundPct = computeBalancedOverroundFromLegDistribution(
      params.leg_distribution,
    );
  } else if (params.balanced_overround_pct !== undefined) {
    resolvedOverroundPct =
      params.balanced_overround_pct !== null &&
      Number.isFinite(params.balanced_overround_pct)
        ? params.balanced_overround_pct
        : null;
  } else if (
    params.existing_vig_capture_pct !== undefined &&
    params.existing_vig_capture_pct !== null &&
    Number.isFinite(params.existing_vig_capture_pct)
  ) {
    const grossHoldUsd = deriveGrossHold(
      params.handle_usd,
      params.hold_total_pct,
    );
    const vigCaptureUsd =
      params.handle_usd * (params.existing_vig_capture_pct / 100);
    return {
      vig_capture_pct: params.existing_vig_capture_pct,
      directional_pnl_usd: grossHoldUsd - vigCaptureUsd,
    };
  }

  if (resolvedOverroundPct === null) {
    return {
      vig_capture_pct: null,
      directional_pnl_usd: null,
    };
  }

  const buyFrac = Math.min(1, Math.max(0, params.buy_share_pct / 100));
  const matchedBookFraction = 2 * Math.min(buyFrac, 1 - buyFrac);
  const vig_capture_pct = resolvedOverroundPct * matchedBookFraction;
  const grossHoldUsd = deriveGrossHold(
    params.handle_usd,
    params.hold_total_pct,
  );
  const vigCaptureUsd = params.handle_usd * (vig_capture_pct / 100);
  const directional_pnl_usd = grossHoldUsd - vigCaptureUsd;

  return {
    vig_capture_pct,
    directional_pnl_usd,
  };
}

/**
 * Gate 1: `(buy_share_pct < 5 || buy_share_pct > 95) && handle_usd > 5_000_000`.
 */
export function gateBuyShareExtreme(
  row: Pick<SliceMetrics, "buy_share_pct" | "handle_usd">,
): boolean {
  return (
    (row.buy_share_pct < EXTREME_BUY_LOW_PCT ||
      row.buy_share_pct > EXTREME_BUY_HIGH_PCT) &&
    row.handle_usd > EXTREME_HANDLE_THRESHOLD_USD
  );
}

/**
 * Gate 2: `(policy === "ADVANTAGE" && hold_total_pct < 0) || (policy === "BLOCKED" && !block_enforced)`.
 */
export function gatePolicyDataConflict(
  row: Pick<SliceMetrics, "policy" | "hold_total_pct" | "block_enforced">,
): boolean {
  return (
    (row.policy === "ADVANTAGE" && row.hold_total_pct < 0) ||
    (row.policy === "BLOCKED" && !row.block_enforced)
  );
}

/**
 * Gate 3: `floor_delta_pct < 0`.
 */
export function gateHoldBelowFloor(
  row: Pick<SliceMetrics, "floor_delta_pct">,
): boolean {
  return row.floor_delta_pct < 0;
}

/**
 * Gate 4: `|directional_pnl_usd| > |handle_usd * (vig_capture_pct / 100)|`.
 * Returns `false` when vig split is unavailable (`null`).
 */
export function gateDirectionalDominant(
  row: Pick<
    SliceMetrics,
    "directional_pnl_usd" | "handle_usd" | "vig_capture_pct"
  >,
): boolean {
  if (row.directional_pnl_usd === null || row.vig_capture_pct === null) {
    return false;
  }
  const vigCaptureUsd = row.handle_usd * (row.vig_capture_pct / 100);
  return Math.abs(row.directional_pnl_usd) > Math.abs(vigCaptureUsd);
}

/**
 * Data-source honesty gate: emitted when vig vs directional split is unavailable (`null`).
 */
export function gateMissingVigSplit(
  row: Pick<SliceMetrics, "vig_capture_pct" | "directional_pnl_usd">,
): boolean {
  return row.vig_capture_pct === null || row.directional_pnl_usd === null;
}

/**
 * Evaluates all slice risk/policy gates in deterministic canonical order.
 */
export function computeFlags(
  row: Omit<SliceMetrics, "flags"> | SliceMetrics,
): SliceFlag[] {
  const flags: SliceFlag[] = [];
  if (gateBuyShareExtreme(row)) {
    flags.push("BUY_SHARE_EXTREME");
  }
  if (gatePolicyDataConflict(row)) {
    flags.push("POLICY_DATA_CONFLICT");
  }
  if (gateHoldBelowFloor(row)) {
    flags.push("HOLD_BELOW_FLOOR");
  }
  if (gateDirectionalDominant(row)) {
    flags.push("DIRECTIONAL_DOMINANT");
  }
  if (gateMissingVigSplit(row)) {
    flags.push("MISSING_VIG_SPLIT");
  }
  return flags;
}

/**
 * Pure row derivation producing a complete `SliceMetrics` record with derived columns
 * and computed gate flags. Deterministic and idempotent (`derive(derive(x))` === `derive(x)`).
 */
export function deriveSliceMetrics(
  input: SliceMetricsInput | SliceMetrics,
): SliceMetrics {
  const sell_share_pct = deriveSellShare(input.buy_share_pct);
  const net_position_usd = deriveNetPosition(
    input.handle_usd,
    input.buy_share_pct,
  );
  const gross_hold_usd = deriveGrossHold(
    input.handle_usd,
    input.hold_total_pct,
  );
  const { floor_delta_pct, floor_delta_usd } = deriveFloorDelta(
    input.hold_total_pct,
    input.hold_floor_pct,
    input.handle_usd,
  );

  const splitParams: {
    handle_usd: number;
    buy_share_pct: number;
    hold_total_pct: number;
    balanced_overround_pct?: number | null;
    leg_distribution?: BalancedBookLegDistribution | null;
    existing_vig_capture_pct?: number | null;
  } = {
    handle_usd: input.handle_usd,
    buy_share_pct: input.buy_share_pct,
    hold_total_pct: input.hold_total_pct,
  };

  if ("leg_distribution" in input && input.leg_distribution !== undefined) {
    splitParams.leg_distribution = input.leg_distribution;
  }
  if (
    "balanced_overround_pct" in input &&
    input.balanced_overround_pct !== undefined
  ) {
    splitParams.balanced_overround_pct = input.balanced_overround_pct;
  }
  if (input.vig_capture_pct !== undefined) {
    splitParams.existing_vig_capture_pct = input.vig_capture_pct;
  }

  const { vig_capture_pct, directional_pnl_usd } =
    deriveVigAndDirectionalSplit(splitParams);

  const baseRow: Omit<SliceMetrics, "flags"> = {
    slice_id: input.slice_id,
    sport: input.sport,
    league: input.league,
    period: input.period,
    market: input.market,
    legs: input.legs,
    buy_share_pct: input.buy_share_pct,
    sell_share_pct,
    handle_usd: input.handle_usd,
    net_position_usd,
    vig_capture_pct,
    directional_pnl_usd,
    hold_total_pct: input.hold_total_pct,
    gross_hold_usd,
    hold_floor_pct: input.hold_floor_pct,
    floor_delta_pct,
    floor_delta_usd,
    policy: input.policy,
    policy_mechanism: input.policy_mechanism,
    policy_qualifier: input.policy_qualifier,
    block_enforced: input.block_enforced,
  };

  return {
    ...baseRow,
    flags: computeFlags(baseRow),
  };
}

/**
 * Alias of `deriveSliceMetrics` for `computeFlags(derive(row))` composition.
 */
export const derive = deriveSliceMetrics;

/**
 * Computes the Blended Hold SLO summary, contrasting the naive raw blended hold
 * against ex-blocked hold and ex-blocked / ex-directional structural vig hold.
 */
export function computeBlendedHoldSlo(
  rows: readonly SliceMetrics[],
  slo_floor_pct: number,
): BlendedHoldSloSummary {
  let total_handle_usd = 0;
  let total_gross_hold_usd = 0;
  let blocked_handle_usd = 0;
  let active_handle_usd = 0;
  let active_gross_hold_usd = 0;
  let active_split_handle_usd = 0;
  let active_vig_capture_usd = 0;
  let active_directional_pnl_usd = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    total_handle_usd += row.handle_usd;
    total_gross_hold_usd += row.gross_hold_usd;

    if (row.policy === "BLOCKED") {
      blocked_handle_usd += row.handle_usd;
    } else {
      active_handle_usd += row.handle_usd;
      active_gross_hold_usd += row.gross_hold_usd;
      if (row.vig_capture_pct !== null && row.directional_pnl_usd !== null) {
        active_split_handle_usd += row.handle_usd;
        active_vig_capture_usd += row.handle_usd * (row.vig_capture_pct / 100);
        active_directional_pnl_usd += row.directional_pnl_usd;
      }
    }
  }

  const raw_blended_hold_pct =
    total_handle_usd > 0 ? (total_gross_hold_usd / total_handle_usd) * 100 : 0;
  const blocked_handle_share_pct =
    total_handle_usd > 0 ? (blocked_handle_usd / total_handle_usd) * 100 : 0;
  const ex_blocked_hold_pct =
    active_handle_usd > 0
      ? (active_gross_hold_usd / active_handle_usd) * 100
      : 0;
  const ex_blocked_ex_directional_hold_pct =
    active_split_handle_usd > 0
      ? (active_vig_capture_usd / active_split_handle_usd) * 100
      : ex_blocked_hold_pct;

  const slo_hold_pct = ex_blocked_ex_directional_hold_pct;
  const slo_delta_pct = slo_hold_pct - slo_floor_pct;

  return {
    total_handle_usd,
    total_gross_hold_usd,
    raw_blended_hold_pct,
    blocked_handle_usd,
    blocked_handle_share_pct,
    active_handle_usd,
    ex_blocked_hold_pct,
    active_split_handle_usd,
    active_vig_capture_usd,
    active_directional_pnl_usd,
    ex_blocked_ex_directional_hold_pct,
    slo_hold_pct,
    slo_floor_pct,
    slo_delta_pct,
    slo_met: slo_hold_pct >= slo_floor_pct,
    reads_ex_blocked: true,
    reads_ex_directional: true,
  };
}
