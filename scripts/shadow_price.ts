#!/usr/bin/env bun
/**
 * @file scripts/shadow_price.ts
 * @description Shadow-pricing evaluation harness for football point-purchase ladders.
 *
 * Simulates counterfactual bookmaker P&L under alternative pricing ladders
 * across historical settled and open wagers, isolating sharp syndicate savings
 * from retail turnover elasticity.
 *
 * Usage:
 *   bun run scripts/shadow_price.ts [--db <path>] [--ladder-3 <odds>] [--ladder-7 <odds>]
 *                                   [--min-volume <N>] [--elasticity <0.0-1.0>] [--json]
 */

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { Database } from "bun:sqlite";

import {
  parseBuyPointsFromDesc,
  parseSpreadAndBuyFromShortDesc,
} from "../lib/f402_figure_date_enricher.ts";
import { isKeyNumberBuy } from "../lib/customer_profile.ts";

export interface ShadowPricingOptions {
  readonly dbPath?: string | undefined;
  readonly ladderKey3?: number | undefined;
  readonly ladderKey7?: number | undefined;
  readonly ladderKey14_21?: number | undefined;
  readonly minVolume?: number | undefined;
  readonly retailElasticity?: number | undefined;
}

export interface ShadowSimulationResult {
  readonly summary: {
    readonly totalAnalyzedLegs: number;
    readonly totalSettledLegs: number;
    readonly totalStakedUsd: number;
    readonly actualDeskPnlUsd: number;
    readonly shadowDeskPnlUsd: number;
    readonly netDeskSavingsUsd: number;
  };
  readonly sharpCohort: {
    readonly bettorCount: number;
    readonly legCount: number;
    readonly stakedUsd: number;
    readonly actualDeskPnlUsd: number;
    readonly shadowDeskPnlUsd: number;
    readonly sharpSavingsUsd: number;
  };
  readonly retailCohort: {
    readonly bettorCount: number;
    readonly legCount: number;
    readonly stakedUsd: number;
    readonly actualDeskPnlUsd: number;
    readonly shadowDeskPnlUsd: number;
    readonly retailNetImpactUsd: number;
    readonly elasticityAssumed: number;
  };
  readonly topSharpBuyers: readonly {
    readonly account: string;
    readonly legs: number;
    readonly stakedUsd: number;
    readonly keyRatePct: string;
    readonly actualDeskPnlUsd: number;
    readonly shadowDeskPnlUsd: number;
    readonly netDeskImprovementUsd: number;
  }[];
}

export interface RawRow {
  account_id: number;
  account_key: string;
  bet_id: number;
  stake: number | null;
  price_taken_american: number;
  raw_description: string;
  result: string;
}

export const FALLBACK_DB_PATH =
  "/Users/nolarose/4c-odds-intergration/probes/.snapshot/hist-mine.db";

export function runShadowPricing(
  options: Partial<ShadowPricingOptions> = {},
): ShadowSimulationResult {
  const defaultDbPath = Bun.env.SHADOW_PRICE_DB ?? FALLBACK_DB_PATH;
  const defaultMinVolume = Number(Bun.env.SHADOW_PRICE_MIN_VOLUME ?? 15);
  const defaultElasticity = Number(Bun.env.SHADOW_PRICE_ELASTICITY ?? 0.15);

  const dbPath = options.dbPath ?? defaultDbPath;
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}`);
  }

  const ladderKey3 = options.ladderKey3 ?? -140;
  const ladderKey7 = options.ladderKey7 ?? -135;
  const ladderKey14_21 = options.ladderKey14_21 ?? -128;
  const minVolume = options.minVolume ?? defaultMinVolume;
  const retailElasticity = options.retailElasticity ?? defaultElasticity;

  const db = new Database(dbPath, { readonly: true });
  // Analytical read performance tuning for Bun SQLite driver
  try {
    db.run("PRAGMA cache_size = -64000;"); // 64MB cache
    db.run("PRAGMA temp_store = MEMORY;");
  } catch {
    // Ignore pragma failures on restricted instances
  }

  try {
    // Query all legs where description contains point-buying
    const query = db.query<RawRow, []>(`
      SELECT
        b.account_id,
        a.account_key,
        b.bet_id,
        b.stake,
        bl.price_taken_american,
        bl.raw_description,
        bl.result
      FROM bet_leg bl
      JOIN bet b ON bl.bet_id = b.bet_id
      JOIN account a ON b.account_id = a.account_id
      WHERE bl.raw_description LIKE '%buying%'
    `);

    const rows = query.all();

    interface LegData {
      account: string;
      betId: number;
      stakeUsd: number;
      priceTaken: number;
      shadowPrice: number;
      result: "won" | "lost" | "push" | "pending" | "other";
      isKey: boolean;
      isKey3or7: boolean;
      keyNumber: number | null;
      actualDeskPnl: number;
      shadowDeskPnl: number;
    }

    const legs: LegData[] = [];
    const accountStats = new Map<
      string,
      { totalLegs: number; key3or7Legs: number; totalStake: number }
    >();

    for (const row of rows) {
      const desc = row.raw_description;
      const buyPts = parseBuyPointsFromDesc(desc);
      if (buyPts <= 0) continue;

      const parsed = parseSpreadAndBuyFromShortDesc(desc);
      const keyCheck = isKeyNumberBuy(parsed.adjSpread, buyPts);

      const account = row.account_key;
      const stake = row.stake !== null && row.stake > 0 ? row.stake : 100; // default $100 if unrecorded leg stake
      const price = row.price_taken_american ?? -120;

      let shadowPrice = price;
      if (keyCheck.key === 3) shadowPrice = ladderKey3;
      else if (keyCheck.key === 7) shadowPrice = ladderKey7;
      else if (
        keyCheck.key === 10 ||
        keyCheck.key === 14 ||
        keyCheck.key === 21
      ) {
        shadowPrice = ladderKey14_21;
      }

      const resRaw = (row.result ?? "").toLowerCase();
      let result: LegData["result"] = "other";
      if (resRaw === "won") result = "won";
      else if (resRaw === "lost") result = "lost";
      else if (resRaw === "push") result = "push";
      else if (resRaw === "pending") result = "pending";

      // Payout function for American odds
      const toWinMultiplier = (odds: number): number => {
        if (odds < 0) return 100 / -odds;
        return odds / 100;
      };

      let actualDeskPnl = 0;
      let shadowDeskPnl = 0;

      if (result === "lost") {
        // Desk wins the stake
        actualDeskPnl = stake;
        shadowDeskPnl = stake;
      } else if (result === "won") {
        // Desk pays out profit
        const actualPayout = stake * toWinMultiplier(price);
        const shadowPayout = stake * toWinMultiplier(shadowPrice);
        actualDeskPnl = -actualPayout;
        shadowDeskPnl = -shadowPayout;
      } else if (result === "push") {
        actualDeskPnl = 0;
        shadowDeskPnl = 0;
      }

      legs.push({
        account,
        betId: row.bet_id,
        stakeUsd: stake,
        priceTaken: price,
        shadowPrice,
        result,
        isKey: keyCheck.isKey,
        isKey3or7: keyCheck.is3or7,
        keyNumber: keyCheck.key,
        actualDeskPnl,
        shadowDeskPnl,
      });

      if (!accountStats.has(account)) {
        accountStats.set(account, {
          totalLegs: 0,
          key3or7Legs: 0,
          totalStake: 0,
        });
      }
      const acc = accountStats.get(account)!;
      acc.totalLegs++;
      acc.totalStake += stake;
      if (keyCheck.is3or7) acc.key3or7Legs++;
    }

    // Classify accounts into Sharp vs Retail based on Volume >= minVolume AND KeyRate >= 40%
    const sharpAccounts = new Set<string>();
    for (const [account, st] of accountStats.entries()) {
      const keyRate = st.totalLegs > 0 ? st.key3or7Legs / st.totalLegs : 0;
      if (st.totalLegs >= minVolume && keyRate >= 0.4) {
        sharpAccounts.add(account);
      }
    }

    let totalAnalyzedLegs = 0;
    let totalSettledLegs = 0;
    let totalStakedUsd = 0;
    let actualDeskPnlUsd = 0;
    let shadowDeskPnlUsd = 0;

    let sharpLegs = 0;
    let sharpStaked = 0;
    let sharpActualPnl = 0;
    let sharpShadowPnl = 0;

    let retailLegs = 0;
    let retailStaked = 0;
    let retailActualPnl = 0;
    let retailShadowPnl = 0;

    const perSharpPnl = new Map<
      string,
      { legs: number; stake: number; actualPnl: number; shadowPnl: number }
    >();

    for (const leg of legs) {
      totalAnalyzedLegs++;
      totalStakedUsd += leg.stakeUsd;

      const isSettled =
        leg.result === "won" || leg.result === "lost" || leg.result === "push";
      if (isSettled) totalSettledLegs++;

      actualDeskPnlUsd += leg.actualDeskPnl;
      shadowDeskPnlUsd += leg.shadowDeskPnl;

      if (sharpAccounts.has(leg.account)) {
        sharpLegs++;
        sharpStaked += leg.stakeUsd;
        sharpActualPnl += leg.actualDeskPnl;
        sharpShadowPnl += leg.shadowDeskPnl;

        if (!perSharpPnl.has(leg.account)) {
          perSharpPnl.set(leg.account, {
            legs: 0,
            stake: 0,
            actualPnl: 0,
            shadowPnl: 0,
          });
        }
        const p = perSharpPnl.get(leg.account)!;
        p.legs++;
        p.stake += leg.stakeUsd;
        p.actualPnl += leg.actualDeskPnl;
        p.shadowPnl += leg.shadowDeskPnl;
      } else {
        retailLegs++;
        retailStaked += leg.stakeUsd;
        retailActualPnl += leg.actualDeskPnl;
        // Model retail elasticity: retailElasticity fraction of bettors drop off
        // If retail dropped off, desk loses retail margin on those lost tickets
        const retainedFactor = 1 - retailElasticity;
        retailShadowPnl += leg.shadowDeskPnl * retainedFactor;
      }
    }

    const topSharpBuyers = Array.from(perSharpPnl.entries())
      .map(([account, data]) => {
        const st = accountStats.get(account)!;
        const keyRate = (st.key3or7Legs / st.totalLegs) * 100;
        return {
          account,
          legs: data.legs,
          stakedUsd: Math.round(data.stake),
          keyRatePct: `${keyRate.toFixed(1)}%`,
          actualDeskPnlUsd: Math.round(data.actualPnl),
          shadowDeskPnlUsd: Math.round(data.shadowPnl),
          netDeskImprovementUsd: Math.round(data.shadowPnl - data.actualPnl),
        };
      })
      .sort((a, b) => b.stakedUsd - a.stakedUsd)
      .slice(0, 15);

    return {
      summary: {
        totalAnalyzedLegs,
        totalSettledLegs,
        totalStakedUsd: Math.round(totalStakedUsd),
        actualDeskPnlUsd: Math.round(actualDeskPnlUsd),
        shadowDeskPnlUsd: Math.round(sharpShadowPnl + retailShadowPnl),
        netDeskSavingsUsd: Math.round(
          sharpShadowPnl + retailShadowPnl - actualDeskPnlUsd,
        ),
      },
      sharpCohort: {
        bettorCount: sharpAccounts.size,
        legCount: sharpLegs,
        stakedUsd: Math.round(sharpStaked),
        actualDeskPnlUsd: Math.round(sharpActualPnl),
        shadowDeskPnlUsd: Math.round(sharpShadowPnl),
        sharpSavingsUsd: Math.round(sharpShadowPnl - sharpActualPnl),
      },
      retailCohort: {
        bettorCount: accountStats.size - sharpAccounts.size,
        legCount: retailLegs,
        stakedUsd: Math.round(retailStaked),
        actualDeskPnlUsd: Math.round(retailActualPnl),
        shadowDeskPnlUsd: Math.round(retailShadowPnl),
        retailNetImpactUsd: Math.round(retailShadowPnl - retailActualPnl),
        elasticityAssumed: retailElasticity,
      },
      topSharpBuyers,
    };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      db: {
        type: "string",
        default: Bun.env.SHADOW_PRICE_DB ?? FALLBACK_DB_PATH,
      },
      "ladder-3": { type: "string", default: "-140" },
      "ladder-7": { type: "string", default: "-135" },
      "ladder-other": { type: "string", default: "-128" },
      "min-volume": { type: "string", default: "15" },
      elasticity: { type: "string", default: "0.15" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`
Usage: dx shadow-price [options]

Options:
  --db <path>           Path to SQLite database (default: $SHADOW_PRICE_DB or hist-mine.db)
  --ladder-3 <odds>     Counterfactual American odds on Key 3 (default: -140)
  --ladder-7 <odds>     Counterfactual American odds on Key 7 (default: -135)
  --ladder-other <odds> Counterfactual American odds on Key 14/21 (default: -128)
  --min-volume <N>      Min point-buy legs to classify bettor as sharp (default: 15)
  --elasticity <0.0-1.0> Assumed retail volume drop-off fraction (default: 0.15)
  --json                Output results as JSON
  --help                Show this help message
`);
    process.exit(0);
  }

  const res = runShadowPricing({
    dbPath: typeof values.db === "string" ? values.db : undefined,
    ladderKey3: Number(values["ladder-3"]),
    ladderKey7: Number(values["ladder-7"]),
    ladderKey14_21: Number(values["ladder-other"]),
    minVolume: Number(values["min-volume"]),
    retailElasticity: Number(values.elasticity),
  });

  if (values.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log("=== SHADOW-PRICING COUNTERFACTUAL SIMULATION ===");
    console.log(`Database: ${values.db}`);
    console.log(
      `Ladder Tested: Key 3 = ${values["ladder-3"]}, Key 7 = ${values["ladder-7"]}, Key 14/21 = ${values["ladder-other"]}`,
    );
    console.log(
      `Min Volume Threshold for Sharps: ${values["min-volume"]} legs`,
    );
    console.log(
      `Assumed Retail Turnover Elasticity: ${(Number(values.elasticity) * 100).toFixed(0)}%\n`,
    );

    console.log("--- HIGH-LEVEL RESULTS ---");
    console.table([
      {
        Metric: "Total Handle Analyzed",
        Value: `$${res.summary.totalStakedUsd.toLocaleString()}`,
      },
      { Metric: "Total Legs Analyzed", Value: res.summary.totalAnalyzedLegs },
      { Metric: "Settled Legs", Value: res.summary.totalSettledLegs },
      {
        Metric: "Actual Desk P&L",
        Value: `$${res.summary.actualDeskPnlUsd.toLocaleString()}`,
      },
      {
        Metric: "Shadow Desk P&L (Simulated)",
        Value: `$${res.summary.shadowDeskPnlUsd.toLocaleString()}`,
      },
      {
        Metric: "Net Desk Improvement",
        Value: `$${res.summary.netDeskSavingsUsd.toLocaleString()}`,
      },
    ]);

    console.log("\n--- COHORT BREAKDOWN ---");
    console.table([
      {
        Cohort: "Sharp Cluster (Disciplined Key Buyers)",
        Bettors: res.sharpCohort.bettorCount,
        Legs: res.sharpCohort.legCount,
        Handle: `$${res.sharpCohort.stakedUsd.toLocaleString()}`,
        "Actual Desk PnL": `$${res.sharpCohort.actualDeskPnlUsd.toLocaleString()}`,
        "Shadow Desk PnL": `$${res.sharpCohort.shadowDeskPnlUsd.toLocaleString()}`,
        "Desk Net Savings": `$${res.sharpCohort.sharpSavingsUsd.toLocaleString()}`,
      },
      {
        Cohort: `Retail Bettors (${(res.retailCohort.elasticityAssumed * 100).toFixed(0)}% Drop)`,
        Bettors: res.retailCohort.bettorCount,
        Legs: res.retailCohort.legCount,
        Handle: `$${res.retailCohort.stakedUsd.toLocaleString()}`,
        "Actual Desk PnL": `$${res.retailCohort.actualDeskPnlUsd.toLocaleString()}`,
        "Shadow Desk PnL": `$${res.retailCohort.shadowDeskPnlUsd.toLocaleString()}`,
        "Desk Net Savings": `$${res.retailCohort.retailNetImpactUsd.toLocaleString()}`,
      },
    ]);

    console.log(
      "\n--- TOP SHARP ACCOUNTS IMPACTED (N >= 15 & Key Rate >= 40%) ---",
    );
    console.table(res.topSharpBuyers);
  }
}
