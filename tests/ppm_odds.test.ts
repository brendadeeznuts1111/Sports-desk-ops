/**
 * @file tests/ppm_odds.test.ts
 * @description American odds are a display format with a sign that carries the
 * meaning; the tests pin the conversion, the padding, and the refusals.
 */
import { describe, expect, test } from "bun:test";
import {
  PpmOddsError,
  americanToDecimal,
  decimalToAmerican,
  extractOddsCellsFromHtml,
  parseAmericanOdds,
} from "../lib/ppm_odds.ts";

/** The exact markup captured from the PPM live board. */
const CELL =
  '<span class="emphasis ng-binding ng-scope" ng-if="!odds.showLock() &amp;&amp; !odds.isUnavailable()" ng-class="{ \'kiosk-styles\': odds.showKioskStyles() }"> -125 </span>';

describe("americanToDecimal", () => {
  test("converts favourites and underdogs", () => {
    expect(americanToDecimal(-125)).toBeCloseTo(1.8, 10);
    expect(americanToDecimal(150)).toBeCloseTo(2.5, 10);
    expect(americanToDecimal(-100)).toBe(2);
    expect(americanToDecimal(100)).toBe(2);
    expect(americanToDecimal(-200)).toBe(1.5);
    expect(americanToDecimal(250)).toBe(3.5);
  });

  test("refuses values that are not prices", () => {
    expect(() => americanToDecimal(0)).toThrow(PpmOddsError);
    expect(() => americanToDecimal(-99)).toThrow(PpmOddsError);
    expect(() => americanToDecimal(99)).toThrow(PpmOddsError);
    expect(() => americanToDecimal(1.5)).toThrow(PpmOddsError);
    expect(() => americanToDecimal(Number.NaN)).toThrow(PpmOddsError);
  });
});

describe("parseAmericanOdds", () => {
  test("reads the padded rendered text", () => {
    expect(parseAmericanOdds(" -125 ")).toBeCloseTo(1.8, 10);
    expect(parseAmericanOdds("+150")).toBeCloseTo(2.5, 10);
    expect(parseAmericanOdds("-110\n")).toBeCloseTo(1.909090909, 8);
  });

  test("reads the unicode minus the page may render", () => {
    expect(parseAmericanOdds("\u2212125")).toBeCloseTo(1.8, 10);
  });

  test("reads even-money spellings", () => {
    expect(parseAmericanOdds("EVEN")).toBe(2);
    expect(parseAmericanOdds("pk")).toBe(2);
  });

  test("bare magnitudes are treated as positive and still validated", () => {
    expect(parseAmericanOdds("250")).toBeCloseTo(3.5, 10);
    expect(() => parseAmericanOdds("99")).toThrow(PpmOddsError);
  });

  test("refuses text that is not a price", () => {
    expect(() => parseAmericanOdds("")).toThrow(PpmOddsError);
    expect(() => parseAmericanOdds("1.80")).toThrow(PpmOddsError);
    expect(() => parseAmericanOdds("+1,000")).toThrow(PpmOddsError);
    expect(() => parseAmericanOdds("N/A")).toThrow(PpmOddsError);
  });
});

describe("decimalToAmerican", () => {
  test("round-trips the common range", () => {
    for (const american of [-125, -110, -200, 100, 150, 250, 1000]) {
      expect(decimalToAmerican(americanToDecimal(american))).toBe(american);
    }
  });

  test("refuses decimals at or below 1", () => {
    expect(() => decimalToAmerican(1)).toThrow(PpmOddsError);
    expect(() => decimalToAmerican(0.5)).toThrow(PpmOddsError);
  });
});

describe("extractOddsCellsFromHtml", () => {
  test("reads the live cell", () => {
    expect(extractOddsCellsFromHtml(CELL)).toEqual([
      { raw: "-125", american: -125, decimal: 1.8 },
    ]);
  });

  test("reads several cells and ignores unsigned numbers", () => {
    const html = `${CELL}<span>+150</span><td>2026</td><span> -110 </span>`;
    expect(extractOddsCellsFromHtml(html).map((cell) => cell.american)).toEqual(
      [-125, 150, -110],
    );
  });

  test("an empty render yields no cells rather than a placeholder price", () => {
    expect(extractOddsCellsFromHtml("<div>no odds</div>")).toEqual([]);
  });
});
