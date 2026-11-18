/**
 * @file panels/ApiUsageCard.tsx
 * @description Session API usage meter rendered in the Telemetry tab.
 *
 * Shows one row per normalized endpoint (method + path) with calls, outcomes,
 * average latency and the last status. Backed by `trackedFetch` in
 * `packages/ui/src/api_usage.ts`; reset only clears this browser session.
 */

import type React from "react";
import { useState } from "react";
import { resetApiUsage, useApiUsage } from "../api_usage.ts";
import { styles } from "../dashboard_styles.ts";

const VISIBLE_ROWS = 14;

function formatMs(value: number | null): string {
  return value === null ? "—" : `${value} ms`;
}

function formatAge(lastAtMs: number | null): string {
  if (lastAtMs === null) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - lastAtMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function statusColor(status: number | null): string {
  if (status === null) return "#fca5a5";
  if (status >= 500) return "#fca5a5";
  if (status >= 400) return "#fbbf24";
  return "#4ade80";
}

export function ApiUsageCard(): React.ReactElement {
  const usage = useApiUsage();
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? usage.rows : usage.rows.slice(0, VISIBLE_ROWS);
  const truncated = usage.rows.length > rows.length;

  return (
    <div style={styles.tableCard} data-api-usage-card="true">
      <div style={styles.tableHeader}>
        <h3 style={styles.tableTitle}>
          📡 API Usage (session)
          <span
            data-api-usage-summary="true"
            style={{
              marginLeft: "8px",
              fontSize: "11px",
              fontWeight: 400,
              color: "#64748b",
            }}
          >
            {usage.calls} calls
            {usage.coalesced > 0
              ? ` · ${usage.calls - usage.coalesced} network · ${usage.coalesced} coalesced`
              : ""}
            {" · "}
            {usage.ok} ok · {usage.failed} failed{" · "}
            avg {formatMs(usage.avgMs)}
            {usage.pending > 0 ? ` · ${usage.pending} pending` : ""}
          </span>
        </h3>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={styles.kpiSub}>
            normalized routes only · no query values or customer ids
          </span>
          <button
            type="button"
            data-api-usage-reset="true"
            onClick={() => {
              resetApiUsage();
              setShowAll(false);
            }}
            disabled={usage.calls === 0}
            style={{
              padding: "3px 9px",
              borderRadius: "6px",
              fontSize: "11px",
              fontWeight: 600,
              appearance: "none",
              backgroundColor: "#1e293b",
              border: "1px solid #334155",
              color: usage.calls === 0 ? "#475569" : "#e2e8f0",
              cursor: usage.calls === 0 ? "default" : "pointer",
            }}
          >
            Reset meter
          </button>
        </div>
      </div>

      {usage.rows.length === 0 ? (
        <div
          data-api-usage-empty="true"
          style={{
            padding: "18px 14px",
            color: "#94a3b8",
            fontSize: "12px",
          }}
        >
          No API calls recorded this session. Dashboard reads are tracked as
          they happen.
        </div>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th scope="col" style={styles.th}>
                    Endpoint
                  </th>
                  <th scope="col" style={styles.th}>
                    Calls
                  </th>
                  <th scope="col" style={styles.th}>
                    OK
                  </th>
                  <th scope="col" style={styles.th}>
                    Err
                  </th>
                  <th scope="col" style={styles.th}>
                    Avg
                  </th>
                  <th scope="col" style={styles.th}>
                    Last
                  </th>
                  <th scope="col" style={styles.th}>
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} data-api-usage-row={row.key}>
                    <td style={styles.td}>
                      <code style={{ fontSize: "11px", color: "#cbd5e1" }}>
                        {row.key}
                      </code>
                    </td>
                    <td style={styles.td}>
                      {row.calls}
                      {row.coalesced > 0 ? (
                        <div style={styles.custSub}>
                          {row.coalesced} coalesced
                        </div>
                      ) : null}
                    </td>
                    <td style={{ ...styles.td, color: "#86efac" }}>{row.ok}</td>
                    <td
                      style={{
                        ...styles.td,
                        color: row.failed > 0 ? "#fca5a5" : "#64748b",
                      }}
                    >
                      {row.failed}
                    </td>
                    <td style={styles.td}>{formatMs(row.avgMs)}</td>
                    <td style={styles.td}>
                      {formatMs(row.lastMs)}
                      <div style={styles.custSub}>
                        {formatAge(row.lastAtMs)}
                      </div>
                    </td>
                    <td
                      style={{
                        ...styles.td,
                        fontFamily: "monospace",
                        fontWeight: 700,
                        color:
                          row.lastStatus !== null
                            ? statusColor(row.lastStatus)
                            : row.pending > 0
                              ? "#94a3b8"
                              : "#fca5a5",
                      }}
                    >
                      {row.lastStatus ?? (row.pending > 0 ? "…" : "ERR")}
                      {row.pending > 0 && row.lastStatus !== null ? " · …" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {truncated || showAll ? (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 14px",
                borderTop: "1px solid #1e293b",
                fontSize: "11px",
                color: "#94a3b8",
              }}
            >
              <span>
                Showing {rows.length} of {usage.rows.length} endpoints
              </span>
              <button
                type="button"
                data-api-usage-show-all={showAll ? "collapse" : "expand"}
                onClick={() => setShowAll((prev) => !prev)}
                style={{
                  ...styles.actionBtn,
                  padding: "3px 9px",
                  fontSize: "11px",
                }}
              >
                {showAll
                  ? `Show top ${VISIBLE_ROWS}`
                  : `Show all ${usage.rows.length}`}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
