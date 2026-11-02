#!/usr/bin/env bun
/**
 * How much of a wager set can reach a scoreboard row — and what stops the rest.
 *
 *   bun run wagers:score-coverage <wagers.json> [--board data/scoreboard.json] [--json]
 *
 * `findScore` refuses to join without a league: a wager's `SportSubType` (`NFL`, `ENG PREM`) is
 * checked against the scoreboard row's league, because a same-nickname club in another league must
 * not borrow a score. The bet ticker's rows carry `ShortDesc` with `sport: "Football"` and no
 * league, so a ticker row cannot join — not because the teams are missing, but because `Football`
 * is NFL *and* CFB.
 *
 * This reports the two numbers separately, which is the whole point:
 *  - **pair present** — the two nicknames appear together on a scoreboard row, ignoring league.
 *    That is "would join if the league were known".
 *  - **joined** — `findScore` with the row's own league (only possible when the row carries one,
 *    e.g. Pending's `SportSubType`).
 *
 * Anything in the first number but not the second is a league problem, and anything outside both is
 * a name or window problem.
 */

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { parseShortDesc } from "../lib/live_wagers.ts";
import {
  findScore,
  readScoreboardFile,
  teamNickname,
  type ScoreboardFile,
} from "../lib/scoreboard.ts";

const REPO = join(import.meta.dir, "..");
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    board: { type: "string", default: join(REPO, "data", "scoreboard.json") },
    json: { type: "boolean", default: false },
  },
});

const path = positionals[0];
if (path === undefined) {
  console.error(
    "usage: bun run wagers:score-coverage <wagers.json> [--board <path>]",
  );
  process.exit(2);
}

const board = readScoreboardFile(
  await Bun.file(resolve(values.board ?? "")).json(),
);
if (board === null) {
  console.error(
    `wagers:score-coverage: ${values.board} is not a scoreboard file`,
  );
  process.exit(2);
}

/** A ticker page (`{LIST}`), a wager list (`{wagers}`), or pending rows (`{games}`). */
interface Row {
  readonly wager: string;
  readonly leg: number;
  readonly team1: string;
  readonly team2: string;
  readonly sport: string;
  readonly league: string;
}

const payload: unknown = await Bun.file(resolve(path)).json();
const record =
  typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};

const rows: Row[] = [];
if (Array.isArray(record["LIST"])) {
  for (const raw of record["LIST"] as Record<string, unknown>[]) {
    const parsed = parseShortDesc(raw["ShortDesc"]);
    parsed.legs.forEach((leg, index) => {
      const [team1 = "", team2 = ""] = leg.game.split(" vs ");
      rows.push({
        wager: String(raw["WagerNumber"] ?? ""),
        leg: index,
        team1,
        team2,
        sport: leg.sport,
        // The ticker does not carry a league; `sport` is too coarse to stand in for one.
        league: "",
      });
    });
  }
}

function pairOnBoard(
  game: ScoreboardFile["games"][number],
  a: string,
  b: string,
): boolean {
  const x = teamNickname(game.team1.name);
  const y = teamNickname(game.team2.name);
  return (x === a && y === b) || (x === b && y === a);
}

let pairPresent = 0;
let joined = 0;
const leagues = new Map<string, number>();
const unmatched: string[] = [];

for (const row of rows) {
  const a = teamNickname(row.team1);
  const b = teamNickname(row.team2);
  const game = board.games.find((candidate) => pairOnBoard(candidate, a, b));
  if (game !== undefined) {
    pairPresent += 1;
    leagues.set(game.league, (leagues.get(game.league) ?? 0) + 1);
  }
  const score = findScore(board, {
    team1: row.team1,
    team2: row.team2,
    league: row.league,
  });
  if (score !== null) joined += 1;
  else if (game !== undefined) {
    unmatched.push(
      `${row.wager}[${row.leg}] ${row.team1} vs ${row.team2} (${game.league})`,
    );
  }
}

const report = {
  rows: rows.length,
  pairPresent,
  joined,
  /** Legs whose teams are on the board but which `findScore` refused for want of a league. */
  leagueBlocked: pairPresent - joined,
  byLeague: Object.fromEntries(leagues),
  missingFromBoard: rows.length - pairPresent,
  blockedExamples: unmatched.slice(0, 5),
};

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `wagers:score-coverage: ${report.rows} leg(s) — ${report.pairPresent} pair(s) on the board, ${report.joined} joined by findScore`,
  );
  console.log(`  leagues present: ${JSON.stringify(report.byLeague)}`);
  console.log(
    `  league-blocked: ${report.leagueBlocked} · absent from the board: ${report.missingFromBoard}`,
  );
  for (const example of report.blockedExamples) {
    console.log(`    would join with a league: ${example}`);
  }
  if (report.rows > 0 && report.joined === 0 && report.pairPresent > 0) {
    console.log(
      "  note: every pair is on the board but none joined — the file has no league per row, and a league-less join is refused when the pair is duplicated across leagues.",
    );
  }
  if (report.joined < report.pairPresent) {
    console.log(
      `  ${report.pairPresent - report.joined} pair(s) resolved to more than one game; a row-level league (Pending's SportSubType) would settle them.`,
    );
  }
}
