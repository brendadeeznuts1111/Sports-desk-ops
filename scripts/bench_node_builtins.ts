#!/usr/bin/env bun
/**
 * Cold `require()` timing for the Node.js built-ins Bun lazily initializes.
 *
 * Each module is required in a fresh Bun process, so the number is the first-use cost of the
 * module's internals rather than a second require from the same process. Three runs per module;
 * the table reports the median.
 *
 *   bun run bench:node-builtins
 */

const MODULES = [
  "node:assert",
  "node:https",
  "node:http",
  "node:http2",
  "node:vm",
  "node:fs",
  "node:util",
  "node:tty",
  "node:worker_threads",
  "node:child_process",
] as const;

function coldRequire(name: string): number | null {
  const script = [
    `const t = performance.now();`,
    `require(${JSON.stringify(name)});`,
    `console.log(performance.now() - t);`,
  ].join("\n");
  const proc = Bun.spawnSync([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return null;
  const value = Number(proc.stdout.toString().trim());
  return Number.isFinite(value) ? value : null;
}

const rows: Array<{ module: string; medianMs: string }> = [];
for (const name of MODULES) {
  const samples = [coldRequire(name), coldRequire(name), coldRequire(name)]
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  rows.push({
    module: name,
    medianMs:
      samples.length === 0
        ? "failed"
        : `${samples[Math.floor(samples.length / 2)]!.toFixed(2)} ms`,
  });
}

console.log(Bun.inspect.table(rows, ["module", "medianMs"], { colors: false }));
