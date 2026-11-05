import { describe, expect, test } from "bun:test";

import {
  type BetMarketHints,
  type ParsedMarket,
  eventKeyFor,
  marketKeyFor,
  parseBetMarket,
} from "../lib/bet_market_parse.ts";

const EMPTY_MARKET: ParsedMarket = {
  sport: "",
  eventLabel: "",
  teams: null,
  marketType: "other",
  periodLabel: "",
  side: null,
  line: null,
  americanOdds: null,
  rotationNumber: null,
  playerName: null,
  isLive: false,
  isAltLine: false,
  confidence: 0,
};

interface Fixture {
  readonly name: string;
  readonly input: string;
  readonly hints?: BetMarketHints;
  readonly expected: ParsedMarket;
}

const F = (
  overrides: Partial<ParsedMarket> & Pick<ParsedMarket, "sport" | "marketType">,
): ParsedMarket => ({ ...EMPTY_MARKET, ...overrides });

/** Real ticker `ShortDesc` shapes, copied from the captured feed (no network in tests). */
const TICKER_FIXTURES: readonly Fixture[] = [
  {
    name: "verbose point spread with a code line and CRLF",
    input:
      "M.G320197818\r\nFootball - Massachusetts vs Ball State / Game / Point spread / Massachusetts -4.5 +146",
    expected: F({
      sport: "Football",
      eventLabel: "Massachusetts vs Ball State",
      teams: ["Massachusetts", "Ball State"],
      marketType: "spread",
      periodLabel: "Game",
      side: "Massachusetts",
      line: -4.5,
      americanOdds: 146,
      confidence: 1,
    }),
  },
  {
    name: "compact hockey total for the 1st period",
    input: "P.Hockey #33 Blackhawks/Panthers O 1½ -140 - For 1st Period",
    expected: F({
      sport: "Hockey",
      eventLabel: "Blackhawks/Panthers",
      teams: ["Blackhawks", "Panthers"],
      marketType: "total",
      periodLabel: "1st Period",
      side: "over",
      line: 1.5,
      americanOdds: -140,
      rotationNumber: 33,
      confidence: 1,
    }),
  },
  {
    name: "compact underdog spread (Suns +3)",
    input: "S.Basketball #520 Suns +3 -110 - For Game",
    expected: F({
      sport: "Basketball",
      eventLabel: "Suns",
      marketType: "spread",
      periodLabel: "Game",
      side: "Suns",
      line: 3,
      americanOdds: -110,
      rotationNumber: 520,
      confidence: 0.9,
    }),
  },
  {
    name: "verbose player prop with a Match (Including OT) qualifier",
    input:
      "M.G14748239\r\nHockey - San Jose Sharks vs Los Angeles Kings / Match (Including OT) / Player Total Shots on Goal / Macklin Celebrini Over 3.5 +115",
    expected: F({
      sport: "Hockey",
      eventLabel: "San Jose Sharks vs Los Angeles Kings",
      teams: ["San Jose Sharks", "Los Angeles Kings"],
      marketType: "player_prop",
      side: "over",
      line: 3.5,
      americanOdds: 115,
      playerName: "Macklin Celebrini",
      confidence: 0.9,
    }),
  },
  {
    name: "compact game total for the 2nd half",
    input: "L.Basketball #511 Cavaliers/Thunder O 115½ -110 - For 2nd Half",
    expected: F({
      sport: "Basketball",
      eventLabel: "Cavaliers/Thunder",
      teams: ["Cavaliers", "Thunder"],
      marketType: "total",
      periodLabel: "2nd Half",
      side: "over",
      line: 115.5,
      americanOdds: -110,
      rotationNumber: 511,
      confidence: 1,
    }),
  },
  {
    name: "odd T-prefixed spread row",
    input: "T BLAZERS -1 -150",
    expected: F({
      sport: "",
      eventLabel: "BLAZERS",
      marketType: "spread",
      side: "BLAZERS",
      line: -1,
      americanOdds: -150,
      confidence: 0.6,
    }),
  },
  {
    name: "live compact spread with a rotation",
    input: "S.LIVE #9305 Central Michigan (Live) -13½ -125 - For Game",
    expected: F({
      sport: "",
      eventLabel: "Central Michigan",
      marketType: "spread",
      periodLabel: "Game",
      side: "Central Michigan",
      line: -13.5,
      americanOdds: -125,
      rotationNumber: 9305,
      isLive: true,
      confidence: 0.7,
    }),
  },
  {
    name: "lone-team total row (HAWKS U 55)",
    input: "HAWKS U 55 -115",
    expected: F({
      sport: "",
      eventLabel: "HAWKS",
      marketType: "team_total",
      side: "under",
      line: 55,
      americanOdds: -115,
      confidence: 0.6,
    }),
  },
  {
    name: "verbose 2-way moneyline",
    input:
      "M.G320197765\r\nBasketball - Oklahoma City Thunder vs Cleveland Cavaliers / Game / Winner (2 way) / Oklahoma City Thunder -2253",
    expected: F({
      sport: "Basketball",
      eventLabel: "Oklahoma City Thunder vs Cleveland Cavaliers",
      teams: ["Oklahoma City Thunder", "Cleveland Cavaliers"],
      marketType: "moneyline",
      periodLabel: "Game",
      side: "Oklahoma City Thunder",
      americanOdds: -2253,
      confidence: 1,
    }),
  },
  {
    name: "verbose 3-way moneyline for a half",
    input:
      "Basketball - Denver Nuggets vs Toronto Raptors / 1st Half / Winner (3 way) / Denver Nuggets -109",
    expected: F({
      sport: "Basketball",
      eventLabel: "Denver Nuggets vs Toronto Raptors",
      teams: ["Denver Nuggets", "Toronto Raptors"],
      marketType: "moneyline",
      periodLabel: "1st Half",
      side: "Denver Nuggets",
      americanOdds: -109,
      confidence: 1,
    }),
  },
  {
    name: "verbose team total",
    input:
      "M.G320197501\r\nFootball - Massachusetts vs Ball State / Game / Ball State team total / Over 23.5 -116",
    expected: F({
      sport: "Football",
      eventLabel: "Massachusetts vs Ball State",
      teams: ["Massachusetts", "Ball State"],
      marketType: "team_total",
      periodLabel: "Game",
      side: "over",
      line: 23.5,
      americanOdds: -116,
      confidence: 1,
    }),
  },
  {
    name: "verbose game total",
    input:
      "Basketball - Boston Celtics vs Milwaukee Bucks / Game / Total / Under 219.5 -155",
    expected: F({
      sport: "Basketball",
      eventLabel: "Boston Celtics vs Milwaukee Bucks",
      teams: ["Boston Celtics", "Milwaukee Bucks"],
      marketType: "total",
      periodLabel: "Game",
      side: "under",
      line: 219.5,
      americanOdds: -155,
      confidence: 1,
    }),
  },
  {
    name: "verbose player prop with commas in the market label",
    input:
      "Basketball - Dallas Mavericks vs San Antonio Spurs / Game / Total Player Points, Rebounds, Assists / Dylan Harper Over 26.5 -126",
    expected: F({
      sport: "Basketball",
      eventLabel: "Dallas Mavericks vs San Antonio Spurs",
      teams: ["Dallas Mavericks", "San Antonio Spurs"],
      marketType: "player_prop",
      periodLabel: "Game",
      side: "over",
      line: 26.5,
      americanOdds: -126,
      playerName: "Dylan Harper",
      confidence: 1,
    }),
  },
  {
    name: "verbose first-basket prop (no line)",
    input:
      "Basketball - Dallas Mavericks vs San Antonio Spurs / Game / player to score first basket / Victor Wembanyama +232",
    expected: F({
      sport: "Basketball",
      eventLabel: "Dallas Mavericks vs San Antonio Spurs",
      teams: ["Dallas Mavericks", "San Antonio Spurs"],
      marketType: "player_prop",
      periodLabel: "Game",
      side: "Victor Wembanyama",
      americanOdds: 232,
      playerName: "Victor Wembanyama",
      confidence: 1,
    }),
  },
  {
    name: "verbose correct-score exotic market",
    input:
      "Top Soccer - AC Milan vs Ferencvaros / Match / Correct Score / AC Milan 3 - 2 +1973",
    expected: F({
      sport: "Soccer",
      eventLabel: "AC Milan vs Ferencvaros",
      teams: ["AC Milan", "Ferencvaros"],
      marketType: "prop",
      side: "AC Milan 3 - 2",
      americanOdds: 1973,
      confidence: 0.9,
    }),
  },
  {
    name: "compact alternate line (buying ½)",
    input: "S.Basketball #640 Santa Clara -16 -120 - buying ½ For Game",
    expected: F({
      sport: "Basketball",
      eventLabel: "Santa Clara",
      marketType: "spread",
      periodLabel: "Game",
      side: "Santa Clara",
      line: -16,
      americanOdds: -120,
      rotationNumber: 640,
      isAltLine: true,
      confidence: 0.9,
    }),
  },
  {
    name: "compact alternate line with a negative half (buying -½)",
    input: "L.Basketball #527 Heat/Clippers O 233 -120 - buying -½ For Game",
    expected: F({
      sport: "Basketball",
      eventLabel: "Heat/Clippers",
      teams: ["Heat", "Clippers"],
      marketType: "total",
      periodLabel: "Game",
      side: "over",
      line: 233,
      americanOdds: -120,
      rotationNumber: 527,
      isAltLine: true,
      confidence: 1,
    }),
  },
  {
    name: "compact HTML-entity half and quarter period",
    input: "S.Basketball #525 Lakers -3&#189; -120 - For 1st Quarter",
    expected: F({
      sport: "Basketball",
      eventLabel: "Lakers",
      marketType: "spread",
      periodLabel: "1st Quarter",
      side: "Lakers",
      line: -3.5,
      americanOdds: -120,
      rotationNumber: 525,
      confidence: 0.9,
    }),
  },
  {
    name: "multi-leg parlay row keeps the first leg",
    input:
      "P.Basketball #636 CSUN/Wichita St U 84½ -110 - For 2nd Half Basketball #510 Bulls/Knicks U 119½ -110 - For 2nd Half",
    expected: F({
      sport: "Basketball",
      eventLabel: "CSUN/Wichita St",
      teams: ["CSUN", "Wichita St"],
      marketType: "total",
      periodLabel: "2nd Half",
      side: "under",
      line: 84.5,
      americanOdds: -110,
      rotationNumber: 636,
      confidence: 1,
    }),
  },
  {
    name: "compact tennis spread",
    input: "S.Tennis #8741 M Hontama -1½ -155 - For Game",
    expected: F({
      sport: "Tennis",
      eventLabel: "M Hontama",
      marketType: "spread",
      periodLabel: "Game",
      side: "M Hontama",
      line: -1.5,
      americanOdds: -155,
      rotationNumber: 8741,
      confidence: 0.9,
    }),
  },
  {
    name: "compact golf moneyline",
    input: "M.Golf #7067 B Silverman -130 - For Game",
    expected: F({
      sport: "Golf",
      eventLabel: "B Silverman",
      marketType: "moneyline",
      periodLabel: "Game",
      side: "B Silverman",
      americanOdds: -130,
      rotationNumber: 7067,
      confidence: 0.9,
    }),
  },
  {
    name: "compact soccer total with a comma split line",
    input: "L.Soccer #22 Fulham/Brentford O 2½,3 -130 - For Game",
    expected: F({
      sport: "Soccer",
      eventLabel: "Fulham/Brentford",
      teams: ["Fulham", "Brentford"],
      marketType: "total",
      periodLabel: "Game",
      side: "over",
      line: 2.5,
      americanOdds: -130,
      rotationNumber: 22,
      isAltLine: true,
      confidence: 1,
    }),
  },
  {
    name: "compact single-team total (Mavericks O 107½)",
    input: "E.Basketball #523 Mavericks O 107½ -115 - For Game",
    expected: F({
      sport: "Basketball",
      eventLabel: "Mavericks",
      marketType: "team_total",
      periodLabel: "Game",
      side: "over",
      line: 107.5,
      americanOdds: -115,
      rotationNumber: 523,
      confidence: 0.9,
    }),
  },
  {
    name: "compact prop with a pick-text marker",
    input: "M.Hockey #11351002 Kraken win opening faceoff -120 - For Game",
    expected: F({
      sport: "Hockey",
      eventLabel: "Kraken",
      marketType: "prop",
      periodLabel: "Game",
      side: "Kraken win opening faceoff",
      americanOdds: -120,
      rotationNumber: 11351002,
      confidence: 0.9,
    }),
  },
  {
    name: "compact player/stat prop (Andrew Wiggins/Rebounds)",
    input: "L.Basketball #502162 Andrew Wiggins/Rebounds U 3½ +105 - For Game",
    expected: F({
      sport: "Basketball",
      eventLabel: "Andrew Wiggins",
      marketType: "player_prop",
      periodLabel: "Game",
      side: "under",
      line: 3.5,
      americanOdds: 105,
      rotationNumber: 502162,
      playerName: "Andrew Wiggins",
      confidence: 0.9,
    }),
  },
  {
    name: "compact player prop with stat abbreviations",
    input:
      "L.Basketball #501967 Victor Wembanyama/Pts+Rebs+Asts O 40½ -120 - For Game",
    expected: F({
      sport: "Basketball",
      eventLabel: "Victor Wembanyama",
      marketType: "player_prop",
      periodLabel: "Game",
      side: "over",
      line: 40.5,
      americanOdds: -120,
      rotationNumber: 501967,
      playerName: "Victor Wembanyama",
      confidence: 0.9,
    }),
  },
  {
    name: "compact unsigned alternate spread (BYU 7 -155, buying 2)",
    input: "P.Football #369 BYU  7 -155 - buying 2 For Game",
    expected: F({
      sport: "Football",
      eventLabel: "BYU",
      marketType: "spread",
      periodLabel: "Game",
      side: "BYU",
      line: 7,
      americanOdds: -155,
      rotationNumber: 369,
      isAltLine: true,
      confidence: 0.9,
    }),
  },
  {
    name: "compact hockey team spread with a regulation-time qualifier",
    input:
      "P.Hockey #11351201 Flames (Reg Time) -½ +177 - For Game Hockey #11351201 Flames (Reg Time)/Kraken (Reg Time) O 6 +100 - For Game",
    expected: F({
      sport: "Hockey",
      eventLabel: "Flames (Reg Time)",
      marketType: "spread",
      periodLabel: "Game",
      side: "Flames (Reg Time)",
      line: -0.5,
      americanOdds: 177,
      rotationNumber: 11351201,
      confidence: 0.9,
    }),
  },
];

/** Real pending `Report/Pending` description + structured-hints shapes. */
const PENDING_FIXTURES: readonly Fixture[] = [
  {
    name: "pending verbose description with matching hints",
    input:
      "Football - Massachusetts vs Ball State / Game / Point spread / Massachusetts -4.5 +146",
    hints: {
      sport: "Football",
      period: "Game",
      team1: "Massachusetts",
      team2: "Ball State",
      chosenTeam: "Massachusetts -4.5 +146",
    },
    expected: F({
      sport: "Football",
      eventLabel: "Massachusetts vs Ball State",
      teams: ["Massachusetts", "Ball State"],
      marketType: "spread",
      periodLabel: "Game",
      side: "Massachusetts",
      line: -4.5,
      americanOdds: 146,
      confidence: 1,
    }),
  },
  {
    name: "pending hints-only team total (description carries the market)",
    input: "Over 23.5 -116",
    hints: {
      sport: "Football",
      period: "Game",
      team1: "Massachusetts",
      team2: "Ball State",
      chosenTeam: "Over 23.5 -116",
      description:
        "Football - Massachusetts vs Ball State / Game / Ball State team total / Over 23.5 -116",
    },
    expected: F({
      sport: "Football",
      eventLabel: "Massachusetts vs Ball State",
      teams: ["Massachusetts", "Ball State"],
      marketType: "team_total",
      periodLabel: "Game",
      side: "over",
      line: 23.5,
      americanOdds: -116,
      confidence: 1,
    }),
  },
  {
    name: "pending chosen team + clean period hint",
    input: "Lakers -3 -110",
    hints: {
      sport: "Basketball",
      period: "1st Half",
      team1: "Los Angeles Lakers",
      team2: "Sacramento Kings",
      chosenTeam: "Lakers -3 -110",
    },
    expected: F({
      sport: "Basketball",
      eventLabel: "Los Angeles Lakers vs Sacramento Kings",
      teams: ["Los Angeles Lakers", "Sacramento Kings"],
      marketType: "spread",
      periodLabel: "1st Half",
      side: "Lakers",
      line: -3,
      americanOdds: -110,
      confidence: 1,
    }),
  },
  {
    name: "pending garbage period hint is ignored in favour of the description",
    input:
      "Basketball - Dallas Mavericks vs San Antonio Spurs / 1st Quarter / Total / Under 55.5 -110",
    hints: {
      sport: "Basketball",
      period: "1st Quarter Basketball #525 Lakers -7 -115 - For 1st Half",
      team1: "Dallas Mavericks",
      team2: "San Antonio Spurs",
      chosenTeam: "Under 55.5 -110",
    },
    expected: F({
      sport: "Basketball",
      eventLabel: "Dallas Mavericks vs San Antonio Spurs",
      teams: ["Dallas Mavericks", "San Antonio Spurs"],
      marketType: "total",
      periodLabel: "1st Quarter",
      side: "under",
      line: 55.5,
      americanOdds: -110,
      confidence: 1,
    }),
  },
  {
    name: "pending compact player prop via the description",
    input: "L.Basketball #502162 Andrew Wiggins/Rebounds U 3½ +105 - For Game",
    hints: {
      sport: "Basketball",
      period: "Game",
      team1: "Golden State Warriors",
      team2: "Los Angeles Lakers",
      chosenTeam: "Andrew Wiggins/Rebounds U 3½ +105",
    },
    expected: F({
      sport: "Basketball",
      // Compact player prop: the event stays the hinted game; the player is separate.
      eventLabel: "Golden State Warriors vs Los Angeles Lakers",
      teams: ["Golden State Warriors", "Los Angeles Lakers"],
      marketType: "player_prop",
      periodLabel: "Game",
      side: "under",
      line: 3.5,
      americanOdds: 105,
      rotationNumber: 502162,
      playerName: "Andrew Wiggins",
      confidence: 1,
    }),
  },
  {
    name: "pending live hint",
    input:
      "Basketball - Phoenix Suns vs Portland Trail Blazers / Game / Winner (2 way) / Phoenix Suns -132",
    hints: {
      sport: "Basketball",
      period: "Game",
      team1: "Phoenix Suns",
      team2: "Portland Trail Blazers",
      chosenTeam: "Phoenix Suns -132",
      live: true,
    },
    expected: F({
      sport: "Basketball",
      eventLabel: "Phoenix Suns vs Portland Trail Blazers",
      teams: ["Phoenix Suns", "Portland Trail Blazers"],
      marketType: "moneyline",
      periodLabel: "Game",
      side: "Phoenix Suns",
      americanOdds: -132,
      isLive: true,
      confidence: 1,
    }),
  },
];

const ALL_FIXTURES = [...TICKER_FIXTURES, ...PENDING_FIXTURES];

describe("parseBetMarket: real fixture shapes", () => {
  test("ships at least 20 realistic fixtures", () => {
    expect(ALL_FIXTURES.length).toBeGreaterThanOrEqual(20);
  });

  for (const fixture of ALL_FIXTURES) {
    test(fixture.name, () => {
      expect(parseBetMarket(fixture.input, fixture.hints)).toEqual(
        fixture.expected,
      );
    });
  }
});

describe("parseBetMarket: normalisation", () => {
  const baseline = parseBetMarket(TICKER_FIXTURES[0]?.input ?? "");

  test("en dash and em dash prices normalise to a minus sign", () => {
    const base =
      "Football - Massachusetts vs Ball State / Game / Point spread / Massachusetts -4.5 +146";
    expect(parseBetMarket(base.replace("-4.5", "–4.5"))).toEqual(
      parseBetMarket(base),
    );
    expect(parseBetMarket(base.replace("-4.5", "—4.5"))).toEqual(
      parseBetMarket(base),
    );
    expect(parseBetMarket(base.replace("+146", "–146")).americanOdds).toBe(
      -146,
    );
  });

  test("&#x0D;, CRLF and \\r\\n artefacts do not change the parse", () => {
    const withEntity = `${TICKER_FIXTURES[0]?.input ?? ""}&#x0D;\n`;
    expect(parseBetMarket(withEntity)).toEqual(baseline);
    const escaped = "Football - A vs B / Game / Total / Under 3.5 -110\\r\\n";
    expect(parseBetMarket(escaped)).toMatchObject({
      marketType: "total",
      line: 3.5,
      americanOdds: -110,
    });
  });

  test("non-breaking spaces and repeated spaces collapse", () => {
    expect(
      parseBetMarket("S.Basketball\u00a0#520\u00a0Suns  +3   -110 - For Game"),
    ).toEqual(parseBetMarket("S.Basketball #520 Suns +3 -110 - For Game"));
  });

  test("unicode quarters and three-quarters become decimals", () => {
    const quarter = parseBetMarket(
      "Soccer - Fulham vs Brentford / Game / Total / Under 3¼ -110",
    );
    expect(quarter.line).toBe(3.25);
    const threeQuarter = parseBetMarket(
      "Soccer - Fulham vs Brentford / Game / Total / Under 3¾ -110",
    );
    expect(threeQuarter.line).toBe(3.75);
  });

  test("the two feeds' equivalent markets produce the same parser output", () => {
    const ticker = parseBetMarket(
      "M.G320197501\r\nFootball - Massachusetts vs Ball State / Game / Ball State team total / Over 23.5 -116",
    );
    const pending = parseBetMarket(
      "Football - Massachusetts vs Ball State / Game / Ball State team total / Over 23.5 -116",
      {
        sport: "Football",
        period: "Game",
        team1: "Massachusetts",
        team2: "Ball State",
        chosenTeam: "Over 23.5 -116",
      },
    );
    expect(pending).toEqual(ticker);
  });
});

describe("parseBetMarket: placeholder team hints", () => {
  test("rejects wire placeholders instead of grouping unrelated games", () => {
    const market = parseBetMarket(
      "Basketball - Basketball vs Market / 1st Half / Point spread / Basketball -6.5 -110",
      {
        sport: "Basketball",
        period: "1st Half",
        team1: "Basketball",
        team2: "Market",
        chosenTeam: "Basketball -6.5 -110",
      },
    );

    expect(market.eventLabel).toBe("");
    expect(market.teams).toBeNull();
    expect(market.marketType).toBe("spread");
    expect(market.line).toBe(-6.5);
    expect(marketKeyFor(market)).not.toContain("market");
    expect(eventKeyFor(market)).not.toContain("market");
  });

  test("keeps the description's real teams when hints are placeholders", () => {
    const market = parseBetMarket(
      "Basketball - Phoenix Suns vs Portland Trail Blazers / Game / Winner (2 way) / Phoenix Suns -132",
      {
        sport: "Basketball",
        period: "Game",
        team1: "Basketball",
        team2: "Market",
      },
    );

    expect(market.eventLabel).toBe("Phoenix Suns vs Portland Trail Blazers");
    expect(market.teams).toEqual(["Phoenix Suns", "Portland Trail Blazers"]);
    expect(eventKeyFor(market)).toBe(
      "basketball|phoenix suns vs portland trail blazers",
    );
  });

  test("falls back to the real pick team when every event name is a placeholder", () => {
    const market = parseBetMarket(
      "Basketball #305 C Michigan -½ -110 - For 2nd Half",
      {
        sport: "Football",
        period: "2nd Half",
        team1: "Basketball",
        team2: "Market",
        chosenTeam: "C Michigan -½ -110",
      },
    );

    expect(market.eventLabel).toBe("C Michigan");
    expect(market.side).toBe("C Michigan");
    expect(market.marketType).toBe("spread");
    expect(market.periodLabel).toBe("2nd Half");
  });

  test("uses real hint teams when the description is the placeholder one", () => {
    const market = parseBetMarket(
      "Basketball - Basketball vs Market / Game / Point spread / Boston Celtics -3 -110",
      {
        sport: "Basketball",
        period: "Game",
        team1: "Boston Celtics",
        team2: "Miami Heat",
      },
    );

    expect(market.eventLabel).toBe("Boston Celtics vs Miami Heat");
    expect(market.teams).toEqual(["Boston Celtics", "Miami Heat"]);
  });
});

describe("parseBetMarket: garbage and empty input", () => {
  const garbage = [
    "",
    "   ",
    "not a market at all",
    "M.G320197818",
    "---",
    "\r\n\r\n",
    "???",
  ];

  for (const input of garbage) {
    test(`returns the empty market for ${JSON.stringify(input)}`, () => {
      expect(parseBetMarket(input)).toEqual(EMPTY_MARKET);
    });
  }

  test("never throws for non-string input", () => {
    expect(parseBetMarket(null as unknown as string)).toEqual(EMPTY_MARKET);
    expect(parseBetMarket(undefined as unknown as string)).toEqual(
      EMPTY_MARKET,
    );
    expect(parseBetMarket(42 as unknown as string)).toEqual(EMPTY_MARKET);
  });

  test("never throws and keeps the shape valid across every fixture", () => {
    const types = new Set<ParsedMarket["marketType"]>([
      "moneyline",
      "spread",
      "total",
      "team_total",
      "player_prop",
      "prop",
      "other",
    ]);
    for (const input of [
      ...ALL_FIXTURES.map((fixture) => fixture.input),
      ...garbage,
      "P. ",
      "M. ",
      "S.LIVE #",
      "O -110",
      "Over",
      "A/B O",
    ]) {
      const market = parseBetMarket(input);
      expect(types.has(market.marketType)).toBe(true);
      expect(market.confidence).toBeGreaterThanOrEqual(0);
      expect(market.confidence).toBeLessThanOrEqual(1);
      expect(market.teams === null || market.teams.length === 2).toBe(true);
      expect(typeof eventKeyFor(market)).toBe("string");
      expect(typeof marketKeyFor(market)).toBe("string");
    }
  });

  test("confidence reflects how much of the market was identified", () => {
    expect(parseBetMarket(TICKER_FIXTURES[0]?.input ?? "").confidence).toBe(1);
    expect(
      parseBetMarket("S.Basketball #520 Suns +3 -110 - For Game").confidence,
    ).toBe(0.9);
    expect(parseBetMarket("T BLAZERS -1 -150").confidence).toBe(0.6);
    expect(parseBetMarket("not a market at all").confidence).toBe(0);
  });
});

describe("marketKeyFor / eventKeyFor", () => {
  test("pins the stable key format", () => {
    const market = parseBetMarket(
      "P.Hockey #33 Blackhawks/Panthers O 1½ -140 - For 1st Period",
    );
    expect(eventKeyFor(market)).toBe("hockey|blackhawks/panthers");
    expect(marketKeyFor(market)).toBe(
      "hockey|blackhawks/panthers|total|1st period|1.5",
    );
  });

  test("both sides of one line share the market key", () => {
    const over = parseBetMarket(
      "Basketball - Boston Celtics vs Milwaukee Bucks / Game / Total / Over 219.5 -110",
    );
    const under = parseBetMarket(
      "Basketball - Boston Celtics vs Milwaukee Bucks / Game / Total / Under 219.5 -110",
    );
    expect(over.side).toBe("over");
    expect(under.side).toBe("under");
    expect(marketKeyFor(under)).toBe(marketKeyFor(over));
  });

  test("a different line, period or market type is a different key", () => {
    const base = parseBetMarket(
      "Basketball - Boston Celtics vs Milwaukee Bucks / Game / Total / Over 219.5 -110",
    );
    const otherLine = parseBetMarket(
      "Basketball - Boston Celtics vs Milwaukee Bucks / Game / Total / Over 220.5 -110",
    );
    const otherPeriod = parseBetMarket(
      "Basketball - Boston Celtics vs Milwaukee Bucks / 1st Half / Total / Over 219.5 -110",
    );
    const otherType = parseBetMarket(
      "Basketball - Boston Celtics vs Milwaukee Bucks / Game / Point spread / Boston Celtics -4.5 -110",
    );
    expect(marketKeyFor(otherLine)).not.toBe(marketKeyFor(base));
    expect(marketKeyFor(otherPeriod)).not.toBe(marketKeyFor(base));
    expect(marketKeyFor(otherType)).not.toBe(marketKeyFor(base));
    expect(eventKeyFor(otherLine)).toBe(eventKeyFor(base));
    expect(marketKeyFor(otherType)).toContain("|spread|");
  });

  test("a moneyline has no line component", () => {
    const market = parseBetMarket(
      "M.G320197765\r\nBasketball - Oklahoma City Thunder vs Cleveland Cavaliers / Game / Winner (2 way) / Oklahoma City Thunder -2253",
    );
    expect(marketKeyFor(market)).toBe(
      "basketball|oklahoma city thunder vs cleveland cavaliers|moneyline|game|",
    );
  });

  test("keys are deterministic and whitespace-insensitive", () => {
    const a = parseBetMarket("S.Basketball #520 Suns +3 -110 - For Game");
    const b = parseBetMarket("S.Basketball  #520   Suns  +3  -110 - For Game");
    const c = parseBetMarket("S.Basketball #520 Suns +3 -110 - For Game");
    expect(marketKeyFor(b)).toBe(marketKeyFor(a));
    expect(marketKeyFor(c)).toBe(marketKeyFor(a));
    expect(eventKeyFor(b)).toBe(eventKeyFor(a));
  });

  test("unclassified markets have no identity key, so crowd rules skip them", () => {
    const empty = parseBetMarket("");
    expect(empty.marketType).toBe("other");
    expect(eventKeyFor(empty)).toBe("");
    expect(marketKeyFor(empty)).toBe("");
    // Classified markets with sparse identity still key normally.
    const sparse = parseBetMarket("HAWKS U 55 -115");
    expect(eventKeyFor(sparse)).toBe("|hawks");
    expect(marketKeyFor(sparse)).toBe("|hawks|team_total||55");
  });
});
