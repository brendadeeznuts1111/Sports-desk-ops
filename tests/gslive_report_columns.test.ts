import { describe, expect, test } from "bun:test";
import {
  canonicalizeGsLiveHeader,
  labelsFor,
  mapGsLiveHeaders,
} from "../lib/gslive_report_columns.ts";

describe("gslive report column labels", () => {
  test("maps the labels observed in the public i18n bundle", () => {
    expect(canonicalizeGsLiveHeader("Player")).toBe("login");
    expect(canonicalizeGsLiveHeader("Player Name")).toBe("login");
    expect(canonicalizeGsLiveHeader("Login")).toBe("login");
    expect(canonicalizeGsLiveHeader("Graded total")).toBe("gradedTotal");
    expect(canonicalizeGsLiveHeader("Pending total")).toBe("pendingTotal");
    expect(canonicalizeGsLiveHeader("Wager Count")).toBe("wagerCount");
    expect(canonicalizeGsLiveHeader("To Win")).toBe("toWin");
    expect(canonicalizeGsLiveHeader("Vigorish")).toBe("vigorish");
    expect(canonicalizeGsLiveHeader("Sports")).toBe("sport");
  });

  test("ignores case and repeated whitespace", () => {
    expect(canonicalizeGsLiveHeader("  gRaDeD   TOTAL ")).toBe("gradedTotal");
    expect(canonicalizeGsLiveHeader("to   win")).toBe("toWin");
  });

  test("unobserved labels stay unknown rather than being guessed", () => {
    expect(canonicalizeGsLiveHeader("Lifetime EV")).toBeNull();
    expect(canonicalizeGsLiveHeader("Turnover")).toBeNull();
    expect(canonicalizeGsLiveHeader("")).toBeNull();
  });

  test("maps a header row positionally and reports gaps", () => {
    const mapped = mapGsLiveHeaders([
      "Player",
      "Bet",
      "To Win",
      "Win",
      "Loss",
      "Mystery",
      "Win",
    ]);
    expect(mapped.columns).toEqual([
      "login",
      "bet",
      "toWin",
      "win",
      "loss",
      null,
      "win",
    ]);
    expect(mapped.unknown).toEqual(["Mystery"]);
    expect(mapped.duplicates).toEqual(["win"]);
  });

  test("preserves the label aliases for documentation", () => {
    expect(labelsFor("login")).toEqual(["Player", "Player Name", "Login"]);
    expect(labelsFor("sport")).toEqual(["Sports", "Sport"]);
  });
});
