/**
 * @file lib/f402_session.ts
 * @description F402 manager session cache for read-only ingestion.
 *
 * The cookie never leaves the process except into the session store; logs may mention cookie
 * names, never values. The login step reuses the evidence-capture WebView flow, and only runs
 * when F402_LIVE_LOGIN=1 (plus credentials) is set.
 *
 * Session store (`F402_SESSION_STORE`):
 * - `file` (default): the 0600 JSON file at `F402_SESSION_FILE` / `~/.cache/sportsdesk/f402-session.json`.
 * - `keychain`: one Bun.secrets entry, service `com.bookdeskops.sportsdesk`, name `f402-session`
 *   (legacy `sportsdesk-ops` is a read-only fallback). No session file is read or written.
 *   Bun.secrets is async only, so a process loads the entry once with `await loadF402Session()`
 *   and the synchronous `readF402Session()` then answers from that in-process copy. A process that
 *   never loads it sees no session in keychain mode (it does not fall back to the file).
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

import {
  F402_READ_SERVICES,
  readF402SecretStrict,
  writeF402Secret,
  deleteF402Secret,
  type SecretsAdapter,
} from "./f402_secret_store.ts";
import { CANONICAL_SECRETS_SERVICE } from "./secrets.ts";
import { decodeF402BearerWindow } from "./f402_jwt.ts";

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
  /** An explicit path always means the file store, whatever `F402_SESSION_STORE` says. */
  readonly path?: string;
  readonly ttlMinutes?: number;
  readonly now?: number;
  /** Overrides `F402_SESSION_STORE` (tests and explicit callers). */
  readonly store?: F402SessionStoreKind;
}

export type F402SessionStoreKind = "file" | "keychain";

/** Bun.secrets entry name for the session in keychain mode. */
export const F402_SESSION_SECRET_NAME = "f402-session";

/** `F402_SESSION_STORE=keychain` opts in; anything else (or unset) keeps the file store. */
export function resolveF402SessionStore(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): F402SessionStoreKind {
  return env["F402_SESSION_STORE"]?.trim().toLowerCase() === "keychain"
    ? "keychain"
    : "file";
}

function storeFor(options?: F402SessionFileOptions): F402SessionStoreKind {
  if (options?.path !== undefined) return "file";
  return options?.store ?? resolveF402SessionStore();
}

/** In-process copy of the keychain session (`undefined` = not loaded in this process yet). */
let keychainSessionCache: { readonly raw: unknown } | undefined;
let pendingKeychainWrites: Promise<void>[] = [];
let warnedUnloaded = false;

/** Reset the in-process keychain cache (tests). */
export function resetF402SessionCacheForTests(): void {
  keychainSessionCache = undefined;
  pendingKeychainWrites = [];
  warnedUnloaded = false;
}

/**
 * Fallback lifetime for sessions with no bearer JWT (cookie-only), and an upper cap on a
 * caller-supplied TTL. A session with a bearer derives `expiresAtIso` from the token's `exp`
 * minus {@link F402_DERIVED_EXPIRY_MARGIN_MS}, so the file never claims a lifetime the server
 * does not grant (measured 2026-11-17: 21 minutes). The 24h fallback is kept for the
 * 2026-11-04 manual-login case; it is not an effective expiry for bearer sessions.
 * Override via `F402_SESSION_TTL_MIN`.
 */
const DEFAULT_TTL_MINUTES = 1440;

/** How far before the bearer's `exp` a derived session expiry sits. */
export const F402_DERIVED_EXPIRY_MARGIN_MS = 2 * 60 * 1000;

export function resolveF402SessionPath(
  env: NodeJS.ProcessEnv = Bun.env,
): string {
  const explicit = env["F402_SESSION_FILE"]?.trim();
  if (explicit) return explicit;
  return join(homedir(), ".cache", "sportsdesk", "f402-session.json");
}

/** Session TTL from `F402_SESSION_TTL_MIN` (minutes), falling back to the 24h default. */
export function f402SessionTtlMinutesFromEnv(
  env: NodeJS.ProcessEnv = Bun.env,
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

/**
 * Reads the current session; returns null when missing, expired, malformed, or (file store)
 * group/world-readable. In keychain mode this answers from the copy `loadF402Session()` loaded.
 */
export function readF402Session(
  options?: F402SessionFileOptions,
): F402Session | null {
  if (storeFor(options) === "keychain") {
    if (keychainSessionCache === undefined) {
      if (!warnedUnloaded) {
        warnedUnloaded = true;
        console.warn(
          "[f402-session] F402_SESSION_STORE=keychain but this process has not loaded the session; call `await loadF402Session()` first",
        );
      }
      return null;
    }
    return parseF402SessionValue(
      keychainSessionCache.raw,
      options?.now ?? Date.now(),
    );
  }
  return readF402SessionFile(options);
}

function readF402SessionFile(
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
 * Persists the session. File store: directory 0700 and file 0600, written atomically (a
 * same-directory `.tmp` at 0600 renamed over the target). Keychain store: updates the in-process
 * copy at once and queues the Bun.secrets write; `await flushF402SessionWrites()` (or use
 * {@link saveF402Session}) to know it landed. Returns where it went, never the value.
 */
export function writeF402Session(
  session: F402Session,
  options?: F402SessionFileOptions,
): string {
  if (storeFor(options) === "keychain") {
    keychainSessionCache = { raw: JSON.parse(JSON.stringify(session)) };
    const write = writeF402Secret(
      F402_SESSION_SECRET_NAME,
      JSON.stringify(session),
      { redact: sessionSecrets(session) },
    ).catch((error: unknown) => {
      const named = error as { name?: string; message?: string };
      console.error(
        `[f402-session] ${named.name ?? "Error"}: ${named.message ?? "keychain write failed"}`,
      );
      throw error;
    });
    // Keep the rejection observable through flush without an unhandled-rejection crash here.
    write.catch(() => {});
    pendingKeychainWrites.push(write);
    return keychainSessionLocation();
  }
  return writeF402SessionFile(session, options);
}

/** Cookie values and the bearer token, scrubbed from any store error text. */
function sessionSecrets(session: F402Session): string[] {
  const values = session.cookieHeader
    .split(";")
    .map((pair) => pair.slice(pair.indexOf("=") + 1).trim())
    .filter((value) => value.length >= 4);
  values.push(session.cookieHeader);
  if (session.authorizationHeader !== undefined) {
    values.push(session.authorizationHeader);
  }
  return values;
}

function keychainSessionLocation(): string {
  return `keychain:${CANONICAL_SECRETS_SERVICE}/${F402_SESSION_SECRET_NAME}`;
}

/** Wait for queued keychain session writes; rethrows the first named error. */
export async function flushF402SessionWrites(): Promise<void> {
  const writes = pendingKeychainWrites;
  pendingKeychainWrites = [];
  const results = await Promise.allSettled(writes);
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed !== undefined) throw failed.reason;
}

/**
 * Async load. File store: same as {@link readF402Session}. Keychain store: reads Bun.secrets
 * (canonical, then the legacy read-only fallback), keeps an in-process copy for sync readers.
 * Throws F402KeychainUnavailable / F402SecretBackendError when the store itself is unusable.
 */
export async function loadF402Session(
  options?: F402SessionFileOptions & { readonly adapter?: SecretsAdapter },
): Promise<F402Session | null> {
  if (storeFor(options) !== "keychain") return readF402SessionFile(options);
  const found = await readF402SecretStrict(F402_SESSION_SECRET_NAME, {
    ...(options?.adapter === undefined ? {} : { adapter: options.adapter }),
    services: F402_READ_SERVICES,
  });
  let raw: unknown = null;
  if (found !== null) {
    try {
      raw = JSON.parse(found.value);
    } catch {
      raw = null;
    }
  }
  keychainSessionCache = { raw };
  return parseF402SessionValue(raw, options?.now ?? Date.now());
}

/** Async save that resolves only once the session is stored. Returns the location label. */
export async function saveF402Session(
  session: F402Session,
  options?: F402SessionFileOptions & { readonly adapter?: SecretsAdapter },
): Promise<string> {
  if (storeFor(options) !== "keychain") {
    return writeF402SessionFile(session, options);
  }
  await writeF402Secret(F402_SESSION_SECRET_NAME, JSON.stringify(session), {
    ...(options?.adapter === undefined ? {} : { adapter: options.adapter }),
    redact: sessionSecrets(session),
  });
  keychainSessionCache = { raw: JSON.parse(JSON.stringify(session)) };
  return keychainSessionLocation();
}

/** Remove the keychain session entry (canonical only; legacy is never written). */
export async function clearF402KeychainSession(
  options: { readonly adapter?: SecretsAdapter } = {},
): Promise<boolean> {
  keychainSessionCache = { raw: null };
  return deleteF402Secret(
    CANONICAL_SECRETS_SERVICE,
    F402_SESSION_SECRET_NAME,
    options,
  );
}

function writeF402SessionFile(
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
  const ttlExpiresAtMs =
    now + (options?.ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60_000;
  const tokenWindow = decodeF402BearerWindow(auth.authorizationHeader);
  const expiresAtMs =
    tokenWindow === null
      ? ttlExpiresAtMs
      : Math.min(
          ttlExpiresAtMs,
          tokenWindow.expMs - F402_DERIVED_EXPIRY_MARGIN_MS,
        );
  return {
    cookieHeader: auth.cookieHeader,
    cookieNames: auth.cookieNames,
    ...(auth.authorizationHeader === undefined
      ? {}
      : { authorizationHeader: auth.authorizationHeader }),
    obtainedAtIso: new Date(now).toISOString(),
    expiresAtIso: new Date(expiresAtMs).toISOString(),
  };
}

export interface RefreshF402SessionOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Login timeout for the WebView flow; unrelated to the session TTL. */
  readonly timeoutMs?: number;
  /** Session TTL in minutes; defaults to `F402_SESSION_TTL_MIN` then 1440 (24h; see `DEFAULT_TTL_MINUTES` above). */
  readonly ttlMinutes?: number;
}

/**
 * Logs in through the evidence-capture WebView. Requires F402_LIVE_LOGIN=1 and credentials;
 * returns a TTL-bounded session. The caller owns persistence.
 */
export async function refreshF402Session(
  options?: RefreshF402SessionOptions,
): Promise<F402Session> {
  const env = options?.env ?? Bun.env;
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

export interface EnsureF402SessionOptions extends RefreshF402SessionOptions {
  /**
   * When true, sets `F402_LIVE_LOGIN=1` for this refresh only (trusted automation callers).
   * Interactive CLIs still require the operator to set the env var explicitly.
   */
  readonly allowLiveLogin?: boolean;
  readonly now?: number;
}

/**
 * Read-through: return when a valid session file exists; otherwise mint once and persist.
 * Used by bridge rollup cron before bridge3a/bridge3b spawn.
 */
export async function ensureF402Session(
  options: EnsureF402SessionOptions = {},
): Promise<void> {
  const env = options.env ?? Bun.env;
  const now = options.now ?? Date.now();
  const existing = await loadF402Session({ now });
  if (existing !== null) return;

  const allow =
    options.allowLiveLogin === true || env["F402_LIVE_LOGIN"]?.trim() === "1";
  if (!allow) {
    throw new Error(
      "F402 session expired or missing and F402_LIVE_LOGIN=1 is not set. " +
        "Cron may pass allowLiveLogin; operators: F402_LIVE_LOGIN=1 bun run session:login --from-keychain",
    );
  }

  const refreshEnv: NodeJS.ProcessEnv = { ...env, F402_LIVE_LOGIN: "1" };
  const session = await refreshF402Session({ ...options, env: refreshEnv });
  await saveF402Session(session, { now });
}

/** One-line, secret-free description for logs. */
export function describeF402Session(session: F402Session | null): string {
  if (session === null) return "no cached session";
  return `session cookies=[${session.cookieNames.join(",")}] expires=${session.expiresAtIso}`;
}
