import { describe, expect, test } from "bun:test";
import { canonicalSport, parseSportTypeList } from "./sport_vocabulary.ts";

describe("sport vocabulary", () => {
  const list = {
    LIST: [
      { sportType: "Basketball          ", "0": "Basketball          " },
      { sportType: "Football            ", "0": "Football            " },
      { sportType: "LIVE                ", "0": "LIVE                " },
      { sportType: "basketball          ", "0": "basketball          " },
      { sportType: "   " },
    ],
  };

  test("trims, preserves order and dedupes case-insensitively", () => {
    expect(parseSportTypeList(list)).toEqual([
      "Basketball",
      "Football",
      "LIVE",
    ]);
  });

  test("matches a canonical sport case-insensitively", () => {
    const vocab = parseSportTypeList(list);
    expect(canonicalSport(" live ", vocab)).toBe("LIVE");
    expect(canonicalSport("basketball", vocab)).toBe("Basketball");
    expect(canonicalSport("Tennis", vocab)).toBeNull();
  });

  test("a missing LIST is an empty vocabulary, not a throw", () => {
    expect(parseSportTypeList({})).toEqual([]);
    expect(parseSportTypeList(null)).toEqual([]);
  });
});
