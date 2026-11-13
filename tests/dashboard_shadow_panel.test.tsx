/**
 * @file tests/dashboard_shadow_panel.test.tsx
 * @description SSR rendering & Signal-Honesty coverage for modularized
 * `@sportsdesk-ops/ui/ShadowPricingPanel` across loading, KEY_LEAK_EXPOSED
 * active counterfactual simulation, and STRICTLY_BLOCKED lockout branches.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShadowPricingPanel } from "../packages/ui/src/ShadowPricingPanel.tsx";
import { runShadowPricingDashboard } from "../lib/shadow_pricing_engine.ts";

describe("@sportsdesk-ops/ui ShadowPricingPanel", () => {
  test("renders explicit loading empty state before hydration", () => {
    const html = renderToStaticMarkup(<ShadowPricingPanel />);
    expect(html).toContain(
      "Multi-Sport Taxonomy Cube &amp; Shadow-Pricing Engine (#135)",
    );
    expect(html).toContain(
      "Loading multi-sport taxonomy cube &amp; point-buy arena",
    );
  });

  test("renders KEY_LEAK_EXPOSED simulator, SVG frontier, key-number audit, and sharp buyers leaderboard", async () => {
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

    const html = renderToStaticMarkup(
      <ShadowPricingPanel
        initialPayload={nflSpread}
        onInspectAccount={() => {}}
        onRunPtyCommand={() => {}}
      />,
    );

    expect(html).toContain("FIXTURE CORPUS");
    expect(html).toContain("4-Axis Taxonomy Slice Selector");
    expect(html).toContain(nflSpread.taxonomy.activeSlice.breadcrumb);
    expect(html).toContain("Inspect Key Buyers in PTY");
    expect(html).toContain("Flat Retail Catalog");
    expect(html).toContain("SLICE POINT-BUY HANDLE");
    expect(html).toContain("NET COUNTERFACTUAL DESK DELTA");
    expect(html).toContain("Desk Policy Recommendation:");
    expect(html).toContain("<svg");
    expect(html).toContain("Retail Turnover Elasticity Frontier");
    expect(html).toContain("Calibrated Ladder Policy Matrix");
    expect(html).toContain("Key-Number Margin Clustering");

    if (nflSpread.simulation.topSharpBuyers.length > 0) {
      expect(html).toContain("Top Impacted Sharp Key-Number Accounts");
      expect(html).toContain(nflSpread.simulation.topSharpBuyers[0]!.account);
      expect(html).toContain("Profile");
    }
  });

  test("renders STRICTLY_BLOCKED catalog lockout banner when point buys are zeroed", async () => {
    const nflLive = await runShadowPricingDashboard({
      forceFixture: true,
      sport: "LIVE",
      subSport: "NFL_Live",
      period: "game",
      market: "spread",
    });

    expect(nflLive.taxonomy.activeSlice.pointBuyPolicy).toBe(
      "STRICTLY_BLOCKED",
    );
    expect(nflLive.simulation.summary.totalAnalyzedLegs).toBe(0);

    const html = renderToStaticMarkup(
      <ShadowPricingPanel initialPayload={nflLive} />,
    );

    expect(html).toContain(nflLive.policyRecommendation.headline);
    expect(html).toContain(
      `${nflLive.policyRecommendation.directive} · 0 Point-Buy Legs`,
    );
    expect(html).toContain("Jump to NFL P0 Spread (Key Leak Simulator)");
    expect(html).not.toContain("Retail Turnover Elasticity Frontier");
    expect(html).not.toContain("Key-Number Margin Clustering");
  });
});
