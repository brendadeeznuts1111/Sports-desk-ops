/**
 * @file tests/enhanced_dashboard_builder.test.ts
 * @description Integration & contract suite for the Enhanced Dashboard Builder:
 *  1. design/tokens.toml -> src/dashboard/tokens.generated.css Houdini emission
 *  2. Native Bun HTML entrypoint bundling + compile-time bun:bundle DCE matrix
 *  3. TypedArray arena counterfactual shadow-pricing & elasticity parity (#135)
 *  4. Declarative Bun.serve({ routes }) dashboard server endpoints
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  runShadowPricingDashboard,
  type ShadowPricingDashboardPayload,
} from "../lib/shadow_pricing_engine.ts";
import {
  buildEnhancedDashboard,
  computeDashboardDceMatrix,
} from "../scripts/build_dashboard.ts";
import { startDashboardServer } from "../scripts/dev_dashboard.ts";
import { runShadowPricing } from "../scripts/shadow_price.ts";

describe("Enhanced Dashboard Builder & Shadow-Pricing Suite", () => {
  describe("1. Generated CSS Houdini Tokens (tokens.generated.css)", () => {
    it("contains @property declarations and :root tokens from design/tokens.toml", async () => {
      const cssFile = Bun.file(
        resolve(process.cwd(), "src/dashboard/tokens.generated.css"),
      );
      expect(await cssFile.exists()).toBe(true);
      const css = await cssFile.text();

      expect(css).toContain("@property --sd-surface-bg");
      expect(css).toContain("@property --sd-tier-alert");
      expect(css).toContain("@property --sd-route-sharp");
      expect(css).toContain("--sd-surface-bg: #070b14;");
      expect(css).toContain("--sd-surface-card: #0d1527;");
      expect(css).toContain("--accent: var(--sd-tier-rec-bias);");
    });
  });

  describe("2. Native HTML Bundling & bun:bundle Dead-Code Elimination", () => {
    it("bundles src/dashboard/index.html into HTML + JS + CSS + build-manifest.json", async () => {
      const outdir = mkdtempSync(join(tmpdir(), "sd-enhanced-build-"));
      try {
        const manifest = await buildEnhancedDashboard({
          target: "prod",
          outdir,
          minify: true,
        });

        expect(manifest.schemaVersion).toBe(1);
        expect(manifest.target).toBe("prod");
        expect(manifest.enabledFeatures).toEqual(["PROD", "ANALYTICS"]);

        const htmlArt = manifest.artifacts.find(
          (a) => a.fileName === "index.html",
        );
        const jsArt = manifest.artifacts.find((a) =>
          a.fileName.endsWith(".js"),
        );
        const cssArt = manifest.artifacts.find((a) =>
          a.fileName.endsWith(".css"),
        );

        expect(htmlArt).toBeDefined();
        expect(jsArt).toBeDefined();
        expect(cssArt).toBeDefined();
        expect(jsArt!.sha256.length).toBe(64);

        const cssBundled = await Bun.file(
          join(outdir, cssArt!.fileName),
        ).text();
        expect(cssBundled).toContain("--sd-surface-bg");

        const manifestDisk = await Bun.file(
          join(outdir, "build-manifest.json"),
        ).json();
        expect(manifestDisk.target).toBe("prod");
      } finally {
        rmSync(outdir, { recursive: true, force: true });
      }
    });

    it("prunes dead feature() branches across prod, dev, and test targets", async () => {
      const matrix = await computeDashboardDceMatrix();
      expect(matrix.length).toBe(3);

      const prod = matrix.find((r) => r.target === "prod")!;
      const dev = matrix.find((r) => r.target === "dev")!;
      const testTarget = matrix.find((r) => r.target === "test")!;

      // PROD keeps PROD sentinel and eliminates DEBUG + EXPERIMENTAL sentinels
      expect(prod.hasProdSentinel).toBe(true);
      expect(prod.hasDebugSentinel).toBe(false);
      expect(prod.hasExperimentalSentinel).toBe(false);

      // DEV keeps DEBUG + EXPERIMENTAL sentinels and eliminates PROD sentinel
      expect(dev.hasProdSentinel).toBe(false);
      expect(dev.hasDebugSentinel).toBe(true);
      expect(dev.hasExperimentalSentinel).toBe(true);

      // TEST keeps DEBUG sentinel and eliminates PROD + EXPERIMENTAL sentinels
      expect(testTarget.hasProdSentinel).toBe(false);
      expect(testTarget.hasDebugSentinel).toBe(true);
      expect(testTarget.hasExperimentalSentinel).toBe(false);
    });
  });

  describe("3. TypedArray Arena Shadow-Pricing & Elasticity Engine (#135)", () => {
    it("matches scripts/shadow_price.ts verbatim in exact mode and clamps steeper buys in floor mode", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sd-shadow-arena-"));
      const dbPath = join(dir, "arena-parity.db");
      const db = new Database(dbPath);

      db.run(`
        CREATE TABLE account (account_id INTEGER PRIMARY KEY, account_key TEXT NOT NULL);
        CREATE TABLE bet (bet_id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, stake REAL NOT NULL);
        CREATE TABLE bet_leg (
          bet_leg_id INTEGER PRIMARY KEY,
          bet_id INTEGER NOT NULL,
          price_taken_american INTEGER NOT NULL,
          raw_description TEXT NOT NULL,
          result TEXT NOT NULL
        );
      `);

      db.run("INSERT INTO account VALUES (1, 'GP301')");
      db.run("INSERT INTO account VALUES (2, 'GP300')");
      db.run("INSERT INTO account VALUES (3, 'RET999')");

      // GP301: 2 legs onto Key 3 & 7 at -120/-125
      db.run("INSERT INTO bet VALUES (1, 1, 1200)");
      db.run(
        "INSERT INTO bet_leg VALUES (1, 1, -120, 'Football #112 TeamA  3 -120 - buying ½ For Game', 'won')",
      );
      db.run("INSERT INTO bet VALUES (2, 1, 1250)");
      db.run(
        "INSERT INTO bet_leg VALUES (2, 2, -125, 'Football #114 TeamB  7 -125 - buying ½ For Game', 'lost')",
      );

      // GP300: 2 legs onto Key 3 already paying -150 (1pt buy)
      db.run("INSERT INTO bet VALUES (3, 2, 1500)");
      db.run(
        "INSERT INTO bet_leg VALUES (3, 3, -150, 'Football #210 TeamC  3 -150 - buying 1 For Game', 'won')",
      );
      db.run("INSERT INTO bet VALUES (4, 2, 1500)");
      db.run(
        "INSERT INTO bet_leg VALUES (4, 4, -150, 'Football #212 TeamD  3 -150 - buying 1 For Game', 'lost')",
      );

      // RET999: 1 retail leg onto Key 3 at -120
      db.run("INSERT INTO bet VALUES (5, 3, 120)");
      db.run(
        "INSERT INTO bet_leg VALUES (5, 5, -120, 'Football #310 TeamE  3 -120 - buying ½ For Game', 'won')",
      );
      db.close();

      try {
        const cliBaseline = runShadowPricing({
          dbPath,
          ladderKey3: -140,
          ladderKey7: -135,
          ladderKey14_21: -128,
          minVolume: 2,
          retailElasticity: 0.15,
        });

        const exactArena = await runShadowPricingDashboard({
          dbPath,
          ladderKey3: -140,
          ladderKey7: -135,
          ladderKey14_21: -128,
          minVolume: 2,
          retailElasticity: 0.15,
          repriceMode: "exact",
        });

        expect(exactArena.provenance).toBe("live_db");
        expect(exactArena.simulation.summary).toEqual(cliBaseline.summary);
        expect(exactArena.simulation.sharpCohort).toEqual(
          cliBaseline.sharpCohort,
        );
        expect(exactArena.simulation.retailCohort).toEqual(
          cliBaseline.retailCohort,
        );
        expect(exactArena.elasticityFrontier.length).toBe(9);
        expect(exactArena.presetComparison.length).toBe(4);

        // Floor mode must NOT cheapen GP300's -150 buy down to -140, so sharp savings strictly improve!
        const floorArena = await runShadowPricingDashboard({
          dbPath,
          ladderKey3: -140,
          ladderKey7: -135,
          ladderKey14_21: -128,
          minVolume: 2,
          retailElasticity: 0.15,
          repriceMode: "floor",
        });

        expect(
          floorArena.simulation.sharpCohort.sharpSavingsUsd,
        ).toBeGreaterThan(exactArena.simulation.sharpCohort.sharpSavingsUsd);
        const gp300Floor = floorArena.simulation.topSharpBuyers.find(
          (b) => b.account === "GP300",
        )!;
        expect(gp300Floor.netDeskImprovementUsd).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("falls back cleanly to Signal-Honesty labeled fixture provenance when DB is missing", async () => {
      const res = await runShadowPricingDashboard({
        dbPath: "/nonexistent/shadow/hist-mine-missing.db",
        ladderKey3: -140,
        ladderKey7: -135,
        repriceMode: "floor",
      });

      expect(res.provenance).toBe("fixture");
      expect(res.simulation.summary.totalAnalyzedLegs).toBeGreaterThan(100);
      expect(res.keyBreakdown.some((k) => k.keyNumber === 3)).toBe(true);
    });

    it("enforces Sport -> SubSport -> Period-per-SubSport -> Market taxonomy invariants", async () => {
      // 1. NFL Game Spread: Key-leak exposed, 7 valid periods (P0 allows buys; 1H..4Q block buys)
      const nflSpread = await runShadowPricingDashboard({
        forceFixture: true,
        sport: "Football",
        subSport: "NFL",
        period: "game",
        market: "spread",
      });
      expect(nflSpread.taxonomy.activeSlice.pointBuyPolicy).toBe(
        "KEY_LEAK_EXPOSED",
      );
      expect(
        nflSpread.taxonomy.activeSlice.validPeriodsForSelection.map(
          (p) => p.code,
        ),
      ).toEqual(["game", "1h", "2h", "1q", "2q", "3q", "4q"]);
      expect(
        nflSpread.taxonomy.activeSlice.validPeriodsForSelection.filter(
          (p) => p.allowsPointBuys,
        ).length,
      ).toBe(1);
      expect(nflSpread.simulation.summary.totalAnalyzedLegs).toBeGreaterThan(0);

      // 2. NCAAB: Halves-only college basketball (NO quarters!); passing period="3q" normalizes cleanly
      const ncaabInvalidQtr = await runShadowPricingDashboard({
        forceFixture: true,
        sport: "Basketball",
        subSport: "NCAAB",
        period: "3q",
        market: "spread",
      });
      expect(ncaabInvalidQtr.taxonomy.activeFilters.period).toBe("ALL");
      expect(
        ncaabInvalidQtr.taxonomy.activeFilters.periodNormalizedFromInvalid,
      ).toBe(true);
      expect(
        ncaabInvalidQtr.taxonomy.activeSlice.validPeriodsForSelection.map(
          (p) => p.code,
        ),
      ).toEqual(["game", "1h", "2h"]);
      expect(ncaabInvalidQtr.taxonomy.activeSlice.pointBuyPolicy).toBe(
        "HOUSE_HOLD_ADVANTAGE",
      );
      expect(ncaabInvalidQtr.policyRecommendation.directive).toBe(
        "PRESERVE_BELL_CURVE_VIG",
      );

      // 3. NBA Game Spread: Bell-curve house hold advantage; 0 Football Key 3/7 legs
      const nbaSpread = await runShadowPricingDashboard({
        forceFixture: true,
        sport: "Basketball",
        subSport: "NBA",
        period: "game",
        market: "spread",
      });
      expect(nbaSpread.taxonomy.activeSlice.riskStatus).toBe("DESK_ADVANTAGE");
      const nbaKey3 = nbaSpread.keyBreakdown.find((k) => k.keyNumber === 3)!;
      expect(nbaKey3.legs).toBe(0);

      // 4. NHL & MLB F5 & LIVE #9000: Point buys strictly blocked across all periods
      const nhlSlice = await runShadowPricingDashboard({
        forceFixture: true,
        sport: "Hockey",
        subSport: "NHL",
        period: "p1",
        market: "total",
      });
      expect(
        nhlSlice.taxonomy.activeSlice.validPeriodsForSelection.map(
          (p) => p.code,
        ),
      ).toEqual(["game", "reg", "p1", "p2", "p3"]);
      expect(
        nhlSlice.taxonomy.activeSlice.validPeriodsForSelection.every(
          (p) => !p.allowsPointBuys,
        ),
      ).toBe(true);
      expect(nhlSlice.taxonomy.activeSlice.pointBuyPolicy).toBe(
        "STRICTLY_BLOCKED",
      );
      expect(nhlSlice.taxonomy.activeSlice.totalLegs).toBeGreaterThan(0);
      expect(nhlSlice.simulation.summary.totalAnalyzedLegs).toBe(0);

      const mlbF5 = await runShadowPricingDashboard({
        forceFixture: true,
        sport: "Baseball",
        subSport: "MLB",
        period: "f5",
        market: "spread",
      });
      expect(
        mlbF5.taxonomy.activeSlice.validPeriodsForSelection.map((p) => p.code),
      ).toEqual(["game", "f5", "inning"]);
      expect(mlbF5.taxonomy.activeSlice.totalLegs).toBeGreaterThan(0);
      expect(mlbF5.policyRecommendation.directive).toBe(
        "DERIVATIVE_AND_LIVE_LOCKOUT",
      );

      const liveSlice = await runShadowPricingDashboard({
        forceFixture: true,
        sport: "LIVE",
        subSport: "NFL_Live",
        period: "game",
      });
      expect(
        liveSlice.taxonomy.activeSlice.validPeriodsForSelection.map(
          (p) => p.code,
        ),
      ).toEqual(["game"]);
      expect(liveSlice.taxonomy.activeSlice.pointBuyPolicy).toBe(
        "STRICTLY_BLOCKED",
      );
      expect(liveSlice.taxonomy.activeSlice.totalLegs).toBeGreaterThan(0);
      expect(liveSlice.taxonomy.activeSlice.buyLegs).toBe(0);
    });
  });

  describe("4. Declarative Bun.serve({ routes }) Dashboard Server", () => {
    it("serves native HTML route, shadow-pricing GET/POST, build-matrix, and 404 wildcard", async () => {
      const handle = startDashboardServer({
        port: 0,
        hostname: "127.0.0.1",
        watchFiles: false,
        forceShadowFixture: true,
      });

      try {
        const rootRes = await fetch(new URL("/", handle.url));
        expect(rootRes.status).toBe(200);
        expect(rootRes.headers.get("content-type")).toContain("text/html");
        const rootHtml = await rootRes.text();
        expect(rootHtml).toContain("SportsDesk");

        const dashAliasRes = await fetch(new URL("dashboard", handle.url));
        expect(dashAliasRes.status).toBe(200);

        const catalogRes = await fetch(
          new URL("api/taxonomy-catalog", handle.url),
        );
        expect(catalogRes.status).toBe(200);
        const catalogJson = (await catalogRes.json()) as {
          catalog: readonly { code: string }[];
        };
        expect(catalogJson.catalog.some((c) => c.code === "NFL")).toBe(true);
        expect(catalogJson.catalog.some((c) => c.code === "NCAAB")).toBe(true);
        expect(catalogJson.catalog.some((c) => c.code === "NFL_Live")).toBe(
          true,
        );

        const shadowGet = await fetch(
          new URL(
            "api/shadow-pricing?sport=Football&subSport=NCAAF&period=game&market=spread&ladder3=-150&ladder7=-142&elasticity=0.2&mode=floor",
            handle.url,
          ),
        );
        expect(shadowGet.status).toBe(200);
        const shadowJson =
          (await shadowGet.json()) as ShadowPricingDashboardPayload;
        expect(shadowJson.provenance).toBe("fixture");
        expect(shadowJson.parameters.ladderKey3).toBe(-150);
        expect(shadowJson.parameters.repriceMode).toBe("floor");
        expect(shadowJson.parameters.sport).toBe("Football");
        expect(shadowJson.parameters.subSport).toBe("NCAAF");
        expect(shadowJson.parameters.period).toBe("game");
        expect(shadowJson.parameters.market).toBe("spread");

        const shadowPost = await fetch(
          new URL("api/shadow-pricing", handle.url),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sport: "Basketball",
              subSport: "NBA",
              period: "game",
              market: "spread",
              ladderKey3: -138,
              ladderKey7: -132,
              ladderKey14_21: -123,
              retailElasticity: 0.1,
              repriceMode: "exact",
            }),
          },
        );
        expect(shadowPost.status).toBe(200);
        const postJson =
          (await shadowPost.json()) as ShadowPricingDashboardPayload;
        expect(postJson.parameters.ladderKey3).toBe(-138);
        expect(postJson.parameters.repriceMode).toBe("exact");
        expect(postJson.parameters.sport).toBe("Basketball");
        expect(postJson.parameters.subSport).toBe("NBA");

        const matrixRes = await fetch(new URL("api/build-matrix", handle.url));
        expect(matrixRes.status).toBe(200);
        const matrixJson = (await matrixRes.json()) as {
          targets: readonly unknown[];
        };
        expect(matrixJson.targets.length).toBe(3);

        const missingApi = await fetch(
          new URL("api/does-not-exist", handle.url),
        );
        expect(missingApi.status).toBe(404);
      } finally {
        handle.stop(true);
      }
    });
  });
});
