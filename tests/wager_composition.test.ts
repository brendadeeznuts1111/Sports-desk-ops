import { describe, expect, test } from "bun:test";
import {
  compositionLabel,
  describeWagerComposition,
  splitWireLegs,
} from "../lib/wager_composition.ts";

const SUNS_SPREAD = "S.Basketball #520 Suns +3 -110 - For Game";
const SUNS_TOTAL = "S.Basketball #520 Suns OVER 210 -110 - For Game";
const LAKERS = "S.Basketball #521 Lakers -2 -105";
const CHIEFS = "S.Football #400 Chiefs -3 -110 - For Game";
const GOLF = "S.Golf #900 Round Leader -120";
const JUNK = "not a market at all";

describe("splitWireLegs", () => {
  test("splits on the three wire separators", () => {
    expect(splitWireLegs(`a | b\r\nc&#x0D;d`)).toEqual(["a", "b", "c", "d"]);
  });

  test("strips a leading ticket prefix and drops standalone ticket references", () => {
    expect(splitWireLegs("A: leg one | A. leg two")).toEqual([
      "leg one",
      "leg two",
    ]);
    // The sport sigil (`S.`) matches the leading-prefix rule, so it is stripped too; the
    // parser still recognizes "Basketball #520 Suns" without it.
    expect(splitWireLegs(`${SUNS_SPREAD} | M.G320197818`)).toEqual([
      "Basketball #520 Suns +3 -110 - For Game",
    ]);
    expect(splitWireLegs("M.G320197818")).toEqual([]);
  });

  test("keeps empty input empty", () => {
    expect(splitWireLegs("")).toEqual([]);
    expect(splitWireLegs(null)).toEqual([]);
    expect(splitWireLegs(undefined)).toEqual([]);
    expect(splitWireLegs("   ")).toEqual([]);
  });
});

describe("describeWagerComposition", () => {
  test("classifies a single leg", () => {
    const composition = describeWagerComposition(SUNS_SPREAD);
    expect(composition.kind).toBe("single");
    expect(composition.legCount).toBe(1);
    expect(composition.splitLegs).toBe(1);
    expect(composition.sports).toEqual(["Basketball"]);
    expect(composition.events).toEqual(["basketball|suns"]);
    expect(composition.legs[0]).toMatchObject({
      sport: "Basketball",
      eventLabel: "Suns",
      eventKey: "basketball|suns",
      marketType: "spread",
      parsed: true,
    });
  });

  test("classifies two markets of one event as same_game", () => {
    const composition = describeWagerComposition(
      `${SUNS_SPREAD} | ${SUNS_TOTAL}`,
    );
    expect(composition.kind).toBe("same_game");
    expect(composition.legCount).toBe(2);
    expect(composition.events).toEqual(["basketball|suns"]);
  });

  test("classifies one sport, two events as cross_game", () => {
    const composition = describeWagerComposition(`${SUNS_SPREAD} | ${LAKERS}`);
    expect(composition.kind).toBe("cross_game");
    expect(composition.events).toEqual([
      "basketball|suns",
      "basketball|lakers",
    ]);
    expect(composition.sports).toEqual(["Basketball"]);
  });

  test("classifies two sports as cross_sport even when events differ", () => {
    const composition = describeWagerComposition(`${SUNS_SPREAD} | ${CHIEFS}`);
    expect(composition.kind).toBe("cross_sport");
    expect(composition.sports).toEqual(["Basketball", "Football"]);
  });

  test("classifies a repeated event alongside a new one as mixed", () => {
    const composition = describeWagerComposition(
      `${SUNS_SPREAD} | ${SUNS_TOTAL} | ${LAKERS}`,
    );
    expect(composition.kind).toBe("mixed");
    expect(composition.legCount).toBe(3);
    expect(composition.events).toEqual([
      "basketball|suns",
      "basketball|lakers",
    ]);
  });

  test("classifies legs with no recoverable event identity as unknown", () => {
    const composition = describeWagerComposition(`${JUNK} | also nothing`);
    expect(composition.kind).toBe("unknown");
    expect(composition.sports).toEqual([]);
    expect(composition.events).toEqual([]);
    // Quirk pinned deliberately: `parseBetMarket` returns an empty record rather than throwing,
    // so these legs are "parsed" with null identity and `unparsedLegs` stays 0.
    expect(composition.unparsedLegs).toBe(0);
    expect(composition.legs[0]).toMatchObject({
      sport: null,
      eventKey: null,
      parsed: true,
    });
  });

  test("classifies an empty description as single with zero legs", () => {
    const composition = describeWagerComposition("");
    expect(composition.kind).toBe("single");
    expect(composition.legCount).toBe(0);
    expect(composition.splitLegs).toBe(0);
  });

  test("declared picks raise the leg count without inventing legs", () => {
    const composition = describeWagerComposition(SUNS_SPREAD, 3);
    expect(composition.declaredPicks).toBe(3);
    expect(composition.legCount).toBe(3);
    expect(composition.splitLegs).toBe(1);
    // One recovered event and no repeated event cannot describe a 3-leg ticket.
    expect(composition.kind).toBe("unknown");
  });

  test("truncates fractional declared picks and ignores non-finite ones", () => {
    expect(describeWagerComposition(SUNS_SPREAD, 1.9).declaredPicks).toBe(1);
    expect(describeWagerComposition(SUNS_SPREAD, 1.9).kind).toBe("single");
    expect(
      describeWagerComposition(SUNS_SPREAD, Number.NaN).declaredPicks,
    ).toBeNull();
    expect(describeWagerComposition(SUNS_SPREAD, Number.NaN).legCount).toBe(1);
  });

  test("flags golf futures as excluded without hiding the composition", () => {
    const composition = describeWagerComposition(`${GOLF} | ${GOLF}`);
    expect(composition.excludedFutures).toBe(true);
    expect(composition.sports).toEqual(["Golf"]);
    expect(composition.kind).toBe("same_game");
    expect(compositionLabel(composition)).toBe("futures (excluded)");
  });

  test("dedupes sports and events across legs", () => {
    const composition = describeWagerComposition(
      `${SUNS_SPREAD} | ${SUNS_TOTAL} | ${LAKERS} | ${CHIEFS}`,
    );
    expect(composition.sports).toEqual(["Basketball", "Football"]);
    expect(composition.events).toEqual([
      "basketball|suns",
      "basketball|lakers",
      "football|chiefs",
    ]);
  });
});

describe("compositionLabel", () => {
  test("labels the four report shapes", () => {
    expect(compositionLabel(describeWagerComposition(SUNS_SPREAD))).toBe(
      "single",
    );
    expect(
      compositionLabel(describeWagerComposition(`${SUNS_SPREAD} | ${CHIEFS}`)),
    ).toBe("cross_sport (2 legs, Basketball+Football)");
    expect(
      compositionLabel(describeWagerComposition(`${JUNK} | also nothing`)),
    ).toBe("unknown (2 legs, unknown sport)");
  });
});
