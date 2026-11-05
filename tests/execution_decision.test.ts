import { describe, expect, test } from "bun:test";
import {
  DUPLICATE_WINDOW_MS,
  LIVE_CONFIRM_PHRASE,
  decideExecution,
  marketKeyFor,
  policyFromEnv,
  roundTick,
  tierForPolicy,
  walkBook,
  type ExecutionDecision,
  type ExecutionPolicy,
  type ExecutionRiskState,
  type VenueReadiness,
} from "../lib/execution_decision.ts";
import { parseKalshiOrderbook } from "../lib/kalshi_client.ts";
import type { KalshiJoin } from "../lib/kalshi_signal_join.ts";
import type { WatchlistSignal } from "../lib/watchlist_signal_engine.ts";
import type { PolymarketQuote } from "../lib/polymarket_quote.ts";
import { readKalshiFixture } from "./fixtures/kalshi/fixture_fetch.ts";

/**
 * Decision rules, offline and deterministic: policy env, risk gates, sizing caps, taker/maker
 * choice, tick rounding and the live gate. The books are the captured Kalshi fixtures.
 */

const NOW = new Date("2026-11-04T12:00:00.000Z");
const BOOK = parseKalshiOrderbook(
  readKalshiFixture("orderbook-kxnbagame-atl.json"),
);
if (BOOK === null) throw new Error("orderbook fixture did not parse");

const READY: VenueReadiness = {
  kalshi: { liveReady: true, reason: null },
  polymarket: { liveReady: false, reason: "no signer" },
};
const UNREADY: VenueReadiness = {
  kalshi: { liveReady: false, reason: "api_key_id_missing" },
  polymarket: { liveReady: false, reason: "no signer" },
};

function policy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return { ...policyFromEnv({}), ...overrides };
}

function signal(overrides: Partial<WatchlistSignal> = {}): WatchlistSignal {
  return {
    id: "NBA-ATL_WSH-moneyline-noline-ATL",
    league: "NBA",
    marketKind: "moneyline",
    teams: ["ATL", "WSH"],
    sideTeam: "ATL",
    line: null,
    overUnder: null,
    accounts: [],
    distinctAccounts: 2,
    riskUsd: 1_000,
    oneSidedShare: 1,
    fairProb: 0.62,
    confidence: 60,
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

function join(overrides: Partial<KalshiJoin> = {}): KalshiJoin {
  return {
    seriesTicker: "KXNBAGAME",
    eventTicker: "KXNBAGAME-26NOV04ATLWAS",
    marketTicker: "KXNBAGAME-26NOV04ATLWAS-ATL",
    marketTitle: "Atlanta wins",
    side: "YES",
    fairProb: 0.62,
    executablePrice: 0.56,
    edgeBps: 600,
    liquidity: null,
    liquidityVerdict: null,
    book: BOOK,
    verdict: "actionable",
    reason: null,
    ...overrides,
  };
}

function risk(overrides: Partial<ExecutionRiskState> = {}): ExecutionRiskState {
  return {
    dailyPlannedUsd: 0,
    openIntents: 0,
    marketExposureUsd: {},
    recentIntents: [],
    ...overrides,
  };
}

function decide(
  overrides: {
    signal?: Partial<WatchlistSignal>;
    join?: Partial<KalshiJoin>;
    polymarket?: PolymarketQuote | null;
    policy?: Partial<ExecutionPolicy>;
    risk?: Partial<ExecutionRiskState>;
    venues?: VenueReadiness;
    liveConfirm?: string | null;
    stylePreference?: "auto" | "taker" | "maker";
  } = {},
): ExecutionDecision {
  return decideExecution({
    signal: signal(overrides.signal),
    join: join(overrides.join),
    polymarket: overrides.polymarket ?? null,
    policy: policy(overrides.policy),
    risk: risk(overrides.risk),
    venues: overrides.venues ?? UNREADY,
    now: NOW,
    ...(overrides.liveConfirm === undefined
      ? {}
      : { liveConfirm: overrides.liveConfirm }),
    ...(overrides.stylePreference === undefined
      ? {}
      : { stylePreference: overrides.stylePreference }),
  });
}

describe("policy from env", () => {
  test("contract defaults when env is empty", () => {
    const parsed = policyFromEnv({});
    expect(parsed.mode).toBe("paper");
    expect(parsed.liveEnabled).toBe(false);
    expect(parsed.hedgeRatio).toBe(0.5);
    expect(parsed.maxOrderUsd).toBe(250);
    expect(parsed.maxMarketUsd).toBe(1_500);
    expect(parsed.maxDailyPlannedUsd).toBe(5_000);
    expect(parsed.maxOpenIntents).toBe(25);
    expect(parsed.minEdgeBps).toBe(300);
    expect(parsed.maxSlippageBps).toBe(200);
    expect(parsed.makerMarginBps).toBe(150);
    expect(parsed.allowMakerLive).toBe(false);
  });

  test("env overrides and per-sport tiers; invalid values keep defaults", () => {
    const parsed = policyFromEnv({
      EXECUTION_MODE: "paused",
      EXECUTION_LIVE: "1",
      EXECUTION_HEDGE_RATIO: "0.25",
      EXECUTION_SPORT_CFB_MIN_EDGE_BPS: "900",
      EXECUTION_SPORT_CFB_MAX_SLIPPAGE_BPS: "50",
      EXECUTION_SPORT_CFB_MAX_ORDER_USD: "75",
      EXECUTION_MAX_ORDER_USD: "banana",
    });
    expect(parsed.mode).toBe("paused");
    expect(parsed.liveEnabled).toBe(true);
    expect(parsed.hedgeRatio).toBe(0.25);
    expect(parsed.maxOrderUsd).toBe(250);
    expect(tierForPolicy(parsed, "CFB")).toEqual({
      minEdgeBps: 900,
      maxSlippageBps: 50,
      maxOrderUsd: 75,
    });
    expect(tierForPolicy(parsed, "NBA")).toEqual({
      minEdgeBps: 300,
      maxSlippageBps: 150,
      maxOrderUsd: 300,
    });
    expect(tierForPolicy(parsed, "UNKNOWN")).toEqual({
      minEdgeBps: 500,
      maxSlippageBps: 300,
      maxOrderUsd: 150,
    });
  });
});

describe("book walk and tick rounding", () => {
  test("walks asks cheap-to-expensive and reports average", () => {
    const walk = walkBook(
      [
        { price: 0.5, size: 100 },
        { price: 0.6, size: 100 },
      ],
      80,
    );
    expect(walk.contracts).toBeCloseTo(150, 5);
    expect(walk.avgPrice).toBeCloseTo(0.5333, 4);
    expect(walk.depthContracts).toBe(200);
  });

  test("one tick is one cent", () => {
    expect(roundTick(0.5612)).toBe(0.56);
    expect(roundTick(0.565)).toBe(0.57);
  });
});

describe("risk gates", () => {
  test("paused blocks every decision", () => {
    const decision = decide({ policy: { mode: "paused" } });
    expect(decision.blocked).toBe(true);
    expect(decision.blockReason).toBe("paused");
    expect(decision.sizeUsd).toBe(0);
  });

  test("kill switch blocks", () => {
    const decision = decide({ risk: { killSwitch: true } });
    expect(decision.blocked).toBe(true);
    expect(decision.blockReason).toBe("kill_switch");
  });

  test("open intents, market cap and daily cap block", () => {
    expect(decide({ risk: { openIntents: 25 } }).blockReason).toBe(
      "max_open_intents",
    );
    const marketKey = marketKeyFor(signal());
    expect(
      decide({ risk: { marketExposureUsd: { [marketKey]: 1_500 } } })
        .blockReason,
    ).toBe("market_cap");
    expect(decide({ risk: { dailyPlannedUsd: 5_000 } }).blockReason).toBe(
      "daily_cap",
    );
  });

  test("duplicate market+side within the window blocks", () => {
    const marketKey = marketKeyFor(signal());
    const decision = decide({
      risk: {
        recentIntents: [
          {
            marketKey,
            side: "YES",
            atIso: new Date(NOW.getTime() - 60_000).toISOString(),
          },
        ],
      },
    });
    expect(decision.blockReason).toBe("duplicate_recent");
    const old = decide({
      risk: {
        recentIntents: [
          {
            marketKey,
            side: "YES",
            atIso: new Date(
              NOW.getTime() - DUPLICATE_WINDOW_MS - 1,
            ).toISOString(),
          },
        ],
      },
    });
    expect(old.blockReason).not.toBe("duplicate_recent");
  });
});

describe("sizing and taker choice", () => {
  test("base size is risk × hedge ratio, capped by maxOrder", () => {
    const decision = decide({
      signal: { riskUsd: 10_000, fairProb: 0.62 },
      policy: { hedgeRatio: 0.5, maxOrderUsd: 250 },
    });
    expect(decision.blocked).toBe(false);
    expect(decision.style).toBe("taker");
    expect(decision.sizeUsd).toBeLessThanOrEqual(300); // NBA tier maxOrder 300
    expect(decision.contracts).toBeGreaterThan(0);
  });

  test("fixture provenance forces paper even with a live-confirmed run", () => {
    const decision = decide({
      signal: {
        fairProb: 0.62,
        provenance: { ...signal().provenance, fixture: true },
      },
      venues: READY,
      policy: { liveEnabled: true },
      liveConfirm: LIVE_CONFIRM_PHRASE,
    });
    expect(decision.blocked).toBe(false);
    expect(decision.paper).toBe(true);
    expect(decision.reasons).toContain("fixture_source:paper_forced");
  });

  test("live gate: paper unless env+adapter+confirm all line up", () => {
    const notReady = decide({ venues: UNREADY });
    expect(notReady.paper).toBe(true);
    expect(notReady.reasons).toContain("paper:live_not_armed");

    const noConfirm = decide({ venues: READY, policy: { liveEnabled: true } });
    expect(noConfirm.paper).toBe(true);

    const live = decide({
      venues: READY,
      policy: { liveEnabled: true },
      liveConfirm: LIVE_CONFIRM_PHRASE,
    });
    expect(live.paper).toBe(false);
    expect(live.venue).toBe("kalshi");
    expect(live.blocked).toBe(false);
  });

  test("slippage over the sport tier falls back to a maker quote", () => {
    // A book with a wide 20c spread and no cheap ask: taker edge/slippage fail.
    const decision = decide({
      join: {
        book: {
          yes: [{ price: 0.6, size: 100 }],
          no: [{ price: 0.5, size: 100 }],
        },
      },
      signal: { fairProb: 0.62 },
    });
    // Yes ask = 1 − 0.5 = 0.50, mid = (0.60 + 0.50)/2 = 0.55 → 9% slippage > tier.
    expect(decision.blocked).toBe(false);
    expect(decision.style).toBe("maker");
    expect(decision.limitPrice).not.toBeNull();
    expect(decision.limitPrice ?? 1).toBeLessThan(decision.fairProb ?? 0);
    expect(decision.paper).toBe(true);
  });

  test("operator can prefer maker even when a taker fill would qualify", () => {
    const maker = decide({ stylePreference: "maker" });
    expect(maker.blocked).toBe(false);
    expect(maker.style).toBe("maker");
    expect(maker.reasons).toContain("style:maker_preferred");
  });

  test("taker-only preference refuses instead of falling back to a maker quote", () => {
    const taker = decide({ stylePreference: "taker" });
    expect(taker.style).toBe("taker");

    // The same wide-spread book that auto-decides to maker must refuse under taker-only.
    const refused = decide({
      stylePreference: "taker",
      join: {
        book: {
          yes: [{ price: 0.6, size: 100 }],
          no: [{ price: 0.5, size: 100 }],
        },
      },
      signal: { fairProb: 0.62 },
    });
    expect(refused.blocked).toBe(true);
    expect(refused.blockReason).toBe("style_taker_no_fill");
  });

  test("no fair price and no book are explicit blocks", () => {
    expect(decide({ signal: { fairProb: null } }).blockReason).toBe(
      "no_fair_price",
    );
    expect(
      decide({ join: { book: null, side: null, marketTicker: null } })
        .blockReason,
    ).toBe("no_book");
  });
});

describe("polymarket venue choice is pure from the quote", () => {
  const quote: PolymarketQuote = {
    available: true,
    source: "gamma+clob",
    marketId: "m1",
    question: "Atlanta Hawks vs. Washington Wizards",
    slug: "atl-wsh",
    outcomes: [
      {
        name: "Atlanta Hawks",
        tokenId: "yes-token",
        bids: [{ price: 0.5, size: 200 }],
        asks: [{ price: 0.52, size: 200 }],
        bestBid: 0.5,
        bestAsk: 0.52,
      },
      {
        name: "Washington Wizards",
        tokenId: "no-token",
        bids: [{ price: 0.46, size: 200 }],
        asks: [{ price: 0.48, size: 200 }],
        bestBid: 0.46,
        bestAsk: 0.48,
      },
    ],
    queriedAtIso: "2026-11-04T12:00:00.000Z",
    telemetry: {
      ok: true,
      degraded: false,
      requests: 3,
      cacheHits: 0,
      cacheTtlSec: 60,
      errors: [],
    },
  };

  test("sideTeam maps to the team's outcome token", () => {
    const decision = decide({
      polymarket: quote,
      join: { book: null, side: null, marketTicker: null, reason: "no kalshi" },
    });
    expect(decision.venue).toBe("polymarket");
    expect(decision.position).toBe("yes");
    expect(decision.tickerToken).toBe("yes-token");
    expect(decision.paper).toBe(true);
  });
});
