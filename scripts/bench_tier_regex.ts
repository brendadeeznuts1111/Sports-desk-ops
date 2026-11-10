/**
 * @file scripts/bench_tier_regex.ts
 * @description Nanosecond-resolution microbenchmark for anchored tier regex using Bun.nanoseconds().
 */

import { TIER_KEYWORD_RE as re } from "../lib/terminal_emulator.ts";

const testCases = [
  { name: "Exact match (#CRITICAL)", input: "#CRITICAL" },
  { name: "Emoji + Parens (🚨 CRITICAL (T2))", input: "🚨 CRITICAL (T2)" },
  { name: "Prefix rejection (STEAM100)", input: "STEAM100" },
  { name: "Regular prose rejection", input: "regular bold text in markdown" },
];

console.log("⚡ Anchored Tier Regex Performance (Bun.nanoseconds):");
console.log("─".repeat(70));

const ITERATIONS = 100_000;

for (const { name, input } of testCases) {
  // Warm up
  for (let i = 0; i < 5_000; i++) re.test(input);

  const start = Bun.nanoseconds();
  for (let i = 0; i < ITERATIONS; i++) {
    re.test(input);
  }
  const elapsedNs = Bun.nanoseconds() - start;
  const nsPerOp = (elapsedNs / ITERATIONS).toFixed(1);
  const opsSec = Math.round(ITERATIONS / (elapsedNs / 1e9)).toLocaleString();

  console.log(
    `  ${name.padEnd(35)} -> ${nsPerOp.padStart(5)} ns/op  (${opsSec.padStart(12)} ops/sec)`,
  );
}

console.log("─".repeat(70));
