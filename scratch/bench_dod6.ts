import { resolve } from "node:path";
import { createDod6V54LifetimeReader } from "../lib/dod6_v54_lifetime_reader.ts";

const PATH = resolve("data/sportsdesk_unified_baseline_v54.dodbin");
const N = 100_000;

function ms(ns: number): number {
  return ns / 1e6;
}

const profiles = (await Bun.file("data/customer-profiles.json").json()) as {
  profiles?: Array<{ customerId?: string }>;
};
const wagers = (await Bun.file("data/live-wagers.json").json()) as {
  LIST?: Array<Record<string, unknown>>;
};
const bets = (await Bun.file("data/live-bets.json").json()) as {
  games?: Array<Record<string, unknown>>;
};
const logins = new Set<string>();
for (const profile of profiles.profiles ?? []) {
  if (typeof profile.customerId === "string") logins.add(profile.customerId.trim());
}
for (const row of wagers.LIST ?? []) {
  for (const key of ["Login", "CustomerID", "CustomerId", "customerID"]) {
    const value = row[key];
    if (typeof value === "string") logins.add(value.trim());
  }
}
for (const row of bets.games ?? []) {
  for (const key of ["customerID", "CustomerID", "Login"]) {
    const value = row[key];
    if (typeof value === "string") logins.add(value.trim());
  }
}
const candidates = [...logins].filter((login) => login !== "");

const creation: number[] = [];
let reader: Awaited<ReturnType<typeof createDod6V54LifetimeReader>> = null;
for (let i = 0; i < 3; i += 1) {
  const start = Bun.nanoseconds();
  reader = await createDod6V54LifetimeReader(PATH);
  creation.push(ms(Bun.nanoseconds() - start));
}
if (reader === null) throw new Error("reader is null");
console.log("creation ms", creation.map((n) => n.toFixed(1)).join(", "));
console.log("meta", reader.meta);

const hitLogins = candidates.filter((login) => reader!.lookup(login) !== null);
console.log("candidates", candidates.length, "hits", hitLogins.length);

for (let i = 0; i < 1000; i += 1) reader.lookup(hitLogins[i % hitLogins.length]!);

Bun.gc(true);
const heapBefore = process.memoryUsage().heapUsed;
let start = Bun.nanoseconds();
let nonNull = 0;
for (let i = 0; i < N; i += 1) {
  const row = reader.lookup(hitLogins[i % hitLogins.length]!);
  if (row !== null) nonNull += 1;
}
const hitNs = Bun.nanoseconds() - start;
console.log(
  `hit lookup: ${(hitNs / N).toFixed(1)} ns/op, ${(N / (hitNs / 1e9)).toFixed(0)} ops/s, non-null=${nonNull}`,
);

start = Bun.nanoseconds();
let misses = 0;
for (let i = 0; i < N; i += 1) {
  const row = reader.lookup(`ZZZ_MISS_${i}`);
  if (row === null) misses += 1;
}
const missNs = Bun.nanoseconds() - start;
console.log(
  `miss lookup: ${(missNs / N).toFixed(1)} ns/op, ${(N / (missNs / 1e9)).toFixed(0)} ops/s, null=${misses}`,
);

const hot = hitLogins[0]!;
for (let i = 0; i < 1000; i += 1) reader.lookup(hot);
start = Bun.nanoseconds();
for (let i = 0; i < N; i += 1) reader.lookup(hot);
const hotNs = Bun.nanoseconds() - start;
console.log(
  `hot lookup (${hot}): ${(hotNs / N).toFixed(1)} ns/op, ${(N / (hotNs / 1e9)).toFixed(0)} ops/s`,
);

const heapAfter = process.memoryUsage().heapUsed;
console.log("heap delta KB", ((heapAfter - heapBefore) / 1024).toFixed(1));
