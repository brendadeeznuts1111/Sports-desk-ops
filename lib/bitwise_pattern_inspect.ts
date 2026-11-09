/**
 * @file lib/bitwise_pattern_inspect.ts
 * @description First-class Bun.inspect and Bun.inspect.table custom reporting for
 * bitwise bitsets, columnar wager arrays, and observation pattern scopes.
 *
 * Provides:
 *  1. `InspectableBitSet32`: Single-word bitmask inspector with popcount, binary, hex, and named flags.
 *  2. `InspectableBitSetArray`: Dense `Uint32Array` bitset arena inspector with density metrics and word tables.
 *  3. `InspectableWagerColumns`: Columnar typed-array wager summary table renderer via `Bun.inspect.table`.
 *  4. `PatternScopeReport`: Observation pattern provability table with bitmask encodings.
 *  5. `CompositeWagerInspectionReport`: Unified multi-section operator report.
 */

import {
  activeWagerObservationSlices,
  PATTERN_SCOPE_MATRIX,
  type PatternClass,
  type PatternProvability,
  type WagerObservationSlice,
} from "./fantasy402_wager_universe_scope.ts";
import type { WagerColumns } from "./wagers_report.ts";

/** Fast, branchless 32-bit popcount (Hamming weight). */
export function popcount32(w: number): number {
  let v = w >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Format a 32-bit unsigned integer as grouped nibbles (e.g. `0000_0000_...`). */
export function formatBinary32(w: number, separator = "_"): string {
  const binary = (w >>> 0).toString(2).padStart(32, "0");
  const chunks: string[] = [];
  for (let i = 0; i < 32; i += 4) {
    chunks.push(binary.slice(i, i + 4));
  }
  return chunks.join(separator);
}

/** Format a 32-bit unsigned integer as zero-padded hexadecimal (`0x00000000`). */
export function formatHex32(w: number): string {
  return `0x${(w >>> 0).toString(16).padStart(8, "0")}`;
}

/** Extract zero-based bit indices currently set in a 32-bit word. */
export function extractBitIndices32(w: number): number[] {
  const indices: number[] = [];
  let bits = w >>> 0;
  let idx = 0;
  while (bits > 0) {
    if ((bits & 1) === 1) {
      indices.push(idx);
    }
    bits >>>= 1;
    idx++;
  }
  return indices;
}

/** Canonical channel behavior flag dictionary. */
export const CHANNEL_BEHAVIOR_FLAG_NAMES: Readonly<Record<number, string>> = {
  0: "INTERNET",
  1: "GSLIVE",
  2: "GSBUILDER",
  3: "ALERT_MIRROR",
  4: "BLOCKED_SENTINEL",
};

/** Canonical route flag dictionary. */
export const ROUTE_FLAG_NAMES: Readonly<Record<number, string>> = {
  0: "NEW_TICKET",
  1: "GONE_TICKET",
  2: "CHANGED_TICKET",
  3: "CONFIRMED_ALERT",
  4: "ORPHAN_ALERT",
  5: "LATE_ALERT",
  6: "NON_SPORTS_DROP",
};

/** Canonical wager state bitmask dictionary. */
export const WAGER_STATE_FLAG_NAMES: Readonly<Record<number, string>> = {
  0: "PENDING",
  1: "SETTLED",
  2: "WON",
  3: "LOST",
  4: "PUSH",
  5: "CANCELED",
  6: "CLV_ELIGIBLE",
  7: "HIGH_RISK",
  8: "FREE_PLAY",
};

/** Pattern class bit position mapping (0..5). */
export const PATTERN_CLASS_BITS: Readonly<Record<PatternClass, number>> = {
  pending_price_spike: 0,
  cross_source_arb: 1,
  customer_stake_timing_cluster: 2,
  win_loss_rate: 3,
  cancel_rate: 4,
  parlay_leg_completion: 5,
};

export const PATTERN_FLAG_NAMES: Readonly<Record<number, string>> = {
  0: "pending_price_spike",
  1: "cross_source_arb",
  2: "customer_stake_timing_cluster",
  3: "win_loss_rate",
  4: "cancel_rate",
  5: "parlay_leg_completion",
};

export interface BitSetTableRow {
  readonly label: string;
  readonly hex: string;
  readonly binary: string;
  readonly popcount: number;
  readonly flags: string;
}

/**
 * Inspectable 32-bit bitset value with `[Bun.inspect.custom]` and table rendering.
 */
export class InspectableBitSet32 {
  public readonly unsigned: number;
  public readonly popcount: number;
  public readonly hex: string;
  public readonly binary: string;
  public readonly activeBits: readonly number[];
  public readonly activeFlags: readonly string[];

  constructor(
    value: number,
    public readonly flagDefinitions: Readonly<Record<number, string>> = {},
  ) {
    this.unsigned = value >>> 0;
    this.popcount = popcount32(this.unsigned);
    this.hex = formatHex32(this.unsigned);
    this.binary = formatBinary32(this.unsigned);
    this.activeBits = extractBitIndices32(this.unsigned);
    this.activeFlags = this.activeBits.map(
      (b) => this.flagDefinitions[b] ?? `BIT_${b}`,
    );
  }

  public has(bit: number): boolean {
    if (bit < 0 || bit > 31) return false;
    return ((this.unsigned >>> bit) & 1) === 1;
  }

  public hasFlag(name: string): boolean {
    return this.activeFlags.includes(name);
  }

  public toTableRow(label = "bitset"): BitSetTableRow {
    return {
      label,
      hex: this.hex,
      binary: this.binary,
      popcount: this.popcount,
      flags: this.activeFlags.join(" | ") || "(none)",
    };
  }

  public [Bun.inspect.custom](
    _depth: number,
    options: { colors?: boolean } = {},
  ): string {
    const flagsStr = this.activeFlags.join(", ") || "(none)";
    if (options?.colors === true) {
      return `\u001b[36mBitSet32\u001b[39m(\u001b[33m${this.hex}\u001b[39m, popcount=${this.popcount}, flags=[\u001b[32m${flagsStr}\u001b[39m])`;
    }
    return `BitSet32(${this.hex}, popcount=${this.popcount}, flags=[${flagsStr}])`;
  }
}

export interface BitSetArrayTableRow {
  readonly word: number;
  readonly bitRange: string;
  readonly hex: string;
  readonly popcount: number;
  readonly flags: string;
}

/**
 * Inspectable dense `Uint32Array` bitset arena with density metrics and word table.
 */
export class InspectableBitSetArray {
  public readonly wordsCount: number;
  public readonly capacityBits: number;
  public readonly popcount: number;
  public readonly densityPercent: string;

  constructor(
    public readonly words: Uint32Array,
    totalBits?: number,
    public readonly flagDefinitions: Readonly<Record<number, string>> = {},
  ) {
    this.wordsCount = words.length;
    this.capacityBits = totalBits ?? words.length * 32;
    let count = 0;
    for (let i = 0; i < words.length; i++) {
      count += popcount32(words[i]!);
    }
    this.popcount = count;
    const density =
      this.capacityBits > 0 ? (count / this.capacityBits) * 100 : 0;
    this.densityPercent = `${density.toFixed(2)}%`;
  }

  public has(bitIndex: number): boolean {
    if (bitIndex < 0 || bitIndex >= this.capacityBits) return false;
    const wordIdx = bitIndex >>> 5;
    const bitOffset = bitIndex & 31;
    const word = this.words[wordIdx];
    if (word === undefined) return false;
    return ((word >>> bitOffset) & 1) === 1;
  }

  public setBit(bitIndex: number): void {
    if (bitIndex < 0 || bitIndex >= this.capacityBits) return;
    const wordIdx = bitIndex >>> 5;
    const bitOffset = bitIndex & 31;
    if (wordIdx < this.words.length) {
      this.words[wordIdx]! |= 1 << bitOffset;
    }
  }

  public clearBit(bitIndex: number): void {
    if (bitIndex < 0 || bitIndex >= this.capacityBits) return;
    const wordIdx = bitIndex >>> 5;
    const bitOffset = bitIndex & 31;
    if (wordIdx < this.words.length) {
      this.words[wordIdx]! &= ~(1 << bitOffset);
    }
  }

  public toTableRows(maxRows = 32): BitSetArrayTableRow[] {
    const rows: BitSetArrayTableRow[] = [];
    let recorded = 0;
    for (let i = 0; i < this.words.length; i++) {
      const val = this.words[i]!;
      // Record non-zero words, or all words if the bitset has <= 4 words
      if (val !== 0 || this.words.length <= 4) {
        const startBit = i * 32;
        const endBit = Math.min((i + 1) * 32 - 1, this.capacityBits - 1);
        const activeBits = extractBitIndices32(val);
        const flagNames = activeBits
          .map((b) => this.flagDefinitions[b] ?? `bit_${b}`)
          .slice(0, 4)
          .join(", ");
        const suffix =
          activeBits.length > 4 ? ` (+${activeBits.length - 4} more)` : "";

        rows.push({
          word: i,
          bitRange: `[${startBit}..${endBit}]`,
          hex: formatHex32(val),
          popcount: popcount32(val),
          flags: flagNames + suffix || "(none)",
        });
        recorded++;
        if (recorded >= maxRows) break;
      }
    }
    return rows;
  }

  public inspectTable(options?: { colors?: boolean }): string {
    const rows = this.toTableRows();
    if (rows.length === 0) return "(all words 0x00000000)";
    return Bun.inspect.table(
      rows,
      ["word", "bitRange", "hex", "popcount", "flags"],
      options,
    );
  }

  public [Bun.inspect.custom](
    _depth: number,
    options: { colors?: boolean } = {},
  ): string {
    const header = `BitSetArray(words=${this.wordsCount}, capacity=${this.capacityBits} bits, popcount=${this.popcount}, density=${this.densityPercent})`;
    const table = this.inspectTable(options);
    return `${header}\n${table}`;
  }
}

export interface WagerColumnTableRow {
  readonly [key: string]: string;
}

/**
 * Inspectable wrapper around columnar wager typed arrays.
 * Automatically computes grand totals and renders a formatted `Bun.inspect.table`.
 */
export class InspectableWagerColumns {
  public readonly totalCount: number;
  public readonly totalLegs: number;
  public readonly totalRisk: number;
  public readonly totalToWin: number;
  public readonly totalResult: number;

  constructor(
    public readonly columns: WagerColumns,
    public readonly groupLabel: string = "Group",
  ) {
    let tCount = 0;
    let tLegs = 0;
    let tRisk = 0;
    let tToWin = 0;
    let tResult = 0;

    const n = columns.groups.length;
    for (let i = 0; i < n; i++) {
      tCount += columns.count[i] ?? 0;
      tLegs += columns.legs[i] ?? 0;
      tRisk += columns.risk[i] ?? 0;
      tToWin += columns.toWin[i] ?? 0;
      tResult += columns.result[i] ?? 0;
    }

    this.totalCount = tCount;
    this.totalLegs = tLegs;
    this.totalRisk = tRisk;
    this.totalToWin = tToWin;
    this.totalResult = tResult;
  }

  public toTableRows(): WagerColumnTableRow[] {
    const { groups, count, legs, risk, toWin, result } = this.columns;
    const n = groups.length;
    const rows: WagerColumnTableRow[] = [];

    for (let i = 0; i < n; i++) {
      const c = count[i] ?? 0;
      const l = legs[i] ?? 0;
      const r = risk[i] ?? 0;
      const w = toWin[i] ?? 0;
      const res = result[i] ?? 0;

      rows.push({
        [this.groupLabel]: groups[i] ?? `group_${i}`,
        Count: c.toLocaleString("en-US"),
        Legs: l.toLocaleString("en-US"),
        "Risk ($)": `$${r.toFixed(2)}`,
        "ToWin ($)": `$${w.toFixed(2)}`,
        "Result ($)": `$${res.toFixed(2)}`,
        "Avg Risk": `$${(c > 0 ? r / c : 0).toFixed(2)}`,
        "Legs/Wager": (c > 0 ? l / c : 0).toFixed(2),
      });
    }

    // Add TOTAL summary row
    rows.push({
      [this.groupLabel]: "TOTAL",
      Count: this.totalCount.toLocaleString("en-US"),
      Legs: this.totalLegs.toLocaleString("en-US"),
      "Risk ($)": `$${this.totalRisk.toFixed(2)}`,
      "ToWin ($)": `$${this.totalToWin.toFixed(2)}`,
      "Result ($)": `$${this.totalResult.toFixed(2)}`,
      "Avg Risk": `$${(this.totalCount > 0 ? this.totalRisk / this.totalCount : 0).toFixed(2)}`,
      "Legs/Wager": (this.totalCount > 0
        ? this.totalLegs / this.totalCount
        : 0
      ).toFixed(2),
    });

    return rows;
  }

  public inspectTable(options?: { colors?: boolean }): string {
    const props = [
      this.groupLabel,
      "Count",
      "Legs",
      "Risk ($)",
      "ToWin ($)",
      "Result ($)",
      "Avg Risk",
      "Legs/Wager",
    ];
    return Bun.inspect.table(this.toTableRows(), props, options);
  }

  public [Bun.inspect.custom](
    _depth: number,
    options: { colors?: boolean } = {},
  ): string {
    const header = `WagerColumns(${this.columns.groups.length} groups, ${this.totalCount} wagers, risk=$${this.totalRisk.toFixed(2)})`;
    const table = this.inspectTable(options);
    return `${header}\n${table}`;
  }
}

export interface PatternScopeTableRow {
  readonly Pattern: string;
  readonly Bit: string;
  readonly Provability: string;
  readonly "Required Slices": string;
  readonly Limitation: string;
}

/**
 * Inspectable report over observation pattern provability and bitmask states.
 */
export class PatternScopeReport {
  public readonly activeSlices: ReadonlySet<WagerObservationSlice>;
  public readonly provenMask: number;
  public readonly partialMask: number;
  public readonly blockedMask: number;

  constructor(activeSlices?: ReadonlySet<WagerObservationSlice>) {
    this.activeSlices = activeSlices ?? activeWagerObservationSlices();

    let proven = 0;
    let partial = 0;
    let blocked = 0;

    for (const row of PATTERN_SCOPE_MATRIX) {
      const bit = PATTERN_CLASS_BITS[row.pattern] ?? 0;
      const prov = this.evaluateProvability(row.pattern);
      if (prov === "proven") proven |= 1 << bit;
      else if (prov === "partial") partial |= 1 << bit;
      else blocked |= 1 << bit;
    }

    this.provenMask = proven >>> 0;
    this.partialMask = partial >>> 0;
    this.blockedMask = blocked >>> 0;
  }

  public evaluateProvability(pattern: PatternClass): PatternProvability {
    const row = PATTERN_SCOPE_MATRIX.find((r) => r.pattern === pattern);
    if (!row) return "blocked";
    const hasAll = row.requiredSlices.every((s) => this.activeSlices.has(s));
    if (!hasAll) return "blocked";
    return row.provability;
  }

  public toTableRows(): PatternScopeTableRow[] {
    return PATTERN_SCOPE_MATRIX.map((row) => {
      const bit = PATTERN_CLASS_BITS[row.pattern] ?? 0;
      const prov = this.evaluateProvability(row.pattern);
      return {
        Pattern: row.pattern,
        Bit: `bit ${bit} (${formatHex32(1 << bit)})`,
        Provability: prov.toUpperCase(),
        "Required Slices": row.requiredSlices.join(", "),
        Limitation: row.limitation,
      };
    });
  }

  public inspectTable(options?: { colors?: boolean }): string {
    const props = [
      "Pattern",
      "Bit",
      "Provability",
      "Required Slices",
      "Limitation",
    ];
    return Bun.inspect.table(this.toTableRows(), props, options);
  }

  public [Bun.inspect.custom](
    _depth: number,
    options: { colors?: boolean } = {},
  ): string {
    const active = Array.from(this.activeSlices).join(", ") || "(none)";
    const header = [
      `PatternScopeReport (activeSlices=[${active}])`,
      `  • Proven Mask : ${formatHex32(this.provenMask)} (${popcount32(this.provenMask)} patterns)`,
      `  • Partial Mask: ${formatHex32(this.partialMask)} (${popcount32(this.partialMask)} patterns)`,
      `  • Blocked Mask: ${formatHex32(this.blockedMask)} (${popcount32(this.blockedMask)} patterns)`,
    ].join("\n");

    return `${header}\n\n${this.inspectTable(options)}`;
  }
}

export interface CompositeWagerInspectionOptions {
  readonly colors?: boolean;
  readonly groupLabel?: string;
}

/**
 * Composite report combining wager metrics, observation patterns, and bitwise flags.
 */
export class CompositeWagerInspectionReport {
  public readonly wagerColumnsReport?: InspectableWagerColumns;
  public readonly patternScopeReport: PatternScopeReport;
  public readonly bitsetArrayReport?: InspectableBitSetArray;
  public readonly bitset32Report?: InspectableBitSet32;

  constructor(options: {
    readonly wagerColumns?: WagerColumns;
    readonly groupLabel?: string;
    readonly activeSlices?: ReadonlySet<WagerObservationSlice>;
    readonly bitsetWords?: Uint32Array;
    readonly bitset32?: number;
    readonly flagDefinitions?: Readonly<Record<number, string>>;
  }) {
    if (options.wagerColumns) {
      this.wagerColumnsReport = new InspectableWagerColumns(
        options.wagerColumns,
        options.groupLabel ?? "Group",
      );
    }
    this.patternScopeReport = new PatternScopeReport(options.activeSlices);
    if (options.bitsetWords) {
      this.bitsetArrayReport = new InspectableBitSetArray(
        options.bitsetWords,
        undefined,
        options.flagDefinitions,
      );
    }
    if (options.bitset32 !== undefined) {
      this.bitset32Report = new InspectableBitSet32(
        options.bitset32,
        options.flagDefinitions,
      );
    }
  }

  public [Bun.inspect.custom](
    depth: number,
    options: { colors?: boolean } = {},
  ): string {
    const sections: string[] = [
      "=== SPORTSDESK OPERATOR COMPOSITE INSPECTION ===",
    ];

    if (this.wagerColumnsReport) {
      sections.push("\n[1] WAGER METRICS BY GROUP (COLUMNAR):");
      sections.push(
        this.wagerColumnsReport[Bun.inspect.custom](depth, options),
      );
    }

    sections.push("\n[2] PATTERN OBSERVATION PROVABILITY MATRIX:");
    sections.push(this.patternScopeReport[Bun.inspect.custom](depth, options));

    if (this.bitsetArrayReport) {
      sections.push("\n[3] BITWISE FLAGS / ARENA BITSET:");
      sections.push(this.bitsetArrayReport[Bun.inspect.custom](depth, options));
    }

    if (this.bitset32Report) {
      sections.push("\n[4] BITSET32 WORD:");
      sections.push(this.bitset32Report[Bun.inspect.custom](depth, options));
    }

    return sections.join("\n");
  }
}
