import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App, PROFILES_UNAVAILABLE_REASON } from "../packages/ui/src/App.tsx";
import {
  fetchRankingsSlice,
  normalizeRankingsResponse,
  PENDING_WAGERS_PROVENANCE,
  RANKINGS_ENDPOINT,
  unavailableProvenance,
} from "../packages/ui/src/hydration.ts";
import {
  CustomersTabPanel,
  LiveWagersTabPanel,
  RankingsTabPanel,
} from "../packages/ui/src/panels/index.tsx";
import {
  FIXTURE_LIVE_WAGERS,
  FIXTURE_PROFILE_CUSTOMERS,
  FIXTURE_RANKINGS,
} from "./fixtures/dashboard_ui_fixtures.ts";

const ROOT = resolve(import.meta.dir, "..");
const RUNTIME_GLOBS = [
  "packages/*/src/**/*.{ts,tsx}",
  "src/**/*.{ts,tsx}",
  "lib/**/*.ts",
  "services/**/*.ts",
  "scripts/**/*.ts",
  "cli/**/*.ts",
  "bin/**/*.ts",
];
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

async function runtimeSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const pattern of RUNTIME_GLOBS) {
    for await (const rel of new Bun.Glob(pattern).scan({ cwd: ROOT })) {
      if (/\.test\.tsx?$/.test(rel) || rel.includes("/node_modules/")) {
        continue;
      }
      sources.set(rel, await Bun.file(resolve(ROOT, rel)).text());
    }
  }
  return sources;
}

const noop = () => {};

const wagersPanelProps = {
  wagerSearch: "",
  onWagerSearchChange: noop,
  wagerSportFilter: "ALL",
  onWagerSportFilterChange: noop,
  wagerAlertFilter: "ALL",
  onWagerAlertFilterChange: noop,
  wagerTypeFilter: "ALL",
  onWagerTypeFilterChange: noop,
  wagerSortField: "timestamp" as const,
  wagerSortDir: "desc" as const,
  onWagerSort: noop,
  selectedWager: null,
  onSelectWager: noop,
  copiedTicketId: null,
  onCopyText: noop,
  tiersConfig: null,
  onSelectCustomerById: noop,
  onInspectPty: noop,
};

const rankingsPanelProps = {
  rankingsSearch: "",
  onRankingsSearchChange: noop,
  rankingsFilter: "ALL" as const,
  onRankingsFilterChange: noop,
  onInspectPty: noop,
};

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("runtime and UI code never carry seed or fixture data", () => {
  test("no runtime module imports from tests/ or the removed showcase module", async () => {
    const offenders: string[] = [];
    for (const [rel, text] of await runtimeSources()) {
      for (const match of text.matchAll(IMPORT_SPECIFIER)) {
        const specifier = match[1] ?? "";
        if (
          /(^|\/)tests\//.test(specifier) ||
          /showcase[_-]data|dashboard_ui_fixtures/.test(specifier)
        ) {
          offenders.push(`${rel} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("UI and backend sources contain none of the synthetic fixture rows", async () => {
    const markers = [
      ...FIXTURE_PROFILE_CUSTOMERS.map((c) => c.name),
      ...FIXTURE_LIVE_WAGERS.map((w) => w.ticketId),
    ];
    const offenders: string[] = [];
    for (const [rel, text] of await runtimeSources()) {
      if (
        !rel.startsWith("packages/ui/src/") &&
        !rel.startsWith("packages/backend/src/")
      ) {
        continue;
      }
      for (const marker of markers) {
        if (text.includes(marker)) offenders.push(`${rel}: ${marker}`);
      }
    }
    expect(markers.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  test("the App's first paint shows pending and unavailable states, not rows", () => {
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain("No live profile source yet");
    expect(html).toContain("Live Wagers (0)");
    expect(html).toContain("Downlines (—)");
    for (const customer of FIXTURE_PROFILE_CUSTOMERS) {
      expect(html).not.toContain(customer.name);
    }
  });
});

describe("each dashboard panel names its endpoint when the source fails", () => {
  test("Live Wagers: fetch failure renders the error and an unavailable empty row", () => {
    const error = "GET /api/wagers failed: connect ECONNREFUSED 127.0.0.1:4020";
    const html = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        ...wagersPanelProps,
        provenance: unavailableProvenance("/api/wagers", error),
        wagersError: error,
      }),
    );
    expect(html).toContain("Live Wagers Feed Error:");
    expect(html).toContain(`Unavailable — /api/wagers: ${error}`);
    expect(html).toContain('data-wagers-empty="unavailable"');
    expect(html).not.toContain(FIXTURE_LIVE_WAGERS[0]!.ticketId);
  });

  test("Live Wagers: before the first response it waits on GET /api/wagers", () => {
    const html = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        ...wagersPanelProps,
        provenance: PENDING_WAGERS_PROVENANCE,
      }),
    );
    expect(html).toContain("Waiting for GET /api/wagers…");
  });

  test("Live Wagers: an empty live feed says so instead of inventing rows", () => {
    const html = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        ...wagersPanelProps,
        wagers: [],
        provenance: {
          kind: "capture",
          label: "Local Capture",
          sourcePath: "data/live-wagers.json",
          observedAt: "2026-11-14T21:00:00.000Z",
        },
      }),
    );
    expect(html).toContain(
      "Local Capture returned no wagers (data/live-wagers.json).",
    );
  });

  test("Downlines: an HTTP 500 from /api/rankings/all renders the server error, no KPIs", async () => {
    const slice = await fetchRankingsSlice(async () =>
      jsonResponse(
        {
          error:
            "f402-bets.jsonl not found at /srv/probes/out13/f402-bets.jsonl.",
        },
        500,
      ),
    );
    expect(slice.ok).toBe(false);
    if (slice.ok) return;
    expect(slice.error).toBe(
      `GET ${RANKINGS_ENDPOINT} returned HTTP 500 (error): f402-bets.jsonl not found at /srv/probes/out13/f402-bets.jsonl.`,
    );
    const html = renderToStaticMarkup(
      React.createElement(RankingsTabPanel, {
        ...rankingsPanelProps,
        rankingsStatus: "unavailable",
        rankingsError: slice.error,
      }),
    );
    expect(html).toContain(
      `Rankings unavailable — GET ${RANKINGS_ENDPOINT}: ${slice.error}`,
    );
    expect(html).toContain('data-rankings-empty="players"');
    expect(html).toContain('data-rankings-empty="conduits"');
    expect(html).toContain("Proxy Conduits (—)");
    expect(html).not.toContain("$268.9M");
  });

  test("Downlines: a network failure and a wrong payload shape are both named", async () => {
    const network = await fetchRankingsSlice(async () => {
      throw new TypeError("fetch failed");
    });
    expect(network).toEqual({
      ok: false,
      error: `GET ${RANKINGS_ENDPOINT} failed: fetch failed`,
    });
    const shape = await fetchRankingsSlice(async () => jsonResponse({}));
    expect(shape).toEqual({
      ok: false,
      error: `GET ${RANKINGS_ENDPOINT} returned an unexpected BatchedRankingResult payload`,
    });
  });

  test("Downlines: a ready source renders its own totals and rows", () => {
    const html = renderToStaticMarkup(
      React.createElement(RankingsTabPanel, {
        ...rankingsPanelProps,
        rankings: FIXTURE_RANKINGS,
      }),
    );
    expect(html).toContain("$268.9M");
    expect(html).toContain("9,134 Accounts");
    expect(html).toContain(
      `Proxy Conduits (${FIXTURE_RANKINGS.conduits.length})`,
    );
    expect(html).not.toContain("data-rankings-source");
  });

  test("Profiles: the customers tab replaces cards with the no-source state", () => {
    const html = renderToStaticMarkup(
      React.createElement(CustomersTabPanel, {
        bannerDismissed: true,
        onDismissBanner: noop,
        kpisCollapsed: true,
        onToggleKpis: noop,
        searchQuery: "",
        onSearchQueryChange: noop,
        filterTier: "ALL",
        onFilterTierChange: noop,
        sortedCustomers: [],
        customerSort: { key: "score", dir: -1 },
        onCustomerSort: noop,
        selectedCustomer: null,
        onSelectCustomer: noop,
        copiedCliId: null,
        onCopyCli: noop,
        customerForensicResult: null,
        onClearForensicResult: noop,
        onRunReverseLookup: noop,
        onOpenTerminalProfile: noop,
        profilesUnavailableReason: PROFILES_UNAVAILABLE_REASON,
      }),
    );
    expect(html).toContain('data-profiles-source="unavailable"');
    expect(html).toContain("No live profile source yet");
    expect(html).toContain("GET /api/customer/profile?id=");
    expect(html).not.toContain("Profiled Bettors");
  });
});

describe("normalizeRankingsResponse", () => {
  const envelope = {
    generatedAtIso: "2026-11-14T21:00:00.000Z",
    windowStart: "2026-10-15",
    windowEnd: "2026-11-14",
    totalWagersScanned: 10,
    inWindowWagers: 4,
    totalHandleUsd: 4200,
    totalToWinUsd: 3900,
    activeCustomerCount: 2,
    activeSubAgentCount: 1,
    activeMasterAgentCount: 1,
    conduitSubAgentCount: 1,
    topMasterAgents: [],
  };
  const player = {
    rank: 1,
    customerId: "CUST1",
    agentId: "AG1",
    masterAgent: "MA1",
    totalWagers: 3,
    handleUsd: 4000,
    stakeGini: 0.1,
    alertRatePct: 33,
    dominantSport: "NFL",
    compositeScore: 7.2,
    tier: "TIER_3",
    tierLabel: "Tier 3: Disciplined Sharp",
    recommendedLimitUsd: 1000,
    isProxyConduit: true,
  };

  test("maps BatchedRankingResult rows and keeps only flagged conduits", () => {
    const normalized = normalizeRankingsResponse({
      ...envelope,
      topRankedPlayers: [player],
      topSubAgents: [
        {
          agentId: "AG1",
          masterAgent: "MA1",
          totalHandleUsd: 4000,
          totalWagers: 3,
          topCustomer: "CUST1",
          topCustomerConcentrationPct: 95.2,
          isProxyConduit: true,
        },
        {
          agentId: "AG2",
          masterAgent: "MA1",
          totalHandleUsd: 200,
          totalWagers: 1,
          topCustomer: "CUST2",
          topCustomerConcentrationPct: 40,
          isProxyConduit: false,
        },
      ],
    });
    expect(normalized?.players).toEqual([
      {
        rank: 1,
        id: "CUST1",
        agentId: "AG1",
        masterAgent: "MA1",
        handleUsd: 4000,
        wagers: 3,
        gini: 0.1,
        alertRate: 33,
        score: 7.2,
        tier: "TIER_3",
        tierLabel: "Tier 3: Disciplined Sharp",
        dominantSport: "NFL",
        isProxy: true,
        limitUsd: 1000,
      },
    ]);
    expect(normalized?.conduits.map((c) => c.agentId)).toEqual(["AG1"]);
    expect(normalized?.summary.totalHandleUsd).toBe(4200);
    expect(normalized?.rejectedRows).toBe(0);
  });

  test("counts rows with missing or non-numeric fields instead of coercing them", () => {
    const normalized = normalizeRankingsResponse({
      ...envelope,
      topRankedPlayers: [
        player,
        { ...player, customerId: "" },
        { ...player, handleUsd: "4000" },
        { ...player, compositeScore: Number.NaN },
        null,
      ],
      topSubAgents: [{ agentId: "AG9", isProxyConduit: true }],
    });
    expect(normalized?.players).toHaveLength(1);
    expect(normalized?.conduits).toEqual([]);
    expect(normalized?.rejectedRows).toBe(5);
  });

  test("rejects envelopes that are not a BatchedRankingResult", () => {
    expect(normalizeRankingsResponse(null)).toBeNull();
    expect(normalizeRankingsResponse([])).toBeNull();
    expect(
      normalizeRankingsResponse({ ...envelope, topRankedPlayers: [] }),
    ).toBeNull();
    expect(
      normalizeRankingsResponse({
        ...envelope,
        totalHandleUsd: undefined,
        topRankedPlayers: [],
        topSubAgents: [],
      }),
    ).toBeNull();
  });
});
