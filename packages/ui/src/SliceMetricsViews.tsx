/**
 * @file src/dashboard/SliceMetricsViews.tsx
 * @description Feature-gated Typed `SliceMetrics` SoA DataTable, Ex-Blocked /
 * Ex-Directional Blended Hold SLO strip, and Pre/Post-Trade `{policy, block_enforced}` DiffView.
 */

import React, { useEffect, useRef, useState } from "react";
import { SliceMetricsSoASpine } from "@sportsdesk-ops/contracts/slice-data-table";
import type {
  SliceFlag,
  SliceMetrics,
  SlicePolicy,
} from "@sportsdesk-ops/contracts/slice-metrics";
import type {
  RouterAuditMode,
  SliceMetricsDashboardBundle,
} from "@sportsdesk-ops/contracts/shadow-pricing";

export interface SliceMetricsViewsProps {
  readonly bundle: SliceMetricsDashboardBundle;
  readonly routerAuditMode: RouterAuditMode;
  readonly onChangeRouterAuditMode: (mode: RouterAuditMode) => void;
}

function formatUsdCompact(val: number): string {
  const sign = val < 0 ? "-" : "";
  const abs = Math.abs(val);
  if (abs >= 1_000_000) {
    return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}$${Math.round(abs).toLocaleString()}`;
  }
  return `${sign}$${abs.toFixed(0)}`;
}

function formatSignedUsd(val: number): string {
  const abs = Math.abs(Math.round(val)).toLocaleString();
  if (val > 0) return `+$${abs}`;
  if (val < 0) return `-$${abs}`;
  return "$0";
}

function formatSignedPct(val: number): string {
  const fixed = val.toFixed(2);
  return val > 0 ? `+${fixed}%` : `${fixed}%`;
}

function renderSlicePolicyPill(policy: SlicePolicy): React.ReactElement {
  if (policy === "BLOCKED") {
    return <span className="sd-pill sd-pill-blocked">BLOCKED</span>;
  }
  if (policy === "LEAK") {
    return <span className="sd-pill sd-pill-alert">LEAK</span>;
  }
  if (policy === "ADVANTAGE") {
    return <span className="sd-pill sd-pill-live">ADVANTAGE</span>;
  }
  return <span className="sd-pill">PRESERVE</span>;
}

function renderFlagBadge(flag: SliceFlag): React.ReactElement {
  if (flag === "POLICY_DATA_CONFLICT" || flag === "BUY_SHARE_EXTREME") {
    return (
      <span key={flag} className="sd-pill sd-pill-alert sd-mono">
        {flag}
      </span>
    );
  }
  if (flag === "HOLD_BELOW_FLOOR" || flag === "DIRECTIONAL_DOMINANT") {
    return (
      <span key={flag} className="sd-pill sd-pill-fixture sd-mono">
        {flag}
      </span>
    );
  }
  return (
    <span key={flag} className="sd-pill sd-pill-blocked sd-mono">
      {flag}
    </span>
  );
}

export function SliceMetricsViews({
  bundle,
  routerAuditMode,
  onChangeRouterAuditMode,
}: SliceMetricsViewsProps): React.ReactElement {
  const spineRef = useRef<SliceMetricsSoASpine | null>(null);
  if (spineRef.current === null) {
    spineRef.current = new SliceMetricsSoASpine(64);
  }

  const [flushVersion, setFlushVersion] = useState<number>(0);
  const [flaggedOnly, setFlaggedOnly] = useState<boolean>(false);

  // Stream flush boundary: compute derived columns & flags ONCE per incoming bundle, NOT per render.
  useEffect(() => {
    const nextGen = spineRef.current!.flush(bundle.rows);
    setFlushVersion(nextGen);
  }, [bundle]);

  const spine = spineRef.current;
  const soaRows: readonly SliceMetrics[] =
    flushVersion > 0 && spine.rowCount > 0 ? spine.readAllRows() : bundle.rows;

  const visibleRows = flaggedOnly
    ? soaRows.filter((r) => r.flags.length > 0)
    : soaRows;
  const flaggedCount = soaRows.filter((r) => r.flags.length > 0).length;
  const slo = bundle.blendedHoldSlo;
  const diff = bundle.policyDiff;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* 1. Ex-Blocked & Ex-Directional Blended Hold SLO Banner */}
      <div
        className="sd-card"
        style={{
          borderLeft: slo.slo_met
            ? "4px solid var(--sd-theme-emerald)"
            : "4px solid var(--sd-tier-alert)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "10px",
            marginBottom: "12px",
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
            <strong style={{ fontSize: "14px" }}>
              🎯 Blended Hold SLO Decomposition (Ex-Blocked &amp;
              Ex-Directional)
            </strong>
            <span
              className={`sd-pill sd-mono ${slo.slo_met ? "sd-pill-live" : "sd-pill-alert"}`}
            >
              {slo.slo_met
                ? `● SLO MET (${slo.slo_hold_pct.toFixed(2)}% ≥ ${slo.slo_floor_pct.toFixed(2)}%)`
                : `▲ BELOW SLO (${slo.slo_hold_pct.toFixed(2)}% vs ${slo.slo_floor_pct.toFixed(2)}% floor · ${formatSignedPct(slo.slo_delta_pct)})`}
            </span>
          </div>
          <span className="sd-pill sd-mono">
            Floor SSOT: config/wager_tiers.toml · Flagged Slices: {flaggedCount}
            /{soaRows.length}
          </span>
        </div>

        <div className="sd-kpi-grid">
          <div className="sd-kpi-box">
            <div className="sd-kpi-label">
              Raw Blended Hold (All Slices — Misleading)
            </div>
            <div
              className="sd-kpi-value sd-mono"
              style={{ color: "var(--sd-text-muted)" }}
            >
              {slo.raw_blended_hold_pct.toFixed(2)}%
            </div>
            <div className="sd-kpi-sub">
              {formatUsdCompact(slo.blocked_handle_usd)} (
              {slo.blocked_handle_share_pct.toFixed(1)}%) sits on BLOCKED slices
            </div>
          </div>

          <div className="sd-kpi-box">
            <div className="sd-kpi-label">
              Ex-Blocked Hold (Active Slices Total)
            </div>
            <div
              className="sd-kpi-value sd-mono"
              style={{
                color:
                  slo.ex_blocked_hold_pct >= slo.slo_floor_pct
                    ? "var(--sd-theme-emerald)"
                    : "var(--sd-tier-fixture, var(--sd-tier-steam))",
              }}
            >
              {slo.ex_blocked_hold_pct.toFixed(2)}%
            </div>
            <div className="sd-kpi-sub">
              Active handle {formatUsdCompact(slo.active_handle_usd)} · Dir
              P&amp;L {formatSignedUsd(slo.active_directional_pnl_usd)}
            </div>
          </div>

          <div className="sd-kpi-box">
            <div className="sd-kpi-label">
              Blended Hold SLO (Ex-Blocked · Ex-Directional)
            </div>
            <div
              className="sd-kpi-value sd-mono"
              style={{
                color: slo.slo_met
                  ? "var(--sd-theme-emerald)"
                  : "var(--sd-tier-alert)",
              }}
            >
              {slo.ex_blocked_ex_directional_hold_pct.toFixed(2)}%
            </div>
            <div className="sd-kpi-sub">
              Pure balanced-book vig (
              {formatUsdCompact(slo.active_vig_capture_usd)}) vs{" "}
              {slo.slo_floor_pct.toFixed(2)}% target
            </div>
          </div>

          <div className="sd-kpi-box">
            <div className="sd-kpi-label">
              Hold-Floor Fallback Chain &amp; SoA Spine
            </div>
            <div
              className="sd-kpi-value sd-mono"
              style={{
                fontSize: "15px",
                color: bundle.floorFallbackSlo.slo_met
                  ? "var(--sd-theme-emerald)"
                  : "var(--sd-tier-alert)",
              }}
            >
              {bundle.floorFallbackSlo.slo_met
                ? `0% default fallback (${bundle.floorFallbackSlo.counts_by_tier.by_slice}s/${bundle.floorFallbackSlo.counts_by_tier.by_sport}sp/${bundle.floorFallbackSlo.counts_by_tier.by_market}m)`
                : `▲ ${bundle.floorFallbackSlo.default_slice_share_pct.toFixed(1)}% default fallback`}
            </div>
            <div className="sd-kpi-sub">
              Flush #{spine.flushCount} · Reads #{spine.renderReadCount} (
              {spine.derivedRowComputeCount} evals)
            </div>
          </div>
        </div>
      </div>

      {/* 2. Typed SliceMetrics DataTable (SoA Spine) */}
      <div className="sd-card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "10px",
            marginBottom: "10px",
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
            <strong style={{ fontSize: "13px" }}>
              🧬 Typed SliceMetrics DataTable (SoA Columnar Spine · Split Policy
              &amp; Hold Decomposition)
            </strong>
            <span className="sd-pill sd-mono">
              Float64Array / Uint32Array Bitsets
            </span>
          </div>

          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <button
              type="button"
              className="sd-preset-btn"
              data-active={flaggedOnly ? "true" : "false"}
              onClick={() => setFlaggedOnly((prev) => !prev)}
            >
              {flaggedOnly
                ? `⚑ Showing Flagged (${flaggedCount})`
                : `⚑ Filter Flagged Only (${flaggedCount}/${soaRows.length})`}
            </button>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table className="sd-soa-table">
            <thead>
              <tr>
                <th>Sport</th>
                <th>League</th>
                <th>Period</th>
                <th>Market</th>
                <th>Legs</th>
                <th>Buy / Sell %</th>
                <th>Handle</th>
                <th>Net Position</th>
                <th>Vig Capture %</th>
                <th>Directional P&amp;L</th>
                <th>Hold Total %</th>
                <th>Gross Hold</th>
                <th>Floor Δ (% / $)</th>
                <th>Policy · Mechanism</th>
                <th>Router Enforced</th>
                <th>Gate Flags</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.slice_id}>
                  <td>
                    <strong>{row.sport}</strong>
                  </td>
                  <td>{row.league}</td>
                  <td className="sd-mono">{row.period}</td>
                  <td>{row.market}</td>
                  <td className="sd-mono">{row.legs.toLocaleString()}</td>
                  <td className="sd-mono">
                    {row.buy_share_pct.toFixed(2)}% /{" "}
                    <span style={{ color: "var(--sd-text-muted)" }}>
                      {row.sell_share_pct.toFixed(2)}%
                    </span>
                  </td>
                  <td className="sd-mono">
                    {formatUsdCompact(row.handle_usd)}
                  </td>
                  <td
                    className="sd-mono"
                    style={{
                      color:
                        Math.abs(row.net_position_usd) > 2_500_000
                          ? "var(--sd-tier-alert)"
                          : "var(--sd-text-primary)",
                    }}
                  >
                    {formatSignedUsd(row.net_position_usd)}
                  </td>
                  <td className="sd-mono">
                    {row.vig_capture_pct !== null
                      ? `${row.vig_capture_pct.toFixed(2)}%`
                      : "NULL"}
                  </td>
                  <td
                    className="sd-mono"
                    style={{
                      color:
                        row.directional_pnl_usd === null
                          ? "var(--sd-text-muted)"
                          : row.directional_pnl_usd >= 0
                            ? "var(--sd-theme-emerald)"
                            : "var(--sd-tier-alert)",
                    }}
                  >
                    {row.directional_pnl_usd !== null
                      ? formatSignedUsd(row.directional_pnl_usd)
                      : "NULL"}
                  </td>
                  <td
                    className="sd-mono"
                    style={{
                      fontWeight: 700,
                      color:
                        row.hold_total_pct >= 0
                          ? "var(--sd-theme-emerald)"
                          : "var(--sd-tier-alert)",
                    }}
                  >
                    {row.hold_total_pct.toFixed(2)}%
                  </td>
                  <td
                    className="sd-mono"
                    style={{
                      color:
                        row.gross_hold_usd >= 0
                          ? "var(--sd-theme-emerald)"
                          : "var(--sd-tier-alert)",
                    }}
                  >
                    {formatSignedUsd(row.gross_hold_usd)}
                  </td>
                  <td
                    className="sd-mono"
                    style={{
                      color:
                        row.floor_delta_pct >= 0
                          ? "var(--sd-theme-emerald)"
                          : "var(--sd-tier-alert)",
                    }}
                    title={`Configured floor: ${row.hold_floor_pct.toFixed(2)}% (resolved_via: ${row.hold_floor_resolved_via ?? "unspecified"})`}
                  >
                    <div>
                      {formatSignedPct(row.floor_delta_pct)} (
                      {formatUsdCompact(row.floor_delta_usd)})
                    </div>
                    <div
                      style={{
                        fontSize: "10px",
                        color:
                          row.hold_floor_resolved_via === "default" ||
                          row.hold_floor_resolved_via === null
                            ? "var(--sd-tier-alert)"
                            : "var(--sd-text-muted)",
                      }}
                    >
                      {row.hold_floor_pct.toFixed(2)}% ·{" "}
                      {row.hold_floor_resolved_via ?? "untracked"}
                    </div>
                  </td>
                  <td>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "3px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          gap: "4px",
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        {renderSlicePolicyPill(row.policy)}
                        <code style={{ fontSize: "10px" }}>
                          {row.policy_mechanism}
                        </code>
                      </div>
                      {row.policy_qualifier !== "" ? (
                        <span
                          style={{
                            fontSize: "10px",
                            color: "var(--sd-text-muted)",
                          }}
                        >
                          {row.policy_qualifier}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="sd-mono">
                    {row.block_enforced ? (
                      <span className="sd-pill sd-pill-live">true (0 ord)</span>
                    ) : (
                      <span className="sd-pill sd-pill-alert">
                        false (&gt;0 ord)
                      </span>
                    )}
                  </td>
                  <td>
                    {row.flags.length === 0 ? (
                      <span className="sd-pill sd-pill-live sd-mono">
                        CLEAN
                      </span>
                    ) : (
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "4px",
                        }}
                      >
                        {row.flags.map((f) => renderFlagBadge(f))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 3. Pre/Post-Trade DiffView ({ policy, block_enforced }) */}
      <div
        className="sd-card"
        style={{
          borderLeft: diff.has_critical_alert
            ? "4px solid var(--sd-tier-alert)"
            : "4px solid var(--sd-theme-emerald)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "10px",
            marginBottom: "10px",
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
            <strong style={{ fontSize: "13px" }}>
              🔀 Pre/Post-Trade Router DiffView (Pair:{" "}
              <code>{"{ policy, block_enforced }"}</code>)
            </strong>
            {diff.has_critical_alert ? (
              <span className="sd-pill sd-pill-alert sd-mono">
                🚨 {diff.alerts.length} BLOCK_ENFORCED_FLIPPED_FALSE ALERT
                {diff.alerts.length === 1 ? "" : "S"}
              </span>
            ) : (
              <span className="sd-pill sd-pill-live sd-mono">
                ✓ 0 Router Block Regressions
              </span>
            )}
          </div>

          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <button
              type="button"
              className="sd-preset-btn"
              data-active={
                routerAuditMode === "observed_ledger" ? "true" : "false"
              }
              onClick={() => onChangeRouterAuditMode("observed_ledger")}
            >
              Observed Ledger Orders (Post-Block Leak)
            </button>
            <button
              type="button"
              className="sd-preset-btn"
              data-active={
                routerAuditMode === "enforced_lockout" ? "true" : "false"
              }
              onClick={() => onChangeRouterAuditMode("enforced_lockout")}
            >
              Hard Router Lockout (0 Post-Block Orders)
            </button>
          </div>
        </div>

        {diff.has_critical_alert ? (
          <div
            style={{
              marginBottom: "10px",
              padding: "8px 12px",
              borderRadius: "6px",
              border: "1px solid var(--sd-tier-alert)",
              fontSize: "12px",
              color: "var(--sd-tier-alert)",
            }}
          >
            {diff.alerts.map((a) => (
              <div key={a.slice_id} className="sd-mono">
                • {a.alert_message}
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ overflowX: "auto" }}>
          <table className="sd-soa-table">
            <thead>
              <tr>
                <th>Slice ID</th>
                <th>Pre-Trade Pair</th>
                <th>Post-Trade Router Pair</th>
                <th>Changed</th>
                <th>Gate Alert</th>
              </tr>
            </thead>
            <tbody>
              {diff.entries.map((entry) => (
                <tr key={entry.slice_id}>
                  <td className="sd-mono">{entry.slice_id}</td>
                  <td className="sd-mono">
                    {entry.pre
                      ? `{ policy: "${entry.pre.policy}", block_enforced: ${String(entry.pre.block_enforced)} }`
                      : "—"}
                  </td>
                  <td className="sd-mono">
                    {entry.post
                      ? `{ policy: "${entry.post.policy}", block_enforced: ${String(entry.post.block_enforced)} }`
                      : "—"}
                  </td>
                  <td className="sd-mono">
                    {entry.changed ? "CHANGED" : "UNCHANGED"}
                  </td>
                  <td>
                    {entry.alert !== null ? (
                      <span className="sd-pill sd-pill-alert sd-mono">
                        🚨 {entry.alert}
                      </span>
                    ) : (
                      <span className="sd-pill sd-pill-live sd-mono">OK</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
