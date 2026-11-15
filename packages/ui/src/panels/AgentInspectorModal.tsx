import type React from "react";
import { useEffect, useState } from "react";
import { styles } from "../dashboard_styles.ts";
import { getLocalAgentHref } from "../links.ts";
import type { AgentDetailApiResponse } from "../types.ts";

export interface AgentInspectorModalProps {
  readonly agentId: string;
  readonly onClose: () => void;
  readonly onSelectAgent: (agentId: string) => void;
  readonly onSelectCustomerById: (customerId: string) => void;
  readonly onInspectPty: (targetId: string) => void;
}

export function AgentInspectorModal({
  agentId,
  onClose,
  onSelectAgent,
  onSelectCustomerById,
  onInspectPty,
}: AgentInspectorModalProps): React.ReactElement {
  const [detail, setDetail] = useState<AgentDetailApiResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetch(`/api/agent/${encodeURIComponent(agentId)}`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return (await res.json()) as AgentDetailApiResponse;
      })
      .then((json) => {
        if (active) setDetail(json);
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [agentId]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        backgroundColor: "rgba(2, 6, 23, 0.78)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(860px, 100%)",
          maxHeight: "88vh",
          overflowY: "auto",
          backgroundColor: "#0f172a",
          border: "1px solid #38bdf8",
          borderRadius: "10px",
          padding: "20px",
          color: "#f1f5f9",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            borderBottom: "1px solid #334155",
            paddingBottom: "12px",
          }}
        >
          <div>
            <div
              style={{ fontSize: "18px", fontWeight: 700, color: "#38bdf8" }}
            >
              🏢 Sub-Agent Inspector: {agentId.toUpperCase()}
            </div>
            <div
              style={{ fontSize: "12px", color: "#94a3b8", marginTop: "2px" }}
            >
              Master Trunk: <b>{detail?.masterAgent ?? "—"}</b> · Level:{" "}
              <b>{detail?.level ?? "—"}</b> · Type:{" "}
              <b>{detail?.agentType ?? "—"}</b> · autoExecute: false
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <a
              href={getLocalAgentHref(agentId)}
              target="_blank"
              rel="noreferrer"
              style={{
                ...styles.actionBtn,
                padding: "5px 10px",
                fontSize: "12px",
                textDecoration: "none",
                color: "#38bdf8",
              }}
            >
              Open Standalone /agent/{agentId.toUpperCase()} ↗
            </a>
            <button
              type="button"
              style={styles.actionBtn}
              onClick={() => {
                onClose();
                onInspectPty(agentId.toUpperCase());
              }}
            >
              💻 Inspect in PTY
            </button>
            <button
              type="button"
              style={{
                ...styles.actionBtn,
                borderColor: "#64748b",
              }}
              onClick={onClose}
            >
              ✕ Close
            </button>
          </div>
        </div>

        {loading ? (
          <div style={{ color: "#94a3b8", fontSize: "13px" }}>
            Loading sub-agent hierarchy & recent activity...
          </div>
        ) : error ? (
          <div style={{ color: "#fca5a5", fontSize: "13px" }}>
            ⚠️ Failed to load agent detail: {error}
          </div>
        ) : (
          <>
            {detail?.conduit30d && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: "10px",
                  padding: "12px",
                  borderRadius: "8px",
                  backgroundColor: "rgba(30, 41, 59, 0.85)",
                  border: detail.conduit30d.isProxyConduit
                    ? "1px solid #f59e0b"
                    : "1px solid #334155",
                }}
              >
                <div>
                  <div style={styles.kpiLabel}>30d Handle</div>
                  <div style={{ fontWeight: 700, fontSize: "16px" }}>
                    ${detail.conduit30d.handleUsd.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div style={styles.kpiLabel}>30d Wagers</div>
                  <div style={{ fontWeight: 700, fontSize: "16px" }}>
                    {detail.conduit30d.wagers.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div style={styles.kpiLabel}>Top Customer Conc</div>
                  <div
                    style={{
                      fontWeight: 700,
                      fontSize: "16px",
                      color: detail.conduit30d.isProxyConduit
                        ? "#fbbf24"
                        : "#4ade80",
                    }}
                  >
                    {detail.conduit30d.concentrationPct.toFixed(1)}% (
                    {detail.conduit30d.topCustomer ?? "—"})
                  </div>
                </div>
              </div>
            )}

            {detail && detail.childAgents.length > 0 && (
              <div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "#94a3b8",
                    marginBottom: "6px",
                  }}
                >
                  Direct Downline Sub-Agents ({detail.childAgents.length}):
                </div>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {detail.childAgents.slice(0, 24).map((child) => (
                    <button
                      key={child}
                      type="button"
                      style={{
                        ...styles.actionBtn,
                        padding: "3px 8px",
                        fontSize: "11px",
                      }}
                      onClick={() => onSelectAgent(child)}
                    >
                      {child}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h4
                style={{
                  margin: "0 0 8px 0",
                  fontSize: "13px",
                  color: "#cbd5e1",
                }}
              >
                Profiled Customers ({detail?.customers.length ?? 0})
              </h4>
              {detail && detail.customers.length > 0 ? (
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Customer</th>
                      <th style={styles.th}>Tier</th>
                      <th style={styles.th}>Sharpness</th>
                      <th style={styles.th}>Rec Limit</th>
                      <th style={styles.th}>Hold %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.customers.map((c) => (
                      <tr key={c.id}>
                        <td style={styles.td}>
                          <button
                            type="button"
                            onClick={() => {
                              onClose();
                              onSelectCustomerById(c.id);
                            }}
                            style={{
                              background: "none",
                              border: "none",
                              color: "#38bdf8",
                              fontWeight: 700,
                              cursor: "pointer",
                              padding: 0,
                            }}
                          >
                            {c.id}
                          </button>
                        </td>
                        <td style={styles.td}>{c.tier}</td>
                        <td style={styles.td}>{c.score.toFixed(1)}/10</td>
                        <td style={styles.td}>
                          ${c.recommendedLimitUsd.toLocaleString()}
                        </td>
                        <td style={styles.td}>{c.holdPct.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ fontSize: "12px", color: "#64748b" }}>
                  No sharp watchlist customer rows linked directly to{" "}
                  {agentId.toUpperCase()}.
                </div>
              )}
            </div>

            <div>
              <h4
                style={{
                  margin: "0 0 8px 0",
                  fontSize: "13px",
                  color: "#cbd5e1",
                }}
              >
                Recent Bet-Ticker Wagers ({detail?.recentWagers.length ?? 0})
              </h4>
              {detail && detail.recentWagers.length > 0 ? (
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Ticket</th>
                      <th style={styles.th}>Customer</th>
                      <th style={styles.th}>Channel</th>
                      <th style={styles.th}>Selection</th>
                      <th style={styles.th}>Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.recentWagers.slice(0, 15).map((w) => (
                      <tr key={w.ticketId}>
                        <td style={styles.td}>#{w.ticketId}</td>
                        <td style={styles.td}>{w.customerId}</td>
                        <td style={styles.td}>{w.writer}</td>
                        <td style={styles.td}>
                          {w.sport} · {w.selection}
                        </td>
                        <td style={styles.td}>${w.riskUsd.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ fontSize: "12px", color: "#64748b" }}>
                  No recent wagers for {agentId.toUpperCase()} in the current
                  Bet-Ticker window.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
