/** Pure benchmark summary math. Importable without starting an HTTP server. */
export type BenchMode = "routes" | "fetch";
export type BenchOrder = { round: number; mode: BenchMode };

export interface HeapSnap {
  objectCount: number;
  heapSize: number;
}

export interface LatencyStats {
  p50_us: number;
  p95_us: number;
  p99_us: number;
  max_us: number;
}

export interface RunResult extends LatencyStats {
  round: number;
  mode: BenchMode;
  retained_cells_per_request: number;
  retained_bytes_per_request: number;
  retained_cells_batch: number;
  retained_bytes_batch: number;
  heap_before: HeapSnap;
  heap_after: HeapSnap;
}

export interface ModeSummary extends LatencyStats {
  mode: BenchMode;
  retained_cells_per_request: number;
  retained_bytes_per_request: number;
}

const rounded = (value: number, digits = 2): number => Number(value.toFixed(digits));

/** Balance round order: AB, BA, AB, BA; one fresh server per observation. */
export function benchmarkOrder(rounds: number): BenchOrder[] {
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 20) {
    throw new RangeError("rounds must be an integer from 1 through 20");
  }
  const output: BenchOrder[] = [];
  for (let round = 1; round <= rounds; round++) {
    const pair: BenchMode[] = round % 2 ? ["routes", "fetch"] : ["fetch", "routes"];
    for (const mode of pair) output.push({ round, mode });
  }
  return output;
}

/** Nearest-rank quantiles; sort an isolated copy, never mutate caller samples. */
export function summarizeLatencies(samples: Float64Array): LatencyStats {
  if (samples.length === 0) throw new RangeError("latency sample cannot be empty");
  const sorted = Float64Array.from(samples).sort();
  for (const value of sorted) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError("invalid latency");
  }
  const at = (q: number): number => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
  return {
    p50_us: rounded(at(0.50)),
    p95_us: rounded(at(0.95)),
    p99_us: rounded(at(0.99)),
    max_us: rounded(sorted[sorted.length - 1]!),
  };
}

/** This is survivor delta after full GC, NOT total allocation pressure. */
export function retainedHeapDelta(before: HeapSnap, after: HeapSnap, requests: number): {
  retained_cells_per_request: number;
  retained_bytes_per_request: number;
} {
  if (!Number.isSafeInteger(requests) || requests <= 0) {
    throw new RangeError("requests must be a positive integer");
  }
  for (const n of [before.objectCount, before.heapSize, after.objectCount, after.heapSize]) {
    if (!Number.isFinite(n) || n < 0) throw new RangeError("invalid heap snapshot");
  }
  return {
    retained_cells_per_request: rounded((after.objectCount - before.objectCount) / requests, 4),
    retained_bytes_per_request: rounded((after.heapSize - before.heapSize) / requests, 2),
  };
}

export function median(values: number[]): number {
  if (!values.length || values.some((n) => !Number.isFinite(n))) {
    throw new RangeError("median requires nonempty finite values");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[half]!
    : (sorted[half - 1]! + sorted[half]!) / 2;
}

/** Median of independent run-level estimates; don't mix raw samples across runs. */
export function summarizeRuns(runs: RunResult[], mode: BenchMode): ModeSummary {
  const rows = runs.filter((r) => r.mode === mode);
  if (!rows.length) throw new RangeError("no runs for mode: " + mode);
  const field = (key: keyof LatencyStats | "retained_cells_per_request" | "retained_bytes_per_request") =>
    rounded(median(rows.map((r) => r[key])), key === "retained_cells_per_request" ? 4 : 2);
  return {
    mode,
    p50_us: field("p50_us"),
    p95_us: field("p95_us"),
    p99_us: field("p99_us"),
    max_us: field("max_us"),
    retained_cells_per_request: field("retained_cells_per_request"),
    retained_bytes_per_request: field("retained_bytes_per_request"),
  };
}

/** Positive indicates lower latency for native routes than manual fetch. */
export function routeImprovementPct(routes: ModeSummary, manual: ModeSummary): number | null {
  return manual.p50_us > 0
    ? rounded(((manual.p50_us - routes.p50_us) / manual.p50_us) * 100)
    : null;
}

/** One signed difference per paired round. Positive values favor native. */
export function pairedLatency(runs: RunResult[]) {
  const rounds = [...new Set(runs.map((run) => run.round))];
  const pairs = rounds.map((round) => {
    const rows = runs.filter((row) => row.round === round);
    const routes = rows.find((row) => row.mode === "routes");
    const manual = rows.find((row) => row.mode === "fetch");
    if (rows.length !== 2 || !routes || !manual) throw new Error("Incomplete or duplicate pair in round " + round);
    return { round, routes, manual };
  });
  return (["p50_us", "p95_us", "p99_us"] as const).map((metric) => {
    const deltas_us = pairs.map(({ round, routes, manual }) => ({
      round,
      delta: rounded(manual[metric] - routes[metric]),
    }));
    const values = deltas_us.map(({ delta }) => delta);
    return {
      metric, deltas_us, pairs: pairs.length,
      native_wins: values.filter((value) => value > 0).length,
      median_us: rounded(median(values)), min_us: Math.min(...values), max_us: Math.max(...values),
    };
  });
}
