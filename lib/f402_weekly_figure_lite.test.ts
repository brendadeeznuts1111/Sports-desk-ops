import { describe, expect, test } from "bun:test";

import {
  buildWeeklyFigureLiteFormBody,
  parseWeeklyFigureLite,
  storedWeeklyFigureLite,
  WeeklyFigureLiteShapeError,
} from "./f402_weekly_figure_lite.ts";

const response = (row: unknown) => ({
  LIST: { ARRAY: row === undefined ? [] : [row], INFO: "INFO" },
});

describe("f402_weekly_figure_lite", () => {
  test("buildWeeklyFigureLiteFormBody matches manager boot HAR shape", () => {
    const body = buildWeeklyFigureLiteFormBody({
      agentID: "BILLY666",
      agentOwner: "BILLY666",
    });
    expect(body.get("operation")).toBe("getWeeklyFigureByAgentLite");
    expect(body.get("agentID")).toBe("BILLY666");
    expect(body.get("agentOwner")).toBe("BILLY666");
    expect(body.get("week")).toBe("0");
    expect(body.get("type")).toBe("A");
    expect(body.get("layout")).toBe("byDay");
    expect(body.get("RRO")).toBe("1");
  });

  test("parses LIST.ARRAY[0] figures, keeping float sums as sent", () => {
    expect(
      parseWeeklyFigureLite(
        response({ ThisWeek: 1234.5600000001, Active: 42, Today: -78.9 }),
      ),
    ).toEqual({
      kind: "figures",
      activePlayers: 42,
      thisWeek: 1234.5600000001,
      today: -78.9,
    });
  });

  test("null money fields stay null; Active -1 is withheld; empty ARRAY is empty", () => {
    expect(
      parseWeeklyFigureLite(response({ ThisWeek: null, Active: 3, Today: null })),
    ).toEqual({ kind: "figures", activePlayers: 3, thisWeek: null, today: null });
    expect(
      parseWeeklyFigureLite(response({ ThisWeek: 5, Active: -1, Today: 1 })),
    ).toEqual({ kind: "withheld" });
    expect(parseWeeklyFigureLite(response(undefined))).toEqual({ kind: "empty" });
  });

  test("rejects shapes the manager page could not render", () => {
    for (const bad of [
      null,
      {},
      { LIST: {} },
      { LIST: { ARRAY: "x" } },
      response("row"),
      response({ ThisWeek: 1, Today: 1 }),
      response({ ThisWeek: 1, Active: 2.5, Today: 1 }),
      response({ ThisWeek: 1, Active: -2, Today: 1 }),
      response({ ThisWeek: "1", Active: 2, Today: 1 }),
      response({ ThisWeek: 1, Active: 2, Today: Number.NaN }),
    ]) {
      expect(() => parseWeeklyFigureLite(bad)).toThrow(WeeklyFigureLiteShapeError);
    }
  });

  test("storedWeeklyFigureLite round-trips through JSON and rejects raw or partial records", () => {
    const fetchedAt = "2026-11-01T18:00:00.000Z";
    for (const figure of [
      parseWeeklyFigureLite(response({ ThisWeek: 10, Active: 1, Today: null })),
      parseWeeklyFigureLite(response({ ThisWeek: 10, Active: -1, Today: 1 })),
      parseWeeklyFigureLite(response(undefined)),
    ]) {
      const stored = { agentId: "MASTER", figure, fetchedAt };
      expect(storedWeeklyFigureLite(JSON.parse(JSON.stringify(stored)))).toEqual(
        stored,
      );
    }
    const figure = { kind: "figures", activePlayers: 1, thisWeek: 1, today: 1 };
    for (const bad of [
      null,
      response({ ThisWeek: 10, Active: 1, Today: 2 }),
      figure,
      { figure, fetchedAt },
      { agentId: "MASTER", figure },
      { agentId: "MASTER", figure: { ...figure, activePlayers: -1 }, fetchedAt },
      { agentId: "MASTER", figure: { ...figure, thisWeek: "1" }, fetchedAt },
    ]) {
      expect(storedWeeklyFigureLite(bad)).toBeNull();
    }
  });
});
