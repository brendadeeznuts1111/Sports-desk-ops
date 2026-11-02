import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  findSubSport,
  loadSportCatalog,
  periodTypeIndex,
  periodsFor,
  subSportIndex,
  summarizeCatalog,
  type SportCatalogFile,
} from "./sport_catalog.ts";

const fixture = loadSportCatalog(
  JSON.parse(
    readFileSync(
      resolve(
        import.meta.dir,
        "../tests/fixtures/fantasy402-sport-catalog-2026-10-21.json",
      ),
      "utf8",
    ),
  ),
) as SportCatalogFile;

describe("loadSportCatalog", () => {
  test("loads the committed fixture with its declared counts", () => {
    expect(fixture).not.toBeNull();
    const summary = summarizeCatalog(fixture);
    expect(summary.sports).toBe(fixture.sportCount);
    expect(summary.subSports).toBe(fixture.subSportCount);
    expect(summary.periodEntries).toBe(fixture.sportPeriodCount);
    expect(fixture.provider).toBe("fantasy402");
  });

  test("rejects foreign payloads", () => {
    expect(loadSportCatalog(null)).toBeNull();
    expect(loadSportCatalog({})).toBeNull();
    expect(loadSportCatalog({ sportCount: 1, sports: [] })).toBeNull();
    expect(loadSportCatalog({ sports: [{ sport: "X" }] })).toBeNull();
  });
});

describe("periodTypeIndex", () => {
  const index = periodTypeIndex(fixture);

  test("reports every number the catalog uses", () => {
    expect(index.map((entry) => entry.number)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("flags sport-specific numbers instead of picking one name", () => {
    const one = index.find((entry) => entry.number === 1);
    expect(one?.sportSpecific).toBe(true);
    expect(one?.names).toEqual(["1st 5 Innings", "1st Half", "1st Period"]);
    expect(one?.sports).toContain("Baseball");
    expect(one?.sports).toContain("Hockey");
  });

  test("only number 0 is unambiguous", () => {
    const zero = index.find((entry) => entry.number === 0);
    expect(zero?.names).toEqual(["Game"]);
    expect(zero?.sportSpecific).toBe(false);
  });

  test("numbers 3 and up mix hockey periods with basketball quarters", () => {
    const three = index.find((entry) => entry.number === 3);
    expect(three?.names).toEqual(["1st Quarter", "3rd Period"]);
    expect(three?.sportSpecific).toBe(true);
  });
});

describe("subSportIndex", () => {
  const index = subSportIndex(fixture);

  test("exposes the desk-link collisions the catalog records", () => {
    const arena = index.find((entry) => entry.code === "Arena");
    expect(arena?.collision).toBe(true);
    expect(arena?.sports).toEqual(["Football", "Horse Racing"]);

    const ncaa = index.find((entry) => entry.code === "NCAA Extra");
    expect(ncaa?.sports).toEqual(["Basketball", "Hockey"]);
  });

  test("most codes belong to exactly one sport", () => {
    const single = index.filter((entry) => !entry.collision);
    expect(single.length).toBeGreaterThan(index.length - 5);
  });
});

describe("lookups require both sport and code", () => {
  test("the same code under a different sport is a different market", () => {
    const football = findSubSport(fixture, "Football", "Arena");
    const racing = findSubSport(fixture, "Horse Racing", "Arena");
    expect(football).not.toBeNull();
    expect(racing).not.toBeNull();
    expect(football?.code).toBe(racing?.code);
  });

  test("unknown sport or code returns null rather than the nearest match", () => {
    expect(findSubSport(fixture, "Kabaddi", "Arena")).toBeNull();
    expect(findSubSport(fixture, "Football", "NOPE")).toBeNull();
  });
});

describe("periodsFor", () => {
  test("returns the sport's own menu, not a global table", () => {
    const hockey = periodsFor(fixture, "Hockey").map((p) => p.name);
    const basketball = periodsFor(fixture, "Basketball").map((p) => p.name);
    expect(hockey).toContain("1st Period");
    expect(basketball).toContain("1st Quarter");
    expect(hockey).not.toContain("1st Quarter");
  });

  test("every sport has at least the full game period", () => {
    for (const sport of fixture.sports) {
      expect(sport.periods[0]?.number).toBe(0);
      expect(sport.periods[0]?.name).toBe("Game");
    }
  });

  test("unknown sport yields an empty menu", () => {
    expect(periodsFor(fixture, "Kabaddi")).toEqual([]);
  });
});
