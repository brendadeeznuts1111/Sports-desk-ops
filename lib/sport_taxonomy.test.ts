import { describe, expect, test } from "bun:test";
import {
  LIVE_FILTER,
  SPORT_CATEGORIES,
  sportCategoryFor,
  summarizeCategories,
  type SportCategory,
} from "./sport_taxonomy.ts";

describe("taxonomy", () => {
  test("matches the portal's ordering and wording", () => {
    expect(SPORT_CATEGORIES[0]).toBe("Auto Racing");
    expect(SPORT_CATEGORIES).toContain("Martial Arts");
    expect(SPORT_CATEGORIES).toContain("Virtual");
    // "All Sports" is the absence of a filter and "LIVE" is a state, so neither is a category.
    expect(SPORT_CATEGORIES as readonly string[]).not.toContain("All Sports");
    expect(SPORT_CATEGORIES as readonly string[]).not.toContain("LIVE");
    expect(LIVE_FILTER).toBe("LIVE");
  });

  test("has no duplicates", () => {
    expect(new Set(SPORT_CATEGORIES).size).toBe(SPORT_CATEGORIES.length);
  });
});

describe("sportCategoryFor", () => {
  test("maps the wire SportType the reports actually send", () => {
    expect(sportCategoryFor({ sportType: "Football" })).toBe("Football");
    expect(sportCategoryFor({ sportType: "Soccer              " })).toBe(
      "Soccer",
    );
    expect(sportCategoryFor({ sportType: "Basketball" })).toBe("Basketball");
    expect(sportCategoryFor({ sportType: "Hockey" })).toBe("Hockey");
  });

  test("honours padded and cased wire values", () => {
    expect(sportCategoryFor({ sportType: "  FOOTBALL  " })).toBe("Football");
    expect(sportCategoryFor({ sportType: "martial arts" })).toBe(
      "Martial Arts",
    );
  });

  test("falls back to the league only when SportType is unrecognised", () => {
    expect(
      sportCategoryFor({ sportType: "Unknown", sportSubType: "ENG PREM" }),
    ).toBe("Soccer");
    expect(sportCategoryFor({ sportType: "", sportSubType: "NFL " })).toBe(
      "Football",
    );
    // An exact SportType match must beat a league hint.
    expect(
      sportCategoryFor({ sportType: "Basketball", sportSubType: "NFL" }),
    ).toBe("Basketball");
  });

  test("keeps unknown sports visible as Other", () => {
    expect(sportCategoryFor({ sportType: "Kabaddi" })).toBe("Other");
    expect(sportCategoryFor({})).toBe("Other");
    expect(sportCategoryFor({ sportType: null })).toBe("Other");
  });

  test("accepts an already-normalised sport field", () => {
    expect(sportCategoryFor({ sport: "Hockey" })).toBe("Hockey");
  });
});

describe("summarizeCategories", () => {
  const rows: Array<{ category: SportCategory; live?: boolean }> = [
    { category: "Football", live: true },
    { category: "Football", live: false },
    { category: "Soccer", live: false },
    { category: "Other", live: false },
  ];

  test("counts games and live games per category", () => {
    const summary = summarizeCategories(rows);
    const football = summary.find((s) => s.category === "Football");
    expect(football?.games).toBe(2);
    expect(football?.live).toBe(1);
  });

  test("omits empty categories and preserves taxonomy order", () => {
    const summary = summarizeCategories(rows);
    expect(summary.map((s) => s.category)).toEqual([
      "Football",
      "Other",
      "Soccer",
    ]);
    expect(summary.some((s) => s.category === "Cricket")).toBe(false);
  });

  test("returns nothing for no rows", () => {
    expect(summarizeCategories([])).toEqual([]);
  });
});
