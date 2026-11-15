/**
 * @file tests/ppm_join_guard.test.ts
 * @description The gate has to fail loudly: a soft warning here would let a
 * slate-id space mismatch price the wrong rows for weeks.
 */
import { describe, expect, test } from "bun:test";
import {
  PpmJoinError,
  assertSlateSpaceOverlap,
} from "../lib/ppm_join_guard.ts";

describe("assertSlateSpaceOverlap", () => {
  test("passes when every odds slate id is known", () => {
    const result = assertSlateSpaceOverlap([1, 2, 3], [1, 2]);
    expect(result).toEqual({ overlap: 2, total: 2, ratio: 1 });
  });

  test("passes at the 95% boundary", () => {
    const snapshot = Array.from({ length: 20 }, (_, i) => i + 1);
    const odds = [...snapshot.slice(0, 19), 999]; // 19/20 = 95%
    expect(assertSlateSpaceOverlap(snapshot, odds).ratio).toBeCloseTo(0.95);
  });

  test("throws with a code below the threshold", () => {
    const snapshot = [1, 2, 3, 4];
    const odds = [1, 2, 90, 91]; // 50%
    expect(() => assertSlateSpaceOverlap(snapshot, odds)).toThrow(PpmJoinError);
    try {
      assertSlateSpaceOverlap(snapshot, odds);
    } catch (error) {
      expect((error as PpmJoinError).code).toBe("slate_id_space_mismatch");
      expect((error as PpmJoinError).message).toContain("2/4");
    }
  });

  test("empty odds input is a no-op, not a failure", () => {
    expect(assertSlateSpaceOverlap([1, 2, 3], [])).toEqual({
      overlap: 0,
      total: 0,
      ratio: 1,
    });
  });

  test("duplicate slate ids count once", () => {
    const result = assertSlateSpaceOverlap([1, 2], [2, 2, 2, 9], 0.4);
    expect(result).toEqual({ overlap: 1, total: 2, ratio: 0.5 });
  });

  test("rejects an out-of-range threshold", () => {
    expect(() => assertSlateSpaceOverlap([1], [1], 0)).toThrow(RangeError);
    expect(() => assertSlateSpaceOverlap([1], [1], 1.5)).toThrow(RangeError);
  });
});
