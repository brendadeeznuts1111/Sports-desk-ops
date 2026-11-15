/**
 * @file tests/ppm_desk_board.test.ts
 * @description Grouping contract: the snapshot is per betting event, the desk
 * board is per game, and no presentation data is invented on the way across.
 */
import { describe, expect, test } from "bun:test";
import { parsePpmAllEvents } from "../lib/ppm_live_feed.ts";
import { PPM_SPORT_NAMES, toDeskBoard } from "../lib/ppm_desk_board.ts";

const CROP = new URL("./fixtures/ppm/all-events.crop.json", import.meta.url);
const SNAPSHOT = parsePpmAllEvents(await Bun.file(CROP).json());
const BOARD = toDeskBoard(SNAPSHOT);

describe("toDeskBoard on the real crop", () => {
  test("groups betting events into games", () => {
    expect(BOARD.counts.games).toBeGreaterThan(0);
    expect(BOARD.counts.games).toBeLessThanOrEqual(BOARD.counts.events);
    expect(BOARD.counts.events).toBe(SNAPSHOT.fixtures.length);
  });

  test("a fixture is a slate: distinct matchups become distinct games", () => {
    // Same fixture id, three different matchups — one slate, three games.
    const slate = parsePpmAllEvents({
      s: {
        3: {
          6: {
            4: {
              90: [["Bears", "", "", 1], ["Lions", "", "", 2], 1_794_753_000],
              91: [["Bills", "", "", 3], ["Broncos", "", "", 4], 1_794_753_000],
            },
          },
        },
      },
    });
    const board = toDeskBoard(slate);
    expect(board.games).toHaveLength(2);
    expect(board.games.map((g) => g.home.teamId).sort()).toEqual([1, 3]);
  });

  test("second-level start jitter does not split one game", () => {
    const jittered = parsePpmAllEvents({
      s: {
        8: {
          252: {
            47367: {
              90: [["Yao", "", "", 1], ["Jones", "", "", 2], 1_794_538_500],
              91: [["Yao", "", "", 1], ["Jones", "", "", 2], 1_794_538_530],
            },
          },
        },
      },
    });
    const board = toDeskBoard(jittered);
    expect(board.games).toHaveLength(1);
    expect(board.games[0]!.eventIds).toEqual([90, 91]);
    expect(board.games[0]!.startTimeUnix).toBe(1_794_538_500);
  });

  test("a doubleheader hours apart stays two games", () => {
    const double = parsePpmAllEvents({
      s: {
        1: {
          6: {
            8: {
              90: [
                ["Rangers", "", "", 1],
                ["Angels", "", "", 2],
                1_794_538_500,
              ],
              91: [
                ["Rangers", "", "", 1],
                ["Angels", "", "", 2],
                1_794_549_300,
              ],
            },
          },
        },
      },
    });
    expect(toDeskBoard(double).games).toHaveLength(2);
  });

  test("one matchup at one start is one game; a rematch days later is another", () => {
    const fixture = parsePpmAllEvents({
      s: {
        2: {
          6: {
            6: {
              90: [
                ["Knicks", "", "", 1],
                ["Raptors", "", "", 2],
                1_794_783_600,
              ],
              91: [
                ["Knicks", "", "", 1],
                ["Raptors", "", "", 2],
                1_794_783_600,
              ],
              92: [
                ["Knicks", "", "", 1],
                ["Raptors", "", "", 2],
                1_794_961_800,
              ],
            },
          },
        },
      },
    });
    const board = toDeskBoard(fixture);
    expect(board.games).toHaveLength(2);
    expect(board.games[0]!.eventIds).toEqual([90, 91]);
    expect(board.games[1]!.eventIds).toEqual([92]);
  });

  test("keeps a known game with its event ids", () => {
    const game = BOARD.games.find((candidate) => candidate.slateId === 9430);
    expect(game).toBeDefined();
    expect(game!.id).toBe("ppm:1:4:9430:3434274-3434273:1795669200");
    expect(game!.sportId).toBe(1);
    expect(game!.sportName).toBe("Baseball");
    expect(game!.home.name).toBe("Great Britain");
    expect(game!.away.name).toBe("China");
    expect(game!.eventIds).toEqual([185442391]);
  });

  test("every game keeps at least one priced event and every event is linked", () => {
    const linked = BOARD.games.flatMap((game) => game.eventIds);
    expect(linked.length).toBe(BOARD.counts.events);
    expect(new Set(linked).size).toBe(linked.length);
    for (const game of BOARD.games) {
      expect(game.eventIds.length).toBeGreaterThan(0);
    }
  });

  test("game ids are unique and start with the source prefix", () => {
    const ids = BOARD.games.map((game) => game.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("ppm:")).toBe(true);
  });

  test("games are ordered by start time", () => {
    for (let i = 1; i < BOARD.games.length; i += 1) {
      const prev = BOARD.games[i - 1]!;
      const next = BOARD.games[i]!;
      expect(prev.startTimeUnix).toBeLessThanOrEqual(next.startTimeUnix);
    }
  });

  test("carries no invented markets or prices", () => {
    for (const game of BOARD.games) {
      expect("markets" in game).toBe(false);
      expect("prices" in game).toBe(false);
    }
  });
});

describe("window and name hygiene", () => {
  test("sinceUnix drops earlier games and their events", () => {
    const cutoff =
      SNAPSHOT.fixtures[Math.floor(SNAPSHOT.fixtures.length / 2)]!
        .startTimeUnix;
    const windowed = toDeskBoard(SNAPSHOT, { sinceUnix: cutoff });
    expect(windowed.counts.games).toBeLessThanOrEqual(BOARD.counts.games);
    expect(windowed.counts.events).toBeLessThan(BOARD.counts.events);
    for (const game of windowed.games) {
      expect(game.startTimeUnix).toBeGreaterThanOrEqual(cutoff);
    }
  });

  test("team names are trimmed without rewriting them", () => {
    const synthetic = parsePpmAllEvents({
      s: {
        1: {
          4: {
            9: {
              90: [
                ["  Athletics ", "", "", 1],
                ["Seattle  Mariners", "", "", 2],
                1_700_000_000,
              ],
            },
          },
        },
      },
    });
    const game = toDeskBoard(synthetic).games[0]!;
    expect(game.home.name).toBe("Athletics");
    expect(game.away.name).toBe("Seattle Mariners");
    expect(game.home.teamId).toBe(1);
  });
});

describe("sport labelling", () => {
  test("known sport ids resolve to a name", () => {
    expect(PPM_SPORT_NAMES[1]).toBe("Baseball");
    expect(PPM_SPORT_NAMES[5]).toBe("Soccer");
    expect(PPM_SPORT_NAMES[8]).toBe("Tennis");
  });

  test("an unknown sport id yields null, not a guess", () => {
    const synthetic = parsePpmAllEvents({
      s: {
        777: {
          12: {
            34: { 56: [["A", "", "", 1], ["B", "", "", 2], 1_700_000_000] },
          },
        },
      },
    });
    const board = toDeskBoard(synthetic);
    expect(board.games).toHaveLength(1);
    expect(board.games[0]!.sportName).toBeNull();
  });
});

describe("unresolved passthrough", () => {
  test("unresolved fixtures are counted but never become games", () => {
    const payload = {
      s: {
        1: {
          4: {
            1: { 11: [[""], [""], 1_700_000_000] },
            2: { 22: [["A", "", "", 1], ["B", "", "", 2], 1_700_000_100] },
          },
        },
      },
    };
    const board = toDeskBoard(parsePpmAllEvents(payload));
    expect(board.counts.games).toBe(1);
    expect(board.counts.events).toBe(1);
    expect(board.counts.unresolved).toBe(1);
    expect(board.games[0]!.eventIds).toEqual([22]);
  });
});
