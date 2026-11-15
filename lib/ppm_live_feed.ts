/**
 * @file lib/ppm_live_feed.ts
 * @description Parser for the PPM player-site fixture snapshot
 * (`GET /live/allEvents` on ppm.sportswidgets.pro).
 *
 * Wire shape (abbreviated on the server, so the mapping is explicit here):
 *
 *   { "s": { "<sportId>": { "<leagueId>": { "<fixtureId>": {
 *       "<bettingEventId>": [ [homeName, "", "", homeTeamId, "", "", ""],
 *                             [awayName, "", "", awayTeamId, "", "", ""],
 *                             <startTimeUnixSeconds>, null, null ] } } } } }
 *
 * The outer fixture id is the stat-score fixture; the inner key is the id the
 * betting desk uses. Team rows carry the name at index 0 and the id at index 3;
 * the rest of the row is stat-score metadata this parser deliberately ignores.
 *
 * This module is pure: it validates a payload it is given and never fetches.
 * The transport (HTTP snapshot today, socket.io `eventData` for live lines) is a
 * separate concern, so the mapper can be tested against captured bytes.
 */

export type PpmFeedErrorCode = "invalid_payload" | "invalid_fixture";

export class PpmFeedError extends Error {
  readonly code: PpmFeedErrorCode;

  constructor(code: PpmFeedErrorCode, message: string) {
    super(message);
    this.name = "PpmFeedError";
    this.code = code;
  }
}

export interface PpmTeam {
  readonly name: string;
  readonly teamId: number;
}

export interface PpmFixture {
  /** The betting event id (inner key) — what the desk prices. */
  readonly eventId: number;
  /**
   * The feed's outer bucket (a card, a day, a schedule window) — not a game.
   * Measured 2026-11-12: 750 slates hold 5,916 events; the largest holds 281.
   */
  readonly slateId: number;
  readonly sportId: number;
  readonly leagueId: number;
  readonly home: PpmTeam;
  readonly away: PpmTeam;
  /** Kick-off / start time in unix seconds, as the feed reports it. */
  readonly startTimeUnix: number;
}

export interface PpmLeagueRef {
  /**
   * League ids are only unique *within* a sport (the crop has 8 league entries
   * but 4 distinct ids), so a league is always the pair.
   */
  readonly sportId: number;
  readonly leagueId: number;
}

/**
 * A fixture the feed carried but the desk cannot price yet (TBD team, missing
 * id). Live feeds contain these between the fixture being posted and the teams
 * being resolved, so they are reported rather than thrown.
 */
export interface PpmUnresolvedFixture {
  readonly sportId: number;
  readonly leagueId: number;
  readonly eventId: number;
  readonly reason: "missing_team_name" | "missing_team_id";
}

export interface PpmAllEventsSnapshot {
  /** Sorted by start time, then event id. */
  readonly fixtures: readonly PpmFixture[];
  /** Fixtures skipped because a team is not resolved yet. */
  readonly unresolved: readonly PpmUnresolvedFixture[];
  readonly sportIds: readonly number[];
  readonly leagues: readonly PpmLeagueRef[];
  readonly counts: {
    readonly sports: number;
    readonly leagues: number;
    readonly fixtures: number;
    readonly unresolved: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toId(key: string, dimension: string): number {
  if (!/^\d+$/.test(key)) {
    throw new PpmFeedError(
      "invalid_payload",
      `${dimension} key is not numeric: ${JSON.stringify(key)}`,
    );
  }
  const id = Number(key);
  if (!Number.isSafeInteger(id)) {
    throw new PpmFeedError(
      "invalid_payload",
      `${dimension} key is not a safe integer: ${key}`,
    );
  }
  return id;
}

type TeamResult =
  | { readonly kind: "ok"; readonly team: PpmTeam }
  | { readonly kind: "gap"; readonly reason: PpmUnresolvedFixture["reason"] };

function parseTeam(value: unknown): TeamResult {
  // The live feed ships unresolved fixtures as `[""]` placeholder rows (108 of
  // 833 at capture time), so a malformed row is a gap, not corruption.
  if (!Array.isArray(value) || value.length < 4) {
    return { kind: "gap", reason: "missing_team_name" };
  }
  const name = value[0];
  const teamId = value[3];
  if (typeof name !== "string" || name.length === 0) {
    return { kind: "gap", reason: "missing_team_name" };
  }
  if (
    typeof teamId !== "number" ||
    !Number.isSafeInteger(teamId) ||
    teamId <= 0
  ) {
    return { kind: "gap", reason: "missing_team_id" };
  }
  return { kind: "ok", team: { name, teamId } };
}

type FixtureResult =
  | { readonly kind: "ok"; readonly fixture: PpmFixture }
  | { readonly kind: "gap"; readonly reason: PpmUnresolvedFixture["reason"] };

function parseFixture(
  value: unknown,
  sportId: number,
  leagueId: number,
  slateId: number,
  eventId: number,
): FixtureResult {
  if (!Array.isArray(value) || value.length < 3) {
    throw new PpmFeedError(
      "invalid_fixture",
      `event ${eventId}: expected [home, away, startTimeUnix, ...]`,
    );
  }
  const home = parseTeam(value[0]);
  if (home.kind === "gap") return home;
  const away = parseTeam(value[1]);
  if (away.kind === "gap") return away;
  const startTimeUnix = value[2];
  if (
    typeof startTimeUnix !== "number" ||
    !Number.isSafeInteger(startTimeUnix) ||
    startTimeUnix <= 0
  ) {
    throw new PpmFeedError(
      "invalid_fixture",
      `event ${eventId}: startTimeUnix must be a positive integer (got ${String(startTimeUnix)})`,
    );
  }
  return {
    kind: "ok",
    fixture: {
      eventId,
      slateId,
      sportId,
      leagueId,
      home: home.team,
      away: away.team,
      startTimeUnix,
    },
  };
}

/**
 * The wire calls the outer key `fixtureId`; it is a slate (a card/day bucket,
 * not a game), so the code names it `slateId` throughout.
 *
 * Validates and flattens an `/live/allEvents` payload. Throws `PpmFeedError`
 * on the first structural problem rather than returning a partial book: a
 * half-parsed odds tree is worse than a visible failure.
 */
export function parsePpmAllEvents(payload: unknown): PpmAllEventsSnapshot {
  if (!isRecord(payload) || !isRecord(payload.s)) {
    throw new PpmFeedError(
      "invalid_payload",
      "expected { s: { sportId: { leagueId: { fixtureId: { eventId: [...] } } } } }",
    );
  }

  const fixtures: PpmFixture[] = [];
  const unresolved: PpmUnresolvedFixture[] = [];
  const sportIds: number[] = [];
  const leagueRefs: PpmLeagueRef[] = [];
  const seenLeagues = new Set<string>();

  for (const [sportKey, leagues] of Object.entries(payload.s)) {
    const sportId = toId(sportKey, "sportId");
    if (!isRecord(leagues)) {
      throw new PpmFeedError(
        "invalid_payload",
        `sport ${sportId}: expected a league map`,
      );
    }
    sportIds.push(sportId);

    for (const [leagueKey, leagueEvents] of Object.entries(leagues)) {
      const leagueId = toId(leagueKey, "leagueId");
      if (!isRecord(leagueEvents)) {
        throw new PpmFeedError(
          "invalid_payload",
          `league ${leagueId}: expected a fixture map`,
        );
      }
      const leagueRefKey = `${sportId}:${leagueId}`;
      if (!seenLeagues.has(leagueRefKey)) {
        seenLeagues.add(leagueRefKey);
        leagueRefs.push({ sportId, leagueId });
      }

      for (const [fixtureKey, events] of Object.entries(leagueEvents)) {
        const slateId = toId(fixtureKey, "slateId");
        if (!isRecord(events)) {
          throw new PpmFeedError(
            "invalid_fixture",
            `league ${leagueId}: expected a map of betting event ids`,
          );
        }
        for (const [eventKey, value] of Object.entries(events)) {
          const eventId = toId(eventKey, "eventId");
          const parsed = parseFixture(
            value,
            sportId,
            leagueId,
            slateId,
            eventId,
          );
          if (parsed.kind === "ok") {
            fixtures.push(parsed.fixture);
          } else {
            unresolved.push({
              sportId,
              leagueId,
              eventId,
              reason: parsed.reason,
            });
          }
        }
      }
    }
  }

  fixtures.sort(
    (a, b) => a.startTimeUnix - b.startTimeUnix || a.eventId - b.eventId,
  );

  return {
    fixtures,
    unresolved,
    sportIds,
    leagues: leagueRefs,
    counts: {
      sports: sportIds.length,
      leagues: leagueRefs.length,
      fixtures: fixtures.length,
      unresolved: unresolved.length,
    },
  };
}
