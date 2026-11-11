import { expect, open, test } from "nsh/test";

const STUB_KPIS = {
  success: true,
  generatedAt: "2026-11-10T19:45:00.000Z",
  kpis: {
    agents: {
      total: 2276,
      agents: 1679,
      masters: 596,
      provenance: {
        source: "scratch/agent-graph.json",
        basis: "fixture",
        asOf: "2026-11-09T04:11:20.581Z",
        ageSeconds: 120,
        stale: false,
        partial: false,
      },
    },
    pending: {
      wagers: 169,
      tickets: 169,
      wageredCents: 2069864,
      toWinCents: 12668020,
      provenance: {
        source: "live:/cloud/api/Report/Pending",
        basis: "capture",
        asOf: "2026-11-10T07:19:28.024Z",
        ageSeconds: 44900,
        stale: true,
        partial: false,
      },
    },
  },
  pipeline: {
    r2: {
      "f402-weblog": {
        state: "fresh",
        ageSeconds: 1800,
        stale: false,
        dataAgeSeconds: 503000,
        dataStale: true,
        reason: "30m old (SLA 1h30m)",
      },
    },
  },
};

const STUB_KALSHI = {
  success: true,
  generatedAt: "2026-11-10T19:45:00.000Z",
  provenance: {
    dataMode: "PARTIAL",
    asOf: "2026-11-04T20:00:38.143Z",
    ageSeconds: 517600,
    stale: true,
    fixture: true,
    sources: ["docs/graph-live-feed.json"],
  },
  kalshi: { ok: true, degraded: false },
  signals: [
    {
      id: "NBA-BOS_LAL-1q_total-55.5-over",
      league: "NBA",
      marketKind: "1q_total",
      teams: ["LAL", "BOS"],
      sideTeam: null,
      line: 55.5,
      overUnder: "over",
      distinctAccounts: 2,
      riskUsd: 27700,
      fairProb: 0.4651,
      confidence: 60,
      provenance: {
        dataMode: "PARTIAL",
        ageSeconds: 517600,
        stale: true,
        fixture: true,
        sources: ["docs/graph-live-feed.json"],
      },
      kalshi: {
        edgeBps: 420,
        verdict: "actionable",
        reason: "spread within 4c",
      },
      accounts: [
        {
          login: "MJ102",
          agentId: "MJ2026",
          archetype: "On-Chain CTF Whale",
          riskUsd: 16200,
        },
      ],
    },
  ],
};

const STUB_SCOREBOARD = {
  schemaVersion: 1,
  source: "operator paste of fantasy402 manager.html scoreboard",
  observedAt: "2026-11-01",
  summary: { games: 1, live: 0, final: 1, scheduled: 0 },
  games: [
    {
      league: "NFL",
      status: "final",
      period: "Final",
      team1: { name: "Vikings", score: 15 },
      team2: { name: "Lions", score: 19 },
    },
  ],
};

function defaultStubNetwork(onKpiCall?: () => void) {
  return {
    "GET http://127.0.0.1:4020/api/kpis": () => {
      onKpiCall?.();
      return { status: 200, body: STUB_KPIS };
    },
    "GET http://127.0.0.1:4020/api/signals/kalshi": {
      status: 200,
      body: STUB_KALSHI,
    },
    "GET http://127.0.0.1:4020/api/scoreboard": {
      status: 200,
      body: STUB_SCOREBOARD,
    },
    "GET http://127.0.0.1:4020/api/live-bets/summary": {
      status: 503,
      body: {
        success: false,
        error: "live Report/Pending unavailable",
        live: {
          diagnostic: {
            code: "unauthorized",
            message: "Report/Pending returned 401",
          },
        },
      },
    },
  };
}

test("renders workspace, provenance badges, 503 diagnostic honesty, and keyboard refresh", async () => {
  let kpiCalls = 0;
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1280,
    height: 820,
    network: defaultStubNetwork(() => {
      kpiCalls += 1;
    }),
  });

  await app.waitUntil(() => app.texts().some((t) => t.includes("2,276 nodes")));

  const texts = app.texts().join("\n");
  expect(texts).toContain("Sportsdesk Desk");
  expect(texts).toContain("http://127.0.0.1:4020 [default:4020]");
  expect(texts).toContain("fixture · 2m");
  expect(texts).toContain("[DATA-STALE]");
  expect(texts).toContain(
    "/api/live-bets/summary HTTP 503 [unauthorized]: live Report/Pending unavailable — Report/Pending returned 401",
  );
  expect(texts).toContain("MJ102 (MJ2026)");

  await app.press("Refresh");
  await app.waitUntil(() => kpiCalls >= 2);
  expect(kpiCalls).toBeGreaterThanOrEqual(2);

  await app.keyboard.press("mod+r");
  await app.waitUntil(() => kpiCalls >= 3);
  expect(kpiCalls).toBeGreaterThanOrEqual(3);
});

test("surfaces explicit unavailable cause instead of zero when signals endpoint fails", async () => {
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1280,
    height: 820,
    network: {
      "GET http://127.0.0.1:4020/api/kpis": { status: 200, body: STUB_KPIS },
      "GET http://127.0.0.1:4020/api/signals/kalshi": {
        status: 503,
        body: {
          error: "kalshi upstream unavailable",
          code: "upstream_down",
        },
      },
      "GET http://127.0.0.1:4020/api/scoreboard": {
        status: 200,
        body: STUB_SCOREBOARD,
      },
      "GET http://127.0.0.1:4020/api/live-bets/summary": {
        status: 200,
        body: { totalWagers: 12, totalRiskUsd: 4500, mode: "live" },
      },
    },
  });

  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("Kalshi signals unavailable")),
  );
  const texts = app.texts().join("\n");
  expect(texts).toContain(
    "/api/signals/kalshi HTTP 503 [upstream_down]: kalshi upstream unavailable",
  );
});

test("switches semantic tokens across light and dark appearances and opens/dismisses UI kit via keyboard", async () => {
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1280,
    height: 820,
    colorScheme: "light",
    reducedMotion: true,
    network: defaultStubNetwork(),
  });

  await app.waitUntil(() => app.texts().some((t) => t.includes("2,276 nodes")));

  const lightTitleStyle = app.spanStyle("text:Sportsdesk Desk");
  expect(lightTitleStyle.color.toLowerCase()).toBe("#0f172aff");
  expect(lightTitleStyle.fontSize).toBeGreaterThanOrEqual(12);

  await app.setColorScheme("dark");
  const darkTitleStyle = app.spanStyle("text:Sportsdesk Desk");
  expect(darkTitleStyle.color.toLowerCase()).toBe("#f1f5f9ff");

  await app.keyboard.press("mod+u");
  await app.waitFor("text:Sportsdesk UI kit");
  expect(app.texts().join("\n")).toContain("Buttons — variants & states");
  expect(app.texts().join("\n")).toContain("Split probe (0)");

  await app.press("id:ui-kit-split-probe");
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("Split probe (1)")),
  );

  await app.keyboard.press("escape");
  await app.waitFor("text:Sportsdesk UI kit", { state: "gone" });
});

test("adapts cleanly to compact mobile viewport with drawer/sheet docks", async () => {
  const app = await open("./App.tsx", {
    platform: "ios",
    width: 390,
    height: 844,
    reducedMotion: true,
    network: defaultStubNetwork(),
  });

  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("NBA-BOS_LAL-1q_total-55.5-over")),
  );
  expect(app.shows("Refresh")).toBe(true);
  expect(app.shows("id:workspace-menu")).toBe(true);
});

test("hydrates Storage preferences, persists lock mutations, and copies diagnostics JSON to Clipboard", async () => {
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1280,
    height: 820,
    reducedMotion: true,
    storage: {
      "ops.sportsdesk.desk.prefs.v1": JSON.stringify({
        schemaVersion: 1,
        leagueFilter: "NBA",
        autoPoll: true,
        locked: false,
        dockOpen: { left: true, bottom: true },
      }),
    },
    network: defaultStubNetwork(),
  });

  await app.waitUntil(() => app.texts().some((t) => t.includes("2,276 nodes")));

  await app.keyboard.press("mod+shift+l");
  await app.waitUntil(() => {
    const raw = app.storage()["ops.sportsdesk.desk.prefs.v1"];
    if (typeof raw !== "string") return false;
    const parsed = JSON.parse(raw) as {
      locked?: boolean;
      leagueFilter?: string;
      autoPoll?: boolean;
    };
    return (
      parsed.locked === true &&
      parsed.leagueFilter === "NBA" &&
      parsed.autoPoll === true
    );
  });

  await app.keyboard.press("mod+shift+c");
  await app.waitUntil(() => app.clipboard() !== null);

  const clipText = app.clipboard() ?? "";
  const diag = JSON.parse(clipText) as {
    appId: string;
    origin: string;
    originSource: string;
    endpoints: Array<{ endpoint: string; status: string; cause?: string }>;
    r2Sinks: Array<{ sink: string; windowDivergent: boolean }>;
  };
  expect(diag.appId).toBe("ops.sportsdesk.desk");
  expect(diag.origin).toBe("http://127.0.0.1:4020");
  expect(diag.originSource).toBe("default:4020");
  expect(
    diag.endpoints.find((e) => e.endpoint === "/api/live-bets/summary")?.cause,
  ).toContain("HTTP 503 [unauthorized]");
  expect(diag.r2Sinks[0]?.windowDivergent).toBe(true);
  expect(app.shows("id:diagnostics-copied-badge")).toBe(true);
});

test("renders live-bets summary telemetry when HTTP 200 and recovers from root ErrorBoundary", async () => {
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1280,
    height: 820,
    reducedMotion: true,
    host: {
      params: {
        __testForceRenderError: "Simulated panel crash",
      },
    },
    network: {
      ...defaultStubNetwork(),
      "GET http://127.0.0.1:4020/api/live-bets/summary": {
        status: 200,
        body: { totalWagers: 14, totalRiskUsd: 6250, mode: "live" },
      },
    },
  });

  await app.waitFor("text:Workspace render error");
  expect(app.texts().join("\n")).toContain("Simulated panel crash");

  await app.press("Reload workspace");
  await app.waitUntil(() => app.texts().some((t) => t.includes("2,276 nodes")));
  const texts = app.texts().join("\n");
  expect(texts).toContain("Sportsdesk Desk");
  expect(texts).toContain("HTTP 200 · 14 wagers · $6250 [live]");
});

test("mounts SignalsPanel in isolation via DeskStoreContext.Provider without prop-drilling", async () => {
  const app = await open("./App.tsx", {
    platform: "macos",
    width: 960,
    height: 640,
    reducedMotion: true,
    host: {
      params: {
        __testIsolatedPanel: "signals",
      },
    },
    network: defaultStubNetwork(),
  });

  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("MJ102 (MJ2026)")),
  );
  const texts = app.texts().join("\n");
  expect(texts).toContain("1 signals");
  expect(texts).toContain("KALSHI · OK");
  expect(texts).not.toContain("Sportsdesk Desk");
});

test("renders Stocks Markets terminal (Composite breadth, Prev close/Turnover stats, 5->10 order book) and executes paper ticket", async () => {
  let executedOrderBody: Record<string, unknown> | null = null;
  let switchedMode: string | null = null;

  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1360,
    height: 860,
    reducedMotion: true,
    network: {
      ...defaultStubNetwork(),
      "GET http://127.0.0.1:4020/api/execution/plan*": {
        status: 200,
        body: {
          mode: "paper",
          style: "auto",
          killSwitch: { active: false },
          policy: { maxOrderNotionalUsd: 2500, maxDailyNotionalUsd: 10000 },
          risk: { remainingDailyNotionalUsd: 8500 },
          blockedReasons: [],
          decisions: [
            {
              signalId: "NBA-BOS_LAL-1q_total-55.5-over",
              venue: "kalshi-paper",
              ticker: "NBA·LAL@BOS",
              action: "buy",
              side: "yes",
              contracts: 1000,
              limitPriceCents: 47,
              notionalUsd: 470,
              edgeBps: 420,
              reason: "spread within 4c",
            },
          ],
          paper: { totalFills: 3 },
        },
      },
      "POST http://127.0.0.1:4020/api/execution/mode": (req) => {
        const parsed = req.body
          ? (JSON.parse(req.body) as { mode?: string })
          : {};
        switchedMode = parsed.mode ?? null;
        return {
          status: 200,
          body: { success: true, mode: switchedMode ?? "paper" },
        };
      },
      "POST http://127.0.0.1:4020/api/execution/run": (req) => {
        executedOrderBody = req.body
          ? (JSON.parse(req.body) as Record<string, unknown>)
          : null;
        return {
          status: 200,
          body: {
            success: true,
            mode: "paper",
            style: "auto",
            filledCount: 1,
            message: "filled 1 paper leg",
          },
        };
      },
    },
  });

  await app.waitUntil(
    () =>
      app.texts().includes("Prev close") && app.texts().includes("Turnover"),
  );

  const initialTexts = app.texts().join("\n");
  expect(initialTexts).toContain("Open");
  expect(initialTexts).toContain("Prev close");
  expect(initialTexts).toContain("Turnover");
  expect(initialTexts).toContain("Order book");
  expect(initialTexts).toContain("Time & sales");
  expect(initialTexts).toContain("Trade flow");

  // Expand Composite breadth header
  await app.press("id:stocks-composite-toggle");
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("Breadth by League")),
  );

  // Toggle Order Book depth 5 -> 10
  expect(app.texts().some((t) => t === "B10")).toBe(false);
  await app.press("id:book-depth-toggle");
  await app.waitUntil(
    () =>
      app.texts().some((t) => t === "B10") &&
      app.texts().some((t) => t === "A10"),
  );

  // Open Execution Ticket modal, step limit price +1, review & execute paper fill
  await app.press("id:open-order-ticket-btn");
  await app.waitFor("text:Execution Ticket — Paper Venue");

  await app.press("id:ticket-mode-paper");
  await app.waitUntil(() => switchedMode === "paper");

  await app.press("id:ticket-limit-plus");
  await app.press("id:ticket-review-btn");
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("LIMIT · PAPER")),
  );

  await app.press("id:ticket-execute-btn");
  await app.waitUntil(() => executedOrderBody !== null);
  expect(executedOrderBody).toMatchObject({
    live: false,
    style: "auto",
    side: "yes",
    stakeUsd: 500,
    limitCents: 48,
    signalId: "NBA-BOS_LAL-1q_total-55.5-over",
  });
  await app.waitFor("id:order-toast-banner");
  expect(app.texts().join("\n")).toContain("filled 1 paper leg");
});

test("navigates Board, Surveillance, Forensics, and System & Ops planes across all :4020 endpoint families", async () => {
  let watchlistAuthorized = false;

  const app = await open("./App.tsx", {
    platform: "macos",
    width: 1360,
    height: 900,
    reducedMotion: true,
    network: {
      ...defaultStubNetwork(),
      // Board plane
      "GET http://127.0.0.1:4020/api/game-admin/board*": {
        status: 200,
        body: {
          source: "live-board",
          window: 24,
          summary: { games: 1, totalWageredUsd: 48200 },
          games: [
            {
              gameNum: 540,
              league: "NBA",
              status: "live",
              clock: "Q2 04:12",
              teams: ["Lakers", "Celtics"],
              score: [54, 59],
              openers: { spread: "-3.5" },
              spread: ["-4.5 (-110)"],
              money: ["+155 / -180"],
              total: ["224.5"],
            },
          ],
        },
      },
      "GET http://127.0.0.1:4020/api/game-admin": {
        status: 200,
        body: {
          source: "captured",
          games: [
            {
              matchup: "Lakers @ Celtics",
              league: "NBA",
              total: { wagers: 42, wagered: 48200, toWin: 43800 },
              positions: {
                Straight: { wagered: 32000 },
                Parlay: { wagered: 11200 },
                Teaser: { wagered: 5000 },
              },
            },
          ],
        },
      },
      "GET http://127.0.0.1:4020/api/logo/*": {
        status: 200,
        body: {
          name: "lakers",
          source: "local",
          format: "png",
          width: 128,
          height: 128,
          bytes: 6144,
          placeholder: "data:image/webp;base64,UklGRg==",
        },
      },
      "GET http://127.0.0.1:4020/api/sports": {
        status: 200,
        body: { liveFilter: ["NBA", "NFL"], all: ["NBA", "NFL", "NHL"] },
      },
      "GET http://127.0.0.1:4020/api/sports/catalog": {
        status: 200,
        body: {
          source: "portal-catalog",
          summary: { sports: 9, subSports: 31, periodEntries: 88 },
          collisions: [{ id: "col-1" }],
          migrationRisks: [],
        },
      },
      "GET http://127.0.0.1:4020/api/contests*": {
        status: 200,
        body: {
          source: "contests.json",
          summary: { total: 2, byGroup: { Futures: 2 } },
          count: 2,
          entries: [
            {
              contestNum: "901",
              group: "Futures",
              description: "NBA Championship Winner",
              cutOff: "2026-06-01",
            },
          ],
        },
      },
      "GET http://127.0.0.1:4020/api/v1/live-bets*": {
        status: 200,
        body: {
          apiVersion: "1",
          dataSource: "file",
          pendingCount: 5,
          games: [],
        },
      },
      "GET http://127.0.0.1:4020/api/v2/live-bets*": {
        status: 200,
        body: {
          apiVersion: "2",
          dataSource: "file",
          fallbackUsed: false,
          games: [],
        },
      },
      "GET http://127.0.0.1:4020/api/live-wagers*": {
        status: 200,
        body: {
          summary: { wageredCents: 950000 },
          wagers: [
            {
              ticketNumber: "8810",
              customerId: "MJ102",
              writer: "inet",
              wagerType: "Straight",
              riskCents: 950000,
              toWinCents: 863600,
              description: "Celtics -4.5",
            },
          ],
        },
      },
      "GET http://127.0.0.1:4020/api/f402/get-pending": {
        status: 410,
        body: { error: "retired endpoint", code: "gone" },
      },

      // Surveillance plane
      "GET http://127.0.0.1:4020/api/graph/summary": {
        status: 200,
        body: {
          feed: { dataMode: "LIVE", totalOpenExposureUsd: 64200 },
          bridges: ["3a", "3b", "3c"],
          automation: { enabled: true },
        },
      },
      "GET http://127.0.0.1:4020/api/graph-feed": {
        status: 200,
        body: {
          schemaVersion: 3,
          dataMode: "LIVE",
          provenance: {
            basis: "live",
            source: "graph",
            stale: false,
            partial: false,
          },
          activeSyndicateWalletsCount: 4,
          configuredWalletsCount: 6,
          totalOpenLegsCount: 9,
          totalOpenExposureUsd: 64200,
          pendingBets: [
            {
              id: "leg-1",
              login: "WHALE77",
              league: "NBA",
              selection: "BOS Over 55.5",
              riskUsd: 18500,
              sharpScore: 92,
            },
          ],
          walletProfiles: [
            {
              label: "WHALE77",
              archetype: "SyndicateOriginator",
              openExposureUsd: 31000,
            },
          ],
          perOfficeIpTrackerClusters: [
            {
              clusterId: "CL-9",
              office: "BILLY666",
              accountCount: 3,
              ipPrefix: "198.51.100.0/24",
              severity: "elevated",
            },
          ],
          backtest4Wk: {
            weeks: [
              {
                week: "2026-W44",
                estimatedSavingsUsd: 12400,
                holdImprovementBps: 85,
              },
            ],
          },
        },
      },
      "GET http://127.0.0.1:4020/api/graph/stream": {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: 'event: graph.snapshot\ndata: {"activeWallets":4,"openLegs":9}\n\n',
      },
      "GET http://127.0.0.1:4020/api/gslive/weblogs": {
        status: 200,
        body: { status: "measured", source: "r2", accounts: ["A1", "A2"] },
      },
      "GET http://127.0.0.1:4020/api/gslive/session-health*": {
        status: 200,
        body: {
          authModel: "cookie-jar",
          session: { status: "ready" },
          advisory: "healthy session",
        },
      },
      "GET http://127.0.0.1:4020/api/bridge3c/status": {
        status: 200,
        body: {
          boundary: "CLASS_D",
          readOnly: true,
          rollup: { status: "fresh" },
        },
      },

      // Forensics plane
      "GET http://127.0.0.1:4020/api/agents/search*": {
        status: 200,
        body: {
          query: "BI",
          count: 1,
          agents: [{ key: "BILLY666", level: 1, agentType: "M" }],
        },
      },
      "GET http://127.0.0.1:4020/api/agent-tree*": {
        status: 200,
        body: {
          agentCount: 2276,
          roots: [{ key: "BILLY666", children: ["A1", "A2"] }],
          collisions: [],
        },
      },
      "GET http://127.0.0.1:4020/api/analysis/filters": {
        status: 200,
        body: {
          reports: ["CP"],
          captured: { sports: ["Baseball", "Basketball"] },
          weeks: ["-1"],
        },
      },
      "GET http://127.0.0.1:4020/api/analysis/reports": {
        status: 200,
        body: { count: 1, reports: ["CP · BILLY666 · Baseball"] },
      },
      "GET http://127.0.0.1:4020/api/analysis*": {
        status: 200,
        body: {
          available: true,
          description: "Captured CP Baseball slice",
          discrepancies: [],
          rows: [
            {
              customerId: "DK121",
              agentId: "BILLY666",
              wagers: 18,
              riskCents: 425000,
              netCents: 112500,
            },
          ],
        },
      },
      "GET http://127.0.0.1:4020/api/customer/profile*": {
        status: 200,
        body: {
          profile: {
            customerId: "DK121",
            agentId: "BILLY666",
            lifetime: { netUsd: 8920 },
            recent7d: { netUsd: 1410 },
            sampleTickets: [{ id: "T1" }, { id: "T2" }],
            sampleOnly: true,
          },
        },
      },
      "GET http://127.0.0.1:4020/api/customer/rating*": {
        status: 200,
        body: {
          rating: {
            customerId: "DK121",
            tier: "sharp-watch",
            bayesianSkill: { posteriorMean: 0.064, probSkillPositive: 0.88 },
            kellyMetrics: { recommendedFraction: 0.25 },
          },
        },
      },
      "GET http://127.0.0.1:4020/api/watchlist": (req) => {
        const auth =
          req.headers["authorization"] ?? req.headers["Authorization"] ?? "";
        if (auth === "Bearer sec-tok-99") {
          watchlistAuthorized = true;
          return {
            status: 200,
            body: {
              watchlist: [
                {
                  customerId: "DK121",
                  label: "DK121 (BILLY666)",
                  reason: "CLV sharp",
                },
              ],
            },
          };
        }
        return {
          status: 401,
          body: { error: "admin bearer token required", code: "unauthorized" },
        };
      },

      // System & Ops plane
      "GET http://127.0.0.1:4020/health": {
        status: 200,
        body: {
          status: "healthy",
          operationalStatus: "nominal",
          dataStatus: "fresh",
          uptimeSeconds: 942,
          runtime: "Bun 1.4.4",
          degradedReasons: [],
        },
      },
      "GET http://127.0.0.1:4020/api/status": {
        status: 200,
        body: {
          ok: true,
          status: "healthy",
          health: { memory: { rss: 104857600 } },
          checks: { r2: true, kalshi: true },
        },
      },
      "GET http://127.0.0.1:4020/api/dns/telemetry": {
        status: 200,
        body: {
          telemetry: {
            size: 12,
            hitRatePercent: 94,
            cacheHitsCompleted: 180,
            cacheHitsInflight: 3,
            cacheMisses: 11,
          },
          coreHosts: ["api.elections.kalshi.com"],
        },
      },
      "GET http://127.0.0.1:4020/governance.json": {
        status: 200,
        body: {
          referenceDate: "2026-11-10",
          summary: {
            openTasks: 2,
            doneTasks: 31,
            p0Open: 0,
            readyGates: 6,
            totalGates: 6,
            pendingDecisions: 0,
          },
          oracleGates: [
            { id: "G-ORACLE-1", name: "Manager Boot Parity", status: "ready" },
          ],
        },
      },
      "GET http://127.0.0.1:4020/api/telegram/status": {
        status: 503,
        body: {
          error: "SPORTSDESK_ADMIN_TOKEN not configured",
          code: "admin_unset",
        },
      },
      "GET http://127.0.0.1:4020/api/telegram/activity*": {
        status: 503,
        body: {
          error: "SPORTSDESK_ADMIN_TOKEN not configured",
          code: "admin_unset",
        },
      },
      "GET http://127.0.0.1:4020/api/test/error": {
        status: 500,
        body: {
          error: "Intentional error-boundary verification",
          code: "test_error",
        },
      },
      "POST http://127.0.0.1:4020/api/parse-toml": {
        status: 200,
        body: {
          ok: true,
          parsed: {
            tier: { whale: { min_risk_usd: 10000, route: "kalshi-paper" } },
          },
        },
      },
    },
  });

  await app.waitUntil(() => app.texts().some((t) => t.includes("2,276 nodes")));

  // 1. Board plane
  await app.press("Board");
  await app.waitFor("id:board-workspace");
  await app.waitUntil(
    () =>
      app.texts().some((t) => t.includes("Lakers @ Celtics")) &&
      app.texts().some((t) => t.includes("f402 GUARD · HTTP 410")),
  );
  expect(app.texts().join("\n")).toContain("NBA Championship Winner");

  // 2. Surveillance plane + SSE stream sample
  await app.press("Surveillance");
  await app.waitFor("id:surveillance-workspace");
  await app.waitUntil(() => app.texts().some((t) => t.includes("WHALE77")));
  await app.press("id:sample-sse-stream-btn");
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("event: graph.snapshot")),
  );

  // 3. Forensics plane + Admin Watchlist bearer token reload
  await app.press("Forensics");
  await app.waitFor("id:forensics-workspace");
  await app.waitUntil(
    () =>
      app.texts().some((t) => t.includes("Captured CP Baseball slice")) &&
      app.texts().some((t) => t.includes("admin bearer token required")),
  );
  await app.type("id:forensics-admin-token-input", "sec-tok-99");
  await app.press("id:forensics-watchlist-reload-btn");
  await app.waitUntil(() => watchlistAuthorized);
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes("Watchlist authorized")),
  );

  // 4. System & Ops plane + 500 Guard + Bun.TOML Parser Workbench
  await app.press("System & Ops");
  await app.waitFor("id:ops-workspace");
  await app.waitUntil(
    () =>
      app.texts().some((t) => t.includes("6 / 6 READY")) &&
      app.texts().some((t) => t.includes("DNS HIT · 94%")),
  );

  await app.press("id:ops-probe-500-btn");
  await app.waitUntil(() =>
    app
      .texts()
      .some((t) => t.includes("Intentional error-boundary verification")),
  );

  await app.press("id:parser-chip-parse-toml");
  await app.press("id:parser-run-btn");
  await app.waitUntil(() =>
    app.texts().some((t) => t.includes('"min_risk_usd": 10000')),
  );
});
