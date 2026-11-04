/**
 * @file gslive_weblog_activity.ts
 * @description GSLive WebLog activity: a pure builder over audit snapshots plus a local-only
 *              reader for the artifact the refresh CLI writes (`Scratch/gslive-weblogs/latest.json`).
 *
 * The dashboard route imports {@link loadGsliveWeblogActivity}; it must never touch the network,
 * so a missing/stale artifact is reported as `not_measured` with the command that produces one —
 * never as fabricated zeros. The builder reuses the existing pure parsers/auditors in
 * `lib/gslive_bet_event_log.ts` instead of reimplementing them, and never carries a GSID, cookie,
 * token, row payload, or admin user name into the artifact.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  auditEventTimeline,
  extractBetLogAuditTargets,
  parseBetLog,
  parseGsliveTimestampMs,
  validateAndAuditBetTimeline,
} from "./gslive_bet_event_log.ts";

/** Path fragment the refresh CLI writes and this reader probes first. */
export const GSLIVE_WEBLOG_ARTIFACT_RELATIVE =
  "Scratch/gslive-weblogs/latest.json" as const;
/** Alternate location the reader accepts: `<root>/gslive-weblogs/latest.json`. */
export const GSLIVE_WEBLOG_ARTIFACT_RELATIVE_ALT =
  "gslive-weblogs/latest.json" as const;
/** The single command an operator runs to produce a measured artifact. */
export const GSLIVE_WEBLOG_REFRESH_COMMAND =
  "bun run gslive:weblogs:refresh" as const;
/** Artifact kind discriminator; anything else is rejected, not best-effort parsed. */
export const GSLIVE_WEBLOG_ARTIFACT_KIND = "gslive-weblogs" as const;
/** An artifact older than this is reported stale (the panel says so; it is not remeasured). */
export const GSLIVE_WEBLOG_STALE_AFTER_SECONDS = 6 * 60 * 60;
/** A generatedAtIso further in the future than this is treated as a corrupt artifact. */
const FUTURE_SKEW_MS = 60 * 60 * 1000;
/** Default provenance string; the CLI can override it. */
export const GSLIVE_WEBLOG_DEFAULT_SOURCE =
  "gslive:getBetReport+getBetLog (partner 118)" as const;

export type GsliveWeblogFlagSeverity = "CRITICAL" | "HIGH" | "MEDIUM";

/** One distinct audit finding for an account, aggregated across its sampled bets. */
export interface GsliveWeblogFlag {
  readonly code: string;
  readonly severity: GsliveWeblogFlagSeverity;
  readonly count: number;
}

/**
 * One watchlist account row in the activity panel.
 * `betCount` counts the bets this pass attempted to audit (including unparseable logs), so
 * `betCount > 0 && flags.length === 0` is a real "no anomalies found" measurement, not "unknown".
 */
export interface GsliveWeblogAccount {
  readonly customerLogin: string;
  readonly gsLivePlayerId: string;
  readonly agentId: string;
  readonly sourceCategory: string;
  readonly archetype: string;
  readonly betCount: number;
  readonly placedAtIso: string | null;
  readonly flags: readonly GsliveWeblogFlag[];
  readonly lastLogIso: string | null;
}

/** Dashboard-facing view of the last GSLive WebLog audit pass. */
export interface GsliveWeblogActivity {
  readonly schemaVersion: 1;
  readonly status: "measured" | "not_measured";
  readonly source: string | null;
  readonly asOf: string | null;
  readonly ageSeconds: number | null;
  readonly stale: boolean;
  readonly accounts: readonly GsliveWeblogAccount[];
  readonly summary: {
    readonly accounts: number;
    readonly bets: number;
    readonly flagsByCode: Record<string, number>;
  };
  /** Number of sampled bets whose getBetLog payload could not be parsed. Additive field. */
  readonly parseErrors?: number;
  readonly reason?: string;
  readonly command: string;
}

/** ISO window the audit covered. */
export interface GsliveWeblogWindow {
  readonly fromIso: string;
  readonly toIso: string;
}

export type GsliveWeblogSessionSource = "env" | "keychain" | "session-file";

/** Session provenance only — never the session value. */
export interface GsliveWeblogSessionDescriptor {
  readonly configured: boolean;
  readonly source: GsliveWeblogSessionSource | null;
}

/** The watchlist fields the artifact keeps (a subset of `WatchlistUnifiedEntry`). */
export interface GsliveWeblogWatchlistAccount {
  readonly customerLogin: string;
  readonly gsLivePlayerId: string;
  readonly agentId: string;
  readonly sourceCategory: string;
  readonly archetype: string;
}

/** One account's getBetReport rows for the window (may be empty: that is an observation). */
export interface GsliveWeblogReport {
  readonly account: GsliveWeblogWatchlistAccount;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}

/** One fetched getBetLog (+ optional getEventLog) for a bet the pass sampled. */
export interface GsliveWeblogBetLogInput {
  readonly account: GsliveWeblogWatchlistAccount;
  readonly betId: string;
  /**
   * Raw getBetLog payload. `null` means the fetch was attempted and failed: the bet is counted
   * and reported as a parse error, never as a flag.
   */
  readonly betLog: unknown;
  /** Raw getEventLog payload when the row named an event; absent skips event-level auditing. */
  readonly eventLog?: unknown;
  readonly eventState?: string;
  /** Optional expected wager state (e.g. from the report row) to detect a state mismatch. */
  readonly expectedWagerState?: string;
}

/** Input to the pure artifact builder; all fetches happen in the CLI, not here. */
export interface GsliveWeblogBuildInput {
  readonly reports: readonly GsliveWeblogReport[];
  readonly bets: readonly GsliveWeblogBetLogInput[];
  readonly window: GsliveWeblogWindow;
  readonly session: GsliveWeblogSessionDescriptor;
  readonly source?: string;
  readonly now?: Date;
}

/** The on-disk artifact (`Scratch/gslive-weblogs/latest.json`). */
export interface GsliveWeblogArtifact {
  readonly schemaVersion: 1;
  readonly kind: "gslive-weblogs";
  readonly generatedAtIso: string;
  readonly window: GsliveWeblogWindow;
  readonly session: GsliveWeblogSessionDescriptor;
  readonly source: string;
  readonly accounts: readonly GsliveWeblogAccount[];
  readonly summary: {
    readonly accounts: number;
    readonly bets: number;
    readonly flagsByCode: Record<string, number>;
  };
  /** Sampled bets whose getBetLog payload could not be parsed (counted, never flagged). */
  readonly parseErrors: number;
}

/**
 * Severity assigned to each audit code the builder can emit. Codes come from the existing
 * `AnomalyFlag` union and prescreen `PrescreenReason` union; unknown codes are MEDIUM.
 */
const FLAG_SEVERITY: Readonly<Record<string, GsliveWeblogFlagSeverity>> = {
  WAGER_STATE_MISMATCH: "CRITICAL",
  SCORE_DURING_DELAY_WINDOW: "CRITICAL",
  SUB_15S_SCORE_SNIPE: "CRITICAL",
  ACCEPTED_WHILE_BLOCKED: "CRITICAL",
  POSSESSION_FLIP_DURING_DELAY: "HIGH",
  FEED_STALL_AT_PLACEMENT: "HIGH",
  MANUAL_ADMIN_INTERVENTION: "HIGH",
  FROZEN_CLOCK_SCORING_OR_PLAY: "HIGH",
  DELAY_MISMATCH: "HIGH",
  ADMIN_USER: "HIGH",
  SUSPECTED_BOT: "HIGH",
  REVERSED_CREDIT: "HIGH",
  PLACEMENT_SNAPSHOT_MISMATCH: "HIGH",
  EXTENDED_FEED_OUTAGE: "MEDIUM",
  ODDS_IMPROVEMENT_DURING_DELAY: "MEDIUM",
  ODDS_DRIFT: "MEDIUM",
  MANUAL_LOG: "MEDIUM",
};

const SEVERITY_RANK: Readonly<Record<GsliveWeblogFlagSeverity, number>> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
};

/** Severity for an audit code; unknown codes are MEDIUM (the artifact still shows the code). */
export function gsliveWeblogFlagSeverity(
  code: string,
): GsliveWeblogFlagSeverity {
  return FLAG_SEVERITY[code] ?? "MEDIUM";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

function isFlagSeverity(value: unknown): value is GsliveWeblogFlagSeverity {
  return value === "CRITICAL" || value === "HIGH" || value === "MEDIUM";
}

function isIsoString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Milliseconds for an ISO string or epoch-ish number; null when unparseable. */
function toEpochMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Stable account ordering: most severe finding first, then busiest, then login. */
function compareAccounts(
  a: GsliveWeblogAccount,
  b: GsliveWeblogAccount,
): number {
  const rank = (account: GsliveWeblogAccount): number => {
    let best: number = Number.MAX_SAFE_INTEGER;
    for (const flag of account.flags) {
      best = Math.min(best, SEVERITY_RANK[flag.severity]);
    }
    return best;
  };
  const bySeverity = rank(a) - rank(b);
  if (bySeverity !== 0) return bySeverity;
  if (a.betCount !== b.betCount) return b.betCount - a.betCount;
  return a.customerLogin.localeCompare(b.customerLogin);
}

const sortFlags = (flags: readonly GsliveWeblogFlag[]): GsliveWeblogFlag[] =>
  [...flags].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.count !== b.count) return b.count - a.count;
    return a.code.localeCompare(b.code);
  });

interface AccountAccumulator {
  readonly account: GsliveWeblogWatchlistAccount;
  bets: number;
  parseErrors: number;
  latestPlacedMs: number | null;
  latestLogMs: number | null;
  readonly flagCounts: Map<string, number>;
}

function flagAccount(
  accumulator: AccountAccumulator,
  codes: readonly string[],
): void {
  for (const code of new Set(codes)) {
    if (code.trim() === "") continue;
    accumulator.flagCounts.set(
      code,
      (accumulator.flagCounts.get(code) ?? 0) + 1,
    );
  }
}

/**
 * Pure: watchlist account records + their getBetReport rows + the fetched per-bet getBetLog /
 * getEventLog payloads → the artifact written to disk. No network, no clock read (`now` injected),
 * no session material. A bet whose log cannot be parsed contributes to `betCount` and
 * `parseErrors` only — flags are never invented for it.
 */
export function buildGsliveWeblogArtifact(
  input: GsliveWeblogBuildInput,
): GsliveWeblogArtifact {
  const now = input.now ?? new Date();
  const generatedAtIso = now.toISOString();
  const fromMs = toEpochMs(input.window.fromIso);
  const toMs = toEpochMs(input.window.toIso);
  if (fromMs === null || toMs === null) {
    throw new Error(
      `buildGsliveWeblogArtifact: window must carry parseable fromIso/toIso (got ${JSON.stringify(input.window)})`,
    );
  }
  if (fromMs > toMs) {
    throw new Error(
      "buildGsliveWeblogArtifact: window.fromIso must be <= window.toIso",
    );
  }
  if (input.session.configured !== true) {
    throw new Error(
      "buildGsliveWeblogArtifact: refusing to build a measured artifact without a configured session",
    );
  }

  const rowsById = new Map<string, Readonly<Record<string, unknown>>>();
  for (const report of input.reports) {
    for (const row of report.rows) {
      if (!isRecord(row)) continue;
      const betId = String(row.id ?? "").trim();
      if (betId !== "" && !rowsById.has(betId)) rowsById.set(betId, row);
    }
  }

  const accumulators = new Map<string, AccountAccumulator>();
  const accumulatorFor = (
    account: GsliveWeblogWatchlistAccount,
  ): AccountAccumulator => {
    const key = account.customerLogin.trim().toUpperCase();
    const existing = accumulators.get(key);
    if (existing !== undefined) return existing;
    const created: AccountAccumulator = {
      account,
      bets: 0,
      parseErrors: 0,
      latestPlacedMs: null,
      latestLogMs: null,
      flagCounts: new Map(),
    };
    accumulators.set(key, created);
    return created;
  };

  const seenBets = new Set<string>();
  for (const bet of input.bets) {
    const accountKey = bet.account.customerLogin.trim().toUpperCase();
    const betId = bet.betId.trim();
    const dedupeKey = `${accountKey}:${betId}`;
    if (seenBets.has(dedupeKey)) continue;
    seenBets.add(dedupeKey);

    const accumulator = accumulatorFor(bet.account);
    accumulator.bets += 1;
    const row = rowsById.get(betId);
    const rowLogMs =
      row === undefined ? null : parseGsliveTimestampMs(row.logTime);
    if (rowLogMs !== null) {
      accumulator.latestLogMs = Math.max(
        accumulator.latestLogMs ?? rowLogMs,
        rowLogMs,
      );
    }

    let parsed: ReturnType<typeof parseBetLog>;
    try {
      parsed = parseBetLog(bet.betLog);
    } catch {
      accumulator.parseErrors += 1;
      continue;
    }
    accumulator.latestPlacedMs = Math.max(
      accumulator.latestPlacedMs ?? parsed.placedAtMs,
      parsed.placedAtMs,
    );
    const logMs = Math.max(
      parsed.placedAtMs,
      parsed.acceptedAtMs ?? parsed.placedAtMs,
    );
    accumulator.latestLogMs = Math.max(accumulator.latestLogMs ?? logMs, logMs);

    const codes: string[] = [];
    try {
      const expected =
        bet.expectedWagerState === undefined
          ? undefined
          : bet.expectedWagerState;
      const audit = validateAndAuditBetTimeline({
        betId,
        betLog: bet.betLog,
        eventLog: bet.eventLog ?? [],
        ...(expected === undefined ? {} : { expectedWagerState: expected }),
        ...(bet.eventState === undefined ? {} : { eventState: bet.eventState }),
      });
      codes.push(...audit.anomalies);
    } catch {
      // The log parsed once but the audit could not run: count it, invent no flags.
      accumulator.parseErrors += 1;
      continue;
    }
    if (bet.eventLog !== undefined) {
      const timeline = auditEventTimeline(
        bet.eventLog,
        bet.eventState ?? "unblocked",
      );
      codes.push(...timeline.anomalies);
    }
    if (row !== undefined) {
      const eventLogs =
        bet.eventLog !== undefined && String(row.eID ?? "").trim() !== ""
          ? new Map([[String(row.eID), bet.eventLog]])
          : undefined;
      for (const target of extractBetLogAuditTargets([row], eventLogs)) {
        codes.push(...target.reasons);
      }
    }
    flagAccount(accumulator, codes);
  }

  const accounts: GsliveWeblogAccount[] = [...accumulators.values()]
    .map((accumulator) => {
      const flags = sortFlags(
        [...accumulator.flagCounts.entries()].map(([code, count]) => ({
          code,
          severity: gsliveWeblogFlagSeverity(code),
          count,
        })),
      );
      return {
        customerLogin: accumulator.account.customerLogin,
        gsLivePlayerId: accumulator.account.gsLivePlayerId,
        agentId: accumulator.account.agentId,
        sourceCategory: accumulator.account.sourceCategory,
        archetype: accumulator.account.archetype,
        betCount: accumulator.bets,
        placedAtIso:
          accumulator.latestPlacedMs === null
            ? null
            : new Date(accumulator.latestPlacedMs).toISOString(),
        flags,
        lastLogIso:
          accumulator.latestLogMs === null
            ? null
            : new Date(accumulator.latestLogMs).toISOString(),
      } satisfies GsliveWeblogAccount;
    })
    .sort(compareAccounts);

  const flagsByCode: Record<string, number> = {};
  let parseErrors = 0;
  for (const accumulator of accumulators.values()) {
    parseErrors += accumulator.parseErrors;
    for (const [code, count] of accumulator.flagCounts) {
      flagsByCode[code] = (flagsByCode[code] ?? 0) + count;
    }
  }
  const sortedFlagsByCode: Record<string, number> = {};
  for (const code of Object.keys(flagsByCode).sort()) {
    sortedFlagsByCode[code] = flagsByCode[code] as number;
  }

  return {
    schemaVersion: 1,
    kind: GSLIVE_WEBLOG_ARTIFACT_KIND,
    generatedAtIso,
    window: { fromIso: input.window.fromIso, toIso: input.window.toIso },
    session: {
      configured: true,
      source: input.session.source,
    },
    source: input.source ?? GSLIVE_WEBLOG_DEFAULT_SOURCE,
    accounts,
    summary: {
      accounts: accounts.length,
      bets: [...accumulators.values()].reduce(
        (total, accumulator) => total + accumulator.bets,
        0,
      ),
      flagsByCode: sortedFlagsByCode,
    },
    parseErrors,
  };
}

interface ValidatedArtifact {
  readonly source: string;
  readonly generatedAtMs: number;
  readonly accounts: readonly GsliveWeblogAccount[];
  readonly summary: GsliveWeblogArtifact["summary"];
  readonly parseErrors: number | null;
}

function parseAccount(raw: unknown, index: number): GsliveWeblogAccount {
  const where = `accounts[${index}]`;
  if (!isRecord(raw)) throw new Error(`${where} is not an object`);
  for (const field of [
    "customerLogin",
    "gsLivePlayerId",
    "agentId",
    "sourceCategory",
    "archetype",
  ] as const) {
    if (!isNonEmptyString(raw[field])) {
      throw new Error(`${where}.${field} must be a non-empty string`);
    }
  }
  const betCount = raw.betCount;
  if (
    typeof betCount !== "number" ||
    !Number.isInteger(betCount) ||
    betCount < 0
  ) {
    throw new Error(`${where}.betCount must be a non-negative integer`);
  }
  for (const field of ["placedAtIso", "lastLogIso"] as const) {
    const value = raw[field];
    if (value !== null && !isIsoString(value)) {
      throw new Error(`${where}.${field} must be null or an ISO timestamp`);
    }
  }
  if (!Array.isArray(raw.flags)) {
    throw new Error(`${where}.flags must be an array`);
  }
  const flags: GsliveWeblogFlag[] = raw.flags.map((flag, flagIndex) => {
    if (!isRecord(flag)) {
      throw new Error(`${where}.flags[${flagIndex}] is not an object`);
    }
    if (!isNonEmptyString(flag.code)) {
      throw new Error(`${where}.flags[${flagIndex}].code must be a string`);
    }
    if (!isFlagSeverity(flag.severity)) {
      throw new Error(
        `${where}.flags[${flagIndex}].severity must be CRITICAL|HIGH|MEDIUM`,
      );
    }
    if (
      typeof flag.count !== "number" ||
      !Number.isInteger(flag.count) ||
      flag.count < 1
    ) {
      throw new Error(
        `${where}.flags[${flagIndex}].count must be a positive integer`,
      );
    }
    return {
      code: flag.code,
      severity: flag.severity,
      count: flag.count,
    };
  });
  return {
    customerLogin: raw.customerLogin as string,
    gsLivePlayerId: raw.gsLivePlayerId as string,
    agentId: raw.agentId as string,
    sourceCategory: raw.sourceCategory as string,
    archetype: raw.archetype as string,
    betCount,
    placedAtIso: raw.placedAtIso as string | null,
    flags,
    lastLogIso: raw.lastLogIso as string | null,
  };
}

function parseArtifact(raw: unknown): ValidatedArtifact {
  if (!isRecord(raw)) throw new Error("artifact is not a JSON object");
  if (raw.schemaVersion !== 1) {
    throw new Error(
      `unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)} (expected 1)`,
    );
  }
  if (raw.kind !== GSLIVE_WEBLOG_ARTIFACT_KIND) {
    throw new Error(
      `unexpected kind ${JSON.stringify(raw.kind)} (expected "${GSLIVE_WEBLOG_ARTIFACT_KIND}")`,
    );
  }
  if (!isIsoString(raw.generatedAtIso)) {
    throw new Error("generatedAtIso must be an ISO timestamp");
  }
  const generatedAtMs = toEpochMs(raw.generatedAtIso as string);
  if (generatedAtMs === null) throw new Error("generatedAtIso is unparseable");
  if (!isNonEmptyString(raw.source)) {
    throw new Error("source must be a non-empty string");
  }
  if (!isRecord(raw.window)) throw new Error("window must be an object");
  if (!isIsoString(raw.window.fromIso) || !isIsoString(raw.window.toIso)) {
    throw new Error("window.fromIso/window.toIso must be ISO timestamps");
  }
  if (!isRecord(raw.session)) throw new Error("session must be an object");
  if (typeof raw.session.configured !== "boolean") {
    throw new Error("session.configured must be a boolean");
  }
  const sessionSource = raw.session.source;
  if (
    sessionSource !== null &&
    sessionSource !== "env" &&
    sessionSource !== "keychain" &&
    sessionSource !== "session-file"
  ) {
    throw new Error("session.source must be null|env|keychain|session-file");
  }
  if (!Array.isArray(raw.accounts)) {
    throw new Error("accounts must be an array");
  }
  const accounts = raw.accounts.map(parseAccount);
  if (!isRecord(raw.summary)) throw new Error("summary must be an object");
  const { accounts: accountCount, bets, flagsByCode } = raw.summary;
  if (
    typeof accountCount !== "number" ||
    !Number.isInteger(accountCount) ||
    accountCount < 0
  ) {
    throw new Error("summary.accounts must be a non-negative integer");
  }
  if (typeof bets !== "number" || !Number.isInteger(bets) || bets < 0) {
    throw new Error("summary.bets must be a non-negative integer");
  }
  if (!isRecord(flagsByCode)) {
    throw new Error("summary.flagsByCode must be an object");
  }
  const normalizedFlags: Record<string, number> = {};
  for (const [code, count] of Object.entries(flagsByCode)) {
    if (
      code.trim() === "" ||
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 0
    ) {
      throw new Error(
        "summary.flagsByCode must map non-empty codes to non-negative integers",
      );
    }
    normalizedFlags[code] = count;
  }
  let parseErrors: number | null = null;
  if (raw.parseErrors !== undefined) {
    if (
      typeof raw.parseErrors !== "number" ||
      !Number.isInteger(raw.parseErrors) ||
      raw.parseErrors < 0
    ) {
      throw new Error("parseErrors must be a non-negative integer");
    }
    parseErrors = raw.parseErrors;
  }
  return {
    source: raw.source as string,
    generatedAtMs,
    accounts,
    summary: { accounts: accountCount, bets, flagsByCode: normalizedFlags },
    parseErrors,
  };
}

function notMeasured(reason: string): GsliveWeblogActivity {
  return {
    schemaVersion: 1,
    status: "not_measured",
    source: null,
    asOf: null,
    ageSeconds: null,
    stale: false,
    accounts: [],
    summary: { accounts: 0, bets: 0, flagsByCode: {} },
    reason,
    command: GSLIVE_WEBLOG_REFRESH_COMMAND,
  };
}

/** Candidate artifact paths, preferred location first; local filesystem only. */
function artifactCandidates(root: string): readonly string[] {
  return [
    join(root, GSLIVE_WEBLOG_ARTIFACT_RELATIVE),
    join(root, GSLIVE_WEBLOG_ARTIFACT_RELATIVE_ALT),
  ];
}

/**
 * Read `Scratch/gslive-weblogs/latest.json` (or `<root>/gslive-weblogs/latest.json`) LOCALLY.
 * Never performs network I/O. A missing file, invalid JSON, or an artifact that fails schema
 * validation is `not_measured` with the honest reason and the refresh command; it is never
 * best-effort parsed into a measurement.
 */
export function loadGsliveWeblogActivity(options?: {
  root?: string;
  now?: Date;
}): GsliveWeblogActivity {
  const root = options?.root ?? process.cwd();
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  const candidates = artifactCandidates(root);
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) {
    return notMeasured(
      `GSLive WebLog artifact not found (looked for ${candidates.join(
        " and ",
      )})`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return notMeasured(
      `GSLive WebLog artifact at ${path} is not valid JSON: ${message}`,
    );
  }
  let artifact: ValidatedArtifact;
  try {
    artifact = parseArtifact(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return notMeasured(
      `GSLive WebLog artifact at ${path} failed validation: ${message}`,
    );
  }
  if (artifact.generatedAtMs > nowMs + FUTURE_SKEW_MS) {
    return notMeasured(
      `GSLive WebLog artifact at ${path} has a generatedAtIso in the future (${new Date(
        artifact.generatedAtMs,
      ).toISOString()})`,
    );
  }
  const ageSeconds = Math.max(
    0,
    Math.floor((nowMs - artifact.generatedAtMs) / 1000),
  );
  return {
    schemaVersion: 1,
    status: "measured",
    source: artifact.source,
    asOf: new Date(artifact.generatedAtMs).toISOString(),
    ageSeconds,
    stale: ageSeconds > GSLIVE_WEBLOG_STALE_AFTER_SECONDS,
    accounts: artifact.accounts,
    summary: artifact.summary,
    ...(artifact.parseErrors === null
      ? {}
      : { parseErrors: artifact.parseErrors }),
    command: GSLIVE_WEBLOG_REFRESH_COMMAND,
  };
}
