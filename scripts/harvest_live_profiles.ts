#!/usr/bin/env bun
/**
 * @file scripts/harvest_live_profiles.ts
 * @description Automated 24h Live Wager Pattern Anomaly & Profile Harvester CLI.
 *
 * Scans `reports/live-positions-summary.json`, `data/live-wagers.json`, `data/live-bets.json`,
 * `docs/backtest-4wk-cfb-nba.json`, and the 14,534-customer DOD6 v5.4 binary spine
 * (`data/sportsdesk_unified_baseline_v54.dodbin`), writes `reports/harvested-live-profiles.json`,
 * and prints an operator surveillance summary table.
 *
 * Usage:
 *   bun run profiles:harvest [--limit 25] [--out reports/harvested-live-profiles.json] [--json]
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { harvestLiveCustomerProfiles } from "../lib/live_profile_harvester.ts";

const REPO = resolve(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    limit: { type: "string", default: "25" },
    out: {
      type: "string",
      default: resolve(REPO, "reports/harvested-live-profiles.json"),
    },
    json: { type: "boolean", default: false },
    all: { type: "boolean", default: false },
  },
});

const limit = Math.max(1, Number(values.limit) || 25);
const result = await harvestLiveCustomerProfiles({
  repoRoot: REPO,
  onlyFlagged: !values.all,
  limit,
});

const outPath = resolve(values.out ?? "");
await mkdir(dirname(outPath), { recursive: true });
await Bun.write(outPath, `${JSON.stringify(result, null, 2)}\n`);

if (values.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(
    `⚡ profiles:harvest — scanned ${result.totalUniqueCustomersScanned} active customers (${result.dodSpineMatchedCount}/${result.totalUniqueCustomersScanned} matched in ${result.dodSpineCustomerCount.toLocaleString()}-customer DOD6 v5.4 binary spine)`,
  );
  console.log(
    `  Flagged profiles: ${result.flaggedProfilesCount} | Wrote top ${result.profiles.length} to ${outPath.replace(REPO, ".")}`,
  );
  console.log(`  Pattern Anomaly Breakdown:`);
  for (const [pattern, count] of Object.entries(result.patternCounts)) {
    console.log(`    • ${pattern.padEnd(30)} ${String(count).padStart(4)}`);
  }
  console.log(
    `\n  Top ${Math.min(15, result.profiles.length)} Harvested Live Profiles:`,
  );
  console.log(
    `  ${"ID".padEnd(10)} ${"Agent".padEnd(11)} ${"Master".padEnd(11)} ${"Score".padStart(5)} ${"24h Risk".padStart(11)} ${"DOD6 Net".padStart(12)} ${"CLV bps".padStart(8)}  Flags`,
  );
  for (const p of result.profiles.slice(0, 15)) {
    const riskStr = `$${p.openRisk24hUsd.toLocaleString()}`;
    const netStr = `${p.ltvUsd < 0 ? "-" : "+"}$${Math.abs(p.ltvUsd).toLocaleString()}`;
    const clvStr =
      p.dodClvBps !== null
        ? `${p.dodClvBps >= 0 ? "+" : ""}${p.dodClvBps}`
        : "—";
    console.log(
      `  ${p.id.padEnd(10)} ${p.agentId.slice(0, 10).padEnd(11)} ${p.masterAgent.slice(0, 10).padEnd(11)} ${p.score.toFixed(1).padStart(5)} ${riskStr.padStart(11)} ${netStr.padStart(12)} ${clvStr.padStart(8)}  ${p.anomalyFlags.join(", ")}`,
    );
  }
}
