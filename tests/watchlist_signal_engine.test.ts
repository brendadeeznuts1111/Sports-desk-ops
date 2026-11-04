import { describe, expect, test } from "bun:test";
import {
  aggregateWatchlistSignals,
  americanToImpliedProbability,
  collectWatchlistCandidates,
  deriveWatchlistSignals,
  parseCanonicalMarket,
  parseLiveBetsGame,
  parseWagerShortDesc,
} from "../lib/watchlist_signal_engine.ts";
import { getUnifiedWatchlistRegistry } from "../lib/gslive_manager_watchlist.ts";

/**
 * Signal derivation, driven by crafted inputs so every rule (parsing, aggregation, provenance,
 * the fixture cap) is testable without the checkout's artifacts.
 */

const NOW = new Date("2026-11-04T12:00:00.000Z");
const REGISTRY = getUnifiedWatchlistRegistry();
function accountAt(index: number): (typeof REGISTRY)[number] {
  const entry = REGISTRY[index];
  if (entry === undefined)
    throw new Error("watchlist registry fixture is missing");
  return entry;
}
const ACCOUNT_A = accountAt(0);
const ACCOUNT_B = accountAt(1);

function feedRow(
  login: string,
  canonicalMarket: string,
  riskUsd: number,
  oddsAmerican: string,
): Record<string, unknown> {
  return {
    ticketId: `T-${login}`,
    f402CustomerId: login,
    agentOwner: "AGENT",
    sourceVenue: "F402",
    sportAndPeriod: "NBA • Game",
    canonicalMarket,
    oddsAmerican,
    riskUsd,
    toWinUsd: riskUsd,
    placedAtUtc: "2026-11-04 10:00:00 UTC",
  };
}

function liveFeed(options: {
  dataMode: string;
  f402Source: string;
  pendingBets: unknown[];
  lastUpdatedIso?: string;
}): unknown {
  return {
    schemaVersion: 3,
    dataMode: options.dataMode,
    lastUpdatedIso: options.lastUpdatedIso ?? "2026-11-04T11:59:00.000Z",
    provenance: { f402: { source: options.f402Source } },
    pendingBets: options.pendingBets,
  };
}

describe("canonical market parsing", () => {
  test.each([
    ["NBA_LAL_BOS_1Q_TOTAL_OVER_55.5", "NBA", "1q_total", 55.5, "over", null],
    ["CFB_TXST_ULL_SPREAD_TXST_+14.5", "CFB", "spread", 14.5, null, "TXST"],
    ["NBA_DEN_PHX_TOTAL_UNDER_223.5", "NBA", "total", 223.5, "under", null],
    [
      "NBA_BOS_MIL_TEAM_TOTAL_BOS_OVER_118.5",
      "NBA",
      "team_total",
      118.5,
      "over",
      "BOS",
    ],
    ["NBA_LAL_BOS:FG:ALT_SPREAD:-750", "NBA", "spread", -7.5, null, "LAL"],
    ["NBA_GSW_SAC:3Q:SPREAD:-150", "NBA", "3q_spread", -1.5, null, "GSW"],
    ["NBA_DEN_PHX:2Q:TOTAL:5450", "NBA", "2q_total", 54.5, null, null],
    ["NBA_BOS_MIL:4Q:SPREAD:+150", "NBA", "4q_spread", 1.5, null, "BOS"],
  ] as const)(
    "%s → league %s kind %s line %s",
    (raw, league, kind, line, overUnder, sideTeam) => {
      const parsed = parseCanonicalMarket(raw);
      expect(parsed).not.toBeNull();
      expect(parsed?.league).toBe(league);
      expect(parsed?.marketKind).toBe(kind);
      expect(parsed?.line).toBe(line);
      expect(parsed?.overUnder).toBe(overUnder);
      expect(parsed?.sideTeam).toBe(sideTeam);
    },
  );

  test("keeps the team tokens for the examples", () => {
    expect(
      parseCanonicalMarket("CFB_TXST_ULL_SPREAD_TXST_+14.5")?.teams,
    ).toEqual(["TXST", "ULL"]);
    expect(
      parseCanonicalMarket("NBA_BOS_MIL_TEAM_TOTAL_BOS_OVER_118.5")?.teams,
    ).toEqual(["BOS", "MIL"]);
    expect(
      parseCanonicalMarket("NBA_LAL_BOS_1Q_TOTAL_OVER_55.5")?.teams,
    ).toEqual(["LAL", "BOS"]);
  });

  test("unknown league or kind is null, never guessed", () => {
    expect(parseCanonicalMarket("XYZ_LAL_BOS_TOTAL_OVER_55.5")).toBeNull();
    expect(parseCanonicalMarket("NBA_LAL_BOS_PROP_OVER_55.5")).toBeNull();
    expect(parseCanonicalMarket("")).toBeNull();
  });
});

describe("short-desc and live-bets parsing", () => {
  test("parses a clipboard ticker total", () => {
    const parsed = parseWagerShortDesc(
      "M.G319748913\r\nFootball - Denver Broncos vs Kansas City Chiefs / Game / Total / Over 46.5 -108&#x0D;\n",
    );
    expect(parsed?.league).toBe("NFL");
    expect(parsed?.marketKind).toBe("total");
    expect(parsed?.line).toBe(46.5);
    expect(parsed?.overUnder).toBe("over");
    expect(parsed?.teams).toEqual(["DENVER BRONCOS", "KANSAS CITY CHIEFS"]);
  });

  test("parses a moneyline winner row", () => {
    const parsed = parseWagerShortDesc(
      "P.G1\r\nFootball - Los Angeles Rams vs Los Angeles Chargers / Game / Winner (2 way) / Los Angeles Rams -201",
    );
    expect(parsed?.marketKind).toBe("moneyline");
    expect(parsed?.sideTeam).toBe("LOS ANGELES RAMS");
  });

  test("parses a live-bets game row best-effort", () => {
    const parsed = parseLiveBetsGame({
      sport: "Basketball",
      period: "1st Quarter",
      description: "Basketball #501 LAL -1.5 -110 - 1st Quarter",
      chosenTeam: "LAL",
      team1: { shortName: "LAL" },
      team2: { shortName: "BOS" },
    });
    expect(parsed?.league).toBe("NBA");
    expect(parsed?.marketKind).toBe("1q_spread");
    expect(parsed?.sideTeam).toBe("LAL");
    expect(parsed?.line).toBe(-1.5);
  });
});

function soccerGame(
  chosenTeam: string,
  options: {
    period?: string;
    login?: string;
    team1?: string;
    team2?: string;
  } = {},
): Record<string, unknown> {
  return {
    customerID: options.login ?? ACCOUNT_A.customerLogin,
    agent: { id: "AGENT", key: "AGENT" },
    sport: "Soccer",
    period: options.period ?? "Game",
    description: `Soccer #224205 ${chosenTeam} - For Game`,
    chosenTeam,
    wagered: 25_000,
    acceptedAt: "2026-11-04 11:50:00.000",
    team1: { shortName: options.team1 ?? "Soccer" },
    team2: { shortName: options.team2 ?? "Market" },
  };
}

describe("soccer selection parsing", () => {
  test("a moneyline names the picked side, not the sport", () => {
    const parsed = parseLiveBetsGame(soccerGame("Arsenal -380"));
    expect(parsed?.league).toBe("EPL");
    expect(parsed?.marketKind).toBe("moneyline");
    expect(parsed?.teams).toEqual(["ARSENAL"]);
    expect(parsed?.sideTeam).toBe("ARSENAL");
    expect(parsed?.line).toBeNull();
    expect(parsed?.overUnder).toBeNull();
  });

  test("a spread keeps the line and drops the price", () => {
    const parsed = parseLiveBetsGame(soccerGame("Arsenal -1½ -120"));
    expect(parsed?.marketKind).toBe("spread");
    expect(parsed?.teams).toEqual(["ARSENAL"]);
    expect(parsed?.sideTeam).toBe("ARSENAL");
    expect(parsed?.line).toBe(-1.5);
  });

  test("a split line is recorded as its midpoint", () => {
    expect(parseLiveBetsGame(soccerGame("Arsenal -½,-1 -105"))?.line).toBe(
      -0.75,
    );
    expect(parseLiveBetsGame(soccerGame("Betis +½,+1 +110"))?.line).toBe(0.75);
  });

  test("a match total names both sides and no pick", () => {
    const parsed = parseLiveBetsGame(
      soccerGame("Arsenal/Slavia Praha O 2½ -130"),
    );
    expect(parsed?.marketKind).toBe("total");
    expect(parsed?.teams).toEqual(["ARSENAL", "SLAVIA PRAHA"]);
    expect(parsed?.sideTeam).toBeNull();
    expect(parsed?.line).toBe(2.5);
    expect(parsed?.overUnder).toBe("over");
  });

  test("a split total takes the midpoint of its two lines", () => {
    expect(
      parseLiveBetsGame(soccerGame("Betis/Borussia Dortmund O 2½,3 -140"))
        ?.line,
    ).toBe(2.75);
  });

  test("a one-team total is a team total", () => {
    const parsed = parseLiveBetsGame(soccerGame("Como O 1½ -140"));
    expect(parsed?.marketKind).toBe("team_total");
    expect(parsed?.teams).toEqual(["COMO"]);
    expect(parsed?.sideTeam).toBe("COMO");
    expect(parsed?.overUnder).toBe("over");
  });

  test("a half bet keeps its period token", () => {
    const parsed = parseLiveBetsGame(
      soccerGame("Man. City/RB Leipzig O 1½ -130", { period: "1st Half" }),
    );
    expect(parsed?.marketKind).toBe("1h_total");
    expect(parsed?.line).toBe(1.5);
  });

  test("a draw names both sides and the pick", () => {
    const parsed = parseLiveBetsGame(
      soccerGame("Draw ( Betis vs Borussia Dortmund ) +160"),
    );
    expect(parsed?.marketKind).toBe("moneyline");
    expect(parsed?.teams).toEqual(["BETIS", "BORUSSIA DORTMUND"]);
    expect(parsed?.sideTeam).toBe("DRAW");
  });

  test("real captured team names beat the placeholder heuristic", () => {
    const parsed = parseLiveBetsGame(
      soccerGame("Rangers U19 -1½ -110", {
        team1: "Rangers U19",
        team2: "Fc Dynamo Kyiv U19",
      }),
    );
    expect(parsed?.teams).toEqual(["RANGERS U19", "FC DYNAMO KYIV U19"]);
    expect(parsed?.line).toBe(-1.5);
  });

  test("the chosen leg wins over a multi-leg description", () => {
    const parsed = parseLiveBetsGame({
      ...soccerGame("Arsenal -380"),
      description:
        "P.Soccer #224214 FC Porto +100 - For Game Soccer #224205 Arsenal -380 - For Game",
    });
    expect(parsed?.teams).toEqual(["ARSENAL"]);
    expect(parsed?.sideTeam).toBe("ARSENAL");
    expect(parsed?.marketKind).toBe("moneyline");
  });

  test("two watched accounts on one soccer pick aggregate into one signal", () => {
    const liveBets = {
      capturedAt: "2026-11-04T11:59:00.000Z",
      dataSource: "capture:/cloud/api/Report/Pending",
      games: [
        soccerGame("Arsenal -1½ -120", { login: ACCOUNT_A.customerLogin }),
        soccerGame("Arsenal -1½ -120", { login: ACCOUNT_B.customerLogin }),
      ],
    };
    const signals = deriveWatchlistSignals(
      { feed: null, wagers: null, liveBets },
      { now: NOW, registry: REGISTRY },
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      league: "EPL",
      marketKind: "spread",
      line: -1.5,
      sideTeam: "ARSENAL",
      distinctAccounts: 2,
    });
    expect(signals[0]?.teams).toEqual(["ARSENAL"]);
    expect(signals[0]?.confidence).toBeGreaterThan(0);
  });
});

describe("watchlist aggregation", () => {
  test("aggregates same-side rows into one signal with risk, accounts and fair probability", () => {
    const feed = liveFeed({
      dataMode: "LIVE",
      f402Source: "live",
      pendingBets: [
        feedRow(
          ACCOUNT_A.customerLogin,
          "NBA_LAL_BOS_1Q_TOTAL_OVER_55.5",
          16_200,
          "+115",
        ),
        feedRow(
          ACCOUNT_B.customerLogin,
          "NBA_LAL_BOS_1Q_TOTAL_OVER_55.5",
          11_500,
          "+115",
        ),
      ],
    });
    const signals = deriveWatchlistSignals(
      { feed, wagers: null, liveBets: null },
      { now: NOW },
    );
    expect(signals).toHaveLength(1);
    const signal = signals[0];
    expect(signal?.distinctAccounts).toBe(2);
    expect(signal?.riskUsd).toBe(27_700);
    expect(signal?.oneSidedShare).toBe(1);
    expect(signal?.fairProb).toBeCloseTo(
      americanToImpliedProbability(115) ?? 0,
      4,
    );
    expect(signal?.confidence).toBeGreaterThan(0);
    expect(signal?.confidence).toBeLessThanOrEqual(100);
    expect(signal?.provenance.fixture).toBe(false);
    expect(signal?.provenance.dataMode).toBe("LIVE");
    expect(signal?.provenance.sources).toEqual(["docs/graph-live-feed.json"]);
    expect(signal?.provenance.ageSeconds).toBe(60);
    expect(signal?.provenance.stale).toBe(false);
  });

  test("a FIXTURE feed row is carried through and caps the signal", () => {
    const feed = liveFeed({
      dataMode: "PARTIAL",
      f402Source: "fixture",
      pendingBets: [
        feedRow(
          ACCOUNT_A.customerLogin,
          "NBA_DEN_PHX_TOTAL_UNDER_223.5",
          4_500,
          "-110",
        ),
      ],
    });
    const signals = deriveWatchlistSignals(
      { feed, wagers: null, liveBets: null },
      { now: NOW },
    );
    expect(signals[0]?.provenance.fixture).toBe(true);
    expect(signals[0]?.provenance.dataMode).toBe("PARTIAL");
  });

  test("an old feed is stale", () => {
    const feed = liveFeed({
      dataMode: "LIVE",
      f402Source: "live",
      lastUpdatedIso: "2026-11-04T10:00:00.000Z",
      pendingBets: [
        feedRow(
          ACCOUNT_A.customerLogin,
          "NBA_LAL_BOS_1Q_TOTAL_OVER_55.5",
          100,
          "+115",
        ),
      ],
    });
    const signals = deriveWatchlistSignals(
      { feed, wagers: null, liveBets: null },
      { now: NOW },
    );
    expect(signals[0]?.provenance.stale).toBe(true);
  });

  test("opposite sides of the same event are two signals with one-sided shares", () => {
    const feed = liveFeed({
      dataMode: "LIVE",
      f402Source: "live",
      pendingBets: [
        feedRow(
          ACCOUNT_A.customerLogin,
          "NBA_DEN_PHX_TOTAL_OVER_223.5",
          30_000,
          "-110",
        ),
        feedRow(
          ACCOUNT_B.customerLogin,
          "NBA_DEN_PHX_TOTAL_UNDER_223.5",
          10_000,
          "-110",
        ),
      ],
    });
    const signals = deriveWatchlistSignals(
      { feed, wagers: null, liveBets: null },
      { now: NOW },
    );
    expect(signals).toHaveLength(2);
    const shares = signals.map((signal) => signal.oneSidedShare).sort();
    expect(shares).toEqual([0.25, 0.75]);
  });

  test("logins outside the watchlist are dropped, not attributed", () => {
    const feed = liveFeed({
      dataMode: "LIVE",
      f402Source: "live",
      pendingBets: [
        feedRow(
          "NOT_ON_LIST",
          "NBA_LAL_BOS_1Q_TOTAL_OVER_55.5",
          99_000,
          "+115",
        ),
      ],
    });
    expect(
      deriveWatchlistSignals(
        { feed, wagers: null, liveBets: null },
        { now: NOW },
      ),
    ).toEqual([]);
  });

  test("the live-wagers source is parsed and converted from cents", () => {
    const wagers = {
      schemaVersion: 1,
      source: "paste:clipboard-ticker",
      observedAt: "2026-11-04T11:30:00.000Z",
      LIST: [
        {
          Login: ACCOUNT_A.customerLogin,
          AgentID: ACCOUNT_A.agentId,
          WagerType: "M",
          AmountWagered: 21_600,
          ShortDesc:
            "M.G1\r\nBasketball - LAL vs BOS / Game / Total / Over 55.5 -108&#x0D;\n",
          InsertDateTime: "2026-11-04 11:29:00.453",
        },
        {
          Login: "NOT_ON_LIST",
          AmountWagered: 500,
          ShortDesc:
            "M.G2\r\nBasketball - LAL vs BOS / Game / Total / Over 55.5 -108",
        },
      ],
    };
    const signals = deriveWatchlistSignals(
      { feed: null, wagers, liveBets: null },
      { now: NOW },
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.riskUsd).toBe(216);
    expect(signals[0]?.provenance.sources).toEqual(["data/live-wagers.json"]);
    expect(signals[0]?.fairProb).toBeCloseTo(
      americanToImpliedProbability(-108) ?? 0,
      4,
    );
  });

  test("rows that cannot be parsed do not invent a side", () => {
    expect(parseCanonicalMarket("NBA_LAL_BOS")?.line).toBeUndefined();
    const rows = aggregateWatchlistSignals([], NOW);
    expect(rows).toEqual([]);
    expect(
      deriveWatchlistSignals(
        {
          feed: liveFeed({
            dataMode: "LIVE",
            f402Source: "live",
            pendingBets: [
              feedRow(
                ACCOUNT_A.customerLogin,
                "NBA_LAL_BOS_UNPARSEABLE",
                100,
                "+115",
              ),
            ],
          }),
          wagers: null,
          liveBets: null,
        },
        { now: NOW },
      ),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Bet-time freshness                                                         */
/* -------------------------------------------------------------------------- */

const TICKER_TOTAL =
  "M.G319748913\r\nFootball - Denver Broncos vs Kansas City Chiefs / Game / Total / Over 46.5 -108";

function wagerRow(
  login: string,
  shortDesc: string,
  amountCents: number,
  insertDateTime: string | null,
): Record<string, unknown> {
  return {
    WagerNumber: "767173499",
    AgentID: "AGENT",
    CustomerID: login,
    Login: login,
    WagerType: "M",
    AmountWagered: amountCents,
    InsertDateTime: insertDateTime,
    TicketWriter: "Internet",
    ShortDesc: shortDesc,
  };
}

function pendingGame(
  login: string,
  acceptedAt: string | null,
): Record<string, unknown> {
  return {
    customerID: login,
    agent: { id: "AGENT", key: "AGENT" },
    wagered: 250_000,
    acceptedAt,
    sport: "Basketball",
    period: "1st Quarter",
    description: "Basketball #501 LAL -1.5 -110 - 1st Quarter",
    chosenTeam: "LAL",
    team1: { shortName: "LAL" },
    team2: { shortName: "BOS" },
  };
}

describe("bet-time freshness", () => {
  test("a ticker row ages from InsertDateTime, not the capture clock", () => {
    const inputs = {
      feed: null,
      wagers: {
        schemaVersion: 1,
        source: "capture:/cloud/api/Manager/getBetTicker",
        observedAt: "2026-11-04T11:59:00.000Z",
        LIST: [
          wagerRow(
            ACCOUNT_A.customerLogin,
            TICKER_TOTAL,
            2_500,
            "2026-11-01 17:18:20",
          ),
        ],
      },
      wagersAsOf: "2026-11-04T11:59:00.000Z",
      liveBets: null,
    };
    const signals = deriveWatchlistSignals(inputs, {
      now: NOW,
      registry: REGISTRY,
    });
    expect(signals).toHaveLength(1);
    const provenance = signals[0]?.provenance;
    expect(provenance?.stale).toBe(true);
    expect(provenance?.ageSeconds).toBeGreaterThan(3_600);
    expect(provenance?.asOf).not.toBe("2026-11-04T11:59:00.000Z");
  });

  test("a ticker row without InsertDateTime falls back to the capture clock", () => {
    const inputs = {
      feed: null,
      wagers: {
        observedAt: "2026-11-04T11:59:00.000Z",
        LIST: [wagerRow(ACCOUNT_A.customerLogin, TICKER_TOTAL, 2_500, null)],
      },
      wagersAsOf: null,
      liveBets: null,
    };
    const signals = deriveWatchlistSignals(inputs, {
      now: NOW,
      registry: REGISTRY,
    });
    expect(signals[0]?.provenance.asOf).toBe("2026-11-04T11:59:00.000Z");
    expect(signals[0]?.provenance.stale).toBe(false);
  });

  test("a pending ticket ages from acceptedAt, not the capture clock", () => {
    const inputs = {
      feed: null,
      wagers: null,
      liveBets: {
        capturedAt: "2026-11-04T11:59:00.000Z",
        dataSource: "capture:/cloud/api/Report/Pending",
        games: [
          pendingGame(ACCOUNT_B.customerLogin, "2026-11-01 14:33:47.900"),
        ],
      },
    };
    const signals = deriveWatchlistSignals(inputs, {
      now: NOW,
      registry: REGISTRY,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.provenance.stale).toBe(true);
    expect(signals[0]?.provenance.ageSeconds).toBeGreaterThan(3_600);
  });

  test("reads the zone-less portal wall-clock in the portal's Eastern zone", () => {
    const inputs = {
      feed: null,
      wagers: {
        observedAt: "2026-11-04T11:59:00.000Z",
        LIST: [
          wagerRow(
            ACCOUNT_A.customerLogin,
            TICKER_TOTAL,
            2_500,
            "2026-11-04 06:30:00",
          ),
        ],
      },
      wagersAsOf: null,
      liveBets: null,
    };
    const signals = deriveWatchlistSignals(inputs, {
      now: NOW,
      registry: REGISTRY,
    });
    // 06:30 America/New_York (EST, UTC-5) is 11:30Z, i.e. 30 minutes before NOW.
    const provenance = signals[0]?.provenance;
    expect(provenance?.asOf).toBe("2026-11-04T11:30:00.000Z");
    expect(provenance?.ageSeconds).toBe(1_800);
    expect(provenance?.stale).toBe(false);
  });

  test("a future-dated portal timestamp is refused as stale, never fresh", () => {
    const inputs = {
      feed: null,
      wagers: {
        observedAt: "2026-11-04T11:59:00.000Z",
        LIST: [
          wagerRow(
            ACCOUNT_A.customerLogin,
            TICKER_TOTAL,
            2_500,
            "2026-11-04 08:00:00",
          ),
        ],
      },
      wagersAsOf: null,
      liveBets: null,
    };
    const signals = deriveWatchlistSignals(inputs, {
      now: NOW,
      registry: REGISTRY,
    });
    // 08:00 Eastern is 13:00Z: an hour after NOW. An impossible clock is not freshness.
    expect(signals[0]?.provenance.asOf).toBe("2026-11-04T13:00:00.000Z");
    expect(signals[0]?.provenance.stale).toBe(true);
  });

  test("an explicit window overrides the per-source default", () => {
    // The feed's own cadence default is 180 s; the CLI passes config.maxSignalAgeSeconds.
    const inputs = {
      feed: liveFeed({
        dataMode: "LIVE",
        f402Source: "live",
        lastUpdatedIso: "2026-11-04T11:50:00.000Z",
        pendingBets: [
          feedRow(
            ACCOUNT_A.customerLogin,
            "NBA_LAL_BOS_1Q_TOTAL_OVER_55.5",
            1_000,
            "+115",
          ),
        ],
      }),
      wagers: null,
      liveBets: null,
    };
    const byDefault = deriveWatchlistSignals(inputs, {
      now: NOW,
      registry: REGISTRY,
    });
    const withWindow = deriveWatchlistSignals(inputs, {
      now: NOW,
      registry: REGISTRY,
      maxAgeSeconds: 900,
    });
    expect(byDefault[0]?.provenance.ageSeconds).toBe(600);
    expect(byDefault[0]?.provenance.stale).toBe(true);
    expect(withWindow[0]?.provenance.stale).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Candidate discovery                                                        */
/* -------------------------------------------------------------------------- */

describe("watchlist candidates", () => {
  test("lists accounts the registry does not watch, ranked by risk", () => {
    const feed = liveFeed({
      dataMode: "LIVE",
      f402Source: "live",
      pendingBets: [
        feedRow(
          ACCOUNT_A.customerLogin,
          "NBA_LAL_BOS_1Q_TOTAL_OVER_55.5",
          16_200,
          "+115",
        ),
      ],
    });
    const wagers = {
      source: "capture:/cloud/api/Manager/getBetTicker",
      observedAt: "2026-11-04T11:59:00.000Z",
      LIST: [
        wagerRow("jp1833.", TICKER_TOTAL, 21_600, "2026-11-01 17:18:20"),
        wagerRow("MG314", TICKER_TOTAL, 20_000, "2026-11-01 17:18:37"),
      ],
    };
    const liveBets = {
      capturedAt: "2026-11-04T11:59:00.000Z",
      dataSource: "capture:/cloud/api/Report/Pending",
      games: [pendingGame("CC364", "2026-11-01 14:33:47.900")],
    };
    const candidates = collectWatchlistCandidates(
      {
        feed,
        wagers,
        wagersAsOf: "2026-11-04T11:59:00.000Z",
        liveBets,
      },
      { now: NOW, registry: REGISTRY },
    );
    expect(candidates.map((candidate) => candidate.login)).toEqual([
      "CC364",
      "JP1833",
      "MG314",
    ]);
    expect(candidates[0]).toMatchObject({
      login: "CC364",
      agentId: "AGENT",
      riskUsd: 2_500,
      wagers: 1,
      sources: ["data/live-bets.json"],
      leagues: ["NBA"],
    });
    expect(candidates[0]?.ageSeconds).toBeGreaterThan(3_600);
    expect(candidates[1]).toMatchObject({
      login: "JP1833",
      agentId: "AGENT",
      riskUsd: 216,
      sources: ["data/live-wagers.json"],
      leagues: ["NFL"],
    });
    expect(
      candidates.some(
        (candidate) => candidate.login === ACCOUNT_A.customerLogin,
      ),
    ).toBe(false);
  });

  test("an unparseable market still surfaces the account", () => {
    const candidates = collectWatchlistCandidates(
      {
        feed: null,
        wagers: {
          observedAt: "2026-11-04T11:59:00.000Z",
          LIST: [
            wagerRow("NEW1", "not a market", 1_000, "2026-11-01 17:18:20"),
          ],
        },
        liveBets: null,
      },
      { now: NOW, registry: REGISTRY },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.login).toBe("NEW1");
    expect(candidates[0]?.sampleMarkets).toEqual([]);
    expect(candidates[0]?.leagues).toEqual([]);
  });

  test("limit and minRiskUsd bound the ranked list without inventing accounts", () => {
    const inputs = {
      feed: null,
      wagers: {
        observedAt: "2026-11-04T11:59:00.000Z",
        LIST: [
          wagerRow("A1", TICKER_TOTAL, 5_000_000, "2026-11-01 17:18:20"),
          wagerRow("B2", TICKER_TOTAL, 2_500, "2026-11-01 17:18:20"),
        ],
      },
      liveBets: null,
    };
    expect(
      collectWatchlistCandidates(inputs, {
        now: NOW,
        registry: REGISTRY,
        limit: 1,
      }).map((candidate) => candidate.login),
    ).toEqual(["A1"]);
    expect(
      collectWatchlistCandidates(inputs, {
        now: NOW,
        registry: REGISTRY,
        minRiskUsd: 100,
      }).map((candidate) => candidate.login),
    ).toEqual(["A1"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Hot-path data layout (measured 2026-11-04)                                  */
/* -------------------------------------------------------------------------- */

describe("hot-path data layout", () => {
  test("derivation reuses the zone formatter instead of building one per row", () => {
    const Original = Intl.DateTimeFormat;
    let constructed = 0;
    const Patched = function (
      this: unknown,
      ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
    ): Intl.DateTimeFormat {
      constructed += 1;
      return new Original(...args);
    } as unknown as typeof Intl.DateTimeFormat;
    Intl.DateTimeFormat = Patched;
    try {
      const liveBets = {
        capturedAt: "2026-11-04T11:59:00.000Z",
        dataSource: "capture:/cloud/api/Report/Pending",
        games: [
          pendingGame(ACCOUNT_A.customerLogin, "2026-11-04 06:00:00.000"),
          pendingGame(ACCOUNT_B.customerLogin, "2026-11-04 06:01:00.000"),
        ],
      };
      const signals = deriveWatchlistSignals(
        { feed: null, wagers: null, liveBets },
        { now: NOW, registry: REGISTRY },
      );
      expect(signals).toHaveLength(1);
    } finally {
      Intl.DateTimeFormat = Original;
    }
    // Both acceptedAt values are zone-less wall clocks, so the two-pass zone conversion
    // runs; the module-scope formatter is reused. A per-row `new Intl.DateTimeFormat`
    // would count 4 here (two calls per row) and was the measured 26.6 ms regression.
    expect(constructed).toBe(0);
  });

  test("a row carries epoch milliseconds, so the signal materialises ISO once", () => {
    const liveBets = {
      capturedAt: "2026-11-04T11:59:00.000Z",
      dataSource: "capture:/cloud/api/Report/Pending",
      games: [
        pendingGame(ACCOUNT_A.customerLogin, "2026-11-04 06:00:00.000"),
        pendingGame(ACCOUNT_B.customerLogin, "2026-11-04 06:01:00.000"),
      ],
    };
    const signals = deriveWatchlistSignals(
      { feed: null, wagers: null, liveBets },
      { now: NOW, registry: REGISTRY },
    );
    const signal = signals[0];
    // The newest contributing row wins (06:01 EST = 11:01Z) without sorting strings.
    expect(signal?.provenance.asOf).toBe(
      new Date(Date.UTC(2026, 10, 4, 11, 1, 0)).toISOString(),
    );
    expect(signal?.provenance.ageSeconds).toBe(3_540);
    expect(signal?.distinctAccounts).toBe(2);
  });
});
