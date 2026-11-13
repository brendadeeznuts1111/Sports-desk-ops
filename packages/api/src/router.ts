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

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

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
        return Response.json(await deps.getLiveWagersPayload());
      },
    },
    "/api/live-wagers": {
      GET: async (req: Request): Promise<Response> => {
        const denied = await enforceAuth(req);
        if (denied) return denied;
        return Response.json(await deps.getLiveWagersPayload());
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
