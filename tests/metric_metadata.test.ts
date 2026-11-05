import { describe, expect, test } from "bun:test";

import {
  METRIC_METADATA_KINDS,
  isMetricMetadataKind,
} from "../lib/metric_metadata.ts";

describe("metric metadata taxonomy", () => {
  test("is the seven kinds, all nouns", () => {
    expect([...METRIC_METADATA_KINDS]).toEqual([
      "population",
      "baseline",
      "metric",
      "parameter",
      "distribution",
      "quality",
      "caveat",
    ]);
  });

  test("refuses the old suffix kinds", () => {
    for (const kind of [
      "ranking-metric",
      "rate-metric",
      "classification-metric",
      "sampling-metric",
      "pending-metric",
      "measurement-quality",
      "label-composition",
      "population-slice",
      "scope",
      "unit",
      "label",
    ]) {
      expect(isMetricMetadataKind(kind)).toBe(false);
    }
  });
});
