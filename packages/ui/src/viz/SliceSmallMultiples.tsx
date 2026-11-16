/**
 * @file packages/ui/src/viz/SliceSmallMultiples.tsx
 * @description Handle (extensive, $) and hold % (intensive) as separate aligned small multiples,
 * sharing one sorted slice order. Fails closed when staged handle does not conserve to the SLO total.
 */

import React from "react";
import type { SliceMetrics } from "@sportsdesk-ops/contracts/slice-metrics";
import {
  ChartFailClosed,
  DotPlot,
  HorizontalBarChart,
  type ChartDatum,
} from "./charts.tsx";
import {
  ConservationError,
  StagingValueError,
  ZeroBaselineError,
  assertConservation,
  formatUsdFromCents,
  isModifiedZOutlier,
  modifiedZScores,
  sortDescendingBy,
  stageCentsSeries,
} from "./perceptual.ts";

export interface SliceSmallMultiplesModel {
  readonly order: readonly string[];
  readonly handle: readonly ChartDatum[];
  readonly hold: readonly ChartDatum[];
  readonly floors: readonly number[];
  readonly stagedTotalCents: number;
}

export function isActionableHoldOutlier(
  row: Pick<SliceMetrics, "floor_delta_pct">,
  modifiedZ: number,
): boolean {
  return row.floor_delta_pct < 0 || isModifiedZOutlier(modifiedZ);
}

export function buildSliceSmallMultiples(
  rows: readonly SliceMetrics[],
  controlTotalHandleUsd: number,
): SliceSmallMultiplesModel {
  const series = stageCentsSeries(rows, {
    key: (row) => row.slice_id,
    value: (row) => row.handle_usd,
  });
  assertConservation(series, controlTotalHandleUsd);
  const bySlice = new Map(rows.map((row) => [row.slice_id, row] as const));
  const ordered = sortDescendingBy(series.points, (point) => point.cents);
  const orderedRows = ordered.map((point) => bySlice.get(point.key)!);
  const zScores = modifiedZScores(orderedRows.map((row) => row.hold_total_pct));
  const accentByKey = new Map(
    orderedRows.map(
      (row, position) =>
        [
          row.slice_id,
          isActionableHoldOutlier(row, zScores[position]!),
        ] as const,
    ),
  );
  return {
    order: ordered.map((point) => point.key),
    handle: ordered.map((point) => ({
      key: point.key,
      label: point.label,
      value: point.cents,
      valueLabel: formatUsdFromCents(point.cents),
      accent: accentByKey.get(point.key) ?? false,
    })),
    hold: orderedRows.map((row) => ({
      key: row.slice_id,
      label: row.slice_id,
      value: row.hold_total_pct,
      valueLabel: `${row.hold_total_pct.toFixed(2)}%`,
      accent: accentByKey.get(row.slice_id) ?? false,
    })),
    floors: orderedRows.map((row) => row.hold_floor_pct),
    stagedTotalCents: series.stagedTotalCents,
  };
}

export interface SliceSmallMultiplesProps {
  readonly rows: readonly SliceMetrics[];
  readonly controlTotalHandleUsd: number;
}

export function SliceSmallMultiples({
  rows,
  controlTotalHandleUsd,
}: SliceSmallMultiplesProps): React.ReactElement {
  let model: SliceSmallMultiplesModel;
  try {
    model = buildSliceSmallMultiples(rows, controlTotalHandleUsd);
  } catch (error) {
    if (
      error instanceof ConservationError ||
      error instanceof StagingValueError ||
      error instanceof ZeroBaselineError
    ) {
      return (
        <ChartFailClosed
          title="Slice handle vs hold"
          error={error}
          detail={
            error instanceof ConservationError
              ? `Δ ${formatUsdFromCents(error.delta)} between staged slice handle and the SLO control total.`
              : undefined
          }
        />
      );
    }
    throw error;
  }
  return (
    <div className="sd-card" data-viz="slice-small-multiples">
      <div
        style={{
          fontSize: "11px",
          color: "var(--sd-text-secondary)",
          marginBottom: "8px",
        }}
      >
        Slices sorted by handle. Handle (extensive) and hold % (intensive) are
        separate panels on separate axes. Amber = actionable: hold below its
        configured floor, or |modified z| &gt; 3.5 across slices. Σ handle{" "}
        {formatUsdFromCents(model.stagedTotalCents)} reconciles to the SLO
        control total.
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
          gap: "16px",
        }}
      >
        <HorizontalBarChart
          title="Handle by slice"
          unitNote="USD, zero-anchored"
          data={model.handle}
        />
        <DotPlot
          title="Hold % by slice"
          unitNote="tick = configured floor"
          data={model.hold}
          reference={{ label: "floor", values: model.floors }}
        />
      </div>
    </div>
  );
}
