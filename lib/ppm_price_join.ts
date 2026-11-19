/**
 * @file lib/ppm_price_join.ts
 * @description Joins the price book (`getUpdates`) to the fixture snapshot
 * (`/live/allEvents`).
 *
 * The two payloads meet on one id: the **betting event id**. They do not share
 * much else, so nothing is inferred across the boundary:
 *
 *  - the snapshot owns teams, sport, league and start time;
 *  - the price book owns period → market → line/selection → decimal price;
 *  - `eventsMetadata.wagertypes` names the market ids (399 of 407 resolve);
 *  - league ids are a different space and are never joined (see
 *    `ppm_metadata.ts`).
 *
 * Measured 2026-11-13 (snapshot 10:56, prices 10:25):
 *
 *   6,724 fixtures        3,331 priced (49.5%) — the rest are unpriced,
 *                         which is a state, not an error
 *   3,531 priced events   3,331 joined (94.3%); 200 orphaned (finished or
 *                         from a slate the snapshot no longer lists)
 *   95,563 markets        79,297 named (83.0%); 16,266 unnamed across 8 ids
 *                         (`1`, `147`, `148`, `150`, `151`, `236`, `26`, `27`)
 *   673,813 prices        with decimal and American on every point
 *
 * This module is pure: it takes parsed payloads and returns a projection. No
 * fetch, no label invented for an id the metadata does not name.
 */

import type {
  PpmPricePoint,
  PpmBootstrap,
  PpmEventPrices,
  PpmMarketKeyKind,
  PpmMarketPrices,
  PpmSideRole,
} from "./ppm_bootstrap.ts";
import { referencePrices } from "./ppm_bootstrap.ts";
import type { DeskBoard, DeskGame } from "./ppm_desk_board.ts";
import type { PpmFixture } from "./ppm_live_feed.ts";
import { decimalToAmerican } from "./ppm_odds.ts";

/** A price with both the feed's decimal and the desk's American spelling. */
export interface PpmPricedPrice {
  readonly key: string;
  readonly line: number | null;
  readonly side: number | null;
  readonly role: PpmSideRole | null;
  readonly decimal: number;
  readonly american: number;
}

export interface PpmPricedMarket {
  readonly marketId: number;
  /** `null` when `eventsMetadata.wagertypes` has no name for the id. */
  readonly marketName: string | null;
  readonly period: string;
  /** The market node's own `r` line, when it carries one. */
  readonly referenceLine: number | null;
  readonly keyKind: PpmMarketKeyKind;
  readonly twoSided: boolean;
  /** True when `referenceLine` is one of the keys and prices at it survived. */
  readonly hasReferencePrice: boolean;
  readonly prices: readonly PpmPricedPrice[];
}

export interface PpmPricedFixture {
  readonly fixture: PpmFixture;
  readonly markets: readonly PpmPricedMarket[];
}

/** A priced event with no fixture: finished, or from a slate not in the snapshot. */
export interface PpmOrphanPriceEvent {
  readonly eventId: string;
  readonly markets: number;
}

export interface PpmPriceJoin {
  /** Only fixtures that carry at least one market, ordered by start then id. */
  readonly priced: readonly PpmPricedFixture[];
  readonly orphanPriceEvents: readonly PpmOrphanPriceEvent[];
  readonly counts: {
    readonly fixtures: number;
    readonly pricedFixtures: number;
    readonly markets: number;
    readonly prices: number;
    readonly twoSidedMarkets: number;
    /** Markets whose id has no name in the metadata handed in. */
    readonly unnamedMarkets: number;
    readonly orphanPriceEvents: number;
  };
}

export interface PpmJoinOptions {
  readonly marketNames?: ReadonlyMap<number, string>;
}

function toPricedPrice(point: PpmPricePoint): PpmPricedPrice {
  return {
    key: point.key,
    line: point.line,
    side: point.side,
    role: point.role,
    decimal: point.decimal,
    american: decimalToAmerican(point.decimal),
  };
}

function toPricedMarket(
  market: PpmMarketPrices,
  marketNames: ReadonlyMap<number, string> | undefined,
): PpmPricedMarket {
  const referenceLine = market.line;
  return {
    marketId: market.marketId,
    marketName: marketNames?.get(market.marketId) ?? null,
    period: market.period,
    referenceLine,
    keyKind: market.keyKind,
    twoSided: market.twoSided,
    hasReferencePrice: referencePrices(market).length > 0,
    prices: market.points.map(toPricedPrice),
  };
}

function comparePeriods(a: string, b: string): number {
  // `full` first, then halves, then set/period codes in numeric order.
  const rank = (period: string): [number, number] =>
    period === "full"
      ? [0, 0]
      : period === "h1"
        ? [1, 0]
        : period === "h2"
          ? [2, 0]
          : [3, Number(period.slice(1)) || 0];
  const [ra, na] = rank(a);
  const [rb, nb] = rank(b);
  return ra - rb || na - nb || a.localeCompare(b);
}

/**
 * Joins prices onto fixtures. Events with no market are simply absent from
 * `priced`; priced events with no fixture are reported, never dropped.
 */
export function joinPpmPrices(
  fixtures: readonly PpmFixture[],
  bootstrap: PpmBootstrap,
  options: PpmJoinOptions = {},
): PpmPriceJoin {
  const pricesByEvent = new Map<string, PpmEventPrices>();
  for (const event of bootstrap.events) pricesByEvent.set(event.eventId, event);

  const priced: PpmPricedFixture[] = [];
  let markets = 0;
  let prices = 0;
  let twoSidedMarkets = 0;
  let unnamedMarkets = 0;
  const seen = new Set<string>();

  for (const fixture of fixtures) {
    const eventId = String(fixture.eventId);
    const pricesForEvent = pricesByEvent.get(eventId);
    if (!pricesForEvent || pricesForEvent.markets.length === 0) continue;
    seen.add(eventId);

    const pricedMarkets = [...pricesForEvent.markets]
      .sort(
        (a, b) => comparePeriods(a.period, b.period) || a.marketId - b.marketId,
      )
      .map((market) => toPricedMarket(market, options.marketNames));

    for (const market of pricedMarkets) {
      markets += 1;
      prices += market.prices.length;
      if (market.twoSided) twoSidedMarkets += 1;
      if (market.marketName === null) unnamedMarkets += 1;
    }
    priced.push({ fixture, markets: pricedMarkets });
  }

  priced.sort(
    (a, b) =>
      a.fixture.startTimeUnix - b.fixture.startTimeUnix ||
      a.fixture.eventId - b.fixture.eventId,
  );

  const orphanPriceEvents: PpmOrphanPriceEvent[] = [];
  for (const event of bootstrap.events) {
    if (seen.has(event.eventId)) continue;
    if (event.markets.length === 0) continue;
    orphanPriceEvents.push({
      eventId: event.eventId,
      markets: event.markets.length,
    });
  }

  return {
    priced,
    orphanPriceEvents,
    counts: {
      fixtures: fixtures.length,
      pricedFixtures: priced.length,
      markets,
      prices,
      twoSidedMarkets,
      unnamedMarkets,
      orphanPriceEvents: orphanPriceEvents.length,
    },
  };
}

/** One desk game with the priced event that belongs to it, if any. */
export interface PpmAlignedGame {
  readonly game: DeskGame;
  /** The priced event chosen, or `null` when unpriced or ambiguous. */
  readonly eventId: number | null;
  readonly markets: readonly PpmPricedMarket[];
  /** More than one of the game's events carried prices; nothing was merged. */
  readonly ambiguous: boolean;
  readonly candidateEventIds: readonly number[];
}

export interface PpmGameAlignment {
  readonly games: readonly PpmAlignedGame[];
  readonly counts: {
    readonly games: number;
    readonly pricedGames: number;
    readonly unpricedGames: number;
    /** Games with more than one priced event; left unpriced on purpose. */
    readonly ambiguousGames: number;
    /** Priced games whose price came from an event other than `eventIds[0]`. */
    readonly pricedNotFirst: number;
  };
}

/**
 * Picks, per desk game, the one event that carries prices.
 *
 * Measured 2026-11-13: 3,331 games are priced, and in 86 of them (2.6%) the
 * priced event is **not** `eventIds[0]` — a naive first-event join loses those.
 * No game has two priced events, so the multi-price case has no precedent to
 * copy; it is reported as `ambiguous` instead of merged or resolved by order.
 */
export function alignPpmPricesToGames(
  board: Pick<DeskBoard, "games">,
  join: PpmPriceJoin,
): PpmGameAlignment {
  const byEvent = new Map<number, PpmPricedFixture>();
  for (const entry of join.priced) byEvent.set(entry.fixture.eventId, entry);

  let pricedGames = 0;
  let ambiguousGames = 0;
  let pricedNotFirst = 0;
  const games: PpmAlignedGame[] = [];

  for (const game of board.games) {
    const hits = game.eventIds.filter((eventId) => byEvent.has(eventId));
    if (hits.length === 0) {
      games.push({
        game,
        eventId: null,
        markets: [],
        ambiguous: false,
        candidateEventIds: [],
      });
      continue;
    }
    if (hits.length > 1) {
      ambiguousGames += 1;
      games.push({
        game,
        eventId: null,
        markets: [],
        ambiguous: true,
        candidateEventIds: hits,
      });
      continue;
    }
    const eventId = hits[0]!;
    const entry = byEvent.get(eventId)!;
    pricedGames += 1;
    if (eventId !== game.eventIds[0]) pricedNotFirst += 1;
    games.push({
      game,
      eventId,
      markets: entry.markets,
      ambiguous: false,
      candidateEventIds: [],
    });
  }

  return {
    games,
    counts: {
      games: board.games.length,
      pricedGames,
      unpricedGames: board.games.length - pricedGames - ambiguousGames,
      ambiguousGames,
      pricedNotFirst,
    },
  };
}
