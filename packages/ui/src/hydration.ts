/**
 * @file packages/ui/src/hydration.ts
 * @description Browser-safe hydration normalizers, dynamic cohort KPI derivation,
 * Signal-Honesty provenance badges, and zero-DOM feed loader for `@sportsdesk-ops/ui`.
 */

import type {
  SlabPolicySummary,
  WagerTier,
  WagersWireContractSummary,
  WagersWireViolation,
} from "@sportsdesk-ops/contracts";
import type {
  CustomersApiResponse,
  CustomersCohortsSummary,
  DashboardFeedProvenanceKind,
  DashboardSourceProvenance,
  LiveWager,
  TierStyleConfig,
} from "./types.ts";

export const SHOWCASE_WAGERS_PROVENANCE: DashboardSourceProvenance = {
  kind: "showcase",
  label: "Showcase Seed",
  sourcePath: null,
  observedAt: "",
};

export const PENDING_COHORTS_PROVENANCE: DashboardSourceProvenance = {
  kind: "pending",
  label: "Pending Hydration",
  sourcePath: "/api/customers",
  observedAt: "",
};

export interface ProvenanceBadgePresentation {
  readonly badgeText: string;
  readonly fg: string;
  readonly bg: string;
  readonly border: string;
  readonly isLive: boolean;
  readonly detail: string;
}

export interface NormalizedLiveWagersResult {
  readonly wagers: readonly LiveWager[];
  readonly totalRiskUsd: number;
  readonly totalToWinUsd: number;
  readonly criticalSteamCount: number;
  readonly provenance: DashboardSourceProvenance;
  /** Vendor wire-contract summary when the feed host checks it; null otherwise. */
  readonly wireContract: WagersWireContractSummary | null;
  /** Slab policy when the host exposes it; null otherwise. */
  readonly slabPolicy: SlabPolicySummary | null;
}

export type CustomerCohortKpiId =
  | "backtest"
  | "key-number-sharps"
  | "hook-syndicates"
  | "fixtures"
  | "enriched-book"
  | "unique-surveillance";

export type CustomerCohortKpiTone =
  "sky" | "red" | "amber" | "slate" | "emerald" | "violet";

export interface CustomerCohortKpiCard {
  readonly id: CustomerCohortKpiId;
  readonly label: string;
  readonly value: string;
  readonly sub: string;
  readonly status: "pending" | "ready" | "unavailable";
  readonly tone: CustomerCohortKpiTone;
  /** Exact raw count when ready; null when pending or unavailable (never faked as 0). */
  readonly count: number | null;
  /** Percentage share of uniqueSurveillanceCount when ready and denominator > 0; null otherwise. */
  readonly sharePct: number | null;
  /** Optional profile tier filter activated when clicking this card in CustomersTabPanel. */
  readonly filterTier: "ALL" | "ELITE" | "SYNDICATE" | null;
}

const KNOWN_PROVENANCE_KINDS = new Set<DashboardFeedProvenanceKind>([
  "live",
  "capture",
  "fixture",
  "fallback",
  "showcase",
  "pending",
  "unavailable",
]);

function normalizeAlertTier(raw: unknown): WagerTier {
  switch (String(raw ?? "").toUpperCase()) {
    case "CRITICAL":
    case "ORIGINATOR_HIGH_RISK":
      return "CRITICAL";
    case "STEAM":
    case "STEAM_MOVE":
      return "STEAM";
    case "LATENCY":
    case "LATENCY_ARB":
      return "LATENCY";
    default:
      return "RECREATIONAL";
  }
}

function normalizeProvenance(
  raw: unknown,
  fallbackKind: DashboardFeedProvenanceKind,
  fallbackLabel: string,
): DashboardSourceProvenance {
  if (typeof raw === "object" && raw !== null) {
    const rec = raw as Record<string, unknown>;
    const rawKind = String(rec.kind ?? "") as DashboardFeedProvenanceKind;
    const kind = KNOWN_PROVENANCE_KINDS.has(rawKind) ? rawKind : fallbackKind;
    const label =
      typeof rec.label === "string" && rec.label.trim().length > 0
        ? rec.label
        : fallbackLabel;
    const sourcePath =
      typeof rec.sourcePath === "string" && rec.sourcePath.trim().length > 0
        ? rec.sourcePath
        : null;
    const observedAt = typeof rec.observedAt === "string" ? rec.observedAt : "";
    return { kind, label, sourcePath, observedAt };
  }
  return {
    kind: fallbackKind,
    label: fallbackLabel,
    sourcePath: null,
    observedAt: "",
  };
}

/** Format a Signal-Honesty provenance badge (explicitly distinguishing `[not live]` & failures). */
export function formatProvenanceBadge(
  provenance: DashboardSourceProvenance,
  options: {
    readonly staleAfterMinutes?: number | undefined;
    readonly nowMs?: number | undefined;
  } = {},
): ProvenanceBadgePresentation {
  const detail = provenance.sourcePath
    ? `${provenance.label} (${provenance.sourcePath})`
    : provenance.label;
  const observedMs = Date.parse(provenance.observedAt);
  const stale =
    options.staleAfterMinutes !== undefined &&
    Number.isFinite(observedMs) &&
    (options.nowMs ?? Date.now()) - observedMs >
      options.staleAfterMinutes * 60_000;
  const suffix = stale ? " · STALE" : "";

  switch (provenance.kind) {
    case "live":
      return {
        badgeText: `● LIVE CAPTURE${suffix}`,
        fg: "#4ade80",
        bg: "rgba(34, 197, 94, 0.14)",
        border: "rgba(34, 197, 94, 0.4)",
        isLive: true,
        detail,
      };
    case "capture":
      return {
        badgeText: `● LOCAL CAPTURE${suffix}`,
        fg: "#4ade80",
        bg: "rgba(34, 197, 94, 0.14)",
        border: "rgba(34, 197, 94, 0.4)",
        isLive: false,
        detail,
      };
    case "fixture":
      return {
        badgeText: `◐ FIXTURE [not live]${suffix}`,
        fg: "#fbbf24",
        bg: "rgba(245, 158, 11, 0.14)",
        border: "rgba(245, 158, 11, 0.4)",
        isLive: false,
        detail,
      };
    case "fallback":
    case "showcase":
      return {
        badgeText: `◌ SHOWCASE [not live]${suffix}`,
        fg: "#fb923c",
        bg: "rgba(251, 146, 60, 0.14)",
        border: "rgba(251, 146, 60, 0.4)",
        isLive: false,
        detail,
      };
    case "pending":
      return {
        badgeText: "⋯ PENDING",
        fg: "#38bdf8",
        bg: "rgba(56, 189, 248, 0.14)",
        border: "rgba(56, 189, 248, 0.35)",
        isLive: false,
        detail,
      };
    case "unavailable":
      return {
        badgeText: "✕ UNAVAILABLE",
        fg: "#f87171",
        bg: "rgba(239, 68, 68, 0.15)",
        border: "rgba(239, 68, 68, 0.45)",
        isLive: false,
        detail,
      };
  }
}

/** Normalize a raw `/api/wagers` item into a strict UI `LiveWager` (`autoExecute: false`). */
export function normalizeHydratedWagerRow(
  raw: Record<string, unknown>,
  idx: number,
): LiveWager {
  const riskUsd = Number(raw.riskUsd ?? 0);
  const toWinUsd = Number(raw.toWinUsd ?? 0);
  const clvCents =
    typeof raw.clvCents === "number" && Number.isFinite(raw.clvCents)
      ? raw.clvCents
      : null;
  const maxRecommendedStake = Number(raw.maxRecommendedStake ?? 0);
  const alertTier = normalizeAlertTier(raw.alertTier);
  return {
    ticketId: String(raw.ticketId ?? `W-HYD-${idx}`),
    timestamp: String(raw.timestamp ?? "—"),
    customerId: String(raw.customerId ?? `CUST-${idx}`),
    agentId: String(raw.agentId ?? "AG01"),
    masterAgent: String(raw.masterAgent ?? "MASTER_A"),
    sport: String(raw.sport ?? "OTHER").toUpperCase(),
    betType: String(raw.betType ?? "Straight"),
    event: String(raw.event ?? "Event Matchup"),
    selection: String(raw.selection ?? "Selection"),
    lineDisplay: String(raw.lineDisplay ?? "ML"),
    oddsAmerican: String(raw.oddsAmerican ?? "-110"),
    riskUsd: Number.isFinite(riskUsd) ? riskUsd : 0,
    toWinUsd: Number.isFinite(toWinUsd) ? toWinUsd : 0,
    clvCents,
    alertTier,
    alertBadge: String(raw.alertBadge ?? alertTier),
    operatorDirective: String(
      raw.operatorDirective ?? "Accept Normal (autoExecute: false)",
    ),
    maxRecommendedStake: Number.isFinite(maxRecommendedStake)
      ? maxRecommendedStake
      : 0,
    autoExecute: false,
  };
}

/** Validate and normalize a `GET /api/wagers` JSON payload. */
export function normalizeLiveWagersResponse(
  raw: unknown,
): NormalizedLiveWagersResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (!Array.isArray(rec.wagers)) return null;

  const wagers = rec.wagers
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    )
    .map((item, idx) => normalizeHydratedWagerRow(item, idx));

  const computedRisk = wagers.reduce((sum, w) => sum + w.riskUsd, 0);
  const computedToWin = wagers.reduce((sum, w) => sum + w.toWinUsd, 0);
  const computedCritSteam = wagers.filter(
    (w) => w.alertTier === "CRITICAL" || w.alertTier === "STEAM",
  ).length;

  return {
    wagers,
    totalRiskUsd:
      typeof rec.totalRiskUsd === "number" ? rec.totalRiskUsd : computedRisk,
    totalToWinUsd:
      typeof rec.totalToWinUsd === "number" ? rec.totalToWinUsd : computedToWin,
    criticalSteamCount:
      typeof rec.criticalSteamCount === "number"
        ? rec.criticalSteamCount
        : computedCritSteam,
    provenance: normalizeProvenance(
      rec.provenance,
      "capture",
      "API Wagers Feed",
    ),
    wireContract: normalizeWireContract(rec.wire_contract),
    slabPolicy: normalizeSlabPolicy(rec.slab_policy),
  };
}

/** Structural parse of `slab_policy`; a malformed block is dropped, not guessed. */
function normalizeSlabPolicy(raw: unknown): SlabPolicySummary | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const rec = raw as Record<string, unknown>;
  const sentinels = rec["sentinels"];
  if (typeof rec["schema"] !== "string" || typeof rec["version"] !== "string") {
    return null;
  }
  if (typeof rec["window_bytes"] !== "number" || rec["window_bytes"] <= 0) {
    return null;
  }
  if (typeof rec["unsafe_allowed"] !== "boolean") return null;
  if (typeof sentinels !== "object" || sentinels === null) return null;
  const s = sentinels as Record<string, unknown>;
  for (const key of [
    "null_clv",
    "null_customer_handle32",
    "null_bridge_channel_word32",
  ]) {
    if (typeof s[key] !== "number") return null;
  }
  return {
    schema: rec["schema"],
    version: rec["version"],
    window_bytes: rec["window_bytes"],
    unsafe_allowed: rec["unsafe_allowed"],
    sentinels: {
      null_clv: s["null_clv"] as number,
      null_customer_handle32: s["null_customer_handle32"] as number,
      null_bridge_channel_word32: s["null_bridge_channel_word32"] as number,
    },
  };
}

/** Structural parse of `wire_contract`; a malformed block is dropped, not guessed. */
function normalizeWireContract(raw: unknown): WagersWireContractSummary | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.ok !== "boolean") return null;
  const violations: WagersWireViolation[] = [];
  if (Array.isArray(rec.violations)) {
    for (const entry of rec.violations) {
      if (typeof entry !== "object" || entry === null) continue;
      const v = entry as Record<string, unknown>;
      if (
        typeof v.field !== "string" ||
        (v.kind !== "type" && v.kind !== "nullable") ||
        typeof v.count !== "number"
      ) {
        continue;
      }
      violations.push({
        field: v.field,
        kind: v.kind,
        count: v.count,
        examples: Array.isArray(v.examples)
          ? v.examples.filter((e): e is string => typeof e === "string")
          : [],
      });
    }
  }
  return {
    ok: rec.ok,
    registry: typeof rec.registry === "string" ? rec.registry : "",
    capture: typeof rec.capture === "string" ? rec.capture : "",
    capture_sha256:
      typeof rec.capture_sha256 === "string" ? rec.capture_sha256 : "",
    enum_source:
      typeof rec.enum_source === "string" ? rec.enum_source : "unknown",
    fields_checked: Array.isArray(rec.fields_checked)
      ? rec.fields_checked.filter((f): f is string => typeof f === "string")
      : [],
    rows: typeof rec.rows === "number" ? rec.rows : 0,
    skipped_rows: typeof rec.skipped_rows === "number" ? rec.skipped_rows : 0,
    violations,
    ...(typeof rec.error === "string" ? { error: rec.error } : {}),
  };
}

/** Validate and normalize a `GET /api/customers` JSON payload. */
export function normalizeCustomersCohortResponse(
  raw: unknown,
): CustomersApiResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.cohorts !== "object" || rec.cohorts === null) return null;
  const rawCohorts = rec.cohorts as Record<string, unknown>;

  const numOrZero = (val: unknown): number => {
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  const cohorts: CustomersCohortsSummary = {
    backtestCount: numOrZero(rawCohorts.backtestCount),
    keyNumberSharpsCount: numOrZero(rawCohorts.keyNumberSharpsCount),
    hookSyndicateCount: numOrZero(rawCohorts.hookSyndicateCount),
    fixtureCount: numOrZero(rawCohorts.fixtureCount),
    fullBookSpecCount: numOrZero(rawCohorts.fullBookSpecCount),
    uniqueSurveillanceCount: numOrZero(rawCohorts.uniqueSurveillanceCount),
  };

  return {
    cohorts,
    backtestTop: Array.isArray(rec.backtestTop)
      ? (rec.backtestTop as ReadonlyArray<Record<string, unknown>>)
      : [],
    fixtures: Array.isArray(rec.fixtures)
      ? (rec.fixtures as ReadonlyArray<Record<string, unknown>>)
      : [],
    provenance: normalizeProvenance(
      rec.provenance,
      "fixture",
      "API Customer Cohorts",
    ),
  };
}

interface CustomerCohortKpiSpec {
  readonly id: CustomerCohortKpiId;
  readonly label: string;
  readonly tone: CustomerCohortKpiTone;
  readonly filterTier: "ALL" | "ELITE" | "SYNDICATE" | null;
}

const CUSTOMER_COHORT_KPI_SPECS: readonly CustomerCohortKpiSpec[] = [
  {
    id: "backtest",
    label: "Backtest Cohort",
    tone: "sky",
    filterTier: "ALL",
  },
  {
    id: "key-number-sharps",
    label: "Key Number Sharps",
    tone: "red",
    filterTier: "ELITE",
  },
  {
    id: "hook-syndicates",
    label: "Hook Syndicates",
    tone: "amber",
    filterTier: "SYNDICATE",
  },
  {
    id: "fixtures",
    label: "CI Synthetic Fixtures",
    tone: "slate",
    filterTier: null,
  },
  {
    id: "enriched-book",
    label: "Enriched Book Spec",
    tone: "emerald",
    filterTier: null,
  },
  {
    id: "unique-surveillance",
    label: "Unique Surveillance",
    tone: "violet",
    filterTier: "ALL",
  },
];

function computeSharePct(count: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((count / total) * 1000) / 10;
}

/** Derive the 6 customer cohort KPI cards dynamically (missing is never hardcoded as non-zero or zero). */
export function deriveCustomerCohortKpiCards(options: {
  readonly report: CustomersApiResponse | null;
  readonly status: "pending" | "ready" | "unavailable";
  readonly error?: string | null | undefined;
}): readonly CustomerCohortKpiCard[] {
  if (options.status === "unavailable") {
    const reason =
      options.error && options.error.trim().length > 0
        ? options.error
        : "GET /api/customers unreachable";
    return CUSTOMER_COHORT_KPI_SPECS.map((spec) => ({
      id: spec.id,
      label: spec.label,
      value: "Unavailable",
      sub: reason,
      status: "unavailable",
      tone: spec.tone,
      count: null,
      sharePct: null,
      filterTier: spec.filterTier,
    }));
  }

  if (options.status === "pending" || options.report === null) {
    return CUSTOMER_COHORT_KPI_SPECS.map((spec) => ({
      id: spec.id,
      label: spec.label,
      value: "Pending…",
      sub: "Awaiting GET /api/customers",
      status: "pending",
      tone: spec.tone,
      count: null,
      sharePct: null,
      filterTier: spec.filterTier,
    }));
  }

  const { cohorts, provenance } = options.report;
  const sourceSuffix = provenance.sourcePath
    ? `Source: ${provenance.sourcePath}`
    : provenance.label;
  const totalUnique = cohorts.uniqueSurveillanceCount;

  const readyRows: Record<
    CustomerCohortKpiId,
    { readonly count: number; readonly value: string; readonly sub: string }
  > = {
    backtest: {
      count: cohorts.backtestCount,
      value: `${cohorts.backtestCount.toLocaleString()} Accounts`,
      sub: "4-Wk CFB/NBA Leaderboard (/api/customers)",
    },
    "key-number-sharps": {
      count: cohorts.keyNumberSharpsCount,
      value: `${cohorts.keyNumberSharpsCount.toLocaleString()} Elite Accounts`,
      sub: "Football Key Numbers Watchlist",
    },
    "hook-syndicates": {
      count: cohorts.hookSyndicateCount,
      value: `${cohorts.hookSyndicateCount.toLocaleString()} Downlines`,
      sub: "Half-Point Syndicate Clusters",
    },
    fixtures: {
      count: cohorts.fixtureCount,
      value: `${cohorts.fixtureCount.toLocaleString()} Accounts`,
      sub: "Deterministic Fixture Corpus",
    },
    "enriched-book": {
      count: cohorts.fullBookSpecCount,
      value: `${cohorts.fullBookSpecCount.toLocaleString()} Accounts`,
      sub: sourceSuffix,
    },
    "unique-surveillance": {
      count: totalUnique,
      value: `${totalUnique.toLocaleString()} IDs`,
      sub: `Deduplicated Across Cohorts (${provenance.kind})`,
    },
  };

  return CUSTOMER_COHORT_KPI_SPECS.map((spec) => {
    const row = readyRows[spec.id];
    return {
      id: spec.id,
      label: spec.label,
      value: row.value,
      sub: row.sub,
      status: "ready",
      tone: spec.tone,
      count: row.count,
      sharePct: computeSharePct(row.count, totalUnique),
      filterTier: spec.filterTier,
    };
  });
}

export type HydratedSliceResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string };

export interface DashboardFeedsHydrationBundle {
  readonly wagers: HydratedSliceResult<NormalizedLiveWagersResult>;
  readonly customers: HydratedSliceResult<CustomersApiResponse>;
  readonly tiers: HydratedSliceResult<TierStyleConfig>;
}

async function fetchJsonSlice<T>(
  fetchImpl: (input: string) => Promise<Response>,
  url: string,
  parse: (json: unknown) => T | null,
  expectedShapeName: string,
): Promise<HydratedSliceResult<T>> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      return {
        ok: false,
        error: `GET ${url} returned HTTP ${res.status} (${res.statusText || "error"})`,
      };
    }
    const json: unknown = await res.json();
    const normalized = parse(json);
    if (normalized === null) {
      return {
        ok: false,
        error: `GET ${url} returned unexpected ${expectedShapeName} payload`,
      };
    }
    return { ok: true, data: normalized };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `GET ${url} failed: ${message}`,
    };
  }
}

/** Hydrate `/api/wagers`, `/api/customers`, and `/api/config/tiers` in parallel using any `fetch` implementation. */
export async function hydrateDashboardFeeds(
  fetchImpl: (input: string) => Promise<Response>,
): Promise<DashboardFeedsHydrationBundle> {
  const [wagers, customers, tiers] = await Promise.all([
    fetchJsonSlice(
      fetchImpl,
      "/api/wagers",
      normalizeLiveWagersResponse,
      "LiveWagersApiResponse",
    ),
    fetchJsonSlice(
      fetchImpl,
      "/api/customers",
      normalizeCustomersCohortResponse,
      "CustomersApiResponse",
    ),
    fetchJsonSlice<TierStyleConfig>(
      fetchImpl,
      "/api/config/tiers",
      (raw) => {
        if (typeof raw !== "object" || raw === null) return null;
        const rec = raw as { tiers?: unknown };
        if (typeof rec.tiers !== "object" || rec.tiers === null) return null;
        return rec.tiers as TierStyleConfig;
      },
      "TiersConfig",
    ),
  ]);
  return { wagers, customers, tiers };
}
