/**
 * @file lib/ppm_price_math.ts
 * @description What a displayed price is worth — and what it is not.
 *
 * PPM formats decimal odds to American integers with `oddsService`:
 *
 *   A = decimal - 1
 *   A < c ? floor(-100/A + d) : floor(100*A + d)     d = 0.5, c = 100/100.5
 *
 * The `floor` is the important part: the display is a *quantized projection* of
 * the true price. Measured over decimal 1.01–20.00, one displayed value covers a
 * band of true decimals whose implied probabilities differ by up to **0.25
 * percentage points**, worst at ±100 (-110 covers 1.9050–1.9132, 0.226 points;
 * +100 covers 1.9950–2.0050, 0.250 points).
 *
 * So a desk that reads prices off the screen is reading a rounded number: its
 * overround, hold and CLV inherit that band. This module keeps the band
 * attached instead of pretending the integer is exact.
 */

export type PpmPriceErrorCode = "invalid_decimal" | "invalid_american";

export class PpmPriceError extends Error {
  readonly code: PpmPriceErrorCode;

  constructor(code: PpmPriceErrorCode, message: string) {
    super(message);
    this.name = "PpmPriceError";
    this.code = code;
  }
}

/** The formatter's epsilon when `ROUND_US_ODDS_DOWN` is false (the PPM config). */
const DISPLAY_EPSILON = 0.5;
/** The favourite/underdog switch point in `decimal - 1` space. */
const DISPLAY_SWITCH = 100 / (100 + DISPLAY_EPSILON);

function requireDecimal(decimal: number): void {
  if (!Number.isFinite(decimal) || decimal <= 1) {
    throw new PpmPriceError(
      "invalid_decimal",
      `decimal odds must be a finite number > 1 (got ${String(decimal)})`,
    );
  }
}

function requireAmerican(american: number): void {
  if (!Number.isInteger(american) || Math.abs(american) < 100) {
    throw new PpmPriceError(
      "invalid_american",
      `American odds must be an integer with |x| >= 100 (got ${String(american)})`,
    );
  }
}

/** Implied probability of a decimal price. */
export function impliedProbability(decimal: number): number {
  requireDecimal(decimal);
  return 1 / decimal;
}

/** Book margin of a market: sum of implied probabilities minus 1. */
export function overround(decimals: readonly number[]): number {
  if (decimals.length < 2) {
    throw new PpmPriceError(
      "invalid_decimal",
      "a market needs at least two outcomes",
    );
  }
  let sum = 0;
  for (const decimal of decimals) sum += impliedProbability(decimal);
  return sum - 1;
}

/**
 * Multiplicative de-vig: normalise implied probabilities to sum to 1. Keeps the
 * shape of the book's opinion and removes its margin. Not the only de-vig
 * method (Shin, additive, power exist), but the one that is honest about what
 * it does: it assumes the margin is proportional to probability.
 */
export function devigMultiplicative(decimals: readonly number[]): number[] {
  if (decimals.length < 2) {
    throw new PpmPriceError(
      "invalid_decimal",
      "a market needs at least two outcomes",
    );
  }
  let sum = 0;
  for (const decimal of decimals) sum += impliedProbability(decimal);
  return decimals.map((decimal) => 1 / decimal / sum);
}

/**
 * Reproduces the feed's decimal → American display, including the floor. Used
 * to test the band below against the real formatter rather than a paraphrase.
 */
export function americanDisplay(decimal: number): number {
  requireDecimal(decimal);
  const profit = Number((decimal - 1).toFixed(6));
  const raw =
    profit < DISPLAY_SWITCH
      ? -100 / profit + DISPLAY_EPSILON
      : 100 * profit + DISPLAY_EPSILON;
  return Math.floor(raw);
}

export interface DisplayBand {
  /** Decimal prices at or above this map to `american`. */
  readonly minDecimal: number;
  /** Decimal prices strictly below this map to `american`. */
  readonly maxDecimal: number;
  readonly minProbability: number;
  readonly maxProbability: number;
  /** maxProbability - minProbability, in probability points. */
  readonly spreadPoints: number;
}

/**
 * The set of true decimals that render as `american`. Inverting the floor:
 *
 *   favourite:  a <= -100/A + d < a + 1
 *   underdog:   a <= 100A + d < a + 1   (A = decimal - 1)
 */
export function displayBand(american: number): DisplayBand {
  requireAmerican(american);
  let minDecimal: number;
  let maxDecimal: number;
  if (american <= -100) {
    minDecimal = 1 + 100 / (DISPLAY_EPSILON - american);
    maxDecimal = 1 + 100 / -(american + DISPLAY_EPSILON);
  } else {
    minDecimal = 1 + (american - DISPLAY_EPSILON) / 100;
    maxDecimal = 1 + (american + DISPLAY_EPSILON) / 100;
  }
  const minProbability = 1 / maxDecimal;
  const maxProbability = 1 / minDecimal;
  return {
    minDecimal,
    maxDecimal,
    minProbability,
    maxProbability,
    spreadPoints: (maxProbability - minProbability) * 100,
  };
}

/**
 * Worst-case implied-probability spread of any displayed price: 0.2500 points
 * at ±100 (closed form 0.2500016), where the band is one American unit wide in
 * decimal space. Exposed so callers can state the error of a display-sourced
 * book instead of implying it is exact.
 */
export const MAX_DISPLAY_SPREAD_POINTS = 0.2501;
