/** Direct 4C `Manager/getWebLog` fetch (Modes A/B/C/I), Class A guard, atomic JSONL capture. */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveF402BearerToken } from "./f402_pending_fetch.ts";

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
  readonly customerId?: string;
  readonly ip?: string;
  readonly agentId?: string;
  readonly agentOwner?: string;
}

export function buildWebLogBody(
  request: WebLogRequest,
): Record<string, string | number> {
  const agentId = request.agentId ?? Bun.env.F402_AGENT_ID ?? "";
  const agentOwner = request.agentOwner ?? Bun.env.F402_AGENT_OWNER ?? "";
  if (request.mode === "I") {
    return {
      type: "I",
      customerID: "0",
      ip: request.ip ?? "",
      operation: "getWebLog",
      date: request.date,
      RRO: 1,
      agentID: agentId,
      agentOwner,
    };
  }
  if (request.mode === "A") {
    return {
      type: "A",
      customerID: request.customerId ?? "",
      operation: "getWebLog",
      date: formatWebLogDate("A", request.date),
      RRO: 1,
      agentID: agentId,
      agentOwner,
    };
  }
  if (request.mode === "B") {
    return {
      type: "B",
      customerID: request.customerId ?? "0",
      operation: "getWebLog",
      date: formatWebLogDate("B", request.date),
      RRO: 1,
      agentID: agentId,
      agentOwner,
    };
  }
  return {
    type: "C",
    customerID: request.customerId ?? "",
    operation: "getWebLog",
    date: formatWebLogDate("C", request.date),
    RRO: 1,
    agentID: agentId,
    agentOwner,
  };
}

export interface WebLogFetchResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly body: Readonly<Record<string, string | number>>;
  readonly url: string;
}

export async function fetchWebLog(options: {
  readonly token: string;
  readonly request: WebLogRequest;
  readonly baseUrl?: string;
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
  const body = buildWebLogBody(options.request);
  const response = await (options.fetchImpl ?? fetch)(url, {
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
  if (response.status !== 200)
    throw new F402WebLogFetchError(
      `getWebLog returned HTTP ${response.status}`,
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
    throw new F402WebLogFetchError("getWebLog returned non-JSON");
  }
  const rows = Array.isArray(payload)
    ? payload
    : payload !== null &&
        typeof payload === "object" &&
        Array.isArray((payload as { LIST?: unknown }).LIST)
      ? (payload as { LIST: unknown[] }).LIST
      : null;
  if (rows === null)
    throw new F402WebLogFetchError(
      "getWebLog response is neither an array nor { LIST: [...] }",
    );
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
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<WebLogFetchResult> {
  const result = await fetchWebLog(options);
  persistWebLogCapture(options.capturePath, result.rows);
  return result;
}

export { resolveF402BearerToken };
