/**
 * @file lib/polymarket_combo.ts
 * @description Polymarket CFB combo discovery and product-of-legs pricing.
 *
 * Discovery is user-anchored: `v2/positions/combos` and `v2/activity/combos` take a wallet. CFB
 * markets come from Gamma `events?series_id=12756`. Fair price = product of leg probabilities,
 * which assumes independent legs (different games) and uses raw implied prices (vig included).
 */

export const GAMMA_API = "https://gamma-api.polymarket.com";
export const COMBO_DATA_API = "https://data-api.polymarket.com";
export const CFB_SERIES_ID = 12756;

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ComboLeg {
  readonly eventSlug: string;
  readonly marketSlug: string;
  readonly question: string;
  readonly marketType: string;
  readonly line: number | null;
  readonly outcome: string;
  readonly outcomeIndex: number;
  readonly price: number;
}

export interface ComboEvent {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly startTime: string | null;
  readonly legs: readonly ComboLeg[];
}

export interface ComboPrice {
  readonly legPrices: readonly number[];
  readonly fairPrice: number;
  readonly payoutMultiple: number;
  readonly stakeUsd: number;
  readonly payoutUsd: number;
  readonly quotedPrice: number | null;
  readonly quotedPayoutUsd: number | null;
  readonly makerMarginPct: number | null;
}

export interface ComboPositionLeg {
  readonly index: number;
  readonly conditionId: string;
  readonly outcome: string;
  readonly status: string;
  readonly currentPrice: number | null;
  readonly marketSlug: string;
  readonly marketType: string;
  readonly line: number | null;
}

export interface ComboPosition {
  readonly comboConditionId: string;
  readonly positionId: string;
  readonly wallet: string;
  readonly outcome: string;
  readonly size: number;
  readonly entryAvgPrice: number;
  readonly entryCostUsd: number;
  readonly status: string;
  readonly redeemable: boolean;
  readonly legsTotal: number;
  readonly legsResolved: number;
  readonly legsPending: number;
  readonly firstEntryAt: string | null;
  readonly legs: readonly ComboPositionLeg[];
}

export interface ComboActivityRow {
  readonly id: string;
  readonly type: string;
  readonly wallet: string;
  readonly amountUsd: number;
  readonly payoutUsd: number | null;
  readonly timestamp: number;
  readonly comboConditionId: string;
  readonly legs: readonly ComboPositionLeg[];
}

export interface ComboWalletSummary {
  readonly wallet: string;
  readonly positions: readonly ComboPosition[];
  readonly activity: readonly ComboActivityRow[];
  readonly openPositions: number;
  readonly openCostUsd: number;
  readonly activityByType: Readonly<
    Record<string, { count: number; amountUsd: number }>
  >;
  readonly pages: number;
  readonly truncated: boolean;
}

export interface ComboFetchOptions {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly gammaBase?: string;
  readonly dataBase?: string;
  readonly limit?: number;
  readonly maxPages?: number;
  readonly sleepMs?: number;
  /** Skip events whose startTime is not in the future (default false; the CLI enables it). */
  readonly pregameOnly?: boolean;
  readonly now?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const text = (value: unknown): string =>
  typeof value === "string"
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : "";

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Gamma returns `outcomes`/`outcomePrices` as JSON strings; accept arrays too. */
export function parseStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.map((entry) => text(entry));
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => text(entry)) : [];
  } catch {
    return [];
  }
}

async function getJson(
  url: string,
  options?: ComboFetchOptions,
): Promise<unknown> {
  const response = await (options?.fetchImpl ?? fetch)(url, {
    proxy: false,
    signal: AbortSignal.timeout(options?.timeoutMs ?? 15_000),
  } as RequestInit);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : Bun.sleep(ms);

const ELIGIBLE_TYPES = new Set(["moneyline", "spreads", "totals"]);

/** Extracts every priced side (not just the first) for ML, spread and total markets. */
export function extractComboLegs(event: Record<string, unknown>): ComboLeg[] {
  const markets = Array.isArray(event.markets) ? event.markets : [];
  const legs: ComboLeg[] = [];
  for (const rawMarket of markets) {
    const market = asRecord(rawMarket);
    if (market === null) continue;
    const marketType = text(market.sportsMarketType).toLowerCase();
    if (!ELIGIBLE_TYPES.has(marketType)) continue;
    if (market.closed === true) continue;
    if (market.acceptingOrders === false) continue;
    if (
      market.comboStatus !== undefined &&
      text(market.comboStatus) !== "enabled"
    )
      continue;
    const outcomes = parseStringArray(market.outcomes);
    const prices = parseStringArray(market.outcomePrices);
    if (outcomes.length === 0 || prices.length === 0) continue;
    const line =
      numberOrNull(market.line) ??
      numberOrNull(market.spread) ??
      numberOrNull(market.total);
    for (
      let index = 0;
      index < Math.min(outcomes.length, prices.length);
      index += 1
    ) {
      const price = Number(prices[index]);
      if (!Number.isFinite(price) || price <= 0 || price >= 1) continue;
      legs.push({
        eventSlug: text(event.slug),
        marketSlug: text(market.slug),
        question: text(market.question),
        marketType,
        line,
        outcome: outcomes[index]!,
        outcomeIndex: index,
        price,
      });
    }
  }
  return legs;
}

/** Fetches active CFB events (series 12756) with their priced legs. */
export async function fetchCfbComboEvents(
  options?: ComboFetchOptions,
): Promise<ComboEvent[]> {
  const base = (options?.gammaBase ?? GAMMA_API).replace(/\/$/, "");
  const limit = Math.min(Math.max(options?.limit ?? 5, 1), 50);
  const body = await getJson(
    `${base}/events?series_id=${CFB_SERIES_ID}&active=true&closed=false&order=volume24hr&ascending=false&limit=${limit}`,
    options,
  );
  if (!Array.isArray(body)) return [];
  const now = options?.now ?? Date.now();
  return body
    .map((raw): ComboEvent | null => {
      const event = asRecord(raw);
      if (event === null) return null;
      const slug = text(event.slug);
      if (slug === "") return null;
      const startTime = text(event.startTime) || null;
      if (
        options?.pregameOnly === true &&
        startTime !== null &&
        Date.parse(startTime) <= now
      ) {
        return null;
      }
      return {
        id: text(event.id),
        slug,
        title: text(event.title),
        startTime,
        legs: extractComboLegs(event),
      };
    })
    .filter((event): event is ComboEvent => event !== null);
}

/** Product-of-legs fair price with stake/payout and optional quote margin. */
export function priceCombo(
  legPrices: readonly number[],
  options?: {
    readonly stakeUsd?: number;
    readonly quotedPrice?: number | null;
  },
): ComboPrice {
  if (legPrices.length < 2) throw new Error("a combo needs at least two legs");
  for (const price of legPrices) {
    if (!Number.isFinite(price) || price <= 0 || price >= 1) {
      throw new Error(`invalid leg price: ${price}`);
    }
  }
  const fairPrice = legPrices.reduce((product, price) => product * price, 1);
  const stakeUsd = options?.stakeUsd ?? 10;
  const quotedPrice = options?.quotedPrice ?? null;
  return {
    legPrices: [...legPrices],
    fairPrice,
    payoutMultiple: 1 / fairPrice,
    stakeUsd,
    payoutUsd: stakeUsd / fairPrice,
    quotedPrice,
    quotedPayoutUsd:
      quotedPrice !== null && Number.isFinite(quotedPrice) && quotedPrice > 0
        ? stakeUsd / quotedPrice
        : null,
    makerMarginPct:
      quotedPrice !== null && Number.isFinite(quotedPrice) && quotedPrice > 0
        ? (quotedPrice / fairPrice - 1) * 100
        : null,
  };
}

/** Parses `"0.38,0.8"` into prices. */
export function parsePriceList(value: string): number[] {
  return value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((price) => Number.isFinite(price));
}

/**
 * Resolves `"<marketSlug>=<outcome>"` specs against fetched events.
 * Returns the matched legs plus any specs that did not match.
 */
export function resolveLegSpecs(
  specs: readonly string[],
  events: readonly ComboEvent[],
): { legs: ComboLeg[]; missing: string[] } {
  const legs: ComboLeg[] = [];
  const missing: string[] = [];
  for (const spec of specs) {
    const separator = spec.lastIndexOf("=");
    if (separator === -1) {
      missing.push(spec);
      continue;
    }
    const marketSlug = spec.slice(0, separator).trim().toLowerCase();
    const outcome = spec
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    let found: ComboLeg | null = null;
    for (const event of events) {
      for (const leg of event.legs) {
        if (
          leg.marketSlug.toLowerCase() === marketSlug &&
          leg.outcome.toLowerCase() === outcome
        ) {
          found = leg;
          break;
        }
      }
      if (found !== null) break;
    }
    if (found === null) missing.push(spec);
    else legs.push(found);
  }
  return { legs, missing };
}

function parseLeg(
  raw: unknown,
  fallbackIndex: number,
): ComboPositionLeg | null {
  const leg = asRecord(raw);
  if (leg === null) return null;
  const market = asRecord(leg.market);
  return {
    index: Number.isFinite(Number(leg.leg_index))
      ? Number(leg.leg_index)
      : fallbackIndex,
    conditionId: text(leg.leg_condition_id),
    outcome: text(leg.leg_outcome_label) || text(market?.outcome),
    status: text(leg.leg_status).toUpperCase(),
    currentPrice: numberOrNull(leg.leg_current_price),
    marketSlug: text(market?.slug),
    marketType: text(market?.sports_market_type),
    line: numberOrNull(market?.line),
  };
}

export function normalizeComboPosition(raw: unknown): ComboPosition | null {
  const row = asRecord(raw);
  if (row === null) return null;
  const conditionId = text(row.combo_condition_id);
  const positionId = text(row.combo_position_id);
  if (conditionId === "" || positionId === "") return null;
  const legs = Array.isArray(row.legs)
    ? row.legs
        .map((leg, index) => parseLeg(leg, index))
        .filter((leg): leg is ComboPositionLeg => leg !== null)
    : [];
  return {
    comboConditionId: conditionId,
    positionId,
    wallet: text(row.proxy_wallet),
    outcome: text(row.outcome_label),
    size: numberOrNull(row.current_size) ?? 0,
    entryAvgPrice: numberOrNull(row.entry_avg_price_usdc) ?? 0,
    entryCostUsd: numberOrNull(row.entry_cost_usdc) ?? 0,
    status: text(row.status).toUpperCase(),
    redeemable: row.redeemable === true,
    legsTotal: numberOrNull(row.legs_total) ?? legs.length,
    legsResolved: numberOrNull(row.legs_resolved) ?? 0,
    legsPending: numberOrNull(row.legs_pending) ?? 0,
    firstEntryAt: text(row.first_entry_at) || null,
    legs,
  };
}

export function normalizeComboActivity(raw: unknown): ComboActivityRow | null {
  const row = asRecord(raw);
  if (row === null) return null;
  const id = text(row.id);
  if (id === "") return null;
  const legs = Array.isArray(row.legs)
    ? row.legs
        .map((leg, index) => parseLeg(leg, index))
        .filter((leg): leg is ComboPositionLeg => leg !== null)
    : [];
  return {
    id,
    type: text(row.type).toUpperCase(),
    wallet: text(row.proxy_wallet),
    amountUsd: numberOrNull(row.amount_usdc) ?? 0,
    payoutUsd: numberOrNull(row.payout_usdc),
    timestamp: numberOrNull(row.timestamp) ?? 0,
    comboConditionId: text(row.combo_condition_id),
    legs,
  };
}

async function fetchCursorPages(
  url: string,
  options?: ComboFetchOptions,
): Promise<{ rows: unknown[]; pages: number; truncated: boolean }> {
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
  const maxPages = Math.max(1, options?.maxPages ?? 5);
  const rows: unknown[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const separator = url.includes("?") ? "&" : "?";
    const suffix =
      cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const body = await getJson(
      `${url}${separator}limit=${limit}${suffix}`,
      options,
    );
    const record = asRecord(body);
    const data = Array.isArray(record?.data) ? (record.data as unknown[]) : [];
    pages += 1;
    rows.push(...data);
    const next = asRecord(record?.pagination);
    const nextCursor = text(next?.next_cursor);
    if (data.length === 0 || nextCursor === "") break;
    cursor = nextCursor;
    if (page < maxPages - 1) await sleep(options?.sleepMs ?? 0);
  }
  return { rows, pages, truncated: pages >= maxPages };
}

export async function fetchComboPositions(
  wallet: string,
  options?: ComboFetchOptions,
): Promise<{ positions: ComboPosition[]; pages: number; truncated: boolean }> {
  const base = (options?.dataBase ?? COMBO_DATA_API).replace(/\/$/, "");
  const result = await fetchCursorPages(
    `${base}/v2/positions/combos?user=${encodeURIComponent(wallet)}`,
    options,
  );
  return {
    positions: result.rows
      .map(normalizeComboPosition)
      .filter((position): position is ComboPosition => position !== null),
    pages: result.pages,
    truncated: result.truncated,
  };
}

export async function fetchComboActivity(
  wallet: string,
  options?: ComboFetchOptions,
): Promise<{
  activity: ComboActivityRow[];
  pages: number;
  truncated: boolean;
}> {
  const base = (options?.dataBase ?? COMBO_DATA_API).replace(/\/$/, "");
  const result = await fetchCursorPages(
    `${base}/v2/activity/combos?user=${encodeURIComponent(wallet)}`,
    options,
  );
  return {
    activity: result.rows
      .map(normalizeComboActivity)
      .filter((row): row is ComboActivityRow => row !== null),
    pages: result.pages,
    truncated: result.truncated,
  };
}

/** Wallet-level combo summary: open cost, counts, and activity by type. */
export async function summarizeComboWallet(
  wallet: string,
  options?: ComboFetchOptions,
): Promise<ComboWalletSummary> {
  const [positionsResult, activityResult] = await Promise.all([
    fetchComboPositions(wallet, options),
    fetchComboActivity(wallet, options),
  ]);
  const open = positionsResult.positions.filter(
    (position) =>
      position.status === "OPEN" ||
      (!position.redeemable && position.legsResolved < position.legsTotal),
  );
  const activityByType: Record<string, { count: number; amountUsd: number }> =
    {};
  for (const row of activityResult.activity) {
    const bucket = activityByType[row.type] ?? { count: 0, amountUsd: 0 };
    bucket.count += 1;
    bucket.amountUsd += row.amountUsd;
    activityByType[row.type] = bucket;
  }
  return {
    wallet: wallet.toLowerCase(),
    positions: positionsResult.positions,
    activity: activityResult.activity,
    openPositions: open.length,
    openCostUsd:
      Math.round(
        open.reduce((sum, position) => sum + position.entryCostUsd, 0) * 100,
      ) / 100,
    activityByType,
    pages: positionsResult.pages + activityResult.pages,
    truncated: positionsResult.truncated || activityResult.truncated,
  };
}
