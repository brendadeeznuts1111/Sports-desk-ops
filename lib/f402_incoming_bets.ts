/**
 * @file lib/f402_incoming_bets.ts
 * @description Live incoming-bet fetch for the YAML flag engine.
 *
 * Live path: `getBetTicker` is POSTed only through `createF402ReplayTransport()` (session file /
 * datastore fetch session / replay proxy), which is the read-only F402 path the agent policy
 * requires. The request body is the captured one (`scripts/capture/capture_bet_ticker.ts`); the
 * raw wire rows are what `widenTickerRow()` expects, so this module fetches the JSON itself
 * instead of going through `probeF402BetTicker()`, whose `F402TickerRow` preview drops the fields
 * the wide rule-facing record needs. No cookie, bearer token, or session value is ever logged or
 * returned; diagnostics carry codes and HTTP status only.
 *
 * `source: "auto"` (the default) falls back to the committed-shape capture artifacts
 * (`data/live-wagers.json` LIST rows, `data/live-bets.json` games) when the live source cannot be
 * used, and names the fallback in `source` so a stale row is never read as a live observation.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  widenPendingRow,
  widenTickerRow,
  widenWagerRow,
  type IncomingBetRecord,
  type IncomingBetSource,
} from "./bet_flags.ts";
import type { F402ProbeFetch } from "./f402_ingest.ts";
import {
  createF402ReplayTransport,
  type F402ReplayTransport,
} from "./f402_replay_transport.ts";
import { readF402Session, type F402Session } from "./f402_session.ts";
import { BET_TICKER_OPERATION } from "./live_wagers.ts";

const BET_TICKER_URL = `https://fantasy402.com${BET_TICKER_OPERATION}`;
const PROXY_ENV = "F402_REPLAY_PROXY_URL";
const CAPTURE_WAGERS_PATH = "data/live-wagers.json";
const CAPTURE_BETS_PATH = "data/live-bets.json";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_TIMEOUT_MS = 15_000;

/** The three ways to configure a replay transport, copied from the capture script's refusal. */
const SESSION_LOGIN_HINT = [
  "bun run session:login                       (one WebView login; writes the 0600 cache)",
  "F402_SESSION_FILE=<session json>            (see lib/f402_session.ts)",
  "F402_REPLAY_PROXY_URL=<localhost proxy>",
].join("\n");

const TRANSPORT_UNAVAILABLE_MESSAGE =
  "No F402 replay transport is available for a live getBetTicker read: no cached session file and F402_REPLAY_PROXY_URL is not set.";

const AGENT_REQUIRED_MESSAGE =
  "No agent id for getBetTicker: pass agentId or set F402_AGENT_ID.";

export interface IncomingBetsOptions {
  /** `"auto"` (default) tries live, then the capture artifacts; `"live"` never falls back. */
  source?: "live" | "auto" | "file";
  /** Agent whose ticker is read; defaults to `Bun.env.F402_AGENT_ID`. */
  agentId?: string;
  /** Row cap (1..500); defaults to 100. */
  limit?: number;
  /** Per-request timeout; defaults to 15000 ms. */
  timeoutMs?: number;
  /** Clock seam for `fetchedAt` and capture-age fallbacks. */
  now?: Date;
  /** Fetch seam for tests; when set, no replay transport is created. */
  fetchImpl?: F402ProbeFetch;
  /** Session seam for tests; `null` forces "no session" instead of reading the cache file. */
  session?: F402Session | null;
  /** Root holding `data/live-wagers.json` and `data/live-bets.json`; defaults to cwd. */
  rootDir?: string;
  /** With `source: "file"`, a JSON `getBetTicker` capture (LIST rows) to parse instead of a live read. */
  file?: string;
}

export type IncomingBetsDiagnostic =
  | { code: "ok"; transport: string; httpStatus?: number }
  | { code: "transport_unavailable"; message: string; hint: string }
  | { code: "agent_required"; message: string }
  | { code: "unauthorized"; message: string; httpStatus: number }
  | { code: "http_error"; message: string; httpStatus: number }
  | { code: "parse_error"; message: string }
  | { code: "captures_unavailable"; message: string }
  | { code: "file_required"; message: string }
  | { code: "file_missing"; message: string }
  | { code: "file_unreadable"; message: string; detail: string }
  | { code: "file_unsupported_html"; message: string }
  | { code: "file_empty"; message: string };

export interface IncomingBetsResult {
  ok: boolean;
  source: IncomingBetSource;
  fetchedAt: string;
  agentId: string | null;
  rows: IncomingBetRecord[];
  diagnostic: IncomingBetsDiagnostic;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{LIST: [...]}` (getBetTicker), a bare array, or the probe's `data`/`rows` envelopes. */
function extractRows(payload: unknown): readonly unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return null;
  for (const key of ["LIST", "data", "rows"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (
    timeoutMs === undefined ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.trunc(timeoutMs);
}

/** Accepted-at instant; unparseable timestamps sort last so a shape drift stays visible. */
function acceptedAtMillis(row: IncomingBetRecord): number {
  const parsed = Date.parse(row.acceptedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Newest first, ties by bet key so the order is deterministic across identical feeds. */
function sortNewestFirst(rows: IncomingBetRecord[]): void {
  rows.sort((a, b) => {
    const delta = acceptedAtMillis(b) - acceptedAtMillis(a);
    if (delta !== 0) return delta;
    if (a.betKey === b.betKey) return 0;
    return a.betKey < b.betKey ? -1 : 1;
  });
}

/** Keeps the first row per bet key; the captures can describe the same ticket twice. */
function dedupeRows(rows: readonly IncomingBetRecord[]): IncomingBetRecord[] {
  const seen = new Set<string>();
  const unique: IncomingBetRecord[] = [];
  for (const row of rows) {
    const key =
      row.betKey !== ""
        ? row.betKey
        : `${row.customerId}\u0000${row.acceptedAt}\u0000${row.stakeUsd ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

interface LiveFetchResult {
  readonly rows: IncomingBetRecord[];
  readonly diagnostic: IncomingBetsDiagnostic;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

async function fetchLiveTicker(args: {
  readonly agentId: string;
  readonly session: F402Session | null;
  readonly fetchImpl: F402ProbeFetch | undefined;
  readonly timeoutMs: number;
  readonly observedAt: string;
}): Promise<LiveFetchResult> {
  let transport: F402ReplayTransport | null = null;
  let fetchImpl: F402ProbeFetch;
  let transportLabel: string;

  if (args.fetchImpl !== undefined) {
    fetchImpl = args.fetchImpl;
    transportLabel = "injected-fetch";
  } else {
    try {
      transport = await createF402ReplayTransport();
    } catch (error) {
      return {
        rows: [],
        diagnostic: {
          code: "transport_unavailable",
          message: `${TRANSPORT_UNAVAILABLE_MESSAGE} Transport creation failed: ${errorMessage(error)}`,
          hint: SESSION_LOGIN_HINT,
        },
      };
    }
    fetchImpl = transport.fetch;
    transportLabel = transport.label;
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    "x-requested-with": "XMLHttpRequest",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
  };
  if (args.session?.authorizationHeader !== undefined) {
    headers["authorization"] = args.session.authorizationHeader;
  }
  // The replay transport injects the cached cookie itself; an injected fetch has no transport
  // behind it, so the caller-provided session supplies the same cookie header the probe sends.
  if (args.fetchImpl !== undefined && args.session !== null) {
    headers["cookie"] = args.session.cookieHeader;
  }

  const body = new URLSearchParams({
    agentID: args.agentId,
    agentOwner: args.agentId,
    wagerNumber: "0",
    operation: "getBetTicker",
    RRO: "1",
  }).toString();

  try {
    const response = await fetchImpl(BET_TICKER_URL, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(args.timeoutMs),
      proxy: false,
    } as RequestInit);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          rows: [],
          diagnostic: {
            code: "unauthorized",
            message: `getBetTicker returned HTTP ${response.status}: the cached session was rejected or has expired. Refresh it with bun run session:login (or the session-refresh service).`,
            httpStatus: response.status,
          },
        };
      }
      return {
        rows: [],
        diagnostic: {
          code: "http_error",
          message: `getBetTicker returned HTTP ${response.status}.`,
          httpStatus: response.status,
        },
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        rows: [],
        diagnostic: {
          code: "parse_error",
          message:
            "getBetTicker response body is not JSON (a login page or an error envelope was returned instead of the ticker).",
        },
      };
    }

    const rawRows = extractRows(payload);
    if (rawRows === null) {
      return {
        rows: [],
        diagnostic: {
          code: "parse_error",
          message:
            "getBetTicker response JSON has no LIST array; the ticker wire shape may have changed.",
        },
      };
    }

    const rows: IncomingBetRecord[] = [];
    for (const raw of rawRows) {
      const row = widenTickerRow(raw, {
        source: "live-ticker",
        observedAt: args.observedAt,
      });
      if (row !== null) rows.push(row);
    }
    if (rawRows.length > 0 && rows.length === 0) {
      return {
        rows: [],
        diagnostic: {
          code: "parse_error",
          message: `getBetTicker returned ${rawRows.length} row(s) but none matched the widened bet shape; the ticker wire shape may have changed.`,
        },
      };
    }

    const capped = dedupeRows(rows);
    sortNewestFirst(capped);
    return {
      rows: capped,
      diagnostic: {
        code: "ok",
        transport: transportLabel,
        httpStatus: response.status,
      },
    };
  } catch (error) {
    return {
      rows: [],
      diagnostic: {
        code: "http_error",
        message: isTimeout(error)
          ? `getBetTicker request timed out after ${args.timeoutMs} ms.`
          : `getBetTicker request failed: ${errorMessage(error)}`,
        httpStatus: 0,
      },
    };
  } finally {
    if (transport !== null) await transport.close();
  }
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The artifact's own capture stamp, falling back to the caller's clock. */
function captureObservedAt(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  for (const key of ["observedAt", "capturedAt"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
  }
  return fallback;
}

interface CaptureRows {
  readonly rows: IncomingBetRecord[];
  readonly observedAt: string;
}

async function readWagerCapture(
  rootDir: string,
  fallbackObservedAt: string,
): Promise<CaptureRows> {
  const path = join(rootDir, CAPTURE_WAGERS_PATH);
  const payload = await readJsonFile(path);
  if (payload === null) return { rows: [], observedAt: fallbackObservedAt };
  const observedAt = captureObservedAt(payload, fallbackObservedAt);
  const rawRows = extractRows(payload) ?? [];
  const rows: IncomingBetRecord[] = [];
  for (const raw of rawRows) {
    const row = widenWagerRow(raw, { observedAt });
    if (row !== null) rows.push(row);
  }
  return { rows, observedAt };
}

async function readPendingCapture(
  rootDir: string,
  fallbackObservedAt: string,
): Promise<CaptureRows> {
  const path = join(rootDir, CAPTURE_BETS_PATH);
  const payload = await readJsonFile(path);
  if (payload === null) return { rows: [], observedAt: fallbackObservedAt };
  const observedAt = captureObservedAt(payload, fallbackObservedAt);
  const games =
    isRecord(payload) && Array.isArray(payload["games"])
      ? payload["games"]
      : [];
  const rows: IncomingBetRecord[] = [];
  for (const raw of games) {
    const row = widenPendingRow(raw, { observedAt });
    if (row !== null) rows.push(row);
  }
  return { rows, observedAt };
}

/** Capture fallback: wager LIST rows plus pending/game rows, deduped, newest first, capped. */
async function readCapturesFallback(
  rootDir: string,
  fallbackObservedAt: string,
  limit: number,
  agentId: string | null,
): Promise<IncomingBetsResult | null> {
  const [wagers, pending] = await Promise.all([
    readWagerCapture(rootDir, fallbackObservedAt),
    readPendingCapture(rootDir, fallbackObservedAt),
  ]);
  const rows = dedupeRows([...wagers.rows, ...pending.rows]);
  if (rows.length === 0) return null;
  const source: IncomingBetSource =
    wagers.rows.length > 0 ? "capture-wagers" : "capture-bets";
  sortNewestFirst(rows);
  return {
    ok: true,
    source,
    fetchedAt: wagers.rows.length > 0 ? wagers.observedAt : pending.observedAt,
    agentId,
    rows: rows.slice(0, limit),
    diagnostic: { code: "ok", transport: "capture-files" },
  };
}

function capturesUnavailableMessage(rootDir: string): string {
  return `No live transport is configured and no capture rows were found: ${join(rootDir, CAPTURE_WAGERS_PATH)} (LIST) and ${join(rootDir, CAPTURE_BETS_PATH)} (games) are missing, unreadable, or empty.`;
}

/**
 * Fetches incoming bets for the flag engine. Never throws for a missing session/agent: every
 * refusal is a structured diagnostic. Live rows are `source: "live-ticker"`; fallback rows name
 * the artifact they came from.
 */
export async function fetchIncomingBets(
  options: IncomingBetsOptions = {},
): Promise<IncomingBetsResult> {
  const mode =
    options.source === "live"
      ? "live"
      : options.source === "file"
        ? "file"
        : "auto";
  const fetchedAt = (options.now ?? new Date()).toISOString();
  const agentId =
    (options.agentId ?? Bun.env["F402_AGENT_ID"] ?? "").trim() || null;
  const limit = resolveLimit(options.limit);
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const rootDir = options.rootDir ?? process.cwd();

  const fail = (
    source: IncomingBetSource,
    diagnostic: IncomingBetsDiagnostic,
  ): IncomingBetsResult => ({
    ok: false,
    source,
    fetchedAt,
    agentId,
    rows: [],
    diagnostic,
  });

  const session: F402Session | null =
    options.session !== undefined ? options.session : readF402Session();
  const proxyConfigured = (Bun.env[PROXY_ENV] ?? "").trim() !== "";
  // An injected fetch is a transport seam; otherwise a session or the proxy must exist.
  // Explicit capture-file source: parse a recorded JSON getBetTicker body. The HTML table is
  // account-less by design (the parser keeps no customer/agent identity), so flags that need an
  // account cannot run from it; that is a structured refusal, not a silent empty scan.
  if (mode === "file") {
    const requested = (options.file ?? "").trim();
    if (requested === "") {
      return fail("file-capture", {
        code: "file_required",
        message:
          "source=file requires a capture path; pass file or use source=auto.",
      });
    }
    const filePath = isAbsolute(requested)
      ? requested
      : resolve(rootDir, requested);
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      const missing =
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "ENOENT";
      if (missing) {
        return fail("file-capture", {
          code: "file_missing",
          message: `capture file not found: ${filePath}`,
        });
      }
      return fail("file-capture", {
        code: "file_unreadable",
        message: `capture file could not be read: ${filePath}`,
        detail: String(error),
      });
    }
    if (text.trimStart().startsWith("<")) {
      return fail("file-capture", {
        code: "file_unsupported_html",
        message:
          "HTML captures carry no customer/agent identity, so the flag sources cannot be evaluated from one; use the JSON getBetTicker capture (capture:bet-ticker) instead.",
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return fail("file-capture", {
        code: "file_unreadable",
        message: `capture file is not valid JSON: ${filePath}`,
        detail: String(error),
      });
    }
    const rawRows = extractRows(parsed) ?? [];
    const rows: IncomingBetRecord[] = [];
    for (const raw of rawRows) {
      const row = widenTickerRow(raw, { observedAt: fetchedAt });
      if (row !== null) rows.push(row);
    }
    if (rows.length === 0) {
      return fail("file-capture", {
        code: "file_empty",
        message: `capture file has no usable ${BET_TICKER_OPERATION} LIST rows: ${filePath}`,
      });
    }
    const deduped = dedupeRows(rows);
    sortNewestFirst(deduped);
    return {
      ok: true,
      source: "file-capture",
      fetchedAt,
      agentId,
      rows: deduped.slice(0, limit),
      diagnostic: { code: "ok", transport: "file-capture" },
    };
  }

  const liveConfigured =
    options.fetchImpl !== undefined || session !== null || proxyConfigured;

  if (!liveConfigured) {
    if (mode === "auto") {
      const fallback = await readCapturesFallback(
        rootDir,
        fetchedAt,
        limit,
        agentId,
      );
      if (fallback !== null) return fallback;
      return fail("capture-wagers", {
        code: "captures_unavailable",
        message: capturesUnavailableMessage(rootDir),
      });
    }
    return fail("live-ticker", {
      code: "transport_unavailable",
      message: TRANSPORT_UNAVAILABLE_MESSAGE,
      hint: SESSION_LOGIN_HINT,
    });
  }

  if (agentId === null) {
    if (mode === "auto") {
      const fallback = await readCapturesFallback(
        rootDir,
        fetchedAt,
        limit,
        agentId,
      );
      if (fallback !== null) return fallback;
    }
    return fail("live-ticker", {
      code: "agent_required",
      message: AGENT_REQUIRED_MESSAGE,
    });
  }

  const live = await fetchLiveTicker({
    agentId,
    session,
    fetchImpl: options.fetchImpl,
    timeoutMs,
    observedAt: fetchedAt,
  });
  if (live.diagnostic.code === "ok") {
    return {
      ok: true,
      source: "live-ticker",
      fetchedAt,
      agentId,
      rows: live.rows.slice(0, limit),
      diagnostic: live.diagnostic,
    };
  }
  if (mode === "auto") {
    const fallback = await readCapturesFallback(
      rootDir,
      fetchedAt,
      limit,
      agentId,
    );
    if (fallback !== null) return fallback;
  }
  return fail("live-ticker", live.diagnostic);
}
