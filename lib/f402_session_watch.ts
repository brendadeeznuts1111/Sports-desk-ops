/**
 * @file f402_session_watch.ts
 * @description Pure evaluation for the F402 refresh-journal silence watchdog (#310).
 *
 * The refresher writes one line per tick. A missing line means the agent is not running, and
 * the token-window alert cannot catch that: it only fires on a mint, so silence reads as health.
 * This module evaluates the journal's age and its last few ticks; the runner
 * (`scripts/f402_session_watch.ts`) reads the files and pages Telegram. Nothing here touches the
 * filesystem, so the thresholds are unit-tested without a live agent.
 */

/** Two missed 5-minute ticks plus slack. */
export const DEFAULT_WATCH_MAX_AGE_MINUTES = 12;

/** Consecutive failed ticks that count as a sustained failure rather than a one-off retry. */
export const DEFAULT_WATCH_REPEATED_FAILURES = 2;

/** Journal `kind` for a refresh tick; the token-window alert uses a different kind. */
export const WATCH_TICK_KIND = "f402-session-refresh";

export interface SessionWatchTick {
  readonly reason: string | null;
  readonly ok: boolean | null;
  readonly error: string | null;
  readonly observedAtMs: number | null;
}

export type SessionWatchCode =
  | "journal-missing"
  | "journal-stale"
  | "journal-unreadable"
  | "last-failed"
  | "repeated-failure";

export interface SessionWatchVerdict {
  readonly status: "ok" | "alert";
  readonly code: SessionWatchCode | null;
  readonly ageMinutes: number | null;
  readonly lastReason: string | null;
  readonly lastError: string | null;
  /** Human-readable line for the journal/log; paths and classifier strings only, never secrets. */
  readonly message: string;
}

export interface SessionWatchInput {
  readonly nowMs: number;
  readonly journalPath: string;
  /** `null` when the journal does not exist. */
  readonly journalMtimeMs: number | null;
  /** Recent raw JSONL lines, oldest to newest. Extra lines are ignored. */
  readonly recentLines: readonly string[];
}

export interface SessionWatchOptions {
  readonly maxAgeMinutes?: number;
  readonly repeatedFailures?: number;
}

/** Parse one journal line into a tick, or null for a non-tick, malformed, or alert line. */
export function parseWatchTick(line: string): SessionWatchTick | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const record = raw as Record<string, unknown>;
  if (record.kind !== WATCH_TICK_KIND) return null;
  return {
    reason: typeof record.reason === "string" ? record.reason : null,
    ok: typeof record.ok === "boolean" ? record.ok : null,
    error: typeof record.error === "string" ? record.error : null,
    observedAtMs:
      typeof record.observedAtMs === "number" ? record.observedAtMs : null,
  };
}

function formatAge(minutes: number | null): string {
  return minutes === null ? "unknown" : minutes.toFixed(1);
}

export function evaluateSessionWatch(
  input: SessionWatchInput,
  options?: SessionWatchOptions,
): SessionWatchVerdict {
  const maxAge = options?.maxAgeMinutes ?? DEFAULT_WATCH_MAX_AGE_MINUTES;
  const repeated = Math.max(
    2,
    options?.repeatedFailures ?? DEFAULT_WATCH_REPEATED_FAILURES,
  );
  const ageMinutes =
    input.journalMtimeMs === null
      ? null
      : Math.max(0, (input.nowMs - input.journalMtimeMs) / 60_000);
  const ticks = input.recentLines
    .map(parseWatchTick)
    .filter((tick): tick is SessionWatchTick => tick !== null);
  const last = ticks.length === 0 ? null : (ticks[ticks.length - 1] ?? null);
  const lastText =
    last === null
      ? "no tick line"
      : `reason=${last.reason ?? "?"} ok=${last.ok ?? "?"}${last.error === null ? "" : ` error=${last.error}`}`;
  const base = `journal: ${input.journalPath}; age: ${formatAge(ageMinutes)} min (threshold ${maxAge}); last: ${lastText}`;
  const verdict = (
    status: "ok" | "alert",
    code: SessionWatchCode | null,
    message: string,
  ): SessionWatchVerdict => ({
    status,
    code,
    ageMinutes,
    lastReason: last?.reason ?? null,
    lastError: last?.error ?? null,
    message,
  });

  if (input.journalMtimeMs === null) {
    return verdict(
      "alert",
      "journal-missing",
      `F402 session refresh journal is missing (the agent may not be installed). ${base}`,
    );
  }
  if (ageMinutes !== null && ageMinutes > maxAge) {
    return verdict(
      "alert",
      "journal-stale",
      `F402 session refresh is silent: journal is older than ${maxAge} min. ${base}`,
    );
  }
  if (ticks.length === 0) {
    return verdict(
      "alert",
      "journal-unreadable",
      `F402 session refresh journal has no readable tick lines. ${base}`,
    );
  }
  const tail = ticks.slice(-repeated);
  if (tail.length === repeated && tail.every((tick) => tick.ok === false)) {
    return verdict(
      "alert",
      "repeated-failure",
      `F402 session refresh is failing: the last ${repeated} ticks all report ok=false. ${base}`,
    );
  }
  if (last?.ok === false) {
    return verdict(
      "alert",
      "last-failed",
      `F402 session refresh failed on its last tick. ${base}`,
    );
  }
  return verdict("ok", null, `F402 session refresh is healthy. ${base}`);
}
