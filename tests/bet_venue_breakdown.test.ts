import { describe, expect, test } from "bun:test";

import { widenTickerRow } from "../lib/bet_flags.ts";
import {
  betToVenueSignal,
  buildBetVenueBreakdown,
  classifySettlementRule,
  compareSettlementRules,
  dimensionValue,
  groupBetVenueBreakdowns,
  looksLikeGameMarket,
  marketLabelOf,
  splitEventTeams,
  summarizeBetVenueBreakdowns,
} from "../lib/bet_venue_breakdown.ts";
import { comboProfile } from "../lib/market_type_registry.ts";
import type { JoinedSignal } from "../lib/kalshi_signal_join.ts";
import type {
  PolymarketOutcome,
  PolymarketQuote,
} from "../lib/polymarket_quote.ts";
import type { WatchlistSignal } from "../lib/watchlist_signal_engine.ts";

/**
 * Offline proof of the cross-venue breakdown: mapping a parsed bet into the venue signal shape
 * and assembling Kalshi/Polymarket views from injected readers. No network, no credentials; the
 * live readers are the same production join/quote code exercised by their own suites.
 */

const NOW = new Date("2026-11-05T05:00:00Z");

function wire(shortDesc: string, wagerType = "L", wagerNumber = 1) {
  return {
    Login: "ABC",
    WagerNumber: wagerNumber,
    AgentID: "AGT",
    AgentLogin: "AGT",
    TicketWriter: "GSLIVE",
    WagerType: wagerType,
    AmountWagered: 100,
    ToWinAmount: 90,
    InsertDateTime: "2026-11-01 17:15:02.770",
    ShortDesc: shortDesc,
    VIP: "0",
  };
}

function record(shortDesc: string, wagerType = "L", wagerNumber = 1) {
  const widened = widenTickerRow(wire(shortDesc, wagerType, wagerNumber), {
    observedAt: "2026-11-05T05:00:00Z",
  });
  if (widened === null) throw new Error("fixture row did not widen");
  return widened;
}

const TOTAL_2H = record(
  "L.Basketball #511 Cavaliers/Thunder O 115½ -110 - For 2nd Half",
  "L",
  1,
);
const SPREAD_GAME = record(
  "M.G320197818\r\nFootball - Massachusetts vs Ball State / Game / Point spread / Massachusetts -4.5 +146",
  "L",
  2,
);
const SINGLE_TEAM = record("S.Basketball #520 Suns +3 -110 - For Game", "L", 3);

describe("splitEventTeams", () => {
  test("splits the event labels the wire carries", () => {
    expect(splitEventTeams("Cavaliers/Thunder")).toEqual([
      "Cavaliers",
      "Thunder",
    ]);
    expect(splitEventTeams("Massachusetts vs Ball State")).toEqual([
      "Massachusetts",
      "Ball State",
    ]);
    expect(splitEventTeams("Suns")).toEqual([]);
  });
});

describe("betToVenueSignal", () => {
  test("maps a total with period and infers the league with a note", () => {
    const mapping = betToVenueSignal(TOTAL_2H, { now: NOW });
    expect(mapping.refusal).toBeNull();
    expect(mapping.league).toBe("NBA");
    expect(mapping.marketKind).toBe("2h_total");
    expect(mapping.teams).toEqual(["Cavaliers", "Thunder"]);
    expect(mapping.notes.join(" ")).toContain("league inferred from sport");
    expect(mapping.signal?.overUnder).toBe("over");
    expect(mapping.signal?.line).toBe(115.5);
    expect(mapping.signal?.fairProb).toBeGreaterThan(0);
  });

  test("an explicit --league overrides the inference", () => {
    const mapping = betToVenueSignal(SPREAD_GAME, {
      now: NOW,
      leagueOverride: "CFB",
    });
    expect(mapping.league).toBe("CFB");
    expect(mapping.signal?.sideTeam).toBe("Massachusetts");
    expect(mapping.notes.join(" ")).toContain("league supplied by operator");
  });

  test("a compact single-team row is an explicit refusal, not a guessed matchup", () => {
    const mapping = betToVenueSignal(SINGLE_TEAM, { now: NOW });
    expect(mapping.signal).toBeNull();
    expect(mapping.refusal).toContain("need two teams");
  });

  test("a multi-leg ticket is a combo, not a single venue market", () => {
    const parlay = record(
      "P.Basketball #1 Cavaliers/Thunder -110 - For Game Basketball #2 Lakers -4.5 -110 - For Game",
      "P",
      11,
    );
    const mapping = betToVenueSignal(parlay, { now: NOW });
    expect(mapping.signal).toBeNull();
    expect(mapping.combo.isCombo).toBe(true);
    expect(mapping.refusal).toContain("combo ticket");
    expect(mapping.refusal).toContain("venue joins are single-market");
  });

  test("hockey 2nd-period total maps to the 2p period key", () => {
    const hockey = record(
      "L.Hockey #33 Kings/Sharks O 3.5 -110 - For 2nd Period",
      "L",
      9,
    );
    const mapping = betToVenueSignal(hockey, { now: NOW });
    expect(mapping.league).toBe("NHL");
    expect(mapping.marketKind).toBe("2p_total");
    expect(mapping.signal?.line).toBe(3.5);
    expect(mapping.refusal).toBeNull();
  });

  test("a side naming exactly one team becomes sideTeam; an ambiguous side stays null", () => {
    const single = record(
      "M.Basketball - Miami Heat vs Golden State Warriors / Game / Winner (2 way) / Miami Heat -110",
      "M",
      6,
    );
    expect(betToVenueSignal(single, { now: NOW }).signal?.sideTeam).toBe(
      "Miami Heat",
    );

    const ambiguous = record(
      "S.Basketball #520 Miami/Golden State -110 - For Game",
      "M",
      7,
    );
    const mapping = betToVenueSignal(ambiguous, { now: NOW });
    expect(mapping.signal?.sideTeam).toBeNull();
  });

  test("season/futures questions are not treated as the game market", () => {
    expect(
      looksLikeGameMarket(
        "Will Miami Heat vs Golden State Warriors be the 2027 NBA Finals matchup?",
      ),
    ).toBe(false);
    expect(looksLikeGameMarket("Cavaliers vs. Thunder")).toBe(true);
    expect(
      looksLikeGameMarket("Will the Lakers win the 2027 NBA Championship?"),
    ).toBe(false);
  });

  test("stale provenance is carried into the venue signal", () => {
    const mapping = betToVenueSignal(TOTAL_2H, { now: NOW });
    // acceptedAt is 2026-11-01, days before NOW.
    expect(mapping.signal?.provenance.stale).toBe(true);
    expect(mapping.signal?.provenance.fixture).toBe(false);
  });
});

function joinedFor(
  signal: WatchlistSignal,
  verdict: "actionable" | "no_market" = "actionable",
  rulesPrimary?: string,
): JoinedSignal {
  return {
    ...signal,
    kalshi: {
      seriesTicker: "KXNBATOTAL",
      eventTicker: verdict === "no_market" ? null : "KXNBA-26NOV05CLEOKC",
      marketTicker:
        verdict === "no_market" ? null : "KXNBATOTAL-26NOV05CLEOKC-230",
      marketTitle:
        verdict === "no_market" ? null : "Cavaliers at Thunder total",
      side: verdict === "no_market" ? null : "YES",
      fairProb: signal.fairProb,
      executablePrice: verdict === "no_market" ? null : 0.53,
      edgeBps: verdict === "no_market" ? null : 290,
      liquidity:
        verdict === "no_market"
          ? null
          : {
              topSize: 400,
              spreadCents: 2,
              depthContracts: 900,
              vwap: 0.533,
              executablePrice: 0.53,
              priceImpactCents: 1,
              verdict: "ok",
              referenceNotionalUsd: 1000,
            },
      liquidityVerdict: verdict === "no_market" ? null : "ok",
      book:
        verdict === "no_market"
          ? null
          : {
              yes: [
                { price: 0.53, size: 400 },
                { price: 0.52, size: 500 },
              ],
              no: [{ price: 0.47, size: 300 }],
            },
      verdict,
      reason: verdict === "no_market" ? "no event for the series" : null,
      ...(rulesPrimary === undefined ? {} : { rulesPrimary }),
    },
  };
}

const OUTCOMES: readonly PolymarketOutcome[] = [
  {
    name: "Cavaliers",
    tokenId: "token-cavs",
    bids: [{ price: 0.55, size: 200 }],
    asks: [{ price: 0.57, size: 100 }],
    bestBid: 0.55,
    bestAsk: 0.57,
  },
  {
    name: "Thunder",
    tokenId: "token-okc",
    bids: [{ price: 0.43, size: 120 }],
    asks: [{ price: 0.45, size: 80 }],
    bestBid: 0.43,
    bestAsk: 0.45,
  },
];

const QUOTE: PolymarketQuote = {
  available: true,
  source: "gamma+clob",
  marketId: "poly-game",
  question: "Cavaliers vs. Thunder",
  slug: "nba-cle-okc",
  outcomes: OUTCOMES,
  queriedAtIso: "2026-11-05T05:00:00.000Z",
  telemetry: {
    ok: true,
    degraded: false,
    requests: 0,
    cacheHits: 0,
    cacheTtlSec: 60,
    errors: [],
  },
};

describe("buildBetVenueBreakdown", () => {
  test("assembles Kalshi price/depth and Polymarket outcome books", async () => {
    const records = [TOTAL_2H, SPREAD_GAME];
    const result = await buildBetVenueBreakdown(records, {
      now: NOW,
      maxBets: 5,
      seams: {
        joinKalshi: async (signals) =>
          signals.map((signal) =>
            joinedFor(
              signal,
              signal.id === SPREAD_GAME.betKey ? "no_market" : "actionable",
            ),
          ),
        quotePolymarket: async () => QUOTE,
      },
    });
    expect(result.refusals).toEqual([]);
    expect(result.breakdowns).toHaveLength(2);

    const total = result.breakdowns[0]!;
    expect(total.kalshi.available).toBe(true);
    expect(total.kalshi.marketTicker).toBe("KXNBATOTAL-26NOV05CLEOKC-230");
    expect(total.kalshi.price).toBe(0.53);
    expect(total.kalshi.liquidity).toMatchObject({
      verdict: "ok",
      spreadCents: 2,
      depthContracts: 900,
    });
    expect(total.kalshi.book?.yes[0]).toEqual({ price: 0.53, size: 400 });

    expect(total.polymarket.available).toBe(false);
    expect(total.polymarket.reason).toContain("game-winner markets only");

    const spread = result.breakdowns[1]!;
    expect(spread.kalshi.available).toBe(false);
    expect(spread.kalshi.reason).toContain("no event");
    expect(spread.notes.join(" ")).toContain("league inferred");
  });

  test("an unmappable bet produces a row plus a refusal", async () => {
    const result = await buildBetVenueBreakdown([SINGLE_TEAM], {
      now: NOW,
      seams: {
        joinKalshi: async () => [],
        quotePolymarket: async () => QUOTE,
      },
    });
    expect(result.breakdowns).toHaveLength(1);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.reason).toContain("need two teams");
    expect(result.breakdowns[0]?.kalshi.available).toBe(false);
    expect(result.breakdowns[0]?.polymarket.available).toBe(false);
  });

  test("a moneyline bet gets the Polymarket game-winner books", async () => {
    const moneyline = record(
      "S.Basketball #520 Cavaliers/Thunder -110 - For Game",
      "M",
      4,
    );
    const result = await buildBetVenueBreakdown([moneyline], {
      now: NOW,
      seams: {
        joinKalshi: async (signals) => signals.map((s) => joinedFor(s)),
        quotePolymarket: async () => QUOTE,
      },
    });
    const row = result.breakdowns[0]!;
    expect(row.polymarket.available).toBe(true);
    expect(row.polymarket.question).toBe("Cavaliers vs. Thunder");
    expect(row.polymarket.outcomes[0]).toMatchObject({
      name: "Cavaliers",
      bestBid: 0.55,
      bestAsk: 0.57,
      askDepthUsd: 57,
    });
    expect(row.polymarket.outcomes[0]?.spread).toBeCloseTo(0.02, 9);
  });

  test("venue selection and maxBets bound the work", async () => {
    let calls = 0;
    const result = await buildBetVenueBreakdown([TOTAL_2H, SPREAD_GAME], {
      now: NOW,
      maxBets: 1,
      venues: ["kalshi"],
      seams: {
        joinKalshi: async (signals) => {
          calls += 1;
          return signals.map((signal) => joinedFor(signal));
        },
        quotePolymarket: async () => {
          throw new Error(
            "polymarket must not be called when it is not requested",
          );
        },
      },
    });
    expect(calls).toBe(1);
    expect(result.breakdowns).toHaveLength(1);
    expect(result.breakdowns[0]?.polymarket.reason).toContain("not requested");
  });

  test("a futures quote for the same teams is refused, not shown as the game price", async () => {
    const moneyline = record(
      "M.Basketball - Miami Heat vs Golden State Warriors / Game / Winner (2 way) / Miami Heat -110",
      "M",
      8,
    );
    const futuresQuote: PolymarketQuote = {
      ...QUOTE,
      question:
        "Will Miami Heat vs Golden State Warriors be the 2027 NBA Finals matchup?",
    };
    const result = await buildBetVenueBreakdown([moneyline], {
      now: NOW,
      seams: {
        joinKalshi: async (signals) => signals.map((s) => joinedFor(s)),
        quotePolymarket: async () => futuresQuote,
      },
    });
    const poly = result.breakdowns[0]!.polymarket;
    expect(poly.available).toBe(false);
    expect(poly.reason).toContain("season/futures market");
  });

  test("a moneyline bet is the only market asked of Polymarket", async () => {
    const moneyline = record(
      "S.Basketball #520 Cavaliers/Thunder -110 - For Game",
      "M",
      4,
    );
    const asked: (readonly string[])[] = [];
    await buildBetVenueBreakdown([moneyline], {
      now: NOW,
      seams: {
        joinKalshi: async (signals) => signals.map((s) => joinedFor(s)),
        quotePolymarket: async (teams) => {
          asked.push(teams);
          return QUOTE;
        },
      },
    });
    expect(asked).toEqual([["Cavaliers", "Thunder"]]);
  });
});

describe("dimension grouping", () => {
  async function rows() {
    const result = await buildBetVenueBreakdown([TOTAL_2H, SPREAD_GAME], {
      now: NOW,
      seams: {
        joinKalshi: async (signals) =>
          signals.map((signal) => joinedFor(signal, "actionable")),
        quotePolymarket: async () => QUOTE,
      },
    });
    return result.breakdowns;
  }

  test("market labels combine kind, line and period", async () => {
    const [total] = await rows();
    expect(marketLabelOf(total!)).toBe("total 115.5 · 2nd Half");
  });

  test("unknown wire fields read unknown, never empty", () => {
    const row = {
      ...breakdown0(),
      sport: "",
      subSport: "",
      periodLabel: "",
      period: "",
      league: "UNKNOWN" as const,
      marketType: "",
    };
    expect(dimensionValue(row, "sport")).toBe("unknown");
    expect(dimensionValue(row, "subsport")).toBe("unknown");
    expect(dimensionValue(row, "period")).toBe("unknown");
    expect(dimensionValue(row, "league")).toBe("unknown");
    expect(dimensionValue(row, "markettype")).toBe("unknown");
  });

  test("flat summary reconciles with the rows and averages priced books", async () => {
    const list = await rows();
    const groups = summarizeBetVenueBreakdowns(list, ["sport", "market"]);
    const sportGroups = groups.filter((group) => group.dimension === "sport");
    expect(sportGroups.reduce((sum, group) => sum + group.bets, 0)).toBe(
      list.length,
    );
    for (const group of sportGroups) {
      expect(group.kalshiMatched).toBe(group.bets);
      expect(group.avgKalshiPrice).toBe(0.53);
      expect(group.avgKalshiSpreadCents).toBe(2);
      expect(group.totalKalshiDepthContracts).toBe(group.bets * 900);
    }
    expect(groups.filter((group) => group.dimension === "market")).toHaveLength(
      2,
    );
  });

  test("nested tree follows the requested dimension order", async () => {
    const list = await rows();
    const tree = groupBetVenueBreakdowns(list, [
      "sport",
      "subsport",
      "period",
      "market",
    ]);
    expect(tree).toHaveLength(2); // Basketball + Football
    expect(tree[0]?.dimension).toBe("sport");
    expect(tree[0]?.value).toBe("Basketball");
    expect(tree[0]?.children[0]?.dimension).toBe("subsport");
    expect(tree[0]?.children[0]?.children[0]?.dimension).toBe("period");
    expect(tree[0]?.children[0]?.children[0]?.children[0]?.dimension).toBe(
      "market",
    );
  });
});

function breakdown0() {
  return {
    betKey: "k",
    eventLabel: "A/B",
    teams: ["A", "B"],
    league: "NBA" as const,
    sport: "Basketball",
    subSport: "PREGAME",
    period: "2nd Half",
    marketType: "total",
    periodLabel: "2nd Half",
    line: 115.5,
    side: "over",
    stakeUsd: 100,
    signalProbability: 0.524,
    americanOdds: -110,
    notes: [],
    kalshi: {
      available: false,
      verdict: "no_market",
      reason: null,
      seriesTicker: null,
      eventTicker: null,
      marketTicker: null,
      title: null,
      side: null,
      price: null,
      edgeBps: null,
      liquidity: null,
      book: null,
      rule: null,
    },
    polymarket: {
      available: false,
      reason: null,
      marketId: null,
      question: null,
      slug: null,
      outcomes: [],
      rule: null,
    },
    settlement: compareSettlementRules(null, null),
    combo: comboProfile({ wagerType: "S", picks: 1 }),
  };
}

describe("settlement rule comparison", () => {
  test("classifies the flags that differ between venues", () => {
    expect(
      classifySettlementRule(
        "Resolves on the final score including overtime and shootouts.",
      ),
    ).toEqual({
      overtime: true,
      shootout: true,
      extraInnings: false,
      extraTime: false,
    });
    expect(classifySettlementRule("Winner of the game.")).toEqual({
      overtime: false,
      shootout: false,
      extraInnings: false,
      extraTime: false,
    });
  });

  test("both rules present: equal flags match, differing flags mismatch", () => {
    const same = compareSettlementRules(
      "Includes overtime and shootout.",
      "Resolves after overtime and shootout.",
    );
    expect(same.verdict).toBe("match");

    const differs = compareSettlementRules(
      "If Boston wins the game (regulation only).",
      "Resolves on the final score including overtime and shootouts.",
    );
    expect(differs.verdict).toBe("mismatch");
    expect(differs.note).toContain("overtime");
    expect(differs.note).toContain("shootout");
  });

  test("a missing rule is unknown, never silently equivalent", () => {
    expect(compareSettlementRules(null, "Includes overtime.").verdict).toBe(
      "unknown",
    );
    expect(compareSettlementRules("Includes overtime.", null).verdict).toBe(
      "unknown",
    );
    expect(compareSettlementRules(null, null).verdict).toBe("unknown");
  });

  test("the breakdown carries the rule text and the comparison", async () => {
    const moneyline = record(
      "S.Basketball #520 Cavaliers/Thunder -110 - For Game",
      "M",
      10,
    );
    const result = await buildBetVenueBreakdown([moneyline], {
      now: NOW,
      seams: {
        joinKalshi: async (signals) =>
          signals.map((signal) =>
            joinedFor(
              signal,
              "actionable",
              "If Boston wins the game including overtime and shootout.",
            ),
          ),
        quotePolymarket: async () => ({
          ...QUOTE,
          description:
            "Resolves on the final score including overtime and shootout.",
        }),
      },
    });
    const row = result.breakdowns[0]!;
    expect(row.kalshi.rule).toContain("overtime");
    expect(row.polymarket.rule).toContain("overtime");
    expect(row.settlement.verdict).toBe("match");
  });
});
