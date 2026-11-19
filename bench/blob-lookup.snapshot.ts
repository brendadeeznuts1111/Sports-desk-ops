// Run with: bun --no-env-file run bench/blob-lookup.snapshot.ts
import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";

const trials = 12;
const warmup = 500;
const batchSize = 5_000;
const payload = "SportsDesk Blob lookup";
type Kind = "own" | "foreign";

function single(href: string) {
  const uptimeBeforeSeconds = process.uptime();
  const startNs = Bun.nanoseconds();
  const result = resolveObjectURL(href);
  const endNs = Bun.nanoseconds();
  const uptimeAfterSeconds = process.uptime();
  return { uptimeBeforeSeconds, startNs, endNs, elapsedNs: endNs - startNs,
    uptimeAfterSeconds, found: result !== undefined };
}

function batch(href: string, count: number) {
  let hits = 0;
  const startNs = Bun.nanoseconds();
  for (let i = 0; i < count; i++) {
    if (resolveObjectURL(href) !== undefined) hits++;
  }
  const elapsedNs = Bun.nanoseconds() - startNs;
  return { count, hits, elapsedNs, meanNsPerLookup: elapsedNs / count };
}

function child(foreign: string, order: Kind[]) {
  const own = URL.createObjectURL(new Blob([payload]));
  try {
    const ids = { own, foreign };
    const first = {} as Record<Kind, ReturnType<typeof single>>;
    const warmed = {} as Record<Kind, ReturnType<typeof batch>>;
    for (const kind of order) {
      first[kind] = single(ids[kind]);
      assert.equal(first[kind].found, kind === "own");
    }
    for (const kind of order) batch(ids[kind], warmup);
    for (const kind of order) {
      warmed[kind] = batch(ids[kind], batchSize);
      assert.equal(warmed[kind].hits, kind === "own" ? batchSize : 0);
    }
    const clockReadGapsNs = Array.from({ length: 100 }, () => {
      const start = Bun.nanoseconds();
      return Bun.nanoseconds() - start;
    });
    return { pid: process.pid, ppid: process.ppid, order, first, warmed, clockReadGapsNs };
  } finally {
    URL.revokeObjectURL(own);
  }
}

async function workerLookup(href: string) {
  const worker = new Worker(`
    const { parentPort, workerData, threadId } = require("node:worker_threads");
    const blob = require("node:buffer").resolveObjectURL(workerData);
    parentPort.postMessage({ pid: process.pid, threadId, found: blob !== undefined });
  `, { eval: true, workerData: href });
  try {
    return await new Promise<{pid: number; threadId: number; found: boolean}>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", code => reject(new Error("Worker exited before replying: " + code)));
    });
  } finally {
    await worker.terminate();
  }
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { n: sorted.length, min: sorted[0], median, max: sorted.at(-1) };
}

if (process.argv[2] === "--child") {
  const order: Kind[] = process.argv[4] === "own" ? ["own", "foreign"] : ["foreign", "own"];
  console.log(JSON.stringify(child(process.argv[3]!, order)));
} else {
  const pin = (await Bun.file(new URL("../.bun-version", import.meta.url)).text()).trim();
  assert.equal(Bun.version, pin);
  const href = URL.createObjectURL(new Blob([payload]));
  const results = [];
  try {
    const parentBefore = single(href);
    const workerBefore = await workerLookup(href);
    assert.ok(parentBefore.found && workerBefore.found);
    assert.equal(workerBefore.pid, process.pid);
    for (let i = 0; i < trials; i++) {
      const firstKind = i % 2 === 0 ? "foreign" : "own";
      const start = Bun.nanoseconds();
      const proc = Bun.spawnSync([process.execPath, "--no-env-file", "run", import.meta.path,
        "--child", href, firstKind], { timeout: 10_000 });
      const spawnToExitNs = Bun.nanoseconds() - start;
      if (!proc.success) throw new Error(proc.stderr.toString() || "Child failed");
      const row: ReturnType<typeof child> = JSON.parse(proc.stdout.toString());
      assert.equal(row.ppid, process.pid);
      assert.notEqual(row.pid, process.pid);
      results.push({ trial: i + 1, spawnToExitNs, ...row });
    }
    const parentAfterChildren = single(href);
    assert.ok(parentAfterChildren.found);
    URL.revokeObjectURL(href);
    const parentAfterRevoke = single(href);
    const workerAfterRevoke = await workerLookup(href);
    assert.ok(!parentAfterRevoke.found && !workerAfterRevoke.found);

    const summary = (kind: Kind) => ({
      firstInProcessNs: distribution(results.filter(r => r.order[0] === kind).map(r => r.first[kind].elapsedNs)),
      warmedBatchMeanNs: distribution(results.map(r => r.warmed[kind].meanNsPerLookup)),
    });
    console.log(JSON.stringify({
      schemaVersion: 1, capturedAt: new Date().toISOString(),
      runtime: { version: Bun.version, revision: Bun.revision, platform: process.platform,
        arch: process.arch, cpu: cpus()[0]?.model },
      command: "bun --no-env-file run bench/blob-lookup.snapshot.ts",
      settings: { trials, warmupPerKind: warmup, batchSize, adjacentClockReadsPerChild: 100 },
      parentPid: process.pid, parentBefore, workerBefore, parentAfterChildren, parentAfterRevoke, workerAfterRevoke,
      summary: { own: summary("own"), foreign: summary("foreign"),
        pairedWarmOwnMinusForeignNs: distribution(results.map(r => r.warmed.own.meanNsPerLookup - r.warmed.foreign.meanNsPerLookup)),
        adjacentClockReadGapNs: distribution(results.flatMap(r => r.clockReadGapsNs)),
        firstLookupUptimeSeconds: distribution(results.map(r => r.first[r.order[0]!].uptimeBeforeSeconds)),
        spawnToExitNs: distribution(results.map(r => r.spawnToExitNs)) },
      results,
    }, null, 2));
  } finally {
    URL.revokeObjectURL(href);
  }
}
