import type React from "react";
import { styles } from "../dashboard_styles.ts";
import { SAMPLE_LIVE_WAGERS } from "../showcase_data.ts";
import type { LiveWager, TierStyleConfig, WagerSortField } from "../types.ts";

export interface LiveWagersTabPanelProps {
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
  readonly onSelectCustomerById: (customerId: string) => void;
  readonly onInspectPty: (customerId: string) => void;
}

const SPORT_PILLS = [
  { id: "ALL", label: "All Sports" },
  { id: "NFL", label: "🏈 NFL" },
  { id: "CFB", label: "🎓 CFB" },
  { id: "NBA", label: "🏀 NBA" },
  { id: "SOCCER", label: "⚽ Soccer" },
];

const ALERT_PILLS = [
  { id: "ALL", label: "All Alerts" },
  { id: "CRITICAL", label: "🚨 Critical" },
  { id: "STEAM", label: "⚡ Steam" },
  { id: "LATENCY", label: "⚠️ Latency" },
  { id: "RECREATIONAL", label: "✅ Recreational" },
];

const BET_TYPE_PILLS = [
  { id: "ALL", label: "All Bet Types" },
  { id: "Spread", label: "Spread" },
  { id: "Total", label: "Total" },
  { id: "Moneyline", label: "Moneyline" },
  { id: "Parlay", label: "Parlay" },
];

const TIER_ORDER: Record<string, number> = {
  CRITICAL: 4,
  STEAM: 3,
  LATENCY: 2,
  RECREATIONAL: 1,
};

export function LiveWagersTabPanel({
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
  onSelectCustomerById,
  onInspectPty,
}: LiveWagersTabPanelProps): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Live Wagers KPI Grid */}
      <div style={styles.kpiGrid}>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Live Streaming Feed</div>
          <div style={styles.kpiVal}>{SAMPLE_LIVE_WAGERS.length} Wagers</div>
          <div style={styles.kpiSub}>Real-Time Ingestion (Sub-second)</div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Flagged Steam / Originator</div>
          <div style={{ ...styles.kpiVal, color: "#f87171" }}>
            {
              SAMPLE_LIVE_WAGERS.filter(
                (w) => w.alertTier === "CRITICAL" || w.alertTier === "STEAM",
              ).length
            }{" "}
            Alerts
          </div>
          <div style={styles.kpiSub}>Key Numbers 3 & 7 / Syndicate Hooks</div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Live Exposure at Risk</div>
          <div style={styles.kpiVal}>
            $
            {SAMPLE_LIVE_WAGERS.reduce(
              (acc, w) => acc + w.riskUsd,
              0,
            ).toLocaleString()}
          </div>
          <div style={styles.kpiSub}>
            To Win: $
            {SAMPLE_LIVE_WAGERS.reduce(
              (acc, w) => acc + w.toWinUsd,
              0,
            ).toLocaleString()}
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
            placeholder="Filter by Ticket (#W-...), Customer ('GP301'), Agent, Event, Selection..."
          />
        </div>

        <div style={styles.tierFilterGroup}>
          {SPORT_PILLS.map((pill) => (
            <button
              key={pill.id}
              type="button"
              style={styles.filterPill(wagerSportFilter === pill.id)}
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
          {BET_TYPE_PILLS.map((pill) => (
            <button
              key={pill.id}
              type="button"
              style={styles.filterPill(wagerTypeFilter === pill.id)}
              onClick={() => onWagerTypeFilterChange(pill.id)}
            >
              {pill.label}
            </button>
          ))}
        </div>
      </div>

      {/* Live Wagers Table Card */}
      <div style={styles.tableCard}>
        <div style={styles.tableHeader}>
          <h3 style={styles.tableTitle}>
            ⚡ Live Incoming Wagers & Real-Time Action Directives
          </h3>
          <span style={{ fontSize: "11px", color: "#64748b" }}>
            Real-time wager feed · autoExecute: false invariant active
          </span>
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
              {SAMPLE_LIVE_WAGERS.filter((w) => {
                const q = wagerSearch.toLowerCase();
                const matchesSearch =
                  !q ||
                  w.ticketId.toLowerCase().includes(q) ||
                  w.customerId.toLowerCase().includes(q) ||
                  w.agentId.toLowerCase().includes(q) ||
                  w.event.toLowerCase().includes(q) ||
                  w.selection.toLowerCase().includes(q);
                if (!matchesSearch) return false;
                if (wagerSportFilter !== "ALL" && w.sport !== wagerSportFilter)
                  return false;
                if (
                  wagerAlertFilter !== "ALL" &&
                  w.alertTier !== wagerAlertFilter
                )
                  return false;
                if (wagerTypeFilter !== "ALL" && w.betType !== wagerTypeFilter)
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
                    cmp = a.clvCents - b.clvCents;
                  } else if (wagerSortField === "alertTier") {
                    cmp =
                      (TIER_ORDER[a.alertTier] ?? 0) -
                      (TIER_ORDER[b.alertTier] ?? 0);
                  }
                  return wagerSortDir === "asc" ? cmp : -cmp;
                })
                .map((w) => (
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
                          href={`https://desk.bookdeskops.com/agent/${w.agentId}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            color: "#38bdf8",
                            textDecoration: "none",
                            fontWeight: 600,
                          }}
                          onClick={(e) => e.stopPropagation()}
                          title="Open Agent Desk Profile"
                        >
                          {w.agentId} ↗
                        </a>
                      </div>
                      <div style={styles.custSub}>Master: {w.masterAgent}</div>
                    </td>
                    <td style={styles.td}>
                      <div style={{ fontWeight: 600 }}>{w.sport}</div>
                      <div style={styles.custSub}>{w.betType}</div>
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
                      </div>
                      <div style={styles.custSub}>
                        To Win: ${w.toWinUsd.toLocaleString()}
                      </div>
                    </td>
                    <td style={styles.td}>
                      <span
                        style={{
                          fontWeight: 700,
                          color:
                            w.clvCents > 0
                              ? w.clvCents >= 10
                                ? "#ef4444"
                                : "#f59e0b"
                              : "#4ade80",
                        }}
                      >
                        {w.clvCents > 0 ? `+${w.clvCents}¢` : `${w.clvCents}¢`}
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
                            w.alertTier === "CRITICAL" ||
                            w.alertTier === "STEAM"
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
                    color:
                      selectedWager.clvCents > 0
                        ? selectedWager.clvCents >= 10
                          ? "#ef4444"
                          : "#f59e0b"
                        : "#4ade80",
                  }}
                >
                  {selectedWager.clvCents > 0
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
