import type React from "react";
import { useState } from "react";
import {
  DASHBOARD_API,
  DASHBOARD_FRESHNESS,
  DASHBOARD_LEAGUES,
  DASHBOARD_META,
  DASHBOARD_PANELS,
  DASHBOARD_THRESHOLDS,
  dashboardApiUrl,
} from "../config/dashboard.ts";
import { styles } from "../dashboard_styles.ts";

export interface ThresholdsPanelProps {
  /** Optional live feed update ISO timestamp used for SLA freshness calculation. */
  readonly dataUpdatedAt?: string | null | undefined;
  /** Optional reference clock in epoch milliseconds for deterministic testing. */
  readonly nowMs?: number | undefined;
}

type FreshnessState = "fresh" | "stale" | "critical";

interface FreshnessSummary {
  readonly state: FreshnessState;
  readonly isStale: boolean;
  readonly sourceLabel: "feed" | "config";
  readonly ageLabel: string;
}

function formatElapsedMinutes(totalMinutes: number): string {
  if (totalMinutes < 1) return "<1m";
  const rounded = Math.round(totalMinutes);
  if (rounded < 60) return `${rounded}m`;
  const days = Math.floor(rounded / 1440);
  const hours = Math.floor((rounded % 1440) / 60);
  const mins = rounded % 60;
  if (days > 0) return `${days}d ${hours}h`;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function computeFreshnessSummary(
  dataUpdatedAt: string | null | undefined,
  nowMs: number,
): FreshnessSummary {
  const sourceLabel = dataUpdatedAt ? "feed" : "config";
  const referenceIso = dataUpdatedAt || DASHBOARD_META.generated_at;
  const parsed = Date.parse(referenceIso);
  if (Number.isNaN(parsed)) {
    return {
      state: "fresh",
      isStale: false,
      sourceLabel,
      ageLabel: "n/a",
    };
  }
  const ageMinutes = Math.max(0, (nowMs - parsed) / 60_000);
  const criticalMinutes =
    DASHBOARD_FRESHNESS.critical_after_minutes ??
    DASHBOARD_FRESHNESS.stale_after_minutes * 4;
  const state: FreshnessState =
    ageMinutes > criticalMinutes
      ? "critical"
      : ageMinutes > DASHBOARD_FRESHNESS.stale_after_minutes
        ? "stale"
        : "fresh";
  return {
    state,
    isStale: state !== "fresh",
    sourceLabel,
    ageLabel: formatElapsedMinutes(ageMinutes),
  };
}

const API_ROUTE_ENTRIES: readonly (readonly [string, string])[] = [
  ["dashboard", DASHBOARD_API.dashboard],
  ["tiers", DASHBOARD_API.tiers],
  ["customers", DASHBOARD_API.customers],
  ["wagers", DASHBOARD_API.wagers],
  ["bet_ticker", DASHBOARD_API.bet_ticker],
  ["r2_pipeline", DASHBOARD_API.r2_pipeline],
  ["dns", DASHBOARD_API.dns],
  ["health", DASHBOARD_API.health],
];

/**
 * Renders the dispatch thresholds, feed routes, and SLA budgets inlined from
 * `packages/ui/src/config/dashboard.toml`.
 *
 * Reading `DASHBOARD_THRESHOLDS.sharp` keeps the tree-shake probe honest:
 * `scripts/validate_dashboard_config.ts` asserts `"sharp"` is inlined in
 * `dist/dashboard/*.js` while unimported `[churn]` is eliminated.
 */
export function ThresholdsPanel({
  dataUpdatedAt = null,
  nowMs = Date.now(),
}: ThresholdsPanelProps = {}): React.ReactElement {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const freshness = computeFreshnessSummary(dataUpdatedAt, nowMs);
  const steamPct = `${(DASHBOARD_THRESHOLDS.steam * 100).toFixed(1)}%`;
  const primarySet = new Set(DASHBOARD_LEAGUES.primary);

  const badgeColors =
    freshness.state === "critical"
      ? {
          accent: "#ef4444",
          fg: "#fca5a5",
          bg: "rgba(239, 68, 68, 0.16)",
          border: "rgba(248, 113, 113, 0.45)",
          label: "CRITICAL",
        }
      : freshness.state === "stale"
        ? {
            accent: "#f59e0b",
            fg: "#fbbf24",
            bg: "rgba(245, 158, 11, 0.16)",
            border: "rgba(251, 191, 36, 0.4)",
            label: "STALE",
          }
        : {
            accent: "#10b981",
            fg: "#34d399",
            bg: "rgba(16, 185, 129, 0.14)",
            border: "rgba(52, 211, 153, 0.4)",
            label: "FRESH",
          };

  return (
    <div
      style={{
        ...styles.dnsBar,
        flexDirection: "column",
        alignItems: "stretch",
        gap: "10px",
        borderLeft: `3px solid ${badgeColors.accent}`,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "10px 14px",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span style={styles.dnsLabel}>⚙ Dispatch thresholds:</span>
          <span
            title={`Evaluating ${freshness.sourceLabel} timestamp against ${DASHBOARD_FRESHNESS.stale_after_minutes}m stale / ${DASHBOARD_FRESHNESS.critical_after_minutes}m critical SLA`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px 8px",
              borderRadius: "999px",
              fontSize: "11px",
              fontWeight: 700,
              color: badgeColors.fg,
              backgroundColor: badgeColors.bg,
              border: `1px solid ${badgeColors.border}`,
            }}
          >
            {badgeColors.label} · {freshness.sourceLabel} {freshness.ageLabel}
          </span>
        </div>

        <span
          title="Composite percentile gate & 10-point sharp rating floors"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "2px 8px",
            borderRadius: "4px",
            backgroundColor: "#091020",
            border: "1px solid #1e293b",
          }}
        >
          Sharp:{" "}
          <b style={{ color: "#f1f5f9" }}>{DASHBOARD_THRESHOLDS.sharp}</b>
          <span style={{ color: "#94a3b8", fontSize: "11px" }}>
            (score &ge;{DASHBOARD_THRESHOLDS.sharp_score} · elite &ge;
            {DASHBOARD_THRESHOLDS.elite_sharp_score})
          </span>
        </span>

        <span
          title="Minimum consensus movement delta and CLV alert floor"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "2px 8px",
            borderRadius: "4px",
            backgroundColor: "#091020",
            border: "1px solid #1e293b",
          }}
        >
          Steam:{" "}
          <b style={{ color: "#f1f5f9" }}>{DASHBOARD_THRESHOLDS.steam}</b>
          <span style={{ color: "#94a3b8", fontSize: "11px" }}>
            ({steamPct} · CLV &ge;{DASHBOARD_THRESHOLDS.clv_alert_bps} bps)
          </span>
        </span>

        <span
          title="High-risk single wager & sub-agent conduit concentration alert gates"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "2px 8px",
            borderRadius: "4px",
            backgroundColor: "#091020",
            border: "1px solid #1e293b",
          }}
        >
          Risk Gate:{" "}
          <b style={{ color: "#f1f5f9" }}>
            ${DASHBOARD_THRESHOLDS.high_risk_wager_usd.toLocaleString("en-US")}
          </b>
          <span style={{ color: "#94a3b8", fontSize: "11px" }}>
            (conduit &ge;{DASHBOARD_THRESHOLDS.conduit_concentration_pct}%)
          </span>
        </span>

        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "6px",
          }}
        >
          <span>Leagues ({DASHBOARD_LEAGUES.names.length}):</span>
          {DASHBOARD_LEAGUES.names.map((league) => {
            const isPrimary = primarySet.has(league);
            return (
              <span
                key={league}
                style={{
                  padding: "1px 7px",
                  borderRadius: "999px",
                  backgroundColor: isPrimary
                    ? "rgba(56, 189, 248, 0.14)"
                    : "rgba(30, 41, 59, 0.55)",
                  border: `1px solid ${
                    isPrimary
                      ? "rgba(56, 189, 248, 0.35)"
                      : "rgba(100, 116, 139, 0.35)"
                  }`,
                  color: isPrimary ? "#e2e8f0" : "#94a3b8",
                  fontWeight: 700,
                  fontSize: "11px",
                }}
              >
                {league}
              </span>
            );
          })}
        </span>

        <div
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: "10px",
            flexWrap: "wrap",
          }}
        >
          <span style={styles.dnsLabel}>
            dashboard.toml v{DASHBOARD_META.version} (
            {DASHBOARD_META.generated_at.slice(0, 10)}) · stale &gt;
            {DASHBOARD_FRESHNESS.stale_after_minutes}m
          </span>
          <button
            type="button"
            onClick={() => setDetailsOpen((prev) => !prev)}
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
            {detailsOpen ? "▴ Config SSOT" : "▾ Config SSOT"}
          </button>
        </div>
      </div>

      {detailsOpen && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px 16px",
            paddingTop: "8px",
            borderTop: "1px solid #1e293b",
            fontSize: "11px",
            color: "#94a3b8",
          }}
        >
          <span>
            Schema:{" "}
            <code style={{ color: "#e2e8f0" }}>{DASHBOARD_META.schema}</code>
          </span>
          <span>
            Snapshot:{" "}
            <code style={{ color: "#e2e8f0" }}>
              {DASHBOARD_META.generated_at}
            </code>
          </span>
          <span>
            Polling:{" "}
            <code style={{ color: "#e2e8f0" }}>
              dash {DASHBOARD_FRESHNESS.poll_dashboard_seconds}s · wagers{" "}
              {DASHBOARD_FRESHNESS.poll_wagers_seconds}s · dns{" "}
              {DASHBOARD_FRESHNESS.poll_dns_seconds}s
            </code>
          </span>
          <span>
            Panels:{" "}
            <code style={{ color: "#e2e8f0" }}>
              page {DASHBOARD_PANELS.customers_page_size} · wagers{" "}
              {DASHBOARD_PANELS.live_wagers_limit} · ticker{" "}
              {DASHBOARD_PANELS.ticker_max_rows}
            </code>
          </span>
          <span>
            API base:{" "}
            <code style={{ color: "#e2e8f0" }}>
              {DASHBOARD_API.base || "same-origin"}
            </code>
          </span>
          {API_ROUTE_ENTRIES.map(([name, routePath]) => (
            <span key={name}>
              {name}:{" "}
              <code style={{ color: "#7dd3fc" }}>
                {dashboardApiUrl(routePath)}
              </code>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
