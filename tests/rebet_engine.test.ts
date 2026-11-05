import { describe, expect, test } from "bun:test";

import type { BetVenueBreakdown } from "../lib/bet_venue_breakdown.ts";
import { compareSettlementRules } from "../lib/bet_venue_breakdown.ts";
import { comboProfile } from "../lib/market_type_registry.ts";
import { evaluateRebet } from "../lib/rebet_engine.ts";

function row(
  overrides: {
    kalshi?: Partial<BetVenueBreakdown["kalshi"]>;
    polymarket?: Partial<BetVenueBreakdown["polymarket"]>;
    signalProbability?: number | null;
    combo?: boolean;
    side?: string | null;
    marketType?: string;
  } = {},
): BetVenueBreakdown {
  return {
    betKey: "bet-1",
    eventLabel: "Cavaliers/Thunder",
    teams: ["Cavaliers", "Thunder"],
    league: "NBA",
    sport: "Basketball",
    subSport: "Winner (2 way)",
    period: "Game",
    marketType: overrides.marketType ?? "moneyline",
    periodLabel: "Game",
    line: null,
    side: overrides.side ?? "Cavaliers",
    stakeUsd: 100,
    signalProbability:
      overrides.signalProbability === undefined
        ? 0.524
        : overrides.signalProbability,
    americanOdds: -110,
    notes: [],
    kalshi: {
      available: true,
      verdict: "actionable",
      reason: null,
      seriesTicker: "KXNBAGAME",
      eventTicker: "KXNBA-1",
      marketTicker: "KXNBAGAME-1-CLE",
      title: "Cavaliers win",
      side: "YES",
      price: 0.45,
      edgeBps: 740,
      liquidity: null,
      book: {
        yes: [{ price: 0.45, size: 100 }],
        no: [{ price: 0.47, size: 100 }],
      },
      rule: null,
      ...overrides.kalshi,
    },
    polymarket: {
      available: true,
      reason: null,
      marketId: "poly-1",
      question: "Cavaliers vs. Thunder",
      slug: "nba-cle-okc",
      outcomes: [
        {
          name: "Cavaliers",
          bestBid: 0.42,
          bestAsk: 0.44,
          spread: 0.02,
          bidDepthUsd: 10,
          askDepthUsd: 10,
        },
        {
          name: "Thunder",
          bestBid: 0.54,
          bestAsk: 0.56,
          spread: 0.02,
          bidDepthUsd: 10,
          askDepthUsd: 10,
        },
      ],
      rule: null,
      ...overrides.polymarket,
    },
    settlement: compareSettlementRules(null, null),
    combo: overrides.combo
      ? comboProfile({
          wagerType: "P",
          description:
            "Basketball - A vs B / Game / Total / Over 1 -110 | Basketball - A vs B / Game / Winner (2 way) / A -110",
        })
      : comboProfile({ wagerType: "S", picks: 1 }),
  };
}

const OPTIONS = {
  styles: ["taker", "maker"] as const,
  minEdgeBps: 100,
  makerMarginBps: 150,
  stakeUsd: 100,
};

describe("rebet engine", () => {
  test("taker qualifies only when the venue price is better than the signal", () => {
    const evaluation = evaluateRebet([row()], OPTIONS);
    const kalshiTaker = evaluation.opportunities.find(
      (opportunity) =>
        opportunity.venue === "kalshi" && opportunity.style === "taker",
    );
    expect(kalshiTaker?.edgeBps).toBe(740);
    expect(kalshiTaker?.venuePrice).toBe(0.45);
    expect(kalshiTaker?.contracts).toBe(222);

    const worse = evaluateRebet(
      [
        row({
          kalshi: { price: 0.62 },
        }),
      ],
      OPTIONS,
    );
    expect(
      worse.opportunities.some(
        (opportunity) =>
          opportunity.venue === "kalshi" && opportunity.style === "taker",
      ),
    ).toBe(false);
    expect(
      worse.rejections.some(
        (rejection) =>
          rejection.venue === "kalshi" &&
          rejection.reason === "venue_price_worse",
      ),
    ).toBe(true);
  });

  test("maker rests below the ask and still clears the edge", () => {
    const evaluation = evaluateRebet([row()], {
      ...OPTIONS,
      styles: ["maker"],
    });
    const kalshiMaker = evaluation.opportunities.find(
      (opportunity) => opportunity.venue === "kalshi",
    );
    // fair 0.524 − 0.015 = 0.509; ask 1 − 0.47 = 0.53, so the limit stays below the ask.
    expect(kalshiMaker?.limitPrice).toBeCloseTo(0.51, 6);
    expect(kalshiMaker?.edgeBps).toBeGreaterThanOrEqual(100);
    expect(kalshiMaker?.edgeBps).toBe(140);
  });

  test("Polymarket maker rests below the ask and clears the edge", () => {
    const evaluation = evaluateRebet([row()], {
      ...OPTIONS,
      styles: ["maker"],
    });
    const polyMaker = evaluation.opportunities.find(
      (opportunity) => opportunity.venue === "polymarket",
    );
    // fair − margin would be 0.509, but the ask is 0.44, so the maker limit is ask − tick = 0.43.
    expect(polyMaker?.limitPrice).toBeCloseTo(0.43, 6);
    expect(polyMaker?.outcomeName).toBe("Cavaliers");
    expect(polyMaker?.edgeBps).toBe(940);
  });

  test("Polymarket outcome is matched to the side; Yes/No outcomes are refused", () => {
    const evaluation = evaluateRebet([row()], {
      ...OPTIONS,
      styles: ["taker"],
    });
    const poly = evaluation.opportunities.find(
      (opportunity) => opportunity.venue === "polymarket",
    );
    expect(poly?.outcomeName).toBe("Cavaliers");
    expect(poly?.venuePrice).toBe(0.44);

    const yesNo = evaluateRebet(
      [
        row({
          polymarket: {
            outcomes: [
              {
                name: "Yes",
                bestBid: 0.4,
                bestAsk: 0.42,
                spread: 0.02,
                bidDepthUsd: 1,
                askDepthUsd: 1,
              },
              {
                name: "No",
                bestBid: 0.56,
                bestAsk: 0.58,
                spread: 0.02,
                bidDepthUsd: 1,
                askDepthUsd: 1,
              },
            ],
          },
        }),
      ],
      { ...OPTIONS, styles: ["taker"] },
    );
    expect(
      yesNo.rejections.some(
        (rejection) =>
          rejection.venue === "polymarket" &&
          rejection.reason === "polymarket_side_mapping_unavailable",
      ),
    ).toBe(true);
  });

  test("combos, missing fair price and unavailable venues are explicit rejections", () => {
    const combo = evaluateRebet([row({ combo: true })], OPTIONS);
    expect(combo.opportunities).toHaveLength(0);
    expect(combo.rejections.map((rejection) => rejection.reason)).toContain(
      "combo_ticket_no_single_venue_market",
    );

    const noFair = evaluateRebet([row({ signalProbability: null })], OPTIONS);
    expect(noFair.rejections.map((rejection) => rejection.reason)).toContain(
      "no_signal_probability",
    );

    const unavailable = evaluateRebet(
      [row({ kalshi: { available: false, reason: "no event" } })],
      OPTIONS,
    );
    expect(
      unavailable.rejections.some(
        (rejection) => rejection.reason === "kalshi_unavailable:no event",
      ),
    ).toBe(true);
  });
});
