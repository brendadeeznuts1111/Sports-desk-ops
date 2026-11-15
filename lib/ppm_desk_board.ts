/**
 * @file lib/ppm_desk_board.ts
 * @description Projects a PPM fixture snapshot into desk games.
 *
 * Two levels in the feed, and they are not the same thing:
 *
 *  - the **slate** (the payload's outer key) is a feed bucket — a card, a day,
 *    a schedule window. Measured 2026-11-12: 750 slates hold 5,916 events, and
 *    the largest holds 281 events across 276 matchups over 30 hours. It is
 *    never a game.
 *  - the **game** is one matchup at one start time. Several betting events for
 *    the same game (periods, markets) share both.
 *
 * Start times jitter by seconds between rows for the same game (234 same-pair
 * events sit within 60 s of each other), so a game is a *cluster* of starts
 * within `START_JITTER_SECONDS`, not an exact start value.
 *
 * What this deliberately does not do: invent prices, colours or form. A game
 * carries `eventIds` and the dashboard decides how to render a row without
 * odds yet.
 */

import type {
  PpmAllEventsSnapshot,
  PpmFixture,
  PpmTeam,
} from "./ppm_live_feed.ts";

/** Two rows for the same game may disagree by this much and still be one game. */
export const START_JITTER_SECONDS = 60;

/**
 * Sport ids observed on the live snapshot (2026-11-12), identified from team
 * names rather than from `sportOrder`. Partial by design: the snapshot carries
 * 35 sports; the rest resolve to `null` and the caller decides how to label
 * them. Do not renumber from the menu order — menu ids are not sport ids.
 */
export const PPM_SPORT_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: "Baseball",
  2: "Basketball",
  3: "American Football",
  4: "Ice Hockey",
  5: "Soccer",
  6: "Boxing",
  7: "Golf",
  8: "Tennis",
  9: "Motor Racing",
  86: "Handball",
  89: "Futsal",
});

export interface DeskGame {
  /** Stable id: `ppm:<sportId>:<leagueId>:<slateId>:<home>-<away>:<start>`. */
  readonly id: string;
  /** The feed bucket this game came from — a slate, not a game id. */
  readonly slateId: number;
  readonly sportId: number;
  readonly sportName: string | null;
  readonly leagueId: number;
  readonly home: PpmTeam;
  readonly away: PpmTeam;
  /** Earliest start in the cluster. */
  readonly startTimeUnix: number;
  /** Betting events under this game, ascending. */
  readonly eventIds: readonly number[];
}

export interface DeskBoardOptions {
  /** Drop games starting before this epoch second (e.g. now, for a live board). */
  readonly sinceUnix?: number;
  /**
   * Sport names from `eventsMetadata`, which are authoritative. Falls back to
   * the measured table, then to `null`.
   */
  readonly sportNames?: ReadonlyMap<number, string>;
}

export interface DeskBoard {
  readonly games: readonly DeskGame[];
  readonly counts: {
    readonly games: number;
    readonly events: number;
    readonly unresolved: number;
  };
}

const BOARD_PREFIX = "ppm";

/** Feed names carry stray padding (`" Athletics"`); presentation normalises it. */
function tidyName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * Slate + matchup. Start time is deliberately *not* part of the key: it is
 * clustered afterwards so second-level jitter does not split one game in two.
 */
function matchupKey(fixture: PpmFixture): string {
  return [
    fixture.sportId,
    fixture.leagueId,
    fixture.slateId,
    fixture.home.teamId,
    fixture.away.teamId,
  ].join(":");
}

function gameId(first: PpmFixture, startTimeUnix: number): string {
  return [
    BOARD_PREFIX,
    first.sportId,
    first.leagueId,
    first.slateId,
    `${first.home.teamId}-${first.away.teamId}`,
    startTimeUnix,
  ].join(":");
}

export function toDeskBoard(
  snapshot: PpmAllEventsSnapshot,
  options: DeskBoardOptions = {},
): DeskBoard {
  const sinceUnix = options.sinceUnix ?? Number.NEGATIVE_INFINITY;
  const byMatchup = new Map<string, PpmFixture[]>();
  for (const fixture of snapshot.fixtures) {
    if (fixture.startTimeUnix < sinceUnix) continue;
    const key = matchupKey(fixture);
    const bucket = byMatchup.get(key);
    if (bucket) bucket.push(fixture);
    else byMatchup.set(key, [fixture]);
  }

  const games: DeskGame[] = [];
  let events = 0;
  for (const bucket of byMatchup.values()) {
    bucket.sort(
      (a, b) => a.startTimeUnix - b.startTimeUnix || a.eventId - b.eventId,
    );

    let clusterStart = Number.NEGATIVE_INFINITY;
    let cluster: PpmFixture[] = [];
    const flush = (): void => {
      if (cluster.length === 0) return;
      const first = cluster[0]!;
      const eventIds = cluster
        .map((fixture) => fixture.eventId)
        .sort((a, b) => a - b);
      events += eventIds.length;
      games.push({
        id: gameId(first, clusterStart),
        slateId: first.slateId,
        sportId: first.sportId,
        sportName:
          options.sportNames?.get(first.sportId) ??
          PPM_SPORT_NAMES[first.sportId] ??
          null,
        leagueId: first.leagueId,
        home: { name: tidyName(first.home.name), teamId: first.home.teamId },
        away: { name: tidyName(first.away.name), teamId: first.away.teamId },
        startTimeUnix: clusterStart,
        eventIds,
      });
    };

    for (const fixture of bucket) {
      if (
        cluster.length === 0 ||
        fixture.startTimeUnix - clusterStart > START_JITTER_SECONDS
      ) {
        flush();
        cluster = [fixture];
        clusterStart = fixture.startTimeUnix;
      } else {
        cluster.push(fixture);
      }
    }
    flush();
  }

  games.sort(
    (a, b) => a.startTimeUnix - b.startTimeUnix || a.id.localeCompare(b.id),
  );

  return {
    games,
    counts: {
      games: games.length,
      events,
      unresolved: snapshot.unresolved.length,
    },
  };
}
