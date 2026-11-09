/**
 * @file lib/f402_live_ticker.ts
 * @description One live `Manager/getBetTicker` read, shared by the flag engine and the desk
 * server.
 *
 * The request is POSTed only through `createF402ReplayTransport()` (session file / datastore
 * fetch session / replay proxy), which is the read-only F402 path the agent policy requires; a
 * caller that already owns a suitable fetch or session injects it instead (tests do). The body is
 * the captured one (`scripts/capture/capture_bet_ticker.ts`) and `wagerNumber: "0"` asks for the
 * whole current list.
 *
 * This module deliberately returns the raw `LIST` row objects rather than the probe's
 * `F402TickerRow` preview: `lib/bet_flags.ts` widens the wire rows, and the preview drops fields
 * that widening needs. Nothing here knows about widening, dedupe or sorting — those stay with the
 * caller.
 *
 * No cookie, bearer token, or other session value is ever logged, returned, or stored: diagnostics
 * carry codes, messages and HTTP status only, and `fetchLiveBetTicker` never echoes a request
 * header. The `session` option exists for test seams and for callers that already resolved one; it
 * is read but never copied into the result.
 */

import type { F402ProbeFetch } from "./f402_ingest.ts";
import {
  createF402ReplayTransport,
  type F402ReplayTransport,
} from "./f402_replay_transport.ts";
import { readF402Session, type F402Session } from "./f402_session.ts";
import {
  F402_KEYCHAIN_NAMES,
  readSecretCanonicalThenLegacy,
} from "./secrets.ts";
import {
  BET_TICKER_OPERATION,
  LIVE_TICKER_SOURCE_PREFIX,
} from "./live_wagers.ts";

/** `getBetTicker` (tier A live request+response); same URL the capture script records. */
export const F402_TICKER_URL = `https://fantasy402.com${BET_TICKER_OPERATION}`;

const PROXY_ENV = "F402_REPLAY_PROXY_URL";
/** Per-request timeout when the caller does not name one; shared with f402_incoming_bets.ts. */
export const LIVE_TICKER_FETCH_DEFAULT_TIMEOUT_MS = 15_000;

/** The three ways to configure a replay transport, copied from the capture script's refusal. */
export const SESSION_LOGIN_HINT = [
  "bun run session:login                       (one WebView login; writes the 0600 cache)",
  "F402_SESSION_FILE=<session json>            (see lib/f402_session.ts)",
  "F402_REPLAY_PROXY_URL=<localhost proxy>",
].join("\n");

export const TRANSPORT_UNAVAILABLE_MESSAGE =
  "No F402 replay transport is available for a live getBetTicker read: no cached session file and F402_REPLAY_PROXY_URL is not set.";

export const AGENT_REQUIRED_MESSAGE =
  "No agent id for getBetTicker: pass agentId or set F402_AGENT_ID.";

export interface LiveTickerFetchOptions {
  /**
   * Agent whose ticker is read. Resolution order: this value, then `F402_AGENT_ID` in `env`,
   * then the keychain entry `F402_KEYCHAIN_NAMES.agentId` (desk-server/production path). The
   * keychain is never read when `fetchImpl` is injected.
   */
  readonly agentId?: string | null;
  /** Per-request timeout; defaults to 15000 ms. */
  readonly timeoutMs?: number;
  /** Clock seam for `observedAt`; defaults to `new Date()`. */
  readonly now?: Date;
  /** Fetch seam for tests; when set, no replay transport is created. */
  readonly fetchImpl?: F402ProbeFetch;
  /** Session seam for tests; `undefined` reads the cache, `null` forces "no session". */
  readonly session?: F402Session | null;
  /** Environment seam; defaults to `Bun.env` (read for the agent id and the proxy URL). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Keychain seam for tests. Defaults to a canonical-then-legacy read of
   * `F402_KEYCHAIN_NAMES.agentId`; a threw/absent secret is a normal `null`.
   */
  readonly secrets?: () => Promise<string | null>;
}

export type LiveTickerDiagnostic =
  | { code: "ok"; transport: string; httpStatus: number }
  | { code: "transport_unavailable"; message: string; hint: string }
  | { code: "agent_required"; message: string }
  | { code: "unauthorized"; message: string; httpStatus: number }
  | { code: "http_error"; message: string; httpStatus: number }
  | { code: "parse_error"; message: string };

export interface LiveTickerFetchResult {
  readonly ok: boolean;
  /** ISO instant of the read, from `options.now`. */
  readonly observedAt: string;
  readonly agentId: string | null;
  /** Object entries of the `LIST` array, unwidened and in wire order. */
  readonly rows: readonly Record<string, unknown>[];
  /** `LIST` length before the object-entry filter. */
  readonly rawRowCount: number;
  /** Transport that produced the rows; `null` when no rows were fetched. */
  readonly transport: string | null;
  readonly diagnostic: LiveTickerDiagnostic;
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

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (
    timeoutMs === undefined ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return LIVE_TICKER_FETCH_DEFAULT_TIMEOUT_MS;
  }
  return Math.trunc(timeoutMs);
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

/** Cheap agent candidates: the explicit option, then the env seam. No keychain read. */
function knownAgentId(
  options: LiveTickerFetchOptions,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const explicit = (options.agentId ?? "").trim();
  if (explicit !== "") return explicit;
  return (env["F402_AGENT_ID"] ?? "").trim() || null;
}

/**
 * Agent resolution: explicit option, env, then the keychain. The F402 scripts read the agent id
 * from the keychain themselves (`F402_AGENT_ID` is deliberately not injected by the environment
 * tooling), so a desk host with no env value must still resolve it. The keychain is skipped for
 * the injected-fetch seam so a unit test can never reach the real keychain; a locked or absent
 * keychain is a normal `null`, never a throw.
 */
async function resolveAgentId(
  options: LiveTickerFetchOptions,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  const known = knownAgentId(options, env);
  if (known !== null) return known;
  // The injected-fetch seam must never reach the REAL keychain. An explicit `secrets` seam is the
  // substitute read and cannot touch it, so it still runs; the real canonical-then-legacy read
  // happens only when no fetch is injected.
  const readSecret =
    options.secrets ??
    (options.fetchImpl !== undefined
      ? null
      : () => readSecretCanonicalThenLegacy(F402_KEYCHAIN_NAMES.agentId));
  if (readSecret === null) return null;
  try {
    return (await readSecret())?.trim() || null;
  } catch {
    return null;
  }
}

/** Form body the portal expects; `wagerNumber: "0"` returns the whole current list. */
function tickerBody(agentId: string): string {
  return new URLSearchParams({
    agentID: agentId,
    agentOwner: agentId,
    wagerNumber: "0",
    operation: "getBetTicker",
    RRO: "1",
  }).toString();
}

/**
 * Reads the live bet ticker. Never throws for an unconfigured session/agent: every refusal is a
 * structured diagnostic, and nothing is fetched until both a transport and an agent are resolved.
 */
export async function fetchLiveBetTicker(
  options: LiveTickerFetchOptions = {},
): Promise<LiveTickerFetchResult> {
  const env = options.env ?? Bun.env;
  const observedAt = (options.now ?? new Date()).toISOString();
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const session: F402Session | null =
    options.session !== undefined ? options.session : readF402Session();
  const proxyConfigured = (env[PROXY_ENV] ?? "").trim() !== "";
  // An injected fetch is a transport seam; otherwise a session or the proxy must exist.
  const transportAvailable =
    options.fetchImpl !== undefined || session !== null || proxyConfigured;

  // Starts as the agent the caller already named so a transport refusal can report it without
  // touching the keychain; the full resolution (which may read it) happens only once a transport
  // exists.
  let agentId: string | null = knownAgentId(options, env);

  const fail = (
    diagnostic: Exclude<LiveTickerDiagnostic, { code: "ok" }>,
  ): LiveTickerFetchResult => ({
    ok: false,
    observedAt,
    agentId,
    rows: [],
    rawRowCount: 0,
    transport: null,
    diagnostic,
  });

  if (!transportAvailable) {
    return fail({
      code: "transport_unavailable",
      message: TRANSPORT_UNAVAILABLE_MESSAGE,
      hint: SESSION_LOGIN_HINT,
    });
  }

  agentId = await resolveAgentId(options, env);
  if (agentId === null) {
    return fail({ code: "agent_required", message: AGENT_REQUIRED_MESSAGE });
  }

  let transport: F402ReplayTransport | null = null;
  let fetchImpl: F402ProbeFetch;
  let transportLabel: string;

  if (options.fetchImpl !== undefined) {
    fetchImpl = options.fetchImpl;
    transportLabel = "injected-fetch";
  } else {
    try {
      transport = await createF402ReplayTransport({ env });
    } catch (error) {
      return fail({
        code: "transport_unavailable",
        message: `${TRANSPORT_UNAVAILABLE_MESSAGE} Transport creation failed: ${errorMessage(error)}`,
        hint: SESSION_LOGIN_HINT,
      });
    }
    fetchImpl = transport.fetch;
    transportLabel = transport.label;
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    "x-requested-with": "XMLHttpRequest",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
  };
  if (session?.authorizationHeader !== undefined) {
    headers["authorization"] = session.authorizationHeader;
  }
  // The replay transport injects the cached cookie itself; an injected fetch has no transport
  // behind it, so the caller-provided session supplies the same cookie header the probe sends.
  if (options.fetchImpl !== undefined && session !== null) {
    headers["cookie"] = session.cookieHeader;
  }

  try {
    const response = await fetchImpl(F402_TICKER_URL, {
      method: "POST",
      headers,
      body: tickerBody(agentId),
      signal: AbortSignal.timeout(timeoutMs),
      proxy: false,
    } as RequestInit);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return fail({
          code: "unauthorized",
          message: `getBetTicker returned HTTP ${response.status}: the cached session was rejected or has expired. Refresh it with bun run session:login (or the session-refresh service).`,
          httpStatus: response.status,
        });
      }
      return fail({
        code: "http_error",
        message: `getBetTicker returned HTTP ${response.status}.`,
        httpStatus: response.status,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return fail({
        code: "parse_error",
        message:
          "getBetTicker response body is not JSON (a login page or an error envelope was returned instead of the ticker).",
      });
    }

    const rawRows = extractRows(payload);
    if (rawRows === null) {
      return fail({
        code: "parse_error",
        message:
          "getBetTicker response JSON has no LIST array; the ticker wire shape may have changed.",
      });
    }

    const rows = rawRows.filter(isRecord);
    return {
      ok: true,
      observedAt,
      agentId,
      rows,
      rawRowCount: rawRows.length,
      transport: transportLabel,
      diagnostic: {
        code: "ok",
        transport: transportLabel,
        httpStatus: response.status,
      },
    };
  } catch (error) {
    return fail({
      code: "http_error",
      message: isTimeout(error)
        ? `getBetTicker request timed out after ${timeoutMs} ms.`
        : `getBetTicker request failed: ${errorMessage(error)}`,
      httpStatus: 0,
    });
  } finally {
    if (transport !== null) await transport.close();
  }
}

/** True when a provenance `source` names a live read (`live:<operation>@<observedAt>`). */
export function isLiveTickerSource(source: string): boolean {
  return source.trim().startsWith(LIVE_TICKER_SOURCE_PREFIX);
}
