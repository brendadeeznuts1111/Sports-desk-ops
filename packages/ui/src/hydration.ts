/**
 * @file packages/ui/src/hydration.ts
 * @description Browser-safe hydration normalizers, dynamic cohort KPI derivation,
 * Signal-Honesty provenance badges, and zero-DOM feed loader for `@sportsdesk-ops/ui`.
 */

import {
  wagerChannelOf,
  type SlabPolicySummary,
  type WagerTier,
  type WagersWireContractSummary,
  type WagersWireViolation,
} from "@sportsdesk-ops/contracts";
import type {
  CustomerRatingApiPayload,
  CustomersApiResponse,
  CustomersCohortsSummary,
  DashboardFeedProvenanceKind,
  DashboardSourceProvenance,
  LiveBetsV2SummarySnapshot,
  LiveWager,
  LiveWagersClvSummary,
  ProxyConduit30d,
  RankedPlayer30d,
  ShowcaseCustomer,
  TierStyleConfig,
} from "./types.ts";

export const PENDING_WAGERS_PROVENANCE: DashboardSourceProvenance = {
  kind: "pending",
  label: "Pending Hydration",
  sourcePath: "/api/wagers",
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
  /** Aggregate ticket & customer-book CLV summary when exposed by backend. */
  readonly clvSummary?: LiveWagersClvSummary | null;
}

export type LegacyCustomerCohortKpiId =
  | "backtest"
  | "key-number-sharps"
  | "hook-syndicates"
  | "fixtures"
  | "enriched-book"
  | "unique-surveillance";

export type FormulaCustomerCohortKpiId =
  | "powered-pos-clv"
  | "profitable-clv"
  | "key-number-buyers"
  | "hook-syndicate-live"
  | "clv-coverage"
  | "billy666-universe";

export type CustomerCohortKpiId =
  LegacyCustomerCohortKpiId | FormulaCustomerCohortKpiId;

export type CustomerCohortKpiTone =
  "sky" | "red" | "amber" | "slate" | "emerald" | "violet";

export type CustomerCohortFilterTier =
  | "ALL"
  | "ELITE"
  | "SYNDICATE"
  | "POSITIVE_CLV"
  | "POWERED_POS_CLV"
  | "PROFITABLE_CLV"
  | "KEY_NUMBER_BUYER"
  | "HOOK_OR_SYNDICATE"
  | null;

export interface CustomerCohortKpiCard {
  readonly id: CustomerCohortKpiId;
  readonly label: string;
  readonly value: string;
  readonly sub: string;
  readonly status: "pending" | "ready" | "unavailable";
  readonly tone: CustomerCohortKpiTone;
  /** Exact raw count when ready; null when pending or unavailable (never faked as 0). */
  readonly count: number | null;
  /** Percentage share of denominator when ready and denominator > 0; null otherwise. */
  readonly sharePct: number | null;
  /** Optional profile tier filter activated when clicking this card in CustomersTabPanel. */
  readonly filterTier: CustomerCohortFilterTier;
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
  const customerClvBps =
    typeof raw.customerClvBps === "number" &&
    Number.isFinite(raw.customerClvBps)
      ? raw.customerClvBps
      : null;
  const customerSharpScore =
    typeof raw.customerSharpScore === "number" &&
    Number.isFinite(raw.customerSharpScore)
      ? raw.customerSharpScore
      : null;
  const maxRecommendedStake = Number(raw.maxRecommendedStake ?? 0);
  const alertTier = normalizeAlertTier(raw.alertTier);
  const ticketWriter =
    typeof raw.ticketWriter === "string" ? raw.ticketWriter.trim() : "";
  const volumeUsd = Number(raw.volumeUsd);
  return {
    ticketId: String(raw.ticketId ?? `W-HYD-${idx}`),
    timestamp: String(raw.timestamp ?? "—"),
    customerId: String(raw.customerId ?? `CUST-${idx}`),
    agentId: String(raw.agentId ?? "AG01"),
    masterAgent: String(raw.masterAgent ?? "MASTER_A"),
    ...(ticketWriter === "" ? {} : { ticketWriter }),
    writer: wagerChannelOf(raw.writer ?? ticketWriter),
    ...(Number.isFinite(volumeUsd) ? { volumeUsd } : {}),
    ...(raw.vip === true ? { vip: true } : {}),
    sport: raw.sport == null ? "" : String(raw.sport).toUpperCase(),
    subSport:
      raw.subSport == null || String(raw.subSport).trim() === ""
        ? null
        : String(raw.subSport).toUpperCase(),
    betType: String(raw.betType ?? "Straight"),
    event: String(raw.event ?? "Event Matchup"),
    selection: String(raw.selection ?? "Selection"),
    lineDisplay: String(raw.lineDisplay ?? "ML"),
    oddsAmerican: String(raw.oddsAmerican ?? "-110"),
    riskUsd: Number.isFinite(riskUsd) ? riskUsd : 0,
    toWinUsd: Number.isFinite(toWinUsd) ? toWinUsd : 0,
    clvCents,
    ...(customerClvBps === null ? {} : { customerClvBps }),
    ...(customerSharpScore === null ? {} : { customerSharpScore }),
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

/** Structural parse of `clvSummary`; drops malformed blocks instead of guessing. */
function normalizeLiveWagersClvSummary(
  raw: unknown,
): LiveWagersClvSummary | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const fin = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const ticketClvCount = fin(rec.ticketClvCount);
  const bookMatchedCount = fin(rec.bookMatchedCount);
  const positiveCustomerClvCount = fin(rec.positiveCustomerClvCount);
  const negativeCustomerClvCount = fin(rec.negativeCustomerClvCount);
  const totalPositiveClvRiskUsd = fin(rec.totalPositiveClvRiskUsd);
  const totalNegativeClvRiskUsd = fin(rec.totalNegativeClvRiskUsd);
  if (
    ticketClvCount === null ||
    bookMatchedCount === null ||
    positiveCustomerClvCount === null ||
    negativeCustomerClvCount === null ||
    totalPositiveClvRiskUsd === null ||
    totalNegativeClvRiskUsd === null
  ) {
    return null;
  }
  return {
    ticketClvCount,
    meanTicketClvCents: fin(rec.meanTicketClvCents),
    bookMatchedCount,
    meanCustomerClvBps: fin(rec.meanCustomerClvBps),
    positiveCustomerClvCount,
    negativeCustomerClvCount,
    totalPositiveClvRiskUsd,
    totalNegativeClvRiskUsd,
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
  const clvSummary = normalizeLiveWagersClvSummary(rec.clvSummary);

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
    ...(clvSummary === null ? {} : { clvSummary }),
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
    backtestAll: Array.isArray(rec.backtestAll)
      ? (rec.backtestAll as ReadonlyArray<Record<string, unknown>>)
      : Array.isArray(rec.backtestTop)
        ? (rec.backtestTop as ReadonlyArray<Record<string, unknown>>)
        : [],
    fixtures: Array.isArray(rec.fixtures)
      ? (rec.fixtures as ReadonlyArray<Record<string, unknown>>)
      : [],
    ...(Array.isArray(rec.book)
      ? { book: rec.book as ReadonlyArray<Record<string, unknown>> }
      : {}),
    provenance: normalizeProvenance(
      rec.provenance,
      "fixture",
      "API Customer Cohorts",
    ),
  };
}

/** Validate and normalize a `GET /api/customer/rating` response envelope or bare payload. */
export function normalizeCustomerRatingResponse(
  raw: unknown,
): CustomerRatingApiPayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const outer = raw as Record<string, unknown>;
  const r =
    typeof outer.rating === "object" && outer.rating !== null
      ? (outer.rating as Record<string, unknown>)
      : outer;
  if (
    typeof r.customerId !== "string" ||
    typeof r.score !== "number" ||
    !Number.isFinite(r.score) ||
    typeof r.tier !== "string" ||
    typeof r.componentScores !== "object" ||
    r.componentScores === null
  ) {
    return null;
  }
  const cs = r.componentScores as Record<string, unknown>;
  const num = (v: unknown, fallback = 0): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const fin = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const rawSig =
    typeof r.clvSignificance === "object" && r.clvSignificance !== null
      ? (r.clvSignificance as Record<string, unknown>)
      : null;
  const rawBayes =
    typeof r.bayesianSkill === "object" && r.bayesianSkill !== null
      ? (r.bayesianSkill as Record<string, unknown>)
      : null;
  const rawKelly =
    typeof r.kellyMetrics === "object" && r.kellyMetrics !== null
      ? (r.kellyMetrics as Record<string, unknown>)
      : null;

  const rawClvSource = r.clvSource;
  const clvSource =
    rawClvSource === "ticket_prices" ||
    rawClvSource === "book_clv_bps" ||
    rawClvSource === "none"
      ? rawClvSource
      : undefined;

  return {
    customerId: r.customerId,
    score: r.score,
    tier: r.tier,
    riskLevel: typeof r.riskLevel === "string" ? r.riskLevel : "STANDARD",
    primaryArchetype:
      typeof r.primaryArchetype === "string"
        ? r.primaryArchetype
        : "recreational",
    componentScores: {
      keyNumberScore: num(cs.keyNumberScore),
      clvEdgeScore: num(cs.clvEdgeScore),
      steamLatencyScore: num(cs.steamLatencyScore),
      timingDisciplineScore: num(cs.timingDisciplineScore),
      derivativeSharpScore: num(cs.derivativeSharpScore),
    },
    confidence: num(r.confidence),
    sampleSize: num(r.sampleSize),
    totalRiskUsd: num(r.totalRiskUsd),
    netUsd: num(r.netUsd),
    recommendedAction:
      typeof r.recommendedAction === "string" ? r.recommendedAction : "ACCEPT",
    autoExecute: false,
    summary: typeof r.summary === "string" ? r.summary : "",
    ...(r.clvBps !== undefined ? { clvBps: fin(r.clvBps) } : {}),
    ...(clvSource !== undefined ? { clvSource } : {}),
    ...(typeof r.activeDays === "number" && Number.isFinite(r.activeDays)
      ? { activeDays: r.activeDays }
      : {}),
    ...(Array.isArray(r.signatures)
      ? {
          signatures: r.signatures.filter(
            (s): s is string => typeof s === "string",
          ),
        }
      : {}),
    ...(rawSig !== null &&
    typeof rawSig.meanClvPercent === "number" &&
    typeof rawSig.sampleCount === "number"
      ? {
          clvSignificance: {
            meanClvPercent: rawSig.meanClvPercent,
            stdDevClvPercent: num(rawSig.stdDevClvPercent),
            sampleCount: rawSig.sampleCount,
            standardError: num(rawSig.standardError),
            tStatistic: num(rawSig.tStatistic),
            pValue: num(rawSig.pValue, 1),
            isSignificant95: rawSig.isSignificant95 === true,
            isSignificant99: rawSig.isSignificant99 === true,
          },
        }
      : {}),
    ...(rawBayes !== null &&
    typeof rawBayes.posteriorMeanWinRate === "number" &&
    Array.isArray(rawBayes.credibleInterval95) &&
    rawBayes.credibleInterval95.length === 2
      ? {
          bayesianSkill: {
            priorAlpha: num(rawBayes.priorAlpha, 10),
            priorBeta: num(rawBayes.priorBeta, 10),
            posteriorAlpha: num(rawBayes.posteriorAlpha, 10),
            posteriorBeta: num(rawBayes.posteriorBeta, 10),
            posteriorMeanWinRate: rawBayes.posteriorMeanWinRate,
            variance: num(rawBayes.variance),
            standardDeviation: num(rawBayes.standardDeviation),
            credibleInterval95: [
              num(rawBayes.credibleInterval95[0]),
              num(rawBayes.credibleInterval95[1]),
            ] as const,
            status:
              rawBayes.status === "CONFIRMED" ||
              rawBayes.status === "CONVERGING"
                ? rawBayes.status
                : "PRELIMINARY",
          },
        }
      : {}),
    ...(rawKelly !== null &&
    typeof rawKelly.halfKellyFraction === "number" &&
    typeof rawKelly.observedUnitFraction === "number"
      ? {
          kellyMetrics: {
            impliedKellyFraction: num(rawKelly.impliedKellyFraction),
            halfKellyFraction: rawKelly.halfKellyFraction,
            quarterKellyFraction: num(rawKelly.quarterKellyFraction),
            observedUnitFraction: rawKelly.observedUnitFraction,
            kellyDivergence: num(rawKelly.kellyDivergence),
            isKellyDisciplined: rawKelly.isKellyDisciplined === true,
            growthRate: num(rawKelly.growthRate),
          },
        }
      : {}),
  };
}

/** Validate and normalize a `GET /api/v2/live-bets` response into a compact summary strip. */
export function normalizeLiveBetsV2Summary(
  raw: unknown,
): LiveBetsV2SummarySnapshot | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const summary =
    typeof rec.summary === "object" && rec.summary !== null
      ? (rec.summary as Record<string, unknown>)
      : null;
  if (summary === null) return null;
  const prov =
    typeof rec.provenance === "object" && rec.provenance !== null
      ? (rec.provenance as Record<string, unknown>)
      : {};
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  return {
    dataSource:
      typeof rec.dataSource === "string"
        ? rec.dataSource
        : typeof summary.dataSource === "string"
          ? summary.dataSource
          : "unknown",
    fallbackUsed: rec.fallbackUsed === true,
    totalGames: num(summary.totalGames),
    totalPending: num(summary.totalPending),
    totalWageredCents: num(summary.totalWagered),
    totalToWinCents: num(summary.totalToWin),
    capturedAt:
      typeof prov.capturedAt === "string"
        ? prov.capturedAt
        : typeof summary.capturedAt === "string"
          ? summary.capturedAt
          : null,
    generatedAt: typeof prov.generatedAt === "string" ? prov.generatedAt : null,
  };
}

interface CustomerCohortKpiSpec {
  readonly id: LegacyCustomerCohortKpiId;
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
    LegacyCustomerCohortKpiId,
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

/**
 * Derive all 6 formula-computed surveillance KPI cards dynamically from live customer records
 * (DOD6 CLV gate, lifetime player net, Football spread key-number buys, ½-pt hook / proxy /
 * multi-seat clusters, and BILLY666 agent-tree distribution — zero hardcoded counts).
 */
export function deriveLiveFormulaCohortKpiCards(
  customers: readonly ShowcaseCustomer[],
): readonly CustomerCohortKpiCard[] {
  const total = customers.length;
  let poweredPosClv = 0;
  let elite100Bps = 0;
  let profitablePosClv = 0;
  let keyNumBuyers = 0;
  let keyNumPosClv = 0;
  let hookOrSyndicate = 0;
  let halfPtHookBuyers = 0;
  let proxyConduits = 0;
  let multiSeat = 0;
  let clvMeasured = 0;
  let clvSum = 0;
  let clvPos = 0;
  let clvNonPos = 0;
  let nolawolf = 0;

  for (const c of customers) {
    const hasClv = typeof c.clvBps === "number" && Number.isFinite(c.clvBps);
    const clv = hasClv ? c.clvBps! : 0;
    const isPowered =
      c.sharpCandidateGatePassed === true || (c.clvLegs ?? 0) >= 5;
    if (hasClv) {
      clvMeasured += 1;
      clvSum += clv;
      if (clv > 0) {
        clvPos += 1;
        if (isPowered) {
          poweredPosClv += 1;
          if (clv >= 100) elite100Bps += 1;
        }
        if (!(c.unknown?.includes("ltv") ?? false) && c.ltvUsd > 0) {
          profitablePosClv += 1;
        }
      } else {
        clvNonPos += 1;
      }
    }
    if (c.isKeyNumberBuyer === true) {
      keyNumBuyers += 1;
      if (hasClv && clv > 0) keyNumPosClv += 1;
    }
    const isHalf = c.isHalfPointHookBuyer === true;
    const isProxy = c.isProxyConduit === true;
    const isMulti = c.isMultiSeatCluster === true;
    if (isHalf) halfPtHookBuyers += 1;
    if (isProxy) proxyConduits += 1;
    if (isMulti) multiSeat += 1;
    if (isHalf || isProxy || isMulti || c.syndicateRisk === "HIGH") {
      hookOrSyndicate += 1;
    }
    const masterUpper = c.masterAgent.trim().toUpperCase();
    const agentUpper = c.agentId.trim().toUpperCase();
    if (masterUpper === "NOLAWOLF" || agentUpper === "NOLAWOLF") {
      nolawolf += 1;
    }
  }

  const meanClv =
    clvMeasured > 0 ? Math.round((clvSum / clvMeasured) * 10) / 10 : null;
  const meanClvLabel =
    meanClv === null
      ? "—"
      : `${meanClv > 0 ? "+" : ""}${meanClv.toFixed(1)} bps`;
  const otherTreeCount = Math.max(0, total - nolawolf);

  return [
    {
      id: "powered-pos-clv",
      label: "Powered +CLV Sharps",
      value: `${poweredPosClv.toLocaleString()} Accounts`,
      sub: `clvLegs ≥ 5 ∧ CLV > 0 · ≥+100 bps: ${elite100Bps.toLocaleString()}`,
      status: "ready",
      tone: "emerald",
      count: poweredPosClv,
      sharePct: computeSharePct(poweredPosClv, total),
      filterTier: "POWERED_POS_CLV",
    },
    {
      id: "profitable-clv",
      label: "Profitable +CLV Winners",
      value: `${profitablePosClv.toLocaleString()} Accounts`,
      sub: "CLV > 0 ∧ Lifetime Player Net > $0",
      status: "ready",
      tone: "red",
      count: profitablePosClv,
      sharePct: computeSharePct(profitablePosClv, total),
      filterTier: "PROFITABLE_CLV",
    },
    {
      id: "key-number-buyers",
      label: "Key-Number Point Buyers",
      value: `${keyNumBuyers.toLocaleString()} Accounts`,
      sub: `Football buys on 3/7/10/14/21 ≥ 3 · +CLV: ${keyNumPosClv.toLocaleString()}`,
      status: "ready",
      tone: "amber",
      count: keyNumBuyers,
      sharePct: computeSharePct(keyNumBuyers, total),
      filterTier: "KEY_NUMBER_BUYER",
    },
    {
      id: "hook-syndicate-live",
      label: "Hook & Syndicate Clusters",
      value: `${hookOrSyndicate.toLocaleString()} Accounts`,
      sub: `½-pt hook: ${halfPtHookBuyers.toLocaleString()} · Conduits: ${proxyConduits.toLocaleString()} · Multi-seat: ${multiSeat.toLocaleString()}`,
      status: "ready",
      tone: "violet",
      count: hookOrSyndicate,
      sharePct: computeSharePct(hookOrSyndicate, total),
      filterTier: "HOOK_OR_SYNDICATE",
    },
    {
      id: "clv-coverage",
      label: "CLV Coverage (DOD6 + Book)",
      value: `${clvMeasured.toLocaleString()} Accounts`,
      sub: `Mean ${meanClvLabel} · +CLV: ${clvPos.toLocaleString()} / ≤0: ${clvNonPos.toLocaleString()}`,
      status: "ready",
      tone: "sky",
      count: clvMeasured,
      sharePct: computeSharePct(clvMeasured, total),
      filterTier: "POSITIVE_CLV",
    },
    {
      id: "billy666-universe",
      label: "Active Universe (BILLY666 Tree)",
      value: `${total.toLocaleString()} Accounts`,
      sub: `NOLAWOLF: ${nolawolf.toLocaleString()} · BILLY667/RTEST5/SAINTS2009 & other: ${otherTreeCount.toLocaleString()}`,
      status: "ready",
      tone: "slate",
      count: total,
      sharePct: computeSharePct(total, total),
      filterTier: "ALL",
    },
  ];
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

/** Provenance for a feed that failed: names the endpoint and the error, never a substitute dataset. */
export function unavailableProvenance(
  endpoint: string,
  error: string,
  observedAt: string = new Date().toISOString(),
): DashboardSourceProvenance {
  return {
    kind: "unavailable",
    label: error,
    sourcePath: endpoint,
    observedAt,
  };
}

/** Endpoint the Downlines tab reads: `runBatchedRanking` over the F402 bets corpus. */
export const RANKINGS_ENDPOINT = "/api/rankings/all";

export interface RankingsSummary {
  readonly generatedAtIso: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly inWindowWagers: number;
  readonly totalHandleUsd: number;
  readonly totalToWinUsd: number;
  readonly activeCustomerCount: number;
  readonly activeSubAgentCount: number;
  readonly activeMasterAgentCount: number;
  readonly conduitSubAgentCount: number;
}

export interface NormalizedRankingsResult {
  readonly summary: RankingsSummary;
  readonly players: readonly RankedPlayer30d[];
  readonly conduits: readonly ProxyConduit30d[];
  /** Rows dropped because a required field was missing or non-numeric. */
  readonly rejectedRows: number;
}

function finiteOrNull(val: unknown): number | null {
  if (typeof val !== "number" || !Number.isFinite(val)) return null;
  return val;
}

function nonEmptyString(val: unknown): string | null {
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : null;
}

/**
 * Normalize a `GET /api/rankings/all` (`BatchedRankingResult`) payload. Returns null when the
 * envelope is not that shape; rows missing a required field are counted in `rejectedRows`
 * instead of being coerced.
 */
export function normalizeRankingsResponse(
  raw: unknown,
): NormalizedRankingsResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (
    !Array.isArray(rec.topRankedPlayers) ||
    !Array.isArray(rec.topSubAgents)
  ) {
    return null;
  }
  const summaryNumbers = {
    inWindowWagers: finiteOrNull(rec.inWindowWagers),
    totalHandleUsd: finiteOrNull(rec.totalHandleUsd),
    totalToWinUsd: finiteOrNull(rec.totalToWinUsd),
    activeCustomerCount: finiteOrNull(rec.activeCustomerCount),
    activeSubAgentCount: finiteOrNull(rec.activeSubAgentCount),
    activeMasterAgentCount: finiteOrNull(rec.activeMasterAgentCount),
    conduitSubAgentCount: finiteOrNull(rec.conduitSubAgentCount),
  };
  if (Object.values(summaryNumbers).some((v) => v === null)) return null;

  let rejectedRows = 0;
  const players: RankedPlayer30d[] = [];
  for (const entry of rec.topRankedPlayers as unknown[]) {
    const row = (
      typeof entry === "object" && entry !== null ? entry : {}
    ) as Record<string, unknown>;
    const id = nonEmptyString(row.customerId);
    const rank = finiteOrNull(row.rank);
    const handleUsd = finiteOrNull(row.handleUsd);
    const wagers = finiteOrNull(row.totalWagers);
    const gini = finiteOrNull(row.stakeGini);
    const alertRate = finiteOrNull(row.alertRatePct);
    const score = finiteOrNull(row.compositeScore);
    const limitUsd = finiteOrNull(row.recommendedLimitUsd);
    const tier = nonEmptyString(row.tier);
    if (
      id === null ||
      rank === null ||
      handleUsd === null ||
      wagers === null ||
      gini === null ||
      alertRate === null ||
      score === null ||
      limitUsd === null ||
      tier === null
    ) {
      rejectedRows++;
      continue;
    }
    const rawSc =
      typeof row.scoreComponents === "object" && row.scoreComponents !== null
        ? (row.scoreComponents as Record<string, unknown>)
        : null;
    const scClv = rawSc ? finiteOrNull(rawSc.clv) : null;
    const scVolume = rawSc ? finiteOrNull(rawSc.volume) : null;
    const scSizing = rawSc ? finiteOrNull(rawSc.sizing) : null;
    const scTiming = rawSc ? finiteOrNull(rawSc.timing) : null;
    const scCombo = rawSc ? finiteOrNull(rawSc.combo) : null;
    const lastWagerAt = nonEmptyString(row.lastWagerAt);
    const clvLegs = finiteOrNull(row.clvLegs);
    const clvBps = row.clvBps === null ? null : finiteOrNull(row.clvBps);
    const dodSharpScore =
      row.dodSharpScore === null ? null : finiteOrNull(row.dodSharpScore);
    const lifetimeNetUsd =
      row.lifetimeNetUsd === null ? null : finiteOrNull(row.lifetimeNetUsd);
    const keyNumberBuys30d = finiteOrNull(row.keyNumberBuys30d);
    const halfPointBuys30d = finiteOrNull(row.halfPointBuys30d);
    const halfPointBuyRatePct = finiteOrNull(row.halfPointBuyRatePct);
    const seatCount = finiteOrNull(row.seatCount);

    players.push({
      rank,
      id,
      agentId: nonEmptyString(row.agentId) ?? "",
      masterAgent: nonEmptyString(row.masterAgent) ?? "",
      handleUsd,
      wagers,
      gini,
      alertRate,
      score,
      tier,
      tierLabel: nonEmptyString(row.tierLabel) ?? tier,
      dominantSport: nonEmptyString(row.dominantSport) ?? "",
      isProxy: row.isProxyConduit === true,
      limitUsd,
      ...(lastWagerAt !== null ? { lastWagerAt } : {}),
      ...(row.clvBps !== undefined ? { clvBps } : {}),
      ...(clvLegs !== null && clvLegs >= 0 ? { clvLegs } : {}),
      ...(row.dodSharpScore !== undefined ? { dodSharpScore } : {}),
      ...(row.lifetimeNetUsd !== undefined ? { lifetimeNetUsd } : {}),
      ...(typeof row.sharpCandidateGatePassed === "boolean"
        ? { sharpCandidateGatePassed: row.sharpCandidateGatePassed }
        : {}),
      ...(keyNumberBuys30d !== null && keyNumberBuys30d > 0
        ? { keyNumberBuys30d }
        : {}),
      ...(halfPointBuys30d !== null && halfPointBuys30d > 0
        ? { halfPointBuys30d }
        : {}),
      ...(halfPointBuyRatePct !== null && halfPointBuyRatePct > 0
        ? { halfPointBuyRatePct }
        : {}),
      ...(seatCount !== null && seatCount > 1 ? { seatCount } : {}),
      ...(row.isKeyNumberBuyer === true ? { isKeyNumberBuyer: true } : {}),
      ...(row.isHalfPointHookBuyer === true
        ? { isHalfPointHookBuyer: true }
        : {}),
      ...(row.isMultiSeatCluster === true ? { isMultiSeatCluster: true } : {}),
      ...(scClv !== null &&
      scVolume !== null &&
      scSizing !== null &&
      scTiming !== null &&
      scCombo !== null
        ? {
            scoreComponents: {
              clv: scClv,
              volume: scVolume,
              sizing: scSizing,
              timing: scTiming,
              combo: scCombo,
            },
          }
        : {}),
    });
  }

  const conduits: ProxyConduit30d[] = [];
  for (const entry of rec.topSubAgents as unknown[]) {
    const row = (
      typeof entry === "object" && entry !== null ? entry : {}
    ) as Record<string, unknown>;
    if (row.isProxyConduit !== true) continue;
    const agentId = nonEmptyString(row.agentId);
    const handleUsd = finiteOrNull(row.totalHandleUsd);
    const wagers = finiteOrNull(row.totalWagers);
    const concPct = finiteOrNull(row.topCustomerConcentrationPct);
    if (
      agentId === null ||
      handleUsd === null ||
      wagers === null ||
      concPct === null
    ) {
      rejectedRows++;
      continue;
    }
    conduits.push({
      agentId,
      masterAgent: nonEmptyString(row.masterAgent) ?? "",
      handleUsd,
      wagers,
      topCust: nonEmptyString(row.topCustomer) ?? "",
      concPct,
    });
  }

  return {
    summary: {
      generatedAtIso: nonEmptyString(rec.generatedAtIso) ?? "",
      windowStart: nonEmptyString(rec.windowStart) ?? "",
      windowEnd: nonEmptyString(rec.windowEnd) ?? "",
      inWindowWagers: summaryNumbers.inWindowWagers as number,
      totalHandleUsd: summaryNumbers.totalHandleUsd as number,
      totalToWinUsd: summaryNumbers.totalToWinUsd as number,
      activeCustomerCount: summaryNumbers.activeCustomerCount as number,
      activeSubAgentCount: summaryNumbers.activeSubAgentCount as number,
      activeMasterAgentCount: summaryNumbers.activeMasterAgentCount as number,
      conduitSubAgentCount: summaryNumbers.conduitSubAgentCount as number,
    },
    players,
    conduits,
    rejectedRows,
  };
}

/**
 * Fetch and normalize `GET /api/rankings/all`. A non-2xx reply carries the server's
 * `{ error }` text (for example a missing bets corpus) into the failure message.
 */
export async function fetchRankingsSlice(
  fetchImpl: (input: string) => Promise<Response>,
  limit = 100,
): Promise<HydratedSliceResult<NormalizedRankingsResult>> {
  const url = `${RANKINGS_ENDPOINT}?limit=${limit}`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
      return {
        ok: false,
        error: `GET ${RANKINGS_ENDPOINT} returned HTTP ${res.status} (${res.statusText || "error"})${detail}`,
      };
    }
    const normalized = normalizeRankingsResponse(await res.json());
    if (normalized === null) {
      return {
        ok: false,
        error: `GET ${RANKINGS_ENDPOINT} returned an unexpected BatchedRankingResult payload`,
      };
    }
    return { ok: true, data: normalized };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `GET ${RANKINGS_ENDPOINT} failed: ${message}` };
  }
}
