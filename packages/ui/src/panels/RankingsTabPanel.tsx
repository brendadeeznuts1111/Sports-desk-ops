import type React from "react";
import { styles } from "../dashboard_styles.ts";
import { PROXY_CONDUITS_30D, RANKED_30D_PLAYERS } from "../showcase_data.ts";
import type { RankingsFilter } from "../types.ts";

export interface RankingsTabPanelProps {
  readonly rankingsSearch: string;
  readonly onRankingsSearchChange: (value: string) => void;
  readonly rankingsFilter: RankingsFilter;
  readonly onRankingsFilterChange: (filter: RankingsFilter) => void;
  readonly onInspectPty: (customerId: string) => void;
}

const RANKINGS_FILTERS: readonly {
  readonly id: RankingsFilter;
  readonly label: string;
}[] = [
  { id: "ALL", label: "All Top Sharps" },
  { id: "CONDUITS", label: "🚨 Proxy Conduits (21)" },
  { id: "TIER3", label: "🎯 Tier 3 Sharps" },
  { id: "WHALES", label: "🐋 Whales (>$1M)" },
];

export function RankingsTabPanel({
  rankingsSearch,
  onRankingsSearchChange,
  rankingsFilter,
  onRankingsFilterChange,
  onInspectPty,
}: RankingsTabPanelProps): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* 30-Day Sharps & Agency Downlines View */}
      <div style={styles.kpiGrid}>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>30-Day Total Handle</div>
          <div style={styles.kpiVal}>$268.9M</div>
          <div style={styles.kpiSub}>
            627,710 Wagers Placed (Oct 10 – Nov 09)
          </div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Active Player Downline</div>
          <div style={styles.kpiVal}>9,134 Accounts</div>
          <div style={styles.kpiSub}>672 Sub-Agents · 107 Master Forests</div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Proxy Conduits Detected</div>
          <div style={{ ...styles.kpiVal, color: "#f87171" }}>21 Agencies</div>
          <div style={styles.kpiSub}>Single-Customer Concentration ≥ 80%</div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Desk Exposure (ToWin)</div>
          <div style={styles.kpiVal}>$424.7M</div>
          <div style={styles.kpiSub}>
            Median: $51.00 · P99: $6,750 · Max: $240k
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
            placeholder="Filter by Customer (e.g. 'B121', 'RF2003'), Sub-Agent ('FAKEMONEY'), or Master..."
          />
        </div>

        <div style={styles.tierFilterGroup}>
          {RANKINGS_FILTERS.map((pill) => (
            <button
              key={pill.id}
              type="button"
              style={styles.filterPill(rankingsFilter === pill.id)}
              onClick={() => onRankingsFilterChange(pill.id)}
            >
              {pill.label}
            </button>
          ))}
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
              {RANKED_30D_PLAYERS.filter((p) => {
                const q = rankingsSearch.toLowerCase();
                const matchesSearch =
                  !q ||
                  p.id.toLowerCase().includes(q) ||
                  p.agentId.toLowerCase().includes(q) ||
                  p.masterAgent.toLowerCase().includes(q);
                if (!matchesSearch) return false;
                if (rankingsFilter === "CONDUITS") return p.isProxy;
                if (rankingsFilter === "TIER3") return p.tier === "TIER_3";
                if (rankingsFilter === "WHALES") return p.handleUsd >= 1000000;
                return true;
              }).map((p) => (
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
                        href={`https://fantasy402.com/manager.html?customer=${p.id}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          ...styles.custLogin,
                          textDecoration: "none",
                        }}
                        title="Fantasy402 Customer Portal"
                      >
                        {p.id} ↗
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
                        href={`https://desk.bookdeskops.com/agent/${p.agentId}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          color: "#38bdf8",
                          textDecoration: "none",
                        }}
                        title="Agent Desk Profile"
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
                      Avg: ${(p.handleUsd / p.wagers).toFixed(0)}
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
                    <span style={styles.tierBadge(p.tier)}>{p.tierLabel}</span>
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
              {PROXY_CONDUITS_30D.map((c) => (
                <tr key={c.agentId}>
                  <td style={styles.td}>
                    <span style={{ fontWeight: 700, color: "#f59e0b" }}>
                      <a
                        href={`https://desk.bookdeskops.com/agent/${c.agentId}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          color: "#f59e0b",
                          textDecoration: "none",
                        }}
                        title="Agent Desk Profile"
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
                        href={`https://fantasy402.com/manager.html?customer=${c.topCust}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          color: "#38bdf8",
                          textDecoration: "none",
                        }}
                        title="Fantasy402 Customer Portal"
                      >
                        {c.topCust} ↗
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
