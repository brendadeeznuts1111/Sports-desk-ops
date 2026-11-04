/**
 * @file lib/polymarket_profile.ts
 * @description Polymarket address profiler, adapted from the public `polymarket-profile` skill.
 *
 * Public APIs only, no key: lb-api (PnL/leaderboard), data-api (positions/activity), gamma-api
 * (categories). All fetchers are injectable for hermetic tests. Activity pagination follows the
 * skill's `end=<last timestamp>` rule, not offsets.
 */

import {
  parsePolymarketPosition,
  parsePositionsEnvelope,
  type PolymarketPosition,
} from "./polymarket_ingest.ts";

/** Retired (HTTP 410). Kept only so callers can recognise stale references. */
export const LB_API = "https://lb-api.polymarket.com";
export const DATA_API = "https://data-api.polymarket.com";
export const GAMMA_API = "https://gamma-api.polymarket.com";

export interface PolymarketActivity {
  readonly type: string;
  readonly slug: string;
  readonly usdcSize: number;
  readonly side: string;
  readonly timestamp: number;
  readonly title: string;
  readonly outcome: string;
  /** Share count; present on TRADE rows and required for the fee residual. */
  readonly size?: number;
  /** Fill price; present on TRADE rows and required for the fee residual. */
  readonly price?: number;
  /** True for combo/CTF fills (`isCombo` on the wire). */
  readonly isCombo?: boolean;
}

export interface ProfileFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly sleepMs?: number;
  readonly maxActivityPages?: number;
  readonly maxCategoryLookups?: number;
  readonly lbBase?: string;
  readonly dataBase?: string;
  readonly gammaBase?: string;
}

export interface PnlSnapshot {
  readonly all: number | null;
  readonly d7: number | null;
  readonly d30: number | null;
  readonly name: string | null;
}

export interface ActivitySummary {
  readonly tradeBuys: number;
  readonly tradeSells: number;
  readonly tradeVolume: number;
  readonly splitVolume: number;
  readonly mergeVolume: number;
  readonly redeemVolume: number;
  readonly comboTrades: number;
  readonly comboTradeVolume: number;
  readonly uniqueMarkets: number;
  readonly firstTimestamp: number | null;
  readonly lastTimestamp: number | null;
}

export interface CategoryBucket {
  readonly category: string;
  readonly positions: number;
  readonly valueUsd: number;
  readonly sharePct: number;
}

export interface StrategyPattern {
  readonly name:
    | "SPLIT Arbitrage"
    | "Market Maker"
    | "Whale / Concentrated"
    | "Diversified"
    | "Small Trader"
    | "Mixed";
  readonly explanation: string;
}

export interface AddressProfile {
  readonly address: string;
  readonly name: string | null;
  readonly pnl: PnlSnapshot;
  readonly positions: readonly PolymarketPosition[];
  readonly activity: ActivitySummary;
  readonly open: readonly PolymarketPosition[];
  readonly wins: number;
  readonly losses: number;
  readonly openCount: number;
  readonly winRate: number | null;
  readonly winRateEstimated: boolean;
  readonly portfolioValueUsd: number;
  readonly investedUsd: number;
  readonly positionsPnlUsd: number;
  readonly categories: readonly CategoryBucket[];
  readonly topWins: readonly PolymarketPosition[];
  readonly topLosses: readonly PolymarketPosition[];
  readonly strategy: StrategyPattern;
  readonly pnlAudit: PnlAudit;
  readonly pagesFetched: number;
  readonly activityTruncated: boolean;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function requestJson(
  url: string,
  options?: ProfileFetchOptions,
): Promise<unknown> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    proxy: false,
    signal: AbortSignal.timeout(options?.timeoutMs ?? 15_000),
  } as RequestInit);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : Bun.sleep(ms);

/**
 * Resolves a 0x address, or a leaderboard username → wallet (3 cursor pages, 1500 users).
 * The old `lb-api` is retired (HTTP 410, `[OBSERVED]` 2026-10-31); this uses
 * `data-api/v2/leaderboard`, which is cursor-based.
 */
export async function resolvePolymarketAddress(
  input: string,
  options?: ProfileFetchOptions,
): Promise<string | null> {
  const trimmed = input.trim();
  if (ADDRESS_PATTERN.test(trimmed)) return trimmed.toLowerCase();
  const needle = trimmed.replace(/^@/, "").toLowerCase();
  if (needle === "") return null;
  const base = (options?.dataBase ?? DATA_API).replace(/\/$/, "");
  let cursor: string | null = null;
  for (let page = 0; page < 3; page += 1) {
    const suffix =
      cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const body: unknown = await requestJson(
      `${base}/v2/leaderboard?window=all&limit=500${suffix}`,
      options,
    );
    const record = asRecord(body);
    const rows = Array.isArray(record?.data) ? (record.data as unknown[]) : [];
    if (rows.length === 0) return null;
    for (const row of rows) {
      const entry = asRecord(row);
      if (entry === null) continue;
      const name = (
        str(entry.user_name) ||
        str(entry.name) ||
        str(entry.pseudonym)
      ).toLowerCase();
      const wallet = str(entry.user_id) || str(entry.proxyWallet);
      if (wallet !== "" && name === needle) return wallet.toLowerCase();
    }
    const pagination = asRecord(record?.pagination);
    const next = str(pagination?.next_cursor);
    if (next === "") return null;
    cursor = next;
  }
  return null;
}

/**
 * PnL snapshot from the v2 leaderboard single-user lookup.
 *
 * `lb-api.polymarket.com/profit` is retired (HTTP 410, `[OBSERVED]` 2026-10-31).
 * `data-api/v2/leaderboard?user=<0x>`
 * returns one object and honours `time_period`: `all` = lifetime, `month` = 30d, `week` = 7d.
 * Omitting `time_period` behaves like `day`, so it is never used here.
 */
async function fetchPnlWindow(
  address: string,
  window: "all" | "7d" | "30d",
  options?: ProfileFetchOptions,
): Promise<{ amount: number | null; name: string | null }> {
  const base = (options?.dataBase ?? DATA_API).replace(/\/$/, "");
  const period = window === "all" ? "all" : window === "7d" ? "week" : "month";
  try {
    const body: unknown = await requestJson(
      `${base}/v2/leaderboard?user=${address}&time_period=${period}`,
      options,
    );
    const record = asRecord(body);
    const row = asRecord(record?.data);
    if (row === null) return { amount: null, name: null };
    return { amount: num(row.pnl), name: str(row.user_name) || null };
  } catch {
    return { amount: null, name: null };
  }
}

export async function fetchPnlSnapshot(
  address: string,
  options?: ProfileFetchOptions,
): Promise<PnlSnapshot> {
  const [all, d7, d30] = await Promise.all([
    fetchPnlWindow(address, "all", options),
    fetchPnlWindow(address, "7d", options),
    fetchPnlWindow(address, "30d", options),
  ]);
  return {
    all: all.amount,
    d7: d7.amount,
    d30: d30.amount,
    name: all.name ?? d7.name ?? d30.name,
  };
}

/**
 * Positions from Data API v2, cursor paginated: 500 first-page rows, 3 pages max.
 *
 * The retired v1 route returned a bare array with `offset`; this requests `/v2/positions` and
 * follows `pagination.next_cursor`. A bare array is still tolerated here only so captured
 * fixtures replay — every live request is v2.
 */
export async function fetchProfilePositions(
  address: string,
  options?: ProfileFetchOptions,
): Promise<PolymarketPosition[]> {
  const base = (options?.dataBase ?? DATA_API).replace(/\/$/, "");
  const positions: PolymarketPosition[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 3; page += 1) {
    const params = new URLSearchParams({ user: address });
    // `limit` applies to the first page only; the cursor binds the page size thereafter.
    if (cursor === null) params.set("limit", "500");
    else params.set("cursor", cursor);
    const body: unknown = await requestJson(
      `${base}/v2/positions?${params.toString()}`,
      options,
    );
    const envelope = parsePositionsEnvelope(body);
    const rows =
      envelope !== null ? envelope.rows : Array.isArray(body) ? body : [];
    for (const row of rows) {
      const parsed = parsePolymarketPosition(row);
      if (parsed !== null) positions.push(parsed);
    }
    if (
      envelope === null ||
      !envelope.hasMore ||
      envelope.nextCursor === null
    ) {
      break;
    }
    cursor = envelope.nextCursor;
  }
  return positions;
}

function parseActivity(row: unknown): PolymarketActivity | null {
  const record = asRecord(row);
  if (record === null) return null;
  const type = str(record.type).toUpperCase();
  const slug =
    str(record.slug) || str(record.eventSlug) || str(record.conditionId);
  if (type === "" || slug === "") return null;
  return {
    type,
    slug,
    usdcSize: num(record.usdcSize),
    side: str(record.side).toUpperCase(),
    timestamp: num(record.timestamp),
    title: str(record.title),
    outcome: str(record.outcome),
    ...(record.size === undefined ? {} : { size: num(record.size) }),
    ...(record.price === undefined ? {} : { price: num(record.price) }),
    isCombo: record.isCombo === true,
  };
}

/** Activity paginated by the last timestamp (`end=`), 500/page, capped. */
export async function fetchProfileActivity(
  address: string,
  options?: ProfileFetchOptions,
): Promise<{ rows: PolymarketActivity[]; pages: number; truncated: boolean }> {
  const base = (options?.dataBase ?? DATA_API).replace(/\/$/, "");
  const maxPages = Math.max(1, options?.maxActivityPages ?? 40);
  const rows: PolymarketActivity[] = [];
  let end: number | null = null;
  let pages = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const suffix = end === null ? "" : `&end=${end}`;
    const body: unknown = await requestJson(
      `${base}/activity?user=${address}&limit=500${suffix}`,
      options,
    );
    if (!Array.isArray(body) || body.length === 0) break;
    pages += 1;
    let lastTimestamp: number | null = end;
    for (const raw of body) {
      const parsed = parseActivity(raw);
      if (parsed !== null) rows.push(parsed);
      const record = asRecord(raw);
      if (record !== null)
        lastTimestamp = num(record.timestamp) || lastTimestamp;
    }
    if (body.length < 500) break;
    if (lastTimestamp === null || (end !== null && lastTimestamp >= end)) break;
    end = lastTimestamp;
    if (page < maxPages - 1) await sleep(options?.sleepMs ?? 500);
  }
  return { rows, pages, truncated: pages >= maxPages };
}

const CATEGORY_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/crypto|bitcoin|ethereum|\bbtc\b|\beth\b|nft/i, "Crypto"],
  [/election|president|congress|senate|trump|biden|party|politic/i, "Politics"],
  [/ukraine|russia|iran|war|military|invasion|geopolit/i, "Geopolitics"],
  [/business|gdp|\boil\b|fed\b|rate|inflation|finance|stock/i, "Finance"],
  [/pop.culture|art\b|coronavirus|culture|movie|music/i, "Culture"],
  [
    /temperature|weather|celsius|fahrenheit|rain|snow|storm|hurricane/i,
    "Weather",
  ],
  [/\bai\b|tech|spacex|openai|nvidia/i, "Tech"],
  [/musk|tweet/i, "Musk/Tweets"],
  [
    /nba|nfl|mlb|nhl|soccer|football|basketball|tennis|ufc|sports|fifa|olympic/i,
    "Sports",
  ],
];

/** Maps a Gamma category/tag/title to a display category. */
export function inferCategory(
  gammaCategory: string,
  tags: readonly string[],
  title: string,
): string {
  const haystack = [gammaCategory, ...tags, title].join(" ");
  for (const [pattern, label] of CATEGORY_RULES) {
    if (pattern.test(haystack)) return label;
  }
  return "Other";
}

/** Best-effort category lookup; returns a slug→category map, falling back to title inference. */
export async function fetchCategories(
  positions: readonly PolymarketPosition[],
  options?: ProfileFetchOptions,
): Promise<Map<string, string>> {
  const base = (options?.gammaBase ?? GAMMA_API).replace(/\/$/, "");
  const bySlug = new Map<string, string>();
  const slugs = [
    ...new Set(
      positions.map((position) => position.slug).filter((slug) => slug !== ""),
    ),
  ];
  const cap = Math.min(
    slugs.length,
    Math.max(0, options?.maxCategoryLookups ?? 60),
  );
  for (const slug of slugs.slice(cap)) {
    const sample = positions.find((position) => position.slug === slug);
    bySlug.set(slug, inferCategory("", [], sample?.title ?? ""));
  }
  for (let index = 0; index < cap; index += 4) {
    await Promise.all(
      slugs.slice(index, index + 4).map(async (slug) => {
        const sample = positions.find((position) => position.slug === slug);
        try {
          const body: unknown = await requestJson(
            `${base}/events?slug=${encodeURIComponent(slug)}`,
            options,
          );
          const event = Array.isArray(body) ? asRecord(body[0]) : null;
          const tags = Array.isArray(event?.tags)
            ? (event.tags as unknown[])
                .map((tag) => str(asRecord(tag)?.label))
                .filter((label) => label !== "")
            : [];
          bySlug.set(
            slug,
            inferCategory(str(event?.category), tags, sample?.title ?? ""),
          );
        } catch {
          bySlug.set(slug, inferCategory("", [], sample?.title ?? ""));
        }
      }),
    );
  }
  return bySlug;
}

export function summarizeActivity(
  rows: readonly PolymarketActivity[],
): ActivitySummary {
  let tradeBuys = 0;
  let tradeSells = 0;
  let tradeVolume = 0;
  let splitVolume = 0;
  let mergeVolume = 0;
  let redeemVolume = 0;
  let comboTrades = 0;
  let comboTradeVolume = 0;
  const markets = new Set<string>();
  let first: number | null = null;
  let last: number | null = null;
  for (const row of rows) {
    markets.add(row.slug);
    if (row.timestamp > 0) {
      first = first === null ? row.timestamp : Math.min(first, row.timestamp);
      last = last === null ? row.timestamp : Math.max(last, row.timestamp);
    }
    if (row.type === "TRADE") {
      tradeVolume += row.usdcSize;
      if (row.side === "SELL") tradeSells += 1;
      else tradeBuys += 1;
      if (row.isCombo === true) {
        comboTrades += 1;
        comboTradeVolume += row.usdcSize;
      }
    } else if (row.type === "SPLIT") splitVolume += row.usdcSize;
    else if (row.type === "MERGE") mergeVolume += row.usdcSize;
    else if (row.type === "REDEEM") redeemVolume += row.usdcSize;
  }
  return {
    tradeBuys,
    tradeSells,
    tradeVolume,
    splitVolume,
    mergeVolume,
    redeemVolume,
    comboTrades,
    comboTradeVolume,
    uniqueMarkets: markets.size,
    firstTimestamp: first,
    lastTimestamp: last,
  };
}

// ============================================================================
// FEE-AWARE PNL AUDIT
// ============================================================================

export interface PnlAudit {
  /** Cashflow PnL: (SELL + REDEEM + MERGE + REBATE) − (BUY + SPLIT) + open value. */
  readonly cashflowPnlUsd: number | null;
  readonly grossInUsd: number;
  readonly grossOutUsd: number;
  readonly openValueUsd: number;
  readonly lbApiPnlUsd: number | null;
  /** `cashflowPnl − lbApiPnl`; positive means the official number understates net. */
  readonly gapUsd: number | null;
  readonly gapPct: number | null;
  /** Residual of `usdcSize` vs `size × price` on TRADE rows; a lower bound on taker fees. */
  readonly feeResidualUsd: number | null;
  readonly feeRows: number;
  readonly tradeRows: number;
  /** False when activity pagination stopped early, which makes the cashflow number partial. */
  readonly complete: boolean;
  readonly reason: string | null;
}

const INFLOW_TYPES = new Set(["SELL", "REDEEM", "MERGE", "REBATE"]);
const OUTFLOW_TYPES = new Set(["BUY", "SPLIT"]);

/**
 * Reconstructs a fee-aware PnL from the activity log and compares it with the official
 * (pre-fee) leaderboard number.
 *
 * `complete: false` when pagination was truncated — the cashflow number is then `null`
 * rather than a partial figure that would look authoritative.
 */
export function auditActivityPnl(
  rows: readonly PolymarketActivity[],
  openValueUsd: number,
  options?: {
    readonly lbApiPnlUsd?: number | null;
    readonly activityTruncated?: boolean;
  },
): PnlAudit {
  const truncated = options?.activityTruncated === true;
  const lbApiPnlUsd = options?.lbApiPnlUsd ?? null;
  let grossIn = 0;
  let grossOut = 0;
  let feeResidual = 0;
  let feeRows = 0;
  let tradeRows = 0;

  for (const row of rows) {
    const directional = row.type === "TRADE" ? row.side : row.type;
    if (INFLOW_TYPES.has(directional)) grossIn += row.usdcSize;
    else if (OUTFLOW_TYPES.has(directional)) grossOut += row.usdcSize;

    if (
      row.type === "TRADE" &&
      row.size !== undefined &&
      row.price !== undefined
    ) {
      tradeRows += 1;
      const notional = row.size * row.price;
      if (notional > 0) {
        const residual =
          row.side === "SELL"
            ? notional - row.usdcSize
            : row.usdcSize - notional;
        if (residual > 0.005) {
          feeResidual += residual;
          feeRows += 1;
        }
      }
    }
  }

  const complete = !truncated && rows.length > 0;
  const cashflowPnlUsd = complete
    ? round2(grossIn - grossOut + openValueUsd)
    : null;
  const gapUsd =
    cashflowPnlUsd === null || lbApiPnlUsd === null
      ? null
      : round2(cashflowPnlUsd - lbApiPnlUsd);
  const gapPct =
    gapUsd === null || lbApiPnlUsd === null || lbApiPnlUsd === 0
      ? null
      : round2((gapUsd / Math.abs(lbApiPnlUsd)) * 100);

  return {
    cashflowPnlUsd,
    grossInUsd: round2(grossIn),
    grossOutUsd: round2(grossOut),
    openValueUsd: round2(openValueUsd),
    lbApiPnlUsd,
    gapUsd,
    gapPct,
    feeResidualUsd: tradeRows === 0 ? null : round2(feeResidual),
    feeRows,
    tradeRows,
    complete,
    reason: complete
      ? null
      : truncated
        ? "ACTIVITY_TRUNCATED: pagination stopped early, cashflow PnL withheld"
        : "NO_ACTIVITY_ROWS: nothing to replay",
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function chooseStrategy(
  activity: ActivitySummary,
  positions: readonly PolymarketPosition[],
  open: readonly PolymarketPosition[],
  portfolioValue: number,
): StrategyPattern {
  const tradeCount = activity.tradeBuys + activity.tradeSells;
  const avgTrade = tradeCount > 0 ? activity.tradeVolume / tradeCount : 0;
  const invested = positions.reduce(
    (sum, position) => sum + position.initialValue,
    0,
  );
  const top3 = [...open]
    .sort((a, b) => b.currentValue - a.currentValue)
    .slice(0, 3)
    .reduce((sum, position) => sum + position.currentValue, 0);
  const concentration = portfolioValue > 0 ? (top3 / portfolioValue) * 100 : 0;

  if (
    activity.splitVolume > activity.tradeVolume * 0.2 &&
    activity.mergeVolume > 0
  ) {
    return {
      name: "SPLIT Arbitrage",
      explanation:
        "Enters by splitting USDC into YES+NO pairs and exits via MERGE or a one-sided sell — capital-efficient and largely market-neutral.",
    };
  }
  if (tradeCount > 500 && activity.uniqueMarkets < 15 && avgTrade < 20) {
    return {
      name: "Market Maker",
      explanation:
        "High-frequency, small tickets concentrated in a handful of markets — liquidity provision rather than directional risk.",
    };
  }
  if (concentration > 60 && activity.uniqueMarkets < 10) {
    return {
      name: "Whale / Concentrated",
      explanation:
        "Most capital sits in a few markets — high-conviction directional exposure.",
    };
  }
  if (activity.uniqueMarkets > 50) {
    return {
      name: "Diversified",
      explanation:
        "Spread across many markets — a portfolio approach with lower per-market risk.",
    };
  }
  if (tradeCount < 50 && invested < 500) {
    return {
      name: "Small Trader",
      explanation: "Limited activity — a new or casual account.",
    };
  }
  return {
    name: "Mixed",
    explanation:
      "No single dominant pattern across trades, markets and concentration.",
  };
}

export function buildAddressProfile(input: {
  readonly address: string;
  readonly pnl: PnlSnapshot;
  readonly positions: readonly PolymarketPosition[];
  readonly activity: readonly PolymarketActivity[];
  readonly categories: ReadonlyMap<string, string>;
  readonly pagesFetched: number;
  readonly activityTruncated: boolean;
}): AddressProfile {
  const { positions, activity } = input;
  const open = positions.filter(
    (position) => !position.redeemable && position.currentValue > 0,
  );
  const won = positions.filter(
    (position) => position.redeemable && position.currentValue > 0,
  );
  const lost = positions.filter(
    (position) => position.redeemable && position.currentValue === 0,
  );
  const portfolioValue = open.reduce(
    (sum, position) => sum + position.currentValue,
    0,
  );

  let wins = won.length;
  let losses = lost.length;
  let estimated = false;
  if (wins + losses < 3) {
    const redeemed = new Set(
      activity
        .filter((row) => row.type === "REDEEM" && row.usdcSize > 0)
        .map((row) => row.slug),
    );
    const traded = new Set(
      activity
        .filter((row) => row.type === "TRADE" && row.side !== "SELL")
        .map((row) => row.slug),
    );
    wins = redeemed.size;
    losses = [...traded].filter((slug) => !redeemed.has(slug)).length;
    estimated = wins + losses > 0;
  }

  const categoryMap = new Map<
    string,
    { positions: number; valueUsd: number }
  >();
  for (const position of open) {
    const category = input.categories.get(position.slug) ?? "Other";
    const bucket = categoryMap.get(category) ?? { positions: 0, valueUsd: 0 };
    bucket.positions += 1;
    bucket.valueUsd += position.currentValue;
    categoryMap.set(category, bucket);
  }
  const categories: CategoryBucket[] = [...categoryMap.entries()]
    .map(([category, bucket]) => ({
      category,
      positions: bucket.positions,
      valueUsd: Math.round(bucket.valueUsd * 100) / 100,
      sharePct:
        portfolioValue > 0
          ? Math.round((bucket.valueUsd / portfolioValue) * 1000) / 10
          : 0,
    }))
    .sort((a, b) => b.valueUsd - a.valueUsd);

  const settled = positions.filter((position) => position.redeemable);
  const topWins = [...settled]
    .sort((a, b) => b.cashPnl - a.cashPnl)
    .slice(0, 5);
  const topLosses = [...settled]
    .sort((a, b) => a.cashPnl - b.cashPnl)
    .slice(0, 5);
  const activitySummary = summarizeActivity(activity);
  const invested = positions.reduce(
    (sum, position) => sum + position.initialValue,
    0,
  );

  return {
    address: input.address.toLowerCase(),
    name: input.pnl.name,
    pnl: input.pnl,
    positions,
    activity: activitySummary,
    open,
    wins,
    losses,
    openCount: open.length,
    winRate:
      wins + losses > 0
        ? Math.round((wins / (wins + losses)) * 1000) / 10
        : null,
    winRateEstimated: estimated,
    portfolioValueUsd: Math.round(portfolioValue * 100) / 100,
    investedUsd: Math.round(invested * 100) / 100,
    positionsPnlUsd:
      Math.round(
        positions.reduce((sum, position) => sum + position.cashPnl, 0) * 100,
      ) / 100,
    categories,
    topWins,
    topLosses,
    strategy: chooseStrategy(activitySummary, positions, open, portfolioValue),
    pnlAudit: auditActivityPnl(input.activity, portfolioValue, {
      lbApiPnlUsd: input.pnl.all,
      activityTruncated: input.activityTruncated,
    }),
    pagesFetched: input.pagesFetched,
    activityTruncated: input.activityTruncated,
  };
}

/** One call that resolves, fetches and builds a profile. */
export async function profilePolymarketAddress(
  input: string,
  options?: ProfileFetchOptions,
): Promise<AddressProfile | null> {
  const address = await resolvePolymarketAddress(input, options);
  if (address === null) return null;
  const [pnl, positions, activityResult] = await Promise.all([
    fetchPnlSnapshot(address, options),
    fetchProfilePositions(address, options),
    fetchProfileActivity(address, options),
  ]);
  const categories = await fetchCategories(positions, options);
  return buildAddressProfile({
    address,
    pnl,
    positions,
    activity: activityResult.rows,
    categories,
    pagesFetched: activityResult.pages,
    activityTruncated: activityResult.truncated,
  });
}
