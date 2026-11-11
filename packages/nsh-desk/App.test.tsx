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
