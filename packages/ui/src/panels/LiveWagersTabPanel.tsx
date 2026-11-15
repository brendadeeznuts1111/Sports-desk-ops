import type React from "react";
import { styles } from "../dashboard_styles.ts";
import {
  formatProvenanceBadge,
  PENDING_WAGERS_PROVENANCE,
} from "../hydration.ts";
import {
  DASHBOARD_FRESHNESS,
  DASHBOARD_THRESHOLDS,
} from "../config/dashboard.ts";
import {
  clvEdgeTone,
  WAGER_ALERT_TIERS,
  WAGER_BET_TYPE_FILTERS,
  WAGER_PERIOD_FILTERS,
  WAGER_SPORT_FILTERS,
  WAGER_TIER_RANK,
  WAGERS_META,
  WAGERS_TABLE,
  WAGERS_THRESHOLDS,
} from "../config/wagers.ts";
import { getLocalAgentHref } from "../links.ts";
import { WireContractChip } from "./WireContractChip.tsx";
import type {
  DashboardSourceProvenance,
  LiveWager,
  TierStyleConfig,
  SlabPolicySummary,
  WagerSortField,
  WagersWireContractSummary,
} from "../types.ts";

export interface LiveWagersTabPanelProps {
  readonly wagers?: readonly LiveWager[] | undefined;
  readonly provenance?: DashboardSourceProvenance | undefined;
  readonly wagersError?: string | null | undefined;
  readonly onRefreshWagers?: (() => void) | undefined;
  readonly wagerSearch: string;
  readonly onWagerSearchChange: (value: string) => void;
  readonly wagerSportFilter: string;
  readonly onWagerSportFilterChange: (sport: string) => void;
  readonly wagerAlertFilter: string;
  readonly onWagerAlertFilterChange: (tier: string) => void;
  readonly wagerTypeFilter: string;
  readonly onWagerTypeFilterChange: (betType: string) => void;
  readonly wagerSortField: WagerSortField;
  readonly wagerSortDir: "asc" | "desc";
  readonly onWagerSort: (field: WagerSortField) => void;
  readonly selectedWager: LiveWager | null;
  readonly onSelectWager: (wager: LiveWager) => void;
  readonly copiedTicketId: string | null;
  readonly onCopyText: (ticketId: string, text: string) => void;
  readonly tiersConfig: TierStyleConfig | null;
  /** Vendor wire-contract check from the feed; absent when the host doesn't check. */
  readonly wireContract?: WagersWireContractSummary | null | undefined;
  /** Validated slab policy from config/slab.toml, when the host exposes it. */
  readonly slabPolicy?: SlabPolicySummary | null | undefined;
  readonly onSelectCustomerById: (customerId: string) => void;
  readonly onInspectPty: (customerId: string) => void;
  readonly onSelectAgent?: ((agentId: string) => void) | undefined;
}

// Filter vocabulary and severity ranks are inlined from
// `packages/ui/src/config/wagers.toml` by Bun's bundler (no runtime fetch).
const SPORT_PILLS = WAGER_SPORT_FILTERS;
const PERIOD_SLICE_PILLS = WAGER_PERIOD_FILTERS;
const BET_TYPE_PILLS = WAGER_BET_TYPE_FILTERS;
const ALERT_PILLS = [
  { id: "ALL", label: "All Alerts" },
  ...WAGER_ALERT_TIERS.map((tier) => ({ id: tier.id, label: tier.label })),
];
const TIER_ORDER = WAGER_TIER_RANK;

/** Stake emphasis is owned by `dashboard.toml`, not duplicated in wagers.toml. */
const HIGH_RISK_WAGER_USD = DASHBOARD_THRESHOLDS.high_risk_wager_usd;

function describeEmptyWagers(
  loadedCount: number,
  provenance: DashboardSourceProvenance,
): string {
  const endpoint = provenance.sourcePath ?? "/api/wagers";
  if (loadedCount > 0) return "No wagers match the current filters.";
  switch (provenance.kind) {
    case "pending":
      return `Waiting for GET ${endpoint}…`;
    case "unavailable":
      return `Unavailable — ${endpoint}: ${provenance.label}`;
    default:
      return `${provenance.label} returned no wagers (${endpoint}).`;
  }
}

export function LiveWagersTabPanel({
  wagers = [],
  provenance = PENDING_WAGERS_PROVENANCE,
  wagersError = null,
  onRefreshWagers,
  wagerSearch,
  onWagerSearchChange,
  wagerSportFilter,
  onWagerSportFilterChange,
  wagerAlertFilter,
  onWagerAlertFilterChange,
  wagerTypeFilter,
  onWagerTypeFilterChange,
  wagerSortField,
  wagerSortDir,
  onWagerSort,
  selectedWager,
  onSelectWager,
  copiedTicketId,
  onCopyText,
  tiersConfig,
  wireContract = null,
  slabPolicy = null,
  onSelectCustomerById,
  onInspectPty,
  onSelectAgent,
}: LiveWagersTabPanelProps): React.ReactElement {
  const activeWagers = wagers;
  const activeProvenance: DashboardSourceProvenance = wagersError
    ? {
        kind: "unavailable",
        label: wagersError,
        sourcePath: provenance.sourcePath,
        observedAt: provenance.observedAt,
      }
    : provenance;
  const provenanceBadge = formatProvenanceBadge(activeProvenance, {
    staleAfterMinutes: DASHBOARD_FRESHNESS.stale_after_minutes,
  });

  const criticalSteamCount = activeWagers.filter(
    (w) => w.alertTier === "CRITICAL" || w.alertTier === "STEAM",
  ).length;
  const totalRiskUsd = activeWagers.reduce((acc, w) => acc + w.riskUsd, 0);
  const totalToWinUsd = activeWagers.reduce((acc, w) => acc + w.toWinUsd, 0);

  const baseSportIds = new Set(SPORT_PILLS.map((p) => p.id.toUpperCase()));
  const extraSportPills: Array<{ id: string; label: string }> = [];
  for (const w of activeWagers) {
    const up = w.sport.toUpperCase();
    if (up && !baseSportIds.has(up)) {
      baseSportIds.add(up);
      extraSportPills.push({ id: up, label: up });
    }
  }
  const sportPills = [...SPORT_PILLS, ...extraSportPills];

  const baseTypeIds = new Set(BET_TYPE_PILLS.map((p) => p.id.toUpperCase()));
  const extraTypePills: Array<{ id: string; label: string }> = [];
  for (const w of activeWagers) {
    const up = w.betType.toUpperCase();
    if (up && !baseTypeIds.has(up)) {
      baseTypeIds.add(up);
      extraTypePills.push({ id: w.betType, label: w.betType });
    }
  }
  const betTypePills = [...BET_TYPE_PILLS, ...extraTypePills];

  const filteredWagers = activeWagers
    .filter((w) => {
      const q = wagerSearch.trim().toLowerCase();
      const matchesSearch =
        !q ||
        w.ticketId.toLowerCase().includes(q) ||
        w.customerId.toLowerCase().includes(q) ||
        w.agentId.toLowerCase().includes(q) ||
        w.sport.toLowerCase().includes(q) ||
        w.betType.toLowerCase().includes(q) ||
        w.event.toLowerCase().includes(q) ||
        w.selection.toLowerCase().includes(q) ||
        w.alertBadge.toLowerCase().includes(q) ||
        ((q === "live" || q === "gslive" || q === "in-play") &&
          (/in-play|live|halftime/i.test(w.selection) ||
            /in-play|live|halftime/i.test(w.alertBadge) ||
            w.alertTier === "LATENCY"));
      if (!matchesSearch) return false;
      if (
        wagerSportFilter !== "ALL" &&
        w.sport.toUpperCase() !== wagerSportFilter.toUpperCase()
      )
        return false;
      if (wagerAlertFilter !== "ALL" && w.alertTier !== wagerAlertFilter)
        return false;
      if (
        wagerTypeFilter !== "ALL" &&
        w.betType.toUpperCase() !== wagerTypeFilter.toUpperCase()
      )
        return false;
      return true;
    })
    .sort((a, b) => {
      let cmp = 0;
      if (wagerSortField === "timestamp") {
        cmp = a.timestamp.localeCompare(b.timestamp);
      } else if (wagerSortField === "riskUsd") {
        cmp = a.riskUsd - b.riskUsd;
      } else if (wagerSortField === "toWinUsd") {
        cmp = a.toWinUsd - b.toWinUsd;
      } else if (wagerSortField === "clvCents") {
        // Unknown CLV sorts last in both directions rather than pretending to be 0.
        if (a.clvCents === null || b.clvCents === null) {
          return a.clvCents === null ? (b.clvCents === null ? 0 : 1) : -1;
        }
        return wagerSortDir === "asc"
          ? a.clvCents - b.clvCents
          : b.clvCents - a.clvCents;
      } else if (wagerSortField === "alertTier") {
        cmp = (TIER_ORDER[a.alertTier] ?? 0) - (TIER_ORDER[b.alertTier] ?? 0);
      }
      return wagerSortDir === "asc" ? cmp : -cmp;
    });

  // Hard render bound from wagers.toml: the feed may carry more rows than the
  // desk wants mounted in one table pass.
  const visibleWagers = filteredWagers.slice(0, WAGERS_TABLE.max_rows);

  // Aggregate per-customer CLV & dollar edge across the active slice
  const sliceCustomerMap = new Map<
    string,
    {
      customerId: string;
      agentId: string;
      wagers: number;
      riskUsd: number;
      clvSum: number;
      expectedEdgeUsd: number;
    }
  >();
  for (const w of filteredWagers) {
    // The customer aggregate is a CLV aggregate; a row without a closing-line
    // comparison contributes nothing rather than a zero.
    if (w.clvCents === null) continue;
    const existing = sliceCustomerMap.get(w.customerId);
    const edgeUsd = w.riskUsd * (w.clvCents / 100);
    if (existing) {
      existing.wagers += 1;
      existing.riskUsd += w.riskUsd;
      existing.clvSum += w.clvCents;
      existing.expectedEdgeUsd += edgeUsd;
    } else {
      sliceCustomerMap.set(w.customerId, {
        customerId: w.customerId,
        agentId: w.agentId,
        wagers: 1,
        riskUsd: w.riskUsd,
        clvSum: w.clvCents,
        expectedEdgeUsd: edgeUsd,
      });
    }
  }
  // A stale contract must not read as clean when the feed itself failed: the
  // error wins and the chip says unavailable, matching the provenance badge.
  const wireError = wagersError ?? wireContract?.error ?? null;

  const topSliceBeaters = [...sliceCustomerMap.values()]
    .sort((a, b) => b.expectedEdgeUsd - a.expectedEdgeUsd)
    .slice(0, WAGERS_THRESHOLDS.slice_leader_limit);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {wagersError ? (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            backgroundColor: "rgba(239, 68, 68, 0.14)",
            border: "1px solid rgba(239, 68, 68, 0.4)",
            color: "#fca5a5",
            fontSize: "12px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <span>
            <b>Live Wagers Feed Error:</b> {wagersError}
          </span>
          {onRefreshWagers ? (
            <button
              type="button"
              style={styles.actionBtn}
              onClick={onRefreshWagers}
            >
              ↻ Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Live Wagers KPI Grid */}
      <div style={styles.kpiGrid}>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Live Streaming Feed</div>
          <div style={styles.kpiVal}>{activeWagers.length} Wagers</div>
          <div style={styles.kpiSub}>{provenanceBadge.detail}</div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Flagged Steam / Originator</div>
          <div style={{ ...styles.kpiVal, color: "#f87171" }}>
            {criticalSteamCount} Alerts
          </div>
          <div style={styles.kpiSub}>Key Numbers 3 & 7 / Syndicate Hooks</div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Live Exposure at Risk</div>
          <div style={styles.kpiVal}>${totalRiskUsd.toLocaleString()}</div>
          <div style={styles.kpiSub}>
            To Win: ${totalToWinUsd.toLocaleString()}
          </div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Operator Guardrails</div>
          <div style={{ ...styles.kpiVal, color: "#4ade80" }}>
            autoExecute: false
          </div>
          <div style={styles.kpiSub}>Production Safety Invariant Active</div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div style={styles.filterBar}>
        <div style={styles.searchBox}>
          <span style={styles.searchIcon}>🔍</span>
          <input
            style={styles.searchInput}
            value={wagerSearch}
            onChange={(e) => onWagerSearchChange(e.target.value)}
            placeholder="Filter by Ticket (#W-...), Customer, Agent, Event, Selection..."
          />
        </div>

        <div style={styles.tierFilterGroup}>
          {sportPills.map((pill) => (
            <button
              key={pill.id}
              type="button"
              style={styles.filterPill(
                wagerSportFilter.toUpperCase() === pill.id.toUpperCase(),
              )}
              onClick={() => onWagerSportFilterChange(pill.id)}
            >
              {pill.label}
            </button>
          ))}
        </div>

        <div style={styles.tierFilterGroup}>
          {ALERT_PILLS.map((pill) => (
            <button
              key={pill.id}
              type="button"
              style={styles.filterPill(wagerAlertFilter === pill.id)}
              onClick={() => onWagerAlertFilterChange(pill.id)}
            >
              {pill.label}
            </button>
          ))}
        </div>

        <div style={styles.tierFilterGroup}>
          {betTypePills.map((pill) => (
            <button
              key={pill.id}
              type="button"
              style={styles.filterPill(
                wagerTypeFilter.toUpperCase() === pill.id.toUpperCase(),
              )}
              onClick={() => onWagerTypeFilterChange(pill.id)}
            >
              {pill.label}
            </button>
          ))}
        </div>

        <div style={styles.tierFilterGroup}>
          {PERIOD_SLICE_PILLS.map((pill) => (
            <button
              key={pill.label}
              type="button"
              style={styles.filterPill(
                wagerSearch.trim().toUpperCase() === pill.id.toUpperCase(),
              )}
              onClick={() => onWagerSearchChange(pill.id)}
            >
              {pill.label}
            </button>
          ))}
        </div>
      </div>

      {/* Slice Edge Leaderboard: Who is beating the desk in the active filter slice */}
      {topSliceBeaters.length > 0 && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            backgroundColor: "rgba(15, 23, 42, 0.75)",
            border: "1px solid rgba(56, 189, 248, 0.25)",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
          }}
        >
          <div style={{ fontSize: "12px", fontWeight: 700, color: "#e2e8f0" }}>
            🎯 Active Slice Edge Leaderboard (Who&apos;s Beating the Line):
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {topSliceBeaters.map((c, idx) => {
              const avgClv = c.wagers > 0 ? c.clvSum / c.wagers : 0;
              return (
                <button
                  key={c.customerId}
                  type="button"
                  style={{
                    ...styles.actionBtn,
                    padding: "4px 10px",
                    fontSize: "11px",
                    cursor: "pointer",
                  }}
                  onClick={() => onSelectCustomerById(c.customerId)}
                  title={`Inspect ${c.customerId} (${c.agentId}) — ${c.wagers} wager(s), $${c.riskUsd.toLocaleString()} risk`}
                >
                  #{idx + 1} <b>{c.customerId}</b> ({c.agentId}) ·{" "}
                  {avgClv > 0
                    ? `+${avgClv.toFixed(1)}¢`
                    : `${avgClv.toFixed(1)}¢`}{" "}
                  CLV · ${c.riskUsd.toLocaleString()}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Live Wagers Table Card */}
      <div style={styles.tableCard}>
        <div style={styles.tableHeader}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <h3 style={styles.tableTitle}>
              ⚡ Live Incoming Wagers & Real-Time Action Directives
            </h3>
            <span
              title={provenanceBadge.detail}
              style={{
                fontSize: "10px",
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: "999px",
                color: provenanceBadge.fg,
                backgroundColor: provenanceBadge.bg,
                border: `1px solid ${provenanceBadge.border}`,
              }}
            >
              {provenanceBadge.badgeText}
            </span>
            <span
              title={`Filter vocabulary, CLV ramp and row bounds are inlined from packages/ui/src/config/wagers.toml (schema ${WAGERS_META.schema}, v${WAGERS_META.version}) at bundle time. No runtime fetch, no JSON parse.`}
              style={{
                fontSize: "10px",
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: "999px",
                color: "#a5b4fc",
                backgroundColor: "rgba(99, 102, 241, 0.14)",
                border: "1px solid rgba(129, 140, 248, 0.4)",
              }}
            >
              📄 {WAGERS_TABLE.policy_tag}
            </span>
            <WireContractChip summary={wireContract} error={wireError} />
            {slabPolicy ? (
              <span
                title={`config/slab.toml ${slabPolicy.schema} v${slabPolicy.version}: ${slabPolicy.window_bytes} byte window; sentinels null_clv=${slabPolicy.sentinels.null_clv}, null_customer_handle32=${slabPolicy.sentinels.null_customer_handle32}, null_bridge_channel_word32=${slabPolicy.sentinels.null_bridge_channel_word32}; unsafe_allowed=${String(slabPolicy.unsafe_allowed)}`}
                style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  padding: "2px 8px",
                  borderRadius: "999px",
                  color: "#94a3b8",
                  backgroundColor: "rgba(148, 163, 184, 0.12)",
                  border: "1px solid rgba(148, 163, 184, 0.35)",
                  whiteSpace: "nowrap",
                }}
              >
                ⚙ slab {(slabPolicy.window_bytes / 1_000_000).toFixed(1)} MB
              </span>
            ) : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "11px", color: "#64748b" }}>
              {provenanceBadge.detail} · showing {visibleWagers.length}/
              {filteredWagers.length} · autoExecute: false invariant active
            </span>
            {onRefreshWagers ? (
              <button
                type="button"
                style={{
                  ...styles.actionBtn,
                  padding: "4px 8px",
                  fontSize: "11px",
                }}
                onClick={onRefreshWagers}
              >
                ↻ Refresh
              </button>
            ) : null}
          </div>
        </div>

        <div style={styles.tableScroll}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th
                  style={{
                    ...styles.th,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => onWagerSort("timestamp")}
                  title="Sort by Timestamp"
                >
                  Ticket / Time{" "}
                  {wagerSortField === "timestamp"
                    ? wagerSortDir === "asc"
                      ? "▲"
                      : "▼"
                    : ""}
                </th>
                <th style={styles.th}>Customer</th>
                <th style={styles.th}>Sub-Agent / Master</th>
                <th style={styles.th}>Sport / Type</th>
                <th style={styles.th}>Event & Market Selection</th>
                <th
                  style={{
                    ...styles.th,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => onWagerSort("riskUsd")}
                  title="Sort by Risk Amount"
                >
                  Risk / To Win{" "}
                  {wagerSortField === "riskUsd"
                    ? wagerSortDir === "asc"
                      ? "▲"
                      : "▼"
                    : ""}
                </th>
                <th
                  style={{
                    ...styles.th,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => onWagerSort("clvCents")}
                  title="Sort by CLV Edge"
                >
                  CLV Edge{" "}
                  {wagerSortField === "clvCents"
                    ? wagerSortDir === "asc"
                      ? "▲"
                      : "▼"
                    : ""}
                </th>
                <th
                  style={{
                    ...styles.th,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => onWagerSort("alertTier")}
                  title="Sort by Alert Severity"
                >
                  Alert Classification{" "}
                  {wagerSortField === "alertTier"
                    ? wagerSortDir === "asc"
                      ? "▲"
                      : "▼"
                    : ""}
                </th>
                <th style={styles.th}>Action Directive</th>
                <th style={styles.th}>Operator Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleWagers.map((w) => (
                <tr
                  key={w.ticketId}
                  style={styles.wagerRow(
                    selectedWager?.ticketId === w.ticketId,
                  )}
                  onClick={() => onSelectWager(w)}
                >
                  <td style={styles.td}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                      }}
                    >
                      <span
                        style={{
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          fontWeight: 700,
                          color: "#38bdf8",
                        }}
                      >
                        #{w.ticketId}
                      </span>
                      <button
                        type="button"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          fontSize: "11px",
                          color: "#94a3b8",
                          padding: "0 2px",
                        }}
                        title="Copy Ticket ID"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCopyText(w.ticketId, w.ticketId);
                        }}
                      >
                        {copiedTicketId === w.ticketId ? "✓" : "📋"}
                      </button>
                    </div>
                    <div style={styles.custSub}>{w.timestamp}</div>
                  </td>
                  <td style={styles.td}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                      }}
                    >
                      <span
                        style={{
                          ...styles.custLink,
                          cursor: "pointer",
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectCustomerById(w.customerId);
                        }}
                        title="Inspect full profile in Customer Showcase"
                      >
                        {w.customerId}
                      </span>
                      <a
                        href={`https://fantasy402.com/manager.html?customer=${w.customerId}`}
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
                    </div>
                  </td>
                  <td style={styles.td}>
                    <div>
                      <a
                        href={getLocalAgentHref(w.agentId)}
                        style={{
                          color: "#38bdf8",
                          textDecoration: "none",
                          fontWeight: 600,
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
                            onSelectAgent(w.agentId);
                          }
                        }}
                        title="Open SportsDesk Agent Inspector"
                      >
                        {w.agentId} ↗
                      </a>
                    </div>
                    <div style={styles.custSub}>Master: {w.masterAgent}</div>
                  </td>
                  <td style={styles.td}>
                    <div style={{ fontWeight: 600 }}>{w.sport}</div>
                    <div style={styles.custSub}>
                      {w.betType}
                      {w.ticketWriter ? ` · ${w.ticketWriter}` : ""}
                    </div>
                  </td>
                  <td style={styles.td}>
                    <div style={{ fontWeight: 600 }}>{w.event}</div>
                    <div style={{ color: "#f59e0b", fontWeight: 700 }}>
                      {w.selection} {w.lineDisplay} ({w.oddsAmerican})
                    </div>
                  </td>
                  <td style={styles.td}>
                    <div style={{ fontWeight: 600 }}>
                      ${w.riskUsd.toLocaleString()}
                      {w.riskUsd >= HIGH_RISK_WAGER_USD ? (
                        <span
                          title={`Stake at/above the $${HIGH_RISK_WAGER_USD.toLocaleString()} emphasis floor from dashboard.toml`}
                          style={{
                            marginLeft: "6px",
                            padding: "1px 6px",
                            borderRadius: "999px",
                            fontSize: "9px",
                            fontWeight: 800,
                            letterSpacing: "0.04em",
                            color: "#fca5a5",
                            backgroundColor: "rgba(239, 68, 68, 0.16)",
                            border: "1px solid rgba(248, 113, 113, 0.45)",
                            verticalAlign: "middle",
                            whiteSpace: "nowrap",
                            display: "inline-block",
                          }}
                        >
                          HIGH RISK
                        </span>
                      ) : null}
                    </div>
                    <div style={styles.custSub}>
                      To Win: ${w.toWinUsd.toLocaleString()}
                    </div>
                  </td>
                  <td style={styles.td}>
                    <span
                      style={{
                        fontWeight: 700,
                        color: clvEdgeTone(w.clvCents),
                      }}
                    >
                      {w.clvCents === null
                        ? "—"
                        : w.clvCents > 0
                          ? `+${w.clvCents}¢`
                          : `${w.clvCents}¢`}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span style={styles.wagerBadge(w.alertTier, tiersConfig)}>
                      {w.alertBadge}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <div
                      style={{
                        fontSize: "11px",
                        color:
                          w.alertTier === "CRITICAL" || w.alertTier === "STEAM"
                            ? "#f87171"
                            : "#4ade80",
                        fontWeight: 600,
                      }}
                    >
                      {w.operatorDirective}
                    </div>
                    <div style={styles.custSub}>
                      Cap: ${w.maxRecommendedStake.toLocaleString()}
                    </div>
                  </td>
                  <td style={styles.td}>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button
                        type="button"
                        style={{
                          ...styles.actionBtn,
                          padding: "4px 8px",
                          fontSize: "11px",
                          cursor: "pointer",
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onInspectPty(w.customerId);
                        }}
                        title="Inspect Customer in PTY Terminal"
                      >
                        💻 PTY
                      </button>
                      <a
                        href={`https://fantasy402.com/manager.html?customer=${w.customerId}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          ...styles.actionBtn,
                          padding: "4px 8px",
                          fontSize: "11px",
                          textDecoration: "none",
                          color: "#0f172a",
                        }}
                        onClick={(e) => e.stopPropagation()}
                        title="Open Customer in Portal"
                      >
                        Portal ↗
                      </a>
                    </div>
                  </td>
                </tr>
              ))}
              {visibleWagers.length === 0 ? (
                <tr>
                  <td
                    colSpan={11}
                    data-wagers-empty={activeProvenance.kind}
                    style={{
                      ...styles.td,
                      textAlign: "center",
                      color: "#94a3b8",
                    }}
                  >
                    {describeEmptyWagers(activeWagers.length, activeProvenance)}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {/* Interactive Selected Wager Inspector */}
      {selectedWager && (
        <div style={styles.wagerInspectorCard}>
          <div style={styles.inspectorHeader}>
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  marginBottom: "4px",
                }}
              >
                <h3
                  style={{
                    margin: 0,
                    fontSize: "18px",
                    color: "#f8fafc",
                  }}
                >
                  Ticket Inspector: #{selectedWager.ticketId}
                </h3>
                <span
                  style={styles.wagerBadge(
                    selectedWager.alertTier,
                    tiersConfig,
                  )}
                >
                  {selectedWager.alertBadge}
                </span>
              </div>
              <div style={styles.inspectorSub}>
                Placed {selectedWager.timestamp} · Sport: {selectedWager.sport}{" "}
                · Market: {selectedWager.betType} · Line:{" "}
                {selectedWager.lineDisplay} ({selectedWager.oddsAmerican})
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                style={styles.actionBtn}
                onClick={() => onInspectPty(selectedWager.customerId)}
                title="Inspect Customer in Terminal PTY"
              >
                💻 PTY Profile
              </button>
              <button
                type="button"
                style={styles.actionBtn}
                onClick={() => onSelectCustomerById(selectedWager.customerId)}
                title="Inspect in Customer Showcase"
              >
                👤 Customer Card
              </button>
              <button
                type="button"
                style={styles.actionBtn}
                onClick={() =>
                  onCopyText(
                    selectedWager.ticketId,
                    JSON.stringify(selectedWager, null, 2),
                  )
                }
                title="Copy Full Ticket Payload"
              >
                {copiedTicketId === selectedWager.ticketId
                  ? "✓ Payload Copied"
                  : "📋 Copy Payload"}
              </button>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: "12px",
              marginBottom: "16px",
            }}
          >
            <div style={styles.radarCard}>
              <div style={styles.cardHeader}>EVENT & SELECTION</div>
              <div
                style={{
                  fontSize: "13px",
                  fontWeight: 700,
                  color: "#f8fafc",
                  marginBottom: "4px",
                }}
              >
                {selectedWager.event}
              </div>
              <div
                style={{
                  fontSize: "12px",
                  color: "#f59e0b",
                  fontWeight: 600,
                }}
              >
                Pick: {selectedWager.selection} {selectedWager.lineDisplay} (
                {selectedWager.oddsAmerican})
              </div>
            </div>

            <div style={styles.radarCard}>
              <div style={styles.cardHeader}>FINANCIAL EXPOSURE & EDGE</div>
              <div style={styles.radarRow}>
                <span style={{ color: "#94a3b8" }}>Risk / To Win:</span>
                <span style={{ fontWeight: 700, color: "#f8fafc" }}>
                  ${selectedWager.riskUsd.toLocaleString()} / $
                  {selectedWager.toWinUsd.toLocaleString()}
                </span>
              </div>
              <div style={styles.radarRow}>
                <span style={{ color: "#94a3b8" }}>CLV Edge Delta:</span>
                <span
                  style={{
                    fontWeight: 700,
                    color: clvEdgeTone(selectedWager.clvCents),
                  }}
                >
                  {selectedWager.clvCents === null
                    ? "— (no closing line)"
                    : selectedWager.clvCents > 0
                      ? `+${selectedWager.clvCents}¢`
                      : `${selectedWager.clvCents}¢`}
                </span>
              </div>
            </div>

            <div style={styles.radarCard}>
              <div style={styles.cardHeader}>AGENT & SYNDICATE ROUTING</div>
              <div style={styles.radarRow}>
                <span style={{ color: "#94a3b8" }}>Customer Login:</span>
                <span style={{ fontWeight: 700, color: "#38bdf8" }}>
                  {selectedWager.customerId}
                </span>
              </div>
              <div style={styles.radarRow}>
                <span style={{ color: "#94a3b8" }}>Sub-Agent / Master:</span>
                <span style={{ fontWeight: 600, color: "#f8fafc" }}>
                  {selectedWager.agentId} / {selectedWager.masterAgent}
                </span>
              </div>
            </div>

            <div style={styles.radarCard}>
              <div style={styles.cardHeader}>PRE/POST-BET LINE WINDOW</div>
              <div style={styles.radarRow}>
                <span style={{ color: "#94a3b8" }}>Entry Line / Price:</span>
                <span style={{ fontWeight: 700, color: "#f8fafc" }}>
                  {selectedWager.lineDisplay} ({selectedWager.oddsAmerican})
                </span>
              </div>
              <div style={styles.radarRow}>
                <span style={{ color: "#94a3b8" }}>Post-Bet Trajectory:</span>
                <span
                  style={{
                    fontWeight: 700,
                    color: clvEdgeTone(selectedWager.clvCents),
                  }}
                >
                  {selectedWager.clvCents === null
                    ? "No closing-line comparison"
                    : selectedWager.clvCents > 0
                      ? `Beat Move (+${selectedWager.clvCents}¢ CLV)`
                      : `Behind Move (${selectedWager.clvCents}¢ CLV)`}
                </span>
              </div>
            </div>

            <div style={styles.radarCard}>
              <div style={styles.cardHeader}>
                DESK DIRECTIVE (autoExecute: false)
              </div>
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: 700,
                  color:
                    selectedWager.alertTier === "CRITICAL" ||
                    selectedWager.alertTier === "STEAM"
                      ? "#f87171"
                      : "#4ade80",
                  marginBottom: "4px",
                }}
              >
                {selectedWager.operatorDirective}
              </div>
              <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                Max Recommended Stake: $
                {selectedWager.maxRecommendedStake.toLocaleString()}
              </div>
            </div>
          </div>

          <div
            style={{
              padding: "10px 14px",
              borderRadius: "6px",
              backgroundColor:
                selectedWager.alertTier === "CRITICAL"
                  ? "rgba(239, 68, 68, 0.12)"
                  : selectedWager.alertTier === "STEAM"
                    ? "rgba(251, 146, 60, 0.12)"
                    : "rgba(34, 197, 94, 0.12)",
              border: `1px solid ${
                selectedWager.alertTier === "CRITICAL"
                  ? "rgba(239, 68, 68, 0.3)"
                  : selectedWager.alertTier === "STEAM"
                    ? "rgba(251, 146, 60, 0.3)"
                    : "rgba(34, 197, 94, 0.3)"
              }`,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ fontSize: "12px", color: "#f1f5f9" }}>
              <b>Action Directive:</b> {selectedWager.operatorDirective} ·
              Safety Invariant: <code>autoExecute: false</code> (Requires
              operator manual override in Fantasy402 Manager)
            </div>
            <span
              style={{
                fontSize: "11px",
                color: "#94a3b8",
                fontWeight: 600,
              }}
            >
              Cap: ${selectedWager.maxRecommendedStake.toLocaleString()}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
