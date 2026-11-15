import { resolveDaemon4020State } from "@sportsdesk-ops/contracts";
import type React from "react";
import { useState } from "react";
import { styles } from "../dashboard_styles.ts";
import type { R2PipelineApiResponse, R2SinkDetail } from "../types.ts";

export interface R2PipelineTabPanelProps {
  readonly data: R2PipelineApiResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRefresh: (force?: boolean) => void;
}

function formatAge(ageSeconds: number | null): string {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) return "—";
  if (ageSeconds < 60) return `${ageSeconds}s`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m`;
  if (ageSeconds < 86400) return `${(ageSeconds / 3600).toFixed(1)}h`;
  return `${(ageSeconds / 86400).toFixed(1)}d`;
}

function formatSla(slaSeconds: number): string {
  if (slaSeconds < 3600) return `${Math.round(slaSeconds / 60)}m`;
  return `${(slaSeconds / 3600).toFixed(0)}h`;
}

function stateBadgeColors(state: R2SinkDetail["state"]): {
  readonly fg: string;
  readonly bg: string;
  readonly border: string;
  readonly label: string;
} {
  if (state === "fresh") {
    return {
      fg: "#4ade80",
      bg: "rgba(34, 197, 94, 0.16)",
      border: "#22c55e",
      label: "🟢 FRESH",
    };
  }
  if (state === "stale") {
    return {
      fg: "#fbbf24",
      bg: "rgba(245, 158, 11, 0.16)",
      border: "#f59e0b",
      label: "🟠 STALE",
    };
  }
  if (state === "missing") {
    return {
      fg: "#f87171",
      bg: "rgba(239, 68, 68, 0.16)",
      border: "#ef4444",
      label: "🔴 MISSING (404)",
    };
  }
  return {
    fg: "#f87171",
    bg: "rgba(239, 68, 68, 0.16)",
    border: "#ef4444",
    label: "🔴 ERROR",
  };
}

export function R2PipelineTabPanel({
  data,
  loading,
  error,
  onRefresh,
}: R2PipelineTabPanelProps): React.ReactElement {
  const [copiedCmdId, setCopiedCmdId] = useState<string | null>(null);

  const daemon = data?.daemon4020;
  const daemonState = resolveDaemon4020State(daemon);
  const daemonBannerColor =
    daemonState === "online"
      ? "#4ade80"
      : daemonState === "degraded"
        ? "#fbbf24"
        : "#fbbf24";
  const daemonBannerBorder = daemonState === "online" ? "#22c55e" : "#f59e0b";
  const daemonBannerLabel =
    daemonState === "online"
      ? `● SportsDesk Daemon :4020 Online (${daemon?.latencyMs ?? 1}ms)`
      : daemonState === "degraded"
        ? `◐ SportsDesk Daemon :4020 Reachable — ${daemon?.operationalStatus === "down" ? "Auth Down" : "Degraded"} (${daemon?.latencyMs ?? 1}ms)`
        : "○ SportsDesk Daemon :4020 Offline (Standalone :4022 fallback active)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      {/* Top R2 Overview & Signal Honesty Note */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
          padding: "12px 16px",
          borderRadius: "8px",
          backgroundColor: "rgba(30, 41, 59, 0.85)",
          border: "1px solid #334155",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              flexWrap: "wrap",
            }}
          >
            <span
              style={{ fontWeight: 700, fontSize: "14px", color: "#f8fafc" }}
            >
              ☁️ Cloudflare R2 Public Pipeline & Rollup Dereferencer
            </span>
            {data && (
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: "999px",
                  fontSize: "11px",
                  fontWeight: 700,
                  color:
                    data.overallStatus === "fresh"
                      ? "#4ade80"
                      : data.overallStatus === "stale"
                        ? "#fbbf24"
                        : "#f87171",
                  backgroundColor:
                    data.overallStatus === "fresh"
                      ? "rgba(34, 197, 94, 0.15)"
                      : "rgba(245, 158, 11, 0.15)",
                  border: `1px solid ${
                    data.overallStatus === "fresh" ? "#22c55e" : "#f59e0b"
                  }`,
                }}
              >
                {data.freshCount}/{data.totalCount} Sinks Within SLA (
                {data.overallStatus.toUpperCase()})
              </span>
            )}
          </div>
          <div style={{ fontSize: "11px", color: "#94a3b8" }}>
            ADR #78 Signal Honesty: <b>Publish Age</b> (`Last-Modified` on{" "}
            <code>latest.json</code>) is tracked separately from{" "}
            <b>Data-Window Age</b> (covered event timestamps inside each
            rollup). Bucket:{" "}
            <code>
              {data?.bucketPublicBase ??
                "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev"}
            </code>
          </div>
        </div>
        <button
          type="button"
          style={styles.actionBtn}
          onClick={() => onRefresh(true)}
          disabled={loading}
        >
          {loading ? "Probing R2..." : "🔄 Force R2 Probe"}
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #ef4444",
            backgroundColor: "rgba(239, 68, 68, 0.14)",
            color: "#fca5a5",
            fontSize: "12px",
          }}
        >
          ⚠️ R2 Pipeline probe error: {error}
        </div>
      )}

      {/* :4020 Companion Daemon Health & Quick Links */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
          padding: "10px 14px",
          borderRadius: "8px",
          backgroundColor: "rgba(15, 23, 42, 0.9)",
          border: `1px solid ${daemonBannerBorder}`,
          fontSize: "12px",
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
          <span
            style={{
              fontWeight: 700,
              color: daemonBannerColor,
            }}
          >
            {daemonBannerLabel}
          </span>
          {daemon?.reason && daemonState !== "online" && (
            <span style={{ color: "#94a3b8" }}>({daemon.reason})</span>
          )}
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <a
            href="/live-bets"
            target="_blank"
            rel="noreferrer"
            style={{
              ...styles.actionBtn,
              padding: "4px 10px",
              fontSize: "11px",
              textDecoration: "none",
              color: "#38bdf8",
            }}
          >
            📈 Live Bets / Scoreboard ↗
          </a>
          <a
            href="/graph"
            target="_blank"
            rel="noreferrer"
            style={{
              ...styles.actionBtn,
              padding: "4px 10px",
              fontSize: "11px",
              textDecoration: "none",
              color: "#38bdf8",
            }}
          >
            🕸️ Hierarchy Graph ↗
          </a>
          <a
            href="/status"
            target="_blank"
            rel="noreferrer"
            style={{
              ...styles.actionBtn,
              padding: "4px 10px",
              fontSize: "11px",
              textDecoration: "none",
              color: "#38bdf8",
            }}
          >
            🩺 Ops Status ↗
          </a>
        </div>
      </div>

      {/* 4 R2 Bridge Sink Cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
          gap: "16px",
        }}
      >
        {(data?.sinks ?? []).map((sink) => {
          const badge = stateBadgeColors(sink.state);
          return (
            <div
              key={sink.id}
              style={{
                ...styles.tableCard,
                padding: "16px",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: "10px",
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: "15px",
                      fontWeight: 700,
                      color: "#f8fafc",
                    }}
                  >
                    {sink.label}
                  </div>
                  <div
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      marginTop: "2px",
                    }}
                  >
                    {sink.description}
                  </div>
                </div>
                <span
                  style={{
                    padding: "3px 8px",
                    borderRadius: "999px",
                    fontSize: "11px",
                    fontWeight: 700,
                    color: badge.fg,
                    backgroundColor: badge.bg,
                    border: `1px solid ${badge.border}`,
                    whiteSpace: "nowrap",
                  }}
                >
                  {badge.label}
                </span>
              </div>

              {/* Publish Age vs Data Window Age */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                  gap: "8px",
                  padding: "8px 10px",
                  borderRadius: "6px",
                  backgroundColor: "rgba(15, 23, 42, 0.7)",
                  fontSize: "11px",
                }}
              >
                <div>
                  <div style={{ color: "#64748b" }}>
                    Publish Age (SLA {formatSla(sink.slaSeconds)})
                  </div>
                  <div
                    style={{
                      fontWeight: 700,
                      color: sink.stale ? "#fbbf24" : "#4ade80",
                    }}
                  >
                    {formatAge(sink.ageSeconds)}
                  </div>
                </div>
                <div>
                  <div style={{ color: "#64748b" }}>Data Window Age (#78)</div>
                  <div
                    style={{
                      fontWeight: 700,
                      color: sink.dataStale ? "#f87171" : "#e2e8f0",
                    }}
                  >
                    {formatAge(sink.dataAgeSeconds)}
                    {sink.dataStale ? " · ⚠️ >24H" : ""}
                  </div>
                </div>
                <div>
                  <div style={{ color: "#64748b" }}>Last-Modified</div>
                  <div style={{ fontWeight: 600, color: "#cbd5e1" }}>
                    {sink.lastModified
                      ? new Date(sink.lastModified).toISOString().slice(0, 16) +
                        "Z"
                      : "—"}
                  </div>
                </div>
              </div>

              {/* Dereferenced Rollup Metrics */}
              {sink.metrics.length > 0 && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    gap: "8px",
                    fontSize: "12px",
                  }}
                >
                  {sink.metrics.map((m) => (
                    <div
                      key={m.label}
                      style={{
                        padding: "6px 8px",
                        borderRadius: "5px",
                        backgroundColor: "rgba(30, 41, 59, 0.55)",
                        border: "1px solid rgba(51, 65, 85, 0.7)",
                      }}
                    >
                      <div style={{ fontSize: "10px", color: "#94a3b8" }}>
                        {m.label}
                      </div>
                      <div
                        style={{
                          fontWeight: 600,
                          color: "#f1f5f9",
                          wordBreak: "break-word",
                        }}
                      >
                        {m.value}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Direct Links + CLI Remediation */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "8px",
                  borderTop: "1px solid #334155",
                  paddingTop: "10px",
                  fontSize: "11px",
                }}
              >
                <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                  <a
                    href={sink.publicUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      color: "#38bdf8",
                      textDecoration: "none",
                      fontWeight: 600,
                    }}
                  >
                    {sink.key} ↗
                  </a>
                  {sink.resolvedRollupUrl && (
                    <a
                      href={sink.resolvedRollupUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        color: "#4ade80",
                        textDecoration: "none",
                        fontWeight: 600,
                      }}
                    >
                      {sink.resolvedRollupKey} ↗
                    </a>
                  )}
                </div>
                <button
                  type="button"
                  style={{
                    ...styles.actionBtn,
                    padding: "3px 8px",
                    fontSize: "11px",
                    fontFamily: "monospace",
                  }}
                  onClick={() => {
                    void navigator.clipboard?.writeText(
                      sink.remediationCommand,
                    );
                    setCopiedCmdId(sink.id);
                    setTimeout(() => setCopiedCmdId(null), 1800);
                  }}
                  title="Copy refresh command to clipboard"
                >
                  {copiedCmdId === sink.id
                    ? "✓ Copied CLI"
                    : `📋 ${sink.remediationCommand}`}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
