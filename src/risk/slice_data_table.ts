/**
 * @file src/risk/slice_data_table.ts
 * @description Structure-of-Arrays (SoA) TypedArray DataTable spine for `SliceMetrics`.
 *
 * Wiring contract:
 * - Adds `vig_capture_pct`, `directional_pnl_usd`, `net_position_usd`, `gross_hold_usd`,
 *   `floor_delta_pct`, and `flags` (`Uint32Array` bitmask) as columnar SoA buffers.
 * - Computes derived columns and flags ONCE per stream `flush()`, never per render read.
 * - Uses fixed-capacity TypedArrays and `Uint32Array` bitsets (zero `Map`, `Set`, or `boolean[]`).
 */

import {
  deriveSliceMetrics,
  type SliceFlag,
  type SliceMetrics,
  type SliceMetricsInput,
  type SlicePolicy,
  type SlicePolicyMechanism,
} from "./slice_metrics.ts";

export const FLAG_BIT_BUY_SHARE_EXTREME = 1 << 0;
export const FLAG_BIT_POLICY_DATA_CONFLICT = 1 << 1;
export const FLAG_BIT_HOLD_BELOW_FLOOR = 1 << 2;
export const FLAG_BIT_DIRECTIONAL_DOMINANT = 1 << 3;
export const FLAG_BIT_MISSING_VIG_SPLIT = 1 << 4;

const POLICY_BY_CODE: readonly SlicePolicy[] = [
  "BLOCKED",
  "LEAK",
  "ADVANTAGE",
  "PRESERVE",
];

const MECHANISM_BY_CODE: readonly SlicePolicyMechanism[] = [
  "LIVE_LOCKOUT",
  "DERIVATIVE",
  "VIG",
  "BELL_CURVE",
];

function encodePolicy(policy: SlicePolicy): number {
  switch (policy) {
    case "BLOCKED":
      return 0;
    case "LEAK":
      return 1;
    case "ADVANTAGE":
      return 2;
    case "PRESERVE":
      return 3;
  }
}

function encodeMechanism(mechanism: SlicePolicyMechanism): number {
  switch (mechanism) {
    case "LIVE_LOCKOUT":
      return 0;
    case "DERIVATIVE":
      return 1;
    case "VIG":
      return 2;
    case "BELL_CURVE":
      return 3;
  }
}

export function encodeSliceFlagsMask(flags: readonly SliceFlag[]): number {
  let mask = 0;
  for (let i = 0; i < flags.length; i++) {
    switch (flags[i]!) {
      case "BUY_SHARE_EXTREME":
        mask |= FLAG_BIT_BUY_SHARE_EXTREME;
        break;
      case "POLICY_DATA_CONFLICT":
        mask |= FLAG_BIT_POLICY_DATA_CONFLICT;
        break;
      case "HOLD_BELOW_FLOOR":
        mask |= FLAG_BIT_HOLD_BELOW_FLOOR;
        break;
      case "DIRECTIONAL_DOMINANT":
        mask |= FLAG_BIT_DIRECTIONAL_DOMINANT;
        break;
      case "MISSING_VIG_SPLIT":
        mask |= FLAG_BIT_MISSING_VIG_SPLIT;
        break;
    }
  }
  return mask >>> 0;
}

export function decodeSliceFlagsMask(mask: number): SliceFlag[] {
  const flags: SliceFlag[] = [];
  if ((mask & FLAG_BIT_BUY_SHARE_EXTREME) !== 0) {
    flags.push("BUY_SHARE_EXTREME");
  }
  if ((mask & FLAG_BIT_POLICY_DATA_CONFLICT) !== 0) {
    flags.push("POLICY_DATA_CONFLICT");
  }
  if ((mask & FLAG_BIT_HOLD_BELOW_FLOOR) !== 0) {
    flags.push("HOLD_BELOW_FLOOR");
  }
  if ((mask & FLAG_BIT_DIRECTIONAL_DOMINANT) !== 0) {
    flags.push("DIRECTIONAL_DOMINANT");
  }
  if ((mask & FLAG_BIT_MISSING_VIG_SPLIT) !== 0) {
    flags.push("MISSING_VIG_SPLIT");
  }
  return flags;
}

export interface SliceMetricsSoAColumns {
  readonly legs: Int32Array;
  readonly buy_share_pct: Float64Array;
  readonly sell_share_pct: Float64Array;
  readonly handle_usd: Float64Array;
  readonly net_position_usd: Float64Array;
  readonly vig_capture_pct: Float64Array;
  readonly directional_pnl_usd: Float64Array;
  readonly hold_total_pct: Float64Array;
  readonly gross_hold_usd: Float64Array;
  readonly hold_floor_pct: Float64Array;
  readonly floor_delta_pct: Float64Array;
  readonly floor_delta_usd: Float64Array;
  readonly policy_code: Uint8Array;
  readonly mechanism_code: Uint8Array;
  readonly block_enforced_bits: Uint32Array;
  readonly flags_mask: Uint32Array;
}

export class SliceMetricsSoASpine {
  readonly capacity: number;
  readonly columns: SliceMetricsSoAColumns;

  private readonly sliceIds: string[];
  private readonly sports: string[];
  private readonly leagues: string[];
  private readonly periods: string[];
  private readonly markets: string[];
  private readonly qualifiers: string[];

  private activeRowCount = 0;
  private streamFlushCount = 0;
  private totalDerivedRows = 0;
  private totalRenderReads = 0;

  constructor(capacity = 256) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `SliceMetricsSoASpine capacity must be positive integer (got ${capacity})`,
      );
    }
    this.capacity = capacity;
    const bitsetWords = Math.ceil(capacity / 32);

    this.columns = {
      legs: new Int32Array(capacity),
      buy_share_pct: new Float64Array(capacity),
      sell_share_pct: new Float64Array(capacity),
      handle_usd: new Float64Array(capacity),
      net_position_usd: new Float64Array(capacity),
      vig_capture_pct: new Float64Array(capacity),
      directional_pnl_usd: new Float64Array(capacity),
      hold_total_pct: new Float64Array(capacity),
      gross_hold_usd: new Float64Array(capacity),
      hold_floor_pct: new Float64Array(capacity),
      floor_delta_pct: new Float64Array(capacity),
      floor_delta_usd: new Float64Array(capacity),
      policy_code: new Uint8Array(capacity),
      mechanism_code: new Uint8Array(capacity),
      block_enforced_bits: new Uint32Array(bitsetWords),
      flags_mask: new Uint32Array(capacity),
    };

    this.sliceIds = [];
    this.sports = [];
    this.leagues = [];
    this.periods = [];
    this.markets = [];
    this.qualifiers = [];
    for (let i = 0; i < capacity; i++) {
      this.sliceIds.push("");
      this.sports.push("");
      this.leagues.push("");
      this.periods.push("");
      this.markets.push("");
      this.qualifiers.push("");
    }
  }

  get rowCount(): number {
    return this.activeRowCount;
  }

  get flushCount(): number {
    return this.streamFlushCount;
  }

  get derivedRowComputeCount(): number {
    return this.totalDerivedRows;
  }

  get renderReadCount(): number {
    return this.totalRenderReads;
  }

  /**
   * Ingests a stream flush batch, computing all derived columns and gate flags
   * once and writing them into the pre-allocated SoA TypedArray buffers.
   */
  flush(inputs: readonly (SliceMetricsInput | SliceMetrics)[]): number {
    if (inputs.length > this.capacity) {
      throw new RangeError(
        `Flush batch (${inputs.length}) exceeds SliceMetricsSoASpine capacity (${this.capacity})`,
      );
    }

    this.columns.block_enforced_bits.fill(0);
    const count = inputs.length;

    for (let i = 0; i < count; i++) {
      const derived = deriveSliceMetrics(inputs[i]!);
      this.totalDerivedRows += 1;

      this.sliceIds[i] = derived.slice_id;
      this.sports[i] = derived.sport;
      this.leagues[i] = derived.league;
      this.periods[i] = derived.period;
      this.markets[i] = derived.market;
      this.qualifiers[i] = derived.policy_qualifier;

      this.columns.legs[i] = derived.legs;
      this.columns.buy_share_pct[i] = derived.buy_share_pct;
      this.columns.sell_share_pct[i] = derived.sell_share_pct;
      this.columns.handle_usd[i] = derived.handle_usd;
      this.columns.net_position_usd[i] = derived.net_position_usd;
      this.columns.vig_capture_pct[i] =
        derived.vig_capture_pct === null ? Number.NaN : derived.vig_capture_pct;
      this.columns.directional_pnl_usd[i] =
        derived.directional_pnl_usd === null
          ? Number.NaN
          : derived.directional_pnl_usd;
      this.columns.hold_total_pct[i] = derived.hold_total_pct;
      this.columns.gross_hold_usd[i] = derived.gross_hold_usd;
      this.columns.hold_floor_pct[i] = derived.hold_floor_pct;
      this.columns.floor_delta_pct[i] = derived.floor_delta_pct;
      this.columns.floor_delta_usd[i] = derived.floor_delta_usd;
      this.columns.policy_code[i] = encodePolicy(derived.policy);
      this.columns.mechanism_code[i] = encodeMechanism(
        derived.policy_mechanism,
      );
      this.columns.flags_mask[i] = encodeSliceFlagsMask(derived.flags);

      if (derived.block_enforced) {
        const wordIdx = i >>> 5;
        const bitMask = 1 << (i & 31);
        this.columns.block_enforced_bits[wordIdx] =
          (this.columns.block_enforced_bits[wordIdx]! | bitMask) >>> 0;
      }
    }

    this.activeRowCount = count;
    this.streamFlushCount += 1;
    return this.streamFlushCount;
  }

  /**
   * Projects row `index` directly from the SoA TypedArray columns without
   * invoking any derivation or gate evaluation functions.
   */
  readRowAt(index: number): SliceMetrics {
    if (index < 0 || index >= this.activeRowCount) {
      throw new RangeError(
        `Row index ${index} out of bounds (0..${this.activeRowCount})`,
      );
    }
    const vigRaw = this.columns.vig_capture_pct[index]!;
    const dirRaw = this.columns.directional_pnl_usd[index]!;
    const wordIdx = index >>> 5;
    const bitMask = 1 << (index & 31);
    const blockEnforced =
      (this.columns.block_enforced_bits[wordIdx]! & bitMask) !== 0;

    return {
      slice_id: this.sliceIds[index]!,
      sport: this.sports[index]!,
      league: this.leagues[index]!,
      period: this.periods[index]!,
      market: this.markets[index]!,
      legs: this.columns.legs[index]!,
      buy_share_pct: this.columns.buy_share_pct[index]!,
      sell_share_pct: this.columns.sell_share_pct[index]!,
      handle_usd: this.columns.handle_usd[index]!,
      net_position_usd: this.columns.net_position_usd[index]!,
      vig_capture_pct: Number.isNaN(vigRaw) ? null : vigRaw,
      directional_pnl_usd: Number.isNaN(dirRaw) ? null : dirRaw,
      hold_total_pct: this.columns.hold_total_pct[index]!,
      gross_hold_usd: this.columns.gross_hold_usd[index]!,
      hold_floor_pct: this.columns.hold_floor_pct[index]!,
      floor_delta_pct: this.columns.floor_delta_pct[index]!,
      floor_delta_usd: this.columns.floor_delta_usd[index]!,
      policy: POLICY_BY_CODE[this.columns.policy_code[index]!] ?? "PRESERVE",
      policy_mechanism:
        MECHANISM_BY_CODE[this.columns.mechanism_code[index]!] ?? "VIG",
      policy_qualifier: this.qualifiers[index]!,
      block_enforced: blockEnforced,
      flags: decodeSliceFlagsMask(this.columns.flags_mask[index]!),
    };
  }

  /**
   * Render-path read of all active rows from SoA columns (zero derivation recomputation).
   */
  readAllRows(): SliceMetrics[] {
    this.totalRenderReads += 1;
    const out: SliceMetrics[] = [];
    for (let i = 0; i < this.activeRowCount; i++) {
      out.push(this.readRowAt(i));
    }
    return out;
  }
}
