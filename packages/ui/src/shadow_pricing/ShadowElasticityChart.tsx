/**
 * @file packages/ui/src/shadow_pricing/ShadowElasticityChart.tsx
 * @description SVG frontier chart plotting Retail Turnover Elasticity vs. Net Desk Savings.
 * One USD axis anchored at $0, direct end labels instead of a legend, grey context series, and a
 * single accent reserved for the actionable breakeven point.
 */

import React from "react";
import type { ElasticityFrontierPoint } from "@sportsdesk-ops/contracts/shadow-pricing";
import { formatSignedUsd } from "./shared.tsx";
import {
  VIZ_COLORS,
  VIZ_LABEL_FONT_PX,
  VIZ_LABEL_MIN_GAP_PX,
  linearScale,
  spreadLabels,
  zeroAnchoredDomain,
} from "../viz/perceptual.ts";

export interface ShadowElasticityChartProps {
  readonly points: readonly ElasticityFrontierPoint[];
  readonly selectedElasticity: number;
  readonly breakevenPct: number | null;
}

const MAX_ELASTICITY = 0.4;

interface FrontierSeries {
  readonly key: string;
  readonly label: string;
  readonly pick: (point: ElasticityFrontierPoint) => number;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly dash?: string;
}

const FRONTIER_SERIES: readonly FrontierSeries[] = [
  {
    key: "net",
    label: "Net desk savings",
    pick: (point) => point.netDeskSavingsUsd,
    stroke: VIZ_COLORS.label,
    strokeWidth: 2.5,
  },
  {
    key: "sharp",
    label: "Sharp savings",
    pick: (point) => point.sharpSavingsUsd,
    stroke: VIZ_COLORS.context,
    strokeWidth: 1.5,
    dash: "5 3",
  },
  {
    key: "retail",
    label: "Retail net impact",
    pick: (point) => point.retailNetImpactUsd,
    stroke: VIZ_COLORS.context,
    strokeWidth: 1.5,
  },
];

export function ShadowElasticityChart({
  points,
  selectedElasticity,
  breakevenPct,
}: ShadowElasticityChartProps): React.ReactElement {
  const width = 640;
  const height = 220;
  const padL = 66;
  const padR = 170;
  const padT = 14;
  const padB = 34;

  if (points.length === 0) {
    return <div style={{ color: "var(--sd-text-muted)" }}>No curve data</div>;
  }

  const domain = zeroAnchoredDomain(
    points.flatMap((point) =>
      FRONTIER_SERIES.map((series) => series.pick(point)),
    ),
  );
  const xScale = linearScale([0, MAX_ELASTICITY], [padL, width - padR]);
  const yScale = linearScale(domain, [height - padB, padT]);
  const xOf = (elasticity: number) =>
    xScale.map(Math.min(MAX_ELASTICITY, Math.max(0, elasticity)));
  const yOf = yScale.map;

  const buildPath = (pick: (point: ElasticityFrontierPoint) => number) =>
    points
      .map(
        (point, order) =>
          `${order === 0 ? "M" : "L"}${xOf(point.elasticity).toFixed(1)},${yOf(pick(point)).toFixed(1)}`,
      )
      .join(" ");

  const last = points[points.length - 1]!;
  const labelYs = spreadLabels(
    FRONTIER_SERIES.map((series) => yOf(series.pick(last)) + 4),
    VIZ_LABEL_MIN_GAP_PX,
    [padT + 4, height - padB + 4],
  );
  const zeroY = yOf(0);
  const markerX = xOf(selectedElasticity);
  const axisTicks = [domain[1], 0, domain[0]].filter(
    (value, order, all) => all.indexOf(value) === order,
  );
  const axisTickYs = spreadLabels(
    axisTicks.map((value) => yOf(value) + 4),
    VIZ_LABEL_MIN_GAP_PX,
    [padT + 4, height - padB + 4 + VIZ_LABEL_MIN_GAP_PX],
  );

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
        stroke={VIZ_COLORS.baseline}
        strokeWidth="1"
      />
      {axisTicks.map((value, order) => (
        <text
          key={value}
          x={padL - 8}
          y={axisTickYs[order]}
          textAnchor="end"
          fill={VIZ_COLORS.label}
          fontSize={VIZ_LABEL_FONT_PX}
        >
          {value === 0 ? "$0" : formatSignedUsd(value)}
        </text>
      ))}

      <line
        x1={markerX}
        y1={padT}
        x2={markerX}
        y2={height - padB}
        stroke={VIZ_COLORS.context}
        strokeWidth="1"
        strokeDasharray="2 3"
      />
      <text
        x={markerX + 4}
        y={padT + 8}
        fill={VIZ_COLORS.label}
        fontSize={VIZ_LABEL_FONT_PX}
      >
        selected {Math.round(selectedElasticity * 100)}%
      </text>

      {FRONTIER_SERIES.map((series, order) => (
        <g key={series.key} data-series={series.key}>
          <path
            d={buildPath(series.pick)}
            fill="none"
            stroke={series.stroke}
            strokeWidth={series.strokeWidth}
            strokeDasharray={series.dash}
          />
          <text
            x={width - padR + 6}
            y={labelYs[order]}
            fill={VIZ_COLORS.label}
            fontSize={VIZ_LABEL_FONT_PX}
            fontWeight={series.key === "net" ? 700 : 400}
          >
            {series.label} {formatSignedUsd(series.pick(last))}
          </text>
        </g>
      ))}

      {breakevenPct !== null && breakevenPct <= MAX_ELASTICITY * 100 ? (
        <g data-accent="true">
          <circle
            cx={xOf(breakevenPct / 100)}
            cy={zeroY}
            r="4.5"
            fill={VIZ_COLORS.accent}
          />
          <text
            x={xOf(breakevenPct / 100) + 6}
            y={zeroY - 6}
            fill={VIZ_COLORS.accent}
            fontSize={VIZ_LABEL_FONT_PX}
            fontWeight="700"
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
          fill={VIZ_COLORS.label}
          fontSize={VIZ_LABEL_FONT_PX}
        >
          {Math.round(tick * 100)}% drop
        </text>
      ))}
    </svg>
  );
}
