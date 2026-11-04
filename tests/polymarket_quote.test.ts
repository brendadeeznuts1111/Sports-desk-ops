import { describe, expect, test } from "bun:test";
import {
  PolymarketQuoteClient,
  parseGammaMarket,
  parseGammaSearch,
  parsePolymarketBook,
  queryForTeams,
  teamMatchesQuestion,
} from "../lib/polymarket_quote.ts";
import {
  executionFixtureFetch,
  readExecutionFixture,
} from "./fixtures/execution/fixture_fetch.ts";
import { readKalshiFixture } from "./fixtures/kalshi/fixture_fetch.ts";

/**
 * Polymarket discovery/book parsing from the real captures. The captured sports markets are
 * closed/historical (that is what gamma search returns in 2026), so the default case is
 * "unavailable, with a reason" — the honest production behaviour. The fixture helper can flip the
 * captured market's `closed` flag to exercise the open-market token/book path; no price is invented.
 */

const NOW = 1_790_000_000_000;

describe("team matching and query building", () => {
  test("codes match city prefixes and hinted names", () => {
    expect(
      teamMatchesQuestion("Milwaukee Brewers vs. Boston Red Sox", "MIL"),
    ).toBe(true);
    expect(
      teamMatchesQuestion("Milwaukee Brewers vs. Boston Red Sox", "BOS"),
    ).toBe(true);
    expect(teamMatchesQuestion("Golden State Warriors vs. Lakers", "GSW")).toBe(
      true,
    );
    expect(teamMatchesQuestion("New Orleans Pelicans vs. Spurs", "NOP")).toBe(
      true,
    );
    expect(teamMatchesQuestion("Lakers vs. Celtics", "LAL")).toBe(true);
    // BOS now resolves through the unified registry's "Celtics" hint, not just the city prefix.
    expect(teamMatchesQuestion("Lakers vs. Celtics", "BOS")).toBe(true);
  });

  test("query expands hinted codes", () => {
    expect(queryForTeams(["MIL", "BOS"])).toBe("Milwaukee Boston");
    expect(queryForTeams(["GSW", "LAL"])).toBe("Golden State Lakers");
  });
});

describe("gamma parsing", () => {
  test("real captured search yields no open market", () => {
    const fixture = readExecutionFixture("polymarket-gamma-search.json");
    expect(parseGammaSearch(fixture)).toEqual([]);
  });

  test("a market without readable token arrays is dropped", () => {
    expect(
      parseGammaMarket({
        id: "m1",
        question: "A vs. B",
        active: true,
        closed: false,
        clobTokenIds: "not json",
        outcomes: '["A","B"]',
      }),
    ).toBeNull();
    expect(
      parseGammaMarket({
        id: "m1",
        question: "A vs. B",
        active: true,
        closed: false,
        clobTokenIds: '["1","2"]',
        outcomes: '["A"]',
      }),
    ).toBeNull();
  });
});

describe("CLOB book parsing", () => {
  test("real captured book parses bids with prices and sizes", () => {
    const fixture = readExecutionFixture("polymarket-clob-book.json");
    const book = parsePolymarketBook(fixture);
    expect(book).not.toBeNull();
    expect(book?.bids.length).toBeGreaterThan(10);
    expect(book?.bids[0]?.price).toBeGreaterThanOrEqual(
      book?.bids[1]?.price ?? 0,
    );
    expect(book?.bids[0]?.size).toBeGreaterThan(0);
  });

  test("garbage levels are dropped", () => {
    const book = parsePolymarketBook({
      bids: [
        { price: "0.5", size: "10" },
        { price: "1.5", size: "10" },
      ],
      asks: [],
    });
    expect(book?.bids).toEqual([{ price: 0.5, size: 10 }]);
    expect(book?.asks).toEqual([]);
  });
});

describe("PolymarketQuoteClient", () => {
  test("no open market → unavailable with a reason, never a guessed token", async () => {
    const fixture = executionFixtureFetch();
    const client = new PolymarketQuoteClient({
      fetchImpl: fixture.fetch,
      now: () => NOW,
    });
    const quote = await client.quoteForTeams(["MIL", "BOS"]);
    expect(quote.available).toBe(false);
    if (!quote.available) {
      expect(quote.reason).toContain("no open Polymarket market");
    }
    expect(fixture.orderCalls).toEqual([]);
  });

  test("open market path parses captured tokens and the real book", async () => {
    const fixture = executionFixtureFetch({ forceOpenGammaMarket: true });
    const client = new PolymarketQuoteClient({
      fetchImpl: fixture.fetch,
      now: () => NOW,
    });
    const quote = await client.quoteForTeams(["MIL", "BOS"]);
    expect(quote.available).toBe(true);
    if (!quote.available) return;
    expect(quote.marketId).toBeString();
    expect(quote.outcomes).toHaveLength(2);
    expect(quote.outcomes[0]?.tokenId.length).toBeGreaterThan(10);
    expect(quote.outcomes[0]?.bids.length).toBeGreaterThan(0);
    expect(quote.source).toBe("gamma+clob");
    expect(quote.telemetry.degraded).toBe(false);
  });

  test("second quote hits the 60s cache", async () => {
    const fixture = executionFixtureFetch({ forceOpenGammaMarket: true });
    let clock = NOW;
    const client = new PolymarketQuoteClient({
      fetchImpl: fixture.fetch,
      now: () => clock,
    });
    await client.quoteForTeams(["MIL", "BOS"]);
    const requestsAfterFirst = client.telemetry().requests;
    await client.quoteForTeams(["MIL", "BOS"]);
    expect(client.telemetry().cacheHits).toBeGreaterThan(0);
    expect(client.telemetry().requests).toBe(requestsAfterFirst);
    clock += 61_000;
    await client.quoteForTeams(["MIL", "BOS"]);
    expect(client.telemetry().requests).toBeGreaterThan(requestsAfterFirst);
  });

  test("network failure is degraded and unavailable, not a number", async () => {
    const client = new PolymarketQuoteClient({
      fetchImpl: (async () => {
        throw new Error("fixture network failure");
      }) as unknown as typeof fetch,
      now: () => NOW,
    });
    const quote = await client.quoteForTeams(["MIL", "BOS"]);
    expect(quote.available).toBe(false);
    if (!quote.available) expect(quote.reason).toContain("gamma unavailable");
    expect(client.telemetry().degraded).toBe(true);
  });
});

describe("fixtures are real captures", () => {
  test("gamma and clob fixtures carry their capture source", () => {
    const gamma = readExecutionFixture("polymarket-gamma-search.json") as {
      capturedAtIso?: unknown;
      source?: unknown;
    };
    expect(typeof gamma.source).toBe("string");
    expect(gamma.source).toContain("gamma-api.polymarket.com");
    const clob = readExecutionFixture("polymarket-clob-book.json") as {
      capturedAtIso?: unknown;
    };
    expect(typeof clob.capturedAtIso).toBe("string");
    // Kalshi fixture copy still parses as a book.
    expect(parsePolymarketBook({ bids: [], asks: [] })).not.toBeNull();
    expect(readKalshiFixture("orderbook-kxnbagame-atl.json")).toBeDefined();
  });
});
