import type React from "react";
import type { ShiftSummaryData } from "../types.ts";

export interface ShiftHandoffModalProps {
  readonly shiftOperator: string;
  readonly onShiftOperatorChange: (operatorId: string) => void;
  readonly shiftLoading: boolean;
  readonly onRefresh: (operatorId: string) => void;
  readonly shiftSummary: ShiftSummaryData | null;
  readonly onClose: () => void;
}

export function ShiftHandoffModal({
  shiftOperator,
  onShiftOperatorChange,
  shiftLoading,
  onRefresh,
  shiftSummary,
  onClose,
}: ShiftHandoffModalProps): React.ReactElement {
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(3, 7, 18, 0.75)",
        backdropFilter: "blur(6px)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "580px",
          maxWidth: "100%",
          backgroundColor: "#0d1527",
          border: "1px solid #1e293b",
          borderRadius: "12px",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)",
          overflow: "hidden",
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid #1e293b",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: "rgba(15, 23, 42, 0.6)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "18px" }}>📋</span>
            <div>
              <h3 style={{ margin: 0, fontSize: "16px", color: "#f8fafc" }}>
                Operator Shift Handoff Summary
              </h3>
              <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                Surveillance alerts, DLQ disposition, and security audit log
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "#94a3b8",
              fontSize: "18px",
              cursor: "pointer",
              padding: "4px 8px",
            }}
          >
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div
          style={{
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          {/* Operator & Window Selector */}
          <div
            style={{
              display: "flex",
              gap: "10px",
              alignItems: "center",
              background: "#131d35",
              padding: "10px 14px",
              borderRadius: "8px",
              border: "1px solid #1e293b",
            }}
          >
            <label
              style={{
                fontSize: "12px",
                color: "#94a3b8",
                fontWeight: 600,
              }}
            >
              Operator:
            </label>
            <input
              value={shiftOperator}
              onChange={(e) => onShiftOperatorChange(e.target.value)}
              style={{
                background: "#070b14",
                border: "1px solid #334155",
                color: "#f1f5f9",
                padding: "4px 8px",
                borderRadius: "4px",
                fontSize: "12px",
                flex: 1,
              }}
              placeholder="operator_id"
            />
            <button
              type="button"
              onClick={() => onRefresh(shiftOperator)}
              disabled={shiftLoading}
              style={{
                padding: "4px 10px",
                borderRadius: "4px",
                fontSize: "12px",
                fontWeight: 600,
                background: "#2563eb",
                border: "none",
                color: "#ffffff",
                cursor: shiftLoading ? "wait" : "pointer",
              }}
            >
              {shiftLoading ? "..." : "Refresh"}
            </button>
          </div>

          {/* Shift Date Label */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "11px",
              color: "#94a3b8",
            }}
          >
            <span>
              <b>Handoff Window:</b> {shiftSummary?.date ?? "Today"} (Rolling
              24h & Shift Span)
            </span>
            <span>
              <b>Audit Ledger:</b> JSONL Verified
            </span>
          </div>

          {/* Shift Metrics Grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: "10px",
            }}
          >
            <div
              style={{
                background: "#0a1020",
                border: "1px solid #1e293b",
                borderRadius: "8px",
                padding: "12px 14px",
              }}
            >
              <div
                style={{
                  fontSize: "11px",
                  color: "#94a3b8",
                  marginBottom: "4px",
                }}
              >
                Total Surveillance Alerts
              </div>
              <div
                style={{
                  fontSize: "20px",
                  fontWeight: 700,
                  color: "#38bdf8",
                }}
              >
                {shiftSummary?.totalAlerts ?? 0}
              </div>
              <div style={{ fontSize: "10px", color: "#64748b" }}>
                Classified by TOML risk engine
              </div>
            </div>

            <div
              style={{
                background: "#0a1020",
                border: "1px solid #1e293b",
                borderRadius: "8px",
                padding: "12px 14px",
              }}
            >
              <div
                style={{
                  fontSize: "11px",
                  color: "#94a3b8",
                  marginBottom: "4px",
                }}
              >
                Delivered to Telegram
              </div>
              <div
                style={{
                  fontSize: "20px",
                  fontWeight: 700,
                  color: "#4ade80",
                }}
              >
                {shiftSummary?.deliveredAlerts ?? 0}
              </div>
              <div style={{ fontSize: "10px", color: "#64748b" }}>
                200 OK from Bot API
              </div>
            </div>

            <div
              style={{
                background: "#0a1020",
                border: "1px solid #1e293b",
                borderRadius: "8px",
                padding: "12px 14px",
              }}
            >
              <div
                style={{
                  fontSize: "11px",
                  color: "#94a3b8",
                  marginBottom: "4px",
                }}
              >
                Dead-Letter DLQ Alerts
              </div>
              <div
                style={{
                  fontSize: "20px",
                  fontWeight: 700,
                  color:
                    (shiftSummary?.deadLetterAlerts ?? 0) > 0
                      ? "#f87171"
                      : "#4ade80",
                }}
              >
                {shiftSummary?.deadLetterAlerts ?? 0}
              </div>
              <div style={{ fontSize: "10px", color: "#64748b" }}>
                Exceeded retry ceiling
              </div>
            </div>

            <div
              style={{
                background: "#0a1020",
                border: "1px solid #1e293b",
                borderRadius: "8px",
                padding: "12px 14px",
              }}
            >
              <div
                style={{
                  fontSize: "11px",
                  color: "#94a3b8",
                  marginBottom: "4px",
                }}
              >
                Operator Acknowledged
              </div>
              <div
                style={{
                  fontSize: "20px",
                  fontWeight: 700,
                  color: "#c084fc",
                }}
              >
                {shiftSummary?.acknowledgedAlerts ?? 0}
              </div>
              <div style={{ fontSize: "10px", color: "#64748b" }}>
                Cleared via Ack or Replay
              </div>
            </div>

            <div
              style={{
                background: "#0a1020",
                border: "1px solid #1e293b",
                borderRadius: "8px",
                padding: "12px 14px",
              }}
            >
              <div
                style={{
                  fontSize: "11px",
                  color: "#94a3b8",
                  marginBottom: "4px",
                }}
              >
                Delivery Retries & Errors
              </div>
              <div
                style={{
                  fontSize: "20px",
                  fontWeight: 700,
                  color: "#fbbf24",
                }}
              >
                {shiftSummary?.failedAttempts ?? 0}
              </div>
              <div style={{ fontSize: "10px", color: "#64748b" }}>
                429 backoff or network retries
              </div>
            </div>

            <div
              style={{
                background: "#0a1020",
                border: "1px solid #1e293b",
                borderRadius: "8px",
                padding: "12px 14px",
              }}
            >
              <div
                style={{
                  fontSize: "11px",
                  color: "#94a3b8",
                  marginBottom: "4px",
                }}
              >
                PTY Terminal Commands
              </div>
              <div
                style={{
                  fontSize: "20px",
                  fontWeight: 700,
                  color: "#e2e8f0",
                }}
              >
                {shiftSummary?.terminalCommandsCount ?? 0}
              </div>
              <div style={{ fontSize: "10px", color: "#64748b" }}>
                Interactive terminal forensics
              </div>
            </div>
          </div>

          {/* Handoff Status Note */}
          <div
            style={{
              padding: "10px 14px",
              borderRadius: "6px",
              background:
                (shiftSummary?.deadLetterAlerts ?? 0) > 0
                  ? "rgba(239, 68, 68, 0.1)"
                  : "rgba(34, 197, 94, 0.1)",
              border: `1px solid ${
                (shiftSummary?.deadLetterAlerts ?? 0) > 0
                  ? "#ef4444"
                  : "#22c55e"
              }`,
              fontSize: "12px",
              color:
                (shiftSummary?.deadLetterAlerts ?? 0) > 0
                  ? "#f87171"
                  : "#4ade80",
            }}
          >
            {(shiftSummary?.deadLetterAlerts ?? 0) > 0
              ? `⚠️ Handoff Warning: ${shiftSummary?.deadLetterAlerts} dead alert(s) in DLQ require operator acknowledgment or replay before shift close.`
              : "✓ Shift Handoff Ready: Zero dead-letter alerts pending. All critical and steam wagers accounted for."}
          </div>
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid #1e293b",
            display: "flex",
            justifyContent: "flex-end",
            background: "rgba(15, 23, 42, 0.6)",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "6px 16px",
              borderRadius: "6px",
              fontSize: "12px",
              fontWeight: 600,
              background: "#1e293b",
              border: "1px solid #334155",
              color: "#f1f5f9",
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
