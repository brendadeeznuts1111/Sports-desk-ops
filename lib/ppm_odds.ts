/**
 * @file lib/ppm_odds.ts
 * @description American-odds conversion and price-cell extraction.
 *
 * PPM renders prices as American integers (`-125`, `+150`) inside a span that
 * only exists when the price is tradeable:
 *
 *   ng-if="!odds.showLock() && !odds.isUnavailable()"
 *
 * and in the bundle `isUnavailable()` is `noMarket() && !hasBet()`. So a missing
 * cell means *no price*, never zero — a zero price is not a thing a book offers,
 * and treating absence as 0 would price a bet at infinite return.
 *
 * This module is the boundary for that text: convert it to decimal, refuse
 * nonsense, and never invent a value for a missing cell.
 */

export type PpmOddsErrorCode = "invalid_american" | "invalid_decimal";

export class PpmOddsError extends Error {
  readonly code: PpmOddsErrorCode;

  constructor(code: PpmOddsErrorCode, message: string) {
    super(message);
    this.name = "PpmOddsError";
    this.code = code;
  }
}

/** American odds are never between -100 and +100. */
const AMERICAN_FLOOR = 100;

/**
 * Converts American odds to decimal (European) odds.
 *
 *   -125 -> 1.80   (risk 125 to win 100)
 *   +150 -> 2.50   (risk 100 to win 150)
 *   ±100 -> 2.00   (even money)
 */
export function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || !Number.isInteger(american)) {
    throw new PpmOddsError(
      "invalid_american",
      `American odds must be an integer (got ${String(american)})`,
    );
  }
  if (american === 0 || Math.abs(american) < AMERICAN_FLOOR) {
    throw new PpmOddsError(
      "invalid_american",
      `American odds must be <= -100 or >= 100 (got ${american})`,
    );
  }
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

/** Inverse of `americanToDecimal`, rounded to the nearest integer. */
export function decimalToAmerican(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1) {
    throw new PpmOddsError(
      "invalid_decimal",
      `decimal odds must be > 1 (got ${String(decimal)})`,
    );
  }
  return decimal >= 2
    ? Math.round((decimal - 1) * 100)
    : -Math.round(100 / (decimal - 1));
}

/**
 * Parses a rendered price string. Accepts the padded text Angular emits
 * (`" -125 "`), an explicit `+`, and the even-money spellings some books use.
 * Anything else throws: a price that cannot be read must not become a price.
 */
export function parseAmericanOdds(text: string): number {
  const normalized = text.replace(/\u2212/g, "-").trim();
  if (/^(ev|even|even money|pk|pick)$/i.test(normalized)) return 2;

  const match = /^([+-]?)(\d{1,5})$/.exec(normalized);
  if (!match) {
    throw new PpmOddsError(
      "invalid_american",
      `not an American price: ${JSON.stringify(text)}`,
    );
  }
  const sign = match[1];
  const magnitude = Number(match[2]);
  // A bare magnitude at or above the floor is positive; below it is not a price.
  const american = sign === "-" ? -magnitude : magnitude;
  return americanToDecimal(american);
}

export interface PpmOddsCell {
  /** The literal text that was read, trimmed. */
  readonly raw: string;
  readonly american: number;
  readonly decimal: number;
}

/**
 * Extracts American prices from captured HTML. Intended for a *rendered* page
 * (Angular fills these spans client-side), so a static fetch of the shell
 * yields nothing — which is the correct result, not an error.
 */
export function extractOddsCellsFromHtml(html: string): PpmOddsCell[] {
  const cells: PpmOddsCell[] = [];
  const pattern = />\s*([+-]\d{3,5})\s*</g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const raw = match[1]!;
    cells.push({
      raw,
      american: Number(raw),
      decimal: americanToDecimal(Number(raw)),
    });
  }
  return cells;
}
