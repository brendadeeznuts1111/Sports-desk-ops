import type React from "react";
import { styles } from "../dashboard_styles.ts";
import {
  type NormalizedRankingsResult,
  RANKINGS_ENDPOINT,
} from "../hydration.ts";
import { getLocalAgentHref, getLocalCustomerHref } from "../links.ts";
import type { RankingsFilter } from "../types.ts";

export type RankingsSourceStatus = "pending" | "ready" | "unavailable";

export interface RankingsTabPanelProps {
  readonly rankingsSearch: string;
  readonly onRankingsSearchChange: (value: string) => void;
  readonly rankingsFilter: RankingsFilter;
  readonly onRankingsFilterChange: (filter: RankingsFilter) => void;
  readonly onInspectPty: (customerId: string) => void;
  readonly onSelectAgent?: ((agentId: string) => void) | undefined;
  readonly onSelectCustomerById?: ((customerId: string) => void) | undefined;
  readonly rankings?: NormalizedRankingsResult | null | undefined;
  readonly rankingsStatus?: RankingsSourceStatus | undefined;
  readonly rankingsError?: string | null | undefined;
}

function rankingsFilterPills(
  conduitCount: number | null,
): readonly { readonly id: RankingsFilter; readonly label: string }[] {
  return [
    { id: "ALL", label: "All Top Sharps" },
    {
      id: "CONDUITS",
      label: `🚨 Proxy Conduits (${conduitCount ?? "—"})`,
    },
    { id: "TIER3", label: "🎯 Tier 3 Sharps" },
    { id: "WHALES", label: "🐋 Whales (>$1M)" },
  ];
}

function formatUsdCompact(usd: number): string {
  if (Math.abs(usd) >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (Math.abs(usd) >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toLocaleString()}`;
}

function RankingsSourceNotice({
  status,
  error,
  rejectedRows,
}: {
  readonly status: RankingsSourceStatus;
  readonly error: string | null;
  readonly rejectedRows: number;
}): React.ReactElement | null {
  if (status === "ready" && rejectedRows === 0) return null;
  const unavailable = status === "unavailable";
  const message =
    status === "pending"
      ? `Waiting for GET ${RANKINGS_ENDPOINT}…`
      : unavailable
        ? `Rankings unavailable — GET ${RANKINGS_ENDPOINT}: ${error ?? "no response"}`
        : `${rejectedRows} ranking row(s) from GET ${RANKINGS_ENDPOINT} were rejected (missing or non-numeric fields) and are not shown.`;
  return (
    <div
      role={unavailable ? "alert" : "status"}
      data-rankings-source={status}
      style={{
        padding: "10px 14px",
        borderRadius: "8px",
        backgroundColor: unavailable
          ? "rgba(239, 68, 68, 0.14)"
          : "rgba(56, 189, 248, 0.12)",
        border: unavailable
          ? "1px solid rgba(239, 68, 68, 0.4)"
          : "1px solid rgba(56, 189, 248, 0.35)",
        color: unavailable ? "#fca5a5" : "#7dd3fc",
        fontSize: "12px",
      }}
    >
      {message}
    </div>
  );
}

export function RankingsTabPanel({
  rankingsSearch,
  onRankingsSearchChange,
  rankingsFilter,
  onRankingsFilterChange,
  onInspectPty,
  onSelectAgent,
  onSelectCustomerById,
  rankings = null,
  rankingsStatus = rankings ? "ready" : "pending",
  rankingsError = null,
}: RankingsTabPanelProps): React.ReactElement {
  const summary = rankings?.summary ?? null;
  const players = rankings?.players ?? [];
  const conduits = rankings?.conduits ?? [];
  const unmeasured = "—";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <RankingsSourceNotice
        status={rankingsStatus}
        error={rankingsError}
        rejectedRows={rankings?.rejectedRows ?? 0}
      />
      {/* 30-Day Sharps & Agency Downlines View */}
      <div style={styles.kpiGrid}>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>30-Day Total Handle</div>
          <div style={styles.kpiVal}>
            {summary ? formatUsdCompact(summary.totalHandleUsd) : unmeasured}
          </div>
          <div style={styles.kpiSub}>
            {summary
              ? `${summary.inWindowWagers.toLocaleString()} Wagers Placed (${summary.windowStart} – ${summary.windowEnd})`
              : `No source: GET ${RANKINGS_ENDPOINT}`}
          </div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Active Player Downline</div>
          <div style={styles.kpiVal}>
            {summary
              ? `${summary.activeCustomerCount.toLocaleString()} Accounts`
              : unmeasured}
          </div>
          <div style={styles.kpiSub}>
            {summary
              ? `${summary.activeSubAgentCount.toLocaleString()} Sub-Agents · ${summary.activeMasterAgentCount.toLocaleString()} Master Forests`
              : `No source: GET ${RANKINGS_ENDPOINT}`}
          </div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Proxy Conduits Detected</div>
          <div style={{ ...styles.kpiVal, color: "#f87171" }}>
            {summary
              ? `${summary.conduitSubAgentCount.toLocaleString()} Agencies`
              : unmeasured}
          </div>
          <div style={styles.kpiSub}>Single-Customer Concentration ≥ 80%</div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Desk Exposure (ToWin)</div>
          <div style={styles.kpiVal}>
            {summary ? formatUsdCompact(summary.totalToWinUsd) : unmeasured}
          </div>
          <div style={styles.kpiSub}>
            {summary
              ? `Generated ${summary.generatedAtIso || "(no timestamp)"}`
              : `No source: GET ${RANKINGS_ENDPOINT}`}
          </div>
        </div>
      </div>

      {/* Filter Bar & Search */}
      <div style={styles.filterBar}>
        <div style={styles.searchBox}>
          <span style={styles.searchIcon}>🔍</span>
          <input
            style={styles.searchInput}
            value={rankingsSearch}
            onChange={(e) => onRankingsSearchChange(e.target.value)}
            placeholder="Filter by Customer, Sub-Agent, or Master..."
          />
        </div>

        <div style={styles.tierFilterGroup}>
          {rankingsFilterPills(summary?.conduitSubAgentCount ?? null).map(
            (pill) => (
              <button
                key={pill.id}
                type="button"
                style={styles.filterPill(rankingsFilter === pill.id)}
                onClick={() => onRankingsFilterChange(pill.id)}
              >
                {pill.label}
              </button>
            ),
          )}
        </div>
      </div>

      {/* Main Rankings Table */}
      <div style={styles.tableCard}>
        <div style={styles.tableHeader}>
          <h3 style={styles.tableTitle}>
            🏆 30-Day Sharp Bettor Rankings & Downline Profiling
          </h3>
          <span style={{ fontSize: "11px", color: "#64748b" }}>
            Streaming batched evaluation (50k lines/chunk) · autoExecute: false
          </span>
        </div>

        <div style={styles.tableScroll}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Rank</th>
                <th style={styles.th}>Customer ID</th>
                <th style={styles.th}>Sub-Agent / Master</th>
                <th style={styles.th}>30d Volume</th>
                <th style={styles.th}>Wagers</th>
                <th style={styles.th}>Stake Gini</th>
                <th style={styles.th}>Alert Rate</th>
                <th style={styles.th}>Composite Score</th>
                <th style={styles.th}>Classification & Tier</th>
                <th style={styles.th}>Risk Directives</th>
                <th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {players.length === 0 ? (
                <tr>
                  <td
                    colSpan={11}
                    data-rankings-empty="players"
                    style={{
                      ...styles.td,
                      textAlign: "center",
                      color: "#94a3b8",
                    }}
                  >
                    {rankingsStatus === "ready"
                      ? `GET ${RANKINGS_ENDPOINT} returned no ranked players for this window.`
                      : rankingsStatus === "pending"
                        ? `Waiting for GET ${RANKINGS_ENDPOINT}…`
                        : `Unavailable — GET ${RANKINGS_ENDPOINT}: ${rankingsError ?? "no response"}`}
                  </td>
                </tr>
              ) : null}
              {players
                .filter((p) => {
                  const q = rankingsSearch.toLowerCase();
                  const matchesSearch =
                    !q ||
                    p.id.toLowerCase().includes(q) ||
                    p.agentId.toLowerCase().includes(q) ||
                    p.masterAgent.toLowerCase().includes(q);
                  if (!matchesSearch) return false;
                  if (rankingsFilter === "CONDUITS") return p.isProxy;
                  if (rankingsFilter === "TIER3") return p.tier === "TIER_3";
                  if (rankingsFilter === "WHALES")
                    return p.handleUsd >= 1000000;
                  return true;
                })
                .map((p) => (
                  <tr key={p.id}>
                    <td style={styles.td}>
                      <span style={{ fontWeight: 700, color: "#38bdf8" }}>
                        #{p.rank}
                      </span>
                    </td>
                    <td style={styles.td}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                        }}
                      >
                        <a
                          href={getLocalCustomerHref(p.id)}
                          onClick={(e) => {
                            if (
                              onSelectCustomerById &&
                              !e.metaKey &&
                              !e.ctrlKey &&
                              e.button === 0
                            ) {
                              e.preventDefault();
                              onSelectCustomerById(p.id);
                            }
                          }}
                          style={{
                            ...styles.custLogin,
                            textDecoration: "none",
                          }}
                          title="Inspect Customer in SportsDesk Profiles"
                        >
                          {p.id}
                        </a>
                        <a
                          href={`https://fantasy402.com/manager.html?customer=${p.id}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            color: "#64748b",
                            textDecoration: "none",
                            fontSize: "11px",
                          }}
                          title="Open in external Fantasy402 Manager Portal (requires active F402 session)"
                        >
                          ↗
                        </a>
                        {p.isProxy && (
                          <span
                            style={{
                              fontSize: "9px",
                              padding: "1px 5px",
                              borderRadius: "3px",
                              backgroundColor: "rgba(239, 68, 68, 0.2)",
                              border: "1px solid #ef4444",
                              color: "#ef4444",
                              fontWeight: 700,
                            }}
                          >
                            PROXY
                          </span>
                        )}
                      </div>
                      <div style={styles.custSub}>{p.dominantSport}</div>
                    </td>
                    <td style={styles.td}>
                      <div style={{ fontWeight: 600 }}>
                        <a
                          href={getLocalAgentHref(p.agentId)}
                          onClick={(e) => {
                            if (
                              onSelectAgent &&
                              !e.metaKey &&
                              !e.ctrlKey &&
                              e.button === 0
                            ) {
                              e.preventDefault();
                              onSelectAgent(p.agentId);
                            }
                          }}
                          style={{
                            color: "#38bdf8",
                            textDecoration: "none",
                          }}
                          title="Open SportsDesk Agent Inspector"
                        >
                          {p.agentId} ↗
                        </a>
                      </div>
                      <div style={styles.custSub}>Master: {p.masterAgent}</div>
                    </td>
                    <td style={styles.td}>
                      <div style={{ fontWeight: 600 }}>
                        ${p.handleUsd.toLocaleString()}
                      </div>
                      <div style={styles.custSub}>
                        Avg:{" "}
                        {p.wagers > 0
                          ? `$${(p.handleUsd / p.wagers).toFixed(0)}`
                          : "—"}
                      </div>
                    </td>
                    <td style={styles.td}>
                      <div>{p.wagers}</div>
                    </td>
                    <td style={styles.td}>
                      <span
                        style={{
                          color: p.gini <= 0.15 ? "#4ade80" : "#f59e0b",
                          fontWeight: 600,
                        }}
                      >
                        {p.gini.toFixed(3)}
                      </span>
                      <div style={styles.custSub}>
                        {p.gini <= 0.15 ? "Flat-Unit" : "Variable"}
                      </div>
                    </td>
                    <td style={styles.td}>
                      <span
                        style={{
                          color: p.alertRate >= 50 ? "#ef4444" : "#94a3b8",
                          fontWeight: 600,
                        }}
                      >
                        {p.alertRate}%
                      </span>
                    </td>
                    <td style={styles.td}>
                      <span
                        style={{
                          fontSize: "14px",
                          fontWeight: 700,
                          color: p.score >= 7.0 ? "#f59e0b" : "#38bdf8",
                        }}
                      >
                        {p.score.toFixed(2)}
                      </span>
                    </td>
                    <td style={styles.td}>
                      <span style={styles.tierBadge(p.tier)}>
                        {p.tierLabel}
                      </span>
                    </td>
                    <td style={styles.td}>
                      <div style={{ fontSize: "11px", color: "#f87171" }}>
                        Limit: ${p.limitUsd.toLocaleString()}
                      </div>
                      <div style={styles.custSub}>Live Delay: 2-3s</div>
                    </td>
                    <td style={styles.td}>
                      <button
                        type="button"
                        style={{
                          ...styles.actionBtn,
                          padding: "4px 8px",
                          fontSize: "11px",
                          cursor: "pointer",
                        }}
                        onClick={() => onInspectPty(p.id)}
                      >
                        Inspect PTY
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sub-Agent Proxy Conduits Section */}
      <div style={styles.tableCard}>
        <div style={styles.tableHeader}>
          <h3 style={{ ...styles.tableTitle, color: "#f87171" }}>
            🚨 Identified Agency Proxy Conduits (Top Customer Concentration ≥
            80%)
          </h3>
          <span style={{ fontSize: "11px", color: "#64748b" }}>
            Bypassing individual bettor limits via dedicated sub-agent conduits
          </span>
        </div>

        <div style={styles.tableScroll}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Sub-Agent ID</th>
                <th style={styles.th}>Master Forest</th>
                <th style={styles.th}>30d Handle (USD)</th>
                <th style={styles.th}>Tickets</th>
                <th style={styles.th}>Top Customer</th>
                <th style={styles.th}>Concentration (%)</th>
                <th style={styles.th}>Risk Assessment & Countermeasure</th>
              </tr>
            </thead>
            <tbody>
              {conduits.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    data-rankings-empty="conduits"
                    style={{
                      ...styles.td,
                      textAlign: "center",
                      color: "#94a3b8",
                    }}
                  >
                    {rankingsStatus === "ready"
                      ? `GET ${RANKINGS_ENDPOINT} flagged no proxy conduits for this window.`
                      : rankingsStatus === "pending"
                        ? `Waiting for GET ${RANKINGS_ENDPOINT}…`
                        : `Unavailable — GET ${RANKINGS_ENDPOINT}: ${rankingsError ?? "no response"}`}
                  </td>
                </tr>
              ) : null}
              {conduits.map((c) => (
                <tr key={c.agentId}>
                  <td style={styles.td}>
                    <span style={{ fontWeight: 700, color: "#f59e0b" }}>
                      <a
                        href={getLocalAgentHref(c.agentId)}
                        onClick={(e) => {
                          if (
                            onSelectAgent &&
                            !e.metaKey &&
                            !e.ctrlKey &&
                            e.button === 0
                          ) {
                            e.preventDefault();
                            onSelectAgent(c.agentId);
                          }
                        }}
                        style={{
                          color: "#f59e0b",
                          textDecoration: "none",
                        }}
                        title="Open SportsDesk Agent Inspector"
                      >
                        {c.agentId} ↗
                      </a>
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span>{c.masterAgent}</span>
                  </td>
                  <td style={styles.td}>
                    <span style={{ fontWeight: 600 }}>
                      ${c.handleUsd.toLocaleString()}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span>{c.wagers}</span>
                  </td>
                  <td style={styles.td}>
                    <span style={{ fontWeight: 700, color: "#38bdf8" }}>
                      <a
                        href={getLocalCustomerHref(c.topCust)}
                        onClick={(e) => {
                          if (
                            onSelectCustomerById &&
                            !e.metaKey &&
                            !e.ctrlKey &&
                            e.button === 0
                          ) {
                            e.preventDefault();
                            onSelectCustomerById(c.topCust);
                          }
                        }}
                        style={{
                          color: "#38bdf8",
                          textDecoration: "none",
                        }}
                        title="Inspect Customer in SportsDesk Profiles"
                      >
                        {c.topCust}
                      </a>{" "}
                      <a
                        href={`https://fantasy402.com/manager.html?customer=${c.topCust}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          color: "#64748b",
                          textDecoration: "none",
                          fontSize: "11px",
                        }}
                        title="Open in external Fantasy402 Manager Portal (requires active F402 session)"
                      >
                        ↗
                      </a>
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span
                      style={{
                        fontWeight: 700,
                        color: c.concPct >= 95 ? "#ef4444" : "#f59e0b",
                      }}
                    >
                      {c.concPct.toFixed(1)}%
                    </span>
                  </td>
                  <td style={styles.td}>
                    <div
                      style={{
                        color: "#ef4444",
                        fontWeight: 600,
                        fontSize: "12px",
                      }}
                    >
                      SINGLE BETTOR PROXY CONDUIT
                    </div>
                    <div style={styles.custSub}>
                      Cap sub-agent total exposure to prevent account rotation
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
