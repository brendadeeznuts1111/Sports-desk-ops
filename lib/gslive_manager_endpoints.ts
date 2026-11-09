/**
 * @file gslive_manager_endpoints.ts
 * @description Typed probes for the read-only Manager Tools endpoints the desk now uses:
 * `live/data` catalog plus the report kinds. Every probe returns a structured status instead
 * of throwing a string, so a caller can tell an expired session (401/302/HTML-200) from a
 * permission gap (403 "Not permitted") and from a transport or shape failure.
 *
 * The cookie header is accepted only as an argument and never included in a result.
 */

export const GSLIVE_LIVE_DATA_URL =
  "https://plive.sportswidgets.pro/live/data?countries=true&leagues=true&sports=true";

export const GSLIVE_REPORTS_BASE =
  "https://plive.sportswidgets.pro/manager-tools/reports/";

import { GSLIVE_PARTNER_ID } from "./gslive_manager_watchlist.ts";

/** Single ordered endpoint list; probes and tests derive from this, not a copied literal. */
export const MANAGER_ENDPOINT_KINDS = [
  "live-data",
  "periods",
  "users-report",
  "events-report",
  "summary-report",
  "open-bet-report",
  "bettor-report",
] as const satisfies readonly GsliveManagerEndpointKind[];

export const DEFAULT_MANAGER_PARTNER_ID = Number(GSLIVE_PARTNER_ID);

export const GSLIVE_REPORT_PERIODS_URL =
  "https://plive.sportswidgets.pro/manager-tools/reports/periods/index.php";

export type GsliveManagerEndpointKind =
  | "live-data"
  | "periods"
  | "users-report"
  | "events-report"
  | "summary-report"
  | "open-bet-report"
  | "bettor-report";

export type GsliveManagerEndpointStatus =
  | "ok"
  | "not_permitted"
  | "session_expired"
  | "challenge"
  | "forbidden"
  | "throttled"
  | "server_error"
  | "unreachable"
  | "invalid_json"
  | "shape_error";

export interface GsliveManagerWindow {
  readonly fromEpochSec: number;
  readonly toEpochSec: number;
}

export interface GsliveManagerProbe {
  readonly kind: GsliveManagerEndpointKind;
  readonly status: GsliveManagerEndpointStatus;
  readonly httpStatus: number | null;
  readonly latencyMs: number | null;
  readonly checkedAt: string;
  /** Rows for report kinds; top-level keys for the catalog; null on failure. */
  readonly count: number | null;
  readonly error: string | null;
}

export interface GsliveManagerProbeOptions {
  readonly cookieHeader: string;
  /** Optional JS-readable session id for the reports surface; never returned. */
  readonly xGsSession?: string;
  readonly window?: GsliveManagerWindow;
  readonly partnerId?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export function defaultManagerWindow(
  nowMs: number = Date.now(),
): GsliveManagerWindow {
  const toEpochSec = Math.floor(nowMs / 1000);
  return { fromEpochSec: toEpochSec - DEFAULT_WINDOW_SECONDS, toEpochSec };
}

export function managerReportUrl(
  kind: Exclude<GsliveManagerEndpointKind, "live-data" | "periods">,
  window: GsliveManagerWindow,
  partnerId = DEFAULT_MANAGER_PARTNER_ID,
): string {
  const url = new URL(GSLIVE_REPORTS_BASE);
  url.searchParams.set("from", String(window.fromEpochSec));
  url.searchParams.set("to", String(window.toEpochSec));
  url.searchParams.set("kind", kind);
  url.searchParams.set("partnerId", String(partnerId));
  return url.toString();
}

/** Pure classification of an HTTP response body for the Manager endpoints. */
export function classifyManagerEndpointResponse(input: {
  readonly httpStatus: number;
  readonly contentType: string;
  readonly body: string;
  readonly cfMitigated?: string | null;
  readonly kind: GsliveManagerEndpointKind;
}): { status: GsliveManagerEndpointStatus; error: string | null } {
  if (input.httpStatus >= 300 && input.httpStatus < 400) {
    return {
      status: "session_expired",
      error: "redirected to login — GSID/ganchrow session is expired",
    };
  }
  if (input.httpStatus === 401) {
    return { status: "session_expired", error: "HTTP 401 — session expired" };
  }
  if (input.httpStatus === 403) {
    if ((input.cfMitigated ?? "").trim() !== "") {
      return {
        status: "challenge",
        error: `Cloudflare challenge (cf-mitigated: ${input.cfMitigated})`,
      };
    }
    if (/not permitted|forbidden|not authorized/i.test(input.body)) {
      return {
        status: "not_permitted",
        error: "HTTP 403 — the account lacks this report permission",
      };
    }
    return { status: "forbidden", error: "HTTP 403 — access denied" };
  }
  if (input.httpStatus === 429) {
    return { status: "throttled", error: "HTTP 429 — rate limited" };
  }
  if (input.httpStatus >= 500) {
    return {
      status: "server_error",
      error: `HTTP ${input.httpStatus} from Manager Tools`,
    };
  }
  if (input.httpStatus < 200 || input.httpStatus >= 300) {
    return {
      status: "forbidden",
      error: `unexpected HTTP ${input.httpStatus}`,
    };
  }
  // The reports endpoint returns a valid JSON array with `content-type: text/html`, so parse
  // first and only fall back to the login-HTML diagnosis when the body is not JSON.
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    if (
      !input.contentType.toLowerCase().includes("json") ||
      input.body.trimStart().startsWith("<")
    ) {
      return {
        status: "session_expired",
        error: `HTTP 200 with a non-JSON body (${input.contentType || "no content-type"}) — login HTML`,
      };
    }
    return { status: "invalid_json", error: "HTTP 200 with invalid JSON" };
  }
  if (typeof parsed === "object" && parsed !== null && "e" in parsed) {
    const code = (parsed as Record<string, unknown>)["e"];
    const detail = (parsed as Record<string, unknown>)["d"];
    const message =
      typeof detail === "string"
        ? detail
        : `API error envelope e=${String(code)}`;
    if (/not permitted|not authorized|forbidden/i.test(message)) {
      return { status: "not_permitted", error: message };
    }
    if (String(code) === "1" || String(code) === "401") {
      return { status: "session_expired", error: message };
    }
    return { status: "shape_error", error: message };
  }
  if (input.kind === "periods") {
    if (
      !Array.isArray(parsed) ||
      parsed.some((value) => typeof value !== "string")
    ) {
      return {
        status: "shape_error",
        error: "periods response is not an array of strings",
      };
    }
    return { status: "ok", error: null };
  }
  if (input.kind === "live-data") {
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("sports" in parsed) ||
      !("leagues" in parsed)
    ) {
      return {
        status: "shape_error",
        error: "catalog JSON lacks sports/leagues maps",
      };
    }
    return { status: "ok", error: null };
  }
  if (!Array.isArray(parsed)) {
    return {
      status: "shape_error",
      error: "report response is not a JSON array",
    };
  }
  return { status: "ok", error: null };
}

function countFor(kind: GsliveManagerEndpointKind, parsed: unknown): number {
  if (Array.isArray(parsed)) return parsed.length;
  if (typeof parsed === "object" && parsed !== null) {
    return Object.keys(parsed).length;
  }
  return 0;
}

const INSPECT_CUSTOM = (Bun.inspect as unknown as { custom: symbol }).custom;
const INSPECT_TABLE = (
  Bun.inspect as unknown as {
    table: (
      data: readonly Record<string, unknown>[],
      properties: readonly string[],
      options: { colors?: boolean },
    ) => string;
  }
).table;

/**
 * Attach a single-line custom inspector so `Bun.inspect(probe)` is readable while
 * `JSON.stringify(probe)` stays the exact wire shape (the symbol is non-enumerable).
 */
function withCustomInspect(probe: GsliveManagerProbe): GsliveManagerProbe {
  Object.defineProperty(probe, INSPECT_CUSTOM, {
    enumerable: false,
    value: () => {
      const http = probe.httpStatus === null ? "—" : String(probe.httpStatus);
      const count = probe.count === null ? "" : ` count=${probe.count}`;
      const error = probe.error === null ? "" : ` — ${probe.error}`;
      return `${probe.kind}: ${probe.status} (HTTP ${http})${count}${error}`;
    },
  });
  return probe;
}

/** Bun.inspect.table rendering of a probe list; callers own the surrounding prose. */
export function formatManagerProbeTable(
  probes: readonly GsliveManagerProbe[],
  colors = Bun.enableANSIColors,
): string {
  const rows = probes.map((probe) => ({
    kind: probe.kind,
    status: probe.status,
    http: probe.httpStatus,
    latencyMs: probe.latencyMs,
    count: probe.count,
    class: isBlockingManagerStatus(probe.status)
      ? "blocking"
      : probe.status === "ok"
        ? "ok"
        : "permission",
    detail: probe.error,
  }));
  return INSPECT_TABLE(
    rows,
    ["kind", "status", "http", "latencyMs", "count", "class", "detail"],
    { colors },
  );
}

/** Fetch one endpoint and return its structured status; never throws on HTTP failure. */
export async function probeManagerEndpoint(
  kind: GsliveManagerEndpointKind,
  options: GsliveManagerProbeOptions,
): Promise<GsliveManagerProbe> {
  const now = options.now ?? Date.now;
  const checkedAt = new Date(now()).toISOString();
  const window = options.window ?? defaultManagerWindow(now());
  const url =
    kind === "live-data"
      ? GSLIVE_LIVE_DATA_URL
      : kind === "periods"
        ? GSLIVE_REPORT_PERIODS_URL
        : managerReportUrl(
            kind,
            window,
            options.partnerId ?? DEFAULT_MANAGER_PARTNER_ID,
          );
  const headers: Record<string, string> = {
    accept: "application/json",
    referer: "https://plive.sportswidgets.pro/manager-tools/",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
  };
  if (options.cookieHeader.trim() !== "") headers.cookie = options.cookieHeader;
  if ((options.xGsSession ?? "").trim() !== "") {
    headers["x-gs-session"] = options.xGsSession as string;
  }
  const started = now();
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    const latencyMs = Math.max(0, now() - started);
    const body = await response.text().catch(() => "");
    const classified = classifyManagerEndpointResponse({
      httpStatus: response.status,
      contentType: response.headers.get("content-type") ?? "",
      cfMitigated: response.headers.get("cf-mitigated"),
      body,
      kind,
    });
    let count: number | null = null;
    if (classified.status === "ok") {
      try {
        count = countFor(kind, JSON.parse(body));
      } catch {
        count = 0;
      }
    }
    return withCustomInspect({
      kind,
      status: classified.status,
      httpStatus: response.status,
      latencyMs,
      checkedAt,
      count,
      error: classified.error,
    });
  } catch (error) {
    return withCustomInspect({
      kind,
      status: "unreachable",
      httpStatus: null,
      latencyMs: Math.max(0, now() - started),
      checkedAt,
      count: null,
      error:
        error instanceof Error && error.name === "TimeoutError"
          ? "timed out"
          : "no response (network/DNS/TLS)",
    });
  }
}

/** Probe every endpoint the desk uses; order is stable for display/tests. */
export async function probeManagerEndpoints(
  options: GsliveManagerProbeOptions,
): Promise<readonly GsliveManagerProbe[]> {
  return await Promise.all(
    MANAGER_ENDPOINT_KINDS.map((kind) => probeManagerEndpoint(kind, options)),
  );
}

/** Parse the periods vocabulary; null when it is not an array of strings. */
export function parsePeriodVocabulary(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.some((value) => typeof value !== "string")) return null;
  return raw as readonly string[];
}

/** Fetch the report period vocabulary (cookie + optional x-gs-session). */
export async function fetchReportPeriods(options: {
  readonly cookieHeader: string;
  readonly xGsSession?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<readonly string[] | null> {
  const headers: Record<string, string> = {
    accept: "application/json",
    referer: "https://plive.sportswidgets.pro/manager-tools/",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
  };
  if (options.cookieHeader.trim() !== "") headers.cookie = options.cookieHeader;
  if ((options.xGsSession ?? "").trim() !== "") {
    headers["x-gs-session"] = options.xGsSession as string;
  }
  const response = await (options.fetchImpl ?? fetch)(
    GSLIVE_REPORT_PERIODS_URL,
    {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    },
  );
  if (!response.ok) return null;
  const body = await response.text();
  try {
    return parsePeriodVocabulary(JSON.parse(body));
  } catch {
    return null;
  }
}

export interface GsliveLiveDataSummary {
  readonly sports: number;
  readonly leagues: number;
  readonly countries: number;
}

/** Parse the public `live/data` catalog once at the boundary; null when the shape is wrong. */
export function parseLiveDataCatalog(
  raw: unknown,
): GsliveLiveDataSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const sports = record["sports"];
  const leagues = record["leagues"];
  const countries = record["countries"];
  if (
    typeof sports !== "object" ||
    sports === null ||
    typeof leagues !== "object" ||
    leagues === null ||
    typeof countries !== "object" ||
    countries === null
  ) {
    return null;
  }
  return {
    sports: Object.keys(sports).length,
    leagues: Object.keys(leagues).length,
    countries: Object.keys(countries).length,
  };
}

/** True when an endpoint failed for an infrastructure/auth reason rather than a permission gap. */
export function isBlockingManagerStatus(
  status: GsliveManagerEndpointStatus,
): boolean {
  return (
    status === "session_expired" ||
    status === "challenge" ||
    status === "unreachable" ||
    status === "throttled" ||
    status === "server_error" ||
    status === "invalid_json" ||
    status === "shape_error"
  );
}
