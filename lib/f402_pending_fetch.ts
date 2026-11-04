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
  let token = (options.cliToken ?? "").trim();
  if (token === "") token = (env.F402_BEARER_TOKEN ?? "").trim();
  if (token === "") {
    const explicit = (env.F402_TOKEN_FILE ?? "").trim();
    const configHome =
      (env.XDG_CONFIG_HOME ?? "").trim() ||
      `${(env.HOME ?? "").trim()}/.config`;
    const path =
      explicit !== "" ? explicit : `${configHome}/sportsdesk/f402-token`;
    try {
      token = readFile(path).trim();
    } catch {
      token = "";
    }
  }
  token = token.replace(/^Bearer\s+/i, "").trim();
  if (token === "" || token === "0" || token.length < MIN_TOKEN_LENGTH) {
    throw new F402PendingFetchError(
      `invalid F402 bearer token: provide --bearer-token, F402_BEARER_TOKEN, or F402_TOKEN_FILE (min ${MIN_TOKEN_LENGTH} chars)`,
    );
  }
  return token;
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
