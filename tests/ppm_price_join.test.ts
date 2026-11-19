/**
 * @file tests/ppm_price_join.test.ts
 * @description The price book joined to the fixture snapshot: one id (the
 * betting event id), named markets, decimal and American prices, and the two
 * coverage states — a fixture with no open market, a priced event with no
 * fixture.
 */
import { describe, expect, test } from "bun:test";
import { parsePpmBootstrap } from "../lib/ppm_bootstrap.ts";
import { parsePpmAllEvents } from "../lib/ppm_live_feed.ts";
import { parsePpmMetadata } from "../lib/ppm_metadata.ts";
import { alignPpmPricesToGames, joinPpmPrices } from "../lib/ppm_price_join.ts";

const SNAPSHOT = parsePpmAllEvents(
  await Bun.file(
    new URL("./fixtures/ppm/all-events.crop.json", import.meta.url),
  ).json(),
);
const PRICES = parsePpmBootstrap(
  await Bun.file(
    new URL("./fixtures/ppm/price-join.crop.json", import.meta.url),
  ).json(),
);
const METADATA = parsePpmMetadata(
  await Bun.file(
    new URL("./fixtures/ppm/metadata.crop.json", import.meta.url),
  ).json(),
);
const JOIN = joinPpmPrices(SNAPSHOT.fixtures, PRICES, {
  marketNames: METADATA.marketNames,
});

describe("joinPpmPrices", () => {
  test("joins on the betting event id and reports both coverage states", () => {
    expect(JOIN.counts.fixtures).toBe(SNAPSHOT.fixtures.length);
    expect(JOIN.counts.pricedFixtures).toBe(2);
    expect(JOIN.counts.pricedFixtures).toBeLessThan(JOIN.counts.fixtures);
    expect(JOIN.counts.markets).toBeGreaterThan(0);
    expect(JOIN.counts.prices).toBeGreaterThan(JOIN.counts.markets);
    expect(JOIN.counts.orphanPriceEvents).toBe(0);
  });

  test("keeps the fixture's teams, sport and start", () => {
    const first = JOIN.priced[0]!;
    const source = SNAPSHOT.fixtures.find(
      (fixture) => fixture.eventId === first.fixture.eventId,
    );
    expect(first.fixture).toEqual(source!);
    expect(first.fixture.home.name.length).toBeGreaterThan(0);
    expect(first.fixture.startTimeUnix).toBeGreaterThan(1_700_000_000);
  });

  test("names markets from metadata and reports ids it cannot name", () => {
    const markets = JOIN.priced.flatMap((entry) => entry.markets);
    const moneyline = markets.find((market) => market.marketId === 3);
    expect(moneyline!.marketName).toBe("Money Line");
    expect(markets.filter((market) => market.marketName === null).length).toBe(
      JOIN.counts.unnamedMarkets,
    );
    expect(JOIN.counts.unnamedMarkets).toBeGreaterThan(0);
  });

  test("carries decimal and American prices on every point", () => {
    const point = JOIN.priced[0]!.markets[0]!.prices[0]!;
    expect(point.decimal).toBeGreaterThan(1.001);
    expect(point.american).toBeInteger();
    expect(Math.abs(point.american)).toBeGreaterThanOrEqual(100);
  });

  test("orders periods full, halves, then set/period codes", () => {
    const rank = (period: string) =>
      period === "full" ? 0 : period === "h1" ? 1 : period === "h2" ? 2 : 3;
    for (const entry of JOIN.priced) {
      const ranks = entry.markets.map((market) => rank(market.period));
      for (let i = 1; i < ranks.length; i += 1) {
        expect(ranks[i]!).toBeGreaterThanOrEqual(ranks[i - 1]!);
      }
    }
  });

  test("flags markets whose reference line has prices", () => {
    const totals = JOIN.priced.flatMap((entry) =>
      entry.markets.filter((market) => market.marketId === 5),
    );
    expect(totals.length).toBeGreaterThan(0);
    expect(totals.some((market) => market.hasReferencePrice)).toBe(true);
    const reference = totals.find((market) => market.hasReferencePrice)!;
    expect(
      reference.prices.filter((price) => price.line === reference.referenceLine)
        .length,
    ).toBeGreaterThan(0);
  });

  test("a priced event missing from the snapshot is reported, not dropped", () => {
    const join = joinPpmPrices(SNAPSHOT.fixtures.slice(0, 5), PRICES, {
      marketNames: METADATA.marketNames,
    });
    const joined = join.priced.map((entry) => String(entry.fixture.eventId));
    const expectedOrphans = PRICES.events.filter(
      (event) => event.markets.length > 0 && !joined.includes(event.eventId),
    ).length;
    expect(join.orphanPriceEvents).toHaveLength(expectedOrphans);
    expect(join.counts.orphanPriceEvents).toBe(expectedOrphans);
  });

  test("a fixture with no open market is absent from priced, not zero-priced", () => {
    const pricedIds = new Set(
      JOIN.priced.map((entry) => String(entry.fixture.eventId)),
    );
    const unpriced = SNAPSHOT.fixtures.find(
      (fixture) => !pricedIds.has(String(fixture.eventId)),
    );
    expect(unpriced).toBeDefined();
    expect(
      JOIN.priced.find((entry) => entry.fixture.eventId === unpriced!.eventId),
    ).toBeUndefined();
  });
});

const ALIGN_FIXTURES = [1, 2, 3].map((id) => ({
  eventId: id,
  slateId: 1,
  sportId: 1,
  leagueId: 1,
  home: { name: `H${id}`, teamId: id * 10 },
  away: { name: `A${id}`, teamId: id * 10 + 1 },
  startTimeUnix: 1_800_000_000,
}));
const ALIGN_PRICES = parsePpmBootstrap([
  {
    t: 1,
    c: {
      "1": { c: { m: { "3": { o: { "1": 1.9, "2": 1.9 } } } } },
      "2": { c: { m: { "3": { o: { "1": 2.1, "2": 1.7 } } } } },
    },
  },
  {},
  {},
  {},
]);
const ALIGN_JOIN = joinPpmPrices(ALIGN_FIXTURES, ALIGN_PRICES);

function game(id: string, eventIds: number[]) {
  return {
    id,
    slateId: 1,
    sportId: 1,
    sportName: "Baseball",
    leagueId: 1,
    home: { name: `H${eventIds[0]}`, teamId: eventIds[0]! * 10 },
    away: { name: `A${eventIds[0]}`, teamId: eventIds[0]! * 10 + 1 },
    startTimeUnix: 1_800_000_000,
    eventIds,
  };
}

describe("alignPpmPricesToGames", () => {
  const alignment = alignPpmPricesToGames(
    {
      games: [
        game("first", [1]),
        game("later", [99, 2]),
        game("unpriced", [3]),
        game("two-priced", [1, 2]),
      ],
    },
    ALIGN_JOIN,
  );

  test("uses the priced event, even when it is not eventIds[0]", () => {
    const later = alignment.games.find((entry) => entry.game.id === "later")!;
    expect(later.eventId).toBe(2);
    expect(later.markets).toHaveLength(1);
    expect(alignment.counts.pricedNotFirst).toBe(1);
  });

  test("an unpriced game stays unpriced rather than zero-priced", () => {
    const unpriced = alignment.games.find(
      (entry) => entry.game.id === "unpriced",
    )!;
    expect(unpriced.eventId).toBeNull();
    expect(unpriced.markets).toEqual([]);
    expect(unpriced.ambiguous).toBe(false);
  });

  test("two priced events are reported as ambiguous, not merged", () => {
    const ambiguous = alignment.games.find(
      (entry) => entry.game.id === "two-priced",
    )!;
    expect(ambiguous.ambiguous).toBe(true);
    expect(ambiguous.eventId).toBeNull();
    expect(ambiguous.markets).toEqual([]);
    expect(ambiguous.candidateEventIds).toEqual([1, 2]);
    expect(alignment.counts.ambiguousGames).toBe(1);
  });

  test("counts partition the games", () => {
    expect(alignment.counts.games).toBe(4);
    expect(alignment.counts.pricedGames).toBe(2);
    expect(alignment.counts.unpricedGames).toBe(1);
    expect(alignment.counts.ambiguousGames).toBe(1);
  });
});
