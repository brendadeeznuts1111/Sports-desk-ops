/**
 * @file scripts/dev_dashboard.ts
 * @description Native Bun-Powered Enhanced Dashboard & Surveillance Server.
 *
 * Implements:
 *  - Declarative `Bun.serve({ routes })` routing with native HTML bundle import (`src/dashboard/index.html`)
 *  - Operator authentication, session cookies, and CSRF validation (`/api/auth/*`)
 *  - Throttled O(1) `/health` probe, surveillance alert DLQ (`ack`, `retry`, `sweep`), and `/api/shift/summary`
 *  - Declarative `config/wager_tiers.toml` v3 API (`/api/config/tiers`) + hot reload over WebSockets
 *  - Compile-time `bun:bundle` dead-code elimination matrix inspection (`/api/build-matrix`)
 *  - Sub-2ms TypedArray arena counterfactual shadow-pricing & elasticity API (`/api/shadow-pricing`)
 *  - Hot-reloading over native WebSockets for React components, `dashboard.md`, and `wager_tiers.toml`
 */

import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import indexHtml from "../src/dashboard/index.html";
import { AlertDispatcher } from "../lib/alerts.ts";
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
import { SUBSPORT_TAXONOMY_CATALOG } from "../lib/market_taxonomy_catalog.ts";
import {
  type MarketFilter,
  type PeriodFilter,
  type RouterAuditMode,
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
  readonly server: Server<undefined>;
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

function parseRouterAuditMode(
  raw: string | null | undefined,
): RouterAuditMode | undefined {
  if (raw === "observed_ledger" || raw === "enforced_lockout") return raw;
  return undefined;
}

function isAuthRequired(): boolean {
  return process.env.NODE_ENV === "production"
    ? process.env.SPORTSDESK_AUTH_DISABLED !== "1"
    : process.env.SPORTSDESK_AUTH_REQUIRED === "1";
}

async function enforceOptionalAuth(req: Request): Promise<Response | null> {
  if (!isAuthRequired()) return null;
  const authRes = await requireSession(req, async () => new Response("OK"));
  if (authRes.status !== 200) return authRes;
  const csrfRes = await requireCsrf(req, async () => new Response("OK"));
  if (csrfRes.status !== 200) return csrfRes;
  return null;
}

async function findCustomerRow(id: string): Promise<CustomerRow | null> {
  const normId = id.trim().toUpperCase();
  const candidatePaths = [
    resolve(process.cwd(), "enriched_customers_full.json"),
    resolve(
      process.cwd(),
      "tests/fixtures/backtest/enriched_customers_full.json",
    ),
    resolve(
      process.cwd(),
      "tests/fixtures/verify-load/enriched_customers_full.json",
    ),
  ];
  for (const enrichedPath of candidatePaths) {
    const enrichedFile = Bun.file(enrichedPath);
    if (await enrichedFile.exists()) {
      try {
        const rows = (await enrichedFile.json()) as CustomerRow[];
        if (Array.isArray(rows)) {
          const found = rows.find(
            (r) =>
              typeof r.customer_id === "string" &&
              r.customer_id.trim().toUpperCase() === normId,
          );
          if (found) return found;
        }
      } catch {
        // signal-honesty: intentional-fallback-invalid-json-candidate
      }
    }
  }
  const profilesPath = resolve(process.cwd(), "data/customer-profiles.json");
  const profilesFile = Bun.file(profilesPath);
  if (await profilesFile.exists()) {
    try {
      const data = (await profilesFile.json()) as {
        profiles?: CustomerRow[];
      };
      if (Array.isArray(data?.profiles)) {
        const found = data.profiles.find((p) => {
          const custId =
            typeof p.customer_id === "string"
              ? p.customer_id
              : typeof (p as { customerId?: unknown }).customerId === "string"
                ? String((p as { customerId?: unknown }).customerId)
                : "";
          return custId.trim().toUpperCase() === normId;
        });
        if (found) return found;
      }
    } catch {
      // signal-honesty: intentional-fallback-invalid-profiles-json
    }
  }
  return null;
}

async function loadDevLiveWagers(): Promise<Array<Record<string, unknown>>> {
  const candidatePaths = [
    resolve(process.cwd(), "data/live-wagers.json"),
    resolve(process.cwd(), "tests/fixtures/live-wagers.partial.json"),
    resolve(process.cwd(), "tests/fixtures/live-wagers-LIST-100.json"),
    resolve(process.cwd(), "tests/fixtures/live-wagers-list-sample.json"),
  ];

  for (const p of candidatePaths) {
    const file = Bun.file(p);
    if (await file.exists()) {
      try {
        const data = (await file.json()) as
          | {
              LIST?: Array<Record<string, unknown>>;
              wagers?: Array<Record<string, unknown>>;
            }
          | Array<Record<string, unknown>>
          | null;
        const list = Array.isArray(
          (data as { LIST?: Array<Record<string, unknown>> })?.LIST,
        )
          ? (data as { LIST: Array<Record<string, unknown>> }).LIST
          : Array.isArray(
                (data as { wagers?: Array<Record<string, unknown>> })?.wagers,
              )
            ? (data as { wagers: Array<Record<string, unknown>> }).wagers
            : Array.isArray(data)
              ? (data as Array<Record<string, unknown>>)
              : null;
        if (list && list.length > 0) {
          const { parseShortDesc } = await import("../lib/live_wagers.ts");
          const { KEY_NUMBER_BUYER_PROFILES } =
            await import("../lib/customer_profile.ts");

          return list.map((item: Record<string, unknown>, idx: number) => {
            const rawDesc =
              item.ShortDesc ?? item.shortDesc ?? item.description ?? "";
            const parsed = parseShortDesc(rawDesc);
            const firstLeg = parsed.legs[0];
            const customerId = String(
              item.CustomerID ??
                item.customerId ??
                item.Login ??
                item.login ??
                `CUST-${idx}`,
            ).trim();
            const riskUsd = Number(
              item.AmountWagered ?? item.amountWagered ?? item.riskUsd ?? 500,
            );
            const toWinUsd = Number(
              item.ToWinAmount ??
                item.toWinUsd ??
                item.toWinAmount ??
                Math.round(riskUsd * 0.9),
            );
            const isSharp = KEY_NUMBER_BUYER_PROFILES.has(
              customerId.toUpperCase(),
            );
            const clvCents =
              typeof item.clvCents === "number"
                ? item.clvCents
                : isSharp
                  ? 12.5
                  : riskUsd >= 5000
                    ? 8.2
                    : -2.4;

            let alertTier = "RECREATIONAL";
            let alertBadge = "✅ RECREATIONAL";
            let operatorDirective = "Accept Normal (autoExecute: false)";
            let maxRecommendedStake = 25000;

            if (clvCents >= 10 || isSharp) {
              alertTier = "CRITICAL";
              alertBadge = isSharp
                ? "🚨 CRITICAL (T1 Originator)"
                : "🚨 CRITICAL (High CLV)";
              operatorDirective = "Clamp Max $250 (autoExecute: false)";
              maxRecommendedStake = 250;
            } else if (clvCents >= 5) {
              alertTier = "STEAM";
              alertBadge = "⚡ STEAM (Line Mover)";
              operatorDirective = "Clamp Max $500 (autoExecute: false)";
              maxRecommendedStake = 500;
            } else if (parsed.isLive || item.live) {
              alertTier = "LATENCY";
              alertBadge = "⚠️ LATENCY (In-Play)";
              operatorDirective = "Delay 3s + Cap $1,000 (autoExecute: false)";
              maxRecommendedStake = 1000;
            }

            return {
              ticketId: String(
                item.WagerNumber ?? item.ticketId ?? `W-${109280 + idx}`,
              ),
              timestamp:
                typeof item.InsertDateTime === "string" ||
                typeof item.InsertDateTime === "number"
                  ? new Date(item.InsertDateTime).toLocaleTimeString() + " ET"
                  : String(item.timestamp ?? "14:30:00 ET"),
              customerId,
              agentId: String(item.AgentID ?? item.agentId ?? "AG01").trim(),
              masterAgent: String(
                item.AgentLogin ?? item.masterAgent ?? "MASTER_A",
              ).trim(),
              sport:
                firstLeg?.sport?.toUpperCase() || (item.sport ?? "FOOTBALL"),
              betType:
                item.WagerType === "M"
                  ? "Moneyline"
                  : item.WagerType === "S"
                    ? "Spread"
                    : item.WagerType === "P"
                      ? "Parlay"
                      : (item.betType ?? "Straight"),
              event: firstLeg?.game || (item.event ?? "Event Matchup"),
              selection: firstLeg?.pick || (item.selection ?? "Selection"),
              lineDisplay: firstLeg?.pick || (item.lineDisplay ?? "ML"),
              oddsAmerican:
                typeof item.oddsAmerican === "string"
                  ? item.oddsAmerican
                  : "-110",
              riskUsd,
              toWinUsd,
              clvCents,
              alertTier,
              alertBadge,
              operatorDirective,
              maxRecommendedStake,
              autoExecute: false as const,
            };
          });
        }
      } catch {
        // signal-honesty: intentional-fallback-next-wagers-fixture
      }
    }
  }
  return [];
}

const FALLBACK_DEV_WAGERS: Array<Record<string, unknown>> = [
  {
    ticketId: "W-109281",
    timestamp: "14:32:01 ET",
    customerId: "GP301",
    agentId: "AG99",
    masterAgent: "MASTER_VEND",
    sport: "NFL",
    betType: "Total",
    event: "Kansas City Chiefs @ Buffalo Bills",
    selection: "Under",
    lineDisplay: "47½",
    oddsAmerican: "-110",
    riskUsd: 5500,
    toWinUsd: 5000,
    clvCents: 14.2,
    alertTier: "CRITICAL",
    alertBadge: "🚨 CRITICAL (T1 Originator)",
    operatorDirective: "Clamp Max $250 (autoExecute: false)",
    maxRecommendedStake: 250,
    autoExecute: false,
  },
  {
    ticketId: "W-109282",
    timestamp: "14:32:15 ET",
    customerId: "CCC88412",
    agentId: "FATSNOBOT",
    masterAgent: "NOLAWOLF",
    sport: "CFB",
    betType: "Spread",
    event: "Georgia @ Texas",
    selection: "Texas",
    lineDisplay: "+3½",
    oddsAmerican: "-105",
    riskUsd: 5250,
    toWinUsd: 5000,
    clvCents: 11.5,
    alertTier: "STEAM",
    alertBadge: "🚨 STEAM (Key Number 3)",
    operatorDirective: "Clamp Max $250 (autoExecute: false)",
    maxRecommendedStake: 250,
    autoExecute: false,
  },
  {
    ticketId: "W-109288",
    timestamp: "14:34:25 ET",
    customerId: "RF2003",
    agentId: "FAKEMONEY",
    masterAgent: "NOLAWOLF",
    sport: "SOCCER",
    betType: "Total",
    event: "Real Madrid vs Barcelona",
    selection: "Over",
    lineDisplay: "3½ Goals",
    oddsAmerican: "+130",
    riskUsd: 25000,
    toWinUsd: 32500,
    clvCents: -4.2,
    alertTier: "RECREATIONAL",
    alertBadge: "✅ RECREATIONAL (Whale)",
    operatorDirective: "Accept Normal ($25k) (autoExecute: false)",
    maxRecommendedStake: 25000,
    autoExecute: false,
  },
];

export function startDashboardServer(
  options: DashboardServerOptions = {},
): DashboardServerHandle {
  const port =
    options.port !== undefined ? options.port : Number(Bun.env.PORT) || 4022;
  const hostname = options.hostname ?? "127.0.0.1";
  const dashboardMdPath = resolve(process.cwd(), "dashboard.md");
  const dashboardEntryPath = resolve(process.cwd(), "src/dashboard/index.tsx");
  const wagerTiersTomlPath = resolve(process.cwd(), "config/wager_tiers.toml");

  const clients = new Set<ServerWebSocket<unknown>>();
  const watchers: FSWatcher[] = [];

  const alertDispatcher = new AlertDispatcher({
    sweepIntervalMs: 5000,
  });
  if (options.watchFiles !== false) {
    alertDispatcher.start();
  }

  let lastDbProbe = 0;
  let lastSweep = 0;
  let lastAlertProbe = 0;
  const DB_PROBE_MS = 5_000;
  const SWEEP_MS = 5 * 60_000;
  const ALERT_PROBE_MS = 15_000;
  let cachedDbStatus = "unconfigured";
  let cachedAlertMetrics = alertDispatcher.getHealthMetrics();

  let cachedDceMatrix: Awaited<
    ReturnType<typeof computeDashboardDceMatrix>
  > | null = null;

  const buildDnsPayload = () => {
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
  };

  const buildLiveWagersPayload = async () => {
    let wagers = await loadDevLiveWagers();
    if (wagers.length === 0) {
      wagers = FALLBACK_DEV_WAGERS;
    }
    return {
      wagers,
      totalRiskUsd: wagers.reduce(
        (sum, w: Record<string, unknown>) => sum + (Number(w.riskUsd) || 0),
        0,
      ),
      totalToWinUsd: wagers.reduce(
        (sum, w: Record<string, unknown>) => sum + (Number(w.toWinUsd) || 0),
        0,
      ),
      criticalSteamCount: wagers.filter(
        (w: Record<string, unknown>) =>
          w.alertTier === "CRITICAL" || w.alertTier === "STEAM",
      ).length,
      autoExecute: false,
      timestamp: new Date().toISOString(),
    };
  };

  const server: Server<undefined> = Bun.serve({
    port,
    hostname,
    routes: {
      "/": indexHtml,
      "/dashboard": indexHtml,

      // Health check endpoint for operator & agent diagnostics (throttled to avoid DB/Disk DoS)
      "/health": {
        GET: async (): Promise<Response> => {
          const now = Date.now();
          let purgedSessions = 0;

          if (process.env.PGUSER && process.env.PGPASSWORD) {
            if (now - lastDbProbe > DB_PROBE_MS) {
              lastDbProbe = now;
              try {
                const { sql } = await import("../lib/db.ts");
                await sql`SELECT 1`;
                cachedDbStatus = "connected";
              } catch (err) {
                cachedDbStatus = `error: ${err instanceof Error ? err.message : String(err)}`;
              }
            }

            if (now - lastSweep > SWEEP_MS) {
              lastSweep = now;
              try {
                const { sessionCleanup } = await import("../lib/session.ts");
                purgedSessions = await sessionCleanup();
              } catch {
                // signal-honesty: intentional-fire-and-forget-session-cleanup
              }
            }
          }

          if (now - lastAlertProbe > ALERT_PROBE_MS) {
            lastAlertProbe = now;
            cachedAlertMetrics = alertDispatcher.getHealthMetrics();
          }

          const overallStatus =
            cachedAlertMetrics.status === "degraded"
              ? "degraded"
              : cachedAlertMetrics.status === "warning"
                ? "warning"
                : "ok";

          return Response.json({
            status: overallStatus,
            service: "sportsdesk-dev-dashboard",
            port: server.port ?? port,
            bunVersion: Bun.version,
            uptimeSeconds: Math.floor(process.uptime()),
            db: cachedDbStatus,
            purgedSessions,
            alerts: cachedAlertMetrics,
            timestamp: new Date().toISOString(),
          });
        },
      },

      // Operator Auth Endpoints
      "/api/auth/login": {
        POST: (req) => handleLogin(req, server),
      },
      "/api/auth/logout": {
        POST: (req) => handleLogout(req),
      },
      "/api/auth/me": {
        GET: (req) => handleSessionMe(req),
      },

      // API: Real-time dashboard.md parsed via Bun.markdown.html
      "/api/dashboard": {
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;

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

      // API: Real-time DNS Cache Telemetry (canonical + alias)
      "/api/dns": {
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
          return Response.json(buildDnsPayload());
        },
      },
      "/api/dns/telemetry": {
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
          return Response.json(buildDnsPayload());
        },
      },

      // API: DNS Resolver Latency Benchmark
      "/api/dns/benchmark": {
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
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
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
          const url = new URL(req.url);
          const ip = url.searchParams.get("ip") || "1.1.1.1";
          const result = await classifyIpAddress(ip);
          return Response.json(result);
        },
      },

      // API: Customer Profiling & Behavioral Sharp Showcase (dynamic counts, zero hardcoding)
      "/api/customers": {
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;

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

          const {
            KEY_NUMBER_BUYER_PROFILES,
            HALF_POINT_HOOK_SYNDICATE_PROFILES,
          } = await import("../lib/customer_profile.ts");

          const uniqueSurveillanceIds = new Set<string>();
          for (const row of backtestJson.customerLeaderboard ?? []) {
            const id =
              (row as Record<string, unknown>).customer ??
              (row as Record<string, unknown>).customerId ??
              (row as Record<string, unknown>).customer_id;
            if (id) uniqueSurveillanceIds.add(String(id).trim().toUpperCase());
          }
          for (const row of fixtureJson) {
            const id =
              (row as Record<string, unknown>).customer_id ??
              (row as Record<string, unknown>).customerId;
            if (id) uniqueSurveillanceIds.add(String(id).trim().toUpperCase());
          }
          for (const key of KEY_NUMBER_BUYER_PROFILES.keys()) {
            uniqueSurveillanceIds.add(key.trim().toUpperCase());
          }
          for (const key of HALF_POINT_HOOK_SYNDICATE_PROFILES.keys()) {
            uniqueSurveillanceIds.add(key.trim().toUpperCase());
          }

          return Response.json({
            cohorts: {
              backtestCount: backtestJson.customerLeaderboard?.length ?? 0,
              keyNumberSharpsCount: KEY_NUMBER_BUYER_PROFILES.size,
              hookSyndicateCount: HALF_POINT_HOOK_SYNDICATE_PROFILES.size,
              fixtureCount: fixtureJson.length,
              fullBookSpecCount: fixtureJson.length,
              uniqueSurveillanceCount: uniqueSurveillanceIds.size,
            },
            backtestTop: (backtestJson.customerLeaderboard ?? []).slice(0, 20),
            fixtures: fixtureJson,
          });
        },
      },

      // API: Customer profiling: unified behavioral forensics & composite sharpness
      "/api/customer/profile": {
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;

          const url = new URL(req.url);
          const id = (url.searchParams.get("id") ?? "").trim();
          if (!id) {
            return Response.json(
              { success: false, error: "Missing required parameter 'id'" },
              { status: 400 },
            );
          }
          const row = await findCustomerRow(id);
          if (!row) {
            return Response.json(
              { success: false, error: `Customer '${id}' not found` },
              { status: 404 },
            );
          }
          const { buildComprehensiveCustomerProfile } =
            await import("../lib/customer_profiling_enhanced.ts");
          const profile = buildComprehensiveCustomerProfile(row);
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

      // API: Customer rating: Bayesian skill profile, Kelly sizing & statistical CLV
      "/api/customer/rating": {
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;

          const url = new URL(req.url);
          const id = (url.searchParams.get("id") ?? "").trim();
          if (!id) {
            return Response.json(
              { success: false, error: "Missing required parameter 'id'" },
              { status: 400 },
            );
          }
          const row = await findCustomerRow(id);
          if (!row) {
            return Response.json(
              { success: false, error: `Customer '${id}' not found` },
              { status: 404 },
            );
          }
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
          return Response.json(
            {
              success: true,
              rating: {
                ...baseRating,
                bayesianSkill,
                kellyMetrics,
              },
              generatedAt: new Date().toISOString(),
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        },
      },

      // API: PTY Terminal Emulator Execution powered by Bun.Terminal & Bun.spawn
      "/api/terminal/exec": {
        POST: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
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
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
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
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
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

      // API: Live Incoming Wager Feed & Surveillance Alerts (canonical + alias)
      "/api/wagers": {
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
          return Response.json(await buildLiveWagersPayload());
        },
      },
      "/api/live-wagers": {
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
          return Response.json(await buildLiveWagersPayload());
        },
      },

      // API: Wager Tiers and Surveillance TOML Configuration (Bun.TOML v3)
      "/api/config/tiers": {
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
          try {
            const { loadTomlConfig } = await import("../lib/wager_config.ts");
            const config = await loadTomlConfig();
            return Response.json(config);
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 500 },
            );
          }
        },
      },

      // API: Surveillance Alert Queue Drain Sweep Trigger
      "/api/alerts/sweep": {
        POST: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
          const sweep = await alertDispatcher.sweepOnce();
          return Response.json({ ok: true, sweep });
        },
      },

      // API: Surveillance Alerts Query (DLQ, queued, delivered, acknowledged, all)
      "/api/alerts": {
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
          const url = new URL(req.url);
          const statusParam = (
            url.searchParams.get("status") ?? "all"
          ).toLowerCase();
          const { listAlerts } = await import("../lib/alerts.ts");
          const alerts = listAlerts(statusParam);
          return Response.json({
            alerts,
            total: alerts.length,
            status: statusParam,
            timestamp: new Date().toISOString(),
          });
        },
      },

      // API: Acknowledge Alert
      "/api/alerts/:id/ack": {
        POST: async (req) => {
          const denied = await enforceOptionalAuth(req);
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
          const { acknowledgeAlert } = await import("../lib/alerts.ts");
          const ok = await acknowledgeAlert({
            deliveryId,
            operatorId: body.operatorId ?? "operator",
            notes: body.notes,
          });
          return Response.json({ ok, deliveryId });
        },
      },

      // API: Replay from DLQ
      "/api/alerts/:id/retry": {
        POST: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
          const deliveryId = req.params.id;
          let body: { operatorId?: string } = {};
          try {
            body = (await req.json()) as { operatorId?: string };
          } catch {
            // signal-honesty: intentional-empty-json-body-allowed
          }
          const { retryAlert } = await import("../lib/alerts.ts");
          const newDeliveryId = await retryAlert({
            deliveryId,
            operatorId: body.operatorId ?? "operator",
          });
          if (!newDeliveryId) {
            return Response.json(
              { error: "Alert not found in dead-letter state" },
              { status: 404 },
            );
          }
          return Response.json({
            ok: true,
            originalDeliveryId: deliveryId,
            newDeliveryId,
          });
        },
      },

      // API: Shift Summary (Shift handoff aggregation of alerts, queries, and auth)
      "/api/shift/summary": {
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
          const url = new URL(req.url);
          const operatorId = url.searchParams.get("operatorId") ?? "operator";
          const { getShiftSummary } = await import("../lib/alerts.ts");
          const summary = getShiftSummary(operatorId);
          return Response.json(summary);
        },
      },

      // API: Canonical 4-Level Market Taxonomy Catalog (Sport -> SubSport -> Period per SubSport -> Market)
      "/api/taxonomy-catalog": {
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
          return Response.json({
            schemaVersion: 1,
            catalog: SUBSPORT_TAXONOMY_CATALOG,
          });
        },
      },

      // API: Counterfactual Shadow-Pricing & Hierarchical Taxonomy Cube (#135)
      "/api/shadow-pricing": {
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
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
        POST: async (req) => {
          const denied = await enforceOptionalAuth(req);
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

      // API: Compile-Time bun:bundle DCE Target Matrix
      "/api/build-matrix": {
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
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
        GET: async (req) => {
          const denied = await enforceOptionalAuth(req);
          if (denied) return denied;
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
              "tiers-updated",
              "proxy-conduits",
              "terminal-logs",
            ],
            timestamp: new Date().toISOString(),
          });
        },
      },

      // Legacy on-demand JS/CSS bundle endpoints for compatibility
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

          const jsOutput =
            build.outputs.find(
              (o) => o.kind === "entry-point" || o.path.endsWith(".js"),
            ) ?? build.outputs[0];
          if (!jsOutput) {
            return new Response("Missing output", { status: 500 });
          }
          return new Response(await jsOutput.text(), {
            headers: {
              "Content-Type": "application/javascript",
              "Cache-Control": "no-cache",
            },
          });
        },
      },

      "/index.css": {
        GET: async () => {
          const build = await runBunBuild({
            entrypoints: [dashboardEntryPath],
            target: "browser",
            sourcemap: "inline",
          });
          const cssOutput = build.outputs.find(
            (o) => o.kind === "asset" && o.path.endsWith(".css"),
          );
          if (!cssOutput) {
            return new Response("/* No CSS emitted */", {
              headers: { "Content-Type": "text/css" },
            });
          }
          return new Response(await cssOutput.text(), {
            headers: {
              "Content-Type": "text/css",
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
        ws.subscribe("tiers-updated");
        clients.add(ws);
      },
      message(ws, message) {
        try {
          const str =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message);
          if (str.startsWith("{")) {
            const parsed = JSON.parse(str) as {
              action?: "subscribe" | "unsubscribe";
              type?: string;
              topic?: string;
              topics?: string[];
            };
            const kind = parsed.type ?? parsed.action;
            if (kind === "subscribe" && parsed.topic) {
              ws.subscribe(parsed.topic);
              ws.send(
                JSON.stringify({
                  type: "subscribed",
                  topic: parsed.topic,
                  activeTopics: ws.subscriptions,
                }),
              );
            } else if (
              kind === "subscribe-all" ||
              (kind === "subscribe" && parsed.topics)
            ) {
              const list = parsed.topics ?? [
                "dashboard",
                "live-bets",
                "syndicate-alerts",
                "tiers-updated",
                "proxy-conduits",
                "terminal-logs",
              ];
              for (const t of list) ws.subscribe(t);
              ws.send(
                JSON.stringify({
                  type: "subscribed-many",
                  topics: list,
                  activeTopics: ws.subscriptions,
                }),
              );
            } else if (kind === "unsubscribe" && parsed.topic) {
              ws.unsubscribe(parsed.topic);
              ws.send(
                JSON.stringify({
                  type: "unsubscribed",
                  topic: parsed.topic,
                  activeTopics: ws.subscriptions,
                }),
              );
            } else if (kind === "query-subscriptions") {
              ws.send(
                JSON.stringify({
                  type: "subscriptions",
                  activeTopics: ws.subscriptions,
                }),
              );
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

      watchers.push(
        watch(wagerTiersTomlPath, async () => {
          try {
            const { reloadTomlConfigIfChanged } =
              await import("../lib/wager_config.ts");
            const { changed, config } = await reloadTomlConfigIfChanged();
            if (changed) {
              server.publish("tiers-updated", JSON.stringify(config));
              for (const ws of clients) {
                if (
                  !ws.subscriptions ||
                  ws.subscriptions.length === 0 ||
                  ws.subscriptions.includes("tiers-updated") ||
                  ws.subscriptions.includes("dashboard")
                ) {
                  ws.send("tiers-updated");
                }
              }
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

  prefetchSportsDeskEndpoints();
  const handle = startDashboardServer({ watchFiles: true });

  console.log(`\n⚡ SportsDesk Enhanced Dashboard Server running!`);
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
