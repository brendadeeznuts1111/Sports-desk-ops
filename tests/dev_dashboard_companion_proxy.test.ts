/**
 * @file tests/dev_dashboard_companion_proxy.test.ts
 * @description Regression suite for companion :4020 proxying, SSE stream lifetime, header &
 * status pass-through, `/api/agents/search` collision avoidance, report pages, React deep links,
 * and offline local fallbacks in `scripts/dev_dashboard.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { Server } from "bun";
import {
  type DashboardServerHandle,
  startDashboardServer,
} from "../scripts/dev_dashboard.ts";

let companionServer: Server<undefined>;
let companionRequests: {
  method: string;
  path: string;
  search: string;
  auth: string | null;
  token: string | null;
  body: string;
}[] = [];

let onlineHandle: DashboardServerHandle;
let offlineHandle: DashboardServerHandle;

function reserveClosedPort(): number {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 204 }),
  });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) {
    throw new Error("Could not reserve ephemeral port");
  }
  return port;
}

beforeAll(() => {
  companionServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body =
        req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      companionRequests.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        auth: req.headers.get("authorization"),
        token: req.headers.get("x-sportsdesk-token"),
        body,
      });

      if (url.pathname === "/api/agents/search") {
        return Response.json({
          success: true,
          query: (url.searchParams.get("q") ?? "").toUpperCase(),
          count: 1,
          agents: [{ key: "BILLYL", level: 5, agentType: "A" }],
        });
      }
      if (url.pathname === "/api/execution/mode" && req.method === "POST") {
        return Response.json({
          success: true,
          upstream: "companion-4020",
          receivedBody: body ? JSON.parse(body) : null,
          receivedAuth: req.headers.get("authorization"),
          receivedToken: req.headers.get("x-sportsdesk-token"),
        });
      }
      if (url.pathname === "/api/graph/stream") {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let closed = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode('event: summary\ndata: {"chunk":1}\n\n'),
            );
            timer = setTimeout(() => {
              if (!closed) {
                controller.enqueue(
                  encoder.encode('event: ping\ndata: {"chunk":2}\n\n'),
                );
                controller.close();
              }
            }, 1_800);
          },
          cancel() {
            closed = true;
            if (timer !== undefined) clearTimeout(timer);
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      }
      if (url.pathname === "/api/analysis") {
        return Response.json(
          {
            success: false,
            available: false,
            error: "no transcribed analysis report matches this selection",
          },
          { status: 501 },
        );
      }
      if (url.pathname === "/api/xml-odds/soa") {
        return Response.json(
          {
            success: false,
            status: "unavailable",
            error: "R2 manifest manifests/xml-ingest/latest unavailable",
          },
          { status: 502 },
        );
      }
      if (url.pathname === "/api/telegram/status") {
        return Response.json(
          {
            success: false,
            error: "SPORTSDESK_ADMIN_TOKEN is not set on the server",
          },
          { status: 503 },
        );
      }
      if (url.pathname === "/api/f402/get-pending") {
        return Response.json(
          { success: false, error: "removed: use /api/live-bets" },
          { status: 410 },
        );
      }
      if (url.pathname === "/api/v1/live-bets") {
        return Response.json(
          { success: true, games: [], deprecated: true },
          {
            headers: {
              Deprecation: "true",
              Sunset: "Wed, 31 Dec 2026 23:59:59 GMT",
            },
          },
        );
      }
      if (url.pathname === "/api/live-wagers") {
        return Response.json({
          success: true,
          servedFrom: "companion-live",
          sourceParam: url.searchParams.get("source"),
          wagers: [],
        });
      }
      if (url.pathname === "/api/gslive/verify-tickets") {
        return Response.json({ upstreamUnexpected: true });
      }
      if (url.pathname === "/agent-graph.webp") {
        return new Response(new Uint8Array([82, 73, 70, 70]), {
          status: 200,
          headers: { "Content-Type": "image/webp" },
        });
      }
      if (url.pathname === "/tracker" || url.pathname === "/governance") {
        return new Response(
          `<html><body>companion:${url.pathname}</body></html>`,
          {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          },
        );
      }
      if (url.pathname === "/health") {
        return Response.json({
          status: "degraded",
          operationalStatus: "degraded",
          dataStatus: "stale",
          runtime: "Bun v1.4.4 (arm64-darwin)",
          uptimeSeconds: 1234,
          nodeEnv: "development",
          version: {
            gitSha: "deadbeef",
            buildTime: "2026-11-20T00:00:00.000Z",
            nodeEnv: "development",
          },
          ingress: { proxied: false, trustProxy: false },
          checks: {
            daemon: "ok",
            auth: {
              f402: {
                status: "ok",
                source: "session-file",
                expiresInSeconds: 500,
                mintCapable: true,
              },
              gslive: {
                status: "expired",
                source: "keychain",
                probeStatus: 401,
              },
            },
            pipelines: {
              r2Fresh: 3,
              r2Total: 4,
              r2StaleKeys: ["gslive-tally"],
              dataStaleKeys: ["wagers-by-state", "gslive-tally"],
              checks: { ticker: "ok", gslive: "stale-publish-and-data" },
            },
          },
          degradedReasons: [
            {
              message: "GSLive session expired (Cloudflare blocks auto-mint)",
              kind: "auth",
              severity: "warn",
              action: "printf '%s' '<GSID>' | bun run secrets:gslive set",
            },
          ],
        });
      }
      if (
        url.pathname === "/governance.json" ||
        url.pathname === "/status.json" ||
        url.pathname === "/live-bets/summary" ||
        url.pathname === "/api/graph/summary" ||
        url.pathname === "/api/analysis/filters" ||
        url.pathname === "/api/analysis/reports" ||
        url.pathname === "/api/scoreboard" ||
        url.pathname === "/api/sports" ||
        url.pathname === "/api/sports/catalog" ||
        url.pathname === "/api/game-admin" ||
        url.pathname === "/api/game-admin/board" ||
        url.pathname === "/api/contests" ||
        url.pathname === "/api/bridge3c/status" ||
        url.pathname === "/api/watchlist" ||
        url.pathname === "/api/parse-toml"
      ) {
        return Response.json({
          ok: true,
          path: url.pathname,
          method: req.method,
        });
      }
      return Response.json({ error: "Not Found" }, { status: 404 });
    },
  });

  onlineHandle = startDashboardServer({
    port: 0,
    hostname: "127.0.0.1",
    watchFiles: false,
    development: false,
    forceShadowFixture: true,
    companionOrigin: `http://127.0.0.1:${companionServer.port}`,
  });

  const offlinePort = reserveClosedPort();
  offlineHandle = startDashboardServer({
    port: 0,
    hostname: "127.0.0.1",
    watchFiles: false,
    development: false,
    forceShadowFixture: true,
    companionOrigin: `http://127.0.0.1:${offlinePort}`,
  });
});

afterAll(() => {
  onlineHandle?.stop(true);
  offlineHandle?.stop(true);
  companionServer?.stop(true);
});

describe("dev_dashboard companion proxy, routing, and report surfaces", () => {
  test("routes /api/agents/search to companion and falls back to local agent-tree when offline while keeping /api/agents/:id", async () => {
    const searchRes = await fetch(
      new URL("/api/agents/search?q=BILLY", onlineHandle.url),
    );
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as {
      readonly success?: boolean;
      readonly query?: string;
      readonly agents?: readonly { readonly key: string }[];
    };
    expect(searchBody.success).toBe(true);
    expect(searchBody.query).toBe("BILLY");
    expect(searchBody.agents?.[0]?.key).toBe("BILLYL");

    const pluralAgentRes = await fetch(
      new URL("/api/agents/FAKEMONEY", onlineHandle.url),
    );
    expect(pluralAgentRes.status).toBe(200);
    const pluralAgentBody = (await pluralAgentRes.json()) as {
      readonly agentId: string;
    };
    expect(pluralAgentBody.agentId).toBe("FAKEMONEY");

    const shortOffline = await fetch(
      new URL("/api/agents/search?q=B", offlineHandle.url),
    );
    expect(shortOffline.status).toBe(400);

    const offlineSearch = await fetch(
      new URL("/api/agents/search?q=BILLY", offlineHandle.url),
    );
    expect(offlineSearch.status).toBe(200);
    const offlineBody = (await offlineSearch.json()) as {
      readonly success: boolean;
      readonly count: number;
      readonly agents: readonly { readonly key: string }[];
    };
    expect(offlineBody.success).toBe(true);
    expect(offlineBody.count).toBeGreaterThan(0);
    expect(offlineBody.agents.some((a) => a.key.includes("BILLY"))).toBe(true);
  }, 15_000);

  test("forwards POST method, body, and auth headers cleanly to companion", async () => {
    const res = await fetch(new URL("/api/execution/mode", onlineHandle.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-tok",
        "x-sportsdesk-token": "admin-tok",
      },
      body: JSON.stringify({ mode: "paper" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      readonly upstream: string;
      readonly receivedBody: { readonly mode: string };
      readonly receivedAuth: string;
      readonly receivedToken: string;
    };
    expect(json.upstream).toBe("companion-4020");
    expect(json.receivedBody).toEqual({ mode: "paper" });
    expect(json.receivedAuth).toBe("Bearer secret-tok");
    expect(json.receivedToken).toBe("admin-tok");
  });

  test("keeps /api/graph/stream SSE connection open beyond 1.5s without timing out", async () => {
    const res = await fetch(new URL("/api/graph/stream", onlineHandle.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let collected = "";
    const startedAt = Date.now();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      collected += decoder.decode(value, { stream: true });
    }
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(1_700);
    expect(collected).toContain('"chunk":1');
    expect(collected).toContain('"chunk":2');
  }, 15_000);

  test("preserves truthful companion 501/502/503/410 statuses and deprecation headers", async () => {
    const res501 = await fetch(new URL("/api/analysis", onlineHandle.url));
    expect(res501.status).toBe(501);
    const body501 = (await res501.json()) as { readonly available?: boolean };
    expect(body501.available).toBe(false);

    const res502 = await fetch(new URL("/api/xml-odds/soa", onlineHandle.url));
    expect(res502.status).toBe(502);

    const res503 = await fetch(
      new URL("/api/telegram/status", onlineHandle.url),
    );
    expect(res503.status).toBe(503);
    const body503 = (await res503.json()) as { readonly error?: string };
    expect(body503.error).toContain("SPORTSDESK_ADMIN_TOKEN");

    const res410 = await fetch(
      new URL("/api/f402/get-pending", onlineHandle.url),
    );
    expect(res410.status).toBe(410);

    const resV1 = await fetch(new URL("/api/v1/live-bets", onlineHandle.url));
    expect(resV1.status).toBe(200);
    expect(resV1.headers.get("deprecation")).toBe("true");
    expect(resV1.headers.get("sunset")).toContain("2026");
  });

  test("wires companion report pages, data APIs, live-wagers ?source=auto, local verify-tickets, and React deep links", async () => {
    const jsonEndpoints = [
      "/governance.json",
      "/status.json",
      "/live-bets/summary",
      "/api/graph/summary",
      "/api/analysis/filters",
      "/api/analysis/reports",
      "/api/scoreboard",
      "/api/sports",
      "/api/sports/catalog",
      "/api/game-admin",
      "/api/game-admin/board",
      "/api/contests",
      "/api/bridge3c/status",
      "/api/watchlist",
    ];
    for (const path of jsonEndpoints) {
      const res = await fetch(new URL(path, onlineHandle.url));
      expect(res.status, path).toBe(200);
      const data = (await res.json()) as { readonly path?: string };
      expect(data.path, path).toBe(path);
    }

    const parseRes = await fetch(new URL("/api/parse-toml", onlineHandle.url), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: 'title = "ok"\n',
    });
    expect(parseRes.status).toBe(200);
    const parseBody = (await parseRes.json()) as { readonly method: string };
    expect(parseBody.method).toBe("POST");

    for (const page of ["/tracker", "/governance"]) {
      const res = await fetch(new URL(page, onlineHandle.url));
      expect(res.status, page).toBe(200);
      expect(await res.text()).toContain(`companion:${page}`);
    }

    const webpRes = await fetch(new URL("/agent-graph.webp", onlineHandle.url));
    expect(webpRes.status).toBe(200);
    expect(webpRes.headers.get("content-type")).toBe("image/webp");

    // `?source=auto` proxies to companion while bare `/api/live-wagers` stays local.
    const liveWagersSource = await fetch(
      new URL("/api/live-wagers?source=auto", onlineHandle.url),
    );
    expect(liveWagersSource.status).toBe(200);
    const liveWagersJson = (await liveWagersSource.json()) as {
      readonly servedFrom?: string;
    };
    expect(liveWagersJson.servedFrom).toBe("companion-live");

    const bareWagers = await fetch(
      new URL("/api/live-wagers", onlineHandle.url),
    );
    expect(bareWagers.status).toBe(200);
    const bareJson = (await bareWagers.json()) as {
      readonly servedFrom?: string;
      readonly wagers?: unknown;
    };
    expect(bareJson.servedFrom).toBeUndefined();
    expect(Array.isArray(bareJson.wagers)).toBe(true);

    // Local POST /api/gslive/verify-tickets must not be shadowed by `/api/gslive/*`.
    const verifyRes = await fetch(
      new URL("/api/gslive/verify-tickets", onlineHandle.url),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      },
    );
    expect(verifyRes.status).toBe(200);
    const verifyJson = (await verifyRes.json()) as {
      readonly ok?: boolean;
      readonly upstreamUnexpected?: boolean;
    };
    expect(verifyJson.ok).toBe(true);
    expect(verifyJson.upstreamUnexpected).toBeUndefined();

    // React deep links serve HTML 200 while `/live-bets` serves static/live-bets.html.
    for (const tabPath of ["/wagers", "/app/live-bets", "/rankings"]) {
      const res = await fetch(new URL(tabPath, onlineHandle.url));
      expect(res.status, tabPath).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
    const standaloneLiveBets = await fetch(
      new URL("/live-bets", onlineHandle.url),
    );
    expect(standaloneLiveBets.status).toBe(200);
    expect(await standaloneLiveBets.text()).toContain("Live");
  });

  test("honestly reports 503 when companion is offline and serves local fallbacks where available", async () => {
    const offlineSummary = await fetch(
      new URL("/api/graph/summary", offlineHandle.url),
    );
    expect(offlineSummary.status).toBe(503);
    const summaryBody = (await offlineSummary.json()) as {
      readonly daemon4020Online: boolean;
    };
    expect(summaryBody.daemon4020Online).toBe(false);

    const offlinePost = await fetch(
      new URL("/api/execution/mode", offlineHandle.url),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "paper" }),
      },
    );
    expect(offlinePost.status).toBe(503);

    for (const fallbackPath of [
      "/api/scoreboard",
      "/api/contests",
      "/api/game-admin/board",
      "/api/live-bets/summary",
      "/live-bets/summary",
    ]) {
      const res = await fetch(new URL(fallbackPath, offlineHandle.url));
      expect(res.status, fallbackPath).toBe(200);
    }

    const expectedLiveBetsStatus = existsSync("data/live-bets.json")
      ? 200
      : 404;
    for (const liveBetsPath of ["/api/live-bets", "/api/v1/live-bets"]) {
      const res = await fetch(new URL(liveBetsPath, offlineHandle.url));
      expect(res.status, liveBetsPath).toBe(expectedLiveBetsStatus);
    }
  });

  test("serves local static/status.html for /status and /status/ while keeping /status.json proxied", async () => {
    for (const handle of [onlineHandle, offlineHandle]) {
      for (const path of ["/status", "/status/"]) {
        const res = await fetch(new URL(path, handle.url));
        expect(res.status, path).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        const html = await res.text();
        expect(html).toContain("SportsDesk Status");
        expect(html).toContain('id="schedule-search"');
        expect(html).toContain('id="alert-banner"');
      }
    }

    const onlineStatusJson = await fetch(
      new URL("/status.json", onlineHandle.url),
    );
    expect(onlineStatusJson.status).toBe(200);
    const onlineBody = (await onlineStatusJson.json()) as {
      readonly path?: string;
    };
    expect(onlineBody.path).toBe("/status.json");
  });

  test("enriches /health with schemaVersion 1, real dependency/runtime metrics, legacy fields, and companion daemon4020", async () => {
    const onlineRes = await fetch(new URL("/health", onlineHandle.url));
    expect(onlineRes.status).toBe(200);
    const onlineHealth = (await onlineRes.json()) as Record<string, unknown>;
    expect(onlineHealth.schemaVersion).toBe(1);
    expect(onlineHealth.status).toBe("degraded");
    expect(onlineHealth.service).toBe("sportsdesk-dev-dashboard");
    expect(typeof onlineHealth.port).toBe("number");
    expect(typeof onlineHealth.bunVersion).toBe("string");
    expect(typeof onlineHealth.uptimeSeconds).toBe("number");
    expect(onlineHealth.db).toBe("unconfigured");
    expect(typeof onlineHealth.purgedSessions).toBe("number");
    expect(typeof onlineHealth.timestamp).toBe("string");
    expect(typeof onlineHealth.pendingRequests).toBe("number");
    expect(typeof onlineHealth.pendingWebSockets).toBe("number");

    const build = onlineHealth.build as {
      readonly bunVersion: string;
      readonly expectedBunVersion: string;
      readonly bunVersionDrift: boolean;
    };
    expect(build.bunVersion).toBe(Bun.version);
    expect(build.expectedBunVersion).toBe("1.4.4");
    expect(build.bunVersionDrift).toBe(Bun.version !== "1.4.4");

    const runtime = onlineHealth.runtime as {
      readonly uptimeSeconds: number;
      readonly rssBytes: number;
      readonly heapUsedBytes: number;
    };
    expect(runtime.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(runtime.rssBytes).toBeGreaterThan(0);
    expect(runtime.heapUsedBytes).toBeGreaterThan(0);

    const server = onlineHealth.server as {
      readonly port: number;
      readonly pendingRequests: number;
      readonly pendingWebSockets: number;
      readonly wsBackpressureBytes: number;
    };
    expect(server.port).toBe(onlineHealth.port as number);
    expect(server.pendingRequests).toBe(onlineHealth.pendingRequests as number);
    expect(server.pendingWebSockets).toBe(
      onlineHealth.pendingWebSockets as number,
    );
    expect(server.wsBackpressureBytes).toBeGreaterThanOrEqual(0);

    const deps = onlineHealth.dependencies as {
      readonly db: { readonly status: string };
      readonly r2: {
        readonly status: string;
        readonly lastSnapshotAgeMs: number | null;
      };
    };
    expect(deps.db.status).toBe("unconfigured");
    expect(deps.r2.status).toBe("degraded");

    const sessions = onlineHealth.sessions as {
      readonly active: number;
      readonly purged: number;
    };
    expect(sessions.active).toBe(0);
    expect(sessions.purged).toBe(onlineHealth.purgedSessions as number);

    const alerts = onlineHealth.alerts as {
      readonly status: string;
      readonly oldestQueuedAgeMs: number;
      readonly lastDeliveryAt: string | null;
    };
    expect(["ok", "degraded", "down"]).toContain(alerts.status);
    expect(typeof alerts.oldestQueuedAgeMs).toBe("number");
    expect(
      alerts.lastDeliveryAt === null ||
        typeof alerts.lastDeliveryAt === "string",
    ).toBe(true);

    const onlineDaemon = onlineHealth.daemon4020 as {
      readonly online: boolean;
      readonly operationalStatus: string;
      readonly dataStatus: string;
      readonly version?: { readonly gitSha?: string };
      readonly checks?: {
        readonly auth?: { readonly f402?: unknown; readonly gslive?: unknown };
        readonly pipelines?: { readonly r2Fresh?: number };
      };
      readonly degradedReasons: readonly { readonly message: string }[];
    };
    expect(onlineDaemon.online).toBe(true);
    expect(onlineDaemon.operationalStatus).toBe("degraded");
    expect(onlineDaemon.dataStatus).toBe("stale");
    expect(onlineDaemon.version?.gitSha).toBe("deadbeef");
    expect(onlineDaemon.checks?.auth?.f402).toBeDefined();
    expect(onlineDaemon.checks?.auth?.gslive).toBeDefined();
    expect(onlineDaemon.checks?.pipelines?.r2Fresh).toBe(3);
    expect(onlineDaemon.degradedReasons[0]?.message).toContain(
      "GSLive session expired",
    );

    const offlineRes = await fetch(new URL("/health", offlineHandle.url));
    expect(offlineRes.status).toBe(200);
    const offlineHealth = (await offlineRes.json()) as Record<string, unknown>;
    expect(offlineHealth.schemaVersion).toBe(1);
    expect(offlineHealth.status).toBe("degraded");
    expect(offlineHealth.service).toBe("sportsdesk-dev-dashboard");
    const offlineDaemon = offlineHealth.daemon4020 as {
      readonly online: boolean;
      readonly status: string;
      readonly operationalStatus: string;
      readonly error: string | null;
      readonly degradedReasons: readonly unknown[];
    };
    expect(offlineDaemon.online).toBe(false);
    expect(offlineDaemon.status).toBe("offline");
    expect(offlineDaemon.operationalStatus).toBe("down");
    expect(typeof offlineDaemon.error).toBe("string");
    expect((offlineDaemon.error ?? "").length).toBeGreaterThan(0);
    expect(offlineDaemon.degradedReasons).toEqual([]);
  });
});
