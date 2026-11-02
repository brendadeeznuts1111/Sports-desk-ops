import { describe, expect, test } from "bun:test";
import {
  compactPositions,
  summarizeByGame,
  wagerTypeLabel,
} from "./game_admin.ts";
import type { LiveBetGame } from "./live_bets.ts";

const base = (overrides: Partial<LiveBetGame>): LiveBetGame =>
  ({
    ticketNumber: "1",
    wagerNumber: "1",
    ticketKey: "1-1",
    agent: { key: "", id: "", level: null, agentType: null },
    customerID: "C1",
    status: "P",
    sport: "Football",
    subSport: "NFL",
    period: "Game",
    wagerType: "S",
    picks: 1,
    description: "",
    chosenTeam: null,
    wagered: 10_000,
    toWin: 9_000,
    gameDateTime: "2030-01-01 13:00:00.000",
    acceptedAt: null,
    team1: {
      name: "Arizona Cardinals",
      shortName: "Cardinals",
      score: 0,
      logo: null,
      logoUrl: null,
      rotationNumber: 243,
    },
    team2: {
      name: "Dallas Cowboys",
      shortName: "Cowboys",
      score: 0,
      logo: null,
      logoUrl: null,
      rotationNumber: 244,
    },
    ...overrides,
  }) as LiveBetGame;

describe("wagerTypeLabel", () => {
  test("maps the documented codes", () => {
    expect(wagerTypeLabel("S")).toBe("Straight");
    expect(wagerTypeLabel("p")).toBe("Parlay");
    expect(wagerTypeLabel(" T ")).toBe("Teaser");
    expect(wagerTypeLabel("R")).toBe("Round Robin");
  });

  test("keeps unknown codes visible instead of guessing", () => {
    expect(wagerTypeLabel("Z")).toBe("Other");
    expect(wagerTypeLabel("")).toBe("Other");
  });
});

describe("summarizeByGame", () => {
  const now = new Date("2026-11-01T18:00:00.000Z");

  test("keys the fixture order-independently", () => {
    const forward = base({});
    const reversed = base({
      team1: forward.team2,
      team2: forward.team1,
      wagerType: "P",
    });
    const games = summarizeByGame([forward, reversed], now);
    expect(games).toHaveLength(1);
    expect(games[0]?.total.wagers).toBe(2);
  });

  test("splits exposure by position", () => {
    const games = summarizeByGame(
      [
        base({ wagerType: "S", wagered: 10_000, toWin: 9_000 }),
        base({ wagerType: "S", wagered: 5_000, toWin: 4_500 }),
        base({ wagerType: "P", wagered: 2_000, toWin: 8_000 }),
        base({ wagerType: "T", wagered: 1_000, toWin: 1_500 }),
      ],
      now,
    );
    const game = games[0];
    expect(game?.total).toEqual({ wagers: 4, wagered: 18_000, toWin: 23_000 });
    expect(game?.positions.Straight).toEqual({
      wagers: 2,
      wagered: 15_000,
      toWin: 13_500,
    });
    expect(game?.positions.Parlay.wagers).toBe(1);
    expect(game?.positions.Teaser.toWin).toBe(1_500);
  });

  test("marks pre-game from the scheduled start, not from status", () => {
    const upcoming = summarizeByGame([base({})], now);
    expect(upcoming[0]?.preGame).toBe(true);

    const started = summarizeByGame(
      [base({ gameDateTime: "2026-11-01 12:00:00.000" })],
      now,
    );
    expect(started[0]?.preGame).toBe(false);
  });

  test("a fixture with any started wager is not pre-game", () => {
    const games = summarizeByGame(
      [
        base({ gameDateTime: "2026-11-01T20:00:00.000Z" }),
        base({ gameDateTime: "2026-11-01T12:00:00.000Z", ticketNumber: "2" }),
      ],
      now,
    );
    expect(games[0]?.preGame).toBe(false);
  });

  test("treats a missing game time as not pre-game", () => {
    const games = summarizeByGame([base({ gameDateTime: null })], now);
    expect(games[0]?.preGame).toBe(false);
    expect(games[0]?.gameDateTime).toBeNull();
  });

  test("orders fixtures by exposure, largest first", () => {
    const small = base({ wagered: 1_000 });
    const large = base({
      wagered: 50_000,
      team1: {
        ...base({}).team1,
        name: "Kansas City Chiefs",
        shortName: "Chiefs",
      },
      team2: { ...base({}).team2, name: "Buffalo Bills", shortName: "Bills" },
    });
    const games = summarizeByGame([small, large], now);
    expect(games[0]?.matchup).toContain("Chiefs");
    expect(games[1]?.matchup).toContain("Cardinals");
  });

  test("labels the league from the sub-sport", () => {
    const games = summarizeByGame(
      [base({ subSport: "ENG PREM", sport: "Soccer" })],
      now,
    );
    expect(games[0]?.league).toBe("ENG PREM");
  });

  test("returns nothing for no wagers", () => {
    expect(summarizeByGame([], now)).toEqual([]);
  });
});

describe("compactPositions", () => {
  test("drops empty buckets and keeps the rest", () => {
    const games = summarizeByGame(
      [base({ wagerType: "S" }), base({ wagerType: "P" })],
      new Date("2026-11-01T18:00:00.000Z"),
    );
    const compact = compactPositions(games[0]!.positions);
    expect(Object.keys(compact).sort()).toEqual(["Parlay", "Straight"]);
    expect(compact.Teaser).toBeUndefined();
  });
});
