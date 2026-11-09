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

import type { TrackerState } from "../lib/tracker_dashboard.ts";
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
  type WagerListArtifact,
} from "../lib/live_wagers.ts";
import { normalizeTicket } from "../lib/live_ticket_view.ts";
import { DETERMINISTIC_RULES, toRuleTicket } from "../cli/rules.ts";
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
import {
  deriveDeskKpis,
  freshness,
  readCustomerBookSummary,
  recordedTime,
  type KpiInput,
} from "../lib/desk_kpis.ts";
import { buildDeskEnhancedHealth } from "../lib/desk_enhanced_health.ts";
import { probeR2PipelineKpis } from "../lib/r2_pipeline_kpis.ts";
import { ReportingSchedulerService } from "./reporting_scheduler_service.ts";
import {
  describeSource,
  resolveSecretEnv,
  SECRET_ENV_GROUPS,
} from "../lib/secret_env.ts";
import {
  REPORT_TYPES,
  SportsDeskTelegramService,
  isReportType,
  type TelegramUpdate,
} from "./sportsdesk_telegram_bot.ts";
import { containedAssetPath, isSafeAssetName } from "../lib/asset_path.ts";
import { cachedJsonFile, readFileBytes } from "../lib/artifact_cache.ts";
import {
  buildStatusTelemetry,
  graphFingerprint,
  loadDashboardSummary,
  type DashboardAutomation,
} from "../lib/dashboard_metrics.ts";
import { KalshiClient } from "../lib/kalshi_client.ts";
import {
  joinConfigFromEnv,
  joinWatchlistSignals,
} from "../lib/kalshi_signal_join.ts";
import {
  deriveWatchlistSignals,
  loadWatchlistSignalInputs,
  type WatchlistSignal,
} from "../lib/watchlist_signal_engine.ts";
import { loadGsliveWeblogActivity } from "../lib/gslive_weblog_activity.ts";
import {
  registerGsidRotationHook,
  resetGsliveAutoSessionCache,
} from "../lib/gslive_auto_session.ts";
import { createGsliveSessionMonitor } from "../lib/gslive_session_health.ts";
import { resolveManagerSession } from "../lib/manager_session.ts";
import {
  buildExecutionPlan,
  placeKalshiLiveOrder,
  resolveKalshiLiveReady,
} from "../lib/execution_planner.ts";
import {
  LIVE_CONFIRM_PHRASE,
  type ExecutionDecision,
  type ExecutionMode,
} from "../lib/execution_decision.ts";
import {
  appendExecutionLedgerRow,
  fillTakerFromDecision,
  makeMakerQuote,
  paperIntentId,
  readExecutionLedger,
  sweepMakerQuotes,
  type PaperFill,
  type PaperQuote,
} from "../lib/execution_paper.ts";
import {
  approvedSignalIds,
  readExecutionApprovals,
  type ExecutionApprovalStyle,
} from "../lib/execution_approvals.ts";
import {
  defaultAgentGraphViewPaths,
  isAgentGraphWebpFresh,
} from "../lib/f402_agent_graph_view_http.ts";
import {
  buildHierarchy,
  type HierarchyAction,
  type RawHierarchyTree,
} from "../lib/hierarchy_view.ts";
import { encodedResponse, negotiateEncoding } from "../lib/http_compression.ts";
import { imageErrorCode, type ImageErrorCode } from "../lib/image_errors.ts";
import {
  contentTypeFor,
  inspectLogo,
  logoHeaders,
  resizeLogo,
  type LogoMetadata,
} from "../lib/logo_image.ts";
import {
  sendFrameOrClose,
  WS_BACKPRESSURE_OPTIONS,
} from "../lib/ws_backpressure.ts";
import {
  createDeskLiveReads,
  parseLiveSourceMode,
  type LivePendingServerOptions,
  type LiveRefreshOptions,
  type LiveTickerServerOptions,
} from "../lib/desk_live_reads.ts";

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

/**
 * A file-backed response, compressed when the client asked for it.
 *
 * The version is the path plus the file's mtime/size: two files can share a timestamp, and a
 * rewritten artifact must not reuse the previous body.
 */
async function fileResponse(
  req: Request,
  path: string,
  contentType: string,
  headers: Record<string, string>,
): Promise<Response> {
  // A client that accepts no encoding gets the file streamed by Bun, which keeps byte ranges and
  // does no work in this process. Only the compressed path needs the bytes in memory.
  if (negotiateEncoding(req.headers.get("accept-encoding")) === null) {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return Response.json(
        {
          success: false,
          error: "Not Found",
          pathname: new URL(req.url).pathname,
        },
        { status: 404, headers },
      );
    }
    return new Response(file, {
      headers: { ...headers, "Content-Type": contentType },
    });
  }

  const bytes = await readFileBytes(path);
  if (bytes === null) {
    return Response.json(
      {
        success: false,
        error: "Not Found",
        pathname: new URL(req.url).pathname,
      },
      { status: 404, headers },
    );
  }
  return encodedResponse(req, {
    version: `${path}|${bytes.version}`,
    contentType,
    produce: () => bytes.value,
    headers: { ...headers, "Accept-Ranges": "none" },
  });
}

export interface ServerOptions {
  readonly port?: number;
  readonly hostname?: string;
  readonly unix?: string;
  readonly development?: boolean | { readonly hmr?: boolean };
  /** Where `bet-ticker.json` and `live-wagers.json` live; defaults to the repo's `data/`. */
  readonly wagerListDir?: string;
  /** Kalshi fetch, injectable so the API tests stay offline (defaults to global `fetch`). */
  readonly kalshiFetch?: typeof fetch;
  /** Kalshi clock, injectable for deterministic cache/TTL tests (defaults to `Date.now`). */
  readonly kalshiNow?: () => number;
  /** Threshold source for the join; defaults to `Bun.env`. */
  readonly kalshiEnv?: Readonly<Record<string, string | undefined>>;
  /** Polymarket gamma/CLOB fetch, injectable so execution tests stay offline. */
  readonly polymarketFetch?: typeof fetch;
  /** Execution clock, injectable for deterministic plans and the 2s run rate limit. */
  readonly executionNow?: () => Date;
  /** Ledger checkout root; tests point this at a temp dir so no real ledger is written. */
  readonly executionLedgerRoot?: string;
  /** Policy env for the execution engine; defaults to `Bun.env`. */
  readonly executionEnv?: Readonly<Record<string, string | undefined>>;
  /** State for GET /tracker; tests inject one so no gh, git or keychain call is made. */
  readonly trackerState?: () => Promise<TrackerState>;
  /** Fallback artifact for live-bets; defaults to `data/live-bets.json` under the repo. */
  readonly liveBetsPath?: string;
  readonly liveTicker?: LiveTickerServerOptions;
  readonly livePending?: LivePendingServerOptions;
  readonly liveRefresh?: LiveRefreshOptions;
  /** When true, `import.meta.main` may start the live refresh loop from env. */
  readonly daemonEntry?: boolean;
}

/**
 * Artifacts are parsed once per file version, not once per request: six of these routes re-read
 * and re-parsed 5-110 KB of JSON on every call before the cache existed (measured 0.85 ms for the
 * 94 KB agent tree). `cachedJsonFile` keys on mtime + size, so a capture that rewrites a file is
 * picked up on the next request and nothing serves a stale artifact.
 */
const ANALYSIS_REPORT_PATH = "data/analysis-cp-baseball-2026-11-01.json";
const SPORT_CATALOG_PATH =
  "tests/fixtures/fantasy402-sport-catalog-2026-10-21.json";

const LIVE_BETS_PATH = resolve(repoRoot, "data/live-bets.json");
const AGENT_TREE_PATH = resolve(repoRoot, "data/agent-tree.json");
const CUSTOMER_PROFILES_PATH = resolve(repoRoot, "data/customer-profiles.json");

function liveBetsArtifactFor(path: string) {
  return cachedJsonFile(path, (raw) => raw as LiveBetsArtifact);
}
const customerBookArtifact = cachedJsonFile(
  CUSTOMER_PROFILES_PATH,
  readCustomerBookSummary,
);
const analysisReportArtifact = cachedJsonFile(
  resolve(repoRoot, ANALYSIS_REPORT_PATH),
  readAnalysisReport,
);
/** Lazily resolves the GSID and caches the cookie-only v4 probe for two minutes. */
const gsliveSessionMonitor = createGsliveSessionMonitor({
  resolveSession: () => resolveManagerSession(),
});
registerGsidRotationHook(() => {
  gsliveSessionMonitor.clearProbeCache();
  resetGsliveAutoSessionCache();
});

const contestsArtifact = cachedJsonFile(
  resolve(repoRoot, "data/contests.json"),
  readContestFile,
);
const boardArtifact = cachedJsonFile(
  resolve(repoRoot, "data/game-admin-board.json"),
  readBoardFile,
);
const catalogArtifact = cachedJsonFile(
  resolve(repoRoot, SPORT_CATALOG_PATH),
  loadSportCatalog,
);
const scoreboardArtifact = cachedJsonFile(
  resolve(repoRoot, "data/scoreboard.json"),
  readScoreboardFile,
);
const agentTreeArtifact = cachedJsonFile(
  AGENT_TREE_PATH,
  (raw) => raw as AgentTree,
);

interface AgentTree {
  readonly nodes?: Record<string, { l?: number | null; t?: string | null }>;
  readonly [key: string]: unknown;
}

/** An artifact plus its file mtime, for KPIs whose artifact records no observation time. */
async function kpiInput<T>(
  path: string,
  artifact: { read(): Promise<{ value: T | null } | null> },
): Promise<KpiInput<T> | null> {
  const [read, stat] = await Promise.all([
    artifact.read(),
    Bun.file(path)
      .stat()
      .catch(() => null),
  ]);
  if (read === null || read.value === null || stat === null) return null;
  return { value: read.value, mtime: stat.mtime };
}

/** `null` unless the payload is a wager list: an object whose `LIST` is an array, or an array. */
function readStrictWagerList(raw: unknown): WagerListArtifact | null {
  const listed =
    Array.isArray(raw) ||
    (typeof raw === "object" &&
      raw !== null &&
      Array.isArray((raw as { LIST?: unknown }).LIST));
  return listed ? readWagerListArtifact(raw) : null;
}

interface WagerListSource {
  /** Repo-relative name, the only path a response carries. */
  readonly label: string;
  readonly path: string;
  readonly artifact: ReturnType<
    typeof cachedJsonFile<WagerListArtifact | null>
  >;
}

export interface WagerListCandidate {
  readonly path: string;
  readonly version: string;
  readonly artifact: WagerListArtifact;
  readonly mtime: Date;
}

export interface WagerListSelection {
  readonly chosen: WagerListCandidate | null;
  /** Files that exist but were not served, with the reason. */
  readonly skipped: ReadonlyArray<{ path: string; reason: string }>;
}

/** In preference order: on equal observation times the first source wins. */
function wagerListSources(dir: string): readonly WagerListSource[] {
  return [
    { label: "data/bet-ticker.json", name: "bet-ticker.json" },
    { label: "data/live-wagers.json", name: "live-wagers.json" },
  ].map(({ label, name }) => {
    const path = resolve(dir, name);
    return { label, path, artifact: cachedJsonFile(path, readStrictWagerList) };
  });
}

/** A recorded observation time outranks any file mtime; mtime only orders undated files. */
function newerWagerList(
  a: { recordedMs: number | null; mtimeMs: number },
  b: { recordedMs: number | null; mtimeMs: number },
): boolean {
  if (a.recordedMs !== null && b.recordedMs !== null) {
    return a.recordedMs > b.recordedMs;
  }
  if (a.recordedMs !== null || b.recordedMs !== null) {
    return a.recordedMs !== null;
  }
  return a.mtimeMs > b.mtimeMs;
}

/**
 * The newest valid wager list among `sources`.
 *
 * Ranking uses the artifact's own `observedAt` (via `recordedTime`), not the file mtime alone: a
 * checkout rewrites a local artifact's mtime to now, and that must not shadow a real capture.
 * A file that is not a list (or not JSON) is skipped rather than served as zero wagers or a 500.
 */
async function loadWagerList(
  sources: readonly WagerListSource[],
): Promise<WagerListSelection> {
  const now = new Date();
  const skipped: Array<{ path: string; reason: string }> = [];
  const valid: Array<
    WagerListCandidate & { recordedMs: number | null; mtimeMs: number }
  > = [];
  for (const source of sources) {
    let read: Awaited<ReturnType<WagerListSource["artifact"]["read"]>>;
    try {
      read = await source.artifact.read();
    } catch (error) {
      skipped.push({
        path: source.label,
        reason: error instanceof SyntaxError ? "invalid JSON" : "unreadable",
      });
      continue;
    }
    if (read === null) continue;
    if (read.value === null) {
      skipped.push({ path: source.label, reason: "no LIST array" });
      continue;
    }
    const stat = await Bun.file(source.path)
      .stat()
      .catch(() => null);
    if (stat === null) continue;
    valid.push({
      path: source.label,
      version: read.version,
      artifact: read.value,
      mtime: stat.mtime,
      recordedMs: recordedTime(read.value.provenance.observedAt, now),
      mtimeMs: stat.mtime.getTime(),
    });
  }

  const newest = valid.reduce<(typeof valid)[number] | null>(
    (best, candidate) =>
      best === null || newerWagerList(candidate, best) ? candidate : best,
    null,
  );
  for (const candidate of valid) {
    if (candidate !== newest && newest !== null) {
      skipped.push({
        path: candidate.path,
        reason: `older than ${newest.path}`,
      });
    }
  }
  if (newest === null) return { chosen: null, skipped };
  const { path, version, artifact, mtime } = newest;
  return { chosen: { path, version, artifact, mtime }, skipped };
}

/** Reads the committed artifact first; falls back to the captured sample row. */
async function loadLiveBetsFrom(
  liveBetsArtifact: ReturnType<typeof liveBetsArtifactFor>,
): Promise<{
  games: LiveBetGame[];
  agents: AgentScope;
  pendingCount: number;
  dataSource: string;
  capturedAt: string | null;
  /** Which artifact version answered, so a response body can be cached on it. */
  version: string;
}> {
  const artifact = await liveBetsArtifact.read();
  if (artifact !== null) {
    return {
      games: [...artifact.value.games],
      agents: artifact.value.agents,
      pendingCount: artifact.value.pendingCount,
      dataSource: artifact.value.dataSource,
      capturedAt: artifact.value.capturedAt,
      version: `live-bets:${artifact.version}`,
    };
  }

  const sampleFile = Bun.file(
    resolve(repoRoot, "tests/f402-pending-wager-sample.json"),
  );
  const sampleStat = await sampleFile.stat().catch(() => null);
  if (sampleStat === null) {
    return {
      games: [],
      agents: summarizeAgents([]),
      pendingCount: 0,
      dataSource: "none",
      capturedAt: null,
      version: "live-bets:none",
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
    version: `live-bets:sample:${sampleStat.mtimeMs}:${sampleStat.size}`,
  };
}

/** A stored Analysis report result, when one has been transcribed. */
async function loadAnalysisReport() {
  return (await analysisReportArtifact.read())?.value ?? null;
}

/** Game Admin "Admin" module: per-game lines and the money on each side. */
async function loadBoard() {
  return (await boardArtifact.read())?.value ?? null;
}

/** Portal scoreboard transcribed from the manager page; null when absent. */
async function loadScoreboard(): Promise<ScoreboardFile | null> {
  return (await scoreboardArtifact.read())?.value ?? null;
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

/**
 * Where team logos come from, and the memo of what came back.
 *
 * The scoreboard's `LogoTeam1`/`LogoTeam2` are file names, and the same handful repeat across every
 * refresh, so the decoded bytes are kept for an hour rather than re-fetched per request. The key
 * includes the requested width and the base URL: `SPORTSDESK_LOGO_BASE_URL` exists so a test can
 * point at a fixture instead of the CDN, and pointing it elsewhere must not serve the old bytes.
 */
const LOGO_CACHE_TTL_MS = 60 * 60 * 1000;
const LOGO_CACHE_MAX = 64;
const MAX_LOGO_BYTES = 4 * 1024 * 1024;
const DEFAULT_LOGO_BASE_URL = "https://cdn.fastassets.io/images/team-logos/";

interface CachedLogo {
  readonly at: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly metadata: LogoMetadata;
  readonly resized: boolean;
}

const logoCache = new Map<string, CachedLogo>();

/**
 * Codes that describe the upstream bytes. `ERR_OUT_OF_MEMORY`, `ERR_IMAGE_ENCODE_FAILED` and
 * `ERR_INVALID_STATE` are this process's failures and must not be reported as a bad upstream image.
 */
type UpstreamImageFault = Extract<
  ImageErrorCode,
  | "ERR_IMAGE_FORMAT_UNSUPPORTED"
  | "ERR_IMAGE_TOO_MANY_PIXELS"
  | "ERR_IMAGE_DECODE_FAILED"
  | "ERR_IMAGE_UNKNOWN_FORMAT"
>;

function isUpstreamImageFault(
  code: ImageErrorCode,
): code is UpstreamImageFault {
  switch (code) {
    case "ERR_IMAGE_FORMAT_UNSUPPORTED":
    case "ERR_IMAGE_TOO_MANY_PIXELS":
    case "ERR_IMAGE_DECODE_FAILED":
    case "ERR_IMAGE_UNKNOWN_FORMAT":
      return true;
    case "ERR_IMAGE_ENCODE_FAILED":
    case "ERR_OUT_OF_MEMORY":
    case "ERR_INVALID_STATE":
      return false;
  }
}

type LogoResult =
  | ({ readonly kind: "ok" } & CachedLogo)
  | { readonly kind: "upstream"; readonly status: number }
  | { readonly kind: "undecodable"; readonly code: UpstreamImageFault }
  | { readonly kind: "too-large"; readonly bytes: number };

function logoBaseUrl(): string {
  const configured = Bun.env.SPORTSDESK_LOGO_BASE_URL ?? "";
  return configured === "" ? DEFAULT_LOGO_BASE_URL : configured;
}

async function fetchLogo(
  name: string,
  width: number | null,
): Promise<LogoResult> {
  const base = logoBaseUrl();
  const key = `${base}|${name}|${width ?? 0}`;
  const hit = logoCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < LOGO_CACHE_TTL_MS) {
    return { kind: "ok", ...hit };
  }

  const url = base + encodeURIComponent(name);
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return { kind: "upstream", status: res.status };

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_LOGO_BYTES) {
    return { kind: "too-large", bytes: declared };
  }
  const raw = new Uint8Array(await res.arrayBuffer());
  if (raw.byteLength > MAX_LOGO_BYTES) {
    return { kind: "too-large", bytes: raw.byteLength };
  }

  // The upstream content-type is a claim; decoding is the proof, and it is also where the
  // dimensions come from.
  let metadata: LogoMetadata;
  try {
    metadata = await inspectLogo(raw);
  } catch (error) {
    const code = imageErrorCode(error);
    if (code === undefined || !isUpstreamImageFault(code)) throw error;
    return { kind: "undecodable", code };
  }

  const processed =
    width === null
      ? { bytes: raw, metadata, resized: false }
      : await resizeLogo(raw, metadata, width);

  const entry: CachedLogo = {
    at: Date.now(),
    bytes: processed.bytes,
    metadata: processed.metadata,
    resized: processed.resized,
  };
  if (logoCache.size >= LOGO_CACHE_MAX) logoCache.clear();
  logoCache.set(key, entry);
  return { kind: "ok", ...entry };
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

/** Polymarket live is unavailable by construction in this checkout (no EIP-712 signer deps). */
const POLYMARKET_LIVE_UNAVAILABLE_REASON =
  "Polymarket live has no EIP-712 signer in this checkout (viem/ethers absent); paper only";

/** Dev-only CORS defaults when `SPORTSDESK_ALLOWED_ORIGINS` is unset (production never adds these). */
export const DEV_DEFAULT_CORS_ORIGINS = [
  "dsh-app://app",
  "http://localhost:3080",
  "http://127.0.0.1:3080",
] as const;

/**
 * Cross-origin grant list from env. In development, empty env picks {@link DEV_DEFAULT_CORS_ORIGINS}
 * so DSH Desktop and local `dsh web` can probe loopback without weakening production.
 */
export function resolveAllowedOrigins(
  isDevelopment: boolean,
  envOrigins: string | undefined = Bun.env.SPORTSDESK_ALLOWED_ORIGINS,
): string[] {
  const allowedOrigins = (envOrigins ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");

  if (isDevelopment && allowedOrigins.length === 0) {
    allowedOrigins.push(...DEV_DEFAULT_CORS_ORIGINS);
  }
  return allowedOrigins;
}

export function startServer(options?: ServerOptions) {
  const telegramService = new SportsDeskTelegramService();
  const scheduler = new ReportingSchedulerService(telegramService);
  const wagerListDir = options?.wagerListDir ?? resolve(repoRoot, "data");
  const wagerLists = wagerListSources(wagerListDir);
  const resolvedLiveBetsPath = resolve(options?.liveBetsPath ?? LIVE_BETS_PATH);
  const liveBetsArtifact = liveBetsArtifactFor(resolvedLiveBetsPath);
  const deskLive = createDeskLiveReads({
    repoRoot,
    liveBetsPath: resolvedLiveBetsPath,
    wagerListDir,
    ...(options?.liveTicker === undefined
      ? {}
      : { liveTicker: options.liveTicker }),
    ...(options?.livePending === undefined
      ? {}
      : { livePending: options.livePending }),
    ...(options?.liveRefresh === undefined
      ? {}
      : { liveRefresh: options.liveRefresh }),
    daemonEntry: options?.daemonEntry === true,
    readLiveBetsArtifact: async () =>
      (await liveBetsArtifact.read())?.value ?? null,
    loadWagerList: () => loadWagerList(wagerLists),
  });
  deskLive.startRefreshLoop();
  const loadLiveBets = () => loadLiveBetsFrom(liveBetsArtifact);
  const customerDashboardPath = resolve(
    repoRoot,
    "static/customer-churn-simulation-dashboard.html",
  );
  const miniappDashboardPath = resolve(
    repoRoot,
    "static/telegram-miniapp-dashboard.html",
  );

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
   * dashboard, the Mini App) need no header at all, so the default is to send none. Development
   * may add {@link DEV_DEFAULT_CORS_ORIGINS} when the env list is empty.
   */
  const corsDevelopment =
    options?.development === false
      ? false
      : options?.development === undefined
        ? typeof Bun !== "undefined"
          ? Bun.env.NODE_ENV !== "production"
          : process.env.NODE_ENV !== "production"
        : true;
  const allowedOrigins = resolveAllowedOrigins(corsDevelopment);

  /** Headers every response carries; the CORS grant is added per request by {@link corsHeadersFor}. */
  const baseHeaders: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With, X-Telegram-Bot-Api-Secret-Token",
    "Content-Security-Policy":
      "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram:;",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Language": "en",
    // Unconditional, not conditional on an `Origin` header being present. The same URL answers
    // differently per origin (grant or refusal), and the no-`Origin` variant is the one a cache is
    // most likely to store first; without `Vary` it would then be replayed — a refusal as often as
    // a grant — to every origin that asked afterwards. Measured before this: the grant-less
    // response carried no `Vary` at all.
    Vary: "Origin",
  };

  function corsHeadersFor(req: Request): Record<string, string> {
    const headers: Record<string, string> = { ...baseHeaders };
    const origin = req.headers.get("origin");
    // The refusal is origin-dependent too, so it carries `Vary` via `baseHeaders` above.
    if (origin !== null && allowedOrigins.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
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

  /**
   * Automation state for `summary.automation`, composed field by field.
   *
   * The telegram object is built explicitly instead of forwarding `getStatus()`: that object's
   * `bot`/`webhook` values carry URLs (a Telegram webhook URL embeds its bearer secret in the
   * path), and the summary is a PII-guarded response. Fields not named here cannot leak by
   * accident; the contract currently asks for `bot: null` and `webhook: null`.
   */
  async function summarizeDashboardAutomation(): Promise<{
    automation: DashboardAutomation;
    checks: Record<string, "ok" | "error">;
  }> {
    const relay = await getBridgeRelayStatus();
    const schedules = scheduler.getSchedules();
    let telegram: DashboardAutomation["telegram"];
    let telegramOk = true;
    try {
      const status = await telegramService.getStatus();
      telegram = {
        mode: status.mode,
        modeReason: status.modeReason.trim() === "" ? null : status.modeReason,
        tokenConfigured: status.tokenConfigured,
        defaultChatConfigured: status.defaultChatConfigured,
        authorizedChatCount: Number.isFinite(status.authorizedChatCount)
          ? status.authorizedChatCount
          : null,
        inbound: status.inbound,
        // Deliberately dropped: see the comment above. The panel renders these as "not exposed".
        bot: null,
        webhook: null,
        error: status.error,
      };
    } catch (error) {
      // A missing/broken bot service is null mode + the message; "simulation" is a configured
      // mode, not a stand-in for "we could not ask".
      telegramOk = false;
      telegram = {
        mode: null,
        modeReason: null,
        tokenConfigured: false,
        defaultChatConfigured: false,
        authorizedChatCount: null,
        inbound: "none",
        bot: null,
        webhook: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      automation: {
        wsRelay: relay,
        cron: {
          // The feed's `schedulerEngine` overrides this in the loader; `Bun.cron` is the
          // documented fallback when the feed carries none.
          engine: "Bun.cron",
          total: schedules.length,
          enabled: schedules.filter((schedule) => schedule.enabled).length,
          schedules: schedules.map((schedule) => ({
            id: schedule.id,
            name: schedule.name,
            scheduleTime: schedule.scheduleTime,
            enabled: schedule.enabled,
          })),
        },
        telegram,
      },
      // Same "ok" meaning /api/status uses: the service answered. A Telegram API error stays in
      // telegram.error for the panel and does not rewrite the daemon's own health.
      checks: { telegram: telegramOk ? "ok" : "error" },
    };
  }

  /** The non-file half of the SSE change signal; see `graphFingerprint`'s `extra`. */
  function automationChangeSignal(automation: DashboardAutomation): string {
    return [
      `relay:${automation.wsRelay.status}`,
      `relayStarted:${automation.wsRelay.started}`,
      `relayFrame:${automation.wsRelay.lastFrameAtIso ?? "-"}`,
      `telegram:${automation.telegram.mode ?? "-"}:${automation.telegram.tokenConfigured}:${automation.telegram.inbound}`,
      `cron:${automation.cron.enabled}/${automation.cron.total}`,
    ].join("|");
  }

  /**
   * The union of the signal sources' provenance for the route envelope.
   *
   * `fixture` is sticky: one fixture-derived signal makes the whole response's source block
   * fixture-capped, which is what the dashboard's pill renders.
   */
  function aggregateSignalProvenance(
    signals: readonly WatchlistSignal[],
    now: Date,
  ): {
    dataMode: string | null;
    asOf: string | null;
    ageSeconds: number | null;
    stale: boolean;
    fixture: boolean;
    sources: string[];
  } {
    const sources = new Set<string>();
    let dataMode: string | null = null;
    let asOf: string | null = null;
    let stale = false;
    let fixture = false;
    for (const signal of signals) {
      for (const source of signal.provenance.sources) sources.add(source);
      stale = stale || signal.provenance.stale;
      fixture = fixture || signal.provenance.fixture;
      if (dataMode === null && signal.provenance.dataMode !== null) {
        dataMode = signal.provenance.dataMode;
      }
      if (
        signal.provenance.asOf !== null &&
        (asOf === null || signal.provenance.asOf > asOf)
      ) {
        asOf = signal.provenance.asOf;
      }
    }
    const parsed = asOf === null ? null : Date.parse(asOf);
    return {
      dataMode,
      asOf,
      ageSeconds:
        parsed !== null && Number.isFinite(parsed)
          ? Math.max(0, Math.floor((now.getTime() - parsed) / 1000))
          : null,
      stale,
      fixture,
      sources: [...sources].sort(),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Execution engine (paper-first; live placement is gated below)       */
  /* ------------------------------------------------------------------ */

  const executionEnv = options?.executionEnv ?? Bun.env;
  const executionLedgerRoot = options?.executionLedgerRoot ?? repoRoot;
  const executionNow = (): Date => options?.executionNow?.() ?? new Date();
  const initialModeRaw = (executionEnv["EXECUTION_MODE"] ?? "paper")
    .trim()
    .toLowerCase();
  /** In-memory operator mode; the ledger records every change. */
  let executionMode: ExecutionMode =
    initialModeRaw === "paused"
      ? "paused"
      : initialModeRaw === "live"
        ? "live"
        : "paper";
  let lastExecutionRunAtMs = 0;
  const EXECUTION_RUN_INTERVAL_MS = 2_000;

  function executionStyleFrom(raw: unknown): ExecutionApprovalStyle | null {
    if (raw === undefined || raw === null || raw === "") return "auto";
    return raw === "auto" || raw === "taker" || raw === "maker" ? raw : null;
  }

  function executionPlanOptions(
    limit: number,
    mode: ExecutionMode,
    liveConfirm: string | null = null,
    stylePreference: ExecutionApprovalStyle = "auto",
    signalIds?: readonly string[],
  ): Parameters<typeof buildExecutionPlan>[0] {
    return {
      root: repoRoot,
      now: executionNow(),
      limit,
      mode,
      liveConfirm,
      stylePreference,
      ...(signalIds === undefined ? {} : { signalIds }),
      ledgerRoot: executionLedgerRoot,
      policyEnv: executionEnv,
      kalshiNow: options?.kalshiNow ?? (() => executionNow().getTime()),
      polymarketNow: () => executionNow().getTime(),
      ...(options?.kalshiFetch === undefined
        ? {}
        : { kalshiFetch: options.kalshiFetch }),
      ...(options?.polymarketFetch === undefined
        ? {}
        : { polymarketFetch: options.polymarketFetch }),
    };
  }

  function executionRiskSnapshot(plan: {
    readonly risk: {
      readonly dailyPlannedUsd: number;
      readonly openIntents: number;
      readonly marketExposureUsd: Readonly<Record<string, number>>;
    };
  }): {
    dailyPlannedUsd: number;
    openIntents: number;
    marketExposureUsd: Readonly<Record<string, number>>;
  } {
    return {
      dailyPlannedUsd: plan.risk.dailyPlannedUsd,
      openIntents: plan.risk.openIntents,
      marketExposureUsd: plan.risk.marketExposureUsd,
    };
  }

  function appendExecutionIntent(
    decision: ExecutionDecision,
    fill: PaperFill | null,
    quote: PaperQuote | null,
    snapshot: ReturnType<typeof executionRiskSnapshot>,
  ): void {
    const now = executionNow();
    appendExecutionLedgerRow(executionLedgerRoot, {
      kind: "intent",
      intentId: paperIntentId(decision, now),
      atIso: now.toISOString(),
      mode: "paper",
      decision,
      fill,
      quote,
      riskSnapshot: snapshot,
    });
  }

  /** Strip internal book evidence from a decision before it leaves the API. */
  function publicDecision(
    decision: ExecutionDecision,
  ): Omit<ExecutionDecision, "bookLevels"> {
    const { bookLevels: _bookLevels, ...rest } = decision;
    return rest;
  }

  function executionHeaders(): Record<string, string> {
    return {
      "Cache-Control": "no-store",
      Vary: "Origin, Authorization",
    };
  }

  const serveConfig = {
    development: isDevelopment ? { hmr: false } : false,
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

      // 2d. Bet-ticker XML: parse one feed document and echo the compact tree.
      if (pathname === "/api/parse-bet-ticker" && req.method === "POST") {
        try {
          const xml = new Uint8Array(await req.arrayBuffer());
          if (xml.byteLength === 0) {
            return Response.json(
              { error: "empty body" },
              { status: 400, headers: cors },
            );
          }
          const { parseBetTickerXml } = await import("../lib/live_wagers.ts");
          return Response.json(parseBetTickerXml(xml), { headers: cors });
        } catch (err) {
          return Response.json(
            { error: String(err) },
            { status: 400, headers: cors },
          );
        }
      }

      // 2i. TOML parse: parse one TOML document and echo the result.
      if (pathname === "/api/parse-toml" && req.method === "POST") {
        try {
          const text = await req.text();
          if (text.trim() === "") {
            return Response.json(
              { error: "empty body" },
              { status: 400, headers: cors },
            );
          }
          const { parseToml } = await import("../lib/toml_parse.ts");
          return Response.json(parseToml(text), { headers: cors });
        } catch (err) {
          return Response.json(
            { error: String(err) },
            { status: 400, headers: cors },
          );
        }
      }

      // 2h. Fantasy402 AJAX XML: parse one Fantasy402 AJAX XML response and echo the compact tree.
      if (pathname === "/api/parse-fantasy402-ajax" && req.method === "POST") {
        try {
          const xml = new Uint8Array(await req.arrayBuffer());
          if (xml.byteLength === 0) {
            return Response.json(
              { error: "empty body" },
              { status: 400, headers: cors },
            );
          }
          const { parseFantasy402AjaxXml: parse } =
            await import("../lib/customer_profile.ts");
          return Response.json(parse(xml), { headers: cors });
        } catch (err) {
          return Response.json(
            { error: String(err) },
            { status: 400, headers: cors },
          );
        }
      }

      // 2g. AJAX XML: parse one AJAX-delivered XML response and echo the compact tree.
      if (pathname === "/api/parse-ajax-xml" && req.method === "POST") {
        try {
          const xml = new Uint8Array(await req.arrayBuffer());
          if (xml.byteLength === 0) {
            return Response.json(
              { error: "empty body" },
              { status: 400, headers: cors },
            );
          }
          const { parseAjaxXml } = await import("../lib/customer_profile.ts");
          return Response.json(parseAjaxXml(xml), { headers: cors });
        } catch (err) {
          return Response.json(
            { error: String(err) },
            { status: 400, headers: cors },
          );
        }
      }

      // 2f. Transactions XML: parse one transactions document and echo the compact tree.
      if (pathname === "/api/parse-transactions" && req.method === "POST") {
        try {
          const xml = new Uint8Array(await req.arrayBuffer());
          if (xml.byteLength === 0) {
            return Response.json(
              { error: "empty body" },
              { status: 400, headers: cors },
            );
          }
          const { parseTransactionsXml } =
            await import("../lib/customer_profile.ts");
          return Response.json(parseTransactionsXml(xml), { headers: cors });
        } catch (err) {
          return Response.json(
            { error: String(err) },
            { status: 400, headers: cors },
          );
        }
      }

      // 2e. Customer performance XML: parse one performance document and echo the compact tree.
      if (
        pathname === "/api/parse-customer-performance" &&
        req.method === "POST"
      ) {
        try {
          const xml = new Uint8Array(await req.arrayBuffer());
          if (xml.byteLength === 0) {
            return Response.json(
              { error: "empty body" },
              { status: 400, headers: cors },
            );
          }
          const { parseCustomerPerformanceXml } =
            await import("../lib/customer_profile.ts");
          return Response.json(parseCustomerPerformanceXml(xml), {
            headers: cors,
          });
        } catch (err) {
          return Response.json(
            { error: String(err) },
            { status: 400, headers: cors },
          );
        }
      }

      // 2c. Customer profile XML: parse one profile document and echo the compact tree.
      if (pathname === "/api/parse-customer-profile" && req.method === "POST") {
        try {
          const xml = new Uint8Array(await req.arrayBuffer());
          if (xml.byteLength === 0) {
            return Response.json(
              { error: "empty body" },
              { status: 400, headers: cors },
            );
          }
          const { customerRowFromXml } =
            await import("../lib/customer_profile.ts");
          return Response.json(customerRowFromXml(xml), { headers: cors });
        } catch (err) {
          return Response.json(
            { error: String(err) },
            { status: 400, headers: cors },
          );
        }
      }

      // 2b. XML parse debug: parse one XML body with Bun.XML and echo the compact tree.
      if (pathname === "/api/parse-xml" && req.method === "POST") {
        try {
          const xml = new Uint8Array(await req.arrayBuffer());
          if (xml.byteLength === 0) {
            return Response.json(
              { error: "empty body" },
              { status: 400, headers: cors },
            );
          }
          const compact = url.searchParams.get("compact") !== "false";
          const parsed = compact
            ? Bun.XML.parse(xml)
            : Bun.XML.parse(xml, { compact: false });
          return Response.json(parsed, { headers: cors });
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

        const sourceMode = parseLiveSourceMode(url.searchParams.get("source"));
        if (sourceMode === "invalid") {
          return Response.json(
            { success: false, error: "source must be auto, live or file" },
            { status: 400, headers: cors },
          );
        }

        const isSummary = pathname.endsWith("/summary");
        const served = isSummary
          ? await deskLive.serveLiveBetsSummary(sourceMode)
          : await deskLive.serveLiveBets(sourceMode);
        const headers = { ...cors, "Cache-Control": "no-store" };

        if (isSummary) {
          const etag = `"${Buffer.from(served.etagParts ?? "").toString("base64url")}"`;
          const ifNoneMatch = req.headers.get("if-none-match");
          const summaryHeaders = {
            ...cors,
            "Cache-Control": "private, max-age=30, must-revalidate",
            Vary: "Origin, Authorization",
            ETag: etag,
          };
          if (served.httpStatus === 200 && ifNoneMatch === etag) {
            return new Response(null, { status: 304, headers: summaryHeaders });
          }
          return Response.json(served.body, {
            status: served.httpStatus,
            headers: summaryHeaders,
          });
        }

        if (served.httpStatus !== 200) {
          return Response.json(served.body, {
            status: served.httpStatus,
            headers,
          });
        }

        const games = (served.body.games as LiveBetGame[]) ?? [];
        const agents = served.body.agents as AgentScope;
        const summary = served.body.summary as ReturnType<
          typeof summarizeGames
        >;

        const scoreboard = await loadScoreboard();
        const withScores = games.map((game) => ({
          ...game,
          position: wagerTypeLabel(game.wagerType),
          category: sportCategoryFor({
            sportType: game.sport,
            sportSubType: game.subSport,
          }),
          scoreboard:
            scoreboard === null ||
            game.team1?.name == null ||
            game.team2?.name == null
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
            ...served.body,
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
        // `?w=N` asks for a downscale (16..1024); `?meta=1` asks for the measurement instead of
        // the pixels, which is what a layout needs to reserve the box before the image lands.
        const requestedWidth = Number(url.searchParams.get("w") ?? "");
        const width =
          Number.isFinite(requestedWidth) &&
          requestedWidth >= 16 &&
          requestedWidth <= 1024
            ? Math.trunc(requestedWidth)
            : null;
        const wantsMeta = /^(1|true|json)$/i.test(
          url.searchParams.get("meta") ?? "",
        );

        try {
          const logo = await fetchLogo(name, width);
          if (logo.kind === "upstream") {
            return new Response("not found", {
              status: logo.status,
              headers: cors,
            });
          }
          if (logo.kind === "too-large") {
            return Response.json(
              {
                error: "upstream image exceeds the size cap",
                bytes: logo.bytes,
              },
              { status: 502, headers: cors },
            );
          }
          if (logo.kind === "undecodable") {
            return Response.json(
              {
                error: "upstream did not return a decodable image",
                code: logo.code,
              },
              { status: 502, headers: cors },
            );
          }

          if (wantsMeta) {
            return Response.json(
              {
                name,
                source: logoBaseUrl() + encodeURIComponent(name),
                contentType: logo.metadata.contentType,
                width: logo.metadata.width,
                height: logo.metadata.height,
                format: logo.metadata.format,
                bytes: logo.metadata.bytes,
                resized: logo.resized,
                requestedWidth: width,
              },
              { headers: { ...cors, "Cache-Control": "no-store" } },
            );
          }

          return new Response(logo.bytes, {
            headers: {
              ...cors,
              ...logoHeaders(logo.metadata),
              "Content-Type": contentTypeFor(logo.metadata.format),
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
        const nodeEnv =
          (typeof Bun !== "undefined"
            ? Bun.env.NODE_ENV
            : process.env.NODE_ENV) || "development";
        const health = await buildDeskEnhancedHealth({
          port: server.port ?? Number(Bun.env.PORT ?? 4020),
          hostname: server.hostname ?? "127.0.0.1",
          url: server.url ? server.url.toString() : "unix://socket",
          uptimeSeconds: Math.floor(process.uptime()),
          runtime: `Bun v${Bun.version} (${process.arch}-${process.platform})`,
          ingress,
          nodeEnv,
          readGsliveHealth: () => gsliveSessionMonitor.read(false),
        });
        return Response.json(health, {
          status: health.httpStatus,
          headers: cors,
        });
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
            live: deskLive.statusBlock(),
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
        return fileResponse(
          req,
          resolve(repoRoot, "static/live-bets.html"),
          "text/html; charset=utf-8",
          cors,
        );
      }

      // 8. Executive Dashboard (GET / or GET /dashboard)
      if (pathname === "/" || pathname === "/dashboard") {
        return fileResponse(
          req,
          customerDashboardPath,
          "text/html; charset=utf-8",
          cors,
        );
      }

      // 8b. Status page (GET /status)
      if (pathname === "/status" || pathname === "/status/") {
        return fileResponse(
          req,
          resolve(repoRoot, "static/status.html"),
          "text/html; charset=utf-8",
          cors,
        );
      }

      // 9. Telegram Mini App (GET /miniapp)
      if (pathname === "/miniapp" || pathname === "/miniapp/") {
        return fileResponse(
          req,
          miniappDashboardPath,
          "text/html; charset=utf-8",
          cors,
        );
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
        return fileResponse(
          req,
          resolve(repoRoot, "docs/graph.html"),
          "text/html; charset=utf-8",
          { ...cors, "Cache-Control": "no-store" },
        );
      }

      if (pathname === "/graph.js") {
        return fileResponse(
          req,
          resolve(repoRoot, "docs/graph.js"),
          "application/javascript; charset=utf-8",
          { ...cors, "Cache-Control": "no-store" },
        );
      }

      // The dashboard's agent-tree raster.
      //
      // The markup asks for `agent-graph.webp` relative to `/`, and no arm answered it (measured
      // 2026-11-01: `GET /agent-graph.webp` → 404 JSON, `GET /assets/agent-graph.webp` → 404 text).
      // The file is written to `scratch/`, not `docs/assets`, and it is a rendering of the same
      // graph `/graph` serves — node labels are logins — so it takes the same guard. Freshness is
      // the viewer's rule, not a guess: a raster older than the graph it depicts is a 503 with the
      // command that fixes it, because a picture of the previous tree is worse than none.
      if (pathname === "/agent-graph.webp") {
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

        const paths = defaultAgentGraphViewPaths(repoRoot);
        const raster = await readFileBytes(paths.graphWebp);
        if (raster === null) {
          return Response.json(
            {
              success: false,
              error: "no agent graph raster; run bun run graph:agent:image",
            },
            { status: 404, headers: cors },
          );
        }
        if (!(await isAgentGraphWebpFresh(paths))) {
          return Response.json(
            {
              success: false,
              error: "stale agent graph raster; run bun run graph:agent:image",
            },
            { status: 503, headers: cors },
          );
        }

        return new Response(raster.value, {
          headers: {
            ...cors,
            "Content-Type": "image/webp",
            // Guarded per peer; an intermediary must not replay it to another one.
            "Cache-Control": "no-store",
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
        return fileResponse(
          req,
          resolve(repoRoot, "docs/graph-live-feed.json"),
          "application/json; charset=utf-8",
          { ...cors, "Cache-Control": "no-store" },
        );
      }

      // 11.1 Derived dashboard summary. Every count `docs/graph.html` renders comes from this
      // body, each section carrying its source/asOf/ageSeconds/stale (or an explicit
      // not_measured), so the page cannot claim a number it did not measure. The guard is the
      // graph page's own: the same data plane, and the route catalog names identifying surfaces.
      if (pathname === "/api/graph/summary" && req.method === "GET") {
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
        const { automation, checks } = await summarizeDashboardAutomation();
        const summary = await loadDashboardSummary({
          status: buildStatusTelemetry(checks),
          automation,
        });
        return Response.json(summary, {
          headers: {
            ...cors,
            "Cache-Control": "no-store",
            // The body is derived from artifacts *and* is served only because the peer allowed
            // the PII guard; the credential is part of the cache key.
            Vary: "Origin, Authorization",
          },
        });
      }

      // 11.2 The summary as server-sent events. The first frame is the whole summary; a 5s tick
      // re-derives it only when a stat fingerprint changes, and every tick also emits a
      // heartbeat comment. 5s, not 15s: Bun's default `idleTimeout` is 10s, so a 15s beat would
      // let the server close an otherwise healthy stream between beats.
      if (pathname === "/api/graph/stream" && req.method === "GET") {
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

        const encoder = new TextEncoder();
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        const cleanup = (): void => {
          if (closed) return;
          closed = true;
          if (heartbeat !== null) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
        };
        const frame = (event: string, data: unknown): string =>
          `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        // `req.signal` is Bun's disconnect notification; `cancel()` covers a stream the server
        // drops itself. Either path must clear the interval or each reconnecting tab leaks one.
        req.signal.addEventListener("abort", cleanup, { once: true });

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (chunk: string): void => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(chunk));
              } catch {
                cleanup();
              }
            };
            let fingerprint: string | null = null;
            try {
              const { automation, checks } =
                await summarizeDashboardAutomation();
              const summary = await loadDashboardSummary({
                status: buildStatusTelemetry(checks),
                automation,
              });
              fingerprint = await graphFingerprint({
                extra: [automationChangeSignal(automation)],
              });
              if (closed) return;
              send(frame("summary", summary));
              send(`: heartbeat ${Date.now()}\n\n`);
            } catch {
              cleanup();
              try {
                controller.close();
              } catch {
                /* already closed */
              }
              return;
            }
            heartbeat = setInterval(() => {
              if (closed) return;
              void (async () => {
                try {
                  const { automation, checks } =
                    await summarizeDashboardAutomation();
                  const next = await graphFingerprint({
                    extra: [automationChangeSignal(automation)],
                  });
                  if (closed) return;
                  if (next !== fingerprint) {
                    fingerprint = next;
                    const summary = await loadDashboardSummary({
                      status: buildStatusTelemetry(checks),
                      automation,
                    });
                    if (closed) return;
                    send(frame("summary", summary));
                  }
                } catch {
                  // A bad stat must not kill the stream; the heartbeat below still proves life.
                }
                if (!closed) send(`: heartbeat ${Date.now()}\n\n`);
              })();
            }, 5_000);
          },
          cancel() {
            cleanup();
          },
        });

        return new Response(stream, {
          headers: {
            ...cors,
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            // Nginx buffers proxied responses by default, which turns a stream into one
            // delayed write; this header is the documented opt-out.
            "X-Accel-Buffering": "no",
            Vary: "Origin, Authorization",
          },
        });
      }

      // 11.3 Watchlist signals joined to live Kalshi markets. Read-only by construction: the
      // client has no auth header and no order/portfolio URL, and a Kalshi failure becomes
      // `degraded` + `no_market`, never a fabricated price. Same guard as the graph page: the
      // accounts and their flow are customer-identifying.
      if (pathname === "/api/signals/kalshi" && req.method === "GET") {
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
        const now = new Date();
        const config = joinConfigFromEnv(options?.kalshiEnv ?? Bun.env);
        const client = new KalshiClient({
          ...(options?.kalshiFetch === undefined
            ? {}
            : { fetchImpl: options.kalshiFetch }),
          ...(options?.kalshiNow === undefined
            ? {}
            : { now: options.kalshiNow }),
        });
        const headers = {
          ...cors,
          "Cache-Control": "no-store",
          Vary: "Origin, Authorization",
        };
        try {
          const inputs = await loadWatchlistSignalInputs(repoRoot);
          const signals = deriveWatchlistSignals(inputs, { now });
          const joined = await joinWatchlistSignals(signals, {
            client,
            config,
          });
          return Response.json(
            {
              success: true,
              schemaVersion: 1,
              generatedAt: now.toISOString(),
              config,
              provenance: aggregateSignalProvenance(signals, now),
              kalshi: client.telemetry(),
              signals: joined,
            },
            { headers },
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const telemetry = client.telemetry();
          return Response.json(
            {
              success: true,
              schemaVersion: 1,
              generatedAt: now.toISOString(),
              config,
              provenance: {
                dataMode: null,
                asOf: null,
                ageSeconds: null,
                stale: false,
                fixture: false,
                sources: [],
              },
              kalshi: {
                ...telemetry,
                ok: false,
                degraded: true,
                errors: [
                  ...telemetry.errors,
                  { scope: "events", reason: message },
                ],
              },
              signals: [],
            },
            { headers },
          );
        }
      }

      // 11.4 GSLive WebLog activity from the local artifact. The reader never touches the
      // network; a missing artifact is `not_measured` with the refresh command, not zeros.
      if (pathname === "/api/gslive/weblogs" && req.method === "GET") {
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
        const now = new Date();
        const headers = {
          ...cors,
          "Cache-Control": "no-store",
          Vary: "Origin, Authorization",
        };
        try {
          const activity = loadGsliveWeblogActivity({ root: repoRoot, now });
          return Response.json(
            {
              ...activity,
              success: true,
              schemaVersion: 1,
              generatedAt: now.toISOString(),
            },
            { headers },
          );
        } catch (error) {
          return Response.json(
            {
              success: true,
              schemaVersion: 1,
              generatedAt: now.toISOString(),
              status: "not_measured",
              source: null,
              asOf: null,
              ageSeconds: null,
              stale: false,
              accounts: [],
              summary: { accounts: 0, bets: 0, flagsByCode: {} },
              reason: `GSLive WebLog reader failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              command: "bun run gslive:weblogs:refresh",
            },
            { headers },
          );
        }
      }

      // 11.4b GSLive Manager Tools session health. The probe is a cookie-only v4 GET; the
      // response carries cookie names and probe status, never the cookie value.
      if (pathname === "/api/gslive/session-health" && req.method === "GET") {
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
        try {
          const health = await gsliveSessionMonitor.read(
            url.searchParams.get("probe") === "1",
          );
          return Response.json(
            { success: true, ...health },
            {
              headers: {
                ...cors,
                "Cache-Control": "no-store",
                Vary: "Origin, Authorization",
              },
            },
          );
        } catch {
          return Response.json(
            { success: false, error: "GSLive session probe failed" },
            { status: 500, headers: cors },
          );
        }
      }

      /* ------------------------------------------------------------------ */
      /* 11.5 Execution engine (paper-first; no order call on plan/read)     */
      /* ------------------------------------------------------------------ */

      // Read-only plan: public books only, no order endpoint is reachable from this path.
      if (pathname === "/api/execution/plan" && req.method === "GET") {
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
        const limitRaw = Number(url.searchParams.get("limit") ?? "25");
        const limit = Number.isFinite(limitRaw)
          ? Math.max(1, Math.min(200, Math.trunc(limitRaw)))
          : 25;
        const style = executionStyleFrom(url.searchParams.get("style"));
        if (style === null) {
          return Response.json(
            {
              success: false,
              error: "invalid_style",
              message: "style must be auto, taker or maker",
            },
            { status: 400, headers: cors },
          );
        }
        const plan = await buildExecutionPlan(
          executionPlanOptions(limit, executionMode, null, style),
        );
        const approvals = await readExecutionApprovals(executionLedgerRoot);
        return Response.json(
          {
            success: true,
            schemaVersion: 1,
            generatedAt: plan.generatedAt,
            mode: plan.mode,
            style,
            approvals: approvals.rows,
            killSwitch: plan.killSwitch,
            policy: plan.policy,
            venues: plan.venues,
            risk: plan.risk,
            decisions: plan.decisions.map((decision) => ({
              ...publicDecision(decision),
              approval: approvals.latest.get(decision.signalId) ?? null,
            })),
            paper: {
              quotes: plan.paper.quotes,
              fills: plan.paper.fills,
              ledgerTail: plan.paper.ledgerTail,
            },
            blockedReasons: plan.blockedReasons,
            provenance: plan.provenance,
          },
          { headers: { ...cors, ...executionHeaders() } },
        );
      }

      // Mode switch (paper/paused, or live only with env + adapter + explicit confirm).
      if (pathname === "/api/execution/mode" && req.method === "POST") {
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
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json(
            { success: false, error: "invalid_json" },
            { status: 400, headers: cors },
          );
        }
        const record =
          typeof body === "object" && body !== null
            ? (body as Record<string, unknown>)
            : {};
        const requested = record["mode"];
        if (
          requested !== "paper" &&
          requested !== "paused" &&
          requested !== "live"
        ) {
          return Response.json(
            {
              success: false,
              error: "invalid_mode",
              allowed: ["paper", "paused", "live"],
            },
            { status: 400, headers: cors },
          );
        }
        if (requested === "live") {
          const readiness = await resolveKalshiLiveReady(
            repoRoot,
            executionEnv,
          );
          const reasons: string[] = [];
          if (executionEnv["EXECUTION_LIVE"] !== "1") {
            reasons.push("EXECUTION_LIVE is not 1");
          }
          if (!readiness.ready) {
            reasons.push(readiness.reason ?? "kalshi live not ready");
          }
          if (record["confirm"] !== "LIVE") {
            reasons.push('confirm must be "LIVE"');
          }
          if (reasons.length > 0) {
            return Response.json(
              {
                success: false,
                error: "live_not_armed",
                reasons,
                venues: {
                  kalshi: readiness,
                  polymarket: {
                    liveReady: false,
                    reason: POLYMARKET_LIVE_UNAVAILABLE_REASON,
                  },
                },
              },
              { status: 409, headers: cors },
            );
          }
        }
        const previousMode = executionMode;
        executionMode = requested;
        const now = executionNow();
        appendExecutionLedgerRow(executionLedgerRoot, {
          kind: "mode_change",
          intentId: `mode:${now.getTime()}`,
          atIso: now.toISOString(),
          mode: "paper",
          decision: null,
          fill: null,
          quote: null,
          riskSnapshot: null,
          note: requested,
        });
        return Response.json(
          {
            success: true,
            mode: executionMode,
            previousMode,
            killSwitch: executionMode === "paused",
            generatedAt: now.toISOString(),
          },
          { headers: { ...cors, ...executionHeaders() } },
        );
      }

      // One run: paper-fill (default) or live-place behind the full gate.
      if (pathname === "/api/execution/run" && req.method === "POST") {
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
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          body = {};
        }
        const record =
          typeof body === "object" && body !== null
            ? (body as Record<string, unknown>)
            : {};
        const live = record["live"] === true;
        const style = executionStyleFrom(record["style"]);
        if (style === null) {
          return Response.json(
            {
              success: false,
              error: "invalid_style",
              message: "style must be auto, taker or maker",
            },
            { status: 400, headers: cors },
          );
        }
        const requireApproval = record["requireApproval"] === true;
        const approvals = await readExecutionApprovals(executionLedgerRoot);
        const approved = approvedSignalIds(approvals);
        if (requireApproval && approved.length === 0) {
          return Response.json(
            {
              success: false,
              error: "no_approved_signals",
              message:
                "requireApproval is set but no signal has an operator approval",
            },
            { status: 409, headers: cors },
          );
        }
        const now = executionNow();
        const elapsed = now.getTime() - lastExecutionRunAtMs;
        if (lastExecutionRunAtMs !== 0 && elapsed < EXECUTION_RUN_INTERVAL_MS) {
          return Response.json(
            {
              success: false,
              error: "rate_limited",
              retryAfterMs: EXECUTION_RUN_INTERVAL_MS - elapsed,
            },
            { status: 429, headers: cors },
          );
        }
        lastExecutionRunAtMs = now.getTime();

        const plan = await buildExecutionPlan(
          executionPlanOptions(
            25,
            executionMode,
            live && record["confirm"] === LIVE_CONFIRM_PHRASE
              ? LIVE_CONFIRM_PHRASE
              : null,
            style,
            requireApproval ? approved : undefined,
          ),
        );
        const snapshot = executionRiskSnapshot(plan);

        if (live) {
          const readiness = await resolveKalshiLiveReady(
            repoRoot,
            executionEnv,
          );
          const reasons: string[] = [];
          if (executionMode === "paused") reasons.push("execution is paused");
          if (executionEnv["EXECUTION_LIVE"] !== "1") {
            reasons.push("EXECUTION_LIVE is not 1");
          }
          if (record["confirm"] !== LIVE_CONFIRM_PHRASE) {
            reasons.push(`confirm must be "${LIVE_CONFIRM_PHRASE}"`);
          }
          if (!readiness.ready) {
            reasons.push(readiness.reason ?? "kalshi live not ready");
          }
          if (reasons.length > 0) {
            return Response.json(
              {
                success: false,
                error: "live_not_armed",
                reasons,
                venues: {
                  kalshi: readiness,
                  polymarket: plan.venues.polymarket,
                },
              },
              { status: 409, headers: cors },
            );
          }
          const placed: unknown[] = [];
          const refused: unknown[] = [];
          for (const decision of plan.decisions) {
            if (decision.venue === "polymarket") {
              refused.push({
                decisionId: decision.id,
                venue: "polymarket",
                ok: false,
                reason: plan.venues.polymarket.reason,
              });
              continue;
            }
            if (
              decision.blocked ||
              decision.paper ||
              decision.venue !== "kalshi"
            )
              continue;
            const placement = await placeKalshiLiveOrder({
              decision,
              root: repoRoot,
              now: executionNow(),
              ...(options?.kalshiFetch === undefined
                ? {}
                : { fetchImpl: options.kalshiFetch }),
            });
            appendExecutionLedgerRow(executionLedgerRoot, {
              kind: "intent",
              intentId: `live:${placement.venueOrderId ?? decision.id}`,
              atIso: executionNow().toISOString(),
              mode: "paper",
              decision,
              fill: null,
              quote: null,
              riskSnapshot: snapshot,
              note: `live:${placement.reason ?? placement.status ?? "placed"}`,
            });
            placed.push({
              decisionId: decision.id,
              ok: placement.ok,
              reason: placement.reason,
              venueOrderId: placement.venueOrderId,
              status: placement.status,
              filledCount: placement.filledCount,
              avgPriceUsd: placement.avgPriceUsd,
            });
          }
          return Response.json(
            {
              success: true,
              mode: executionMode,
              generatedAt: now.toISOString(),
              live: true,
              placed,
              refused,
            },
            { headers: { ...cors, ...executionHeaders() } },
          );
        }

        // Paper path: sweep resting maker quotes first, then fill/quote this plan.
        const ledgerBefore = readExecutionLedger(executionLedgerRoot);
        const sweep = sweepMakerQuotes(
          ledgerBefore.openQuotes,
          plan.venueBooks,
          now,
        );
        for (const fill of sweep.fills) {
          appendExecutionLedgerRow(executionLedgerRoot, {
            kind: "intent",
            intentId: fill.intentId,
            atIso: now.toISOString(),
            mode: "paper",
            decision: null,
            fill,
            quote: null,
            riskSnapshot: snapshot,
            note: "maker_sweep_fill",
          });
        }
        for (const quote of sweep.quotes) {
          if (quote.status !== "expired") continue;
          appendExecutionLedgerRow(executionLedgerRoot, {
            kind: "intent",
            intentId: quote.intentId,
            atIso: now.toISOString(),
            mode: "paper",
            decision: null,
            fill: null,
            quote,
            riskSnapshot: snapshot,
            note: "maker_quote_expired",
          });
        }
        const fills: PaperFill[] = [...sweep.fills];
        const quotes: PaperQuote[] = sweep.quotes.filter(
          (quote) => quote.status === "open",
        );
        for (const decision of plan.decisions) {
          if (decision.blocked) continue;
          if (decision.style === "taker") {
            const fill = fillTakerFromDecision(
              decision,
              paperIntentId(decision, now),
              now,
            );
            if (fill.status !== "rejected") fills.push(fill);
            appendExecutionIntent(decision, fill, null, snapshot);
            continue;
          }
          if (decision.style === "maker") {
            const quote = makeMakerQuote(
              decision,
              paperIntentId(decision, now),
              now,
            );
            if (quote !== null) quotes.push(quote);
            appendExecutionIntent(decision, null, quote, snapshot);
          }
        }
        return Response.json(
          {
            success: true,
            mode: executionMode,
            style,
            approvals: requireApproval ? approvals.rows : [],
            generatedAt: now.toISOString(),
            live: false,
            decisions: plan.decisions.map((decision) => ({
              ...publicDecision(decision),
              approval: approvals.latest.get(decision.signalId) ?? null,
            })),
            paper: { fills, quotes },
            blockedReasons: plan.blockedReasons,
          },
          { headers: { ...cors, ...executionHeaders() } },
        );
      }

      if (GRAPH_DOCS_JSON.has(pathname)) {
        // Book-derived counts (customers in the book, linked wallets, combo gate totals): not
        // identifiers, but not for an anonymous reader. Bearer token only, loopback or not.
        // The guard is in serveGraphDocsJson at the end of this file so that this arm keeps its
        // line count: the evidence citations below it pin line numbers.
        // See docs/evidence/surfaces.md, surface.daemon-graph-data-plane.
        return serveGraphDocsJson(req, pathname, cors);
      }

      // Which analysis reports have been transcribed, so a client can select one instead of
      // guessing the selection it was run for.
      if (pathname === "/api/analysis/reports") {
        // `context` is the selection the report was run for, and its `agent` is a portal login
        // (`BILLY666` in the stored artifact). That is the same identifier `/api/analysis` guards,
        // so this index is customer-identifying too: an unguarded read here disclosed the login
        // that the guarded arm protects. Measured before the fix: a non-loopback peer without a
        // token got 200 with `BILLY666` while `/api/analysis` answered 503.
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

        const sourceMode = parseLiveSourceMode(url.searchParams.get("source"));
        if (sourceMode === "invalid") {
          return Response.json(
            { success: false, error: "source must be auto, live or file" },
            { status: 400, headers: cors },
          );
        }

        const fileSelection = await loadWagerList(wagerLists);
        const resolved = await deskLive.serveLiveWagers(
          sourceMode,
          fileSelection,
        );
        if (resolved.httpStatus !== 200) {
          return Response.json(resolved.body, {
            status: resolved.httpStatus,
            headers: { ...cors, "Cache-Control": "no-store" },
          });
        }

        const artifact = {
          wagers: (resolved.body.wagers as WagerListArtifact["wagers"]) ?? [],
          provenance: resolved.body
            .provenance as WagerListArtifact["provenance"],
        };
        const wagers = artifact.wagers;
        const skipped =
          (resolved.body.skipped as Array<{ path: string; reason: string }>) ??
          [];
        // No `ageSeconds`: it advances every second, and in the version it would turn each poll
        // into a new entry in the shared 48-body cache, which clears whole when full. The page
        // computes the age from `asOf`; `stale` flips once, so it can be part of the version.
        const fresh = (resolved.body.freshness as Omit<
          ReturnType<typeof freshness>,
          "ageSeconds"
        > & { stale: boolean }) ?? {
          stale: false,
          asOf: artifact.provenance.observedAt ?? new Date().toISOString(),
          asOfFrom: "artifact" as const,
        };
        const liveStatus = resolved.body.live;

        const writer = (url.searchParams.get("writer") ?? "")
          .trim()
          .toLowerCase();
        const type = (url.searchParams.get("type") ?? "").trim().toUpperCase();
        const filtered = wagers.filter(
          (wager) =>
            (writer === "" || wager.writer === writer) &&
            (type === "" || wager.wagerType === type),
        );

        const ruleTickets = filtered.map((wager) =>
          toRuleTicket(normalizeTicket(wager)),
        );
        const flags: Array<{
          rule: string;
          severity: string;
          evidence: Readonly<
            Record<string, string | number | readonly string[]>
          >;
          wagerNumbers: readonly string[];
        }> = [];
        const byRule: Record<string, number> = {};
        for (const [rule, run] of Object.entries(DETERMINISTIC_RULES)) {
          let hits: ReturnType<typeof run> = [];
          try {
            hits = run(ruleTickets);
          } catch {
            hits = [];
          }
          for (const hit of hits) {
            byRule[rule] = (byRule[rule] ?? 0) + 1;
            flags.push({
              rule: hit.rule,
              severity: hit.severity,
              evidence: hit.evidence,
              wagerNumbers: hit.tickets.map((ticket) => ticket.wagerNumber),
            });
          }
        }

        return encodedResponse(req, {
          // Every input to the bytes is in the version: the query, which file won, what was
          // skipped, and whether it has gone stale.
          version: `live-wagers|${fileSelection.chosen?.path ?? "none"}|${fileSelection.chosen?.version ?? "none"}|${artifact.provenance.source}|${fresh.stale}|${JSON.stringify(skipped)}|${writer}|${type}|${JSON.stringify(liveStatus)}`,
          contentType: "application/json; charset=utf-8",
          produce: () =>
            new TextEncoder().encode(
              JSON.stringify({
                success: true,
                summary: summarizeLiveWagers(filtered),
                all: summarizeLiveWagers(wagers),
                writer: writer === "" ? null : writer,
                type: type === "" ? null : type,
                provenance: artifact.provenance,
                freshness: fresh,
                skipped,
                wagers: filtered,
                flags,
                byRule,
                live: liveStatus,
              }),
            ),
          headers: { ...cors, "Cache-Control": "no-store" },
        });
      }

      // Contest / futures list: the sports nav's get-games-prop anchors.
      if (pathname === "/api/contests") {
        const cachedContests = await contestsArtifact.read();
        // A parse that returns null is "this file is not a contest list", same as absent.
        if (cachedContests === null || cachedContests.value === null) {
          return Response.json(
            {
              error: "no contest list",
              hint: "bun run contests:extract --html <saved sports nav markup>",
            },
            { status: 404, headers: cors },
          );
        }
        const contests = cachedContests.value;

        const group = url.searchParams.get("group") ?? "";
        const query = url.searchParams.get("q") ?? "";
        const filtered = searchContests(
          { ...contests, entries: contestsInGroup(contests, group) },
          query,
        );

        return encodedResponse(req, {
          version: `contests|${cachedContests.version}|${group}|${query}`,
          contentType: "application/json; charset=utf-8",
          produce: () =>
            new TextEncoder().encode(
              JSON.stringify({
                success: true,
                source: contests.source,
                extractedAt: contests.extractedAt,
                summary: summarizeContests(contests),
                group: group === "" ? null : group,
                query: query === "" ? null : query,
                count: filtered.length,
                entries: filtered,
              }),
            ),
          headers: { ...cors, "Cache-Control": "no-store" },
        });
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
        const cachedCatalog = await catalogArtifact.read();
        if (cachedCatalog === null || cachedCatalog.value === null) {
          return Response.json(
            { error: "no sport catalog fixture" },
            { status: 404, headers: cors },
          );
        }
        const catalog = cachedCatalog.value;

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

        return encodedResponse(req, {
          version: `catalog|${cachedCatalog.version}|${sportFilter}|${codeFilter}`,
          contentType: "application/json; charset=utf-8",
          produce: () =>
            new TextEncoder().encode(
              JSON.stringify({
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
              }),
            ),
          headers: { ...cors, "Cache-Control": "no-store" },
        });
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
          const tree = await agentTreeArtifact.read();
          if (tree !== null) {
            const node = tree.value.nodes?.[selection.agent.toUpperCase()];
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

      // Headline KPIs: counts and sums only, so public like the dashboard that shows them.
      if (pathname === "/api/kpis") {
        const [agentTree, liveInputs, customerBook, r2Pipeline] =
          await Promise.all([
            kpiInput(AGENT_TREE_PATH, agentTreeArtifact),
            deskLive.kpiLiveInputs(),
            kpiInput(CUSTOMER_PROFILES_PATH, customerBookArtifact),
            probeR2PipelineKpis(new Date()).catch(() => null),
          ]);
        const now = new Date();
        return Response.json(
          await withWeblog({
            success: true,
            kpis: deriveDeskKpis(
              {
                agentTree,
                liveBets: liveInputs.liveBets,
                liveWagers: liveInputs.liveWagers,
                customerBook,
              },
              now,
            ),
            live: liveInputs.live,
            livePending: liveInputs.livePending,
            ...(r2Pipeline === null ? {} : { pipeline: { r2: r2Pipeline } }),
            generatedAt: now.toISOString(),
          }),
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

        const tree = await agentTreeArtifact.read();
        if (tree === null) {
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

        const nodes = tree.value.nodes ?? {};
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
        const tree = await agentTreeArtifact.read();
        if (tree === null) {
          return Response.json(
            { error: "no agent tree; run bun run build:agent-tree" },
            { status: 404, headers: cors },
          );
        }
        const { agents, version: betsVersion } = await loadLiveBets();
        const hierarchy = tree.value as RawHierarchyTree;
        const nodes = hierarchy.nodes ?? {};
        const counts: Record<
          string,
          { games: number; wagered: number; toWin: number }
        > = {};
        for (const agent of agents.agents) {
          // The rollup can name an agent the tree capture does not contain; only nodes that
          // exist can render exposure, so the join is restricted to them.
          if (!Object.hasOwn(nodes, agent.key)) continue;
          counts[agent.key] = {
            games: agent.games,
            wagered: agent.wagered,
            toWin: agent.toWin,
          };
        }
        if (url.searchParams.get("view") === "hierarchy") {
          // The flat map answers "does this agent exist"; only the folded view answers "how much
          // is under it", which is the question a tree UI asks on every render.
          const view = buildHierarchy(hierarchy, {
            actionByAgent: counts as Record<string, HierarchyAction>,
          });
          return encodedResponse(req, {
            version: `agent-tree:hierarchy|${tree.version}|${betsVersion}`,
            contentType: "application/json; charset=utf-8",
            produce: () =>
              new TextEncoder().encode(
                JSON.stringify({
                  success: true,
                  source: "agent-tree",
                  ...view,
                }),
              ),
            headers: { ...cors, "Cache-Control": "no-store" },
          });
        }

        const body = { ...tree.value, counts };
        return encodedResponse(req, {
          // The payload joins two artifacts, so both versions belong in the key.
          version: `agent-tree|${tree.version}|${betsVersion}`,
          contentType: "application/json; charset=utf-8",
          produce: () => new TextEncoder().encode(JSON.stringify(body)),
          headers: { ...cors, "Cache-Control": "no-store" },
        });
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
        const FONT_MIME = {
          woff: "font/woff",
          woff2: "font/woff2",
          ttf: "font/ttf",
          otf: "font/otf",
          eot: "application/vnd.ms-fontobject",
        } as const;
        type FontExt = keyof typeof FONT_MIME;
        const ext = contained.split(".").pop()?.toLowerCase() ?? "";
        const headers: Record<string, string> = {
          ...cors,
          "Cache-Control": "public, max-age=3600",
        };
        if (ext in FONT_MIME)
          headers["Content-Type"] = FONT_MIME[ext as FontExt];
        return new Response(Bun.file(contained), { headers });
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
        // Names and sources only; never values. The route is already admin-gated above, so this
        // is safe to return; the dashboard reads it to name any variable the operator still needs
        // to seed with `bun run secrets:env set <NAME>`.
        const { report: seedingReport } = await resolveSecretEnv(
          SECRET_ENV_GROUPS["telegram"] ?? [],
        );
        const seeding = seedingReport.map((row) => ({
          name: row.name,
          source: describeSource(row.source),
          kind: row.source.kind,
        }));
        return Response.json(
          {
            success: true,
            status: await telegramService.getStatus(),
            schedules: scheduler.getSchedules(),
            reportTypes: REPORT_TYPES,
            seeding,
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
        } catch (err) {
          return Response.json(
            {
              success: false,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
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

      // 13b. Ops tracker (/tracker) and RBAC & Task Governance (/governance, /governance.json).
      if (
        (pathname === "/governance" || pathname === "/governance.json") &&
        req.method === "GET"
      ) {
        return serveGovernanceRoute(pathname, cors);
      }
      if (pathname === "/tracker" && req.method === "GET") {
        const ip = server.requestIP(req)?.address;
        const rejected = piiRejection(req, ip, ingress);
        if (rejected !== null) {
          return Response.json(
            { success: false, error: rejected.error },
            { status: rejected.status, headers: cors },
          );
        }
        const [
          { TRACKER_HEADERS, renderTrackerPage },
          { loadTrackerStateCached },
        ] = await Promise.all([
          import("../lib/tracker_dashboard.ts"),
          import("../lib/tracker_sources.ts"),
        ]);
        const loadState =
          options?.trackerState ?? (() => loadTrackerStateCached(repoRoot));
        return new Response(renderTrackerPage(await loadState()), {
          headers: { ...cors, ...TRACKER_HEADERS },
        });
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
  } satisfies Parameters<typeof Bun.serve>[0];

  const server: Bun.Server<undefined> = Bun.serve({
    ...serveConfig,
    // The dashboard's live bridge upgrades a guarded route that is already in DAEMON_ROUTES.
    fetch: withBridgeUpgrade(serveConfig.fetch, ingress),
    websocket: bridgeWebsocket,
    ...(unixSocket
      ? { unix: unixSocket }
      : {
          ...(options?.port !== undefined && { port: options.port }),
          ...(options?.hostname !== undefined && {
            hostname: options.hostname,
          }),
        }),
  });
  attachBridgeHub(server);
  return server;
}

/**
 * The webview daemon is the long-lived process, so it owns the bridge rollup schedules. The
 * standalone Telegram bot daemon excludes them (`BRIDGE_SCHEDULE_IDS`), so running both does not
 * publish twice or send duplicate digests.
 */
export function startBridgeSchedules(): () => void {
  const scheduler = new ReportingSchedulerService();
  const stop = scheduler.startBridgeSchedules();
  console.log(
    "[Bridge Cron] schedules active (America/Chicago): 3a/3b/3c every 15m, weblog hourly at :07, agent-tree hourly at :11 (requires F402_BEARER_TOKEN), customer-profiles every 6h at :27 (requires enriched_customers_full.json)",
  );
  return stop;
}

if (import.meta.main)
  queueMicrotask(() => {
    // defer past module eval
    const server = startServer({ daemonEntry: true });
    const stopBridgeCron = startBridgeSchedules();
    const location = server.url ? server.url.toString() : "unix domain socket";
    console.log(`[SportsDesk Webview Server] Active on ${location}`);
    console.log(` • Master Dashboard : ${location}`);
    console.log(` • Mini App (TMA)   : ${location}miniapp`);
    console.log(` • Health Probe     : ${location}health`);
    console.log(` • Watch List API   : ${location}api/watchlist`);
    const shutdown = (): void => {
      stopBridgeCron();
      server.stop(true);
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

/**
 * Merge the latest f402-weblog rollup and the last bridge rollup cycle into an aggregate response.
 * The cycle state is the same file the reporting scheduler writes, so the dashboard's Review Queue
 * and the Telegram digest can never disagree about what the last run saw.
 */
async function withWeblog<T extends Record<string, unknown>>(
  value: T,
): Promise<T & { weblog: unknown; bridge: unknown }> {
  const mod = await import("../lib/f402_weblog_latest.ts");
  const [latest, bridge] = await Promise.all([
    mod.loadWeblogLatest(),
    readBridgeRollupState(),
  ]);
  return {
    ...value,
    weblog: latest.status === "ok" ? latest.rollup : latest,
    bridge,
  };
}

/** Last bridge rollup cycle for the panel, verbatim. */
/* The panel renders defensively, so the payload is not re-validated; the scheduler's digest path does. */
export async function readBridgeRollupState(): Promise<unknown> {
  // Dynamic import (same pattern as the WebLog loader): keeps every line above this one
  // stable, which the docs' file:line citation pins depend on.
  const { resolveBridgeRollupStatePath } =
    await import("../lib/bridge_rollup_cron.ts");
  const path = resolveBridgeRollupStatePath();
  try {
    return JSON.parse(await Bun.file(path).text()) as unknown;
  } catch {
    return { updatedAt: null, jobs: [], alerts: [] };
  }
}

/*
 * Dashboard live bridge: a same-origin pub/sub hub that relays the blob gateway's bridge topics.
 *
 * Why an upgrade on `/api/live-bets` instead of a new route: that path is already a guarded route
 * in DAEMON_ROUTES, so reusing it keeps the route table, the OpenAPI fragment and the ledger's
 * route counts unchanged, and unauthenticated callers still meet the route's own `piiRejection`
 * guard. A browser cannot set headers on a WebSocket handshake, so the dashboard offers the admin
 * token as a `bearer-<token>` subprotocol and the guard runs against a synthetic request that
 * carries it as `authorization`. The token never appears in a URL, a log or a public response.
 */

/** Topics the dashboard subscribes to; the relay republishes exactly these. */
export const BRIDGE_WS_TOPICS = [
  "wagers-by-state",
  "f402-bet-ticker",
  "f402-pending",
  "gslive-tally",
  "f402-weblog",
] as const;

/** Offered first by the dashboard; the server echoes it so the browser accepts the upgrade. */
export const BRIDGE_WS_PROTOCOL = "sportsdesk.bridge.v1";

/** Browsers cannot set headers on a WebSocket, so the bearer rides in the subprotocol list. */
const BRIDGE_WS_TOKEN_PREFIX = "bearer-";

/** An already-registered guarded route: reusing it keeps DAEMON_ROUTES and the ledger unchanged. */
const BRIDGE_WS_PATH = "/api/live-bets";

const BRIDGE_WS_CHANNEL_RE = /^[a-z0-9-]{1,32}$/;

type BridgeSocket = {
  readonly subscriptions: readonly string[];
  subscribe: (channel: string) => void;
  unsubscribe: (channel: string) => void;
  send: (frame: string) => number;
  close: (code?: number, reason?: string) => void;
};

type BridgeProtocols = {
  readonly token: string | null;
  readonly echo: string | null;
};

let bridgeHub: Bun.Server<undefined> | null = null;
let bridgeRelaySocket: WebSocket | null = null;
let bridgeRelayTimer: ReturnType<typeof setTimeout> | null = null;
let bridgeRelayBackoffMs = 1_000;
let bridgeRelayStarted = false;
/** When the gateway last delivered a publishable frame; read by the automation panel. */
let bridgeRelayLastFrameAtIso: string | null = null;

/** Give the upgrade path the live server instance; `startServer` calls this after `Bun.serve`. */
export function attachBridgeHub(server: Bun.Server<undefined>): void {
  bridgeHub = server;
}

/** Whether this request is the dashboard's WebSocket upgrade for the reused guarded route. */
export function isBridgeUpgrade(req: Request): boolean {
  const upgrade = req.headers.get("upgrade");
  if (upgrade === null || upgrade.toLowerCase() !== "websocket") return false;
  try {
    return new URL(req.url).pathname === BRIDGE_WS_PATH;
  } catch {
    return false;
  }
}

/** The admin token and the protocol to echo, read from what the browser offered. */
export function bridgeProtocols(req: Request): BridgeProtocols {
  const offered = (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const bearer = offered.find((value) =>
    value.startsWith(BRIDGE_WS_TOKEN_PREFIX),
  );
  return {
    token:
      bearer === undefined ? null : bearer.slice(BRIDGE_WS_TOKEN_PREFIX.length),
    echo: offered.includes(BRIDGE_WS_PROTOCOL) ? BRIDGE_WS_PROTOCOL : null,
  };
}

/** What the route's guard sees: same URL, with the subprotocol token as a bearer header. */
export function bridgeUpgradeRequest(req: Request): Request {
  const { token } = bridgeProtocols(req);
  const headers = new Headers(req.headers);
  headers.delete("sec-websocket-protocol");
  if (token === null || token === "") headers.delete("authorization");
  else headers.set("authorization", `Bearer ${token}`);
  return new Request(req.url, { method: req.method, headers });
}

/** `null` when the request may upgrade; otherwise the guarded route's own rejection. */
export function bridgeUpgradeRejection(
  req: Request,
  address: string | null | undefined,
  ingress: Ingress,
): { status: number; error: string } | null {
  return piiRejection(bridgeUpgradeRequest(req), address, ingress);
}

function bridgeRefusal(status: number, error: string): Response {
  return Response.json({ success: false, error }, { status });
}

/** Wrap the daemon fetch so only the bridge upgrade diverges; every other request is untouched. */
export function withBridgeUpgrade(
  inner: (req: Request) => Promise<Response>,
  ingress: Ingress,
): (req: Request) => Promise<Response | undefined> {
  return async (req) => {
    if (!isBridgeUpgrade(req)) return inner(req);
    const server = bridgeHub;
    if (server === null) return bridgeRefusal(503, "hub_not_ready");
    const rejected = bridgeUpgradeRejection(
      req,
      server.requestIP(req)?.address,
      ingress,
    );
    if (rejected !== null)
      return bridgeRefusal(rejected.status, rejected.error);
    const { echo } = bridgeProtocols(req);
    const upgraded = server.upgrade(
      req,
      echo === null ? {} : { headers: { "Sec-WebSocket-Protocol": echo } },
    );
    return upgraded ? undefined : bridgeRefusal(426, "upgrade_failed");
  };
}

function bridgeSend(socket: BridgeSocket, payload: unknown): void {
  sendFrameOrClose(socket, JSON.stringify(payload));
}

/**
 * Same wire protocol as the blob gateway: `PING`/`PONG`, `SUBSCRIBE`/`SUBSCRIBED` and
 * `UNSUBSCRIBE`/`UNSUBSCRIBED`, all synchronous (Bun auto-corks `message`). The ack's
 * `channels` and `subscriptions` both come from uWebSockets' own topic table.
 */
export const bridgeWebsocket = {
  // Relayed rollups go out through `bridgeHub.publish`, which drops frames for a stalled tab
  // while the socket stays open; the cap closes it so the page reconnects and resubscribes.
  ...WS_BACKPRESSURE_OPTIONS,
  open(): void {
    startBridgeRelay();
  },
  message(ws: BridgeSocket, raw: string | Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      bridgeSend(ws, { type: "ERROR", code: "invalid_json" });
      return;
    }
    if (parsed === null || typeof parsed !== "object") {
      bridgeSend(ws, { type: "ERROR", code: "invalid_message" });
      return;
    }
    const msg = parsed as { type?: unknown; channel?: unknown };
    if (msg.type === "PING") {
      bridgeSend(ws, { type: "PONG", ts: Date.now() });
      return;
    }
    if (
      typeof msg.channel !== "string" ||
      !BRIDGE_WS_CHANNEL_RE.test(msg.channel)
    ) {
      bridgeSend(ws, { type: "ERROR", code: "invalid_channel" });
      return;
    }
    if (msg.type === "SUBSCRIBE") {
      ws.subscribe(msg.channel);
      bridgeSend(ws, {
        type: "SUBSCRIBED",
        channel: msg.channel,
        channels: ws.subscriptions,
        subscriptions: ws.subscriptions,
      });
      return;
    }
    if (msg.type !== "UNSUBSCRIBE") {
      bridgeSend(ws, { type: "ERROR", code: "invalid_message" });
      return;
    }
    ws.unsubscribe(msg.channel);
    bridgeSend(ws, {
      type: "UNSUBSCRIBED",
      channel: msg.channel,
      channels: ws.subscriptions,
      subscriptions: ws.subscriptions,
    });
  },
  close(): void {},
};

/** Connect once to the blob gateway and republish its bridge frames onto the local hub. */
function startBridgeRelay(): void {
  if (bridgeRelayStarted) return;
  bridgeRelayStarted = true;
  void connectBridgeRelay();
}

async function connectBridgeRelay(): Promise<void> {
  const server = bridgeHub;
  if (server === null) {
    scheduleBridgeRelay();
    return;
  }
  try {
    const { resolveBlobApiToken, resolveBlobGatewayUrl } =
      await import("../lib/blob_upload.ts");
    const gateway = resolveBlobGatewayUrl();
    const token = await resolveBlobApiToken();
    if (token === "") {
      scheduleBridgeRelay();
      return;
    }
    const ticketResponse = await fetch(`${gateway}/api/v1/ws-tickets`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!ticketResponse.ok) {
      scheduleBridgeRelay();
      return;
    }
    const { ticket } = (await ticketResponse.json()) as { ticket?: unknown };
    if (typeof ticket !== "string" || ticket === "") {
      scheduleBridgeRelay();
      return;
    }
    const url = new URL(`${gateway}/ws/live-bets`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    const socket = new WebSocket(url);
    bridgeRelaySocket = socket;
    socket.addEventListener("open", () => {
      bridgeRelayBackoffMs = 1_000;
      for (const topic of BRIDGE_WS_TOPICS) {
        socket.send(JSON.stringify({ type: "SUBSCRIBE", channel: topic }));
      }
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        // The gateway only sends text frames; a binary one is a protocol change worth seeing.
        console.warn(
          "[bridge] relay dropped a non-text frame from the gateway",
        );
        return;
      }
      const raw = event.data;
      if (raw === "" || bridgeHub === null) return;
      let kind: unknown;
      try {
        kind = (JSON.parse(raw) as { kind?: unknown }).kind;
      } catch {
        return;
      }
      if (
        typeof kind !== "string" ||
        !(BRIDGE_WS_TOPICS as readonly string[]).includes(kind)
      ) {
        return;
      }
      bridgeRelayLastFrameAtIso = new Date().toISOString();
      bridgeHub.publish(kind, raw);
    });
    socket.addEventListener("close", () => {
      if (bridgeRelaySocket !== socket) return;
      bridgeRelaySocket = null;
      scheduleBridgeRelay();
    });
  } catch {
    scheduleBridgeRelay();
  }
}

function scheduleBridgeRelay(): void {
  if (bridgeRelayTimer !== null) return;
  const delay = bridgeRelayBackoffMs;
  bridgeRelayBackoffMs = Math.min(bridgeRelayBackoffMs * 2, 30_000);
  bridgeRelayTimer = setTimeout(() => {
    bridgeRelayTimer = null;
    void connectBridgeRelay();
  }, delay);
  // The relay retries in the background; it must not keep the process alive.
  bridgeRelayTimer.unref?.();
}

/** Stop the relay and detach the hub; tests and shutdown use this. */
export function stopBridgeHub(): void {
  bridgeRelayStarted = false;
  bridgeRelayBackoffMs = 1_000;
  bridgeRelayLastFrameAtIso = null;
  if (bridgeRelayTimer !== null) {
    clearTimeout(bridgeRelayTimer);
    bridgeRelayTimer = null;
  }
  const socket = bridgeRelaySocket;
  bridgeRelaySocket = null;
  bridgeHub = null;
  socket?.close();
}

export interface BridgeRelayStatus {
  readonly status: "connected" | "disconnected" | "no_token" | "unavailable";
  readonly started: boolean;
  readonly lastFrameAtIso: string | null;
  readonly lastFrameAgeSeconds: number | null;
  readonly topics: readonly string[];
  /** URL host only — never the ticket-bearing stream URL. */
  readonly gatewayHost: string | null;
}

function frameAgeSeconds(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms)
    ? Math.max(0, Math.floor((now.getTime() - ms) / 1000))
    : null;
}

/**
 * The relay's own state, for `summary.automation.wsRelay`.
 *
 * The token and the stream URL are deliberately not returned: the URL embeds the WebSocket
 * ticket and the token is a bearer secret. `gatewayHost` is the URL's host, which is safe to
 * render, and an open socket is the only proof of "connected" — `started` alone means a retry
 * loop is running, not that frames are arriving.
 */
export async function getBridgeRelayStatus(
  now: Date = new Date(),
): Promise<BridgeRelayStatus> {
  const { resolveBlobApiToken, resolveBlobGatewayUrl } =
    await import("../lib/blob_upload.ts");
  let gatewayHost: string | null = null;
  try {
    gatewayHost = new URL(resolveBlobGatewayUrl()).host;
  } catch {
    gatewayHost = null;
  }
  const base = {
    started: bridgeRelayStarted,
    lastFrameAtIso: bridgeRelayLastFrameAtIso,
    lastFrameAgeSeconds: frameAgeSeconds(bridgeRelayLastFrameAtIso, now),
    topics: [...BRIDGE_WS_TOPICS],
    gatewayHost,
  } as const;
  let token: string;
  try {
    token = await resolveBlobApiToken();
  } catch {
    return { ...base, status: "unavailable" };
  }
  const socket = bridgeRelaySocket;
  const open = socket !== null && socket.readyState === WebSocket.OPEN;
  const status: BridgeRelayStatus["status"] =
    token.trim() === "" ? "no_token" : open ? "connected" : "disconnected";
  return { ...base, status };
}

/** The graph page's companion JSON, behind the admin token (see the arm that calls this). */
async function serveGraphDocsJson(
  req: Request,
  pathname: string,
  cors: Record<string, string>,
): Promise<Response> {
  const rejected = adminRejection(req);
  if (rejected !== null) {
    return Response.json(
      { success: false, error: rejected.error },
      { status: rejected.status, headers: cors },
    );
  }
  return fileResponse(
    req,
    resolve(repoRoot, "docs", pathname.slice(1)),
    "application/json; charset=utf-8",
    { ...cors, "Cache-Control": "no-store" },
  );
}

/** RBAC Roles & Task Governance HTML dashboard (/governance) and JSON report (/governance.json). */
async function serveGovernanceRoute(
  pathname: string,
  cors: Record<string, string>,
): Promise<Response> {
  const { buildGovernanceReport, renderStandaloneGovernanceHtml } =
    await import("../lib/rbac_governance.ts");
  const report = buildGovernanceReport({ root: repoRoot });
  if (pathname === "/governance.json") {
    return Response.json(report, {
      headers: { ...cors, "Cache-Control": "no-store" },
    });
  }
  return new Response(renderStandaloneGovernanceHtml(report), {
    headers: {
      ...cors,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
