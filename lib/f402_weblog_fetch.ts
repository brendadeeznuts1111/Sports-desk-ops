/** Direct 4C `Manager/getWebLog` fetch (Modes A/B/C/I), Class A guard, atomic JSONL capture. */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class F402WebLogFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "F402WebLogFetchError";
  }
}

export type WebLogMode = "A" | "B" | "C" | "I";
const MIN_TOKEN_LENGTH = 24;

/** A/B use MM/DD/YYYY; C uses YYYY-MM-DD; I carries no date formatting change. */
export function formatWebLogDate(mode: WebLogMode, date: string): string {
  if (mode === "C") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new F402WebLogFetchError("Mode C date must be YYYY-MM-DD");
    }
    return date;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null)
    throw new F402WebLogFetchError(`${mode} date must be YYYY-MM-DD input`);
  return `${match[2]}/${match[3]}/${match[1]}`;
}

export interface WebLogRequest {
  readonly mode: WebLogMode;
  readonly date: string;
  readonly endDate?: string;
  readonly customerId?: string;
  readonly ip?: string;
  readonly actions?: string;
  readonly agentId?: string;
  readonly agentOwner?: string;
}

export const OBSERVED_WEBLOG_WIRE_ORDER = [
  "agentID",
  "customerID",
  "start",
  "end",
  "type",
  "actions",
  "ip",
  "operation",
  "RRO",
  "agentOwner",
] as const;

export interface ParsedWebLogFormBody {
  readonly agentID: string;
  readonly customerID: string;
  readonly start: string;
  readonly end: string;
  readonly type: WebLogMode;
  readonly actions: string;
  readonly ip: string;
  readonly operation: "getWebLog";
  readonly RRO: string;
  readonly agentOwner: string;
  readonly wireFieldOrder: readonly string[];
  readonly matchesObservedWireOrder: boolean;
  readonly hasDistinctAgentOwner: boolean;
  readonly isDateRange: boolean;
  readonly modeCIpMatchesCustomer: boolean | null;
  readonly isActivityStream: boolean;
}

/** Observed Manager HAR & Mode C wire: `application/x-www-form-urlencoded` with `start`/`end`. */
export function buildWebLogFormFields(
  request: WebLogRequest,
): Record<string, string> {
  const agentId = (request.agentId ?? Bun.env.F402_AGENT_ID ?? "").trim();
  const agentOwner = (
    request.agentOwner ??
    Bun.env.F402_AGENT_OWNER ??
    ""
  ).trim();
  const actions = request.actions ?? "ALL";

  let customerID: string;
  let start: string;
  let end: string;
  let ip: string;

  if (request.mode === "I") {
    customerID = "0";
    start = request.date.trim();
    end = (request.endDate ?? request.date).trim();
    ip = request.ip ?? "";
  } else if (request.mode === "C") {
    const startYmd = formatWebLogDate("C", request.date);
    const endYmd = formatWebLogDate("C", request.endDate ?? request.date);
    if (endYmd < startYmd) {
      throw new F402WebLogFetchError(
        `Mode C endDate ${endYmd} cannot precede start ${startYmd}`,
      );
    }
    customerID = request.customerId ?? "";
    start = startYmd;
    end = endYmd;
    ip = request.ip ?? customerID.trim().toLowerCase();
  } else {
    const endInput = request.endDate ?? request.date;
    start = formatWebLogDate(request.mode, request.date);
    end = formatWebLogDate(request.mode, endInput);
    if (endInput < request.date) {
      throw new F402WebLogFetchError(
        `Mode ${request.mode} endDate ${endInput} cannot precede start ${request.date}`,
      );
    }
    customerID = request.customerId ?? (request.mode === "B" ? "0" : "");
    ip = request.ip ?? "";
  }

  return {
    agentID: agentId,
    customerID,
    start,
    end,
    type: request.mode,
    actions,
    ip,
    operation: "getWebLog",
    RRO: "1",
    agentOwner,
  };
}

/**
 * Parse and validate an `application/x-www-form-urlencoded` `Manager/getWebLog` wire body
 * against the observed 10-field wire contract (Modes A/B/C/I).
 */
export function parseWebLogFormBody(rawBody: string): ParsedWebLogFormBody {
  const params = new URLSearchParams(rawBody);
  const operation = params.get("operation");
  if (operation !== "getWebLog") {
    throw new F402WebLogFetchError(
      `Invalid getWebLog form operation: ${JSON.stringify(operation)}`,
    );
  }
  const typeRaw = params.get("type");
  if (
    typeRaw !== "A" &&
    typeRaw !== "B" &&
    typeRaw !== "C" &&
    typeRaw !== "I"
  ) {
    throw new F402WebLogFetchError(
      `Invalid getWebLog mode type: ${JSON.stringify(typeRaw)}`,
    );
  }

  const agentID = params.get("agentID") ?? "";
  const customerID = params.get("customerID") ?? "";
  const start = params.get("start") ?? "";
  const end = params.get("end") ?? "";
  const actions = params.get("actions") ?? "";
  const ip = params.get("ip") ?? "";
  const rro = params.get("RRO") ?? "";
  const agentOwner = params.get("agentOwner") ?? "";

  const wireFieldOrder = [...params.keys()];
  const matchesObservedWireOrder =
    wireFieldOrder.length === OBSERVED_WEBLOG_WIRE_ORDER.length &&
    wireFieldOrder.every((key, idx) => key === OBSERVED_WEBLOG_WIRE_ORDER[idx]);

  return {
    agentID,
    customerID,
    start,
    end,
    type: typeRaw,
    actions,
    ip,
    operation: "getWebLog",
    RRO: rro,
    agentOwner,
    wireFieldOrder,
    matchesObservedWireOrder,
    hasDistinctAgentOwner: agentOwner !== "" && agentOwner !== agentID,
    isDateRange: start !== "" && end !== "" && start !== end,
    modeCIpMatchesCustomer:
      typeRaw === "C"
        ? ip.trim().toLowerCase() === customerID.trim().toLowerCase() &&
          customerID.trim() !== ""
        : null,
    isActivityStream: typeRaw === "A",
  };
}

export function buildWebLogFormBody(request: WebLogRequest): string {
  return new URLSearchParams(buildWebLogFormFields(request)).toString();
}

/** @deprecated Name kept for CLI tests; values match the live form fields. */
export function buildWebLogBody(
  request: WebLogRequest,
): Record<string, string> {
  return buildWebLogFormFields(request);
}

export interface WebLogFetchResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly body: Readonly<Record<string, string>>;
  readonly url: string;
}

type BunManagerFetchInit = RequestInit & {
  readonly verbose?: boolean | "curl";
};

function f402FetchVerbose(): boolean | "curl" | undefined {
  const raw = (Bun.env.F402_FETCH_VERBOSE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "0" || raw === "false") return undefined;
  if (raw === "curl") return "curl";
  return true;
}

function describeJsonShape(payload: unknown): string {
  if (Array.isArray(payload)) return `array[length=${payload.length}]`;
  if (payload !== null && typeof payload === "object") {
    const keys = Object.keys(payload);
    const head = keys.slice(0, 8).join(",");
    return `object{${head}${keys.length > 8 ? ",…" : ""}}`;
  }
  return typeof payload;
}

function bodyPreview(text: string, max = 80): string {
  return text.slice(0, max).replace(/\s+/g, " ").trim();
}

function logWebLogResponseDebug(contentType: string, text: string): void {
  if (f402FetchVerbose() === undefined) return;
  console.error("weblog: content-type:", contentType || "(none)");
  console.error("weblog: raw response body (first 500 chars):");
  console.error(text.slice(0, 500));
}

/** Human-readable cause when {@link parseWebLogListPayload} returns null. */
export function explainWebLogListParseFailure(payload: unknown): string {
  if (Array.isArray(payload))
    return "internal error: top-level array should have parsed";
  if (payload === null || typeof payload !== "object")
    return `top-level ${describeJsonShape(payload)}`;
  const record = payload as Record<string, unknown>;
  if (!("LIST" in record)) {
    const keys = Object.keys(record);
    return `missing LIST; keys: ${keys.length > 0 ? keys.join(",") : "(none)"}`;
  }
  const list = record.LIST;
  if (typeof list === "string") {
    const trimmed = list.trim();
    if (trimmed === "") return "internal error: empty LIST should yield []";
    return `LIST string is not a JSON array (prefix: ${bodyPreview(trimmed, 120)})`;
  }
  if (list !== undefined && !Array.isArray(list))
    return `LIST has unexpected type ${typeof list}`;
  return describeJsonShape(payload);
}

/** Portal envelope: top-level array, `{ LIST: Row[] }`, or `{ LIST: "<json array>" | "" }`. */
export function parseWebLogListPayload(
  payload: unknown,
): Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload === null || typeof payload !== "object") return null;
  const list = (payload as { LIST?: unknown; INFO?: unknown }).LIST;
  if (list === undefined) return null;
  if (Array.isArray(list)) return list as Record<string, unknown>[];
  if (typeof list === "string") {
    const trimmed = list.trim();
    if (trimmed === "") return [];
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>[];
    } catch {
      return null;
    }
  }
  return null;
}

export async function fetchWebLog(options: {
  readonly token: string;
  readonly request: WebLogRequest;
  readonly baseUrl?: string;
  readonly cookieHeader?: string;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<WebLogFetchResult> {
  if (options.token === "0" || options.token.length < MIN_TOKEN_LENGTH) {
    throw new F402WebLogFetchError("invalid F402 bearer token");
  }
  const base = (
    options.baseUrl ??
    Bun.env.F402_BASE_URL ??
    "https://fantasy402.com"
  ).replace(/\/+$/, "");
  const url = `${base}/cloud/api/Manager/getWebLog`;
  const body = buildWebLogFormFields(options.request);
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token}`,
    accept: "application/json, text/plain, */*",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    "x-requested-with": "XMLHttpRequest",
  };
  const cookieHeader = options.cookieHeader?.trim();
  if (cookieHeader !== undefined && cookieHeader !== "") {
    headers.cookie = cookieHeader;
  }
  const verbose = f402FetchVerbose();
  const init: BunManagerFetchInit = {
    method: "POST",
    headers,
    body: buildWebLogFormBody(options.request),
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
    ...(verbose !== undefined ? { verbose } : {}),
  };
  const response = await (options.fetchImpl ?? fetch)(url, init);
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  logWebLogResponseDebug(contentType, text);
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "(no Location header)";
    throw new F402WebLogFetchError(
      `getWebLog redirect HTTP ${response.status} → ${location} (session/cookie rejected; set F402_FETCH_VERBOSE=1 to trace)`,
    );
  }
  if (response.status !== 200)
    throw new F402WebLogFetchError(
      `getWebLog returned HTTP ${response.status} (content-type: ${contentType || "unknown"}; body: ${bodyPreview(text)})`,
    );
  if (
    contentType.includes("text/html") ||
    /^\s*(<!doctype|<html|<)/i.test(text)
  ) {
    throw new F402WebLogFetchError("getWebLog returned an HTML/XML login trap");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new F402WebLogFetchError(
      `getWebLog returned non-JSON (content-type: ${contentType || "unknown"}; first 200 chars: ${bodyPreview(text, 200)})`,
    );
  }
  if (
    !Array.isArray(payload) &&
    !(
      payload !== null &&
      typeof payload === "object" &&
      "LIST" in (payload as object)
    )
  ) {
    const keys =
      payload !== null && typeof payload === "object"
        ? Object.keys(payload as object).join(",")
        : describeJsonShape(payload);
    console.error("weblog: unexpected JSON shape:", keys || "(none)");
    throw new F402WebLogFetchError(
      `getWebLog response is neither an array nor { LIST: … } (missing LIST; keys: ${keys || "(none)"}; content-type: ${contentType || "unknown"})`,
    );
  }
  const rows = parseWebLogListPayload(payload);
  if (rows === null) {
    throw new F402WebLogFetchError(
      `getWebLog response is neither an array nor { LIST: [...] } (${explainWebLogListParseFailure(payload)}; content-type: ${contentType || "unknown"})`,
    );
  }
  if (
    !rows.every(
      (row) => row !== null && typeof row === "object" && !Array.isArray(row),
    )
  ) {
    throw new F402WebLogFetchError("getWebLog LIST contains non-object rows");
  }
  return { rows: rows as Record<string, unknown>[], body, url };
}

/** Atomic 0600 JSONL persistence: invalid input never touches an existing capture. */
export function persistWebLogCapture(
  path: string,
  rows: readonly Record<string, unknown>[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(
    temp,
    rows.map((row) => JSON.stringify(row)).join("\n") +
      (rows.length > 0 ? "\n" : ""),
    { mode: 0o600 },
  );
  renameSync(temp, path);
}

export async function fetchAndPersistWebLog(options: {
  readonly token: string;
  readonly request: WebLogRequest;
  readonly capturePath: string;
  readonly baseUrl?: string;
  readonly cookieHeader?: string;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<WebLogFetchResult> {
  const result = await fetchWebLog(options);
  persistWebLogCapture(options.capturePath, result.rows);
  return result;
}

export {
  resolveF402BearerToken,
  resolveF402BearerTokenDetailed,
  type F402BearerSource,
  type ResolvedF402Bearer,
} from "./f402_pending_fetch.ts";
