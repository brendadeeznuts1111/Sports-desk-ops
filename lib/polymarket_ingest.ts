/**
 * @file lib/polymarket_ingest.ts
 * @description Live Polymarket positions ingestion for the graph feed.
 *
 * Public Data API only: no credentials. The caller decides cadence; this module owns pagination,
 * timeouts, one retry on 429/5xx, bounded concurrency, row validation, and aggregate math.
 *
 * Spec: docs/REAL_INGESTION.md
 */

export const POLYMARKET_POSITIONS_URL =
  "https://data-api.polymarket.com/positions";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface PolymarketPosition {
  readonly proxyWallet: string;
  readonly asset: string;
  readonly conditionId: string;
  readonly size: number;
  readonly avgPrice: number;
  readonly initialValue: number;
  readonly currentValue: number;
  readonly cashPnl: number;
  readonly curPrice: number;
  readonly redeemable: boolean;
  readonly title: string;
  readonly slug: string;
  readonly eventId: string;
  readonly outcome: string;
  readonly endDate: string | null;
}

export interface WalletAggregate {
  readonly openPositionsCount: number;
  readonly openLegsCount: number;
  readonly openCostUsd: number;
  readonly openValueUsd: number;
  readonly openPnlUsd: number;
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
  readonly truncated: boolean;
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
  readonly retryDelayMs?: number;
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

function numberOr(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Coerces one API row; returns null when the row cannot be attributed to a market. */
export function parsePolymarketPosition(
  value: unknown,
): PolymarketPosition | null {
  const row = asRecord(value);
  if (row === null) return null;
  const asset = stringOr(row.asset);
  const conditionId = stringOr(row.conditionId);
  const title = stringOr(row.title);
  if (asset === "" || conditionId === "" || title === "") return null;
  return {
    proxyWallet: stringOr(row.proxyWallet),
    asset,
    conditionId,
    size: numberOr(row.size),
    avgPrice: numberOr(row.avgPrice),
    initialValue: numberOr(row.initialValue),
    currentValue: numberOr(row.currentValue),
    cashPnl: numberOr(row.cashPnl),
    curPrice: numberOr(row.curPrice),
    redeemable: row.redeemable === true,
    title,
    slug: stringOr(row.slug),
    eventId: stringOr(row.eventId),
    outcome: stringOr(row.outcome),
    endDate: typeof row.endDate === "string" ? row.endDate : null,
  };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Aggregate math for one wallet. Redeemable (won-but-unclaimed) positions are excluded from open legs. */
export function aggregatePositions(
  positions: readonly PolymarketPosition[],
): WalletAggregate {
  const open = positions.filter((position) => !position.redeemable);
  const cost = open.reduce((sum, position) => sum + position.initialValue, 0);
  const value = open.reduce((sum, position) => sum + position.currentValue, 0);
  const pnl = open.reduce((sum, position) => sum + position.cashPnl, 0);
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

/** Fetches and validates one wallet's positions, following pagination up to `maxPages`. */
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
  const pageSize = Math.min(Math.max(options?.pageSize ?? 500, 1), 500);
  const maxPages = Math.max(1, options?.maxPages ?? 2);

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
  });

  if (!isValidWalletAddress(address)) return fail("invalid address");

  const positions: PolymarketPosition[] = [];
  let pages = 0;
  let truncated = false;

  try {
    for (let page = 0; page < maxPages; page += 1) {
      const url = `${baseUrl}?user=${encodeURIComponent(address)}&limit=${pageSize}&offset=${page * pageSize}`;
      let response: Response | null = null;
      let lastStatus = 0;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        response = await fetchImpl(url, {
          proxy: false,
          signal: AbortSignal.timeout(timeoutMs),
        } as RequestInit);
        lastStatus = response.status;
        if (response.status === 429 || response.status >= 500) {
          await sleep(retryDelayMs);
          continue;
        }
        break;
      }
      if (response === null) return fail("no response");
      if (!response.ok) return fail(`HTTP ${lastStatus}`);

      const body: unknown = await response.json();
      if (!Array.isArray(body)) {
        return fail(
          `unexpected body (${response.headers.get("content-type") ?? "unknown"})`,
        );
      }
      pages += 1;
      for (const row of body) {
        const parsed = parsePolymarketPosition(row);
        if (parsed !== null) positions.push(parsed);
      }
      if (body.length < pageSize) {
        truncated = false;
        break;
      }
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
