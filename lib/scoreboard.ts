/**
 * @file scoreboard.ts
 * @description Join between the portal scoreboard (games + scores) and captured wagers.
 *
 * The scoreboard is transcribed from the manager page, not captured from an API, so every
 * derived value carries `source`. Team names differ in shape between the two surfaces —
 * wagers report `"Arizona Cardinals"`, the scoreboard reports `"Cardinals"` — so matching is
 * by nickname plus league, never by fuzzy string distance, and a failed match stays a miss.
 */

export const SCOREBOARD_SOURCE = "paste:fantasy402 manager.html scoreboard";

export interface ScoreboardTeam {
  readonly name: string;
  readonly score: number | null;
  readonly logo: string | null;
}

export interface ScoreboardGame {
  readonly league: string;
  readonly sport: string;
  readonly status: "final" | "live" | "scheduled" | string;
  readonly period: string | null;
  readonly broadcast: string | null;
  readonly team1: ScoreboardTeam;
  readonly team2: ScoreboardTeam;
}

export interface ScoreboardFile {
  readonly schemaVersion: 1;
  readonly source: string;
  readonly observedAt: string | null;
  readonly notes?: readonly string[];
  readonly games: readonly ScoreboardGame[];
}

/** Score context attached to a wager when both of its teams appear in one scoreboard game. */
export interface WagerScore {
  readonly league: string;
  readonly status: string;
  readonly period: string | null;
  readonly broadcast: string | null;
  /** Scores aligned to the wager's own `team1` / `team2`, not the scoreboard's order. */
  readonly team1Score: number | null;
  readonly team2Score: number | null;
  readonly source: string;
  readonly observedAt: string | null;
}

const NON_ALNUM = /[^a-z0-9 ]+/g;

/** Lower-case, punctuation-free, whitespace-collapsed. */
export function normalizeTeamName(raw: unknown): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(NON_ALNUM, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The club, without a city: `"Arizona Cardinals"` and `"Cardinals"` both yield `"cardinals"`.
 * Multi-word nicknames (`"Notre Dame"`, `"Golden State Warriors"`) degrade to their last word
 * on both sides, which still matches because the scoreboard stores the same short form.
 */
export function teamNickname(raw: unknown): string {
  const normalized = normalizeTeamName(raw);
  if (normalized === "") return "";
  const parts = normalized.split(" ");
  return parts[parts.length - 1] ?? "";
}

export function readScoreboardFile(payload: unknown): ScoreboardFile | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Partial<ScoreboardFile>;
  if (!Array.isArray(record.games)) return null;
  return {
    schemaVersion: 1,
    source: typeof record.source === "string" ? record.source : "",
    observedAt:
      typeof record.observedAt === "string" ? record.observedAt : null,
    ...(Array.isArray(record.notes) ? { notes: record.notes.map(String) } : {}),
    games: record.games,
  };
}

function samePair(
  game: ScoreboardGame,
  a: string,
  b: string,
  league: string,
): boolean {
  if (league !== "" && game.league.toLowerCase() !== league.toLowerCase()) {
    return false;
  }
  const g1 = teamNickname(game.team1.name);
  const g2 = teamNickname(game.team2.name);
  if (g1 === "" || g2 === "") return false;
  return (g1 === a && g2 === b) || (g1 === b && g2 === a);
}

/**
 * Finds the scoreboard row for a wager's two teams. `league` is the wager's `SportSubType`
 * (`"NFL"`, `"ENG PREM"`); when it does not match, the pair is not joined — a same-nickname
 * club in another league must not borrow a score.
 *
 * An **empty** league is not a licence to ignore the guard. It means the caller does not know the
 * competition (the bet ticker carries `sport: "Football"`, which is NFL *and* CFB), so the join
 * proceeds only when exactly one game matches the nickname pair. Two candidates and the result is
 * `null` rather than the first row in file order. The board really does repeat a nickname —
 * `Jets` plays in NFL and in NHL — so a league-less caller is one duplicated pair away from a
 * wrong score.
 */
export function findScore(
  file: ScoreboardFile,
  wager: {
    readonly team1: string;
    readonly team2: string;
    readonly league: string;
  },
): WagerScore | null {
  const a = teamNickname(wager.team1);
  const b = teamNickname(wager.team2);
  if (a === "" || b === "") return null;

  const league = wager.league.trim();
  const candidates = file.games.filter((game) => samePair(game, a, b, league));
  if (candidates.length === 0) return null;
  // No league means the caller cannot disambiguate; two matches are a refusal, not a coin flip.
  if (league === "" && candidates.length > 1) return null;

  const game = candidates[0]!;
  // Align scores to the wager's team order so the caller never has to re-sort.
  const wagerTeam1IsGameTeam1 = teamNickname(game.team1.name) === a;
  return {
    league: game.league,
    status: game.status,
    period: game.period,
    broadcast: game.broadcast,
    team1Score: wagerTeam1IsGameTeam1 ? game.team1.score : game.team2.score,
    team2Score: wagerTeam1IsGameTeam1 ? game.team2.score : game.team1.score,
    source: file.source,
    observedAt: file.observedAt,
  };
}

/** Counts by status, for the scoreboard header. */
export function summarizeScoreboard(file: ScoreboardFile): {
  games: number;
  live: number;
  final: number;
  scheduled: number;
  byLeague: Record<string, number>;
} {
  let live = 0;
  let final = 0;
  let scheduled = 0;
  const byLeague: Record<string, number> = {};

  for (const game of file.games) {
    if (game.status === "live") live += 1;
    else if (game.status === "final") final += 1;
    else if (game.status === "scheduled") scheduled += 1;
    byLeague[game.league] = (byLeague[game.league] ?? 0) + 1;
  }

  return { games: file.games.length, live, final, scheduled, byLeague };
}
