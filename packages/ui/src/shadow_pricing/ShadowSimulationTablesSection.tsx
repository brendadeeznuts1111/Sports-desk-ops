/**
 * @file packages/ui/src/shadow_pricing/ShadowSimulationTablesSection.tsx
 * @description Two-column Elasticity Frontier + Preset Matrix, Key-Number Margin Clustering
 * audit table, and Top Impacted Sharp Point-Buyers Leaderboard.
 */

import React from "react";
import type { ShadowPricingDashboardPayload } from "@sportsdesk-ops/contracts/shadow-pricing";
import { ShadowElasticityChart } from "./ShadowElasticityChart.tsx";
import { formatSignedUsd, formatUsd } from "./shared.tsx";

export interface ShadowSimulationTablesSectionProps {
  readonly payload: ShadowPricingDashboardPayload;
  readonly retailElasticity: number;
  readonly minVolume: number;
  readonly onApplyPresetLadder: (
    k3: number,
    k7: number,
    k14_21: number,
  ) => void;
  readonly onInspectAccount?: ((accountId: string) => void) | undefined;
}

export function ShadowSimulationTablesSection({
  payload,
  retailElasticity,
  minVolume,
  onApplyPresetLadder,
  onInspectAccount,
}: ShadowSimulationTablesSectionProps): React.ReactElement {
  const sim = payload.simulation;

  return (
    <>
      {/* Two-column: Elasticity Frontier Chart + 4-Policy Comparison */}
      <div className="sd-grid-2">
        <div className="sd-card">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "8px",
            }}
          >
            <strong style={{ fontSize: "13px" }}>
              📉 Retail Turnover Elasticity Frontier (0% → 40% Drop)
            </strong>
            <div
              style={{
                display: "flex",
                gap: "10px",
                fontSize: "11px",
                color: "var(--sd-text-muted)",
              }}
            >
              <span style={{ color: "var(--sd-tier-rec-bias)" }}>
                ━ Net Delta
              </span>
              <span style={{ color: "var(--sd-route-sharp)" }}>
                ┄ Sharp Savings
              </span>
              <span style={{ color: "var(--sd-tier-steam)" }}>
                ━ Retail Attrition
              </span>
            </div>
          </div>
          <ShadowElasticityChart
            points={payload.elasticityFrontier}
            selectedElasticity={retailElasticity}
            breakevenPct={payload.breakevenElasticityPct}
          />
        </div>

        <div className="sd-card">
          <strong
            style={{
              display: "block",
              fontSize: "13px",
              marginBottom: "8px",
            }}
          >
            🏛️ Calibrated Ladder Policy Matrix (at{" "}
            {Math.round(retailElasticity * 100)}% Elasticity)
          </strong>
          <table>
            <thead>
              <tr>
                <th>Policy Ladder</th>
                <th>3 / 7 / 14</th>
                <th>Sharp Δ</th>
                <th>Retail Δ</th>
                <th>Net Desk Δ</th>
              </tr>
            </thead>
            <tbody>
              {payload.presetComparison.map((row) => (
                <tr
                  key={row.id}
                  style={{ cursor: "pointer" }}
                  onClick={() =>
                    onApplyPresetLadder(
                      row.ladderKey3,
                      row.ladderKey7,
                      row.ladderKey14_21,
                    )
                  }
                >
                  <td>
                    <strong>{row.label}</strong>
                  </td>
                  <td className="sd-mono">
                    {row.ladderKey3} / {row.ladderKey7} / {row.ladderKey14_21}
                  </td>
                  <td
                    className="sd-mono"
                    style={{
                      color:
                        row.sharpSavingsUsd >= 0
                          ? "var(--sd-route-sharp)"
                          : "var(--sd-tier-alert)",
                    }}
                  >
                    {formatSignedUsd(row.sharpSavingsUsd)}
                  </td>
                  <td
                    className="sd-mono"
                    style={{
                      color:
                        row.retailNetImpactUsd >= 0
                          ? "var(--sd-theme-emerald)"
                          : "var(--sd-tier-steam)",
                    }}
                  >
                    {formatSignedUsd(row.retailNetImpactUsd)}
                  </td>
                  <td
                    className="sd-mono"
                    style={{
                      fontWeight: 700,
                      color:
                        row.netDeskSavingsUsd >= 0
                          ? "var(--sd-theme-emerald)"
                          : "var(--sd-tier-alert)",
                    }}
                  >
                    {formatSignedUsd(row.netDeskSavingsUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Key-Number Exposure Breakdown Table */}
      <div className="sd-card">
        <strong
          style={{
            display: "block",
            fontSize: "13px",
            marginBottom: "8px",
          }}
        >
          🏈 Key-Number Margin Clustering &amp; Fair Breakeven Audit
        </strong>
        <table>
          <thead>
            <tr>
              <th>Target Margin</th>
              <th>Fair Breakeven</th>
              <th>Shadow Odds</th>
              <th>Analyzed Legs</th>
              <th>Settled Win %</th>
              <th>Handle (USD)</th>
              <th>Actual Desk P&amp;L</th>
              <th>Shadow Desk P&amp;L</th>
              <th>Net Desk Δ</th>
            </tr>
          </thead>
          <tbody>
            {payload.keyBreakdown.map((kb) => (
              <tr key={kb.keyLabel}>
                <td>
                  <strong>{kb.keyLabel}</strong>
                </td>
                <td className="sd-mono">{kb.fairBreakevenOdds}</td>
                <td className="sd-mono">
                  {kb.configuredShadowOdds !== null
                    ? kb.configuredShadowOdds
                    : "Unchanged"}
                </td>
                <td className="sd-mono">{kb.legs.toLocaleString()}</td>
                <td className="sd-mono">{kb.winRatePct.toFixed(1)}%</td>
                <td className="sd-mono">{formatUsd(kb.stakedUsd)}</td>
                <td className="sd-mono">
                  {formatSignedUsd(kb.actualDeskPnlUsd)}
                </td>
                <td className="sd-mono">
                  {formatSignedUsd(kb.shadowDeskPnlUsd)}
                </td>
                <td
                  className="sd-mono"
                  style={{
                    fontWeight: 700,
                    color:
                      kb.netDeltaUsd >= 0
                        ? "var(--sd-theme-emerald)"
                        : "var(--sd-tier-alert)",
                  }}
                >
                  {formatSignedUsd(kb.netDeltaUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Top Sharp Point-Buyers Leaderboard */}
      {sim.topSharpBuyers.length > 0 ? (
        <div className="sd-card">
          <strong
            style={{
              display: "block",
              fontSize: "13px",
              marginBottom: "8px",
            }}
          >
            🎯 Top Impacted Sharp Key-Number Accounts in Slice (N &gt;={" "}
            {minVolume} &amp; Key 3/7 Rate &gt;= 40%)
          </strong>
          <table>
            <thead>
              <tr>
                <th>Account ID</th>
                <th>Buy Legs</th>
                <th>Key 3/7 Rate</th>
                <th>Staked (USD)</th>
                <th>Actual Desk P&amp;L</th>
                <th>Shadow Desk P&amp;L</th>
                <th>Desk Improvement Δ</th>
                <th>Inspect</th>
              </tr>
            </thead>
            <tbody>
              {sim.topSharpBuyers.map((buyer) => (
                <tr key={buyer.account}>
                  <td>
                    <code>{buyer.account}</code>
                  </td>
                  <td className="sd-mono">{buyer.legs}</td>
                  <td className="sd-mono">{buyer.keyRatePct}</td>
                  <td className="sd-mono">{formatUsd(buyer.stakedUsd)}</td>
                  <td
                    className="sd-mono"
                    style={{
                      color:
                        buyer.actualDeskPnlUsd >= 0
                          ? "var(--sd-theme-emerald)"
                          : "var(--sd-tier-alert)",
                    }}
                  >
                    {formatSignedUsd(buyer.actualDeskPnlUsd)}
                  </td>
                  <td className="sd-mono">
                    {formatSignedUsd(buyer.shadowDeskPnlUsd)}
                  </td>
                  <td
                    className="sd-mono"
                    style={{
                      fontWeight: 700,
                      color:
                        buyer.netDeskImprovementUsd >= 0
                          ? "var(--sd-theme-emerald)"
                          : "var(--sd-tier-steam)",
                    }}
                  >
                    {formatSignedUsd(buyer.netDeskImprovementUsd)}
                  </td>
                  <td>
                    {onInspectAccount ? (
                      <button
                        type="button"
                        className="sd-preset-btn"
                        style={{ padding: "3px 8px", fontSize: "11px" }}
                        onClick={() => onInspectAccount(buyer.account)}
                      >
                        🔍 Profile
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
