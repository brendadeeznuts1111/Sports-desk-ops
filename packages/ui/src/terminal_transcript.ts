/**
 * @file terminal_transcript.ts
 * @description Pure helpers behind the Operator Terminal's history filter, run
 * statistics and session export.
 *
 * No DOM and no fetch: every function is total over `TerminalHistoryEntry[]`, so
 * the panel stays a renderer and the filtering/stats/export behaviour is
 * testable without a browser.
 */

import type { TerminalHistoryEntry } from "./types.ts";

/** CSI (`\x1b[38;2;…m`), OSC-8 hyperlinks (`\x1b]8;;url\x1b\\`) and single-char escapes. */
const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex -- ANSI sequences require control characters
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

/** C0 controls a PTY can emit that must not leak into search text or an export. */
// eslint-disable-next-line no-control-regex -- control characters are the point
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Strip ANSI colour, OSC-8 link wrappers and stray control characters, keeping
 * the visible text. Carriage returns collapse to newlines so a PTY progress
 * line does not search as one broken string.
 */
export function stripAnsi(raw: string): string {
  return raw
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_PATTERN, "");
}

/** Non-overlapping occurrences of `needle` in `haystack`; both must be lowercase. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** One history entry that matched the filter, with its stable history index. */
export interface TerminalHistoryMatch {
  readonly entry: TerminalHistoryEntry;
  readonly historyIndex: number;
  readonly hits: number;
}

/** Outcome of applying a filter query to the history. */
export interface TerminalHistoryMatches {
  /** True when a non-empty query is filtering the history. */
  readonly active: boolean;
  /** Trimmed query as applied (empty when inactive). */
  readonly query: string;
  readonly totalEntries: number;
  /** Occurrences summed across matching entries. */
  readonly totalHits: number;
  readonly matches: readonly TerminalHistoryMatch[];
}

/**
 * Filter history by a case-insensitive substring over the command and its
 * ANSI-stripped output. An inactive filter returns every entry so callers can
 * render one code path.
 */
export function matchTerminalHistory(
  entries: readonly TerminalHistoryEntry[],
  rawQuery: string,
): TerminalHistoryMatches {
  const query = rawQuery.trim();
  if (query.length === 0) {
    return {
      active: false,
      query: "",
      totalEntries: entries.length,
      totalHits: 0,
      matches: entries.map((entry, historyIndex) => ({
        entry,
        historyIndex,
        hits: 0,
      })),
    };
  }

  const needle = query.toLowerCase();
  const matches: TerminalHistoryMatch[] = [];
  let totalHits = 0;
  entries.forEach((entry, historyIndex) => {
    const haystack =
      `${entry.command}\n${stripAnsi(entry.stdout)}`.toLowerCase();
    const hits = countOccurrences(haystack, needle);
    if (hits === 0) return;
    totalHits += hits;
    matches.push({ entry, historyIndex, hits });
  });

  return {
    active: true,
    query,
    totalEntries: entries.length,
    totalHits,
    matches,
  };
}

/** Derived run statistics for the terminal header. */
export interface TerminalHistoryStats {
  /** Every entry in the buffer, including the seeded welcome entry. */
  readonly entries: number;
  /** Entries that actually executed (the seeded welcome buffer is excluded). */
  readonly executed: number;
  readonly failed: number;
  readonly totalMs: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
}

/** Nearest-rank percentile over an ascending array. */
function nearestRank(sorted: readonly number[], percentile: number): number {
  const rank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index] ?? 0;
}

/**
 * Run count, failure count and p50/p95 duration. The seeded welcome buffer is
 * excluded by its explicit `synthetic` marker rather than by a magic duration:
 * a real run can report `durationMs: 0` when it finishes inside a millisecond.
 * Latency percentiles use only the runs that measured above zero.
 */
export function summarizeTerminalHistory(
  entries: readonly TerminalHistoryEntry[],
): TerminalHistoryStats {
  const durations: number[] = [];
  let executed = 0;
  let failed = 0;
  for (const entry of entries) {
    if (entry.synthetic === true) continue;
    executed += 1;
    if (entry.exitCode !== 0) failed += 1;
    if (entry.durationMs > 0) durations.push(entry.durationMs);
  }
  durations.sort((a, b) => a - b);
  return {
    entries: entries.length,
    executed,
    failed,
    totalMs: durations.reduce((sum, ms) => sum + ms, 0),
    p50Ms: durations.length === 0 ? null : nearestRank(durations, 50),
    p95Ms: durations.length === 0 ? null : nearestRank(durations, 95),
  };
}

export interface TerminalTranscriptOptions {
  /** Export timestamp used in the header; defaults to now. */
  readonly exportedAt?: Date | number | string;
  /** `false` omits the provenance header (useful when pasting into a ticket). */
  readonly includeHeader?: boolean;
}

function toIso(value: Date | number | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : new Date(0).toISOString();
}

function formatStat(value: number | null): string {
  return value === null ? "—" : `${value}ms`;
}

/**
 * Deterministic plain-text transcript: ANSI stripped, ISO timestamps, one block
 * per command. Suitable for a ticket, a diff or a downloaded `.txt`.
 */
export function formatTerminalTranscript(
  entries: readonly TerminalHistoryEntry[],
  options: TerminalTranscriptOptions = {},
): string {
  const stats = summarizeTerminalHistory(entries);
  const lines: string[] = [];

  if (options.includeHeader !== false) {
    lines.push("SportsDesk Operator Terminal — session transcript");
    lines.push(`exported: ${toIso(options.exportedAt ?? Date.now())}`);
    lines.push(
      `commands: ${stats.executed} · failed: ${stats.failed} · p50: ${formatStat(stats.p50Ms)} · p95: ${formatStat(stats.p95Ms)}`,
    );
    lines.push("");
  }

  for (const entry of entries) {
    lines.push(
      `$ ${entry.command}  · exit ${entry.exitCode} · ${entry.durationMs}ms · ${toIso(entry.timestamp)}`,
    );
    const body = stripAnsi(entry.stdout).replace(/\s+$/, "");
    lines.push(body.length > 0 ? body : "(no output)");
    lines.push("");
  }

  return lines.length === 0 ? "" : `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** Download filename for a transcript, ISO-safe on every filesystem. */
export function terminalTranscriptFilename(
  at: Date | number = Date.now(),
): string {
  return `sportsdesk-terminal-${toIso(at).replace(/[:.]/g, "-")}.txt`;
}
