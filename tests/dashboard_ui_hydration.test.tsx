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
  normalizeLiveWagersResponse,
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
  test("normalizeLiveWagersResponse carries wire_contract, and drops a malformed block", () => {
    const base = {
      wagers: [],
      provenance: {
        kind: "capture",
        label: "Local Capture",
        sourcePath: "data/live-wagers.json",
        observedAt: "2026-11-14T00:00:00Z",
      },
    };
    const withContract = normalizeLiveWagersResponse({
      ...base,
      wire_contract: {
        ok: true,
        registry: "schema/wagers_field_contract.json",
        capture: "getBetTicker-2026-10-31",
        capture_sha256: "955c",
        enum_source: "observed",
        fields_checked: ["WagerType", "VIP"],
        rows: 237,
        skipped_rows: 63,
        violations: [],
      },
    });
    expect(withContract?.wireContract?.rows).toBe(237);
    expect(withContract?.wireContract?.skipped_rows).toBe(63);
    expect(withContract?.wireContract?.enum_source).toBe("observed");
    expect(withContract?.wireContract?.ok).toBe(true);

    // `ok` must be a boolean; anything else is dropped rather than guessed.
    const malformed = normalizeLiveWagersResponse({
      ...base,
      wire_contract: { ok: "yes", rows: 1 },
    });
    expect(malformed?.wireContract).toBeNull();

    // Absent block stays null (a host that does not check the contract).
    expect(normalizeLiveWagersResponse(base)?.wireContract).toBeNull();
  });

  test("normalizeLiveWagersResponse carries slab_policy, and drops a malformed block", () => {
    const base = {
      wagers: [],
      provenance: {
        kind: "capture",
        label: "Local Capture",
        sourcePath: "data/live-wagers.json",
        observedAt: "2026-11-14T00:00:00Z",
      },
    };
    const withSlab = normalizeLiveWagersResponse({
      ...base,
      slab_policy: {
        schema: "sportsdesk-slab/v1",
        version: "1.0.0",
        window_bytes: 2_000_000,
        unsafe_allowed: true,
        sentinels: {
          null_clv: -2147483648,
          null_customer_handle32: 4294967295,
          null_bridge_channel_word32: 4294967295,
        },
      },
    });
    expect(withSlab?.slabPolicy?.window_bytes).toBe(2_000_000);
    expect(withSlab?.slabPolicy?.sentinels.null_clv).toBe(-2147483648);
    expect(withSlab?.slabPolicy?.unsafe_allowed).toBe(true);

    // A missing sentinel key makes the block unusable: drop it rather than guess.
    const malformed = normalizeLiveWagersResponse({
      ...base,
      slab_policy: {
        schema: "sportsdesk-slab/v1",
        version: "1.0.0",
        window_bytes: 2_000_000,
        unsafe_allowed: true,
        sentinels: { null_clv: -2147483648 },
      },
    });
    expect(malformed?.slabPolicy).toBeNull();
    expect(normalizeLiveWagersResponse(base)?.slabPolicy).toBeNull();
  });

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
      "● LOCAL CAPTURE",
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
    expect(customersHtml).toContain("● LOCAL CAPTURE");
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
    expect(wagersHtml).toContain("● LOCAL CAPTURE");
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
      expect(cards.every((c) => c.status === "unavailable")).toBe(true);
      expect(cards.every((c) => c.count === null && c.sharePct === null)).toBe(
        true,
      );
      expect(cards[0]?.sub).toContain("HTTP 503");
    }

    const readyCards = deriveCustomerCohortKpiCards({
      status: "ready",
      report: {
        cohorts: {
          backtestCount: 49,
          keyNumberSharpsCount: 5,
          hookSyndicateCount: 5,
          fixtureCount: 6,
          fullBookSpecCount: 220,
          uniqueSurveillanceCount: 500,
        },
        backtestTop: [],
        fixtures: [],
        provenance: {
          kind: "capture",
          label: "Local Capture",
          sourcePath: "data/live.json",
          observedAt: "2026-11-14T00:00:00Z",
        },
      },
    });
    expect(readyCards[0]).toMatchObject({
      id: "backtest",
      status: "ready",
      tone: "sky",
      count: 49,
      sharePct: 9.8,
      filterTier: "ALL",
    });
    expect(readyCards[1]).toMatchObject({
      id: "key-number-sharps",
      tone: "red",
      count: 5,
      sharePct: 1,
      filterTier: "ELITE",
    });

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
