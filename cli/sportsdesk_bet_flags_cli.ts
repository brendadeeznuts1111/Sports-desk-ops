#!/usr/bin/env bun
/**
 * SportsDesk incoming-bet flags CLI — the reference implementation behind the autobet control
 * plane's `Incoming` view.
 *
 * Contract: `Scratch/bet-flags/BUILD-CONTRACT.md` (section "cli/sportsdesk_bet_flags_cli.ts").
 *
 * - commands: rules | scan | explain <ruleId> | locate | alert | alert-log | watch | kalshi | markets | rebet
 * - scan/alert/watch pipeline: fetchIncomingBets -> enrichIncomingBets(--context-window) ->
 *   evaluateBetFlagRules; findings carry the deep market fields and `bet.context` (v2 additive).
 * - clock: an explicit --now is authoritative; otherwise the context window and rule evaluation
 *   anchor at the batch's newest acceptedAt (fallbacks: fetchedAt, wall clock), so capture
 *   fallback batches are not all-zeros just because their rows are minutes old
 * - global flags anywhere: --root/-r, --rules/-R, --json/-j, --now/-n, --help/-h
 * - closed per-command flag specs: an unknown flag is a usage error (exit 2)
 * - `--json` stdout is exactly one object (watch: one object per tick, NDJSON); diagnostics go to
 *   stderr
 * - exit codes: 0 ok, 2 usage_error, 3 refusal
 *   (source_unavailable / rules_invalid / rules_missing / not_found), 1 everything else
 *
 * Read-only over the desk's artifacts. The only writes are the alert dedupe ledger
 * (`Scratch/watchlist-autobet/alert-state.json`, owned by lib/telegram_alert_sender.ts) and the
 * watch tick log (`Scratch/watchlist-autobet/bet-flags-watch.jsonl`). No order path exists.
 *
 * Test seam: `runSportsdeskBetFlagsCli(argv, deps)` injects the incoming-bet fetcher, the alert
 * deliverer and the output writers, so tests exercise the real command surface with no live F402
 * call, no Telegram call and no keychain read. `main()` is the only place that touches
 * process.argv / process.stdout / process.stderr.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  FLAG_SEVERITIES,
  evaluateBetFlagRules,
  loadBetFlagRules,
  type BetFlagFinding,
  type BetFlagRuleSet,
  type FlagSeverity,
  type IncomingBetRecord,
  type IncomingBetSource,
} from "../lib/bet_flags.ts";
import { enrichIncomingBets } from "../lib/bet_context.ts";
import { kalshiArming } from "../lib/autobet_kalshi.ts";
import {
  evaluateRebet,
  type RebetOpportunity,
  type RebetStyle,
} from "../lib/rebet_engine.ts";
import {
  buildAlertPerformance,
  defaultCustomerBookPath,
  loadOutcomeFile,
  outcomesFromCustomerBook,
  type AlertPerformanceReport,
} from "../lib/alert_performance.ts";
import {
  backfillAlertAuditFromActivity,
  chatAlertRollup,
  dailyAlertRollup,
  readAlertAudit,
  readTelegramActivityLog,
  ruleAlertRollup,
  severityAlertRollup,
  summarizeAlertAudit,
  type AlertAuditStatus,
  type TelegramAlertAuditRow,
} from "../lib/telegram_alert_audit.ts";
import {
  appendRebetOpportunities,
  decideRebetOpportunity,
  readRebetLedger,
} from "../lib/rebet_ledger.ts";
import {
  BREAKDOWN_DIMENSIONS,
  buildBetVenueBreakdown,
  groupBetVenueBreakdowns,
  summarizeBetVenueBreakdowns,
  type BetVenueBreakdown,
  type BreakdownDimension,
  type VenueBreakdownResult,
} from "../lib/bet_venue_breakdown.ts";
import type { League } from "../lib/watchlist_signal_engine.ts";
import {
  fetchIncomingBets,
  type IncomingBetsOptions,
  type IncomingBetsResult,
} from "../lib/f402_incoming_bets.ts";
import {
  customerViewForBet,
  resolveCustomerView,
  type CustomerViewResult,
} from "../lib/f402_customer_view.ts";
import { GSLIVE_BET_HISTORY_STATES } from "../lib/gslive_manager_deeplink_sidecar.ts";
import {
  ALERT_STATE_REL_PATH,
  deliverFlagAlerts,
  type AlertRunResult,
  type DeliverFlagAlertsOptions,
} from "../lib/telegram_alert_sender.ts";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_REFUSAL = 3;

export const BET_FLAGS_CLI_SCHEMA_VERSION = 1 as const;
export const DEFAULT_RULES_REL_PATH = "config/bet-flags.yml";
export const WATCH_LOG_REL_PATH =
  "Scratch/watchlist-autobet/bet-flags-watch.jsonl" as const;
const DESK_TIME_ZONE = "America/Chicago";

type RefusalCode =
  | "source_unavailable"
  | "rules_invalid"
  | "rules_missing"
  | "not_found"
  | "kalshi_not_armed";

class CliError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly exitCode: number;

  constructor(
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    exitCode: number = EXIT_ERROR,
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

class CliRefusal extends CliError {
  constructor(
    code: RefusalCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code, message, details, EXIT_REFUSAL);
    this.name = "CliRefusal";
  }
}

/* -------------------------------------------------------------------------- */
/* Test seam                                                                   */
/* -------------------------------------------------------------------------- */

/** Injected collaborators. Production passes none of them; tests pass fakes. */
export interface BetFlagsCliDeps {
  readonly fetchBets?: (
    options: IncomingBetsOptions,
  ) => Promise<IncomingBetsResult>;
  readonly deliverFlagAlerts?: (
    findings: readonly BetFlagFinding[],
    options: DeliverFlagAlertsOptions,
  ) => Promise<AlertRunResult>;
  readonly venueBreakdown?: typeof buildBetVenueBreakdown;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Context and global args                                                     */
/* -------------------------------------------------------------------------- */

interface CliContext {
  readonly root: string;
  readonly rulesPath: string;
  readonly json: boolean;
  readonly now: Date;
  readonly nowFixed: boolean;
  readonly deps: BetFlagsCliDeps;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

interface GlobalArgs {
  readonly root: string;
  readonly rules: string;
  readonly json: boolean;
  readonly now: Date;
  readonly nowFixed: boolean;
  readonly help: boolean;
  readonly command: string | undefined;
  readonly commandArgs: readonly string[];
}

const GLOBAL_VALUE_FLAGS: Readonly<
  Record<string, "--root" | "--rules" | "--now">
> = {
  "--root": "--root",
  "-r": "--root",
  "--rules": "--rules",
  "-R": "--rules",
  "--now": "--now",
  "-n": "--now",
};

function isMissingValue(value: string | undefined): boolean {
  return value === undefined || value === "" || value.startsWith("-");
}

interface Writer {
  readonly json: boolean;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

type GlobalParseResult =
  | { readonly ok: true; readonly value: GlobalArgs }
  | {
      readonly ok: false;
      readonly error: CliError;
      readonly writer: Writer;
    };

function parseGlobalArgs(argv: readonly string[]): GlobalParseResult {
  let root = process.cwd();
  let rules = DEFAULT_RULES_REL_PATH;
  let json = false;
  let now = new Date();
  let nowFixed = false;
  let help = false;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) break;
    if (token === "--json" || token === "-j") {
      json = true;
      continue;
    }
    if (token === "-h" || token === "--help") {
      help = true;
      continue;
    }
    const equalsIndex = token.startsWith("-") ? token.indexOf("=") : -1;
    const rawFlag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    const canonical = GLOBAL_VALUE_FLAGS[rawFlag];
    if (canonical !== undefined) {
      let value: string | undefined =
        equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
      if (value === undefined) {
        const next = argv[index + 1];
        if (isMissingValue(next)) {
          return {
            ok: false,
            writer: { json, out: writeToStdout, err: writeToStderr },
            error: new CliError(
              "usage_error",
              `missing value for ${rawFlag}`,
              {},
              EXIT_USAGE,
            ),
          };
        }
        value = next as string;
        index += 1;
      }
      if (canonical === "--root") {
        root = resolve(value);
      } else if (canonical === "--rules") {
        rules = value;
      } else {
        const parsed = new Date(value);
        if (!Number.isFinite(parsed.getTime())) {
          return {
            ok: false,
            writer: { json, out: writeToStdout, err: writeToStderr },
            error: new CliError(
              "usage_error",
              `--now must be an ISO-8601 timestamp, got "${value}"`,
              {},
              EXIT_USAGE,
            ),
          };
        }
        now = parsed;
        nowFixed = true;
      }
      continue;
    }
    rest.push(token);
  }
  return {
    ok: true,
    value: {
      root,
      rules,
      json,
      now,
      nowFixed,
      help,
      command: rest[0],
      commandArgs: rest.slice(1),
    },
  };
}

function resolveFromRoot(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

function writeToStdout(text: string): void {
  process.stdout.write(text);
}

function writeToStderr(text: string): void {
  process.stderr.write(text);
}

/* -------------------------------------------------------------------------- */
/* Output (single JSON object on stdout; diagnostics on stderr)               */
/* -------------------------------------------------------------------------- */

function serializeBody(
  body: Readonly<Record<string, unknown>>,
  pretty: boolean,
): string {
  return pretty
    ? `${JSON.stringify(body, null, 2)}\n`
    : `${JSON.stringify(body)}\n`;
}

function emitSuccess(
  context: CliContext,
  command: string,
  payload: Readonly<Record<string, unknown>>,
  generatedAt: Date = context.now,
): number {
  const body = {
    ...payload,
    success: true,
    schemaVersion: BET_FLAGS_CLI_SCHEMA_VERSION,
    command,
    generatedAt: generatedAt.toISOString(),
  };
  context.out(serializeBody(body, !context.json));
  return EXIT_OK;
}

function emitFailure(
  writer: Writer,
  command: string,
  error: CliError,
  generatedAt: Date,
): number {
  const body = {
    success: false,
    schemaVersion: BET_FLAGS_CLI_SCHEMA_VERSION,
    command,
    generatedAt: generatedAt.toISOString(),
    error: {
      code: error.code,
      message: error.message,
      ...(Object.keys(error.details).length === 0
        ? {}
        : { details: error.details }),
    },
  };
  writer.out(serializeBody(body, !writer.json));
  writer.err(`${error.code}: ${error.message}\n`);
  return error.exitCode;
}

/* -------------------------------------------------------------------------- */
/* Command flag parsing (closed specs; unknown flag = usage_error)            */
/* -------------------------------------------------------------------------- */

interface CommandFlags {
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

interface FlagSpec {
  readonly valueFlags?: readonly string[];
  readonly switchFlags?: readonly string[];
  readonly shortAliases?: Readonly<Record<string, string>>;
}

function helpHint(command: string): string {
  return `run \`bun run cli/sportsdesk_bet_flags_cli.ts ${command} --help\` for flags`;
}

function usageError(command: string, message: string): never {
  throw new CliError("usage_error", `${command}: ${message}`, {}, EXIT_USAGE);
}

function parseCommandFlags(
  command: string,
  tokens: readonly string[],
  spec: FlagSpec = {},
): CommandFlags {
  const valued = new Set(spec.valueFlags ?? []);
  const switches = new Set(spec.switchFlags ?? []);
  const aliases = spec.shortAliases ?? {};
  const values = new Map<string, string>();
  const switchSet = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) break;
    if (token === "--") {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    const equalsIndex = token.startsWith("-") ? token.indexOf("=") : -1;
    const rawFlag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    if (rawFlag.startsWith("-")) {
      let flagName = rawFlag;
      if (!rawFlag.startsWith("--")) {
        const alias = aliases[rawFlag];
        if (alias === undefined) {
          usageError(command, `unknown flag ${rawFlag}; ${helpHint(command)}`);
        }
        flagName = alias;
      }
      if (valued.has(flagName)) {
        let value =
          equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
        if (value === undefined) {
          const next = tokens[index + 1];
          if (isMissingValue(next)) {
            usageError(command, `missing value for ${flagName}`);
          }
          value = next as string;
          index += 1;
        }
        values.set(flagName, value);
        continue;
      }
      if (equalsIndex !== -1) {
        usageError(command, `flag ${flagName} does not take a value`);
      }
      if (!switches.has(flagName)) {
        usageError(command, `unknown flag ${flagName}; ${helpHint(command)}`);
      }
      switchSet.add(flagName);
      continue;
    }
    positionals.push(token);
  }
  return { values, switches: switchSet, positionals };
}

function assertNoPositionals(command: string, flags: CommandFlags): void {
  const [extra] = flags.positionals;
  if (extra !== undefined) {
    usageError(command, `unexpected argument: ${extra}`);
  }
}

function requireSinglePositional(
  command: string,
  flags: CommandFlags,
  label: string,
): string {
  const [first, ...rest] = flags.positionals;
  if (first === undefined) usageError(command, `missing ${label}`);
  if (rest.length > 0) usageError(command, `unexpected argument: ${rest[0]}`);
  return first;
}

function integerFlag(
  command: string,
  flags: CommandFlags,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = flags.values.get(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    usageError(command, `${name} must be an integer in [${min}, ${max}]`);
  }
  return parsed;
}

function isSeverity(value: string): value is FlagSeverity {
  return (FLAG_SEVERITIES as readonly string[]).includes(value);
}

function severityFlag(
  command: string,
  flags: CommandFlags,
  name: string,
  fallback: FlagSeverity,
): FlagSeverity {
  const raw = flags.values.get(name);
  if (raw === undefined) return fallback;
  if (!isSeverity(raw)) {
    usageError(
      command,
      `${name} must be one of ${FLAG_SEVERITIES.join(", ")}, got "${raw}"`,
    );
  }
  return raw;
}

function severityRank(severity: FlagSeverity): number {
  return FLAG_SEVERITIES.indexOf(severity);
}

function sourceFlag(
  command: string,
  flags: CommandFlags,
): "live" | "auto" | "file" {
  const raw = flags.values.get("--source");
  if (raw === undefined) return "auto";
  if (raw !== "live" && raw !== "auto" && raw !== "file") {
    usageError(
      command,
      `--source must be one of live, auto, file, got "${raw}"`,
    );
  }
  return raw;
}

/** `--file <capture.json>`: the recorded getBetTicker body for `--source file`. */
function captureFileFlag(flags: CommandFlags): string | undefined {
  const raw = flags.values.get("--file");
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function agentFlag(flags: CommandFlags): string | undefined {
  const raw = flags.values.get("--agent");
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/* -------------------------------------------------------------------------- */
/* Shared scan planning                                                       */
/* -------------------------------------------------------------------------- */

const DEFAULT_CONTEXT_WINDOW_SECONDS = 300;
const MIN_CONTEXT_WINDOW_SECONDS = 1;
const MAX_CONTEXT_WINDOW_SECONDS = 3600;

const SCAN_VALUE_FLAGS: readonly string[] = [
  "--source",
  "--file",
  "--agent",
  "--limit",
  "--min-severity",
  "--max-findings",
  "--context-window",
];

interface ScanOptions {
  readonly source: "live" | "auto" | "file";
  /** Capture path when `source` is `file`; validated by `scanOptions`. */
  readonly file: string | undefined;
  readonly agentId: string | undefined;
  readonly limit: number;
  readonly minSeverity: FlagSeverity;
  readonly maxFindings: number;
  /** Window (seconds) for `enrichIncomingBets` baselines; 1..3600, default 300. */
  readonly contextWindow: number;
}

function contextWindowFlag(command: string, flags: CommandFlags): number {
  return integerFlag(
    command,
    flags,
    "--context-window",
    DEFAULT_CONTEXT_WINDOW_SECONDS,
    MIN_CONTEXT_WINDOW_SECONDS,
    MAX_CONTEXT_WINDOW_SECONDS,
  );
}

function scanOptions(command: string, flags: CommandFlags): ScanOptions {
  const source = sourceFlag(command, flags);
  const file = captureFileFlag(flags);
  if (source === "file" && file === undefined) {
    usageError(
      command,
      "--source file requires --file <capture.json> (a recorded getBetTicker body)",
    );
  }
  return {
    source,
    file,
    agentId: agentFlag(flags),
    limit: integerFlag(command, flags, "--limit", 100, 1, 500),
    minSeverity: severityFlag(command, flags, "--min-severity", "info"),
    maxFindings: integerFlag(command, flags, "--max-findings", 200, 1, 1000),
    contextWindow: contextWindowFlag(command, flags),
  };
}

function deskDateYmd(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DESK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const valueOf = (type: "year" | "month" | "day"): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${valueOf("year")}-${valueOf("month")}-${valueOf("day")}`;
}

function currentNow(context: CliContext): Date {
  return context.nowFixed ? context.now : new Date();
}

async function loadRulesOrRefuse(
  context: CliContext,
  command: string,
): Promise<BetFlagRuleSet> {
  const loaded = await loadBetFlagRules(context.rulesPath);
  if (loaded.ok) return loaded.ruleSet;
  throw new CliRefusal(
    loaded.code === "rules_invalid" ? "rules_invalid" : "rules_missing",
    `${command}: ${loaded.code} at ${loaded.path}: ${loaded.message}`,
    {
      path: loaded.path,
      errors: loaded.errors,
      ...(loaded.code === "rules_unreadable" ? { loadCode: loaded.code } : {}),
    },
  );
}

async function fetchBetsFor(
  context: CliContext,
  options: {
    readonly source: "live" | "auto" | "file";
    readonly file?: string | undefined;
    readonly agentId: string | undefined;
    readonly limit: number;
  },
  now: Date,
): Promise<IncomingBetsResult> {
  const fetchFn = context.deps.fetchBets ?? fetchIncomingBets;
  return fetchFn({
    source: options.source,
    limit: options.limit,
    now,
    rootDir: context.root,
    ...(options.file === undefined ? {} : { file: options.file }),
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
  });
}

interface ScanRun {
  readonly ruleSet: BetFlagRuleSet;
  readonly result: IncomingBetsResult;
  readonly findings: readonly BetFlagFinding[];
  readonly evaluated: number;
  readonly skippedDisabled: number;
  /** The instant the context window and rule evaluation were anchored at. */
  readonly now: Date;
}

/**
 * Clock used for the context window and rule evaluation (`aggregate.windowSeconds`, `ageSeconds`
 * rules). An explicit `--now` is authoritative. Without it, a capture-fallback batch is anchored
 * at its newest `acceptedAt`: wall clock would put a 20-minute-old capture outside every window,
 * making `bet.context` and any time-windowed rule read as zeros/dead. A live ticker batch anchors
 * to its newest row, which is within seconds of wall clock. Falls back to `result.fetchedAt`, then
 * the caller's clock, when no row carries a parseable `acceptedAt`.
 */
function batchAnchor(
  context: CliContext,
  rows: readonly IncomingBetRecord[],
  fetchedAtIso: string,
  fallback: Date,
): Date {
  if (context.nowFixed) return context.now;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const acceptedMs = Date.parse(row.acceptedAt);
    if (Number.isFinite(acceptedMs) && acceptedMs > newestMs)
      newestMs = acceptedMs;
  }
  if (newestMs !== Number.NEGATIVE_INFINITY) return new Date(newestMs);
  const fetchedMs = Date.parse(fetchedAtIso);
  if (Number.isFinite(fetchedMs)) return new Date(fetchedMs);
  return fallback;
}

async function runScan(
  context: CliContext,
  command: string,
  options: ScanOptions,
  now: Date = context.now,
): Promise<ScanRun> {
  // Rules load first: a broken pack is a rules refusal, not a fabricated empty finding list.
  const ruleSet = await loadRulesOrRefuse(context, command);
  const result = await fetchBetsFor(context, options, now);
  if (!result.ok) {
    throw new CliRefusal(
      "source_unavailable",
      `${command}: incoming-bet source unavailable (${result.diagnostic.code})`,
      { source: result.source, diagnostic: result.diagnostic },
    );
  }
  // v2 depth: every finding's `bet` carries the structured market fields and `bet.context`
  // baselines computed over the fetched batch for this window. Without an explicit --now the
  // batch's newest acceptedAt is the anchor, so stale captures still have live window counts.
  const anchor = batchAnchor(context, result.rows, result.fetchedAt, now);
  const enriched = enrichIncomingBets(result.rows, {
    windowSeconds: options.contextWindow,
    now: anchor,
  });
  const evaluation = evaluateBetFlagRules(enriched, ruleSet.rules, {
    now: anchor,
  });
  return {
    ruleSet,
    result,
    findings: evaluation.findings,
    evaluated: evaluation.evaluated,
    skippedDisabled: evaluation.skippedDisabled,
    now: anchor,
  };
}

function selectFindings(
  findings: readonly BetFlagFinding[],
  minSeverity: FlagSeverity,
  maxFindings: number,
): readonly BetFlagFinding[] {
  const minimum = severityRank(minSeverity);
  return findings
    .filter((finding) => severityRank(finding.severity) >= minimum)
    .slice(0, maxFindings);
}

function serializeFinding(
  finding: BetFlagFinding,
  now: Date,
): Readonly<Record<string, unknown>> {
  let customerView: Readonly<Record<string, unknown>>;
  try {
    const view: CustomerViewResult = customerViewForBet(finding.bet, {
      dateYmd: deskDateYmd(now),
    });
    customerView = {
      customerId: view.customerId,
      gsLivePlayerId: view.links.gsLivePlayerId,
      betHistoryUrl: view.links.betHistoryUrl,
    };
  } catch (error) {
    // A malformed row must not blank the whole scan: the finding is still reported with empty
    // link fields and an explicit unavailableReason instead of fabricated URLs.
    const message = error instanceof Error ? error.message : String(error);
    customerView = {
      customerId: finding.bet.customerId,
      gsLivePlayerId: "",
      betHistoryUrl: "",
      unavailableReason: message,
    };
  }
  return {
    ruleId: finding.ruleId,
    ruleTitle: finding.ruleTitle,
    severity: finding.severity,
    matchedAt: finding.matchedAt,
    dedupeKey: finding.dedupeKey,
    bet: finding.bet,
    evidence: finding.evidence,
    customerView,
  };
}

function bySeverityCounts(
  findings: readonly BetFlagFinding[],
): Record<FlagSeverity, number> {
  const counts: Record<FlagSeverity, number> = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function sourceBlock(
  result: IncomingBetsResult,
): Readonly<Record<string, unknown>> {
  return {
    kind: result.source,
    transport:
      result.diagnostic.code === "ok" ? result.diagnostic.transport : null,
    fetchedAt: result.fetchedAt,
    agentId: result.agentId,
  };
}

function rulesBlock(
  ruleSet: BetFlagRuleSet,
): Readonly<Record<string, unknown>> {
  return { path: ruleSet.path, count: ruleSet.rules.length, errors: [] };
}

function scanPayload(
  run: ScanRun,
  selected: readonly BetFlagFinding[],
): Readonly<Record<string, unknown>> {
  return {
    rules: rulesBlock(run.ruleSet),
    source: sourceBlock(run.result),
    counts: {
      rows: run.result.rows.length,
      findings: selected.length,
      rulesEvaluated: run.evaluated,
      bySeverity: bySeverityCounts(selected),
    },
    findings: selected.map((finding) => serializeFinding(finding, run.now)),
    diagnostic: run.result.diagnostic,
  };
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

async function cmdRules(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("rules", tokens);
  assertNoPositionals("rules", flags);
  const ruleSet = await loadRulesOrRefuse(context, "rules");
  const payload = {
    path: ruleSet.path,
    count: ruleSet.rules.length,
    rules: ruleSet.rules,
    errors: [],
  };
  return emitSuccess(context, "rules", payload);
}

async function cmdExplain(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("explain", tokens);
  const ruleId = requireSinglePositional("explain", flags, "ruleId");
  const ruleSet = await loadRulesOrRefuse(context, "explain");
  const rule = ruleSet.rules.find((candidate) => candidate.id === ruleId);
  if (rule === undefined) {
    throw new CliRefusal(
      "not_found",
      `explain: no rule with id "${ruleId}" in ${ruleSet.path}`,
      { ruleId, path: ruleSet.path, ruleIds: ruleSet.rules.map((r) => r.id) },
    );
  }
  return emitSuccess(context, "explain", { rule });
}

async function cmdScan(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("scan", tokens, {
    valueFlags: SCAN_VALUE_FLAGS,
  });
  assertNoPositionals("scan", flags);
  const options = scanOptions("scan", flags);
  const run = await runScan(context, "scan", options);
  const selected = selectFindings(
    run.findings,
    options.minSeverity,
    options.maxFindings,
  );
  return emitSuccess(context, "scan", scanPayload(run, selected));
}

async function cmdAlert(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("alert", tokens, {
    valueFlags: [
      "--source",
      "--file",
      "--agent",
      "--limit",
      "--max-findings",
      "--chat-id",
      "--state",
      "--min-severity",
      "--max-messages",
      "--context-window",
    ],
    switchFlags: ["--dry-run"],
  });
  assertNoPositionals("alert", flags);
  const dryRun = flags.switches.has("--dry-run");
  const source = sourceFlag("alert", flags);
  const agentId = agentFlag(flags);
  const limit = integerFlag("alert", flags, "--limit", 100, 1, 500);
  const maxFindings = integerFlag(
    "alert",
    flags,
    "--max-findings",
    200,
    1,
    1000,
  );
  const minSeverity = severityFlag("alert", flags, "--min-severity", "medium");
  const maxMessages = integerFlag("alert", flags, "--max-messages", 1, 1, 20);
  const chatId = flags.values.get("--chat-id");
  const stateRaw = flags.values.get("--state");
  const statePath =
    stateRaw === undefined
      ? join(context.root, ALERT_STATE_REL_PATH)
      : resolveFromRoot(context.root, stateRaw);

  const options: ScanOptions = {
    source,
    file: captureFileFlag(flags),
    agentId,
    limit,
    minSeverity: "info",
    maxFindings,
    contextWindow: contextWindowFlag("alert", flags),
  };
  const run = await runScan(context, "alert", options, context.now);
  const findings = run.findings.slice(0, maxFindings);
  const deliver = context.deps.deliverFlagAlerts ?? deliverFlagAlerts;
  const chatLabel = (Bun.env.TELEGRAM_CHAT_LABEL ?? "").trim();
  const delivery = await deliver(findings, {
    dryRun,
    statePath,
    minSeverity,
    maxMessages,
    now: context.now,
    audit: {
      root: context.root,
      ...(chatLabel === "" ? {} : { chatLabel }),
    },
    ...(chatId === undefined ? {} : { chatId }),
  });
  if (!delivery.ok) {
    throw new CliError(
      "alert_delivery_failed",
      delivery.reason ?? "alert delivery failed",
      {
        scan: { rows: run.result.rows.length, findings },
        deliveries: delivery.deliveries,
        summary: delivery.summary,
      },
      EXIT_ERROR,
    );
  }
  const payload = {
    scan: { rows: run.result.rows.length, findings: findings.length },
    deliveries: delivery.deliveries,
    summary: delivery.summary,
  };
  return emitSuccess(context, "alert", payload);
}

async function cmdKalshi(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("kalshi", tokens);
  assertNoPositionals("kalshi", flags);
  const arming = await kalshiArming({ env: Bun.env });
  if (!arming.armed) {
    throw new CliRefusal(
      "kalshi_not_armed",
      `kalshi: live placement is not armed (${arming.blockingReasons.join("; ")})`,
      { arming: arming as unknown as Record<string, unknown> },
    );
  }
  return emitSuccess(
    context,
    "kalshi",
    arming as unknown as Record<string, unknown>,
  );
}

const VENUE_BETS_MAX = 50;

function parseVenues(
  command: string,
  raw: string | undefined,
): readonly ("kalshi" | "polymarket")[] {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "both") {
    return ["kalshi", "polymarket"];
  }
  const out: ("kalshi" | "polymarket")[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim().toLowerCase();
    if (token === "") continue;
    if (token !== "kalshi" && token !== "polymarket") {
      usageError(
        command,
        `--venues must be kalshi, polymarket, a comma list of them, or both; got "${part.trim()}"`,
      );
    }
    if (!out.includes(token)) out.push(token);
  }
  if (out.length === 0) usageError(command, "--venues selected no venue");
  return out;
}

function parseLeague(
  command: string,
  raw: string | undefined,
): League | undefined {
  if (raw === undefined) return undefined;
  const token = raw.trim().toUpperCase();
  const allowed: readonly League[] = ["NBA", "NFL", "CFB", "EPL", "NHL", "MLB"];
  if (!(allowed as readonly string[]).includes(token)) {
    usageError(command, `--league must be one of ${allowed.join(", ")}`);
  }
  return token as League;
}

function percentText(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function marketLabel(breakdown: BetVenueBreakdown): string {
  const line = breakdown.line === null ? "" : ` ${breakdown.line}`;
  const period =
    breakdown.periodLabel === "" ? "" : ` · ${breakdown.periodLabel}`;
  return `${breakdown.marketType}${line}${period}`;
}

function kalshiLabel(view: BetVenueBreakdown["kalshi"]): string {
  if (!view.available) return `— (${view.reason ?? view.verdict})`;
  const depth =
    view.liquidity === null
      ? ""
      : ` · ${view.liquidity.spreadCents ?? "?"}c · ${view.liquidity.depthContracts} ctr`;
  return `${view.marketTicker ?? "?"} ${view.side ?? "?"} @ ${percentText(view.price)}${depth}`;
}

function polymarketLabel(view: BetVenueBreakdown["polymarket"]): string {
  if (!view.available) return `— (${view.reason ?? "unavailable"})`;
  const outcomes = view.outcomes
    .map((outcome) => {
      const price = outcome.bestAsk ?? outcome.bestBid;
      return `${outcome.name} ${percentText(price)}`;
    })
    .join(" / ");
  return `${view.question ?? view.marketId ?? "?"} — ${outcomes}`;
}

const DIMENSION_ALIASES: Readonly<Record<string, BreakdownDimension>> = {
  sport: "sport",
  sports: "sport",
  league: "league",
  subsport: "subsport",
  "sub-sport": "subsport",
  period: "period",
  periods: "period",
  market: "market",
  markets: "market",
  markettype: "markettype",
  "market-type": "markettype",
};

function parseGroupBy(
  command: string,
  raw: string | undefined,
): readonly BreakdownDimension[] {
  if (raw === undefined) return [];
  const out: BreakdownDimension[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim().toLowerCase();
    if (token === "") continue;
    const dimension = DIMENSION_ALIASES[token];
    if (dimension === undefined) {
      usageError(
        command,
        `--group-by must be a comma list of ${BREAKDOWN_DIMENSIONS.join(", ")}; got "${part.trim()}"`,
      );
    }
    if (!out.includes(dimension)) out.push(dimension);
  }
  if (out.length === 0) usageError(command, "--group-by selected no dimension");
  return out;
}

async function cmdMarkets(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("markets", tokens, {
    valueFlags: [
      ...SCAN_VALUE_FLAGS,
      "--venues",
      "--max-bets",
      "--league",
      "--group-by",
    ],
    switchFlags: ["--all"],
  });
  assertNoPositionals("markets", flags);
  const options = scanOptions("markets", flags);
  const venues = parseVenues("markets", flags.values.get("--venues"));
  const maxBets = integerFlag(
    "markets",
    flags,
    "--max-bets",
    5,
    1,
    VENUE_BETS_MAX,
  );
  const leagueOverride = parseLeague("markets", flags.values.get("--league"));
  const dimensions = parseGroupBy("markets", flags.values.get("--group-by"));
  const includeAll = flags.switches.has("--all");

  const run = await runScan(context, "markets", options);
  const findings = selectFindings(
    run.findings,
    options.minSeverity,
    options.maxFindings,
  );
  const records = includeAll ? run.result.rows : findings.map((f) => f.bet);
  const build = context.deps.venueBreakdown ?? buildBetVenueBreakdown;
  const result: VenueBreakdownResult = await build(records, {
    venues,
    maxBets,
    now: run.now,
    ...(leagueOverride === undefined ? {} : { leagueOverride }),
  });

  const matchedKalshi = result.breakdowns.filter(
    (row) => row.kalshi.available,
  ).length;
  const matchedPolymarket = result.breakdowns.filter(
    (row) => row.polymarket.available,
  ).length;
  const payload = {
    source: {
      kind: run.result.source,
      transport:
        run.result.diagnostic.code === "ok"
          ? run.result.diagnostic.transport
          : run.result.diagnostic.code,
      fetchedAt: run.result.fetchedAt,
    },
    counts: {
      bets: result.breakdowns.length,
      refusals: result.refusals.length,
      kalshiMatched: matchedKalshi,
      polymarketMatched: matchedPolymarket,
      bothMatched: result.breakdowns.filter(
        (row) => row.kalshi.available && row.polymarket.available,
      ).length,
      venues,
      includeAll,
    },
    note:
      result.breakdowns.length === 0
        ? includeAll
          ? "the source returned no rows"
          : "no finding matched the selected severity; pass --all to match every fetched row"
        : null,
    dimensions,
    groups:
      dimensions.length === 0
        ? null
        : summarizeBetVenueBreakdowns(result.breakdowns, dimensions),
    tree:
      dimensions.length === 0
        ? null
        : groupBetVenueBreakdowns(result.breakdowns, dimensions),
    breakdowns: result.breakdowns,
    refusals: result.refusals,
    telemetry: result.telemetry,
  };

  if (context.json) {
    return emitSuccess(context, "markets", payload);
  }
  const table = Bun.inspect.table(
    result.breakdowns.map((row) => ({
      bet: row.betKey,
      sport: [row.sport, row.subSport, row.periodLabel || row.period]
        .filter((part) => part !== "")
        .join(" · "),
      event: row.eventLabel,
      market: marketLabel(row),
      side: row.side ?? "—",
      kalshi: kalshiLabel(row.kalshi),
      polymarket: polymarketLabel(row.polymarket),
    })),
    { colors: false },
  );
  const lines = [
    table.trimEnd(),
    `${result.breakdowns.length} bets · kalshi ${matchedKalshi} · polymarket ${matchedPolymarket} · refusals ${result.refusals.length}`,
    payload.note === null ? "" : payload.note,
  ];
  for (const dimension of dimensions) {
    const groups = summarizeBetVenueBreakdowns(result.breakdowns, [dimension]);
    lines.push(
      "",
      `— by ${dimension} —`,
      Bun.inspect
        .table(
          groups.map((group) => ({
            value: group.value,
            bets: group.bets,
            kalshi: group.kalshiMatched,
            polymarket: group.polymarketMatched,
            both: group.bothMatched,
            "avg kalshi":
              group.avgKalshiPrice === null
                ? "—"
                : `${(group.avgKalshiPrice * 100).toFixed(1)}%`,
            "avg spread":
              group.avgKalshiSpreadCents === null
                ? "—"
                : `${group.avgKalshiSpreadCents}c`,
            "kalshi depth": group.totalKalshiDepthContracts,
            stake: group.totalStakeUsd,
          })),
          { colors: false },
        )
        .trimEnd(),
    );
  }
  lines.push(`Source: ${payload.source.kind} via ${payload.source.transport}`);
  if (dimensions.length > 0) {
    lines.splice(1, 0, `grouped by ${dimensions.join(" → ")}`);
  }
  context.out(lines.filter((line) => line !== "").join("\n"));
  return EXIT_OK;
}

const REBET_DEFAULTS = {
  minEdgeBps: 100,
  makerMarginBps: 150,
  stakeUsd: 100,
  maxBets: 5,
  intervalSeconds: 60,
} as const;

function parseRebetStyles(
  command: string,
  raw: string | undefined,
): readonly RebetStyle[] {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "both") {
    return ["taker", "maker"];
  }
  const styles: RebetStyle[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim().toLowerCase();
    if (token === "") continue;
    if (token !== "taker" && token !== "maker") {
      usageError(
        command,
        `--style must be both, taker, maker or a comma list of them; got "${part.trim()}"`,
      );
    }
    if (!styles.includes(token)) styles.push(token);
  }
  if (styles.length === 0) usageError(command, "--style selected no style");
  return styles;
}

interface RebetFlags {
  readonly scan: ScanOptions;
  readonly styles: readonly RebetStyle[];
  readonly minEdgeBps: number;
  readonly makerMarginBps: number;
  readonly stakeUsd: number;
  readonly maxBets: number;
  readonly intervalSeconds: number;
  readonly paper: boolean;
  readonly watch: boolean;
  readonly maxTicks: number;
}

function rebetFlags(flags: CommandFlags): RebetFlags {
  return {
    scan: scanOptions("rebet", flags),
    styles: parseRebetStyles("rebet", flags.values.get("--style")),
    minEdgeBps: integerFlag(
      "rebet",
      flags,
      "--min-edge-bps",
      REBET_DEFAULTS.minEdgeBps,
      0,
      5_000,
    ),
    makerMarginBps: integerFlag(
      "rebet",
      flags,
      "--maker-margin-bps",
      REBET_DEFAULTS.makerMarginBps,
      0,
      2_000,
    ),
    stakeUsd: integerFlag(
      "rebet",
      flags,
      "--stake",
      REBET_DEFAULTS.stakeUsd,
      1,
      100_000,
    ),
    maxBets: integerFlag(
      "rebet",
      flags,
      "--max-bets",
      REBET_DEFAULTS.maxBets,
      1,
      50,
    ),
    intervalSeconds: integerFlag(
      "rebet",
      flags,
      "--interval",
      REBET_DEFAULTS.intervalSeconds,
      15,
      86_400,
    ),
    paper: flags.switches.has("--paper"),
    watch: flags.switches.has("--watch"),
    maxTicks: integerFlag("rebet", flags, "--max-ticks", 0, 0, 10_000),
  };
}

interface RebetTickPayload {
  readonly success: true;
  readonly command: "rebet";
  readonly generatedAt: string;
  readonly source: { readonly kind: string; readonly fetchedAt: string };
  readonly options: {
    readonly styles: readonly RebetStyle[];
    readonly minEdgeBps: number;
    readonly makerMarginBps: number;
    readonly stakeUsd: number;
  };
  readonly counts: {
    readonly bets: number;
    readonly opportunities: number;
    readonly rejections: number;
    readonly recorded: number;
    readonly skipped: number;
  };
  readonly opportunities: readonly RebetOpportunity[];
  readonly rejections: readonly {
    readonly betKey: string;
    readonly venue: string;
    readonly style: string;
    readonly reason: string;
  }[];
}

async function rebetTick(
  context: CliContext,
  options: RebetFlags,
): Promise<RebetTickPayload> {
  const now = currentNow(context);
  const fetched = await fetchBetsFor(
    context,
    {
      source: options.scan.source,
      file: options.scan.file,
      agentId: options.scan.agentId,
      limit: options.scan.limit,
    },
    now,
  );
  if (!fetched.ok) {
    throw new CliRefusal(
      "source_unavailable",
      `rebet: incoming-bet source unavailable (${fetched.diagnostic.code})`,
      { source: fetched.source, diagnostic: fetched.diagnostic },
    );
  }
  const build = context.deps.venueBreakdown ?? buildBetVenueBreakdown;
  const breakdown = await build(fetched.rows, {
    venues: ["kalshi", "polymarket"],
    maxBets: options.maxBets,
    now,
  });
  const evaluation = evaluateRebet(breakdown.breakdowns, {
    styles: options.styles,
    minEdgeBps: options.minEdgeBps,
    makerMarginBps: options.makerMarginBps,
    stakeUsd: options.stakeUsd,
  });
  let recorded = 0;
  let skipped = 0;
  if (options.paper) {
    const appended = await appendRebetOpportunities(
      context.root,
      evaluation.opportunities,
      { now },
    );
    recorded = appended.written;
    skipped = appended.skipped;
  }
  return {
    success: true,
    command: "rebet",
    generatedAt: now.toISOString(),
    source: { kind: fetched.source, fetchedAt: fetched.fetchedAt },
    options: {
      styles: options.styles,
      minEdgeBps: options.minEdgeBps,
      makerMarginBps: options.makerMarginBps,
      stakeUsd: options.stakeUsd,
    },
    counts: {
      bets: breakdown.breakdowns.length,
      opportunities: evaluation.opportunities.length,
      rejections: evaluation.rejections.length,
      recorded,
      skipped,
    },
    opportunities: evaluation.opportunities,
    rejections: evaluation.rejections,
  };
}

function printRebetHuman(
  payload: RebetTickPayload,
  out: (text: string) => void,
): void {
  const lines: string[] = [];
  lines.push(
    `rebet: ${payload.counts.bets} bet(s) · ${payload.counts.opportunities} opportunit(ies) · ${payload.counts.rejections} rejection(s)` +
      (payload.counts.recorded > 0
        ? ` · recorded ${payload.counts.recorded} pending`
        : ""),
  );
  if (payload.opportunities.length > 0) {
    lines.push(
      Bun.inspect
        .table(
          payload.opportunities.map((opportunity) => ({
            bet: opportunity.betKey,
            venue: opportunity.venue,
            style: opportunity.style,
            fair: `${(opportunity.fairProb * 100).toFixed(1)}%`,
            price: `${(opportunity.venuePrice * 100).toFixed(1)}%`,
            edge: `${opportunity.edgeBps} bps`,
            stake: `$${opportunity.stakeUsd}`,
            market: opportunity.marketTicker ?? opportunity.polyMarketId ?? "—",
          })),
          { colors: false },
        )
        .trimEnd(),
    );
  }
  const reasons = new Map<string, number>();
  for (const rejection of payload.rejections) {
    reasons.set(rejection.reason, (reasons.get(rejection.reason) ?? 0) + 1);
  }
  if (reasons.size > 0) {
    lines.push(
      `rejections: ${[...reasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${reason}×${count}`)
        .join(" · ")}`,
    );
  }
  lines.push(`source: ${payload.source.kind} @ ${payload.source.fetchedAt}`);
  out(lines.join("\n"));
}

async function cmdRebet(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("rebet", tokens, {
    valueFlags: [
      ...SCAN_VALUE_FLAGS,
      "--style",
      "--min-edge-bps",
      "--maker-margin-bps",
      "--stake",
      "--max-bets",
      "--interval",
      "--max-ticks",
      "--approve",
      "--reject",
      "--actor",
      "--reason",
    ],
    switchFlags: ["--paper", "--watch", "--list"],
  });
  assertNoPositionals("rebet", flags);
  const options = rebetFlags(flags);
  const approve = flags.values.get("--approve");
  const reject = flags.values.get("--reject");
  const actor = flags.values.get("--actor");
  const reason = flags.values.get("--reason");
  const list = flags.switches.has("--list");
  if (approve !== undefined && reject !== undefined) {
    usageError("rebet", "--approve and --reject are mutually exclusive");
  }
  if (list) {
    const state = await readRebetLedger(context.root);
    const rows = [...state.opportunities.entries()].map(([id, entry]) => ({
      id,
      status: entry.status,
      betKey: entry.opportunity.betKey,
      venue: entry.opportunity.venue,
      style: entry.opportunity.style,
      edgeBps: entry.opportunity.edgeBps,
      stakeUsd: entry.opportunity.stakeUsd,
      decidedBy: entry.decidedBy ?? null,
      reason: entry.reason ?? null,
    }));
    const payload = {
      success: true,
      command: "rebet",
      list: rows,
      counts: {
        total: rows.length,
        pending: rows.filter((row) => row.status === "pending").length,
        approved: rows.filter((row) => row.status === "approved").length,
        rejected: rows.filter((row) => row.status === "rejected").length,
      },
    };
    if (context.json) {
      return emitSuccess(
        context,
        "rebet",
        payload as unknown as Record<string, unknown>,
      );
    }
    context.out(
      rows.length === 0
        ? "rebet: no recorded opportunities"
        : rows
            .map(
              (row) =>
                `${row.id} · ${row.status} · ${row.venue}/${row.style} · ${row.edgeBps} bps`,
            )
            .join("\n"),
    );
    return EXIT_OK;
  }
  const decisionAction =
    approve === undefined && reject === undefined
      ? null
      : approve !== undefined
        ? "approve"
        : "reject";
  if (decisionAction !== null) {
    if (actor === undefined || actor.trim() === "") {
      usageError("rebet", "--actor <name> is required with --approve/--reject");
    }
    try {
      const decided = await decideRebetOpportunity(context.root, {
        opportunityId: approve ?? reject ?? "",
        action: decisionAction,
        actor,
        ...(reason === undefined ? {} : { reason }),
      });
      const payload = {
        success: true,
        command: "rebet",
        decision: decided.decision,
        fill: decided.fill,
      };
      if (context.json) {
        return emitSuccess(
          context,
          "rebet",
          payload as unknown as Record<string, unknown>,
        );
      }
      context.out(
        `${decisionAction === "approve" ? "approved" : "rejected"} ${approve ?? reject ?? ""}` +
          (decided.fill === null
            ? ""
            : ` · simulated paper fill @ ${decided.fill.opportunity?.venuePrice ?? "?"}`),
      );
      return EXIT_OK;
    } catch (error) {
      throw new CliError(
        "rebet_decision_failed",
        String((error as Error).message ?? error),
        {},
        EXIT_ERROR,
      );
    }
  }
  if (!options.watch) {
    const payload = await rebetTick(context, options);
    if (context.json) {
      return emitSuccess(
        context,
        "rebet",
        payload as unknown as Record<string, unknown>,
      );
    }
    printRebetHuman(payload, context.out);
    return EXIT_OK;
  }
  let tick = 0;
  for (;;) {
    tick += 1;
    try {
      const payload = await rebetTick(context, options);
      if (context.json) {
        context.out(JSON.stringify({ ...payload, tick }));
      } else {
        printRebetHuman(payload, context.out);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (context.json) {
        context.out(
          JSON.stringify({
            success: false,
            command: "rebet",
            tick,
            generatedAt: new Date().toISOString(),
            error: { code: "tick_failed", message },
          }),
        );
      } else {
        context.err(`rebet tick ${tick} failed: ${message}`);
      }
    }
    if (options.maxTicks > 0 && tick >= options.maxTicks) break;
    await Bun.sleep(options.intervalSeconds * 1_000);
  }
  return EXIT_OK;
}

const ALERT_AUDIT_STATUSES: readonly AlertAuditStatus[] = [
  "sent",
  "simulated",
  "failed",
  "deduped",
  "rate_limited",
];

function parseAlertAuditStatuses(
  command: string,
  raw: string | undefined,
): readonly AlertAuditStatus[] | undefined {
  if (raw === undefined) return undefined;
  const statuses: AlertAuditStatus[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token === "") continue;
    if (!(ALERT_AUDIT_STATUSES as readonly string[]).includes(token)) {
      usageError(
        command,
        `--status must be a comma list of ${ALERT_AUDIT_STATUSES.join(", ")}`,
      );
    }
    if (!statuses.includes(token as AlertAuditStatus)) {
      statuses.push(token as AlertAuditStatus);
    }
  }
  return statuses.length === 0 ? undefined : statuses;
}

async function cmdAlertLog(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("alert-log", tokens, {
    valueFlags: ["--since", "--status", "--limit", "--chat", "--outcomes"],
    switchFlags: [
      "--include-activity",
      "--backfill",
      "--summary",
      "--csv",
      "--performance",
      "--include-simulated",
      "--use-customer-book-sample",
    ],
  });
  assertNoPositionals("alert-log", flags);
  const since = flags.values.get("--since");
  if (since !== undefined && !Number.isFinite(Date.parse(since))) {
    usageError("alert-log", `--since must be an ISO timestamp, got "${since}"`);
  }
  const statuses = parseAlertAuditStatuses(
    "alert-log",
    flags.values.get("--status"),
  );
  const limit = integerFlag("alert-log", flags, "--limit", 50, 1, 500);
  const includeActivity = flags.switches.has("--include-activity");
  const backfill = flags.switches.has("--backfill");
  const summaryMode = flags.switches.has("--summary");
  const csvMode = flags.switches.has("--csv");
  const performanceMode = flags.switches.has("--performance");
  const includeSimulated = flags.switches.has("--include-simulated");
  const useBookSample = flags.switches.has("--use-customer-book-sample");
  const chatFilter = flags.values.get("--chat")?.trim() ?? null;
  if (csvMode && context.json) {
    usageError("alert-log", "--csv cannot be combined with --json");
  }
  let backfillResult: {
    imported: number;
    skipped: number;
    activityRows: number;
  } | null = null;
  if (backfill) {
    backfillResult = await backfillAlertAuditFromActivity(
      context.root,
      since === undefined ? {} : { since },
    );
  }
  // Read the whole (filtered) ledger for summaries/filters; the display limit applies after.
  const structuredAll = await readAlertAudit(context.root, {
    ...(since === undefined ? {} : { since }),
    ...(statuses === undefined ? {} : { status: statuses }),
    limit: Number.MAX_SAFE_INTEGER,
  });
  let matchedRows: TelegramAlertAuditRow[] =
    chatFilter === null
      ? structuredAll
      : structuredAll.filter(
          (row) =>
            row.chatId === chatFilter ||
            (row.chatLabel ?? "").toLowerCase() === chatFilter.toLowerCase(),
        );
  if (includeActivity) {
    const activity = await readTelegramActivityLog(context.root);
    const filtered = activity.filter((row) => {
      if (
        since !== undefined &&
        !(Date.parse(row.atIso) >= Date.parse(since))
      ) {
        return false;
      }
      if (statuses !== undefined && !statuses.includes(row.status))
        return false;
      return true;
    });
    matchedRows = [...matchedRows, ...filtered].sort(
      (a, b) => Date.parse(b.atIso) - Date.parse(a.atIso),
    );
  }
  const matched = matchedRows.length;
  const rows = matchedRows.slice(0, limit);
  const summary = summarizeAlertAudit(matchedRows);
  let performance: AlertPerformanceReport | null = null;
  if (performanceMode) {
    const outcomesPathRaw = flags.values.get("--outcomes");
    let outcomes = null as Awaited<ReturnType<typeof loadOutcomeFile>>;
    let outcomeFile = "settlement outcomes (--outcomes)";
    if (outcomesPathRaw !== undefined) {
      outcomeFile = resolveFromRoot(context.root, outcomesPathRaw);
      outcomes = await loadOutcomeFile(outcomeFile);
    } else if (useBookSample) {
      outcomeFile = defaultCustomerBookPath(context.root);
      const book: unknown = await Bun.file(outcomeFile)
        .json()
        .catch(() => null);
      outcomes = book === null ? null : outcomesFromCustomerBook(book);
    } else {
      performance = {
        available: false,
        reason:
          "no outcomes source: pass --outcomes <settlement-export.jsonl>, or --use-customer-book-sample to opt into the partial generated-book sample",
        outcomeSource: "none",
        alerts: 0,
        delivered: 0,
        matched: 0,
        unmatched: 0,
        wins: 0,
        losses: 0,
        pushes: 0,
        netUsd: 0,
        customers: [],
        dimensions: [],
        warnings: [],
      };
    }
    if (performance === null) {
      if (outcomes === null) {
        performance = {
          available: false,
          reason: `outcome source missing: ${outcomeFile}`,
          outcomeSource: "none",
          alerts: 0,
          delivered: 0,
          matched: 0,
          unmatched: 0,
          wins: 0,
          losses: 0,
          pushes: 0,
          netUsd: 0,
          customers: [],
          dimensions: [],
          warnings: [],
        };
      } else {
        performance = buildAlertPerformance(matchedRows, outcomes, {
          deliveredOnly: !includeSimulated,
        });
      }
    }
  }
  const rollups = summaryMode
    ? {
        daily: dailyAlertRollup(matchedRows),
        chat: chatAlertRollup(matchedRows),
        rule: ruleAlertRollup(matchedRows),
        severity: severityAlertRollup(matchedRows),
      }
    : null;
  if (csvMode) {
    const csvEscape = (value: unknown): string => {
      const text = value === null || value === undefined ? "" : String(value);
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const columns = [
      "atIso",
      "source",
      "status",
      "chatId",
      "chatLabel",
      "customerId",
      "sport",
      "subSport",
      "period",
      "wagerType",
      "ruleId",
      "severity",
      "messageId",
      "messageChars",
      "detail",
    ] as const;
    context.out(
      [
        columns.join(","),
        ...rows.map((row) =>
          columns
            .map((column) =>
              csvEscape(
                column === "chatLabel"
                  ? row.chatLabel
                  : column === "chatId"
                    ? row.chatId
                    : column === "atIso"
                      ? row.atIso
                      : column === "source"
                        ? row.source
                        : column === "status"
                          ? row.status
                          : column === "customerId"
                            ? row.customerId
                            : column === "sport"
                              ? row.sport
                              : column === "subSport"
                                ? row.subSport
                                : column === "period"
                                  ? row.period
                                  : column === "wagerType"
                                    ? row.wagerType
                                    : column === "ruleId"
                                      ? row.ruleId
                                      : column === "severity"
                                        ? row.severity
                                        : column === "messageId"
                                          ? row.messageId
                                          : column === "messageChars"
                                            ? row.messageChars
                                            : row.detail,
              ),
            )
            .join(","),
        ),
      ].join("\n"),
    );
    return EXIT_OK;
  }
  const payload = {
    success: true,
    command: "alert-log",
    filters: {
      since: since ?? null,
      statuses: statuses ?? null,
      limit,
      includeActivity,
      backfill,
      chat: chatFilter,
    },
    ...(backfillResult === null ? {} : { backfill: backfillResult }),
    matched,
    summary,
    ...(rollups === null ? {} : { rollups }),
    ...(performance === null ? {} : { performance }),
    rows,
  };
  if (context.json) {
    return emitSuccess(
      context,
      "alert-log",
      payload as unknown as Record<string, unknown>,
    );
  }
  if (rows.length === 0) {
    context.out(
      "alert-log: no alert audit rows yet (run alert with TELEGRAM_CHAT_LABEL set, or pass --include-activity)",
    );
    return EXIT_OK;
  }
  const table = Bun.inspect.table(
    rows.map((row) => ({
      at: row.atIso,
      status: row.status,
      chat: row.chatLabel ?? row.chatId ?? "—",
      customer: row.customerId ?? "—",
      sport:
        [row.sport, row.subSport, row.period, row.wagerType]
          .filter((part) => part !== undefined && part !== "")
          .join(" · ") || "—",
      rule: row.ruleId ?? "—",
      severity: row.severity ?? "—",
      source: row.source,
    })),
    { colors: false },
  );
  const lines = [
    table.trimEnd(),
    `${summary.total} matching alert row(s) (${rows.length} shown) · ${ALERT_AUDIT_STATUSES.map(
      (status) => `${status} ${summary.byStatus[status]}`,
    ).join(" · ")}`,
    `chats: ${summary.chats.length === 0 ? "—" : summary.chats.join(", ")}`,
    summary.firstAtIso === null
      ? "window: —"
      : `window: ${summary.firstAtIso} → ${summary.lastAtIso}`,
  ];
  if (backfillResult !== null) {
    lines.push(
      `backfill: imported ${backfillResult.imported} activity row(s), skipped ${backfillResult.skipped} already tracked (${backfillResult.activityRows} outbound activity rows read)`,
    );
  }
  if (performance !== null) {
    lines.push("", `alert performance (${performance.outcomeSource})`);
    if (!performance.available) {
      lines.push(
        `  unavailable: ${performance.reason ?? "no joined outcomes"}`,
      );
    } else {
      lines.push(
        `  alerts ${performance.alerts} · matched ${performance.matched} · unmatched ${performance.unmatched} · wins ${performance.wins} · losses ${performance.losses} · net $${performance.netUsd}`,
      );
      if (performance.metadata !== undefined) {
        const window = performance.metadata.alertWindow;
        lines.push(
          `  coverage: ${performance.metadata.outcomeCoverage}` +
            ` · window ${window.firstAtIso ?? "—"} → ${window.lastAtIso ?? "—"}` +
            ` · sources ${performance.metadata.outcomeSources.join("+") || "none"}`,
        );
        if (performance.metadata.alertsWithoutCustomerKey > 0) {
          lines.push(
            `  ${performance.metadata.alertsWithoutCustomerKey} delivered alert(s) had no customer id`,
          );
        }
      }
      for (const warning of performance.warnings) {
        lines.push(`  warning: ${warning}`);
      }
      for (const group of performance.dimensions) {
        lines.push(
          `  ${group.dimension}=${group.key}: ${group.matched}/${group.alerts} matched · net $${group.netUsd} · winner ${group.topWinner?.customerId ?? "—"} ($${group.topWinner?.netUsd ?? 0}) · loser ${group.topLoser?.customerId ?? "—"} ($${group.topLoser?.netUsd ?? 0})`,
        );
      }
    }
  }
  if (rollups !== null) {
    lines.push(
      "",
      "by day:",
      Bun.inspect
        .table(
          rollups.daily.map((bucket) => ({
            day: bucket.key,
            total: bucket.total,
            sent: bucket.sent,
            simulated: bucket.simulated,
            failed: bucket.failed,
          })),
          { colors: false },
        )
        .trimEnd(),
      "by rule:",
      Bun.inspect
        .table(
          rollups.rule.map((bucket) => ({
            rule: bucket.key,
            total: bucket.total,
            sent: bucket.sent,
            simulated: bucket.simulated,
            failed: bucket.failed,
          })),
          { colors: false },
        )
        .trimEnd(),
    );
  }
  context.out(lines.join("\n"));
  return EXIT_OK;
}

function parseDateYmd(
  command: string,
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    usageError(command, `--date must be YYYY-MM-DD, got "${raw}"`);
  }
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== raw
  ) {
    usageError(command, `--date must be a real calendar day, got "${raw}"`);
  }
  return raw;
}

function parseLocateState(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!(GSLIVE_BET_HISTORY_STATES as readonly string[]).includes(raw)) {
    usageError(
      "locate",
      `--state must be one of ${GSLIVE_BET_HISTORY_STATES.filter((s) => s !== "").join(", ")} or empty, got "${raw}"`,
    );
  }
  return raw;
}

function locateLinksPayload(
  view: CustomerViewResult,
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    customerId: view.customerId,
    links: view.links,
    read: view.read,
    ...extra,
  };
}

async function cmdLocate(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("locate", tokens, {
    valueFlags: [
      "--customer",
      "--bet",
      "--date",
      "--state",
      "--window",
      "--source",
      "--file",
      "--agent",
      "--limit",
    ],
  });
  assertNoPositionals("locate", flags);
  const customerRaw = flags.values.get("--customer");
  const betRaw = flags.values.get("--bet");
  if (customerRaw === undefined && betRaw === undefined) {
    usageError(
      "locate",
      "one of --customer <login> or --bet <betKey> is required",
    );
  }
  if (customerRaw !== undefined && betRaw !== undefined) {
    usageError("locate", "--customer and --bet are mutually exclusive");
  }
  const dateYmd = parseDateYmd("locate", flags.values.get("--date"));
  const state = parseLocateState(flags.values.get("--state"));
  const windowDays = integerFlag("locate", flags, "--window", 1, 1, 31);
  const source = sourceFlag("locate", flags);
  const agentId = agentFlag(flags);
  const limit = integerFlag("locate", flags, "--limit", 100, 1, 500);
  const requestOptions = {
    ...(dateYmd === undefined ? {} : { dateYmd }),
    ...(state === undefined ? {} : { state }),
    windowDays,
    tickEpochMs: context.now.getTime(),
  };

  if (customerRaw !== undefined) {
    const customerId = customerRaw.trim();
    if (customerId === "") {
      usageError("locate", "--customer must be a non-empty login");
    }
    const view = resolveCustomerView({
      customerId,
      ...requestOptions,
    });
    return emitSuccess(context, "locate", locateLinksPayload(view));
  }

  const betKey = (betRaw as string).trim();
  if (betKey === "") usageError("locate", "--bet must be a non-empty bet key");
  const result = await fetchBetsFor(
    context,
    { source, file: captureFileFlag(flags), agentId, limit },
    context.now,
  );
  if (!result.ok) {
    throw new CliRefusal(
      "source_unavailable",
      `locate: incoming-bet source unavailable (${result.diagnostic.code})`,
      { source: result.source, diagnostic: result.diagnostic },
    );
  }
  const match = result.rows.find(
    (row) =>
      row.betKey === betKey ||
      row.ticketNumber === betKey ||
      row.wagerNumber === betKey,
  );
  if (match === undefined) {
    throw new CliRefusal(
      "not_found",
      `locate: no incoming bet with key "${betKey}" in the current ${result.source} source`,
      { betKey, source: result.source, rows: result.rows.length },
    );
  }
  let view: CustomerViewResult;
  try {
    view = customerViewForBet(match, requestOptions);
  } catch (error) {
    // A row with a malformed customer id cannot produce an honest link. It is "not found" for
    // this command rather than a fabricated URL.
    const message = error instanceof Error ? error.message : String(error);
    throw new CliRefusal(
      "not_found",
      `locate: bet "${betKey}" cannot be resolved to a customer view: ${message}`,
      { betKey, source: result.source },
    );
  }
  return emitSuccess(
    context,
    "locate",
    locateLinksPayload(view, { betKey: match.betKey }),
  );
}

/** One watch tick: scan, emit one NDJSON object / human line, append to the tick log. */
async function watchTick(
  context: CliContext,
  tick: number,
  intervalSeconds: number,
  options: ScanOptions,
  logPath: string,
): Promise<{ readonly exitCode: number; readonly ok: boolean }> {
  const now = currentNow(context);
  let line: string;
  let body: Readonly<Record<string, unknown>>;
  let ok = true;
  let exitCode = EXIT_OK;
  try {
    const run = await runScan(context, "watch", options, now);
    const selected = selectFindings(
      run.findings,
      options.minSeverity,
      options.maxFindings,
    );
    body = {
      ...scanPayload(run, selected),
      schemaVersion: BET_FLAGS_CLI_SCHEMA_VERSION,
      command: "watch",
      success: true,
      generatedAt: now.toISOString(),
      tick,
      intervalSeconds,
      logPath,
    };
    const counts = body["counts"] as {
      rows: number;
      findings: number;
    };
    const source = body["source"] as { readonly kind: string };
    line = context.json
      ? `${JSON.stringify(body)}\n`
      : `[${now.toISOString()}] tick ${tick}: source=${source.kind} rows=${counts.rows} findings=${counts.findings} interval=${intervalSeconds}s\n`;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    ok = false;
    exitCode = error.exitCode;
    body = {
      success: false,
      schemaVersion: BET_FLAGS_CLI_SCHEMA_VERSION,
      command: "watch",
      generatedAt: now.toISOString(),
      tick,
      intervalSeconds,
      error: {
        code: error.code,
        message: error.message,
        ...(Object.keys(error.details).length === 0
          ? {}
          : { details: error.details }),
      },
    };
    line = context.json
      ? `${JSON.stringify(body)}\n`
      : `[${now.toISOString()}] tick ${tick} ${error.code}: ${error.message}\n`;
    context.err(`${error.code}: ${error.message}\n`);
  }
  context.out(line);
  // The tick log is the durable trace: append every tick, including refusals, as one JSON line.
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(body)}\n`, "utf8");
  return { exitCode, ok };
}

async function cmdWatch(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("watch", tokens, {
    valueFlags: [...SCAN_VALUE_FLAGS, "--interval"],
    switchFlags: ["--once"],
  });
  assertNoPositionals("watch", flags);
  const options = scanOptions("watch", flags);
  const intervalSeconds = integerFlag(
    "watch",
    flags,
    "--interval",
    60,
    15,
    86_400,
  );
  const once = flags.switches.has("--once");
  const logPath = join(context.root, WATCH_LOG_REL_PATH);
  let tick = 0;
  for (;;) {
    tick += 1;
    const outcome = await watchTick(
      context,
      tick,
      intervalSeconds,
      options,
      logPath,
    );
    if (once) return outcome.ok ? EXIT_OK : outcome.exitCode;
    await Bun.sleep(intervalSeconds * 1000);
  }
}

/* -------------------------------------------------------------------------- */
/* Help                                                                        */
/* -------------------------------------------------------------------------- */

interface HelpRow {
  readonly flags: string;
  readonly description: string;
}

interface CommandHelp {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly detail: readonly string[];
  readonly arguments?: readonly HelpRow[];
  readonly options: readonly HelpRow[];
  readonly examples: readonly string[];
}

const HELP_GLOBAL_OPTIONS: readonly HelpRow[] = [
  { flags: "-r, --root <dir>", description: "Workspace root (default: cwd)." },
  {
    flags: "-R, --rules <path>",
    description: `Rule pack path, relative to --root (default: ${DEFAULT_RULES_REL_PATH}).`,
  },
  {
    flags: "-j, --json",
    description: "Exactly one JSON object on stdout (watch: one per tick).",
  },
  {
    flags: "-n, --now <iso>",
    description: "Freeze the clock (ISO-8601) for deterministic output.",
  },
  { flags: "-h, --help", description: "This help, or one command's help." },
];

const HELP_COMMANDS: readonly CommandHelp[] = [
  {
    name: "rules",
    summary: "List the loaded rule pack with its validation state",
    usage: "rules [flags]",
    detail: [
      "Loads and validates the YAML rule pack (--rules, default config/bet-flags.yml).",
      "An invalid pack is a refusal (rules_invalid, exit 3); a missing one is rules_missing.",
    ],
    options: [],
    examples: ["bun run cli/sportsdesk_bet_flags_cli.ts rules --json"],
  },
  {
    name: "scan",
    summary:
      "Fetch incoming bets, evaluate every enabled rule, return findings",
    usage:
      "scan [--source live|auto|file] [--file <capture.json>] [--agent <id>] [--limit N] [--context-window N] [--min-severity <level>] [--max-findings N] [flags]",
    detail: [
      "Reads live Manager getBetTicker through the replay transport (--source live) or falls",
      "back to the local captures (--source auto, default), then enriches the batch with market",
      "fields and per-bet context baselines before evaluating the rules. Each finding carries",
      "the wide bet record (deep market fields + bet.context), evidence, and a customerView",
      "with the GSLive Manager bet-history link.",
      "No live session or captures is a structured refusal (source_unavailable, exit 3).",
    ],
    options: [
      {
        flags: "--source <live|auto|file>",
        description:
          "auto (default) tries live then captures; live refuses without a session; file parses a recorded getBetTicker capture.",
      },
      {
        flags: "--file <path>",
        description:
          "With --source file: JSON getBetTicker capture (LIST rows). HTML captures are refused because they carry no customer identity.",
      },
      {
        flags: "--agent <id>",
        description: "Manager agent id for the live ticker.",
      },
      {
        flags: "--limit <N>",
        description: "Incoming rows to fetch (1-500, default 100).",
      },
      {
        flags: "--min-severity <level>",
        description: `Inclusive severity filter (default info). One of ${FLAG_SEVERITIES.join(", ")}.`,
      },
      {
        flags: "--max-findings <N>",
        description: "Findings kept (1-1000, default 200).",
      },
      {
        flags: "--context-window <N>",
        description:
          "Context baseline window in seconds for enrichIncomingBets (1-3600, default 300).",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_bet_flags_cli.ts scan --json --source auto --limit 100",
      "bun run cli/sportsdesk_bet_flags_cli.ts scan --json --source file --file tests/fixtures/live-wagers-list-sample.json",
      "bun run cli/sportsdesk_bet_flags_cli.ts scan --min-severity high --json",
      "bun run cli/sportsdesk_bet_flags_cli.ts scan --context-window 900 --json",
    ],
  },
  {
    name: "explain",
    summary: "Show the full definition of one rule",
    usage: "explain <ruleId> [flags]",
    detail: [
      "Prints the rule's predicate, aggregate and metadata. An unknown id is a refusal",
      "(not_found, exit 3).",
    ],
    arguments: [{ flags: "<ruleId>", description: "Rule id from `rules`." }],
    options: [],
    examples: [
      "bun run cli/sportsdesk_bet_flags_cli.ts explain stake_over_10k --json",
    ],
  },
  {
    name: "locate",
    summary:
      "Resolve a customer or incoming bet to GSLive Manager bet-history links",
    usage:
      "locate (--customer <login> | --bet <betKey>) [--date YYYY-MM-DD] [--state <state>] [--window 1-31] [flags]",
    detail: [
      "Builds the per-customer / per-ticket GSLive Manager deep links through the repo's link",
      "contract. `read` is honest about v1: available:false because no live customer read is",
      "configured. --bet resolves the key against the current incoming-bet source; an unknown",
      "key is a refusal (not_found, exit 3).",
    ],
    arguments: [],
    options: [
      {
        flags: "--customer <login>",
        description: "Customer login for the links.",
      },
      {
        flags: "--bet <betKey>",
        description:
          "Incoming bet key (or ticket/wager number) resolved against the source.",
      },
      {
        flags: "--date <YYYY-MM-DD>",
        description: "Desk day the window ends on (default today).",
      },
      {
        flags: "--state <state>",
        description: "SPA bet-state filter (default all).",
      },
      {
        flags: "--window <N>",
        description: "Desk days in the history window (1-31, default 1).",
      },
      {
        flags: "--source <live|auto|file>",
        description: "Source used to resolve --bet (default auto).",
      },
      {
        flags: "--file <path>",
        description:
          "With --source file: the getBetTicker capture to resolve --bet in.",
      },
      {
        flags: "--agent <id>",
        description: "Manager agent id for the live ticker.",
      },
      {
        flags: "--limit <N>",
        description: "Incoming rows to fetch for --bet (1-500, default 100).",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_bet_flags_cli.ts locate --customer CCC107 --json",
      "bun run cli/sportsdesk_bet_flags_cli.ts locate --bet wa-123 --json",
    ],
  },
  {
    name: "alert",
    summary: "Scan, then deliver deduped findings to Telegram",
    usage:
      "alert [--dry-run] [--chat-id <id>] [--state <path>] [--min-severity <level>] [--max-messages N] [--context-window N] [scan flags] [flags]",
    detail: [
      "Runs the same scan, then batches findings (at most --max-messages, default 1) into",
      "Telegram HTML messages. Dedupe keys live 7 days in Scratch/watchlist-autobet/alert-state.json.",
      "--dry-run never resolves credentials, never constructs a sender, never calls Telegram,",
      "and never advances the dedupe ledger: repeated dry runs report the same findings.",
    ],
    options: [
      {
        flags: "--dry-run",
        description:
          "Simulate delivery; no Telegram call and no keychain read.",
      },
      {
        flags: "--chat-id <id>",
        description: "Override the destination chat.",
      },
      {
        flags: "--state <path>",
        description: `Dedupe ledger path, relative to --root (default ${ALERT_STATE_REL_PATH}).`,
      },
      {
        flags: "--min-severity <level>",
        description: `Deliver at or above this severity (default medium). One of ${FLAG_SEVERITIES.join(", ")}.`,
      },
      {
        flags: "--max-messages <N>",
        description: "Message budget per run (1-20, default 1).",
      },
      {
        flags: "--context-window <N>",
        description:
          "Context baseline window in seconds for enrichIncomingBets (1-3600, default 300).",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_bet_flags_cli.ts alert --dry-run --json",
      "bun run cli/sportsdesk_bet_flags_cli.ts alert --min-severity high --max-messages 3 --json",
    ],
  },
  {
    name: "watch",
    summary: "Poll scan on an interval; write NDJSON per tick",
    usage: "watch [--interval N] [--once] [scan flags] [flags]",
    detail: [
      "Repeats the same enriched scan every --interval seconds (>=15, default 60). It accepts",
      "the scan flags including --context-window. With --json stdout is NDJSON, one object per",
      "tick; otherwise one human line per tick. Every tick, including refusals, is appended to",
      "Scratch/watchlist-autobet/bet-flags-watch.jsonl. --once runs a single tick for cron and",
      "exits with the tick's status. Watch does not send Telegram; use `alert`.",
    ],
    options: [
      {
        flags: "--interval <N>",
        description: "Seconds between ticks (>=15, default 60).",
      },
      { flags: "--once", description: "Run exactly one tick, then exit." },
    ],
    examples: [
      "bun run cli/sportsdesk_bet_flags_cli.ts watch --once --json",
      "bun run cli/sportsdesk_bet_flags_cli.ts watch --once --source auto --json",
    ],
  },
  {
    name: "kalshi",
    summary:
      "Report whether live Kalshi placement is armed (never places an order)",
    usage: "kalshi [flags]",
    detail: [
      "Resolves the three independent live gates — credentials, EXECUTION_MODE=live and",
      "EXECUTION_LIVE=1 — and prints the blocking reasons. Credentials come from",
      "KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY_PATH, or the keychain pair kalshi-api-key-id /",
      "kalshi-private-key-pem under com.bookdeskops.sportsdesk. It never reads key material",
      "into output and never places an order: the phrase PLACE LIVE ORDERS is required per",
      "order by the execution endpoint, not by this report.",
    ],
    options: [],
    examples: ["bun run cli/sportsdesk_bet_flags_cli.ts kalshi --json"],
  },
  {
    name: "markets",
    summary:
      "Match parsed bets to Kalshi and Polymarket markets with price and liquidity",
    usage:
      "markets [--venues kalshi,polymarket|both] [--max-bets N] [--league <code>] [--all] [scan flags] [flags]",
    detail: [
      "Takes the scan findings (or every fetched row with --all), maps each bet to the",
      "venue-facing signal shape, then reads public Kalshi events/order books and",
      "Polymarket gamma/CLOB books. Read-only: no order, portfolio or credential path.",
      "The league mapping is heuristic (Basketball→NBA, Football→NFL, Hockey→NHL,",
      "Baseball→MLB, Soccer→EPL); pass --league when the capture is ambiguous.",
      "Polymarket's team join covers game-winner markets only, so a total/spread/prop bet",
      "reports unavailable with that reason instead of a mismatched market.",
      "Each breakdown reports executable price, spread/depth (Kalshi) and best bid/ask",
      "plus top-of-book depth per outcome (Polymarket).",
    ],
    options: [
      {
        flags: "--venues <list>",
        description: "kalshi, polymarket, or both (default both).",
      },
      {
        flags: "--max-bets <N>",
        description: `Bets matched per run (1-${VENUE_BETS_MAX}, default 5; each is a network read).`,
      },
      {
        flags: "--league <code>",
        description:
          "Override the inferred league (NBA, NFL, CFB, EPL, NHL, MLB).",
      },
      {
        flags: "--all",
        description:
          "Match every fetched row instead of only the rule findings.",
      },
      {
        flags: "--group-by <list>",
        description: `Group the breakdown by any of ${BREAKDOWN_DIMENSIONS.join(", ")} (comma list; order defines the tree).`,
      },
    ],
    examples: [
      "bun run cli/sportsdesk_bet_flags_cli.ts markets --json --max-bets 3",
      "bun run cli/sportsdesk_bet_flags_cli.ts markets --source file --file tests/fixtures/live-wagers-list-sample.json --all --json",
      "bun run cli/sportsdesk_bet_flags_cli.ts markets --league NBA --max-bets 5",
      "bun run cli/sportsdesk_bet_flags_cli.ts markets --group-by sport,subsport,period,market --max-bets 5",
    ],
  },
  {
    name: "rebet",
    summary:
      "Re-bet ticker signals only when Kalshi or Polymarket offers a better price (paper ledger)",
    usage:
      "rebet [--style both|taker|maker] [--min-edge-bps N] [--maker-margin-bps N] [--stake N] [--max-bets N] [--paper] [--watch --interval N] [--approve <id>|--reject <id> --actor <name>] [--list] [scan flags] [flags]",
    detail: [
      "Fetches incoming bets (source flags), resolves each to Kalshi/Polymarket, and compares",
      "the venue price to the signal's own implied probability. Only edges at or above",
      "--min-edge-bps become opportunities; everything else reports a concrete rejection.",
      "Taker pays the executable price; maker rests at fair − margin below the ask.",
      "Combos and unmapped sides are refused (no single venue market / Poly side mapping).",
      "--paper records opportunities as PENDING in Scratch/rebet/ledger.jsonl, deduplicated",
      "per bet/venue/style so a watch loop is idempotent; no fill happens on detection.",
      "--approve <id> --actor <name> records the operator decision and a simulated paper fill;",
      "--reject requires --reason. --list shows pending/approved/rejected opportunities.",
      "--watch repeats on --interval seconds (>=15) and --max-ticks bounds a test/cron run.",
      "No order is placed: live placement stays behind the execution API gate.",
    ],
    options: [
      {
        flags: "--style <list>",
        description: "both (default), taker, maker, or a comma list.",
      },
      {
        flags: "--min-edge-bps <N>",
        description:
          "Minimum fair − venue-price edge in bps (0-5000, default 100).",
      },
      {
        flags: "--maker-margin-bps <N>",
        description:
          "Resting distance below fair for maker quotes (default 150).",
      },
      {
        flags: "--stake <N>",
        description: "Stake per opportunity in USD (1-100000, default 100).",
      },
      {
        flags: "--max-bets <N>",
        description: "Bets priced per tick (1-50, default 5).",
      },
      {
        flags: "--paper",
        description: "Record opportunities and simulated fills.",
      },
      {
        flags: "--watch",
        description:
          "Repeat every --interval seconds; JSON is NDJSON per tick.",
      },
      {
        flags: "--interval <N>",
        description: "Seconds between watch ticks (default 60).",
      },
      {
        flags: "--max-ticks <N>",
        description:
          "Stop after N ticks in watch mode (0 = run until interrupted).",
      },
      {
        flags: "--list",
        description: "List recorded opportunities and their status.",
      },
      {
        flags: "--approve <id>",
        description:
          "Approve one pending opportunity (needs --actor); writes a paper fill.",
      },
      {
        flags: "--reject <id>",
        description:
          "Reject one pending opportunity (needs --actor and --reason).",
      },
      {
        flags: "--actor <name>",
        description: "Operator recorded on an approval/rejection.",
      },
      {
        flags: "--reason <text>",
        description: "Required reason when rejecting.",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_bet_flags_cli.ts rebet --json --once",
      "bun run cli/sportsdesk_bet_flags_cli.ts rebet --json --paper --style maker --min-edge-bps 200",
      "bun run cli/sportsdesk_bet_flags_cli.ts rebet --watch --interval 60 --paper --json",
      "bun run cli/sportsdesk_bet_flags_cli.ts rebet --list --json",
      "bun run cli/sportsdesk_bet_flags_cli.ts rebet --approve bet-1:kalshi:taker --actor alice --json",
    ],
  },
  {
    name: "alert-log",
    summary:
      "Read the structured audit of alerts delivered to the desk Telegram chat",
    usage:
      "alert-log [--since <iso>] [--status <list>] [--chat <id|label>] [--limit N] [--include-activity] [--backfill] [--summary] [--performance] [--outcomes <path>] [--csv] [flags]",
    detail: [
      "Reads Scratch/watchlist-autobet/telegram-alerts.jsonl, written by every flag-alert",
      "delivery (sent, simulated, failed, deduped, rate_limited). Rows carry the rule id,",
      "severity and dedupe key plus a message hash/length — never the alert text, so customer",
      "identifiers do not leak into the audit.",
      "--include-activity merges the bot's own outbound log (reports/telegram-activity.jsonl),",
      "which covers non-flag messages but has no rule identity.",
      "--backfill imports those historical outbound rows into the audit ledger (idempotent).",
      "--summary adds per-day, per-chat and per-rule delivery rollups; --csv exports rows.",
      "--performance joins alerted customers (customer+wager) to outcomes and reports top",
      "winner/loser per sport/subSport/period/wagerType. Default outcomes come from the",
      "explicit --outcomes settlement export; --use-customer-book-sample opts into the",
      "partial generated-book sample (labelled as a warning). Alerts without a wager key are",
      "reported as unmatched, never guessed; duplicate sends of the same bet are counted once.",
      "--chat filters by chat id or the configured chat label (e.g. deskbotops).",
      "TELEGRAM_CHAT_LABEL records the operator's chat name (e.g. deskbotops) on each row.",
    ],
    options: [
      {
        flags: "--since <iso>",
        description: "Only rows at or after this ISO timestamp.",
      },
      {
        flags: "--status <list>",
        description:
          "Comma list from sent, simulated, failed, deduped, rate_limited.",
      },
      {
        flags: "--limit <N>",
        description: "Rows to return (1-500, default 50).",
      },
      {
        flags: "--include-activity",
        description:
          "Also merge outbound rows from reports/telegram-activity.jsonl.",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_bet_flags_cli.ts alert-log --json",
      "bun run cli/sportsdesk_bet_flags_cli.ts alert-log --include-activity --limit 20",
      "bun run cli/sportsdesk_bet_flags_cli.ts alert-log --backfill --summary --json",
      "bun run cli/sportsdesk_bet_flags_cli.ts alert-log --chat deskbotops --csv",
    ],
  },
];

function formatHelpRows(rows: readonly HelpRow[]): string {
  const width = rows.reduce((max, row) => Math.max(max, row.flags.length), 0);
  return rows
    .map((row) => `  ${row.flags.padEnd(width)}  ${row.description}`)
    .join("\n");
}

function printRootHelp(out: (text: string) => void): void {
  const nameWidth = HELP_COMMANDS.reduce(
    (max, command) => Math.max(max, command.name.length),
    0,
  );
  const table = HELP_COMMANDS.map(
    (command) => `  ${command.name.padEnd(nameWidth)}  ${command.summary}`,
  ).join("\n");
  out(`SportsDesk incoming-bet flags — YAML rules, read-only customer view, deduped alerts

Usage: bun run cli/sportsdesk_bet_flags_cli.ts <command> [flags] [args]

Commands:
${table}

  <command> --help     Print detailed help for one command.

Read-only: live Manager reads go through the F402 replay transport; no order path exists.
--json stdout is always exactly one JSON object (watch: one object per tick); diagnostics go
to stderr.

Global flags:
${formatHelpRows(HELP_GLOBAL_OPTIONS)}

Exit codes:
  0  ok
  2  usage_error (unknown command/flag, missing or invalid value)
  3  refusal (source_unavailable, rules_invalid, rules_missing, not_found)
  1  everything else

Examples:
  bun run cli/sportsdesk_bet_flags_cli.ts rules --json
  bun run cli/sportsdesk_bet_flags_cli.ts scan --json --source auto --limit 100
  bun run cli/sportsdesk_bet_flags_cli.ts explain stake_over_10k --json
  bun run cli/sportsdesk_bet_flags_cli.ts locate --customer CCC107 --json
  bun run cli/sportsdesk_bet_flags_cli.ts alert --dry-run --json
  bun run cli/sportsdesk_bet_flags_cli.ts watch --once --json
  bun run cli/sportsdesk_bet_flags_cli.ts kalshi --json
  bun run cli/sportsdesk_bet_flags_cli.ts markets --max-bets 3 --json
`);
}

function printHelp(
  commandName: string | undefined,
  out: (text: string) => void,
): void {
  if (commandName === undefined) {
    printRootHelp(out);
    return;
  }
  const command = HELP_COMMANDS.find((entry) => entry.name === commandName);
  if (command === undefined) {
    printRootHelp(out);
    return;
  }
  const lines: string[] = [
    `Usage: bun run cli/sportsdesk_bet_flags_cli.ts ${command.usage}`,
    "",
    ...command.detail,
    "",
    ...(command.arguments === undefined || command.arguments.length === 0
      ? []
      : ["Arguments:", formatHelpRows(command.arguments), ""]),
    "Options:",
    formatHelpRows([...command.options, ...HELP_GLOBAL_OPTIONS]),
    "",
    "Examples:",
    ...command.examples.map((example) => `  ${example}`),
    "",
  ];
  out(`${lines.join("\n")}\n`);
}

/* -------------------------------------------------------------------------- */
/* Dispatch / entrypoint                                                       */
/* -------------------------------------------------------------------------- */

const COMMANDS: ReadonlySet<string> = new Set(
  HELP_COMMANDS.map((command) => command.name),
);

function makeContext(global: GlobalArgs, deps: BetFlagsCliDeps): CliContext {
  return {
    root: global.root,
    rulesPath: resolveFromRoot(global.root, global.rules),
    json: global.json,
    now: global.now,
    nowFixed: global.nowFixed,
    deps,
    out: deps.stdout ?? writeToStdout,
    err: deps.stderr ?? writeToStderr,
  };
}

/**
 * Run one CLI invocation. Returns the exit code; writes only through the injected/global
 * stdout and stderr writers. Tests call this directly with fake collaborators.
 */
export async function runSportsdeskBetFlagsCli(
  argv: readonly string[],
  deps: BetFlagsCliDeps = {},
): Promise<number> {
  const globalResult = parseGlobalArgs(argv);
  if (!globalResult.ok) {
    return emitFailure(
      globalResult.writer,
      "unknown",
      globalResult.error,
      new Date(),
    );
  }
  const global = globalResult.value;
  if (global.help) {
    printHelp(global.command, deps.stdout ?? writeToStdout);
    return EXIT_OK;
  }
  const context = makeContext(global, deps);
  if (global.command === undefined || global.command.trim() === "") {
    return emitFailure(
      context,
      "unknown",
      new CliError(
        "usage_error",
        "missing command; run `bun run cli/sportsdesk_bet_flags_cli.ts --help`",
        {},
        EXIT_USAGE,
      ),
      context.now,
    );
  }
  if (!COMMANDS.has(global.command)) {
    return emitFailure(
      context,
      global.command,
      new CliError(
        "usage_error",
        `${global.command}: unknown command; run \`bun run cli/sportsdesk_bet_flags_cli.ts --help\` for the command table`,
        {},
        EXIT_USAGE,
      ),
      context.now,
    );
  }
  try {
    switch (global.command) {
      case "rules":
        return await cmdRules(global.commandArgs, context);
      case "scan":
        return await cmdScan(global.commandArgs, context);
      case "explain":
        return await cmdExplain(global.commandArgs, context);
      case "locate":
        return await cmdLocate(global.commandArgs, context);
      case "alert":
        return await cmdAlert(global.commandArgs, context);
      case "alert-log":
        return await cmdAlertLog(global.commandArgs, context);
      case "watch":
        return await cmdWatch(global.commandArgs, context);
      case "kalshi":
        return await cmdKalshi(global.commandArgs, context);
      case "markets":
        return await cmdMarkets(global.commandArgs, context);
      case "rebet":
        return await cmdRebet(global.commandArgs, context);
      default:
        // Unreachable: COMMANDS was checked above.
        throw new CliError(
          "usage_error",
          `${global.command}: unknown command`,
          {},
          EXIT_USAGE,
        );
    }
  } catch (error) {
    if (error instanceof CliError) {
      return emitFailure(context, global.command, error, context.now);
    }
    const message = error instanceof Error ? error.message : String(error);
    return emitFailure(
      context,
      global.command,
      new CliError("internal_error", message, {}, EXIT_ERROR),
      context.now,
    );
  }
}

async function main(): Promise<number> {
  return runSportsdeskBetFlagsCli(process.argv.slice(2));
}

if (import.meta.main) {
  // `exitCode` rather than `process.exit`: stdout/stderr writes are allowed to drain.
  process.exitCode = await main();
}

/* Re-exported for the control plane and tests: importable without running the CLI. */
export { deskDateYmd, runScan, scanPayload, selectFindings };
export type { IncomingBetSource, ScanOptions, ScanRun };
