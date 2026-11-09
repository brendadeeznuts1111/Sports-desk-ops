/**
 * @file tests/bitwise_pattern_inspect.test.ts
 * @description Verifies first-class Bun.inspect and Bun.inspect.table custom reporting
 * across bitwise bitsets, columnar wager arrays, and observation pattern scopes.
 */

import { describe, expect, test } from "bun:test";
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
} from "../lib/bitwise_pattern_inspect.ts";
import {
  inspectSummary,
  inspectColumns,
  inspectKeys,
  inspectWagerColumns,
  inspectBitSet32,
  inspectBitSetTable,
  inspectPatternScopeTable,
  inspectCompositeWagerReport,
} from "../lib/inspect.ts";
import { toColumnar, toInspectableColumnar } from "../lib/wagers_report.ts";
import { buildSqliteSchemaReportForTable } from "../lib/schema_report.ts";
import { COMBO_LEGS_SCHEMA } from "../lib/sqlite_schema_registry.ts";
import type { WagerObservationSlice } from "../lib/fantasy402_wager_universe_scope.ts";

describe("bitwise primitive utilities", () => {
  test("popcount32 calculates exact bit counts across 32-bit range", () => {
    expect(popcount32(0)).toBe(0);
    expect(popcount32(1)).toBe(1);
    expect(popcount32(0b10101010)).toBe(4);
    expect(popcount32(0xffffffff)).toBe(32);
    expect(popcount32(0x80000000)).toBe(1);
    expect(popcount32(0x7fffffff)).toBe(31);
    expect(popcount32(0x12345678)).toBe(13);
  });

  test("formatBinary32 formats 8 grouped nibbles", () => {
    expect(formatBinary32(0)).toBe("0000_0000_0000_0000_0000_0000_0000_0000");
    expect(formatBinary32(0b1011)).toBe(
      "0000_0000_0000_0000_0000_0000_0000_1011",
    );
    expect(formatBinary32(0xffffffff)).toBe(
      "1111_1111_1111_1111_1111_1111_1111_1111",
    );
    expect(formatBinary32(0xa5a5a5a5, " ")).toBe(
      "1010 0101 1010 0101 1010 0101 1010 0101",
    );
  });

  test("formatHex32 outputs canonical 0x-prefixed 8-character hex", () => {
    expect(formatHex32(0)).toBe("0x00000000");
    expect(formatHex32(42)).toBe("0x0000002a");
    expect(formatHex32(0xffffffff)).toBe("0xffffffff");
    expect(formatHex32(-1)).toBe("0xffffffff");
  });

  test("extractBitIndices32 returns zero-based bit offsets", () => {
    expect(extractBitIndices32(0)).toEqual([]);
    expect(extractBitIndices32(1)).toEqual([0]);
    expect(extractBitIndices32(0b10101)).toEqual([0, 2, 4]);
    expect(extractBitIndices32(1 << 31)).toEqual([31]);
  });
});

describe("InspectableBitSet32 custom inspect & table integration", () => {
  test("inspects named channel behavior flags", () => {
    // 0: INTERNET, 1: GSLIVE, 3: ALERT_MIRROR -> 0b1011 = 11
    const bitset = new InspectableBitSet32(11, CHANNEL_BEHAVIOR_FLAG_NAMES);

    expect(bitset.popcount).toBe(3);
    expect(bitset.hex).toBe("0x0000000b");
    expect(bitset.has(0)).toBe(true);
    expect(bitset.has(1)).toBe(true);
    expect(bitset.has(2)).toBe(false);
    expect(bitset.has(3)).toBe(true);
    expect(bitset.hasFlag("INTERNET")).toBe(true);
    expect(bitset.hasFlag("GSLIVE")).toBe(true);
    expect(bitset.hasFlag("GSBUILDER")).toBe(false);
    expect(bitset.activeFlags).toEqual(["INTERNET", "GSLIVE", "ALERT_MIRROR"]);

    const text = Bun.inspect(bitset, { colors: false });
    expect(text).toBe(
      "BitSet32(0x0000000b, popcount=3, flags=[INTERNET, GSLIVE, ALERT_MIRROR])",
    );

    const colored = Bun.inspect(bitset, { colors: true });
    expect(colored).toContain("\u001b[36mBitSet32\u001b[39m");
    expect(colored).toContain("\u001b[33m0x0000000b\u001b[39m");
  });

  test("renders bitset as table row for Bun.inspect.table", () => {
    const bitset = new InspectableBitSet32(0x05, ROUTE_FLAG_NAMES);
    const row = bitset.toTableRow("route_0");

    expect(row.label).toBe("route_0");
    expect(row.hex).toBe("0x00000005");
    expect(row.popcount).toBe(2);
    expect(row.flags).toBe("NEW_TICKET | CHANGED_TICKET");

    const table = Bun.inspect.table(
      [row],
      ["label", "hex", "popcount", "flags"],
      {
        colors: false,
      },
    );
    expect(table).toContain("route_0");
    expect(table).toContain("0x00000005");
    expect(table).toContain("NEW_TICKET | CHANGED_TICKET");
  });

  test("inspectBitSet32 convenience helper formats properly", () => {
    const output = inspectBitSet32(
      (1 << 0) | (1 << 6),
      WAGER_STATE_FLAG_NAMES,
      { colors: false },
    );
    expect(output).toContain("BitSet32(0x00000041, popcount=2");
    expect(output).toContain("PENDING, CLV_ELIGIBLE");
  });
});

describe("InspectableBitSetArray custom inspect & table integration", () => {
  test("measures capacity, popcount, and density across dense words", () => {
    const words = new Uint32Array(4);
    words[0] = 0b1111; // 4 bits
    words[2] = 0b0011; // 2 bits
    // total bits = 128, popcount = 6 -> density = (6/128) * 100 = 4.69%

    const arena = new InspectableBitSetArray(words, 128, ROUTE_FLAG_NAMES);
    expect(arena.wordsCount).toBe(4);
    expect(arena.capacityBits).toBe(128);
    expect(arena.popcount).toBe(6);
    expect(arena.densityPercent).toBe("4.69%");

    expect(arena.has(0)).toBe(true);
    expect(arena.has(1)).toBe(true);
    expect(arena.has(4)).toBe(false);
    expect(arena.has(64)).toBe(true); // word 2, bit 0 -> 2*32 + 0 = 64
    expect(arena.has(65)).toBe(true); // word 2, bit 1 -> 65
    expect(arena.has(66)).toBe(false);

    // Test mutating bit operations
    arena.setBit(100);
    expect(arena.has(100)).toBe(true);
    arena.clearBit(100);
    expect(arena.has(100)).toBe(false);
  });

  test("inspectTable generates a box table over non-zero words", () => {
    const words = new Uint32Array(8);
    words[1] = 0x01;
    words[5] = 0x03;

    const arena = new InspectableBitSetArray(
      words,
      256,
      WAGER_STATE_FLAG_NAMES,
    );
    const table = arena.inspectTable({ colors: false });

    expect(table).toContain("word");
    expect(table).toContain("bitRange");
    expect(table).toContain("[32..63]");
    expect(table).toContain("[160..191]");
    expect(table).toContain("0x00000001");
    expect(table).toContain("0x00000003");
  });

  test("Bun.inspect(arena) includes summary header and table", () => {
    const words = new Uint32Array([0x07, 0x00]);
    const arena = new InspectableBitSetArray(words, 64, ROUTE_FLAG_NAMES);
    const inspected = Bun.inspect(arena, { colors: false });

    expect(inspected).toContain(
      "BitSetArray(words=2, capacity=64 bits, popcount=3",
    );
    expect(inspected).toContain("[0..31]");
    expect(inspected).toContain("NEW_TICKET, GONE_TICKET, CHANGED_TICKET");
  });

  test("inspectBitSetTable helper renders directly", () => {
    const words = new Uint32Array([0x0f]);
    const rendered = inspectBitSetTable(words, {
      colors: false,
      flagDefinitions: CHANNEL_BEHAVIOR_FLAG_NAMES,
    });
    expect(rendered).toContain("0x0000000f");
    expect(rendered).toContain("INTERNET, GSLIVE, GSBUILDER, ALERT_MIRROR");
  });
});

describe("InspectableWagerColumns custom inspect & table integration", () => {
  test("computes grand totals and formats table with currency & commas", () => {
    const buckets = [
      {
        state: "Football",
        count: 1250,
        legsTotal: 2500,
        riskDollars: 50000.5,
        toWinDollars: 45000.25,
        resultDollars: 12000.0,
      },
      {
        state: "Basketball",
        count: 750,
        legsTotal: 1500,
        riskDollars: 25000.0,
        toWinDollars: 22000.0,
        resultDollars: -5000.0,
      },
    ];

    const inspectable = toInspectableColumnar(buckets, "Sport");

    expect(inspectable.totalCount).toBe(2000);
    expect(inspectable.totalLegs).toBe(4000);
    expect(inspectable.totalRisk).toBe(75000.5);
    expect(inspectable.totalToWin).toBe(67000.25);
    expect(inspectable.totalResult).toBe(7000.0);

    const rows = inspectable.toTableRows();
    expect(rows.length).toBe(3); // 2 sports + TOTAL

    expect(rows[0]!["Sport"]).toBe("Football");
    expect(rows[0]!["Count"]).toBe("1,250");
    expect(rows[0]!["Risk ($)"]).toBe("$50000.50");
    expect(rows[0]!["Legs/Wager"]).toBe("2.00");

    expect(rows[2]!["Sport"]).toBe("TOTAL");
    expect(rows[2]!["Count"]).toBe("2,000");
    expect(rows[2]!["Risk ($)"]).toBe("$75000.50");

    const table = inspectable.inspectTable({ colors: false });
    expect(table).toContain("Sport");
    expect(table).toContain("Football");
    expect(table).toContain("Basketball");
    expect(table).toContain("TOTAL");
    expect(table).toContain("$75000.50");

    const fullInspect = Bun.inspect(inspectable, { colors: false });
    expect(fullInspect).toContain(
      "WagerColumns(2 groups, 2000 wagers, risk=$75000.50)",
    );
    expect(fullInspect).toContain("TOTAL");
  });

  test("inspectWagerColumns helper renders clean table", () => {
    const col = toColumnar([
      {
        state: "win",
        count: 10,
        legsTotal: 20,
        riskDollars: 100,
        toWinDollars: 90,
        resultDollars: 90,
      },
    ]);
    const direct = new InspectableWagerColumns(col, "State");
    expect(direct.totalCount).toBe(10);
    const table = inspectWagerColumns(col, "State", { colors: false });
    expect(table).toContain("State");
    expect(table).toContain("win");
    expect(table).toContain("TOTAL");
    expect(table).toContain("$100.00");
  });
});

describe("PatternScopeReport custom inspect & table integration", () => {
  test("exposes canonical pattern bit mapping and flag names", () => {
    expect(PATTERN_CLASS_BITS.pending_price_spike).toBe(0);
    expect(PATTERN_CLASS_BITS.cross_source_arb).toBe(1);
    expect(PATTERN_FLAG_NAMES[0]).toBe("pending_price_spike");
    expect(PATTERN_FLAG_NAMES[1]).toBe("cross_source_arb");
  });

  test("evaluates pattern provability against pending observation slice", () => {
    const report = new PatternScopeReport(new Set(["pending_at_poll"]));

    // pending_price_spike is PROVEN (bit 0 -> 1)
    // cross_source_arb is PARTIAL (bit 1 -> 2)
    // customer_stake_timing_cluster is PARTIAL (bit 2 -> 4)
    // settlement patterns are BLOCKED (bits 3, 4, 5, 6 -> 8 + 16 + 32 + 64 = 120)
    expect(report.provenMask).toBe(1 << 0);
    expect(report.partialMask).toBe((1 << 1) | (1 << 2));
    expect(report.blockedMask).toBe((1 << 3) | (1 << 4) | (1 << 5) | (1 << 6));

    const rows = report.toTableRows();
    expect(rows.length).toBe(7);

    const priceSpike = rows.find((r) => r.Pattern === "pending_price_spike");
    expect(priceSpike?.Provability).toBe("PROVEN");
    expect(priceSpike?.Bit).toContain("bit 0");

    const winLoss = rows.find((r) => r.Pattern === "win_loss_rate");
    expect(winLoss?.Provability).toBe("BLOCKED");

    const table = report.inspectTable({ colors: false });
    expect(table).toContain("Pattern");
    expect(table).toContain("Provability");
    expect(table).toContain("pending_price_spike");
    expect(table).toContain("PROVEN");

    const inspected = Bun.inspect(report, { colors: false });
    expect(inspected).toContain(
      "PatternScopeReport (activeSlices=[pending_at_poll])",
    );
    expect(inspected).toContain("Proven Mask");
    expect(inspected).toContain("0x00000001 (1 patterns)");
  });

  test("unlocks settlement patterns with settlement_history slice", () => {
    const slices: ReadonlySet<WagerObservationSlice> = new Set([
      "pending_at_poll",
      "settlement_history",
    ]);
    const report = new PatternScopeReport(slices);

    // With settlement_history: win_loss_rate, cancel_rate, parlay_leg_completion, parlay_buyout_audit become PROVEN
    expect(report.evaluateProvability("win_loss_rate")).toBe("proven");
    expect(report.evaluateProvability("cancel_rate")).toBe("proven");
    expect(report.evaluateProvability("parlay_leg_completion")).toBe("proven");
    expect(report.evaluateProvability("parlay_buyout_audit")).toBe("proven");
    expect(report.blockedMask).toBe(0); // All 7 are either proven or partial
  });

  test("inspectPatternScopeTable helper formats table directly", () => {
    const table = inspectPatternScopeTable(new Set(["pending_at_poll"]), {
      colors: false,
    });
    expect(table).toContain("pending_price_spike");
    expect(table).toContain("PROVEN");
  });
});

describe("CompositeWagerInspectionReport unified operator report", () => {
  test("combines wager metrics, observation patterns, and bitwise flags into one view", () => {
    const wagerColumns = toColumnar([
      {
        state: "GSLIVE",
        count: 50,
        legsTotal: 100,
        riskDollars: 5000.0,
        toWinDollars: 4500.0,
        resultDollars: 1000.0,
      },
    ]);
    const bitsetWords = new Uint32Array([0b1101]); // bits 0, 2, 3

    const composite = new CompositeWagerInspectionReport({
      wagerColumns,
      groupLabel: "Channel",
      activeSlices: new Set(["pending_at_poll"]),
      bitsetWords,
      bitset32: 0x2a,
      flagDefinitions: CHANNEL_BEHAVIOR_FLAG_NAMES,
    });

    const output = Bun.inspect(composite, { colors: false });

    expect(output).toContain("SPORTSDESK OPERATOR COMPOSITE INSPECTION");
    expect(output).toContain("[1] WAGER METRICS BY GROUP (COLUMNAR):");
    expect(output).toContain("Channel");
    expect(output).toContain("GSLIVE");
    expect(output).toContain("$5000.00");
    expect(output).toContain("[2] PATTERN OBSERVATION PROVABILITY MATRIX:");
    expect(output).toContain("pending_price_spike");
    expect(output).toContain("[3] BITWISE FLAGS / ARENA BITSET:");
    expect(output).toContain("[4] BITSET32 WORD:");
    expect(output).toContain("0x0000002a");

    const directHelper = inspectCompositeWagerReport(
      {
        wagerColumns,
        activeSlices: new Set(["pending_at_poll"]),
      },
      { colors: false },
    );
    expect(directHelper).toContain("SPORTSDESK OPERATOR COMPOSITE INSPECTION");
  });
});

describe("lib/inspect.ts exports and schema inspect regression safety", () => {
  test("preserves inspectSummary, inspectColumns, inspectKeys contracts", () => {
    const report = buildSqliteSchemaReportForTable(COMBO_LEGS_SCHEMA.name)!;
    expect(report).toBeDefined();

    const summaryTable = inspectSummary(report.summary);
    expect(summaryTable).toContain("combo_legs");

    const columnsTable = inspectColumns(report.columns);
    expect(columnsTable).toContain("combo_legs");
    expect(columnsTable).toContain("canonical_combo_id");

    const keysTable = inspectKeys(report.keys);
    expect(keysTable).toContain("combo_legs");
  });
});
