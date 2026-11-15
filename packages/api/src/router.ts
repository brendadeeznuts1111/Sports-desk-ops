/**
 * @file packages/api/src/router.ts
 * @description Injectable dashboard HTTP API router + in-memory `fetch()` dispatcher for zero-port testing & `Bun.serve({ routes })`.
 */

import {
  parseFiniteNumber,
  parseRepriceMode,
  parseRouterAuditMode,
} from "@sportsdesk-ops/backend";
import {
  type DashboardWsTopic,
  type MarketFilter,
  type PeriodFilter,
  type RouterAuditMode,
  type ShadowRepriceMode,
  type SportFilter,
  type SubSportFilter,
} from "@sportsdesk-ops/contracts";
import type {
  DashboardApiDeps,
  EncodedResponseSpec,
  RouteRequestWithParams,
} from "./types.ts";
import {
  createDashboardWebSocketHandler,
  publishDashboardTopicEvent,
  type WsLike,
} from "./ws.ts";

type HttpMethod =
  "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

type SimpleMethodHandlers = {
  readonly [M in HttpMethod]?: (req: Request) => Response | Promise<Response>;
};

type IdParamMethodHandlers = {
  readonly [M in HttpMethod]?: (
    req: RouteRequestWithParams<{ readonly id: string }>,
  ) => Response | Promise<Response>;
};

function defaultEncodeResponse(
  _req: Request,
  spec: EncodedResponseSpec,
): Response {
  const bytes = spec.produce();
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return new Response(body, {
    headers: {
      "Content-Type": spec.contentType,
      ...spec.headers,
    },
  });
}

/**
 * Merge the wagers-tab policy stamp into a live-wagers payload.
 *
 * The stamp is read from `packages/ui/src/config/wagers.toml` at request time,
 * so `curl -s :4021/api/wagers | jq -r .policy_version` is a stable probe that
 * survives rebuilds (unlike a bundle content hash). A missing/invalid policy
 * file must not take the feed down: the payload is returned unstamped.
 */
async function withWagersTabPolicy(
  deps: DashboardApiDeps,
  payload: object,
): Promise<object> {
  const readPolicy = deps.getWagersTabPolicy;
  if (!readPolicy) return payload;
  try {
    const stamp = await readPolicy();
    return stamp ? { ...payload, ...stamp } : payload;
  } catch (err) {
    console.warn(
      "[api] wagers tab policy stamp unavailable:",
      err instanceof Error ? err.message : err,
    );
    return payload;
  }
}

/**
 * Create the SportsDesk dashboard HTTP + WebSocket API surface.
 *
 * Exposes:
 * - `routes`: declarative route table ready to mount in `Bun.serve({ routes })`
 * - `fetch(req)`: zero-port in-memory request dispatcher for fast unit & contract tests
 * - `websocket` + `clients`: topic-based WebSocket handler
 */
export function createDashboardApi<TWs extends WsLike = WsLike>(
  deps: DashboardApiDeps,
  options: { readonly clients?: Set<TWs> | undefined } = {},
) {
  const clients = options.clients ?? new Set<TWs>();
  const { websocket, buildWsStatusPayload } =
    createDashboardWebSocketHandler(clients);
  const publishTopic = (topic: DashboardWsTopic, message: string): number =>
    publishDashboardTopicEvent(clients, topic, message);
  const emitAlertsUpdated = () => {
    publishTopic(
      "syndicate-alerts",
      JSON.stringify({
        type: "topic-event",
        topic: "syndicate-alerts",
        event: "alerts-updated",
        timestamp: new Date().toISOString(),
      }),
    );
  };

  const enforceAuth = async (req: Request): Promise<Response | null> => {
    if (!deps.enforceAuth) return null;
    return deps.enforceAuth(req);
  };

  const encodeResponse = (
    req: Request,
    spec: EncodedResponseSpec,
  ): Response | Promise<Response> => {
    if (deps.encodeResponse) {
      return deps.encodeResponse(req, spec);
    }
    return defaultEncodeResponse(req, spec);
  };

  const textEncoder = new TextEncoder();

  const staticRoutes = {
    "/health": {
      GET: async (): Promise<Response> => {
        return Response.json(await deps.getHealthPayload());
      },
    },

    "/mcp": {
      GET: (req: Request) =>
        deps.handleMcp
          ? deps.handleMcp(req)
          : Response.json(
              { error: "MCP endpoint not configured" },
              { status: 404 },
            ),
      HEAD: (req: Request) =>
        deps.handleMcp
          ? deps.handleMcp(req)
          : new Response(null, { status: 404 }),
      POST: (req: Request) =>
        deps.handleMcp
          ? deps.handleMcp(req)
          : Response.json(
              { error: "MCP endpoint not configured" },
              { status: 404 },
            ),
      PUT: (req: Request) =>
        deps.handleMcp
          ? deps.handleMcp(req)
          : Response.json(
              { error: "MCP endpoint not configured" },
              { status: 404 },
            ),
      PATCH: (req: Request) =>
        deps.handleMcp
          ? deps.handleMcp(req)
          : Response.json(
              { error: "MCP endpoint not configured" },
              { status: 404 },
            ),
      DELETE: (req: Request) =>
        deps.handleMcp
          ? deps.handleMcp(req)
          : Response.json(
              { error: "MCP endpoint not configured" },
              { status: 404 },
            ),
      OPTIONS: (req: Request) =>
        deps.handleMcp
          ? deps.handleMcp(req)
          : new Response(null, { status: 204 }),
    },

    "/api/auth/login": {
      POST: (req: Request) => deps.auth.login(req),
    },
    "/api/auth/logout": {
      POST: (req: Request) => deps.auth.logout(req),
    },
    "/api/auth/me": {
      GET: (req: Request) => deps.auth.me(req),
    },

    "/api/dashboard": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;

        const rendered = await deps.loadDashboardMarkdown();
        if (rendered === null) {
          return Response.json(
            { error: "dashboard.md not found" },
            { status: 404 },
          );
        }

        const payload = {
          markdown: rendered.markdown,
          html: rendered.html,
          ...(rendered.renderDurationMs !== undefined
            ? { renderDurationMs: rendered.renderDurationMs }
            : {}),
          ...(rendered.markdownBytes !== undefined
            ? { markdownBytes: rendered.markdownBytes }
            : {}),
          ...(rendered.htmlBytes !== undefined
            ? { htmlBytes: rendered.htmlBytes }
            : {}),
          ...(rendered.nonAsciiChars !== undefined
            ? { nonAsciiChars: rendered.nonAsciiChars }
            : {}),
          updatedAt: new Date().toISOString(),
        };
        return encodeResponse(req, {
          version: `dev-dashboard-md|${rendered.stamp}`,
          contentType: "application/json; charset=utf-8",
          produce: () => textEncoder.encode(JSON.stringify(payload)),
          headers: { "Cache-Control": "no-cache" },
        });
      },
    },

    "/api/dns": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        return Response.json(deps.dns.getTelemetryPayload());
      },
    },
    "/api/dns/telemetry": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        return Response.json(deps.dns.getTelemetryPayload());
      },
    },
    "/api/dns/benchmark": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        const url = new URL(req.url);
        const host = url.searchParams.get("host") || "fantasy402.com";
        return Response.json(await deps.dns.benchmark(host));
      },
    },
    "/api/dns/reverse": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        const url = new URL(req.url);
        const ip = url.searchParams.get("ip") || "1.1.1.1";
        return Response.json(await deps.dns.classifyIp(ip));
      },
    },

    "/api/customers": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        const report = await deps.customers.getCohortReport();
        return encodeResponse(req, {
          version: report.versionStamp,
          contentType: "application/json; charset=utf-8",
          produce: () => textEncoder.encode(JSON.stringify(report.payload)),
        });
      },
    },

    "/api/customer/profile": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        const url = new URL(req.url);
        const id = (url.searchParams.get("id") ?? "").trim();
        if (!id) {
          return Response.json(
            { success: false, error: "Missing required parameter 'id'" },
            { status: 400 },
          );
        }
        const profile = await deps.customers.getProfile(id);
        if (!profile) {
          return Response.json(
            { success: false, error: `Customer '${id}' not found` },
            { status: 404 },
          );
        }
        return Response.json(
          {
            success: true,
            profile,
            generatedAt: new Date().toISOString(),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },

    "/api/customer/rating": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        const url = new URL(req.url);
        const id = (url.searchParams.get("id") ?? "").trim();
        if (!id) {
          return Response.json(
            { success: false, error: "Missing required parameter 'id'" },
            { status: 400 },
          );
        }
        const rating = await deps.customers.getRating(id);
        if (!rating) {
          return Response.json(
            { success: false, error: `Customer '${id}' not found` },
            { status: 404 },
          );
        }
        return Response.json(
          {
            success: true,
            rating,
            generatedAt: new Date().toISOString(),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },

    "/api/terminal/exec": {
      POST: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        try {
          const body = (await req.json()) as {
            command?: string;
            cols?: number;
            rows?: number;
          };
          const command = body.command?.trim() ?? "help";
          const result = await deps.execTerminal(command, {
            cols: body.cols ?? 100,
            rows: body.rows ?? 30,
          });
          return Response.json(result);
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          );
        }
      },
    },

    "/api/rankings/all": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        try {
          const url = new URL(req.url);
          const limit = Number(url.searchParams.get("limit")) || 100;
          const { generatedAtIso, payload } = await deps.rankings.getAll(limit);
          return await encodeResponse(req, {
            version: `dev-rankings|${generatedAtIso}|${limit}`,
            contentType: "application/json; charset=utf-8",
            produce: () => textEncoder.encode(JSON.stringify(payload)),
          });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          );
        }
      },
    },

    "/api/agency/conduits": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        try {
          const conduits = await deps.rankings.getConduits();
          return Response.json({ conduits });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          );
        }
      },
    },

    "/api/wagers": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        return Response.json(
          await withWagersTabPolicy(deps, await deps.getLiveWagersPayload()),
        );
      },
    },
    "/api/live-wagers": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        return Response.json(
          await withWagersTabPolicy(deps, await deps.getLiveWagersPayload()),
        );
      },
    },

    "/api/config/tiers": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        try {
          return Response.json(await deps.getTiersConfig());
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          );
        }
      },
    },

    "/api/alerts/sweep": {
      POST: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        const sweep = await deps.alerts.sweepOnce();
        emitAlertsUpdated();
        return Response.json({ ok: true, sweep });
      },
    },

    "/api/alerts": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        const url = new URL(req.url);
        const statusParam = (
          url.searchParams.get("status") ?? "all"
        ).toLowerCase();
        const alerts = deps.alerts.list(statusParam);
        return Response.json({
          alerts,
          total: alerts.length,
          status: statusParam,
          timestamp: new Date().toISOString(),
        });
      },
    },

    "/api/shift/summary": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        const url = new URL(req.url);
        const operatorId = url.searchParams.get("operatorId") ?? "operator";
        return Response.json(deps.alerts.getShiftSummary(operatorId));
      },
    },

    "/api/taxonomy-catalog": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        return Response.json({
          schemaVersion: 1,
          catalog: deps.getTaxonomyCatalog(),
        });
      },
    },

    "/api/shadow-pricing": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        try {
          const url = new URL(req.url);
          const forceFixture =
            deps.forceShadowFixture === true ||
            url.searchParams.get("source") === "fixture";
          const sportParam = url.searchParams.get("sport");
          const subSportParam = url.searchParams.get("subSport");
          const periodParam = url.searchParams.get("period");
          const marketParam = url.searchParams.get("market");
          const payload = await deps.runShadowPricing({
            dbPath: deps.shadowDbPath,
            forceFixture,
            ladderKey3: parseFiniteNumber(url.searchParams.get("ladder3")),
            ladderKey7: parseFiniteNumber(url.searchParams.get("ladder7")),
            ladderKey14_21: parseFiniteNumber(
              url.searchParams.get("ladderOther"),
            ),
            minVolume: parseFiniteNumber(url.searchParams.get("minVolume")),
            retailElasticity: parseFiniteNumber(
              url.searchParams.get("elasticity"),
            ),
            repriceMode: parseRepriceMode(url.searchParams.get("mode")),
            sport: (sportParam ?? undefined) as SportFilter | undefined,
            subSport: (subSportParam ?? undefined) as
              SubSportFilter | undefined,
            period: (periodParam ?? undefined) as PeriodFilter | undefined,
            market: (marketParam ?? undefined) as MarketFilter | undefined,
            routerAuditMode: parseRouterAuditMode(
              url.searchParams.get("routerAudit"),
            ),
          });
          return Response.json(payload);
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          );
        }
      },
      POST: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        try {
          const body = (await req.json()) as {
            ladderKey3?: number;
            ladderKey7?: number;
            ladderKey14_21?: number;
            minVolume?: number;
            retailElasticity?: number;
            repriceMode?: ShadowRepriceMode;
            sport?: SportFilter;
            subSport?: SubSportFilter;
            period?: PeriodFilter;
            market?: MarketFilter;
            routerAuditMode?: RouterAuditMode;
            source?: string;
          };
          const forceFixture =
            deps.forceShadowFixture === true || body.source === "fixture";
          const payload = await deps.runShadowPricing({
            dbPath: deps.shadowDbPath,
            forceFixture,
            ladderKey3: body.ladderKey3,
            ladderKey7: body.ladderKey7,
            ladderKey14_21: body.ladderKey14_21,
            minVolume: body.minVolume,
            retailElasticity: body.retailElasticity,
            repriceMode: parseRepriceMode(body.repriceMode),
            sport: body.sport,
            subSport: body.subSport,
            period: body.period,
            market: body.market,
            routerAuditMode: parseRouterAuditMode(body.routerAuditMode),
          });
          return Response.json(payload);
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      },
    },

    "/api/build-matrix": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        try {
          const targets = await deps.getBuildMatrix();
          return Response.json({
            schemaVersion: 1,
            targets,
            generatedAt: new Date().toISOString(),
          });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          );
        }
      },
    },

    "/api/ws/status": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        return Response.json(buildWsStatusPayload());
      },
    },

    "/api/bet-ticker": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        const url = new URL(req.url);
        const writer = url.searchParams.get("writer") ?? undefined;
        const wagerType =
          url.searchParams.get("type") ??
          url.searchParams.get("wagerType") ??
          undefined;
        if (!deps.getBetTickerPayload) {
          const observedAt = new Date().toISOString();
          return Response.json({
            schemaVersion: 1,
            observedAt,
            autoExecute: false,
            provenance: {
              kind: "unavailable",
              label: "Bet-Ticker loader not configured",
              sourcePath: null,
              observedAt,
            },
            localFeed: {
              rawRowCount: 0,
              actionableTicketCount: 0,
              sentinelNoiseCount: 0,
              totalWageredCents: 0,
              totalVolumeCents: 0,
              totalToWinCents: 0,
              volumeDiffersCount: 0,
              vipCount: 0,
              liveCount: 0,
              flagCount: 0,
              byRule: {},
              byWriter: [],
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
          });
        }
        return Response.json(
          await deps.getBetTickerPayload({ writer, wagerType }),
        );
      },
    },

    "/api/r2/pipeline": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        const url = new URL(req.url);
        const refresh = url.searchParams.get("refresh") === "1";
        if (!deps.getR2PipelinePayload) {
          const observedAt = new Date().toISOString();
          return Response.json({
            schemaVersion: 1,
            bucketPublicBase: "",
            observedAt,
            overallStatus: "degraded",
            freshCount: 0,
            totalCount: 0,
            staleKeys: [],
            dataStaleKeys: [],
            sinks: [],
            daemon4020: {
              online: false,
              url: "http://127.0.0.1:4020/health",
              status: null,
              latencyMs: null,
              checkedAt: observedAt,
              reason: "R2 pipeline probe not configured",
            },
          });
        }
        return Response.json(await deps.getR2PipelinePayload({ refresh }));
      },
    },

    "/api/daemon/status": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        if (!deps.getDaemonStatusPayload) {
          return Response.json({
            online: false,
            url: "http://127.0.0.1:4020/health",
            status: null,
            latencyMs: null,
            checkedAt: new Date().toISOString(),
            reason: "Daemon probe not configured",
          });
        }
        return Response.json(await deps.getDaemonStatusPayload());
      },
    },
  } satisfies Record<string, SimpleMethodHandlers>;

  const paramRoutes = {
    "/api/alerts/:id/ack": {
      POST: async (
        req: RouteRequestWithParams<{ readonly id: string }>,
      ): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        const deliveryId = req.params.id;
        let body: { operatorId?: string; notes?: string } = {};
        try {
          body = (await req.json()) as {
            operatorId?: string;
            notes?: string;
          };
        } catch {
          // signal-honesty: intentional-empty-json-body-allowed
        }
        const ok = await deps.alerts.ack({
          deliveryId,
          operatorId: body.operatorId ?? "operator",
          notes: body.notes,
        });
        if (ok) {
          emitAlertsUpdated();
        }
        return Response.json({ ok, deliveryId });
      },
    },

    "/api/alerts/:id/retry": {
      POST: async (
        req: RouteRequestWithParams<{ readonly id: string }>,
      ): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        const deliveryId = req.params.id;
        let body: { operatorId?: string } = {};
        try {
          body = (await req.json()) as { operatorId?: string };
        } catch {
          // signal-honesty: intentional-empty-json-body-allowed
        }
        const newDeliveryId = await deps.alerts.retry({
          deliveryId,
          operatorId: body.operatorId ?? "operator",
        });
        if (!newDeliveryId) {
          return Response.json(
            { error: "Alert not found in dead-letter state" },
            { status: 404 },
          );
        }
        emitAlertsUpdated();
        return Response.json({
          ok: true,
          originalDeliveryId: deliveryId,
          newDeliveryId,
        });
      },
    },

    "/api/agent/:id": {
      GET: async (
        req: RouteRequestWithParams<{ readonly id: string }>,
      ): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        const agentId = decodeURIComponent(req.params.id);
        if (!deps.getAgentDetailPayload) {
          return Response.json({
            schemaVersion: 1,
            agentId: agentId.trim().toUpperCase(),
            found: false,
            masterAgent: null,
            level: null,
            agentType: null,
            childAgents: [],
            conduit30d: null,
            customers: [],
            recentWagers: [],
            observedAt: new Date().toISOString(),
            autoExecute: false,
          });
        }
        return Response.json(await deps.getAgentDetailPayload(agentId));
      },
    },

    "/api/agents/:id": {
      GET: async (
        req: RouteRequestWithParams<{ readonly id: string }>,
      ): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        const agentId = decodeURIComponent(req.params.id);
        if (!deps.getAgentDetailPayload) {
          return Response.json({
            schemaVersion: 1,
            agentId: agentId.trim().toUpperCase(),
            found: false,
            masterAgent: null,
            level: null,
            agentType: null,
            childAgents: [],
            conduit30d: null,
            customers: [],
            recentWagers: [],
            observedAt: new Date().toISOString(),
            autoExecute: false,
          });
        }
        return Response.json(await deps.getAgentDetailPayload(agentId));
      },
    },
  } satisfies Record<string, IdParamMethodHandlers>;

  const apiFallbackResponse = () =>
    Response.json({ error: "Dashboard API route not found" }, { status: 404 });

  const routes = {
    ...staticRoutes,
    ...paramRoutes,
    "/api/*": () => apiFallbackResponse(),
  };

  /** Dispatch a dashboard API/health `Request` completely in-memory with zero port bind. */
  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const method = req.method.toUpperCase() as HttpMethod;

    const exact = (staticRoutes as Record<string, SimpleMethodHandlers>)[
      url.pathname
    ];
    if (exact !== undefined) {
      const handler = exact[method];
      if (!handler) {
        return Response.json({ error: "Method Not Allowed" }, { status: 405 });
      }
      return handler(req);
    }

    const alertActionMatch = /^\/api\/alerts\/([^/]+)\/(ack|retry)$/.exec(
      url.pathname,
    );
    if (alertActionMatch?.[1] && alertActionMatch[2]) {
      const routeKey =
        alertActionMatch[2] === "ack"
          ? "/api/alerts/:id/ack"
          : "/api/alerts/:id/retry";
      const handlers = paramRoutes[routeKey] as IdParamMethodHandlers;
      const handler = handlers[method];
      if (!handler) {
        return Response.json({ error: "Method Not Allowed" }, { status: 405 });
      }
      const id = decodeURIComponent(alertActionMatch[1]);
      const reqWithParams = Object.assign(req, {
        params: { id },
      }) as RouteRequestWithParams<{ readonly id: string }>;
      return handler(reqWithParams);
    }

    const agentDetailMatch = /^\/api\/agents?\/([^/]+)$/.exec(url.pathname);
    if (agentDetailMatch?.[1]) {
      const routeKey = url.pathname.startsWith("/api/agents/")
        ? "/api/agents/:id"
        : "/api/agent/:id";
      const handlers = paramRoutes[routeKey] as IdParamMethodHandlers;
      const handler = handlers[method];
      if (!handler) {
        return Response.json({ error: "Method Not Allowed" }, { status: 405 });
      }
      const id = decodeURIComponent(agentDetailMatch[1]);
      const reqWithParams = Object.assign(req, {
        params: { id },
      }) as RouteRequestWithParams<{ readonly id: string }>;
      return handler(reqWithParams);
    }

    if (url.pathname.startsWith("/api/")) {
      return apiFallbackResponse();
    }

    return new Response("Not Found", { status: 404 });
  };

  return {
    routes,
    fetch,
    websocket,
    clients,
    publishTopic,
  };
}
