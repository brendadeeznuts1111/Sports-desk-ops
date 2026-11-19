import type React from "react";
import { DASHBOARD_FRESHNESS } from "../config/dashboard.ts";
import { styles } from "../dashboard_styles.ts";
import {
  type CustomerCohortKpiTone,
  deriveCustomerCohortKpiCards,
  formatProvenanceBadge,
  PENDING_COHORTS_PROVENANCE,
} from "../hydration.ts";
import { getLocalAgentHref } from "../links.ts";
import type { ReverseDnsForensicsView } from "../../../../lib/reverse_dns_forensics.ts";
import { ReverseDnsForensicsCard } from "./ReverseDnsForensicsCard.tsx";
import { SharpnessDecomposition } from "../viz/SharpnessDecomposition.tsx";
import type {
  CustomerRatingApiPayload,
  CustomersApiResponse,
  CustomerSortKey,
  ShowcaseCustomer,
} from "../types.ts";

export interface CustomersTabPanelProps {
  readonly bannerDismissed: boolean;
  readonly onDismissBanner: () => void;
  readonly kpisCollapsed: boolean;
  readonly onToggleKpis: () => void;
  readonly cohortsReport?: CustomersApiResponse | null | undefined;
  readonly cohortsStatus?: "pending" | "ready" | "unavailable" | undefined;
  readonly cohortsError?: string | null | undefined;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (value: string) => void;
  readonly filterTier: string;
  readonly onFilterTierChange: (tier: string) => void;
  readonly sortedCustomers: readonly ShowcaseCustomer[];
  readonly customerSort: {
    readonly key: CustomerSortKey;
    readonly dir: 1 | -1;
  };
  readonly onCustomerSort: (key: CustomerSortKey) => void;
  readonly selectedCustomer: ShowcaseCustomer | null;
  readonly onSelectCustomer: (cust: ShowcaseCustomer) => void;
  readonly selectedCustomerRating?: CustomerRatingApiPayload | null | undefined;
  readonly selectedCustomerRatingLoading?: boolean | undefined;
  /** Account id the operator tried to inspect but the curated cohort lacks. */
  readonly customerLookupNotice?: string | null | undefined;
  readonly onClearCustomerLookupNotice?: (() => void) | undefined;
  readonly copiedCliId: string | null;
  readonly onCopyCli: (customerId: string) => void;
  readonly customerReverseForensics?:
    ReverseDnsForensicsView | null | undefined;
  readonly onClearForensicResult: () => void;
  readonly onRunReverseLookup: (ipAddress: string) => void;
  readonly onOpenTerminalProfile: (customerId: string) => void;
  readonly onSelectAgent?: ((agentId: string) => void) | undefined;
  readonly onViewCustomerWagers?: ((customerId: string) => void) | undefined;
  /** Set when no live per-customer profile source exists; replaces the table and inspector. */
  readonly profilesUnavailableReason?: string | null | undefined;
  /** One-line provenance for the rows on screen (counts + source endpoint). */
  readonly profilesProvenance?: string | null | undefined;
  readonly matrixMode?: boolean | undefined;
  readonly matrixProfileOverlay?:
    | {
        readonly total: number;
        readonly liveOpen: number;
        readonly ranked: number;
        readonly cohort: number;
        readonly liveWagersDistinct: number;
      }
    | null
    | undefined;
  readonly onOpenTerminalRadar?: ((customerId: string) => void) | undefined;
}

interface CustomerCohortSummary {
  readonly totalVarUsd: number;
  readonly totalCapUsd: number;
  /** Rows that actually carry a measured VaR / cap; the rest list them in `unknown`. */
  readonly varRows: number;
  readonly capRows: number;
  readonly alertCount: number;
  readonly avgSharpness: string;
}

function summarizeDisplayedCustomers(
  rows: readonly ShowcaseCustomer[],
): CustomerCohortSummary {
  let totalVarUsd = 0;
  let totalCapUsd = 0;
  let varRows = 0;
  let capRows = 0;
  let alertCount = 0;
  let sharpSum = 0;
  for (const row of rows) {
    const unknown = row.unknown ?? [];
    // A row that never measured VaR or a limit is not a zero-dollar contribution.
    if (!unknown.includes("var95")) {
      totalVarUsd += row.var95Usd;
      varRows += 1;
    }
    if (!unknown.includes("limit")) {
      totalCapUsd += row.recommendedLimitUsd;
      capRows += 1;
    }
    if (row.action.includes("ALERT")) alertCount++;
    sharpSum += row.score;
  }
  return {
    totalVarUsd,
    totalCapUsd,
    varRows,
    capRows,
    alertCount,
    avgSharpness: rows.length > 0 ? (sharpSum / rows.length).toFixed(1) : "n/a",
  };
}

interface RadarAxisSpec {
  readonly label: string;
  readonly valueKey:
    "clvScore" | "skillScore" | "sizingScore" | "sigScore" | "timingScore";
  readonly max: number;
}

const RADAR_AXES: readonly RadarAxisSpec[] = [
  {
    label: "CLV Beat Margin",
    valueKey: "clvScore",
    max: 3.0,
  },
  {
    label: "Bayesian Skill",
    valueKey: "skillScore",
    max: 2.5,
  },
  {
    label: "Sizing Discipline",
    valueKey: "sizingScore",
    max: 1.5,
  },
  {
    label: "Signature Specialization",
    valueKey: "sigScore",
    max: 2.0,
  },
  {
    label: "Timing / Parlay Exploitation",
    valueKey: "timingScore",
    max: 1.0,
  },
];

const KPI_TONE_ACCENT: Record<CustomerCohortKpiTone, string> = {
  sky: "#38bdf8",
  red: "#f87171",
  amber: "#fbbf24",
  slate: "#94a3b8",
  emerald: "#34d399",
  violet: "#a78bfa",
};

export function CustomersTabPanel({
  bannerDismissed,
  onDismissBanner,
  kpisCollapsed,
  onToggleKpis,
  cohortsReport = null,
  cohortsStatus,
  cohortsError = null,
  searchQuery,
  onSearchQueryChange,
  filterTier,
  onFilterTierChange,
  sortedCustomers,
  customerSort,
  onCustomerSort,
  selectedCustomer,
  onSelectCustomer,
  selectedCustomerRating = null,
  selectedCustomerRatingLoading = false,
  customerLookupNotice = null,
  onClearCustomerLookupNotice,
  copiedCliId,
  onCopyCli,
  customerReverseForensics = null,
  onClearForensicResult,
  onRunReverseLookup,
  onOpenTerminalProfile,
  onSelectAgent,
  onViewCustomerWagers,
  profilesUnavailableReason = null,
  profilesProvenance = null,
  matrixMode = false,
  matrixProfileOverlay = null,
  onOpenTerminalRadar,
}: CustomersTabPanelProps): React.ReactElement {
  const showOpenRisk =
    matrixMode && sortedCustomers.some((c) => (c.openRiskUsd ?? 0) > 0);
  const effectiveStatus: "pending" | "ready" | "unavailable" =
    cohortsStatus ?? (cohortsReport !== null ? "ready" : "pending");
  const kpiCards = deriveCustomerCohortKpiCards({
    report: cohortsReport,
    status: effectiveStatus,
    error: cohortsError,
  });
  const isUnknown = (cust: ShowcaseCustomer, field: string): boolean =>
    cust.unknown?.includes(field) ?? false;
  const provenanceBadge = formatProvenanceBadge(
    effectiveStatus === "unavailable"
      ? {
          kind: "unavailable",
          label: cohortsError || "GET /api/customers failed",
          sourcePath: "/api/customers",
          observedAt: "",
        }
      : (cohortsReport?.provenance ?? PENDING_COHORTS_PROVENANCE),
    { staleAfterMinutes: DASHBOARD_FRESHNESS.stale_after_minutes },
  );

  return (
    <div>
      {/* Session Notice Banner (Dismissible) */}
      {!bannerDismissed && (
        <div
          style={{
            marginBottom: "16px",
            padding: "10px 14px",
            borderRadius: "8px",
            background: "rgba(245, 158, 11, 0.1)",
            border: "1px solid rgba(245, 158, 11, 0.2)",
            fontSize: "12px",
            color: "#fbbf24",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "10px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "10px",
            }}
          >
            <span style={{ fontSize: "16px", lineHeight: "1" }}>⚠️</span>
            <div>
              <b>Fantasy402 Portal Session Notice:</b> Direct portal links
              require an active, authenticated manager session in your browser.
              If you encounter <i>"Your session has expired"</i>, log into
              fantasy402.com first. For instant local telemetry, all accounts
              are profiled below; click any row/ID to inspect or use{" "}
              <b>📋 Copy CLI</b>.
            </div>
          </div>
          <button
            type="button"
            style={{
              background: "none",
              border: "none",
              color: "#fbbf24",
              fontSize: "16px",
              cursor: "pointer",
              padding: "0 4px",
              lineHeight: "1",
            }}
            onClick={onDismissBanner}
            title="Dismiss notice"
          >
            ✕
          </button>
        </div>
      )}

      {/* Collapsible KPI Strip Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "8px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              fontSize: "11px",
              color: "#64748b",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              fontWeight: 600,
            }}
          >
            Corpora & Surveillance Cohorts
          </span>
          <span
            title={provenanceBadge.detail}
            style={{
              fontSize: "10px",
              fontWeight: 700,
              padding: "2px 7px",
              borderRadius: "999px",
              color: provenanceBadge.fg,
              backgroundColor: provenanceBadge.bg,
              border: `1px solid ${provenanceBadge.border}`,
            }}
          >
            {provenanceBadge.badgeText}
          </span>
          {cohortsReport?.provenance.sourcePath ? (
            <span style={{ fontSize: "10px", color: "#64748b" }}>
              {cohortsReport.provenance.sourcePath}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          style={{
            background: "none",
            border: "none",
            color: "#38bdf8",
            fontSize: "11px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "4px",
            padding: "2px 6px",
          }}
          onClick={onToggleKpis}
        >
          {kpisCollapsed ? "Show Corpora ▼" : "Hide Corpora ▲"}
        </button>
      </div>

      {/* KPI Summary Cards (Collapsible, hydrated dynamically from /api/customers) */}
      {!kpisCollapsed && (
        <div className="kpi-strip" style={styles.kpiGrid}>
          {kpiCards.map((card) => {
            const accent =
              card.status === "unavailable"
                ? "#f87171"
                : card.status === "pending"
                  ? "#64748b"
                  : KPI_TONE_ACCENT[card.tone];
            const isInteractive =
              card.status === "ready" && card.filterTier !== null;
            const isActiveFilter =
              isInteractive &&
              card.filterTier !== "ALL" &&
              filterTier === card.filterTier;
            const { border: _ignoredBorder, ...kpiCardBase } = styles.kpiCard;
            const sideBorder = `1px solid ${isActiveFilter ? accent : "#1e293b"}`;
            const cardStyle: React.CSSProperties = {
              ...kpiCardBase,
              borderTop: sideBorder,
              borderRight: sideBorder,
              borderBottom: sideBorder,
              borderLeft: `3px solid ${accent}`,
              textAlign: "left",
              width: "100%",
              cursor: isInteractive ? "pointer" : "default",
            };
            const content = (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                  }}
                >
                  <span style={styles.kpiLabel}>{card.label}</span>
                  {card.sharePct !== null &&
                    card.id !== "unique-surveillance" && (
                      <span
                        style={{
                          fontSize: "10px",
                          fontWeight: 700,
                          color: accent,
                          backgroundColor: "rgba(15, 23, 42, 0.85)",
                          border: "1px solid #1e293b",
                          borderRadius: "999px",
                          padding: "1px 6px",
                          whiteSpace: "nowrap",
                        }}
                        title={`${card.sharePct}% of Unique Surveillance (${card.count?.toLocaleString() ?? "?"})`}
                      >
                        {card.sharePct}%
                      </span>
                    )}
                </div>
                <div
                  style={{
                    ...styles.kpiVal,
                    color:
                      card.status === "ready"
                        ? "#f1f5f9"
                        : card.status === "unavailable"
                          ? "#fca5a5"
                          : "#94a3b8",
                  }}
                >
                  {card.value}
                </div>
                <div style={styles.kpiSub}>{card.sub}</div>
              </>
            );
            return isInteractive ? (
              <button
                key={card.id}
                type="button"
                style={cardStyle}
                onClick={() => {
                  if (card.filterTier) {
                    onFilterTierChange(card.filterTier);
                  }
                }}
                title={
                  card.filterTier === "ALL"
                    ? "Show all customer profiles"
                    : `Filter profiles to ${card.filterTier}`
                }
              >
                {content}
              </button>
            ) : (
              <div key={card.id} style={cardStyle}>
                {content}
              </div>
            );
          })}
        </div>
      )}

      {/* Filter and Search Bar */}
      <div style={styles.filterBar}>
        <input
          style={styles.searchInput}
          placeholder="🔍 Search by Customer ID, Name, Agent or Sport..."
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
        />
        <div style={styles.filterPills}>
          <button
            type="button"
            style={styles.pill(filterTier === "ALL")}
            onClick={() => onFilterTierChange("ALL")}
          >
            All Profiles
          </button>
          <button
            type="button"
            style={styles.pill(filterTier === "ELITE")}
            onClick={() => onFilterTierChange("ELITE")}
          >
            🚨 Elite Sharps
          </button>
          <button
            type="button"
            style={styles.pill(filterTier === "POSITIVE_CLV")}
            onClick={() => onFilterTierChange("POSITIVE_CLV")}
          >
            📈 +CLV Sharps
          </button>
          <button
            type="button"
            style={styles.pill(filterTier === "SYNDICATE")}
            onClick={() => onFilterTierChange("SYNDICATE")}
          >
            🔗 Syndicates
          </button>
          <button
            type="button"
            style={styles.pill(filterTier === "STEAM")}
            onClick={() => onFilterTierChange("STEAM")}
          >
            ⚡ Steam Chasers
          </button>
          <button
            type="button"
            style={styles.pill(filterTier === "RECREATIONAL")}
            onClick={() => onFilterTierChange("RECREATIONAL")}
          >
            ✅ High-Hold Whales
          </button>
          {(() => {
            const clvValues = sortedCustomers
              .map((c) => c.clvBps)
              .filter(
                (v): v is number => typeof v === "number" && Number.isFinite(v),
              );
            const avgClv =
              clvValues.length > 0
                ? Math.round(
                    (clvValues.reduce((a, b) => a + b, 0) / clvValues.length) *
                      10,
                  ) / 10
                : null;
            return (
              <span
                data-customers-avg-clv="true"
                style={{
                  ...styles.pill(false),
                  cursor: "default",
                  color:
                    avgClv === null
                      ? "#94a3b8"
                      : avgClv > 0
                        ? "#4ade80"
                        : avgClv < 0
                          ? "#f87171"
                          : "#e2e8f0",
                  border: "1px solid rgba(56, 189, 248, 0.25)",
                }}
                title="Mean measured book/backtest CLV (bps) across visible cohort rows"
              >
                Avg CLV:{" "}
                {avgClv === null
                  ? "—"
                  : `${avgClv > 0 ? "+" : ""}${avgClv.toFixed(1)} bps (n=${clvValues.length})`}
              </span>
            );
          })()}
          {matrixMode ? (
            <>
              {(
                ["TIER_1", "TIER_2", "TIER_3", "TIER_4", "TIER_5"] as const
              ).map((tier) => (
                <button
                  key={tier}
                  type="button"
                  style={styles.pill(filterTier === tier)}
                  onClick={() => onFilterTierChange(tier)}
                  title={`Filter by data tier ${tier} (30d rankings)`}
                >
                  {tier.replace("TIER_", "T")}
                </button>
              ))}
            </>
          ) : null}
        </div>
      </div>

      {matrixMode && matrixProfileOverlay ? (
        <div
          data-customers-matrix="overlay"
          style={{
            margin: "0 12px 10px",
            padding: "10px 12px",
            borderRadius: "8px",
            border: "1px solid rgba(56, 189, 248, 0.35)",
            background:
              "linear-gradient(90deg, rgba(56, 189, 248, 0.1), rgba(168, 85, 247, 0.08))",
            fontSize: "12px",
            color: "#cbd5e1",
          }}
        >
          <strong style={{ color: "#7dd3fc" }}>Matrix overlay</strong> merges{" "}
          <b>{matrixProfileOverlay.cohort}</b> cohort rows,{" "}
          <b>{matrixProfileOverlay.ranked}</b> ranked players, and{" "}
          <b>{matrixProfileOverlay.liveOpen}</b> live-open customers (
          {matrixProfileOverlay.liveWagersDistinct} on the wager tape). Tiers
          and scores follow API payloads — not hardcoded cutoffs.
        </div>
      ) : null}

      {profilesProvenance !== null && (
        <div
          role="status"
          data-profiles-source="cohort"
          style={{
            margin: "0 12px 8px",
            fontSize: "11px",
            color: "#94a3b8",
          }}
        >
          {profilesProvenance}
        </div>
      )}

      {customerLookupNotice !== null ? (
        <div
          role="status"
          data-customer-lookup-notice={customerLookupNotice}
          className="sd-card"
          style={{
            margin: "0 12px 10px",
            padding: "10px 14px",
            border: "1px solid rgba(245, 158, 11, 0.45)",
            backgroundColor: "rgba(245, 158, 11, 0.10)",
            color: "#fcd34d",
            fontSize: "12px",
          }}
        >
          <strong>
            No curated cohort profile for <code>{customerLookupNotice}</code>.
          </strong>{" "}
          The shadow buyer table contains accounts outside the profile cohort;
          the search is set to this id so a partial match is still visible.
          <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
            <button
              type="button"
              className="sd-preset-btn"
              onClick={() => onOpenTerminalProfile(customerLookupNotice)}
            >
              💻 Open terminal profile
            </button>
            {onClearCustomerLookupNotice ? (
              <button
                type="button"
                className="sd-preset-btn"
                onClick={onClearCustomerLookupNotice}
              >
                Dismiss
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Two-Column Grid: Customer Table & Deep Inspector */}
      {(() => {
        if (
          profilesUnavailableReason !== null &&
          !(matrixMode && sortedCustomers.length > 0)
        ) {
          return (
            <div
              role="status"
              data-profiles-source="unavailable"
              style={{
                ...styles.tablePanel,
                textAlign: "center",
                color: "#94a3b8",
                fontSize: "13px",
              }}
            >
              <h3
                style={{
                  margin: "0 0 8px",
                  fontSize: "16px",
                  color: "#f8fafc",
                }}
              >
                No live profile source yet
              </h3>
              <div>{profilesUnavailableReason}</div>
            </div>
          );
        }
        const cohortSummary = summarizeDisplayedCustomers(sortedCustomers);
        const hasActiveFilter =
          searchQuery.trim() !== "" || filterTier !== "ALL";
        const selectedIndex = selectedCustomer
          ? sortedCustomers.findIndex((c) => c.id === selectedCustomer.id)
          : -1;
        const canStepPrev = selectedIndex > 0;
        const canStepNext =
          selectedIndex >= 0 && selectedIndex < sortedCustomers.length - 1;
        const resetFilters = () => {
          onSearchQueryChange("");
          onFilterTierChange("ALL");
        };
        const stepCustomer = (delta: -1 | 1) => {
          if (sortedCustomers.length === 0) return;
          const nextIdx =
            selectedIndex < 0
              ? 0
              : Math.min(
                  sortedCustomers.length - 1,
                  Math.max(0, selectedIndex + delta),
                );
          const next = sortedCustomers[nextIdx];
          if (next) {
            onSelectCustomer(next);
            onClearForensicResult();
          }
        };

        return (
          <div style={styles.showcaseGrid}>
            {/* Left Column: Customers Table */}
            <div style={styles.tablePanel}>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "8px 12px",
                  marginBottom: "10px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    flexWrap: "wrap",
                  }}
                >
                  <h3 style={{ margin: 0, fontSize: "16px", color: "#f8fafc" }}>
                    Profiled Bettors ({sortedCustomers.length})
                  </h3>
                  <span
                    style={{
                      padding: "2px 7px",
                      borderRadius: "4px",
                      backgroundColor: "rgba(56, 189, 248, 0.12)",
                      color: "#7dd3fc",
                      fontSize: "11px",
                      fontWeight: 600,
                    }}
                  >
                    Avg Sharp: {cohortSummary.avgSharpness}
                  </span>
                  <span
                    style={{
                      padding: "2px 7px",
                      borderRadius: "4px",
                      backgroundColor: "rgba(239, 68, 68, 0.14)",
                      color: "#fca5a5",
                      fontSize: "11px",
                      fontWeight: 600,
                    }}
                  >
                    {cohortSummary.alertCount} Alerts
                  </span>
                  <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                    Σ VaR ({cohortSummary.varRows}/{sortedCustomers.length}
                    ): <b>${cohortSummary.totalVarUsd.toLocaleString()}</b> · Σ
                    Caps ({cohortSummary.capRows}/{sortedCustomers.length}
                    ): <b>${cohortSummary.totalCapUsd.toLocaleString()}</b>
                  </span>
                </div>
                <div
                  style={{ display: "flex", alignItems: "center", gap: "8px" }}
                >
                  {hasActiveFilter && (
                    <button
                      type="button"
                      onClick={resetFilters}
                      style={{
                        padding: "2px 8px",
                        borderRadius: "4px",
                        backgroundColor: "rgba(245, 158, 11, 0.14)",
                        border: "1px solid rgba(251, 191, 36, 0.35)",
                        color: "#fbbf24",
                        fontSize: "11px",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      ✕ Reset filters
                    </button>
                  )}
                  <span style={{ fontSize: "11px", color: "#64748b" }}>
                    Click header to sort · Pinned Directive
                  </span>
                </div>
              </div>
              <div className="profiles-wrap">
                <table style={styles.table}>
                  <thead>
                    <tr style={styles.thRow}>
                      <th
                        className="sortable"
                        style={styles.th}
                        onClick={() => onCustomerSort("id")}
                      >
                        Customer
                        <span className="sort-arrow">
                          {customerSort.key === "id"
                            ? customerSort.dir === 1
                              ? "▲"
                              : "▼"
                            : ""}
                        </span>
                      </th>
                      <th
                        className="sortable"
                        style={styles.th}
                        onClick={() => onCustomerSort("score")}
                      >
                        Unified Sharpness
                        <span className="sort-arrow">
                          {customerSort.key === "score"
                            ? customerSort.dir === 1
                              ? "▲"
                              : "▼"
                            : ""}
                        </span>
                      </th>
                      <th
                        className="sortable"
                        style={styles.th}
                        onClick={() => onCustomerSort("clvBps")}
                        title="Sort by measured CLV in basis points"
                      >
                        CLV (bps)
                        <span className="sort-arrow">
                          {customerSort.key === "clvBps"
                            ? customerSort.dir === 1
                              ? "▲"
                              : "▼"
                            : ""}
                        </span>
                      </th>
                      <th
                        className="sortable"
                        style={styles.th}
                        onClick={() => onCustomerSort("gini")}
                      >
                        Sizing Strategy
                        <span className="sort-arrow">
                          {customerSort.key === "gini"
                            ? customerSort.dir === 1
                              ? "▲"
                              : "▼"
                            : ""}
                        </span>
                      </th>
                      <th style={styles.th}>Specialization</th>
                      {showOpenRisk ? (
                        <th style={styles.th} title="Open risk from live tape">
                          24h Open
                        </th>
                      ) : null}
                      <th style={styles.th}>Correlated Par</th>
                      <th
                        className="sortable"
                        style={styles.th}
                        onClick={() => onCustomerSort("var95Usd")}
                      >
                        7d VaR (95%)
                        <span className="sort-arrow">
                          {customerSort.key === "var95Usd"
                            ? customerSort.dir === 1
                              ? "▲"
                              : "▼"
                            : ""}
                        </span>
                      </th>
                      <th
                        className="sortable directive"
                        style={styles.th}
                        onClick={() => onCustomerSort("holdPct")}
                      >
                        Desk Directive
                        <span className="sort-arrow">
                          {customerSort.key === "holdPct"
                            ? customerSort.dir === 1
                              ? "▲"
                              : "▼"
                            : ""}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCustomers.map((cust) => {
                      const isSelected = selectedCustomer?.id === cust.id;
                      const tierClass = cust.tier.includes("TIER_1")
                        ? "tier-1"
                        : cust.tier.includes("TIER_2")
                          ? "tier-2"
                          : cust.tier.includes("TIER_3")
                            ? "tier-3"
                            : cust.tier.includes("TIER_4")
                              ? "tier-4"
                              : "tier-5";

                      const actionClass = cust.action.includes("ALERT")
                        ? "action-alert"
                        : cust.action.includes("MONITOR") ||
                            cust.action.includes("THROTTLE")
                          ? "action-monitor"
                          : "action-accept";

                      return (
                        <tr
                          key={cust.id}
                          style={styles.tr(isSelected)}
                          onClick={() => {
                            onSelectCustomer(cust);
                            onClearForensicResult();
                          }}
                        >
                          <td style={styles.td}>
                            <div style={styles.custCell}>
                              <span
                                style={{
                                  ...styles.custLink,
                                  cursor: "pointer",
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectCustomer(cust);
                                  onClearForensicResult();
                                }}
                              >
                                {cust.id}
                              </span>
                              <a
                                href={`https://fantasy402.com/manager.html?customer=${cust.id}`}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  color: "#94a3b8",
                                  textDecoration: "none",
                                  fontSize: "11px",
                                }}
                                onClick={(e) => e.stopPropagation()}
                                title="Open in Fantasy402 Manager Portal"
                              >
                                ↗
                              </a>
                              {cust.source !== undefined && (
                                <span
                                  style={{
                                    ...styles.subBadge,
                                    backgroundColor: "rgba(56, 189, 248, 0.14)",
                                    color: "#7dd3fc",
                                  }}
                                  title={`Row source: ${cust.source}`}
                                >
                                  {cust.source.toUpperCase()}
                                </span>
                              )}
                              {cust.subAccountIndex !== null && (
                                <span style={styles.subBadge}>
                                  Seat #{cust.subAccountIndex}
                                </span>
                              )}
                            </div>
                            <div style={styles.custAgent}>
                              Agent:{" "}
                              <a
                                href={getLocalAgentHref(cust.agentId)}
                                style={{
                                  color: "#38bdf8",
                                  textDecoration: "none",
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (
                                    onSelectAgent &&
                                    !e.metaKey &&
                                    !e.ctrlKey &&
                                    e.button === 0
                                  ) {
                                    e.preventDefault();
                                    onSelectAgent(cust.agentId);
                                  }
                                }}
                                title="Open SportsDesk Agent Inspector"
                              >
                                {cust.agentId} ↗
                              </a>
                            </div>
                          </td>
                          <td style={styles.td}>
                            <span className={`chip ${tierClass}`}>
                              {cust.score >= 9.0
                                ? "🚨 "
                                : cust.score >= 8.0
                                  ? "⚡ "
                                  : cust.score >= 7.0
                                    ? "⚠️ "
                                    : "✅ "}
                              {cust.score.toFixed(1)} ·{" "}
                              {cust.tier.replace("TIER_", "T")}
                            </span>
                            {cust.tierLabel ? (
                              <div
                                style={{
                                  fontSize: "10px",
                                  color: "#94a3b8",
                                  marginTop: "2px",
                                }}
                              >
                                {cust.tierLabel}
                              </div>
                            ) : null}
                          </td>
                          <td style={styles.td}>
                            {typeof cust.clvBps === "number" &&
                            Number.isFinite(cust.clvBps) ? (
                              <span
                                style={{
                                  fontWeight: 700,
                                  color:
                                    cust.clvBps > 0
                                      ? "#4ade80"
                                      : cust.clvBps < 0
                                        ? "#f87171"
                                        : "#cbd5e1",
                                }}
                              >
                                {cust.clvBps > 0
                                  ? `+${cust.clvBps}`
                                  : `${cust.clvBps}`}{" "}
                                bps
                              </span>
                            ) : (
                              <span style={{ color: "#64748b" }}>—</span>
                            )}
                          </td>
                          <td style={styles.td}>
                            <div>{cust.sizingStrategy}</div>
                            <div style={styles.custSub}>
                              {isUnknown(cust, "gini")
                                ? "Gini: —"
                                : `Gini: ${cust.gini.toFixed(3)}`}
                            </div>
                          </td>
                          <td
                            style={{
                              ...styles.td,
                              maxWidth: "168px",
                              whiteSpace: "normal",
                              overflowWrap: "anywhere",
                            }}
                          >
                            <div>{cust.specialization}</div>
                            <div style={styles.custSub}>
                              {cust.timingArchetype}
                            </div>
                          </td>
                          {showOpenRisk ? (
                            <td style={styles.td}>
                              {(cust.openRiskUsd ?? 0) > 0
                                ? `$${cust.openRiskUsd!.toLocaleString()}`
                                : "—"}
                            </td>
                          ) : null}
                          <td style={styles.td}>
                            {isUnknown(cust, "correlation") ? (
                              <span style={{ color: "#64748b" }}>—</span>
                            ) : (
                              <span
                                style={styles.corrBadge(cust.correlatedRisk)}
                              >
                                {cust.correlatedRisk}
                              </span>
                            )}
                          </td>
                          <td style={styles.td}>
                            <div>
                              {isUnknown(cust, "var95")
                                ? "—"
                                : `$${cust.var95Usd.toLocaleString()}`}
                            </div>
                            <div
                              className={
                                cust.holdPct < 0 ? "hold-neg" : "hold-pos"
                              }
                              style={{ fontSize: "11px" }}
                            >
                              {isUnknown(cust, "holdPct")
                                ? "Hold: —"
                                : `Hold: ${cust.holdPct}%`}
                            </div>
                          </td>
                          <td className="directive" style={styles.td}>
                            <span className={`chip ${actionClass}`}>
                              {cust.action}
                            </span>
                            <div style={styles.custSub}>
                              {isUnknown(cust, "limit")
                                ? "Cap: —"
                                : `Cap: $${cust.recommendedLimitUsd.toLocaleString()}`}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {sortedCustomers.length === 0 && (
                      <tr>
                        <td
                          colSpan={7}
                          style={{
                            padding: "24px 16px",
                            textAlign: "center",
                            color: "#94a3b8",
                            fontSize: "12px",
                          }}
                        >
                          No profiled bettors match current filters.{" "}
                          {hasActiveFilter && (
                            <button
                              type="button"
                              onClick={resetFilters}
                              style={{
                                marginLeft: "8px",
                                padding: "3px 10px",
                                borderRadius: "4px",
                                backgroundColor: "rgba(56, 189, 248, 0.16)",
                                border: "1px solid rgba(56, 189, 248, 0.4)",
                                color: "#7dd3fc",
                                fontSize: "11px",
                                fontWeight: 600,
                                cursor: "pointer",
                              }}
                            >
                              Reset filters
                            </button>
                          )}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Right Column: Deep-Dive Inspector */}
            <div className="detail-panel" style={styles.inspectorPanel}>
              {selectedCustomer ? (
                <div>
                  <div style={styles.inspectorHeader}>
                    <div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <h2 style={styles.inspectorTitle}>
                          {selectedCustomer.id}
                        </h2>
                        {selectedIndex >= 0 && (
                          <span
                            style={{
                              padding: "1px 7px",
                              borderRadius: "999px",
                              backgroundColor: "#1e293b",
                              color: "#94a3b8",
                              fontSize: "11px",
                              fontWeight: 600,
                              whiteSpace: "nowrap",
                            }}
                          >
                            #{selectedIndex + 1} / {sortedCustomers.length}
                          </span>
                        )}
                      </div>
                      <div style={styles.inspectorSub}>
                        {selectedCustomer.name} · Agent:{" "}
                        <b>{selectedCustomer.agentId}</b> (Master:{" "}
                        <b>{selectedCustomer.masterAgent}</b>)
                      </div>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        justifyContent: "flex-start",
                        alignItems: "center",
                        gap: "6px",
                        maxWidth: "100%",
                      }}
                    >
                      <button
                        type="button"
                        disabled={!canStepPrev}
                        onClick={() => stepCustomer(-1)}
                        style={{
                          padding: "4px 7px",
                          borderRadius: "4px",
                          backgroundColor: "#1e293b",
                          color: canStepPrev ? "#e2e8f0" : "#475569",
                          border: "1px solid #334155",
                          fontSize: "11px",
                          cursor: canStepPrev ? "pointer" : "default",
                        }}
                        title="Previous customer in current sort order"
                      >
                        ← Prev
                      </button>
                      <button
                        type="button"
                        disabled={!canStepNext}
                        onClick={() => stepCustomer(1)}
                        style={{
                          padding: "4px 7px",
                          borderRadius: "4px",
                          backgroundColor: "#1e293b",
                          color: canStepNext ? "#e2e8f0" : "#475569",
                          border: "1px solid #334155",
                          fontSize: "11px",
                          cursor: canStepNext ? "pointer" : "default",
                        }}
                        title="Next customer in current sort order"
                      >
                        Next →
                      </button>
                      <button
                        type="button"
                        style={{
                          ...styles.actionBtn,
                          padding: "4px 8px",
                          fontSize: "11px",
                          cursor: "pointer",
                        }}
                        onClick={() =>
                          onOpenTerminalProfile(selectedCustomer.id)
                        }
                        title="Inspect this customer in Bun.Terminal emulator"
                      >
                        💻 Terminal
                      </button>
                      {onOpenTerminalRadar ? (
                        <button
                          type="button"
                          style={{
                            ...styles.actionBtn,
                            padding: "4px 8px",
                            fontSize: "11px",
                            cursor: "pointer",
                          }}
                          onClick={() =>
                            onOpenTerminalRadar(selectedCustomer.id)
                          }
                          title="Run profile &lt;id&gt; --radar in Bun.Terminal"
                        >
                          📊 Radar
                        </button>
                      ) : null}
                      {onViewCustomerWagers && (
                        <button
                          type="button"
                          style={{
                            ...styles.actionBtn,
                            padding: "4px 8px",
                            fontSize: "11px",
                            cursor: "pointer",
                          }}
                          onClick={() =>
                            onViewCustomerWagers(selectedCustomer.id)
                          }
                          title="Filter Live Wagers tape to this customer"
                        >
                          ⚡ Wager Tape
                        </button>
                      )}
                      <button
                        type="button"
                        style={{
                          ...styles.actionBtn,
                          padding: "4px 8px",
                          fontSize: "11px",
                          cursor: "pointer",
                        }}
                        onClick={() => onCopyCli(selectedCustomer.id)}
                        title="Copy terminal CLI command to clipboard"
                      >
                        {copiedCliId === selectedCustomer.id
                          ? "✓ Copied CLI"
                          : "📋 Copy CLI"}
                      </button>
                      <a
                        href={`https://fantasy402.com/manager.html?customer=${selectedCustomer.id}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          ...styles.actionBtn,
                          padding: "4px 8px",
                          fontSize: "11px",
                          textDecoration: "none",
                          color: "#0f172a",
                        }}
                        title="Requires active Fantasy402 manager session in your browser"
                      >
                        Portal ↗
                      </a>
                      <span style={styles.tierBadge(selectedCustomer.tier)}>
                        {selectedCustomer.tierLabel ?? selectedCustomer.tier}{" "}
                        (Score: {selectedCustomer.score.toFixed(1)}/10.0)
                      </span>
                      {selectedCustomer.source ? (
                        <span
                          style={{
                            fontSize: "10px",
                            padding: "2px 6px",
                            borderRadius: "4px",
                            backgroundColor: "rgba(148, 163, 184, 0.15)",
                            color: "#94a3b8",
                          }}
                        >
                          source: {selectedCustomer.source}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {/* Decomposed Score: common-scale aligned bars */}
                  <div style={styles.radarCard}>
                    <h4 style={styles.cardHeader}>
                      🎯 Decomposed Sharpness Radars
                    </h4>
                    <SharpnessDecomposition
                      score={selectedCustomer.score}
                      components={RADAR_AXES.map((axis) => ({
                        key: axis.valueKey,
                        label: axis.label,
                        value: selectedCustomer[axis.valueKey],
                        cap: axis.max,
                      }))}
                    />
                  </div>

                  {/* Sizing & Portfolio Risk */}
                  <div style={styles.detailGrid}>
                    <div style={styles.detailCard}>
                      <h4 style={styles.cardHeader}>
                        💰 Stake Sizing & Variance
                      </h4>
                      <div>
                        Strategy:{" "}
                        <b>
                          {isUnknown(selectedCustomer, "sizing")
                            ? "—"
                            : selectedCustomer.sizingStrategy}
                        </b>
                      </div>
                      <div>
                        Gini Inequality:{" "}
                        <b>
                          {isUnknown(selectedCustomer, "gini")
                            ? "—"
                            : selectedCustomer.gini}
                        </b>
                      </div>
                      <div>
                        Mean Stake:{" "}
                        <b>
                          {isUnknown(selectedCustomer, "meanStake")
                            ? "—"
                            : `$${selectedCustomer.meanStake.toLocaleString()}`}
                        </b>
                      </div>
                      <div>
                        VaR / Max Cap:{" "}
                        <b
                          style={{
                            color:
                              !isUnknown(selectedCustomer, "var95") &&
                              !isUnknown(selectedCustomer, "limit") &&
                              selectedCustomer.recommendedLimitUsd > 0 &&
                              selectedCustomer.var95Usd >
                                selectedCustomer.recommendedLimitUsd
                                ? "#f87171"
                                : "#7dd3fc",
                          }}
                        >
                          {!isUnknown(selectedCustomer, "var95") &&
                          !isUnknown(selectedCustomer, "limit") &&
                          selectedCustomer.recommendedLimitUsd > 0
                            ? `${Math.round((selectedCustomer.var95Usd / selectedCustomer.recommendedLimitUsd) * 100)}%`
                            : "n/a"}
                        </b>
                      </div>
                    </div>
                    <div style={styles.detailCard}>
                      <h4 style={styles.cardHeader}>
                        📊 Risk & Expected Value
                      </h4>
                      <div>
                        7d 95% VaR:{" "}
                        <b>
                          {isUnknown(selectedCustomer, "var95")
                            ? "—"
                            : `$${selectedCustomer.var95Usd.toLocaleString()}`}
                        </b>
                      </div>
                      <div>
                        Expected Shortfall (CVaR):{" "}
                        <b>
                          {isUnknown(selectedCustomer, "var95")
                            ? "—"
                            : `$${selectedCustomer.cvar95Usd.toLocaleString()}`}
                        </b>
                      </div>
                      <div>
                        Lifetime Hold:{" "}
                        <b
                          style={{
                            color: isUnknown(selectedCustomer, "holdPct")
                              ? "#94a3b8"
                              : selectedCustomer.holdPct < 0
                                ? "#f87171"
                                : "#4ade80",
                          }}
                        >
                          {isUnknown(selectedCustomer, "holdPct")
                            ? "—"
                            : `${selectedCustomer.holdPct}%`}
                        </b>
                      </div>
                      <div>
                        Projected LTV:{" "}
                        <b>
                          {isUnknown(selectedCustomer, "ltv")
                            ? "—"
                            : `$${Math.abs(selectedCustomer.ltvUsd).toLocaleString()}${
                                selectedCustomer.ltvUsd < 0
                                  ? " (Loss to Desk)"
                                  : " (Desk Hold)"
                              }`}
                        </b>
                      </div>
                    </div>
                  </div>

                  {selectedCustomerRatingLoading || selectedCustomerRating ? (
                    <div
                      data-customer-clv-rating-card="true"
                      style={{
                        ...styles.detailCard,
                        marginBottom: "12px",
                        border: "1px solid rgba(56, 189, 248, 0.28)",
                      }}
                    >
                      <h4 style={styles.cardHeader}>
                        📐 CLV, Bayesian Skill &amp; Kelly Rating
                        (/api/customer/rating)
                      </h4>
                      {selectedCustomerRatingLoading &&
                      !selectedCustomerRating ? (
                        <div style={{ color: "#94a3b8", fontSize: "12px" }}>
                          Evaluating CLV &amp; Bayesian skill rating…
                        </div>
                      ) : selectedCustomerRating ? (
                        <div
                          style={{
                            ...styles.detailGrid,
                            gridTemplateColumns:
                              "repeat(auto-fit, minmax(220px, 1fr))",
                            overflowWrap: "anywhere",
                          }}
                        >
                          <div>
                            <div>
                              Rating Score:{" "}
                              <b>
                                {selectedCustomerRating.score.toFixed(1)}/10 ·{" "}
                                {selectedCustomerRating.tier}
                              </b>{" "}
                              ({selectedCustomerRating.recommendedAction})
                            </div>
                            <div>
                              Measured CLV:{" "}
                              <b
                                style={{
                                  color:
                                    typeof selectedCustomerRating.clvBps ===
                                    "number"
                                      ? selectedCustomerRating.clvBps > 0
                                        ? "#4ade80"
                                        : selectedCustomerRating.clvBps < 0
                                          ? "#f87171"
                                          : "#e2e8f0"
                                      : "#94a3b8",
                                }}
                              >
                                {typeof selectedCustomerRating.clvBps ===
                                "number"
                                  ? `${selectedCustomerRating.clvBps > 0 ? "+" : ""}${selectedCustomerRating.clvBps} bps`
                                  : "—"}
                              </b>{" "}
                              <span style={styles.subBadge}>
                                source:{" "}
                                {selectedCustomerRating.clvSource ?? "none"}
                              </span>
                            </div>
                            <div>
                              CLV Edge Component:{" "}
                              <b>
                                {selectedCustomerRating.componentScores.clvEdgeScore.toFixed(
                                  1,
                                )}
                                /10
                              </b>
                            </div>
                          </div>
                          <div>
                            <div>
                              CLV Significance:{" "}
                              <b>
                                {selectedCustomerRating.clvSignificance
                                  ? `${selectedCustomerRating.clvSignificance.meanClvPercent > 0 ? "+" : ""}${selectedCustomerRating.clvSignificance.meanClvPercent.toFixed(1)}% (${
                                      selectedCustomerRating.clvSignificance
                                        .sampleCount === 1
                                        ? "n=1 (book aggregate)"
                                        : `n=${selectedCustomerRating.clvSignificance.sampleCount} · p=${selectedCustomerRating.clvSignificance.pValue.toFixed(3)} · ${
                                            selectedCustomerRating
                                              .clvSignificance.isSignificant95
                                              ? "Sig 95%"
                                              : "Not Sig"
                                          }`
                                    })`
                                  : "No CLV samples"}
                              </b>
                            </div>
                            {selectedCustomerRating.bayesianSkill ? (
                              <div>
                                Bayesian Win Rate:{" "}
                                <b>
                                  {(
                                    selectedCustomerRating.bayesianSkill
                                      .posteriorMeanWinRate * 100
                                  ).toFixed(1)}
                                  %
                                </b>{" "}
                                [
                                {(
                                  selectedCustomerRating.bayesianSkill
                                    .credibleInterval95[0] * 100
                                ).toFixed(0)}
                                %–
                                {(
                                  selectedCustomerRating.bayesianSkill
                                    .credibleInterval95[1] * 100
                                ).toFixed(0)}
                                %] ·{" "}
                                {selectedCustomerRating.bayesianSkill.status}
                              </div>
                            ) : null}
                            {selectedCustomerRating.kellyMetrics ? (
                              <div>
                                Kelly Sizing:{" "}
                                <b>
                                  ½Kelly{" "}
                                  {(
                                    selectedCustomerRating.kellyMetrics
                                      .halfKellyFraction * 100
                                  ).toFixed(2)}
                                  % vs Obs{" "}
                                  {(
                                    selectedCustomerRating.kellyMetrics
                                      .observedUnitFraction * 100
                                  ).toFixed(2)}
                                  %
                                </b>{" "}
                                <span
                                  style={{
                                    ...styles.subBadge,
                                    color: selectedCustomerRating.kellyMetrics
                                      .isKellyDisciplined
                                      ? "#4ade80"
                                      : "#fbbf24",
                                  }}
                                >
                                  {selectedCustomerRating.kellyMetrics
                                    .isKellyDisciplined
                                    ? "Disciplined"
                                    : "Review"}
                                </span>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Correlated Parlay & Timing */}
                  <div style={styles.detailGrid}>
                    <div style={styles.detailCard}>
                      <h4 style={styles.cardHeader}>🔗 Correlated Parlays</h4>
                      <div>
                        Risk Tier:{" "}
                        <span
                          style={styles.corrBadge(
                            selectedCustomer.correlatedRisk,
                          )}
                        >
                          {selectedCustomer.correlatedRisk}
                        </span>
                      </div>
                      <div>
                        Exploit Rate:{" "}
                        <b>
                          {(
                            selectedCustomer.correlatedExploitRate * 100
                          ).toFixed(0)}
                          %
                        </b>
                      </div>
                    </div>
                    <div style={styles.detailCard}>
                      <h4 style={styles.cardHeader}>⏱️ Timing Fingerprint</h4>
                      <div>
                        Archetype: <b>{selectedCustomer.timingArchetype}</b>
                      </div>
                      <div>
                        Downline Syndicate:{" "}
                        <b>
                          {(selectedCustomer.syndicateProb * 100).toFixed(0)}%
                          Prob
                        </b>
                      </div>
                    </div>
                  </div>

                  {/* Actionable Operator Directives */}
                  <div style={styles.directiveCard}>
                    <h4 style={styles.cardHeader}>
                      🚨 Actionable Desk Directives
                    </h4>
                    <div style={styles.directiveRow}>
                      <span>Action:</span>
                      <span style={styles.actionBadge(selectedCustomer.action)}>
                        {selectedCustomer.action}
                      </span>
                    </div>
                    <div style={styles.directiveRow}>
                      <span>Max Stake Ceiling:</span>
                      <b>
                        {isUnknown(selectedCustomer, "limit")
                          ? "—"
                          : `$${selectedCustomer.recommendedLimitUsd.toLocaleString()}`}
                      </b>
                    </div>
                    <div style={styles.directiveRow}>
                      <span>In-Play Submission Delay:</span>
                      <b>
                        {isUnknown(selectedCustomer, "delay")
                          ? "—"
                          : `${selectedCustomer.inPlayDelaySec} seconds`}
                      </b>
                    </div>
                    <div style={styles.directiveRow}>
                      <span>Line Shading:</span>
                      <b>{selectedCustomer.lineShadeCents}¢ against action</b>
                    </div>
                    <div style={styles.directiveRow}>
                      <span>Shadow Copy Multiplier:</span>
                      <b>{selectedCustomer.shadowCopyMultiplier.toFixed(2)}x</b>
                    </div>
                  </div>

                  {/* Cross-Endpoint Portal & Figure-Date Reconciliation Card */}
                  {selectedCustomer.portalReconciliation && (
                    <div
                      style={{
                        ...styles.detailCard,
                        marginBottom: "14px",
                        border: "1px solid rgba(56, 189, 248, 0.35)",
                        backgroundColor: "rgba(15, 23, 42, 0.78)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: "6px",
                          marginBottom: "8px",
                        }}
                      >
                        <h4 style={{ ...styles.cardHeader, margin: 0 }}>
                          🧾 Cross-Endpoint Portal & Figure-Date Reconciliation
                        </h4>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: "999px",
                            fontSize: "10px",
                            fontWeight: 700,
                            backgroundColor: selectedCustomer
                              .portalReconciliation.creditEquationBalanced
                              ? "rgba(34, 197, 94, 0.16)"
                              : "rgba(239, 68, 68, 0.18)",
                            color: selectedCustomer.portalReconciliation
                              .creditEquationBalanced
                              ? "#4ade80"
                              : "#f87171",
                            border: `1px solid ${
                              selectedCustomer.portalReconciliation
                                .creditEquationBalanced
                                ? "rgba(74, 222, 128, 0.4)"
                                : "rgba(248, 113, 113, 0.45)"
                            }`,
                          }}
                        >
                          {selectedCustomer.portalReconciliation
                            .creditEquationBalanced
                            ? "✓ CREDIT & CARRYOVER BALANCED (0¢ DELTA)"
                            : "⚠️ LEDGER DELTA"}
                        </span>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 1fr",
                          gap: "8px",
                          fontSize: "12px",
                          marginBottom: "8px",
                        }}
                      >
                        <div
                          style={{
                            padding: "8px",
                            borderRadius: "6px",
                            backgroundColor: "#091020",
                            border: "1px solid #1e293b",
                          }}
                        >
                          <div
                            style={{
                              fontSize: "10px",
                              color: "#94a3b8",
                              textTransform: "uppercase",
                              marginBottom: "4px",
                            }}
                          >
                            getInfoPlayer Credit-Line Identity
                          </div>
                          <div>
                            Credit Limit:{" "}
                            <b>
                              $
                              {selectedCustomer.portalReconciliation.creditLimitUsd.toLocaleString()}
                            </b>
                          </div>
                          <div>
                            Current Balance:{" "}
                            <b
                              style={{
                                color:
                                  selectedCustomer.portalReconciliation
                                    .currentBalanceUsd < 0
                                    ? "#f87171"
                                    : "#4ade80",
                              }}
                            >
                              {selectedCustomer.portalReconciliation
                                .currentBalanceUsd < 0
                                ? `-$${Math.abs(selectedCustomer.portalReconciliation.currentBalanceUsd).toLocaleString()}`
                                : `+$${selectedCustomer.portalReconciliation.currentBalanceUsd.toLocaleString()}`}
                            </b>
                          </div>
                          <div>
                            Pending Exposure:{" "}
                            <b style={{ color: "#fbbf24" }}>
                              $
                              {selectedCustomer.portalReconciliation.pendingWagerBalanceUsd.toLocaleString()}
                            </b>{" "}
                            (
                            {
                              selectedCustomer.portalReconciliation
                                .pendingWagerCount
                            }{" "}
                            open)
                          </div>
                          <div>
                            Available Balance:{" "}
                            <b style={{ color: "#38bdf8" }}>
                              $
                              {selectedCustomer.portalReconciliation.availableBalanceUsd.toLocaleString()}
                            </b>
                          </div>
                        </div>
                        <div
                          style={{
                            padding: "8px",
                            borderRadius: "6px",
                            backgroundColor: "#091020",
                            border: "1px solid #1e293b",
                          }}
                        >
                          <div
                            style={{
                              fontSize: "10px",
                              color: "#94a3b8",
                              textTransform: "uppercase",
                              marginBottom: "4px",
                            }}
                          >
                            getPerformancePlayer ↔ CarryOver Split
                          </div>
                          <div>
                            Carryover Prefix:{" "}
                            <b style={{ color: "#f87171" }}>
                              +$
                              {selectedCustomer.portalReconciliation.carryOverUsd.toLocaleString()}
                            </b>{" "}
                            <span
                              style={{ fontSize: "10px", color: "#4ade80" }}
                            >
                              (
                              {selectedCustomer.portalReconciliation
                                .carryOverParityMatched
                                ? "PreviousBalance × 100 ✓"
                                : "Mismatch"}
                              )
                            </span>
                          </div>
                          <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                            Window:{" "}
                            {
                              selectedCustomer.portalReconciliation
                                .carryOverWindow
                            }
                          </div>
                          <div>
                            Post-Carryover Net:{" "}
                            <b
                              style={{
                                color:
                                  selectedCustomer.portalReconciliation
                                    .postCarryOverNetUsd < 0
                                    ? "#4ade80"
                                    : "#f87171",
                              }}
                            >
                              {selectedCustomer.portalReconciliation
                                .postCarryOverNetUsd < 0
                                ? `-$${Math.abs(selectedCustomer.portalReconciliation.postCarryOverNetUsd).toLocaleString()}`
                                : `+$${selectedCustomer.portalReconciliation.postCarryOverNetUsd.toLocaleString()}`}
                            </b>
                          </div>
                          <div>
                            31d Customer Net:{" "}
                            <b style={{ color: "#f87171" }}>
                              +$
                              {selectedCustomer.portalReconciliation.net31dUsd.toLocaleString()}
                            </b>{" "}
                            ({selectedCustomer.portalReconciliation.winDays31d}W
                            -{selectedCustomer.portalReconciliation.lossDays31d}
                            L ·{" "}
                            {
                              selectedCustomer.portalReconciliation
                                .activeDays31d
                            }{" "}
                            figureDates)
                          </div>
                        </div>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "6px",
                          fontSize: "11px",
                          color: "#cbd5e1",
                          marginBottom: "6px",
                        }}
                      >
                        <span>
                          Wager Limit:{" "}
                          <b>
                            $
                            {selectedCustomer.portalReconciliation.wagerLimitUsd.toLocaleString()}
                          </b>
                        </span>
                        <span>·</span>
                        <span>
                          Settle Figure:{" "}
                          <b>
                            $
                            {selectedCustomer.portalReconciliation.settleFigureUsd.toLocaleString()}
                          </b>
                        </span>
                        <span>·</span>
                        <span>
                          WiseLineWeight:{" "}
                          <b>
                            {
                              selectedCustomer.portalReconciliation
                                .wiseLineMovementWeight
                            }
                          </b>
                        </span>
                        <span>·</span>
                        <span>
                          Delay:{" "}
                          <b>
                            {
                              selectedCustomer.portalReconciliation
                                .confirmationDelaySec
                            }
                            s
                          </b>
                        </span>
                        <span>·</span>
                        <span>
                          Inet:{" "}
                          <code>
                            {selectedCustomer.portalReconciliation.inetTarget}
                          </code>
                        </span>
                        <span>·</span>
                        <span>
                          Parlay:{" "}
                          <b>
                            {
                              selectedCustomer.portalReconciliation
                                .assignedParlayName
                            }
                          </b>
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "5px",
                        }}
                      >
                        {selectedCustomer.portalReconciliation.postureFlags.map(
                          (flag) => (
                            <span
                              key={flag}
                              style={{
                                padding: "2px 6px",
                                borderRadius: "4px",
                                fontSize: "10px",
                                fontWeight: 700,
                                fontFamily: "monospace",
                                backgroundColor:
                                  flag === "LINE_MOVER_WEIGHT_ACTIVE"
                                    ? "rgba(239, 68, 68, 0.16)"
                                    : flag === "BETTING_ALERTS_DISABLED"
                                      ? "rgba(245, 158, 11, 0.16)"
                                      : "rgba(56, 189, 248, 0.12)",
                                color:
                                  flag === "LINE_MOVER_WEIGHT_ACTIVE"
                                    ? "#fca5a5"
                                    : flag === "BETTING_ALERTS_DISABLED"
                                      ? "#fbbf24"
                                      : "#7dd3fc",
                                border: "1px solid rgba(148, 163, 184, 0.25)",
                              }}
                            >
                              {flag}
                            </span>
                          ),
                        )}
                      </div>
                    </div>
                  )}

                  {/* Real-time Reverse DNS Forensics Trigger */}
                  <div style={styles.forensicCard}>
                    <h4 style={styles.cardHeader}>
                      🌐 Reverse DNS & Proxy Forensics
                    </h4>
                    <div style={styles.forensicRow}>
                      <span>Observed Login IP:</span>
                      <code>{selectedCustomer.ipAddress}</code>
                      <button
                        type="button"
                        style={styles.actionBtnSmall}
                        onClick={() =>
                          onRunReverseLookup(selectedCustomer.ipAddress)
                        }
                      >
                        🔍 Run Reverse DNS
                      </button>
                    </div>
                    {customerReverseForensics ? (
                      <ReverseDnsForensicsCard
                        view={customerReverseForensics}
                      />
                    ) : null}
                  </div>
                </div>
              ) : (
                <div style={styles.loading}>
                  Select a customer to inspect deep multidimensional profile.
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
