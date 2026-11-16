/**
 * @file tests/shadow_taxonomy_regime.test.tsx
 * @description Verifies 5th-axis Regime / Wager Type (`PREGAME` vs `LIVE_IN_PLAY`)
 * across `runShadowPricingDashboard`, `taxonomy.byRegime` TypedArray rollups, and SSR rendering of `ShadowPricingPanel`.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShadowPricingPanel } from "../packages/ui/src/ShadowPricingPanel.tsx";
import {
  REGIME_ID_LIVE_IN_PLAY,
  REGIME_ID_PREGAME,
  regimeIndexOf,
  resolveSlicePolicyAndRisk,
} from "../lib/market_taxonomy_catalog.ts";
import { runShadowPricingDashboard } from "../lib/shadow_pricing_engine.ts";

describe("Shadow Taxonomy Cube Axis 5: Regime / Wager Type", () => {
  test("regimeIndexOf resolves canonical and uppercase aliases cleanly", () => {
    expect(regimeIndexOf("ALL")).toBe(-1);
    expect(regimeIndexOf(undefined)).toBe(-1);
    expect(regimeIndexOf("pregame")).toBe(REGIME_ID_PREGAME);
    expect(regimeIndexOf("live_in_play")).toBe(REGIME_ID_LIVE_IN_PLAY);
    expect(regimeIndexOf("PREGAME" as never)).toBe(REGIME_ID_PREGAME);
    expect(regimeIndexOf("LIVE_IN_PLAY" as never)).toBe(REGIME_ID_LIVE_IN_PLAY);

    expect(
      resolveSlicePolicyAndRisk(-1, -1, 0, 0, 0, 0, REGIME_ID_LIVE_IN_PLAY),
    ).toMatchObject({
      pointBuyPolicy: "STRICTLY_BLOCKED",
      riskStatus: "IMMUNE_BLOCKED",
    });
  });

  test("runShadowPricingDashboard partitions fixture legs cleanly into PREGAME vs LIVE_IN_PLAY rollups", async () => {
    const fullBook = await runShadowPricingDashboard({ forceFixture: true });
    expect(fullBook.parameters.regime).toBe("ALL");
    expect(fullBook.taxonomy.activeFilters.regime).toBe("ALL");

    const byRegime = fullBook.taxonomy.byRegime ?? [];
    expect(byRegime).toHaveLength(2);
    const preRow = byRegime.find((r) => r.code === "pregame");
    const liveRow = byRegime.find((r) => r.code === "live_in_play");
    expect(preRow).toBeDefined();
    expect(liveRow).toBeDefined();
    expect(preRow!.dimension).toBe("regime");
    expect(liveRow!.dimension).toBe("regime");
    expect(preRow!.totalLegs).toBeGreaterThan(0);
    expect(liveRow!.totalLegs).toBeGreaterThan(0);
    expect(preRow!.totalLegs + liveRow!.totalLegs).toBe(
      fullBook.taxonomy.activeSlice.totalLegs,
    );
    expect(preRow!.handleUsd + liveRow!.handleUsd).toBe(
      fullBook.taxonomy.activeSlice.handleUsd,
    );
    expect(liveRow!.pointBuyPolicy).toBe("STRICTLY_BLOCKED");

    const pregameSlice = await runShadowPricingDashboard({
      forceFixture: true,
      regime: "pregame",
    });
    expect(pregameSlice.parameters.regime).toBe("pregame");
    expect(pregameSlice.taxonomy.activeSlice.totalLegs).toBe(preRow!.totalLegs);
    expect(pregameSlice.taxonomy.activeSlice.breadcrumb).toContain("PREGAME");
    const liveSportInPregame = pregameSlice.taxonomy.bySport.find(
      (s) => s.code === "LIVE",
    );
    expect(liveSportInPregame?.totalLegs).toBe(0);

    const liveSlice = await runShadowPricingDashboard({
      forceFixture: true,
      regime: "live_in_play",
    });
    expect(liveSlice.parameters.regime).toBe("live_in_play");
    expect(liveSlice.taxonomy.activeSlice.totalLegs).toBe(liveRow!.totalLegs);
    expect(liveSlice.taxonomy.activeSlice.pointBuyPolicy).toBe(
      "STRICTLY_BLOCKED",
    );
    expect(liveSlice.taxonomy.activeSlice.breadcrumb).toContain("LIVE_IN_PLAY");
    expect(liveSlice.simulation.summary.totalAnalyzedLegs).toBe(0);
    const footballInLive = liveSlice.taxonomy.bySport.find(
      (s) => s.code === "Football",
    );
    expect(footballInLive?.totalLegs).toBe(0);
  });

  test("SSR renders 5. Regime / Wager Type selector axis and 5. By Regime tab cleanly", async () => {
    const payload = await runShadowPricingDashboard({
      forceFixture: true,
      regime: "live_in_play",
    });
    const html = renderToStaticMarkup(
      <ShadowPricingPanel initialPayload={payload} />,
    );
    expect(html).toContain("4-Axis Taxonomy Slice Selector");
    expect(html).toContain("5. Regime / Wager Type");
    expect(html).toContain("All Regimes");
    expect(html).toContain("PREGAME (wagerType3=0..6");
    expect(html).toContain("LIVE_IN_PLAY / GSLive (wagerType3=7");
    expect(html).toContain("5. By Regime (2)");
  });
});
