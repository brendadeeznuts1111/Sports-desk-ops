#!/usr/bin/env bun
/**
 * Build per-customer profiles from the customer book, offline.
 *
 *   bun run customers:profiles [--book enriched_customers_full.json]
 *                              [--tree data/agent-tree.json]
 *                              [--out data/customer-profiles.json] [--json]
 *
 * The book carries lifetime aggregates plus five recent tickets per customer, so P/L per league,
 * per market and per channel is computable without a portal session. Two things are stated rather
 * than guessed: the ticket window is a five-row sample (`sampleOnly: true`), and `GSLIVE` is a
 * channel proxy for "live", not a verified live flag.
 */

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  buildCustomerProfiles,
  type CustomerRow,
  type TreeIndex,
} from "../lib/customer_profile.ts";

const REPO = join(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    book: {
      type: "string",
      default: join(REPO, "enriched_customers_full.json"),
    },
    tree: { type: "string", default: join(REPO, "data", "agent-tree.json") },
    out: {
      type: "string",
      default: join(REPO, "data", "customer-profiles.json"),
    },
    json: { type: "boolean", default: false },
  },
});

const bookPath = resolve(values.book ?? "");
const rows = (await Bun.file(bookPath)
  .json()
  .catch((error: unknown) => {
    console.error(
      `customers:profiles: cannot read ${bookPath}: ${String(error)}`,
    );
    process.exit(2);
  })) as CustomerRow[];

const tree = (await Bun.file(resolve(values.tree ?? "")).json()) as TreeIndex;
const { profiles, summary } = buildCustomerProfiles(rows, tree);

const outPath = resolve(values.out ?? "");
await Bun.write(
  outPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: {
        book: bookPath.replace(REPO, "."),
        tree: resolve(values.tree ?? "").replace(REPO, "."),
      },
      window:
        "recent-sample (5 tickets per customer); lifetime numbers come from the book",
      liveProxy: "GSLIVE channel — unverified as a live-betting flag",
      summary,
      profiles,
    },
    null,
    2,
  ),
);

if (values.json) {
  console.log(JSON.stringify({ summary, profiles }, null, 2));
} else {
  // The book's `*_usd` fields are dollars (a $20,000 ticket is `risk_usd: 20000`), not cents.
  const usd = (dollars: number) =>
    `${dollars < 0 ? "-" : ""}$${Math.abs(Math.round(dollars)).toLocaleString("en-US")}`;
  console.log(
    `customers:profiles: ${summary.customers} customer(s), ${summary.tickets} ticket(s)`,
  );
  console.log(`  wrote ${outPath.replace(REPO, ".")}`);
  console.log(
    `  lifetime net ${usd(summary.lifetimeNetUsd)} · sample net ${usd(summary.sampleNetUsd)} on ${usd(summary.sampleRiskUsd)} risk`,
  );
  console.log(`\n  by league (sample):`);
  for (const [league, bucket] of Object.entries(summary.byLeague).sort(
    (a, b) => b[1].n - a[1].n,
  )) {
    console.log(
      `    ${league.padEnd(5)} ${String(bucket.n).padStart(4)} tickets  net ${usd(bucket.netUsd)}`,
    );
  }
  console.log(`\n  by market (sample):`);
  for (const [market, bucket] of Object.entries(summary.byMarket).sort(
    (a, b) => b[1].n - a[1].n,
  )) {
    console.log(
      `    ${market.padEnd(10)} ${String(bucket.n).padStart(4)} tickets  net ${usd(bucket.netUsd)}`,
    );
  }
  console.log(`\n  by channel (sample; GSLIVE is the live proxy):`);
  for (const [channel, bucket] of Object.entries(summary.byChannel).sort(
    (a, b) => b[1].n - a[1].n,
  )) {
    console.log(
      `    ${channel.padEnd(10)} ${String(bucket.n).padStart(4)} tickets  net ${usd(bucket.netUsd)}`,
    );
  }
  console.log(`\n  sharpest (sharp_score, clv_bps):`);
  for (const entry of summary.sharpest) {
    console.log(
      `    ${entry.customerId.padEnd(10)} ${String(entry.sharpScore).padStart(5)}  ${entry.clvBps} bps`,
    );
  }
  console.log(`\n  worst recent sample net:`);
  for (const entry of summary.worstRecent) {
    console.log(`    ${entry.customerId.padEnd(10)} ${usd(entry.netUsd)}`);
  }
  if (summary.notInTree.length > 0) {
    console.log(`\n  agents not in the tree: ${summary.notInTree.join(", ")}`);
  }
}
