#!/usr/bin/env bun
/**
 * @file f402_session_refresh.ts
 * @description Thin runner for `lib/f402_session_refresh.ts`: read the current F402 session file,
 * ask the library whether a refresh is needed, and spawn `bun run session:login --from-keychain
 * --ttl-min 1440` when it is. Designed to be driven on a short interval by launchd (a user
 * `LaunchAgent` with `StartInterval` is the lightest supervision surface on macOS and does not
 * require a running webview daemon) or by the reporting scheduler as a future shellJob entry.
 *
 * Writes one JSONL line per tick to `scratch/f402-session-refresh.jsonl` (matching the bridge
 * rollup and r2 staleness journals), so one `jq` reads the whole operator cron surface. Never
 * logs a cookie, password, or stderr from the child; only the `error` classifier string and the
 * timing.
 *
 * Exit contract (deliberately distinct from "did we mint"):
 *   0 — no action needed (session was fresh), OR mint succeeded.
 *   1 — runner itself broke (keychain unreadable, Bun.spawn threw).
 *   2 — refresh attempted and the post-read is still missing/stale.
 *
 * Usage:
 *   bun run scripts/f402_session_refresh.ts
 *   bun run scripts/f402_session_refresh.ts --dry-run    # decide, don't spawn
 *   F402_REFRESH_GRACE_MS=600000 bun run scripts/f402_session_refresh.ts
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { readF402Session } from "../lib/f402_session.ts";
import {
  DEFAULT_REFRESH_GRACE_MS,
  DEFAULT_REFRESH_TTL_MINUTES,
  REFRESH_EXIT,
  decideRefresh,
  journalLine,
  type RefreshErrorKind,
  type RefreshExit,
  type RefreshOutcome,
} from "../lib/f402_session_refresh.ts";

interface RunnerOptions {
  readonly dryRun: boolean;
  readonly graceMs: number;
  readonly ttlMinutes: number;
  readonly journalPath: string;
}

function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): RunnerOptions {
  const graceEnv = (env.F402_REFRESH_GRACE_MS ?? "").trim();
  const graceParsed = Number(graceEnv);
  const graceMs =
    graceEnv !== "" && Number.isFinite(graceParsed) && graceParsed > 0
      ? graceParsed
      : DEFAULT_REFRESH_GRACE_MS;
  const ttlEnv = (env.F402_REFRESH_TTL_MIN ?? "").trim();
  const ttlParsed = Number(ttlEnv);
  const ttlMinutes =
    ttlEnv !== "" && Number.isFinite(ttlParsed) && ttlParsed > 0
      ? ttlParsed
      : DEFAULT_REFRESH_TTL_MINUTES;
  const journalDefault = resolve(
    import.meta.dir,
    "..",
    "scratch",
    "f402-session-refresh.jsonl",
  );
  return {
    dryRun: argv.includes("--dry-run"),
    graceMs,
    ttlMinutes,
    journalPath: (env.F402_REFRESH_JOURNAL ?? "").trim() || journalDefault,
  };
}

/** Spawn `bun run session:login --from-keychain --ttl-min <N>` with `F402_LIVE_LOGIN=1`. */
async function spawnMint(ttlMinutes: number): Promise<{
  readonly ok: boolean;
  readonly error?: RefreshErrorKind;
  readonly durationMs: number;
}> {
  const startedNs = Bun.nanoseconds();
  try {
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "run",
        "session:login",
        "--from-keychain",
        "--ttl-min",
        String(ttlMinutes),
      ],
      env: { ...Bun.env, F402_LIVE_LOGIN: "1" },
      // Child stdio is discarded on purpose: `session:login` prints the cookie-name list and the
      // expiry to stdout, and while that is not itself the cookie, the policy is to never let the
      // child's descriptors leak into this process's stdout where a log aggregator would scoop
      // them up unredacted. The outcome is reported via exit code and the post-read.
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    const exitCode = await proc.exited;
    const durationMs = Math.round((Bun.nanoseconds() - startedNs) / 1e6);
    if (exitCode !== 0) {
      return { ok: false, error: "exit-nonzero", durationMs };
    }
    return { ok: true, durationMs };
  } catch (err) {
    const durationMs = Math.round((Bun.nanoseconds() - startedNs) / 1e6);
    // `err` is caught so the classifier stays stable; the message (which could hold a path or
    // argv echo) does not land in the journal.
    void err;
    return { ok: false, error: "spawn-error", durationMs };
  }
}

async function appendJournal(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, { mode: 0o600 });
}

async function main(): Promise<RefreshExit> {
  const options = parseArgs(
    Bun.argv.slice(2),
    Bun.env as Record<string, string | undefined>,
  );
  const nowMs = Date.now();

  let session: Awaited<ReturnType<typeof readF402Session>> | null = null;
  try {
    session = readF402Session();
  } catch {
    // `readF402Session` is already defensive; a throw here would be a bug in that reader. Fall
    // through with `session = null` so the decider classifies as "missing".
  }

  const decision = decideRefresh(session, nowMs, options.graceMs);

  if (!decision.shouldRefresh) {
    const outcome: RefreshOutcome = {
      observedAtMs: nowMs,
      decision,
      attempted: false,
      ok: true,
      mintDurationMs: 0,
    };
    await appendJournal(options.journalPath, journalLine(outcome));
    return REFRESH_EXIT.ok;
  }

  if (options.dryRun) {
    const outcome: RefreshOutcome = {
      observedAtMs: nowMs,
      decision,
      attempted: false,
      ok: true,
      mintDurationMs: 0,
    };
    await appendJournal(options.journalPath, journalLine(outcome));
    process.stdout.write(
      `dry-run: would refresh (${decision.reason}); grace=${options.graceMs}ms, ttl=${options.ttlMinutes}min\n`,
    );
    return REFRESH_EXIT.ok;
  }

  const mint = await spawnMint(options.ttlMinutes);
  const postRead = readF402Session();
  const postDecision = decideRefresh(postRead, Date.now(), options.graceMs);

  let outcome: RefreshOutcome;
  let exit: RefreshExit;

  if (mint.ok && !postDecision.shouldRefresh) {
    outcome = {
      observedAtMs: nowMs,
      decision,
      attempted: true,
      ok: true,
      mintDurationMs: mint.durationMs,
    };
    exit = REFRESH_EXIT.ok;
  } else {
    const error: RefreshErrorKind = mint.ok
      ? postRead === null
        ? "post-read-missing"
        : "post-read-stale"
      : (mint.error ?? "spawn-error");
    outcome = {
      observedAtMs: nowMs,
      decision,
      attempted: true,
      ok: false,
      mintDurationMs: mint.durationMs,
      error,
    };
    exit = REFRESH_EXIT.refreshFailed;
  }

  await appendJournal(options.journalPath, journalLine(outcome));
  return exit;
}

if (import.meta.main) {
  try {
    const exitCode = await main();
    process.exit(exitCode);
  } catch {
    // A throw out of main is a runner bug; classify as 1 (runner-error) not 2 (refresh-failed)
    // so an alerter can distinguish "my supervision broke" from "the thing I supervise broke".
    process.exit(REFRESH_EXIT.runnerError);
  }
}
