/**
 * @file lib/polymarket_ingest.ts
 * @description Live Polymarket positions ingestion for the graph feed (Data API **v2**).
 *
 * Public Data API only: no credentials. The caller decides cadence; this module owns the v2
 * `{ data, pagination }` envelope, cursor-only pagination, timeouts, one bounded retry on
 * `429`/`5xx` (honouring `Retry-After`), bounded concurrency, row validation and aggregate math.
 *
 * The retired v1 route (`GET /positions`) answers HTTP 410
 * `{"error":"Data API v1 has been retired"}` (observed 2026-11-04). Nothing here falls back to
 * it: every request targets `/v2/positions`, and the envelope is mandatory on the wire.
 *
 * Spec: docs/REAL_INGESTION.md
 */

export const POLYMARKET_DATA_API_ORIGIN = "https://data-api.polymarket.com";

/** Data API v2 positions route. The v1 `/positions` route is retired (HTTP 410, 2026-11-04). */
export const POLYMARKET_POSITIONS_URL = `${POLYMARKET_DATA_API_ORIGIN}/v2/positions`;

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Row states the v2 contract documents for `/v2/positions`. */
export type PolymarketPositionStatus =
  "OPEN" | "REDEEMABLE" | "REDEEMABLE_LOST" | "MERGEABLE" | "CLOSED";

const POSITION_STATUSES: ReadonlySet<string> =
  new Set<PolymarketPositionStatus>([
    "OPEN",
    "REDEEMABLE",
    "REDEEMABLE_LOST",
    "MERGEABLE",
    "CLOSED",
  ]);

/**
 * One position row, mapped from the v2 snake_case wire shape onto the historical feed field
 * names. The v2 aliases are additive: `status`, `totalPnlUsd`, `realizedPnlUsd`,
 * `unrealizedPnlUsd`, `entryFeesUsdc`, `totalCostUsdc` and `missingFields`.
 *
 * Legacy names kept for the feed: `asset` = `token_id`, `initialValue` = `entry_cost_usdc`,
 * `cashPnl` = `total_pnl` and `curPrice` = `current_price`.
 */
export interface PolymarketPosition {
  readonly proxyWallet: string;
  /** v2 `token_id`: the outcome token (ERC-1155 asset id). */
  readonly asset: string;
  /** v2 `condition_id`. */
  readonly conditionId: string;
  /** v2 `current_size`: the CURRENT holding, in outcome shares. */
  readonly size: number;
  /** v2 `avg_price`: weighted-average entry price per share, in USDC. */
  readonly avgPrice: number;
  /**
   * v2 `entry_cost_usdc`: the **fee-exclusive** entry basis, in USD. This is the feed's
   * `openVolumeUsd` cost basis (v1 called it `initialValue`); the gross basis is `totalCostUsdc`.
   */
  readonly initialValue: number;
  /** v2 `current_value`: mark-to-market value, in USDC. */
  readonly currentValue: number;
  /** v2 `total_pnl` (realized + unrealized), in USD. v1 called this `cashPnl`. */
  readonly cashPnl: number;
  /** v2 `current_price`: live mark per share, in USDC. */
  readonly curPrice: number;
  /**
   * True when the position can be redeemed now: `status === "REDEEMABLE"` or the wire's own
   * `redeemable` boolean. The two agree on the live arm (2026-11-04: all 151 REDEEMABLE rows
   * carried `redeemable: true`).
   */
  readonly redeemable: boolean;
  readonly title: string;
  readonly slug: string;
  /** v2 `event_id` (Gamma event id). */
  readonly eventId: string;
  readonly outcome: string;
  readonly endDate: string | null;
  /**
   * Row state echoed by the wire. `""` means absent/unrecognised and is never counted as an open
   * leg. The default v2 `status=OPEN` arm is a superset: it still carries `REDEEMABLE` rows.
   */
  readonly status: PolymarketPositionStatus | "";
  /** v2 `realized_pnl`, cumulative for the position, in USD. */
  readonly realizedPnlUsd: number;
  /** v2 `unrealized_pnl` (`current_value - entry_cost_usdc`), in USD. */
  readonly unrealizedPnlUsd: number;
  /** v2 `total_pnl` (`realized_pnl + unrealized_pnl`), in USD. Same value as `cashPnl`. */
  readonly totalPnlUsd: number;
  /** v2 `entry_fees_usdc`: attributed BUY fees, disclosure only. */
  readonly entryFeesUsdc: number;
  /** v2 `total_cost_usdc`: gross (fee-inclusive) basis, `entry_cost_usdc + entry_fees_usdc`. */
  readonly totalCostUsdc: number;
  /** Wire numeric fields that were missing/null on this row; their mapped value is 0. */
  readonly missingFields: readonly string[];
}

export interface WalletAggregate {
  /** Every row the page walk returned (the OPEN arm is a superset, so redeemable rows count here). */
  readonly openPositionsCount: number;
  /** Rows whose own `status` is exactly `"OPEN"`; REDEEMABLE/MERGEABLE/CLOSED are excluded. */
  readonly openLegsCount: number;
  /** Sum of `initialValue` (`entry_cost_usdc`, fee-exclusive basis) over OPEN rows. */
  readonly openCostUsd: number;
  /** Sum of `currentValue` over OPEN rows. */
  readonly openValueUsd: number;
  /** Sum of `cashPnl` (`total_pnl` = realized + unrealized) over OPEN rows. */
  readonly openPnlUsd: number;
  /** Additive: sum of `unrealizedPnlUsd` over OPEN rows (the mark-to-market component). */
  readonly openUnrealizedPnlUsd: number;
  /** Additive: OPEN rows that carried at least one missing/null numeric field. */
  readonly openRowsWithMissingNumerics: number;
  readonly summary: string;
}

export interface WalletFetchResult {
  readonly address: string;
  readonly status: "ok" | "error";
  readonly positions: readonly PolymarketPosition[];
  readonly aggregate: WalletAggregate | null;
  readonly error: string | null;
  readonly fetchedAtIso: string;
  readonly durationMs: number;
  readonly pages: number;
  /** A page walk stopped at `maxPages` while the server still reported another page. */
  readonly truncated: boolean;
  /** Additive: rows the walk returned that failed validation and were dropped. */
  readonly rejectedRows: number;
}

export interface PolymarketSnapshot {
  readonly source: string;
  readonly fetchedAtIso: string;
  readonly durationMs: number;
  readonly requested: number;
  readonly ok: number;
  readonly failed: number;
  readonly truncatedWallets: readonly string[];
  readonly wallets: readonly WalletFetchResult[];
}

export interface FetchWalletOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** Fallback retry delay when `Retry-After` is absent or unparseable. */
  readonly retryDelayMs?: number;
  /** Upper bound applied to any `Retry-After` wait (default 5 s); keeps a retry bounded. */
  readonly maxRetryAfterMs?: number;
  /** First-page page size; the cursor carries the size for later pages. Capped at 1000. */
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface FetchSnapshotOptions extends FetchWalletOptions {
  readonly concurrency?: number;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** True for a 20-byte hex address; placeholder rows in the watchlist fail this. */
export function isValidWalletAddress(address: string): boolean {
  return ADDRESS_PATTERN.test(address);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** First non-empty string among the candidates (v2 wire name first, legacy alias second). */
function firstString(...values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** End date: v2 `end_date` first, then the legacy `endDate`; null when neither is a string. */
function endDateOrNull(row: Record<string, unknown>): string | null {
  const primary = firstString(row.end_date, row.endDate);
  return primary === "" ? null : primary;
}

/**
 * Coerces one API row; returns null when the row cannot be attributed to a market.
 *
 * v2 names win. The retired v1 camelCase names are still read so captured fixtures and cached
 * rows keep parsing; that tolerance never changes which endpoint is requested.
 */
export function parsePolymarketPosition(
  value: unknown,
): PolymarketPosition | null {
  const row = asRecord(value);
  if (row === null) return null;
  const asset = firstString(row.token_id, row.asset);
  const conditionId = firstString(row.condition_id, row.conditionId);
  const title = firstString(row.title);
  if (asset === "" || conditionId === "" || title === "") return null;

  const missingFields: string[] = [];
  const numeric = (wire: string, ...candidates: readonly unknown[]): number => {
    for (const candidate of candidates) {
      const parsed = numberOrNull(candidate);
      if (parsed !== null) return parsed;
    }
    missingFields.push(wire);
    return 0;
  };

  const size = numeric("current_size", row.current_size, row.size);
  const avgPrice = numeric("avg_price", row.avg_price, row.avgPrice);
  const initialValue = numeric(
    "entry_cost_usdc",
    row.entry_cost_usdc,
    row.initialValue,
  );
  const currentValue = numeric(
    "current_value",
    row.current_value,
    row.currentValue,
  );
  const totalPnlUsd = numeric("total_pnl", row.total_pnl, row.cashPnl);
  const curPrice = numeric("current_price", row.current_price, row.curPrice);
  const realizedPnlUsd = numeric("realized_pnl", row.realized_pnl);
  const unrealizedPnlUsd = numeric("unrealized_pnl", row.unrealized_pnl);
  const entryFeesUsdc = numeric("entry_fees_usdc", row.entry_fees_usdc);
  const totalCostUsdc = numeric("total_cost_usdc", row.total_cost_usdc);

  const rawStatus = firstString(row.status).trim().toUpperCase();
  const status: PolymarketPositionStatus | "" = POSITION_STATUSES.has(rawStatus)
    ? (rawStatus as PolymarketPositionStatus)
    : rawStatus === ""
      ? // Legacy v1 row shape has no `status`; derive it from its `redeemable` boolean.
        row.redeemable === true
        ? "REDEEMABLE"
        : "OPEN"
      : "";

  return {
    proxyWallet: firstString(row.proxy_wallet, row.proxyWallet),
    asset,
    conditionId,
    size,
    avgPrice,
    initialValue,
    currentValue,
    cashPnl: totalPnlUsd,
    curPrice,
    redeemable: status === "REDEEMABLE" || row.redeemable === true,
    title,
    slug: firstString(row.slug),
    eventId: firstString(row.event_id, row.eventId),
    outcome: firstString(row.outcome),
    endDate: endDateOrNull(row),
    status,
    realizedPnlUsd,
    unrealizedPnlUsd,
    totalPnlUsd,
    entryFeesUsdc,
    totalCostUsdc,
    missingFields,
  };
}

/** The v2 `{ data, pagination }` envelope, normalised for the page walk. */
export interface PositionsPage {
  readonly rows: readonly unknown[];
  /** Opaque cursor for the next page; null on the last page. */
  readonly nextCursor: string | null;
  /** The server's exact "another page exists" flag. */
  readonly hasMore: boolean;
}

/**
 * Parses the v2 envelope. Returns null when the body is not an envelope (`{ data, pagination }`),
 * which is a failure: the retired v1 route returned a bare array, and silently accepting that
 * shape would hide a stale endpoint.
 *
 * `data` may be `null` or `[]`: a documented miss is a successful empty page, never an error.
 */
export function parsePositionsEnvelope(value: unknown): PositionsPage | null {
  const record = asRecord(value);
  if (record === null) return null;
  const data = record.data;
  if (data !== null && !Array.isArray(data)) return null;
  const pagination = asRecord(record.pagination);
  if (pagination === null) return null;
  const cursor = pagination.next_cursor;
  const nextCursor =
    typeof cursor === "string" && cursor !== "" ? cursor : null;
  return {
    rows: Array.isArray(data) ? data : [],
    nextCursor,
    // `has_more` is contractually exact; if a server omits it, the cursor decides.
    hasMore:
      pagination.has_more === true ||
      (pagination.has_more === undefined && nextCursor !== null),
  };
}

/**
 * Parses a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds.
 * Returns null when absent or unparseable so the caller can use its fallback delay.
 */
export function parseRetryAfterMs(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1000);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * Delay before the single retry: the header when it parses, else the configured fallback,
 * clamped to `[0, maxMs]` so a hostile or buggy `Retry-After` cannot stall the poll.
 */
export function resolveRetryDelayMs(
  retryAfterHeader: string | null,
  fallbackMs: number,
  maxMs: number,
): number {
  const headerMs = parseRetryAfterMs(retryAfterHeader);
  const base = headerMs ?? fallbackMs;
  return Math.min(Math.max(base, 0), Math.max(maxMs, 0));
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Aggregate math for one wallet, over rows whose own `status` is exactly `"OPEN"`.
 *
 * The default v2 arm is the OPEN superset and also returns `REDEEMABLE` rows (settled but
 * unclaimed). Excluding them matches the feed's historical "open legs" definition (v1's
 * `redeemable === false`). `openPositionsCount` stays the total row count for compatibility.
 *
 * Missing numerics are summed as 0; rows that had any are counted in
 * `openRowsWithMissingNumerics` so a zero can be told apart from an unavailable value.
 */
export function aggregatePositions(
  positions: readonly PolymarketPosition[],
): WalletAggregate {
  const open = positions.filter((position) => position.status === "OPEN");
  const cost = open.reduce((sum, position) => sum + position.initialValue, 0);
  const value = open.reduce((sum, position) => sum + position.currentValue, 0);
  const pnl = open.reduce((sum, position) => sum + position.cashPnl, 0);
  const unrealized = open.reduce(
    (sum, position) => sum + position.unrealizedPnlUsd,
    0,
  );
  const top = [...open]
    .sort((a, b) => b.currentValue - a.currentValue)
    .slice(0, 3)
    .map((position) => {
      const label =
        position.title.length > 48
          ? `${position.title.slice(0, 45)}...`
          : position.title;
      const outcome = position.outcome === "" ? "" : ` (${position.outcome})`;
      return `${label}${outcome} $${Math.round(position.currentValue).toLocaleString("en-US")}`;
    });
  return {
    openPositionsCount: positions.length,
    openLegsCount: open.length,
    openCostUsd: round2(cost),
    openValueUsd: round2(value),
    openPnlUsd: round2(pnl),
    openUnrealizedPnlUsd: round2(unrealized),
    openRowsWithMissingNumerics: open.filter(
      (position) => position.missingFields.length > 0,
    ).length,
    summary: top.length > 0 ? top.join(", ") : "no open positions",
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError")
      return "timeout";
    return error.message;
  }
  return String(error);
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : Bun.sleep(ms);

/** `HTTP <status>: <body error|message>`; the body's own message is preserved when present. */
async function describeHttpError(response: Response): Promise<string> {
  const base = `HTTP ${response.status}`;
  let detail = "";
  try {
    const text = await response.text();
    if (text !== "") {
      try {
        const body: unknown = JSON.parse(text);
        const record = asRecord(body);
        detail =
          firstString(record?.error, record?.message) || text.slice(0, 160);
      } catch {
        detail = text.slice(0, 160);
      }
    }
  } catch {
    // Unreadable error body: the status alone is still a useful failure.
  }
  return detail === "" ? base : `${base}: ${detail}`;
}

function requestInit(timeoutMs: number): RequestInit {
  return {
    proxy: false,
    signal: AbortSignal.timeout(timeoutMs),
  } as RequestInit;
}

/** Fetches and validates one wallet's positions, following the v2 cursor up to `maxPages`. */
export async function fetchWalletPositions(
  address: string,
  options?: FetchWalletOptions,
): Promise<WalletFetchResult> {
  const startedAt = Date.now();
  const fetchedAtIso = new Date(startedAt).toISOString();
  const baseUrl = (options?.baseUrl ?? POLYMARKET_POSITIONS_URL).replace(
    /\/$/,
    "",
  );
  const fetchImpl: FetchLike = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const retryDelayMs = options?.retryDelayMs ?? 250;
  const maxRetryAfterMs = Math.max(0, options?.maxRetryAfterMs ?? 5_000);
  const pageSize = Math.min(Math.max(options?.pageSize ?? 500, 1), 1000);
  const maxPages = Math.max(1, options?.maxPages ?? 3);

  const fail = (error: string): WalletFetchResult => ({
    address,
    status: "error",
    positions: [],
    aggregate: null,
    error,
    fetchedAtIso,
    durationMs: Date.now() - startedAt,
    pages: 0,
    truncated: false,
    rejectedRows: 0,
  });

  if (!isValidWalletAddress(address)) return fail("invalid address");

  /** One request plus at most one retry on 429/5xx, waiting at most `maxRetryAfterMs`. */
  const request = async (url: string): Promise<Response> => {
    let response = await fetchImpl(url, requestInit(timeoutMs));
    if (response.status !== 429 && response.status < 500) return response;
    await sleep(
      resolveRetryDelayMs(
        response.headers.get("retry-after"),
        retryDelayMs,
        maxRetryAfterMs,
      ),
    );
    response = await fetchImpl(url, requestInit(timeoutMs));
    return response;
  };

  const positions: PolymarketPosition[] = [];
  let pages = 0;
  let rejectedRows = 0;
  let truncated = false;

  try {
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const params = new URLSearchParams({ user: address });
      // Cursor-only pagination: `limit` applies to the first page; a cursor binds the rest
      // (and the server rejects `offset` on this route).
      if (cursor === null) params.set("limit", String(pageSize));
      else params.set("cursor", cursor);
      const url = `${baseUrl}?${params.toString()}`;

      const response = await request(url);
      if (!response.ok) return fail(await describeHttpError(response));

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return fail(
          `unexpected body (invalid JSON, ${response.headers.get("content-type") ?? "unknown"})`,
        );
      }
      const pageData = parsePositionsEnvelope(body);
      if (pageData === null) {
        return fail(
          `unexpected body (${response.headers.get("content-type") ?? "unknown"})`,
        );
      }
      pages += 1;
      for (const row of pageData.rows) {
        const parsed = parsePolymarketPosition(row);
        if (parsed === null) rejectedRows += 1;
        else positions.push(parsed);
      }

      // `next_cursor` is the authority; `has_more` is exact, so either can end the walk.
      if (!pageData.hasMore || pageData.nextCursor === null) {
        truncated = false;
        break;
      }
      cursor = pageData.nextCursor;
      if (page === maxPages - 1) truncated = true;
    }
  } catch (error) {
    return fail(errorMessage(error));
  }

  return {
    address,
    status: "ok",
    positions,
    aggregate: aggregatePositions(positions),
    error: null,
    fetchedAtIso,
    durationMs: Date.now() - startedAt,
    pages,
    truncated,
    rejectedRows,
  };
}

/** Fetches many wallets with bounded concurrency; result order matches input order. */
export async function fetchPolymarketSnapshot(
  addresses: readonly string[],
  options?: FetchSnapshotOptions,
): Promise<PolymarketSnapshot> {
  const startedAt = Date.now();
  const fetchedAtIso = new Date(startedAt).toISOString();
  const unique = [
    ...new Set(
      addresses
        .map((address) => address.trim())
        .filter((address) => address !== ""),
    ),
  ];
  const concurrency = Math.min(
    Math.max(options?.concurrency ?? 6, 1),
    unique.length || 1,
  );
  // eslint-disable-next-line unicorn/no-new-array -- dense preallocation filled by index
  const wallets: WalletFetchResult[] = new Array(unique.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= unique.length) return;
      wallets[index] = await fetchWalletPositions(unique[index]!, options);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const ok = wallets.filter((wallet) => wallet.status === "ok").length;
  return {
    source: (options?.baseUrl ?? POLYMARKET_POSITIONS_URL).replace(/\/$/, ""),
    fetchedAtIso,
    durationMs: Date.now() - startedAt,
    requested: unique.length,
    ok,
    failed: unique.length - ok,
    truncatedWallets: wallets
      .filter((wallet) => wallet.truncated)
      .map((wallet) => wallet.address),
    wallets,
  };
}

/* -------------------------------------------------------------------------- */
/* State cache + reconciliation                                               */
/* -------------------------------------------------------------------------- */

export interface CachedWallet {
  readonly aggregate: WalletAggregate;
  readonly fetchedAtIso: string;
}

export interface PositionCache {
  readonly schemaVersion: 1;
  readonly wallets: Readonly<Record<string, CachedWallet>>;
}

export interface WalletIngestState {
  readonly address: string;
  readonly dataSource: "LIVE" | "STALE" | "FIXTURE";
  readonly aggregate: WalletAggregate | null;
  readonly fetchedAtIso: string | null;
  readonly staleSinceIso: string | null;
  readonly lastError: string | null;
}

/** Builds one cache from a snapshot, keeping only wallets that succeeded. */
export function cacheFromSnapshot(snapshot: PolymarketSnapshot): PositionCache {
  const wallets: Record<string, CachedWallet> = {};
  for (const wallet of snapshot.wallets) {
    if (wallet.status === "ok" && wallet.aggregate !== null) {
      wallets[wallet.address] = {
        aggregate: wallet.aggregate,
        fetchedAtIso: wallet.fetchedAtIso,
      };
    }
  }
  return { schemaVersion: 1, wallets };
}

/**
 * LIVE when the fetch succeeded; STALE (last good cache) when it failed but a cache exists;
 * FIXTURE when it failed and there is nothing to fall back to.
 */
export function reconcileSnapshot(
  snapshot: PolymarketSnapshot,
  cache: PositionCache,
): readonly WalletIngestState[] {
  return snapshot.wallets.map((wallet) => {
    if (wallet.status === "ok" && wallet.aggregate !== null) {
      return {
        address: wallet.address,
        dataSource: "LIVE",
        aggregate: wallet.aggregate,
        fetchedAtIso: wallet.fetchedAtIso,
        staleSinceIso: null,
        lastError: null,
      };
    }
    const cached = cache.wallets[wallet.address];
    if (cached !== undefined) {
      return {
        address: wallet.address,
        dataSource: "STALE",
        aggregate: cached.aggregate,
        fetchedAtIso: cached.fetchedAtIso,
        staleSinceIso: cached.fetchedAtIso,
        lastError: wallet.error,
      };
    }
    return {
      address: wallet.address,
      dataSource: "FIXTURE",
      aggregate: null,
      fetchedAtIso: null,
      staleSinceIso: null,
      lastError: wallet.error,
    };
  });
}
