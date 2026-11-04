import { describe, expect, test } from "bun:test";
import {
  canonicalizeGsLiveHeader,
  labelsFor,
  mapGsLiveHeaders,
} from "../lib/gslive_report_columns.ts";

describe("gslive report column labels", () => {
  test("maps the Last Bets UI labels", () => {
    expect(canonicalizeGsLiveHeader("Player")).toBe("player");
    expect(canonicalizeGsLiveHeader("Player Name")).toBe("player");
    expect(canonicalizeGsLiveHeader("Login")).toBe("player");
    expect(canonicalizeGsLiveHeader("To Win")).toBe("toWin");
    expect(canonicalizeGsLiveHeader("Sports")).toBe("sportLeague");
    expect(canonicalizeGsLiveHeader("Grade Time")).toBe("gradeTime");
    expect(canonicalizeGsLiveHeader("Max Time Until Score")).toBeNull();
  });

  test("ignores case and repeated whitespace", () => {
    expect(canonicalizeGsLiveHeader("  gRaDe   TIME ")).toBe("gradeTime");
    expect(canonicalizeGsLiveHeader("to   win")).toBe("toWin");
  });

  test("unobserved labels stay unknown rather than being guessed", () => {
    expect(canonicalizeGsLiveHeader("Lifetime EV")).toBeNull();
    expect(canonicalizeGsLiveHeader("Graded total")).toBeNull();
    expect(canonicalizeGsLiveHeader("")).toBeNull();
  });

  test("maps a header row positionally and reports gaps", () => {
    const mapped = mapGsLiveHeaders([
      "Player",
      "Risk",
      "To Win",
      "Market",
      "Mystery",
      "Market",
    ]);
    expect(mapped.columns).toEqual([
      "player",
      "risk",
      "toWin",
      "market",
      null,
      "market",
    ]);
    expect(mapped.unknown).toEqual(["Mystery"]);
    expect(mapped.duplicates).toEqual(["market"]);
  });

  test("preserves aliases for documentation", () => {
    expect(labelsFor("player")).toEqual(["Player", "Player Name", "Login"]);
    expect(labelsFor("sportLeague")).toEqual([
      "Sport / League",
      "Sports",
      "Sport",
    ]);
  });
});
