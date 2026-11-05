/**
 * The shared metric-metadata taxonomy. `kind` names what a row is, not what it measures:
 * a ranking metric, a rate and a classifier are all `metric`; their variant is expressed by the
 * fields they carry (k/maxAchievable, unit, evaluates).
 */
export const METRIC_METADATA_KINDS = [
  "population",
  "baseline",
  "metric",
  "parameter",
  "distribution",
  "quality",
  "caveat",
] as const;

export type MetricMetadataKind = (typeof METRIC_METADATA_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(METRIC_METADATA_KINDS);

export function isMetricMetadataKind(kind: string): kind is MetricMetadataKind {
  return KIND_SET.has(kind);
}

/** How a metric was produced; a sampled metric and a fully computed one are not interchangeable. */
export const METRIC_DERIVED_FROM = [
  "sampled",
  "measured",
  "computed",
  "extrapolated",
  "assumed_default",
] as const;

export type MetricDerivedFrom = (typeof METRIC_DERIVED_FROM)[number];

const DERIVED_SET: ReadonlySet<string> = new Set(METRIC_DERIVED_FROM);

export function isMetricDerivedFrom(value: string): value is MetricDerivedFrom {
  return DERIVED_SET.has(value);
}
