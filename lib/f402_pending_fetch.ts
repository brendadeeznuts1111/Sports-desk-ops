/** Direct 4C `Manager/getPending` fetch, validation and capture persistence. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class F402PendingFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "F402PendingFetchError";
  }
}

const MIN_TOKEN_LENGTH = 24;

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

const INVALID_TOKEN_MESSAGE = `invalid F402 bearer token: provide --bearer-token, F402_BEARER_TOKEN, or F402_TOKEN_FILE (min ${MIN_TOKEN_LENGTH} chars, raw value only)`;

/** A headerless JWT is exactly three non-empty base64url segments. */
function isJwtShaped(token: string): boolean {
  const segments = token.split(".");
  return (
    segments.length === 3 &&
    segments.every(
      (segment) => segment !== "" && BASE64URL_SEGMENT.test(segment),
    )
  );
}

/**
 * Normalizes one candidate (`Bearer ` prefix stripped) and validates it. Returns null instead of
 * throwing so a file read can fail closed without guessing whether the content was a token.
 *
 * Rejected: empty/zero, shell text (`umask…`, `export…`, anything containing whitespace), and a
 * JWT-looking value (`eyJ…`) that is not exactly three non-empty base64url segments. Opaque
 * tokens are accepted when they meet the existing minimum length.
 */
export function validateF402Token(raw: string): string | null {
  const token = raw
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (token === "" || token === "0") return null;
  if (/\s/.test(token)) return null;
  if (/^(?:umask|export)/.test(token)) return null;
  if (token.startsWith("eyJ") && !isJwtShaped(token)) return null;
  if (token.length < MIN_TOKEN_LENGTH) return null;
  return token;
}

/**
 * Reads a token file and returns the validated token, or null when the file is missing,
 * unreadable, or does not hold exactly one raw token. Reads are injectable for tests.
 */
export function readF402TokenFile(
  path: string,
  readFile: (target: string) => string = (target) =>
    readFileSync(target, "utf8"),
): string | null {
  try {
    return validateF402Token(readFile(path));
  } catch {
    return null;
  }
}

/** Token-file path: `F402_TOKEN_FILE`, else `$XDG_CONFIG_HOME/sportsdesk/f402-token`. */
export function resolveF402TokenFilePath(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): string {
  const explicit = (env.F402_TOKEN_FILE ?? "").trim();
  if (explicit !== "") return explicit;
  const configHome =
    (env.XDG_CONFIG_HOME ?? "").trim() || `${(env.HOME ?? "").trim()}/.config`;
  return `${configHome}/sportsdesk/f402-token`;
}

/**
 * Write one validated bearer token to a 0600 file (atomic temp+rename). The token is never logged.
 * This is the `session:login --mint-bearer` half of the contract `resolveF402BearerToken` reads.
 */
export function writeF402BearerToken(
  rawToken: string,
  options: {
    readonly path?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): { readonly path: string; readonly chars: number } {
  const token = validateF402Token(rawToken);
  if (token === null) {
    throw new F402PendingFetchError(INVALID_TOKEN_MESSAGE);
  }
  const path = options.path ?? resolveF402TokenFilePath(options.env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, token, { mode: 0o600 });
  renameSync(temp, path);
  return { path, chars: token.length };
}

/** Resolve the bearer token read-only: CLI, env, then the token file; fail before network I/O. */
export function resolveF402BearerToken(
  options: {
    readonly cliToken?: string | undefined;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly readFile?: (path: string) => string;
  } = {},
): string {
  const env =
    options.environment ?? (Bun.env as Record<string, string | undefined>);
  const readFile =
    options.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  // First non-empty source wins, as before: a present-but-invalid source fails closed instead of
  // silently falling through to a stale env/file token.
  const cliRaw = (options.cliToken ?? "").trim();
  if (cliRaw !== "") {
    const token = validateF402Token(cliRaw);
    if (token === null) throw new F402PendingFetchError(INVALID_TOKEN_MESSAGE);
    return token;
  }
  const envRaw = (env.F402_BEARER_TOKEN ?? "").trim();
  if (envRaw !== "") {
    const token = validateF402Token(envRaw);
    if (token === null) throw new F402PendingFetchError(INVALID_TOKEN_MESSAGE);
    return token;
  }

  const fromFile = readF402TokenFile(resolveF402TokenFilePath(env), readFile);
  if (fromFile !== null) return fromFile;

  throw new F402PendingFetchError(INVALID_TOKEN_MESSAGE);
}

/** `deskDate - 6d` in America/Chicago, for the 7-day open book. */
export function defaultPendingDate(
  now = new Date(),
  override?: string,
): string {
  if (override !== undefined && override !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(override)) {
      throw new F402PendingFetchError(
        `--date must be YYYY-MM-DD, got "${override}"`,
      );
    }
    return override;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now.getTime() - 6 * 86_400_000));
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface PendingFetchOptions {
  readonly token: string;
  readonly date: string;
  readonly agentId?: string;
  readonly agentOwner?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
}

export interface PendingFetchResult {
  readonly legs: readonly Record<string, unknown>[];
  readonly url: string;
  readonly body: Readonly<Record<string, string | number>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Class A guard: reject auth traps and require a bare array or `{ LIST: [...] }`. */
export function extractPendingLegs(
  payload: unknown,
): Record<string, unknown>[] {
  const legs = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.LIST)
      ? payload.LIST
      : null;
  if (legs === null) {
    throw new F402PendingFetchError(
      "getPending response is neither a JSON array nor { LIST: [...] }",
    );
  }
  if (!legs.every(isRecord)) {
    throw new F402PendingFetchError("getPending LIST contains non-object legs");
  }
  return legs;
}

export async function fetchF402Pending(
  options: PendingFetchOptions,
): Promise<PendingFetchResult> {
  const base = (
    options.baseUrl ??
    Bun.env.F402_BASE_URL ??
    "https://fantasy402.com"
  ).replace(/\/+$/, "");
  const url = `${base}/cloud/api/Manager/getPending`;
  const body: Record<string, string | number> = {
    agentID: options.agentId ?? Bun.env.F402_AGENT_ID ?? "",
    path: "/qubic/api/Manager/getPending",
    RRO: 1,
    date: options.date,
    wagerType: "",
    sort: "1",
    typeSort: "2",
    week: 0,
    customerID: "0",
    agentOwner: options.agentOwner ?? Bun.env.F402_AGENT_OWNER ?? "",
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (response.status !== 200) {
    throw new F402PendingFetchError(
      `getPending returned HTTP ${response.status}`,
    );
  }
  if (
    contentType.includes("text/html") ||
    /^\s*(<!doctype|<html|<)/i.test(text)
  ) {
    throw new F402PendingFetchError(
      "getPending returned an HTML/XML login trap",
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new F402PendingFetchError("getPending returned non-JSON content");
  }
  return { legs: extractPendingLegs(payload), url, body };
}

/** Atomically persist the validated legs; throws before touching the target on invalid input. */
export function persistPendingCapture(
  path: string,
  legs: readonly Record<string, unknown>[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(legs, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export async function fetchAndPersistPending(
  options: PendingFetchOptions & { readonly capturePath: string },
): Promise<PendingFetchResult> {
  const result = await fetchF402Pending(options);
  persistPendingCapture(options.capturePath, result.legs);
  return result;
}

/** Decode a JWT `exp` claim (no signature verification); null when absent/malformed. */
export function f402TokenExpiresAtMs(token: string): number | null {
  try {
    const segment = token.split(".")[1];
    if (segment === undefined || segment === "") return null;
    const json = Buffer.from(
      segment.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const payload = JSON.parse(json) as unknown;
    const exp = isRecord(payload) ? payload["exp"] : undefined;
    return typeof exp === "number" && Number.isFinite(exp)
      ? Math.round(exp * 1000)
      : null;
  } catch {
    return null;
  }
}

/** A token refresh failed; a batch must abort, never downgrade this to a per-customer skip. */
export class F402TokenRefreshError extends F402PendingFetchError {
  constructor(message: string) {
    super(message);
    this.name = "F402TokenRefreshError";
  }
}

export interface RenewF402BearerTokenOptions {
  /** Current (possibly about-to-expire) JWT. Never logged. */
  readonly token: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

export interface RenewedF402BearerToken {
  /** New JWT. Never log this field. */
  readonly token: string;
  readonly tokenChars: number;
  readonly expiresAtMs: number | null;
  readonly expiresAtIso: string | null;
}

/**
 * `POST /cloud/api/System/renewToken` — measured 2026-11-04: HTTP 200 with `{ code }` for a valid
 * bearer. Used by long customer batches so a 20-minute JWT cannot expire mid-cycle.
 */
export async function renewF402BearerToken(
  options: RenewF402BearerTokenOptions,
): Promise<RenewedF402BearerToken> {
  const token = validateF402Token(options.token);
  if (token === null) throw new F402TokenRefreshError(INVALID_TOKEN_MESSAGE);
  const baseUrl = (
    options.baseUrl ??
    ((Bun.env.F402_BASE_URL ?? "").trim() || "https://www.fantasy402.com")
  ).replace(/\/+$/, "");
  const fetchImpl =
    options.fetchImpl ??
    ((input: string, init: RequestInit) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/cloud/api/System/renewToken`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/javascript, */*; q=0.01",
        "x-requested-with": "XMLHttpRequest",
      },
      body: JSON.stringify({ operation: "renewToken", RRO: 1 }),
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 25_000),
    });
  } catch (error) {
    throw new F402TokenRefreshError(
      `renewToken request failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  if (response.status !== 200) {
    const msg = isRecord(payload) ? shortServerMessage(payload["msg"]) : "";
    throw new F402TokenRefreshError(
      `renewToken returned HTTP ${response.status}${msg === "" ? "" : `: ${msg}`}`,
    );
  }
  const code = isRecord(payload) ? payload["code"] : undefined;
  const renewed = typeof code === "string" ? validateF402Token(code) : null;
  if (renewed === null) {
    throw new F402TokenRefreshError(
      "renewToken returned no valid `code` token",
    );
  }
  const expiresAtMs = f402TokenExpiresAtMs(renewed);
  return {
    token: renewed,
    tokenChars: renewed.length,
    expiresAtMs,
    expiresAtIso:
      expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
  };
}

/* ------------------------------------------------------------------------- */
/* Report/Pending (customer-scoped) — the bearer path that actually works     */
/* ------------------------------------------------------------------------- */

/** The verified bearer endpoint. `Manager/getPending` returns 500 and is not used here. */
export const REPORT_PENDING_PATH = "/cloud/api/Report/Pending";

export interface ReportPendingBatchOptions {
  /** Validated F402 bearer (e.g. from `session:login --mint-bearer`). Never logged. */
  readonly token: string;
  readonly customerIds: readonly string[];
  readonly baseUrl?: string;
  readonly fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  /** Parallel requests; default 6. */
  readonly concurrency?: number;
  /** Hard cap on parallelism; default 8 (operator can raise it to at most 16). */
  readonly maxConcurrency?: number;
  readonly timeoutMs?: number;
  /** `throw` (default) fails the whole batch on any customer; `skip` records the failure. */
  readonly onCustomerFailure?: "throw" | "skip";
  /** `exp` of the initial token, from `f402TokenExpiresAtMs`; enables proactive refresh. */
  readonly expiresAtMs?: number | null;
  /** Renew at this point before expiry; default 300_000 ms (5 min). */
  readonly refreshLeadMs?: number;
  /** Mint a fresh token when the current one is near expiry or a request returns 401. */
  readonly refreshToken?: (
    currentToken: string,
  ) => Promise<{ readonly token: string; readonly expiresAtMs: number | null }>;
  /** Called after a successful refresh (safe logging hook). */
  readonly onRefresh?: () => void;
  /** Retries for 429/5xx/network failures per customer; default 2 (3 attempts). */
  readonly maxRetries?: number;
  /** Injectable delay for tests; defaults to `Bun.sleep`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ReportPendingCustomerResult {
  readonly customerIdChars: number;
  readonly ok: boolean;
  readonly status: number | null;
  readonly legs: number;
  /** Short server message / class; never a token. */
  readonly error: string | null;
}

export interface ReportPendingBatchResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly perCustomer: readonly ReportPendingCustomerResult[];
  readonly okCount: number;
  readonly failedCount: number;
  readonly url: string;
}

function shortServerMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text === "" || text.length > 80) return "";
  return /^[\x20-\x7E]+$/.test(text) ? text : "";
}

class ReportPendingResponseError extends F402PendingFetchError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ReportPendingResponseError";
    this.status = status;
  }
}

/** Parse one Report/Pending response into rows; throws `F402PendingFetchError` with a class. */
function reportPendingRows(
  status: number,
  contentType: string,
  text: string,
): readonly Record<string, unknown>[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new F402PendingFetchError(
      `Report/Pending returned non-JSON content (HTTP ${status})`,
    );
  }
  if (isRecord(payload) && Array.isArray(payload.Pending)) {
    const rows = payload.Pending.filter(isRecord);
    if (rows.length !== payload.Pending.length) {
      throw new F402PendingFetchError(
        "Report/Pending Pending array contains non-object rows",
      );
    }
    return rows;
  }
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (status !== 200) {
    const msg = isRecord(payload) ? shortServerMessage(payload.msg) : "";
    throw new F402PendingFetchError(
      `Report/Pending returned HTTP ${status}${msg === "" ? "" : `: ${msg}`}`,
    );
  }
  throw new F402PendingFetchError(
    "Report/Pending response has no Pending array",
  );
}

/**
 * Fetch pending rows for an explicit customer list over the verified bearer path.
 *
 * `Manager/getPending` is not used: it returns 500 for every captured request shape. Report/Pending
 * is strictly customer-scoped (no wildcard/agent scope was accepted on 2026-11-04), so the caller
 * must supply the list — this function never invents or enumerates customers.
 */
export async function fetchF402ReportPendingBatch(
  options: ReportPendingBatchOptions,
): Promise<ReportPendingBatchResult> {
  const initialToken = validateF402Token(options.token);
  if (initialToken === null) {
    throw new F402PendingFetchError(INVALID_TOKEN_MESSAGE);
  }
  const baseUrl = (
    options.baseUrl ??
    ((Bun.env.F402_BASE_URL ?? "").trim() || "https://www.fantasy402.com")
  ).replace(/\/+$/, "");
  const url = `${baseUrl}${REPORT_PENDING_PATH}`;
  const customerIds = [
    ...new Set(
      options.customerIds.map((id) => id.trim()).filter((id) => id !== ""),
    ),
  ];
  if (customerIds.length === 0) {
    throw new F402PendingFetchError(
      "Report/Pending needs an explicit customer list (F402_PENDING_CUSTOMERS or --customers)",
    );
  }
  const fetchImpl =
    options.fetchImpl ??
    ((input: string, init: RequestInit) => fetch(input, init));
  const onFailure = options.onCustomerFailure ?? "throw";
  const maxConcurrency = Math.min(
    16,
    Math.max(1, Math.floor(options.maxConcurrency ?? 8)),
  );
  const concurrency = Math.min(
    maxConcurrency,
    Math.max(1, Math.floor(options.concurrency ?? 6)),
    customerIds.length,
  );
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2));
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));

  // Mutable token state for a long batch; shared by every worker.
  let currentToken = initialToken;
  let expiresAtMs = options.expiresAtMs ?? null;
  let refreshing: Promise<void> | null = null;
  async function refreshNow(): Promise<void> {
    if (options.refreshToken === undefined) {
      throw new F402TokenRefreshError(
        "token expired or was rejected and no refresh is configured",
      );
    }
    if (refreshing === null) {
      refreshing = (async () => {
        let next: {
          readonly token: string;
          readonly expiresAtMs: number | null;
        };
        try {
          next = await options.refreshToken!(currentToken);
        } catch (error) {
          throw new F402TokenRefreshError(
            `token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const valid = validateF402Token(next.token);
        if (valid === null) {
          throw new F402TokenRefreshError("refresh returned an invalid token");
        }
        currentToken = valid;
        expiresAtMs = next.expiresAtMs;
        options.onRefresh?.();
      })().finally(() => {
        refreshing = null;
      });
    }
    await refreshing;
  }
  async function ensureFresh(): Promise<void> {
    if (expiresAtMs === null || options.refreshToken === undefined) return;
    const lead = options.refreshLeadMs ?? 300_000;
    if (Date.now() < expiresAtMs - lead) return;
    await refreshNow();
  }
  function backoffMs(attempt: number, response?: Response): number {
    const retryAfter = (response?.headers.get("retry-after") ?? "").trim();
    if (/^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
    const base = Math.min(8_000, 250 * 2 ** attempt);
    return base + Math.floor(Math.random() * base * 0.3);
  }

  /** One customer with proactive refresh, 401 refresh, and 429/5xx/network backoff. */
  async function fetchRows(
    customerID: string,
  ): Promise<{ status: number; rows: readonly Record<string, unknown>[] }> {
    await ensureFresh();
    let attempts = 0;
    let authRetried = false;
    for (;;) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${currentToken}`,
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            accept: "application/json, text/plain, */*",
            "x-requested-with": "XMLHttpRequest",
          },
          body: new URLSearchParams({
            customerID,
            token: "",
            operation: "Pending",
          }).toString(),
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs ?? 25_000),
        });
      } catch (error) {
        if (attempts < maxRetries) {
          await sleep(backoffMs(attempts));
          attempts += 1;
          continue;
        }
        throw new F402PendingFetchError(
          `Report/Pending request failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
      if (
        response.status === 401 &&
        !authRetried &&
        options.refreshToken !== undefined
      ) {
        authRetried = true;
        await refreshNow();
        continue;
      }
      if (
        (response.status === 429 || response.status >= 500) &&
        attempts < maxRetries
      ) {
        await sleep(backoffMs(attempts, response));
        attempts += 1;
        continue;
      }
      const text = await response.text();
      try {
        return {
          status: response.status,
          rows: reportPendingRows(
            response.status,
            response.headers.get("content-type") ?? "",
            text,
          ),
        };
      } catch (error) {
        throw new ReportPendingResponseError(
          response.status,
          error instanceof Error ? error.message : "Report/Pending failed",
        );
      }
    }
  }

  const results = new Map<
    number,
    {
      readonly rows: readonly Record<string, unknown>[];
      readonly result: ReportPendingCustomerResult;
    }
  >();

  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= customerIds.length) return;
      const customerID = customerIds[index]!;
      let status: number | null = null;
      try {
        const fetched = await fetchRows(customerID);
        status = fetched.status;
        results.set(index, {
          rows: fetched.rows,
          result: {
            customerIdChars: customerID.length,
            ok: true,
            status,
            legs: fetched.rows.length,
            error: null,
          },
        });
      } catch (error) {
        if (error instanceof F402TokenRefreshError) throw error;
        if (error instanceof ReportPendingResponseError) status = error.status;
        const message =
          error instanceof Error ? error.message : "Report/Pending failed";
        results.set(index, {
          rows: [],
          result: {
            customerIdChars: customerID.length,
            ok: false,
            status,
            legs: 0,
            error: message,
          },
        });
        if (onFailure === "throw") throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const rows: Record<string, unknown>[] = [];
  const perCustomer: ReportPendingCustomerResult[] = [];
  for (let index = 0; index < customerIds.length; index += 1) {
    const entry = results.get(index);
    if (entry === undefined) continue; // unreachable after a resolved batch
    rows.push(...entry.rows);
    perCustomer.push(entry.result);
  }
  const okCount = perCustomer.filter((entry) => entry.ok).length;
  return {
    rows,
    perCustomer,
    okCount,
    failedCount: perCustomer.length - okCount,
    url,
  };
}

/** Batch fetch + persist as a bare rows array (the shape `buildF402PendingRollup` reads). */
export async function fetchAndPersistReportPending(
  options: ReportPendingBatchOptions & { readonly capturePath: string },
): Promise<ReportPendingBatchResult> {
  const result = await fetchF402ReportPendingBatch(options);
  persistPendingCapture(options.capturePath, result.rows);
  return result;
}
