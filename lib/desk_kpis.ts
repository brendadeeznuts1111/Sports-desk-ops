/**
 * The dashboard's headline figures, derived from the artifacts the daemon already serves.
 *
 * The KPI strip used to be literals in the markup (668 agents, 9,435 accounts, $2.79M handle,
 * $10.49M hold) that traced to no capture. Each figure here carries its source, when it was
 * observed and whether that is too old to trust, so a stale capture reads as stale instead of
 * as today's book.
 *
 * Counts and sums only: no login, customer id or agent key leaves this module, which is what lets
 * `/api/kpis` stay public (`aggregate`) while `/api/live-bets` and `/api/live-wagers` stay guarded.
 */

import { isFixtureAgentTreeGraphSource } from "./agent_tree.ts";
import type { LiveBetsArtifact } from "./live_bets.ts";
import { summarizeLiveWagers, type WagerListArtifact } from "./live_wagers.ts";

/** `fixture` is demo data; it is shown so the card is not empty, never as the book. */
export type KpiBasis = "capture" | "paste" | "fixture";

/** Map artifact `source` / `dataSource` strings to KPI basis (`live:` counts as capture). */
export function kpiBasisFromSource(source: string): KpiBasis {
  if (source.startsWith("paste:")) return "paste";
  if (source.startsWith("capture:") || source.startsWith("live:")) return "capture";
  // Bridge rollups may stamp the public R2 mirror URL on downstream artifacts.
  if (source.startsWith("https://") && source.includes(".r2.dev/")) return "capture";
  if (source.startsWith("data/")) return "capture";
  return "fixture";
}

export interface KpiProvenance {
  readonly source: string;
  readonly basis: KpiBasis;
  /** When the data was observed: the artifact's own timestamp, else the file's mtime. */
  readonly asOf: string;
  readonly asOfFrom: "artifact" | "file-mtime";
  readonly ageSeconds: number;
  /** Older than `STALE_AFTER_SECONDS` for its kind. Fixtures are never stale, only fixtures. */
  readonly stale: boolean;
  /** The artifact says it is a subset of what the portal showed. */
  readonly partial: boolean;
}

/** An artifact as read from disk, with the file's mtime for artifacts that record no time. */
export interface KpiInput<T> {
  readonly value: T;
  readonly mtime: Date;
}

export interface AgentTreeNodes {
  /** Input graph path stamped by `build:agent-tree` (`source` on `AgentTreeFile`). */
  readonly source?: string;
  readonly nodes?: Record<string, { readonly t?: string | null }>;
}

/** The part of `data/customer-profiles.json` the strip reads. */
export interface CustomerBookSummary {
  readonly generatedAt: string | null;
  readonly book: string;
  readonly customers: number;
  readonly tickets: number;
  readonly lifetimeNetUsd: number;
}

export interface DeskKpiInputs {
  readonly agentTree: KpiInput<AgentTreeNodes> | null;
  readonly liveBets: KpiInput<LiveBetsArtifact> | null;
  readonly liveWagers: KpiInput<WagerListArtifact> | null;
  readonly customerBook: KpiInput<CustomerBookSummary> | null;
}

export interface DeskKpis {
  readonly agents: {
    readonly total: number;
    /** Node type `A` in the tree. */
    readonly agents: number;
    /** Node type `M` in the tree. */
    readonly masters: number;
    /** Nodes with neither `A` nor `M`; the total is agents + masters + unclassified. */
    readonly unclassified: number;
    readonly provenance: KpiProvenance;
  } | null;
  readonly pending: {
    readonly wagers: number;
    readonly tickets: number;
    readonly wageredCents: number;
    readonly toWinCents: number;
    readonly provenance: KpiProvenance;
  } | null;
  readonly ticker: {
    /** Rows that are not `ALERT` mirrors or `BLOCKED` sentinels; risk and volume cover these. */
    readonly wagers: number;
    /** `ALERT` plus `BLOCKED` rows left out of every ticker figure. */
    readonly excludedRows: number;
    readonly live: number;
    readonly riskCents: number;
    readonly volumeCents: number;
    readonly provenance: KpiProvenance;
  } | null;
  readonly customerBook: {
    readonly customers: number;
    readonly tickets: number;
    /** Customer-side lifetime net: negative means the customers lost to the book. */
    readonly customerNetCents: number;
    readonly provenance: KpiProvenance;
  } | null;
}

/** A pending or ticker capture an hour old no longer describes the open book. */
export const STALE_AFTER_SECONDS = {
  agentTree: 7 * 24 * 3600,
  liveBets: 3600,
  liveWagers: 3600,
} as const;

/** How far a recorded time may run ahead of this host's clock and still be believed. */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * An artifact's own observation time in ms, or `null` when it is missing, unparseable or in the
 * future: a future time would never go stale and would outrank every real capture.
 */
export function recordedTime(
  recorded: string | null,
  now: Date,
): number | null {
  const parsed = recorded === null ? Number.NaN : Date.parse(recorded);
  return Number.isFinite(parsed) && parsed <= now.getTime() + MAX_FUTURE_SKEW_MS
    ? parsed
    : null;
}

/**
 * How old an artifact is: its own `recorded` time when `recordedTime` accepts it, else the
 * file's mtime. `staleAfterSeconds: null` means never stale.
 */
export function freshness(
  recorded: string | null,
  mtime: Date,
  staleAfterSeconds: number | null,
  now: Date,
): {
  asOf: string;
  asOfFrom: "artifact" | "file-mtime";
  ageSeconds: number;
  stale: boolean;
} {
  const parsed = recordedTime(recorded, now);
  const fromArtifact = parsed !== null;
  const asOfMs = parsed ?? mtime.getTime();
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - asOfMs) / 1000));
  return {
    asOf: new Date(asOfMs).toISOString(),
    asOfFrom: fromArtifact ? "artifact" : "file-mtime",
    ageSeconds,
    stale: staleAfterSeconds !== null && ageSeconds > staleAfterSeconds,
  };
}

function provenance(
  source: string,
  basis: KpiBasis,
  recorded: string | null,
  mtime: Date,
  staleAfterSeconds: number | null,
  partial: boolean,
  now: Date,
): KpiProvenance {
  const fresh = freshness(recorded, mtime, staleAfterSeconds, now);
  return {
    source,
    basis,
    ...fresh,
    stale: basis !== "fixture" && fresh.stale,
    partial,
  };
}

export function deriveDeskKpis(inputs: DeskKpiInputs, now: Date): DeskKpis {
  const { agentTree, liveBets, liveWagers, customerBook } = inputs;

  const agents = (() => {
    if (agentTree === null) return null;
    const nodes = Object.values(agentTree.value.nodes ?? {});
    const graphSource = (agentTree.value.source ?? "").trim();
    const basis: KpiBasis = isFixtureAgentTreeGraphSource(graphSource)
      ? "fixture"
      : "capture";
    const provenanceSource =
      graphSource !== "" ? graphSource : "data/agent-tree.json";
    return {
      total: nodes.length,
      agents: nodes.filter((node) => node.t === "A").length,
      masters: nodes.filter((node) => node.t === "M").length,
      unclassified: nodes.filter((node) => node.t !== "A" && node.t !== "M")
        .length,
      provenance: provenance(
        provenanceSource,
        basis,
        null,
        agentTree.mtime,
        STALE_AFTER_SECONDS.agentTree,
        false,
        now,
      ),
    };
  })();

  const pending = (() => {
    if (liveBets === null) return null;
    const artifact = liveBets.value;
    return {
      wagers: artifact.pendingCount,
      tickets: artifact.games.length,
      wageredCents: artifact.games.reduce((sum, g) => sum + g.wagered, 0),
      toWinCents: artifact.games.reduce((sum, g) => sum + g.toWin, 0),
      provenance: provenance(
        artifact.dataSource,
        kpiBasisFromSource(artifact.dataSource),
        artifact.capturedAt,
        liveBets.mtime,
        STALE_AFTER_SECONDS.liveBets,
        false,
        now,
      ),
    };
  })();

  const ticker = (() => {
    if (liveWagers === null) return null;
    const { wagers, provenance: filed } = liveWagers.value;
    const summary = summarizeLiveWagers(wagers);
    return {
      wagers: summary.counted,
      excludedRows: summary.excluded.alert + summary.excluded.blocked,
      live: summary.live,
      riskCents: summary.risk,
      volumeCents: summary.volume,
      provenance: provenance(
        filed.source,
        kpiBasisFromSource(filed.source),
        filed.observedAt,
        liveWagers.mtime,
        STALE_AFTER_SECONDS.liveWagers,
        filed.partial,
        now,
      ),
    };
  })();

  // The only book `customers:profiles` builds from is enriched_customers_full.json, a demo
  // fixture (lib/parlay_combo_backtest_engine.ts), so this card is labelled as one.
  const book = (() => {
    if (customerBook === null) return null;
    const summary = customerBook.value;
    return {
      customers: summary.customers,
      tickets: summary.tickets,
      customerNetCents: Math.round(summary.lifetimeNetUsd * 100),
      provenance: provenance(
        summary.book,
        "fixture",
        summary.generatedAt,
        customerBook.mtime,
        null,
        false,
        now,
      ),
    };
  })();

  return { agents, pending, ticker, customerBook: book };
}

function finite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Boundary parse for `data/customer-profiles.json`; `null` when the file is not that shape. */
export function readCustomerBookSummary(
  raw: unknown,
): CustomerBookSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const file = raw as {
    generatedAt?: unknown;
    source?: { book?: unknown };
    summary?: {
      customers?: unknown;
      tickets?: unknown;
      lifetimeNetUsd?: unknown;
    };
  };
  if (typeof file.summary !== "object" || file.summary === null) return null;
  return {
    generatedAt: typeof file.generatedAt === "string" ? file.generatedAt : null,
    book:
      typeof file.source?.book === "string"
        ? file.source.book
        : "data/customer-profiles.json",
    customers: finite(file.summary.customers),
    tickets: finite(file.summary.tickets),
    lifetimeNetUsd: finite(file.summary.lifetimeNetUsd),
  };
}
