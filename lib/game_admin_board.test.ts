import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BOARD_WINDOWS,
  biggestSide,
  filterByWindow,
  parseBoardWindow,
  readBoardFile,
  sidesOf,
  summarizeBoard,
  type BoardFile,
  type BoardGame,
} from "./game_admin_board.ts";

const file = readBoardFile(
  JSON.parse(
    readFileSync(
      resolve(import.meta.dir, "../data/game-admin-board.json"),
      "utf8",
    ),
  ),
) as BoardFile;

describe("readBoardFile", () => {
  test("loads the committed board with four games", () => {
    expect(file.games).toHaveLength(4);
    expect(file.observedAt).toBe("2026-11-01");
    expect(file.source).toContain("Game Admin");
  });

  test("rejects a game missing a market", () => {
    const broken = {
      games: [
        {
          gameNum: 1,
          teams: ["A", "B"],
          spread: [],
          money: [],
          total: [],
          teamTotal: [],
        },
      ],
    };
    expect(readBoardFile(broken)).toBeNull();
  });

  test("rejects foreign payloads", () => {
    expect(readBoardFile(null)).toBeNull();
    expect(readBoardFile({})).toBeNull();
    expect(readBoardFile({ games: [] })).toBeNull();
  });
});

describe("amount honesty", () => {
  test("abbreviated portal figures stay approximate", () => {
    const rams = file.games[0]?.spread[1];
    expect(rams?.amount).toBe("120k");
    expect(rams?.amountExact).toBeNull();

    const chiefs = file.games[1]?.spread[0];
    expect(chiefs?.amount).toBe("163k");
    expect(chiefs?.amountExact).toBeNull();
  });

  test("exact figures keep their integer", () => {
    const chargers = file.games[0]?.spread[0];
    expect(chargers?.amount).toBe("53,903");
    expect(chargers?.amountExact).toBe(53903);
  });

  test("a zero side is exact, not missing", () => {
    const side = file.games[0]?.teamTotal[0];
    expect(side?.underAmountExact).toBe(0);
    expect(side?.underAmount).toBe("0");
  });
});

describe("sidesOf", () => {
  test("expands team totals into over and under rows per team", () => {
    const game = file.games[0] as BoardGame;
    const sides = sidesOf(game, "teamTotal");
    expect(sides).toHaveLength(4);
    expect(sides.map((s) => s.side)).toEqual([
      "Los Angeles Chargers OVER",
      "Los Angeles Chargers UNDER",
      "Los Angeles Rams OVER",
      "Los Angeles Rams UNDER",
    ]);
  });

  test("returns the pair for a normal market", () => {
    const game = file.games[0] as BoardGame;
    expect(sidesOf(game, "spread").map((s) => s.line)).toEqual(["+6½", "-6½"]);
    expect(sidesOf(game, "total").map((s) => s.side)).toEqual([
      "OVER",
      "UNDER",
    ]);
  });
});

describe("summarizeBoard", () => {
  const summary = summarizeBoard(file);

  test("counts live and scheduled games", () => {
    expect(summary.games).toBe(4);
    expect(summary.live).toBe(3);
    expect(summary.scheduled).toBe(1);
  });

  test("separates proven sums from approximate sides", () => {
    for (const market of summary.byMarket) {
      // 4 games x 2 sides; team totals carry over and under per team, so twice that.
      const expected = market.market === "teamTotal" ? 16 : 8;
      expect(market.proven + market.approximate).toBe(expected);
    }

    const spread = summary.byMarket.find((m) => m.market === "spread");
    // 120k, 163k, 111k and 123k are abbreviated; the other four are exact integers.
    expect(spread?.approximate).toBe(4);
    expect(spread?.proven).toBe(4);
    expect(spread?.sumExact).toBe(53903 + 71128 + 7129 + 91003);
  });
});

describe("biggestSide", () => {
  test("finds the largest proven exposure and names its game", () => {
    const best = biggestSide(file);
    expect(best?.side.amountExact).toBe(91003);
    expect(best?.game.teams[1]).toBe("Washington Commanders");
    expect(best?.market).toBe("spread");
  });

  test("never picks an approximated side over a proven one", () => {
    const zeroed: BoardFile = {
      ...file,
      games: file.games.map((game) => ({
        ...game,
        spread: [
          { ...game.spread[0], amountExact: null },
          { ...game.spread[1], amountExact: 1 },
        ] as BoardGame["spread"],
      })),
    };
    // With every spread approximation in play, the largest proven figure is a total, not a
    // spread — an abbreviated 120k must never beat a proven integer.
    expect(biggestSide(zeroed)?.side.amountExact).toBe(50314);
    expect(biggestSide(zeroed)?.market).toBe("total");
  });
});

describe("filterByWindow", () => {
  test("today returns the games dated observedAt", () => {
    const games = filterByWindow(file, "24");
    expect(games).toHaveLength(4);
    expect(games.every((game) => game.date === "2026-11-01")).toBe(true);
  });

  test("yesterday returns nothing for a single-day board rather than repeating today", () => {
    expect(filterByWindow(file, "48")).toEqual([]);
  });

  test("current board keeps live and scheduled, drops finals", () => {
    const withFinal: BoardFile = {
      ...file,
      games: file.games.map((game, index) =>
        index === 0 ? { ...game, status: "final" } : game,
      ),
    };
    const games = filterByWindow(withFinal, "-1");
    expect(games).toHaveLength(3);
    expect(games.every((game) => game.status !== "final")).toBe(true);
  });

  test("a day window with no reference date returns nothing", () => {
    expect(filterByWindow({ ...file, observedAt: null }, "48")).toEqual([]);
  });

  test("the selector vocabulary matches the portal", () => {
    expect(BOARD_WINDOWS.map((w) => w.value)).toEqual(["48", "24", "-1"]);
    expect(BOARD_WINDOWS.map((w) => w.label)).toEqual([
      "Yesterday",
      "Today",
      "Current Board",
    ]);
    expect(parseBoardWindow(null)).toBe("24");
    expect(parseBoardWindow("99")).toBeNull();
  });
});
