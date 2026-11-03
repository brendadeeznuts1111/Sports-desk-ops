import { describe, expect, test } from "bun:test";
import {
  GSLIVE_PERIOD_BASE_CODES,
  gsLivePeriodName,
  listGsLivePeriodOptions,
  parseGsLiveSportPeriods,
  resolveGsLivePeriodCode,
} from "../lib/gslive_period_logic.ts";

const FIXTURE = new URL(
  "./fixtures/gslive-sport-periods-2026-11-03.json",
  import.meta.url,
);
const payload: unknown = await Bun.file(FIXTURE).json();
const vocabulary = parseGsLiveSportPeriods(payload);

describe("GSLive sportPeriods vocabulary", () => {
  test("parses the captured payload with the documented counts", () => {
    expect(vocabulary).not.toBeNull();
    if (vocabulary === null) return;
    expect(Object.keys(vocabulary.periods)).toHaveLength(102);
    expect(Object.keys(vocabulary.abbreviations)).toHaveLength(10);
    expect(Object.keys(vocabulary.periodNames)).toHaveLength(40);
    expect(vocabulary.abbreviations.Quarter).toBe("Qtr");
    expect(vocabulary.periodNames["1"]).toBe("Inning");
  });

  test("refuses malformed payloads instead of inventing an empty vocabulary", () => {
    expect(parseGsLiveSportPeriods(null)).toBeNull();
    expect(parseGsLiveSportPeriods([])).toBeNull();
    expect(parseGsLiveSportPeriods("periods")).toBeNull();
    expect(parseGsLiveSportPeriods({})).toBeNull();
    expect(
      parseGsLiveSportPeriods({
        periods: [],
        abbreviations: {},
        periodNames: {},
      }),
    ).toBeNull();
    expect(
      parseGsLiveSportPeriods({
        periods: { 2: [] },
        abbreviations: {},
        periodNames: {},
      }),
    ).toBeNull();
    expect(
      parseGsLiveSportPeriods({
        periods: { 2: { m: "Game" } },
        abbreviations: { Quarter: 1 },
        periodNames: {},
      }),
    ).toBeNull();
  });

  test("lists a sport's periods in console order with labels and overrides", () => {
    if (vocabulary === null) return;
    const basketball = listGsLivePeriodOptions(vocabulary, "2");
    expect(basketball.map((option) => option.code)).toEqual([
      ...GSLIVE_PERIOD_BASE_CODES,
    ]);
    expect(basketball.find((option) => option.code === "s5")).toEqual({
      code: "s5",
      label: "Regulation Time",
      overridden: true,
    });
    expect(gsLivePeriodName(vocabulary, "2")).toBe("Quarter");

    const baseball = listGsLivePeriodOptions(vocabulary, "1");
    expect(baseball.find((option) => option.code === "h1")?.label).toBe(
      "1st 5 Innings",
    );
    expect(gsLivePeriodName(vocabulary, "1")).toBe("Inning");

    // "NA" labels are not selectable, so they are not options a link can carry.
    const championship = listGsLivePeriodOptions(vocabulary, "16");
    expect(championship.map((option) => option.code)).toEqual(["ht", "s10"]);
  });

  test("resolves labels and codes against one sport at a time", () => {
    if (vocabulary === null) return;
    expect(resolveGsLivePeriodCode(vocabulary, "2", "3rd Quarter")?.code).toBe(
      "s3",
    );
    expect(
      resolveGsLivePeriodCode(vocabulary, "2", " 3RD   quarter ")?.code,
    ).toBe("s3");
    expect(resolveGsLivePeriodCode(vocabulary, "2", "S3")?.code).toBe("s3");
    expect(
      resolveGsLivePeriodCode(vocabulary, "2", "Regulation Time")?.code,
    ).toBe("s5");
    expect(resolveGsLivePeriodCode(vocabulary, "1", "1st Inning")?.code).toBe(
      "s1",
    );
    // The same label belongs to a different code per sport, and to only one sport here.
    expect(resolveGsLivePeriodCode(vocabulary, "1", "4th Inning")?.code).toBe(
      "s4",
    );
    expect(
      resolveGsLivePeriodCode(vocabulary, "2", "4th Inning"),
    ).toBeUndefined();
    expect(
      resolveGsLivePeriodCode(vocabulary, "999", "1st Half"),
    ).toBeUndefined();
    expect(resolveGsLivePeriodCode(vocabulary, "2", "")).toBeUndefined();
  });
});
