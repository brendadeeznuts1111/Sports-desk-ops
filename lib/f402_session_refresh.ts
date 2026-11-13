/**
 * @file f402_session_refresh.ts
 * @description Decide whether the cached F402 session file needs re-minting, and (via the runner)
 * spawn `session:login --from-keychain` when it does. The core bug this closes: the default
 * session TTL in `lib/f402_session.ts` is 30 minutes, so an operator who mints a session (even
 * via `--from-keychain`) and walks away gets a silent bridge outage half an hour later. That is
 * exactly what happened on 2026-11-04 (session minted 06:03 UTC, expired 06:33 UTC, every bridge
 * rollup since then failed with "missing credentials: no F402 session file" — see
 * `scratch/bridge-rollup-cron.jsonl` for the 36 consecutive ok:false entries).
 *
 * The decision logic lives here, in a pure function that takes a session + now + grace and
 * returns a `RefreshDecision`. The runner (`scripts/f402_session_refresh.ts`) drives it on a
 * schedule (launchd, Bun.cron, or a future `sched_f402_session_refresh` entry in the reporting
 * scheduler) so the "what to do" can be unit-tested without I/O.
 *
 * Nothing in this module reads, writes, or logs a cookie value, the session header, or the
 * password. It only sees the session's `expiresAtIso` timestamp and derived metadata.
 */

import type { F402Session } from "./f402_session.ts";

/** How close to expiry triggers a refresh. 5 min default; 1/6 of the 30-min TTL. */
export const DEFAULT_REFRESH_GRACE_MS = 5 * 60 * 1000;

/** TTL for a refreshed session. 24h matches the bridge cadence; the client is the only enforcer. */
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
}

export type RefreshErrorKind =
  "exit-nonzero" | "post-read-missing" | "post-read-stale" | "spawn-error";

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
