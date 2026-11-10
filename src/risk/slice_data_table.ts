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
  type HoldFloorResolvedVia,
  type SliceFlag,
  type SliceMetrics,
  type SliceMetricsInput,
  type SlicePolicy,
  type SlicePolicyMechanism,
} from "./slice_metrics.ts";
import {
  recordUnknownSliceId,
  type SlicePredicateOptions,
} from "./slice_registry.ts";

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

function encodeResolvedVia(tier: HoldFloorResolvedVia | null): number {
  switch (tier) {
    case null:
      return 0;
    case "by_slice":
      return 1;
    case "by_sport":
      return 2;
    case "by_market":
      return 3;
    case "default":
      return 4;
  }
}

function decodeResolvedVia(code: number): HoldFloorResolvedVia | null {
  switch (code) {
    case 1:
      return "by_slice";
    case 2:
      return "by_sport";
    case 3:
      return "by_market";
    case 4:
      return "default";
    default:
      return null;
  }
}

function flagBitOf(flag: SliceFlag): number {
  switch (flag) {
    case "BUY_SHARE_EXTREME":
      return FLAG_BIT_BUY_SHARE_EXTREME;
    case "POLICY_DATA_CONFLICT":
      return FLAG_BIT_POLICY_DATA_CONFLICT;
    case "HOLD_BELOW_FLOOR":
      return FLAG_BIT_HOLD_BELOW_FLOOR;
    case "DIRECTIONAL_DOMINANT":
      return FLAG_BIT_DIRECTIONAL_DOMINANT;
    case "MISSING_VIG_SPLIT":
      return FLAG_BIT_MISSING_VIG_SPLIT;
  }
}

export function encodeSliceFlagsMask(flags: readonly SliceFlag[]): number {
  let mask = 0;
  for (let i = 0; i < flags.length; i++) {
    mask |= flagBitOf(flags[i]!);
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
  readonly hold_floor_resolved_via_code: Uint8Array;
  readonly floor_delta_pct: Float64Array;
  readonly floor_delta_usd: Float64Array;
  readonly policy_code: Uint8Array;
  readonly mechanism_code: Uint8Array;
}

export class SliceMetricsSoASpine {
  readonly capacity: number;
  readonly columns: SliceMetricsSoAColumns;

  private readonly blockEnforcedBits: Uint32Array;
  private readonly flagsMask: Uint32Array;
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
    const bitsetWords = (capacity + 31) >>> 5;

    this.blockEnforcedBits = new Uint32Array(bitsetWords);
    this.flagsMask = new Uint32Array(capacity);

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
      hold_floor_resolved_via_code: new Uint8Array(capacity),
      floor_delta_pct: new Float64Array(capacity),
      floor_delta_usd: new Float64Array(capacity),
      policy_code: new Uint8Array(capacity),
      mechanism_code: new Uint8Array(capacity),
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
   * Predicate read over the encapsulated `blockEnforcedBits` `Uint32Array` bitset.
   *
   * @param rowIndex - Active **SoA flush-batch row index** (`0..rowCount - 1`),
   *   NOT a `SLICE_REGISTRY` index (`flush()` accepts arbitrary filtered/ordered batches;
   *   use {@link isSliceBlockEnforced} when querying by canonical `slice_id`).
   */
  isBlockEnforcedAt(rowIndex: number): boolean {
    if (rowIndex < 0 || rowIndex >= this.activeRowCount) {
      throw new RangeError(
        `SoA rowIndex ${rowIndex} out of bounds (0..${this.activeRowCount})`,
      );
    }
    return (
      ((this.blockEnforcedBits[rowIndex >>> 5]! >>> (rowIndex & 31)) & 1) === 1
    );
  }

  /**
   * Policy-boundary predicate read of `block_enforced` by canonical `slice_id`
   * over active flushed rows. Never fails silently on an absent `slice_id`:
   * increments `slice_unknown_total{slice_id}` and throws `UnknownSliceIdError`
   * in dev/test profiles (or returns `false` when `onUnknownSlice === "telemetry"`).
   */
  isSliceBlockEnforced(
    slice_id: string,
    options?: SlicePredicateOptions,
  ): boolean {
    for (let rowIndex = 0; rowIndex < this.activeRowCount; rowIndex++) {
      if (this.sliceIds[rowIndex] === slice_id) {
        return this.isBlockEnforcedAt(rowIndex);
      }
    }
    return recordUnknownSliceId(slice_id, options, "SliceMetricsSoASpine");
  }

  /**
   * Predicate read over the encapsulated `flagsMask` `Uint32Array` bitset.
   *
   * @param rowIndex - Active **SoA flush-batch row index** (`0..rowCount - 1`),
   *   NOT a `SLICE_REGISTRY` index.
   */
  hasFlagAt(rowIndex: number, flag: SliceFlag): boolean {
    if (rowIndex < 0 || rowIndex >= this.activeRowCount) {
      throw new RangeError(
        `SoA rowIndex ${rowIndex} out of bounds (0..${this.activeRowCount})`,
      );
    }
    return (this.flagsMask[rowIndex]! & flagBitOf(flag)) !== 0;
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

    this.blockEnforcedBits.fill(0);
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
      this.columns.hold_floor_resolved_via_code[i] = encodeResolvedVia(
        derived.hold_floor_resolved_via,
      );
      this.columns.floor_delta_pct[i] = derived.floor_delta_pct;
      this.columns.floor_delta_usd[i] = derived.floor_delta_usd;
      this.columns.policy_code[i] = encodePolicy(derived.policy);
      this.columns.mechanism_code[i] = encodeMechanism(
        derived.policy_mechanism,
      );
      this.flagsMask[i] = encodeSliceFlagsMask(derived.flags);

      if (derived.block_enforced) {
        const wordIdx = i >>> 5;
        const bitMask = 1 << (i & 31);
        this.blockEnforcedBits[wordIdx] =
          (this.blockEnforcedBits[wordIdx]! | bitMask) >>> 0;
      }
    }

    this.activeRowCount = count;
    this.streamFlushCount += 1;
    return this.streamFlushCount;
  }

  /**
   * Projects row `rowIndex` (SoA flush-batch row position `0..rowCount - 1`,
   * NOT a `SLICE_REGISTRY` index) directly from the SoA TypedArray columns
   * without invoking any derivation or gate evaluation functions.
   */
  readRowAt(rowIndex: number): SliceMetrics {
    if (rowIndex < 0 || rowIndex >= this.activeRowCount) {
      throw new RangeError(
        `SoA rowIndex ${rowIndex} out of bounds (0..${this.activeRowCount})`,
      );
    }
    const vigRaw = this.columns.vig_capture_pct[rowIndex]!;
    const dirRaw = this.columns.directional_pnl_usd[rowIndex]!;
    const blockEnforced = this.isBlockEnforcedAt(rowIndex);

    return {
      slice_id: this.sliceIds[rowIndex]!,
      sport: this.sports[rowIndex]!,
      league: this.leagues[rowIndex]!,
      period: this.periods[rowIndex]!,
      market: this.markets[rowIndex]!,
      legs: this.columns.legs[rowIndex]!,
      buy_share_pct: this.columns.buy_share_pct[rowIndex]!,
      sell_share_pct: this.columns.sell_share_pct[rowIndex]!,
      handle_usd: this.columns.handle_usd[rowIndex]!,
      net_position_usd: this.columns.net_position_usd[rowIndex]!,
      vig_capture_pct: Number.isNaN(vigRaw) ? null : vigRaw,
      directional_pnl_usd: Number.isNaN(dirRaw) ? null : dirRaw,
      hold_total_pct: this.columns.hold_total_pct[rowIndex]!,
      gross_hold_usd: this.columns.gross_hold_usd[rowIndex]!,
      hold_floor_pct: this.columns.hold_floor_pct[rowIndex]!,
      hold_floor_resolved_via: decodeResolvedVia(
        this.columns.hold_floor_resolved_via_code[rowIndex]!,
      ),
      floor_delta_pct: this.columns.floor_delta_pct[rowIndex]!,
      floor_delta_usd: this.columns.floor_delta_usd[rowIndex]!,
      policy: POLICY_BY_CODE[this.columns.policy_code[rowIndex]!] ?? "PRESERVE",
      policy_mechanism:
        MECHANISM_BY_CODE[this.columns.mechanism_code[rowIndex]!] ?? "VIG",
      policy_qualifier: this.qualifiers[rowIndex]!,
      block_enforced: blockEnforced,
      flags: decodeSliceFlagsMask(this.flagsMask[rowIndex]!),
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
