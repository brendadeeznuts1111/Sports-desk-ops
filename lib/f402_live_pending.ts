/**
 * @file lib/f402_live_pending.ts
 * @description One live `Report/Pending` read across a customer scope, shared by the desk
 * server's pending endpoints.
 *
 * `Report/Pending` is customer-scoped: one POST returns that customer's pending book, so a desk
 * read is a bounded fan-out over the caller's scope and the union of the parsed rows. The request
 * is the captured one (`scripts/capture/capture_pending_full.ts`): form body
 * `customerID` + empty `token` + `operation=Pending`.
 *
 * Auth follows `lib/f402_live_ticker.ts`: the request goes only through
 * `createF402ReplayTransport()` unless a caller already owns a fetch/session and injects it (tests
 * do). The transport refusal text and login hint are imported from that module rather than
 * restated, so both live readers refuse with the same three setup paths.
 *
 * No cookie, bearer token, or other session value is ever logged, returned, or stored: diagnostics
 * carry codes, messages and HTTP status only, and `fetchLivePending` never echoes a request
 * header. The `session` option is read but never copied into the result.
 */

import type { F402ProbeFetch } from "./f402_ingest.ts";
import {
  resolveWireProvenBearerHeader,
  SESSION_LOGIN_HINT,
  TRANSPORT_UNAVAILABLE_MESSAGE,
} from "./f402_live_ticker.ts";
import {
  createF402ReplayTransport,
  type F402ReplayTransport,
} from "./f402_replay_transport.ts";
import { readF402Session, type F402Session } from "./f402_session.ts";
import { readPendingRows, type PendingRow } from "./live_bets.ts";

/** `/cloud/api/Report/Pending`: the operation path the live-bets artifact records. */
export const REPORT_PENDING_OPERATION = "/cloud/api/Report/Pending";

/** Same URL the capture script posts to. */
export const REPORT_PENDING_URL = `https://fantasy402.com${REPORT_PENDING_OPERATION}`;

/** Env var naming the customer scope when the caller supplies no explicit list. */
const CUSTOMERS_ENV = "SPORTSDESK_LIVE_PENDING_CUSTOMERS";

const PROXY_ENV = "F402_REPLAY_PROXY_URL";

/**
 * Defaults and clamps for the live Pending read. These are exported so the server gates and the
 * tests derive from one source rather than re-declaring the same numbers.
 */
export const LIVE_PENDING_DEFAULT_MAX_CUSTOMERS = 25;
export const LIVE_PENDING_MIN_MAX_CUSTOMERS = 1;
export const LIVE_PENDING_MAX_MAX_CUSTOMERS = 50;
export const LIVE_PENDING_DEFAULT_TIMEOUT_MS = 3_000;
export const LIVE_PENDING_MIN_TIMEOUT_MS = 250;
export const LIVE_PENDING_MAX_TIMEOUT_MS = 15_000;
export const LIVE_PENDING_DEFAULT_CONCURRENCY = 5;
export const LIVE_PENDING_MAX_CONCURRENCY = 10;
export const LIVE_PENDING_DEFAULT_TICKER_CUSTOMER_CAP = 10;

/** A customer id is a portal login: short, printable, and never a URL/header fragment. */
const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

const NO_CUSTOMER_SCOPE_MESSAGE = `No customer scope for a live Report/Pending read: ${CUSTOMERS_ENV} is unset, empty, or every entry failed the customer-id rule.`;

const NO_CUSTOMER_SCOPE_HINT = [
  `Set ${CUSTOMERS_ENV}=H1716,CC364 (comma-separated portal login ids)`,
  "or pass the scope explicitly as the desk's livePending customer list.",
  "The scope can also come from the live getBetTicker rows (CustomerID, then Login) once a live",
  "ticker read has succeeded; no Report/Pending request is sent until a scope exists.",
].join("\n");

export interface LivePendingFetchOptions {
  /** Customer scope for the fan-out; sanitized and deduped here. */
  readonly customers: readonly string[];
  /** Cap on distinct customers read per call; default 25, clamped to 1..50. */
  readonly maxCustomers?: number;
  /** Per-customer request timeout in ms; default 3000, clamped to 250..15000. */
  readonly timeoutMs?: number;
  /** Parallel in-flight requests; default 5, clamped to 1..10. */
  readonly concurrency?: number;
  /** Clock seam for `observedAt`; defaults to `new Date()`. */
  readonly now?: Date;
  /** Environment seam; defaults to `Bun.env` (read for the proxy URL only). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Fetch seam for tests; when set, no replay transport is created. */
  readonly fetchImpl?: F402ProbeFetch;
  /** Session seam for tests; `undefined` reads the cache, `null` forces "no session". */
  readonly session?: F402Session | null;
}

export type LivePendingDiagnostic =
  | { code: "ok"; transport: string; httpStatus: number }
  | { code: "transport_unavailable"; message: string; hint: string }
  | { code: "no_customer_scope"; message: string; hint: string }
  | {
      code: "unauthorized";
      message: string;
      httpStatus: number;
      customersAttempted: number;
      customersFailed: number;
    }
  | {
      code: "http_error";
      message: string;
      httpStatus: number;
      customersAttempted: number;
      customersFailed: number;
    }
  | {
      code: "parse_error";
      message: string;
      customersAttempted: number;
      customersFailed: number;
    };

export interface LivePendingFetchResult {
  readonly ok: boolean;
  /** True when at least one customer answered but at least one other failed. */
  readonly partial: boolean;
  /** ISO instant of the read, from `options.now`. */
  readonly observedAt: string;
  /** Union of every customer's parsed rows, in scope order; not deduped (the builder dedupes). */
  readonly rows: readonly PendingRow[];
  readonly customersAttempted: number;
  readonly customersFailed: number;
  /** Transport that produced the rows; `null` when the read failed overall. */
  readonly transport: string | null;
  readonly diagnostic: LivePendingDiagnostic;
}

/** One customer's outcome, kept with its scope index so the merged row order is deterministic. */
type CustomerOutcome =
  | {
      readonly index: number;
      readonly kind: "ok";
      readonly status: number;
      readonly rows: readonly PendingRow[];
    }
  | {
      readonly index: number;
      readonly kind: "unauthorized";
      readonly status: number;
    }
  | {
      readonly index: number;
      readonly kind: "http_error";
      readonly status: number;
      readonly message: string;
    }
  | {
      readonly index: number;
      readonly kind: "parse_error";
      readonly status: number;
      readonly message: string;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function safeMessage(message: string): string {
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/** NaN-safe integer with a default and a hard range (an option can never become a NaN cap). */
function clampInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function sanitizeCustomerId(raw: string): string | null {
  const id = raw.trim();
  return CUSTOMER_ID_PATTERN.test(id) ? id : null;
}

/**
 * Trims, validates, dedupes (case-insensitively: the same customer reported as `CustomerID` and
 * `Login` must not be POSTed twice) and caps the scope, preserving the caller's order.
 */
function scopeCustomers(
  customers: readonly string[],
  maxCustomers: number,
): string[] {
  const seen = new Set<string>();
  const scope: string[] = [];
  for (const raw of customers) {
    if (typeof raw !== "string") continue;
    const id = sanitizeCustomerId(raw);
    if (id === null) continue;
    const key = id.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    scope.push(id);
    if (scope.length >= maxCustomers) break;
  }
  return scope;
}

/** Form body the portal expects; `token` is empty because auth is the transport's cookie. */
function pendingBody(customerId: string): string {
  return new URLSearchParams({
    customerID: customerId,
    token: "",
    operation: "Pending",
  }).toString();
}

/** Request headers from the capture script, plus the session the injected-fetch seam needs. */
function requestHeaders(
  options: LivePendingFetchOptions,
  env: Readonly<Record<string, string | undefined>>,
  session: F402Session | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
  };
  const authHeader = resolveWireProvenBearerHeader(env, session);
  if (authHeader !== undefined) {
    headers["authorization"] = authHeader;
  }
  // The replay transport injects the cached cookie itself; an injected fetch has no transport
  // behind it, so the caller-provided session supplies the same cookie header a probe sends.
  if (options.fetchImpl !== undefined && session !== null) {
    headers["cookie"] = session.cookieHeader;
  }
  return headers;
}

/**
 * One customer-scoped read. Never throws: a transport error, an HTTP error, and a non-JSON body
 * are all outcomes the caller aggregates.
 */
async function fetchCustomerPending(
  fetchImpl: F402ProbeFetch,
  customerId: string,
  index: number,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<CustomerOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(REPORT_PENDING_URL, {
      method: "POST",
      headers,
      body: pendingBody(customerId),
      signal: AbortSignal.timeout(timeoutMs),
      proxy: false,
    } as RequestInit);
  } catch (error) {
    return {
      index,
      kind: "http_error",
      status: 0,
      message: isTimeout(error)
        ? `request timed out after ${timeoutMs} ms`
        : `request failed: ${safeMessage(errorMessage(error))}`,
    };
  }

  // A rejected session is not a per-customer failure: every other customer is behind the same
  // session, so the caller aborts the whole fan-out instead of collecting more 401 pages.
  if (response.status === 401 || response.status === 403) {
    return { index, kind: "unauthorized", status: response.status };
  }
  if (!response.ok) {
    return {
      index,
      kind: "http_error",
      status: response.status,
      message: `HTTP ${response.status}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      index,
      kind: "parse_error",
      status: response.status,
      message:
        "response body is not JSON (a login page or an error envelope was returned instead of the pending book)",
    };
  }
  // A 200 with zero rows is a valid empty book for that customer; `readPendingRows` returns [].
  return {
    index,
    kind: "ok",
    status: response.status,
    rows: readPendingRows(payload),
  };
}

function failureDiagnostic(
  outcomes: readonly Exclude<CustomerOutcome, { kind: "ok" }>[],
  customersAttempted: number,
): Exclude<LivePendingDiagnostic, { code: "ok" }> {
  const customersFailed = outcomes.length;
  const unauthorized = outcomes.find(
    (outcome) => outcome.kind === "unauthorized",
  );
  if (unauthorized !== undefined) {
    return {
      code: "unauthorized",
      // Wording from lib/f402_live_ticker.ts: same session, same refresh instruction.
      message: `Report/Pending returned HTTP ${unauthorized.status}: the cached session was rejected or has expired. Refresh it with bun run session:login (or the session-refresh service).`,
      httpStatus: unauthorized.status,
      customersAttempted,
      customersFailed,
    };
  }

  const http = outcomes.find((outcome) => outcome.kind === "http_error");
  if (http !== undefined) {
    return {
      code: "http_error",
      message:
        http.status > 0
          ? `Report/Pending returned HTTP ${http.status}; ${customersFailed} of ${customersAttempted} customer read(s) failed and none returned a pending book.`
          : `Report/Pending request failed for ${customersFailed} of ${customersAttempted} customer(s); none returned a pending book. First error: ${http.message}`,
      httpStatus: http.status,
      customersAttempted,
      customersFailed,
    };
  }

  const parse = outcomes.find((outcome) => outcome.kind === "parse_error");
  return {
    code: "parse_error",
    message:
      parse === undefined
        ? "Report/Pending returned no usable body."
        : `Report/Pending returned a non-JSON body for ${customersFailed} of ${customersAttempted} customer(s): a login page or an error envelope was returned instead of the pending book.`,
    customersAttempted,
    customersFailed,
  };
}

/**
 * Reads the live Pending report for every customer in scope.
 *
 * Never throws for an unconfigured transport or an empty scope: every refusal is a structured
 * diagnostic, and nothing is fetched until both a scope and a transport exist. A 401/403 on the
 * first observed response stops the fan-out; every other per-customer failure is collected and
 * reported as `partial` when at least one customer still answered.
 */
export async function fetchLivePending(
  options: LivePendingFetchOptions,
): Promise<LivePendingFetchResult> {
  const env = options.env ?? Bun.env;
  const observedAt = (options.now ?? new Date()).toISOString();
  const maxCustomers = clampInt(
    options.maxCustomers,
    LIVE_PENDING_DEFAULT_MAX_CUSTOMERS,
    1,
    LIVE_PENDING_MAX_MAX_CUSTOMERS,
  );
  const timeoutMs = clampInt(
    options.timeoutMs,
    LIVE_PENDING_DEFAULT_TIMEOUT_MS,
    LIVE_PENDING_MIN_TIMEOUT_MS,
    LIVE_PENDING_MAX_TIMEOUT_MS,
  );
  const concurrency = clampInt(
    options.concurrency,
    LIVE_PENDING_DEFAULT_CONCURRENCY,
    1,
    LIVE_PENDING_MAX_CONCURRENCY,
  );

  // Scope first: an empty scope needs no session read and must never open a connection.
  const scope = scopeCustomers(options.customers, maxCustomers);
  if (scope.length === 0) {
    return {
      ok: false,
      partial: false,
      observedAt,
      rows: [],
      customersAttempted: 0,
      customersFailed: 0,
      transport: null,
      diagnostic: {
        code: "no_customer_scope",
        message: NO_CUSTOMER_SCOPE_MESSAGE,
        hint: NO_CUSTOMER_SCOPE_HINT,
      },
    };
  }

  const session: F402Session | null =
    options.session !== undefined ? options.session : readF402Session();
  const proxyConfigured = (env[PROXY_ENV] ?? "").trim() !== "";
  // An injected fetch is a transport seam; otherwise a session or the proxy must exist.
  const transportAvailable =
    options.fetchImpl !== undefined || session !== null || proxyConfigured;

  const fail = (
    diagnostic: Extract<
      LivePendingDiagnostic,
      { code: "transport_unavailable" }
    >,
  ): LivePendingFetchResult => ({
    ok: false,
    partial: false,
    observedAt,
    rows: [],
    customersAttempted: 0,
    customersFailed: 0,
    transport: null,
    diagnostic,
  });

  if (!transportAvailable) {
    return fail({
      code: "transport_unavailable",
      // The shared refusal text from lib/f402_live_ticker.ts: same transport, same setup paths.
      message: TRANSPORT_UNAVAILABLE_MESSAGE,
      hint: SESSION_LOGIN_HINT,
    });
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
        message: `${TRANSPORT_UNAVAILABLE_MESSAGE} Transport creation failed: ${safeMessage(errorMessage(error))}`,
        hint: SESSION_LOGIN_HINT,
      });
    }
    fetchImpl = transport.fetch;
    transportLabel = transport.label;
  }

  const headers = requestHeaders(options, env, session);
  const outcomes: CustomerOutcome[] = [];
  let next = 0;
  let aborted = false;

  /** One pool worker: claim the next scope entry, read it, and stop when the session is rejected. */
  async function worker(): Promise<void> {
    while (!aborted) {
      const index = next;
      if (index >= scope.length) return;
      next += 1;
      const customerId = scope[index];
      if (customerId === undefined) return;
      const outcome = await fetchCustomerPending(
        fetchImpl,
        customerId,
        index,
        headers,
        timeoutMs,
      );
      outcomes.push(outcome);
      if (outcome.kind === "unauthorized") aborted = true;
    }
  }

  try {
    const workers = Math.min(concurrency, scope.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
  } finally {
    if (transport !== null) await transport.close();
  }

  outcomes.sort((left, right) => left.index - right.index);
  const successes = outcomes.filter(
    (outcome): outcome is Extract<CustomerOutcome, { kind: "ok" }> =>
      outcome.kind === "ok",
  );
  const failures = outcomes.filter(
    (outcome): outcome is Exclude<CustomerOutcome, { kind: "ok" }> =>
      outcome.kind !== "ok",
  );
  const rows = successes.flatMap((outcome) => [...outcome.rows]);
  const customersAttempted = outcomes.length;
  const customersFailed = failures.length;

  if (successes.length === 0) {
    return {
      ok: false,
      partial: false,
      observedAt,
      rows: [],
      customersAttempted,
      customersFailed,
      transport: null,
      diagnostic: failureDiagnostic(failures, customersAttempted),
    };
  }

  const firstSuccess = successes[0];
  const httpStatus = firstSuccess?.status ?? 200;
  return {
    ok: true,
    partial: customersFailed > 0,
    observedAt,
    rows,
    customersAttempted,
    customersFailed,
    transport: transportLabel,
    diagnostic: { code: "ok", transport: transportLabel, httpStatus },
  };
}

/** `CustomerID` first, then `Login`: the same customer id the ticker rows carry both spellings. */
function tickerRowCustomerId(row: Record<string, unknown>): string | null {
  for (const key of ["CustomerID", "Login"] as const) {
    const value = row[key];
    if (typeof value !== "string") continue;
    const id = sanitizeCustomerId(value);
    if (id !== null) return id;
  }
  return null;
}

/**
 * Derives the Pending customer scope from a live `getBetTicker` row set, so a desk that already
 * reads the ticker live does not need a second scope setting. Junk ids are dropped (not guessed
 * at) and the result is deduped and capped; default cap 10.
 */
export function pendingCustomersFromTickerRows(
  rows: readonly Record<string, unknown>[],
  max?: number,
): string[] {
  const cap = clampInt(
    max,
    LIVE_PENDING_DEFAULT_TICKER_CUSTOMER_CAP,
    1,
    LIVE_PENDING_MAX_MAX_CUSTOMERS,
  );
  const seen = new Set<string>();
  const scope: string[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const id = tickerRowCustomerId(row);
    if (id === null) continue;
    const key = id.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    scope.push(id);
    if (scope.length >= cap) break;
  }
  return scope;
}
