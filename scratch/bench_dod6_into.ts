import { resolve } from "node:path";
import { heapStats } from "bun:jsc";
import {
  createDod6V54LifetimeReader,
  type Dod6LifetimeLookupTarget,
} from "../lib/dod6_v54_lifetime_reader.ts";

interface HeapSnap {
  readonly objectCount: number;
  readonly extraMemorySize: number;
}

/**
 * `heapStats()` allocates its own `objectTypeCounts` record, so the snapshot is taken and
 * dropped, then GC'd again. Without that, the snapshot overhead (~250–330 objects) looks like
 * per-lookup allocation.
 */
function snapHeap(): HeapSnap {
  Bun.gc(true);
  const stats = heapStats();
  const snap = {
    objectCount: stats.objectCount,
    extraMemorySize: stats.extraMemorySize,
  };
  Bun.gc(true);
  return snap;
}

const beforeOpen = snapHeap();
const reader = await createDod6V54LifetimeReader(
  resolve("data/sportsdesk_unified_baseline_v54.dodbin"),
);
if (reader === null) throw new Error("reader is null");
const afterOpen = snapHeap();

const profiles = (await Bun.file("data/customer-profiles.json").json()) as {
  profiles?: Array<{ customerId?: string }>;
};
const wagers = (await Bun.file("data/live-wagers.json").json()) as {
  LIST?: Array<Record<string, unknown>>;
};
const logins = new Set<string>();
for (const profile of profiles.profiles ?? []) {
  if (typeof profile.customerId === "string") logins.add(profile.customerId.trim());
}
for (const row of wagers.LIST ?? []) {
  for (const key of ["Login", "CustomerID"]) {
    const value = row[key];
    if (typeof value === "string") logins.add(value.trim());
  }
}
const hits = [...logins].filter((login) => reader.lookup(login) !== null);
const target: Dod6LifetimeLookupTarget = {
  clvBps: null,
  sharpScore: null,
  lifetimeNetUsd: null,
  clvLegs: 0,
  avgClvPoints: null,
  sharpCandidateGatePassed: false,
  source: "lifetime_csv",
  handleKind: "row-index-fallback",
  handleValue: null,
};

const N = 500_000;
let sink = 0;
for (let i = 0; i < 1_000_000; i += 1) reader.lookupInto(hits[i % hits.length]!, target);

// Calibrate the snapshot itself with an equally long non-allocating loop.
const calibA = snapHeap();
let calibSink = 0;
for (let i = 0; i < N; i += 1) calibSink += i & 1;
const calibB = snapHeap();
const snapshotObjectOverhead = calibB.objectCount - calibA.objectCount;

const beforeLookup = snapHeap();
const beforeHeapUsed = process.memoryUsage().heapUsed;
const start = Bun.nanoseconds();
for (let i = 0; i < N; i += 1) {
  if (reader.lookupInto(hits[i % hits.length]!, target)) sink += target.clvLegs & 1;
}
const ns = Bun.nanoseconds() - start;
const afterHeapUsed = process.memoryUsage().heapUsed;
const afterLookup = snapHeap();

// Second phase: any one-time JIT/code objects have already been created, so this is the
// steady-state allocation signal.
const steadyA = snapHeap();
let steadySink = 0;
for (let i = 0; i < N; i += 1) {
  if (reader.lookupInto(hits[i % hits.length]!, target)) steadySink += target.clvLegs & 1;
}
const steadyB = snapHeap();

console.log(
  JSON.stringify({
    bunVersion: Bun.version,
    bunVersionWithSha: Bun.version_with_sha,
    bunRevision: Bun.revision,
    hits: hits.length,
    nsPerOp: Number((ns / N).toFixed(1)),
    opsPerSec: Math.round(N / (ns / 1e9)),
    heapUsedDeltaKB: Number(((afterHeapUsed - beforeHeapUsed) / 1024).toFixed(1)),
    openObjectCountDelta: afterOpen.objectCount - beforeOpen.objectCount,
    openExtraMemoryDeltaKB: Number(
      ((afterOpen.extraMemorySize - beforeOpen.extraMemorySize) / 1024).toFixed(1),
    ),
    lookupObjectCountDelta: afterLookup.objectCount - beforeLookup.objectCount,
    lookupExtraMemoryDeltaKB: Number(
      ((afterLookup.extraMemorySize - beforeLookup.extraMemorySize) / 1024).toFixed(1),
    ),
    steadyObjectCountDelta: steadyB.objectCount - steadyA.objectCount,
    steadyExtraMemoryDeltaKB: Number(
      ((steadyB.extraMemorySize - steadyA.extraMemorySize) / 1024).toFixed(1),
    ),
    snapshotObjectOverhead,
    calibSink,
    steadySink,
    sink,
  }),
);
