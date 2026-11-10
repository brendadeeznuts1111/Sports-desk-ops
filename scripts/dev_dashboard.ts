/**
 * @file scripts/dev_dashboard.ts
 * @description Native Bun-Powered Enhanced Dashboard Server.
 *
 * Implements:
 *  - Declarative `Bun.serve({ routes })` routing with native HTML bundle import (`src/dashboard/index.html`)
 *  - Compile-time `bun:bundle` dead-code elimination matrix inspection (`/api/build-matrix`)
 *  - Sub-2ms TypedArray arena counterfactual shadow-pricing & elasticity API (`/api/shadow-pricing`)
 *  - Hot-reloading over native WebSockets for both React components and `dashboard.md`
 *  - Live Markdown-to-HTML rendering via `Bun.markdown.html`
 */

import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import indexHtml from "../src/dashboard/index.html";
import {
  benchmarkResolverLatency,
  classifyIpAddress,
  getDnsTelemetry,
  prefetchSportsDeskEndpoints,
  SPORTSDESK_CORE_HOSTS,
} from "../lib/bun_dns.ts";
import { SUBSPORT_TAXONOMY_CATALOG } from "../lib/market_taxonomy_catalog.ts";
import {
  type MarketFilter,
  type PeriodFilter,
  runShadowPricingDashboard,
  type ShadowRepriceMode,
  type SportFilter,
  type SubSportFilter,
} from "../lib/shadow_pricing_engine.ts";
import { executeTerminalQuery } from "../lib/terminal_emulator.ts";
import { runBunBuild } from "./build.ts";
import { computeDashboardDceMatrix } from "./build_dashboard.ts";

export interface DashboardServerOptions {
  readonly port?: number | undefined;
  readonly hostname?: string | undefined;
  readonly watchFiles?: boolean | undefined;
  readonly shadowDbPath?: string | undefined;
  readonly forceShadowFixture?: boolean | undefined;
}

export interface DashboardServerHandle {
  readonly server: Server<unknown>;
  readonly url: URL;
  readonly port: number;
  stop: (closeActiveConnections?: boolean) => void;
}

function parseFiniteNumber(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseRepriceMode(
  raw: string | null | undefined,
): ShadowRepriceMode | undefined {
  if (raw === "floor" || raw === "exact") return raw;
  return undefined;
}

export function startDashboardServer(
  options: DashboardServerOptions = {},
): DashboardServerHandle {
  const port =
    options.port !== undefined ? options.port : Number(Bun.env.PORT) || 4022;
  const hostname = options.hostname ?? "127.0.0.1";
  const dashboardMdPath = resolve(process.cwd(), "dashboard.md");
  const dashboardEntryPath = resolve(process.cwd(), "src/dashboard/index.tsx");

  const clients = new Set<ServerWebSocket<unknown>>();
  const watchers: FSWatcher[] = [];

  let cachedDceMatrix: Awaited<
    ReturnType<typeof computeDashboardDceMatrix>
  > | null = null;

  const server = Bun.serve({
    port,
    hostname,
    routes: {
      "/": indexHtml,
      "/dashboard": indexHtml,

      // API: Real-time dashboard.md parsed via Bun.markdown.html
      "/api/dashboard": {
        GET: async () => {
          const file = Bun.file(dashboardMdPath);
          if (!(await file.exists())) {
            return Response.json(
              { error: "dashboard.md not found" },
              { status: 404 },
            );
          }

          const markdown = await file.text();
          // trusted-markdown: local repo-owned dashboard.md rendered for operator dev server
          const html = Bun.markdown.html(markdown);
          return Response.json({
            markdown,
            html,
            updatedAt: new Date().toISOString(),
          });
        },
      },

      // API: Real-time DNS Cache Telemetry
      "/api/dns": {
        GET: () => {
          const telemetry = getDnsTelemetry();
          return Response.json({
            telemetry,
            hosts: SPORTSDESK_CORE_HOSTS,
            updatedAt: new Date().toISOString(),
          });
        },
      },

      // API: DNS Resolver Latency Benchmark
      "/api/dns/benchmark": {
        GET: async (req) => {
          const url = new URL(req.url);
          const host = url.searchParams.get("host") || "fantasy402.com";
          const result = await benchmarkResolverLatency(
            host,
            ["c-ares", "system"],
            3,
          );
          return Response.json(result);
        },
      },

      // API: Reverse DNS & Forensics IP Classification
      "/api/dns/reverse": {
        GET: async (req) => {
          const url = new URL(req.url);
          const ip = url.searchParams.get("ip") || "1.1.1.1";
          const result = await classifyIpAddress(ip);
          return Response.json(result);
        },
      },

      // API: Customer Profiling & Behavioral Sharp Showcase
      "/api/customers": {
        GET: async () => {
          const backtestFile = Bun.file("docs/backtest-4wk-cfb-nba.json");
          const backtestJson = (await backtestFile.exists())
            ? ((await backtestFile.json()) as {
                customerLeaderboard?: Array<Record<string, unknown>>;
              })
            : { customerLeaderboard: [] };

          const fixtureFile = Bun.file(
            "tests/fixtures/backtest/enriched_customers_full.json",
          );
          const fixtureJson = (await fixtureFile.exists())
            ? ((await fixtureFile.json()) as Array<Record<string, unknown>>)
            : [];

          return Response.json({
            cohorts: {
              backtestCount: backtestJson.customerLeaderboard?.length ?? 49,
              keyNumberSharpsCount: 5,
              hookSyndicateCount: 5,
              fixtureCount: fixtureJson.length,
              fullBookSpecCount: 220,
              uniqueSurveillanceCount: 4914,
            },
            backtestTop: (backtestJson.customerLeaderboard ?? []).slice(0, 20),
            fixtures: fixtureJson,
          });
        },
      },

      // API: PTY Terminal Emulator Execution powered by Bun.Terminal & Bun.spawn
      "/api/terminal/exec": {
        POST: async (req) => {
          try {
            const body = (await req.json()) as {
              command?: string;
              cols?: number;
              rows?: number;
            };
            const command = body.command?.trim() ?? "help";
            const result = await executeTerminalQuery(command, {
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

      // API: 30-Day Batched Player Rankings
      "/api/rankings/all": {
        GET: async (req) => {
          try {
            const url = new URL(req.url);
            const { runBatchedRanking } =
              await import("../lib/customer_rankings.ts");
            const limit = Number(url.searchParams.get("limit")) || 100;
            const data = await runBatchedRanking({ limitPlayers: limit });
            return Response.json(data);
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 500 },
            );
          }
        },
      },

      // API: Proxy Conduits
      "/api/agency/conduits": {
        GET: async () => {
          try {
            const { runBatchedRanking } =
              await import("../lib/customer_rankings.ts");
            const data = await runBatchedRanking({ limitPlayers: 50 });
            const conduits = data.topSubAgents.filter((s) => s.isProxyConduit);
            return Response.json({ conduits });
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 500 },
            );
          }
        },
      },

      // API: Canonical 4-Level Market Taxonomy Catalog (Sport -> SubSport -> Period per SubSport -> Market)
      "/api/taxonomy-catalog": {
        GET: () =>
          Response.json({
            schemaVersion: 1,
            catalog: SUBSPORT_TAXONOMY_CATALOG,
          }),
      },

      // API: Counterfactual Shadow-Pricing & Hierarchical Taxonomy Cube (#135)
      "/api/shadow-pricing": {
        GET: async (req) => {
          try {
            const url = new URL(req.url);
            const forceFixture =
              options.forceShadowFixture === true ||
              url.searchParams.get("source") === "fixture";
            const sportParam = url.searchParams.get("sport");
            const subSportParam = url.searchParams.get("subSport");
            const periodParam = url.searchParams.get("period");
            const marketParam = url.searchParams.get("market");
            const payload = await runShadowPricingDashboard({
              dbPath: options.shadowDbPath,
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
            });
            return Response.json(payload);
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 500 },
            );
          }
        },
        POST: async (req) => {
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
              source?: string;
            };
            const forceFixture =
              options.forceShadowFixture === true || body.source === "fixture";
            const payload = await runShadowPricingDashboard({
              dbPath: options.shadowDbPath,
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

      // API: Compile-Time bun:bundle DCE Target Matrix
      "/api/build-matrix": {
        GET: async () => {
          try {
            if (!cachedDceMatrix) {
              cachedDceMatrix = await computeDashboardDceMatrix();
            }
            return Response.json({
              schemaVersion: 1,
              targets: cachedDceMatrix,
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

      // API: WebSocket Status & Topic Subscriptions Telemetry
      "/api/ws/status": {
        GET: () => {
          const topicCounts: Record<string, number> = {};
          const clientSummaries: Array<{ id: number; topics: string[] }> = [];
          let clientId = 1;

          for (const ws of clients) {
            const subs = ws.subscriptions ?? [];
            clientSummaries.push({ id: clientId++, topics: subs });
            for (const topic of subs) {
              topicCounts[topic] = (topicCounts[topic] || 0) + 1;
            }
          }

          return Response.json({
            totalConnectedClients: clients.size,
            topicDistribution: topicCounts,
            clients: clientSummaries,
            serverTopics: [
              "dashboard",
              "live-bets",
              "syndicate-alerts",
              "proxy-conduits",
              "terminal-logs",
            ],
            timestamp: new Date().toISOString(),
          });
        },
      },

      // Legacy on-demand JS bundle endpoint for compatibility
      "/index.js": {
        GET: async () => {
          const build = await runBunBuild({
            entrypoints: [dashboardEntryPath],
            target: "browser",
            sourcemap: "inline",
          });

          if (!build.success || build.outputs.length === 0) {
            console.error("Build failed:", build.logs);
            return new Response("console.error('Bundle compilation failed');", {
              status: 500,
              headers: { "Content-Type": "application/javascript" },
            });
          }

          const output = build.outputs[0];
          if (!output) {
            return new Response("Missing output", { status: 500 });
          }
          return new Response(await output.text(), {
            headers: {
              "Content-Type": "application/javascript",
              "Cache-Control": "no-cache",
            },
          });
        },
      },

      // Wildcard 404 for unknown API routes
      "/api/*": Response.json(
        { error: "Dashboard API route not found" },
        { status: 404 },
      ),
    },

    fetch(req, srv) {
      const url = new URL(req.url);

      // WebSocket upgrade for hot reload & topic pub/sub
      if (url.pathname === "/ws") {
        const upgraded = srv.upgrade(req);
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(ws) {
        ws.subscribe("dashboard");
        ws.subscribe("live-bets");
        ws.subscribe("syndicate-alerts");
        clients.add(ws);
      },
      message(ws, message) {
        try {
          const str = typeof message === "string" ? message : "";
          if (str.startsWith("{")) {
            const parsed = JSON.parse(str) as {
              action?: "subscribe" | "unsubscribe";
              topic?: string;
            };
            if (parsed.action === "subscribe" && parsed.topic) {
              ws.subscribe(parsed.topic);
            } else if (parsed.action === "unsubscribe" && parsed.topic) {
              ws.unsubscribe(parsed.topic);
            }
          }
        } catch {
          // signal-honesty: intentional-ignore-nonjson-ws-ping
        }
      },
      close(ws) {
        clients.delete(ws);
      },
    },
  });

  if (options.watchFiles !== false) {
    try {
      watchers.push(
        watch(dashboardMdPath, () => {
          server.publish("dashboard", "dashboard-updated");
          for (const ws of clients) {
            if (
              !ws.subscriptions ||
              ws.subscriptions.length === 0 ||
              ws.subscriptions.includes("dashboard")
            ) {
              ws.send("dashboard-updated");
            }
          }
        }),
      );

      watchers.push(
        watch(
          resolve(process.cwd(), "src/dashboard"),
          { recursive: true },
          () => {
            cachedDceMatrix = null;
            server.publish("dashboard", "reload");
            for (const ws of clients) {
              if (
                !ws.subscriptions ||
                ws.subscriptions.length === 0 ||
                ws.subscriptions.includes("dashboard")
              ) {
                ws.send("reload");
              }
            }
          },
        ),
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

  prefetchSportsDeskEndpoints();
  const handle = startDashboardServer({ watchFiles: true });

  console.log(`\n⚡ SportsDesk Enhanced Dashboard Server running!`);
  console.log(`   ➜ Local URL:    ${handle.url.href}`);
  console.log(`   ➜ Markdown API: ${handle.url.href}api/dashboard`);
  console.log(`   ➜ Shadow API:   ${handle.url.href}api/shadow-pricing`);
  console.log(`   ➜ DCE Matrix:   ${handle.url.href}api/build-matrix`);
  console.log(`   ➜ DNS Cache:    ${handle.url.href}api/dns`);
  console.log(
    `   ➜ WebSocket:    ws://${handle.url.host}/ws (Topics: dashboard, live-bets, syndicate-alerts)\n`,
  );
}
