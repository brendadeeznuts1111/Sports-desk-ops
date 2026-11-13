/**
 * Read-only resolution of the GSLive Manager Tools session.
 *
 * The resolution order is deliberate: a host-exported cookie (`GSID_COOKIE`) wins so a rotated
 * value can be supplied without touching the keychain, then the session file, then the OS
 * keychain (`GSLIVE_SESSION_ID`, with the pre-rename entries as read fallbacks), then the
 * environment. Callers that need a credential get {@link requireManagerSession}; callers that
 * only report health use {@link resolveManagerSession}.
 *
 * Nothing here logs, prints, or writes the cookie value.
 */
import { readFileSync } from "node:fs";
import { env, secrets } from "bun";

import {
  getSecretBounded,
  GSID_LEGACY_NAME,
  GSLIVE_GANCHROW_SESSION_NAME,
  GSLIVE_SESSION_ID_NAME,
  gsliveSessionIdFromEnv,
  setSecretBounded,
} from "./secrets.ts";

/** One `Cookie` header from a session id; `_ga` is appended only when present. */
function cookieHeaderFromValue(gsid: string, ga: string | undefined): string {
  const value = gsid.trim();
  if (value === "") return "";
  const analytics = (ga ?? "").trim();
  return analytics === "" ? `GSID=${value}` : `GSID=${value}; _ga=${analytics}`;
}

/**
 * Build the cookie header from the environment. Returns "" when no session is configured;
 * callers must fail closed instead of sending an anonymous request.
 */
export function cookieHeaderFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return cookieHeaderFromValue(
    gsliveSessionIdFromEnv(environment),
    environment.GA,
  );
}

/** OS-keychain entry (Bun.secrets) the manager session is read from before any env fallback. */
export const GSID_SECRET = {
  service: "com.bookdeskops.sportsdesk",
  name: GSLIVE_SESSION_ID_NAME,
} as const;
/** Pre-rename entry (same service, name `GSID`): read fallback only, never written. */
export const GSID_SECRET_PRE_RENAME = {
  service: "com.bookdeskops.sportsdesk",
  name: GSID_LEGACY_NAME,
} as const;
/** Legacy keychain entry kept as a read fallback during migration. */
export const GSID_SECRET_LEGACY = {
  service: "sportsdesk-gslive",
  name: "GSID",
} as const;
/** OS-keychain `x-gs-session` gate (`ganchrowSessionId`) paired with {@link GSID_SECRET}. */
export const GANCHROW_SESSION_SECRET = {
  service: GSID_SECRET.service,
  name: GSLIVE_GANCHROW_SESSION_NAME,
} as const;

/** Minimal injectable read surface so tests never touch the real keychain. */
export interface SecretReader {
  get(options: { service: string; name: string }): Promise<string | null>;
}

export type ManagerSessionSource =
  | "webview-profile"
  | "running-chrome"
  | "env-cookie"
  | "session-file"
  | "keychain"
  | "env"
  | "none";

/** A resolved session is either usable or explicitly absent — never "none with a cookie". */
export interface ActiveManagerSession {
  readonly source: Exclude<ManagerSessionSource, "none">;
  readonly cookieHeader: string;
  /** Sent as `x-gs-session` on `ajax.php` / `betLobbyV2` when non-empty. */
  readonly sessionGate: string;
}

export interface NoManagerSession {
  readonly source: "none";
  readonly cookieHeader: "";
}

export type ManagerSession = ActiveManagerSession | NoManagerSession;

function defaultSecretReader(): SecretReader | null {
  try {
    if (secrets !== undefined && typeof secrets.get === "function") {
      return { get: (options) => getSecretBounded(secrets, options) };
    }
  } catch {
    // Bun.secrets is unavailable in some runtimes; the env fallback still works.
  }
  return null;
}

/** `GSID_COOKIE` wins: a full `GSID=…` header, or a bare id. */
function cookieHeaderFromGsidCookie(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const raw = (environment.GSID_COOKIE ?? "").trim();
  if (raw === "") return "";
  return raw.includes("=") ? raw : `GSID=${raw}`;
}

/** Read-only `GSLIVE_SESSION_FILE` / `$XDG_CONFIG_HOME/sportsdesk/gslive-session` fallback. */
function cookieHeaderFromSessionFile(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const explicit = (environment.GSLIVE_SESSION_FILE ?? "").trim();
  const configHome =
    (environment.XDG_CONFIG_HOME ?? "").trim() ||
    `${(environment.HOME ?? "").trim()}/.config`;
  const path =
    explicit !== "" ? explicit : `${configHome}/sportsdesk/gslive-session`;
  try {
    const value = readFileSync(path, "utf8").trim();
    if (value === "") return "";
    return cookieHeaderFromValue(value, environment.GA);
  } catch {
    return "";
  }
}

/**
 * Resolve the manager session file/env-first so a host-exported cookie works without keychain
 * mutation, then keychain (Bun.secrets), then `GSID` in the environment. Read-only: this function
 * never writes the session anywhere.
 */
export async function resolveManagerSession(
  environment: Readonly<Record<string, string | undefined>> = env,
  secretReader: SecretReader | null = defaultSecretReader(),
): Promise<ManagerSession> {
  const envCookie = cookieHeaderFromGsidCookie(environment);
  if (envCookie !== "") {
    const sessionGate = await resolveManagerSessionGate(
      environment,
      secretReader,
    );
    return { source: "env-cookie", cookieHeader: envCookie, sessionGate };
  }
  const fileCookie = cookieHeaderFromSessionFile(environment);
  if (fileCookie !== "") {
    const sessionGate = await resolveManagerSessionGate(
      environment,
      secretReader,
    );
    return { source: "session-file", cookieHeader: fileCookie, sessionGate };
  }
  if (secretReader !== null) {
    try {
      const gsid =
        (await secretReader.get(GSID_SECRET))?.trim() ??
        (await secretReader.get(GSID_SECRET_PRE_RENAME))?.trim() ??
        (await secretReader.get(GSID_SECRET_LEGACY))?.trim() ??
        "";
      if (gsid !== "") {
        const sessionGate = await resolveManagerSessionGate(
          environment,
          secretReader,
        );
        return {
          cookieHeader: cookieHeaderFromValue(gsid, environment.GA),
          source: "keychain",
          sessionGate,
        };
      }
    } catch {
      // Fall through to env: a locked/absent keychain is not a hard failure.
    }
  }
  const cookieHeader = cookieHeaderFromEnv(environment);
  if (cookieHeader === "") return { source: "none", cookieHeader: "" };
  const sessionGate = await resolveManagerSessionGate(
    environment,
    secretReader,
  );
  return { source: "env", cookieHeader, sessionGate };
}

/** Resolve, or fail closed with the provisioning path. Never echoes a cookie value. */
export async function requireManagerSession(
  environment: Readonly<Record<string, string | undefined>> = env,
  secretReader: SecretReader | null = defaultSecretReader(),
): Promise<ActiveManagerSession> {
  const session = await resolveManagerSession(environment, secretReader);
  if (session.source === "none") {
    throw new Error(
      "No manager session. Provision it in the OS keychain via `bun run secrets:gslive set` " +
        "(keychain service com.bookdeskops.sportsdesk, name GSLIVE_SESSION_ID), or provide GSLIVE_SESSION_ID (legacy: GSID) through the SSOT " +
        "environment. Never paste a live session cookie into chat, a commit, or a script.",
    );
  }
  return session;
}

/** Optional second gate some builds require alongside the cookie. */
export function sessionGateFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return (environment.GS_SESSION ?? "").trim();
}

/** Resolve `x-gs-session`: `GS_SESSION` env, then keychain `GSLIVE_GANCHROW_SESSION`. */
export async function resolveManagerSessionGate(
  environment: Readonly<Record<string, string | undefined>> = env,
  secretReader: SecretReader | null = defaultSecretReader(),
): Promise<string> {
  const fromEnv = sessionGateFromEnv(environment);
  if (fromEnv !== "") return fromEnv;
  if (secretReader === null) return "";
  try {
    const fromKeychain =
      (await secretReader.get(GANCHROW_SESSION_SECRET))?.trim() ?? "";
    return fromKeychain;
  } catch {
    return "";
  }
}

/** Persist the browser `ganchrowSessionId` for dual-auth ajax probes (never logged). */
export async function writeManagerSessionGate(value: string): Promise<void> {
  const trimmed = value.trim();
  if (trimmed === "") return;
  try {
    await setSecretBounded(Bun.secrets, {
      service: GANCHROW_SESSION_SECRET.service,
      name: GANCHROW_SESSION_SECRET.name,
      value: trimmed,
      persist: "local",
    } as never);
  } catch {
    /* best effort */
  }
}
