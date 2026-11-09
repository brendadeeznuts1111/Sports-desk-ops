#!/usr/bin/env bun
/**
 * @file bench_bridge3b_workload.ts
 * @description Sustained benchmark and profiling workload for F402 Pending Bets Bridge 3B.
 * Replays realistic pending fixture batches across configurable iterations (default: 1,000)
 * to measure latency distributions (min, median, p95, p99, max), throughput, and verify
 * zero collection allocations and flat heap retention.
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { heapStats } from "bun:jsc";
import { buildF402PendingRollup } from "../lib/f402_pending_rollup.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      default: "tests/f402-pending-wager-sample.json",
    },
    mimalloc: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`Usage: bun run scripts/bench_bridge3b_workload.ts [flags]

Flags:
  -n, --iterations <n>  Number of measurement iterations (default: 1000)
  -w, --warmup <n>      Number of unmeasured warmup iterations (default: 50)
  -r, --rows <n>        Target rows per iteration (scales fixture; default: 100)
  -f, --fixture <path>  Fixture path relative to repo root (default: tests/f402-pending-wager-sample.json)
  --mimalloc            Dump native mimalloc heap arena stats after execution
  --json                Output results as JSON
  -h, --help            Show this help message
`);
  process.exit(0);
}

const totalIterations = Math.max(1, parseInt(values.iterations ?? "1000", 10));
const warmupIterations = Math.max(0, parseInt(values.warmup ?? "50", 10));
const targetRows = Math.max(1, parseInt(values.rows ?? "100", 10));
const fixtureRelPath = values.fixture ?? "tests/f402-pending-wager-sample.json";
const fixtureFullPath = resolve(repoRoot, fixtureRelPath);

const fixtureFile = Bun.file(fixtureFullPath);
if (!(await fixtureFile.exists())) {
  console.error(`Error: Fixture file not found: ${fixtureFullPath}`);
  process.exit(1);
}

const sampleRow = (await fixtureFile.json()) as Record<string, unknown>;
const baseRows: Record<string, unknown>[] = Array.isArray(sampleRow)
  ? sampleRow
  : Array.isArray((sampleRow as { Pending?: unknown }).Pending)
    ? ((sampleRow as { Pending: unknown[] }).Pending as Record<
        string,
        unknown
      >[])
    : [sampleRow];

const activeRows: Record<string, unknown>[] = [];
for (let i = 0; i < targetRows; i++) {
  const base = baseRows[i % baseRows.length]!;
  activeRows.push({
    ...base,
    TicketNumber: 1000000 + i,
    WagerNumber: 1,
    AmountWagered: 1_000_000,
    ToWinAmount: 2_000_000,
    SportType: i % 2 === 0 ? "Football" : "Basketball",
    PeriodDescription: "Game",
    Team1RotNum: 200 + (i % 20),
    Team2RotNum: 201 + (i % 20),
    ChosenTeamID: "Dallas Cowboys",
    Team2ID: "Dallas Cowboys",
  });
}

// Write to temp file for buildF402PendingRollup
const tempDir = await mkdtemp(join(tmpdir(), "bench-3b-"));
const benchFixturePath = join(tempDir, "pending-bench.json");
await writeFile(benchFixturePath, JSON.stringify({ Pending: activeRows }));

// 2. Warmup phase
for (let i = 0; i < warmupIterations; i++) {
  await buildF402PendingRollup(benchFixturePath, {
    deskDate: "2026-11-08",
    sourceKind: "fixture",
  });
}

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
  await buildF402PendingRollup(benchFixturePath, {
    deskDate: "2026-11-08",
    sourceKind: "fixture",
  });
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

latenciesNs.sort((a, b) => a - b);

const sumNs = latenciesNs.reduce((acc, v) => acc + v, 0);
const meanNs = sumNs / totalIterations;
const minNs = latenciesNs[0]!;
const maxNs = latenciesNs[latenciesNs.length - 1]!;
const p50Ns = latenciesNs[Math.floor(totalIterations * 0.5)]!;
const p90Ns = latenciesNs[Math.floor(totalIterations * 0.9)]!;
const p95Ns = latenciesNs[Math.floor(totalIterations * 0.95)]!;
const p99Ns = latenciesNs[Math.floor(totalIterations * 0.99)]!;

const throughputOpsPerSec = Math.round(
  (totalIterations / benchmarkElapsedNs) * 1_000_000_000,
);
const rowsPerSec = Math.round(throughputOpsPerSec * targetRows);

const nsToUs = (ns: number): number => Math.round((ns / 1000) * 100) / 100;
const nsToMs = (ns: number): number =>
  Math.round((ns / 1_000_000) * 1000) / 1000;

const heapGrowthBytes = memAfter.heapUsed - memBefore.heapUsed;
const heapGrowthKb = heapGrowthBytes / 1024;
const heapGrowthPerIter = Math.round(heapGrowthBytes / totalIterations);

const result = {
  benchmark: "Bridge 3B F402 Pending Rollup (SoA)",
  workload: {
    iterations: totalIterations,
    warmup: warmupIterations,
    rowsPerIteration: targetRows,
    totalRowsProcessed: totalIterations * targetRows,
    elapsedMs: Math.round(benchmarkElapsedMs * 100) / 100,
  },
  throughput: {
    rollupsPerSec: throughputOpsPerSec,
    rowsPerSec,
  },
  latency: {
    unit: "microseconds",
    minUs: nsToUs(minNs),
    medianUs: nsToUs(p50Ns),
    meanUs: nsToUs(meanNs),
    p90Us: nsToUs(p90Ns),
    p95Us: nsToUs(p95Ns),
    p99Us: nsToUs(p99Ns),
    maxUs: nsToUs(maxNs),
    p50Ms: nsToMs(p50Ns),
    p99Ms: nsToMs(p99Ns),
  },
  memory: {
    deltaStructure,
    deltaPropertyTable,
    heapGrowthKb: Math.round(heapGrowthKb * 10) / 10,
    heapGrowthPerIterationBytes: heapGrowthPerIter,
    rssMb: Math.round((memAfter.rss / 1024 / 1024) * 10) / 10,
  },
};

// Cleanup temp fixture
await rm(tempDir, { recursive: true, force: true });

if (values.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(
    "================================================================================",
  );
  console.log(
    `  BRIDGE 3B WORKLOAD BENCHMARK: ${totalIterations} iterations × ${targetRows} rows (${(totalIterations * targetRows).toLocaleString()} total rows)`,
  );
  console.log(
    "================================================================================",
  );
  console.log("  [Throughput & Workload]");
  console.log(
    `    • Total Duration:    ${result.workload.elapsedMs.toFixed(2)} ms`,
  );
  console.log(
    `    • Rollups/Sec:       ${result.throughput.rollupsPerSec.toLocaleString()} ops/sec`,
  );
  console.log(
    `    • Rows/Sec:          ${result.throughput.rowsPerSec.toLocaleString()} rows/sec`,
  );
  console.log("  [Latency Distribution]");
  console.log(`    • Min:               ${result.latency.minUs} µs`);
  console.log(
    `    • Median (p50):      ${result.latency.medianUs} µs (${result.latency.p50Ms} ms)`,
  );
  console.log(`    • Mean:              ${result.latency.meanUs} µs`);
  console.log(`    • p90:               ${result.latency.p90Us} µs`);
  console.log(`    • p95:               ${result.latency.p95Us} µs`);
  console.log(
    `    • p99:               ${result.latency.p99Us} µs (${result.latency.p99Ms} ms)`,
  );
  console.log(`    • Max:               ${result.latency.maxUs} µs`);
  console.log("  [Heap & Shape Retention]");
  console.log(
    `    • Delta Structure:   ${result.memory.deltaStructure >= 0 ? "+" : ""}${result.memory.deltaStructure}`,
  );
  console.log(
    `    • Delta PropertyTab: ${result.memory.deltaPropertyTable >= 0 ? "+" : ""}${result.memory.deltaPropertyTable}`,
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
