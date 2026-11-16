import { resolveDaemon4020State } from "@sportsdesk-ops/contracts";
import { copyText } from "../clipboard.ts";
import type React from "react";
import { useState } from "react";
import { styles } from "../dashboard_styles.ts";
import type { R2PipelineApiResponse, R2SinkDetail } from "../types.ts";

export interface R2PipelineTabPanelProps {
  readonly data: R2PipelineApiResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRefresh: (force?: boolean) => void;
  readonly onVerifyTickets?: (dryRun?: boolean) => void;
  readonly verifyingTickets?: boolean;
  readonly verifyTicketsError?: string | null;
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

function formatUsdCents(cents: number): string {
  const usd = cents / 100;
  return usd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(usd) >= 100 ? 0 : 2,
  });
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

interface BlockerGroup {
  readonly key: string;
  readonly headline: string;
  readonly detail: string;
  readonly suggestedCommand: string;
  readonly sinkIds: string[];
  readonly urgentAuth: boolean;
}

function collectBlockerGroups(
  sinks: readonly R2SinkDetail[],
): readonly BlockerGroup[] {
  const groups: BlockerGroup[] = [];
  const indexByKey: Record<string, number> = Object.create(null);

  for (const sink of sinks) {
    const diag = sink.diagnostic;
    if (!diag) continue;
    const key = `${diag.blockerClass}::${diag.suggestedCommand}`;
    const existingIdx = indexByKey[key];
    if (existingIdx !== undefined) {
      groups[existingIdx]!.sinkIds.push(sink.id);
      continue;
    }
    const urgentAuth =
      diag.blockerClass === "f402_auth_expired" ||
      diag.blockerClass === "gslive_auth_expired" ||
      diag.blockerClass === "sanitization_guard";
    indexByKey[key] = groups.length;
    groups.push({
      key,
      headline: diag.headline,
      detail: diag.detail,
      suggestedCommand: diag.suggestedCommand,
      sinkIds: [sink.id],
      urgentAuth,
    });
  }
  return groups;
}

const SECTION_CARD_STYLE: React.CSSProperties = {
  borderRadius: "8px",
  padding: "14px 16px",
  backgroundColor: "rgba(15, 23, 42, 0.9)",
  border: "1px solid #334155",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const METRIC_BOX_STYLE: React.CSSProperties = {
  padding: "6px 8px",
  borderRadius: "5px",
  backgroundColor: "rgba(30, 41, 59, 0.55)",
  border: "1px solid rgba(51, 65, 85, 0.7)",
};

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
  onVerifyTickets,
  verifyingTickets = false,
  verifyTicketsError = null,
}: R2PipelineTabPanelProps): React.ReactElement {
  const [copiedCmdId, setCopiedCmdId] = useState<string | null>(null);
  const automations = data?.automations;
  const ticketVerify = automations?.ticketVerification ?? null;

  const daemon = data?.daemon4020;
  const blockerGroups = collectBlockerGroups(data?.sinks ?? []);
  const failedBridgeJobs = (automations?.bridgeJobs ?? []).filter((j) => !j.ok);
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
            {data && data.dataStaleKeys.length > 0 && (
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: "999px",
                  fontSize: "11px",
                  fontWeight: 700,
                  color: "#f87171",
                  backgroundColor: "rgba(239, 68, 68, 0.14)",
                  border: "1px solid #ef4444",
                }}
              >
                ⚠️ {data.dataStaleKeys.length}/{data.totalCount} Data Windows
                &gt;24h
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

      {blockerGroups.length > 0 && (
        <div
          style={{
            ...SECTION_CARD_STYLE,
            borderColor: "#f59e0b",
            backgroundColor: "rgba(69, 26, 3, 0.28)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "8px",
            }}
          >
            <span
              style={{ fontWeight: 700, fontSize: "13px", color: "#fbbf24" }}
            >
              🛠️ Pipeline Root-Cause &amp; Auth Remediation Triage (
              {blockerGroups.length} active{" "}
              {blockerGroups.length === 1 ? "blocker" : "blockers"})
            </span>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            {blockerGroups.map((group) => (
              <div
                key={group.key}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  flexWrap: "wrap",
                  gap: "10px",
                  padding: "8px 10px",
                  borderRadius: "6px",
                  backgroundColor: "rgba(15, 23, 42, 0.78)",
                  border: `1px solid ${group.urgentAuth ? "#ef4444" : "#f59e0b"}`,
                  fontSize: "11px",
                }}
              >
                <div style={{ flex: "1 1 340px", minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 700,
                      color: group.urgentAuth ? "#fca5a5" : "#fde68a",
                    }}
                  >
                    {group.headline} · Sinks: {group.sinkIds.join(", ")}
                  </div>
                  <div
                    style={{
                      color: "#cbd5e1",
                      marginTop: "3px",
                      fontFamily: "monospace",
                      wordBreak: "break-word",
                    }}
                  >
                    {group.detail}
                  </div>
                </div>
                <button
                  type="button"
                  style={{
                    ...styles.actionBtn,
                    padding: "4px 8px",
                    fontSize: "11px",
                    fontFamily: "monospace",
                    maxWidth: "100%",
                  }}
                  onClick={() => {
                    void copyText(group.suggestedCommand);
                    setCopiedCmdId(`blocker:${group.key}`);
                    setTimeout(() => setCopiedCmdId(null), 1800);
                  }}
                >
                  {copiedCmdId === `blocker:${group.key}`
                    ? "✓ Copied Fix CLI"
                    : `📋 ${group.suggestedCommand}`}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

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
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    flexWrap: "wrap",
                  }}
                >
                  {sink.dataStale && (
                    <span
                      style={{
                        padding: "3px 7px",
                        borderRadius: "999px",
                        fontSize: "10px",
                        fontWeight: 700,
                        color: "#fca5a5",
                        backgroundColor: "rgba(239, 68, 68, 0.16)",
                        border: "1px solid #ef4444",
                        whiteSpace: "nowrap",
                      }}
                    >
                      ⚠️ DATA &gt;24H
                    </span>
                  )}
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

              {(sink.reason || sink.sha256 || sink.contentLength !== null) && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: "6px",
                    fontSize: "11px",
                    color: "#94a3b8",
                  }}
                >
                  <span>{sink.reason ?? ""}</span>
                  <span style={{ fontFamily: "monospace" }}>
                    {sink.contentLength !== null
                      ? formatBytes(sink.contentLength)
                      : ""}
                    {sink.contentLength !== null && sink.sha256 ? " · " : ""}
                    {sink.sha256 ? `sha256:${sink.sha256.slice(0, 12)}` : ""}
                  </span>
                </div>
              )}

              {sink.diagnostic && (
                <div
                  style={{
                    padding: "8px 10px",
                    borderRadius: "6px",
                    backgroundColor: "rgba(127, 29, 29, 0.22)",
                    border: "1px solid rgba(239, 68, 68, 0.65)",
                    fontSize: "11px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  <div style={{ fontWeight: 700, color: "#fca5a5" }}>
                    {sink.diagnostic.headline}
                    {sink.diagnostic.failedJobIds.length > 0
                      ? ` (${sink.diagnostic.failedJobIds.join(", ")})`
                      : ""}
                  </div>
                  <div
                    style={{
                      color: "#e2e8f0",
                      fontFamily: "monospace",
                      wordBreak: "break-word",
                    }}
                  >
                    {sink.diagnostic.detail}
                  </div>
                </div>
              )}

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
                    void copyText(sink.remediationCommand);
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

      {/* GSLive Ticket Verification & Secret Redaction Canary */}
      {(automations !== undefined || onVerifyTickets !== undefined) && (
        <div style={SECTION_CARD_STYLE}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "10px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                flexWrap: "wrap",
              }}
            >
              <span
                style={{ fontWeight: 700, fontSize: "13px", color: "#f8fafc" }}
              >
                🎫 GSLive Ticket Verification &amp; #private Redaction Canary
              </span>
              {ticketVerify && (
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: "999px",
                    fontSize: "11px",
                    fontWeight: 700,
                    color:
                      ticketVerify.canaryPassed && ticketVerify.clientSealed
                        ? "#4ade80"
                        : "#f87171",
                    backgroundColor:
                      ticketVerify.canaryPassed && ticketVerify.clientSealed
                        ? "rgba(34, 197, 94, 0.14)"
                        : "rgba(239, 68, 68, 0.14)",
                    border: `1px solid ${
                      ticketVerify.canaryPassed && ticketVerify.clientSealed
                        ? "#22c55e"
                        : "#ef4444"
                    }`,
                  }}
                >
                  {ticketVerify.canaryPassed && ticketVerify.clientSealed
                    ? `CANARY PASS · ${ticketVerify.mode.toUpperCase()}`
                    : "CANARY FAIL"}
                </span>
              )}
            </div>
            <div
              style={{
                display: "flex",
                gap: "8px",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              {onVerifyTickets && (
                <button
                  type="button"
                  style={{
                    ...styles.actionBtn,
                    padding: "4px 10px",
                    fontSize: "11px",
                    cursor: verifyingTickets ? "wait" : "pointer",
                  }}
                  disabled={verifyingTickets}
                  onClick={() => onVerifyTickets(true)}
                >
                  {verifyingTickets ? "Verifying…" : "▶ Run Dry-Run Verify"}
                </button>
              )}
              <button
                type="button"
                style={{
                  ...styles.actionBtn,
                  padding: "4px 8px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                }}
                onClick={() => {
                  void copyText("bun run verify:gslive-tickets -- --dry-run");
                  setCopiedCmdId("verify-gslive-tickets");
                  setTimeout(() => setCopiedCmdId(null), 1800);
                }}
              >
                {copiedCmdId === "verify-gslive-tickets"
                  ? "✓ Copied CLI"
                  : "📋 bun run verify:gslive-tickets -- --dry-run"}
              </button>
            </div>
          </div>

          {verifyTicketsError && (
            <div style={{ fontSize: "12px", color: "#f87171" }}>
              {verifyTicketsError}
            </div>
          )}

          {ticketVerify ? (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: "8px",
                  fontSize: "12px",
                }}
              >
                <div style={METRIC_BOX_STYLE}>
                  <div style={{ fontSize: "10px", color: "#94a3b8" }}>
                    Actionable / Rows
                  </div>
                  <div style={{ fontWeight: 700, color: "#f1f5f9" }}>
                    {ticketVerify.actionableTickets} / {ticketVerify.totalRows}
                  </div>
                </div>
                <div style={METRIC_BOX_STYLE}>
                  <div style={{ fontSize: "10px", color: "#94a3b8" }}>
                    Wagered / Volume
                  </div>
                  <div style={{ fontWeight: 700, color: "#f1f5f9" }}>
                    {formatUsdCents(ticketVerify.totalWageredCents)} /{" "}
                    {formatUsdCents(ticketVerify.totalVolumeCents)}
                  </div>
                </div>
                <div style={METRIC_BOX_STYLE}>
                  <div style={{ fontSize: "10px", color: "#94a3b8" }}>
                    Sentinel Noise / ΔVol
                  </div>
                  <div style={{ fontWeight: 700, color: "#f1f5f9" }}>
                    {ticketVerify.sentinelNoiseCount} noise ·{" "}
                    {ticketVerify.volumeMismatchCount} Δ
                  </div>
                </div>
                <div style={METRIC_BOX_STYLE}>
                  <div style={{ fontSize: "10px", color: "#94a3b8" }}>
                    F402 / R2 Status
                  </div>
                  <div style={{ fontWeight: 700, color: "#f1f5f9" }}>
                    {ticketVerify.f402Status} / {ticketVerify.r2Status}
                  </div>
                </div>
                <div style={METRIC_BOX_STYLE}>
                  <div style={{ fontSize: "10px", color: "#94a3b8" }}>
                    Verified At
                  </div>
                  <div style={{ fontWeight: 600, color: "#cbd5e1" }}>
                    {ticketVerify.verifiedAt
                      ? `${ticketVerify.verifiedAt.slice(0, 16)}Z`
                      : "—"}
                  </div>
                </div>
              </div>
              {(ticketVerify.sourcePath || ticketVerify.r2PublishedKey) && (
                <div
                  style={{
                    fontSize: "11px",
                    color: "#94a3b8",
                    fontFamily: "monospace",
                  }}
                >
                  {ticketVerify.sourcePath
                    ? `source=${ticketVerify.sourcePath}`
                    : ""}
                  {ticketVerify.sourcePath && ticketVerify.r2PublishedKey
                    ? " · "
                    : ""}
                  {ticketVerify.r2PublishedKey
                    ? `r2=${ticketVerify.r2PublishedKey}`
                    : ""}
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: "12px", color: "#94a3b8" }}>
              No verification receipt recorded yet. Run Dry-Run Verify or{" "}
              <code>bun run verify:gslive-tickets -- --dry-run</code>.
            </div>
          )}

          {ticketVerify?.error && (
            <div style={{ fontSize: "11px", color: "#fbbf24" }}>
              {ticketVerify.error}
              {ticketVerify.remediation ? ` — ${ticketVerify.remediation}` : ""}
            </div>
          )}
        </div>
      )}

      {/* Automations & Scheduled Jobs */}
      {automations && (
        <div style={SECTION_CARD_STYLE}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "8px",
            }}
          >
            <span
              style={{ fontWeight: 700, fontSize: "13px", color: "#f8fafc" }}
            >
              ⏱️ Scheduled Automations &amp; Bridge Rollups (
              {automations.schedules.filter((s) => s.gateReady).length}/
              {automations.schedules.length} gate-ready)
            </span>
            <span style={{ fontSize: "11px", color: "#94a3b8" }}>
              Last bridge cycle:{" "}
              {automations.bridgeRollupUpdatedAt
                ? `${automations.bridgeRollupUpdatedAt.slice(0, 16)}Z`
                : "unrecorded"}
            </span>
          </div>

          {automations.bridgeJobs.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {automations.bridgeJobs.map((job) => (
                <span
                  key={job.id}
                  style={{
                    padding: "3px 8px",
                    borderRadius: "6px",
                    fontSize: "11px",
                    fontWeight: 600,
                    color: job.ok ? "#4ade80" : "#f87171",
                    backgroundColor: job.ok
                      ? "rgba(34, 197, 94, 0.12)"
                      : "rgba(239, 68, 68, 0.12)",
                    border: `1px solid ${job.ok ? "#22c55e" : "#ef4444"}`,
                  }}
                  title={job.error ?? `${job.durationMs}ms`}
                >
                  {job.ok ? "✓" : "✗"} {job.id} ({job.durationMs}ms)
                </span>
              ))}
            </div>
          )}

          {failedBridgeJobs.length > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                padding: "8px 10px",
                borderRadius: "6px",
                backgroundColor: "rgba(127, 29, 29, 0.18)",
                border: "1px solid rgba(239, 68, 68, 0.45)",
                fontSize: "11px",
              }}
            >
              <div style={{ fontWeight: 700, color: "#fca5a5" }}>
                Failing Bridge Jobs ({failedBridgeJobs.length})
              </div>
              {failedBridgeJobs.map((job) => (
                <div
                  key={job.id}
                  style={{
                    fontFamily: "monospace",
                    color: "#e2e8f0",
                    wordBreak: "break-word",
                  }}
                >
                  <span style={{ color: "#f87171", fontWeight: 700 }}>
                    ✗ {job.id}
                  </span>{" "}
                  <span style={{ color: "#94a3b8" }}>({job.label})</span>:{" "}
                  {job.error ?? `exited with failure (${job.durationMs}ms)`}
                </div>
              ))}
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: "8px",
            }}
          >
            {automations.schedules.map((sched) => (
              <div
                key={sched.id}
                style={{
                  ...METRIC_BOX_STYLE,
                  padding: "8px 10px",
                  borderRadius: "6px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                  fontSize: "11px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <span style={{ fontWeight: 700, color: "#f1f5f9" }}>
                    {sched.name}
                  </span>
                  <span
                    style={{
                      padding: "1px 6px",
                      borderRadius: "999px",
                      fontSize: "10px",
                      fontWeight: 700,
                      color: sched.gateReady ? "#4ade80" : "#fbbf24",
                      backgroundColor: sched.gateReady
                        ? "rgba(34, 197, 94, 0.12)"
                        : "rgba(245, 158, 11, 0.12)",
                      border: `1px solid ${sched.gateReady ? "#22c55e" : "#f59e0b"}`,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {sched.gateReady ? "READY" : "GATED"}
                  </span>
                </div>
                <div style={{ color: "#94a3b8", fontFamily: "monospace" }}>
                  {sched.scheduleTime} · {sched.tz} · {sched.owner}
                </div>
                {sched.lastTriggeredAt && (
                  <div style={{ color: "#cbd5e1" }}>
                    Last run: {sched.lastTriggeredAt.slice(0, 16)}Z
                  </div>
                )}
                {sched.missingRequirements.length > 0 && (
                  <div style={{ color: "#fbbf24" }}>
                    Missing: {sched.missingRequirements.join(", ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
