import { describe, expect, test } from "bun:test";
import {
  aggregateWatchlistSignals,
  americanToImpliedProbability,
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
