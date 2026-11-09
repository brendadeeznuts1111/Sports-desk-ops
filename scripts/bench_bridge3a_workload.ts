#!/usr/bin/env bun
/**
 * @file bench_bridge3a_workload.ts
 * @description Sustained benchmark and profiling workload for Bet Ticker Bridge 3A.
 * Replays realistic 100-row getBetTicker fixture batches across configurable iterations
 * (default: 1,000) to collect statistically robust latency distributions (min, median,
 * p95, p99, max), verify memory stability, and provide sufficient CPU/Heap profile samples.
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { heapStats } from "bun:jsc";
import {
  buildF402TickerSnapshot,
  projectF402TickerDelta,
} from "../lib/f402_bet_ticker_delta.ts";
import { parseF402TickerRow, type F402TickerRow } from "../lib/f402_ingest.ts";

const repoRoot = resolve(import.meta.dir, "..");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    iterations: { type: "string", short: "n", default: "1000" },
    warmup: { type: "string", short: "w", default: "50" },
    rows: { type: "string", short: "r", default: "100" },
    fixture: {
      type: "string",
      short: "f",
      default: "tests/fixtures/live-wagers-LIST-100.json",
    },
    mimalloc: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`Usage: bun run scripts/bench_bridge3a_workload.ts [flags]

Flags:
  -n, --iterations <n>  Number of measurement iterations (default: 1000)
  -w, --warmup <n>      Number of unmeasured warmup iterations (default: 50)
  -r, --rows <n>        Target rows per iteration (scales fixture; default: 100)
  -f, --fixture <path>  Fixture path relative to repo root (default: tests/fixtures/live-wagers-LIST-100.json)
  --mimalloc            Dump native mimalloc heap arena stats after execution
  --json                Output results as JSON
  -h, --help            Show this help message
`);
  process.exit(0);
}

const totalIterations = Math.max(1, parseInt(values.iterations ?? "1000", 10));
const warmupIterations = Math.max(0, parseInt(values.warmup ?? "50", 10));
const targetRows = Math.max(1, parseInt(values.rows ?? "100", 10));
const fixtureRelPath =
  values.fixture ?? "tests/fixtures/live-wagers-LIST-100.json";
const fixtureFullPath = resolve(repoRoot, fixtureRelPath);

// 1. Load and parse fixture rows
const fixtureFile = Bun.file(fixtureFullPath);
if (!(await fixtureFile.exists())) {
  console.error(`Error: Fixture file not found: ${fixtureFullPath}`);
  process.exit(1);
}

const fixtureJson = (await fixtureFile.json()) as { LIST?: unknown[] };
if (!Array.isArray(fixtureJson.LIST)) {
  console.error(
    `Error: Fixture does not contain a LIST array: ${fixtureRelPath}`,
  );
  process.exit(1);
}

const rawRows = fixtureJson.LIST;
const parsedRows: F402TickerRow[] = rawRows
  .map((row) => parseF402TickerRow(row))
  .filter((r): r is F402TickerRow => r !== null);

if (parsedRows.length === 0) {
  console.error(
    `Error: No valid ticker rows parsed from fixture: ${fixtureRelPath}`,
  );
  process.exit(1);
}

// Scale rows to targetRows if requested (e.g. 1k or 10k)
let activeRows: F402TickerRow[] = parsedRows;
if (targetRows !== parsedRows.length) {
  activeRows = [];
  let copyIndex = 0;
  while (activeRows.length < targetRows) {
    const base = parsedRows[copyIndex % parsedRows.length]!;
    const seq = Math.floor(copyIndex / parsedRows.length);
    activeRows.push({
      ...base,
      wagerNumber: seq === 0 ? base.wagerNumber : `${base.wagerNumber}_${seq}`,
      ticketNumber: base.ticketNumber
        ? seq === 0
          ? base.ticketNumber
          : `${base.ticketNumber}_${seq}`
        : "",
    });
    copyIndex++;
  }
}

// 2. Warmup phase
for (let i = 0; i < warmupIterations; i++) {
  const polledAt = new Date(Date.now() + i * 15_000).toISOString();
  const delta = projectF402TickerDelta([], activeRows, polledAt);
  buildF402TickerSnapshot(delta, activeRows.length);
}

// Force GC if available
if (typeof Bun.gc === "function") {
  Bun.gc(true);
}

const jscStatsBefore = heapStats().objectTypeCounts;
const memBefore = process.memoryUsage();
const latenciesNs: number[] = Array.from({ length: totalIterations });

// 3. Measured benchmark loop with nanosecond precision
const benchmarkStartNs = Bun.nanoseconds();

for (let i = 0; i < totalIterations; i++) {
  const tickStartNs = Bun.nanoseconds();
  const polledAt = new Date(1731086400000 + i * 15_000).toISOString();
  const delta = projectF402TickerDelta([], activeRows, polledAt);
  buildF402TickerSnapshot(delta, activeRows.length);
  latenciesNs[i] = Bun.nanoseconds() - tickStartNs;
}

const benchmarkElapsedNs = Bun.nanoseconds() - benchmarkStartNs;
const benchmarkElapsedMs = benchmarkElapsedNs / 1_000_000;

if (typeof Bun.gc === "function") {
  Bun.gc(true);
}
const memAfter = process.memoryUsage();
const jscStatsAfter = heapStats().objectTypeCounts;

const deltaStructure =
  (jscStatsAfter.Structure ?? 0) - (jscStatsBefore.Structure ?? 0);
const deltaPropertyTable =
  (jscStatsAfter.PropertyTable ?? 0) - (jscStatsBefore.PropertyTable ?? 0);

// 4. Statistical aggregation (nanosecond precision, reported in µs and ms)
// Note: The p99 / p50 spread in sustained tight-loop benchmarks is driven by JSC's minor GC
// sweeps (collapses from ~4-5x to ~2x when Bun.gc(true) runs per iteration) and is unobservable
// at live ingestion rates (<500 rows/sec = ~0.03% CPU duty cycle).
latenciesNs.sort((a, b) => a - b);

const sumNs = latenciesNs.reduce((acc, v) => acc + v, 0);
const meanNs = sumNs / totalIterations;
const minNs = latenciesNs[0]!;
const maxNs = latenciesNs[latenciesNs.length - 1]!;
const p50Ns = latenciesNs[Math.floor(totalIterations * 0.5)]!;
const p90Ns = latenciesNs[Math.floor(totalIterations * 0.9)]!;
const p95Ns = latenciesNs[Math.floor(totalIterations * 0.95)]!;
const p99Ns = latenciesNs[Math.floor(totalIterations * 0.99)]!;

const varianceNs =
  latenciesNs.reduce((acc, v) => acc + Math.pow(v - meanNs, 2), 0) /
  totalIterations;
const stdDevNs = Math.sqrt(varianceNs);

const heapGrowthBytes = memAfter.heapUsed - memBefore.heapUsed;
const heapGrowthKb = heapGrowthBytes / 1024;
const opsPerSec = Math.round(totalIterations / (benchmarkElapsedMs / 1000));

const toMs = (ns: number): number => Number((ns / 1_000_000).toFixed(4));
const toUs = (ns: number): number => Number((ns / 1_000).toFixed(2));

const result = {
  fixture: fixtureRelPath,
  rowCount: activeRows.length,
  iterations: totalIterations,
  warmupIterations,
  elapsedMs: Number(benchmarkElapsedMs.toFixed(2)),
  opsPerSec,
  latencies: {
    minUs: toUs(minNs),
    p50Us: toUs(p50Ns),
    meanUs: toUs(meanNs),
    p90Us: toUs(p90Ns),
    p95Us: toUs(p95Ns),
    p99Us: toUs(p99Ns),
    maxUs: toUs(maxNs),
    stdDevUs: toUs(stdDevNs),
    minMs: toMs(minNs),
    p50Ms: toMs(p50Ns),
    meanMs: toMs(meanNs),
    p90Ms: toMs(p90Ns),
    p95Ms: toMs(p95Ns),
    p99Ms: toMs(p99Ns),
    maxMs: toMs(maxNs),
    stdDevMs: toMs(stdDevNs),
  },
  jscHeap: {
    structureBefore: jscStatsBefore.Structure ?? 0,
    structureAfter: jscStatsAfter.Structure ?? 0,
    deltaStructure,
    propertyTableBefore: jscStatsBefore.PropertyTable ?? 0,
    propertyTableAfter: jscStatsAfter.PropertyTable ?? 0,
    deltaPropertyTable,
  },
  memory: {
    heapUsedBeforeKb: Number((memBefore.heapUsed / 1024).toFixed(1)),
    heapUsedAfterKb: Number((memAfter.heapUsed / 1024).toFixed(1)),
    heapGrowthKb: Number(heapGrowthKb.toFixed(1)),
    heapGrowthPerIterationBytes: Number(
      (heapGrowthBytes / totalIterations).toFixed(2),
    ),
    rssMb: Number((memAfter.rss / (1024 * 1024)).toFixed(1)),
  },
};

if (values.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(
    "================================================================================",
  );
  console.log(
    `  ⚡ BRIDGE 3A SUSTAINED WORKLOAD BENCHMARK (${totalIterations} iterations, ${activeRows.length} rows/iter)`,
  );
  console.log(
    "================================================================================",
  );
  console.log(
    `  Fixture:       ${fixtureRelPath} (${activeRows.length} active tickets)`,
  );
  console.log(
    `  Iterations:    ${totalIterations} (warmup: ${warmupIterations})`,
  );
  console.log(
    `  Total Elapsed: ${benchmarkElapsedMs.toFixed(2)} ms (${opsPerSec.toLocaleString()} ops/sec)`,
  );
  console.log(
    "--------------------------------------------------------------------------------",
  );
  console.log("  Latency Distribution (Bun.nanoseconds precision):");
  console.log(`    • Min:       ${toMs(minNs)} ms (${toUs(minNs)} µs)`);
  console.log(`    • Median:    ${toMs(p50Ns)} ms (${toUs(p50Ns)} µs)`);
  console.log(
    `    • Mean:      ${toMs(meanNs)} ms (±${toMs(stdDevNs)} ms / ±${toUs(stdDevNs)} µs)`,
  );
  console.log(`    • p90:       ${toMs(p90Ns)} ms (${toUs(p90Ns)} µs)`);
  console.log(`    • p95:       ${toMs(p95Ns)} ms (${toUs(p95Ns)} µs)`);
  console.log(`    • p99:       ${toMs(p99Ns)} ms (${toUs(p99Ns)} µs)`);
  console.log(`    • Max:       ${toMs(maxNs)} ms (${toUs(maxNs)} µs)`);
  console.log(
    "--------------------------------------------------------------------------------",
  );
  console.log("  JSC Object Type & Retention Invariants:");
  console.log(
    `    • JSC Structure:     ${result.jscHeap.structureBefore} → ${result.jscHeap.structureAfter} (Δ: ${deltaStructure >= 0 ? "+" : ""}${deltaStructure})`,
  );
  console.log(
    `    • JSC PropertyTable: ${result.jscHeap.propertyTableBefore} → ${result.jscHeap.propertyTableAfter} (Δ: ${deltaPropertyTable >= 0 ? "+" : ""}${deltaPropertyTable})`,
  );
  console.log(
    `    • Heap Used Before:  ${result.memory.heapUsedBeforeKb.toFixed(1)} KB`,
  );
  console.log(
    `    • Heap Used After:   ${result.memory.heapUsedAfterKb.toFixed(1)} KB`,
  );
  console.log(
    `    • Net Heap Delta:    ${result.memory.heapGrowthKb >= 0 ? "+" : ""}${result.memory.heapGrowthKb.toFixed(1)} KB (${result.memory.heapGrowthPerIterationBytes} B/iter)`,
  );
  console.log(`    • Process RSS:       ${result.memory.rssMb.toFixed(1)} MB`);
  console.log(
    "================================================================================",
  );
}

if (values.mimalloc) {
  console.log("\n--- Bun mimalloc Heap Dump ---");
  const runtime = globalThis as unknown as {
    Bun?: { unsafe?: { mimallocDump?: () => void } };
  };
  const mimallocDump = runtime.Bun?.unsafe?.mimallocDump;
  if (typeof mimallocDump === "function") {
    mimallocDump();
  } else {
    console.log("mimallocDump is not available in this Bun runtime");
  }
}
