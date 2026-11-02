/**
 * Score-payload line values: which side the `Spread` belongs to, and what a wager's line is worth.
 *
 * Two observed games, 2026-11-02:
 *
 *   Clippers vs Warriors      Spread -2     Favorito "Golden St Warriors"     (Team2)
 *   Eagles   vs Commanders    Spread -5.5   Favorito "Washington Commanders"  (Team2)
 *
 * In both, `Spread` is negative and `Favorito` is `Team2ID`. Two rules fit that data:
 * "`Spread` is Team2's line" and "`Favorito` decides". They agree here, and they need not: if
 * `Team2ID` were the underdog, a `Favorito`-first rule would still work while a Team2-relative rule
 * would carry the sign through. This module uses the Team2-relative reading — it needs one field
 * instead of two — and reports whether `Favorito` agrees, so a disagreement is visible rather than
 * silently resolved by whichever rule ran first.
 *
 * The sign convention for `lineValue`: **positive means the bettor got the better number.**
 */

export interface ScoreGameLine {
  /** `undefined` when the payload omitted the field. */
  readonly spread?: number | null;
  readonly favorito?: string | null;
  readonly team1Id: string;
  readonly team2Id: string;
}

export interface ResolvedSpreads {
  /** `Spread` is Team2's line; Team1 gets the negation. */
  readonly team1: number | null;
  readonly team2: number | null;
  /** Whether `Favorito` names Team2 — the cross-check, not the source of the sign. */
  readonly favoritoIsTeam2: boolean | null;
  /** `null` when either signal is absent; false means a `Favorito`-first rule would differ. */
  readonly agrees: boolean | null;
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" &&
        value.trim() !== "" &&
        Number.isFinite(Number(value))
      ? Number(value)
      : null;

const same = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export function resolveSpreads(game: ScoreGameLine): ResolvedSpreads {
  const spread = num(game.spread);
  if (spread === null) {
    return { team1: null, team2: null, favoritoIsTeam2: null, agrees: null };
  }
  const favorito = (game.favorito ?? "").trim();
  const favoritoIsTeam2 =
    favorito === ""
      ? null
      : same(favorito, game.team2Id)
        ? true
        : same(favorito, game.team1Id)
          ? false
          : null;
  // Negative spreads are favourites; the favourite is whichever team `Spread` names.
  const spreadTeamIsFavorite = spread < 0;
  const agrees =
    favoritoIsTeam2 === null ? null : spreadTeamIsFavorite === favoritoIsTeam2;
  return {
    team1: -spread,
    team2: spread,
    favoritoIsTeam2,
    agrees,
  };
}

/**
 * How much better or worse the bettor's number is than the current line.
 *
 * `wagerLine - currentSpread`, so with the bettor holding Eagles +3.5 while the market is +5.5 the
 * result is **-2**: the market moved past them, which is a loss of value, not a gain.
 */
export function lineValue(
  wagerLine: number | null,
  currentSpread: number | null,
): number | null {
  if (wagerLine === null || currentSpread === null) return null;
  return wagerLine - currentSpread;
}

/**
 * The bet's result against the line at the current score. Positive means covering.
 *
 * `(teamScore - opponentScore) + spread`, with `spread` from the bettor's own side.
 */
export function margin(
  teamScore: number | null,
  opponentScore: number | null,
  spread: number | null,
): number | null {
  if (teamScore === null || opponentScore === null || spread === null) {
    return null;
  }
  return teamScore - opponentScore + spread;
}
