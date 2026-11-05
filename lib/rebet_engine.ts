/**
 * @file rebet_engine.ts
 * @description Re-bet the bet-ticker signal at a better venue price.
 *
 * The ticker gives a signal with an implied probability (`impliedProb` from its American odds).
 * The venue gives an executable price for the same side. Re-betting is only worth it when the
 * venue price is BETTER than the signal's own price — i.e. the edge `fair - venuePrice` clears the
 * operator threshold. Two order styles are evaluated:
 *
 *  - taker: pay the venue's best ask (or book-walked executable price already in the join).
 *  - maker: rest at `fair - makerMargin`, clamped below the current ask so the order is passive.
 *
 * This module is pure: no network, no order path. It returns opportunities and the precise reason
 * every non-opportunity was rejected, so a paper run or a human approval has something concrete to
 * act on.
 */

import type { BetVenueBreakdown } from "./bet_venue_breakdown.ts";

export type RebetStyle = "taker" | "maker";

export interface RebetOptions {
  readonly styles?: readonly RebetStyle[];
  /** Minimum edge in basis points (`fair - venue price`) to qualify. */
  readonly minEdgeBps: number;
  /** Resting distance below fair for a maker quote, in basis points. */
  readonly makerMarginBps: number;
  /** Target stake in USD per opportunity. */
  readonly stakeUsd: number;
}

export interface RebetOpportunity {
  readonly id: string;
  readonly betKey: string;
  readonly eventLabel: string;
  readonly league: string;
  readonly marketType: string;
  readonly line: number | null;
  readonly side: string | null;
  readonly venue: "kalshi" | "polymarket";
  readonly style: RebetStyle;
  readonly fairProb: number;
  /** Taker price or maker limit price (0..1). */
  readonly venuePrice: number;
  readonly limitPrice: number | null;
  readonly edgeBps: number;
  readonly stakeUsd: number;
  readonly contracts: number;
  readonly marketTicker: string | null;
  readonly polyMarketId: string | null;
  readonly outcomeName: string | null;
  readonly reasons: readonly string[];
}

export interface RebetRejection {
  readonly betKey: string;
  readonly venue: "kalshi" | "polymarket";
  readonly style: RebetStyle;
  readonly reason: string;
}

export interface RebetEvaluation {
  readonly opportunities: readonly RebetOpportunity[];
  readonly rejections: readonly RebetRejection[];
}

const TICK = 0.01;

function roundTick(value: number): number {
  return Math.round(value / TICK) * TICK;
}

function clampPrice(value: number): number {
  return Math.min(0.99, Math.max(TICK, roundTick(value)));
}

function edgeBpsOf(fairProb: number, price: number): number {
  return Math.round((fairProb - price) * 10_000);
}

function contractsFor(stakeUsd: number, price: number): number {
  if (price <= 0) return 0;
  return Math.max(0, Math.floor(stakeUsd / price));
}

/** Best YES ask from a Kalshi book snapshot (YES bids + NO bids; ask = 1 − best NO bid). */
function kalshiBestAsk(row: BetVenueBreakdown): number | null {
  const book = row.kalshi.book;
  if (book === null) return null;
  const noBid = book.no[0]?.price ?? null;
  if (noBid === null) return null;
  return clampPrice(1 - noBid);
}

function selectPolymarketOutcome(
  row: BetVenueBreakdown,
): { name: string; bestBid: number | null; bestAsk: number | null } | null {
  const side = (row.side ?? "").trim().toLowerCase();
  if (side === "" || side === "over" || side === "under") return null;
  const outcomes = row.polymarket.outcomes;
  const match = outcomes.find((outcome) => {
    const name = outcome.name.trim().toLowerCase();
    return name === side || name.includes(side) || side.includes(name);
  });
  if (match === undefined) return null;
  // Poly game-winner markets are commonly Yes/No; those cannot be mapped to a team side.
  if (
    match.name.trim().toLowerCase() === "yes" ||
    match.name.trim().toLowerCase() === "no"
  ) {
    return null;
  }
  return {
    name: match.name,
    bestBid: match.bestBid,
    bestAsk: match.bestAsk,
  };
}

/**
 * Evaluate one breakdown row for both venues and the requested styles. A rejection always names
 * the concrete reason (no market, combo, missing fair price, no side mapping, edge below the
 * threshold) so the caller never has to infer why nothing was rebet.
 */
export function evaluateRebet(
  rows: readonly BetVenueBreakdown[],
  options: RebetOptions,
): RebetEvaluation {
  const styles = options.styles ?? ["taker", "maker"];
  const opportunities: RebetOpportunity[] = [];
  const rejections: RebetRejection[] = [];

  for (const row of rows) {
    for (const style of styles) {
      for (const venue of ["kalshi", "polymarket"] as const) {
        const reject = (reason: string): void => {
          rejections.push({ betKey: row.betKey, venue, style, reason });
        };
        if (row.combo.isCombo) {
          reject("combo_ticket_no_single_venue_market");
          continue;
        }
        const fair = row.signalProbability;
        if (fair === null) {
          reject("no_signal_probability");
          continue;
        }
        if (venue === "kalshi") {
          if (!row.kalshi.available) {
            reject(
              `kalshi_unavailable:${row.kalshi.reason ?? row.kalshi.verdict}`,
            );
            continue;
          }
          if (style === "taker") {
            const price = row.kalshi.price;
            if (price === null) {
              reject("no_kalshi_executable_price");
              continue;
            }
            const edge = edgeBpsOf(fair, price);
            if (edge < options.minEdgeBps) {
              reject(edge <= 0 ? "venue_price_worse" : "edge_below_min");
              continue;
            }
            opportunities.push({
              id: `${row.betKey}:kalshi:taker`,
              betKey: row.betKey,
              eventLabel: row.eventLabel,
              league: row.league,
              marketType: row.marketType,
              line: row.line,
              side: row.side,
              venue,
              style,
              fairProb: fair,
              venuePrice: price,
              limitPrice: price,
              edgeBps: edge,
              stakeUsd: options.stakeUsd,
              contracts: contractsFor(options.stakeUsd, price),
              marketTicker: row.kalshi.marketTicker,
              polyMarketId: null,
              outcomeName: null,
              reasons: [`taker:kalshi`, `price:${price}`, `fair:${fair}`],
            });
            continue;
          }
          const ask = kalshiBestAsk(row);
          if (ask === null) {
            reject("no_kalshi_book_for_maker");
            continue;
          }
          const limit = clampPrice(
            Math.min(fair - options.makerMarginBps / 10_000, ask - TICK),
          );
          const edge = edgeBpsOf(fair, limit);
          if (edge < options.minEdgeBps) {
            reject(edge <= 0 ? "venue_price_worse" : "edge_below_min");
            continue;
          }
          opportunities.push({
            id: `${row.betKey}:kalshi:maker`,
            betKey: row.betKey,
            eventLabel: row.eventLabel,
            league: row.league,
            marketType: row.marketType,
            line: row.line,
            side: row.side,
            venue,
            style,
            fairProb: fair,
            venuePrice: limit,
            limitPrice: limit,
            edgeBps: edge,
            stakeUsd: options.stakeUsd,
            contracts: contractsFor(options.stakeUsd, limit),
            marketTicker: row.kalshi.marketTicker,
            polyMarketId: null,
            outcomeName: null,
            reasons: [`maker:kalshi`, `limit:${limit}`, `fair:${fair}`],
          });
          continue;
        }

        if (!row.polymarket.available) {
          reject(
            `polymarket_unavailable:${row.polymarket.reason ?? "unavailable"}`,
          );
          continue;
        }
        const outcome = selectPolymarketOutcome(row);
        if (outcome === null) {
          reject("polymarket_side_mapping_unavailable");
          continue;
        }
        if (style === "taker") {
          const price = outcome.bestAsk ?? outcome.bestBid;
          if (price === null) {
            reject("no_polymarket_price");
            continue;
          }
          const edge = edgeBpsOf(fair, price);
          if (edge < options.minEdgeBps) {
            reject(edge <= 0 ? "venue_price_worse" : "edge_below_min");
            continue;
          }
          opportunities.push({
            id: `${row.betKey}:polymarket:taker`,
            betKey: row.betKey,
            eventLabel: row.eventLabel,
            league: row.league,
            marketType: row.marketType,
            line: row.line,
            side: row.side,
            venue,
            style,
            fairProb: fair,
            venuePrice: price,
            limitPrice: price,
            edgeBps: edge,
            stakeUsd: options.stakeUsd,
            contracts: contractsFor(options.stakeUsd, price),
            marketTicker: null,
            polyMarketId: row.polymarket.marketId,
            outcomeName: outcome.name,
            reasons: [`taker:polymarket`, `price:${price}`, `fair:${fair}`],
          });
          continue;
        }
        const ask = outcome.bestAsk;
        if (ask === null) {
          reject("no_polymarket_ask_for_maker");
          continue;
        }
        const limit = clampPrice(
          Math.min(fair - options.makerMarginBps / 10_000, ask - TICK),
        );
        const edge = edgeBpsOf(fair, limit);
        if (edge < options.minEdgeBps) {
          reject(edge <= 0 ? "venue_price_worse" : "edge_below_min");
          continue;
        }
        opportunities.push({
          id: `${row.betKey}:polymarket:maker`,
          betKey: row.betKey,
          eventLabel: row.eventLabel,
          league: row.league,
          marketType: row.marketType,
          line: row.line,
          side: row.side,
          venue,
          style,
          fairProb: fair,
          venuePrice: limit,
          limitPrice: limit,
          edgeBps: edge,
          stakeUsd: options.stakeUsd,
          contracts: contractsFor(options.stakeUsd, limit),
          marketTicker: null,
          polyMarketId: row.polymarket.marketId,
          outcomeName: outcome.name,
          reasons: [`maker:polymarket`, `limit:${limit}`, `fair:${fair}`],
        });
      }
    }
  }

  return { opportunities, rejections };
}
