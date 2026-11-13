import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDashboardApi } from "@sportsdesk-ops/api";
import {
  computeCustomersCohortPayload,
  projectLiveWagerRow,
} from "@sportsdesk-ops/backend";
import { parseDashboardWsSignal } from "@sportsdesk-ops/contracts";
import {
  CustomersTabPanel,
  deriveCustomerCohortKpiCards,
  formatProvenanceBadge,
  hydrateDashboardFeeds,
  LiveWagersTabPanel,
  SAMPLE_PROFILE_DATA,
} from "@sportsdesk-ops/ui";

function buildHydrationApi(options: {
  readonly wagerProvenanceKind?: "capture" | "fixture" | "fallback";
  readonly customersStatus?: number;
}) {
  const provenanceKind = options.wagerProvenanceKind ?? "capture";
  const projected = projectLiveWagerRow(
    {
      WagerNumber: "W-88401",
      CustomerID: "GP301",
      AgentID: "AG99",
      AgentLogin: "MASTER_VEND",
      AmountWagered: 5500,
      ToWinAmount: 5000,
      clvCents: 13.4,
      ShortDesc: "NFL KC Chiefs @ BUF Bills Under 47.5",
    },
    0,
    {
      parseShortDesc: () => ({
        isLive: false,
        legs: [
          {
            sport: "NFL",
            game: "Kansas City Chiefs @ Buffalo Bills",
            pick: "Under 47.5",
          },
        ],
      }),
      sharpCustomerIds: new Set(["GP301"]),
    },
  );

  const cohortsPayload = computeCustomersCohortPayload({
    backtestLeaderboard: [
      { customer: "GP301" },
      { customer: "CCC88412" },
      { customer: "BT_3" },
    ],
    fixtures: [{ customer_id: "FIX_1" }, { customer_id: "GP301" }],
    localBookRows:
      provenanceKind === "capture"
        ? [{ customer_id: "GP301" }, { customer_id: "BOOK_1" }]
        : undefined,
    keyNumberBuyerIds: ["GP301", "GP300"],
    hookSyndicateIds: ["SYN_1"],
  });

  return createDashboardApi({
    auth: {
      login: async () => Response.json({ ok: true }),
      logout: async () => Response.json({ ok: true }),
      me: async () => Response.json({ authenticated: true }),
    },
    getHealthPayload: () => ({ status: "ok" }),
    loadDashboardMarkdown: async () => ({
      stamp: "1",
      markdown: "# Desk",
      html: "<h1>Desk</h1>",
    }),
    dns: {
      getTelemetryPayload: () => ({ success: true }),
      benchmark: async () => ({}),
      classifyIp: async () => ({}),
    },
    customers: {
      getCohortReport: async () => ({
        versionStamp: "v-test",
        payload: cohortsPayload,
      }),
      getProfile: async () => null,
      getRating: async () => null,
    },
    execTerminal: async (command) => ({ command, stdout: "ok", exitCode: 0 }),
    rankings: {
      getAll: async () => ({
        generatedAtIso: "2026-11-12T00:00:00Z",
        payload: {},
      }),
      getConduits: async () => [],
    },
    getLiveWagersPayload: async () => ({
      wagers: [projected],
      totalRiskUsd: projected.riskUsd,
      totalToWinUsd: projected.toWinUsd,
      criticalSteamCount: 1,
      autoExecute: false,
      timestamp: "2026-11-12T00:00:00Z",
      provenance: {
        kind: provenanceKind,
        label:
          provenanceKind === "capture"
            ? "Local Capture"
            : provenanceKind === "fixture"
              ? "Synthetic Fixture"
              : "In-Memory Fallback",
        sourcePath:
          provenanceKind === "capture"
            ? "data/live-wagers.json"
            : provenanceKind === "fixture"
              ? "tests/fixtures/live-wagers.partial.json"
              : null,
        observedAt: "2026-11-12T00:00:00Z",
      },
    }),
    getTiersConfig: async () => ({
      tiers: {
        CRITICAL: { fg: "#fff", bg: "#991b1b", border: "#ef4444" },
      },
    }),
    alerts: {
      sweepOnce: async () => ({ sent: 0 }),
      list: () => [],
      ack: async () => false,
      retry: async () => null,
      getShiftSummary: () => ({}),
    },
    getTaxonomyCatalog: () => [],
    runShadowPricing: async () => ({}),
    getBuildMatrix: async () => [],
  });
}

describe("@sportsdesk-ops/ui live hydration & Signal-Honesty provenance (zero port bind)", () => {
  test("hydrates /api/wagers, /api/customers, and /api/config/tiers end-to-end through createDashboardApi.fetch", async () => {
    const api = buildHydrationApi({ wagerProvenanceKind: "capture" });
    const bundle = await hydrateDashboardFeeds((path) =>
      api.fetch(new Request(`http://dashboard.local${path}`)),
    );

    expect(bundle.wagers.ok).toBe(true);
    expect(bundle.customers.ok).toBe(true);
    expect(bundle.tiers.ok).toBe(true);
    if (!bundle.wagers.ok || !bundle.customers.ok || !bundle.tiers.ok) {
      throw new Error("Expected all hydration slices to succeed");
    }

    expect(bundle.wagers.data.wagers.length).toBe(1);
    expect(bundle.wagers.data.wagers[0]?.ticketId).toBe("W-88401");
    expect(bundle.wagers.data.wagers[0]?.autoExecute).toBe(false);
    expect(bundle.wagers.data.provenance.kind).toBe("capture");
    expect(formatProvenanceBadge(bundle.wagers.data.provenance).badgeText).toBe(
      "● LIVE CAPTURE",
    );

    const noop = () => {};
    const customersHtml = renderToStaticMarkup(
      React.createElement(CustomersTabPanel, {
        bannerDismissed: true,
        onDismissBanner: noop,
        kpisCollapsed: false,
        onToggleKpis: noop,
        cohortsReport: bundle.customers.data,
        cohortsStatus: "ready",
        searchQuery: "",
        onSearchQueryChange: noop,
        filterTier: "ALL",
        onFilterTierChange: noop,
        sortedCustomers: SAMPLE_PROFILE_DATA,
        customerSort: { key: "score", dir: -1 },
        onCustomerSort: noop,
        selectedCustomer: SAMPLE_PROFILE_DATA[0] ?? null,
        onSelectCustomer: noop,
        copiedCliId: null,
        onCopyCli: noop,
        customerForensicResult: null,
        onClearForensicResult: noop,
        onRunReverseLookup: noop,
        onOpenTerminalProfile: noop,
      }),
    );

    expect(customersHtml).toContain(
      `${bundle.customers.data.cohorts.backtestCount} Accounts`,
    );
    expect(customersHtml).toContain(
      `${bundle.customers.data.cohorts.uniqueSurveillanceCount} IDs`,
    );
    expect(bundle.customers.data.cohorts.backtestCount).toBe(3);
    expect(bundle.customers.data.cohorts.uniqueSurveillanceCount).toBe(7);
    expect(customersHtml).toContain("● LIVE CAPTURE");
    expect(customersHtml).toContain("enriched_customers_full.json");
    expect(customersHtml).not.toContain("49 Accounts");
    expect(customersHtml).not.toContain("4,914 IDs");

    const wagersHtml = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        wagers: bundle.wagers.data.wagers,
        provenance: bundle.wagers.data.provenance,
        wagerSearch: "",
        onWagerSearchChange: noop,
        wagerSportFilter: "ALL",
        onWagerSportFilterChange: noop,
        wagerAlertFilter: "ALL",
        onWagerAlertFilterChange: noop,
        wagerTypeFilter: "ALL",
        onWagerTypeFilterChange: noop,
        wagerSortField: "timestamp",
        wagerSortDir: "desc",
        onWagerSort: noop,
        selectedWager: bundle.wagers.data.wagers[0] ?? null,
        onSelectWager: noop,
        copiedTicketId: null,
        onCopyText: noop,
        tiersConfig: bundle.tiers.data,
        onSelectCustomerById: noop,
        onInspectPty: noop,
      }),
    );

    expect(wagersHtml).toContain("#W-88401");
    expect(wagersHtml).toContain("● LIVE CAPTURE");
    expect(wagersHtml).toContain("data/live-wagers.json");
    expect(wagersHtml).toContain("1 Wagers");
  });

  test("marks fixture & fallback feeds explicitly with [not live] and surfaces HTTP failure causes without fake zeros", async () => {
    const fixtureApi = buildHydrationApi({ wagerProvenanceKind: "fixture" });
    const fixtureBundle = await hydrateDashboardFeeds((path) => {
      if (path === "/api/customers") {
        return Promise.resolve(
          new Response("Backend unavailable", {
            status: 503,
            statusText: "Service Unavailable",
          }),
        );
      }
      return fixtureApi.fetch(new Request(`http://dashboard.local${path}`));
    });

    expect(fixtureBundle.wagers.ok).toBe(true);
    if (fixtureBundle.wagers.ok) {
      expect(
        formatProvenanceBadge(fixtureBundle.wagers.data.provenance).badgeText,
      ).toBe("◐ FIXTURE [not live]");
    }

    expect(fixtureBundle.customers.ok).toBe(false);
    if (!fixtureBundle.customers.ok) {
      expect(fixtureBundle.customers.error).toContain("HTTP 503");
      const cards = deriveCustomerCohortKpiCards({
        report: null,
        status: "unavailable",
        error: fixtureBundle.customers.error,
      });
      expect(cards.every((c) => c.value === "Unavailable")).toBe(true);
      expect(cards[0]?.sub).toContain("HTTP 503");
    }

    const fallbackBadge = formatProvenanceBadge({
      kind: "fallback",
      label: "In-Memory Fallback",
      sourcePath: null,
      observedAt: "",
    });
    expect(fallbackBadge.badgeText).toBe("◌ SHOWCASE [not live]");
    expect(fallbackBadge.isLive).toBe(false);

    expect(
      parseDashboardWsSignal(
        JSON.stringify({
          type: "topic-event",
          topic: "syndicate-alerts",
          event: "alerts-updated",
          timestamp: "2026-11-12T00:00:00Z",
        }),
      ),
    ).toEqual({ kind: "alerts-updated" });
  });
});
