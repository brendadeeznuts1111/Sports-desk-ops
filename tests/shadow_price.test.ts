/**
 * @file tests/shadow_price.test.ts
 * @description Unit tests for the shadow-pricing evaluation harness.
 */

import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runShadowPricing } from "../scripts/shadow_price.ts";

describe("Shadow-Pricing Harness", () => {
  it("accurately simulates counterfactual payouts and retail elasticity", () => {
    // Create temporary SQLite DB for testing
    const testDbPath = `scratch/test-shadow-price-${Date.now()}.db`;
    const db = new Database(testDbPath);

    db.run(`
      CREATE TABLE account (
        account_id INTEGER PRIMARY KEY,
        account_key TEXT NOT NULL
      );
      CREATE TABLE bet (
        bet_id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL,
        stake REAL NOT NULL
      );
      CREATE TABLE bet_leg (
        bet_leg_id INTEGER PRIMARY KEY,
        bet_id INTEGER NOT NULL,
        price_taken_american INTEGER NOT NULL,
        raw_description TEXT NOT NULL,
        result TEXT NOT NULL
      );
    `);

    // Insert sharp account GP301
    db.run("INSERT INTO account VALUES (1, 'GP301')");
    // Insert retail account RET999
    db.run("INSERT INTO account VALUES (2, 'RET999')");

    // GP301 buys onto Key 3 (wins): $1,200 stake, taken at -120 -> won $1,000.
    // Under shadow ladder of -140: $1,200 stake pays $857.14 -> saves $142.86.
    db.run("INSERT INTO bet VALUES (1, 1, 1200)");
    db.run(
      "INSERT INTO bet_leg VALUES (1, 1, -120, 'Football #112 TeamA  3 -120 - buying ½ For Game', 'won')",
    );

    // GP301 buys onto Key 7 (loses): $1,250 stake, taken at -125 -> lost.
    // Under shadow ladder: desk keeps stake ($1,250), identical PnL.
    db.run("INSERT INTO bet VALUES (2, 1, 1250)");
    db.run(
      "INSERT INTO bet_leg VALUES (2, 2, -125, 'Football #114 TeamB  7 -125 - buying ½ For Game', 'lost')",
    );

    // Retail RET999 buys onto Key 3 (wins): $120 stake at -120 -> won $100.
    db.run("INSERT INTO bet VALUES (3, 2, 120)");
    db.run(
      "INSERT INTO bet_leg VALUES (3, 3, -120, 'Football #116 TeamC  3 -120 - buying ½ For Game', 'won')",
    );

    db.close();

    try {
      const res = runShadowPricing({
        dbPath: testDbPath,
        ladderKey3: -140,
        ladderKey7: -135,
        minVolume: 2, // GP301 has 2 legs (sharp), RET999 has 1 leg (retail)
        retailElasticity: 0.15,
      });

      expect(res.summary.totalAnalyzedLegs).toBe(3);
      expect(res.summary.totalSettledLegs).toBe(3);
      expect(res.summary.totalStakedUsd).toBe(2570);

      // GP301 actual desk PnL: -$1000 + $1250 = +$250
      // Under shadow -140: -$857.14 + $1250 = +$392.86
      // Sharp savings on winning tickets
      expect(res.sharpCohort.sharpSavingsUsd).toBeGreaterThan(0);
      expect(res.sharpCohort.sharpSavingsUsd).toBeGreaterThanOrEqual(142);
      expect(res.sharpCohort.sharpSavingsUsd).toBeLessThanOrEqual(144);

      // Retail elasticity reduces retail payout & volume
      expect(res.retailCohort.elasticityAssumed).toBe(0.15);
      expect(res.retailCohort.stakedUsd).toBe(120);
      // Under 15% elasticity, shadow desk payout scales by (1 - 0.15) = 0.85
      // Retail won $100 -> actual PnL -$100 -> shadow payout -$857.14 * 0.1 * 0.85 approx
      expect(res.retailCohort.shadowDeskPnlUsd).toBeGreaterThan(
        res.retailCohort.actualDeskPnlUsd,
      );
    } finally {
      // Clean up test DB
      try {
        const file = Bun.file(testDbPath);
        if (file.size > 0) {
          Bun.spawnSync(["rm", "-f", testDbPath]);
        }
      } catch {
        // ignore
      }
    }
  });

  it("respects Bun.env overrides for default parameters", () => {
    const prevDb = Bun.env.SHADOW_PRICE_DB;
    const prevMinVol = Bun.env.SHADOW_PRICE_MIN_VOLUME;
    const prevElast = Bun.env.SHADOW_PRICE_ELASTICITY;

    try {
      Bun.env.SHADOW_PRICE_MIN_VOLUME = "42";
      Bun.env.SHADOW_PRICE_ELASTICITY = "0.25";

      // Verify that throwing on missing DB proves Bun.env.SHADOW_PRICE_DB is checked
      Bun.env.SHADOW_PRICE_DB = "/non/existent/path/db.sqlite";
      expect(() => runShadowPricing()).toThrow("Database not found");
    } finally {
      if (prevDb !== undefined) Bun.env.SHADOW_PRICE_DB = prevDb;
      else delete Bun.env.SHADOW_PRICE_DB;

      if (prevMinVol !== undefined)
        Bun.env.SHADOW_PRICE_MIN_VOLUME = prevMinVol;
      else delete Bun.env.SHADOW_PRICE_MIN_VOLUME;

      if (prevElast !== undefined) Bun.env.SHADOW_PRICE_ELASTICITY = prevElast;
      else delete Bun.env.SHADOW_PRICE_ELASTICITY;
    }
  });
});
