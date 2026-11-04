#!/usr/bin/env bun
/**
 * Benchmarks graded-wager parsing: AoS vs SoA, plus bitset popcount.
 *
 *   bun run bench:graded-wager
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseGradedWagerRowsSoA,
  countLive,
  isLive,
} from "../lib/f402_graded_wager_row.ts";

const html = readFileSync(
  join(import.meta.dir, "../tests/fixtures/f402-graded-wager-rows.html"),
  "utf8",
);

const WARMUP = 5;
const RUNS = 50;

for (let i = 0; i < WARMUP; i++) {
  parseGradedWagerRowsSoA(html);
}
const soaTimes: number[] = [];
for (let i = 0; i < RUNS; i++) {
  const t = performance.now();
  const soa = parseGradedWagerRowsSoA(html);
  soaTimes.push(performance.now() - t);
  // touch result to avoid dead-code elimination
  if (countLive(soa) < 0) throw new Error("unreachable");
}
const soaMin = Math.min(...soaTimes);
const soaP50 = soaTimes.sort((a, b) => a - b)[Math.floor(RUNS / 2)]!;

console.log(
  `SoA parse: min=${soaMin.toFixed(3)}ms p50=${soaP50.toFixed(3)}ms (n=${RUNS})`,
);
console.log(`rows=${parseGradedWagerRowsSoA(html).ticketNumbers.length}`);
console.log(`countLive=${countLive(parseGradedWagerRowsSoA(html))}`);
// bitset access sanity
const soa = parseGradedWagerRowsSoA(html);
console.log(`isLive(0)=${isLive(soa, 0)}`);

// Synthetic scale probe: parse the fixture N times to estimate throughput + heap.
const ITERS = 2000;
const before = process.memoryUsage().heapUsed;
const t0 = performance.now();
for (let i = 0; i < ITERS; i++) {
  parseGradedWagerRowsSoA(html);
}
const elapsed = performance.now() - t0;
const after = process.memoryUsage().heapUsed;
const rowsPerSec = (3 * ITERS) / (elapsed / 1000);
console.log(
  `scale: ${ITERS} parses of 3 rows in ${elapsed.toFixed(1)}ms => ${rowsPerSec.toFixed(0)} rows/s, heap delta ${(after - before) / 1024} KB`,
);
