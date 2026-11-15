import { describe, expect, test } from "bun:test";
import {
  createDashboardApi,
  type DashboardApiDeps,
  type WsLike,
} from "@sportsdesk-ops/api";
import { parseDashboardWsSignal } from "@sportsdesk-ops/contracts";
import { WAGERS_TABLE } from "../packages/ui/src/config/wagers.ts";
import { startDashboardServer } from "../scripts/dev_dashboard.ts";

function buildMockDeps(
  overrides: Partial<DashboardApiDeps> = {},
): DashboardApiDeps {
  return {
    auth: {
      login: async () => Response.json({ ok: true, token: "mock-csrf" }),
      logout: async () => Response.json({ ok: true }),
      me: async () => Response.json({ authenticated: true, user: "operator" }),
    },
    getHealthPayload: () => ({
      status: "ok",
      service: "sportsdesk-dev-dashboard",
      port: 0,
    }),
    loadDashboardMarkdown: async () => ({
      stamp: "100:20",
      markdown: "# Desk",
      html: "<h1>Desk</h1>",
    }),
    dns: {
      getTelemetryPayload: () => ({
        success: true,
        telemetry: { size: 4, hitRatePercent: 95 },
      }),
      benchmark: async (host) => ({
        host,
        fastestBackend: "c-ares",
        speedupFactor: 2.1,
      }),
      classifyIp: async (ip) => ({
        ip,
        organization: "Cloudflare",
        isDatacenterOrCloud: true,
      }),
    },
    customers: {
      getCohortReport: async () => ({
        versionStamp: "v1",
        payload: {
          cohorts: { backtestCount: 2 },
          backtestTop: [],
          fixtures: [],
        },
      }),
      getProfile: async (id) =>
        id.toUpperCase() === "GP301"
          ? { customerId: "GP301", score: 9.8 }
          : null,
      getRating: async (id) =>
        id.toUpperCase() === "GP301"
          ? { customerId: "GP301", tier: "TIER_1" }
          : null,
    },
    execTerminal: async (command, dims) => ({
      command,
      stdout: `ran:${command}`,
      exitCode: 0,
      cols: dims.cols,
    }),
    rankings: {
      getAll: async (limit) => ({
        generatedAtIso: "2026-11-12T00:00:00.000Z",
        payload: { limit, players: [{ id: "GP301" }] },
      }),
      getConduits: async () => [{ agentId: "FAKEMONEY", isProxyConduit: true }],
    },
    getLiveWagersPayload: async () => ({
      wagers: [{ ticketId: "W-1", autoExecute: false }],
      autoExecute: false,
    }),
    getBetTickerPayload: async (filters) => ({
      schemaVersion: 1,
      observedAt: "2026-11-12T00:00:00.000Z",
      autoExecute: false,
      provenance: {
        kind: "fixture",
        label: "mock",
        sourcePath: null,
        observedAt: "2026-11-12T00:00:00.000Z",
      },
      localFeed: {
        rawRowCount: 1,
        actionableTicketCount: 1,
        sentinelNoiseCount: 0,
        totalWageredCents: 10000,
        totalVolumeCents: 10000,
        totalToWinCents: 9091,
        volumeDiffersCount: 0,
        vipCount: 0,
        liveCount: 0,
        flagCount: 0,
        byRule: {},
        byWriter: [
          {
            writer: filters?.writer ?? "Internet",
            count: 1,
            wageredCents: 10000,
            volumeCents: 10000,
            toWinCents: 9091,
            isSentinelNoise: false,
          },
        ],
        byWagerType: [],
        tickets: [],
      },
      bridge3aR2: {
        available: false,
        publicUrl: "",
        state: "error",
        lastModified: null,
        ageSeconds: null,
        generatedAt: null,
        deskDate: null,
        deskHour: null,
        watermark: null,
        rowCount: 0,
        ticketCount: 0,
        legCount: 0,
        alertTwinCount: 0,
        orphanCount: 0,
        byChannel: {},
        byWagerType: {},
      },
      pendingGames: {
        available: false,
        gameCount: 0,
        pendingCount: 0,
        totalWageredCents: 0,
        totalToWinCents: 0,
        capturedAt: null,
        dataSource: null,
        sourcePath: null,
      },
      captureHealth: {
        available: false,
        status: null,
        capturedAt: null,
        ageSeconds: null,
        rowCount: null,
        sourcePath: null,
      },
    }),
    getR2PipelinePayload: async (opts) => ({
      schemaVersion: 1,
      bucketPublicBase: "https://pub-mock.r2.dev",
      observedAt: "2026-11-12T00:00:00.000Z",
      overallStatus: opts?.refresh ? "fresh" : "stale",
      freshCount: 4,
      totalCount: 4,
      staleKeys: [],
      dataStaleKeys: [],
      sinks: [],
      daemon4020: {
        online: true,
        url: "http://127.0.0.1:4020/health",
        status: 200,
        latencyMs: 2,
        checkedAt: "2026-11-12T00:00:00.000Z",
      },
    }),
    getDaemonStatusPayload: async () => ({
      online: true,
      url: "http://127.0.0.1:4020/health",
      status: 200,
      latencyMs: 2,
      checkedAt: "2026-11-12T00:00:00.000Z",
    }),
    getAgentDetailPayload: async (agentId) => ({
      schemaVersion: 1,
      agentId: agentId.trim().toUpperCase(),
      found: agentId.trim().toUpperCase() === "FAKEMONEY",
      masterAgent: "NOLAWOLF",
      level: 3,
      agentType: "Agent",
      childAgents: [],
      conduit30d: null,
      customers: [],
      recentWagers: [],
      observedAt: "2026-11-12T00:00:00.000Z",
      autoExecute: false,
    }),
    getTiersConfig: async () => ({ tiers: { CRITICAL: { fg: "#fff" } } }),
    alerts: {
      sweepOnce: async () => ({ sent: 1, failed: 0, dead: 0 }),
      list: (status) => [{ deliveryId: "del-123", status }],
      ack: async ({ deliveryId }) => deliveryId === "del-123",
      retry: async ({ deliveryId }) =>
        deliveryId === "del-123" ? "del-retry-456" : null,
      getShiftSummary: (operatorId) => ({ operatorId, totalAlerts: 3 }),
    },
    getTaxonomyCatalog: () => [{ code: "NFL" }],
    runShadowPricing: async (params) => ({
      provenance: params.forceFixture ? "fixture" : "live_db",
      parameters: params,
    }),
    getBuildMatrix: async () => [{ target: "prod", features: ["PROD"] }],
    ...overrides,
  };
}

describe("@sportsdesk-ops/api in-memory router (zero port bind)", () => {
  test("dispatches all HTTP endpoints in-memory including :id params and 404 fallback", async () => {
    const api = createDashboardApi(buildMockDeps());
    const call = (path: string, init?: RequestInit) =>
      api.fetch(new Request(`http://dashboard.local${path}`, init));

    expect((await call("/health")).status).toBe(200);
    expect(
      ((await (await call("/health")).json()) as { status: string }).status,
    ).toBe("ok");

    expect((await call("/api/auth/login", { method: "POST" })).status).toBe(
      200,
    );
    expect((await call("/api/auth/logout", { method: "POST" })).status).toBe(
      200,
    );
    expect((await call("/api/auth/me")).status).toBe(200);
    expect((await call("/api/auth/me", { method: "POST" })).status).toBe(405);

    const dashRes = await call("/api/dashboard");
    expect(dashRes.status).toBe(200);
    expect(((await dashRes.json()) as { html: string }).html).toContain(
      "<h1>Desk</h1>",
    );

    expect((await call("/api/dns")).status).toBe(200);
    expect((await call("/api/dns/telemetry")).status).toBe(200);
    const benchJson = (await (
      await call("/api/dns/benchmark?host=example.com")
    ).json()) as { host: string };
    expect(benchJson.host).toBe("example.com");
    const revJson = (await (
      await call("/api/dns/reverse?ip=8.8.8.8")
    ).json()) as { ip: string };
    expect(revJson.ip).toBe("8.8.8.8");

    expect((await call("/api/customers")).status).toBe(200);
    expect((await call("/api/customer/profile")).status).toBe(400);
    expect((await call("/api/customer/profile?id=MISSING")).status).toBe(404);
    expect((await call("/api/customer/profile?id=gp301")).status).toBe(200);
    expect((await call("/api/customer/rating")).status).toBe(400);
    expect((await call("/api/customer/rating?id=MISSING")).status).toBe(404);
    expect((await call("/api/customer/rating?id=GP301")).status).toBe(200);

    const termRes = await call("/api/terminal/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "p GP301", cols: 120 }),
    });
    expect(termRes.status).toBe(200);
    expect(((await termRes.json()) as { stdout: string }).stdout).toBe(
      "ran:p GP301",
    );

    expect((await call("/api/rankings/all?limit=25")).status).toBe(200);
    expect((await call("/api/agency/conduits")).status).toBe(200);
    expect((await call("/api/wagers")).status).toBe(200);
    expect((await call("/api/live-wagers")).status).toBe(200);
    expect((await call("/api/config/tiers")).status).toBe(200);

    expect((await call("/api/alerts/sweep", { method: "POST" })).status).toBe(
      200,
    );
    expect((await call("/api/alerts?status=dead")).status).toBe(200);

    const ackJson = (await (
      await call("/api/alerts/del-123/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operatorId: "op1", notes: "checked" }),
      })
    ).json()) as { ok: boolean; deliveryId: string };
    expect(ackJson).toEqual({ ok: true, deliveryId: "del-123" });

    const retryOk = await call("/api/alerts/del-123/retry", { method: "POST" });
    expect(retryOk.status).toBe(200);
    expect(
      ((await retryOk.json()) as { newDeliveryId: string }).newDeliveryId,
    ).toBe("del-retry-456");
    expect(
      (await call("/api/alerts/unknown/retry", { method: "POST" })).status,
    ).toBe(404);

    expect((await call("/api/shift/summary?operatorId=op1")).status).toBe(200);
    expect((await call("/api/taxonomy-catalog")).status).toBe(200);

    const shadowGet = await call(
      "/api/shadow-pricing?source=fixture&ladder3=-145&mode=floor&routerAudit=enforced_lockout",
    );
    expect(shadowGet.status).toBe(200);
    const shadowGetJson = (await shadowGet.json()) as {
      provenance: string;
      parameters: {
        ladderKey3: number;
        repriceMode: string;
        routerAuditMode: string;
      };
    };
    expect(shadowGetJson.provenance).toBe("fixture");
    expect(shadowGetJson.parameters.ladderKey3).toBe(-145);
    expect(shadowGetJson.parameters.repriceMode).toBe("floor");
    expect(shadowGetJson.parameters.routerAuditMode).toBe("enforced_lockout");

    const shadowBadPost = await call("/api/shadow-pricing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad-json",
    });
    expect(shadowBadPost.status).toBe(400);

    expect((await call("/api/build-matrix")).status).toBe(200);
    expect((await call("/api/ws/status")).status).toBe(200);

    const tickerRes = await call("/api/bet-ticker?writer=GSLIVE");
    expect(tickerRes.status).toBe(200);
    expect(
      (
        (await tickerRes.json()) as {
          localFeed: { byWriter: Array<{ writer: string }> };
        }
      ).localFeed.byWriter[0]?.writer,
    ).toBe("GSLIVE");

    const r2Res = await call("/api/r2/pipeline?refresh=1");
    expect(r2Res.status).toBe(200);
    expect(
      ((await r2Res.json()) as { overallStatus: string }).overallStatus,
    ).toBe("fresh");

    const daemonRes = await call("/api/daemon/status");
    expect(daemonRes.status).toBe(200);
    expect(((await daemonRes.json()) as { online: boolean }).online).toBe(true);

    const agentRes = await call("/api/agent/FAKEMONEY");
    expect(agentRes.status).toBe(200);
    expect(((await agentRes.json()) as { found: boolean }).found).toBe(true);

    expect((await call("/api/not-a-route")).status).toBe(404);
    expect((await call("/unknown")).status).toBe(404);
  });

  test("enforces optional auth gate and manages WebSocket topic subscriptions", async () => {
    const api = createDashboardApi(
      buildMockDeps({
        enforceAuth: async (req) =>
          req.headers.get("authorization") === "Bearer ok"
            ? null
            : Response.json({ error: "Unauthorized" }, { status: 401 }),
      }),
    );

    expect(
      (await api.fetch(new Request("http://dashboard.local/api/dns"))).status,
    ).toBe(401);
    expect(
      (
        await api.fetch(
          new Request("http://dashboard.local/api/dns", {
            headers: { Authorization: "Bearer ok" },
          }),
        )
      ).status,
    ).toBe(200);

    const subs = new Set<string>();
    const sent: string[] = [];
    const fakeWs: WsLike = {
      get subscriptions() {
        return [...subs];
      },
      subscribe(topic) {
        subs.add(topic);
      },
      unsubscribe(topic) {
        subs.delete(topic);
      },
      send(data) {
        sent.push(data);
      },
    };

    api.websocket.open(fakeWs);
    expect(api.clients.size).toBe(1);
    api.websocket.message(
      fakeWs,
      JSON.stringify({ type: "subscribe", topic: "proxy-conduits" }),
    );
    expect(subs.has("proxy-conduits")).toBe(true);
    api.websocket.message(
      fakeWs,
      JSON.stringify({ type: "unsubscribe", topic: "live-bets" }),
    );
    expect(subs.has("live-bets")).toBe(false);
    expect(sent.length).toBe(2);

    // live-bets was unsubscribed, so publishTopic skips this client for live-bets
    expect(api.publishTopic("live-bets", "wagers-updated")).toBe(0);
    // syndicate-alerts is still subscribed: sweep, ack, and retry push notifications once each
    await api.fetch(
      new Request("http://dashboard.local/api/alerts/sweep", {
        method: "POST",
        headers: { Authorization: "Bearer ok" },
      }),
    );
    await api.fetch(
      new Request("http://dashboard.local/api/alerts/del-123/ack", {
        method: "POST",
        headers: {
          Authorization: "Bearer ok",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ operatorId: "op1" }),
      }),
    );
    await api.fetch(
      new Request("http://dashboard.local/api/alerts/del-123/retry", {
        method: "POST",
        headers: { Authorization: "Bearer ok" },
      }),
    );
    expect(sent.length).toBe(5);
    expect(parseDashboardWsSignal(sent[2]!)).toEqual({
      kind: "alerts-updated",
    });

    const statusJson = (await (
      await api.fetch(
        new Request("http://dashboard.local/api/ws/status", {
          headers: { Authorization: "Bearer ok" },
        }),
      )
    ).json()) as { totalConnectedClients: number };
    expect(statusJson.totalConnectedClients).toBe(1);

    api.websocket.close(fakeWs);
    expect(api.clients.size).toBe(0);
  });

  test("parseDashboardWsSignal handles plain strings, structured topic events, tier configs, and malformed frames", () => {
    expect(parseDashboardWsSignal("reload")).toEqual({ kind: "reload" });
    expect(parseDashboardWsSignal("dashboard-updated")).toEqual({
      kind: "dashboard-updated",
    });
    expect(parseDashboardWsSignal("wagers-updated")).toEqual({
      kind: "wagers-updated",
    });
    expect(parseDashboardWsSignal("live-bets")).toEqual({
      kind: "wagers-updated",
    });
    expect(parseDashboardWsSignal("syndicate-alerts")).toEqual({
      kind: "alerts-updated",
    });
    expect(parseDashboardWsSignal("tiers-updated")).toEqual({
      kind: "tiers-updated",
    });
    expect(
      parseDashboardWsSignal(
        JSON.stringify({
          type: "topic-event",
          topic: "live-bets",
          event: "wagers-updated",
          timestamp: "2026-11-12T00:00:00Z",
        }),
      ),
    ).toEqual({ kind: "wagers-updated" });
    expect(
      parseDashboardWsSignal(
        JSON.stringify({
          type: "tiers-updated",
          tiers: {
            CRITICAL: { fg: "#fff", bg: "#f00", border: "#900" },
          },
        }),
      ),
    ).toEqual({
      kind: "tiers-updated",
      tiers: {
        CRITICAL: { fg: "#fff", bg: "#f00", border: "#900" },
      },
    });
    expect(
      parseDashboardWsSignal(
        JSON.stringify({ type: "subscribed-many", topics: ["dashboard"] }),
      ),
    ).toEqual({ kind: "ack", ackType: "subscribed-many" });
    expect(parseDashboardWsSignal("{not-valid-json")).toEqual({
      kind: "ignore",
    });
  });

  test("stamps the wagers-tab policy version on the live-wagers payload (rebuild-independent probe)", async () => {
    const api = createDashboardApi(
      buildMockDeps({
        getWagersTabPolicy: async () => ({
          policy_version: "wagers-policy/v1",
          policy_schema: "sportsdesk-wagers-tab/v1",
        }),
      }),
    );
    const call = (path: string) =>
      api.fetch(new Request(`http://dashboard.local${path}`));

    for (const path of ["/api/wagers", "/api/live-wagers"]) {
      const body = (await (await call(path)).json()) as {
        readonly policy_version?: string;
        readonly policy_schema?: string;
        readonly wagers?: unknown;
      };
      expect(body.policy_version).toBe("wagers-policy/v1");
      expect(body.policy_schema).toBe("sportsdesk-wagers-tab/v1");
      expect(Array.isArray(body.wagers)).toBe(true);
    }
  });

  test("keeps the feed serving when the policy stamp read fails", async () => {
    const api = createDashboardApi(
      buildMockDeps({
        getWagersTabPolicy: async () => {
          throw new Error("policy file unreadable");
        },
      }),
    );
    const res = await api.fetch(
      new Request("http://dashboard.local/api/wagers"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { readonly policy_version?: string };
    expect(body.policy_version).toBeUndefined();
  });

  test("startDashboardServer({ apiOnly: true }) exposes /health & /api/* without serving UI HTML", async () => {
    const handle = startDashboardServer({
      port: 0,
      hostname: "127.0.0.1",
      watchFiles: false,
      apiOnly: true,
      forceShadowFixture: true,
    });
    try {
      const healthRes = await fetch(new URL("/health", handle.url));
      expect(healthRes.status).toBe(200);
      const taxRes = await fetch(new URL("/api/taxonomy-catalog", handle.url));
      expect(taxRes.status).toBe(200);
      const rootRes = await fetch(new URL("/", handle.url));
      expect(rootRes.status).toBe(404);

      // The host wires the real loader, so the committed TOML is the source.
      const wagersBody = (await (
        await fetch(new URL("/api/wagers", handle.url))
      ).json()) as { readonly policy_version?: string };
      expect(wagersBody.policy_version).toBe(WAGERS_TABLE.policy_tag);
    } finally {
      handle.stop(true);
    }
  });
});
