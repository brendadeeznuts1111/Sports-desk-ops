/**
 * Compose a read-only execution plan from the v3 signal pipeline plus public venue books.
 *
 * The plan is pure-orchestration: watchlist signals → Kalshi join (public books) → Polymarket
 * quote (gamma + CLOB public books) → decisions → paper/ledger state. Nothing here places an
 * order; the only live call in the feature is in the run route, behind its gate.
 */
import { resolve } from "node:path";
import { KalshiClient } from "./kalshi_client.ts";
import { PolymarketQuoteClient } from "./polymarket_quote.ts";
import {
  decideExecutions,
  kalshiBookView,
  policyFromEnv,
  type ExecutionDecision,
  type ExecutionMode,
  type ExecutionPolicy,
  type ExecutionRiskState,
  type VenueReadiness,
} from "./execution_decision.ts";
import {
  readExecutionLedger,
  summarizeExecutionLedger,
  type ExecutionLedgerState,
  type LedgerSummary,
  type PaperFill,
  type PaperQuote,
  type QuoteBook,
} from "./execution_paper.ts";
import {
  joinConfigFromEnv,
  joinWatchlistSignals,
  type JoinedSignal,
} from "./kalshi_signal_join.ts";
import {
  deriveWatchlistSignals,
  loadWatchlistSignalInputs,
  type WatchlistSignal,
} from "./watchlist_signal_engine.ts";

export interface KalshiLiveReady {
  readonly ready: boolean;
  readonly reason: string | null;
}

const KALSHI_ADAPTER_SPECIFIER = "../lib/kalshi_live_execution.ts";

/** The adapter's async readiness shape (reason is always a string, "ready" when true). */
interface LiveAdapterModule {
  readonly resolveKalshiCredentials?: (options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly getSecret?: (name: string) => Promise<string | null>;
  }) => Promise<unknown>;
  readonly kalshiLiveReady?: (options?: unknown) => Promise<{
    readonly ready?: unknown;
    readonly reason?: unknown;
  }>;
  readonly placeKalshiOrder?: (options: {
    readonly decision: ExecutionDecision;
    readonly fetchImpl?: typeof fetch;
    readonly now?: Date;
  }) => Promise<{
    readonly ok?: unknown;
    readonly reason?: unknown;
    readonly detail?: unknown;
    readonly venueOrderId?: unknown;
    readonly status?: unknown;
    readonly filledCount?: unknown;
    readonly avgPriceUsd?: unknown;
  }>;
}

async function loadLiveAdapter(): Promise<LiveAdapterModule | null> {
  try {
    const loaded = (await import(KALSHI_ADAPTER_SPECIFIER)) as unknown;
    if (typeof loaded !== "object" || loaded === null) return null;
    return loaded as LiveAdapterModule;
  } catch {
    return null;
  }
}

/**
 * Whether the Kalshi live adapter is installed and armed.
 *
 * The adapter is owned by another module and may not exist yet; a missing file is a reason, not a
 * crash. The specifier is resolved at runtime so this checkout type-checks without it.
 */
export async function resolveKalshiLiveReady(
  root: string,
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): Promise<KalshiLiveReady> {
  void env;
  const exists = await Bun.file(
    resolve(root, "lib/kalshi_live_execution.ts"),
  ).exists();
  if (!exists) {
    return {
      ready: false,
      reason: "kalshi live adapter not installed in this checkout",
    };
  }
  const adapter = await loadLiveAdapter();
  if (adapter === null) {
    return { ready: false, reason: "kalshi live adapter has no exports" };
  }
  if (typeof adapter.kalshiLiveReady !== "function") {
    return {
      ready: false,
      reason: "kalshi live adapter has no kalshiLiveReady()",
    };
  }
  try {
    // The adapter's readiness resolver is async (credential lookup/keychain read). When the
    // caller injects an env view (tests, an offline plan), keep it hermetic: no OS keychain
    // fallback, or a machine with Kalshi secrets would make readiness non-deterministic.
    const injectedEnv = env !== Bun.env;
    const readiness =
      injectedEnv && typeof adapter.resolveKalshiCredentials === "function"
        ? await adapter.kalshiLiveReady({
            resolveCredentials: () =>
              adapter.resolveKalshiCredentials!({
                env,
                getSecret: async () => null,
              }),
          })
        : await adapter.kalshiLiveReady();
    const ready = readiness.ready === true;
    const reason =
      typeof readiness.reason === "string" && readiness.reason.trim() !== ""
        ? readiness.reason
        : ready
          ? "ready"
          : "not ready";
    return { ready, reason: ready ? null : reason };
  } catch (error) {
    return {
      ready: false,
      reason: `kalshi live adapter failed to load: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export interface LivePlacementResult {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly detail: string | null;
  readonly venueOrderId: string | null;
  readonly status: string | null;
  readonly filledCount: number;
  readonly avgPriceUsd: number | null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Call the live adapter for one decision. Only the run route uses this, behind its gate; it never
 * throws for a refusal (paper/blocked/missing credentials) and never surfaces key material.
 */
export async function placeKalshiLiveOrder(input: {
  readonly decision: ExecutionDecision;
  readonly root: string;
  readonly now: Date;
  readonly fetchImpl?: typeof fetch;
}): Promise<LivePlacementResult> {
  const exists = await Bun.file(
    resolve(input.root, "lib/kalshi_live_execution.ts"),
  ).exists();
  const adapter = exists ? await loadLiveAdapter() : null;
  if (adapter === null || typeof adapter.placeKalshiOrder !== "function") {
    return {
      ok: false,
      reason: "adapter_not_installed",
      detail: "kalshi live adapter is not installed in this checkout",
      venueOrderId: null,
      status: null,
      filledCount: 0,
      avgPriceUsd: null,
    };
  }
  try {
    const raw = await adapter.placeKalshiOrder({
      decision: input.decision,
      now: input.now,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    });
    const record =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)
        : {};
    return {
      ok: record["ok"] === true,
      reason: nullableString(record["reason"]),
      detail: nullableString(record["detail"]),
      venueOrderId: nullableString(record["venueOrderId"]),
      status: nullableString(record["status"]),
      filledCount: finiteNumber(record["filledCount"]) ?? 0,
      avgPriceUsd: finiteNumber(record["avgPriceUsd"]),
    };
  } catch (error) {
    return {
      ok: false,
      reason: "unexpected_error",
      detail:
        error instanceof Error ? error.message.slice(0, 200) : String(error),
      venueOrderId: null,
      status: null,
      filledCount: 0,
      avgPriceUsd: null,
    };
  }
}

export interface ExecutionPlanProvenance {
  readonly fixture: boolean;
  readonly stale: boolean;
  readonly dataMode: string | null;
  readonly asOf: string | null;
  readonly ageSeconds: number | null;
  readonly sources: readonly string[];
}

export interface ExecutionPlanRisk {
  readonly dailyPlannedUsd: number;
  readonly openIntents: number;
  readonly marketExposureUsd: Readonly<Record<string, number>>;
  readonly dailyCapUsd: number;
}

export interface ExecutionPlan {
  readonly generatedAt: string;
  readonly mode: ExecutionMode;
  readonly killSwitch: boolean;
  readonly policy: ExecutionPolicy;
  readonly venues: VenueReadiness;
  readonly risk: ExecutionPlanRisk;
  readonly decisions: readonly ExecutionDecision[];
  readonly paper: {
    readonly quotes: readonly PaperQuote[];
    readonly fills: readonly PaperFill[];
    readonly ledgerTail: LedgerSummary["ledgerTail"];
  };
  readonly provenance: ExecutionPlanProvenance;
  readonly blockedReasons: Readonly<Record<string, number>>;
  readonly kalshiTelemetry: ReturnType<KalshiClient["telemetry"]>;
  readonly polymarketTelemetry: ReturnType<PolymarketQuoteClient["telemetry"]>;
  /** Join results behind the decisions, for callers that want venue detail. */
  readonly joins: readonly JoinedSignal[];
  readonly signals: readonly WatchlistSignal[];
  /** Current order books keyed `<venue>:<token>`, for sweeping resting maker quotes. */
  readonly venueBooks: ReadonlyMap<string, QuoteBook>;
}

export interface BuildExecutionPlanOptions {
  readonly root: string;
  readonly now?: Date;
  readonly limit?: number;
  readonly kalshiFetch?: typeof fetch;
  readonly kalshiNow?: () => number;
  readonly polymarketFetch?: typeof fetch;
  readonly polymarketNow?: () => number;
  readonly policyEnv?: Readonly<Record<string, string | undefined>>;
  /** In-memory operator mode override (POST /api/execution/mode). */
  readonly mode?: ExecutionMode;
  /** Ledger checkout root when it differs from the signal root (tests use a temp dir). */
  readonly ledgerRoot?: string;
  /** Explicit live confirmation for a run; omitted on read-only planning. */
  readonly liveConfirm?: string | null;
  /** Venue readiness override; by default Kalshi readiness comes from the adapter. */
  readonly venues?: VenueReadiness;
  readonly ledger?: ExecutionLedgerState;
  /** Overall public-book lookup budget; the plan degrades instead of hanging a request. */
  readonly budgetMs?: number;
}

function aggregateProvenance(
  signals: readonly WatchlistSignal[],
  now: Date,
): ExecutionPlanProvenance {
  const sources = new Set<string>();
  let fixture = false;
  let stale = false;
  let dataMode: string | null = null;
  let asOf: string | null = null;
  for (const signal of signals) {
    for (const source of signal.provenance.sources) sources.add(source);
    fixture = fixture || signal.provenance.fixture;
    stale = stale || signal.provenance.stale;
    if (dataMode === null && signal.provenance.dataMode !== null) {
      dataMode = signal.provenance.dataMode;
    }
    if (
      signal.provenance.asOf !== null &&
      (asOf === null || signal.provenance.asOf > asOf)
    ) {
      asOf = signal.provenance.asOf;
    }
  }
  const parsed = asOf === null ? null : Date.parse(asOf);
  return {
    fixture,
    stale,
    dataMode,
    asOf,
    ageSeconds:
      parsed !== null && Number.isFinite(parsed)
        ? Math.max(0, Math.floor((now.getTime() - parsed) / 1000))
        : null,
    sources: [...sources].sort(),
  };
}

function blockedReasonsOf(
  decisions: readonly ExecutionDecision[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const decision of decisions) {
    if (!decision.blocked || decision.blockReason === null) continue;
    counts[decision.blockReason] = (counts[decision.blockReason] ?? 0) + 1;
  }
  return counts;
}

/** Build one plan; public reads only, and the Kalshi/Polymarket clients are injectable. */
export async function buildExecutionPlan(
  options: BuildExecutionPlanOptions,
): Promise<ExecutionPlan> {
  const now = options.now ?? new Date();
  const env = options.policyEnv ?? Bun.env;
  const policyFromEnvValue = policyFromEnv(env);
  const mode: ExecutionMode = options.mode ?? policyFromEnvValue.mode;
  const policy: ExecutionPolicy = { ...policyFromEnvValue, mode };
  const ledgerRoot = options.ledgerRoot ?? options.root;
  const ledger = options.ledger ?? readExecutionLedger(ledgerRoot);
  const summary = summarizeExecutionLedger(ledger, now);

  const kalshiReady = await resolveKalshiLiveReady(options.root, env);
  const venues: VenueReadiness = options.venues ?? {
    kalshi: { liveReady: kalshiReady.ready, reason: kalshiReady.reason },
    polymarket: {
      liveReady: false,
      reason:
        "Polymarket live has no EIP-712 signer in this checkout (viem/ethers absent); paper only",
    },
  };

  const inputs = await loadWatchlistSignalInputs(options.root);
  const limit = Math.max(1, Math.min(200, options.limit ?? 25));
  const signals = deriveWatchlistSignals(inputs, { now });
  const selected = signals.slice(0, limit);

  const kalshi = new KalshiClient({
    ...(options.kalshiFetch === undefined
      ? {}
      : { fetchImpl: options.kalshiFetch }),
    ...(options.kalshiNow === undefined ? {} : { now: options.kalshiNow }),
  });
  const polymarket = new PolymarketQuoteClient({
    ...(options.polymarketFetch === undefined
      ? {}
      : { fetchImpl: options.polymarketFetch }),
    ...(options.polymarketNow === undefined
      ? {}
      : { now: options.polymarketNow }),
  });
  // Public-book lookups are slow (Kalshi per-series events, Polymarket gamma+CLOB per signal):
  // run both venues concurrently under one budget and degrade with an explicit reason rather
  // than letting an internal route probe time out.
  const budgetMs = Math.max(250, options.budgetMs ?? 1_800);
  const joinTask = joinWatchlistSignals(selected, {
    client: kalshi,
    config: joinConfigFromEnv(env),
  }).then((value) => ({ value, timedOut: false as const }));
  const quoteTask = (async () => {
    const out = new Map<
      string,
      Awaited<ReturnType<PolymarketQuoteClient["quoteForTeams"]>>
    >();
    for (let index = 0; index < selected.length; index += 4) {
      const batch = selected.slice(index, index + 4);
      const results = await Promise.all(
        batch.map((signal) => polymarket.quoteForTeams(signal.teams)),
      );
      results.forEach((quote, offset) => {
        const signal = batch[offset];
        if (signal !== undefined) out.set(signal.id, quote);
      });
    }
    return out;
  })().then((value) => ({ value, timedOut: false as const }));
  const timeout = new Promise<{ value: null; timedOut: true }>((resolve) => {
    const timer = setTimeout(
      () => resolve({ value: null, timedOut: true }),
      budgetMs,
    );
    timer.unref?.();
  });
  const [joinOutcome, quoteOutcome] = await Promise.all([
    Promise.race([joinTask, timeout]),
    Promise.race([quoteTask, timeout]),
  ]);
  const budgetTimedOut = joinOutcome.timedOut || quoteOutcome.timedOut;
  const joins = joinOutcome.value ?? [];
  const quotes: ReadonlyMap<
    string,
    Awaited<ReturnType<PolymarketQuoteClient["quoteForTeams"]>>
  > = quoteOutcome.value ?? new Map();

  const risk: ExecutionRiskState = {
    dailyPlannedUsd: summary.dailyPlannedUsd,
    openIntents: summary.openIntents,
    marketExposureUsd: summary.marketExposureUsd,
    recentIntents: summary.recentIntents,
  };
  const items = joins.map((join) => {
    const signal =
      selected.find((candidate) => candidate.id === join.id) ?? join;
    return {
      signal,
      join: join.kalshi,
      polymarket: quotes.get(join.id) ?? null,
    };
  });
  const decisions = decideExecutions({
    items,
    policy,
    risk,
    venues,
    now,
    ...(options.liveConfirm === undefined
      ? {}
      : { liveConfirm: options.liveConfirm }),
  });

  const venueBooks = new Map<string, QuoteBook>();
  for (const join of joins) {
    const view = kalshiBookView(join.kalshi, false, null);
    if (view !== null && view.tickerToken !== "") {
      venueBooks.set(`kalshi:${view.tickerToken}`, {
        asks: view.asks,
        bids: view.bids,
      });
    }
  }
  for (const quote of quotes.values()) {
    if (!quote.available) continue;
    for (const outcome of quote.outcomes) {
      venueBooks.set(`polymarket:${outcome.tokenId}`, {
        asks: outcome.asks,
        bids: outcome.bids,
      });
    }
  }

  return {
    generatedAt: now.toISOString(),
    mode,
    killSwitch: mode === "paused",
    policy,
    venues,
    risk: {
      dailyPlannedUsd: summary.dailyPlannedUsd,
      openIntents: summary.openIntents,
      marketExposureUsd: summary.marketExposureUsd,
      dailyCapUsd: policy.maxDailyPlannedUsd,
    },
    decisions,
    paper: {
      quotes: summary.openQuotes,
      fills: summary.fills,
      ledgerTail: summary.ledgerTail,
    },
    provenance: aggregateProvenance(signals, now),
    blockedReasons: budgetTimedOut
      ? { plan_budget_exceeded: selected.length }
      : blockedReasonsOf(decisions),
    kalshiTelemetry: kalshi.telemetry(),
    polymarketTelemetry: polymarket.telemetry(),
    joins,
    signals,
    venueBooks,
  };
}
