/**
 * @file r2_staleness.ts
 * @description External freshness contract for the public R2 keys this repo publishes.
 * The bridge rollups, agent tree and gslive sinks all land at stable `<prefix>/latest.json` keys
 * under `sportsdesk-ops-reports`; a missed cron fire goes undetected on the operator host because
 * supervision on macOS is a bare shell-launched process with no restart, no log rotation and no
 * alert. This module is the inverse: pure SLA evaluation and human-readable formatting that a
 * runner (GitHub Actions scheduled workflow, cron, or a local probe) can drive against the
 * public R2 URL without any R2 credentials.
 *
 * Pure by design: no `fetch`, no `console`, no process state. The runner HEADs the URL and feeds
 * in `{ status, lastModified }`; this module decides fresh/stale/missing/error and formats the
 * Telegram summary. Tests cover the library exhaustively; the runner is trivial.
 */

/** Public R2 base for the `sportsdesk-ops-reports` bucket. Matches `R2S3Options.publicBase`. */
export const R2_PUBLIC_BASE =
  "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev";

/** How a key can relate to its SLA. */
export type StalenessState = "fresh" | "stale" | "missing" | "error";

/** One monitored R2 key: its name, the SLA, and a short human label for the alert. */
export interface StalenessTarget {
  readonly key: string;
  readonly slaMs: number;
  readonly label: string;
  /** Short reason the key exists, in the alert body. Defaults to the key. */
  readonly description?: string;
}

/** What the runner observed for one target. */
export interface StalenessProbe {
  readonly target: StalenessTarget;
  /** HTTP status from HEAD. 0 if the fetch itself threw. */
  readonly status: number;
  /** Parsed `Last-Modified` as a unix ms timestamp, or null if absent/unparseable. */
  readonly lastModifiedMs: number | null;
  /** Fetch/network error message when status===0. */
  readonly error?: string;
}

/** The evaluated verdict for one probe. */
export interface StalenessVerdict {
  readonly target: StalenessTarget;
  readonly state: StalenessState;
  /** Age in ms (now - lastModified), only when state==="fresh" or "stale". */
  readonly ageMs: number | null;
  /** Short human reason (the alert line's suffix). */
  readonly reason: string;
}

/** The whole run's verdict, ready to format. */
export interface StalenessReport {
  readonly observedAtMs: number;
  readonly verdicts: readonly StalenessVerdict[];
  readonly degradedCount: number;
}

/**
 * The v1 monitored set: the four bridge keys that MUST be fresh every 15 min on a healthy
 * operator. PR #42's new keys (`live-wagers/latest.json`, `agent-tree/latest.json`,
 * `customer-profiles/latest.json`, etc.) deliberately stay out of v1 because the operator's
 * working branch is still pre-PR-42; adding them here would spam `missing` alerts for keys that
 * nothing is yet publishing. Add them in v2 once the operator is on main.
 */
export const BRIDGE_STALENESS_TARGETS: readonly StalenessTarget[] = [
  {
    key: "f402-bet-ticker/latest.json",
    slaMs: 60 * 60 * 1000,
    label: "f402 bet ticker",
    description: "bridge3a wager ticker rollup",
  },
  {
    key: "gslive-tally/latest.json",
    slaMs: 60 * 60 * 1000,
    label: "gslive tally",
    description: "bridge3c open-bets rollup",
  },
  {
    key: "f402-weblog/latest.json",
    slaMs: 90 * 60 * 1000,
    label: "f402 weblog",
    description: "weblog pointer (hourly cadence)",
  },
  {
    key: "wagers-by-state/latest.json",
    slaMs: 60 * 60 * 1000,
    label: "wagers-by-state",
    description: "wager-state histogram",
  },
] as const;

/** Build the public URL for an R2 key under the reports bucket. */
export function publicUrlFor(target: StalenessTarget): string {
  return `${R2_PUBLIC_BASE}/${target.key}`;
}

/**
 * Parse an HTTP `Last-Modified` header to a unix ms timestamp. Returns `null` for null,
 * empty, or unparseable input — `Date.parse` returns NaN on garbage, which we must not leak as
 * a valid age.
 */
export function parseLastModified(header: string | null): number | null {
  if (header === null || header === "") return null;
  const ms = Date.parse(header);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Evaluate one probe against its SLA.
 *
 * 404 maps to `missing` (the key does not exist at all — distinct failure class from stale).
 * status 0 (fetch threw) and other non-200 map to `error` so a WAF block or DNS fail does not
 * get silently classified as "fresh".
 */
export function evaluateProbe(
  probe: StalenessProbe,
  nowMs: number,
): StalenessVerdict {
  const { target, status, lastModifiedMs, error } = probe;
  if (status === 0) {
    return {
      target,
      state: "error",
      ageMs: null,
      reason: `fetch failed: ${error ?? "unknown"}`,
    };
  }
  if (status === 404) {
    return {
      target,
      state: "missing",
      ageMs: null,
      reason: "404 (key does not exist)",
    };
  }
  if (status !== 200) {
    return {
      target,
      state: "error",
      ageMs: null,
      reason: `HTTP ${status} (expected 200)`,
    };
  }
  if (lastModifiedMs === null) {
    return {
      target,
      state: "error",
      ageMs: null,
      reason: "200 but Last-Modified absent/unparseable",
    };
  }
  const ageMs = nowMs - lastModifiedMs;
  if (ageMs < 0) {
    // clock skew: a key freshly written on R2 can beat the alerter's clock by a few seconds.
    // Treat near-future (<= 5 min skew) as fresh with age 0; further is an error.
    if (ageMs > -5 * 60 * 1000) {
      return { target, state: "fresh", ageMs: 0, reason: "fresh (clock skew)" };
    }
    return {
      target,
      state: "error",
      ageMs: null,
      reason: `Last-Modified ${Math.abs(ageMs)}ms in the future`,
    };
  }
  if (ageMs > target.slaMs) {
    return {
      target,
      state: "stale",
      ageMs,
      reason: `${formatAge(ageMs)} old (SLA ${formatAge(target.slaMs)})`,
    };
  }
  return {
    target,
    state: "fresh",
    ageMs,
    reason: `${formatAge(ageMs)} old (SLA ${formatAge(target.slaMs)})`,
  };
}

/** Evaluate every probe, count the degraded, and bundle into one report. */
export function buildReport(
  probes: readonly StalenessProbe[],
  nowMs: number,
): StalenessReport {
  const verdicts = probes.map((probe) => evaluateProbe(probe, nowMs));
  const degradedCount = verdicts.filter(
    (v) => v.state === "stale" || v.state === "missing" || v.state === "error",
  ).length;
  return { observedAtMs: nowMs, verdicts, degradedCount };
}

/**
 * Format `ms` as a short human age: "47s", "9m", "2h13m", "1d4h". For SLAs and ages in the alert
 * body; readable at a glance in a Telegram message.
 */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mRem = m - h * 60;
  if (h < 24) return mRem === 0 ? `${h}h` : `${h}h${mRem}m`;
  const d = Math.floor(h / 24);
  const hRem = h - d * 24;
  return hRem === 0 ? `${d}d` : `${d}d${hRem}h`;
}

/** Icons for the alert body. ASCII only so a plain-text terminal reader can still parse it. */
const STATE_PREFIX: Record<StalenessState, string> = {
  fresh: "OK",
  stale: "STALE",
  missing: "MISSING",
  error: "ERROR",
};

/**
 * Format the whole report as a Telegram HTML message. Empty string when all verdicts are fresh —
 * the runner uses that signal to stay silent (no post).
 *
 * The message is compact (< 4096 chars, Telegram's limit) and groups degraded keys at the top.
 * Fresh keys are listed at the bottom so the operator can confirm the alerter is comparing
 * against the expected set, not silently dropping a key from the registry.
 */
export function formatReport(report: StalenessReport): string {
  if (report.degradedCount === 0) return "";
  const degraded = report.verdicts.filter((v) => v.state !== "fresh");
  const fresh = report.verdicts.filter((v) => v.state === "fresh");
  const observedAt = new Date(report.observedAtMs).toISOString();
  const header =
    `<b>R2 staleness alert</b>\n` +
    `${degraded.length} of ${report.verdicts.length} key(s) degraded at ${observedAt}`;
  const degradedLines = degraded.map(
    (v) =>
      `${STATE_PREFIX[v.state]} <code>${Bun.escapeHTML(v.target.key)}</code> — ${Bun.escapeHTML(v.reason)}`,
  );
  const freshLines = fresh.map(
    (v) =>
      `${STATE_PREFIX[v.state]} <code>${Bun.escapeHTML(v.target.key)}</code> — ${Bun.escapeHTML(v.reason)}`,
  );
  const sections = [header, "", ...degradedLines];
  if (freshLines.length > 0) {
    sections.push("", "<i>Fresh:</i>", ...freshLines);
  }
  return sections.join("\n");
}

/** Exit codes for the runner. 0 = all fresh, 2 = degraded, 1 = alerter itself failed. */
export const ALERTER_EXIT = {
  allFresh: 0,
  alerterError: 1,
  degraded: 2,
} as const;
export type AlerterExit = (typeof ALERTER_EXIT)[keyof typeof ALERTER_EXIT];
