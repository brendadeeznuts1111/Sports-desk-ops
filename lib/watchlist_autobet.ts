/**
 * Watchlist autobet: a paper-only bet-intent pipeline over the desk's own watchlist signals.
 *
 * This module is the engine behind `cli/watchlist_autobet_cli.ts` and is intentionally boring:
 * it reads local artifacts, derives signals with `lib/watchlist_signal_engine.ts`, runs a closed
 * list of gates, and records intents in an append-only JSONL ledger for **operator approval**.
 *
 * Safety boundaries in this module (v1 has no live adapter and no network calls):
 *
 * - paper only: `mode` must be `"paper"` and `allowLiveExecution` must be `false` at config load;
 *   `assertPaperVenue` refuses any venue except `"paper"` with `live_disabled`.
 * - approval gating: `assertIntentTransition` allows `approve` only from `queued`, `execute` only
 *   from `approved`, `settle` only from `filled`; every other transition is `invalid_transition`.
 * - provenance: fixture-sourced signals fail `fixture_provenance` unless config opts in, and stale
 *   or price-less signals fail `freshness` / `reference_price`, so they are never queued.
 * - the ledger is append-only: a malformed or transition-illegal line is a hard `ledger_corrupt`
 *   error with its 1-based line number, never skipped.
 * - money is integer cents internally; JSON payloads expose dollars rounded to the cent. The
 *   reference price is the watched accounts' own implied probability, never a market quote.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { isRecordValue } from "./zod_guards.ts";
import type {
  League,
  OverUnder,
  SignalProvenance,
  WatchlistSignal,
} from "./watchlist_signal_engine.ts";
import {
  deriveWatchlistSignals,
  loadWatchlistSignalInputs,
} from "./watchlist_signal_engine.ts";

export const AUTOBET_SCHEMA_VERSION = 1 as const;
export const AUTOBET_CONFIG_REL_PATH = "config/watchlist-autobet.json";
/** The reference price is the watched accounts' own implied probability, never a market quote. */
export const AUTOBET_REFERENCE_SOURCE = "watchlist_signal.fairProb";
export const DESK_TIME_ZONE = "America/Chicago";

export const AUTOBET_LEAGUES = [
  "NBA",
  "NFL",
  "CFB",
  "EPL",
  "NHL",
  "MLB",
] as const;
export type AutobetLeague = (typeof AUTOBET_LEAGUES)[number];

export const AUTOBET_EVENT_TYPES = [
  "intent_created",
  "intent_approved",
  "intent_rejected",
  "intent_filled",
  "intent_settled",
  "intent_expired",
] as const;
export type AutobetEventType = (typeof AUTOBET_EVENT_TYPES)[number];

export const AUTOBET_STATUSES = [
  "queued",
  "approved",
  "filled",
  "settled",
  "rejected",
  "expired",
] as const;
export type AutobetIntentStatus = (typeof AUTOBET_STATUSES)[number];

export const AUTOBET_GATE_CHECKS = [
  "enabled",
  "league_allowed",
  "fixture_provenance",
  "freshness",
  "confidence",
  "distinct_accounts",
  "one_sided_share",
  "reference_price",
  "stake_available",
  "daily_stake_cap",
  "league_daily_cap",
  "duplicate_intent",
] as const;
export type GateCheckId = (typeof AUTOBET_GATE_CHECKS)[number];

/** The three local artifacts the watchlist signal engine reads; no network path exists. */
export const SIGNAL_SOURCE_PATHS = [
  "docs/graph-live-feed.json",
  "data/live-wagers.json",
  "data/live-bets.json",
] as const;

/** Statuses that hold a dedupe slot; `rejected` and `expired` release it. */
const ACTIVE_INTENT_STATUSES: ReadonlySet<AutobetIntentStatus> = new Set([
  "queued",
  "approved",
  "filled",
  "settled",
]);

const EVENT_SOURCE_STATUSES: Readonly<
  Record<AutobetEventType, readonly AutobetIntentStatus[]>
> = {
  intent_created: [],
  intent_approved: ["queued"],
  intent_rejected: ["queued", "approved"],
  intent_filled: ["approved"],
  intent_settled: ["filled"],
  intent_expired: ["queued", "approved"],
};

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type AutobetErrorCode =
  | "usage_error"
  | "config_missing"
  | "config_invalid"
  | "ledger_corrupt"
  | "ledger_locked"
  | "intent_not_found"
  | "invalid_transition"
  | "intent_expired"
  | "live_disabled"
  | "internal_error";

const EXIT_CODES: Readonly<Record<AutobetErrorCode, 1 | 2 | 3>> = {
  usage_error: 2,
  config_missing: 1,
  config_invalid: 1,
  ledger_corrupt: 1,
  ledger_locked: 1,
  intent_not_found: 1,
  invalid_transition: 3,
  intent_expired: 3,
  live_disabled: 3,
  internal_error: 1,
};

export interface AutobetErrorOptions {
  readonly cause?: unknown;
}

export class AutobetError extends Error {
  readonly code: AutobetErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: AutobetErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: AutobetErrorOptions,
  ) {
    super(message, options);
    this.name = "AutobetError";
    this.code = code;
    this.details = details;
  }

  /** `0` ok, `2` usage, `3` refusal (`invalid_transition`/`intent_expired`/`live_disabled`), else 1. */
  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

export interface AutobetConfig {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly mode: "paper";
  readonly stakeUsd: number;
  readonly maxStakeUsd: number;
  readonly dailyStakeCapUsd: number;
  readonly perLeagueDailyStakeCapUsd: number;
  readonly minConfidence: number;
  readonly minDistinctAccounts: number;
  readonly minOneSidedShare: number;
  readonly maxSignalAgeSeconds: number;
  readonly allowFixtureSignals: boolean;
  readonly allowLiveExecution: false;
  readonly paperSlippageBps: number;
  readonly expireApprovedAfterMinutes: number;
  readonly ledgerPath: string;
  readonly eligibleLeagues: readonly AutobetLeague[];
}

export interface AutobetConfigError {
  readonly path: string;
  readonly message: string;
}

export type AutobetConfigParseResult =
  | { readonly ok: true; readonly config: AutobetConfig }
  | { readonly ok: false; readonly errors: readonly AutobetConfigError[] };

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "enabled",
  "mode",
  "stakeUsd",
  "maxStakeUsd",
  "dailyStakeCapUsd",
  "perLeagueDailyStakeCapUsd",
  "minConfidence",
  "minDistinctAccounts",
  "minOneSidedShare",
  "maxSignalAgeSeconds",
  "allowFixtureSignals",
  "allowLiveExecution",
  "paperSlippageBps",
  "expireApprovedAfterMinutes",
  "ledgerPath",
  "eligibleLeagues",
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value);
}

function isUnitProbability(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value < 1
  );
}

export function isAutobetLeague(value: string): value is AutobetLeague {
  return (AUTOBET_LEAGUES as readonly string[]).includes(value);
}

function isAutobetEventType(value: string): value is AutobetEventType {
  return (AUTOBET_EVENT_TYPES as readonly string[]).includes(value);
}

export function isAutobetIntentStatus(
  value: string,
): value is AutobetIntentStatus {
  return (AUTOBET_STATUSES as readonly string[]).includes(value);
}

/**
 * Strict config parse: required keys, ranges, `mode === "paper"`, `allowLiveExecution === false`,
 * `stakeUsd <= maxStakeUsd`, non-empty unique `eligibleLeagues`, repo-relative `ledgerPath`, and
 * unknown keys rejected. Every error is collected so one bad file reports every problem at once.
 */
export function parseAutobetConfig(raw: unknown): AutobetConfigParseResult {
  const errors: AutobetConfigError[] = [];
  const fail = (path: string, message: string): void => {
    errors.push({ path, message });
  };

  if (!isRecordValue(raw)) {
    return {
      ok: false,
      errors: [{ path: "", message: "config must be a JSON object" }],
    };
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) fail(key, "unknown key");
  }

  const schemaVersion = raw["schemaVersion"];
  if (schemaVersion !== AUTOBET_SCHEMA_VERSION) {
    fail("schemaVersion", `must be ${AUTOBET_SCHEMA_VERSION}`);
  }

  const enabled = raw["enabled"];
  if (typeof enabled !== "boolean") fail("enabled", "must be a boolean");

  const mode = raw["mode"];
  if (mode !== "paper") {
    fail("mode", 'must be "paper"; live execution is not implemented');
  }

  const stakeUsd = raw["stakeUsd"];
  if (!isFiniteNumber(stakeUsd) || stakeUsd <= 0) {
    fail("stakeUsd", "must be a finite number > 0");
  }

  const maxStakeUsd = raw["maxStakeUsd"];
  if (!isFiniteNumber(maxStakeUsd) || maxStakeUsd <= 0) {
    fail("maxStakeUsd", "must be a finite number > 0");
  }
  if (
    isFiniteNumber(stakeUsd) &&
    isFiniteNumber(maxStakeUsd) &&
    stakeUsd > maxStakeUsd
  ) {
    fail("stakeUsd", "must be <= maxStakeUsd");
  }

  const dailyStakeCapUsd = raw["dailyStakeCapUsd"];
  if (!isFiniteNumber(dailyStakeCapUsd) || dailyStakeCapUsd < 0) {
    fail("dailyStakeCapUsd", "must be a finite number >= 0");
  }

  const perLeagueDailyStakeCapUsd = raw["perLeagueDailyStakeCapUsd"];
  if (
    !isFiniteNumber(perLeagueDailyStakeCapUsd) ||
    perLeagueDailyStakeCapUsd < 0
  ) {
    fail("perLeagueDailyStakeCapUsd", "must be a finite number >= 0");
  }

  const minConfidence = raw["minConfidence"];
  if (
    !isFiniteNumber(minConfidence) ||
    minConfidence < 0 ||
    minConfidence > 100
  ) {
    fail("minConfidence", "must be a finite number in [0, 100]");
  }

  const minDistinctAccounts = raw["minDistinctAccounts"];
  if (!isInteger(minDistinctAccounts) || minDistinctAccounts < 1) {
    fail("minDistinctAccounts", "must be an integer >= 1");
  }

  const minOneSidedShare = raw["minOneSidedShare"];
  if (
    !isFiniteNumber(minOneSidedShare) ||
    minOneSidedShare < 0 ||
    minOneSidedShare > 1
  ) {
    fail("minOneSidedShare", "must be a finite number in [0, 1]");
  }

  const maxSignalAgeSeconds = raw["maxSignalAgeSeconds"];
  if (!isInteger(maxSignalAgeSeconds) || maxSignalAgeSeconds < 1) {
    fail("maxSignalAgeSeconds", "must be an integer >= 1");
  }

  const allowFixtureSignals = raw["allowFixtureSignals"];
  if (typeof allowFixtureSignals !== "boolean") {
    fail("allowFixtureSignals", "must be a boolean");
  }

  const allowLiveExecution = raw["allowLiveExecution"];
  if (typeof allowLiveExecution !== "boolean") {
    fail("allowLiveExecution", "must be false");
  } else if (allowLiveExecution) {
    fail(
      "allowLiveExecution",
      "live execution is not implemented; must be false",
    );
  }

  const paperSlippageBps = raw["paperSlippageBps"];
  if (
    !isInteger(paperSlippageBps) ||
    paperSlippageBps < 0 ||
    paperSlippageBps > 5_000
  ) {
    fail("paperSlippageBps", "must be an integer in [0, 5000]");
  }

  const expireApprovedAfterMinutes = raw["expireApprovedAfterMinutes"];
  if (
    !isInteger(expireApprovedAfterMinutes) ||
    expireApprovedAfterMinutes < 1
  ) {
    fail("expireApprovedAfterMinutes", "must be an integer >= 1");
  }

  const ledgerPath = raw["ledgerPath"];
  const ledgerPathOk = typeof ledgerPath === "string" ? ledgerPath.trim() : "";
  if (ledgerPathOk === "") {
    fail("ledgerPath", "must be a non-empty string");
  } else if (isAbsolute(ledgerPathOk)) {
    fail("ledgerPath", "must be repo-relative; absolute paths are refused");
  } else if (ledgerPathOk.split(/[\\/]/).includes("..")) {
    fail("ledgerPath", "must not escape the root with ..");
  }

  const eligibleRaw = raw["eligibleLeagues"];
  const eligibleLeagues: AutobetLeague[] = [];
  if (!Array.isArray(eligibleRaw) || eligibleRaw.length === 0) {
    fail("eligibleLeagues", "must be a non-empty array of league codes");
  } else {
    for (const [index, value] of eligibleRaw.entries()) {
      if (typeof value !== "string" || !isAutobetLeague(value)) {
        fail(
          `eligibleLeagues[${index}]`,
          `must be one of ${AUTOBET_LEAGUES.join(", ")}`,
        );
        continue;
      }
      if (eligibleLeagues.includes(value)) {
        fail(`eligibleLeagues[${index}]`, "duplicate league");
        continue;
      }
      eligibleLeagues.push(value);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      schemaVersion: AUTOBET_SCHEMA_VERSION,
      enabled: enabled === true,
      mode: "paper",
      stakeUsd: stakeUsd as number,
      maxStakeUsd: maxStakeUsd as number,
      dailyStakeCapUsd: dailyStakeCapUsd as number,
      perLeagueDailyStakeCapUsd: perLeagueDailyStakeCapUsd as number,
      minConfidence: minConfidence as number,
      minDistinctAccounts: minDistinctAccounts as number,
      minOneSidedShare: minOneSidedShare as number,
      maxSignalAgeSeconds: maxSignalAgeSeconds as number,
      allowFixtureSignals: allowFixtureSignals === true,
      allowLiveExecution: false,
      paperSlippageBps: paperSlippageBps as number,
      expireApprovedAfterMinutes: expireApprovedAfterMinutes as number,
      ledgerPath: ledgerPathOk,
      eligibleLeagues,
    },
  };
}

/** Read + parse the config file; a missing file is `config_missing`, never silent defaults. */
export async function loadAutobetConfig(
  root: string,
  configRelPath: string = AUTOBET_CONFIG_REL_PATH,
): Promise<AutobetConfig> {
  const absolute = resolve(root, configRelPath);
  let text: string;
  try {
    text = await Bun.file(absolute).text();
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new AutobetError(
        "config_missing",
        `autobet config not found: ${configRelPath}`,
        { path: configRelPath },
        { cause: error },
      );
    }
    throw new AutobetError(
      "internal_error",
      `cannot read autobet config: ${configRelPath}`,
      { path: configRelPath },
      { cause: error },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AutobetError(
      "config_invalid",
      `autobet config is not valid JSON: ${configRelPath}`,
      { path: configRelPath },
      { cause: error },
    );
  }

  const parsed = parseAutobetConfig(raw);
  if (!parsed.ok) {
    const summary = parsed.errors
      .map((error) =>
        error.path === "" ? error.message : `${error.path}: ${error.message}`,
      )
      .join("; ");
    throw new AutobetError(
      "config_invalid",
      `autobet config is invalid: ${configRelPath}: ${summary}`,
      { path: configRelPath, errors: parsed.errors },
    );
  }
  return parsed.config;
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { readonly code?: unknown }).code === "ENOENT";
}

/* -------------------------------------------------------------------------- */
/* Desk day and money math                                                     */
/* -------------------------------------------------------------------------- */

const DESK_DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: DESK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Desk day as `YYYY-MM-DD` in America/Chicago (the cap window, not UTC). */
export function deskDayYmd(now: Date): string {
  const parts = DESK_DAY_FORMAT.formatToParts(now);
  let year = "";
  let month = "";
  let day = "";
  for (const part of parts) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  return `${year}-${month}-${day}`;
}

export function dollarsToCents(value: number): number {
  return Math.round(value * 100);
}

export function centsToUsd(cents: number): number {
  return Math.round(cents) / 100;
}

/** `min(stakeUsd, maxStakeUsd)` clamped to whole cents; the per-bet stake. */
export function clampStakeUsd(config: AutobetConfig): number {
  const cents = Math.min(
    dollarsToCents(config.stakeUsd),
    dollarsToCents(config.maxStakeUsd),
  );
  return centsToUsd(cents);
}

/** Implied probability (0,1) → American odds, rounded to an integer. */
export function impliedProbToAmerican(probability: number): number {
  if (!isUnitProbability(probability)) {
    throw new AutobetError(
      "internal_error",
      `implied probability out of range: ${String(probability)}`,
    );
  }
  const american =
    probability > 0.5
      ? (-100 * probability) / (1 - probability)
      : (100 * (1 - probability)) / probability;
  return Math.round(american);
}

/* -------------------------------------------------------------------------- */
/* Signals and sources                                                         */
/* -------------------------------------------------------------------------- */

export interface AutobetSourceStatus {
  readonly path: string;
  readonly exists: boolean;
  readonly ageSeconds: number | null;
  readonly stale: boolean;
}

/** File-level freshness of the three local signal artifacts (`MISSING` is never zero). */
export async function describeSignalSources(
  root: string,
  maxSignalAgeSeconds: number,
  now: Date,
): Promise<AutobetSourceStatus[]> {
  const statuses: AutobetSourceStatus[] = [];
  for (const relative of SIGNAL_SOURCE_PATHS) {
    const stat = await Bun.file(join(root, relative))
      .stat()
      .catch(() => null);
    if (stat === null) {
      statuses.push({
        path: relative,
        exists: false,
        ageSeconds: null,
        stale: true,
      });
      continue;
    }
    const ageSeconds = Math.max(
      0,
      Math.floor((now.getTime() - stat.mtime.getTime()) / 1_000),
    );
    statuses.push({
      path: relative,
      exists: true,
      ageSeconds,
      stale: ageSeconds > maxSignalAgeSeconds,
    });
  }
  return statuses;
}

export interface AutobetSignalSnapshot {
  readonly signals: readonly WatchlistSignal[];
  readonly sources: readonly AutobetSourceStatus[];
}

/** Load the local artifacts, derive signals with the existing engine, and report source ages. */
export async function loadAutobetSignals(
  root: string,
  config: AutobetConfig,
  now: Date,
): Promise<AutobetSignalSnapshot> {
  const inputs = await loadWatchlistSignalInputs(root);
  const signals = deriveWatchlistSignals(inputs, { now });
  const sources = await describeSignalSources(
    root,
    config.maxSignalAgeSeconds,
    now,
  );
  return { signals, sources };
}

/* -------------------------------------------------------------------------- */
/* Gates                                                                       */
/* -------------------------------------------------------------------------- */

export interface GateCheck {
  readonly check: GateCheckId;
  readonly ok: boolean;
  readonly actual: unknown;
  readonly required: unknown;
  readonly detail?: string;
}

export interface GateResult {
  readonly eligible: boolean;
  readonly checks: readonly GateCheck[];
  readonly reasons: readonly GateCheckId[];
}

export interface GateContext {
  readonly config: AutobetConfig;
  readonly now: Date;
  /** Stake computed by `clampStakeUsd` for this intent, in cents-rounded dollars. */
  readonly stakeUsd: number;
  readonly dailyStakeUsedUsd: number;
  readonly leagueStakeUsedUsd: number;
  /** Ledger intents; the duplicate check derives expiry itself. */
  readonly existingIntents: readonly AutobetIntent[];
}

function gateCheck(
  check: GateCheckId,
  ok: boolean,
  actual: unknown,
  required: unknown,
  detail?: string,
): GateCheck {
  return detail === undefined
    ? { check, ok, actual, required }
    : { check, ok, actual, required, detail };
}

/**
 * Evaluate the closed gate list in table order. A signal is eligible only when every check
 * passes; `reasons` is the failed check ids in that same order (never a different order).
 */
export function evaluateSignalGates(
  signal: WatchlistSignal,
  context: GateContext,
): GateResult {
  const { config, now } = context;
  const provenance = signal.provenance;
  const ageSeconds = provenance.ageSeconds;
  const fresh =
    provenance.asOf !== null &&
    ageSeconds !== null &&
    Number.isFinite(ageSeconds) &&
    ageSeconds <= config.maxSignalAgeSeconds &&
    provenance.stale === false;
  const freshnessDetail = fresh
    ? undefined
    : provenance.asOf === null
      ? "no provenance.asOf; freshness cannot be proven"
      : provenance.stale
        ? "engine marked this signal's provenance stale"
        : ageSeconds === null
          ? "provenance.ageSeconds is unknown"
          : `signal age ${ageSeconds}s exceeds maxSignalAgeSeconds ${config.maxSignalAgeSeconds}`;

  const league: League = signal.league;
  const leagueAllowed =
    isAutobetLeague(league) && config.eligibleLeagues.includes(league);

  const stakeCents = dollarsToCents(context.stakeUsd);
  const dailyUsedCents = dollarsToCents(context.dailyStakeUsedUsd);
  const leagueUsedCents = dollarsToCents(context.leagueStakeUsedUsd);
  const dailyCapCents = dollarsToCents(config.dailyStakeCapUsd);
  const leagueCapCents = dollarsToCents(config.perLeagueDailyStakeCapUsd);

  const duplicate = context.existingIntents.find(
    (intent) =>
      intent.signalId === signal.id &&
      ACTIVE_INTENT_STATUSES.has(resolveIntentStatus(intent, now)),
  );

  const checks: GateCheck[] = [
    gateCheck(
      "enabled",
      config.enabled === true,
      config.enabled,
      true,
      config.enabled ? undefined : "autobet is disabled in config",
    ),
    gateCheck(
      "league_allowed",
      leagueAllowed,
      league,
      [...config.eligibleLeagues],
      leagueAllowed ? undefined : `league ${league} is not in eligibleLeagues`,
    ),
    gateCheck(
      "fixture_provenance",
      provenance.fixture === false || config.allowFixtureSignals,
      provenance.fixture,
      false,
      provenance.fixture && !config.allowFixtureSignals
        ? "signal provenance is fixture-sourced; fixture signals are refused by default"
        : undefined,
    ),
    gateCheck(
      "freshness",
      fresh,
      {
        asOf: provenance.asOf,
        ageSeconds,
        stale: provenance.stale,
      },
      { asOf: "required", maxAgeSeconds: config.maxSignalAgeSeconds },
      freshnessDetail,
    ),
    gateCheck(
      "confidence",
      signal.confidence >= config.minConfidence,
      signal.confidence,
      config.minConfidence,
    ),
    gateCheck(
      "distinct_accounts",
      signal.distinctAccounts >= config.minDistinctAccounts,
      signal.distinctAccounts,
      config.minDistinctAccounts,
    ),
    gateCheck(
      "one_sided_share",
      signal.oneSidedShare >= config.minOneSidedShare,
      signal.oneSidedShare,
      config.minOneSidedShare,
    ),
    gateCheck(
      "reference_price",
      isUnitProbability(signal.fairProb),
      signal.fairProb,
      "finite number in (0, 1)",
      isUnitProbability(signal.fairProb)
        ? undefined
        : "signal has no usable fairProb reference price",
    ),
    gateCheck(
      "stake_available",
      stakeCents > 0,
      centsToUsd(stakeCents),
      "> 0",
      stakeCents > 0
        ? undefined
        : "clamped stake is zero; check stakeUsd/maxStakeUsd",
    ),
    gateCheck(
      "daily_stake_cap",
      dailyUsedCents + stakeCents <= dailyCapCents,
      {
        usedUsd: centsToUsd(dailyUsedCents),
        stakeUsd: centsToUsd(stakeCents),
        capUsd: config.dailyStakeCapUsd,
      },
      "usedUsd + stakeUsd <= dailyStakeCapUsd",
    ),
    gateCheck(
      "league_daily_cap",
      leagueUsedCents + stakeCents <= leagueCapCents,
      {
        usedUsd: centsToUsd(leagueUsedCents),
        stakeUsd: centsToUsd(stakeCents),
        capUsd: config.perLeagueDailyStakeCapUsd,
      },
      "usedUsd + stakeUsd <= perLeagueDailyStakeCapUsd",
    ),
    gateCheck(
      "duplicate_intent",
      duplicate === undefined,
      duplicate === undefined ? null : duplicate.intentId,
      "no existing intent for this signalId",
      duplicate === undefined
        ? undefined
        : `signal already has intent ${duplicate.intentId} (${resolveIntentStatus(duplicate, now)})`,
    ),
  ];

  const eligible = checks.every((check) => check.ok);
  const reasons = checks
    .filter((check) => !check.ok)
    .map((check) => check.check);
  return { eligible, checks, reasons };
}

/* -------------------------------------------------------------------------- */
/* Intent model                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Side vocabulary from the engine fields: `over`/`under` for totals, the team token for
 * spreads/moneyline/team totals, and `line_positive`/`line_negative` when only a line exists.
 * `none` means the engine could not name a side; such a signal never carries a usable price edge.
 */
export function autobetSideFromSignal(signal: WatchlistSignal): string {
  if (signal.overUnder !== null) return signal.overUnder;
  if (signal.sideTeam !== null) return signal.sideTeam;
  if (signal.line !== null) {
    return signal.line > 0 ? "line_positive" : "line_negative";
  }
  return "none";
}

export interface IntentAccount {
  readonly login: string;
  readonly agentId: string | null;
  readonly archetype: string | null;
  readonly sourceCategory: string | null;
  readonly riskUsd: number;
}

export interface PaperFill {
  readonly venue: "paper";
  readonly filledAt: string;
  readonly stakeUsd: number;
  readonly effectiveImpliedProb: number;
  readonly effectiveAmericanOdds: number;
  readonly payoutIfWinUsd: number;
  readonly slippageBps: number;
  readonly referenceSource: typeof AUTOBET_REFERENCE_SOURCE;
}

export type SettlementResult = "won" | "lost" | "void";

export interface Settlement {
  readonly result: SettlementResult;
  readonly settledAt: string;
  readonly profitUsd: number;
  readonly payoutUsd: number;
}

export interface AutobetIntentCore {
  readonly intentId: string;
  readonly signalId: string;
  readonly marketKey: string;
  readonly side: string;
  readonly league: AutobetLeague;
  readonly marketKind: string;
  readonly teams: readonly string[];
  readonly line: number | null;
  readonly sideTeam: string | null;
  readonly overUnder: OverUnder | null;
  readonly fairProb: number;
  readonly confidence: number;
  readonly riskUsd: number;
  readonly distinctAccounts: number;
  readonly oneSidedShare: number;
  readonly provenance: SignalProvenance;
  readonly accounts: readonly IntentAccount[];
  readonly stakeUsd: number;
  readonly referenceAmericanOdds: number;
  readonly referenceImpliedProb: number;
  readonly gates: readonly GateCheck[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
}

export interface AutobetIntent extends AutobetIntentCore {
  /** Derived at read time: `queued`/`approved` past `expiresAt` reads as `expired`. */
  readonly status: AutobetIntentStatus;
  readonly fill: PaperFill | null;
  readonly settlement: Settlement | null;
}

function snapshotProvenance(provenance: SignalProvenance): SignalProvenance {
  return {
    dataMode: provenance.dataMode,
    asOf: provenance.asOf,
    ageSeconds: provenance.ageSeconds,
    stale: provenance.stale,
    fixture: provenance.fixture,
    sources: [...provenance.sources],
  };
}

function snapshotAccounts(
  accounts: readonly {
    readonly login: string;
    readonly agentId: string | null;
    readonly archetype: string | null;
    readonly sourceCategory: string | null;
    readonly riskUsd: number;
  }[],
): IntentAccount[] {
  return accounts.map((account) => ({
    login: account.login,
    agentId: account.agentId,
    archetype: account.archetype,
    sourceCategory: account.sourceCategory,
    riskUsd: account.riskUsd,
  }));
}

function snapshotGateCheck(check: GateCheck): GateCheck {
  return check.detail === undefined
    ? {
        check: check.check,
        ok: check.ok,
        actual: check.actual,
        required: check.required,
      }
    : {
        check: check.check,
        ok: check.ok,
        actual: check.actual,
        required: check.required,
        detail: check.detail,
      };
}

export interface BuildIntentOptions {
  readonly config: AutobetConfig;
  readonly now: Date;
  readonly actor: string;
}

/** Build the `queued` intent for a signal that passed every gate (never called for rejected). */
export function buildAutobetIntent(
  signal: WatchlistSignal,
  gate: GateResult,
  options: BuildIntentOptions,
): AutobetIntent {
  if (!gate.eligible) {
    throw new AutobetError(
      "internal_error",
      `refusing to build an intent for ineligible signal ${signal.id}`,
      { signalId: signal.id, reasons: gate.reasons },
    );
  }
  const fairProb = signal.fairProb;
  if (!isUnitProbability(fairProb)) {
    throw new AutobetError(
      "internal_error",
      `signal ${signal.id} has no usable reference price`,
      { signalId: signal.id },
    );
  }
  if (!isAutobetLeague(signal.league)) {
    throw new AutobetError(
      "internal_error",
      `signal ${signal.id} has league outside eligibleLeagues`,
      { signalId: signal.id, league: signal.league },
    );
  }
  const stakeUsd = clampStakeUsd(options.config);
  if (dollarsToCents(stakeUsd) <= 0) {
    throw new AutobetError("internal_error", "clamped stake is zero", {
      stakeUsd,
    });
  }
  const createdAt = options.now.toISOString();
  const expiresAt = new Date(
    options.now.getTime() + options.config.expireApprovedAfterMinutes * 60_000,
  ).toISOString();
  return {
    intentId: `wa-${randomUUID()}`,
    signalId: signal.id,
    marketKey: signal.id,
    side: autobetSideFromSignal(signal),
    league: signal.league,
    marketKind: signal.marketKind,
    teams: [...signal.teams],
    line: signal.line,
    sideTeam: signal.sideTeam,
    overUnder: signal.overUnder,
    fairProb,
    confidence: signal.confidence,
    riskUsd: signal.riskUsd,
    distinctAccounts: signal.distinctAccounts,
    oneSidedShare: signal.oneSidedShare,
    provenance: snapshotProvenance(signal.provenance),
    accounts: snapshotAccounts(signal.accounts),
    stakeUsd,
    referenceAmericanOdds: impliedProbToAmerican(fairProb),
    referenceImpliedProb: fairProb,
    gates: gate.checks.map(snapshotGateCheck),
    createdAt,
    createdBy: options.actor,
    expiresAt,
    status: "queued",
    fill: null,
    settlement: null,
  };
}

/** The `data` payload of `intent_created` (everything except derived status/fill/settlement). */
export function intentCreatedEventData(
  intent: AutobetIntent,
): Record<string, unknown> {
  return {
    signalId: intent.signalId,
    marketKey: intent.marketKey,
    side: intent.side,
    league: intent.league,
    marketKind: intent.marketKind,
    teams: [...intent.teams],
    line: intent.line,
    sideTeam: intent.sideTeam,
    overUnder: intent.overUnder,
    fairProb: intent.fairProb,
    confidence: intent.confidence,
    riskUsd: intent.riskUsd,
    distinctAccounts: intent.distinctAccounts,
    oneSidedShare: intent.oneSidedShare,
    provenance: snapshotProvenance(intent.provenance),
    accounts: snapshotAccounts(intent.accounts),
    stakeUsd: intent.stakeUsd,
    referenceAmericanOdds: intent.referenceAmericanOdds,
    referenceImpliedProb: intent.referenceImpliedProb,
    gates: intent.gates.map(snapshotGateCheck),
    createdAt: intent.createdAt,
    createdBy: intent.createdBy,
    expiresAt: intent.expiresAt,
  };
}

/** Derived status: `queued`/`approved` past `expiresAt` becomes `expired` at read time. */
export function resolveIntentStatus(
  intent: AutobetIntent,
  now: Date,
): AutobetIntentStatus {
  return deriveIntentStatus(intent.status, intent.expiresAt, now);
}

function deriveIntentStatus(
  base: AutobetIntentStatus,
  expiresAt: string,
  now: Date,
): AutobetIntentStatus {
  if (base !== "queued" && base !== "approved") return base;
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return base;
  return now.getTime() >= expiresMs ? "expired" : base;
}

/* -------------------------------------------------------------------------- */
/* Paper fill and settlement                                                   */
/* -------------------------------------------------------------------------- */

/** Apply `paperSlippageBps` to the reference implied probability (the fill is always worse). */
export function computeEffectiveImpliedProb(
  referenceProb: number,
  slippageBps: number,
): number {
  const effective = referenceProb * (1 + slippageBps / 10_000);
  const rounded = Math.round(effective * 1_000_000) / 1_000_000;
  if (!isUnitProbability(rounded)) {
    throw new AutobetError(
      "internal_error",
      `effective implied probability out of range (${String(rounded)}); check paperSlippageBps`,
      { referenceProb, slippageBps },
    );
  }
  return rounded;
}

/** `round(stakeCents / effectiveProb - stakeCents)` — the win profit in integer cents. */
export function computePayoutIfWinCents(
  stakeCents: number,
  effectiveProb: number,
): number {
  const payout = Math.round(stakeCents / effectiveProb - stakeCents);
  if (!Number.isFinite(payout) || payout < 0) {
    throw new AutobetError(
      "internal_error",
      "paper payout is not a non-negative integer number of cents",
      { stakeCents, effectiveProb },
    );
  }
  return payout;
}

export interface PaperFillInput {
  readonly intent: AutobetIntent;
  readonly config: AutobetConfig;
  readonly now: Date;
}

/**
 * Simulated fill at the reference price worsened by `paperSlippageBps`. `referenceSource` is
 * always `watchlist_signal.fairProb`: the watched accounts' implied price, not a market quote.
 */
export function computePaperFill(input: PaperFillInput): PaperFill {
  const stakeCents = dollarsToCents(input.intent.stakeUsd);
  if (stakeCents <= 0) {
    throw new AutobetError(
      "internal_error",
      "cannot paper-fill an intent with a zero stake",
      { intentId: input.intent.intentId },
    );
  }
  const effectiveImpliedProb = computeEffectiveImpliedProb(
    input.intent.referenceImpliedProb,
    input.config.paperSlippageBps,
  );
  const payoutCents = computePayoutIfWinCents(stakeCents, effectiveImpliedProb);
  return {
    venue: "paper",
    filledAt: input.now.toISOString(),
    stakeUsd: centsToUsd(stakeCents),
    effectiveImpliedProb,
    effectiveAmericanOdds: impliedProbToAmerican(effectiveImpliedProb),
    payoutIfWinUsd: centsToUsd(payoutCents),
    slippageBps: input.config.paperSlippageBps,
    referenceSource: AUTOBET_REFERENCE_SOURCE,
  };
}

/** Paper settlement: `won` pays stake + win profit, `lost` forfeits stake, `void` returns it. */
export function computeSettlement(
  fill: PaperFill,
  result: SettlementResult,
  now: Date,
): Settlement {
  const stakeCents = dollarsToCents(fill.stakeUsd);
  if (stakeCents <= 0) {
    throw new AutobetError(
      "internal_error",
      "cannot settle a paper fill with a zero stake",
    );
  }
  let profitCents = 0;
  let payoutCents = 0;
  if (result === "won") {
    profitCents = dollarsToCents(fill.payoutIfWinUsd);
    payoutCents = stakeCents + profitCents;
  } else if (result === "lost") {
    profitCents = -stakeCents;
    payoutCents = 0;
  } else {
    profitCents = 0;
    payoutCents = stakeCents;
  }
  return {
    result,
    settledAt: now.toISOString(),
    profitUsd: centsToUsd(profitCents),
    payoutUsd: centsToUsd(payoutCents),
  };
}

/* -------------------------------------------------------------------------- */
/* Lifecycle transitions (command layer uses these; they never write)          */
/* -------------------------------------------------------------------------- */

export type IntentAction = "approve" | "reject" | "execute" | "settle";

const ACTION_SOURCE_STATUSES: Readonly<
  Record<IntentAction, readonly AutobetIntentStatus[]>
> = {
  approve: ["queued"],
  reject: ["queued", "approved"],
  execute: ["approved"],
  settle: ["filled"],
};

/**
 * Validate an action against the intent's derived status. Refusals are typed errors:
 * `intent_not_found`, `intent_expired` or `invalid_transition`; never a silent no-op.
 */
export function assertIntentTransition(
  intent: AutobetIntent | undefined,
  action: IntentAction,
  now: Date,
  intentId: string,
): AutobetIntent {
  if (intent === undefined) {
    throw new AutobetError(
      "intent_not_found",
      `intent not found: ${intentId}`,
      {
        intentId,
      },
    );
  }
  const status = resolveIntentStatus(intent, now);
  if (status === "expired") {
    if (action === "settle") {
      throw new AutobetError(
        "invalid_transition",
        `intent ${intentId} is expired and immutable`,
        { intentId, status },
      );
    }
    throw new AutobetError(
      "intent_expired",
      `intent ${intentId} expired at ${intent.expiresAt}`,
      { intentId, expiresAt: intent.expiresAt },
    );
  }
  const allowed = ACTION_SOURCE_STATUSES[action];
  if (!allowed.includes(status)) {
    throw new AutobetError(
      "invalid_transition",
      `cannot ${action} intent ${intentId} in status ${status}`,
      { intentId, status, allowed: [...allowed] },
    );
  }
  return { ...intent, status };
}

/** Refuse any venue but the paper adapter. v1 has no live order path at all. */
export function assertPaperVenue(venue: string | undefined): "paper" {
  const resolved = venue ?? "paper";
  if (resolved !== "paper") {
    throw new AutobetError(
      "live_disabled",
      `live execution is disabled; venue "${resolved}" refuses (paper only)`,
      { venue: resolved },
    );
  }
  return "paper";
}

/* -------------------------------------------------------------------------- */
/* Caps and ledger summary                                                     */
/* -------------------------------------------------------------------------- */

export interface CapUsage {
  readonly dailyStakeUsedUsd: number;
  readonly byLeagueStakeUsedUsd: Readonly<Record<string, number>>;
}

/**
 * Stake reserved on the current desk day: intents created today in any state except
 * `rejected`/`expired` (enqueue reserves; only those two release it).
 */
export function computeCapUsage(
  intents: readonly AutobetIntent[],
  now: Date,
): CapUsage {
  const today = deskDayYmd(now);
  let dailyCents = 0;
  const leagueCents = new Map<string, number>();
  for (const intent of intents) {
    const status = resolveIntentStatus(intent, now);
    if (status === "rejected" || status === "expired") continue;
    const createdMs = Date.parse(intent.createdAt);
    if (!Number.isFinite(createdMs)) continue;
    if (deskDayYmd(new Date(createdMs)) !== today) continue;
    const cents = dollarsToCents(intent.stakeUsd);
    dailyCents += cents;
    leagueCents.set(
      intent.league,
      (leagueCents.get(intent.league) ?? 0) + cents,
    );
  }
  const byLeagueStakeUsedUsd: Record<string, number> = {};
  for (const [league, cents] of leagueCents) {
    byLeagueStakeUsedUsd[league] = centsToUsd(cents);
  }
  return {
    dailyStakeUsedUsd: centsToUsd(dailyCents),
    byLeagueStakeUsedUsd,
  };
}

export interface IntentCounts {
  readonly total: number;
  readonly queued: number;
  readonly approved: number;
  readonly filled: number;
  readonly settled: number;
  readonly rejected: number;
  readonly expired: number;
}

export function countIntentsByStatus(
  intents: readonly AutobetIntent[],
  now: Date,
): IntentCounts {
  const counts: Record<AutobetIntentStatus, number> = {
    queued: 0,
    approved: 0,
    filled: 0,
    settled: 0,
    rejected: 0,
    expired: 0,
  };
  for (const intent of intents) {
    counts[resolveIntentStatus(intent, now)] += 1;
  }
  return {
    total: intents.length,
    queued: counts.queued,
    approved: counts.approved,
    filled: counts.filled,
    settled: counts.settled,
    rejected: counts.rejected,
    expired: counts.expired,
  };
}

export interface LedgerSummary {
  readonly intents: number;
  readonly byStatus: Readonly<Record<AutobetIntentStatus, number>>;
  /** Reserved stake: every intent not `rejected`/`expired`, all time. */
  readonly stakedUsd: number;
  /** Stake on `settled` intents (the ROI denominator). */
  readonly settledStakeUsd: number;
  /** Paper P&L: sum of settlement profit over settled intents only. */
  readonly profitUsd: number;
  readonly roiPct: number;
  /** Stake on `queued`/`approved`/`filled` intents, waiting on a settlement. */
  readonly pendingStakeUsd: number;
}

/** Paper P&L rollup over derived intents (all money math in integer cents). */
export function summarizeIntents(
  intents: readonly AutobetIntent[],
): LedgerSummary {
  const byStatus: Record<AutobetIntentStatus, number> = {
    queued: 0,
    approved: 0,
    filled: 0,
    settled: 0,
    rejected: 0,
    expired: 0,
  };
  let stakedCents = 0;
  let settledStakeCents = 0;
  let profitCents = 0;
  let pendingCents = 0;
  for (const intent of intents) {
    byStatus[intent.status] += 1;
    const cents = dollarsToCents(intent.stakeUsd);
    if (intent.status !== "rejected" && intent.status !== "expired") {
      stakedCents += cents;
    }
    if (intent.status === "settled" && intent.settlement !== null) {
      settledStakeCents += cents;
      profitCents += dollarsToCents(intent.settlement.profitUsd);
    }
    if (
      intent.status === "queued" ||
      intent.status === "approved" ||
      intent.status === "filled"
    ) {
      pendingCents += cents;
    }
  }
  const roiPct =
    settledStakeCents > 0
      ? Math.round((profitCents * 10_000) / settledStakeCents) / 100
      : 0;
  return {
    intents: intents.length,
    byStatus,
    stakedUsd: centsToUsd(stakedCents),
    settledStakeUsd: centsToUsd(settledStakeCents),
    profitUsd: centsToUsd(profitCents),
    roiPct,
    pendingStakeUsd: centsToUsd(pendingCents),
  };
}

/* -------------------------------------------------------------------------- */
/* Enqueue planning (shared by `plan` and `enqueue`)                           */
/* -------------------------------------------------------------------------- */

export interface SkippedEnqueue {
  readonly signalId: string;
  readonly reasons: readonly GateCheckId[];
  readonly existingIntentId?: string;
}

export interface EnqueuePlanCaps {
  readonly dailyStakeCapUsd: number;
  /** Reserved stake before this batch (today, desk day). */
  readonly dailyStakeUsedUsd: number;
  readonly remainingUsd: number;
  readonly perLeagueDailyStakeCapUsd: number;
}

export interface EnqueuePlan {
  readonly wouldQueue: readonly AutobetIntent[];
  readonly skipped: readonly SkippedEnqueue[];
  readonly caps: EnqueuePlanCaps;
}

export interface PlanEnqueueOptions {
  readonly config: AutobetConfig;
  readonly now: Date;
  readonly intents: readonly AutobetIntent[];
  readonly actor: string;
}

/**
 * Dry run of `enqueue`: reserves the clamped stake against the caps as it goes, so a batch that
 * would breach the daily/per-league caps stops at the boundary instead of creating every intent.
 * `plan` and `enqueue` call this one function, so their answers cannot disagree.
 */
export function planEnqueues(
  signals: readonly WatchlistSignal[],
  options: PlanEnqueueOptions,
): EnqueuePlan {
  const usage = computeCapUsage(options.intents, options.now);
  let usedDailyCents = dollarsToCents(usage.dailyStakeUsedUsd);
  const usedLeagueCents = new Map<string, number>();
  for (const [league, usd] of Object.entries(usage.byLeagueStakeUsedUsd)) {
    usedLeagueCents.set(league, dollarsToCents(usd));
  }

  const stakeUsd = clampStakeUsd(options.config);
  const stakeCents = dollarsToCents(stakeUsd);
  const wouldQueue: AutobetIntent[] = [];
  const skipped: SkippedEnqueue[] = [];

  for (const signal of signals) {
    const leagueUsedCents = usedLeagueCents.get(signal.league) ?? 0;
    const gate = evaluateSignalGates(signal, {
      config: options.config,
      now: options.now,
      stakeUsd,
      dailyStakeUsedUsd: centsToUsd(usedDailyCents),
      leagueStakeUsedUsd: centsToUsd(leagueUsedCents),
      existingIntents: options.intents,
    });
    if (!gate.eligible) {
      const duplicate = gate.checks.find(
        (check) => check.check === "duplicate_intent",
      );
      const existingIntentId =
        typeof duplicate?.actual === "string" ? duplicate.actual : undefined;
      skipped.push({
        signalId: signal.id,
        reasons: gate.reasons,
        ...(existingIntentId === undefined ? {} : { existingIntentId }),
      });
      continue;
    }
    const intent = buildAutobetIntent(signal, gate, {
      config: options.config,
      now: options.now,
      actor: options.actor,
    });
    wouldQueue.push(intent);
    usedDailyCents += stakeCents;
    usedLeagueCents.set(signal.league, leagueUsedCents + stakeCents);
  }

  const dailyCapCents = dollarsToCents(options.config.dailyStakeCapUsd);
  const remainingCents = Math.max(
    0,
    dailyCapCents - dollarsToCents(usage.dailyStakeUsedUsd),
  );
  return {
    wouldQueue,
    skipped,
    caps: {
      dailyStakeCapUsd: options.config.dailyStakeCapUsd,
      dailyStakeUsedUsd: usage.dailyStakeUsedUsd,
      remainingUsd: centsToUsd(remainingCents),
      perLeagueDailyStakeCapUsd: options.config.perLeagueDailyStakeCapUsd,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Ledger                                                                      */
/* -------------------------------------------------------------------------- */

export interface LedgerEvent {
  readonly schemaVersion: 1;
  readonly type: AutobetEventType;
  readonly at: string;
  readonly actor: string;
  readonly intentId: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export function buildLedgerEvent(
  type: AutobetEventType,
  intentId: string,
  at: Date,
  actor: string,
  data: Readonly<Record<string, unknown>>,
): LedgerEvent {
  return {
    schemaVersion: AUTOBET_SCHEMA_VERSION,
    type,
    at: at.toISOString(),
    actor,
    intentId,
    data,
  };
}

export function ledgerPathFor(root: string, config: AutobetConfig): string {
  const absolute = resolve(root, config.ledgerPath);
  const rootAbsolute = resolve(root);
  if (absolute !== rootAbsolute && !absolute.startsWith(`${rootAbsolute}/`)) {
    throw new AutobetError(
      "internal_error",
      `ledger path escapes the autobet root: ${config.ledgerPath}`,
      { ledgerPath: config.ledgerPath },
    );
  }
  // The lexical check above does not follow symlinks. When the directory or ledger file already
  // exists, compare real paths too, so a symlinked component cannot redirect the writer outside.
  try {
    const rootReal = realpathSync(rootAbsolute);
    const parentReal = realpathSync(dirname(absolute));
    if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}/`)) {
      throw new AutobetError(
        "internal_error",
        `ledger path escapes the autobet root through a symlink: ${config.ledgerPath}`,
        { ledgerPath: config.ledgerPath },
      );
    }
    // A ledger file that is itself a symlink is followed by `open(..., "a")`, so check the file
    // too when it exists. ENOENT is expected before the first append.
    const fileReal = realpathSync(absolute);
    if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}/`)) {
      throw new AutobetError(
        "internal_error",
        `ledger file escapes the autobet root through a symlink: ${config.ledgerPath}`,
        { ledgerPath: config.ledgerPath },
      );
    }
  } catch (error) {
    if (error instanceof AutobetError) throw error;
    // ENOENT: the ledger directory/file does not exist yet; `appendLedgerEvent` creates it under
    // the root and the next command re-checks the real paths before writing.
  }
  return absolute;
}

/** Suffix of the advisory lock file created next to the ledger. */
export const LEDGER_LOCK_SUFFIX = ".lock";
const DEFAULT_LEDGER_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LEDGER_LOCK_STALE_MS = 30_000;
const LEDGER_LOCK_RETRY_MS = 25;

export interface LedgerLockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  readonly retryMs?: number;
}

export function ledgerLockPathFor(ledgerPath: string): string {
  return `${ledgerPath}${LEDGER_LOCK_SUFFIX}`;
}

function sleepMilliseconds(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Serialize a read→validate→append mutation across processes with an advisory lock file next to
 * the ledger (`<ledger>.lock`, created with `O_EXCL`).
 *
 * WHY: the append-only JSONL ledger is only valid while one writer at a time folds the current
 * state and appends its event. Two operator shells, or `watch`/cron beside an operator command,
 * could each read the same queued intent and append a transition; the second event is then
 * transition-illegal and every later read reports `ledger_corrupt` with no repair path. Readers
 * (status/signals/list/journal) do not take the lock: one appended line becomes visible atomically.
 *
 * A lock left behind by a crashed process is broken only after `staleMs`; waiting past
 * `timeoutMs` is a `ledger_locked` refusal, never a silent write.
 */
export async function withLedgerLock<T>(
  ledgerPath: string,
  run: () => Promise<T>,
  options: LedgerLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LEDGER_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LEDGER_LOCK_STALE_MS;
  const retryMs = options.retryMs ?? LEDGER_LOCK_RETRY_MS;
  const lockPath = ledgerLockPathFor(ledgerPath);
  await mkdir(dirname(lockPath), { recursive: true });
  const startedAt = Bun.nanoseconds();
  const deadline = startedAt + timeoutMs * 1e6;

  for (;;) {
    let handle: FileHandle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (errorCodeOf(error) !== "EEXIST") {
        throw new AutobetError(
          "internal_error",
          `cannot create the autobet ledger lock: ${lockPath}`,
          { lockPath },
          { cause: error },
        );
      }
      // Another process holds the lock. Break it only when its mtime proves it stale.
      let stale = false;
      try {
        const info = await stat(lockPath);
        stale = Date.now() - info.mtimeMs > staleMs;
      } catch (statError) {
        if (errorCodeOf(statError) !== "ENOENT") {
          throw new AutobetError(
            "internal_error",
            `cannot inspect the autobet ledger lock: ${lockPath}`,
            { lockPath },
            { cause: statError },
          );
        }
        // The holder released it between our open and stat: retry immediately.
        continue;
      }
      if (stale) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Bun.nanoseconds() >= deadline) {
        throw new AutobetError(
          "ledger_locked",
          `another autobet process holds the ledger lock (${lockPath}); nothing was written. ` +
            "Retry after it finishes, or remove the lock file if the holder crashed.",
          { lockPath, waitedMs: (Bun.nanoseconds() - startedAt) / 1e6 },
        );
      }
      await sleepMilliseconds(retryMs);
      continue;
    }
    try {
      await handle.write(
        `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
      );
      return await run();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

/**
 * Append one JSON line with a single `write`, creating the parent directory and file mode 0o600.
 * The ledger is append-only; nothing in this module rewrites or truncates it.
 */
export async function appendLedgerEvent(
  path: string,
  event: LedgerEvent,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const payload = `${JSON.stringify(event)}\n`;
  const handle = await open(path, "a", 0o600);
  try {
    await handle.write(payload);
  } finally {
    await handle.close();
  }
  // A pre-existing ledger can carry a wider mode; tighten it best-effort on every append.
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) await chmod(path, 0o600);
  } catch {
    // Best effort: a refused chmod must not lose the appended event.
  }
}

export interface ReadLedgerSuccess {
  readonly ok: true;
  readonly intents: readonly AutobetIntent[];
  readonly events: readonly LedgerEvent[];
  readonly summary: LedgerSummary;
}

export interface ReadLedgerFailure {
  readonly ok: false;
  readonly code: "ledger_corrupt";
  readonly message: string;
  /** 1-based line number of the offending record. */
  readonly line: number;
}

export type ReadLedgerResult = ReadLedgerSuccess | ReadLedgerFailure;

export interface ReadLedgerOptions {
  readonly now?: Date;
}

interface FoldedIntent {
  core: AutobetIntentCore;
  status: AutobetIntentStatus;
  fill: PaperFill | null;
  settlement: Settlement | null;
}

/**
 * Read and fold the append-only JSONL ledger. A missing file is an empty ledger; a malformed
 * line, unknown event, illegal transition or duplicate `intent_created` is `ledger_corrupt`
 * with its line number — never skipped, never repaired.
 */
export async function readLedger(
  path: string,
  options: ReadLedgerOptions = {},
): Promise<ReadLedgerResult> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    if (isNotFoundError(error)) {
      const intents: AutobetIntent[] = [];
      return {
        ok: true,
        intents,
        events: [],
        summary: summarizeIntents(intents),
      };
    }
    throw new AutobetError(
      "internal_error",
      `cannot read autobet ledger: ${path}`,
      { path },
      { cause: error },
    );
  }

  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const folded = new Map<string, FoldedIntent>();
  const events: LedgerEvent[] = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.trim() === "") {
      return {
        ok: false,
        code: "ledger_corrupt",
        message: `line ${lineNumber} is empty; every ledger line must be one JSON event`,
        line: lineNumber,
      };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      return {
        ok: false,
        code: "ledger_corrupt",
        message: `line ${lineNumber} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        line: lineNumber,
      };
    }
    const foldedLine = foldLedgerLine(folded, payload);
    if (!foldedLine.ok) {
      return {
        ok: false,
        code: "ledger_corrupt",
        message: `line ${lineNumber}: ${foldedLine.message}`,
        line: lineNumber,
      };
    }
    events.push(foldedLine.event);
  }

  const now = options.now ?? new Date();
  const intents = [...folded.values()].map((state) => ({
    ...state.core,
    status: deriveIntentStatus(state.status, state.core.expiresAt, now),
    fill: state.fill,
    settlement: state.settlement,
  }));
  return {
    ok: true,
    intents,
    events,
    summary: summarizeIntents(intents),
  };
}

function foldLedgerLine(
  folded: Map<string, FoldedIntent>,
  payload: unknown,
):
  | { readonly ok: true; readonly event: LedgerEvent }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  const shape = parseLedgerEventShape(payload);
  if (!shape.ok) return shape;
  const event = shape.event;

  if (event.type === "intent_created") {
    if (folded.has(event.intentId)) {
      return {
        ok: false,
        message: `duplicate intent_created for ${event.intentId}`,
      };
    }
    const parsed = parseIntentCore(event.intentId, event.data);
    if (!parsed.ok) {
      return {
        ok: false,
        message: `invalid intent_created data: ${parsed.message}`,
      };
    }
    folded.set(event.intentId, {
      core: parsed.core,
      status: "queued",
      fill: null,
      settlement: null,
    });
    return { ok: true, event };
  }

  const state = folded.get(event.intentId);
  if (state === undefined) {
    return {
      ok: false,
      message: `${event.type} for unknown intent ${event.intentId}`,
    };
  }
  const allowedFrom = EVENT_SOURCE_STATUSES[event.type];
  if (!allowedFrom.includes(state.status)) {
    return {
      ok: false,
      message: `${event.type} not allowed after ${state.status} for ${event.intentId}`,
    };
  }

  switch (event.type) {
    case "intent_approved": {
      const note = event.data["note"];
      if (note !== undefined && typeof note !== "string") {
        return { ok: false, message: "intent_approved note must be a string" };
      }
      state.status = "approved";
      return { ok: true, event };
    }
    case "intent_rejected": {
      const reason = event.data["reason"];
      if (typeof reason !== "string" || reason.trim() === "") {
        return {
          ok: false,
          message: "intent_rejected requires a non-empty reason",
        };
      }
      state.status = "rejected";
      return { ok: true, event };
    }
    case "intent_filled": {
      const fill = parsePaperFill(event.data["fill"]);
      if (fill === null) {
        return { ok: false, message: "intent_filled has an invalid fill" };
      }
      state.status = "filled";
      state.fill = fill;
      return { ok: true, event };
    }
    case "intent_settled": {
      const settlement = parseSettlement(event.data["settlement"]);
      if (settlement === null) {
        return {
          ok: false,
          message: "intent_settled has an invalid settlement",
        };
      }
      state.status = "settled";
      state.settlement = settlement;
      return { ok: true, event };
    }
    case "intent_expired": {
      state.status = "expired";
      return { ok: true, event };
    }
  }
}

function parseLedgerEventShape(payload: unknown):
  | { readonly ok: true; readonly event: LedgerEvent }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  if (!isRecordValue(payload)) {
    return { ok: false, message: "event must be a JSON object" };
  }
  if (payload["schemaVersion"] !== AUTOBET_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `unsupported schemaVersion ${String(payload["schemaVersion"])}`,
    };
  }
  const type = payload["type"];
  if (typeof type !== "string" || !isAutobetEventType(type)) {
    return { ok: false, message: `unknown event type ${String(type)}` };
  }
  const at = readIsoTimestamp(payload["at"]);
  if (at === null) {
    return { ok: false, message: "event.at must be an ISO-8601 timestamp" };
  }
  const actor = payload["actor"];
  if (typeof actor !== "string" || actor.trim() === "") {
    return { ok: false, message: "event.actor must be a non-empty string" };
  }
  const intentId = payload["intentId"];
  if (typeof intentId !== "string" || intentId.trim() === "") {
    return {
      ok: false,
      message: "event.intentId must be a non-empty string",
    };
  }
  const data = payload["data"];
  if (!isRecordValue(data)) {
    return { ok: false, message: "event.data must be a JSON object" };
  }
  return {
    ok: true,
    event: {
      schemaVersion: AUTOBET_SCHEMA_VERSION,
      type,
      at,
      actor,
      intentId,
      data,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Field parsing (external data boundary)                                      */
/* -------------------------------------------------------------------------- */

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function readNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return isFiniteNumber(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

function readIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function parseProvenance(value: unknown): SignalProvenance | null {
  if (!isRecordValue(value)) return null;
  const dataMode = readNullableString(value["dataMode"]);
  const asOf = readNullableString(value["asOf"]);
  const ageSeconds = readNullableNumber(value["ageSeconds"]);
  const stale = value["stale"];
  const fixture = value["fixture"];
  const sources = readStringArray(value["sources"]);
  if (
    dataMode === undefined ||
    asOf === undefined ||
    ageSeconds === undefined ||
    typeof stale !== "boolean" ||
    typeof fixture !== "boolean" ||
    sources === null
  ) {
    return null;
  }
  return { dataMode, asOf, ageSeconds, stale, fixture, sources };
}

function parseAccounts(value: unknown): IntentAccount[] | null {
  if (!Array.isArray(value)) return null;
  const accounts: IntentAccount[] = [];
  for (const raw of value) {
    if (!isRecordValue(raw)) return null;
    const login = raw["login"];
    const agentId = readNullableString(raw["agentId"]);
    const archetype = readNullableString(raw["archetype"]);
    const sourceCategory = readNullableString(raw["sourceCategory"]);
    const riskUsd = raw["riskUsd"];
    if (
      typeof login !== "string" ||
      login === "" ||
      agentId === undefined ||
      archetype === undefined ||
      sourceCategory === undefined ||
      !isFiniteNumber(riskUsd) ||
      riskUsd < 0
    ) {
      return null;
    }
    accounts.push({ login, agentId, archetype, sourceCategory, riskUsd });
  }
  return accounts;
}

function parseGateChecks(value: unknown): GateCheck[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const checks: GateCheck[] = [];
  for (const raw of value) {
    if (!isRecordValue(raw)) return null;
    const check = raw["check"];
    const ok = raw["ok"];
    const detail = raw["detail"];
    if (
      typeof check !== "string" ||
      !(AUTOBET_GATE_CHECKS as readonly string[]).includes(check) ||
      typeof ok !== "boolean" ||
      (detail !== undefined && typeof detail !== "string") ||
      !("actual" in raw) ||
      !("required" in raw)
    ) {
      return null;
    }
    checks.push(
      detail === undefined
        ? {
            check: check as GateCheckId,
            ok,
            actual: raw["actual"],
            required: raw["required"],
          }
        : {
            check: check as GateCheckId,
            ok,
            actual: raw["actual"],
            required: raw["required"],
            detail,
          },
    );
  }
  return checks;
}

type CoreParseResult =
  | { readonly ok: true; readonly core: AutobetIntentCore }
  | { readonly ok: false; readonly message: string };

function parseIntentCore(
  intentId: string,
  data: Readonly<Record<string, unknown>>,
): CoreParseResult {
  const fail = (message: string): CoreParseResult => ({ ok: false, message });

  const signalId = data["signalId"];
  if (typeof signalId !== "string" || signalId === "") {
    return fail("signalId must be a non-empty string");
  }
  if (data["marketKey"] !== signalId) {
    return fail("marketKey must equal signalId");
  }
  const side = data["side"];
  if (typeof side !== "string" || side === "") {
    return fail("side must be a non-empty string");
  }
  const league = data["league"];
  if (typeof league !== "string" || !isAutobetLeague(league)) {
    return fail(`league must be one of ${AUTOBET_LEAGUES.join(", ")}`);
  }
  const marketKind = data["marketKind"];
  if (typeof marketKind !== "string" || marketKind === "") {
    return fail("marketKind must be a non-empty string");
  }
  const teams = readStringArray(data["teams"]);
  if (teams === null) return fail("teams must be an array of strings");
  const line = readNullableNumber(data["line"]);
  if (line === undefined) return fail("line must be a number or null");
  const sideTeam = readNullableString(data["sideTeam"]);
  if (sideTeam === undefined) return fail("sideTeam must be a string or null");
  const overUnderRaw = data["overUnder"];
  const overUnder: OverUnder | null | undefined =
    overUnderRaw === null
      ? null
      : overUnderRaw === "over" || overUnderRaw === "under"
        ? overUnderRaw
        : undefined;
  if (overUnder === undefined) {
    return fail('overUnder must be "over", "under" or null');
  }
  const fairProb = data["fairProb"];
  if (!isUnitProbability(fairProb)) {
    return fail("fairProb must be a finite number in (0, 1)");
  }
  const confidence = data["confidence"];
  if (!isFiniteNumber(confidence) || confidence < 0 || confidence > 100) {
    return fail("confidence must be a finite number in [0, 100]");
  }
  const riskUsd = data["riskUsd"];
  if (!isFiniteNumber(riskUsd) || riskUsd < 0) {
    return fail("riskUsd must be a finite number >= 0");
  }
  const distinctAccounts = data["distinctAccounts"];
  if (!isInteger(distinctAccounts) || distinctAccounts < 1) {
    return fail("distinctAccounts must be an integer >= 1");
  }
  const oneSidedShare = data["oneSidedShare"];
  if (
    !isFiniteNumber(oneSidedShare) ||
    oneSidedShare < 0 ||
    oneSidedShare > 1
  ) {
    return fail("oneSidedShare must be a finite number in [0, 1]");
  }
  const provenance = parseProvenance(data["provenance"]);
  if (provenance === null) return fail("provenance has an invalid shape");
  const accounts = parseAccounts(data["accounts"]);
  if (accounts === null) return fail("accounts has an invalid shape");
  const stakeUsd = data["stakeUsd"];
  if (!isFiniteNumber(stakeUsd) || stakeUsd <= 0) {
    return fail("stakeUsd must be a finite number > 0");
  }
  const referenceAmericanOdds = data["referenceAmericanOdds"];
  if (!isFiniteNumber(referenceAmericanOdds)) {
    return fail("referenceAmericanOdds must be a finite number");
  }
  const referenceImpliedProb = data["referenceImpliedProb"];
  if (!isUnitProbability(referenceImpliedProb)) {
    return fail("referenceImpliedProb must be a finite number in (0, 1)");
  }
  const gates = parseGateChecks(data["gates"]);
  if (gates === null) return fail("gates has an invalid shape");
  const createdAt = readIsoTimestamp(data["createdAt"]);
  if (createdAt === null)
    return fail("createdAt must be an ISO-8601 timestamp");
  const createdBy = data["createdBy"];
  if (typeof createdBy !== "string" || createdBy.trim() === "") {
    return fail("createdBy must be a non-empty string");
  }
  const expiresAt = readIsoTimestamp(data["expiresAt"]);
  if (expiresAt === null)
    return fail("expiresAt must be an ISO-8601 timestamp");
  if (Date.parse(expiresAt) < Date.parse(createdAt)) {
    return fail("expiresAt must not precede createdAt");
  }

  return {
    ok: true,
    core: {
      intentId,
      signalId,
      marketKey: signalId,
      side,
      league,
      marketKind,
      teams,
      line,
      sideTeam,
      overUnder,
      fairProb,
      confidence,
      riskUsd,
      distinctAccounts,
      oneSidedShare,
      provenance,
      accounts,
      stakeUsd,
      referenceAmericanOdds,
      referenceImpliedProb,
      gates,
      createdAt,
      createdBy,
      expiresAt,
    },
  };
}

function parsePaperFill(value: unknown): PaperFill | null {
  if (!isRecordValue(value)) return null;
  if (value["venue"] !== "paper") return null;
  const filledAt = readIsoTimestamp(value["filledAt"]);
  const stakeUsd = value["stakeUsd"];
  const effectiveImpliedProb = value["effectiveImpliedProb"];
  const effectiveAmericanOdds = value["effectiveAmericanOdds"];
  const payoutIfWinUsd = value["payoutIfWinUsd"];
  const slippageBps = value["slippageBps"];
  if (
    filledAt === null ||
    !isFiniteNumber(stakeUsd) ||
    stakeUsd <= 0 ||
    !isUnitProbability(effectiveImpliedProb) ||
    !isFiniteNumber(effectiveAmericanOdds) ||
    !isFiniteNumber(payoutIfWinUsd) ||
    payoutIfWinUsd < 0 ||
    !isInteger(slippageBps) ||
    slippageBps < 0 ||
    value["referenceSource"] !== AUTOBET_REFERENCE_SOURCE
  ) {
    return null;
  }
  return {
    venue: "paper",
    filledAt,
    stakeUsd,
    effectiveImpliedProb,
    effectiveAmericanOdds,
    payoutIfWinUsd,
    slippageBps,
    referenceSource: AUTOBET_REFERENCE_SOURCE,
  };
}

function parseSettlement(value: unknown): Settlement | null {
  if (!isRecordValue(value)) return null;
  const result = value["result"];
  const settledAt = readIsoTimestamp(value["settledAt"]);
  const profitUsd = value["profitUsd"];
  const payoutUsd = value["payoutUsd"];
  if (
    (result !== "won" && result !== "lost" && result !== "void") ||
    settledAt === null ||
    !isFiniteNumber(profitUsd) ||
    !isFiniteNumber(payoutUsd) ||
    payoutUsd < 0
  ) {
    return null;
  }
  return { result, settledAt, profitUsd, payoutUsd };
}
