/**
 * Read-only client for Kalshi's public market-data API.
 *
 * Signals are evaluated against public prices; this client can do exactly three things —
 * list open events for a series, read one order book, read one market. It never sends an auth
 * header, never reads `KALSHI_API_KEY`, and has no code path to an order or portfolio endpoint.
 * The endpoint whitelist is the two URL builders below; there is no generic `request(path)` that
 * a future caller could point somewhere else.
 *
 * Failure is data, not an exception: a network error, timeout, non-2xx or an unexpected body
 * shape returns `{ok:false, reason}` and records the error, so the route can say `degraded` and
 * the join can say `no_market`/`no_fair_price` instead of publishing a fabricated price.
 *
 * Prices arrive as dollar strings ("0.5500") and sizes as fixed-point strings ("678.63"); they are
 * parsed at this boundary and `null` when unparseable. Everything downstream sees numbers or null.
 */

import { isRecordValue } from "./zod_guards.ts";

export const KALSHI_DEFAULT_BASE_URL =
  "https://api.elections.kalshi.com/trade-api/v2";

/** Concurrent HTTP requests; small on purpose (public endpoints, one signal sweep). */
export const KALSHI_MAX_CONCURRENCY = 3;
export const KALSHI_EVENTS_TTL_MS = 60_000;
export const KALSHI_ORDERBOOK_TTL_MS = 30_000;
export const KALSHI_REQUEST_TIMEOUT_MS = 5_000;

export interface KalshiMarket {
  readonly ticker: string;
  readonly title: string | null;
  readonly yesSubTitle: string | null;
  readonly status: string | null;
  /** Best resting bid for YES, in dollars. */
  readonly yesBid: number | null;
  /** Best resting ask for YES, in dollars. */
  readonly yesAsk: number | null;
  readonly yesBidSize: number | null;
  readonly yesAskSize: number | null;
  readonly lastPrice: number | null;
  readonly openInterest: number | null;
  readonly volume24h: number | null;
  readonly volume: number | null;
  readonly strikeType: string | null;
  readonly floorStrike: number | null;
  readonly capStrike: number | null;
  readonly closeTime: string | null;
  /** The market's resolution rule text (`rules_primary`); absent when the wire omits it. */
  readonly rulesPrimary?: string;
}

export interface KalshiEvent {
  readonly eventTicker: string;
  readonly title: string | null;
  readonly seriesTicker: string | null;
  readonly mutuallyExclusive: boolean | null;
  readonly markets: readonly KalshiMarket[];
}

export interface KalshiLevel {
  /** Price in dollars. */
  readonly price: number;
  /** Contract count. */
  readonly size: number;
}

/**
 * One side of the book as Kalshi publishes it: resting bids for that side's contract, ascending
 * by price. The *ask* for a side is `1 - best bid of the opposite side`, which is why the join
 * walks these bid arrays rather than reading a separate ask array.
 */
export interface KalshiOrderbook {
  readonly yes: readonly KalshiLevel[];
  readonly no: readonly KalshiLevel[];
}

export type KalshiResult<T> =
  | { readonly ok: true; readonly value: T; readonly cached: boolean }
  | { readonly ok: false; readonly reason: string };

export interface KalshiError {
  readonly scope: "events" | "orderbook" | "market";
  readonly reason: string;
}

export interface KalshiTelemetry {
  readonly ok: boolean;
  readonly degraded: boolean;
  readonly requests: number;
  readonly cacheHits: number;
  readonly maxConcurrency: number;
  readonly cache: {
    readonly eventsTtlSec: number;
    readonly orderbookTtlSec: number;
  };
  readonly errors: readonly KalshiError[];
}

export interface KalshiClientOptions {
  readonly fetchImpl?: typeof fetch;
  /** Milliseconds clock; injectable so cache/TTL tests do not sleep. */
  readonly now?: () => number;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly eventsTtlMs?: number;
  readonly orderbookTtlMs?: number;
  readonly maxConcurrency?: number;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly value: unknown;
}

/** A dollar/fixed-point string to a finite number, or `null`. */
export function parseKalshiNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** One market row; `null` when the ticker is missing (a market we cannot address is unusable). */
export function parseKalshiMarket(value: unknown): KalshiMarket | null {
  if (!isRecordValue(value)) return null;
  const ticker = parseString(value["ticker"]);
  if (ticker === null) return null;
  const rulesPrimary = parseString(value["rules_primary"]);
  return {
    ticker,
    title: parseString(value["title"]),
    yesSubTitle: parseString(value["yes_sub_title"]),
    status: parseString(value["status"]),
    yesBid: parseKalshiNumber(value["yes_bid_dollars"]),
    yesAsk: parseKalshiNumber(value["yes_ask_dollars"]),
    yesBidSize: parseKalshiNumber(value["yes_bid_size_fp"]),
    yesAskSize: parseKalshiNumber(value["yes_ask_size_fp"]),
    lastPrice: parseKalshiNumber(value["last_price_dollars"]),
    openInterest: parseKalshiNumber(value["open_interest_fp"]),
    volume24h: parseKalshiNumber(value["volume_24h_fp"]),
    volume: parseKalshiNumber(value["volume_fp"]),
    strikeType: parseString(value["strike_type"]),
    floorStrike: parseKalshiNumber(value["floor_strike"]),
    capStrike: parseKalshiNumber(value["cap_strike"]),
    closeTime: parseString(value["close_time"]),
    // Only present when the wire carries it, so the parsed object shape stays stable otherwise.
    ...(rulesPrimary === null ? {} : { rulesPrimary }),
  };
}

export function parseKalshiEvent(value: unknown): KalshiEvent | null {
  if (!isRecordValue(value)) return null;
  const eventTicker = parseString(value["event_ticker"]);
  if (eventTicker === null) return null;
  const rawMarkets = Array.isArray(value["markets"]) ? value["markets"] : [];
  const markets: KalshiMarket[] = [];
  for (const raw of rawMarkets) {
    const market = parseKalshiMarket(raw);
    if (market !== null) markets.push(market);
  }
  return {
    eventTicker,
    title: parseString(value["title"]),
    seriesTicker: parseString(value["series_ticker"]),
    mutuallyExclusive:
      typeof value["mutually_exclusive"] === "boolean"
        ? value["mutually_exclusive"]
        : null,
    markets,
  };
}

/** `{events:[…]}` from `/events`; `null` when the envelope itself is wrong. */
export function parseKalshiEvents(
  value: unknown,
): readonly KalshiEvent[] | null {
  if (!isRecordValue(value) || !Array.isArray(value["events"])) return null;
  const events: KalshiEvent[] = [];
  for (const raw of value["events"]) {
    const event = parseKalshiEvent(raw);
    if (event !== null) events.push(event);
  }
  return events;
}

function parseLevels(value: unknown): readonly KalshiLevel[] | null {
  if (!Array.isArray(value)) return null;
  const levels: KalshiLevel[] = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const price = parseKalshiNumber(raw[0]);
    const size = parseKalshiNumber(raw[1]);
    if (price === null || size === null || price <= 0 || price >= 1) continue;
    if (size <= 0) continue;
    levels.push({ price, size });
  }
  return levels;
}

/** `{orderbook_fp:{yes_dollars,no_dollars}}`; `null` when either side is unreadable. */
export function parseKalshiOrderbook(value: unknown): KalshiOrderbook | null {
  if (!isRecordValue(value)) return null;
  const book = isRecordValue(value["orderbook_fp"])
    ? value["orderbook_fp"]
    : value;
  const yes = parseLevels(book["yes_dollars"]);
  const no = parseLevels(book["no_dollars"]);
  if (yes === null || no === null) return null;
  return { yes, no };
}

export class KalshiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly eventsTtlMs: number;
  private readonly orderbookTtlMs: number;
  private readonly maxConcurrency: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly errors: KalshiError[] = [];
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private requestCount = 0;
  private cacheHitCount = 0;

  constructor(options: KalshiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.baseUrl = (options.baseUrl ?? KALSHI_DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.timeoutMs = options.timeoutMs ?? KALSHI_REQUEST_TIMEOUT_MS;
    this.eventsTtlMs = options.eventsTtlMs ?? KALSHI_EVENTS_TTL_MS;
    this.orderbookTtlMs = options.orderbookTtlMs ?? KALSHI_ORDERBOOK_TTL_MS;
    this.maxConcurrency = Math.max(
      1,
      Math.trunc(options.maxConcurrency ?? KALSHI_MAX_CONCURRENCY),
    );
  }

  /** The public telemetry block `/api/signals/kalshi` publishes. */
  telemetry(): KalshiTelemetry {
    return {
      ok: this.errors.length === 0,
      degraded: this.errors.length > 0,
      requests: this.requestCount,
      cacheHits: this.cacheHitCount,
      maxConcurrency: this.maxConcurrency,
      cache: {
        eventsTtlSec: Math.floor(this.eventsTtlMs / 1000),
        orderbookTtlSec: Math.floor(this.orderbookTtlMs / 1000),
      },
      errors: [...this.errors],
    };
  }

  private recordError(scope: KalshiError["scope"], reason: string): void {
    // Bounded: one broken series should not grow the response forever.
    if (this.errors.length < 20) this.errors.push({ scope, reason });
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }

  private async cachedRequest<T>(
    scope: KalshiError["scope"],
    url: string,
    ttlMs: number,
    parse: (raw: unknown) => T | null,
  ): Promise<KalshiResult<T>> {
    const key = `${scope}:${url}`;
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit !== undefined && hit.expiresAt > now) {
      this.cacheHitCount += 1;
      return { ok: true, value: hit.value as T, cached: true };
    }
    this.requestCount += 1;
    let response: Response;
    try {
      await this.acquire();
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } finally {
        this.release();
      }
    } catch (error) {
      const reason = `network: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 200);
      this.recordError(scope, reason);
      return { ok: false, reason };
    }
    if (!response.ok) {
      const reason = `HTTP ${response.status} from ${new URL(url).pathname}`;
      this.recordError(scope, reason);
      return { ok: false, reason };
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      const reason = "response is not JSON";
      this.recordError(scope, reason);
      return { ok: false, reason };
    }
    const parsed = parse(raw);
    if (parsed === null) {
      const reason = "unexpected response shape";
      this.recordError(scope, reason);
      return { ok: false, reason };
    }
    this.cache.set(key, { expiresAt: now + ttlMs, value: parsed });
    return { ok: true, value: parsed, cached: false };
  }

  /** Open events for one series, with nested markets. Cached for `eventsTtlMs`. */
  async listOpenEvents(
    seriesTicker: string,
  ): Promise<KalshiResult<readonly KalshiEvent[]>> {
    const url = `${this.baseUrl}/events?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&limit=100&with_nested_markets=true`;
    return this.cachedRequest(
      "events",
      url,
      this.eventsTtlMs,
      parseKalshiEvents,
    );
  }

  /** Order book for one market, depth 10. Cached for `orderbookTtlMs`. */
  async getOrderbook(
    marketTicker: string,
  ): Promise<KalshiResult<KalshiOrderbook>> {
    const url = `${this.baseUrl}/markets/${encodeURIComponent(marketTicker)}/orderbook?depth=10`;
    return this.cachedRequest("orderbook", url, this.orderbookTtlMs, (raw) => {
      if (!isRecordValue(raw) || !isRecordValue(raw["orderbook_fp"]))
        return null;
      return parseKalshiOrderbook(raw);
    });
  }

  /** One market by ticker; used when a caller only needs the market metadata. */
  async getMarket(marketTicker: string): Promise<KalshiResult<KalshiMarket>> {
    const url = `${this.baseUrl}/markets/${encodeURIComponent(marketTicker)}`;
    return this.cachedRequest("market", url, this.eventsTtlMs, (raw) => {
      if (!isRecordValue(raw)) return null;
      return parseKalshiMarket(raw["market"]);
    });
  }
}
