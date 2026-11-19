/**
 * @file tests/ppm_price_math.test.ts
 * @description The display is a quantized projection; these tests pin the
 * formatter it comes from, the band it hides, and the market math on top.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_DISPLAY_SPREAD_POINTS,
  PpmPriceError,
  americanDisplay,
  devigMultiplicative,
  displayBand,
  impliedProbability,
  overround,
} from "../lib/ppm_price_math.ts";

describe("americanDisplay reproduces the feed's formatter", () => {
  test("matches the known displays", () => {
    expect(americanDisplay(1.5)).toBe(-200);
    expect(americanDisplay(1.9090909090909092)).toBe(-110);
    expect(americanDisplay(2)).toBe(100);
    expect(americanDisplay(2.5)).toBe(150);
    expect(americanDisplay(3)).toBe(200);
    expect(americanDisplay(1.2)).toBe(-500);
  });

  test("is monotonically non-decreasing in the price", () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (let decimal = 1.01; decimal <= 10; decimal += 0.01) {
      const display = americanDisplay(Number(decimal.toFixed(2)));
      expect(display).toBeGreaterThanOrEqual(previous);
      previous = display;
    }
  });
});

describe("displayBand inverts the floor", () => {
  test("-110 hides a band of true decimals", () => {
    const band = displayBand(-110);
    expect(band.minDecimal).toBeCloseTo(1.90498, 5);
    expect(band.maxDecimal).toBeCloseTo(1.91324, 5);
    expect(band.spreadPoints).toBeCloseTo(0.2265, 2);
  });

  test("+100 hides a band on the other side", () => {
    const band = displayBand(100);
    expect(band.minDecimal).toBeCloseTo(1.995, 5);
    expect(band.maxDecimal).toBeCloseTo(2.005, 5);
    expect(band.spreadPoints).toBeCloseTo(0.25, 2);
  });

  test("prices inside the band map back to that display", () => {
    // The edges are half-open, and the formatter rounds (decimal - 1) to six
    // places before flooring, so only interior points are guaranteed to
    // round-trip. That rounding is also why the band is a band.
    for (const american of [-500, -110, -101, 100, 150, 250]) {
      const band = displayBand(american);
      const mid = (band.minDecimal + band.maxDecimal) / 2;
      expect(americanDisplay(mid)).toBe(american);
      expect(
        americanDisplay(
          band.minDecimal + (band.maxDecimal - band.minDecimal) * 0.25,
        ),
      ).toBe(american);
    }
  });

  test("no display exceeds the documented worst case", () => {
    let worst = 0;
    for (let american = -5000; american <= 5000; american += 1) {
      if (Math.abs(american) < 100) continue;
      worst = Math.max(worst, displayBand(american).spreadPoints);
    }
    expect(worst).toBeLessThanOrEqual(MAX_DISPLAY_SPREAD_POINTS);
  });
});

describe("market math", () => {
  test("implied probability and overround of a two-way market", () => {
    const market = [1.9090909090909092, 1.9090909090909092]; // -110 / -110
    expect(impliedProbability(market[0]!)).toBeCloseTo(0.5238, 4);
    expect(overround(market)).toBeCloseTo(0.0476, 4);
  });

  test("de-vig normalises to one and preserves ordering", () => {
    const fair = devigMultiplicative([1.5, 2.5]); // -200 / +150
    expect(fair.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(fair[0]!).toBeGreaterThan(fair[1]!);
  });

  test("a fair market has zero overround", () => {
    expect(overround([2, 2])).toBeCloseTo(0, 12);
  });

  test("refuses values that are not decimal prices", () => {
    expect(() => impliedProbability(1)).toThrow(PpmPriceError);
    expect(() => impliedProbability(0.5)).toThrow(PpmPriceError);
    expect(() => overround([1.9])).toThrow(PpmPriceError);
    expect(() => devigMultiplicative([])).toThrow(PpmPriceError);
    expect(() => displayBand(50)).toThrow(PpmPriceError);
  });
});
