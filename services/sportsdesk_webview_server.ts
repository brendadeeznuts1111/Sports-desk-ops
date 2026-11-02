#!/usr/bin/env bun
/**
 * @file sportsdesk_webview_server.ts
 * @description Native Bun (v1.4+) Webview Automation Server & Telegram Mini App Gateway.
 *
 * Implements native Bun HTTP server semantics:
 *  - Native port cascade: relies on Bun's BUN_PORT -> PORT -> NODE_PORT -> 3000 cascade
 *    (SportsDesk defaults to PORT=4020 via auto-loaded .env, overridable via options).
 *  - Explicit or default hostname binding (defaults to 0.0.0.0).
 *  - Unix domain socket support via `unix` option or `BUN_SOCKET` environment variable
 *    (removes TCP port exposure for local Nginx upstream proxying).
 *  - High-throughput Response.json() and lazy Response(Bun.file()) static file handle serving.
 *  - Standardized CORS and CSP frame-ancestors for Telegram Mini App embedding (no X-Frame-Options).
 *  - Robust error boundary handling via Bun.serve `error(err)` returning structured 500 JSON.
 */

import crypto from "node:crypto";
import { resolve, dirname } from "node:path";
import {
  LIVE_FILTER,
  SPORT_CATEGORIES,
  sportCategoryFor,
  summarizeCategories,
} from "../lib/sport_taxonomy.ts";
import {
  findSubSport,
  loadSportCatalog,
  periodTypeIndex,
  periodsFor,
  subSportIndex,
  summarizeCatalog,
} from "../lib/sport_catalog.ts";
import {
  ANALYSIS_ACTIVITIES,
  ANALYSIS_GROUPS,
  ANALYSIS_REPORTS,
  ANALYSIS_REQUIRED_CAPTURE,
  ANALYSIS_WEEKS,
  describeSelection,
  parseAnalysisQuery,
} from "../lib/analysis_filters.ts";
import {
  contestsInGroup,
  readContestFile,
  searchContests,
  summarizeContests,
} from "../lib/contests.ts";
import {
  compareTotals,
  matchesSelection,
  readAnalysisReport,
  recomputeTotals,
} from "../lib/analysis_report.ts";
import {
  readWagerListArtifact,
  summarizeLiveWagers,
} from "../lib/live_wagers.ts";
import {
  BOARD_WINDOWS,
  biggestSide,
  filterByWindow,
  parseBoardWindow,
  readBoardFile,
  sidesOf,
  summarizeBoard,
} from "../lib/game_admin_board.ts";
import {
  compactPositions,
  summarizeByGame,
  wagerTypeLabel,
} from "../lib/game_admin.ts";
import {
  findScore,
  readScoreboardFile,
  summarizeScoreboard,
  type ScoreboardFile,
} from "../lib/scoreboard.ts";
import {
  readPendingRows,
  summarizeAgents,
  summarizeGames,
  toLiveBetGame,
  type AgentScope,
  type LiveBetGame,
  type LiveBetsArtifact,
} from "../lib/live_bets.ts";
import { ReportingSchedulerService } from "./reporting_scheduler_service.ts";
import {
  REPORT_TYPES,
  SportsDeskTelegramService,
  isReportType,
  type TelegramUpdate,
} from "./sportsdesk_telegram_bot.ts";
import { containedAssetPath, isSafeAssetName } from "../lib/asset_path.ts";

/** `null` when the request comes from the same machine; otherwise the admin gate applies. */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (address === null || address === undefined) return true; // no peer address: see Ingress
  const normalized = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "" || normalized === "localhost") return true;
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackAddress(normalized.slice("::ffff:".length));
  }
  return normalized.startsWith("127.");
}

/**
 * How this process accepts connections, because that decides what a peer address can mean.
 *
 * A TCP listener sees the client, so loopback is the operator. A unix-socket listener sees only
 * the reverse proxy: `server.requestIP()` is `null` for every request, proxied or not, so reading
 * "no address" as local made every PII route public on the VPS, where Nginx is the socket's only
 * client (`scripts/deploy/deploy_to_vps.sh`). Proxied ingress therefore trusts nothing by default;
 * `SPORTSDESK_TRUST_PROXY=1` is the explicit opt-in for a deployment that terminates its own auth
 * at the edge and accepts that the daemon cannot tell one proxied client from another.
 */
export type Ingress = {
  /** Listening on a unix socket: the peer is the proxy, not the client. */
  readonly proxied: boolean;
  /** `SPORTSDESK_TRUST_PROXY=1`: the proxy is declared the trust boundary. */
  readonly trustProxy: boolean;
};

/** Whether the peer speaks for the machine itself. Pure so the policy can be tested directly. */
export function peerIsTrusted(
  address: string | null | undefined,
  ingress: Ingress,
): boolean {
  if (ingress.proxied) return ingress.trustProxy;
  return isLoopbackAddress(address);
}

/**
 * Guards endpoints that carry customer or agent-identifying data.
 *
 * Loopback is allowed so the local scoreboard keeps working without a token. Any other peer
 * must present `SPORTSDESK_ADMIN_TOKEN`: a phone on the same Wi-Fi must not be able to read
 * customer ids from a dev server bound to 0.0.0.0. Behind a proxy the peer address is the
 * proxy's, which `peerIsTrusted` refuses unless the deployment said otherwise.
 */
function piiRejection(
  req: Request,
  address: string | null | undefined,
  ingress: Ingress,
): { status: 401 | 403 | 503; error: string } | null {
  if (peerIsTrusted(address, ingress)) return null;
  return adminRejection(req);
}

/** `null` when the bearer token matches SPORTSDESK_ADMIN_TOKEN; otherwise the rejection status and reason. */
function adminRejection(
  req: Request,
): { status: 401 | 503; error: string } | null {
  const expected = Bun.env.SPORTSDESK_ADMIN_TOKEN ?? "";
  if (!expected) {
    return {
      status: 503,
      error: "SPORTSDESK_ADMIN_TOKEN is not set on the server",
    };
  }
  const given = (req.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b)
    ? null
    : { status: 401, error: "Missing or wrong admin token" };
}

const repoRoot = resolve(
  typeof import.meta !== "undefined" && import.meta.dir
    ? import.meta.dir
    : dirname(process.argv[1] || "."),
  "..",
);

export interface ServerOptions {
  readonly port?: number;
  readonly hostname?: string;
  readonly unix?: string;
  readonly development?: boolean;
}

/** Reads the committed artifact first; falls back to the captured sample row. */
async function loadLiveBets(): Promise<{
  games: LiveBetGame[];
  agents: AgentScope;
  pendingCount: number;
  dataSource: string;
  capturedAt: string | null;
}> {
  const artifactFile = Bun.file(resolve(repoRoot, "data/live-bets.json"));
  if (await artifactFile.exists()) {
    const artifact = (await artifactFile.json()) as LiveBetsArtifact;
    return {
      games: [...artifact.games],
      agents: artifact.agents,
      pendingCount: artifact.pendingCount,
      dataSource: artifact.dataSource,
      capturedAt: artifact.capturedAt,
    };
  }

  const sampleFile = Bun.file(
    resolve(repoRoot, "tests/f402-pending-wager-sample.json"),
  );
  if (!(await sampleFile.exists())) {
    return {
      games: [],
      agents: summarizeAgents([]),
      pendingCount: 0,
      dataSource: "none",
      capturedAt: null,
    };
  }
  const pending = readPendingRows(await sampleFile.json());
  const games = pending.map((row) => toLiveBetGame(row));
  return {
    games,
    agents: summarizeAgents(games),
    pendingCount: pending.length,
    dataSource: "sample-fixture:tests/f402-pending-wager-sample.json",
    capturedAt: null,
  };
}

/** The live wager list ({LIST: [...]}), when a capture has been saved. */
/** The live wager list ({LIST: [...]}) plus the file's own account of its completeness. */
async function loadLiveWagerList() {
  const file = Bun.file(resolve(repoRoot, "data/live-wagers.json"));
  if (!(await file.exists())) return null;
  return readWagerListArtifact(await file.json());
}

/** A stored Analysis report result, when one has been transcribed. */
async function loadAnalysisReport() {
  const file = Bun.file(
    resolve(repoRoot, "data/analysis-cp-baseball-2026-11-01.json"),
  );
  if (!(await file.exists())) return null;
  return readAnalysisReport(await file.json());
}

/** Contest (futures) list extracted from the sports nav markup. */
async function loadContests() {
  const file = Bun.file(resolve(repoRoot, "data/contests.json"));
  if (!(await file.exists())) return null;
  return readContestFile(await file.json());
}

/** Game Admin "Admin" module: per-game lines and the money on each side. */
async function loadBoard() {
  const file = Bun.file(resolve(repoRoot, "data/game-admin-board.json"));
  if (!(await file.exists())) return null;
  return readBoardFile(await file.json());
}

/** Portal sport catalog (19 sports / 230 sub-sports / 42 period entries). */
const SPORT_CATALOG_PATH =
  "tests/fixtures/fantasy402-sport-catalog-2026-10-21.json";

async function loadCatalog() {
  const file = Bun.file(resolve(repoRoot, SPORT_CATALOG_PATH));
  if (!(await file.exists())) return null;
  return loadSportCatalog(await file.json());
}

/** Portal scoreboard transcribed from the manager page; null when absent. */
async function loadScoreboard(): Promise<ScoreboardFile | null> {
  const file = Bun.file(resolve(repoRoot, "data/scoreboard.json"));
  if (!(await file.exists())) return null;
  return readScoreboardFile(await file.json());
}

/** Team-logo names come from the feed and may contain spaces (`"Arsenal FC.png"`).
 *  Validate by rejecting separators, control characters and traversal rather than by
 *  allowlisting characters the feed happens to use today. */
const LOGO_EXTENSION = /\.(?:png|jpe?g|gif|webp|svg)$/i;

function isLogoName(name: string): boolean {
  if (!LOGO_EXTENSION.test(name) || name.includes("..")) return false;
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || ch === "/" || ch === "\\") return false;
  }
  return true;
}

/** JSON files the generated graph page fetches relative to itself. */
const GRAPH_DOCS_JSON = new Set([
  "/combo-uniqueness.json",
  "/cross-domain-bridge.json",
]);

/**
 * The largest request body any arm reads.
 *
 * `/api/parse-formdata` exists to parse one form, and every other POST body is a small JSON
 * document. Bun enforces this before the handler runs, so a chunked body cannot be buffered past
 * it the way an arm-local `content-length` check could be.
 */
const MAX_REQUEST_BODY_BYTES = 1 << 20;

export function startServer(options?: ServerOptions) {
  const telegramService = new SportsDeskTelegramService();
  const scheduler = new ReportingSchedulerService(telegramService);
  const customerDashboardPath = resolve(
    repoRoot,
    "static/customer-churn-simulation-dashboard.html",
  );
  const miniappDashboardPath = resolve(
    repoRoot,
    "static/telegram-miniapp-dashboard.html",
  );

  const customerDashboardFile = Bun.file(customerDashboardPath);
  const miniappDashboardFile = Bun.file(miniappDashboardPath);

  const isDevelopment =
    options?.development ??
    (typeof Bun !== "undefined"
      ? Bun.env.NODE_ENV !== "production"
      : process.env.NODE_ENV !== "production");

  /**
   * Cross-origin reads are off unless the operator names the origins that may make them.
   *
   * The old value was `Access-Control-Allow-Origin: *` on every response, including the PII ones.
   * Any page on any site could therefore read `/api/live-bets` from the operator's own browser,
   * where the peer is loopback and the guard deliberately allows it. Same-origin fetches (the
   * dashboard, the Mini App) need no header at all, so the default is to send none.
   */
  const allowedOrigins = (Bun.env.SPORTSDESK_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");

  /** Headers every response carries; the CORS grant is added per request by {@link corsHeadersFor}. */
  const baseHeaders: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With, X-Telegram-Bot-Api-Secret-Token",
    "Content-Security-Policy":
      "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram:;",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };

  function corsHeadersFor(req: Request): Record<string, string> {
    const headers: Record<string, string> = { ...baseHeaders };
    const origin = req.headers.get("origin");
    if (origin !== null && allowedOrigins.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Vary"] = "Origin";
    }
    return headers;
  }

  const unixSocket =
    options?.unix ||
    (typeof Bun !== "undefined" ? Bun.env.BUN_SOCKET : process.env.BUN_SOCKET);

  /** What a peer address means here; read once, so a restart is what changes it. */
  const ingress: Ingress = {
    proxied: Boolean(unixSocket),
    trustProxy: (Bun.env.SPORTSDESK_TRUST_PROXY ?? "") === "1",
  };

  const serveConfig: Parameters<typeof Bun.serve>[0] = {
    development: isDevelopment,
    // Bodies here are small JSON documents and one 1 MiB form probe. Without a cap a chunked
    // request is buffered in full by `req.json()` / `arrayBuffer()` (measured: a 6 MiB POST to
    // /api/telegram/alert was accepted), which is a memory DoS on an unauthenticated port.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,

    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const cors = corsHeadersFor(req);

      // Synthetic error trigger for testing error boundary.
      // Deliberately reachable in production: tests/server_error.test.ts asserts the
      // production 500 body carries no stack trace, so this hook must not be gated.
      if (
        pathname === "/api/test/error" ||
        url.searchParams.get("trigger_error") === "non_error"
      ) {
        throw "Synthetic non-Error thrown in handler";
      }

      // 1. Fast Preflight OPTIONS Response (HTTP 204 No Content)
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }

      // 2. Form-data parse debug: echoes the fields of one form.
      // `req.formData()` rather than `new Blob([await req.arrayBuffer()]).formData()`: the Blob
      // path rejects Bun's own multipart encoding on 1.4.4 ("Invalid encoding", measured with a
      // body this server's own client produced), so the arm answered 400 for every real form.
      // The read is bounded by `maxRequestBodySize` above.
      if (pathname === "/api/parse-formdata" && req.method === "POST") {
        try {
          const fd = await req.formData();
          const out: Record<string, string | string[]> = {};
          for (const [k, v] of fd.entries()) {
            if (out[k] === undefined) out[k] = String(v);
            else if (Array.isArray(out[k]))
              (out[k] as string[]).push(String(v));
            else out[k] = [out[k] as string, String(v)];
          }
          return Response.json(out, { headers: cors });
        } catch (err) {
          return Response.json(
            { error: String(err) },
            { status: 400, headers: cors },
          );
        }
      }

      // 3. Live bets context, derived from real Report/Pending captures.
      // `/api/live-bets/summary` returns the same aggregates without the game list.
      if (
        pathname === "/api/live-bets" ||
        pathname === "/live-bets/summary" ||
        pathname === "/api/live-bets/summary"
      ) {
        const rejected = piiRejection(
          req,
          server.requestIP(req)?.address,
          ingress,
        );
        if (rejected !== null) {
          return Response.json(
            { success: false, error: rejected.error },
            { status: rejected.status, headers: cors },
          );
        }

        const { games, agents, pendingCount, dataSource, capturedAt } =
          await loadLiveBets();
        const summary = summarizeGames(
          games,
          pendingCount,
          dataSource,
          capturedAt,
        );
        const generatedAt = new Date().toISOString();
        // A scoreboard is a snapshot; let the client decide when to re-ask.
        const headers = { ...cors, "Cache-Control": "no-store" };

        if (pathname.endsWith("/summary")) {
          const etag = `"${Buffer.from(
            `${dataSource}|${capturedAt}|${summary.totalGames}|${summary.totalWagered}|${summary.totalToWin}|${summary.totalPending}`,
          ).toString("base64url")}"`;
          const ifNoneMatch = req.headers.get("if-none-match");
          const summaryHeaders = {
            ...cors,
            "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
            ETag: etag,
          };
          if (ifNoneMatch === etag) {
            return new Response(null, { status: 304, headers: summaryHeaders });
          }
          return Response.json(
            { success: true, summary, generatedAt },
            { headers: summaryHeaders },
          );
        }

        // Scores come from the transcribed scoreboard; a wager without a matching game
        // stays null rather than borrowing a neighbour's score.
        const scoreboard = await loadScoreboard();
        const withScores = games.map((game) => ({
          ...game,
          position: wagerTypeLabel(game.wagerType),
          category: sportCategoryFor({
            sportType: game.sport,
            sportSubType: game.subSport,
          }),
          scoreboard:
            scoreboard === null
              ? null
              : findScore(scoreboard, {
                  team1: game.team1.name,
                  team2: game.team2.name,
                  league: game.subSport,
                }),
        }));

        const categories = summarizeCategories(
          withScores.map((game) => ({
            category: game.category,
            live: game.scoreboard?.status === "live",
          })),
        );

        return Response.json(
          {
            games: withScores,
            agents,
            pendingCount: summary.totalPending,
            summary,
            scoreboard:
              scoreboard === null
                ? null
                : {
                    source: scoreboard.source,
                    observedAt: scoreboard.observedAt,
                    summary: summarizeScoreboard(scoreboard),
                  },
            sports: {
              categories,
              all: SPORT_CATEGORIES,
              liveFilter: LIVE_FILTER,
            },
            generatedAt,
          },
          { headers },
        );
      }

      // 4. Logo proxy (fetches team logo and returns the image blob)
      if (pathname.startsWith("/api/logo/")) {
        // A malformed percent-escape made `decodeURIComponent` throw, which reached the error
        // boundary as a 500 and logged a stack for what is a client error (measured:
        // /api/logo/%E0%A4%A).
        let name: string;
        try {
          name = decodeURIComponent(pathname.slice("/api/logo/".length));
        } catch {
          return new Response("invalid logo name", {
            status: 400,
            headers: cors,
          });
        }
        if (!name) {
          return new Response("missing name", {
            status: 400,
            headers: cors,
          });
        }
        if (!isLogoName(name)) {
          return new Response("invalid logo name", {
            status: 400,
            headers: cors,
          });
        }
        try {
          const url = "https://cdn.fastassets.io/images/team-logos/" + name;
          const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
          if (!res.ok) {
            return new Response("not found", {
              status: res.status,
              headers: cors,
            });
          }
          const type = res.headers.get("content-type") ?? "";
          if (!type.startsWith("image/")) {
            return new Response("upstream did not return an image", {
              status: 502,
              headers: cors,
            });
          }
          const blob = await res.blob();
          return new Response(blob, {
            headers: {
              ...cors,
              "Content-Type": blob.type || "image/png",
              "Cache-Control": "public, max-age=86400, immutable",
            },
          });
        } catch (err) {
          return Response.json(
            { error: String(err) },
            { status: 502, headers: cors },
          );
        }
      }

      // 5. Retired: /api/f402/get-pending answered the same dataset as /api/live-bets with a
      // different shape. Kept as an explicit tombstone so an old client fails loudly instead
      // of silently reading a fixture that looks live.
      if (pathname === "/api/f402/get-pending") {
        return Response.json(
          {
            success: false,
            error:
              "removed: use /api/live-bets (games + agents) or pass --body to build:live-bets",
          },
          { status: 410, headers: cors },
        );
      }

      // 6. Health & Telemetry Probe
      if (pathname === "/health") {
        return Response.json(
          {
            status: "healthy",
            port: server.port,
            hostname: server.hostname,
            url: server.url ? server.url.toString() : "unix://socket",
            timestamp: new Date().toISOString(),
            uptimeSeconds: Math.floor(process.uptime()),
            runtime: `Bun v${Bun.version} (${process.arch}-${process.platform})`,
            // Which peer-trust rule is in force, so "is the guard on?" is answerable from here
            // instead of from a request that happens to come from the wrong address.
            ingress,
            nodeEnv:
              (typeof Bun !== "undefined"
                ? Bun.env.NODE_ENV
                : process.env.NODE_ENV) || "development",
          },
          { headers: cors },
        );
      }

      if (
        (pathname === "/api/status" || pathname === "/status.json") &&
        (req.method === "GET" || req.method === "HEAD")
      ) {
        // Ask the service directly. The first version fetched itself over
        // `http://127.0.0.1:${server.port}`: an extra round trip, and no port at all when the
        // server listens on a unix socket (BUN_SOCKET / options.unix), which silently reported
        // telegram as null — indistinguishable from "not configured".
        const mem = process.memoryUsage();
        const cpu = process.cpuUsage();
        const checks: Record<string, "ok" | "error"> = {};
        let telegram: unknown = null;
        try {
          telegram = {
            status: await telegramService.getStatus(),
            schedules: scheduler.getSchedules(),
          };
          checks.telegram = "ok";
        } catch (error) {
          checks.telegram = "error";
          telegram = {
            error: error instanceof Error ? error.message : String(error),
          };
        }

        // `ok` was a literal true and `status` the literal "healthy", so the status page's
        // unhealthy branch was unreachable. Both are derived from the checks now.
        const ok = Object.values(checks).every((check) => check === "ok");
        return Response.json(
          {
            ok,
            status: ok ? "serving" : "degraded",
            checks,
            health: {
              // process.cpuUsage() is cumulative CPU time since start, not utilisation; the old
              // `cpu` label invited reading it as load.
              uptimeSeconds: Math.floor(process.uptime()),
              runtime: `Bun v${Bun.version} (${process.arch}-${process.platform})`,
              memory: {
                rss: mem.rss,
                heapTotal: mem.heapTotal,
                heapUsed: mem.heapUsed,
                external: mem.external,
                arrayBuffers: mem.arrayBuffers,
              },
              cpuUsageSinceStartMicros: {
                user: cpu.user,
                system: cpu.system,
              },
              pid: process.pid,
            },
            telegram,
            timestamp: new Date().toISOString(),
          },
          { headers: cors },
        );
      }

      // 7. Live bets view
      if (pathname === "/live-bets") {
        return new Response(
          Bun.file(resolve(repoRoot, "static/live-bets.html")),
          {
            headers: {
              ...cors,
              "Content-Type": "text/html; charset=utf-8",
            },
          },
        );
      }

      // 8. Executive Dashboard (GET / or GET /dashboard)
      if (pathname === "/" || pathname === "/dashboard") {
        return new Response(customerDashboardFile, {
          headers: {
            ...cors,
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }

      // 8b. Status page (GET /status)
      if (pathname === "/status" || pathname === "/status/") {
        return new Response(Bun.file(resolve(repoRoot, "static/status.html")), {
          headers: {
            ...cors,
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }

      // 9. Telegram Mini App (GET /miniapp)
      if (pathname === "/miniapp" || pathname === "/miniapp/") {
        return new Response(miniappDashboardFile, {
          headers: {
            ...cors,
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }

      // 10. Dedicated Surveillance Graph & Shadow Portfolio Page (GET /graph or /graph.html)
      if (
        pathname === "/graph" ||
        pathname === "/graph/" ||
        pathname === "/graph.html" ||
        pathname === "/surveillance-graph"
      ) {
        // docs/graph.html carries agent logins in its dataset (BILLY666, RF2003, BGD101 in the
        // 640 KB payload), so it is customer-identifying, not a static page. Loopback keeps
        // working; any other peer needs the admin token, as /api/live-bets already does.
        const rejected = piiRejection(
          req,
          server.requestIP(req)?.address,
          ingress,
        );
        if (rejected !== null) {
          return Response.json(
            { success: false, error: rejected.error },
            { status: rejected.status, headers: cors },
          );
        }
        return new Response(Bun.file(resolve(repoRoot, "docs/graph.html")), {
          headers: {
            ...cors,
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }

      if (pathname === "/graph.js") {
        return new Response(Bun.file(resolve(repoRoot, "docs/graph.js")), {
          headers: {
            ...cors,
            "Content-Type": "application/javascript; charset=utf-8",
          },
        });
      }

      // 11. Graph data plane. `docs/graph.js` fetches these relative to the page, so the
      // daemon-served graph was dead (404) unless the docs directory was served separately.
      if (
        pathname === "/graph-live-feed.json" ||
        pathname === "/api/graph-feed"
      ) {
        // Same identifiers as the page: the feed is the page's dataset, so the same guard.
        const rejected = piiRejection(
          req,
          server.requestIP(req)?.address,
          ingress,
        );
        if (rejected !== null) {
          return Response.json(
            { success: false, error: rejected.error },
            { status: rejected.status, headers: cors },
          );
        }
        return new Response(
          Bun.file(resolve(repoRoot, "docs/graph-live-feed.json")),
          {
            headers: {
              ...cors,
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
            },
          },
        );
      }

      if (GRAPH_DOCS_JSON.has(pathname)) {
        return new Response(
          Bun.file(resolve(repoRoot, "docs", pathname.slice(1))),
          {
            headers: {
              ...cors,
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
            },
          },
        );
      }

      // Which analysis reports have been transcribed, so a client can select one instead of
      // guessing the selection it was run for.
      if (pathname === "/api/analysis/reports") {
        const stored = await loadAnalysisReport();
        if (stored === null) {
          return Response.json(
            { success: true, count: 0, reports: [] },
            { headers: { ...cors, "Cache-Control": "no-store" } },
          );
        }
        return Response.json(
          {
            success: true,
            count: 1,
            reports: [
              {
                id: "analysis-cp-baseball-2026-11-01",
                report: stored.report,
                source: stored.source,
                observedAt: stored.observedAt,
                context: stored.context,
                rows: stored.rows.length,
                discrepancies: compareTotals(stored).length,
              },
            ],
          },
          { headers: { ...cors, "Cache-Control": "no-store" } },
        );
      }

      // Live wager list: the bet-ticker feed ({LIST: [...]}), a different shape from Pending.
      if (pathname === "/api/live-wagers") {
        const rejected = piiRejection(
          req,
          server.requestIP(req)?.address,
          ingress,
        );
        if (rejected !== null) {
          return Response.json(
            { success: false, error: rejected.error },
            { status: rejected.status, headers: cors },
          );
        }

        const artifact = await loadLiveWagerList();
        if (artifact === null) {
          return Response.json(
            {
              error: "no live wager list",
              hint: "save the ticker response as data/live-wagers.json and reload",
            },
            { status: 404, headers: cors },
          );
        }
        const wagers = artifact.wagers;

        const writer = (url.searchParams.get("writer") ?? "")
          .trim()
          .toLowerCase();
        const type = (url.searchParams.get("type") ?? "").trim().toUpperCase();
        const filtered = wagers.filter(
          (wager) =>
            (writer === "" || wager.writer === writer) &&
            (type === "" || wager.wagerType === type),
        );

        return Response.json(
          {
            success: true,
            summary: summarizeLiveWagers(filtered),
            all: summarizeLiveWagers(wagers),
            writer: writer === "" ? null : writer,
            type: type === "" ? null : type,
            // The file's own account of itself: a 17-row subset reads as 17 rows, not as the list.
            provenance: artifact.provenance,
            wagers: filtered,
          },
          { headers: { ...cors, "Cache-Control": "no-store" } },
        );
      }

      // Contest / futures list: the sports nav's get-games-prop anchors.
      if (pathname === "/api/contests") {
        const contests = await loadContests();
        if (contests === null) {
          return Response.json(
            {
              error: "no contest list",
              hint: "bun run contests:extract --html <saved sports nav markup>",
            },
            { status: 404, headers: cors },
          );
        }

        const group = url.searchParams.get("group") ?? "";
        const query = url.searchParams.get("q") ?? "";
        const filtered = searchContests(
          { ...contests, entries: contestsInGroup(contests, group) },
          query,
        );

        return Response.json(
          {
            success: true,
            source: contests.source,
            extractedAt: contests.extractedAt,
            summary: summarizeContests(contests),
            group: group === "" ? null : group,
            query: query === "" ? null : query,
            count: filtered.length,
            entries: filtered,
          },
          { headers: { ...cors, "Cache-Control": "no-store" } },
        );
      }

      // Game Admin board: the market with exposure on each side, per game.
      if (pathname === "/api/game-admin/board") {
        const board = await loadBoard();
        if (board === null) {
          return Response.json(
            { error: "no game board; add data/game-admin-board.json" },
            { status: 404, headers: cors },
          );
        }

        const gameNum = Number(url.searchParams.get("game") ?? "");
        if (Number.isFinite(gameNum) && gameNum > 0) {
          const game = board.games.find((entry) => entry.gameNum === gameNum);
          if (game === undefined) {
            return Response.json(
              {
                success: false,
                error: `no game ${gameNum}`,
                known: board.games.map((entry) => entry.gameNum),
              },
              { status: 404, headers: cors },
            );
          }
          return Response.json(
            {
              success: true,
              game,
              markets: {
                spread: sidesOf(game, "spread"),
                money: sidesOf(game, "money"),
                total: sidesOf(game, "total"),
                teamTotal: sidesOf(game, "teamTotal"),
              },
            },
            { headers: { ...cors, "Cache-Control": "no-store" } },
          );
        }

        // The report's own window selector: 48 yesterday, 24 today, -1 current board.
        const window = parseBoardWindow(url.searchParams.get("window"));
        if (window === null) {
          return Response.json(
            {
              success: false,
              error: "window must be 48, 24 or -1",
              windows: BOARD_WINDOWS,
            },
            { status: 400, headers: cors },
          );
        }
        const games = filterByWindow(board, window);

        return Response.json(
          {
            success: true,
            source: board.source,
            observedAt: board.observedAt,
            window,
            windows: BOARD_WINDOWS,
            notes: board.notes ?? [],
            // The summary describes the games in this window, not the whole file.
            summary: summarizeBoard({ ...board, games }),
            biggest: biggestSide({ ...board, games }),
            games,
          },
          { headers: { ...cors, "Cache-Control": "no-store" } },
        );
      }

      // Sport catalog: sub-sports and the full period menus, with their types.
      if (pathname === "/api/sports/catalog") {
        const catalog = await loadCatalog();
        if (catalog === null) {
          return Response.json(
            { error: "no sport catalog fixture" },
            { status: 404, headers: cors },
          );
        }

        const sportFilter = (url.searchParams.get("sport") ?? "").trim();
        const codeFilter = (url.searchParams.get("subSport") ?? "").trim();

        if (codeFilter !== "" && sportFilter !== "") {
          const subSport = findSubSport(catalog, sportFilter, codeFilter);
          if (subSport === null) {
            return Response.json(
              {
                success: false,
                error: `${sportFilter} has no sub-sport "${codeFilter}"`,
                periods: periodsFor(catalog, sportFilter),
              },
              { status: 404, headers: cors },
            );
          }
          return Response.json(
            {
              success: true,
              sport: sportFilter,
              subSport,
              periods: periodsFor(catalog, sportFilter),
              source: SPORT_CATALOG_PATH,
            },
            { headers: { ...cors, "Cache-Control": "no-store" } },
          );
        }

        const sports =
          sportFilter === ""
            ? catalog.sports
            : catalog.sports.filter((entry) => entry.sport === sportFilter);
        if (sportFilter !== "" && sports.length === 0) {
          return Response.json(
            {
              success: false,
              error: `unknown sport "${sportFilter}"`,
              known: catalog.sports.map((entry) => entry.sport),
            },
            { status: 404, headers: cors },
          );
        }

        return Response.json(
          {
            success: true,
            source: SPORT_CATALOG_PATH,
            provider: catalog.provider,
            capturedAt: catalog.capturedAt,
            periodsCapturedAt: catalog.periodsCapturedAt,
            summary: summarizeCatalog(catalog),
            periodTypes: periodTypeIndex(catalog),
            subSports: subSportIndex(catalog),
            collisions: catalog.collisions,
            migrationRisks: catalog.migrationRisks,
            expectedEmptySubSportPaths: catalog.expectedEmptySubSportPaths,
            sports,
          },
          { headers: { ...cors, "Cache-Control": "no-store" } },
        );
      }

      // Analysis report vocabulary: the codes the portal's filter bar sends, transcribed from
      // its markup. No report body exists in this repo, so the query is validated but not run.
      if (pathname === "/api/analysis/filters") {
        return Response.json(
          {
            success: true,
            provenance:
              "portal markup: report.js filter bar (report kind, activity, group, week)",
            captured: false,
            reports: ANALYSIS_REPORTS,
            activities: ANALYSIS_ACTIVITIES,
            groups: ANALYSIS_GROUPS,
            weeks: ANALYSIS_WEEKS,
            requiredCapture: ANALYSIS_REQUIRED_CAPTURE,
          },
          { headers: { ...cors, "Cache-Control": "no-store" } },
        );
      }

      if (pathname === "/api/analysis") {
        // The stored report's rows are customer logins (EGGT3, GOLD22, … TDFIRE) and the
        // response carries them verbatim, so this is customer-identifying, not aggregate.
        // Measured: GET /api/analysis?report=CP&agent=BILLY666&sport=Baseball&week=-1&activity=0
        // returned 8/8 known logins in 2,899 bytes with no credential. Same policy as /graph:
        // loopback keeps working, any other peer needs SPORTSDESK_ADMIN_TOKEN.
        const rejected = piiRejection(
          req,
          server.requestIP(req)?.address,
          ingress,
        );
        if (rejected !== null) {
          return Response.json(
            { success: false, error: rejected.error },
            { status: rejected.status, headers: cors },
          );
        }
        const parsed = parseAnalysisQuery(url.searchParams);
        if (!parsed.ok || parsed.selection === undefined) {
          return Response.json(
            {
              success: false,
              error: "invalid analysis selection",
              issues: parsed.errors,
            },
            { status: 400, headers: cors },
          );
        }

        // Resolve the typed agent against the committed tree so the response can say whether
        // the name is one the hierarchy knows, instead of echoing it unexamined.
        let agentKnown: boolean | null = null;
        let agentLevel: number | null = null;
        const selection = parsed.selection;
        if (selection.agent !== "") {
          const treeFile = Bun.file(resolve(repoRoot, "data/agent-tree.json"));
          if (await treeFile.exists()) {
            const tree = (await treeFile.json()) as {
              nodes?: Record<string, { l?: number | null }>;
            };
            const node = tree.nodes?.[selection.agent.toUpperCase()];
            agentKnown = node !== undefined;
            agentLevel =
              node !== undefined && typeof node.l === "number" ? node.l : null;
          }
        }
        // A transcribed result answers only for the selection it was run for. Everything else
        // stays 501: inventing zeroes here would read as "no action".
        const stored = await loadAnalysisReport();
        if (
          stored !== null &&
          matchesSelection(stored, {
            report: selection.report,
            agent: selection.agent,
            sport: url.searchParams.get("sport") ?? "all",
            week: selection.week,
            activity: selection.activity,
          })
        ) {
          const discrepancies = compareTotals(stored);
          return Response.json(
            {
              success: true,
              available: true,
              filter: parsed.selection,
              description: describeSelection(parsed.selection),
              agentKnown,
              agentLevel,
              report: stored.report,
              source: stored.source,
              observedAt: stored.observedAt,
              context: stored.context,
              notes: stored.notes ?? [],
              rows: stored.rows,
              totals: stored.totals,
              // Recomputed independently of the stored footer so a transcription slip is visible.
              recomputed: recomputeTotals(stored),
              discrepancies,
            },
            { headers: { ...cors, "Cache-Control": "no-store" } },
          );
        }

        return Response.json(
          {
            success: false,
            available: false,
            filter: parsed.selection,
            description: describeSelection(parsed.selection),
            agentKnown,
            agentLevel,
            error: "no transcribed analysis report matches this selection",
            storedReports: stored === null ? [] : [stored.context],
            requiredCapture: ANALYSIS_REQUIRED_CAPTURE,
          },
          { status: 501, headers: cors },
        );
      }

      // "Action on a game", the Game Admin report the portal manual documents (F.A.Q. #4):
      // exposure per fixture with the Straight/Parlay/Teaser split.
      if (pathname === "/api/game-admin") {
        const { games } = await loadLiveBets();
        const lineup = summarizeByGame(games, new Date());
        return Response.json(
          {
            success: true,
            source: "live-bets wager capture",
            games: lineup.map((game) => ({
              ...game,
              positions: compactPositions(game.positions),
            })),
            generatedAt: new Date().toISOString(),
          },
          { headers: { ...cors, "Cache-Control": "no-store" } },
        );
      }

      // Portal sport taxonomy, with counts for whatever is currently loaded.
      if (pathname === "/api/sports") {
        const { games } = await loadLiveBets();
        const scoreboard = await loadScoreboard();
        const wagerRows = games.map((game) => ({
          category: sportCategoryFor({
            sportType: game.sport,
            sportSubType: game.subSport,
          }),
        }));
        const boardRows = (scoreboard?.games ?? []).map((game) => ({
          category: sportCategoryFor({ sportType: game.sport }),
          live: game.status === "live",
        }));

        return Response.json(
          {
            success: true,
            liveFilter: LIVE_FILTER,
            all: SPORT_CATEGORIES,
            catalog: "/api/sports/catalog",
            wagers: summarizeCategories(wagerRows),
            scoreboard: summarizeCategories(boardRows),
          },
          { headers: { ...cors, "Cache-Control": "no-store" } },
        );
      }

      // Transcribed portal scoreboard (games + scores), separate from the wager capture.
      if (pathname === "/api/scoreboard") {
        const scoreboard = await loadScoreboard();
        if (scoreboard === null) {
          return Response.json(
            { error: "no scoreboard; add data/scoreboard.json" },
            { status: 404, headers: cors },
          );
        }
        return Response.json(
          { ...scoreboard, summary: summarizeScoreboard(scoreboard) },
          { headers: { ...cors, "Cache-Control": "no-store" } },
        );
      }

      // Agent lookup over the committed tree: the Analysis form needs names, not the forest.
      if (pathname === "/api/agents/search") {
        const rejected = piiRejection(
          req,
          server.requestIP(req)?.address,
          ingress,
        );
        if (rejected !== null) {
          return Response.json(
            { success: false, error: rejected.error },
            { status: rejected.status, headers: cors },
          );
        }

        const treeFile = Bun.file(resolve(repoRoot, "data/agent-tree.json"));
        if (!(await treeFile.exists())) {
          return Response.json(
            { error: "no agent tree; run bun run build:agent-tree" },
            { status: 404, headers: cors },
          );
        }

        const query = (url.searchParams.get("q") ?? "").trim().toUpperCase();
        const limitRaw = Number(url.searchParams.get("limit") ?? 20);
        const limit = Math.min(
          Math.max(Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 20, 1),
          100,
        );
        if (query.length < 2) {
          return Response.json(
            {
              success: false,
              error: "q must be at least 2 characters",
              minLength: 2,
            },
            { status: 400, headers: cors },
          );
        }

        const tree = (await treeFile.json()) as {
          nodes?: Record<string, { l?: number | null; t?: string | null }>;
        };
        const nodes = tree.nodes ?? {};
        const matches = Object.entries(nodes)
          .filter(([key]) => key.includes(query))
          .sort((a, b) => {
            // Prefix hits first, then shortest name, then alphabetical.
            const aPrefix = a[0].startsWith(query) ? 0 : 1;
            const bPrefix = b[0].startsWith(query) ? 0 : 1;
            if (aPrefix !== bPrefix) return aPrefix - bPrefix;
            if (a[0].length !== b[0].length) return a[0].length - b[0].length;
            return a[0].localeCompare(b[0]);
          })
          .slice(0, limit)
          .map(([key, node]) => ({
            key,
            level: typeof node.l === "number" ? node.l : null,
            agentType: node.t ?? null,
          }));

        return Response.json(
          { success: true, query, count: matches.length, agents: matches },
          { headers: { ...cors, "Cache-Control": "no-store" } },
        );
      }

      // Agent forest, joined with the wager rollup so a tree node can show its own exposure.
      if (pathname === "/api/agent-tree") {
        const rejected = piiRejection(
          req,
          server.requestIP(req)?.address,
          ingress,
        );
        if (rejected !== null) {
          return Response.json(
            { success: false, error: rejected.error },
            { status: rejected.status, headers: cors },
          );
        }
        const treeFile = Bun.file(resolve(repoRoot, "data/agent-tree.json"));
        if (!(await treeFile.exists())) {
          return Response.json(
            { error: "no agent tree; run bun run build:agent-tree" },
            { status: 404, headers: cors },
          );
        }
        const tree = (await treeFile.json()) as Record<string, unknown>;
        const { agents } = await loadLiveBets();
        const counts: Record<
          string,
          { games: number; wagered: number; toWin: number }
        > = {};
        for (const agent of agents.agents) {
          counts[agent.key] = {
            games: agent.games,
            wagered: agent.wagered,
            toWin: agent.toWin,
          };
        }
        return Response.json(
          { ...tree, counts },
          { headers: { ...cors, "Cache-Control": "no-store" } },
        );
      }

      if (pathname.startsWith("/assets/")) {
        const asset = pathname.slice("/assets/".length);
        // realpath containment, not just a name check: Bun 1.4.4's `routes: { "/*": { dir } }`
        // serves a symlink's target even when it points outside the directory (measured), and
        // `Bun.file().exists()` follows links too. docs/assets has no symlinks today; this keeps
        // it that way instead of trusting the platform.
        const contained = containedAssetPath(
          resolve(repoRoot, "docs/assets"),
          asset,
        );
        if (contained === null) {
          return new Response(
            isSafeAssetName(asset) ? "not found" : "invalid asset",
            {
              status: isSafeAssetName(asset) ? 404 : 400,
              headers: cors,
            },
          );
        }
        return new Response(Bun.file(contained), {
          headers: { ...cors, "Cache-Control": "public, max-age=3600" },
        });
      }

      // Telegram webhook: Telegram echoes the secret registered by setWebhook in this header
      if (pathname === "/telegram/webhook" && req.method === "POST") {
        if (
          !telegramService.isWebhookSecretValid(
            req.headers.get("x-telegram-bot-api-secret-token"),
          )
        ) {
          return Response.json({ ok: false }, { status: 401, headers: cors });
        }
        const update = (await req
          .json()
          .catch(() => null)) as TelegramUpdate | null;
        if (update) {
          await telegramService
            .handleUpdate(update)
            .catch((err) =>
              console.error("[Telegram webhook] update failed:", err),
            );
        }
        return Response.json({ ok: true }, { headers: cors });
      }

      if (
        pathname === "/api/watchlist" ||
        pathname.startsWith("/api/telegram/")
      ) {
        const rejected = adminRejection(req);
        if (rejected) {
          return Response.json(
            { success: false, error: rejected.error },
            { status: rejected.status, headers: cors },
          );
        }
      }

      if (
        pathname === "/api/telegram/status" &&
        (req.method === "GET" || req.method === "HEAD")
      ) {
        return Response.json(
          {
            success: true,
            status: await telegramService.getStatus(),
            schedules: scheduler.getSchedules(),
            reportTypes: REPORT_TYPES,
          },
          { headers: cors },
        );
      }

      if (
        pathname === "/api/telegram/activity" &&
        (req.method === "GET" || req.method === "HEAD")
      ) {
        const limit = Math.min(
          Math.max(Number(url.searchParams.get("limit")) || 50, 1),
          200,
        );
        return Response.json(
          { success: true, entries: await telegramService.getActivity(limit) },
          { headers: cors },
        );
      }

      if (pathname === "/api/telegram/webhook" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          action?: string;
        };
        if (body.action !== "set" && body.action !== "delete") {
          return Response.json(
            { success: false, error: 'action must be "set" or "delete"' },
            { status: 400, headers: cors },
          );
        }
        const res =
          body.action === "set"
            ? await telegramService.setWebhook()
            : await telegramService.deleteWebhook();
        return Response.json(
          {
            success: res.ok,
            ok: res.ok,
            error: res.ok ? undefined : res.description,
          },
          { status: res.ok ? 200 : 502, headers: cors },
        );
      }

      // 11. REST API: Monitored Watch List Accounts
      if (pathname === "/api/watchlist") {
        const list = Array.from(telegramService.getWatchList().values());
        return Response.json(
          {
            success: true,
            count: list.length,
            data: list,
          },
          { headers: cors },
        );
      }

      // 12. REST API: Instant Telegram Alert Dispatch
      if (pathname === "/api/telegram/alert" && req.method === "POST") {
        try {
          const body = (await req.json().catch(() => ({}))) as {
            customerId?: string;
          };
          const custId = body.customerId || "RF2003";
          const sent = await telegramService.dispatchTestAlert(custId);
          return Response.json(
            {
              success: true,
              ok: sent,
              customerId: custId,
            },
            { headers: cors },
          );
        } catch (err: any) {
          return Response.json(
            {
              success: false,
              ok: false,
              error: err?.message || String(err),
            },
            { status: 500, headers: cors },
          );
        }
      }

      // 13. REST API: Scheduled Executive Report Trigger
      if (pathname === "/api/telegram/report" && req.method === "POST") {
        const type = url.searchParams.get("type") || "EVENING_SETTLEMENT";
        if (!isReportType(type)) {
          return Response.json(
            {
              success: false,
              error: `type must be one of ${REPORT_TYPES.join(", ")}`,
            },
            { status: 400, headers: cors },
          );
        }
        const sent = await scheduler.dispatchReportNow(type);
        return Response.json(
          {
            success: true,
            ok: sent,
            reportType: type,
          },
          { headers: cors },
        );
      }

      // 14. 404 Fallback
      return Response.json(
        {
          success: false,
          error: "Not Found",
          pathname,
        },
        { status: 404, headers: cors },
      );
    },

    error(err) {
      console.error("[SportsDesk Server Error]", err);
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "An unexpected error occurred";

      return Response.json(
        {
          success: false,
          error: "Internal Server Error",
          message,
        },
        { status: 500, headers: baseHeaders },
      );
    },
  };

  if (unixSocket) {
    (serveConfig as any).unix = unixSocket;
  } else {
    if (options?.port !== undefined) {
      serveConfig.port = options.port;
    }
    if (options?.hostname !== undefined) {
      serveConfig.hostname = options.hostname;
    }
  }

  const server = Bun.serve(serveConfig);
  return server;
}

if (import.meta.main) {
  const server = startServer();
  const location = server.url ? server.url.toString() : "unix domain socket";
  console.log(`[SportsDesk Webview Server] Active on ${location}`);
  console.log(` • Master Dashboard : ${location}`);
  console.log(` • Mini App (TMA)   : ${location}miniapp`);
  console.log(` • Health Probe     : ${location}health`);
  console.log(` • Watch List API   : ${location}api/watchlist`);
}
