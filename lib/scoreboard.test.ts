import { describe, expect, test } from "bun:test";
import {
  findScore,
  normalizeTeamName,
  readScoreboardFile,
  summarizeScoreboard,
  teamNickname,
  type ScoreboardFile,
} from "./scoreboard.ts";

const file: ScoreboardFile = {
  schemaVersion: 1,
  source: "paste:test",
  observedAt: "2026-11-01",
  games: [
    {
      league: "NFL",
      sport: "Football",
      status: "final",
      period: "Final",
      broadcast: "FOX",
      team1: { name: "Cardinals", score: 33, logo: "Arizona-Cardinals.png" },
      team2: { name: "Cowboys", score: 30, logo: "Dallas-Cowboys.png" },
    },
    {
      league: "NFL",
      sport: "Football",
      status: "final",
      period: "Final",
      broadcast: null,
      team1: { name: "Raiders", score: 38, logo: "Oakland-Raiders.png" },
      team2: { name: "Jets", score: 33, logo: "New-York-Jets.png" },
    },
    {
      league: "NHL",
      sport: "Hockey",
      status: "final",
      period: "Final",
      broadcast: null,
      team1: { name: "Jets", score: 0, logo: "Winnipeg-Jets.png" },
      team2: { name: "Hurricanes", score: 7, logo: "Carolina-Hurricanes.png" },
    },
    {
      league: "NFL",
      sport: "Football",
      status: "scheduled",
      period: "7:20 pm CST",
      broadcast: "NBC",
      team1: { name: "Eagles", score: null, logo: "Philadelphia-Eagles.png" },
      team2: {
        name: "Commanders",
        score: null,
        logo: "washington-commanders.png",
      },
    },
  ],
};

describe("team name normalization", () => {
  test("strips punctuation and case", () => {
    expect(normalizeTeamName("  New York Jets ")).toBe("new york jets");
    expect(normalizeTeamName("Notre Dame")).toBe("notre dame");
    expect(normalizeTeamName("St. Louis")).toBe("st louis");
  });

  test("nickname drops the city on both surfaces", () => {
    expect(teamNickname("Arizona Cardinals")).toBe("cardinals");
    expect(teamNickname("Cardinals")).toBe("cardinals");
    expect(teamNickname("Golden State Warriors")).toBe("warriors");
    expect(teamNickname("")).toBe("");
  });
});

describe("findScore", () => {
  test("joins a wager to its scoreboard game", () => {
    const score = findScore(file, {
      team1: "Arizona Cardinals",
      team2: "Dallas Cowboys",
      league: "NFL",
    });
    expect(score).not.toBeNull();
    expect(score?.team1Score).toBe(33);
    expect(score?.team2Score).toBe(30);
    expect(score?.period).toBe("Final");
    expect(score?.broadcast).toBe("FOX");
  });

  test("aligns scores to the wager's team order, not the scoreboard's", () => {
    const reversed = findScore(file, {
      team1: "Dallas Cowboys",
      team2: "Arizona Cardinals",
      league: "nfl",
    });
    expect(reversed?.team1Score).toBe(30);
    expect(reversed?.team2Score).toBe(33);
  });

  test("does not borrow a same-nickname club from another league", () => {
    const nfl = findScore(file, {
      team1: "New York Jets",
      team2: "Carolina Hurricanes",
      league: "NFL",
    });
    expect(nfl).toBeNull();
  });

  test("matches the NHL Jets only inside the NHL", () => {
    const nhl = findScore(file, {
      team1: "Winnipeg Jets",
      team2: "Carolina Hurricanes",
      league: "NHL",
    });
    expect(nhl?.team1Score).toBe(0);
    expect(nhl?.team2Score).toBe(7);
  });

  test("an empty league joins only when exactly one game matches", () => {
    // The caller (the bet ticker) cannot say which league; a unique nickname pair is safe.
    const unique = findScore(file, {
      team1: "Cardinals",
      team2: "Cowboys",
      league: "",
    });
    expect(unique?.league).toBe("NFL");

    // Every nickname that repeats on the real board (`Jets` in NFL and NHL) has a different
    // partner, so a pair still resolves. Duplicated pairs are the case the rule exists for.
    expect(
      findScore(file, { team1: "Jets", team2: "Hurricanes", league: "" })
        ?.league,
    ).toBe("NHL");
    expect(
      findScore(file, { team1: "Raiders", team2: "Jets", league: "" })?.league,
    ).toBe("NFL");
  });

  test("refuses a league-less join when two games share the pair", () => {
    const duplicated: ScoreboardFile = {
      ...file,
      games: [
        ...file.games,
        {
          league: "CFB",
          sport: "Football",
          status: "scheduled",
          period: null,
          broadcast: null,
          team1: { name: "Cardinals", score: null, logo: null },
          team2: { name: "Cowboys", score: null, logo: null },
        },
      ],
    };
    // "Cardinals vs Cowboys" now exists in two leagues: refuse instead of taking the first row.
    expect(
      findScore(duplicated, {
        team1: "Cardinals",
        team2: "Cowboys",
        league: "",
      }),
    ).toBeNull();
    // Naming the league still resolves it.
    expect(
      findScore(duplicated, {
        team1: "Cardinals",
        team2: "Cowboys",
        league: "CFB",
      })?.status,
    ).toBe("scheduled");
  });

  test("leaves a sport the scoreboard does not cover unmatched", () => {
    expect(
      findScore(file, {
        team1: "Arsenal",
        team2: "Liverpool",
        league: "ENG PREM",
      }),
    ).toBeNull();
  });

  test("carries a scheduled game with null scores", () => {
    const score = findScore(file, {
      team1: "Philadelphia Eagles",
      team2: "Washington Commanders",
      league: "NFL",
    });
    expect(score?.status).toBe("scheduled");
    expect(score?.team1Score).toBeNull();
    expect(score?.period).toBe("7:20 pm CST");
  });

  test("reports provenance with every match", () => {
    const score = findScore(file, {
      team1: "Cardinals",
      team2: "Cowboys",
      league: "NFL",
    });
    expect(score?.source).toBe("paste:test");
    expect(score?.observedAt).toBe("2026-11-01");
  });
});

describe("readScoreboardFile", () => {
  test("accepts the committed shape and keeps notes", () => {
    const parsed = readScoreboardFile({
      schemaVersion: 1,
      source: "s",
      observedAt: "d",
      notes: ["n"],
      games: [],
    });
    expect(parsed?.notes).toEqual(["n"]);
  });

  test("rejects payloads without games", () => {
    expect(readScoreboardFile(null)).toBeNull();
    expect(readScoreboardFile({})).toBeNull();
    expect(readScoreboardFile({ games: "nope" })).toBeNull();
  });
});

describe("summarizeScoreboard", () => {
  test("counts by status and league", () => {
    const summary = summarizeScoreboard(file);
    expect(summary.games).toBe(4);
    expect(summary.final).toBe(3);
    expect(summary.scheduled).toBe(1);
    expect(summary.live).toBe(0);
    expect(summary.byLeague).toEqual({ NFL: 3, NHL: 1 });
  });
});
