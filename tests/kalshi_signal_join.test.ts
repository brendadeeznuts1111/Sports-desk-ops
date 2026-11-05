import { describe, expect, test } from "bun:test";
import { KalshiClient } from "../lib/kalshi_client.ts";
import {
  DEFAULT_JOIN_CONFIG,
  deriveLiquidity,
  eventTeamCodeCandidates,
  joinConfigFromEnv,
  joinWatchlistSignals,
  seriesTickerFor,
  teamCodesMatch,
} from "../lib/kalshi_signal_join.ts";
import type { WatchlistSignal } from "../lib/watchlist_signal_engine.ts";
import { parseKalshiOrderbook } from "../lib/kalshi_client.ts";
import {
  kalshiFixtureFetch,
  readKalshiFixture,
} from "./fixtures/kalshi/fixture_fetch.ts";

const NOW = 1_790_000_000_000;

function signal(overrides: Partial<WatchlistSignal> = {}): WatchlistSignal {
  return {
    id: "NBA-ATL_WSH-moneyline-noline-ATL",
    league: "NBA",
    marketKind: "moneyline",
    teams: ["ATL", "WSH"],
    sideTeam: "ATL",
    line: null,
    overUnder: null,
    accounts: [
      {
        login: "BGD101",
        agentId: "BIGDAD",
        archetype: "whale",
        sourceCategory: "POLY_ONCHAIN_CTF_WHALE",
        riskUsd: 5_000,
        source: "docs/graph-live-feed.json",
      },
    ],
    distinctAccounts: 1,
    riskUsd: 5_000,
    oneSidedShare: 1,
    fairProb: 0.62,
    confidence: 40,
    provenance: {
      dataMode: "LIVE",
      asOf: "2026-11-04T11:59:00.000Z",
      ageSeconds: 60,
      stale: false,
      fixture: false,
      sources: ["docs/graph-live-feed.json"],
    },
    ...overrides,
  };
}

function clientWith(fetchImpl: typeof fetch): KalshiClient {
  return new KalshiClient({ fetchImpl, now: () => NOW });
}

describe("team-code matching", () => {
  test("alias table links registry codes to Kalshi tickers", () => {
    expect(teamCodesMatch("WSH", "WAS")).toBe(true);
    expect(teamCodesMatch("BRK", "BKN")).toBe(true);
    expect(teamCodesMatch("GS", "GSW")).toBe(true);
    expect(teamCodesMatch("ATL", "BOS")).toBe(false);
  });

  test("candidate pairs come from real captured event tickers", () => {
    expect(
      eventTeamCodeCandidates("KXNBAGAME-26NOV04ATLWAS", "KXNBAGAME"),
    ).toContainEqual(["ATL", "WAS"]);
    expect(
      eventTeamCodeCandidates("KXNBAGAME-26NOV04CHABKN", "KXNBAGAME"),
    ).toContainEqual(["CHA", "BKN"]);
  });
});

describe("series map", () => {
  test("maps league × kind, and unsupported kinds stay unmapped", () => {
    expect(seriesTickerFor(signal({ marketKind: "moneyline" }))).toBe(
      "KXNBAGAME",
    );
    expect(
      seriesTickerFor(
        signal({ marketKind: "total", sideTeam: null, overUnder: "over" }),
      ),
    ).toBe("KXNBATOTAL");
    expect(seriesTickerFor(signal({ marketKind: "team_total" }))).toBe(
      "KXNBATEAMTOTAL",
    );
    expect(seriesTickerFor(signal({ marketKind: "prop" }))).toBeNull();
  });

  test("measured gaps are closed: NBA 2H totals, NHL 2P total, MLB core", () => {
    expect(
      seriesTickerFor(signal({ marketKind: "2h_total", sideTeam: null })),
    ).toBe("KXNBA2HTOTAL");
    expect(
      seriesTickerFor(signal({ marketKind: "2h_team_total", sideTeam: null })),
    ).toBe("KXNBA2HTEAMTOTAL");
    expect(
      seriesTickerFor(signal({ league: "NHL", marketKind: "2p_total" })),
    ).toBe("KXNHL2PTOTAL");
    expect(seriesTickerFor(signal({ league: "MLB" }))).toBe("KXMLBGAME");
    expect(
      seriesTickerFor(
        signal({ league: "MLB", marketKind: "spread", sideTeam: "ATL" }),
      ),
    ).toBe("KXMLBSPREAD");
    expect(
      seriesTickerFor(
        signal({ league: "MLB", marketKind: "total", sideTeam: null }),
      ),
    ).toBe("KXMLBTOTAL");
    expect(
      seriesTickerFor(
        signal({ league: "MLB", marketKind: "team_total", sideTeam: "ATL" }),
      ),
    ).toBe("KXMLBTEAMTOTAL");
    // An unsupported period kind still refuses rather than guessing a series.
    expect(
      seriesTickerFor(signal({ league: "NHL", marketKind: "2p_spread" })),
    ).toBeNull();
  });
});

describe("liquidity from the captured book", () => {
  const book = parseKalshiOrderbook(
    readKalshiFixture("orderbook-kxnbagame-atl.json"),
  );
  if (book === null) throw new Error("orderbook fixture did not parse");

  test("YES side lifts NO bids: executable 0.56, 1c spread, top size from the level", () => {
    const liquidity = deriveLiquidity(book, "YES", DEFAULT_JOIN_CONFIG);
    expect(liquidity.executablePrice).toBe(0.56);
    expect(liquidity.spreadCents).toBe(1);
    expect(liquidity.topSize).toBe(649.19);
    expect(liquidity.depthContracts).toBeGreaterThanOrEqual(
      DEFAULT_JOIN_CONFIG.minContracts,
    );
    expect(liquidity.verdict).toBe("ok");
    expect(liquidity.priceImpactCents).not.toBeNull();
  });

  test("the reference notional caps the depth walk", () => {
    const small = deriveLiquidity(book, "YES", {
      ...DEFAULT_JOIN_CONFIG,
      referenceNotionalUsd: 100,
    });
    const large = deriveLiquidity(book, "YES", DEFAULT_JOIN_CONFIG);
    expect(small.depthContracts).toBeLessThan(large.depthContracts);
  });

  test("an empty book is empty, not a price", () => {
    const liquidity = deriveLiquidity(
      { yes: [], no: [] },
      "YES",
      DEFAULT_JOIN_CONFIG,
    );
    expect(liquidity.executablePrice).toBeNull();
    expect(liquidity.vwap).toBeNull();
    expect(liquidity.verdict).toBe("empty");
  });

  test("thresholds come from env with contract defaults", () => {
    expect(joinConfigFromEnv({})).toEqual(DEFAULT_JOIN_CONFIG);
    expect(
      joinConfigFromEnv({
        KALSHI_MIN_EDGE_BPS: "500",
        KALSHI_MIN_CONTRACTS: "10",
        KALSHI_MAX_SPREAD_CENTS: "2",
        KALSHI_REFERENCE_NOTIONAL_USD: "250",
      }),
    ).toEqual({
      minEdgeBps: 500,
      minContracts: 10,
      maxSpreadCents: 2,
      referenceNotionalUsd: 250,
    });
    // A bad value keeps the default rather than becoming 0/NaN.
    expect(joinConfigFromEnv({ KALSHI_MIN_CONTRACTS: "banana" })).toEqual(
      DEFAULT_JOIN_CONFIG,
    );
  });
});

describe("signal → market join", () => {
  test("moneyline: team code + alias match, YES side, actionable edge", async () => {
    const fixture = kalshiFixtureFetch();
    const joined = await joinWatchlistSignals([signal()], {
      client: clientWith(fixture.fetch),
      config: DEFAULT_JOIN_CONFIG,
    });
    const first = joined[0];
    expect(first?.kalshi.eventTicker).toBe("KXNBAGAME-26NOV04ATLWAS");
    expect(first?.kalshi.marketTicker).toBe("KXNBAGAME-26NOV04ATLWAS-ATL");
    expect(first?.kalshi.side).toBe("YES");
    expect(first?.kalshi.executablePrice).toBe(0.56);
    expect(first?.kalshi.edgeBps).toBe(600);
    expect(first?.kalshi.liquidityVerdict).toBe("ok");
    expect(first?.kalshi.verdict).toBe("actionable");
  });

  test("total: over lifts the Over strike YES; under takes NO (Kalshi is Over-only)", async () => {
    const fixture = kalshiFixtureFetch();
    const over = await joinWatchlistSignals(
      [
        signal({
          id: "total-over",
          marketKind: "total",
          teams: ["ATL", "WAS"],
          sideTeam: null,
          line: 206.5,
          overUnder: "over",
          fairProb: 0.95,
        }),
      ],
      { client: clientWith(fixture.fetch), config: DEFAULT_JOIN_CONFIG },
    );
    expect(over[0]?.kalshi.marketTicker).toBe("KXNBATOTAL-26NOV04ATLWAS-207");
    expect(over[0]?.kalshi.side).toBe("YES");
    expect(over[0]?.kalshi.executablePrice).toBe(0.94);

    const under = await joinWatchlistSignals(
      [
        signal({
          id: "total-under",
          marketKind: "total",
          teams: ["ATL", "WAS"],
          sideTeam: null,
          line: 206.5,
          overUnder: "under",
          fairProb: 0.5,
        }),
      ],
      { client: clientWith(fixture.fetch), config: DEFAULT_JOIN_CONFIG },
    );
    expect(under[0]?.kalshi.side).toBe("NO");
    // NO ask = 1 − best YES bid (0.93).
    expect(under[0]?.kalshi.executablePrice).toBe(0.07);
    expect(under[0]?.kalshi.verdict).toBe("thin_liquidity");
  });

  test("favorite −1.5 takes YES on that team's wins-by-over market", async () => {
    const fixture = kalshiFixtureFetch();
    const joined = await joinWatchlistSignals(
      [
        signal({
          id: "spread-fav",
          marketKind: "spread",
          line: -1.5,
          sideTeam: "ATL",
          fairProb: 0.7,
        }),
      ],
      { client: clientWith(fixture.fetch), config: DEFAULT_JOIN_CONFIG },
    );
    expect(joined[0]?.kalshi.marketTicker).toBe(
      "KXNBASPREAD-26NOV04ATLWAS-ATL2",
    );
    expect(joined[0]?.kalshi.side).toBe("YES");
  });

  test("dog +14.5 takes NO on the opponent's wins-by-over market", async () => {
    const fixture = kalshiFixtureFetch();
    const joined = await joinWatchlistSignals(
      [
        signal({
          id: "spread-dog",
          marketKind: "spread",
          line: 14.5,
          sideTeam: "ATL",
          fairProb: 0.4,
        }),
      ],
      { client: clientWith(fixture.fetch), config: DEFAULT_JOIN_CONFIG },
    );
    // ATL +14.5 ⇔ NOT (WAS wins by over 14.5): Kalshi NO on WAS15.
    expect(joined[0]?.kalshi.marketTicker).toBe(
      "KXNBASPREAD-26NOV04ATLWAS-WAS15",
    );
    expect(joined[0]?.kalshi.side).toBe("NO");
    expect(joined[0]?.kalshi.verdict).toBe("thin_liquidity");
  });

  test("team total uses the team's strike market", async () => {
    const fixture = kalshiFixtureFetch();
    const joined = await joinWatchlistSignals(
      [
        signal({
          id: "team-total",
          marketKind: "team_total",
          teams: ["MIL", "BOS"],
          sideTeam: "BOS",
          line: 117.5,
          overUnder: "over",
          fairProb: 0.5,
        }),
      ],
      { client: clientWith(fixture.fetch), config: DEFAULT_JOIN_CONFIG },
    );
    expect(joined[0]?.kalshi.marketTicker).toBe(
      "KXNBATEAMTOTAL-26NOV04MILBOS-BOS118",
    );
    expect(joined[0]?.kalshi.side).toBe("YES");
  });

  test("no matching event/market is no_market with a reason", async () => {
    const fixture = kalshiFixtureFetch();
    const noEvent = await joinWatchlistSignals(
      [signal({ league: "NHL", id: "nhl" })],
      { client: clientWith(fixture.fetch), config: DEFAULT_JOIN_CONFIG },
    );
    expect(noEvent[0]?.kalshi.verdict).toBe("no_market");
    expect(noEvent[0]?.kalshi.reason).toContain("no open events for series");

    const noKind = await joinWatchlistSignals(
      [signal({ marketKind: "prop", id: "prop" })],
      { client: clientWith(fixture.fetch), config: DEFAULT_JOIN_CONFIG },
    );
    expect(noKind[0]?.kalshi.verdict).toBe("no_market");
    expect(noKind[0]?.kalshi.reason).toContain("unsupported league/kind");
  });

  test("verdict precedence: fixture_only caps a matched, liquid, positive-edge signal", async () => {
    const fixture = kalshiFixtureFetch();
    const joined = await joinWatchlistSignals(
      [
        signal({
          id: "fixture",
          provenance: {
            dataMode: "PARTIAL",
            asOf: "2026-11-04T11:59:00.000Z",
            ageSeconds: 60,
            stale: false,
            fixture: true,
            sources: ["docs/graph-live-feed.json"],
          },
        }),
      ],
      { client: clientWith(fixture.fetch), config: DEFAULT_JOIN_CONFIG },
    );
    expect(joined[0]?.kalshi.marketTicker).not.toBeNull();
    expect(joined[0]?.kalshi.liquidityVerdict).toBe("ok");
    expect(joined[0]?.kalshi.verdict).toBe("fixture_only");
  });

  test("verdict precedence: no_fair_price and stale before liquidity/edge", async () => {
    const fixture = kalshiFixtureFetch();
    const noFair = await joinWatchlistSignals(
      [signal({ id: "nofair", fairProb: null })],
      { client: clientWith(fixture.fetch), config: DEFAULT_JOIN_CONFIG },
    );
    expect(noFair[0]?.kalshi.verdict).toBe("no_fair_price");

    const stale = await joinWatchlistSignals(
      [
        signal({
          id: "stale",
          provenance: {
            dataMode: "LIVE",
            asOf: "2026-11-04T09:00:00.000Z",
            ageSeconds: 10_000,
            stale: true,
            fixture: false,
            sources: ["docs/graph-live-feed.json"],
          },
        }),
      ],
      { client: clientWith(fixture.fetch), config: DEFAULT_JOIN_CONFIG },
    );
    expect(stale[0]?.kalshi.verdict).toBe("stale");
  });

  test("verdict precedence: thin/empty liquidity before edge, no_edge before actionable", async () => {
    const empty = kalshiFixtureFetch({ emptyOrderbooks: true });
    const thin = await joinWatchlistSignals([signal({ id: "thin" })], {
      client: clientWith(empty.fetch),
      config: DEFAULT_JOIN_CONFIG,
    });
    expect(thin[0]?.kalshi.liquidityVerdict).toBe("empty");
    expect(thin[0]?.kalshi.verdict).toBe("thin_liquidity");
    expect(thin[0]?.kalshi.executablePrice).toBeNull();

    const ok = kalshiFixtureFetch();
    const noEdge = await joinWatchlistSignals(
      [signal({ id: "noedge", fairProb: 0.55 })],
      { client: clientWith(ok.fetch), config: DEFAULT_JOIN_CONFIG },
    );
    expect(noEdge[0]?.kalshi.edgeBps).toBe(-100);
    expect(noEdge[0]?.kalshi.verdict).toBe("no_edge");
  });

  test("a Kalshi failure is no_market + degraded, never a price", async () => {
    const failing = kalshiFixtureFetch({ failOn: "events" });
    const client = clientWith(failing.fetch);
    const joined = await joinWatchlistSignals([signal({ id: "fail" })], {
      client,
      config: DEFAULT_JOIN_CONFIG,
    });
    expect(joined[0]?.kalshi.verdict).toBe("no_market");
    expect(joined[0]?.kalshi.reason).toContain("Kalshi unavailable");
    expect(joined[0]?.kalshi.executablePrice).toBeNull();
    expect(client.telemetry().degraded).toBe(true);
  });
});
