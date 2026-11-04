#!/usr/bin/env bun
/**
 * Times the two server response paths in-process: Response.json against JSON.stringify + new
 * Response, and new Response(Bun.file) against reading the bytes first + new Response. Run it on an idle
 * machine; under a parallel test runner the numbers measure the runner.
 *
 *   bun scripts/bench_server.ts
 *
 * Correctness of both paths is asserted in tests/bench_server.test.ts.
 */
import { resolve } from "node:path";

function time(iterations: number, body: () => void): number {
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < iterations; i++) body();
  return (Bun.nanoseconds() - t0) / 1e6;
}

async function timeAsync(
  iterations: number,
  body: () => Promise<void>,
): Promise<number> {
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < iterations; i++) await body();
  return (Bun.nanoseconds() - t0) / 1e6;
}

function report(
  label: string,
  iterations: number,
  rows: readonly [string, number][],
): void {
  console.log(`\n[Benchmark: ${label}] ${iterations} iterations:`);
  for (const [name, ms] of rows) {
    const us = (ms / iterations) * 1000;
    console.log(
      ` • ${name.padEnd(40)}: ${ms.toFixed(3)} ms total (${us.toFixed(2)} µs/op)`,
    );
  }
  const [first, second] = rows;
  if (first !== undefined && second !== undefined) {
    console.log(
      ` • ${"Ratio".padEnd(40)}: ${(first[1] / second[1]).toFixed(2)}x`,
    );
  }
}

const payload = {
  status: "healthy",
  port: 4020,
  runtime: `Bun v${Bun.version}`,
  accounts: Array.from({ length: 25 }, (_, i) => ({
    id: `ACC_${i}`,
    val: i * 100,
    active: i % 2 === 0,
  })),
};
const manualJson = (): void => {
  new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
};
const nativeJson = (): void => {
  Response.json(payload);
};
time(200, manualJson);
time(200, nativeJson);
report("JSON Serialization", 5000, [
  ["Manual (JSON.stringify + headers)", time(5000, manualJson)],
  ["Native (Response.json)", time(5000, nativeJson)],
]);

const filePath = resolve(
  import.meta.dir,
  "../static/customer-churn-simulation-dashboard.html",
);
const headers = { "Content-Type": "text/html; charset=utf-8" };
const eagerFile = async (): Promise<void> => {
  new Response(await Bun.file(filePath).text(), { headers });
};
const lazyFile = (): void => {
  new Response(Bun.file(filePath), { headers });
};
await timeAsync(50, eagerFile);
time(50, lazyFile);
const sizeKb = (Bun.file(filePath).size / 1024).toFixed(1);
report(`Response Handle Construction (${sizeKb} KB)`, 1000, [
  ["Eager (Bun.file().text() + headers)", await timeAsync(1000, eagerFile)],
  ["Native (Bun.file lazy handle creation)", time(1000, lazyFile)],
]);
console.log(
  " Note: measures user-space handle construction. For socket transfers see tests/sendfile_threshold.test.ts.",
);
