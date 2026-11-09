import type { ColumnRow, KeyRow, TableSummary } from "./schema_report.ts";
import type { WagerColumns } from "./wagers_report.ts";
import type { WagerObservationSlice } from "./fantasy402_wager_universe_scope.ts";
import {
  InspectableBitSet32,
  InspectableBitSetArray,
  InspectableWagerColumns,
  PatternScopeReport,
  CompositeWagerInspectionReport,
  CHANNEL_BEHAVIOR_FLAG_NAMES,
  ROUTE_FLAG_NAMES,
  WAGER_STATE_FLAG_NAMES,
  PATTERN_FLAG_NAMES,
  PATTERN_CLASS_BITS,
  popcount32,
  formatBinary32,
  formatHex32,
  extractBitIndices32,
} from "./bitwise_pattern_inspect.ts";

export {
  InspectableBitSet32,
  InspectableBitSetArray,
  InspectableWagerColumns,
  PatternScopeReport,
  CompositeWagerInspectionReport,
  CHANNEL_BEHAVIOR_FLAG_NAMES,
  ROUTE_FLAG_NAMES,
  WAGER_STATE_FLAG_NAMES,
  PATTERN_FLAG_NAMES,
  PATTERN_CLASS_BITS,
  popcount32,
  formatBinary32,
  formatHex32,
  extractBitIndices32,
};

export function inspectTable<const R extends Record<string, unknown>>(
  rows: readonly R[],
  props?: readonly (keyof R & string)[],
  opts?: { colors?: boolean },
): string {
  return Bun.inspect.table(rows as R[], props as string[] | undefined, opts);
}

export const inspectSummary = (rows: readonly TableSummary[]) =>
  inspectTable(rows, ["table", "domain", "columns", "keys", "appendOnly"], {
    colors: true,
  });

export const inspectColumns = (rows: readonly ColumnRow[]) =>
  inspectTable(
    rows,
    ["table", "column", "sqlType", "kind", "nullable", "keyRoles"],
    { colors: true },
  );

export const inspectKeys = (rows: readonly KeyRow[]) =>
  inspectTable(rows, ["table", "keyKind", "name", "columns", "partial"], {
    colors: true,
  });

/**
 * Render columnar typed-array wager metrics as an aligned terminal table via `Bun.inspect.table`.
 */
export function inspectWagerColumns(
  columns: WagerColumns,
  groupLabel = "Group",
  opts?: { colors?: boolean },
): string {
  const inspector = new InspectableWagerColumns(columns, groupLabel);
  return inspector.inspectTable(opts);
}

/**
 * Inspect a 32-bit bitset with named flag decoding, hex, binary, and popcount.
 */
export function inspectBitSet32(
  value: number,
  flagDefinitions?: Readonly<Record<number, string>>,
  opts?: { colors?: boolean },
): string {
  const item = new InspectableBitSet32(value, flagDefinitions);
  return item[Bun.inspect.custom](0, opts);
}

/**
 * Render an ASCII/box table of dense bitset words and active flags via `Bun.inspect.table`.
 */
export function inspectBitSetTable(
  words: Uint32Array,
  opts?: {
    colors?: boolean;
    flagDefinitions?: Readonly<Record<number, string>>;
  },
): string {
  const arena = new InspectableBitSetArray(
    words,
    undefined,
    opts?.flagDefinitions,
  );
  return arena.inspectTable(opts);
}

/**
 * Render a provability and observation slice table for bet patterns via `Bun.inspect.table`.
 */
export function inspectPatternScopeTable(
  activeSlices?: ReadonlySet<WagerObservationSlice>,
  opts?: { colors?: boolean },
): string {
  const report = new PatternScopeReport(activeSlices);
  return report.inspectTable(opts);
}

/**
 * Render a composite operator inspection report covering wagers, patterns, and bitwise flags.
 */
export function inspectCompositeWagerReport(
  options: ConstructorParameters<typeof CompositeWagerInspectionReport>[0],
  opts?: { colors?: boolean },
): string {
  const composite = new CompositeWagerInspectionReport(options);
  return composite[Bun.inspect.custom](0, opts);
}
