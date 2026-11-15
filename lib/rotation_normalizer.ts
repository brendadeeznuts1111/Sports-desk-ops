/**
 * @file lib/rotation_normalizer.ts
 * @description Specification-Grade Rotation Number Normalizer & Bidirectional Translator
 * for Fantasy402 / DGS Sportsbook and GSLive In-Play Feeds.
 *
 * Formalizes rotation number offsets and provides bidirectional translation between:
 *  1. Pregame Main Board Rotation (#101–#999)
 *  2. 1st Half Derivatives (DGS +1000: #1101–#1999)
 *  3. 2nd Half Derivatives (DGS +2000: #2101–#2999)
 *  4. Alternate Spreads & Totals (DGS +5000: #5000–#5999)
 *  5. Live / In-Play Lines (ASI/DGS #9000 Series: #9000–#9999)
 *  6. Canonical GSLive / Steam Index Keys ("ROT <parentRot>")
 */

export const DGS_ROTATION_OFFSETS = {
  PREGAME_MAIN: 0,
  FIRST_HALF: 1000,
  SECOND_HALF: 2000,
  ALT_SPREAD_TOTAL: 5000,
  LIVE_IN_PLAY: 9000,
} as const;

export type RotationKind =
  | "PREGAME_MAIN"
  | "FIRST_HALF"
  | "SECOND_HALF"
  | "ALT_SPREAD_TOTAL"
  | "LIVE_IN_PLAY"
  | "CUSTOM_PROPOSITION";

export type RotationPeriod = "GAME" | "1H" | "2H" | "LIVE" | "UNKNOWN";

export interface NormalizedRotation {
  readonly rawRotation: number;
  readonly parentRotation: number;
  readonly parentGameNumber: number;
  readonly isAwayTeam: boolean;
  readonly isHomeTeam: boolean;
  readonly rotationKind: RotationKind;
  readonly period: RotationPeriod;
  readonly isLive: boolean;
  readonly isDerivative: boolean;
  readonly isAlt: boolean;
  readonly canonicalRotationKey: `ROT ${number}`;
}

const ROTATION_TOKEN_REGEX = /(?:(?:LIVE\s+#|GameNum\s+|ROT\s+|#))(\d{3,5})\b/i;

/**
 * Normalizes any raw rotation number across pregame, 1H/2H, alternate, and live series
 * into its canonical pregame parent rotation and architectural metadata.
 */
export function normalizeRotationNumber(rawRot: number): NormalizedRotation {
  const rot = Math.trunc(rawRot);
  let parentRotation = rot;
  let rotationKind: RotationKind = "PREGAME_MAIN";
  let period: RotationPeriod = "GAME";
  let isLive = false;
  let isDerivative = false;
  let isAlt = false;

  if (rot >= 9000 && rot < 10000) {
    rotationKind = "LIVE_IN_PLAY";
    period = "LIVE";
    isLive = true;
    isDerivative = true;
    // Map DGS 9000-series offset back to parent if in 9000 + parent range
    parentRotation = rot >= 9100 ? rot - 9000 : rot;
  } else if (rot >= 5000 && rot < 6000) {
    rotationKind = "ALT_SPREAD_TOTAL";
    period = "GAME";
    isAlt = true;
    isDerivative = true;
    parentRotation = rot - 5000;
  } else if (rot >= 2000 && rot < 3000) {
    rotationKind = "SECOND_HALF";
    period = "2H";
    isDerivative = true;
    parentRotation = rot - 2000;
  } else if (rot >= 1000 && rot < 2000) {
    rotationKind = "FIRST_HALF";
    period = "1H";
    isDerivative = true;
    parentRotation = rot - 1000;
  } else if (rot >= 100 && rot < 1000) {
    rotationKind = "PREGAME_MAIN";
    period = "GAME";
    parentRotation = rot;
  } else {
    rotationKind = "CUSTOM_PROPOSITION";
    period = "UNKNOWN";
    parentRotation = rot;
  }

  const isAwayTeam = parentRotation % 2 !== 0;
  const isHomeTeam = !isAwayTeam;
  const parentGameNumber = Math.floor(parentRotation / 2);

  return {
    rawRotation: rot,
    parentRotation,
    parentGameNumber,
    isAwayTeam,
    isHomeTeam,
    rotationKind,
    period,
    isLive,
    isDerivative,
    isAlt,
    canonicalRotationKey: `ROT ${parentRotation}`,
  };
}

/**
 * Bidirectional translator: translate a pregame parent rotation to its Live #9000 counterpart.
 */
export function toLiveRotation(parentRot: number): number {
  const norm = normalizeRotationNumber(parentRot);
  return norm.parentRotation + DGS_ROTATION_OFFSETS.LIVE_IN_PLAY;
}

/**
 * Bidirectional translator: translate a pregame parent rotation to its 1st Half #1000 counterpart.
 */
export function to1hRotation(parentRot: number): number {
  const norm = normalizeRotationNumber(parentRot);
  return norm.parentRotation + DGS_ROTATION_OFFSETS.FIRST_HALF;
}

/**
 * Bidirectional translator: translate a pregame parent rotation to its 2nd Half #2000 counterpart.
 */
export function to2hRotation(parentRot: number): number {
  const norm = normalizeRotationNumber(parentRot);
  return norm.parentRotation + DGS_ROTATION_OFFSETS.SECOND_HALF;
}

/**
 * Bidirectional translator: translate a pregame parent rotation to its Alt Spread/Total #5000 counterpart.
 */
export function toAltRotation(parentRot: number): number {
  const norm = normalizeRotationNumber(parentRot);
  return norm.parentRotation + DGS_ROTATION_OFFSETS.ALT_SPREAD_TOTAL;
}

/**
 * Extract and normalize a rotation number from raw wager text or slip descriptions
 * (e.g. `LIVE #9501`, `GameNum 5501`, `ROT 501`, `KC #451 -3`).
 */
export function extractRotationFromText(
  text: string,
): NormalizedRotation | null {
  if (!text || typeof text !== "string") return null;
  const match = ROTATION_TOKEN_REGEX.exec(text);
  if (!match || !match[1]) return null;
  const rotNum = parseInt(match[1], 10);
  if (!Number.isFinite(rotNum)) return null;
  return normalizeRotationNumber(rotNum);
}

/**
 * Formats any rotation number or string into the canonical `"ROT <parentRot>"` key
 * expected by surveillance indexes (e.g. GsliveSteamIndex).
 */
export function resolveCanonicalRotationKey(
  input: number | string,
): `ROT ${number}` {
  if (typeof input === "number") {
    return normalizeRotationNumber(input).canonicalRotationKey;
  }
  const extracted = extractRotationFromText(input);
  if (extracted !== null) {
    return extracted.canonicalRotationKey;
  }
  const digits = input.match(/\d{3,5}/);
  if (digits !== null) {
    return normalizeRotationNumber(parseInt(digits[0], 10))
      .canonicalRotationKey;
  }
  return "ROT 0";
}

/**
 * Check whether two rotation numbers (across pregame, 1H, 2H, alt, or live)
 * reference the exact same underlying event / team.
 */
export function areRotationsCoincident(
  rotA: number | string,
  rotB: number | string,
): boolean {
  const normA =
    typeof rotA === "number"
      ? normalizeRotationNumber(rotA)
      : extractRotationFromText(rotA);
  const normB =
    typeof rotB === "number"
      ? normalizeRotationNumber(rotB)
      : extractRotationFromText(rotB);

  if (!normA || !normB) return false;
  return normA.parentRotation === normB.parentRotation;
}
