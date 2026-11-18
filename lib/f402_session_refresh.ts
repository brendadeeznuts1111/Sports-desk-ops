/**
 * @file f402_session_refresh.ts
 * @description Decide whether the cached F402 session file needs re-minting, and (via the runner)
 * spawn `session:login --from-keychain` when it does. A bearer session's `expiresAtIso` is the
 * server JWT's `exp` minus a small margin (see `sessionFromAuth`), so this decision tracks the
 * real 21-minute window; cookie-only sessions fall back to the client TTL. The runner exists
 * because of 2026-11-04 (session minted 06:03 UTC, expired 06:33 UTC, every bridge rollup after
 * that failed for 14+ hours — see `scratch/bridge-rollup-cron.jsonl`).
 *
 * The decision logic lives here, in a pure function that takes a session + now + grace and
 * returns a `RefreshDecision`. The runner (`scripts/f402_session_refresh.ts`) drives it on a
 * schedule (launchd, Bun.cron, or a future `sched_f402_session_refresh` entry in the reporting
 * scheduler) so the "what to do" can be unit-tested without I/O.
 *
 * Nothing in this module reads, writes, or logs a cookie value, the session header, or the
 * password. It only sees the session's `expiresAtIso` timestamp and derived metadata.
 */

import { decodeF402BearerWindow, type F402TokenWindow } from "./f402_jwt.ts";
import type { F402Session } from "./f402_session.ts";

/** How close to expiry triggers a refresh. 5 min default; about a quarter of the 21-min window. */
export const DEFAULT_REFRESH_GRACE_MS = 5 * 60 * 1000;

/**
 * Client-side TTL cap passed to the mint. For a bearer session the file expiry is derived from
 * the JWT `exp` (see `sessionFromAuth`), so this value only bounds cookie-only sessions and a
 * deliberately shorter caller TTL. The 21-minute window is observational, not an input.
 */
export const DEFAULT_REFRESH_TTL_MINUTES = 1440;

export type RefreshReason =
  "missing" | "unparseable-expiry" | "expired" | "expiring-soon" | "fresh";

export interface RefreshDecision {
  /** True when the runner should re-mint. */
  readonly shouldRefresh: boolean;
  /** Why the decision was made; always safe to log. */
  readonly reason: RefreshReason;
  /** Milliseconds until the current session expires, or null when unknown. */
  readonly msUntilExpiry: number | null;
}

/**
 * Pure decision: should we refresh?
 *
 *   null            → missing; refresh.
 *   expiry unparseable → unparseable-expiry; refresh (treat as a broken file).
 *   expiry <= now   → expired; refresh.
 *   expiry < now + grace → expiring-soon; refresh.
 *   expiry > now + grace → fresh; no action.
 */
export function decideRefresh(
  session: F402Session | null,
  nowMs: number,
  graceMs: number = DEFAULT_REFRESH_GRACE_MS,
): RefreshDecision {
  if (session === null) {
    return { shouldRefresh: true, reason: "missing", msUntilExpiry: null };
  }
  const expiresAtMs = Date.parse(session.expiresAtIso);
  if (!Number.isFinite(expiresAtMs)) {
    return {
      shouldRefresh: true,
      reason: "unparseable-expiry",
      msUntilExpiry: null,
    };
  }
  const msUntilExpiry = expiresAtMs - nowMs;
  if (msUntilExpiry <= 0) {
    return { shouldRefresh: true, reason: "expired", msUntilExpiry };
  }
  if (msUntilExpiry < graceMs) {
    return { shouldRefresh: true, reason: "expiring-soon", msUntilExpiry };
  }
  return { shouldRefresh: false, reason: "fresh", msUntilExpiry };
}

/** What the runner did on one tick. The shape every journal/log entry takes. */
export interface RefreshOutcome {
  readonly observedAtMs: number;
  readonly decision: RefreshDecision;
  /** True when a mint was attempted (shouldRefresh && the runner invoked the login). */
  readonly attempted: boolean;
  /** True when the mint succeeded (child exit 0 and the new session file is readable). */
  readonly ok: boolean;
  /**
   * Short error reason when attempted && !ok. Never includes stderr, the password, or the cookie:
   * only the exit code and a stable classifier string ("exit-nonzero", "post-read-missing",
   * "post-read-stale", "spawn-error").
   */
  readonly error?: string;
  /** Duration of the mint attempt in ms; 0 when no mint was attempted. */
  readonly mintDurationMs: number;
  /**
   * Bearer window read back after a successful mint. Absent when no mint ran or the token is
   * opaque. Never contains the token itself.
   */
  readonly tokenWindow?: TokenWindow;
}

export type RefreshErrorKind =
  "exit-nonzero" | "post-read-missing" | "post-read-stale" | "spawn-error";

/**
 * Observed F402 bearer window (`exp - nbf`), measured 2026-11-17: 21 minutes. This is an
 * observability threshold for the alert below, not the expiry input: `sessionFromAuth` derives
 * `expiresAtIso` from the token's own `exp`.
 */
export const EXPECTED_TOKEN_WINDOW_MINUTES = 21;

/** Deviation beyond this many minutes appends a `f402-token-window-alert` journal line. */
export const TOKEN_WINDOW_TOLERANCE_MINUTES = 2;

/** Bearer validity window, decoded without exposing the token. */
export type TokenWindow = F402TokenWindow;

/**
 * Decode the bearer JWT's `nbf`/`exp` claims. Returns null for an opaque token, a missing header,
 * or an unparseable payload — never throws, and never returns the token.
 */
export function tokenWindowFromSession(
  session: F402Session | null,
): TokenWindow | null {
  if (session === null) return null;
  return decodeF402BearerWindow(session.authorizationHeader);
}

/** Build a stable JSONL line for the runner's journal. No cookie, password, or stderr leaks. */
export function journalLine(outcome: RefreshOutcome): string {
  const payload = {
    kind: "f402-session-refresh",
    observedAtMs: outcome.observedAtMs,
    reason: outcome.decision.reason,
    msUntilExpiry: outcome.decision.msUntilExpiry,
    attempted: outcome.attempted,
    ok: outcome.ok,
    mintDurationMs: outcome.mintDurationMs,
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    ...(outcome.tokenWindow === undefined
      ? {}
      : {
          tokenNbfIso: outcome.tokenWindow.nbfIso,
          tokenExpIso: outcome.tokenWindow.expIso,
          tokenWindowMin: outcome.tokenWindow.windowMinutes,
        }),
  } as const;
  return `${JSON.stringify(payload)}\n`;
}

/** Exit-code vocabulary for the runner (symmetric with `lib/r2_staleness.ts`). */
export const REFRESH_EXIT = {
  /** No action needed, or mint succeeded. */
  ok: 0,
  /** Runner itself broke (keychain unreadable, spawn failed). */
  runnerError: 1,
  /** Refresh attempted and failed (spawn returned non-zero, or post-read still bad). */
  refreshFailed: 2,
} as const;
export type RefreshExit = (typeof REFRESH_EXIT)[keyof typeof REFRESH_EXIT];

export interface BuildMintCommandOptions {
  readonly execPath?: string;
  readonly loginScriptPath?: string;
  /**
   * Pass `--from-keychain` for pre-`op run` installs without env credentials (default `true`).
   * Pass `false` when `op run` / parent env already supplies `F402_AGENT_ID` + `F402_PASSWORD`
   * so argv honestly reflects the credential source.
   */
  readonly fromKeychain?: boolean;
}

/** True when `F402_AGENT_ID` and `F402_PASSWORD` are both non-blank in the environment. */
export function hasEnvLoginCredentials(
  env: Record<string, string | undefined>,
): boolean {
  return (
    (env.F402_AGENT_ID ?? "").trim() !== "" &&
    (env.F402_PASSWORD ?? "").trim() !== ""
  );
}

/**
 * Build the child argv that re-mints the F402 session file.
 *
 * Uses `execPath` (`process.execPath` in the runner) instead of bare `"bun"` so minimal launchd
 * `PATH` environments never fail with ENOENT, passes `--no-orphans` + `--no-env-file` BEFORE `run`
 * (Bun does not inherit `--no-env-file` across `Bun.spawn`, and repo `.env` is a 1Password FIFO
 * that hangs when Desktop is locked), and invokes `scripts/session_login.ts` directly rather than
 * the `package.json` `"session:login"` script (which would spawn a second bare `bun` without
 * `--no-env-file`).
 */
export function buildMintCommand(
  ttlMinutes: number,
  options?: BuildMintCommandOptions,
): string[] {
  const execPath = options?.execPath ?? process.execPath;
  const loginScriptPath =
    options?.loginScriptPath ?? "scripts/session_login.ts";
  const fromKeychain = options?.fromKeychain ?? true;
  return [
    execPath,
    "--no-orphans",
    "--no-env-file",
    "run",
    loginScriptPath,
    ...(fromKeychain ? ["--from-keychain"] : []),
    "--ttl-min",
    String(ttlMinutes),
  ];
}
