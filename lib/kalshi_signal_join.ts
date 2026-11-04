/**
 * Join a watchlist signal to one Kalshi market and price its executable edge.
 *
 * This is the read-only half of the feature: it lists open events for the league's series, picks
 * the market the signal actually describes, walks the order book for the side the signal needs,
 * and compares the book's executable probability to the signal's fair probability. It never
 * places an order and never sends credentials — the only network calls are the client's three
 * public GETs.
 *
 * Verdict precedence is deliberate and fixed:
 * `fixture_only → no_market → no_fair_price → stale → thin_liquidity → no_edge → actionable`.
 * A fixture-sourced signal therefore stays `fixture_only` even when a real, liquid market matched:
 * the market data is real, the betting flow is not, and the verdict must describe the weaker limb.
 */
import type {
  KalshiClient,
  KalshiEvent,
  KalshiMarket,
  KalshiOrderbook,
} from "./kalshi_client.ts";
import type { League, WatchlistSignal } from "./watchlist_signal_engine.ts";

export type SignalSide = "YES" | "NO";
export type LiquidityVerdict = "ok" | "thin" | "wide" | "empty";
export type SignalVerdict =
  | "fixture_only"
  | "no_market"
  | "no_fair_price"
  | "stale"
  | "thin_liquidity"
  | "no_edge"
  | "actionable";

export interface JoinConfig {
  readonly minEdgeBps: number;
  readonly minContracts: number;
  readonly maxSpreadCents: number;
  readonly referenceNotionalUsd: number;
}

export const DEFAULT_JOIN_CONFIG: JoinConfig = {
  minEdgeBps: 300,
  minContracts: 50,
  maxSpreadCents: 6,
  referenceNotionalUsd: 1_000,
};

function envInt(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Contract defaults, overridable with `KALSHI_*` env vars; a bad value keeps the default. */
export function joinConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): JoinConfig {
  return {
    minEdgeBps: envInt(
      env,
      "KALSHI_MIN_EDGE_BPS",
      DEFAULT_JOIN_CONFIG.minEdgeBps,
    ),
    minContracts: envInt(
      env,
      "KALSHI_MIN_CONTRACTS",
      DEFAULT_JOIN_CONFIG.minContracts,
    ),
    maxSpreadCents: envInt(
      env,
      "KALSHI_MAX_SPREAD_CENTS",
      DEFAULT_JOIN_CONFIG.maxSpreadCents,
    ),
    referenceNotionalUsd: envInt(
      env,
      "KALSHI_REFERENCE_NOTIONAL_USD",
      DEFAULT_JOIN_CONFIG.referenceNotionalUsd,
    ),
  };
}

export interface Liquidity {
  readonly topSize: number;
  readonly spreadCents: number | null;
  readonly depthContracts: number;
  readonly vwap: number | null;
  readonly executablePrice: number | null;
  readonly priceImpactCents: number | null;
  readonly verdict: LiquidityVerdict;
  readonly referenceNotionalUsd: number;
}

export interface KalshiJoin {
  readonly seriesTicker: string | null;
  readonly eventTicker: string | null;
  readonly marketTicker: string | null;
  readonly marketTitle: string | null;
  readonly side: SignalSide | null;
  readonly fairProb: number | null;
  readonly executablePrice: number | null;
  /** fairProb − executable probability, in basis points; `null` without a fair price. */
  readonly edgeBps: number | null;
  readonly liquidity: Liquidity | null;
  readonly liquidityVerdict: LiquidityVerdict | null;
  /** The book as fetched, so an execution planner can re-walk it without another request. */
  readonly book: KalshiOrderbook | null;
  readonly verdict: SignalVerdict;
  readonly reason: string | null;
}

export interface JoinedSignal extends WatchlistSignal {
  readonly kalshi: KalshiJoin;
}

/* -------------------------------------------------------------------------- */
/* Series map and team codes                                                  */
/* -------------------------------------------------------------------------- */

/** League × market kind → Kalshi series. A kind absent here is `no_market`, not a guess. */
const SERIES_BY_LEAGUE: Readonly<
  Record<League, Readonly<Record<string, string>>>
> = {
  NBA: {
    moneyline: "KXNBAGAME",
    spread: "KXNBASPREAD",
    total: "KXNBATOTAL",
    team_total: "KXNBATEAMTOTAL",
    "1q_moneyline": "KXNBA1Q",
    "1q_total": "KXNBA1QTOTAL",
    "1q_spread": "KXNBA1QSPREAD",
    "2q_moneyline": "KXNBA2Q",
    "2q_total": "KXNBA2QTOTAL",
    "2q_spread": "KXNBA2QSPREAD",
    "3q_moneyline": "KXNBA3Q",
    "3q_total": "KXNBA3QTOTAL",
    "3q_spread": "KXNBA3QSPREAD",
    "4q_moneyline": "KXNBA4Q",
    "4q_total": "KXNBA4QTOTAL",
    "4q_spread": "KXNBA4QSPREAD",
    "1h_moneyline": "KXNBA1HWINNER",
    "2h_moneyline": "KXNBA2HWINNER",
    "1h_total": "KXNBA1HTOTAL",
    "1h_spread": "KXNBA1HSPREAD",
    "2h_spread": "KXNBA2HSPREAD",
  },
  NFL: {
    moneyline: "KXNFLGAME",
    spread: "KXNFLSPREAD",
    total: "KXNFLTOTAL",
    "2q_moneyline": "KXNFL2Q",
    "2q_total": "KXNFL2QTOTAL",
    "1h_moneyline": "KXNFL1H",
    "1h_total": "KXNFL1HTOTAL",
    "3q_moneyline": "KXNFL3QWINNER",
  },
  CFB: {
    moneyline: "KXNCAAFGAME",
    spread: "KXNCAAFSPREAD",
    total: "KXNCAAFTOTAL",
    "2h_moneyline": "KXNCAAF2H",
    "1h_moneyline": "KXNCAAF1HWINNER",
    "1h_spread": "KXNCAAF1HSPREAD",
    "1q_total": "KXNCAAF1QTOTAL",
  },
  EPL: {
    moneyline: "KXEPLGAME",
    spread: "KXEPLSPREAD",
    total: "KXEPLTOTAL",
    "1h_moneyline": "KXEPL1H",
    "2h_moneyline": "KXEPL2H",
    "1h_total": "KXEPL1HTOTAL",
  },
  NHL: {
    moneyline: "KXNHLGAME",
    spread: "KXNHLSPREAD",
    total: "KXNHLTOTAL",
  },
  MLB: {},
  UNKNOWN: {},
};

export function seriesTickerFor(
  signal: Pick<WatchlistSignal, "league" | "marketKind">,
): string | null {
  return SERIES_BY_LEAGUE[signal.league]?.[signal.marketKind] ?? null;
}

/**
 * Signal code ↔ Kalshi code. Kalshi's tickers are the source of truth for the right-hand side
 * (captured 2026-11-04: `...ATLWAS`, `...CHABKN`, `...MILBOS`); the aliases exist because the
 * F402/registry vocabulary differs for a handful of clubs.
 */
const TEAM_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["BKN", "BRK"],
  ["GSW", "GS"],
  ["NOP", "NO"],
  ["NYK", "NY"],
  ["SAS", "SA"],
  ["WSH", "WAS"],
  ["JAX", "JAC"],
  ["PHO", "PHX"],
  ["LA", "LAR"],
  ["LA", "LAC"],
];

const ALIAS_MAP: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const [left, right] of TEAM_ALIASES) {
    const leftSet = map.get(left) ?? new Set<string>([left]);
    leftSet.add(right);
    map.set(left, leftSet);
    const rightSet = map.get(right) ?? new Set<string>([right]);
    rightSet.add(left);
    map.set(right, rightSet);
  }
  return map;
})();

/** Two codes name the same club when equal or linked by the alias table (either direction). */
export function teamCodesMatch(a: string, b: string): boolean {
  const left = a.trim().toUpperCase();
  const right = b.trim().toUpperCase();
  if (left === right) return true;
  return ALIAS_MAP.get(left)?.has(right) ?? false;
}

function looksLikeCode(team: string): boolean {
  return /^[A-Z]{2,4}$/.test(team.trim());
}

/**
 * The code pair at the end of an event ticker after its date prefix.
 *
 * `KXNBAGAME-26NOV04ATLWAS` → [ATL, WAS]; code widths vary (2-4), so every split is a candidate
 * and the caller must find exactly one match (ambiguity is `no_market`, not a coin flip).
 */
export function eventTeamCodeCandidates(
  eventTicker: string,
  seriesTicker: string,
): ReadonlyArray<readonly [string, string]> {
  const prefix = `${seriesTicker}-`;
  if (!eventTicker.startsWith(prefix)) return [];
  const suffix = eventTicker.slice(prefix.length);
  const dateMatch = /^\d{2}[A-Z]{3}\d{2}(.+)$/.exec(suffix);
  if (dateMatch === null) return [];
  const rest = dateMatch[1] ?? "";
  const candidates: Array<readonly [string, string]> = [];
  for (let left = 2; left <= 4; left += 1) {
    const first = rest.slice(0, left);
    const second = rest.slice(left);
    if (second.length < 2 || second.length > 4) continue;
    if (!/^[A-Z]+$/.test(first) || !/^[A-Z]+$/.test(second)) continue;
    candidates.push([first, second]);
  }
  return candidates;
}

interface EventMatch {
  readonly event: KalshiEvent;
  /** Signal team token → Kalshi code for this event. */
  readonly codes: ReadonlyMap<string, string>;
}

function matchEvent(
  signals: readonly string[],
  events: readonly KalshiEvent[],
  seriesTicker: string,
): EventMatch | null | "ambiguous" {
  const wanted = signals.map((team) => team.trim().toUpperCase());
  const matches: EventMatch[] = [];
  for (const event of events) {
    for (const candidate of eventTeamCodeCandidates(
      event.eventTicker,
      seriesTicker,
    )) {
      const codes = new Map<string, string>();
      let matched = 0;
      for (const team of wanted) {
        const found = candidate.find((code) => teamCodesMatch(team, code));
        if (found !== undefined) {
          codes.set(team, found);
          matched += 1;
        }
      }
      if (matched === wanted.length) {
        matches.push({ event, codes });
        break;
      }
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) return "ambiguous";
  return matches[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Liquidity                                                                  */
/* -------------------------------------------------------------------------- */

function roundPrice(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Walk the book for one side.
 *
 * Kalshi publishes resting *bids* per contract. Buying YES lifts NO bids at `1 - noPrice`, and
 * buying NO lifts YES bids at `1 - yesPrice`; levels are walked from the best (cheapest ask) down
 * until `referenceNotionalUsd` is spent. Nothing is modelled from an empty side: an empty book is
 * `empty`, never a synthetic price.
 */
export function deriveLiquidity(
  book: KalshiOrderbook,
  side: SignalSide,
  config: JoinConfig,
): Liquidity {
  const against = side === "YES" ? book.no : book.yes;
  const forSide = side === "YES" ? book.yes : book.no;
  const levels = [...against].sort((a, b) => b.price - a.price);
  const bestAgainst = levels[0];
  const bestFor = [...forSide].sort((a, b) => b.price - a.price)[0];
  const executablePrice =
    bestAgainst === undefined ? null : roundPrice(1 - bestAgainst.price);
  const topSize = bestAgainst === undefined ? 0 : Math.max(0, bestAgainst.size);
  const spreadCents =
    bestFor === undefined || bestAgainst === undefined
      ? null
      : Math.max(0, Math.round((1 - bestAgainst.price - bestFor.price) * 100));

  let contracts = 0;
  let cost = 0;
  let remainingNotional = Math.max(0, config.referenceNotionalUsd);
  let lastPrice = executablePrice ?? 0;
  if (executablePrice !== null) {
    for (const level of levels) {
      if (remainingNotional <= 0) break;
      const price = 1 - level.price;
      if (price <= 0) continue;
      const affordable = Math.min(
        Math.max(0, level.size),
        Math.floor(remainingNotional / price),
      );
      if (affordable <= 0) continue;
      contracts += affordable;
      cost += affordable * price;
      remainingNotional -= affordable * price;
      lastPrice = price;
    }
  }
  const vwap = contracts > 0 ? roundPrice(cost / contracts) : null;
  const priceImpactCents =
    executablePrice === null || contracts === 0
      ? null
      : Math.max(0, Math.round((lastPrice - executablePrice) * 100));

  let verdict: LiquidityVerdict = "ok";
  if (executablePrice === null || contracts === 0) verdict = "empty";
  else if (spreadCents !== null && spreadCents > config.maxSpreadCents)
    verdict = "wide";
  else if (topSize < config.minContracts || contracts < config.minContracts)
    verdict = "thin";

  return {
    topSize: Math.round(topSize * 100) / 100,
    spreadCents,
    depthContracts: Math.round(contracts * 100) / 100,
    vwap,
    executablePrice,
    priceImpactCents,
    verdict,
    referenceNotionalUsd: config.referenceNotionalUsd,
  };
}

/* -------------------------------------------------------------------------- */
/* Market selection                                                           */
/* -------------------------------------------------------------------------- */

function strikeToken(line: number): string {
  return String(Math.round(Math.abs(line)));
}

function marketByTicker(
  event: KalshiEvent,
  suffix: string,
): KalshiMarket | null {
  return event.markets.find((market) => market.ticker.endsWith(suffix)) ?? null;
}

interface MarketChoice {
  readonly market: KalshiMarket;
  readonly side: SignalSide;
}

function chooseMarket(
  signal: WatchlistSignal,
  event: KalshiEvent,
  match: EventMatch,
): MarketChoice | "no_market" {
  const kind = signal.marketKind;
  // Only a period prefix (`1q_total`) is stripped; `team_total` is its own base kind.
  const baseKind = /^(?:1q|2q|3q|4q|1h|2h)_/.test(kind) ? kind.slice(3) : kind;
  const line = signal.line;
  const sideTeam = signal.sideTeam;
  const sideCode =
    sideTeam === null ? null : (match.codes.get(sideTeam) ?? null);

  if (baseKind === "moneyline") {
    if (sideCode === null) return "no_market";
    const market = marketByTicker(event, `-${sideCode}`);
    return market === null ? "no_market" : { market, side: "YES" };
  }

  if (baseKind === "total") {
    if (line === null || signal.overUnder === null) return "no_market";
    const market =
      event.markets.find(
        (candidate) =>
          candidate.floorStrike !== null &&
          Math.abs(candidate.floorStrike - line) < 0.01,
      ) ?? null;
    return market === null
      ? "no_market"
      : { market, side: signal.overUnder === "over" ? "YES" : "NO" };
  }

  if (baseKind === "spread") {
    if (line === null || sideTeam === null || sideCode === null)
      return "no_market";
    const token = strikeToken(line);
    if (line < 0) {
      const market =
        event.markets.find(
          (candidate) =>
            candidate.ticker.includes(`-${sideCode}`) &&
            candidate.floorStrike !== null &&
            Math.abs(candidate.floorStrike + line) < 0.01,
        ) ?? null;
      return market === null ? "no_market" : { market, side: "YES" };
    }
    const opponent = signal.teams.find(
      (team) => !teamCodesMatch(team, sideTeam),
    );
    const opponentCode =
      opponent === undefined ? null : (match.codes.get(opponent) ?? null);
    if (opponentCode === null) return "no_market";
    const market =
      event.markets.find(
        (candidate) =>
          candidate.ticker.includes(`-${opponentCode}${token}`) &&
          candidate.floorStrike !== null &&
          Math.abs(candidate.floorStrike - line) < 0.01,
      ) ?? null;
    return market === null ? "no_market" : { market, side: "NO" };
  }

  if (baseKind === "team_total") {
    if (line === null || sideCode === null || signal.overUnder === null)
      return "no_market";
    const market =
      event.markets.find(
        (candidate) =>
          candidate.ticker.includes(`-${sideCode}`) &&
          candidate.floorStrike !== null &&
          Math.abs(candidate.floorStrike - line) < 0.01,
      ) ?? null;
    return market === null
      ? "no_market"
      : { market, side: signal.overUnder === "over" ? "YES" : "NO" };
  }

  // Any other base kind (e.g. a period "winner" series) is a team-wins market.
  if (sideCode === null) return "no_market";
  const market = marketByTicker(event, `-${sideCode}`);
  return market === null ? "no_market" : { market, side: "YES" };
}

/* -------------------------------------------------------------------------- */
/* Join                                                                       */
/* -------------------------------------------------------------------------- */

function verdictFor(input: {
  readonly signal: WatchlistSignal;
  readonly choice: MarketChoice | "no_market" | null;
  readonly joinFailure: string | null;
  readonly liquidity: Liquidity | null;
  readonly edgeBps: number | null;
  readonly config: JoinConfig;
}): { verdict: SignalVerdict; reason: string | null } {
  const { signal, choice, joinFailure, liquidity, edgeBps, config } = input;
  if (signal.provenance.fixture)
    return { verdict: "fixture_only", reason: "source row is a fixture" };
  if (choice === null || choice === "no_market")
    return {
      verdict: "no_market",
      reason: joinFailure ?? "no matching Kalshi market",
    };
  if (signal.fairProb === null)
    return {
      verdict: "no_fair_price",
      reason: "no American odds on the signal",
    };
  if (signal.provenance.stale)
    return { verdict: "stale", reason: "signal source is stale" };
  if (liquidity === null || liquidity.verdict !== "ok")
    return {
      verdict: "thin_liquidity",
      reason:
        liquidity === null ? "no order book" : `liquidity ${liquidity.verdict}`,
    };
  if (edgeBps === null || edgeBps < config.minEdgeBps)
    return {
      verdict: "no_edge",
      reason:
        edgeBps === null
          ? "no executable price"
          : `edge ${edgeBps} bps < ${config.minEdgeBps} bps`,
    };
  return { verdict: "actionable", reason: null };
}

export interface JoinWatchlistOptions {
  readonly client: KalshiClient;
  readonly config?: JoinConfig;
}

/**
 * Join every signal in order, reusing the client's event cache.
 *
 * A series with no open events, an unmatched team, an unsupported kind or a failed request all
 * end as `no_market` with a reason; none of them produce a price. The client's telemetry carries
 * the degraded flag for the route.
 */
export async function joinWatchlistSignals(
  signals: readonly WatchlistSignal[],
  options: JoinWatchlistOptions,
): Promise<JoinedSignal[]> {
  const config = options.config ?? DEFAULT_JOIN_CONFIG;
  const eventsBySeries = new Map<string, readonly KalshiEvent[] | null>();
  const joined: JoinedSignal[] = [];
  for (const signal of signals) {
    const seriesTicker = seriesTickerFor(signal);
    const base: KalshiJoin = {
      seriesTicker,
      eventTicker: null,
      marketTicker: null,
      marketTitle: null,
      side: null,
      fairProb: signal.fairProb,
      executablePrice: null,
      edgeBps: null,
      liquidity: null,
      liquidityVerdict: null,
      book: null,
      verdict: "no_market",
      reason: null,
    };
    if (seriesTicker === null) {
      joined.push({
        ...signal,
        kalshi: {
          ...base,
          reason: `unsupported league/kind ${signal.league}/${signal.marketKind}`,
        },
      });
      continue;
    }

    let events = eventsBySeries.get(seriesTicker);
    let joinFailure: string | null = null;
    if (events === undefined) {
      const listed = await options.client.listOpenEvents(seriesTicker);
      if (listed.ok) {
        events = listed.value;
      } else {
        events = null;
        joinFailure = `Kalshi unavailable: ${listed.reason}`;
      }
      eventsBySeries.set(seriesTicker, events);
    }
    if (events === null) {
      joined.push({
        ...signal,
        kalshi: { ...base, reason: joinFailure ?? "Kalshi unavailable" },
      });
      continue;
    }
    if (events.length === 0) {
      joined.push({
        ...signal,
        kalshi: {
          ...base,
          reason: `no open events for series ${seriesTicker}`,
        },
      });
      continue;
    }

    const teamCodes = signal.teams.filter(looksLikeCode);
    if (teamCodes.length < 2) {
      joined.push({
        ...signal,
        kalshi: {
          ...base,
          reason: "team codes unavailable for event matching",
        },
      });
      continue;
    }
    const matched = matchEvent(teamCodes, events, seriesTicker);
    if (matched === null || matched === "ambiguous") {
      joined.push({
        ...signal,
        kalshi: {
          ...base,
          reason:
            matched === "ambiguous"
              ? "multiple Kalshi events match the team codes"
              : "no open Kalshi event matches the team codes",
        },
      });
      continue;
    }

    const choice = chooseMarket(signal, matched.event, matched);
    if (choice === "no_market") {
      joined.push({
        ...signal,
        kalshi: {
          ...base,
          eventTicker: matched.event.eventTicker,
          reason: `no ${signal.marketKind} market at line ${String(signal.line)}`,
        },
      });
      continue;
    }

    const orderbook = await options.client.getOrderbook(choice.market.ticker);
    const liquidity = orderbook.ok
      ? deriveLiquidity(orderbook.value, choice.side, config)
      : null;
    const executablePrice = liquidity?.executablePrice ?? null;
    const edgeBps =
      signal.fairProb !== null && executablePrice !== null
        ? Math.round((signal.fairProb - executablePrice) * 10_000)
        : null;
    const failure = orderbook.ok
      ? null
      : `orderbook unavailable: ${orderbook.reason}`;
    const decision = verdictFor({
      signal,
      choice,
      joinFailure: failure,
      liquidity,
      edgeBps,
      config,
    });
    joined.push({
      ...signal,
      kalshi: {
        seriesTicker,
        eventTicker: matched.event.eventTicker,
        marketTicker: choice.market.ticker,
        marketTitle: choice.market.title,
        side: choice.side,
        fairProb: signal.fairProb,
        executablePrice,
        edgeBps,
        liquidity,
        liquidityVerdict: liquidity?.verdict ?? null,
        book: orderbook.ok ? orderbook.value : null,
        verdict: decision.verdict,
        reason: failure ?? decision.reason,
      },
    });
  }
  return joined;
}
