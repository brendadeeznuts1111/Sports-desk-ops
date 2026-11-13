/**
 * @file packages/ui/src/shadow_pricing/ShadowElasticityChart.tsx
 * @description SVG frontier chart plotting Retail Turnover Elasticity vs. Net Desk Savings.
 */

import React from "react";
import type { ElasticityFrontierPoint } from "@sportsdesk-ops/contracts/shadow-pricing";
import { formatSignedUsd } from "./shared.tsx";

export interface ShadowElasticityChartProps {
  readonly points: readonly ElasticityFrontierPoint[];
  readonly selectedElasticity: number;
  readonly breakevenPct: number | null;
}

export function ShadowElasticityChart({
  points,
  selectedElasticity,
  breakevenPct,
}: ShadowElasticityChartProps): React.ReactElement {
  const width = 620;
  const height = 220;
  const padL = 66;
  const padR = 24;
  const padT = 22;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  if (points.length === 0) {
    return <div style={{ color: "var(--sd-text-muted)" }}>No curve data</div>;
  }

  let minY = 0;
  let maxY = 0;
  for (const pt of points) {
    minY = Math.min(
      minY,
      pt.netDeskSavingsUsd,
      pt.sharpSavingsUsd,
      pt.retailNetImpactUsd,
    );
    maxY = Math.max(
      maxY,
      pt.netDeskSavingsUsd,
      pt.sharpSavingsUsd,
      pt.retailNetImpactUsd,
    );
  }
  const span = Math.max(1000, maxY - minY);
  minY -= span * 0.1;
  maxY += span * 0.1;

  const xOf = (elasticity: number) =>
    padL + (Math.min(0.4, Math.max(0, elasticity)) / 0.4) * plotW;
  const yOf = (usd: number) =>
    padT + (1 - (usd - minY) / (maxY - minY)) * plotH;

  const buildPath = (pick: (p: ElasticityFrontierPoint) => number) =>
    points
      .map(
        (p, idx) =>
          `${idx === 0 ? "M" : "L"}${xOf(p.elasticity).toFixed(1)},${yOf(pick(p)).toFixed(1)}`,
      )
      .join(" ");

  const zeroY = yOf(0);
  const markerX = xOf(selectedElasticity);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", height: "auto", display: "block" }}
      role="img"
      aria-label="Retail Turnover Elasticity vs Net Desk Savings Frontier"
    >
      <line
        x1={padL}
        y1={zeroY}
        x2={width - padR}
        y2={zeroY}
        stroke="var(--sd-surface-border)"
        strokeWidth="1.5"
        strokeDasharray="4 4"
      />
      <text
        x={padL - 8}
        y={zeroY + 4}
        textAnchor="end"
        fill="var(--sd-text-muted)"
        fontSize="10"
      >
        $0
      </text>
      <text
        x={padL - 8}
        y={padT + 8}
        textAnchor="end"
        fill="var(--sd-text-muted)"
        fontSize="10"
      >
        {formatSignedUsd(maxY)}
      </text>
      <text
        x={padL - 8}
        y={height - padB}
        textAnchor="end"
        fill="var(--sd-text-muted)"
        fontSize="10"
      >
        {formatSignedUsd(minY)}
      </text>

      <path
        d={buildPath((p) => p.sharpSavingsUsd)}
        fill="none"
        stroke="var(--sd-route-sharp)"
        strokeWidth="2"
        strokeDasharray="5 3"
      />

      <path
        d={buildPath((p) => p.retailNetImpactUsd)}
        fill="none"
        stroke="var(--sd-tier-steam)"
        strokeWidth="2"
      />

      <path
        d={buildPath((p) => p.netDeskSavingsUsd)}
        fill="none"
        stroke="var(--sd-tier-rec-bias)"
        strokeWidth="3"
      />

      <line
        x1={markerX}
        y1={padT}
        x2={markerX}
        y2={height - padB}
        stroke="var(--sd-theme-emerald)"
        strokeWidth="1.5"
      />

      {breakevenPct !== null && breakevenPct <= 40 ? (
        <g>
          <circle
            cx={xOf(breakevenPct / 100)}
            cy={zeroY}
            r="4.5"
            fill="var(--sd-tier-alert)"
          />
          <text
            x={xOf(breakevenPct / 100) + 6}
            y={zeroY - 6}
            fill="var(--sd-tier-alert)"
            fontSize="10"
            fontWeight="600"
          >
            Breakeven {breakevenPct}%
          </text>
        </g>
      ) : null}

      {[0, 0.1, 0.2, 0.3, 0.4].map((tick) => (
        <text
          key={tick}
          x={xOf(tick)}
          y={height - 10}
          textAnchor="middle"
          fill="var(--sd-text-muted)"
          fontSize="10"
        >
          {Math.round(tick * 100)}% drop
        </text>
      ))}
    </svg>
  );
}
