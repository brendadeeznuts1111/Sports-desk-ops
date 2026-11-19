import { describe, expect, test } from "bun:test";
import {
  createDashboardApi,
  type DashboardApiDeps,
  type WsLike,
} from "@sportsdesk-ops/api";
import { parseDashboardWsSignal } from "@sportsdesk-ops/contracts";
import { WAGERS_TABLE } from "../packages/ui/src/config/wagers.ts";
import {
  resolveDashboardDevelopmentOption,
  startDashboardServer,
} from "../scripts/dev_dashboard.ts";

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
          backtestAll: [],
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
    getR2PipelineHistoryPayload: async (opts) => ({
      schemaVersion: 1,
      observedAt: "2026-11-12T00:00:00.000Z",
      source: "process-memory",
      sampledSince: "2026-11-12T00:00:00.000Z",
      minSampleIntervalSeconds: 60,
      sinks: [
        {
          id: "gslive-tally",
          label: "gslive tally",
          slaSeconds: 3600,
          sampleCount: opts?.limit === 1 ? 1 : 2,
          samples: [
            {
              at: "2026-11-12T00:00:00.000Z",
              ageSeconds: 7200,
              state: "stale",
              dataAgeSeconds: 90000,
            },
          ],
        },
      ],
    }),
    getR2ImageProvenancePayload: async ({ key }) => ({
      schemaVersion: 1,
      key,
      publicUrl: `https://pub-mock.r2.dev/${key}`,
      fetchedBytes: 12,
      report: {
        available: true,
        format: "png",
        width: 1,
        height: 1,
        byteLength: 12,
        channels: ["png-text"],
        fields: {
          streamId: "gslive-tally",
          genU32: 1042,
          merkleRoot: "ab".repeat(32),
        },
        raw: { "sportsdesk:gen_u32": "1042" },
        issues: [],
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
    getBuildMatrix: async () => ({
      targets: [{ target: "prod", features: ["PROD"] }],
      generatedAt: "2026-11-15T00:00:00.000Z",
    }),
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
      "/api/shadow-pricing?source=fixture&ladder3=-145&mode=floor&routerAudit=enforced_lockout&regime=live_in_play",
    );
    expect(shadowGet.status).toBe(200);
    const shadowGetJson = (await shadowGet.json()) as {
      provenance: string;
      parameters: {
        ladderKey3: number;
        repriceMode: string;
        routerAuditMode: string;
        regime?: string;
      };
    };
    expect(shadowGetJson.provenance).toBe("fixture");
    expect(shadowGetJson.parameters.ladderKey3).toBe(-145);
    expect(shadowGetJson.parameters.repriceMode).toBe("floor");
    expect(shadowGetJson.parameters.routerAuditMode).toBe("enforced_lockout");
    expect(shadowGetJson.parameters.regime).toBe("live_in_play");

    const shadowPostRegime = await call("/api/shadow-pricing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sport: "Football",
        regime: "pregame",
      }),
    });
    expect(shadowPostRegime.status).toBe(200);
    const shadowPostRegimeJson = (await shadowPostRegime.json()) as {
      parameters: { sport?: string; regime?: string };
    };
    expect(shadowPostRegimeJson.parameters.sport).toBe("Football");
    expect(shadowPostRegimeJson.parameters.regime).toBe("pregame");

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

    const historyRes = await call("/api/r2/pipeline/history?limit=1");
    expect(historyRes.status).toBe(200);
    const history = (await historyRes.json()) as {
      source: string;
      sampledSince: string | null;
      sinks: Array<{ id: string; sampleCount: number }>;
    };
    expect(history.source).toBe("process-memory");
    expect(history.sampledSince).toBe("2026-11-12T00:00:00.000Z");
    expect(history.sinks[0]?.id).toBe("gslive-tally");
    expect(history.sinks[0]?.sampleCount).toBe(1);

    const defaultHistoryRes = await call("/api/r2/pipeline/history");
    expect(
      (
        (await defaultHistoryRes.json()) as {
          sinks: Array<{ sampleCount: number }>;
        }
      ).sinks[0]?.sampleCount,
    ).toBe(2);

    const provenanceRes = await call(
      "/api/r2/image-provenance?key=assets/ARCH-Guide.webp",
    );
    expect(provenanceRes.status).toBe(200);
    const provenance = (await provenanceRes.json()) as {
      key: string;
      publicUrl: string;
      report: { fields: { streamId: string; genU32: number } };
    };
    expect(provenance.key).toBe("assets/ARCH-Guide.webp");
    expect(provenance.publicUrl).toBe(
      "https://pub-mock.r2.dev/assets/ARCH-Guide.webp",
    );
    expect(provenance.report.fields.streamId).toBe("gslive-tally");
    expect(provenance.report.fields.genU32).toBe(1042);

    // A key that could escape the bucket or name a non-image is refused.
    for (const badKey of [
      "",
      "../secret.png",
      "/assets/x.png",
      "https://evil.example/x.png",
      "assets/x.json",
    ]) {
      const res = await call(
        `/api/r2/image-provenance?key=${encodeURIComponent(badKey)}`,
      );
      expect(res.status).toBe(400);
    }

    const daemonRes = await call("/api/daemon/status");
    expect(daemonRes.status).toBe(200);
    expect(((await daemonRes.json()) as { online: boolean }).online).toBe(true);

    const agentRes = await call("/api/agent/FAKEMONEY");
    expect(agentRes.status).toBe(200);
    expect(((await agentRes.json()) as { found: boolean }).found).toBe(true);

    expect((await call("/api/not-a-route")).status).toBe(404);
    expect((await call("/unknown")).status).toBe(404);
  });

  test("reports an empty process-local history when the pipeline service is not wired", async () => {
    const api = createDashboardApi(
      buildMockDeps({
        getR2PipelinePayload: undefined,
        getR2PipelineHistoryPayload: undefined,
      }),
    );
    const res = await api.fetch(
      new Request("http://dashboard.local/api/r2/pipeline/history"),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      schemaVersion: number;
      source: string;
      sampledSince: string | null;
      sinks: readonly unknown[];
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.source).toBe("process-memory");
    expect(payload.sampledSince).toBeNull();
    expect(payload.sinks).toEqual([]);
  });

  test("reports provenance_probe_not_configured when no image fetcher is wired", async () => {
    const api = createDashboardApi(
      buildMockDeps({ getR2ImageProvenancePayload: undefined }),
    );
    const res = await api.fetch(
      new Request(
        "http://dashboard.local/api/r2/image-provenance?key=assets/x.webp",
      ),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      key: string;
      report: { available: boolean; issues: readonly string[] };
    };
    expect(payload.key).toBe("assets/x.webp");
    expect(payload.report.available).toBe(false);
    expect(payload.report.issues).toContain("provenance_probe_not_configured");
  });

  test("forwards the build-matrix refresh flag so the Re-compile button actually reprobes", async () => {
    const probes: Array<boolean | undefined> = [];
    const api = createDashboardApi(
      buildMockDeps({
        getBuildMatrix: async (force) => {
          probes.push(force);
          return {
            targets: [{ target: "prod", features: ["PROD"] }],
            generatedAt: "2026-11-15T00:00:00.000Z",
          };
        },
      }),
    );
    const call = (path: string) =>
      api.fetch(new Request(`http://dashboard.local${path}`));

    expect((await call("/api/build-matrix")).status).toBe(200);
    expect((await call("/api/build-matrix?refresh=0")).status).toBe(200);
    expect((await call("/api/build-matrix?refresh=1")).status).toBe(200);
    expect(probes).toEqual([false, false, true]);
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

  test("resolveDashboardDevelopmentOption wires Bun v1.4.4 HTML error overlay & HMR options", () => {
    expect(resolveDashboardDevelopmentOption({}, "development")).toEqual({
      hmr: true,
      console: true,
    });
    expect(
      resolveDashboardDevelopmentOption({ watchFiles: false }, "development"),
    ).toEqual({
      hmr: false,
      console: false,
    });
    expect(
      resolveDashboardDevelopmentOption({ apiOnly: true }, "development"),
    ).toBe(false);
    expect(resolveDashboardDevelopmentOption({}, "production")).toBe(false);
    expect(
      resolveDashboardDevelopmentOption(
        { development: { hmr: true, console: false } },
        "production",
      ),
    ).toEqual({
      hmr: true,
      console: false,
    });
    expect(
      resolveDashboardDevelopmentOption({ development: false }, "development"),
    ).toBe(false);
  });
});

describe("conditional GET (ETag / If-None-Match)", () => {
  const call = (
    api: ReturnType<typeof createDashboardApi>,
    path: string,
    headers: Record<string, string> = {},
  ) => api.fetch(new Request(`http://dashboard.local${path}`, { headers }));

  test("an encoded route answers a matching validator with 304 and no body", async () => {
    const api = createDashboardApi(buildMockDeps());
    const first = await call(api, "/api/customers");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);

    const second = await call(api, "/api/customers", {
      "if-none-match": etag!,
    });
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect((await second.arrayBuffer()).byteLength).toBe(0);
  });

  test("a JSON route gets the same validator, and a changed payload changes it", async () => {
    let wagers = [{ ticketId: "W-1" }];
    const api = createDashboardApi(
      buildMockDeps({
        getLiveWagersPayload: async () => ({ wagers, autoExecute: false }),
      }),
    );

    const first = await call(api, "/api/wagers");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");

    const revalidated = await call(api, "/api/wagers", {
      "if-none-match": etag,
    });
    expect(revalidated.status).toBe(304);

    wagers = [{ ticketId: "W-1" }, { ticketId: "W-2" }];
    const changed = await call(api, "/api/wagers", {
      "if-none-match": etag,
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect(
      ((await changed.json()) as { wagers: unknown[] }).wagers,
    ).toHaveLength(2);
  });

  test("a weak validator matches and an unrelated one does not", async () => {
    const api = createDashboardApi(buildMockDeps());
    const etag = (await call(api, "/api/ws/status")).headers.get("etag")!;
    expect(
      (
        await call(api, "/api/ws/status", {
          "if-none-match": `W/${etag}`,
        })
      ).status,
    ).toBe(304);
    expect(
      (
        await call(api, "/api/ws/status", {
          "if-none-match": '"stale-validator"',
        })
      ).status,
    ).toBe(200);
  });
});

describe("HEAD and Allow", () => {
  const call = (
    api: ReturnType<typeof createDashboardApi>,
    path: string,
    init: RequestInit = {},
  ) => api.fetch(new Request(`http://dashboard.local${path}`, init));

  test("HEAD mirrors the GET headers and sends no body", async () => {
    const api = createDashboardApi(buildMockDeps());
    const get = await call(api, "/api/customers");
    const head = await call(api, "/api/customers", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
    expect(head.headers.get("content-type")).toBe(
      get.headers.get("content-type"),
    );
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  test("HEAD honours a matching If-None-Match with 304", async () => {
    const api = createDashboardApi(buildMockDeps());
    const etag = (await call(api, "/api/customers")).headers.get("etag")!;
    const head = await call(api, "/api/customers", {
      method: "HEAD",
      headers: { "if-none-match": etag },
    });
    expect(head.status).toBe(304);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  test("HEAD reaches parameterised routes", async () => {
    const api = createDashboardApi(buildMockDeps());
    const head = await call(api, "/api/agent/FAKEMONEY", {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("application/json");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  test("HEAD on an unknown path is a bodiless 404", async () => {
    const api = createDashboardApi(buildMockDeps());
    const head = await call(api, "/api/does-not-exist", { method: "HEAD" });
    expect(head.status).toBe(404);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  test("a disallowed method names the methods the route allows", async () => {
    const api = createDashboardApi(buildMockDeps());
    const post = await call(api, "/api/customers", { method: "POST" });
    expect(post.status).toBe(405);
    // HEAD is implicit wherever GET is served.
    expect(post.headers.get("allow")).toBe("GET, HEAD");

    const postHealth = await call(api, "/health", { method: "POST" });
    expect(postHealth.status).toBe(405);
    expect(postHealth.headers.get("allow")).toBe("GET, HEAD");

    // A POST-only route must not advertise GET/HEAD.
    const getAck = await call(api, "/api/alerts/A1/ack", { method: "GET" });
    expect(getAck.status).toBe(405);
    expect(getAck.headers.get("allow")).toBe("POST");
  });
});

describe("/api/config/tiers native formats", () => {
  const CONFIG = {
    tiers: { CRITICAL: { fg: "#fff", weight: 3 }, LOW: { fg: "#94a3b8" } },
    order: ["CRITICAL", "LOW"],
    live: true,
  };
  const api = createDashboardApi(
    buildMockDeps({ getTiersConfig: async () => CONFIG }),
  );
  const call = (query = "", headers: Record<string, string> = {}) =>
    api.fetch(
      new Request(`http://dashboard.local/api/config/tiers${query}`, {
        headers,
      }),
    );

  test("defaults to JSON with a validator", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(await response.json()).toEqual(CONFIG);
  });

  test("?format=yaml emits YAML that parses back to the config", async () => {
    const response = await call("?format=yaml");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/yaml; charset=utf-8",
    );
    const body = await response.text();
    expect(body.endsWith("\n")).toBe(true);
    expect(Bun.YAML.parse(body)).toEqual(CONFIG);
  });

  test("?format=toml emits TOML that parses back to the config", async () => {
    const response = await call("?format=toml");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/toml; charset=utf-8",
    );
    const body = await response.text();
    expect(Bun.TOML.parse(body)).toEqual(CONFIG);
  });

  test("a conditional request revalidates each format", async () => {
    for (const format of ["yaml", "toml"]) {
      const first = await call(`?format=${format}`);
      const etag = first.headers.get("etag")!;
      const second = await call(`?format=${format}`, {
        "if-none-match": etag,
      });
      expect(second.status).toBe(304);
      expect((await second.arrayBuffer()).byteLength).toBe(0);
    }
  });

  test("an unknown format is a 400 that names the choices", async () => {
    const response = await call("?format=xml");
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      allowed: string[];
    };
    expect(body.error).toContain('Unsupported format "xml"');
    expect(body.allowed).toEqual(["json", "yaml", "toml"]);
  });

  test("a non-object config cannot pretend to be TOML", async () => {
    const scalarApi = createDashboardApi(
      buildMockDeps({ getTiersConfig: async () => 42 }),
    );
    const response = await scalarApi.fetch(
      new Request("http://dashboard.local/api/config/tiers?format=toml"),
    );
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toContain(
      "not an object",
    );
  });
});
