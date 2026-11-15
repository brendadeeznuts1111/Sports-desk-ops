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
  createAgentDetailService,
  createBetTickerService,
  createCachedJsonReader,
  createCustomerRowFinder,
  createDevLiveWagersLoader,
  createR2PipelineService,
  DashboardHealthTracker,
  DashboardMarkdownCache,
  isDashboardAuthRequired,
} from "@sportsdesk-ops/backend";
import {
  createDashboardApi,
  type EncodedResponseSpec,
} from "@sportsdesk-ops/api";
import type { AgentDetailApiResponse } from "@sportsdesk-ops/contracts";
import type { BunRequest, Server, ServerWebSocket } from "bun";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { resolve } from "node:path";
import {
  acknowledgeAlert,
  AlertDispatcher,
  getShiftSummary,
  listAlerts,
  retryAlert,
} from "../lib/alerts.ts";
import { containedAssetPath, isSafeAssetName } from "../lib/asset_path.ts";
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
import { parseShortDesc } from "../lib/live_wagers.ts";
import { isSentinelTickerWriter } from "@sportsdesk-ops/backend";
import { SLAB_SERVER } from "../lib/slab_config.ts";
import { inspectWagersWireContract } from "../lib/wagers_wire_contract.ts";
import { loadWagersTabPolicyStamp } from "../lib/wagers_tab_policy.ts";
import { SUBSPORT_TAXONOMY_CATALOG } from "../lib/market_taxonomy_catalog.ts";
import { runShadowPricingDashboard } from "../lib/shadow_pricing_engine.ts";
import {
  createSportsdeskMcpHttpHandler,
  resolveMcpAllowedOrigins,
} from "../lib/sportsdesk_mcp_server.ts";
import { executeTerminalQuery } from "../lib/terminal_emulator.ts";
import {
  PROXY_CONDUITS_30D,
  SAMPLE_PROFILE_DATA,
} from "../packages/ui/src/showcase_data.ts";
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
  readonly mcpStateless?: boolean | undefined;
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

const DEFAULT_COMPANION_4020_ORIGIN = "http://127.0.0.1:4020";

function escapeHtmlText(value: unknown): string {
  return Bun.escapeHTML(String(value ?? ""));
}

function renderAgentHtmlPage(detail: AgentDetailApiResponse): string {
  const esc = escapeHtmlText;
  const agentId = esc(detail.agentId);
  const master = detail.masterAgent
    ? `<a href="/agent/${encodeURIComponent(detail.masterAgent)}">${esc(detail.masterAgent)}</a>`
    : "Root / Unassigned";
  const childrenHtml =
    detail.childAgents.length > 0
      ? detail.childAgents
          .map(
            (child) =>
              `<a class="chip" href="/agent/${encodeURIComponent(child)}">${esc(child)}</a>`,
          )
          .join("")
      : '<span class="muted">No child agents indexed</span>';
  const customersHtml =
    detail.customers.length > 0
      ? `<table><thead><tr><th>Customer</th><th>Tier</th><th>Score</th><th>Limit</th><th>Hold %</th></tr></thead><tbody>${detail.customers
          .map(
            (c) =>
              `<tr><td><a href="/customer/${encodeURIComponent(c.id)}">${esc(c.id)}</a></td><td>${esc(c.tier)}</td><td>${esc(c.score.toFixed(1))}</td><td>$${esc(c.recommendedLimitUsd.toLocaleString())}</td><td>${esc(c.holdPct.toFixed(1))}%</td></tr>`,
          )
          .join("")}</tbody></table>`
      : '<p class="muted">No customers directly indexed for this agent.</p>';
  const wagersHtml =
    detail.recentWagers.length > 0
      ? `<table><thead><tr><th>Ticket</th><th>Customer</th><th>Selection</th><th>Writer</th><th>Risk</th><th>To Win</th><th>Tier</th></tr></thead><tbody>${detail.recentWagers
          .map(
            (w) =>
              `<tr><td>${esc(w.ticketId)}</td><td><a href="/customer/${encodeURIComponent(w.customerId)}">${esc(w.customerId)}</a></td><td>${esc(`${w.sport} ${w.betType} · ${w.selection}`)}</td><td>${esc(w.writer)}</td><td>$${esc(w.riskUsd.toLocaleString())}</td><td>$${esc(w.toWinUsd.toLocaleString())}</td><td>${esc(w.alertTier)}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : '<p class="muted">No recent wagers indexed for this agent in current live feed.</p>';
  const conduitCard = detail.conduit30d
    ? `<div class="card"><h2>30-Day Conduit Summary</h2><div class="grid"><div><span>Handle</span><strong>$${esc(detail.conduit30d.handleUsd.toLocaleString())}</strong></div><div><span>Wagers</span><strong>${esc(detail.conduit30d.wagers.toLocaleString())}</strong></div><div><span>Concentration</span><strong>${esc(detail.conduit30d.concentrationPct.toFixed(1))}%</strong></div><div><span>Proxy Conduit</span><strong>${detail.conduit30d.isProxyConduit ? "YES" : "NO"}</strong></div></div></div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent ${agentId} · SportsDesk Ops</title>
<style>
  body { margin: 0; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b1120; color: #e2e8f0; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 20px 48px; }
  .nav { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; font-size: 13px; }
  .nav a, a { color: #38bdf8; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 18px; }
  .btn { display: inline-block; padding: 8px 14px; border-radius: 6px; background: #0284c7; color: #ffffff; font-weight: 600; font-size: 13px; }
  .card { background: #111827; border: 1px solid #1e293b; border-radius: 10px; padding: 16px 18px; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .grid span { display: block; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
  .grid strong { font-size: 16px; color: #f8fafc; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .chip { padding: 4px 10px; border-radius: 999px; background: #1e293b; border: 1px solid #334155; font-size: 12px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1e293b; }
  th { color: #94a3b8; font-size: 11px; text-transform: uppercase; }
  .muted { color: #94a3b8; font-size: 13px; }
  h1 { margin: 0; font-size: 24px; }
  h2 { margin: 0 0 10px; font-size: 15px; color: #cbd5e1; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="nav">
      <a href="/">← SportsDesk Dashboard</a>
      <a href="/?tab=rankings">Rankings</a>
      <a href="/?tab=bet-ticker">Bet Ticker</a>
      <a href="/?tab=r2">R2 Pipeline</a>
      <a href="/graph">Graph Explorer</a>
      <a href="/api/agent/${encodeURIComponent(detail.agentId)}">JSON API</a>
    </div>
    <div class="header">
      <div>
        <h1>Agent ${agentId}</h1>
        <div class="muted">${detail.found ? "Indexed in hierarchy/feed" : "No hierarchy node found for this agent ID"} · autoExecute: false</div>
      </div>
      <a class="btn" href="/?agent=${encodeURIComponent(detail.agentId)}">Open in Interactive Inspector ↗</a>
    </div>
    <div class="card">
      <div class="grid">
        <div><span>Master Agent</span><strong>${master}</strong></div>
        <div><span>Tree Level</span><strong>${detail.level !== null ? esc(`L${detail.level}`) : "—"}</strong></div>
        <div><span>Agent Type</span><strong>${esc(detail.agentType ?? "—")}</strong></div>
        <div><span>Downline Agents</span><strong>${esc(detail.childAgents.length)}</strong></div>
      </div>
    </div>
    ${conduitCard}
    <div class="card">
      <h2>Child Agents (${esc(detail.childAgents.length)})</h2>
      <div class="chips">${childrenHtml}</div>
    </div>
    <div class="card">
      <h2>Customers (${esc(detail.customers.length)})</h2>
      ${customersHtml}
    </div>
    <div class="card">
      <h2>Recent Wagers (${esc(detail.recentWagers.length)})</h2>
      ${wagersHtml}
    </div>
  </div>
</body>
</html>`;
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
  const isDevelopment = Bun.env.NODE_ENV !== "production";
  const mcpHandler = createSportsdeskMcpHttpHandler({
    stateless:
      options.mcpStateless ??
      /^(1|true)$/i.test(Bun.env.SPORTSDESK_MCP_STATELESS ?? ""),
    allowedOrigins: resolveMcpAllowedOrigins(isDevelopment),
  });

  const alertDispatcher = new AlertDispatcher({
    sweepIntervalMs: 5000,
  });
  if (options.watchFiles !== false) {
    alertDispatcher.start();
  }

  const jsonReader = createCachedJsonReader(24);
  const { findCustomerRow } = createCustomerRowFinder<CustomerRow>({ cwd });
  const markdownCache = new DashboardMarkdownCache(dashboardMdPath);
  const r2PipelineService = createR2PipelineService({
    daemon4020Origin:
      Bun.env.SPORTSDESK_API_ORIGIN ?? DEFAULT_COMPANION_4020_ORIGIN,
  });
  const { buildLiveWagersPayload, clearCache: clearWagersCache } =
    createDevLiveWagersLoader({
      cwd,
      // Vendor wire contract (schema/wagers_field_contract.json) checked against
      // the raw rows before projection; surfaces as payload.wire_contract.
      // Sentinel-noise rows (writer ALERT/BLOCKED) are not wagers; skip and count
      // them so the exclusion is visible in payload.wire_contract.skipped_rows.
      inspectRawRows: (rows) =>
        inspectWagersWireContract(rows, undefined, {
          skipRow: (row) => isSentinelTickerWriter(row.TicketWriter),
        }),
      // Validated config/slab.toml summary; path-free by construction.
      describeSlab: () => ({
        schema: SLAB_SERVER.meta.schema,
        version: SLAB_SERVER.meta.version,
        window_bytes: SLAB_SERVER.capacity.ticker_window_bytes,
        unsafe_allowed: SLAB_SERVER.unsafe.allowed,
        sentinels: SLAB_SERVER.sentinels,
      }),
      loadSharpDeps: async () => {
        const [{ parseShortDesc: parseDesc }, { KEY_NUMBER_BUYER_PROFILES }] =
          await Promise.all([
            import("../lib/live_wagers.ts"),
            import("../lib/customer_profile.ts"),
          ]);
        return {
          parseShortDesc: parseDesc,
          sharpCustomerIds: new Set(
            [...KEY_NUMBER_BUYER_PROFILES.keys()].map((k) =>
              k.trim().toUpperCase(),
            ),
          ),
        };
      },
    });
  const betTickerService = createBetTickerService({
    cwd,
    parseShortDesc,
    getSharpCustomerIds: async () => {
      const { KEY_NUMBER_BUYER_PROFILES } =
        await import("../lib/customer_profile.ts");
      return new Set(
        [...KEY_NUMBER_BUYER_PROFILES.keys()].map((k) =>
          k.trim().toUpperCase(),
        ),
      );
    },
    getBridge3aSnapshot: () => r2PipelineService.getLatestBetTickerBridge3a(),
  });
  const agentDetailService = createAgentDetailService({
    cwd,
    getConduits: async () =>
      PROXY_CONDUITS_30D.map((c) => ({
        agentId: c.agentId,
        masterAgent: c.masterAgent,
        handleUsd: c.handleUsd,
        wagers: c.wagers,
        topCustomer: c.topCust,
        concentrationPct: c.concPct,
        isProxyConduit: c.concPct >= 80,
      })),
    getCustomers: () => SAMPLE_PROFILE_DATA,
    getRecentWagers: async () => {
      const payload = await buildLiveWagersPayload();
      return payload.wagers as unknown as ReadonlyArray<
        Record<string, unknown>
      >;
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
      // Stable ops probe: /api/wagers -> .policy_version (from wagers.toml at request time).
      getWagersTabPolicy: () => loadWagersTabPolicyStamp(),
      getBetTickerPayload: (filters) => betTickerService.getPayload(filters),
      getR2PipelinePayload: (opts) => r2PipelineService.probeAll(opts),
      getDaemonStatusPayload: () => r2PipelineService.probeDaemon(),
      getAgentDetailPayload: (agentId) =>
        agentDetailService.getAgentDetail(agentId),
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
      handleMcp: (req: Request) => mcpHandler.handleRequest(req),
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
    "/agent/:id": {
      GET: async (req: BunRequest<"/agent/:id">): Promise<Response> => {
        const agentId = req.params.id ?? "";
        const detail = await agentDetailService.getAgentDetail(agentId);
        const accept = req.headers.get("accept") ?? "";
        if (accept.includes("application/json")) {
          return Response.json(detail);
        }
        return new Response(renderAgentHtmlPage(detail), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      },
    },
    "/customer/:id": {
      GET: (req: BunRequest<"/customer/:id">): Response => {
        const customerId = req.params.id ?? "";
        return new Response(null, {
          status: 302,
          headers: {
            Location: `/?tab=customers&search=${encodeURIComponent(customerId)}`,
            "Cache-Control": "no-store",
          },
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

  const companionOrigin =
    Bun.env.SPORTSDESK_API_ORIGIN ?? DEFAULT_COMPANION_4020_ORIGIN;

  async function serveStaticFileResponse(
    absPath: string,
    contentType: string,
  ): Promise<Response> {
    const file = Bun.file(absPath);
    if (!(await file.exists())) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      },
    });
  }

  async function proxy4020OrFallback(
    req: Request,
    url: URL,
    localFallback?: () => Promise<Response>,
  ): Promise<Response> {
    if (req.method === "GET" || req.method === "HEAD") {
      try {
        const upstreamUrl = `${companionOrigin}${url.pathname}${url.search}`;
        const upstream =
          req.method === "HEAD"
            ? await fetch(upstreamUrl, {
                method: "HEAD",
                signal: AbortSignal.timeout(1500),
              })
            : await fetch(upstreamUrl, {
                method: "GET",
                signal: AbortSignal.timeout(1500),
              });
        if (
          upstream.status < 500 &&
          !(upstream.status === 404 && localFallback !== undefined)
        ) {
          return new Response(upstream.body, {
            status: upstream.status,
            headers: {
              "Content-Type":
                upstream.headers.get("Content-Type") ??
                "application/octet-stream",
              "Cache-Control": "no-store",
            },
          });
        }
      } catch {
        // signal-honesty: intentional-companion-4020-offline-fallback
      }
    }
    if (localFallback) {
      return localFallback();
    }
    return Response.json(
      {
        success: false,
        daemon4020Online: false,
        error: `SportsDesk daemon :4020 is offline for ${url.pathname}`,
      },
      { status: 503 },
    );
  }

  const companionApiRoutes = {
    "/api/live-bets": (req: Request) =>
      proxy4020OrFallback(req, new URL(req.url), () =>
        serveStaticFileResponse(
          resolve(cwd, "data/live-bets.json"),
          "application/json; charset=utf-8",
        ),
      ),
    "/api/v2/live-bets": (req: Request) =>
      proxy4020OrFallback(req, new URL(req.url)),
    "/api/agent-tree": (req: Request) =>
      proxy4020OrFallback(req, new URL(req.url), () =>
        serveStaticFileResponse(
          resolve(cwd, "data/agent-tree.json"),
          "application/json; charset=utf-8",
        ),
      ),
    "/api/status": (req: Request) =>
      proxy4020OrFallback(req, new URL(req.url), async () =>
        Response.json({
          ok: false,
          daemon4020Online: false,
          note: "Daemon :4020 offline",
        }),
      ),
    "/api/kpis": (req: Request) => proxy4020OrFallback(req, new URL(req.url)),
    "/api/graph-feed": (req: Request) =>
      proxy4020OrFallback(req, new URL(req.url), () =>
        serveStaticFileResponse(
          resolve(cwd, "docs/graph-live-feed.json"),
          "application/json; charset=utf-8",
        ),
      ),
    "/api/graph/stream": (req: Request) =>
      proxy4020OrFallback(req, new URL(req.url)),
    "/api/execution/*": (req: Request) =>
      proxy4020OrFallback(req, new URL(req.url)),
    "/api/gslive/*": (req: Request) =>
      proxy4020OrFallback(req, new URL(req.url)),
    "/api/signals/*": (req: Request) =>
      proxy4020OrFallback(req, new URL(req.url)),
    "/api/logo/*": (req: Request) => proxy4020OrFallback(req, new URL(req.url)),
    "/combo-uniqueness.json": (req: Request) =>
      proxy4020OrFallback(req, new URL(req.url), () =>
        serveStaticFileResponse(
          resolve(cwd, "docs/combo-uniqueness.json"),
          "application/json; charset=utf-8",
        ),
      ),
    "/cross-domain-bridge.json": (req: Request) =>
      proxy4020OrFallback(req, new URL(req.url), () =>
        serveStaticFileResponse(
          resolve(cwd, "docs/cross-domain-bridge.json"),
          "application/json; charset=utf-8",
        ),
      ),
  };

  const server: Server<undefined> = Bun.serve({
    port,
    hostname,
    routes: apiOnly
      ? api.routes
      : { ...uiRoutes, ...api.routes, ...companionApiRoutes },
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const upgraded = srv.upgrade(req);
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (!apiOnly) {
        const path = url.pathname;
        if (path === "/live-bets") {
          return proxy4020OrFallback(req, url, () =>
            serveStaticFileResponse(
              resolve(cwd, "static/live-bets.html"),
              "text/html; charset=utf-8",
            ),
          );
        }
        if (path === "/status" || path === "/status/") {
          return proxy4020OrFallback(req, url, () =>
            serveStaticFileResponse(
              resolve(cwd, "static/status.html"),
              "text/html; charset=utf-8",
            ),
          );
        }
        if (path === "/miniapp" || path === "/miniapp/") {
          return proxy4020OrFallback(req, url, () =>
            serveStaticFileResponse(
              resolve(cwd, "static/telegram-miniapp-dashboard.html"),
              "text/html; charset=utf-8",
            ),
          );
        }
        if (
          path === "/graph" ||
          path === "/graph/" ||
          path === "/graph.html" ||
          path === "/surveillance-graph"
        ) {
          return proxy4020OrFallback(req, url, () =>
            serveStaticFileResponse(
              resolve(cwd, "docs/graph.html"),
              "text/html; charset=utf-8",
            ),
          );
        }
        if (path === "/graph.js") {
          return proxy4020OrFallback(req, url, () =>
            serveStaticFileResponse(
              resolve(cwd, "docs/graph.js"),
              "application/javascript; charset=utf-8",
            ),
          );
        }
        if (path === "/graph-live-feed.json" || path === "/api/graph-feed") {
          return proxy4020OrFallback(req, url, () =>
            serveStaticFileResponse(
              resolve(cwd, "docs/graph-live-feed.json"),
              "application/json; charset=utf-8",
            ),
          );
        }
        if (path.startsWith("/assets/")) {
          const asset = path.slice("/assets/".length);
          const contained = containedAssetPath(
            resolve(cwd, "docs/assets"),
            asset,
          );
          if (contained === null) {
            return new Response(
              isSafeAssetName(asset) ? "not found" : "invalid asset",
              { status: isSafeAssetName(asset) ? 404 : 400 },
            );
          }
          const file = Bun.file(contained);
          return new Response(file, {
            status: 200,
            headers: {
              "Content-Type": file.type || "application/octet-stream",
              "Cache-Control": "no-store",
            },
          });
        }
        if (path === "/api/live-bets") {
          return proxy4020OrFallback(req, url, () =>
            serveStaticFileResponse(
              resolve(cwd, "data/live-bets.json"),
              "application/json; charset=utf-8",
            ),
          );
        }
        if (path === "/api/agent-tree") {
          return proxy4020OrFallback(req, url, () =>
            serveStaticFileResponse(
              resolve(cwd, "data/agent-tree.json"),
              "application/json; charset=utf-8",
            ),
          );
        }
        if (path === "/api/status") {
          return proxy4020OrFallback(req, url, async () =>
            Response.json({
              ok: false,
              daemon4020Online: false,
              note: "Daemon :4020 offline",
            }),
          );
        }
        if (
          path === "/api/v2/live-bets" ||
          path === "/api/kpis" ||
          path === "/api/graph/stream" ||
          path.startsWith("/api/execution/") ||
          path.startsWith("/api/gslive/") ||
          path.startsWith("/api/signals/") ||
          path.startsWith("/api/logo/")
        ) {
          return proxy4020OrFallback(req, url);
        }
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
            if (
              !filename ||
              filename === "live-wagers.json" ||
              filename === "live-bets.json" ||
              filename === "capture-health.json" ||
              filename === "agent-tree.json"
            ) {
              clearWagersCache();
              betTickerService.clearCache();
              agentDetailService.clearCache();
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
      mcpHandler.closeAll().catch(() => {
        // signal-honesty: intentional-teardown-cleanup
      });
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
  const mcpStateless =
    Bun.argv.includes("--stateless") || Bun.argv.includes("--mcp-stateless");
  prefetchSportsDeskEndpoints();
  const handle = startDashboardServer({
    watchFiles: true,
    apiOnly,
    ...(mcpStateless ? { mcpStateless: true } : {}),
  });

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
