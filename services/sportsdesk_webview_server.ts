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
  type WagerListArtifact,
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
import {
  STALE_AFTER_SECONDS,
  deriveDeskKpis,
  freshness,
  readCustomerBookSummary,
  recordedTime,
  type KpiInput,
} from "../lib/desk_kpis.ts";
import { ReportingSchedulerService } from "./reporting_scheduler_service.ts";
import {
  REPORT_TYPES,
  SportsDeskTelegramService,
  isReportType,
  type TelegramUpdate,
} from "./sportsdesk_telegram_bot.ts";
import { containedAssetPath, isSafeAssetName } from "../lib/asset_path.ts";
import { cachedJsonFile, readFileBytes } from "../lib/artifact_cache.ts";
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
  readonly development?: boolean;
  /** Where `bet-ticker.json` and `live-wagers.json` live; defaults to the repo's `data/`. */
  readonly wagerListDir?: string;
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

const liveBetsArtifact = cachedJsonFile(
  LIVE_BETS_PATH,
  (raw) => raw as LiveBetsArtifact,
);
const customerBookArtifact = cachedJsonFile(
  CUSTOMER_PROFILES_PATH,
  readCustomerBookSummary,
);
const analysisReportArtifact = cachedJsonFile(
  resolve(repoRoot, ANALYSIS_REPORT_PATH),
  readAnalysisReport,
);
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
 * checkout rewrites the committed paste's mtime to now, and that must not shadow a real capture.
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
async function loadLiveBets(): Promise<{
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

export function startServer(options?: ServerOptions) {
  const telegramService = new SportsDeskTelegramService();
  const scheduler = new ReportingSchedulerService(telegramService);
  const wagerLists = wagerListSources(
    options?.wagerListDir ?? resolve(repoRoot, "data"),
  );
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

  const serveConfig = {
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

      // 2d. Bet-ticker XML: parse one feed document and echo the compact tree.
      if (pathname === "/api/parse-bet-ticker" && req.method === "POST") {
        try {
          const text = await req.text();
          if (text.trim() === "") {
            return Response.json(
              { error: "empty body" },
              { status: 400, headers: cors },
            );
          }
          const { parseBetTickerXml } = await import("../lib/live_wagers.ts");
          return Response.json(parseBetTickerXml(text), { headers: cors });
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
          const text = await req.text();
          if (text.trim() === "") {
            return Response.json(
              { error: "empty body" },
              { status: 400, headers: cors },
            );
          }
          const { parseFantasy402AjaxXml } =
            await import("../lib/customer_profile.ts");
          return Response.json(parseFantasy402AjaxXml(text), { headers: cors });
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
          const text = await req.text();
          if (text.trim() === "") {
            return Response.json(
              { error: "empty body" },
              { status: 400, headers: cors },
            );
          }
          const { parseAjaxXml } = await import("../lib/customer_profile.ts");
          return Response.json(parseAjaxXml(text), { headers: cors });
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
          const text = await req.text();
          if (text.trim() === "") {
            return Response.json(
              { error: "empty body" },
              { status: 400, headers: cors },
            );
          }
          const { parseTransactionsXml } =
            await import("../lib/customer_profile.ts");
          return Response.json(parseTransactionsXml(text), { headers: cors });
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
          const text = await req.text();
          if (text.trim() === "") {
            return Response.json(
              { error: "empty body" },
              { status: 400, headers: cors },
            );
          }
          const { parseCustomerPerformanceXml } =
            await import("../lib/customer_profile.ts");
          return Response.json(parseCustomerPerformanceXml(text), {
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
          const text = await req.text();
          if (text.trim() === "") {
            return Response.json(
              { error: "empty body" },
              { status: 400, headers: cors },
            );
          }
          const { customerRowFromXml } =
            await import("../lib/customer_profile.ts");
          return Response.json(customerRowFromXml(text), { headers: cors });
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
          const text = await req.text();
          if (text.trim() === "") {
            return Response.json(
              { error: "empty body" },
              { status: 400, headers: cors },
            );
          }
          const compact = url.searchParams.get("compact") !== "false";
          const parsed = compact
            ? Bun.XML.parse(text)
            : Bun.XML.parse(text, { compact: false });
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
          // `private`, not `public`: the summary is served only because `piiRejection` allowed
          // this peer (`byAgent` is keyed by agent login), so a shared cache that stored and
          // replayed it would answer requests the guard never saw — which is exactly the request
          // it must not answer. `must-revalidate` replaces `stale-while-revalidate` for the same
          // reason: a stale copy is still an answer given without asking the guard.
          // `Vary: Authorization` says the body is a function of the credential, not just the URL.
          const summaryHeaders = {
            ...cors,
            "Cache-Control": "private, max-age=30, must-revalidate",
            Vary: "Origin, Authorization",
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
          cors,
        );
      }

      if (pathname === "/graph.js") {
        return fileResponse(
          req,
          resolve(repoRoot, "docs/graph.js"),
          "application/javascript; charset=utf-8",
          cors,
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

      if (GRAPH_DOCS_JSON.has(pathname)) {
        return fileResponse(
          req,
          resolve(repoRoot, "docs", pathname.slice(1)),
          "application/json; charset=utf-8",
          { ...cors, "Cache-Control": "no-store" },
        );
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

        const { chosen, skipped } = await loadWagerList(wagerLists);
        if (chosen === null) {
          return Response.json(
            {
              error: "no live wager list",
              hint: "run bun run capture:bet-ticker (writes data/bet-ticker.json), or save a ticker paste as data/live-wagers.json, and reload",
              skipped,
            },
            { status: 404, headers: cors },
          );
        }
        const artifact = chosen.artifact;
        const wagers = artifact.wagers;
        // No `ageSeconds`: it advances every second, and in the version it would turn each poll
        // into a new entry in the shared 48-body cache, which clears whole when full. The page
        // computes the age from `asOf`; `stale` flips once, so it can be part of the version.
        const { ageSeconds: _age, ...fresh } = freshness(
          artifact.provenance.observedAt,
          chosen.mtime,
          STALE_AFTER_SECONDS.liveWagers,
          new Date(),
        );

        const writer = (url.searchParams.get("writer") ?? "")
          .trim()
          .toLowerCase();
        const type = (url.searchParams.get("type") ?? "").trim().toUpperCase();
        const filtered = wagers.filter(
          (wager) =>
            (writer === "" || wager.writer === writer) &&
            (type === "" || wager.wagerType === type),
        );

        return encodedResponse(req, {
          // Every input to the bytes is in the version: the query, which file won, what was
          // skipped, and whether it has gone stale.
          version: `live-wagers|${chosen.path}|${chosen.version}|${fresh.stale}|${JSON.stringify(skipped)}|${writer}|${type}`,
          contentType: "application/json; charset=utf-8",
          produce: () =>
            new TextEncoder().encode(
              JSON.stringify({
                success: true,
                summary: summarizeLiveWagers(filtered),
                all: summarizeLiveWagers(wagers),
                writer: writer === "" ? null : writer,
                type: type === "" ? null : type,
                // The file's own account of itself: a 17-row subset reads as 17 rows, not as the list.
                provenance: artifact.provenance,
                freshness: fresh,
                skipped,
                wagers: filtered,
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
        const [agentTree, liveBets, wagerList, customerBook] =
          await Promise.all([
            kpiInput(AGENT_TREE_PATH, agentTreeArtifact),
            kpiInput(LIVE_BETS_PATH, liveBetsArtifact),
            loadWagerList(wagerLists),
            kpiInput(CUSTOMER_PROFILES_PATH, customerBookArtifact),
          ]);
        const liveWagers =
          wagerList.chosen === null
            ? null
            : {
                value: wagerList.chosen.artifact,
                mtime: wagerList.chosen.mtime,
              };
        const now = new Date();
        return Response.json(
          await withWeblog({
            success: true,
            kpis: deriveDeskKpis(
              { agentTree, liveBets, liveWagers, customerBook },
              now,
            ),
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
        if (url.searchParams.get("view") === "hierarchy") {
          // The flat map answers "does this agent exist"; only the folded view answers "how much
          // is under it", which is the question a tree UI asks on every render.
          const view = buildHierarchy(tree.value as RawHierarchyTree, {
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
    "[Bridge Cron] bridge schedules active (America/Chicago): 3a/3b/3c every 15m, weblog hourly at :07",
  );
  return stop;
}

if (import.meta.main)
  queueMicrotask(() => {
    // defer past module eval
    const server = startServer();
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
  socket.send(JSON.stringify(payload));
}

/**
 * Same wire protocol as the blob gateway: `PING`/`PONG`, `SUBSCRIBE`/`SUBSCRIBED` and
 * `UNSUBSCRIBE`/`UNSUBSCRIBED`, all synchronous (Bun auto-corks `message`). The ack's
 * `channels` and `subscriptions` both come from uWebSockets' own topic table.
 */
export const bridgeWebsocket = {
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
      const raw = typeof event.data === "string" ? event.data : "";
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
  if (bridgeRelayTimer !== null) {
    clearTimeout(bridgeRelayTimer);
    bridgeRelayTimer = null;
  }
  const socket = bridgeRelaySocket;
  bridgeRelaySocket = null;
  bridgeHub = null;
  socket?.close();
}
