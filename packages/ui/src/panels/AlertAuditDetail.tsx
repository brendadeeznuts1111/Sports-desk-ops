import type React from "react";
import { formatRelativeAge } from "../relative_time.ts";
import type { DashboardAlertRecord } from "../types.ts";

export interface AlertAuditDetailProps {
  readonly alert: DashboardAlertRecord;
  /** Render clock; the panel ticks this so the age stays honest. */
  readonly now: number;
}

function field(label: string, value: React.ReactNode): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        gap: "8px",
        alignItems: "baseline",
        fontSize: "11px",
        lineHeight: 1.7,
      }}
    >
      <span style={{ color: "#64748b", minWidth: "86px", flexShrink: 0 }}>
        {label}
      </span>
      <span
        style={{
          color: "#e2e8f0",
          minWidth: 0,
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function card(): React.CSSProperties {
  return {
    flex: "1 1 260px",
    minWidth: 0,
    padding: "10px 12px",
    borderRadius: "6px",
    border: "1px solid #1e293b",
    backgroundColor: "rgba(2, 6, 23, 0.55)",
  };
}

/**
 * Full audit record for one delivery: the ticket payload that was screened, the
 * delivery lineage (attempts, message id, final error, replay origin), and the
 * explicit ack. The list row shows only the directive; this is the evidence view.
 */
export function AlertAuditDetail({
  alert,
  now,
}: AlertAuditDetailProps): React.ReactElement {
  const age = formatRelativeAge(
    now,
    Number.isFinite(Date.parse(alert.createdAt))
      ? Date.parse(alert.createdAt)
      : null,
  );
  const payload = alert.payload;
  return (
    <div
      data-alert-detail={alert.deliveryId}
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "10px",
        padding: "10px 0 14px",
      }}
    >
      <div style={card()}>
        <div
          style={{
            fontSize: "10px",
            fontWeight: 700,
            letterSpacing: "0.05em",
            color: "#38bdf8",
            marginBottom: "6px",
          }}
        >
          TICKET PAYLOAD
        </div>
        {field("Sport", payload.sport ?? "—")}
        {field("Event", payload.event ?? "—")}
        {field("Selection", payload.selection ?? "—")}
        {field("Odds", payload.oddsAmerican ?? "—")}
        {field("Amount", `$${payload.amountUsd?.toLocaleString() ?? "—"}`)}
        {field("CLV", payload.clvCents == null ? "—" : `${payload.clvCents}¢`)}
        {field("Directive", payload.directive ?? "—")}
      </div>

      <div style={card()}>
        <div
          style={{
            fontSize: "10px",
            fontWeight: 700,
            letterSpacing: "0.05em",
            color: "#c084fc",
            marginBottom: "6px",
          }}
        >
          DELIVERY &amp; LINEAGE
        </div>
        {field("Delivery ID", <code>{alert.deliveryId}</code>)}
        {field("Ticket", alert.wagerId || "—")}
        {field("Status", alert.status.toUpperCase())}
        {field("Tier", alert.tier)}
        {field("Attempts", `${alert.attempts ?? 1} / 5`)}
        {field("Message ID", alert.messageId ?? "—")}
        {field("Final error", alert.finalError ?? "—")}
        {field("Retried from", alert.retriedFrom ?? "—")}
      </div>

      <div style={card()}>
        <div
          style={{
            fontSize: "10px",
            fontWeight: 700,
            letterSpacing: "0.05em",
            color: "#4ade80",
            marginBottom: "6px",
          }}
        >
          TIMESTAMPS &amp; ACK
        </div>
        {field("Created", <code>{alert.createdAt}</code>)}
        {field("Updated", <code>{alert.updatedAt}</code>)}
        {field(
          "Age",
          <span data-alert-detail-age="true">{age ?? "unknown"}</span>,
        )}
        {field("Acked by", alert.acknowledgedBy ?? "—")}
        {field("Ack notes", alert.acknowledgedNotes ?? "—")}
      </div>
    </div>
  );
}
