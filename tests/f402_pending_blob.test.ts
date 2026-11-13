import { describe, expect, test } from "bun:test";
import {
  catalogIdToBlobRotation,
  formatParsedPendingBlob,
  isPendingBlobRow,
  PENDING_BLOB_ROTATION_BASE,
  PENDING_BLOB_ROTATION_TOP,
  parsePendingBlobDescription,
  pendingBlobChannel,
  resolvePendingRollupDimensions,
  sanitizePendingBlobText,
  splitPendingBlobSegments,
} from "../lib/f402_pending_blob.ts";

const CONTEST =
  "FOOTBALL - #NFL Futures - #To win Super Bowl - #Odds to win 2026-27 Super Bowl - Chicago Bears +1100 for  Game";
const BUILDER =
  "G1234 FOOTBALL - Team A vs Team B / 1st Half / Moneyline / Team A -110";
const TWO_LEG =
  "G111 FOOTBALL - A vs B / Game / Moneyline / A\nG222 BASKETBALL - C vs D / Game / Spread / C -3";

describe("sanitizePendingBlobText", () => {
  test("normalizes entities, stray CR and the id line break", () => {
    expect(
      sanitizePendingBlobText("G55 \n\nFOOTBALL &frac12; &#x0D;x\r\ny"),
    ).toBe("G55 FOOTBALL ½ x\ny");
    expect(sanitizePendingBlobText("a &#189; b")).toBe("a ½ b");
  });

  test("coerces non-strings to a trimmed empty string", () => {
    expect(sanitizePendingBlobText(undefined)).toBe("");
    expect(sanitizePendingBlobText(null)).toBe("");
    expect(sanitizePendingBlobText(42)).toBe("42");
  });
});

describe("splitPendingBlobSegments", () => {
  test("splits on lines that start a new catalog segment", () => {
    expect(splitPendingBlobSegments(TWO_LEG)).toEqual([
      "G111 FOOTBALL - A vs B / Game / Moneyline / A",
      "G222 BASKETBALL - C vs D / Game / Spread / C -3",
    ]);
  });

  test("splits on a sport-name start", () => {
    expect(
      splitPendingBlobSegments(
        "Tennis - A vs B / Game / Moneyline / A\nBaseball - C vs D / Game / ML / C",
      ),
    ).toHaveLength(2);
  });

  test("returns the raw text when nothing splits", () => {
    expect(splitPendingBlobSegments("just text")).toEqual(["just text"]);
    expect(splitPendingBlobSegments("")).toEqual([""]);
  });
});

describe("parsePendingBlobDescription", () => {
  test("parses a contest/futures row and maps the sport", () => {
    const parsed = parsePendingBlobDescription(CONTEST);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      catalogId: "NFL Futures",
      wagerType: "C",
      sport: "Football",
      subSport: "NFL Futures",
      matchup: "To win Super Bowl",
      period: "Game",
      market: "To win Super Bowl - Odds to win 2026-27 Super Bowl",
      selection: "Chicago Bears +1100",
      desc: "Chicago Bears +1100",
      legCount: 1,
      channel: "CONTEST",
    });
  });

  test("parses a builder row, keeping the raw sport token", () => {
    const parsed = parsePendingBlobDescription(BUILDER);
    expect(parsed).toMatchObject({
      catalogId: "1234",
      wagerType: "G",
      sport: "FOOTBALL",
      matchup: "Team A vs Team B",
      period: "1st Half",
      market: "Moneyline",
      selection: "Team A -110",
      legCount: 1,
      channel: "OTHER",
    });
    expect(parsed?.subSport).toBeUndefined();
  });

  test("parses multiple legs and keeps each leg's identity", () => {
    const parsed = parsePendingBlobDescription(TWO_LEG);
    expect(parsed?.legCount).toBe(2);
    expect(
      parsed?.legs.map((leg) => [leg.catalogId, leg.sport, leg.period]),
    ).toEqual([
      ["111", "FOOTBALL", "Game"],
      ["222", "BASKETBALL", "Game"],
    ]);
    // The summary describes the primary (first) leg.
    expect(parsed?.catalogId).toBe("111");
    expect(parsed?.selection).toBe("A");
  });

  test("accepts a wager-type override without changing the channel", () => {
    const parsed = parsePendingBlobDescription(CONTEST, " g ");
    expect(parsed?.wagerType).toBe("G");
    expect(parsed?.channel).toBe("CONTEST");
  });

  test("parses a dash-form segment without a G id, defaulting the catalog id", () => {
    const parsed = parsePendingBlobDescription(
      "Tennis - A vs B / Game / Moneyline / A",
    );
    expect(parsed).toMatchObject({
      catalogId: "0",
      wagerType: "G",
      sport: "Tennis",
      matchup: "A vs B",
      period: "Game",
      market: "Moneyline",
      selection: "A",
      channel: "OTHER",
    });
  });

  test("returns null for empty or unparseable text", () => {
    expect(parsePendingBlobDescription("")).toBeNull();
    expect(parsePendingBlobDescription("   ")).toBeNull();
    expect(parsePendingBlobDescription("just text")).toBeNull();
  });

  test("renders through toString and Bun.inspect.custom", () => {
    const parsed = parsePendingBlobDescription(BUILDER);
    expect(String(parsed)).toBe(
      "✓ BUILDER FOOTBALL | Moneyline | 1st Half | Team A -110",
    );
    expect(
      (parsed as unknown as Record<symbol, (d: number) => string>)[
        Symbol.for("nodejs.util.inspect.custom")
      ]?.(0),
    ).toBeTruthy();
  });
});

describe("isPendingBlobRow", () => {
  test("accepts G rows and untyped contest descriptions", () => {
    expect(isPendingBlobRow({ WagerType: "g" })).toBe(true);
    expect(
      isPendingBlobRow({ WagerType: "C", SportType: "", Description: CONTEST }),
    ).toBe(true);
    expect(
      isPendingBlobRow({ WagerType: "C", SportType: "", ShortDesc: CONTEST }),
    ).toBe(true);
  });

  test("rejects structured C rows, junk descriptions and other wager types", () => {
    expect(
      isPendingBlobRow({
        WagerType: "C",
        SportType: "FOOTBALL",
        Description: CONTEST,
      }),
    ).toBe(false);
    expect(
      isPendingBlobRow({
        WagerType: "C",
        SportType: "",
        Description: "nothing",
      }),
    ).toBe(false);
    expect(isPendingBlobRow({ WagerType: "S" })).toBe(false);
    expect(isPendingBlobRow({})).toBe(false);
  });
});

describe("pendingBlobChannel", () => {
  test("maps wager type and writer to the channel", () => {
    expect(pendingBlobChannel({ WagerType: "C" })).toBe("CONTEST");
    expect(pendingBlobChannel({ WagerType: "G", PlacedOn: "GSBUILDER" })).toBe(
      "GSBUILDER",
    );
    expect(pendingBlobChannel({ PlacedOn: "GSLIVE" })).toBe("GSLIVE");
    expect(pendingBlobChannel({ TicketWriter: "GSBUILDER" })).toBe("GSBUILDER");
    expect(pendingBlobChannel({})).toBe("OTHER");
  });

  test("prefers PlacedOn over TicketWriter", () => {
    expect(
      pendingBlobChannel({ PlacedOn: "GSLIVE", TicketWriter: "GSBUILDER" }),
    ).toBe("GSLIVE");
  });
});

describe("catalogIdToBlobRotation", () => {
  test("returns the band base for an empty seed", () => {
    expect(catalogIdToBlobRotation("")).toBe(PENDING_BLOB_ROTATION_BASE);
    expect(catalogIdToBlobRotation("   ")).toBe(PENDING_BLOB_ROTATION_BASE);
  });

  test("is deterministic, trims the seed and stays inside the reserved band", () => {
    expect(catalogIdToBlobRotation("abc")).toBe(
      catalogIdToBlobRotation(" abc "),
    );
    expect(catalogIdToBlobRotation("abc")).toBe(998306);
    expect(catalogIdToBlobRotation("abc")).not.toBe(
      catalogIdToBlobRotation("abd"),
    );
    for (const seed of [
      "a",
      "abc",
      "catalog-123",
      "NFL Futures|Football|To win Super Bowl",
    ]) {
      const rotation = catalogIdToBlobRotation(seed);
      expect(rotation).toBeGreaterThanOrEqual(PENDING_BLOB_ROTATION_BASE);
      expect(rotation).toBeLessThanOrEqual(PENDING_BLOB_ROTATION_TOP);
    }
  });
});

describe("formatParsedPendingBlob", () => {
  test("labels the wager kinds and marks sport resolution", () => {
    expect(
      formatParsedPendingBlob({
        wagerType: "G",
        sport: "Football",
        subSport: "S",
        period: "Game",
        selection: "A",
      }),
    ).toBe("✓ BUILDER Football | S | Game | A");
    expect(
      formatParsedPendingBlob({
        channel: "CONTEST",
        sport: "Football",
        market: "M",
        period: "Game",
      }),
    ).toBe("✓ FUTURE Football | M | Game | ");
  });

  test("marks 'other' and missing sport with a cross and '?' placeholders", () => {
    expect(formatParsedPendingBlob({ sport: "other", subSport: "S" })).toBe(
      "✗ BUILDER other | S | ? | ",
    );
    expect(formatParsedPendingBlob({ subSport: "S", desc: "D" })).toBe(
      "✗ BUILDER ? | S | ? | D",
    );
  });

  test("dims the description only when colors are enabled", () => {
    const plain = formatParsedPendingBlob({
      sport: "Football",
      subSport: "S",
      desc: "D",
    });
    const colored = formatParsedPendingBlob(
      { sport: "Football", subSport: "S", desc: "D" },
      { colors: true },
    );
    expect(plain).not.toContain("\x1b[2m");
    expect(colored).toContain("\x1b[2mD\x1b[0m");
  });
});

describe("resolvePendingRollupDimensions", () => {
  test("derives the builder rotation from catalog, sport and market", () => {
    expect(
      resolvePendingRollupDimensions({ WagerType: "G", Description: BUILDER }),
    ).toEqual({
      rotation: 918351,
      sport: "FOOTBALL",
      period: "1st Half",
      blob: true,
    });
  });

  test("derives the contest rotation with the mapped sport", () => {
    expect(
      resolvePendingRollupDimensions({
        WagerType: "C",
        SportType: "",
        Description: CONTEST,
      }),
    ).toEqual({
      rotation: 1020117,
      sport: "Football",
      period: "Game",
      blob: true,
    });
  });

  test("uses a structured row's rotation and strips the 5000-5999 band", () => {
    expect(
      resolvePendingRollupDimensions({
        WagerType: "S",
        SportType: "Basketball",
        PeriodDescription: "1st Half",
        Team1RotNum: 5201,
      }),
    ).toEqual({
      rotation: 201,
      sport: "Basketball",
      period: "1st Half",
      blob: false,
    });
  });

  test("selects Team2RotNum when the chosen team is team two", () => {
    expect(
      resolvePendingRollupDimensions({
        WagerType: "S",
        SportType: "Basketball",
        ChosenTeamID: "t2",
        Team2ID: "t2",
        Team1RotNum: 10,
        Team2RotNum: "17",
      }).rotation,
    ).toBe(17);
  });

  test("hashes an unusable rotation into the blob band", () => {
    expect(
      resolvePendingRollupDimensions({
        WagerType: "S",
        SportType: "Basketball",
        SportSubType: "NFL",
        PeriodDescription: "Q1",
        Team1RotNum: "abc",
      }),
    ).toEqual({
      rotation: 1032573,
      sport: "Basketball",
      period: "Q1",
      blob: true,
    });
  });
});
