/**
 * @file scripts/dev_dashboard.ts
 * @description Host entrypoint for the Native Bun-Powered Enhanced Dashboard & Surveillance Server.
 *
 * Delegates backend caching, customer/wager projection, health probing, and HTTP/WebSocket API
 * routing to `@sportsdesk-ops/backend` and `@sportsdesk-ops/api`, while wiring host adapters,
 * HTML/JS/CSS asset serving (`src/dashboard/index.html`), and workspace HMR file watchers.
 *
 * Pass `--api-only` (or `startDashboardServer({ apiOnly: true })`) via `bun run dev:api` to run
 * the API & WebSocket router without HTML bundling or UI file watchers.
 */

import {
  computeCustomersCohortPayload,
  createCachedJsonReader,
  createCustomerRowFinder,
  createDevLiveWagersLoader,
  DashboardHealthTracker,
  DashboardMarkdownCache,
  isDashboardAuthRequired,
} from "@sportsdesk-ops/backend";
import {
  createDashboardApi,
  type EncodedResponseSpec,
} from "@sportsdesk-ops/api";
import type { Server, ServerWebSocket } from "bun";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { resolve } from "node:path";
import {
  acknowledgeAlert,
  AlertDispatcher,
  getShiftSummary,
  listAlerts,
  retryAlert,
} from "../lib/alerts.ts";
import {
  benchmarkResolverLatency,
  classifyIpAddress,
  getDnsTelemetry,
  prefetchSportsDeskEndpoints,
  SPORTSDESK_CORE_HOSTS,
} from "../lib/bun_dns.ts";
import type { CustomerRow, TicketRow } from "../lib/customer_profile.ts";
import {
  handleLogin,
  handleLogout,
  handleSessionMe,
  requireCsrf,
  requireSession,
} from "../lib/http_auth.ts";
import { encodedResponse } from "../lib/http_compression.ts";
import { SUBSPORT_TAXONOMY_CATALOG } from "../lib/market_taxonomy_catalog.ts";
import { runShadowPricingDashboard } from "../lib/shadow_pricing_engine.ts";
import { executeTerminalQuery } from "../lib/terminal_emulator.ts";
import indexHtml from "../src/dashboard/index.html";
import { runBunBuild } from "./build.ts";
import { computeDashboardDceMatrix } from "./build_dashboard.ts";

export interface DashboardServerOptions {
  readonly port?: number | undefined;
  readonly hostname?: string | undefined;
  readonly watchFiles?: boolean | undefined;
  readonly shadowDbPath?: string | undefined;
  readonly forceShadowFixture?: boolean | undefined;
  readonly apiOnly?: boolean | undefined;
}

export interface DashboardServerHandle {
  readonly server: Server<undefined>;
  readonly url: URL;
  readonly port: number;
  stop: (closeActiveConnections?: boolean) => void;
}

interface CachedLegacyBundle {
  readonly jsBytes: Uint8Array<ArrayBuffer>;
  readonly jsEtag: string;
  readonly cssBytes: Uint8Array<ArrayBuffer> | null;
  readonly cssEtag: string | null;
}

async function enforceOptionalAuth(req: Request): Promise<Response | null> {
  if (!isDashboardAuthRequired()) return null;
  const authRes = await requireSession(req, async () => new Response("OK"));
  if (authRes.status !== 200) return authRes;
  const csrfRes = await requireCsrf(req, async () => new Response("OK"));
  if (csrfRes.status !== 200) return csrfRes;
  return null;
}

export function startDashboardServer(
  options: DashboardServerOptions = {},
): DashboardServerHandle {
  const cwd = process.cwd();
  const port =
    options.port !== undefined ? options.port : Number(Bun.env.PORT) || 4022;
  const hostname = options.hostname ?? "127.0.0.1";
  const apiOnly = options.apiOnly === true;

  const dashboardMdPath = resolve(cwd, "dashboard.md");
  const dashboardEntryPath = resolve(cwd, "src/dashboard/index.tsx");
  const wagerTiersTomlPath = resolve(cwd, "config/wager_tiers.toml");

  const clients = new Set<ServerWebSocket<undefined>>();
  const watchers: FSWatcher[] = [];
  let serverRef: Server<undefined> | null = null;

  const alertDispatcher = new AlertDispatcher({
    sweepIntervalMs: 5000,
  });
  if (options.watchFiles !== false) {
    alertDispatcher.start();
  }

  const jsonReader = createCachedJsonReader(24);
  const { findCustomerRow } = createCustomerRowFinder<CustomerRow>({ cwd });
  const markdownCache = new DashboardMarkdownCache(dashboardMdPath);
  const { buildLiveWagersPayload, clearCache: clearWagersCache } =
    createDevLiveWagersLoader({
      cwd,
      loadSharpDeps: async () => {
        const [{ parseShortDesc }, { KEY_NUMBER_BUYER_PROFILES }] =
          await Promise.all([
            import("../lib/live_wagers.ts"),
            import("../lib/customer_profile.ts"),
          ]);
        return {
          parseShortDesc,
          sharpCustomerIds: new Set(
            [...KEY_NUMBER_BUYER_PROFILES.keys()].map((k) =>
              k.trim().toUpperCase(),
            ),
          ),
        };
      },
    });

  const healthTracker = new DashboardHealthTracker({
    isDbConfigured: () => Boolean(Bun.env.PGUSER && Bun.env.PGPASSWORD),
    probeDb: async () => {
      const { sql } = await import("../lib/db.ts");
      await sql`SELECT 1`;
    },
    cleanupSessions: async () => {
      const { sessionCleanup } = await import("../lib/session.ts");
      return sessionCleanup();
    },
    getAlertMetrics: () => alertDispatcher.getHealthMetrics(),
    getPort: () => serverRef?.port ?? port,
  });

  let cachedDceMatrix: Awaited<
    ReturnType<typeof computeDashboardDceMatrix>
  > | null = null;
  let cachedLegacyBundle: CachedLegacyBundle | null = null;
  let inflightLegacyBundle: Promise<CachedLegacyBundle | null> | null = null;

  const ensureLegacyBundle = async (): Promise<CachedLegacyBundle | null> => {
    if (cachedLegacyBundle !== null) return cachedLegacyBundle;
    if (inflightLegacyBundle !== null) return inflightLegacyBundle;

    inflightLegacyBundle = (async () => {
      const build = await runBunBuild({
        entrypoints: [dashboardEntryPath],
        target: "browser",
        sourcemap: "inline",
      });
      if (!build.success || build.outputs.length === 0) {
        console.error("Build failed:", build.logs);
        return null;
      }
      const jsOutput =
        build.outputs.find(
          (o) => o.kind === "entry-point" || o.path.endsWith(".js"),
        ) ?? build.outputs[0];
      if (!jsOutput) return null;

      const cssOutput =
        build.outputs.find(
          (o) => o.kind === "asset" && o.path.endsWith(".css"),
        ) ?? null;

      const [jsBuf, cssBuf] = await Promise.all([
        jsOutput.arrayBuffer(),
        cssOutput ? cssOutput.arrayBuffer() : Promise.resolve(null),
      ]);
      const jsBytes = new Uint8Array<ArrayBuffer>(jsBuf);
      const jsHash =
        jsOutput.hash ??
        new Bun.CryptoHasher("sha256")
          .update(jsBytes)
          .digest("hex")
          .slice(0, 16);
      const cssBytes =
        cssBuf !== null ? new Uint8Array<ArrayBuffer>(cssBuf) : null;
      const cssHash =
        cssOutput && cssBytes
          ? (cssOutput.hash ??
            new Bun.CryptoHasher("sha256")
              .update(cssBytes)
              .digest("hex")
              .slice(0, 16))
          : null;

      const bundle: CachedLegacyBundle = {
        jsBytes,
        jsEtag: `"${jsHash}"`,
        cssBytes,
        cssEtag: cssHash ? `"${cssHash}"` : null,
      };
      cachedLegacyBundle = bundle;
      return bundle;
    })().finally(() => {
      inflightLegacyBundle = null;
    });

    return inflightLegacyBundle;
  };

  const api = createDashboardApi<ServerWebSocket<undefined>>(
    {
      enforceAuth: enforceOptionalAuth,
      auth: {
        login: (req) => handleLogin(req, serverRef!),
        logout: (req) => handleLogout(req),
        me: (req) => handleSessionMe(req),
      },
      encodeResponse: (req, spec: EncodedResponseSpec) =>
        encodedResponse(req, {
          version: spec.version,
          contentType: spec.contentType,
          produce: spec.produce,
          ...(spec.headers ? { headers: spec.headers } : {}),
        }),
      getHealthPayload: () => healthTracker.sample(),
      loadDashboardMarkdown: () => markdownCache.load(),
      dns: {
        getTelemetryPayload: () => {
          const telemetry = getDnsTelemetry();
          const nowIso = new Date().toISOString();
          return {
            success: true,
            telemetry,
            hosts: SPORTSDESK_CORE_HOSTS,
            coreHosts: SPORTSDESK_CORE_HOSTS.map((h) => ({
              hostname: h.hostname,
              port: h.port,
              serviceName: h.serviceName,
            })),
            updatedAt: nowIso,
            generatedAt: nowIso,
          };
        },
        benchmark: (host) =>
          benchmarkResolverLatency(host, ["c-ares", "system"], 3),
        classifyIp: (ip) => classifyIpAddress(ip),
      },
      customers: {
        getCohortReport: async () => {
          const [backtestCached, fixtureCached, localBookCached] =
            await Promise.all([
              jsonReader.readCachedJson<{
                customerLeaderboard?: Array<Record<string, unknown>>;
              }>(resolve(cwd, "docs/backtest-4wk-cfb-nba.json")),
              jsonReader.readCachedJson<Array<Record<string, unknown>>>(
                resolve(
                  cwd,
                  "tests/fixtures/backtest/enriched_customers_full.json",
                ),
              ),
              jsonReader.readCachedJson<Array<Record<string, unknown>>>(
                resolve(cwd, "enriched_customers_full.json"),
              ),
            ]);
          const backtestJson = backtestCached?.value ?? {
            customerLeaderboard: [],
          };
          const fixtureJson = fixtureCached?.value ?? [];
          const {
            KEY_NUMBER_BUYER_PROFILES,
            HALF_POINT_HOOK_SYNDICATE_PROFILES,
          } = await import("../lib/customer_profile.ts");

          const payload = computeCustomersCohortPayload({
            backtestLeaderboard: backtestJson.customerLeaderboard ?? [],
            fixtures: fixtureJson,
            localBookRows: localBookCached?.value,
            keyNumberBuyerIds: KEY_NUMBER_BUYER_PROFILES.keys(),
            hookSyndicateIds: HALF_POINT_HOOK_SYNDICATE_PROFILES.keys(),
          });
          return {
            versionStamp: `dev-customers|${backtestCached?.stamp ?? "none"}|${fixtureCached?.stamp ?? "none"}|${localBookCached?.stamp ?? "none"}`,
            payload,
          };
        },
        getProfile: async (id) => {
          const row = await findCustomerRow(id);
          if (!row) return null;
          const { buildComprehensiveCustomerProfile } =
            await import("../lib/customer_profiling_enhanced.ts");
          return buildComprehensiveCustomerProfile(row);
        },
        getRating: async (id) => {
          const row = await findCustomerRow(id);
          if (!row) return null;
          const [
            { CustomerObservations },
            {
              rateCustomerFromObservations,
              computeBayesianSkillProfile,
              computeKellyMetrics,
            },
            { buildPortfolioRiskForensics },
          ] = await Promise.all([
            import("../lib/customer_profile.ts"),
            import("../lib/customer_rating.ts"),
            import("../lib/customer_profiling_enhanced.ts"),
          ]);
          const tickets = Array.isArray(row.recent_tickets)
            ? (row.recent_tickets as unknown as readonly TicketRow[])
            : [];
          const riskForensics = buildPortfolioRiskForensics(row, tickets);
          const obs = new CustomerObservations(
            String(row.customer_id ?? id),
            tickets.length,
            riskForensics.lifetimeVolumeUsd,
            riskForensics.lifetimeNetUsd,
            [],
            "2026-10-01",
            "2026-11-09",
          );
          const baseRating = rateCustomerFromObservations(obs);
          const bayesianSkill = computeBayesianSkillProfile([]);
          const kellyMetrics = computeKellyMetrics(
            -110,
            bayesianSkill.posteriorMeanWinRate,
            obs.nTickets > 0 ? obs.totalRiskUsd / obs.nTickets : 100,
          );
          return {
            ...baseRating,
            bayesianSkill,
            kellyMetrics,
          };
        },
      },
      execTerminal: (command, dims) => executeTerminalQuery(command, dims),
      rankings: {
        getAll: async (limit) => {
          const { runBatchedRanking } =
            await import("../lib/customer_rankings.ts");
          const data = await runBatchedRanking({ limitPlayers: limit });
          return {
            generatedAtIso: data.generatedAtIso,
            payload: data,
          };
        },
        getConduits: async () => {
          const { runBatchedRanking } =
            await import("../lib/customer_rankings.ts");
          const data = await runBatchedRanking({ limitPlayers: 50 });
          return data.topSubAgents.filter((s) => s.isProxyConduit);
        },
      },
      getLiveWagersPayload: () => buildLiveWagersPayload(),
      getTiersConfig: async () => {
        const { loadTomlConfig } = await import("../lib/wager_config.ts");
        return loadTomlConfig();
      },
      alerts: {
        sweepOnce: () => alertDispatcher.sweepOnce(),
        list: (status) => listAlerts(status),
        ack: async (input) => acknowledgeAlert(input),
        retry: async (input) => retryAlert(input),
        getShiftSummary: (operatorId) => getShiftSummary(operatorId),
      },
      getTaxonomyCatalog: () => SUBSPORT_TAXONOMY_CATALOG,
      runShadowPricing: (params) => runShadowPricingDashboard(params),
      forceShadowFixture: options.forceShadowFixture,
      shadowDbPath: options.shadowDbPath,
      getBuildMatrix: async () => {
        if (!cachedDceMatrix) {
          cachedDceMatrix = await computeDashboardDceMatrix();
        }
        return cachedDceMatrix;
      },
    },
    { clients },
  );

  const uiRoutes = {
    "/": indexHtml,
    "/dashboard": indexHtml,
    "/index.js": {
      GET: async (req: Request): Promise<Response> => {
        const bundle = await ensureLegacyBundle();
        if (bundle === null) {
          return new Response("console.error('Bundle compilation failed');", {
            status: 500,
            headers: { "Content-Type": "application/javascript" },
          });
        }
        const baseHeaders = {
          "Cache-Control": "no-cache",
          ETag: bundle.jsEtag,
        };
        if (req.headers.get("if-none-match") === bundle.jsEtag) {
          return new Response(null, { status: 304, headers: baseHeaders });
        }
        return encodedResponse(req, {
          version: `dev-index-js|${bundle.jsEtag}`,
          contentType: "application/javascript; charset=utf-8",
          produce: () => bundle.jsBytes,
          headers: baseHeaders,
        });
      },
    },
    "/index.css": {
      GET: async (req: Request): Promise<Response> => {
        const bundle = await ensureLegacyBundle();
        if (
          bundle === null ||
          bundle.cssBytes === null ||
          bundle.cssEtag === null
        ) {
          return new Response("/* No CSS emitted */", {
            headers: {
              "Content-Type": "text/css; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          });
        }
        const baseHeaders = {
          "Cache-Control": "no-cache",
          ETag: bundle.cssEtag,
        };
        if (req.headers.get("if-none-match") === bundle.cssEtag) {
          return new Response(null, { status: 304, headers: baseHeaders });
        }
        return encodedResponse(req, {
          version: `dev-index-css|${bundle.cssEtag}`,
          contentType: "text/css; charset=utf-8",
          produce: () => bundle.cssBytes!,
          headers: baseHeaders,
        });
      },
    },
  };

  const server: Server<undefined> = Bun.serve({
    port,
    hostname,
    routes: apiOnly ? api.routes : { ...uiRoutes, ...api.routes },
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const upgraded = srv.upgrade(req);
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return new Response("Not Found", { status: 404 });
    },
    websocket: api.websocket,
  });
  serverRef = server;

  if (options.watchFiles !== false) {
    try {
      if (!apiOnly) {
        watchers.push(
          watch(dashboardMdPath, () => {
            markdownCache.invalidate();
            api.publishTopic("dashboard", "dashboard-updated");
          }),
        );

        const hmrWatchDirs = [
          resolve(cwd, "packages/ui/src"),
          resolve(cwd, "packages/contracts/src"),
          resolve(cwd, "src/dashboard"),
        ];
        for (const dir of hmrWatchDirs) {
          if (!existsSync(dir)) continue;
          watchers.push(
            watch(dir, { recursive: true }, () => {
              cachedDceMatrix = null;
              cachedLegacyBundle = null;
              api.publishTopic("dashboard", "reload");
            }),
          );
        }
      }

      const dataDir = resolve(cwd, "data");
      if (existsSync(dataDir)) {
        watchers.push(
          watch(dataDir, (_eventType, filename) => {
            if (!filename || filename === "live-wagers.json") {
              clearWagersCache();
              api.publishTopic(
                "live-bets",
                JSON.stringify({
                  type: "topic-event",
                  topic: "live-bets",
                  event: "wagers-updated",
                  timestamp: new Date().toISOString(),
                }),
              );
            }
          }),
        );
      }

      watchers.push(
        watch(wagerTiersTomlPath, async () => {
          try {
            const { reloadTomlConfigIfChanged } =
              await import("../lib/wager_config.ts");
            const { changed, config } = await reloadTomlConfigIfChanged();
            if (changed) {
              api.publishTopic(
                "tiers-updated",
                JSON.stringify({ type: "tiers-updated", tiers: config.tiers }),
              );
            }
          } catch (err) {
            console.warn("File watch reload failed for wager_tiers.toml:", err);
          }
        }),
      );
    } catch (err) {
      console.warn("File watch initialized with fallback:", err);
    }
  }

  return {
    server,
    url: server.url,
    port: server.port ?? port,
    stop(closeActiveConnections = true) {
      alertDispatcher.stop();
      for (const w of watchers) {
        w.close();
      }
      server.stop(closeActiveConnections);
    },
  };
}

if (import.meta.main) {
  if (typeof process !== "undefined" && typeof process.on === "function") {
    try {
      process.on("memoryPressure", (level: string) => {
        console.warn(
          `[SportsDesk Dev Server] Host memory pressure: ${level}. Reclaiming build cache.`,
        );
      });
    } catch {
      // signal-honesty: intentional-unsupported-memory-pressure-event
    }
  }

  const apiOnly = Bun.argv.includes("--api-only");
  prefetchSportsDeskEndpoints();
  const handle = startDashboardServer({ watchFiles: true, apiOnly });

  console.log(
    `\n⚡ SportsDesk ${apiOnly ? "API-Only" : "Enhanced Dashboard"} Server running!`,
  );
  console.log(`   ➜ Local URL:    ${handle.url.href}`);
  console.log(`   ➜ Health Probe: ${handle.url.href}health`);
  console.log(`   ➜ Markdown API: ${handle.url.href}api/dashboard`);
  console.log(`   ➜ Shadow API:   ${handle.url.href}api/shadow-pricing`);
  console.log(`   ➜ Tiers Config: ${handle.url.href}api/config/tiers`);
  console.log(`   ➜ DCE Matrix:   ${handle.url.href}api/build-matrix`);
  console.log(`   ➜ DNS Cache:    ${handle.url.href}api/dns`);
  console.log(
    `   ➜ WebSocket:    ws://${handle.url.host}/ws (Topics: dashboard, live-bets, syndicate-alerts, tiers-updated)\n`,
  );
}
