/**
 * @file packages/ui/src/viz/charts.tsx
 * @description Aligned-baseline SVG primitives: zero-anchored horizontal bars, dot plots, and the
 * fail-closed error card shown when a staging or conservation oracle rejects a panel.
 */

import React from "react";
import {
  VIZ_COLORS,
  VIZ_LABEL_FONT_PX,
  VIZ_LABEL_MIN_GAP_PX,
  barScale,
  linearScale,
  zeroAnchoredDomain,
} from "./perceptual.ts";

export interface ChartDatum {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly valueLabel: string;
  readonly accent: boolean;
}

export interface AlignedChartProps {
  readonly title: string;
  readonly unitNote: string;
  readonly data: readonly ChartDatum[];
  readonly width?: number;
  readonly labelColumn?: number;
  readonly valueColumn?: number;
}

export interface HorizontalBarChartProps extends AlignedChartProps {
  readonly reference?:
    { readonly label: string; readonly values: readonly number[] } | undefined;
}

export const ROW_PITCH_PX = Math.max(20, VIZ_LABEL_MIN_GAP_PX);

function ChartFrame({
  title,
  unitNote,
  height,
  width,
  children,
}: {
  readonly title: string;
  readonly unitNote: string;
  readonly height: number;
  readonly width: number;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <figure className="sd-viz-figure" style={{ margin: 0, overflowX: "auto" }}>
      <figcaption
        style={{
          fontSize: "12px",
          color: "var(--sd-text-primary)",
          fontWeight: 600,
          marginBottom: "4px",
        }}
      >
        {title}{" "}
        <span style={{ color: VIZ_COLORS.label, fontWeight: 400 }}>
          · {unitNote}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        style={{ display: "block", maxWidth: "none" }}
        role="img"
        aria-label={`${title} (${unitNote})`}
      >
        {children}
      </svg>
    </figure>
  );
}

export function HorizontalBarChart({
  title,
  unitNote,
  data,
  reference,
  width = 460,
  labelColumn = 170,
  valueColumn = 78,
}: HorizontalBarChartProps): React.ReactElement {
  const height = data.length * ROW_PITCH_PX + 8;
  const scale = barScale(
    [...data.map((datum) => datum.value), ...(reference?.values ?? [])],
    [labelColumn, width - valueColumn],
  );
  const zeroX = scale.map(0);
  return (
    <ChartFrame title={title} unitNote={unitNote} height={height} width={width}>
      {data.map((datum, row) => {
        const y = 4 + row * ROW_PITCH_PX;
        const end = scale.map(datum.value);
        const fill = datum.accent ? VIZ_COLORS.accent : VIZ_COLORS.context;
        return (
          <g
            key={datum.key}
            data-key={datum.key}
            data-accent={datum.accent ? "true" : "false"}
          >
            <text
              x={labelColumn - 6}
              y={y + ROW_PITCH_PX / 2 + 4}
              textAnchor="end"
              fontSize={VIZ_LABEL_FONT_PX}
              fill={VIZ_COLORS.label}
            >
              {datum.label}
            </text>
            <rect
              x={Math.min(zeroX, end)}
              y={y + 3}
              width={Math.abs(end - zeroX)}
              height={ROW_PITCH_PX - 6}
              fill={fill}
            />
            {reference?.values[row] !== undefined ? (
              <line
                x1={scale.map(reference.values[row])}
                y1={y + 1}
                x2={scale.map(reference.values[row])}
                y2={y + ROW_PITCH_PX - 1}
                stroke={VIZ_COLORS.label}
                strokeWidth={1.5}
              >
                <title>{`${reference.label}: ${reference.values[row]}`}</title>
              </line>
            ) : null}
            <text
              x={
                Math.max(
                  zeroX,
                  end,
                  reference?.values[row] !== undefined
                    ? scale.map(reference.values[row])
                    : end,
                ) + 4
              }
              y={y + ROW_PITCH_PX / 2 + 4}
              fontSize={VIZ_LABEL_FONT_PX}
              fill={datum.accent ? VIZ_COLORS.accent : VIZ_COLORS.label}
              fontWeight={datum.accent ? 700 : 400}
            >
              {datum.valueLabel}
            </text>
          </g>
        );
      })}
      <line
        x1={zeroX}
        y1={2}
        x2={zeroX}
        y2={height - 2}
        stroke={VIZ_COLORS.baseline}
        strokeWidth={1}
      />
    </ChartFrame>
  );
}

export interface DotPlotProps extends AlignedChartProps {
  readonly reference?:
    { readonly label: string; readonly values: readonly number[] } | undefined;
}

export function DotPlot({
  title,
  unitNote,
  data,
  reference,
  width = 460,
  labelColumn = 170,
  valueColumn = 78,
}: DotPlotProps): React.ReactElement {
  const height = data.length * ROW_PITCH_PX + 8;
  const domain = zeroAnchoredDomain([
    ...data.map((datum) => datum.value),
    ...(reference?.values ?? []),
  ]);
  const scale = linearScale(domain, [labelColumn + 4, width - valueColumn - 8]);
  const zeroX = scale.map(0);
  return (
    <ChartFrame title={title} unitNote={unitNote} height={height} width={width}>
      <line
        x1={zeroX}
        y1={2}
        x2={zeroX}
        y2={height - 2}
        stroke={VIZ_COLORS.baseline}
        strokeWidth={1}
      />
      {data.map((datum, row) => {
        const y = 4 + row * ROW_PITCH_PX;
        const cy = y + ROW_PITCH_PX / 2;
        const cx = scale.map(datum.value);
        const tick = reference?.values[row];
        return (
          <g
            key={datum.key}
            data-key={datum.key}
            data-accent={datum.accent ? "true" : "false"}
          >
            <text
              x={labelColumn - 6}
              y={cy + 4}
              textAnchor="end"
              fontSize={VIZ_LABEL_FONT_PX}
              fill={VIZ_COLORS.label}
            >
              {datum.label}
            </text>
            <line
              x1={labelColumn + 4}
              y1={cy}
              x2={width - valueColumn - 8}
              y2={cy}
              stroke={VIZ_COLORS.context}
              strokeWidth={0.5}
              strokeOpacity={0.5}
            />
            {tick !== undefined ? (
              <line
                x1={scale.map(tick)}
                y1={cy - 6}
                x2={scale.map(tick)}
                y2={cy + 6}
                stroke={VIZ_COLORS.label}
                strokeWidth={1.5}
              >
                <title>{`${reference?.label ?? "reference"}: ${tick.toFixed(2)}`}</title>
              </line>
            ) : null}
            <circle
              cx={cx}
              cy={cy}
              r={datum.accent ? 5 : 4}
              fill={datum.accent ? VIZ_COLORS.accent : VIZ_COLORS.context}
              stroke={datum.accent ? "none" : VIZ_COLORS.label}
              strokeWidth={datum.accent ? 0 : 1}
            />
            <text
              x={width - valueColumn + 6}
              y={cy + 4}
              fontSize={VIZ_LABEL_FONT_PX}
              fill={datum.accent ? VIZ_COLORS.accent : VIZ_COLORS.label}
              fontWeight={datum.accent ? 700 : 400}
            >
              {datum.valueLabel}
            </text>
          </g>
        );
      })}
    </ChartFrame>
  );
}

export interface ChartFailClosedProps {
  readonly title: string;
  readonly error: Error;
  readonly detail?: string | undefined;
}

export function ChartFailClosed({
  title,
  error,
  detail,
}: ChartFailClosedProps): React.ReactElement {
  return (
    <div
      role="alert"
      data-fail-closed="true"
      className="sd-card"
      style={{
        borderLeft: "4px solid var(--sd-tier-alert)",
        fontSize: "12px",
        color: "var(--sd-text-primary)",
      }}
    >
      <div
        style={{
          fontWeight: 700,
          color: "var(--sd-tier-alert)",
          marginBottom: "4px",
        }}
      >
        {title}: chart withheld ({error.name})
      </div>
      <div className="sd-mono" style={{ color: VIZ_COLORS.label }}>
        {error.message}
      </div>
      {detail ? (
        <div style={{ marginTop: "4px", color: VIZ_COLORS.label }}>
          {detail}
        </div>
      ) : null}
    </div>
  );
}
