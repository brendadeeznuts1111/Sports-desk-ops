import { extractMarkdownTelemetry } from "@sportsdesk-ops/contracts";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DASHBOARD_PANELS } from "../config/dashboard.ts";
import { styles } from "../dashboard_styles.ts";
import type { DashboardData, DnsData } from "../types.ts";
import { ThresholdsPanel } from "./ThresholdsPanel.tsx";

const DNS_CACHE_CAPACITY = DASHBOARD_PANELS.dns_cache_capacity;

export interface SurveillanceTabPanelProps {
  readonly dnsData: DnsData | null;
  readonly dnsRefreshing?: boolean;
  readonly dnsError?: string | null;
  readonly onRefreshDns?: (() => void) | undefined;
  readonly benchLoading: boolean;
  readonly benchResult: string | null;
  readonly onRunBenchmark: () => void;
  readonly reverseIp: string;
  readonly onReverseIpChange: (value: string) => void;
  readonly reverseResult: string | null;
  readonly onRunReverseLookup: () => void;
  readonly viewMode: "interactive" | "raw";
  readonly onViewModeChange: (mode: "interactive" | "raw") => void;
  readonly data: DashboardData | null;
  readonly onSelectAgent?: ((agentId: string) => void) | undefined;
}

interface DnsHealthBadge {
  readonly label: string;
  readonly color: string;
  readonly bg: string;
  readonly border: string;
}

function resolveDnsBadge(
  hitRatePercent: number,
  errors: number,
): DnsHealthBadge {
  if (errors > 0) {
    return {
      label: `${errors} ERR`,
      color: "#fca5a5",
      bg: "rgba(239, 68, 68, 0.16)",
      border: "rgba(248, 113, 113, 0.45)",
    };
  }
  if (hitRatePercent >= DASHBOARD_PANELS.dns_warm_hit_rate_pct) {
    return {
      label: "WARM",
      color: "#34d399",
      bg: "rgba(16, 185, 129, 0.14)",
      border: "rgba(52, 211, 153, 0.4)",
    };
  }
  if (hitRatePercent >= DASHBOARD_PANELS.dns_active_hit_rate_pct) {
    return {
      label: "ACTIVE",
      color: "#38bdf8",
      bg: "rgba(56, 189, 248, 0.14)",
      border: "rgba(56, 189, 248, 0.4)",
    };
  }
  return {
    label: "COLD",
    color: "#fbbf24",
    bg: "rgba(245, 158, 11, 0.16)",
    border: "rgba(251, 191, 36, 0.4)",
  };
}

function formatUtcClock(iso: string | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return `${new Date(parsed).toISOString().slice(11, 19)} UTC`;
}

function computeDnsSummary(dnsData: DnsData) {
  const { telemetry } = dnsData;
  const capacityPct = Math.min(
    100,
    Math.max(0, Math.round((telemetry.size / DNS_CACHE_CAPACITY) * 1000) / 10),
  );
  const totalHits = telemetry.cacheHitsCompleted + telemetry.cacheHitsInflight;
  const totalLookups =
    telemetry.totalCount ?? totalHits + telemetry.cacheMisses;
  const inflightSharePct =
    totalHits > 0
      ? Math.round((telemetry.cacheHitsInflight / totalHits) * 100)
      : 0;
  const errors = telemetry.errors ?? 0;
  const targets = dnsData.coreHosts?.length
    ? dnsData.coreHosts
    : (dnsData.hosts ?? []);

  return {
    capacityPct,
    totalHits,
    totalLookups,
    inflightSharePct,
    errors,
    badge: resolveDnsBadge(telemetry.hitRatePercent, errors),
    targets,
    observedUtc: formatUtcClock(dnsData.generatedAt ?? dnsData.updatedAt),
  };
}

const pillStyle = (
  color: string,
  bg: string,
  border: string,
): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "11px",
  fontWeight: 700,
  color,
  backgroundColor: bg,
  border: `1px solid ${border}`,
  whiteSpace: "nowrap",
});

export function SurveillanceTabPanel({
  dnsData,
  dnsRefreshing = false,
  dnsError = null,
  onRefreshDns,
  benchLoading,
  benchResult,
  onRunBenchmark,
  reverseIp,
  onReverseIpChange,
  reverseResult,
  onRunReverseLookup,
  viewMode,
  onViewModeChange,
  data,
  onSelectAgent,
}: SurveillanceTabPanelProps): React.ReactElement {
  const [hostsExpanded, setHostsExpanded] = useState(false);
  const [outlineExpanded, setOutlineExpanded] = useState(false);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const markdownRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const dnsSummary = dnsData ? computeDnsSummary(dnsData) : null;
  const briefSummary = useMemo(() => {
    if (!data) return null;
    return {
      ...extractMarkdownTelemetry(data.markdown, data.html, {
        ...(data.markdownBytes !== undefined
          ? { markdownBytes: data.markdownBytes }
          : {}),
        ...(data.htmlBytes !== undefined ? { htmlBytes: data.htmlBytes } : {}),
        ...(data.nonAsciiChars !== undefined
          ? { nonAsciiChars: data.nonAsciiChars }
          : {}),
      }),
      updatedUtc: formatUtcClock(data.updatedAt),
    };
  }, [data]);

  const handleCopyMarkdown = () => {
    if (!data || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(data.markdown).then(
      () => {
        setCopiedMarkdown(true);
        if (copyTimerRef.current !== null) {
          clearTimeout(copyTimerRef.current);
        }
        copyTimerRef.current = setTimeout(() => {
          setCopiedMarkdown(false);
        }, 1500);
      },
      () => {},
    );
  };

  const scrollToSection = (sectionIndex: number, sectionId: string | null) => {
    const container = markdownRef.current;
    if (!container) return;
    const byId =
      sectionId &&
      typeof CSS !== "undefined" &&
      typeof CSS.escape === "function"
        ? container.querySelector(`#${CSS.escape(sectionId)}`)
        : sectionId
          ? container.querySelector(`[id="${sectionId}"]`)
          : null;
    const target = byId ?? container.querySelectorAll("h2")?.[sectionIndex];
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <div>
      <ThresholdsPanel dataUpdatedAt={data?.updatedAt} />
      {/* Existing Surveillance & Telemetry View */}
      {dnsData && dnsSummary && (
        <div
          style={{
            ...styles.dnsBar,
            flexDirection: "column",
            alignItems: "stretch",
            gap: "10px",
          }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "12px 16px",
            }}
          >
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <span style={styles.dnsLabel}>🌐 Bun.dns Cache Telemetry:</span>
              <span
                style={pillStyle(
                  dnsSummary.badge.color,
                  dnsSummary.badge.bg,
                  dnsSummary.badge.border,
                )}
              >
                {dnsSummary.badge.label}
              </span>
            </div>

            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
              title={`${dnsData.telemetry.size} of ${DNS_CACHE_CAPACITY} LRU cache slots occupied (${dnsSummary.capacityPct}%)`}
            >
              <span>
                Size:{" "}
                <b>
                  {dnsData.telemetry.size}/{DNS_CACHE_CAPACITY}
                </b>
              </span>
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: "44px",
                  height: "6px",
                  borderRadius: "999px",
                  backgroundColor: "#1e293b",
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    display: "block",
                    width: `${Math.max(4, dnsSummary.capacityPct)}%`,
                    height: "100%",
                    backgroundColor:
                      dnsSummary.capacityPct >= 85 ? "#fbbf24" : "#38bdf8",
                  }}
                />
              </span>
              <span style={{ color: "#94a3b8", fontSize: "11px" }}>
                ({dnsSummary.capacityPct}%)
              </span>
            </span>

            <span>
              Hit Rate:{" "}
              <b style={{ color: dnsSummary.badge.color }}>
                {dnsData.telemetry.hitRatePercent}%
              </b>
            </span>
            <span>
              Hits (Completed): <b>{dnsData.telemetry.cacheHitsCompleted}</b>
            </span>
            <span>
              Hits (Inflight): <b>{dnsData.telemetry.cacheHitsInflight}</b>
              {dnsData.telemetry.cacheHitsInflight > 0 && (
                <span
                  style={{
                    marginLeft: "4px",
                    color: "#7dd3fc",
                    fontSize: "11px",
                  }}
                  title="Concurrent requests coalesced onto one active lookup"
                >
                  ({dnsSummary.inflightSharePct}% coalesced)
                </span>
              )}
            </span>
            <span>
              Misses: <b>{dnsData.telemetry.cacheMisses}</b>
            </span>
            <span>
              Lookups: <b>{dnsSummary.totalLookups}</b>
            </span>
            <span>
              Errors:{" "}
              <b
                style={{
                  color: dnsSummary.errors > 0 ? "#f87171" : "#94a3b8",
                }}
              >
                {dnsSummary.errors}
              </b>
            </span>
            <span>
              TTL: <b>{dnsData.telemetry.defaultTtlSeconds}s</b>
            </span>

            <div
              style={{
                marginLeft: "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                flexWrap: "wrap",
              }}
            >
              {dnsSummary.observedUtc && (
                <span
                  style={{
                    color: "#94a3b8",
                    fontSize: "11px",
                    fontFamily: "monospace",
                  }}
                  title="Server snapshot timestamp"
                >
                  {dnsSummary.observedUtc}
                </span>
              )}
              {dnsSummary.targets.length > 0 && (
                <button
                  type="button"
                  onClick={() => setHostsExpanded((prev) => !prev)}
                  style={{
                    padding: "3px 8px",
                    borderRadius: "4px",
                    backgroundColor: "rgba(56, 189, 248, 0.1)",
                    color: "#7dd3fc",
                    fontSize: "11px",
                    fontWeight: 600,
                    border: "1px solid rgba(56, 189, 248, 0.3)",
                    cursor: "pointer",
                  }}
                >
                  {hostsExpanded ? "▴" : "▾"} Prefetched Hosts (
                  {dnsSummary.targets.length})
                </button>
              )}
              {onRefreshDns && (
                <button
                  type="button"
                  onClick={onRefreshDns}
                  disabled={dnsRefreshing}
                  style={{
                    ...styles.actionBtnSmall,
                    opacity: dnsRefreshing ? 0.65 : 1,
                    cursor: dnsRefreshing ? "wait" : "pointer",
                  }}
                >
                  {dnsRefreshing ? "Refreshing..." : "↻ Refresh"}
                </button>
              )}
            </div>
          </div>

          {dnsError && (
            <div style={{ color: "#fca5a5", fontSize: "11px" }}>
              DNS refresh warning: {dnsError}
            </div>
          )}

          {hostsExpanded && dnsSummary.targets.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "8px",
                paddingTop: "8px",
                borderTop: "1px solid #1e293b",
              }}
            >
              {dnsSummary.targets.map((target) => {
                const endpoint = target.port
                  ? `${target.hostname}:${target.port}`
                  : target.hostname;
                return (
                  <span
                    key={endpoint}
                    title={target.serviceName ?? target.hostname}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "3px 8px",
                      borderRadius: "4px",
                      backgroundColor: "#091020",
                      border: "1px solid #1e293b",
                      fontSize: "11px",
                    }}
                  >
                    <code style={{ color: "#e2e8f0" }}>{endpoint}</code>
                    {target.serviceName && (
                      <span style={{ color: "#64748b" }}>
                        {target.serviceName}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div style={styles.toolsBar}>
        <div style={styles.toolItem}>
          <button
            type="button"
            style={styles.actionBtn}
            onClick={onRunBenchmark}
            disabled={benchLoading}
          >
            {benchLoading
              ? "Benchmarking..."
              : "⚡ Benchmark c-ares vs system (fantasy402.com)"}
          </button>
          {benchResult && <span style={styles.toolResult}>{benchResult}</span>}
        </div>
        <div style={styles.toolItem}>
          <input
            style={styles.input}
            value={reverseIp}
            onChange={(e) => onReverseIpChange(e.target.value)}
            placeholder="IP (e.g. 1.1.1.1)"
          />
          <button
            type="button"
            style={styles.actionBtn}
            onClick={onRunReverseLookup}
          >
            🔍 Reverse DNS & Forensics
          </button>
          {reverseResult && (
            <span style={styles.toolResult}>{reverseResult}</span>
          )}
        </div>
        <div style={styles.viewToggleGroup}>
          <button
            type="button"
            style={styles.toggleBtn(viewMode === "interactive")}
            onClick={() => onViewModeChange("interactive")}
          >
            Interactive
          </button>
          <button
            type="button"
            style={styles.toggleBtn(viewMode === "raw")}
            onClick={() => onViewModeChange("raw")}
          >
            Raw Markdown
          </button>
        </div>
      </div>

      {data && briefSummary ? (
        <div
          style={{
            backgroundColor: "#0d1527",
            borderRadius: "8px",
            border: "1px solid #1e293b",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "10px 14px",
              padding: "10px 16px",
              backgroundColor: "rgba(4, 7, 14, 0.55)",
              borderBottom: "1px solid #1e293b",
              fontSize: "12px",
              color: "#cbd5e1",
            }}
          >
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <span style={{ fontWeight: 700, color: "#f1f5f9" }}>
                📝 Surveillance Brief
              </span>
              <span
                style={pillStyle(
                  "#38bdf8",
                  "rgba(56, 189, 248, 0.14)",
                  "rgba(56, 189, 248, 0.4)",
                )}
                title="Rendered server-side by the native Markdown renderer (GFM tables, strikethrough, tasklists, autolinks, heading IDs, tagFilter)"
              >
                native markdown
              </span>
              {briefSummary.hasHeadingIds && (
                <span
                  style={pillStyle(
                    "#34d399",
                    "rgba(16, 185, 129, 0.12)",
                    "rgba(52, 211, 153, 0.35)",
                  )}
                  title="Heading ID anchors enabled (headings: { ids: true })"
                >
                  #ids
                </span>
              )}
              <code
                style={{
                  fontSize: "11px",
                  color: "#94a3b8",
                  backgroundColor: "#091020",
                  padding: "2px 6px",
                  borderRadius: "4px",
                  border: "1px solid #1e293b",
                }}
              >
                dashboard.md
              </code>
            </div>

            <span>
              Sections: <b>{briefSummary.sections.length}</b>
            </span>
            <span>
              Tables: <b>{briefSummary.tableCount}</b>
            </span>
            <span>
              Lines: <b>{briefSummary.lineCount}</b>
            </span>
            <span title="UTF-8 byte payload before and after the native render">
              Payload:{" "}
              <b>{(briefSummary.markdownBytes / 1024).toFixed(1)} KB</b> →{" "}
              <b>{(briefSummary.htmlBytes / 1024).toFixed(1)} KB</b>
            </span>
            <span title="Multibyte Unicode / emoji & typographic glyphs in Markdown input">
              Non-ASCII: <b>{briefSummary.nonAsciiChars} glyphs</b>
            </span>
            {data.renderDurationMs !== undefined && (
              <span title="Measured native Markdown parse and render duration">
                Render:{" "}
                <b style={{ color: "#34d399" }}>
                  {data.renderDurationMs.toFixed(2)} ms
                </b>
              </span>
            )}

            <div
              style={{
                marginLeft: "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                flexWrap: "wrap",
              }}
            >
              {briefSummary.updatedUtc && (
                <span
                  style={{
                    color: "#94a3b8",
                    fontSize: "11px",
                    fontFamily: "monospace",
                  }}
                  title="Server snapshot timestamp"
                >
                  {briefSummary.updatedUtc}
                </span>
              )}
              {viewMode === "interactive" &&
                briefSummary.sections.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setOutlineExpanded((prev) => !prev)}
                    style={{
                      padding: "3px 8px",
                      borderRadius: "4px",
                      backgroundColor: "rgba(56, 189, 248, 0.1)",
                      color: "#7dd3fc",
                      fontSize: "11px",
                      fontWeight: 600,
                      border: "1px solid rgba(56, 189, 248, 0.3)",
                      cursor: "pointer",
                    }}
                  >
                    {outlineExpanded ? "▴" : "▾"} Outline (
                    {briefSummary.sections.length})
                  </button>
                )}
              <button
                type="button"
                onClick={handleCopyMarkdown}
                style={styles.actionBtnSmall}
              >
                {copiedMarkdown ? "✓ Copied" : "⧉ Copy MD"}
              </button>
            </div>
          </div>

          {viewMode === "interactive" &&
            outlineExpanded &&
            briefSummary.sections.length > 0 && (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "6px",
                  padding: "8px 16px",
                  borderBottom: "1px solid #1e293b",
                  backgroundColor: "rgba(9, 16, 32, 0.7)",
                }}
              >
                {briefSummary.sections.map((section) =>
                  section.id ? (
                    <a
                      key={`${section.index}-${section.id}`}
                      href={`#${section.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        scrollToSection(section.index, section.id);
                      }}
                      style={{
                        padding: "3px 9px",
                        borderRadius: "999px",
                        backgroundColor: "#0d1527",
                        border: "1px solid #1e293b",
                        color: "#cbd5e1",
                        fontSize: "11px",
                        fontWeight: 600,
                        textDecoration: "none",
                        cursor: "pointer",
                      }}
                    >
                      {section.text}
                    </a>
                  ) : (
                    <button
                      key={`${section.index}-${section.text}`}
                      type="button"
                      onClick={() => scrollToSection(section.index, null)}
                      style={{
                        padding: "3px 9px",
                        borderRadius: "999px",
                        backgroundColor: "#0d1527",
                        border: "1px solid #1e293b",
                        color: "#cbd5e1",
                        fontSize: "11px",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      {section.text}
                    </button>
                  ),
                )}
              </div>
            )}

          {viewMode === "interactive" ? (
            <div
              ref={markdownRef}
              className="sd-markdown-doc"
              style={{
                ...styles.renderedHtml,
                border: "none",
                borderRadius: 0,
              }}
              onClick={(e) => {
                const target = e.target as HTMLElement | null;
                const anchor = target?.closest?.("a");
                if (!anchor) return;
                const href = anchor.getAttribute("href") ?? "";
                if (href.startsWith("#") && href.length > 1) {
                  e.preventDefault();
                  scrollToSection(0, href.slice(1));
                  return;
                }
                if (!onSelectAgent) return;
                const agentMatch = /^\/agent\/([^/?#]+)/i.exec(href);
                if (
                  agentMatch?.[1] &&
                  !e.metaKey &&
                  !e.ctrlKey &&
                  e.button === 0
                ) {
                  e.preventDefault();
                  onSelectAgent(decodeURIComponent(agentMatch[1]));
                }
              }}
              dangerouslySetInnerHTML={{ __html: data.html }}
            />
          ) : (
            <pre
              style={{
                ...styles.rawMarkdown,
                border: "none",
                borderRadius: 0,
                margin: 0,
              }}
            >
              {data.markdown}
            </pre>
          )}
        </div>
      ) : (
        <div style={styles.loading}>
          Loading real-time surveillance dashboard...
        </div>
      )}
    </div>
  );
}
