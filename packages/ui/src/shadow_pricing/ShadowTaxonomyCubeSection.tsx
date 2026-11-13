/**
 * @file packages/ui/src/shadow_pricing/ShadowTaxonomyCubeSection.tsx
 * @description 4-Axis Taxonomy Slice Selector, Active Slice Summary Strip, and
 * Interactive 4-Dimension Exposure & Hold Matrix Explorer.
 */

import React from "react";
import type {
  MarketCode,
  MarketFilter,
  PeriodFilter,
  ShadowPricingDashboardPayload,
  SportCode,
  SportFilter,
  SubSportCode,
  SubSportFilter,
  TaxonomyRollupRow,
} from "@sportsdesk-ops/contracts/shadow-pricing";
import {
  type CubeTab,
  formatCompactLegs,
  formatSignedUsd,
  formatUsd,
  QUICK_SLICE_PRESETS,
  type QuickSlicePreset,
  renderPolicyBadge,
  renderRiskBadge,
  SPORT_ICONS,
} from "./shared.tsx";

export interface ShadowTaxonomyCubeSectionProps {
  readonly taxonomy: ShadowPricingDashboardPayload["taxonomy"] | undefined;
  readonly sport: SportFilter;
  readonly subSport: SubSportFilter;
  readonly period: PeriodFilter;
  readonly market: MarketFilter;
  readonly cubeTab: CubeTab;
  readonly hasAnyDimensionFilter: boolean;
  readonly onSelectSport: (nextSport: SportFilter) => void;
  readonly onSelectSubSport: (nextSubSport: SubSportFilter) => void;
  readonly onSelectPeriod: (nextPeriod: PeriodFilter) => void;
  readonly onSelectMarket: (nextMarket: MarketFilter) => void;
  readonly onSelectCubeTab: (nextTab: CubeTab) => void;
  readonly onApplyQuickPreset: (preset: QuickSlicePreset) => void;
  readonly onResetSlice: () => void;
  readonly onDrillRow: (row: TaxonomyRollupRow) => void;
}

export function ShadowTaxonomyCubeSection({
  taxonomy,
  sport,
  subSport,
  period,
  market,
  cubeTab,
  hasAnyDimensionFilter,
  onSelectSport,
  onSelectSubSport,
  onSelectPeriod,
  onSelectMarket,
  onSelectCubeTab,
  onApplyQuickPreset,
  onResetSlice,
  onDrillRow,
}: ShadowTaxonomyCubeSectionProps): React.ReactElement {
  const activeSlice = taxonomy?.activeSlice;
  const activeCubeRows: readonly TaxonomyRollupRow[] = taxonomy
    ? cubeTab === "sport"
      ? taxonomy.bySport
      : cubeTab === "subSport"
        ? taxonomy.bySubSport
        : cubeTab === "period"
          ? taxonomy.byPeriod
          : taxonomy.byMarket
    : [];

  return (
    <>
      {/* 4-Axis Hierarchical Selector Card: Sport -> Sub-Sport -> Period (per Sub-Sport) -> Market */}
      <div className="sd-card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "8px",
            marginBottom: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <strong style={{ fontSize: "13px" }}>
              🧭 4-Axis Taxonomy Slice Selector
            </strong>
            {activeSlice ? (
              <code style={{ fontSize: "11px" }}>{activeSlice.breadcrumb}</code>
            ) : null}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {QUICK_SLICE_PRESETS.map((qp) => {
              const isPresetActive =
                sport === qp.sport &&
                subSport === qp.subSport &&
                period === qp.period &&
                market === qp.market;
              return (
                <button
                  key={qp.label}
                  type="button"
                  className="sd-dim-chip"
                  data-active={isPresetActive ? "true" : "false"}
                  onClick={() => onApplyQuickPreset(qp)}
                >
                  {qp.label}
                </button>
              );
            })}
            {hasAnyDimensionFilter ? (
              <button
                type="button"
                className="sd-dim-chip"
                onClick={onResetSlice}
              >
                ↺ Reset Slice
              </button>
            ) : null}
          </div>
        </div>

        {/* Axis 1: Sport */}
        <div className="sd-dim-row">
          <div className="sd-dim-label">1. Sport / Mode</div>
          <div className="sd-chip-strip">
            <button
              type="button"
              className="sd-dim-chip"
              data-active={sport === "ALL" ? "true" : "false"}
              onClick={() => onSelectSport("ALL")}
            >
              All Sports
            </button>
            {(taxonomy?.bySport ?? []).map((spRow) => {
              const code = spRow.code as SportCode;
              const icon = SPORT_ICONS[code] ?? "•";
              return (
                <button
                  key={spRow.code}
                  type="button"
                  className="sd-dim-chip"
                  data-active={sport === spRow.code ? "true" : "false"}
                  onClick={() => onSelectSport(code)}
                >
                  <span>
                    {icon} {spRow.code}
                  </span>
                  <span className="sd-dim-count sd-mono">
                    {formatCompactLegs(spRow.totalLegs)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Axis 2: Sub-Sport (scoped dynamically to Sport) */}
        <div className="sd-dim-row">
          <div className="sd-dim-label">2. Sub-Sport</div>
          <div className="sd-chip-strip">
            <button
              type="button"
              className="sd-dim-chip"
              data-active={subSport === "ALL" ? "true" : "false"}
              onClick={() => onSelectSubSport("ALL")}
            >
              {sport === "ALL" ? "All Sub-Sports" : `All ${sport} Leagues`}
            </button>
            {(taxonomy?.bySubSport ?? []).map((subRow) => {
              const spec = taxonomy?.catalog.find(
                (c) => c.code === subRow.code,
              );
              return (
                <button
                  key={subRow.code}
                  type="button"
                  className="sd-dim-chip"
                  data-active={subSport === subRow.code ? "true" : "false"}
                  onClick={() => onSelectSubSport(subRow.code as SubSportCode)}
                  title={subRow.primaryRiskVector}
                >
                  <span>{spec?.shortLabel ?? subRow.label}</span>
                  <span className="sd-dim-count sd-mono">
                    {formatCompactLegs(subRow.totalLegs)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Axis 3: Period per Sub-Sport (dynamically scoped to validPeriods of selected Sub-Sport!) */}
        <div className="sd-dim-row">
          <div className="sd-dim-label">
            3. Period{" "}
            <span style={{ fontWeight: 400, opacity: 0.75 }}>
              ({subSport === "ALL" ? "valid set" : subSport})
            </span>
          </div>
          <div className="sd-chip-strip">
            <button
              type="button"
              className="sd-dim-chip"
              data-active={period === "ALL" ? "true" : "false"}
              onClick={() => onSelectPeriod("ALL")}
            >
              All Valid Periods
            </button>
            {(activeSlice?.validPeriodsForSelection ?? []).map((vp) => {
              const pRow = taxonomy?.byPeriod.find((r) => r.code === vp.code);
              return (
                <button
                  key={vp.code}
                  type="button"
                  className="sd-dim-chip"
                  data-active={period === vp.code ? "true" : "false"}
                  onClick={() => onSelectPeriod(vp.code)}
                  title={
                    vp.allowsPointBuys
                      ? `${vp.label} — Portal PeriodNumber ${vp.portalPeriodNumber}: Point purchases permitted on pre-game Football/Basketball`
                      : `${vp.label} — Portal PeriodNumber ${vp.portalPeriodNumber}: Point purchases strictly blocked`
                  }
                >
                  <span>
                    {vp.allowsPointBuys ? "🟢" : "🔒"} {vp.label}
                  </span>
                  {pRow ? (
                    <span className="sd-dim-count sd-mono">
                      {formatCompactLegs(pRow.totalLegs)}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* Axis 4: Market */}
        <div className="sd-dim-row">
          <div className="sd-dim-label">4. Market Type</div>
          <div className="sd-chip-strip">
            <button
              type="button"
              className="sd-dim-chip"
              data-active={market === "ALL" ? "true" : "false"}
              onClick={() => onSelectMarket("ALL")}
            >
              All Markets
            </button>
            {(taxonomy?.byMarket ?? []).map((mktRow) => (
              <button
                key={mktRow.code}
                type="button"
                className="sd-dim-chip"
                data-active={market === mktRow.code ? "true" : "false"}
                onClick={() => onSelectMarket(mktRow.code as MarketCode)}
              >
                <span>{mktRow.label}</span>
                <span className="sd-dim-count sd-mono">
                  {formatCompactLegs(mktRow.totalLegs)}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Active Slice Summary Strip (All Legs + Hold % + Point-Buy Share + Risk Vector) */}
      {activeSlice ? (
        <div className="sd-card-cli">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "10px",
              marginBottom: "8px",
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
              {renderPolicyBadge(activeSlice.pointBuyPolicy)}
              {renderRiskBadge(activeSlice.riskStatus)}
              <span
                className="sd-mono"
                style={{ fontSize: "12px", color: "var(--sd-text-primary)" }}
              >
                Slice Legs:{" "}
                <strong>{activeSlice.totalLegs.toLocaleString()}</strong> (
                {activeSlice.settledLegs.toLocaleString()} settled ·{" "}
                {activeSlice.winRatePct}% win) · Handle:{" "}
                <strong>{formatUsd(activeSlice.handleUsd)}</strong> · Actual
                Desk P&amp;L:{" "}
                <strong
                  style={{
                    color:
                      activeSlice.actualDeskPnlUsd >= 0
                        ? "var(--sd-theme-emerald)"
                        : "var(--sd-tier-alert)",
                  }}
                >
                  {formatSignedUsd(activeSlice.actualDeskPnlUsd)} (
                  {activeSlice.holdPct}% hold)
                </strong>{" "}
                · Point-Buy Share:{" "}
                <strong>
                  {activeSlice.buyLegs.toLocaleString()} legs (
                  {activeSlice.buyRatePct}%)
                </strong>
              </span>
            </div>
          </div>
          <div style={{ fontSize: "12px", color: "var(--sd-text-muted)" }}>
            <strong>Operational Risk Vector:</strong>{" "}
            {activeSlice.primaryRiskVector}
          </div>
        </div>
      ) : null}

      {/* Interactive 4-Dimension Exposure & Hold Matrix Explorer */}
      {taxonomy ? (
        <div className="sd-card">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "10px",
              marginBottom: "8px",
            }}
          >
            <strong style={{ fontSize: "13px" }}>
              📊 Hierarchical Exposure, Hold &amp; Point-Buy Matrix (Click any
              row to drill in)
            </strong>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              <button
                type="button"
                className="sd-preset-btn"
                data-active={cubeTab === "sport" ? "true" : "false"}
                onClick={() => onSelectCubeTab("sport")}
              >
                1. By Sport ({taxonomy.bySport.length})
              </button>
              <button
                type="button"
                className="sd-preset-btn"
                data-active={cubeTab === "subSport" ? "true" : "false"}
                onClick={() => onSelectCubeTab("subSport")}
              >
                2. By Sub-Sport ({taxonomy.bySubSport.length})
              </button>
              <button
                type="button"
                className="sd-preset-btn"
                data-active={cubeTab === "period" ? "true" : "false"}
                onClick={() => onSelectCubeTab("period")}
              >
                3. Valid Periods ({taxonomy.byPeriod.length})
              </button>
              <button
                type="button"
                className="sd-preset-btn"
                data-active={cubeTab === "market" ? "true" : "false"}
                onClick={() => onSelectCubeTab("market")}
              >
                4. By Market ({taxonomy.byMarket.length})
              </button>
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Segment</th>
                  <th>Point-Buy Policy</th>
                  <th>Total Legs</th>
                  <th>Win %</th>
                  <th>Total Handle</th>
                  <th>Buy Legs (% Share)</th>
                  <th>Actual Desk P&amp;L</th>
                  <th>Hold %</th>
                  <th>Shadow Δ</th>
                  <th>Risk Status</th>
                </tr>
              </thead>
              <tbody>
                {activeCubeRows.map((row) => {
                  const isRowSelected =
                    (row.dimension === "sport" && sport === row.code) ||
                    (row.dimension === "subSport" && subSport === row.code) ||
                    (row.dimension === "period" && period === row.code) ||
                    (row.dimension === "market" && market === row.code);
                  return (
                    <tr
                      key={`${row.dimension}:${row.code}`}
                      className={isRowSelected ? "sd-row-active" : undefined}
                      style={{ cursor: "pointer" }}
                      onClick={() => onDrillRow(row)}
                      title={row.primaryRiskVector}
                    >
                      <td>
                        <strong>{row.label}</strong>
                        {row.parentCode ? (
                          <span
                            style={{
                              marginLeft: "6px",
                              fontSize: "10px",
                              color: "var(--sd-text-muted)",
                            }}
                          >
                            ({row.parentCode})
                          </span>
                        ) : null}
                      </td>
                      <td>{renderPolicyBadge(row.pointBuyPolicy)}</td>
                      <td className="sd-mono">
                        {row.totalLegs.toLocaleString()}
                      </td>
                      <td className="sd-mono">{row.winRatePct.toFixed(1)}%</td>
                      <td className="sd-mono">{formatUsd(row.handleUsd)}</td>
                      <td className="sd-mono">
                        {row.buyLegs.toLocaleString()} ({row.buyRatePct}%)
                      </td>
                      <td
                        className="sd-mono"
                        style={{
                          color:
                            row.actualDeskPnlUsd >= 0
                              ? "var(--sd-theme-emerald)"
                              : "var(--sd-tier-alert)",
                        }}
                      >
                        {formatSignedUsd(row.actualDeskPnlUsd)}
                      </td>
                      <td className="sd-mono">{row.holdPct.toFixed(2)}%</td>
                      <td
                        className="sd-mono"
                        style={{
                          fontWeight: 700,
                          color:
                            row.netDeltaUsd > 0
                              ? "var(--sd-theme-emerald)"
                              : row.netDeltaUsd < 0
                                ? "var(--sd-tier-alert)"
                                : "var(--sd-text-muted)",
                        }}
                      >
                        {formatSignedUsd(row.netDeltaUsd)}
                      </td>
                      <td>{renderRiskBadge(row.riskStatus)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}
