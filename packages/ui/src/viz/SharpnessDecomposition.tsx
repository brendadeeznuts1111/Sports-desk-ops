/**
 * @file packages/ui/src/viz/SharpnessDecomposition.tsx
 * @description Sharpness score components on one common zero-anchored points scale, sorted, with
 * cap ticks. Fails closed when the components do not sum to the displayed score.
 */

import React from "react";
import {
  ChartFailClosed,
  HorizontalBarChart,
  type ChartDatum,
} from "./charts.tsx";
import {
  ConservationError,
  StagingValueError,
  assertScaledConservation,
  sortDescendingBy,
} from "./perceptual.ts";

export const SCORE_UNITS_PER_POINT = 100;

export interface SharpnessComponent {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly cap: number;
}

export interface SharpnessDecompositionModel {
  readonly data: readonly ChartDatum[];
  readonly caps: readonly number[];
  readonly totalPoints: number;
}

export function buildSharpnessDecomposition(
  components: readonly SharpnessComponent[],
  score: number,
): SharpnessDecompositionModel {
  const totalUnits = assertScaledConservation(
    components,
    score,
    SCORE_UNITS_PER_POINT,
    " pts/100",
  );
  const ordered = sortDescendingBy(components, (component) => component.value);
  return {
    data: ordered.map((component) => ({
      key: component.key,
      label: component.label,
      value: component.value,
      valueLabel: `${component.value.toFixed(2)} / ${component.cap.toFixed(1)}`,
      accent: false,
    })),
    caps: ordered.map((component) => component.cap),
    totalPoints: totalUnits / SCORE_UNITS_PER_POINT,
  };
}

export interface SharpnessDecompositionProps {
  readonly components: readonly SharpnessComponent[];
  readonly score: number;
}

export function SharpnessDecomposition({
  components,
  score,
}: SharpnessDecompositionProps): React.ReactElement {
  let model: SharpnessDecompositionModel;
  try {
    model = buildSharpnessDecomposition(components, score);
  } catch (error) {
    if (
      error instanceof ConservationError ||
      error instanceof StagingValueError
    ) {
      return (
        <ChartFailClosed
          title="Sharpness decomposition"
          error={error}
          detail={
            error instanceof ConservationError
              ? `Components sum to ${(error.delta / SCORE_UNITS_PER_POINT + score).toFixed(2)} but the profile score is ${score.toFixed(2)} (Δ ${(error.delta / SCORE_UNITS_PER_POINT).toFixed(2)} pts).`
              : undefined
          }
        />
      );
    }
    throw error;
  }
  return (
    <div data-viz="sharpness-decomposition">
      <HorizontalBarChart
        title={`Σ ${model.totalPoints.toFixed(2)} / 10.0 pts`}
        unitNote="common 0-based scale · tick = cap"
        data={model.data}
        reference={{ label: "cap", values: model.caps }}
        width={330}
        labelColumn={160}
        valueColumn={76}
      />
    </div>
  );
}
