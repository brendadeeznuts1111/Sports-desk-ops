/**
 * @file game_admin.ts
 * @description "Action on a game", the concept the portal's Game Admin report documents:
 * exposure per game, split by position (Straight / Parlay / Teaser).
 *
 * Source: fantasy402.com User Manual v1.0.280, F.A.Q. #4 — "Where do I see the action I have
 * on a particular game?" The manual says the report summarises action per league, that a
 * dropdown switches Admin (game) to Position (wager shape), and that clicking a figure opens
 * the underlying wagers. This module produces the Position view; the wagers themselves are
 * already the `/api/live-bets` payload.
 *
 * The manual also states the wager-delete control only appears *prior to game time* (F.A.Q. #3),
 * which is why `preGame` is reported as a fact rather than a permission.
 */

import type { LiveBetGame } from "./live_bets.ts";

/** The portal's `WagerType` codes, as used by `Report/Pending` rows. */
export const WAGER_TYPE_LABELS = {
  S: "Straight",
  P: "Parlay",
  T: "Teaser",
  R: "Round Robin",
  I: "If Bet",
  G: "Live",
  C: "Casino",
  A: "Manual Action",
} as const;

export type WagerTypeLabel =
  (typeof WAGER_TYPE_LABELS)[keyof typeof WAGER_TYPE_LABELS] | "Other";

/** `S` → `Straight`. Unknown codes stay visible as `Other` rather than being guessed. */
export function wagerTypeLabel(code: string): WagerTypeLabel {
  const key = String(code ?? "")
    .trim()
    .toUpperCase();
  return WAGER_TYPE_LABELS[key as keyof typeof WAGER_TYPE_LABELS] ?? "Other";
}

export interface ExposureBucket {
  wagers: number;
  wagered: number;
  toWin: number;
}

export interface GameExposure {
  /** Neutral label — the feed reports `Team1`/`Team2`, not home/away. */
  readonly matchup: string;
  readonly league: string;
  readonly gameDateTime: string | null;
  /** True while the scheduled start is still in the future (manual: deletes are pre-game). */
  readonly preGame: boolean;
  readonly total: ExposureBucket;
  /** Position breakdown, in the manual's order. */
  readonly positions: Readonly<Record<WagerTypeLabel, ExposureBucket>>;
}

function emptyBucket(): ExposureBucket {
  return { wagers: 0, wagered: 0, toWin: 0 };
}

const POSITION_ORDER: readonly WagerTypeLabel[] = [
  "Straight",
  "Parlay",
  "Teaser",
  "Round Robin",
  "If Bet",
  "Live",
  "Casino",
  "Manual Action",
  "Other",
];

function emptyPositions(): Record<WagerTypeLabel, ExposureBucket> {
  const positions = {} as Record<WagerTypeLabel, ExposureBucket>;
  for (const label of POSITION_ORDER) positions[label] = emptyBucket();
  return positions;
}

function gameKey(game: LiveBetGame): string {
  // Order-independent so the same fixture keys together regardless of feed order.
  const names = [game.team1.name, game.team2.name].map((n) =>
    n.trim().toLowerCase(),
  );
  return [...names].sort().join("|");
}

/**
 * Groups wagers by fixture and splits each into positions.
 *
 * `now` is injected so the `preGame` verdict is testable and so a long-running server does not
 * freeze "pre-game" at process start.
 */
export function summarizeByGame(
  games: readonly LiveBetGame[],
  now: Date,
): GameExposure[] {
  const byKey = new Map<
    string,
    {
      matchup: string;
      league: string;
      gameDateTime: string | null;
      preGame: boolean;
      total: ExposureBucket;
      positions: Record<WagerTypeLabel, ExposureBucket>;
    }
  >();

  for (const game of games) {
    const key = gameKey(game);
    const label = wagerTypeLabel(game.wagerType);
    const start =
      game.gameDateTime === null ? null : new Date(game.gameDateTime);
    const startsInFuture =
      start !== null &&
      !Number.isNaN(start.getTime()) &&
      start.getTime() > now.getTime();

    const entry =
      byKey.get(key) ??
      (() => {
        const created = {
          matchup: `${game.team1.shortName || game.team1.name} vs ${
            game.team2.shortName || game.team2.name
          }`,
          league: game.subSport || game.sport || "Other",
          gameDateTime: game.gameDateTime,
          preGame: startsInFuture,
          total: emptyBucket(),
          positions: emptyPositions(),
        };
        byKey.set(key, created);
        return created;
      })();

    // A fixture counts as pre-game only while *every* wager on it is pre-game; once one row
    // carries a started game time, the report shows it as live.
    if (!startsInFuture) entry.preGame = false;

    entry.total.wagers += 1;
    entry.total.wagered += game.wagered;
    entry.total.toWin += game.toWin;

    const bucket = entry.positions[label];
    bucket.wagers += 1;
    bucket.wagered += game.wagered;
    bucket.toWin += game.toWin;
  }

  return [...byKey.values()]
    .map((entry) => ({
      matchup: entry.matchup,
      league: entry.league,
      gameDateTime: entry.gameDateTime,
      preGame: entry.preGame,
      total: entry.total,
      positions: entry.positions,
    }))
    .sort((a, b) => b.total.wagered - a.total.wagered);
}

/** Drops empty positions so the payload does not carry eight zero buckets per game. */
export function compactPositions(
  positions: Readonly<Record<WagerTypeLabel, ExposureBucket>>,
): Partial<Record<WagerTypeLabel, ExposureBucket>> {
  const out: Partial<Record<WagerTypeLabel, ExposureBucket>> = {};
  for (const label of POSITION_ORDER) {
    const bucket = positions[label];
    if (bucket.wagers > 0) out[label] = bucket;
  }
  return out;
}
