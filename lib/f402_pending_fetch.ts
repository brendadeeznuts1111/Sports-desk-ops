/** Direct 4C `Manager/getPending` fetch, validation and capture persistence. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  primeF402Session,
  readF402Session,
  type F402Session,
} from "./f402_session.ts";
import {
  F402_KEYCHAIN_NAMES,
  readSecretCanonicalThenLegacy,
} from "./secrets.ts";

/** Desk-server path: the keychain holds the agent id when the cron env does not. */
const defaultResolveAgentId = (): Promise<string | null> =>
  readSecretCanonicalThenLegacy(F402_KEYCHAIN_NAMES.agentId);

export class F402PendingFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "F402PendingFetchError";
  }
}

const MIN_TOKEN_LENGTH = 24;

/** Built once: `new Intl.DateTimeFormat` costs ~20 us (measured 2026-11-04). */
const CHICAGO_YMD_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

const INVALID_TOKEN_MESSAGE = `invalid F402 bearer token: provide --bearer-token, F402_BEARER_TOKEN, F402_TOKEN_FILE, or run session:login (min ${MIN_TOKEN_LENGTH} chars, raw value only)`;

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

export type F402BearerSource = "cli" | "env" | "file" | "session";

export interface ResolvedF402Bearer {
  readonly token: string;
  readonly source: F402BearerSource;
}

export interface ResolveF402BearerOptions {
  readonly cliToken?: string | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly readFile?: (path: string) => string;
  readonly readSession?: () => F402Session | null;
}

function defaultF402TokenFilePath(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const explicit = (env.F402_TOKEN_FILE ?? "").trim();
  const configHome =
    (env.XDG_CONFIG_HOME ?? "").trim() || `${(env.HOME ?? "").trim()}/.config`;
  return explicit !== "" ? explicit : `${configHome}/sportsdesk/f402-token`;
}

/**
 * Resolve bearer + provenance: CLI, env, token file, then `session:login` authorizationHeader.
 * Synchronous: with F402_SESSION_STORE=keychain the session comes from the in-process copy, so an
 * async caller should use {@link resolveF402BearerTokenDetailedAsync}, which loads it first.
 */
export function resolveF402BearerTokenDetailed(
  options: ResolveF402BearerOptions = {},
): ResolvedF402Bearer {
  const env =
    options.environment ?? (Bun.env as Record<string, string | undefined>);
  const readFile =
    options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const readSession = options.readSession ?? (() => readF402Session());

  const cliRaw = (options.cliToken ?? "").trim();
  if (cliRaw !== "") {
    const token = validateF402Token(cliRaw);
    if (token === null) throw new F402PendingFetchError(INVALID_TOKEN_MESSAGE);
    return { token, source: "cli" };
  }
  const envRaw = (env.F402_BEARER_TOKEN ?? "").trim();
  if (envRaw !== "") {
    const token = validateF402Token(envRaw);
    if (token === null) throw new F402PendingFetchError(INVALID_TOKEN_MESSAGE);
    return { token, source: "env" };
  }

  const fromFile = readF402TokenFile(defaultF402TokenFilePath(env), readFile);
  if (fromFile !== null) return { token: fromFile, source: "file" };

  const session = readSession();
  const authHeader = session?.authorizationHeader ?? "";
  if (authHeader !== "") {
    const token = validateF402Token(authHeader);
    if (token !== null) {
      return { token, source: "session" };
    }
  }

  throw new F402PendingFetchError(INVALID_TOKEN_MESSAGE);
}

/**
 * Async form of {@link resolveF402BearerTokenDetailed} for the session store. CLI, env and token
 * file are tried first with no session read; only when none resolves (and no `readSession` was
 * injected) is the session loaded, which with F402_SESSION_STORE=keychain is an async Bun.secrets
 * read whose named store error is thrown. File store: same result as the sync form.
 */
export async function resolveF402BearerTokenDetailedAsync(
  options: ResolveF402BearerOptions = {},
): Promise<ResolvedF402Bearer> {
  if (options.readSession !== undefined) {
    return resolveF402BearerTokenDetailed(options);
  }
  try {
    return resolveF402BearerTokenDetailed({
      ...options,
      readSession: () => null,
    });
  } catch (error) {
    if (!(error instanceof F402PendingFetchError)) throw error;
  }
  await primeF402Session();
  return resolveF402BearerTokenDetailed(options);
}

/**
 * Async {@link f402BearerResolvable}: `false` only when no bearer source exists; a session-store
 * failure is thrown by name instead of being read as "no bearer".
 */
export async function f402BearerResolvableAsync(
  options: ResolveF402BearerOptions = {},
): Promise<boolean> {
  try {
    await resolveF402BearerTokenDetailedAsync(options);
    return true;
  } catch (error) {
    if (error instanceof F402PendingFetchError) return false;
    throw error;
  }
}

/** Resolve the bearer token read-only; fail before network I/O. */
export function resolveF402BearerToken(
  options: ResolveF402BearerOptions = {},
): string {
  return resolveF402BearerTokenDetailed(options).token;
}

/** True when {@link resolveF402BearerTokenDetailed} would succeed (no network). */
export function f402BearerResolvable(
  options: ResolveF402BearerOptions = {},
): boolean {
  try {
    resolveF402BearerTokenDetailed(options);
    return true;
  } catch {
    return false;
  }
}

function probeBearerSource(source: F402BearerSource): string {
  switch (source) {
    case "env":
      return "env:F402_BEARER_TOKEN";
    case "file":
      return "token-file";
    case "session":
      return "session:bearer";
    default:
      return source;
  }
}

/** Like {@link resolveF402BearerTokenDetailed} but maps to cron probe `source` labels. */
export function resolveF402BearerForCredentialProbe(
  options: ResolveF402BearerOptions = {},
): ResolvedF402Bearer & { readonly probeSource: string } {
  const resolved = resolveF402BearerTokenDetailed(options);
  return { ...resolved, probeSource: probeBearerSource(resolved.source) };
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
  const parts = CHICAGO_YMD_FORMAT.formatToParts(
    new Date(now.getTime() - 6 * 86_400_000),
  );
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface PendingFetchOptions {
  readonly token: string;
  readonly date: string;
  readonly agentId?: string;
  readonly agentOwner?: string;
  /** Test/daemon seam: keychain agent-id read when both option and env are empty. */
  readonly resolveAgentId?: () => Promise<string | null>;
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
  const explicitAgentId = (options.agentId ?? "").trim();
  const envAgentId = (Bun.env.F402_AGENT_ID ?? "").trim();
  const agentId =
    explicitAgentId !== ""
      ? explicitAgentId
      : envAgentId !== ""
        ? envAgentId
        : (
            (await (options.resolveAgentId ?? defaultResolveAgentId)()) ?? ""
          ).trim();
  const explicitOwner = (options.agentOwner ?? "").trim();
  const envOwner = (Bun.env.F402_AGENT_OWNER ?? "").trim();
  const agentOwner =
    explicitOwner !== "" ? explicitOwner : envOwner !== "" ? envOwner : agentId;
  const body: Record<string, string | number> = {
    agentID: agentId,
    path: "/qubic/api/Manager/getPending",
    RRO: 1,
    date: options.date,
    wagerType: "",
    sort: "1",
    typeSort: "2",
    week: 0,
    customerID: "0",
    // The server 500s (empty text/html) when agentOwner is empty; the ticker body sets it to the
    // agent id, and the pending read must match that shape.
    agentOwner,
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
