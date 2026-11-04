/**
 * @file lib/f402_session.ts
 * @description F402 manager session cache for read-only ingestion.
 *
 * The cookie never leaves the process except into a 0600 cache file; logs may mention cookie
 * names, never values. The login step reuses the evidence-capture WebView flow, and only runs
 * when F402_LIVE_LOGIN=1 (plus credentials) is set.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface F402Session {
  /** Raw Cookie header value. Never log this field. */
  readonly cookieHeader: string;
  /** Cookie names only, safe to log. */
  readonly cookieNames: readonly string[];
  /** Portal-issued bearer token, when the login exposes one. Never log. */
  readonly authorizationHeader?: string;
  readonly obtainedAtIso: string;
  readonly expiresAtIso: string;
}

export interface F402SessionFileOptions {
  readonly path?: string;
  readonly ttlMinutes?: number;
  readonly now?: number;
}

const DEFAULT_TTL_MINUTES = 30;

export function resolveF402SessionPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env["F402_SESSION_FILE"]?.trim();
  if (explicit) return explicit;
  return join(homedir(), ".cache", "sportsdesk", "f402-session.json");
}

/** Session TTL from `F402_SESSION_TTL_MIN` (minutes), falling back to the 30-minute default. */
export function f402SessionTtlMinutesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env["F402_SESSION_TTL_MIN"] ?? DEFAULT_TTL_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MINUTES;
}

function isExpired(session: F402Session, now: number): boolean {
  const expiresAt = Date.parse(session.expiresAtIso);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function modeIsPrivate(path: string): boolean {
  if (process.platform === "win32") return true;
  try {
    return (statSync(path).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

const AUTHORIZATION_HEADER = /^Bearer\s+\S+$/;

/**
 * Validates one parsed session object. JSON has no typed schema, so this is the boundary: any
 * shape a fresh login could not produce is rejected instead of being repaired into a half-session.
 */
function parseF402SessionValue(
  value: unknown,
  now: number,
): F402Session | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  const cookieHeader = record["cookieHeader"];
  if (typeof cookieHeader !== "string") return null;
  if (cookieHeader.trim() === "") return null;
  if (!cookieHeader.includes("=")) return null;
  // A cookie header is one header line; CR/LF here would be header injection.
  if (/[\r\n\0]/.test(cookieHeader)) return null;

  const authorizationHeader = record["authorizationHeader"];
  let authorization: string | undefined;
  if (authorizationHeader !== undefined) {
    if (typeof authorizationHeader !== "string") return null;
    // Same one-header-line rule as the cookie header, before the shape check.
    if (/[\r\n\0]/.test(authorizationHeader)) return null;
    if (!AUTHORIZATION_HEADER.test(authorizationHeader)) return null;
    authorization = authorizationHeader;
  }

  const session: F402Session = {
    cookieHeader,
    cookieNames: Array.isArray(record["cookieNames"])
      ? record["cookieNames"].filter(
          (name): name is string => typeof name === "string",
        )
      : [],
    ...(authorization === undefined
      ? {}
      : { authorizationHeader: authorization }),
    obtainedAtIso:
      typeof record["obtainedAtIso"] === "string"
        ? record["obtainedAtIso"]
        : "",
    expiresAtIso:
      typeof record["expiresAtIso"] === "string" ? record["expiresAtIso"] : "",
  };
  return isExpired(session, now) ? null : session;
}

/** Reads a cached session; returns null when missing, expired, malformed, or group/world-readable. */
export function readF402Session(
  options?: F402SessionFileOptions,
): F402Session | null {
  const path = options?.path ?? resolveF402SessionPath();
  if (!existsSync(path) || !modeIsPrivate(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return parseF402SessionValue(parsed, options?.now ?? Date.now());
}

/**
 * Writes the session with directory 0700 and file 0600, atomically: a same-directory `.tmp` is
 * written at 0600 and renamed over the target, so a reader never observes a partial JSON file.
 */
export function writeF402Session(
  session: F402Session,
  options?: F402SessionFileOptions,
): string {
  const path = options?.path ?? resolveF402SessionPath();
  const directory = dirname(path);
  const directoryExisted = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!directoryExisted) chmodSync(directory, 0o700);
  const temp = `${path}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(session, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean up; surface the original failure below.
    }
    throw error;
  }
  return path;
}

/** Builds a session from an in-memory auth result; the raw cookie is not logged. */
export function sessionFromAuth(
  auth: {
    readonly cookieHeader: string;
    readonly cookieNames: readonly string[];
    readonly authorizationHeader?: string;
  },
  options?: { readonly ttlMinutes?: number; readonly now?: number },
): F402Session {
  const now = options?.now ?? Date.now();
  const ttl = (options?.ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60_000;
  return {
    cookieHeader: auth.cookieHeader,
    cookieNames: auth.cookieNames,
    ...(auth.authorizationHeader === undefined
      ? {}
      : { authorizationHeader: auth.authorizationHeader }),
    obtainedAtIso: new Date(now).toISOString(),
    expiresAtIso: new Date(now + ttl).toISOString(),
  };
}

export interface RefreshF402SessionOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Login timeout for the WebView flow; unrelated to the session TTL. */
  readonly timeoutMs?: number;
  /** Session TTL in minutes; defaults to `F402_SESSION_TTL_MIN` then 30. */
  readonly ttlMinutes?: number;
}

/**
 * Logs in through the evidence-capture WebView. Requires F402_LIVE_LOGIN=1 and credentials;
 * returns a TTL-bounded session. The caller owns persistence.
 */
export async function refreshF402Session(
  options?: RefreshF402SessionOptions,
): Promise<F402Session> {
  const env = options?.env ?? process.env;
  if (env["F402_LIVE_LOGIN"]?.trim() !== "1") {
    throw new Error(
      "F402 live login disabled (set F402_LIVE_LOGIN=1 to allow one WebView login)",
    );
  }
  const baseUrl = (
    env["F402_BASE_URL"]?.trim() || "https://www.fantasy402.com"
  ).replace(/\/$/, "");
  const { authenticateWithWebView } =
    await import("../scripts/evidence_capture.ts");
  const { resolveLoginConfig } = await import("../scripts/capture/ops.ts");
  const auth = await authenticateWithWebView({
    env,
    baseUrl,
    login: resolveLoginConfig(env, baseUrl),
    timeoutMs: options?.timeoutMs ?? 60_000,
  });
  try {
    return sessionFromAuth(auth, {
      ttlMinutes: options?.ttlMinutes ?? f402SessionTtlMinutesFromEnv(env),
    });
  } finally {
    await auth.close();
  }
}

/** One-line, secret-free description for logs. */
export function describeF402Session(session: F402Session | null): string {
  if (session === null) return "no cached session";
  return `session cookies=[${session.cookieNames.join(",")}] expires=${session.expiresAtIso}`;
}
