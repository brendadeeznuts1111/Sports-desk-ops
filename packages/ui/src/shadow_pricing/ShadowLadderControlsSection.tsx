/**
 * @file packages/ui/src/shadow_pricing/ShadowLadderControlsSection.tsx
 * @description Catalog lockout banner (when point buys are blocked) OR Calibrated
 * Ladder Presets, 5 parameter sliders, 4 cohort KPI cards, and Desk Policy directive.
 */

import React from "react";
import type {
  ShadowPricingDashboardPayload,
  ShadowRepriceMode,
  SportFilter,
  SubSportFilter,
} from "@sportsdesk-ops/contracts/shadow-pricing";
import { CLIENT_PRESETS, formatSignedUsd, formatUsd } from "./shared.tsx";

export interface ShadowLadderControlsSectionProps {
  readonly payload: ShadowPricingDashboardPayload;
  readonly ladderKey3: number;
  readonly ladderKey7: number;
  readonly ladderKey14_21: number;
  readonly minVolume: number;
  readonly retailElasticity: number;
  readonly repriceMode: ShadowRepriceMode;
  readonly onSetLadder: (k3: number, k7: number, k14_21: number) => void;
  readonly onChangeLadderKey3: (value: number) => void;
  readonly onChangeLadderKey7: (value: number) => void;
  readonly onChangeLadderKey14_21: (value: number) => void;
  readonly onChangeRetailElasticity: (value: number) => void;
  readonly onChangeMinVolume: (value: number) => void;
  readonly onChangeRepriceMode: (mode: ShadowRepriceMode) => void;
  readonly onJumpToSimulatorSlice: (
    sport: SportFilter,
    subSport: SubSportFilter,
  ) => void;
}

export function ShadowLadderControlsSection({
  payload,
  ladderKey3,
  ladderKey7,
  ladderKey14_21,
  minVolume,
  retailElasticity,
  repriceMode,
  onSetLadder,
  onChangeLadderKey3,
  onChangeLadderKey7,
  onChangeLadderKey14_21,
  onChangeRetailElasticity,
  onChangeMinVolume,
  onChangeRepriceMode,
  onJumpToSimulatorSlice,
}: ShadowLadderControlsSectionProps): React.ReactElement {
  const activeSlice = payload.taxonomy.activeSlice;
  const sim = payload.simulation;
  const netDelta = sim.summary.netDeskSavingsUsd;
  const sharpDelta = sim.sharpCohort.sharpSavingsUsd;
  const retailDelta = sim.retailCohort.retailNetImpactUsd;

  if (
    activeSlice.pointBuyPolicy === "STRICTLY_BLOCKED" &&
    sim.summary.totalAnalyzedLegs === 0
  ) {
    return (
      <div
        className="sd-card"
        style={{
          borderLeft: "4px solid var(--sd-tier-blocked)",
        }}
      >
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
          <strong style={{ fontSize: "14px" }}>
            🔒 {payload.policyRecommendation.headline}
          </strong>
          <span className="sd-pill sd-pill-blocked sd-mono">
            {payload.policyRecommendation.directive} · 0 Point-Buy Legs
          </span>
        </div>
        <p
          style={{
            margin: "0 0 12px",
            fontSize: "12.5px",
            color: "var(--sd-text-muted)",
          }}
        >
          {payload.policyRecommendation.rationale}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          <button
            type="button"
            className="sd-preset-btn"
            onClick={() => onJumpToSimulatorSlice("Football", "NFL")}
          >
            🏈 Jump to NFL P0 Spread (Key Leak Simulator)
          </button>
          <button
            type="button"
            className="sd-preset-btn"
            onClick={() => onJumpToSimulatorSlice("Football", "NCAAF")}
          >
            🏟️ Jump to College FB P0 Spread
          </button>
          <button
            type="button"
            className="sd-preset-btn"
            onClick={() => onJumpToSimulatorSlice("Basketball", "NBA")}
          >
            🏀 Jump to NBA P0 Spread (House Vig Edge)
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Calibrated Ladder Presets + Interactive Sliders */}
      <div className="sd-card">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "10px",
            marginBottom: "14px",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {CLIENT_PRESETS.map((preset) => {
              const active =
                ladderKey3 === preset.ladderKey3 &&
                ladderKey7 === preset.ladderKey7 &&
                ladderKey14_21 === preset.ladderKey14_21;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className="sd-preset-btn"
                  data-active={active ? "true" : "false"}
                  onClick={() =>
                    onSetLadder(
                      preset.ladderKey3,
                      preset.ladderKey7,
                      preset.ladderKey14_21,
                    )
                  }
                >
                  <div>{preset.label}</div>
                  <div
                    style={{
                      fontSize: "10px",
                      opacity: 0.8,
                      fontWeight: 400,
                    }}
                  >
                    {preset.subtitle}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Reprice Mode Toggle */}
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <span
              style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}
              title="Price Floor preserves steeper juice (-145/-150) already paid on 1.0–1.5pt buys; Exact Ladder matches ./bin/dx shadow-price verbatim."
            >
              Mode:
            </span>
            <button
              type="button"
              className="sd-preset-btn"
              data-active={repriceMode === "floor" ? "true" : "false"}
              onClick={() => onChangeRepriceMode("floor")}
            >
              🛡️ Price Floor Clamp
            </button>
            <button
              type="button"
              className="sd-preset-btn"
              data-active={repriceMode === "exact" ? "true" : "false"}
              onClick={() => onChangeRepriceMode("exact")}
            >
              🎯 Exact CLI Override
            </button>
          </div>
        </div>

        {/* 5 Parameter Sliders */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(185px, 1fr))",
            gap: "14px",
          }}
        >
          <label className="sd-card-cli" style={{ display: "block" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "12px",
                marginBottom: "6px",
              }}
            >
              <span>Key 3 Odds (Fair: -138)</span>
              <strong
                className="sd-mono"
                style={{ color: "var(--sd-tier-rec-bias)" }}
              >
                {ladderKey3}
              </strong>
            </div>
            <input
              type="range"
              className="sd-slider"
              min={-175}
              max={-110}
              step={1}
              value={ladderKey3}
              onChange={(e) => onChangeLadderKey3(Number(e.target.value))}
            />
          </label>

          <label className="sd-card-cli" style={{ display: "block" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "12px",
                marginBottom: "6px",
              }}
            >
              <span>Key 7 Odds (Fair: -132)</span>
              <strong
                className="sd-mono"
                style={{ color: "var(--sd-tier-rec-bias)" }}
              >
                {ladderKey7}
              </strong>
            </div>
            <input
              type="range"
              className="sd-slider"
              min={-165}
              max={-110}
              step={1}
              value={ladderKey7}
              onChange={(e) => onChangeLadderKey7(Number(e.target.value))}
            />
          </label>

          <label className="sd-card-cli" style={{ display: "block" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "12px",
                marginBottom: "6px",
              }}
            >
              <span>Key 10/14/21 (Fair: -123)</span>
              <strong
                className="sd-mono"
                style={{ color: "var(--sd-tier-rec-bias)" }}
              >
                {ladderKey14_21}
              </strong>
            </div>
            <input
              type="range"
              className="sd-slider"
              min={-155}
              max={-110}
              step={1}
              value={ladderKey14_21}
              onChange={(e) => onChangeLadderKey14_21(Number(e.target.value))}
            />
          </label>

          <label className="sd-card-cli" style={{ display: "block" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "12px",
                marginBottom: "6px",
              }}
            >
              <span>Retail Elasticity Drop</span>
              <strong
                className="sd-mono"
                style={{ color: "var(--sd-tier-steam)" }}
              >
                {Math.round(retailElasticity * 100)}%
              </strong>
            </div>
            <input
              type="range"
              className="sd-slider"
              min={0}
              max={0.4}
              step={0.01}
              value={retailElasticity}
              onChange={(e) => onChangeRetailElasticity(Number(e.target.value))}
            />
          </label>

          <label className="sd-card-cli" style={{ display: "block" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "12px",
                marginBottom: "6px",
              }}
            >
              <span>Sharp Min Legs</span>
              <strong
                className="sd-mono"
                style={{ color: "var(--sd-route-sharp)" }}
              >
                {minVolume} legs
              </strong>
            </div>
            <input
              type="range"
              className="sd-slider"
              min={2}
              max={50}
              step={1}
              value={minVolume}
              onChange={(e) => onChangeMinVolume(Number(e.target.value))}
            />
          </label>
        </div>
      </div>

      {/* 4 Headline Point-Buy Cohort KPI Cards */}
      <div className="sd-grid-4">
        <div className="sd-card">
          <div style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}>
            SLICE POINT-BUY HANDLE
          </div>
          <div
            className="sd-mono"
            style={{
              fontSize: "22px",
              fontWeight: 700,
              margin: "6px 0 4px",
            }}
          >
            {formatUsd(sim.summary.totalStakedUsd)}
          </div>
          <div style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}>
            {sim.summary.totalAnalyzedLegs.toLocaleString()} buy legs ·{" "}
            {sim.summary.totalSettledLegs.toLocaleString()} settled · Actual
            P&amp;L{" "}
            <strong style={{ color: "var(--sd-theme-emerald)" }}>
              {formatSignedUsd(sim.summary.actualDeskPnlUsd)}
            </strong>
          </div>
        </div>

        <div className="sd-card">
          <div style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}>
            SHARP SYNDICATE DELTA ({sim.sharpCohort.bettorCount} ACCTS)
          </div>
          <div
            className="sd-mono"
            style={{
              fontSize: "22px",
              fontWeight: 700,
              margin: "6px 0 4px",
              color:
                sharpDelta >= 0
                  ? "var(--sd-route-sharp)"
                  : "var(--sd-tier-alert)",
            }}
          >
            {formatSignedUsd(sharpDelta)}
          </div>
          <div style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}>
            {sim.sharpCohort.legCount.toLocaleString()} legs (
            {formatUsd(sim.sharpCohort.stakedUsd)}) · Actual{" "}
            {formatSignedUsd(sim.sharpCohort.actualDeskPnlUsd)}
          </div>
        </div>

        <div className="sd-card">
          <div style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}>
            RETAIL ELASTICITY IMPACT (
            {Math.round(sim.retailCohort.elasticityAssumed * 100)}% DROP)
          </div>
          <div
            className="sd-mono"
            style={{
              fontSize: "22px",
              fontWeight: 700,
              margin: "6px 0 4px",
              color:
                retailDelta >= 0
                  ? "var(--sd-theme-emerald)"
                  : "var(--sd-tier-steam)",
            }}
          >
            {formatSignedUsd(retailDelta)}
          </div>
          <div style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}>
            {sim.retailCohort.bettorCount.toLocaleString()} retail bettors ·{" "}
            {sim.retailCohort.legCount.toLocaleString()} legs (
            {formatUsd(sim.retailCohort.stakedUsd)})
          </div>
        </div>

        <div className="sd-card">
          <div style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}>
            NET COUNTERFACTUAL DESK DELTA
          </div>
          <div
            className="sd-mono"
            style={{
              fontSize: "22px",
              fontWeight: 700,
              margin: "6px 0 4px",
              color:
                netDelta >= 0
                  ? "var(--sd-theme-emerald)"
                  : "var(--sd-tier-alert)",
            }}
          >
            {formatSignedUsd(netDelta)}
          </div>
          <div style={{ fontSize: "11px", color: "var(--sd-text-muted)" }}>
            Shadow P&amp;L: {formatSignedUsd(sim.summary.shadowDeskPnlUsd)}{" "}
            {payload.breakevenElasticityPct !== null
              ? `· Breakeven @ ${payload.breakevenElasticityPct}% drop`
              : ""}
          </div>
        </div>
      </div>

      {/* Operational Policy Directive Banner */}
      <div
        className="sd-card"
        style={{
          borderLeft: `4px solid ${
            payload.policyRecommendation.directive ===
            "TARGETED_LIMITS_AND_ALERTS"
              ? "var(--sd-tier-steam)"
              : "var(--sd-theme-emerald)"
          }`,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "8px",
            marginBottom: "4px",
          }}
        >
          <strong style={{ fontSize: "13px" }}>
            🎯 Desk Policy Recommendation:{" "}
            {payload.policyRecommendation.headline}
          </strong>
          <span className="sd-pill sd-pill-sharp sd-mono">
            {payload.policyRecommendation.directive} · Max Key Risk Cap: $
            {payload.policyRecommendation.recommendedMaxKeyRiskUsd.toLocaleString()}
          </span>
        </div>
        <div style={{ fontSize: "12px", color: "var(--sd-text-muted)" }}>
          {payload.policyRecommendation.rationale}
        </div>
      </div>
    </>
  );
}
