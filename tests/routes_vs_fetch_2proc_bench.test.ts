import { describe, expect, test } from "bun:test";
import {
  benchmarkOrder,
  median,
  retainedHeapDelta,
  routeImprovementPct,
  summarizeLatencies,
  summarizeRuns,
  type RunResult,
} from "../bench/routes-vs-fetch-2proc.core";

describe("two-process benchmark contract (pure math)", () => {
  test("rounds alternate AB/BA without dropping a mode", () => {
    expect(benchmarkOrder(4)).toEqual([
      { round: 1, mode: "routes" },
      { round: 1, mode: "fetch" },
      { round: 2, mode: "fetch" },
      { round: 2, mode: "routes" },
      { round: 3, mode: "routes" },
      { round: 3, mode: "fetch" },
      { round: 4, mode: "fetch" },
      { round: 4, mode: "routes" },
    ]);
  });

  test("rejects invalid rounds rather than starting runaway children", () => {
    for (const n of [0, -1, 1.5, NaN, Infinity, 21]) {
      expect(() => benchmarkOrder(n)).toThrow(RangeError);
    }
  });

  test("nearest rank is deterministic and does not reorder caller samples", () => {
    const samples = Float64Array.from(Array.from({ length: 100 }, (_, i) => 100 - i));
    expect(summarizeLatencies(samples)).toEqual({
      p50_us: 50,
      p95_us: 95,
      p99_us: 99,
      max_us: 100,
    });
    expect(samples[0]).toBe(100);
  });

  test("short arrays and zero/invalid latency inputs fail safely", () => {
    expect(summarizeLatencies(new Float64Array([2, 5, 7, 8]))).toEqual({
      p50_us: 5,
      p95_us: 8,
      p99_us: 8,
      max_us: 8,
    });
    expect(() => summarizeLatencies(new Float64Array())).toThrow();
    expect(() => summarizeLatencies(Float64Array.from([1, NaN]))).toThrow();
    expect(() => summarizeLatencies(Float64Array.from([-1, 2]))).toThrow();
  });

  test("heap deltas are signed live survivors, not allocations", () => {
    expect(retainedHeapDelta({ objectCount: 150, heapSize: 8000 }, { objectCount: 140, heapSize: 7000 }, 10)).toEqual({
      retained_cells_per_request: -1,
      retained_bytes_per_request: -100,
    });
    expect(() => retainedHeapDelta({ objectCount: 0, heapSize: 0 }, { objectCount: 1, heapSize: 1 }, 0)).toThrow();
    expect(() => retainedHeapDelta({ objectCount: -1, heapSize: 1 }, { objectCount: 1, heapSize: 1 }, 1)).toThrow();
  });

  test("median handles odd/even counts and invalid values", () => {
    expect(median([9, 1, 5])).toBe(5);
    expect(median([10, 1, 2, 3])).toBe(2.5);
    expect(() => median([])).toThrow();
    expect(() => median([NaN])).toThrow();
  });

  test("run summary is median of independent trial quantiles", () => {
    const make = (round: number, mode: "routes" | "fetch", latency: number): RunResult => ({
      round,
      mode,
      p50_us: latency,
      p95_us: latency + 10,
      p99_us: latency + 20,
      max_us: latency + 30,
      retained_cells_per_request: 0.25,
      retained_bytes_per_request: -3.5,
      heap_before: { objectCount: 100, heapSize: 1000 },
      heap_after: { objectCount: 110, heapSize: 950 },
    });
    const runs = [
      make(1, "routes", 10),
      make(1, "fetch", 40),
      make(2, "routes", 20),
      make(2, "fetch", 60),
      make(3, "routes", 30),
      make(3, "fetch", 80),
    ];
    const routes = summarizeRuns(runs, "routes");
    const manual = summarizeRuns(runs, "fetch");
    expect(routes.p50_us).toBe(20);
    expect(manual.p50_us).toBe(60);
    expect(routes.p95_us).toBe(30);
    expect(routes.retained_bytes_per_request).toBe(-3.5);
    expect(routeImprovementPct(routes, manual)).toBe(66.67);
    expect(() => summarizeRuns([], "routes")).toThrow();
    expect(routeImprovementPct(routes, { ...manual, p50_us: 0 })).toBeNull();
  });
});
