import { describe, expect, test } from "bun:test";
import {
  ageSecondsSince,
  checkFailed,
  classifySource,
  collectDeskHealth,
  formatAge,
  parseArtifactTime,
  type DeskFetch,
  type DeskHealth,
} from "../lib/desk_health.ts";

const NOW = new Date("2026-11-04T20:00:00.000Z");
const NOW_MS = NOW.getTime();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Routes = Readonly<Record<string, () => Response | Promise<Response>>>;

function fakeFetch(routes: Routes): DeskFetch {
  return async (input) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const path = new URL(raw).pathname;
    const handler = routes[path];
    return handler === undefined
      ? json({ error: "not found" }, 404)
      : handler();
  };
}

/** `/health` plus a `/api/status` that names a pid; every test starts from a running daemon. */
function daemon(routes: Routes): Routes {
  return {
    "/health": () =>
      json({
        status: "healthy",
        uptimeSeconds: 1_234,
        runtime: "Bun v1.4.4 (arm64-darwin)",
      }),
    "/api/status": () =>
      json({ ok: true, health: { pid: 4_242, uptimeSeconds: 1_234 } }),
    ...routes,
  };
}

function captureKpis(): unknown {
  return {
    success: true,
    kpis: {
      agents: {
        total: 2_276,
        provenance: {
          source: "data/agent-tree.json",
          basis: "capture",
          asOf: "2026-11-04T19:55:00.000Z",
          stale: false,
          partial: false,
        },
      },
      pending: {
        wagers: 250,
        provenance: {
          source: "capture:/cloud/api/Report/Pending@2026-11-04T19:50:00.009Z",
          basis: "capture",
          asOf: "2026-11-04T19:50:00.009Z",
          stale: false,
          partial: false,
        },
      },
      ticker: {
        wagers: 221,
        provenance: {
          source:
            "capture:/cloud/api/Manager/getBetTicker@2026-11-04T19:50:00.009Z",
          basis: "capture",
          asOf: "2026-11-04T19:50:00.009Z",
          stale: false,
          partial: false,
        },
      },
      customerBook: {
        customers: 220,
        provenance: {
          source: "./enriched_customers_full.json",
          basis: "fixture",
          asOf: "2026-11-03T04:24:17.493Z",
          stale: false,
          partial: false,
        },
      },
    },
    bridge: {
      updatedAt: "2026-11-04T19:59:00.000Z",
      jobs: [
        { id: "bridge3a", label: "Bet ticker poll (3a)", ok: true },
        { id: "bridge3b", label: "Pending liability rollup (3b)", ok: true },
        { id: "bridge3c", label: "GSLive tally rollup (3c)", ok: true },
        { id: "weblog", label: "WebLog overlap bridge", ok: true },
      ],
    },
  };
}

/** Every route declares a capture, so the desk is clean apart from the demo customer book. */
function healthyRoutes(): Routes {
  return daemon({
    "/api/kpis": () => json(captureKpis()),
    "/api/live-wagers": () =>
      json({
        provenance: {
          source:
            "capture:/cloud/api/Manager/getBetTicker@2026-11-04T19:50:00.009Z",
          partial: false,
        },
        freshness: { asOf: "2026-11-04T19:50:00.009Z", stale: false },
      }),
    "/api/game-admin/board": () =>
      json({
        source: "capture:/cloud/api/Manager/gameAdmin@2026-11-04T19:55:00.000Z",
        observedAt: "2026-11-04T19:55:00.000Z",
      }),
    "/api/scoreboard": () =>
      json({
        source:
          "capture:/cloud/api/Report/getScoreboard@2026-11-04T19:55:00.000Z",
        observedAt: "2026-11-04T19:55:00.000Z",
      }),
    "/api/contests": () =>
      json({
        source:
          "capture:/cloud/api/Report/getContests@2026-11-04T19:55:00.000Z",
        extractedAt: "2026-11-04T19:55:00.000Z",
      }),
    "/api/sports/catalog": () =>
      json({
        source:
          "capture:/cloud/api/Report/getSportCatalog@2026-11-04T19:55:00.000Z",
        capturedAt: "2026-11-04T19:55:00.000Z",
      }),
    "/api/analysis/reports": () =>
      json({
        success: true,
        count: 2,
        reports: [
          {
            source:
              "capture:/cloud/api/Manager/getAgentPerformance@2026-11-04T19:55:00.000Z",
            observedAt: "2026-11-04T19:55:00.000Z",
          },
          {
            source:
              "capture:/cloud/api/Manager/getAgentPerformance@2026-11-04T19:55:00.000Z",
            observedAt: "2026-11-04T19:55:00.000Z",
          },
        ],
      }),
  });
}

async function collect(routes: Routes): Promise<DeskHealth> {
  return collectDeskHealth({
    baseUrl: "http://127.0.0.1:4020",
    fetchImpl: fakeFetch(routes),
    now: NOW,
  });
}

function codes(health: DeskHealth): readonly string[] {
  return health.issues.map((issue) => issue.code);
}

describe("desk health: capture-only desk", () => {
  test("reports ok and no next commands except the demo book warning", async () => {
    const health = await collect(healthyRoutes());
    expect(health.service.reachable).toBe(true);
    expect(health.service.pid).toBe(4_242);
    expect(health.service.uptimeSeconds).toBe(1_234);
    expect(health.panels).toHaveLength(11);
    expect(codes(health)).toEqual(["fixture"]);
    const book = health.panels.find((panel) => panel.id === "kpi.customerBook");
    expect(book?.basis).toBe("fixture");
    expect(book?.state).toBe("fixture");
    expect(health.verdict).toBe("warn");
    // A fixture with no live source must not advertise a command that cannot help.
    expect(health.nextCommands).toEqual([]);
    expect(checkFailed(health)).toBe(false);
    expect(checkFailed(health, { strict: true })).toBe(true);
    expect(
      health.panels.every(
        (panel) => panel.ageSeconds === null || panel.ageSeconds >= 0,
      ),
    ).toBe(true);
  });

  test("panel ages come from the payload's own timestamp", async () => {
    const health = await collect(healthyRoutes());
    const pending = health.panels.find((panel) => panel.id === "kpi.pending");
    // 19:50:00.009 -> 20:00:00.000 is 599.991 s, floored to whole seconds.
    expect(pending?.ageSeconds).toBe(599);
    expect(formatAge(pending?.ageSeconds ?? null)).toBe("9m");
  });
});

describe("desk health: paste and fixture provenance", () => {
  function pastedRoutes(): Routes {
    return daemon({
      "/api/kpis": () =>
        json({
          success: true,
          kpis: {
            agents: {
              provenance: {
                source: "data/agent-tree.json",
                basis: "capture",
                asOf: "2026-11-04T19:55:00.000Z",
                stale: false,
              },
            },
            pending: {
              provenance: {
                source:
                  "capture:/cloud/api/Report/Pending@2026-11-01T02:22:35.774Z",
                basis: "capture",
                asOf: "2026-11-01T02:22:35.774Z",
                stale: true,
              },
            },
            ticker: {
              provenance: {
                source: "paste:clipboard-ticker",
                basis: "paste",
                asOf: "2026-11-04T00:17:43.363Z",
                stale: true,
                partial: true,
              },
            },
            customerBook: {
              provenance: {
                source: "./enriched_customers_full.json",
                basis: "fixture",
                asOf: "2026-11-03T04:24:17.493Z",
                stale: false,
              },
            },
          },
          bridge: {
            updatedAt: "2026-11-04T19:59:00.000Z",
            jobs: [
              {
                id: "bridge3a",
                label: "Bet ticker poll (3a)",
                ok: false,
                error: "missing credentials",
              },
              {
                id: "weblog",
                label: "WebLog overlap bridge",
                ok: false,
                error: "exit 1",
              },
            ],
          },
        }),
      "/api/live-wagers": () =>
        json({
          provenance: { source: "paste:clipboard-ticker", partial: true },
          freshness: { asOf: "2026-11-04T00:17:43.363Z", stale: true },
        }),
      "/api/game-admin/board": () =>
        json({
          source: "operator paste of fantasy402 Game Admin (module Admin)",
          observedAt: "2026-11-01",
        }),
      "/api/scoreboard": () =>
        json({
          source: "operator paste of fantasy402 manager.html scoreboard",
          observedAt: "2026-11-01",
        }),
      "/api/contests": () =>
        json({
          source: "markup:stdin",
          extractedAt: "2026-11-01T22:45:07.287Z",
        }),
      "/api/sports/catalog": () =>
        json({
          source: "tests/fixtures/fantasy402-sport-catalog-2026-10-21.json",
          capturedAt: "2026-10-21T16:38:53.513Z",
        }),
      "/api/analysis/reports": () =>
        json({
          success: true,
          count: 1,
          reports: [
            {
              source:
                "operator paste of the portal Analysis report (Customer Performance)",
              observedAt: "2026-11-01",
            },
          ],
        }),
    });
  }

  test("classifies the declared sources and surfaces the paste warnings", async () => {
    const health = await collect(pastedRoutes());
    const byId = new Map(health.panels.map((panel) => [panel.id, panel]));
    expect(byId.get("gameAdminBoard")?.basis).toBe("paste");
    expect(byId.get("scoreboard")?.basis).toBe("paste");
    expect(byId.get("contests")?.basis).toBe("paste");
    expect(byId.get("sportsCatalog")?.basis).toBe("fixture");
    expect(byId.get("analysisReports")?.basis).toBe("paste");
    expect(byId.get("liveWagers")?.stale).toBe(true);
    expect(health.verdict).toBe("fail");
    expect(codes(health)).toContain("stale");
    expect(codes(health)).toContain("paste");
    expect(codes(health)).toContain("fixture");
    expect(codes(health)).toContain("bridge-job-failed");
    expect(byId.get("bridge")?.state).toBe("warn");
  });

  test("next commands point at the capture that would replace the paste", async () => {
    const health = await collect(pastedRoutes());
    expect(health.nextCommands).toContain(
      "bun run capture:dom --input scratch/pastes --only game-admin-board",
    );
    expect(health.nextCommands).toContain(
      "bun run capture:dom --input scratch/pastes --only scoreboard",
    );
    expect(health.nextCommands).toContain(
      "bun run capture:dom --input scratch/pastes --only contests",
    );
    expect(health.nextCommands).toContain("bun run capture:bet-ticker");
    expect(health.nextCommands).toContain("bun run capture:pending");
    // The demo book has no live source, so it must not claim a command.
    expect(health.nextCommands).not.toContain("bun run customers:profiles");
    // A failing bridge job promises no command: its error text names its own fix.
    expect(health.nextCommands).not.toContain("bun run weblog:rollup");
  });

  test("a stale capture is an error, so --check fails without --strict", async () => {
    const health = await collect(pastedRoutes());
    expect(checkFailed(health)).toBe(true);
    expect(checkFailed(health, { strict: true })).toBe(true);
  });
});

describe("desk health: unreadable and inconsistent panels", () => {
  test("an unreachable daemon is a service issue, not eleven panel errors", async () => {
    const health = await collectDeskHealth({
      baseUrl: "http://127.0.0.1:4020",
      now: NOW,
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });
    expect(health.service.reachable).toBe(false);
    expect(health.panels).toEqual([]);
    expect(health.verdict).toBe("fail");
    expect(health.issues[0]?.code).toBe("service-unreachable");
    expect(health.nextCommands).toEqual(["bun run serve"]);
  });

  test("a locked route is a warning, not a failure", async () => {
    const routes = healthyRoutes();
    const health = await collect({
      ...routes,
      "/api/live-wagers": () =>
        json(
          { success: false, error: "SPORTSDESK_ADMIN_TOKEN is not set" },
          503,
        ),
    });
    const panel = health.panels.find((entry) => entry.id === "liveWagers");
    expect(panel?.httpStatus).toBe(503);
    expect(panel?.state).toBe("locked");
    expect(panel?.issues[0]?.code).toBe("panel-locked");
    expect(checkFailed(health)).toBe(false);
  });

  test("a count that disagrees with reports[] is an error", async () => {
    const routes = healthyRoutes();
    const health = await collect({
      ...routes,
      "/api/analysis/reports": () =>
        json({
          success: true,
          count: 1,
          reports: [
            {
              source:
                "capture:/cloud/api/Manager/getAgentPerformance@2026-11-04T19:55:00.000Z",
              observedAt: "2026-11-04T19:55:00.000Z",
            },
            {
              source:
                "capture:/cloud/api/Manager/getAgentPerformance@2026-11-04T19:55:00.000Z",
              observedAt: "2026-11-04T19:55:00.000Z",
            },
          ],
        }),
    });
    const mismatch = health.issues.find(
      (issue) => issue.code === "count-mismatch",
    );
    expect(mismatch?.severity).toBe("error");
    expect(mismatch?.message).toContain("reports[] has 2");
    expect(checkFailed(health)).toBe(true);
  });

  test("an empty analysis artifact reports a missing source", async () => {
    const routes = healthyRoutes();
    const health = await collect({
      ...routes,
      "/api/analysis/reports": () =>
        json({ success: true, count: 0, reports: [] }),
    });
    const panel = health.panels.find((entry) => entry.id === "analysisReports");
    expect(panel?.issues.some((issue) => issue.code === "missing-source")).toBe(
      true,
    );
    expect(panel?.state).toBe("error");
  });

  test("an unreadable timestamp is an error, not a fresh panel", async () => {
    const routes = healthyRoutes();
    const health = await collect({
      ...routes,
      "/api/scoreboard": () =>
        json({ source: "capture:/x", observedAt: "not-a-date" }),
    });
    const panel = health.panels.find((entry) => entry.id === "scoreboard");
    expect(panel?.ageSeconds).toBeNull();
    expect(
      panel?.issues.some((issue) => issue.code === "invalid-timestamp"),
    ).toBe(true);
    expect(checkFailed(health)).toBe(true);
  });

  test("--max-age supplies a budget only when asked", async () => {
    const routes = healthyRoutes();
    const health = await collectDeskHealth({
      baseUrl: "http://127.0.0.1:4020",
      fetchImpl: fakeFetch(routes),
      now: NOW,
      maxAgeSeconds: 60,
    });
    const panel = health.panels.find((entry) => entry.id === "kpi.pending");
    expect(panel?.stale).toBe(true);
    expect(panel?.issues.some((issue) => issue.code === "stale")).toBe(true);
    expect(checkFailed(health)).toBe(true);
  });
});

describe("desk health: pure helpers", () => {
  test("classifySource recognises the source vocabulary in use", () => {
    expect(
      classifySource(
        "capture:/cloud/api/Report/Pending@2026-11-01T02:22:35.774Z",
      ),
    ).toBe("capture");
    expect(classifySource("paste:clipboard-ticker")).toBe("paste");
    expect(classifySource("markup:stdin")).toBe("paste");
    expect(
      classifySource("operator paste of fantasy402 Game Admin (module Admin)"),
    ).toBe("paste");
    expect(
      classifySource("operator paste of fantasy402 manager.html scoreboard"),
    ).toBe("paste");
    expect(
      classifySource("tests/fixtures/fantasy402-sport-catalog-2026-10-21.json"),
    ).toBe("fixture");
    expect(classifySource("./enriched_customers_full.json")).toBe("fixture");
    expect(classifySource("something-else")).toBe("unclassified");
  });

  test("date-only artifact times are UTC midnight, and future times are rejected", () => {
    expect(parseArtifactTime("2026-11-01", NOW_MS)).toBe(
      Date.parse("2026-11-01T00:00:00.000Z"),
    );
    expect(parseArtifactTime("2026-11-04T19:50:00.009Z", NOW_MS)).toBe(
      Date.parse("2026-11-04T19:50:00.009Z"),
    );
    expect(parseArtifactTime("not-a-date", NOW_MS)).toBeNull();
    expect(parseArtifactTime("2026-11-05T00:00:00.000Z", NOW_MS)).toBeNull();
    expect(parseArtifactTime(null, NOW_MS)).toBeNull();
  });

  test("age formatting buckets", () => {
    expect(formatAge(null)).toBe("—");
    expect(formatAge(42)).toBe("42s");
    expect(formatAge(600)).toBe("10m");
    expect(formatAge(11_520)).toBe("3.2h");
    expect(formatAge(181_440)).toBe("2.1d");
    expect(ageSecondsSince(NOW_MS - 1_000, NOW_MS)).toBe(1);
    expect(ageSecondsSince(NOW_MS + 1_000, NOW_MS)).toBe(0);
  });
});
