import type React from "react";
import { styles } from "../dashboard_styles.ts";
import type {
  AlertFilter,
  AlertToastState,
  DashboardAlertRecord,
  HealthData,
  TierStyleConfig,
} from "../types.ts";

export interface AlertsTabPanelProps {
  readonly alertToast: AlertToastState | null;
  readonly onDismissToast: () => void;
  readonly onCopyDeliveryId: (deliveryId: string) => void;
  readonly healthData: HealthData | null;
  readonly alertFilter: AlertFilter;
  readonly onFilterChange: (filter: AlertFilter) => void;
  readonly alertLoading: boolean;
  readonly onSweepAlerts: () => void;
  readonly onRefreshAlerts: () => void;
  readonly onOpenShiftModal: () => void;
  readonly alertRecords: readonly DashboardAlertRecord[];
  readonly tiersConfig: TierStyleConfig | null;
  readonly onAckAlert: (deliveryId: string, notes?: string) => void;
  readonly onRetryAlert: (deliveryId: string) => void;
}

export function AlertsTabPanel({
  alertToast,
  onDismissToast,
  onCopyDeliveryId,
  healthData,
  alertFilter,
  onFilterChange,
  alertLoading,
  onSweepAlerts,
  onRefreshAlerts,
  onOpenShiftModal,
  alertRecords,
  tiersConfig,
  onAckAlert,
  onRetryAlert,
}: AlertsTabPanelProps): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Alert Toast Notification Banner */}
      {alertToast && (
        <div
          style={{
            padding: "12px 18px",
            borderRadius: "8px",
            background:
              alertToast.type === "success"
                ? "rgba(34, 197, 94, 0.15)"
                : alertToast.type === "error"
                  ? "rgba(239, 68, 68, 0.15)"
                  : "rgba(56, 189, 248, 0.15)",
            border: `1px solid ${
              alertToast.type === "success"
                ? "#22c55e"
                : alertToast.type === "error"
                  ? "#ef4444"
                  : "#38bdf8"
            }`,
            color:
              alertToast.type === "success"
                ? "#4ade80"
                : alertToast.type === "error"
                  ? "#f87171"
                  : "#38bdf8",
            fontSize: "13px",
            fontWeight: 600,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>{alertToast.message}</span>
          <button
            type="button"
            onClick={onDismissToast}
            style={{
              background: "transparent",
              border: "none",
              color: "inherit",
              cursor: "pointer",
              fontSize: "16px",
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Alert Health & DLQ KPI Grid */}
      <div style={styles.kpiGrid}>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Surveillance Status</div>
          <div
            style={{
              ...styles.kpiVal,
              color:
                healthData?.alerts?.status === "degraded"
                  ? "#f87171"
                  : healthData?.alerts?.status === "warning"
                    ? "#fbbf24"
                    : "#4ade80",
            }}
          >
            {healthData?.alerts?.status?.toUpperCase() ?? "OK"}
          </div>
          <div style={styles.kpiSub}>
            O(1) in-memory probe · zero disk parse
          </div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Dead-Letter Queue (DLQ)</div>
          <div
            style={{
              ...styles.kpiVal,
              color:
                (healthData?.alerts?.dead ?? 0) > 0 ? "#f87171" : "#4ade80",
            }}
          >
            {healthData?.alerts?.dead ?? 0} Dead
          </div>
          <div style={styles.kpiSub}>
            Exceeded max attempts · operator ack or replay
          </div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Active Queue Backlog</div>
          <div style={styles.kpiVal}>
            {healthData?.alerts?.backlog ?? 0} Pending
          </div>
          <div style={styles.kpiSub}>Draining on 5s sweep interval</div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Telegram Dispatched</div>
          <div style={{ ...styles.kpiVal, color: "#38bdf8" }}>
            {healthData?.alerts?.delivered ?? 0} Dispatched
          </div>
          <div style={styles.kpiSub}>
            Auto-formatted HTML cards · autoExecute: false
          </div>
        </div>
      </div>

      {/* Filter and Action Bar */}
      <div style={styles.filterBar}>
        <div style={styles.tierFilterGroup}>
          {(
            [
              { id: "ALL", label: "All Alerts" },
              {
                id: "DEAD",
                label: `🚨 Dead DLQ (${healthData?.alerts?.dead ?? 0})`,
              },
              {
                id: "QUEUED",
                label: `⏳ Queued (${healthData?.alerts?.backlog ?? 0})`,
              },
              {
                id: "DELIVERED",
                label: `📬 Delivered (${healthData?.alerts?.delivered ?? 0})`,
              },
              {
                id: "ACKNOWLEDGED",
                label: `✅ Acknowledged (${healthData?.alerts?.acknowledged ?? 0})`,
              },
            ] as const
          ).map((pill) => (
            <button
              key={pill.id}
              type="button"
              style={styles.filterPill(alertFilter === pill.id)}
              onClick={() => onFilterChange(pill.id)}
            >
              {pill.label}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button
            type="button"
            onClick={onSweepAlerts}
            style={{
              padding: "7px 14px",
              borderRadius: "6px",
              fontSize: "12px",
              fontWeight: 600,
              background: "rgba(56, 189, 248, 0.15)",
              border: "1px solid #38bdf8",
              color: "#38bdf8",
              cursor: "pointer",
            }}
            title="Immediately sweep active queue without waiting for 5s daemon tick"
          >
            ⚡ Sweep Queue Now
          </button>
          <button
            type="button"
            onClick={onRefreshAlerts}
            disabled={alertLoading}
            style={{
              padding: "7px 14px",
              borderRadius: "6px",
              fontSize: "12px",
              fontWeight: 600,
              background: "#1e293b",
              border: "1px solid #334155",
              color: "#f1f5f9",
              cursor: alertLoading ? "wait" : "pointer",
            }}
          >
            {alertLoading ? "Loading..." : "🔄 Refresh"}
          </button>
          <button
            type="button"
            onClick={onOpenShiftModal}
            style={{
              padding: "7px 14px",
              borderRadius: "6px",
              fontSize: "12px",
              fontWeight: 600,
              background: "rgba(168, 85, 247, 0.15)",
              border: "1px solid #a855f7",
              color: "#c084fc",
              cursor: "pointer",
            }}
          >
            📋 Shift Handoff
          </button>
        </div>
      </div>

      {/* Alerts Table Card */}
      <div style={styles.tableCard}>
        <div style={styles.tableHeader}>
          <h3 style={styles.tableTitle}>
            🚨 Surveillance Alert Audit Stream & Dead-Letter Management
          </h3>
          <span style={{ fontSize: "11px", color: "#64748b" }}>
            Durable JSONL audit log · Replay lineage tracked via retriedFrom ·
            Total: {alertRecords.length}
          </span>
        </div>

        <div style={styles.tableScroll}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Timestamp</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Delivery ID</th>
                <th style={styles.th}>Ticket / Wager</th>
                <th style={styles.th}>Customer</th>
                <th style={styles.th}>Tier</th>
                <th style={styles.th}>Amount / CLV</th>
                <th style={styles.th}>Attempts</th>
                <th style={styles.th}>Directive / Final Error</th>
                <th style={styles.th}>Operator Actions</th>
              </tr>
            </thead>
            <tbody>
              {alertRecords.length === 0 ? (
                <tr>
                  <td
                    colSpan={10}
                    style={{
                      padding: "36px",
                      textAlign: "center",
                      color: "#64748b",
                      fontSize: "13px",
                    }}
                  >
                    No alerts matching filter "{alertFilter}".
                  </td>
                </tr>
              ) : (
                alertRecords.map((alert) => {
                  const isDead = alert.status === "dead";
                  const isAcked = alert.status === "acknowledged";
                  const isQueued = alert.status === "queued";
                  const isDelivered = alert.status === "delivered";

                  return (
                    <tr
                      key={alert.deliveryId}
                      style={{
                        borderBottom: "1px solid #1e293b",
                        background: isDead
                          ? "rgba(239, 68, 68, 0.06)"
                          : "transparent",
                      }}
                    >
                      <td style={styles.td}>
                        <div style={{ fontSize: "12px", color: "#f1f5f9" }}>
                          {new Date(alert.createdAt).toLocaleTimeString()}
                        </div>
                        <div style={{ fontSize: "10px", color: "#64748b" }}>
                          {
                            new Date(alert.createdAt)
                              .toISOString()
                              .split("T")[0]
                          }
                        </div>
                      </td>
                      <td style={styles.td}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: "4px",
                            fontSize: "10px",
                            fontWeight: 700,
                            background: isDead
                              ? "rgba(239, 68, 68, 0.2)"
                              : isQueued
                                ? "rgba(245, 158, 11, 0.2)"
                                : isDelivered
                                  ? "rgba(34, 197, 94, 0.2)"
                                  : "rgba(168, 85, 247, 0.2)",
                            color: isDead
                              ? "#f87171"
                              : isQueued
                                ? "#fbbf24"
                                : isDelivered
                                  ? "#4ade80"
                                  : "#c084fc",
                            border: `1px solid ${
                              isDead
                                ? "#ef4444"
                                : isQueued
                                  ? "#f59e0b"
                                  : isDelivered
                                    ? "#22c55e"
                                    : "#a855f7"
                            }`,
                          }}
                        >
                          {alert.status.toUpperCase()}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <span
                          style={{
                            fontFamily:
                              "ui-monospace, SFMono-Regular, Menlo, monospace",
                            fontSize: "11px",
                            color: "#94a3b8",
                            cursor: "pointer",
                          }}
                          title={`Click to copy: ${alert.deliveryId}`}
                          onClick={() => onCopyDeliveryId(alert.deliveryId)}
                        >
                          {alert.deliveryId.slice(0, 8)}...
                        </span>
                        {alert.retriedFrom && (
                          <div
                            style={{
                              fontSize: "9px",
                              color: "#64748b",
                            }}
                            title={`Retried from prior delivery: ${alert.retriedFrom}`}
                          >
                            ↳ retried from {alert.retriedFrom.slice(0, 6)}
                          </div>
                        )}
                      </td>
                      <td style={styles.td}>
                        <span
                          style={{
                            fontFamily:
                              "ui-monospace, SFMono-Regular, Menlo, monospace",
                            fontWeight: 600,
                            color: "#38bdf8",
                          }}
                        >
                          {alert.wagerId || "—"}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <span style={{ fontWeight: 600, color: "#f1f5f9" }}>
                          {alert.payload.customerId}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <span
                          style={{
                            ...styles.wagerBadge(alert.tier, tiersConfig),
                            display: "inline-block",
                            padding: "2px 6px",
                            borderRadius: "4px",
                            fontSize: "11px",
                            fontWeight: 700,
                          }}
                        >
                          {alert.tier}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <div style={{ fontWeight: 600, color: "#f1f5f9" }}>
                          ${alert.payload.amountUsd?.toLocaleString() ?? "—"}
                        </div>
                        <div
                          style={{
                            fontSize: "10px",
                            color:
                              (alert.payload.clvCents ?? 0) >= 7
                                ? "#4ade80"
                                : "#94a3b8",
                          }}
                        >
                          CLV: {alert.payload.clvCents ?? 0}¢
                        </div>
                      </td>
                      <td style={styles.td}>
                        <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                          {alert.attempts ?? 1} / 5
                        </span>
                      </td>
                      <td style={styles.td}>
                        {isDead ? (
                          <div
                            style={{
                              fontSize: "11px",
                              color: "#f87171",
                              fontFamily:
                                "ui-monospace, SFMono-Regular, Menlo, monospace",
                            }}
                          >
                            ❌{" "}
                            {alert.finalError ??
                              "Max delivery attempts exceeded"}
                          </div>
                        ) : isAcked ? (
                          <div style={{ fontSize: "11px", color: "#c084fc" }}>
                            ✓ Acked by {alert.acknowledgedBy ?? "operator"}
                            {alert.acknowledgedNotes
                              ? ` · "${alert.acknowledgedNotes}"`
                              : ""}
                          </div>
                        ) : isDelivered ? (
                          <div style={{ fontSize: "11px", color: "#4ade80" }}>
                            📬 Delivered (Msg #{alert.messageId ?? "sent"})
                          </div>
                        ) : (
                          <div style={{ fontSize: "11px", color: "#38bdf8" }}>
                            ⏳ {alert.payload.directive ?? "Pending sweep"}
                          </div>
                        )}
                      </td>
                      <td style={styles.td}>
                        <div style={{ display: "flex", gap: "6px" }}>
                          {isDead && (
                            <>
                              <button
                                type="button"
                                onClick={() => onAckAlert(alert.deliveryId)}
                                style={{
                                  padding: "3px 8px",
                                  borderRadius: "4px",
                                  fontSize: "11px",
                                  fontWeight: 600,
                                  background: "rgba(168, 85, 247, 0.2)",
                                  border: "1px solid #a855f7",
                                  color: "#c084fc",
                                  cursor: "pointer",
                                }}
                                title="Clear dead status and acknowledge alert"
                              >
                                Ack
                              </button>
                              <button
                                type="button"
                                onClick={() => onRetryAlert(alert.deliveryId)}
                                style={{
                                  padding: "3px 8px",
                                  borderRadius: "4px",
                                  fontSize: "11px",
                                  fontWeight: 600,
                                  background: "rgba(56, 189, 248, 0.2)",
                                  border: "1px solid #38bdf8",
                                  color: "#38bdf8",
                                  cursor: "pointer",
                                }}
                                title="Replay from DLQ with linkage and trigger immediate send"
                              >
                                Retry DLQ
                              </button>
                            </>
                          )}
                          {isQueued && (
                            <button
                              type="button"
                              onClick={() =>
                                onAckAlert(
                                  alert.deliveryId,
                                  "Discarded from queue",
                                )
                              }
                              style={{
                                padding: "3px 8px",
                                borderRadius: "4px",
                                fontSize: "11px",
                                fontWeight: 600,
                                background: "#1e293b",
                                border: "1px solid #334155",
                                color: "#94a3b8",
                                cursor: "pointer",
                              }}
                            >
                              Ack / Clear
                            </button>
                          )}
                          {isAcked && (
                            <button
                              type="button"
                              onClick={() => onRetryAlert(alert.deliveryId)}
                              style={{
                                padding: "3px 8px",
                                borderRadius: "4px",
                                fontSize: "11px",
                                fontWeight: 600,
                                background: "rgba(56, 189, 248, 0.15)",
                                border: "1px solid #38bdf8",
                                color: "#38bdf8",
                                cursor: "pointer",
                              }}
                            >
                              Re-queue
                            </button>
                          )}
                          {isDelivered && (
                            <span
                              style={{
                                fontSize: "11px",
                                color: "#4ade80",
                              }}
                            >
                              ✓ Sent
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
