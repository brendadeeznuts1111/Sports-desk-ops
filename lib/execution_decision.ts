/**
 * The execution decision engine, pure and deterministic.
 *
 * For one watchlist signal it chooses venue (Kalshi/Polymarket), style (taker/maker), position,
 * size and limit, or explains why it will not act. Planning only ever reads public books; the
 * `paper` flag is true unless the caller passes an explicit live confirmation *and* the venue says
 * it is live-ready — and live order placement is not this module's job.
 *
 * Money is handled in USD and probabilities in [0,1]; every emitted number is finite by
 * construction (`null` where a book did not provide one). Ticks are 1¢ on both venues.
 */
import type { KalshiJoin } from "./kalshi_signal_join.ts";
import type { PolymarketQuote, PolymarketOutcome } from "./polymarket_quote.ts";
import {
  teamMatchesQuestion,
  type PolymarketLevel,
} from "./polymarket_quote.ts";
import type { WatchlistSignal } from "./watchlist_signal_engine.ts";

export type ExecutionMode = "paper" | "paused" | "live";
export type ExecutionVenue = "kalshi" | "polymarket";
export type ExecutionStyle = "taker" | "maker";
export type ExecutionPosition = "yes" | "no";

/** One-cent tick on both venues; prices are rounded to it before they leave the engine. */
export const EXECUTION_TICK = 0.01;
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
export const LIVE_CONFIRM_PHRASE = "PLACE LIVE ORDERS";

export interface SportTier {
  readonly minEdgeBps: number;
  readonly maxSlippageBps: number;
  readonly maxOrderUsd: number;
}

/** Contract per-sport tiers; an unknown league falls back to the default tier. */
export const DEFAULT_SPORT_TIERS: Readonly<Record<string, SportTier>> = {
  NBA: { minEdgeBps: 300, maxSlippageBps: 150, maxOrderUsd: 300 },
  NFL: { minEdgeBps: 300, maxSlippageBps: 200, maxOrderUsd: 250 },
  CFB: { minEdgeBps: 500, maxSlippageBps: 300, maxOrderUsd: 150 },
  EPL: { minEdgeBps: 500, maxSlippageBps: 300, maxOrderUsd: 150 },
  NHL: { minEdgeBps: 500, maxSlippageBps: 300, maxOrderUsd: 150 },
  DEFAULT: { minEdgeBps: 500, maxSlippageBps: 300, maxOrderUsd: 150 },
};

export interface ExecutionPolicy {
  readonly mode: ExecutionMode;
  readonly liveEnabled: boolean;
  readonly hedgeRatio: number;
  readonly maxOrderUsd: number;
  readonly maxMarketUsd: number;
  readonly maxDailyPlannedUsd: number;
  readonly maxOpenIntents: number;
  readonly minEdgeBps: number;
  readonly maxSlippageBps: number;
  readonly makerMarginBps: number;
  readonly allowMakerLive: boolean;
  readonly sportTiers: Readonly<Record<string, SportTier>>;
}

function envNumber(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  options: { readonly integer?: boolean } = {},
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return options.integer === true ? Math.trunc(parsed) : parsed;
}

function tierFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  league: string,
  defaults: SportTier,
): SportTier {
  return {
    minEdgeBps: envNumber(
      env,
      `EXECUTION_SPORT_${league}_MIN_EDGE_BPS`,
      defaults.minEdgeBps,
      { integer: true },
    ),
    maxSlippageBps: envNumber(
      env,
      `EXECUTION_SPORT_${league}_MAX_SLIPPAGE_BPS`,
      defaults.maxSlippageBps,
      { integer: true },
    ),
    maxOrderUsd: envNumber(
      env,
      `EXECUTION_SPORT_${league}_MAX_ORDER_USD`,
      defaults.maxOrderUsd,
    ),
  };
}

/** Policy from env with the contract defaults; unknown values keep the default, never 0. */
export function policyFromEnv(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): ExecutionPolicy {
  const modeRaw = (env["EXECUTION_MODE"] ?? "paper").trim().toLowerCase();
  const mode: ExecutionMode =
    modeRaw === "paused" ? "paused" : modeRaw === "live" ? "live" : "paper";
  const sportTiers: Record<string, SportTier> = {};
  for (const [league, defaults] of Object.entries(DEFAULT_SPORT_TIERS)) {
    if (league === "DEFAULT") continue;
    sportTiers[league] = tierFromEnv(env, league, defaults);
  }
  return {
    mode,
    liveEnabled: (env["EXECUTION_LIVE"] ?? "0").trim() === "1",
    hedgeRatio: Math.min(1, envNumber(env, "EXECUTION_HEDGE_RATIO", 0.5)),
    maxOrderUsd: envNumber(env, "EXECUTION_MAX_ORDER_USD", 250),
    maxMarketUsd: envNumber(env, "EXECUTION_MAX_MARKET_USD", 1_500),
    maxDailyPlannedUsd: envNumber(
      env,
      "EXECUTION_MAX_DAILY_PLANNED_USD",
      5_000,
    ),
    maxOpenIntents: envNumber(env, "EXECUTION_MAX_OPEN_INTENTS", 25, {
      integer: true,
    }),
    minEdgeBps: envNumber(env, "EXECUTION_MIN_EDGE_BPS", 300, {
      integer: true,
    }),
    maxSlippageBps: envNumber(env, "EXECUTION_MAX_SLIPPAGE_BPS", 200, {
      integer: true,
    }),
    makerMarginBps: envNumber(env, "EXECUTION_MAKER_MARGIN_BPS", 150, {
      integer: true,
    }),
    allowMakerLive: (env["EXECUTION_ALLOW_MAKER_LIVE"] ?? "0").trim() === "1",
    sportTiers,
  };
}

export function tierForPolicy(
  policy: ExecutionPolicy,
  league: string,
): SportTier {
  return (
    policy.sportTiers[league.toUpperCase()] ??
    DEFAULT_SPORT_TIERS["DEFAULT"] ?? {
      minEdgeBps: 500,
      maxSlippageBps: 300,
      maxOrderUsd: 150,
    }
  );
}

/** Stable market identity used for caps and duplicate detection. */
export function marketKeyFor(signal: WatchlistSignal): string {
  return [
    signal.league,
    [...signal.teams].sort().join("_"),
    signal.marketKind,
    signal.line === null ? "noline" : String(signal.line),
  ].join("|");
}

function sideKeyFor(signal: WatchlistSignal, join: KalshiJoin): string {
  return (
    join.side ??
    signal.overUnder ??
    (signal.sideTeam === null
      ? signal.line !== null && signal.line > 0
        ? "positive"
        : "none"
      : signal.sideTeam)
  );
}

export interface ExecutionRiskState {
  /** Manual kill switch; `paused` mode sets the same effect through the policy. */
  readonly killSwitch?: boolean;
  readonly dailyPlannedUsd: number;
  readonly openIntents: number;
  readonly marketExposureUsd: Readonly<Record<string, number>>;
  readonly recentIntents: readonly {
    readonly marketKey: string;
    readonly side: string;
    readonly atIso: string;
  }[];
}

export interface VenueReadiness {
  readonly kalshi: {
    readonly liveReady: boolean;
    readonly reason: string | null;
  };
  readonly polymarket: {
    readonly liveReady: false;
    readonly reason: string;
  };
}

export interface ExecutionProvenance {
  readonly fixture: boolean;
  readonly stale: boolean;
  readonly dataMode: string | null;
  readonly signalAsOf: string | null;
}

export interface ExecutionDecision {
  readonly id: string;
  readonly signalId: string;
  readonly createdAtIso: string;
  readonly league: string;
  readonly marketKind: string;
  readonly teams: readonly string[];
  readonly sideTeam: string | null;
  readonly line: number | null;
  readonly venue: ExecutionVenue | null;
  readonly style: ExecutionStyle | null;
  readonly position: ExecutionPosition | null;
  readonly orderAction: "buy" | "sell";
  readonly tickerToken: string | null;
  readonly fairProb: number | null;
  readonly executableProb: number | null;
  readonly edgeAfterSlippageBps: number | null;
  readonly slippageBps: number | null;
  readonly sizeUsd: number;
  readonly contracts: number;
  readonly limitPrice: number | null;
  readonly expectedCostUsd: number;
  readonly reasons: readonly string[];
  readonly blocked: boolean;
  readonly blockReason: string | null;
  readonly paper: boolean;
  readonly provenance: ExecutionProvenance;
  /** Ask-side levels (contract probability, ascending) the fill walk used. Paper-only evidence. */
  readonly bookLevels: readonly PolymarketLevel[];
}

export interface ExecutionBookView {
  readonly venue: ExecutionVenue;
  readonly position: ExecutionPosition;
  readonly tickerToken: string;
  readonly mid: number | null;
  /** Levels you would lift to buy our side, ascending by price. */
  readonly asks: readonly PolymarketLevel[];
  readonly bids: readonly PolymarketLevel[];
  readonly liveReady: boolean;
  readonly unavailableReason: string | null;
}

export interface BookWalk {
  readonly contracts: number;
  readonly costUsd: number;
  readonly avgPrice: number | null;
  readonly depthContracts: number;
  readonly bestPrice: number | null;
  readonly lastPrice: number | null;
}

export function roundTick(price: number): number {
  // The epsilon keeps 0.565 on the 57¢ side of the binary rounding boundary; dividing cents by
  // 100 at the end keeps 0.57 exactly representable for equality checks.
  return Math.round((price + 1e-9) * 100) / 100;
}

export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Ask-side walk of `budgetUsd`: what a marketable buy would actually pay. */
export function walkBook(
  asks: readonly PolymarketLevel[],
  budgetUsd: number,
): BookWalk {
  if (budgetUsd <= 0) {
    return {
      contracts: 0,
      costUsd: 0,
      avgPrice: null,
      depthContracts: 0,
      bestPrice: asks[0]?.price ?? null,
      lastPrice: null,
    };
  }
  let remaining = budgetUsd;
  let contracts = 0;
  let cost = 0;
  let lastPrice: number | null = null;
  const depthContracts = asks.reduce((sum, level) => sum + level.size, 0);
  for (const level of asks) {
    if (remaining <= 0) break;
    if (level.price <= 0) continue;
    const affordable = Math.min(level.size, remaining / level.price);
    if (affordable <= 0) continue;
    contracts += affordable;
    cost += affordable * level.price;
    remaining -= affordable * level.price;
    lastPrice = level.price;
  }
  return {
    contracts,
    costUsd: cost,
    avgPrice: contracts > 0 ? cost / contracts : null,
    depthContracts,
    bestPrice: asks[0]?.price ?? null,
    lastPrice,
  };
}

function levelFromBids(
  bids: readonly PolymarketLevel[],
  invertForAsk: boolean,
): readonly PolymarketLevel[] {
  return bids
    .map((level) => ({
      price: invertForAsk ? 1 - level.price : level.price,
      size: level.size,
    }))
    .filter((level) => level.price > 0 && level.price < 1)
    .sort((a, b) => a.price - b.price);
}

function midOf(
  bids: readonly PolymarketLevel[],
  asks: readonly PolymarketLevel[],
): number | null {
  const bestBid = [...bids].sort((a, b) => b.price - a.price)[0]?.price ?? null;
  const bestAsk = [...asks].sort((a, b) => a.price - b.price)[0]?.price ?? null;
  return bestBid === null || bestAsk === null ? null : (bestBid + bestAsk) / 2;
}

/** Kalshi venue view from the join result: YES buy = lift NO bids at 1−p, and vice versa. */
export function kalshiBookView(
  join: KalshiJoin,
  liveReady: boolean,
  reason: string | null,
): ExecutionBookView | null {
  if (join.book === null || join.side === null) return null;
  const position: ExecutionPosition = join.side === "YES" ? "yes" : "no";
  const against = position === "yes" ? join.book.no : join.book.yes;
  const forSide = position === "yes" ? join.book.yes : join.book.no;
  const asks = levelFromBids(against, true);
  const bids = [...forSide]
    .map((level) => ({ price: level.price, size: level.size }))
    .sort((a, b) => b.price - a.price);
  return {
    venue: "kalshi",
    position,
    tickerToken: join.marketTicker ?? "",
    mid: midOf(bids, asks),
    asks,
    bids,
    liveReady,
    unavailableReason: reason,
  };
}

/** Which outcome token expresses our side; `null` when the question cannot be mapped. */
export function polymarketOutcomeIndex(
  quote: Extract<PolymarketQuote, { available: true }>,
  signal: WatchlistSignal,
): number | null {
  const outcomes = quote.outcomes;
  if (signal.overUnder !== null) {
    const wanted = signal.overUnder === "over" ? "over" : "under";
    const index = outcomes.findIndex((outcome) =>
      outcome.name.toLowerCase().includes(wanted),
    );
    return index < 0 ? null : index;
  }
  if (signal.sideTeam !== null) {
    const index = outcomes.findIndex((outcome) =>
      teamMatchesQuestion(outcome.name, signal.sideTeam ?? ""),
    );
    return index < 0 ? null : index;
  }
  return null;
}

export function polymarketBookView(
  quote: PolymarketQuote,
  signal: WatchlistSignal,
  liveReady: false,
  reason: string,
): ExecutionBookView | null {
  if (!quote.available) return null;
  const index = polymarketOutcomeIndex(quote, signal);
  if (index === null) return null;
  const outcome: PolymarketOutcome | undefined = quote.outcomes[index];
  if (outcome === undefined) return null;
  const position: ExecutionPosition = index === 0 ? "yes" : "no";
  return {
    venue: "polymarket",
    position,
    tickerToken: outcome.tokenId,
    mid: midOf(outcome.bids, outcome.asks),
    asks: outcome.asks,
    bids: outcome.bids,
    liveReady,
    unavailableReason: reason,
  };
}

/* -------------------------------------------------------------------------- */
/* Decision                                                                   */
/* -------------------------------------------------------------------------- */

export interface DecideExecutionInput {
  readonly signal: WatchlistSignal;
  readonly join: KalshiJoin;
  readonly polymarket: PolymarketQuote | null;
  readonly policy: ExecutionPolicy;
  readonly risk: ExecutionRiskState;
  readonly venues: VenueReadiness;
  readonly now: Date;
  /** Present only on an explicit live run: `PLACE LIVE ORDERS`. */
  readonly liveConfirm?: string | null;
  /** Operator order-style preference: auto (default), taker-only or maker-only. */
  readonly stylePreference?: ExecutionStyle | "auto";
}

interface TakerCandidate {
  readonly book: ExecutionBookView;
  readonly walk: BookWalk;
  readonly avgPrice: number;
  readonly mid: number;
  readonly slippageBps: number;
  readonly edgeBps: number;
  readonly sizeUsd: number;
  readonly eligible: boolean;
  readonly skipReason: string | null;
}

function venueBooks(input: DecideExecutionInput): readonly ExecutionBookView[] {
  const books: ExecutionBookView[] = [];
  const kalshi = kalshiBookView(
    input.join,
    input.venues.kalshi.liveReady,
    input.venues.kalshi.reason,
  );
  if (kalshi !== null) books.push(kalshi);
  if (input.polymarket !== null) {
    const poly = polymarketBookView(
      input.polymarket,
      input.signal,
      false,
      input.polymarket.available
        ? input.venues.polymarket.reason
        : input.polymarket.reason,
    );
    if (poly !== null) books.push(poly);
  }
  return books;
}

function blockedDecision(
  input: DecideExecutionInput,
  blockReason: string,
  options: {
    readonly book: ExecutionBookView | null;
    readonly style: ExecutionStyle | null;
  },
): ExecutionDecision {
  const { signal } = input;
  return {
    id: `exec:${signal.id}:blocked`,
    signalId: signal.id,
    createdAtIso: input.now.toISOString(),
    league: signal.league,
    marketKind: signal.marketKind,
    teams: signal.teams,
    sideTeam: signal.sideTeam,
    line: signal.line,
    venue: options.book?.venue ?? null,
    style: options.style,
    position: options.book?.position ?? null,
    orderAction: "buy",
    tickerToken: options.book?.tickerToken ?? null,
    fairProb: signal.fairProb,
    executableProb: null,
    edgeAfterSlippageBps: null,
    slippageBps: null,
    sizeUsd: 0,
    contracts: 0,
    limitPrice: null,
    expectedCostUsd: 0,
    reasons: [blockReason],
    blocked: true,
    blockReason,
    paper: true,
    provenance: {
      fixture: signal.provenance.fixture,
      stale: signal.provenance.stale,
      dataMode: signal.provenance.dataMode,
      signalAsOf: signal.provenance.asOf,
    },
    bookLevels: [],
  };
}

function marketKeyExposure(
  risk: ExecutionRiskState,
  marketKey: string,
): number {
  return risk.marketExposureUsd[marketKey] ?? 0;
}

function duplicateRecent(
  input: DecideExecutionInput,
  marketKey: string,
  side: string,
): boolean {
  const cutoff = input.now.getTime() - DUPLICATE_WINDOW_MS;
  return input.risk.recentIntents.some(
    (intent) =>
      intent.marketKey === marketKey &&
      intent.side === side &&
      Date.parse(intent.atIso) >= cutoff,
  );
}

/**
 * Decide one signal. Risk gates run first and short-circuit with a blocked decision; otherwise
 * venue/style/size are chosen and `paper` reflects whether any live placement could be legal.
 */
export function decideExecution(
  input: DecideExecutionInput,
): ExecutionDecision {
  const { signal, policy, risk, venues, now } = input;
  const marketKey = marketKeyFor(signal);
  const side = sideKeyFor(signal, input.join);
  const provenance: ExecutionProvenance = {
    fixture: signal.provenance.fixture,
    stale: signal.provenance.stale,
    dataMode: signal.provenance.dataMode,
    signalAsOf: signal.provenance.asOf,
  };
  const kalshiView = kalshiBookView(
    input.join,
    venues.kalshi.liveReady,
    venues.kalshi.reason,
  );
  const polyView =
    input.polymarket === null
      ? null
      : polymarketBookView(
          input.polymarket,
          signal,
          false,
          venues.polymarket.reason,
        );
  const firstBook = kalshiView ?? polyView;

  if (risk.killSwitch || policy.mode === "paused") {
    return blockedDecision(input, risk.killSwitch ? "kill_switch" : "paused", {
      book: firstBook,
      style: null,
    });
  }
  if (duplicateRecent(input, marketKey, side)) {
    return blockedDecision(input, "duplicate_recent", {
      book: firstBook,
      style: null,
    });
  }
  if (risk.openIntents >= policy.maxOpenIntents) {
    return blockedDecision(input, "max_open_intents", {
      book: firstBook,
      style: null,
    });
  }
  const remainingMarket =
    policy.maxMarketUsd - marketKeyExposure(risk, marketKey);
  if (remainingMarket <= 0) {
    return blockedDecision(input, "market_cap", {
      book: firstBook,
      style: null,
    });
  }
  const remainingDaily = policy.maxDailyPlannedUsd - risk.dailyPlannedUsd;
  if (remainingDaily <= 0) {
    return blockedDecision(input, "daily_cap", {
      book: firstBook,
      style: null,
    });
  }

  const fixtureCapped = signal.provenance.fixture;
  const books = venueBooks(input);
  const tier = tierForPolicy(policy, signal.league);
  const maxOrder = Math.min(tier.maxOrderUsd, policy.maxOrderUsd);
  const baseUsd = Math.min(
    Math.max(0, signal.riskUsd * policy.hedgeRatio),
    maxOrder,
    remainingMarket,
    remainingDaily,
  );

  const candidates: TakerCandidate[] = [];
  for (const book of books) {
    const bestPrice = book.asks[0]?.price ?? null;
    if (bestPrice === null || bestPrice <= 0) {
      candidates.push({
        book,
        walk: walkBook([], 0),
        avgPrice: 0,
        mid: book.mid ?? 0,
        slippageBps: 0,
        edgeBps: 0,
        sizeUsd: 0,
        eligible: false,
        skipReason: "no_book",
      });
      continue;
    }
    const depthNotional = book.asks.reduce(
      (sum, level) => sum + level.price * level.size,
      0,
    );
    const venueBudget = Math.min(baseUsd, depthNotional * 0.25);
    if (venueBudget <= 0) {
      candidates.push({
        book,
        walk: walkBook(book.asks, 0),
        avgPrice: 0,
        mid: book.mid ?? 0,
        slippageBps: 0,
        edgeBps: 0,
        sizeUsd: 0,
        eligible: false,
        skipReason: "no_book",
      });
      continue;
    }
    const walk = walkBook(book.asks, venueBudget);
    const avgPrice = roundTick(walk.avgPrice ?? bestPrice);
    const mid = book.mid ?? avgPrice;
    const slippageBps =
      mid > 0 ? Math.round((Math.abs(avgPrice - mid) / mid) * 10_000) : 0;
    const edgeBps =
      signal.fairProb === null
        ? 0
        : Math.round((signal.fairProb - avgPrice) * 10_000);
    const requestedContracts = Math.max(1, Math.floor(venueBudget / avgPrice));
    const covered = walk.contracts >= requestedContracts;
    const skipReason = !covered
      ? "insufficient_depth"
      : slippageBps > tier.maxSlippageBps
        ? "slippage_exceeds_policy"
        : signal.fairProb === null
          ? "no_fair_price"
          : edgeBps < tier.minEdgeBps
            ? "edge_below_min"
            : null;
    candidates.push({
      book,
      walk,
      avgPrice,
      mid,
      slippageBps,
      edgeBps,
      sizeUsd: roundUsd(walk.contracts * avgPrice),
      eligible: skipReason === null,
      skipReason,
    });
  }

  const eligible = candidates
    .filter((candidate) => candidate.eligible)
    .sort(
      (a, b) =>
        b.edgeBps - a.edgeBps ||
        b.walk.depthContracts - a.walk.depthContracts ||
        a.book.venue.localeCompare(b.book.venue),
    );
  const stylePreference = input.stylePreference ?? "auto";
  const chosen = stylePreference === "maker" ? undefined : eligible[0];
  if (chosen !== undefined) {
    const contracts = Math.max(0, Math.floor(chosen.walk.contracts));
    const sizeUsd = roundUsd(contracts * chosen.avgPrice);
    const liveReady =
      !fixtureCapped &&
      chosen.book.venue === "kalshi" &&
      policy.liveEnabled &&
      venues.kalshi.liveReady &&
      input.liveConfirm === LIVE_CONFIRM_PHRASE;
    const reasons: string[] = [
      `taker:${chosen.book.venue}`,
      `sport_tier:${signal.league.toUpperCase()}`,
    ];
    if (fixtureCapped) reasons.push("fixture_source:paper_forced");
    if (!liveReady) reasons.push("paper:live_not_armed");
    if (sizeUsd <= 0 || contracts <= 0) {
      return blockedDecision(input, "no_size", {
        book: chosen.book,
        style: "taker",
      });
    }
    return {
      id: `exec:${signal.id}:${chosen.book.venue}:taker`,
      signalId: signal.id,
      createdAtIso: now.toISOString(),
      league: signal.league,
      marketKind: signal.marketKind,
      teams: signal.teams,
      sideTeam: signal.sideTeam,
      line: signal.line,
      venue: chosen.book.venue,
      style: "taker",
      position: chosen.book.position,
      orderAction: "buy",
      tickerToken: chosen.book.tickerToken,
      fairProb: signal.fairProb,
      executableProb: chosen.avgPrice,
      edgeAfterSlippageBps: chosen.edgeBps,
      slippageBps: chosen.slippageBps,
      sizeUsd,
      contracts,
      limitPrice: roundTick(chosen.avgPrice),
      expectedCostUsd: sizeUsd,
      reasons,
      blocked: false,
      blockReason: null,
      paper: !liveReady,
      provenance,
      bookLevels: chosen.book.asks,
    };
  }

  if (stylePreference === "taker") {
    // The operator asked for taker only: do not quietly fall back to a resting maker quote.
    return blockedDecision(input, "style_taker_no_fill", {
      book: firstBook,
      style: null,
    });
  }

  // No taker candidate cleared the policy: offer a maker quote if a book exists.
  const makerBook = candidates
    .filter(
      (candidate) =>
        candidate.book.asks.length > 0 || candidate.book.bids.length > 0,
    )
    .sort(
      (a, b) =>
        b.walk.depthContracts - a.walk.depthContracts ||
        a.book.venue.localeCompare(b.book.venue),
    )[0];
  const makerAllowed =
    makerBook !== undefined &&
    // A maker quote can only be a real order when live placement allows makers. (The paused
    // mode already returned above, so it cannot reach this branch.)
    (!policy.liveEnabled || policy.allowMakerLive);
  let makerBlockReason: string | null = null;
  if (makerBook !== undefined && makerAllowed && signal.fairProb !== null) {
    const book = makerBook.book;
    const makerMargin = policy.makerMarginBps / 10_000;
    const fairPrice = roundTick(signal.fairProb - makerMargin);
    const bestAsk = book.asks[0]?.price ?? null;
    const bestBid = book.bids[0]?.price ?? null;
    let limitPrice = fairPrice;
    if (bestAsk !== null)
      limitPrice = Math.min(limitPrice, bestAsk - EXECUTION_TICK);
    limitPrice = Math.max(EXECUTION_TICK, roundTick(limitPrice));
    // A maker buy is only worth posting when the resting price is below fair by at least the
    // policy edge. Clamping up to the current bid would post at negative expected value: the
    // first live plan did exactly that (-862 bps edge, reported as actionable).
    const makerEdgeBps =
      signal.fairProb === null
        ? null
        : Math.round((signal.fairProb - limitPrice) * 10_000);
    if (makerEdgeBps === null || makerEdgeBps < tier.minEdgeBps) {
      makerBlockReason = "maker_edge_below_min";
    }
    const topSize =
      bestBid === null ? (book.asks[0]?.size ?? 0) : (book.bids[0]?.size ?? 0);
    const makerDepthUsd = Math.max(
      0,
      Math.min(baseUsd, topSize * 0.5 * limitPrice),
    );
    const makerMax = Math.min(
      policy.maxOrderUsd,
      remainingMarket,
      remainingDaily,
    );
    const sizeUsd = roundUsd(Math.min(makerDepthUsd, makerMax));
    const contracts = Math.max(
      0,
      Math.floor(sizeUsd / Math.max(limitPrice, EXECUTION_TICK)),
    );
    const reasons = [
      `maker:${book.venue}`,
      `maker_margin:${policy.makerMarginBps}bps`,
      "no_eligible_taker",
      ...(stylePreference === "maker" ? ["style:maker_preferred"] : []),
    ];
    if (!policy.allowMakerLive) reasons.push("maker_live_disallowed");
    if (makerEdgeBps !== null) {
      reasons.push("maker_edge:" + makerEdgeBps + "bps");
    }
    if (makerBlockReason === null && contracts > 0 && sizeUsd > 0) {
      return {
        id: `exec:${signal.id}:${book.venue}:maker`,
        signalId: signal.id,
        createdAtIso: now.toISOString(),
        league: signal.league,
        marketKind: signal.marketKind,
        teams: signal.teams,
        sideTeam: signal.sideTeam,
        line: signal.line,
        venue: book.venue,
        style: "maker",
        position: book.position,
        orderAction: "buy",
        tickerToken: book.tickerToken,
        fairProb: signal.fairProb,
        executableProb: limitPrice,
        edgeAfterSlippageBps: makerEdgeBps ?? 0,
        slippageBps: 0,
        sizeUsd,
        contracts,
        limitPrice,
        expectedCostUsd: sizeUsd,
        reasons,
        blocked: false,
        blockReason: null,
        paper: true,
        provenance,
        bookLevels: book.asks,
      };
    }
  }

  const firstSkip = candidates.find(
    (candidate) => candidate.skipReason !== null,
  );
  const skipReason =
    makerBlockReason !== null
      ? makerBlockReason
      : makerBook === undefined
        ? candidates.length === 0
          ? "no_book"
          : "venue_unavailable"
        : (firstSkip?.skipReason ?? "no_edge");
  return blockedDecision(input, skipReason, {
    book: makerBook?.book ?? firstBook,
    style: null,
  });
}

export interface DecideExecutionsInput {
  readonly items: readonly {
    readonly signal: WatchlistSignal;
    readonly join: KalshiJoin;
    readonly polymarket: PolymarketQuote | null;
  }[];
  readonly policy: ExecutionPolicy;
  readonly risk: ExecutionRiskState;
  readonly venues: VenueReadiness;
  readonly now: Date;
  readonly liveConfirm?: string | null;
  readonly stylePreference?: ExecutionStyle | "auto";
}

/** Decide a batch in order, advancing the in-memory risk state so caps apply within a plan. */
export function decideExecutions(
  input: DecideExecutionsInput,
): readonly ExecutionDecision[] {
  const decisions: ExecutionDecision[] = [];
  const recent = [...input.risk.recentIntents];
  let daily = input.risk.dailyPlannedUsd;
  const exposure = { ...input.risk.marketExposureUsd };
  for (const item of input.items) {
    const decision = decideExecution({
      signal: item.signal,
      join: item.join,
      polymarket: item.polymarket,
      policy: input.policy,
      risk: {
        dailyPlannedUsd: daily,
        openIntents:
          input.risk.openIntents +
          decisions.filter((row) => !row.blocked).length,
        marketExposureUsd: exposure,
        recentIntents: recent,
      },
      venues: input.venues,
      now: input.now,
      ...(input.liveConfirm === undefined
        ? {}
        : { liveConfirm: input.liveConfirm }),
      ...(input.stylePreference === undefined
        ? {}
        : { stylePreference: input.stylePreference }),
    });
    decisions.push(decision);
    if (!decision.blocked) {
      daily += decision.sizeUsd;
      const marketKey = marketKeyFor(item.signal);
      exposure[marketKey] = (exposure[marketKey] ?? 0) + decision.sizeUsd;
      recent.push({
        marketKey,
        side: sideKeyFor(item.signal, item.join),
        atIso: decision.createdAtIso,
      });
    }
  }
  return decisions;
}
