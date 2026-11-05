/**
 * @file bet_venue_breakdown.ts
 * @description Cross-venue market breakdown for parsed bet-ticker bets: for each bet, find the
 * matching Kalshi market and Polymarket market, and report price + liquidity.
 *
 * WHAT THIS IS
 *
 * The incoming-bet pipeline sees a ticket narrative (sport, event, market type, line, side). This
 * module turns that narrative into the `WatchlistSignal` shape the venue joins already understand,
 * then reuses the two production readers instead of re-implementing matching:
 *   - `joinWatchlistSignals` (Kalshi public events + order book) gives the market ticker, side,
 *     executable probability, spread/depth and a verdict.
 *   - `PolymarketQuoteClient.quoteForTeams` (gamma search + CLOB books) gives the game-winner
 *     market and both outcome books. Polymarket's team join is game-winner only, so a
 *     total/spread/prop bet reports `available:false` with that reason rather than pairing the
 *     bet with a different market.
 *
 * READ-ONLY: both readers use public GET endpoints only; this module has no order, portfolio or
 * credentials path. A fixture-sourced signal keeps a `fixture_only` verdict; a stale capture
 * keeps `stale`. A missing/unsupported league/kind is an explicit unmatched reason, never a
 * guessed market.
 *
 * The league mapping is a heuristic (Basketball→NBA, Football→NFL, Hockey→NHL, Baseball→MLB,
 * Soccer→EPL) and every breakdown carries the note; pass `leagueOverride` (CLI `--league`) when
 * the capture cannot say (CFB vs NFL, WNBA vs NBA).
 */

import type { IncomingBetRecord } from "./bet_flags.ts";
import {
  KalshiClient,
  type KalshiOrderbook,
  type KalshiTelemetry,
} from "./kalshi_client.ts";
import {
  joinWatchlistSignals,
  type JoinedSignal,
  type KalshiJoin,
} from "./kalshi_signal_join.ts";
import {
  PolymarketQuoteClient,
  type PolymarketQuote,
  type PolymarketTelemetry,
} from "./polymarket_quote.ts";
import type {
  League,
  OverUnder,
  WatchlistSignal,
} from "./watchlist_signal_engine.ts";
import { comboProfile, type ComboProfile } from "./market_type_registry.ts";

const LEAGUES: ReadonlySet<League> = new Set([
  "NBA",
  "NFL",
  "CFB",
  "EPL",
  "NHL",
  "MLB",
]);

/** Sport names the capture carries → the only league this module can infer from them. */
const SPORT_TO_LEAGUE: Readonly<Record<string, League>> = {
  basketball: "NBA",
  football: "NFL",
  hockey: "NHL",
  baseball: "MLB",
  soccer: "EPL",
};

const PERIOD_TOKEN: Readonly<Record<string, string>> = {
  "1st quarter": "1q",
  "2nd quarter": "2q",
  "3rd quarter": "3q",
  "4th quarter": "4q",
  "1st half": "1h",
  "2nd half": "2h",
  "1st period": "1p",
  "2nd period": "2p",
  "3rd period": "3p",
  "1st set": "1s",
  "2nd set": "2s",
  "3rd set": "3s",
};

const MARKET_KIND: Readonly<Record<string, string>> = {
  total: "total",
  spread: "spread",
  moneyline: "moneyline",
  team_total: "team_total",
};

export interface BetVenueSignalMapping {
  readonly signal: WatchlistSignal | null;
  /** Why no venue signal could be built (unsupported kind, missing teams, unknown league). */
  readonly refusal: string | null;
  readonly league: League;
  readonly marketKind: string;
  readonly teams: readonly string[];
  readonly notes: readonly string[];
  readonly combo: ComboProfile;
}

/** Split `"Cavaliers/Thunder"`, `"Massachusetts vs Ball State"`, `"A - B"` style event labels. */
export function splitEventTeams(eventLabel: string): string[] {
  const parts = eventLabel
    .split(/\s+vs\.?\s+|\s+@\s+|\s*\/\s*|\s+-\s+/i)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length === 2 ? parts : [];
}

/**
 * Build the venue-facing signal for one record. Pure; the production join/quote readers consume
 * the result unchanged. A heuristic league mapping is recorded in `notes` so a caller can show
 * the assumption rather than hide it.
 */
export function betToVenueSignal(
  record: IncomingBetRecord,
  options: { readonly leagueOverride?: League; readonly now?: Date } = {},
): BetVenueSignalMapping {
  const notes: string[] = [];
  const picksRaw = Number(record.raw["picks"]);
  const combo = comboProfile({
    wagerType: record.wagerType,
    wagerKind: record.wagerKind,
    picks: Number.isFinite(picksRaw) ? picksRaw : null,
    description: record.description,
  });
  const teams = splitEventTeams(record.eventLabel);
  if (combo.isCombo) {
    // A ticket of several legs is not a single venue market: Kalshi has no parlay product and
    // Polymarket's combo product is wallet/RFQ-anchored. Joining one leg would misrepresent it.
    return {
      signal: null,
      refusal: `combo ticket (${combo.code ?? record.wagerKind}${combo.legs === null ? "" : `, ${combo.legs} legs`}, ${combo.composition.kind}): venue joins are single-market; no like-for-like ${combo.venue["kalshi"]?.product === "none" ? "Kalshi" : "venue"} market`,
      league: "UNKNOWN",
      marketKind: record.marketType,
      teams: [],
      notes,
      combo,
    };
  }
  const kindBase = MARKET_KIND[record.marketType] ?? record.marketType;
  const periodToken =
    PERIOD_TOKEN[record.periodLabel.trim().toLowerCase()] ?? "";
  const marketKind =
    kindBase === "moneyline" || kindBase === "spread" || kindBase === "total"
      ? `${periodToken === "" ? "" : `${periodToken}_`}${kindBase}`
      : periodToken === ""
        ? kindBase
        : `${periodToken}_${kindBase}`;

  let league: League = "UNKNOWN";
  if (options.leagueOverride !== undefined) {
    league = options.leagueOverride;
    notes.push(`league supplied by operator (${league})`);
  } else {
    const explicit = record.league.trim().toUpperCase();
    if ((LEAGUES as ReadonlySet<string>).has(explicit)) {
      league = explicit as League;
    } else {
      const inferred = SPORT_TO_LEAGUE[record.sport.trim().toLowerCase()];
      if (inferred !== undefined) {
        league = inferred;
        notes.push(
          `league inferred from sport "${record.sport}" (${league}); pass --league when the sport is ambiguous`,
        );
      }
    }
  }

  if (league === "UNKNOWN") {
    return {
      signal: null,
      refusal:
        "unknown league: the capture names no supported league and --league was not supplied",
      league,
      marketKind,
      teams,
      notes,
      combo,
    };
  }
  if (teams.length !== 2) {
    return {
      signal: null,
      refusal: `need two teams to match a venue market, got ${JSON.stringify(record.eventLabel)}`,
      league,
      marketKind,
      teams,
      notes,
      combo,
    };
  }
  if (marketKind === "" || kindBase === "other" || kindBase === "prop") {
    return {
      signal: null,
      refusal: `unsupported market for a venue join: ${record.marketType}${record.periodLabel === "" ? "" : ` (${record.periodLabel})`}`,
      league,
      marketKind,
      teams,
      notes,
      combo,
    };
  }

  const overUnder: OverUnder | null =
    record.side === "over" ? "over" : record.side === "under" ? "under" : null;
  // `side` on a compact row can be the whole label ("Miami/Golden State -110"): only a value
  // that names exactly one of the two matched teams can be a Kalshi side. Anything else is
  // ambiguous and stays null rather than guessing which side the ticket took.
  const sideText = (record.side ?? "").toLowerCase();
  const namedTeams =
    sideText === ""
      ? []
      : teams.filter((team) => sideText.includes(team.toLowerCase()));
  const sideTeam =
    overUnder === null && namedTeams.length === 1 ? namedTeams[0]! : null;
  const now = options.now ?? new Date();
  const accepted = Date.parse(record.acceptedAt);
  const ageSeconds = Number.isFinite(accepted)
    ? Math.max(0, Math.round((now.getTime() - accepted) / 1000))
    : null;

  const signal: WatchlistSignal = {
    id: record.betKey,
    league,
    marketKind,
    teams,
    sideTeam,
    line: record.line,
    overUnder,
    accounts: [],
    distinctAccounts: 1,
    riskUsd: record.stakeUsd ?? 0,
    oneSidedShare: 1,
    fairProb: record.impliedProb,
    confidence: 50,
    provenance: {
      dataMode: null,
      asOf: record.acceptedAt,
      ageSeconds,
      stale: ageSeconds !== null && ageSeconds > 900,
      fixture: false,
      sources: [record.source],
    },
  };
  return { signal, refusal: null, league, marketKind, teams, notes, combo };
}

export interface VenueBookLevel {
  readonly price: number;
  readonly size: number;
}

export interface KalshiVenueView {
  readonly available: boolean;
  readonly verdict: string;
  readonly reason: string | null;
  readonly seriesTicker: string | null;
  readonly eventTicker: string | null;
  readonly marketTicker: string | null;
  readonly title: string | null;
  readonly side: "YES" | "NO" | null;
  /** Executable probability for the bet's side (0..1). */
  readonly price: number | null;
  readonly edgeBps: number | null;
  readonly liquidity: {
    readonly verdict: string;
    readonly spreadCents: number | null;
    readonly depthContracts: number;
    readonly topSize: number;
    readonly referenceNotionalUsd: number;
  } | null;
  readonly book: {
    readonly yes: VenueBookLevel[];
    readonly no: VenueBookLevel[];
  } | null;
  /** The matched market's resolution rule text, when the venue publishes it. */
  readonly rule: string | null;
}

export interface PolymarketOutcomeView {
  readonly name: string;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly spread: number | null;
  /** Top-of-book notional (price × size) for each side, in USD. */
  readonly bidDepthUsd: number | null;
  readonly askDepthUsd: number | null;
}

export interface PolymarketVenueView {
  readonly available: boolean;
  readonly reason: string | null;
  readonly marketId: string | null;
  readonly question: string | null;
  readonly slug: string | null;
  readonly outcomes: readonly PolymarketOutcomeView[];
  /** The gamma market description (resolution rule), when present. */
  readonly rule: string | null;
}

/** Boolean facts a resolution rule states, extracted by keyword. */
export interface SettlementFlags {
  readonly overtime: boolean;
  readonly shootout: boolean;
  readonly extraInnings: boolean;
  readonly extraTime: boolean;
}

export interface VenueSettlementView {
  readonly rule: string | null;
  readonly flags: SettlementFlags;
}

export interface SettlementComparison {
  readonly kalshi: VenueSettlementView | null;
  readonly polymarket: VenueSettlementView | null;
  /** `match`/`mismatch` only when BOTH rules are present; otherwise `unknown`. */
  readonly verdict: "match" | "mismatch" | "unknown";
  readonly note: string | null;
}

const SETTLEMENT_PATTERNS: Readonly<Record<keyof SettlementFlags, RegExp>> = {
  overtime: /\bovertime\b/i,
  shootout: /\bshootouts?\b/i,
  extraInnings: /\bextra innings?\b/i,
  extraTime: /\bextra time\b/i,
};

/** Classify a resolution rule by the settlement questions that differ between venues. */
export function classifySettlementRule(
  rule: string | null | undefined,
): SettlementFlags {
  const text = rule ?? "";
  return {
    overtime: SETTLEMENT_PATTERNS.overtime.test(text),
    shootout: SETTLEMENT_PATTERNS.shootout.test(text),
    extraInnings: SETTLEMENT_PATTERNS.extraInnings.test(text),
    extraTime: SETTLEMENT_PATTERNS.extraTime.test(text),
  };
}

function settlementView(
  rule: string | null | undefined,
): VenueSettlementView | null {
  const trimmed = (rule ?? "").trim();
  if (trimmed === "") return null;
  return { rule: trimmed, flags: classifySettlementRule(trimmed) };
}

/**
 * Compare the two venues' rule text. This is a keyword comparison, not a full rules engine:
 * equal flags are `match`, differing flags are `mismatch`, and a missing rule on either side is
 * `unknown` — never a silent "equivalent".
 */
export function compareSettlementRules(
  kalshiRule: string | null | undefined,
  polymarketRule: string | null | undefined,
): SettlementComparison {
  const kalshi = settlementView(kalshiRule);
  const polymarket = settlementView(polymarketRule);
  if (kalshi === null || polymarket === null) {
    return {
      kalshi,
      polymarket,
      verdict: "unknown",
      note:
        kalshi === null && polymarket === null
          ? "neither venue published a resolution rule"
          : `${kalshi === null ? "Kalshi" : "Polymarket"} published no resolution rule`,
    };
  }
  const differing = (
    Object.keys(kalshi.flags) as (keyof SettlementFlags)[]
  ).filter((key) => kalshi.flags[key] !== polymarket.flags[key]);
  if (differing.length === 0) {
    return { kalshi, polymarket, verdict: "match", note: null };
  }
  return {
    kalshi,
    polymarket,
    verdict: "mismatch",
    note: `rule text differs on: ${differing.join(", ")}`,
  };
}

export interface BetVenueBreakdown {
  readonly betKey: string;
  readonly eventLabel: string;
  readonly teams: readonly string[];
  readonly league: League;
  readonly sport: string;
  readonly subSport: string;
  readonly period: string;
  readonly marketType: string;
  readonly periodLabel: string;
  readonly line: number | null;
  readonly side: string | null;
  readonly stakeUsd: number | null;
  /** The signal's implied probability from its American odds (null without odds). */
  readonly signalProbability: number | null;
  readonly americanOdds: number | null;
  readonly notes: readonly string[];
  readonly kalshi: KalshiVenueView;
  readonly polymarket: PolymarketVenueView;
  readonly settlement: SettlementComparison;
  readonly combo: ComboProfile;
}

/** The dimensions a breakdown can be grouped by; a closed set so a typo is a usage error. */
export const BREAKDOWN_DIMENSIONS = [
  "sport",
  "league",
  "subsport",
  "period",
  "markettype",
  "market",
] as const;

export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

/** A market label is the market kind + line + period, the finest useful grouping. */
export function marketLabelOf(row: BetVenueBreakdown): string {
  const line = row.line === null ? "" : ` ${row.line}`;
  const period = row.periodLabel === "" ? "" : ` · ${row.periodLabel}`;
  return `${row.marketType}${line}${period}`;
}

/** The value a row contributes to one dimension; missing wire values read "unknown". */
export function dimensionValue(
  row: BetVenueBreakdown,
  dimension: BreakdownDimension,
): string {
  switch (dimension) {
    case "sport":
      return row.sport === "" ? "unknown" : row.sport;
    case "league":
      return row.league === "UNKNOWN" ? "unknown" : row.league;
    case "subsport":
      return row.subSport === "" ? "unknown" : row.subSport;
    case "period":
      return row.periodLabel !== ""
        ? row.periodLabel
        : row.period === ""
          ? "unknown"
          : row.period;
    case "markettype":
      return row.marketType === "" ? "unknown" : row.marketType;
    case "market":
      return marketLabelOf(row);
  }
}

export interface VenueGroup {
  readonly dimension: BreakdownDimension;
  readonly value: string;
  readonly bets: number;
  readonly kalshiMatched: number;
  readonly polymarketMatched: number;
  readonly bothMatched: number;
  readonly kalshiPriced: number;
  /** Mean executable Kalshi probability over the priced rows (0..1), or null. */
  readonly avgKalshiPrice: number | null;
  /** Mean Kalshi spread in cents over the rows that report one, or null. */
  readonly avgKalshiSpreadCents: number | null;
  readonly totalKalshiDepthContracts: number;
  readonly totalStakeUsd: number;
}

function aggregateRows(
  rows: readonly BetVenueBreakdown[],
): Omit<VenueGroup, "dimension" | "value"> {
  const priced = rows
    .map((row) => row.kalshi.price)
    .filter((price): price is number => price !== null);
  const spreads = rows
    .map((row) => row.kalshi.liquidity?.spreadCents ?? null)
    .filter((spread): spread is number => spread !== null);
  const stake = rows.reduce((sum, row) => sum + (row.stakeUsd ?? 0), 0);
  const depth = rows.reduce(
    (sum, row) => sum + (row.kalshi.liquidity?.depthContracts ?? 0),
    0,
  );
  return {
    bets: rows.length,
    kalshiMatched: rows.filter((row) => row.kalshi.available).length,
    polymarketMatched: rows.filter((row) => row.polymarket.available).length,
    bothMatched: rows.filter(
      (row) => row.kalshi.available && row.polymarket.available,
    ).length,
    kalshiPriced: priced.length,
    avgKalshiPrice:
      priced.length === 0
        ? null
        : Math.round(
            (priced.reduce((sum, price) => sum + price, 0) / priced.length) *
              10_000,
          ) / 10_000,
    avgKalshiSpreadCents:
      spreads.length === 0
        ? null
        : Math.round(
            (spreads.reduce((sum, spread) => sum + spread, 0) /
              spreads.length) *
              100,
          ) / 100,
    totalKalshiDepthContracts: Math.round(depth * 100) / 100,
    totalStakeUsd: Math.round(stake * 100) / 100,
  };
}

/**
 * Flat, one-table-per-dimension summary. Every row appears in exactly one group per requested
 * dimension; a matched market counts toward its bet's group, so the totals reconcile with the
 * row count.
 */
export function summarizeBetVenueBreakdowns(
  rows: readonly BetVenueBreakdown[],
  dimensions: readonly BreakdownDimension[],
): VenueGroup[] {
  const groups: VenueGroup[] = [];
  for (const dimension of dimensions) {
    const buckets = new Map<string, BetVenueBreakdown[]>();
    for (const row of rows) {
      const value = dimensionValue(row, dimension);
      const bucket = buckets.get(value);
      if (bucket === undefined) buckets.set(value, [row]);
      else bucket.push(row);
    }
    for (const [value, bucket] of [...buckets.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      groups.push({ dimension, value, ...aggregateRows(bucket) });
    }
  }
  return groups;
}

export interface VenueGroupNode {
  readonly dimension: BreakdownDimension;
  readonly value: string;
  readonly bets: number;
  readonly kalshiMatched: number;
  readonly polymarketMatched: number;
  readonly bothMatched: number;
  readonly kalshiPriced: number;
  readonly avgKalshiPrice: number | null;
  readonly avgKalshiSpreadCents: number | null;
  readonly totalKalshiDepthContracts: number;
  readonly totalStakeUsd: number;
  readonly children: readonly VenueGroupNode[];
}

/** Nested tree in the requested dimension order (e.g. sport → subsport → period → market). */
export function groupBetVenueBreakdowns(
  rows: readonly BetVenueBreakdown[],
  dimensions: readonly BreakdownDimension[],
): VenueGroupNode[] {
  if (dimensions.length === 0) return [];
  const [current, ...rest] = dimensions as [
    BreakdownDimension,
    ...BreakdownDimension[],
  ];
  const buckets = new Map<string, BetVenueBreakdown[]>();
  for (const row of rows) {
    const value = dimensionValue(row, current);
    const bucket = buckets.get(value);
    if (bucket === undefined) buckets.set(value, [row]);
    else bucket.push(row);
  }
  const nodes: VenueGroupNode[] = [];
  for (const [value, bucket] of [...buckets.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    nodes.push({
      dimension: current,
      value,
      ...aggregateRows(bucket),
      children: groupBetVenueBreakdowns(bucket, rest),
    });
  }
  return nodes;
}

export interface VenueBreakdownSeams {
  readonly joinKalshi?: (
    signals: readonly WatchlistSignal[],
  ) => Promise<readonly JoinedSignal[]>;
  readonly quotePolymarket?: (
    teams: readonly string[],
  ) => Promise<PolymarketQuote>;
}

export interface VenueBreakdownOptions {
  readonly venues?: readonly ("kalshi" | "polymarket")[];
  readonly maxBets?: number;
  readonly leagueOverride?: League;
  readonly now?: Date;
  readonly seams?: VenueBreakdownSeams;
}

export interface VenueBreakdownResult {
  readonly breakdowns: readonly BetVenueBreakdown[];
  /** One entry per input record that could not be mapped to a venue signal. */
  readonly refusals: readonly {
    readonly betKey: string;
    readonly reason: string;
  }[];
  readonly telemetry: {
    readonly kalshi: KalshiTelemetry | null;
    readonly polymarket: PolymarketTelemetry | null;
  };
}

function emptyKalshi(reason: string): KalshiVenueView {
  return {
    available: false,
    verdict: "no_market",
    reason,
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
  };
}

function emptyPolymarket(reason: string): PolymarketVenueView {
  return {
    available: false,
    reason,
    marketId: null,
    question: null,
    slug: null,
    outcomes: [],
    rule: null,
  };
}

function topLevels(
  book: KalshiOrderbook,
  side: "yes" | "no",
): VenueBookLevel[] {
  return book[side]
    .slice(0, 3)
    .map((level) => ({ price: level.price, size: level.size }));
}

function kalshiView(
  join: JoinedSignal | undefined,
  refusal: string | null,
): KalshiVenueView {
  if (refusal !== null) return emptyKalshi(refusal);
  if (join === undefined) {
    return emptyKalshi("Kalshi join returned no row for this bet");
  }
  const kalshi: KalshiJoin = join.kalshi;
  const available = kalshi.verdict !== "no_market";
  return {
    available,
    verdict: kalshi.verdict,
    reason: kalshi.reason,
    seriesTicker: kalshi.seriesTicker,
    eventTicker: kalshi.eventTicker,
    marketTicker: kalshi.marketTicker,
    title: kalshi.marketTitle,
    side: kalshi.side,
    price: kalshi.executablePrice,
    edgeBps: kalshi.edgeBps,
    liquidity:
      kalshi.liquidity === null
        ? null
        : {
            verdict: kalshi.liquidity.verdict,
            spreadCents: kalshi.liquidity.spreadCents,
            depthContracts: kalshi.liquidity.depthContracts,
            topSize: kalshi.liquidity.topSize,
            referenceNotionalUsd: kalshi.liquidity.referenceNotionalUsd,
          },
    book:
      kalshi.book === null
        ? null
        : {
            yes: topLevels(kalshi.book, "yes"),
            no: topLevels(kalshi.book, "no"),
          },
    rule: kalshi.rulesPrimary ?? null,
  };
}

/**
 * The public team join searches gamma by team names; a season/futures question ("Will X vs Y be
 * the 2027 NBA Finals matchup?") names both teams too, so it can be returned ahead of the actual
 * game market. A futures price is not this bet's market, so it is refused rather than displayed.
 */
const NON_GAME_QUESTION =
  /\b(finals|championship|champion|playoff|playoffs|season|series|matchup|win the (?:title|cup|championship)|make the playoffs|make the finals)\b/i;

export function looksLikeGameMarket(question: string): boolean {
  return !NON_GAME_QUESTION.test(question);
}

function polymarketView(
  quote: PolymarketQuote | undefined,
): PolymarketVenueView {
  if (quote === undefined) {
    return emptyPolymarket("Polymarket quote unavailable");
  }
  if (!quote.available) {
    return emptyPolymarket(quote.reason);
  }
  if (!looksLikeGameMarket(quote.question)) {
    return emptyPolymarket(
      `matched a season/futures market ("${quote.question}"), not this game; refusing to show a futures price as the game price`,
    );
  }
  return {
    available: true,
    reason: null,
    marketId: quote.marketId,
    question: quote.question,
    slug: quote.slug,
    rule: quote.description ?? null,
    outcomes: quote.outcomes.map((outcome) => {
      const spread =
        outcome.bestBid !== null && outcome.bestAsk !== null
          ? outcome.bestAsk - outcome.bestBid
          : null;
      const topBid = outcome.bids[0];
      const topAsk = outcome.asks[0];
      return {
        name: outcome.name,
        bestBid: outcome.bestBid,
        bestAsk: outcome.bestAsk,
        spread,
        bidDepthUsd:
          topBid === undefined
            ? null
            : Math.round(topBid.price * topBid.size * 100) / 100,
        askDepthUsd:
          topAsk === undefined
            ? null
            : Math.round(topAsk.price * topAsk.size * 100) / 100,
      };
    }),
  };
}

/**
 * Build the cross-venue breakdown for a batch of parsed bets.
 *
 * Records are processed in order up to `maxBets` (default 5; venue reads are network calls).
 * A record that cannot become a venue signal is reported in `refusals` and still appears in
 * `breakdowns` with both venues marked unavailable and the refusal as the reason, so the caller
 * gets one row per bet.
 */
export async function buildBetVenueBreakdown(
  records: readonly IncomingBetRecord[],
  options: VenueBreakdownOptions = {},
): Promise<VenueBreakdownResult> {
  const venues = options.venues ?? ["kalshi", "polymarket"];
  const limit = Math.max(1, Math.trunc(options.maxBets ?? 5));
  const selected = records.slice(0, limit);
  const now = options.now ?? new Date();

  const mappings = selected.map((record) =>
    betToVenueSignal(record, {
      ...(options.leagueOverride === undefined
        ? {}
        : { leagueOverride: options.leagueOverride }),
      now,
    }),
  );

  let kalshiClient: KalshiClient | null = null;
  let polymarketClient: PolymarketQuoteClient | null = null;
  let joined: readonly JoinedSignal[] = [];
  const refusals: { betKey: string; reason: string }[] = [];

  const signals = mappings
    .map((mapping) => mapping.signal)
    .filter((signal): signal is WatchlistSignal => signal !== null);

  if (venues.includes("kalshi") && signals.length > 0) {
    if (options.seams?.joinKalshi !== undefined) {
      joined = await options.seams.joinKalshi(signals);
    } else {
      kalshiClient = new KalshiClient();
      joined = await joinWatchlistSignals(signals, { client: kalshiClient });
    }
  }

  const polymarketBySignal = new Map<string, PolymarketQuote>();
  if (venues.includes("polymarket")) {
    if (options.seams?.quotePolymarket !== undefined) {
      for (const signal of signals) {
        if (signal.marketKind !== "moneyline") {
          polymarketBySignal.set(signal.id, {
            available: false,
            reason:
              "Polymarket team join covers game-winner markets only; this bet's market (total/spread/prop) has no matched market here",
            telemetry: {
              ok: true,
              degraded: false,
              requests: 0,
              cacheHits: 0,
              cacheTtlSec: 0,
              errors: [],
            },
          });
          continue;
        }
        polymarketBySignal.set(
          signal.id,
          await options.seams.quotePolymarket(signal.teams),
        );
      }
    } else {
      polymarketClient = new PolymarketQuoteClient();
      for (const signal of signals) {
        // Polymarket's team join is game-winner only; asking it for a total would pair the bet
        // with a different market. Report the limitation instead.
        if (signal.marketKind !== "moneyline") {
          polymarketBySignal.set(signal.id, {
            available: false,
            reason:
              "Polymarket team join covers game-winner markets only; this bet's market (total/spread/prop) has no matched market here",
            telemetry: polymarketClient.telemetry(),
          });
          continue;
        }
        polymarketBySignal.set(
          signal.id,
          await polymarketClient.quoteForTeams(signal.teams),
        );
      }
    }
  }

  const joinedById = new Map(joined.map((row) => [row.id, row]));
  const breakdowns: BetVenueBreakdown[] = mappings.map((mapping, index) => {
    const record = selected[index]!;
    const signal = mapping.signal;
    if (signal === null) {
      refusals.push({
        betKey: record.betKey,
        reason: mapping.refusal ?? "could not map the bet to a venue signal",
      });
      return {
        betKey: record.betKey,
        eventLabel: record.eventLabel,
        teams: mapping.teams,
        league: mapping.league,
        sport: record.sport,
        subSport: record.subSport,
        period: record.period,
        marketType: record.marketType,
        periodLabel: record.periodLabel,
        line: record.line,
        side: record.side,
        stakeUsd: record.stakeUsd,
        signalProbability: record.impliedProb,
        americanOdds: record.americanOdds,
        notes: mapping.notes,
        kalshi: emptyKalshi(mapping.refusal ?? "unmapped bet"),
        polymarket: emptyPolymarket(mapping.refusal ?? "unmapped bet"),
        settlement: compareSettlementRules(null, null),
        combo: mapping.combo,
      };
    }
    const kalshiJoin = venues.includes("kalshi")
      ? joinedById.get(record.betKey)
      : undefined;
    const polyQuote = venues.includes("polymarket")
      ? polymarketBySignal.get(record.betKey)
      : undefined;
    return {
      betKey: record.betKey,
      eventLabel: record.eventLabel,
      teams: mapping.teams,
      league: mapping.league,
      sport: record.sport,
      subSport: record.subSport,
      period: record.period,
      marketType: record.marketType,
      periodLabel: record.periodLabel,
      line: record.line,
      side: record.side,
      stakeUsd: record.stakeUsd,
      signalProbability: record.impliedProb,
      americanOdds: record.americanOdds,
      notes: mapping.notes,
      kalshi:
        kalshiJoin === undefined
          ? emptyKalshi("kalshi venue not requested")
          : kalshiView(kalshiJoin, null),
      polymarket:
        polyQuote === undefined
          ? emptyPolymarket("polymarket venue not requested")
          : polymarketView(polyQuote),
      settlement: compareSettlementRules(
        kalshiJoin?.kalshi.rulesPrimary,
        polyQuote !== undefined && polyQuote.available
          ? polyQuote.description
          : null,
      ),
      combo: mapping.combo,
    };
  });

  return {
    breakdowns,
    refusals,
    telemetry: {
      kalshi: kalshiClient === null ? null : kalshiClient.telemetry(),
      polymarket:
        polymarketClient === null ? null : polymarketClient.telemetry(),
    },
  };
}
