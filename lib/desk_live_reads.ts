/**
 * @file desk_live_reads.ts
 * @description Live-first orchestration for desk ticker (`getBetTicker`) and Pending reads:
 * route resolution, TTL caches, artifact persistence, refresh-loop telemetry, and `/api/status`
 * live blocks.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { F402ProbeFetch } from "./f402_ingest.ts";
import {
  fetchLivePending,
  pendingCustomersFromTickerRows,
  REPORT_PENDING_OPERATION,
  type LivePendingDiagnostic,
} from "./f402_live_pending.ts";
import {
  fetchLiveBetTicker,
  type LiveTickerDiagnostic,
} from "./f402_live_ticker.ts";
import type { F402Session } from "./f402_session.ts";
import {
  LIVE_PENDING_DEFAULT_TTL_MS,
  LIVE_PENDING_MAX_TTL_MS,
  LIVE_PERSIST_DEFAULT_THROTTLE_MS,
  LIVE_REFRESH_DEFAULT_MS,
  LIVE_REFRESH_MAX_MS,
  LIVE_TICKER_DEFAULT_TIMEOUT_MS,
  LIVE_TICKER_DEFAULT_TTL_MS,
  LIVE_TICKER_MAX_TIMEOUT_MS,
  LIVE_TICKER_MAX_TTL_MS,
  LIVE_TICKER_MIN_TIMEOUT_MS,
} from "./live_read_defaults.ts";
import {
  LIVE_PENDING_DEFAULT_MAX_CUSTOMERS,
  LIVE_PENDING_DEFAULT_TIMEOUT_MS,
  LIVE_PENDING_MAX_MAX_CUSTOMERS,
  LIVE_PENDING_MAX_TIMEOUT_MS,
  LIVE_PENDING_MIN_TIMEOUT_MS,
} from "./f402_live_pending.ts";
import {
  livePendingArtifact,
  type LiveBetsArtifact,
  type LiveBetsSummary,
} from "./live_bets.ts";
import { resolveLiveBets } from "../src/live_bets/resolve.ts";
import {
  BET_TICKER_OPERATION,
  liveTickerFile,
  readWagerListArtifact,
  type WagerListArtifact,
} from "./live_wagers.ts";
import {
  persistLiveSnapshot,
  type LivePersistState,
} from "./live_provenance.ts";
import { freshness, STALE_AFTER_SECONDS, type KpiInput } from "./desk_kpis.ts";

export type LiveSourceMode = "auto" | "live" | "file";

export interface LiveDiagnosticBody {
  readonly code: string;
  readonly message?: string;
  readonly hint?: string;
  readonly httpStatus?: number;
}

export interface LiveTickerStatusBody {
  readonly mode: LiveSourceMode;
  readonly status: "live" | "unavailable" | "disabled";
  readonly ok: boolean;
  readonly fetchedAt: string | null;
  readonly servedFromCache: boolean;
  readonly transport: string | null;
  readonly diagnostic: LiveDiagnosticBody | null;
  readonly ttlMs: number;
}

export interface LivePendingStatusBody extends LiveTickerStatusBody {
  readonly customersAttempted: number;
  readonly customersFailed: number;
}

export interface LiveRefreshTelemetry {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly ticks: number;
  readonly lastTickAt: string | null;
  readonly lastTickOk: boolean | null;
  readonly lastError: string | null;
}

export interface LivePersistenceTelemetry {
  readonly enabled: boolean;
  readonly artifactRoot: "repo" | "custom";
  readonly throttleMs: number;
}

export interface LiveStatusBlock {
  readonly ticker: LiveTickerStatusBody | null;
  readonly pending: LivePendingStatusBody | null;
  readonly refresh: LiveRefreshTelemetry;
  readonly persistence: LivePersistenceTelemetry;
}

export interface LiveTickerServerOptions {
  readonly enabled?: boolean;
  readonly fetch?: F402ProbeFetch;
  readonly session?: F402Session | null;
  readonly agentId?: string;
  readonly now?: () => Date;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly ttlMs?: number;
}

export interface LivePendingPersistenceOptions {
  readonly enabled?: boolean;
  readonly rootDir?: string;
  readonly throttleMs?: number;
}

export interface LivePendingServerOptions {
  readonly enabled?: boolean;
  readonly fetch?: F402ProbeFetch;
  readonly session?: F402Session | null;
  readonly customers?: readonly string[];
  readonly now?: () => Date;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly ttlMs?: number;
  readonly maxCustomers?: number;
  readonly persistence?: LivePendingPersistenceOptions;
}

export interface LiveRefreshOptions {
  readonly enabled?: boolean;
  readonly intervalMs?: number;
  readonly jitterMs?: number;
  readonly onStarted?: (stop: () => void) => void;
}

export interface DeskLiveReadsOptions {
  readonly repoRoot: string;
  readonly liveBetsPath: string;
  readonly wagerListDir: string;
  readonly liveTicker?: LiveTickerServerOptions;
  readonly livePending?: LivePendingServerOptions;
  readonly liveRefresh?: LiveRefreshOptions;
  /** When true, the daemon may start the refresh loop from env unless overridden. */
  readonly daemonEntry?: boolean;
  readonly loadWagerList?: () => Promise<{
    readonly chosen: {
      readonly path: string;
      readonly artifact: WagerListArtifact;
      readonly mtime: Date;
    } | null;
    readonly skipped: ReadonlyArray<{ path: string; reason: string }>;
  }>;
}

export interface LiveBetsServeResult {
  readonly httpStatus: number;
  readonly body: Record<string, unknown>;
  readonly etagParts?: string;
}

export interface LiveWagersServeResult {
  readonly httpStatus: number;
  readonly body: Record<string, unknown>;
}

interface TickerCacheEntry {
  readonly status: LiveTickerStatusBody;
  readonly artifact: WagerListArtifact | null;
  readonly rawPayload: unknown | null;
}

interface PendingCacheEntry {
  readonly status: LivePendingStatusBody;
  readonly artifact: LiveBetsArtifact | null;
}

const LIVE_TICKER_GATE = "SPORTSDESK_LIVE_TICKER";
const LIVE_PENDING_GATE = "SPORTSDESK_LIVE_PENDING";
const LIVE_PERSIST_GATE = "SPORTSDESK_LIVE_PERSIST";
const LIVE_PERSIST_ROOT_ENV = "SPORTSDESK_LIVE_PERSIST_ROOT";
const LIVE_REFRESH_ENV = "SPORTSDESK_LIVE_REFRESH_MS";
const LIVE_TICKER_TTL_ENV = "SPORTSDESK_LIVE_TICKER_TTL_MS";
const LIVE_TICKER_TIMEOUT_ENV = "SPORTSDESK_LIVE_TICKER_TIMEOUT_MS";
const LIVE_PENDING_TTL_ENV = "SPORTSDESK_LIVE_PENDING_TTL_MS";
const LIVE_PENDING_TIMEOUT_ENV = "SPORTSDESK_LIVE_PENDING_TIMEOUT_MS";
const LIVE_PENDING_CUSTOMERS_ENV = "SPORTSDESK_LIVE_PENDING_CUSTOMERS";
const LIVE_PENDING_MAX_CUSTOMERS_ENV = "SPORTSDESK_LIVE_PENDING_MAX_CUSTOMERS";
const LIVE_PERSIST_MS_ENV = "SPORTSDESK_LIVE_PERSIST_MS";

const OFF = new Set(["0", "false", "off", "no"]);
const ON = new Set(["1", "true", "on", "yes"]);

function envFlag(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): boolean | undefined {
  const raw = (env[key] ?? "").trim().toLowerCase();
  if (raw === "") return undefined;
  if (OFF.has(raw)) return false;
  if (ON.has(raw)) return true;
  return undefined;
}

function gateEnabled(
  explicit: boolean | undefined,
  env: Readonly<Record<string, string | undefined>>,
  gateVar: string,
): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  const fromEnv = envFlag(env, gateVar);
  if (fromEnv !== undefined) return fromEnv;
  return (env.NODE_ENV ?? "").trim() !== "test";
}

function clampMs(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function parseCustomers(
  env: Readonly<Record<string, string | undefined>>,
  explicit?: readonly string[],
): string[] {
  if (explicit !== undefined) return [...explicit];
  const raw = (env[LIVE_PENDING_CUSTOMERS_ENV] ?? "").trim();
  if (raw === "") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function toDiagnostic(
  diagnostic: LiveTickerDiagnostic | LivePendingDiagnostic,
): LiveDiagnosticBody | null {
  if (diagnostic.code === "ok") return null;
  return {
    code: diagnostic.code,
    ...("message" in diagnostic && typeof diagnostic.message === "string"
      ? { message: diagnostic.message }
      : {}),
    ...("hint" in diagnostic && typeof diagnostic.hint === "string"
      ? { hint: diagnostic.hint }
      : {}),
    ...("httpStatus" in diagnostic && typeof diagnostic.httpStatus === "number"
      ? { httpStatus: diagnostic.httpStatus }
      : {}),
  };
}

function disabledTickerStatus(
  mode: LiveSourceMode,
  ttlMs: number,
): LiveTickerStatusBody {
  return {
    mode,
    status: "disabled",
    ok: false,
    fetchedAt: null,
    servedFromCache: false,
    transport: null,
    diagnostic: null,
    ttlMs,
  };
}

function disabledPendingStatus(
  mode: LiveSourceMode,
  ttlMs: number,
): LivePendingStatusBody {
  return {
    ...disabledTickerStatus(mode, ttlMs),
    customersAttempted: 0,
    customersFailed: 0,
  };
}

export function parseLiveSourceMode(
  raw: string | null,
): LiveSourceMode | "invalid" {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "live";
  if (value === "auto" || value === "live" || value === "file") return value;
  return "invalid";
}

export function createDeskLiveReads(options: DeskLiveReadsOptions) {
  const tickerOpt = options.liveTicker ?? {};
  const pendingOpt = options.livePending ?? {};
  const tickerEnv = tickerOpt.env ?? Bun.env;
  const pendingEnv = pendingOpt.env ?? Bun.env;
  const tickerNow = tickerOpt.now ?? (() => new Date());
  const pendingNow = pendingOpt.now ?? tickerNow;

  const tickerGateOn = gateEnabled(
    tickerOpt.enabled,
    tickerEnv,
    LIVE_TICKER_GATE,
  );
  const pendingGateOn = gateEnabled(
    pendingOpt.enabled,
    pendingEnv,
    LIVE_PENDING_GATE,
  );

  const tickerTtlMs = clampMs(
    tickerOpt.ttlMs === undefined
      ? tickerEnv[LIVE_TICKER_TTL_ENV]
      : String(tickerOpt.ttlMs),
    LIVE_TICKER_DEFAULT_TTL_MS,
    0,
    LIVE_TICKER_MAX_TTL_MS,
  );
  const pendingTtlMs = clampMs(
    pendingOpt.ttlMs === undefined
      ? pendingEnv[LIVE_PENDING_TTL_ENV]
      : String(pendingOpt.ttlMs),
    LIVE_PENDING_DEFAULT_TTL_MS,
    0,
    LIVE_PENDING_MAX_TTL_MS,
  );

  const tickerTimeoutMs = clampMs(
    tickerOpt.timeoutMs === undefined
      ? tickerEnv[LIVE_TICKER_TIMEOUT_ENV]
      : String(tickerOpt.timeoutMs),
    LIVE_TICKER_DEFAULT_TIMEOUT_MS,
    LIVE_TICKER_MIN_TIMEOUT_MS,
    LIVE_TICKER_MAX_TIMEOUT_MS,
  );

  const pendingTimeoutMs = clampMs(
    pendingOpt.timeoutMs === undefined
      ? pendingEnv[LIVE_PENDING_TIMEOUT_ENV]
      : String(pendingOpt.timeoutMs),
    LIVE_PENDING_DEFAULT_TIMEOUT_MS,
    LIVE_PENDING_MIN_TIMEOUT_MS,
    LIVE_PENDING_MAX_TIMEOUT_MS,
  );

  const pendingMaxCustomers = clampMs(
    pendingOpt.maxCustomers === undefined
      ? pendingEnv[LIVE_PENDING_MAX_CUSTOMERS_ENV]
      : String(pendingOpt.maxCustomers),
    LIVE_PENDING_DEFAULT_MAX_CUSTOMERS,
    1,
    LIVE_PENDING_MAX_MAX_CUSTOMERS,
  );

  const persistExplicit = pendingOpt.persistence?.enabled;
  const persistGateOn =
    persistExplicit === true ||
    (persistExplicit !== false &&
      (envFlag(pendingEnv, LIVE_PERSIST_GATE) ??
        pendingEnv.NODE_ENV !== "test"));

  const persistThrottleMs = clampMs(
    pendingOpt.persistence?.throttleMs === undefined
      ? pendingEnv[LIVE_PERSIST_MS_ENV]
      : String(pendingOpt.persistence?.throttleMs),
    LIVE_PERSIST_DEFAULT_THROTTLE_MS,
    0,
    600_000,
  );

  const persistRootExplicit =
    pendingOpt.persistence?.rootDir ?? pendingEnv[LIVE_PERSIST_ROOT_ENV];
  const injectedFetch =
    tickerOpt.fetch !== undefined || pendingOpt.fetch !== undefined;
  const persistRoot = resolve(
    persistRootExplicit ??
      (injectedFetch
        ? mkdtempSync(join(tmpdir(), "sportsdesk-live-persist-"))
        : options.repoRoot),
  );
  const persistRootKind: "repo" | "custom" =
    resolve(persistRoot) === resolve(options.repoRoot) ? "repo" : "custom";

  let tickerCache: TickerCacheEntry | null = null;
  let tickerCacheAt = 0;
  let pendingCache: PendingCacheEntry | null = null;
  let pendingCacheAt = 0;
  let tickerRowsForScope: readonly Record<string, unknown>[] = [];

  let persistTickerState: LivePersistState | null = null;
  let persistPendingState: LivePersistState | null = null;

  let statusTicker: LiveTickerStatusBody | null = null;
  let statusPending: LivePendingStatusBody | null = null;

  let refreshTicks = 0;
  let refreshLastAt: string | null = null;
  let refreshLastOk: boolean | null = null;
  let refreshLastError: string | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  const refreshEnv: Readonly<Record<string, string | undefined>> = {
    ...Bun.env,
    ...tickerEnv,
    ...pendingEnv,
  };

  function readRefreshEnvMs(
    env: Readonly<Record<string, string | undefined>>,
  ): number | null {
    const raw = env[LIVE_REFRESH_ENV];
    if (raw === undefined || raw.trim() === "") return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(LIVE_REFRESH_MAX_MS, Math.max(0, Math.trunc(parsed)));
  }

  const envRefreshMs = readRefreshEnvMs(refreshEnv);
  const statusRefreshIntervalMs =
    options.liveRefresh?.intervalMs ?? envRefreshMs ?? LIVE_REFRESH_DEFAULT_MS;

  function refreshEnabled(): boolean {
    if (options.liveRefresh?.enabled === false) return false;
    if (options.liveRefresh?.enabled === true) {
      if (options.liveRefresh.intervalMs !== undefined) return true;
      return statusRefreshIntervalMs > 0;
    }
    if (options.daemonEntry === true) {
      return statusRefreshIntervalMs > 0;
    }
    return false;
  }

  function loopIntervalMs(): number {
    if (options.liveRefresh?.intervalMs !== undefined) {
      return options.liveRefresh.intervalMs;
    }
    if (envRefreshMs !== null) {
      return envRefreshMs > 0 ? envRefreshMs : LIVE_REFRESH_DEFAULT_MS;
    }
    return LIVE_REFRESH_DEFAULT_MS;
  }

  const refreshIntervalMs = loopIntervalMs();

  function cacheFresh(at: number, ttlMs: number, nowMs: number): boolean {
    return ttlMs > 0 && nowMs - at < ttlMs;
  }

  function tickerStatusFromFetch(
    mode: LiveSourceMode,
    servedFromCache: boolean,
    result: Awaited<ReturnType<typeof fetchLiveBetTicker>>,
  ): LiveTickerStatusBody {
    if (!tickerGateOn) {
      return disabledTickerStatus(mode, tickerTtlMs);
    }
    return {
      mode,
      status: result.ok ? "live" : "unavailable",
      ok: result.ok,
      fetchedAt: result.observedAt,
      servedFromCache,
      transport: result.transport,
      diagnostic: toDiagnostic(result.diagnostic),
      ttlMs: tickerTtlMs,
    };
  }

  function pendingStatusFromFetch(
    mode: LiveSourceMode,
    servedFromCache: boolean,
    result: Awaited<ReturnType<typeof fetchLivePending>>,
  ): LivePendingStatusBody {
    if (!pendingGateOn) {
      return disabledPendingStatus(mode, pendingTtlMs);
    }
    return {
      mode,
      status: result.ok ? "live" : "unavailable",
      ok: result.ok,
      fetchedAt: result.observedAt,
      servedFromCache,
      transport: result.transport,
      diagnostic: toDiagnostic(result.diagnostic),
      customersAttempted: result.customersAttempted,
      customersFailed: result.customersFailed,
      ttlMs: pendingTtlMs,
    };
  }

  async function persistTicker(
    payload: unknown,
    observedAt: string,
    transport: string | null,
    rowCount: number,
    servedFromCache: boolean,
  ): Promise<void> {
    if (!persistGateOn || servedFromCache) return;
    const file = liveTickerFile(payload, observedAt);
    const artifactText = `${JSON.stringify(file)}\n`;
    try {
      const outcome = await persistLiveSnapshot({
        rootDir: persistRoot,
        throttleMs: persistThrottleMs,
        now: tickerNow(),
        previous: persistTickerState,
        snapshot: {
          source: "getBetTicker",
          operation: BET_TICKER_OPERATION,
          artifactPath: "data/live-wagers.json",
          artifactText,
          observedAt,
          transport,
          httpStatus: 200,
          rows: rowCount,
          partial: false,
        },
      });
      persistTickerState = outcome.state;
    } catch {
      // Persistence failure never fails the HTTP response.
    }
  }

  async function persistPending(
    artifact: LiveBetsArtifact,
    transport: string | null,
    servedFromCache: boolean,
  ): Promise<void> {
    if (!persistGateOn || servedFromCache) return;
    const artifactText = `${JSON.stringify(artifact)}\n`;
    try {
      const outcome = await persistLiveSnapshot({
        rootDir: persistRoot,
        throttleMs: persistThrottleMs,
        now: pendingNow(),
        previous: persistPendingState,
        snapshot: {
          source: "Pending",
          operation: REPORT_PENDING_OPERATION,
          artifactPath: "data/live-bets.json",
          artifactText,
          observedAt: artifact.capturedAt ?? pendingNow().toISOString(),
          transport,
          httpStatus: 200,
          rows: artifact.pendingCount,
          partial: false,
        },
      });
      persistPendingState = outcome.state;
    } catch {
      // Persistence failure never fails the HTTP response.
    }
  }

  async function readTickerLive(
    mode: LiveSourceMode,
    force: boolean,
  ): Promise<TickerCacheEntry> {
    const nowMs = tickerNow().getTime();
    if (
      !force &&
      tickerCache !== null &&
      cacheFresh(tickerCacheAt, tickerTtlMs, nowMs)
    ) {
      return {
        ...tickerCache,
        status: { ...tickerCache.status, mode, servedFromCache: true },
      };
    }

    if (!tickerGateOn || mode === "file") {
      const status = disabledTickerStatus(mode, tickerTtlMs);
      const entry = { status, artifact: null, rawPayload: null };
      tickerCache = entry;
      tickerCacheAt = nowMs;
      return entry;
    }

    const result = await fetchLiveBetTicker({
      ...(tickerOpt.fetch === undefined ? {} : { fetchImpl: tickerOpt.fetch }),
      ...(tickerOpt.session === undefined
        ? {}
        : { session: tickerOpt.session }),
      ...(tickerOpt.agentId === undefined
        ? {}
        : { agentId: tickerOpt.agentId }),
      timeoutMs: tickerTimeoutMs,
      now: tickerNow(),
      env: tickerEnv,
    });

    const status = tickerStatusFromFetch(mode, false, result);
    let artifact: WagerListArtifact | null = null;
    let rawPayload: unknown = null;

    if (result.ok) {
      rawPayload = { LIST: result.rows };
      tickerRowsForScope = result.rows;
      artifact = readWagerListArtifact(
        liveTickerFile(rawPayload, result.observedAt),
      );
      await persistTicker(
        rawPayload,
        result.observedAt,
        result.transport,
        result.rows.length,
        false,
      );
    }

    const entry: TickerCacheEntry = { status, artifact, rawPayload };
    tickerCache = entry;
    tickerCacheAt = nowMs;
    return entry;
  }

  async function resolvePendingCustomers(): Promise<string[]> {
    const explicit = parseCustomers(pendingEnv, pendingOpt.customers);
    if (explicit.length > 0) return explicit;
    return pendingCustomersFromTickerRows(
      tickerRowsForScope,
      pendingMaxCustomers,
    );
  }

  async function readPendingLive(
    mode: LiveSourceMode,
    force: boolean,
  ): Promise<PendingCacheEntry> {
    const nowMs = pendingNow().getTime();
    if (
      !force &&
      pendingCache !== null &&
      cacheFresh(pendingCacheAt, pendingTtlMs, nowMs)
    ) {
      return {
        ...pendingCache,
        status: { ...pendingCache.status, mode, servedFromCache: true },
      };
    }

    if (!pendingGateOn || mode === "file") {
      const status = disabledPendingStatus(mode, pendingTtlMs);
      const entry = { status, artifact: null };
      pendingCache = entry;
      pendingCacheAt = nowMs;
      return entry;
    }

    if (
      pendingOpt.customers === undefined &&
      parseCustomers(pendingEnv).length === 0 &&
      tickerGateOn &&
      tickerRowsForScope.length === 0
    ) {
      await readTickerLive("auto", false);
    }

    const customers = await resolvePendingCustomers();
    const result = await fetchLivePending({
      customers,
      ...(pendingOpt.fetch === undefined
        ? {}
        : { fetchImpl: pendingOpt.fetch }),
      ...(pendingOpt.session === undefined
        ? {}
        : { session: pendingOpt.session }),
      maxCustomers: pendingMaxCustomers,
      timeoutMs: pendingTimeoutMs,
      now: pendingNow(),
      env: pendingEnv,
    });

    const status = pendingStatusFromFetch(mode, false, result);
    let artifact: LiveBetsArtifact | null = null;
    if (result.ok) {
      artifact = livePendingArtifact(result.rows, {
        operation: REPORT_PENDING_OPERATION,
        capturedAt: result.observedAt,
      });
      await persistPending(artifact, result.transport, false);
    }

    const entry: PendingCacheEntry = { status, artifact };
    pendingCache = entry;
    pendingCacheAt = nowMs;
    return entry;
  }

  async function loadFileWagers(): Promise<{
    chosen: {
      readonly path: string;
      readonly artifact: WagerListArtifact;
      readonly mtime: Date;
    } | null;
    skipped: ReadonlyArray<{ path: string; reason: string }>;
  }> {
    if (options.loadWagerList === undefined) {
      return { chosen: null, skipped: [] };
    }
    return options.loadWagerList();
  }

  async function refreshTick(): Promise<void> {
    if (!tickerGateOn && !pendingGateOn) return;
    refreshTicks += 1;
    refreshLastAt = pendingNow().toISOString();
    refreshLastError = null;
    try {
      const ticker = await readTickerLive("auto", true);
      statusTicker = ticker.status;
      const pending = await readPendingLive("auto", true);
      statusPending = pending.status;
      refreshLastOk = ticker.status.ok && pending.status.ok;
      if (!refreshLastOk) {
        const parts: string[] = [];
        if (!ticker.status.ok && ticker.status.diagnostic?.code) {
          parts.push(ticker.status.diagnostic.code);
        }
        if (!pending.status.ok && pending.status.diagnostic?.code) {
          parts.push(pending.status.diagnostic.code);
        }
        refreshLastError = parts.join("; ") || "live read failed";
      }
    } catch (error) {
      refreshLastOk = false;
      refreshLastError = error instanceof Error ? error.message : String(error);
    }
  }

  function startRefreshLoop(): (() => void) | null {
    if (!refreshEnabled() || refreshTimer !== null) return null;
    const jitter =
      options.liveRefresh?.jitterMs === undefined
        ? 0
        : Math.max(0, options.liveRefresh.jitterMs);
    const intervalMs = Math.max(1, refreshIntervalMs + jitter);
    const stop = (): void => {
      if (refreshTimer !== null) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    };
    refreshTimer = setInterval(() => {
      void refreshTick();
    }, intervalMs);
    options.liveRefresh?.onStarted?.(stop);
    return stop;
  }

  function statusBlock(options?: { exposeReads?: boolean }): LiveStatusBlock {
    const expose =
      options?.exposeReads === true || (refreshEnabled() && refreshTicks > 0);
    return {
      ticker: expose ? statusTicker : null,
      pending: expose ? statusPending : null,
      refresh: {
        enabled: refreshEnabled(),
        intervalMs: statusRefreshIntervalMs,
        ticks: refreshTicks,
        lastTickAt: refreshLastAt,
        lastTickOk: refreshLastOk,
        lastError: refreshLastError,
      },
      persistence: {
        enabled: persistGateOn,
        artifactRoot: persistRootKind,
        throttleMs: persistThrottleMs,
      },
    };
  }

  return {
    tickerGateOn,
    pendingGateOn,
    persistGateOn,
    startRefreshLoop,
    statusBlock,

    async readLivePendingArtifact(): Promise<LiveBetsArtifact | null> {
      const live = await readPendingLive("live", false);
      return live.status.status === "live" ? live.artifact : null;
    },

    async serveLiveBets(mode: LiveSourceMode): Promise<LiveBetsServeResult> {
      const now = pendingNow();
      const live = await readPendingLive(mode, false);

      const useLive = live.status.status === "live" && live.artifact !== null;
      if (mode === "live" && !useLive) {
        return {
          httpStatus: 503,
          body: {
            success: false,
            error: "live Report/Pending unavailable",
            live: live.status,
          },
        };
      }

      const resolved =
        useLive && mode !== "file"
          ? await resolveLiveBets(
              { source: "db", fallback: "strict" },
              {
                repoRoot: options.repoRoot,
                readDb: async () => live.artifact,
                now: () => now,
                scoreboard: null,
              },
            )
          : await resolveLiveBets(
              {
                source: "file",
                fallback: "strict",
                path: options.liveBetsPath,
              },
              {
                repoRoot: options.repoRoot,
                defaultFilePath: options.liveBetsPath,
                now: () => now,
                scoreboard: null,
              },
            );

      const { summary } = resolved;
      const fresh = freshness(
        summary.capturedAt,
        now,
        STALE_AFTER_SECONDS.liveBets,
        now,
      );

      const liveStatus =
        mode === "file"
          ? disabledPendingStatus("file", pendingTtlMs)
          : { ...live.status, mode };

      return {
        httpStatus: 200,
        etagParts: `${summary.dataSource}|${summary.capturedAt}|${JSON.stringify(liveStatus)}`,
        body: {
          success: true,
          games: resolved.games,
          agents: resolved.agents,
          pendingCount: summary.totalPending,
          summary,
          freshness: fresh,
          live: liveStatus,
          generatedAt: now.toISOString(),
        },
      };
    },

    async serveLiveBetsSummary(
      mode: LiveSourceMode,
    ): Promise<LiveBetsServeResult> {
      const full = await this.serveLiveBets(mode);
      if (full.httpStatus !== 200) return full;
      const body = full.body;
      const summary = body.summary as LiveBetsSummary;
      const etagParts = `${full.etagParts}|${summary.totalGames}|${summary.totalWagered}|${summary.totalToWin}|${summary.totalPending}`;
      return {
        httpStatus: 200,
        etagParts,
        body: {
          success: true,
          summary,
          generatedAt: body.generatedAt,
          freshness: body.freshness,
          live: body.live,
        },
      };
    },

    async serveLiveWagers(
      mode: LiveSourceMode,
      fileSelection: Awaited<ReturnType<typeof loadFileWagers>>,
    ): Promise<LiveWagersServeResult> {
      const now = tickerNow();
      const live = await readTickerLive(mode, false);
      const skipped = [...fileSelection.skipped];

      if (mode === "file") {
        const chosen = fileSelection.chosen;
        if (chosen === null) {
          return {
            httpStatus: 404,
            body: {
              error: "no live wager list",
              hint: "run bun run capture:bet-ticker (writes data/bet-ticker.json), or save a ticker paste as data/live-wagers.json, and reload",
              skipped,
              live: disabledTickerStatus("file", tickerTtlMs),
            },
          };
        }
        return {
          httpStatus: 200,
          body: {
            success: true,
            provenance: chosen.artifact.provenance,
            freshness: freshness(
              chosen.artifact.provenance.observedAt,
              chosen.mtime,
              STALE_AFTER_SECONDS.liveWagers,
              now,
            ),
            skipped,
            wagers: chosen.artifact.wagers,
            live: disabledTickerStatus("file", tickerTtlMs),
          },
        };
      }

      const liveArtifact = live.artifact;
      const liveOk = live.status.status === "live" && liveArtifact !== null;

      if (mode === "live" && !liveOk) {
        return {
          httpStatus: 503,
          body: {
            success: false,
            error: "live getBetTicker unavailable",
            live: live.status,
          },
        };
      }

      if (liveOk) {
        skipped.push(...fileSelection.skipped);
        if (fileSelection.chosen !== null) {
          skipped.push({
            path: fileSelection.chosen.path,
            reason: "older than live:getBetTicker",
          });
        }
        const artifact = liveArtifact!;
        const { ageSeconds: _age, ...fresh } = freshness(
          artifact.provenance.observedAt,
          now,
          STALE_AFTER_SECONDS.liveWagers,
          now,
        );
        return {
          httpStatus: 200,
          body: {
            success: true,
            provenance: artifact.provenance,
            freshness: fresh,
            skipped,
            wagers: artifact.wagers,
            live: live.status,
          },
        };
      }

      const chosen = fileSelection.chosen;
      if (chosen === null) {
        return {
          httpStatus: 404,
          body: {
            error: "no live wager list",
            hint: "Set F402_AGENT_ID or the f402-agent-id keychain entry, run bun run session:login, run bun run capture:bet-ticker (writes data/bet-ticker.json), or save a ticker paste as data/live-wagers.json, and reload",
            skipped,
            live: live.status,
          },
        };
      }

      const { ageSeconds: _age, ...fresh } = freshness(
        chosen.artifact.provenance.observedAt,
        chosen.mtime,
        STALE_AFTER_SECONDS.liveWagers,
        now,
      );
      return {
        httpStatus: 200,
        body: {
          success: true,
          provenance: chosen.artifact.provenance,
          freshness: fresh,
          skipped,
          wagers: chosen.artifact.wagers,
          live: live.status,
        },
      };
    },

    async kpiLiveInputs(): Promise<{
      live: LiveTickerStatusBody;
      livePending: LivePendingStatusBody;
      liveBets: KpiInput<LiveBetsArtifact> | null;
      liveWagers: KpiInput<WagerListArtifact> | null;
    }> {
      const now = pendingNow();
      const [ticker, pending, fileBets, fileWagers] = await Promise.all([
        readTickerLive("auto", false),
        readPendingLive("auto", false),
        resolveLiveBets(
          { source: "file", fallback: "strict", path: options.liveBetsPath },
          {
            repoRoot: options.repoRoot,
            defaultFilePath: options.liveBetsPath,
            now: () => now,
            scoreboard: null,
          },
        ),
        loadFileWagers(),
      ]);

      const liveBets: KpiInput<LiveBetsArtifact> | null =
        pending.artifact !== null && pending.status.ok
          ? { value: pending.artifact, mtime: now }
          : fileBets.dataSource !== "none" &&
              fileBets.summary.dataSource !== "none"
            ? {
                value: {
                  schemaVersion: 1,
                  dataSource: fileBets.summary.dataSource,
                  capturedAt: fileBets.summary.capturedAt,
                  operation: REPORT_PENDING_OPERATION,
                  pendingCount: fileBets.pendingCount,
                  agents: fileBets.agents,
                  games: fileBets.games,
                },
                mtime: now,
              }
            : null;

      const liveWagers: KpiInput<WagerListArtifact> | null =
        ticker.artifact !== null && ticker.status.ok
          ? { value: ticker.artifact, mtime: now }
          : fileWagers.chosen === null
            ? null
            : {
                value: fileWagers.chosen.artifact,
                mtime: fileWagers.chosen.mtime,
              };

      return {
        live: ticker.status,
        livePending: pending.status,
        liveBets,
        liveWagers,
      };
    },
  };
}

export type DeskLiveReads = ReturnType<typeof createDeskLiveReads>;
