/**
 * @file tests/ppm_metadata.test.ts
 * @description The metadata endpoint resolves sports but not leagues, and the
 * board must prefer it over the measured fallback table.
 */
import { describe, expect, test } from "bun:test";
import { PpmMetadataError, parsePpmMetadata } from "../lib/ppm_metadata.ts";
import { parsePpmAllEvents } from "../lib/ppm_live_feed.ts";
import { toDeskBoard } from "../lib/ppm_desk_board.ts";
import {
  PpmJoinError,
  assertSportIdSpaceOverlap,
} from "../lib/ppm_join_guard.ts";

const CROP = new URL("./fixtures/ppm/metadata.crop.json", import.meta.url);
const META = parsePpmMetadata(await Bun.file(CROP).json());

describe("parsePpmMetadata", () => {
  test("extracts the sports dictionary", () => {
    expect(META.sportNames.get(1)).toBe("Baseball");
    expect(META.sportNames.get(93)).toBe("Table Tennis");
    expect(META.sportNames.get(102)).toBe("College Basketball");
    expect(META.counts.sports).toBe(4);
    expect(META.counts.unnamedSports).toBe(0);
  });

  test("counts the dictionaries it deliberately does not expose", () => {
    expect(META.counts.leagues).toBe(2);
    expect(META.counts.wagertypes).toBe(1);
  });

  test("rejects a payload without a sports map", () => {
    expect(() => parsePpmMetadata(null)).toThrow(PpmMetadataError);
    expect(() => parsePpmMetadata({})).toThrow(PpmMetadataError);
    // A nameless entry is skipped and counted, not fatal (sport 323 in prod).
    const withPlaceholder = parsePpmMetadata({
      sports: { 1: { n: "Baseball" }, 323: {} },
    });
    expect(withPlaceholder.sportNames.size).toBe(1);
    expect(withPlaceholder.counts.unnamedSports).toBe(1);
    expect(() => parsePpmMetadata({ sports: { abc: { n: "X" } } })).toThrow(
      PpmMetadataError,
    );
  });
});

describe("board naming precedence", () => {
  const snapshot = parsePpmAllEvents({
    s: {
      93: {
        4: {
          50630: { 11: [["A", "", "", 1], ["B", "", "", 2], 1_700_000_000] },
        },
      },
    },
  });

  test("metadata wins over the measured fallback", () => {
    expect(toDeskBoard(snapshot).games[0]!.sportName).toBeNull();
    const named = toDeskBoard(snapshot, { sportNames: META.sportNames });
    expect(named.games[0]!.sportName).toBe("Table Tennis");
  });

  test("the measured fallback still applies when metadata is absent", () => {
    const baseball = parsePpmAllEvents({
      s: {
        1: {
          6: { 8: { 12: [["A", "", "", 1], ["B", "", "", 2], 1_700_000_000] } },
        },
      },
    });
    expect(toDeskBoard(baseball).games[0]!.sportName).toBe("Baseball");
  });
});

describe("sport id space guard", () => {
  test("passes when the snapshot's sports are present in metadata", () => {
    expect(assertSportIdSpaceOverlap(META.sportNames.keys(), [1, 93])).toEqual({
      overlap: 2,
      total: 2,
      ratio: 1,
    });
  });

  test("throws when the metadata cannot name the snapshot's sports", () => {
    try {
      assertSportIdSpaceOverlap(META.sportNames.keys(), [1, 2, 3, 4]);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PpmJoinError);
      expect((error as PpmJoinError).code).toBe("sport_id_space_mismatch");
    }
  });
});
