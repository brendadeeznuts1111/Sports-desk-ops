import { resolve } from "node:path";
import { createDod6V54LifetimeReader } from "../lib/dod6_v54_lifetime_reader.ts";

const reader = await createDod6V54LifetimeReader(
  resolve("data/sportsdesk_unified_baseline_v54.dodbin"),
);
if (reader === null) throw new Error("reader is null");

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
if (hits.length === 0) throw new Error("no hit logins");

for (let i = 0; i < 20_000; i += 1) reader.lookup(hits[i % hits.length]!);

const N = 500_000;
let sink = 0;
const start = Bun.nanoseconds();
for (let i = 0; i < N; i += 1) {
  const row = reader.lookup(hits[i % hits.length]!);
  if (row !== null) sink += row.clvLegs & 1;
}
const ns = Bun.nanoseconds() - start;
console.log(
  JSON.stringify({
    env: {
      useJIT: Bun.env.BUN_JSC_useJIT ?? "default",
      useDFGJIT: Bun.env.BUN_JSC_useDFGJIT ?? "default",
      useFTLJIT: Bun.env.BUN_JSC_useFTLJIT ?? "default",
    },
    hits: hits.length,
    nsPerOp: Number((ns / N).toFixed(1)),
    opsPerSec: Math.round(N / (ns / 1e9)),
    sink,
  }),
);
