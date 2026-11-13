import { describe, expect, test } from "bun:test";
import {
  deriveGameIdentifier,
  normalizeCanonicalPeriod,
  normalizeCanonicalSubject,
} from "../lib/leg_taxonomy.ts";

describe("normalizeCanonicalPeriod", () => {
  test("maps missing and empty input to game", () => {
    expect(normalizeCanonicalPeriod(null)).toBe("game");
    expect(normalizeCanonicalPeriod(undefined)).toBe("game");
    expect(normalizeCanonicalPeriod("")).toBe("game");
  });

  test("maps the numeric period codes 0-6", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(normalizeCanonicalPeriod)).toEqual([
      "game",
      "1h",
      "2h",
      "1q",
      "2q",
      "3q",
      "4q",
    ]);
    expect(normalizeCanonicalPeriod(7)).toBe("game");
    expect(normalizeCanonicalPeriod(-1)).toBe("game");
  });

  test("maps the numeric strings the same way as the numbers", () => {
    expect(normalizeCanonicalPeriod("3")).toBe("1q");
    expect(normalizeCanonicalPeriod("6")).toBe("4q");
    expect(normalizeCanonicalPeriod("0")).toBe("game");
  });

  test("accepts the game and half vocabulary", () => {
    expect(normalizeCanonicalPeriod("FULL_GAME")).toBe("game");
    expect(normalizeCanonicalPeriod("fg")).toBe("game");
    expect(normalizeCanonicalPeriod("1st Half")).toBe("1h");
    expect(normalizeCanonicalPeriod("first half")).toBe("1h");
    expect(normalizeCanonicalPeriod("2nd half")).toBe("2h");
    expect(normalizeCanonicalPeriod("1H")).toBe("1h");
  });

  test("accepts both quarter spellings", () => {
    expect(normalizeCanonicalPeriod("1st quarter")).toBe("1q");
    expect(normalizeCanonicalPeriod("Q1")).toBe("1q");
    expect(normalizeCanonicalPeriod("2nd quarter")).toBe("2q");
    expect(normalizeCanonicalPeriod("3rd quarter")).toBe("3q");
    expect(normalizeCanonicalPeriod("4th quarter")).toBe("4q");
    expect(normalizeCanonicalPeriod("q4")).toBe("4q");
  });

  test("maps the live markers and falls back to game", () => {
    expect(normalizeCanonicalPeriod("0g")).toBe("live");
    expect(normalizeCanonicalPeriod("LIVE")).toBe("live");
    expect(normalizeCanonicalPeriod("in-play")).toBe("live");
    expect(normalizeCanonicalPeriod("banana")).toBe("game");
  });
});

describe("normalizeCanonicalSubject", () => {
  test("maps missing and blank input to UNKNOWN", () => {
    expect(normalizeCanonicalSubject(undefined)).toBe("UNKNOWN");
    expect(normalizeCanonicalSubject("")).toBe("UNKNOWN");
    expect(normalizeCanonicalSubject("   ")).toBe("UNKNOWN");
  });

  test("resolves the exact alias table", () => {
    expect(normalizeCanonicalSubject("NE")).toBe("NE");
    expect(normalizeCanonicalSubject("KC")).toBe("KC");
    expect(normalizeCanonicalSubject("ALA")).toBe("ALA");
    expect(normalizeCanonicalSubject("OSU")).toBe("OSU");
    expect(normalizeCanonicalSubject("NYJ")).toBe("NYJ");
    expect(normalizeCanonicalSubject("LAL")).toBe("LAL");
    expect(normalizeCanonicalSubject("BOS")).toBe("BOS");
    expect(normalizeCanonicalSubject("GSW")).toBe("GSW");
    expect(normalizeCanonicalSubject("DEN")).toBe("DEN");
    expect(normalizeCanonicalSubject("PHX")).toBe("PHX");
    expect(normalizeCanonicalSubject("MIL")).toBe("MIL");
    expect(normalizeCanonicalSubject("NYK")).toBe("NYK");
    expect(normalizeCanonicalSubject("DAL_NBA")).toBe("DAL_NBA");
    expect(normalizeCanonicalSubject("DAL")).toBe("DAL");
  });

  test("resolves full names by substring", () => {
    expect(normalizeCanonicalSubject("New England Patriots")).toBe("NE");
    expect(normalizeCanonicalSubject("Kansas City Chiefs")).toBe("KC");
    expect(normalizeCanonicalSubject("Golden State Warriors")).toBe("GSW");
    expect(normalizeCanonicalSubject("Phoenix Suns")).toBe("PHX");
    expect(normalizeCanonicalSubject("Dallas Mavericks")).toBe("DAL_NBA");
    expect(normalizeCanonicalSubject("Dallas Cowboys")).toBe("DAL");
    expect(normalizeCanonicalSubject("Sacramento Kings")).toBe("SAC_ST");
    expect(normalizeCanonicalSubject("UCF Knights")).toBe("UCF");
    expect(normalizeCanonicalSubject("Troy")).toBe("TROY");
    expect(normalizeCanonicalSubject("NY Jets")).toBe("NYJ");
  });

  test("is case-insensitive and uppercases the fallback with underscores", () => {
    expect(normalizeCanonicalSubject("tampa bay")).toBe("TAMPA_BAY");
    expect(normalizeCanonicalSubject("  tampa   bay  ")).toBe("TAMPA_BAY");
    expect(normalizeCanonicalSubject("unknown team")).toBe("UNKNOWN_TEAM");
    expect(normalizeCanonicalSubject("South Florida")).toBe("SOUTH_FLORIDA");
  });

  test("pins the cross-sport collisions the flat table carries", () => {
    // The rules are first-match-wins across sports; these are the collisions that survive.
    expect(normalizeCanonicalSubject("Boston College")).toBe("BOS");
    expect(normalizeCanonicalSubject("Denver Broncos")).toBe("DEN");
    expect(normalizeCanonicalSubject("Winnipeg Jets")).toBe("NYJ");
  });
});

describe("deriveGameIdentifier", () => {
  test("uppercases the family and sorts the subject pair", () => {
    expect(deriveGameIdentifier("cfb", "Troy", "Baylor")).toBe(
      "CFB:BAYLOR_VS_TROY",
    );
    expect(deriveGameIdentifier("cfb", "Baylor", "Troy")).toBe(
      "CFB:BAYLOR_VS_TROY",
    );
    expect(deriveGameIdentifier("nba", "boston celtics", "lakers")).toBe(
      "NBA:BOS_VS_LAL",
    );
  });

  test("uses OPP when no opponent is supplied", () => {
    expect(deriveGameIdentifier("nfl", "KC")).toBe("NFL:KC_VS_OPP");
  });

  test("normalizes both sides before pairing", () => {
    expect(deriveGameIdentifier("cfb", "baylor", "Baylor Bears")).toBe(
      "CFB:BAYLOR_VS_BAYLOR",
    );
    // A blank subject normalizes to UNKNOWN (not OPP, which means "no opponent supplied").
    expect(deriveGameIdentifier("nfl", "  ", "Tampa Bay")).toBe(
      "NFL:TAMPA_BAY_VS_UNKNOWN",
    );
  });
});
