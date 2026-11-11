#!/usr/bin/env bun
/**
 * Watchlist autobet CLI — paper-only bet intents over the desk's own watchlist signals.
 *
 * Safety boundary: this CLI never places a live order. `execute` only fills the paper adapter;
 * any other venue is refused with `live_disabled` (exit 3). Intents must be approved by an
 * operator before a paper fill, and the append-only ledger records every transition.
 *
 * Contract:
 * - one command per invocation: status | signals | candidates | plan | enqueue | list | approve |
 *   reject | execute | settle | journal | watch
 * - each command has detailed help: `bun run autobet <command> --help` (arguments, long and short
 *   flags, defaults, safety notes, examples); the root `--help` prints the command table
 * - global flags anywhere on the line: --root/-r <path>, --config/-c <path>, --json/-j,
 *   --now/-n <iso>, --help/-h
 * - `--json` stdout is exactly one JSON object (diagnostics only on stderr)
 * - exit codes: 0 ok, 2 usage_error, 3 refusal (invalid_transition/intent_expired/live_disabled),
 *   1 everything else
 */
import { resolve } from "node:path";

import {
  AUTOBET_CONFIG_REL_PATH,
  AUTOBET_SCHEMA_VERSION,
  AutobetError,
  appendLedgerEvent,
  assertIntentTransition,
  assertPaperVenue,
  buildLedgerEvent,
  clampStakeUsd,
  computeCapUsage,
  computePaperFill,
  computeSettlement,
  countIntentsByStatus,
  describeSignalSources,
  evaluateSignalGates,
  intentCreatedEventData,
  isAutobetIntentStatus,
  ledgerPathFor,
  loadAutobetConfig,
  loadAutobetSignals,
  planEnqueues,
  readLedger,
  withLedgerLock,
  type AutobetConfig,
  type AutobetIntent,
  type AutobetSourceStatus,
  type ReadLedgerSuccess,
  type SettlementResult,
  type SkippedEnqueue,
} from "../lib/watchlist_autobet.ts";
import {
  WATCHLIST_ACCOUNT_CATEGORIES,
  WatchlistOverlayError,
  addWatchlistAccount,
  listWatchlistAccounts,
  removeWatchlistAccount,
} from "../lib/watchlist_account_overlay.ts";
import { collectWatchlistCandidates } from "../lib/watchlist_signal_engine.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 2;
/** How many unwatched candidates ride along in the Signals inspector payload. */
const SIGNALS_CANDIDATE_PREVIEW = 25;

interface CliContext {
  readonly root: string;
  readonly configRelPath: string;
  readonly json: boolean;
  readonly now: Date;
  /** True when `--now` pinned the clock (used by `watch` and deterministic tests). */
  readonly nowFixed: boolean;
}

interface GlobalArgs {
  readonly root: string;
  readonly configRelPath: string;
  readonly json: boolean;
  readonly now: Date;
  readonly nowFixed: boolean;
  readonly help: boolean;
  readonly command: string | undefined;
  readonly commandArgs: readonly string[];
}

type GlobalParseResult =
  | { readonly ok: true; readonly value: GlobalArgs }
  | {
      readonly ok: false;
      readonly error: AutobetError;
      readonly json: boolean;
    };

function isMissingValue(value: string | undefined): boolean {
  return value === undefined || value === "" || value.startsWith("-");
}

/** Canonical long name for every global value flag; single-dash aliases share it. */
const GLOBAL_VALUE_FLAGS: Readonly<
  Record<string, "--root" | "--config" | "--now">
> = {
  "--root": "--root",
  "-r": "--root",
  "--config": "--config",
  "-c": "--config",
  "--now": "--now",
  "-n": "--now",
};

/**
 * Global flags may appear before or after the subcommand, mixed with command flags (the DSH
 * plugin appends `--json` last). They are extracted from the whole line; everything else is
 * handed to the command parser, whose closed flag specs reject unknown flags.
 *
 * Both long and short forms are accepted, including `--root=<path>` / `-r=<path>`.
 */
function parseGlobalArgs(argv: readonly string[]): GlobalParseResult {
  let root = process.cwd();
  let configRelPath: string = AUTOBET_CONFIG_REL_PATH;
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
      let value = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
      if (value === undefined) {
        const next = argv[index + 1];
        if (isMissingValue(next)) {
          return {
            ok: false,
            json,
            error: new AutobetError(
              "usage_error",
              `missing value for ${rawFlag}`,
            ),
          };
        }
        value = next as string;
        index += 1;
      }
      if (canonical === "--root") {
        root = resolve(value);
      } else if (canonical === "--config") {
        configRelPath = value;
      } else {
        const parsed = new Date(value);
        if (!Number.isFinite(parsed.getTime())) {
          return {
            ok: false,
            json,
            error: new AutobetError(
              "usage_error",
              `--now must be an ISO-8601 timestamp, got "${value}"`,
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

  const command = rest[0];
  return {
    ok: true,
    value: {
      root,
      configRelPath,
      json,
      now,
      nowFixed,
      help,
      command,
      commandArgs: rest.slice(1),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

function emitSuccess(
  context: CliContext,
  command: string,
  payload: Readonly<Record<string, unknown>>,
): number {
  const body = {
    success: true,
    schemaVersion: AUTOBET_SCHEMA_VERSION,
    command,
    generatedAt: context.now.toISOString(),
    ...payload,
  };
  process.stdout.write(
    context.json
      ? `${JSON.stringify(body)}\n`
      : `${JSON.stringify(body, null, 2)}\n`,
  );
  return EXIT_OK;
}

/** Failures always print the JSON error object to stdout plus a one-line message on stderr. */
function emitFailure(command: string, error: AutobetError): void {
  const body = {
    success: false,
    schemaVersion: AUTOBET_SCHEMA_VERSION,
    command,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.stderr.write(`${error.code}: ${error.message}\n`);
}

function toAutobetError(error: unknown): AutobetError {
  if (error instanceof AutobetError) return error;
  if (error instanceof WatchlistOverlayError) {
    // The overlay module owns its own vocabulary; map it onto the CLI's closed error codes so
    // the operator sees a stable code (and the right exit code) instead of internal_error.
    const code =
      error.code === "overlay_invalid" || error.code === "overlay_unreadable"
        ? "config_invalid"
        : error.code;
    return new AutobetError(code, error.message, error.details, {
      cause: error,
    });
  }
  return new AutobetError(
    "internal_error",
    error instanceof Error ? error.message : String(error),
    undefined,
    { cause: error },
  );
}

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                            */
/* -------------------------------------------------------------------------- */

interface CommandFlags {
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

interface FlagSpec {
  readonly valueFlags?: readonly string[];
  readonly switchFlags?: readonly string[];
  /** Single-dash aliases resolved before the closed-set check, e.g. `{ "-l": "--limit" }`. */
  readonly shortAliases?: Readonly<Record<string, string>>;
}

/** Actionable tail for a usage error: which help topic documents the flag. */
function helpHint(command: string): string {
  return `run \`bun run autobet ${command} --help\` for flags`;
}

function usageError(command: string, message: string): never {
  throw new AutobetError("usage_error", `${command}: ${message}`);
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
        // A single-dash token is a short alias, never a free-form value. Rejecting unknown
        // shorts here keeps the closed flag set intact.
        const resolved = aliases[rawFlag];
        if (resolved === undefined) {
          usageError(command, `unknown flag ${rawFlag}; ${helpHint(command)}`);
        }
        flagName = resolved;
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
  if (rest.length > 0) {
    usageError(command, `unexpected argument: ${rest[0]}`);
  }
  return first;
}

function requireFlagValue(
  command: string,
  flags: CommandFlags,
  name: string,
): string {
  const value = flags.values.get(name);
  if (value === undefined || value.trim() === "") {
    usageError(command, `missing ${name}`);
  }
  return value;
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

function numberFlag(
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
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    usageError(command, `${name} must be a number in [${min}, ${max}]`);
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Shared state loaders                                                        */
/* -------------------------------------------------------------------------- */

async function loadConfig(context: CliContext): Promise<AutobetConfig> {
  return loadAutobetConfig(context.root, context.configRelPath);
}

async function loadLedgerState(
  context: CliContext,
  config: AutobetConfig,
  now: Date = context.now,
): Promise<ReadLedgerSuccess> {
  const result = await readLedger(ledgerPathFor(context.root, config), { now });
  if (!result.ok) {
    throw new AutobetError("ledger_corrupt", result.message, {
      line: result.line,
    });
  }
  return result;
}

function findIntent(
  ledger: ReadLedgerSuccess,
  intentId: string,
): AutobetIntent | undefined {
  return ledger.intents.find((intent) => intent.intentId === intentId);
}

async function recordExpiry(
  context: CliContext,
  config: AutobetConfig,
  ledger: ReadLedgerSuccess,
  intentId: string,
): Promise<void> {
  const alreadyRecorded = ledger.events.some(
    (event) => event.intentId === intentId && event.type === "intent_expired",
  );
  if (alreadyRecorded) return;
  await appendLedgerEvent(
    ledgerPathFor(context.root, config),
    buildLedgerEvent("intent_expired", intentId, context.now, "system", {
      reason: "expired",
    }),
  );
}

/**
 * Resolve an intent for an action, recording an `intent_expired` event the first time expiry is
 * observed so the refusal is legible in the journal. Illegal transitions propagate untouched.
 */
async function resolveActionableIntent(
  context: CliContext,
  config: AutobetConfig,
  ledger: ReadLedgerSuccess,
  intentId: string,
  action: "approve" | "reject" | "execute" | "settle",
): Promise<AutobetIntent> {
  const intent = findIntent(ledger, intentId);
  try {
    return assertIntentTransition(intent, action, context.now, intentId);
  } catch (error) {
    if (error instanceof AutobetError && error.code === "intent_expired") {
      await recordExpiry(context, config, ledger, intentId);
    }
    throw error;
  }
}

function skippedEnqueueJson(skipped: SkippedEnqueue): Record<string, unknown> {
  return {
    signalId: skipped.signalId,
    reasons: skipped.reasons,
    ...(skipped.existingIntentId === undefined
      ? {}
      : { existingIntentId: skipped.existingIntentId }),
  };
}

function sourceJson(source: AutobetSourceStatus): Record<string, unknown> {
  return {
    path: source.path,
    exists: source.exists,
    ageSeconds: source.ageSeconds,
    stale: source.stale,
  };
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

async function cmdStatus(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("status", tokens);
  assertNoPositionals("status", flags);
  const config = await loadConfig(context);
  const ledger = await loadLedgerState(context, config);
  const ledgerAbsolute = ledgerPathFor(context.root, config);
  const sources = await describeSignalSources(
    context.root,
    config.maxSignalAgeSeconds,
    context.now,
  );
  const lastEvent = ledger.events[ledger.events.length - 1];
  const accounts = await listWatchlistAccounts(context.root);
  return emitSuccess(context, "status", {
    config: {
      path: context.configRelPath,
      exists: true,
      effective: config,
    },
    ledger: {
      path: config.ledgerPath,
      exists: await Bun.file(ledgerAbsolute).exists(),
      events: ledger.events.length,
      intents: countIntentsByStatus(ledger.intents, context.now),
      lastEventAt: lastEvent === undefined ? null : lastEvent.at,
    },
    sources: sources.map(sourceJson),
    accounts: {
      path: accounts.path,
      exists: accounts.exists,
      ...accounts.counts,
    },
    safety: { liveExecution: false, reason: "paper_mode_only" },
  });
}

async function cmdSignals(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("signals", tokens, {
    valueFlags: ["--limit", "--min-confidence"],
    switchFlags: ["--include-rejected"],
    shortAliases: {
      "-l": "--limit",
      "-m": "--min-confidence",
      "-i": "--include-rejected",
    },
  });
  assertNoPositionals("signals", flags);
  const limit = integerFlag("signals", flags, "--limit", 50, 1, 200);
  const minConfidence = numberFlag(
    "signals",
    flags,
    "--min-confidence",
    0,
    0,
    100,
  );
  const includeRejected = flags.switches.has("--include-rejected");

  const config = await loadConfig(context);
  const ledger = await loadLedgerState(context, config);
  const snapshot = await loadAutobetSignals(context.root, config, context.now);
  const usage = computeCapUsage(ledger.intents, context.now);
  const stakeUsd = clampStakeUsd(config);

  const evaluations = snapshot.signals
    .filter((signal) => signal.confidence >= minConfidence)
    .map((signal) => ({
      signal,
      gate: evaluateSignalGates(signal, {
        config,
        now: context.now,
        stakeUsd,
        dailyStakeUsedUsd: usage.dailyStakeUsedUsd,
        leagueStakeUsedUsd: usage.byLeagueStakeUsedUsd[signal.league] ?? 0,
        existingIntents: ledger.intents,
      }),
    }));
  const eligible = evaluations.filter((evaluation) => evaluation.gate.eligible);
  const visible = includeRejected ? evaluations : eligible;
  // Advisory discovery: accounts in the same artifacts that the registry does not watch.
  // Never gated, never queued — the Signals inspector shows them so a new account is not silent.
  // The overlay registry is passed so an account the operator just added stops appearing here.
  const discovered = collectWatchlistCandidates(snapshot.inputs, {
    now: context.now,
    registry: snapshot.registry,
  });

  return emitSuccess(context, "signals", {
    sources: snapshot.sources.map(sourceJson),
    counts: {
      total: evaluations.length,
      eligible: eligible.length,
      rejected: evaluations.length - eligible.length,
      candidates: discovered.length,
    },
    signals: visible.slice(0, limit),
    candidates: discovered.slice(0, SIGNALS_CANDIDATE_PREVIEW),
  });
}

async function cmdCandidates(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("candidates", tokens, {
    valueFlags: ["--limit", "--min-risk-usd"],
    shortAliases: { "-l": "--limit" },
  });
  assertNoPositionals("candidates", flags);
  const limit = integerFlag("candidates", flags, "--limit", 50, 1, 200);
  const minRiskUsd = numberFlag(
    "candidates",
    flags,
    "--min-risk-usd",
    0,
    0,
    1_000_000_000,
  );

  const config = await loadConfig(context);
  const snapshot = await loadAutobetSignals(context.root, config, context.now);
  const discovered = collectWatchlistCandidates(snapshot.inputs, {
    now: context.now,
    minRiskUsd,
    registry: snapshot.registry,
  });
  const totalRiskUsd =
    Math.round(discovered.reduce((sum, c) => sum + c.riskUsd, 0) * 100) / 100;

  return emitSuccess(context, "candidates", {
    sources: snapshot.sources.map(sourceJson),
    counts: {
      total: discovered.length,
      returned: Math.min(discovered.length, limit),
      minRiskUsd,
      riskUsd: totalRiskUsd,
    },
    candidates: discovered.slice(0, limit),
  });
}

async function cmdAccounts(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const subcommand = tokens[0];
  if (subcommand === undefined || subcommand.trim() === "") {
    usageError(
      "accounts",
      "missing subcommand (list|add|remove); run `bun run autobet accounts --help`",
    );
  }
  const rest = tokens.slice(1);

  if (subcommand === "list") {
    const flags = parseCommandFlags("accounts", rest);
    assertNoPositionals("accounts", flags);
    const listing = await listWatchlistAccounts(context.root);
    return emitSuccess(context, "accounts", {
      action: "list",
      ...listing,
    });
  }

  if (subcommand === "add") {
    const flags = parseCommandFlags("accounts", rest, {
      valueFlags: ["--agent", "--category", "--archetype", "--note", "--actor"],
    });
    const login = flags.positionals[0];
    if (login === undefined) {
      usageError("accounts", "add: missing <login>");
    }
    if (flags.positionals.length > 1) {
      usageError("accounts", "add: expected exactly one <login>");
    }
    const agentId = flags.values.get("--agent");
    if (agentId === undefined || agentId.trim() === "") {
      usageError("accounts", "add: --agent is required");
    }
    const actor = flags.values.get("--actor") ?? "operator";
    if (actor.trim() === "") {
      usageError("accounts", "add: --actor must not be empty");
    }
    const category = flags.values.get("--category");
    if (
      category !== undefined &&
      !(WATCHLIST_ACCOUNT_CATEGORIES as readonly string[]).includes(category)
    ) {
      usageError(
        "accounts",
        `add: unknown --category ${category}; allowed: ${WATCHLIST_ACCOUNT_CATEGORIES.join(", ")}`,
      );
    }
    const archetype = flags.values.get("--archetype");
    const note = flags.values.get("--note");
    const result = await addWatchlistAccount(context.root, {
      login,
      agentId,
      ...(category === undefined ? {} : { sourceCategory: category }),
      ...(archetype === undefined ? {} : { archetype }),
      ...(note === undefined ? {} : { note }),
      actor,
      now: context.now,
    });
    return emitSuccess(context, "accounts", {
      action: "add",
      account: result.account,
      path: result.overlay.path,
      exists: true,
      counts: result.counts,
    });
  }

  if (subcommand === "remove") {
    const flags = parseCommandFlags("accounts", rest, {
      valueFlags: ["--actor"],
    });
    const login = flags.positionals[0];
    if (login === undefined) {
      usageError("accounts", "remove: missing <login>");
    }
    if (flags.positionals.length > 1) {
      usageError("accounts", "remove: expected exactly one <login>");
    }
    const actor = flags.values.get("--actor") ?? "operator";
    if (actor.trim() === "") {
      usageError("accounts", "remove: --actor must not be empty");
    }
    const result = await removeWatchlistAccount(context.root, login);
    return emitSuccess(context, "accounts", {
      action: "remove",
      removed: result.removed,
      actor,
      path: result.overlay.path,
      exists: result.overlay.exists,
      counts: result.counts,
    });
  }

  usageError(
    "accounts",
    `unknown subcommand ${subcommand}; expected list, add or remove`,
  );
}

async function cmdPlan(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("plan", tokens);
  assertNoPositionals("plan", flags);
  const config = await loadConfig(context);
  const ledger = await loadLedgerState(context, config);
  const snapshot = await loadAutobetSignals(context.root, config, context.now);
  const plan = planEnqueues(snapshot.signals, {
    config,
    now: context.now,
    intents: ledger.intents,
    actor: "operator",
  });
  return emitSuccess(context, "plan", {
    wouldQueue: plan.wouldQueue.map((intent) => ({ intent })),
    skipped: plan.skipped.map(skippedEnqueueJson),
    caps: plan.caps,
  });
}

async function cmdEnqueue(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("enqueue", tokens, {
    valueFlags: ["--actor"],
    shortAliases: { "-a": "--actor" },
  });
  assertNoPositionals("enqueue", flags);
  const actor = flags.values.get("--actor") ?? "operator";
  if (actor.trim() === "") usageError("enqueue", "--actor must not be empty");

  const config = await loadConfig(context);
  const ledgerAbsolute = ledgerPathFor(context.root, config);
  // Read→plan→append must be one critical section: a second writer (watch/cron/operator shell)
  // would otherwise plan against the same intents and append a duplicate or transition-illegal
  // event, which the append-only ledger treats as permanent corruption.
  return withLedgerLock(ledgerAbsolute, async () => {
    const ledger = await loadLedgerState(context, config);
    const snapshot = await loadAutobetSignals(
      context.root,
      config,
      context.now,
    );
    const plan = planEnqueues(snapshot.signals, {
      config,
      now: context.now,
      intents: ledger.intents,
      actor,
    });

    for (const intent of plan.wouldQueue) {
      await appendLedgerEvent(
        ledgerAbsolute,
        buildLedgerEvent(
          "intent_created",
          intent.intentId,
          context.now,
          actor,
          intentCreatedEventData(intent),
        ),
      );
    }

    const refreshed = await loadLedgerState(context, config);
    const byId = new Map(
      refreshed.intents.map((intent) => [intent.intentId, intent] as const),
    );
    const created = plan.wouldQueue.map(
      (intent) => byId.get(intent.intentId) ?? intent,
    );
    return emitSuccess(context, "enqueue", {
      created,
      skipped: plan.skipped.map(skippedEnqueueJson),
      ledger: {
        path: config.ledgerPath,
        exists: await Bun.file(ledgerAbsolute).exists(),
        events: refreshed.events.length,
        intents: countIntentsByStatus(refreshed.intents, context.now),
      },
    });
  });
}

async function cmdList(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("list", tokens, {
    valueFlags: ["--status", "--limit"],
    shortAliases: { "-s": "--status", "-l": "--limit" },
  });
  assertNoPositionals("list", flags);
  const limit = integerFlag("list", flags, "--limit", 100, 1, 500);
  const statusFilter = flags.values.get("--status");
  if (statusFilter !== undefined && !isAutobetIntentStatus(statusFilter)) {
    usageError(
      "list",
      `--status must be one of queued, approved, filled, settled, rejected, expired`,
    );
  }

  const config = await loadConfig(context);
  const ledger = await loadLedgerState(context, config);
  const intents =
    statusFilter === undefined
      ? ledger.intents
      : ledger.intents.filter((intent) => intent.status === statusFilter);
  return emitSuccess(context, "list", {
    intents: intents.slice(0, limit),
    counts: countIntentsByStatus(ledger.intents, context.now),
  });
}

async function cmdApprove(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("approve", tokens, {
    valueFlags: ["--actor", "--note"],
    shortAliases: { "-a": "--actor", "-o": "--note" },
  });
  const intentId = requireSinglePositional("approve", flags, "<intentId>");
  const actor = requireFlagValue("approve", flags, "--actor");
  const note = flags.values.get("--note");

  const config = await loadConfig(context);
  return withLedgerLock(ledgerPathFor(context.root, config), async () => {
    const ledger = await loadLedgerState(context, config);
    const actionable = await resolveActionableIntent(
      context,
      config,
      ledger,
      intentId,
      "approve",
    );
    await appendLedgerEvent(
      ledgerPathFor(context.root, config),
      buildLedgerEvent(
        "intent_approved",
        actionable.intentId,
        context.now,
        actor,
        note === undefined ? {} : { note },
      ),
    );
    const refreshed = await loadLedgerState(context, config);
    const updated = findIntent(refreshed, intentId);
    if (updated === undefined) {
      throw new AutobetError(
        "internal_error",
        `intent vanished after approve: ${intentId}`,
      );
    }
    return emitSuccess(context, "approve", { intent: updated });
  });
}

async function cmdReject(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("reject", tokens, {
    valueFlags: ["--actor", "--reason"],
    shortAliases: { "-a": "--actor", "-R": "--reason" },
  });
  const intentId = requireSinglePositional("reject", flags, "<intentId>");
  const actor = requireFlagValue("reject", flags, "--actor");
  const reason = requireFlagValue("reject", flags, "--reason");

  const config = await loadConfig(context);
  return withLedgerLock(ledgerPathFor(context.root, config), async () => {
    const ledger = await loadLedgerState(context, config);
    const actionable = await resolveActionableIntent(
      context,
      config,
      ledger,
      intentId,
      "reject",
    );
    await appendLedgerEvent(
      ledgerPathFor(context.root, config),
      buildLedgerEvent(
        "intent_rejected",
        actionable.intentId,
        context.now,
        actor,
        { reason },
      ),
    );
    const refreshed = await loadLedgerState(context, config);
    const updated = findIntent(refreshed, intentId);
    if (updated === undefined) {
      throw new AutobetError(
        "internal_error",
        `intent vanished after reject: ${intentId}`,
      );
    }
    return emitSuccess(context, "reject", { intent: updated });
  });
}

async function cmdExecute(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("execute", tokens, {
    valueFlags: ["--venue"],
    shortAliases: { "-v": "--venue" },
  });
  const intentId = requireSinglePositional("execute", flags, "<intentId>");
  // Venue is checked before any state read: a live venue is refused unconditionally.
  assertPaperVenue(flags.values.get("--venue"));

  const config = await loadConfig(context);
  return withLedgerLock(ledgerPathFor(context.root, config), async () => {
    const ledger = await loadLedgerState(context, config);
    const actionable = await resolveActionableIntent(
      context,
      config,
      ledger,
      intentId,
      "execute",
    );
    const fill = computePaperFill({
      intent: actionable,
      config,
      now: context.now,
    });
    await appendLedgerEvent(
      ledgerPathFor(context.root, config),
      buildLedgerEvent(
        "intent_filled",
        actionable.intentId,
        context.now,
        "operator",
        { fill },
      ),
    );
    const refreshed = await loadLedgerState(context, config);
    const updated = findIntent(refreshed, intentId);
    if (updated === undefined) {
      throw new AutobetError(
        "internal_error",
        `intent vanished after execute: ${intentId}`,
      );
    }
    return emitSuccess(context, "execute", { intent: updated, fill });
  });
}

async function cmdSettle(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("settle", tokens, {
    valueFlags: ["--result"],
    shortAliases: { "-e": "--result" },
  });
  const intentId = requireSinglePositional("settle", flags, "<intentId>");
  const resultRaw = requireFlagValue("settle", flags, "--result");
  if (resultRaw !== "won" && resultRaw !== "lost" && resultRaw !== "void") {
    usageError("settle", "--result must be one of won, lost, void");
  }
  const result: SettlementResult = resultRaw;

  const config = await loadConfig(context);
  return withLedgerLock(ledgerPathFor(context.root, config), async () => {
    const ledger = await loadLedgerState(context, config);
    const actionable = await resolveActionableIntent(
      context,
      config,
      ledger,
      intentId,
      "settle",
    );
    const fill = actionable.fill;
    if (fill === null) {
      throw new AutobetError(
        "internal_error",
        `intent ${intentId} is filled but has no fill snapshot`,
      );
    }
    const settlement = computeSettlement(fill, result, context.now);
    await appendLedgerEvent(
      ledgerPathFor(context.root, config),
      buildLedgerEvent(
        "intent_settled",
        actionable.intentId,
        context.now,
        "operator",
        { settlement },
      ),
    );
    const refreshed = await loadLedgerState(context, config);
    const updated = findIntent(refreshed, intentId);
    if (updated === undefined) {
      throw new AutobetError(
        "internal_error",
        `intent vanished after settle: ${intentId}`,
      );
    }
    return emitSuccess(context, "settle", {
      intent: updated,
      settlement,
      ledgerSummary: refreshed.summary,
    });
  });
}

async function cmdJournal(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("journal", tokens, {
    valueFlags: ["--limit"],
    shortAliases: { "-l": "--limit" },
  });
  assertNoPositionals("journal", flags);
  const limit = integerFlag("journal", flags, "--limit", 100, 1, 500);
  const config = await loadConfig(context);
  const ledger = await loadLedgerState(context, config);
  const events = ledger.events.slice(Math.max(0, ledger.events.length - limit));
  return emitSuccess(context, "journal", {
    path: config.ledgerPath,
    events,
    summary: ledger.summary,
  });
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

async function sleepWhile(
  totalMs: number,
  shouldStop: () => boolean,
): Promise<void> {
  const stepMs = 100;
  let waited = 0;
  while (waited < totalMs && !shouldStop()) {
    const chunk = Math.min(stepMs, totalMs - waited);
    await sleepFor(chunk);
    waited += chunk;
  }
}

/**
 * Automation loop: one enqueue cycle per interval, one JSON line per cycle. Never executes.
 * SIGINT/SIGTERM stop the loop at the next tick boundary.
 */
async function cmdWatch(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("watch", tokens, {
    valueFlags: ["--interval-seconds"],
    shortAliases: { "-i": "--interval-seconds" },
  });
  assertNoPositionals("watch", flags);
  const intervalSeconds = integerFlag(
    "watch",
    flags,
    "--interval-seconds",
    60,
    30,
    Number.MAX_SAFE_INTEGER,
  );
  const config = await loadConfig(context);

  let stopping = false;
  const onSignal = (): void => {
    stopping = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    while (!stopping) {
      const cycleNow = context.nowFixed ? context.now : new Date();
      const cycleLedgerAbsolute = ledgerPathFor(context.root, config);
      // One watch cycle is one writer: it holds the same lock an operator command takes, so the
      // loop can never interleave with an approve/execute/settle and poison the ledger.
      const cycle = await withLedgerLock(cycleLedgerAbsolute, async () => {
        const ledger = await loadLedgerState(context, config, cycleNow);
        const snapshot = await loadAutobetSignals(
          context.root,
          config,
          cycleNow,
        );
        const plan = planEnqueues(snapshot.signals, {
          config,
          now: cycleNow,
          intents: ledger.intents,
          actor: "watch",
        });
        for (const intent of plan.wouldQueue) {
          await appendLedgerEvent(
            cycleLedgerAbsolute,
            buildLedgerEvent(
              "intent_created",
              intent.intentId,
              cycleNow,
              "watch",
              intentCreatedEventData(intent),
            ),
          );
        }
        const refreshed = await loadLedgerState(context, config, cycleNow);
        return {
          created: plan.wouldQueue.map((intent) => ({
            intentId: intent.intentId,
            signalId: intent.signalId,
            stakeUsd: intent.stakeUsd,
          })),
          skipped: plan.skipped.map(skippedEnqueueJson),
          ledger: {
            path: config.ledgerPath,
            events: refreshed.events.length,
            intents: countIntentsByStatus(refreshed.intents, cycleNow),
          },
        };
      });
      process.stdout.write(
        `${JSON.stringify({ at: cycleNow.toISOString(), ...cycle })}\n`,
      );
      if (stopping) break;
      await sleepWhile(intervalSeconds * 1_000, () => stopping);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return EXIT_OK;
}

/* -------------------------------------------------------------------------- */
/* Entrypoint                                                                  */
/* -------------------------------------------------------------------------- */

async function dispatch(
  command: string,
  args: readonly string[],
  context: CliContext,
): Promise<number> {
  switch (command) {
    case "status":
      return cmdStatus(args, context);
    case "signals":
      return cmdSignals(args, context);
    case "candidates":
      return cmdCandidates(args, context);
    case "accounts":
      return cmdAccounts(args, context);
    case "plan":
      return cmdPlan(args, context);
    case "enqueue":
      return cmdEnqueue(args, context);
    case "list":
      return cmdList(args, context);
    case "approve":
      return cmdApprove(args, context);
    case "reject":
      return cmdReject(args, context);
    case "execute":
      return cmdExecute(args, context);
    case "settle":
      return cmdSettle(args, context);
    case "journal":
      return cmdJournal(args, context);
    case "watch":
      return cmdWatch(args, context);
    default:
      usageError(
        command,
        "unknown command; run `bun run autobet --help` for the command table",
      );
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
  /** One-line summary for the root command table. */
  readonly summary: string;
  /** Usage tail after `bun run autobet `. */
  readonly usage: string;
  /** Paragraph lines printed under the usage line, before Arguments/Options. */
  readonly detail: readonly string[];
  readonly arguments?: readonly HelpRow[];
  /** Command-specific flags; every command also lists the global flags. */
  readonly options: readonly HelpRow[];
  readonly examples: readonly string[];
}

const HELP_GLOBAL_OPTIONS: readonly HelpRow[] = [
  {
    flags: "-h, --help",
    description:
      "Print this help, or one command's help with `<command> --help`.",
  },
  {
    flags: "-j, --json",
    description:
      "Print exactly one JSON object on stdout (diagnostics go to stderr).",
  },
  {
    flags: "-r, --root <path>",
    description: "Repo root for artifacts, config and ledger (default: cwd).",
  },
  {
    flags: "-c, --config <path>",
    description:
      "Config path relative to --root (default: config/watchlist-autobet.json).",
  },
  {
    flags: "-n, --now <iso>",
    description: "Testing clock: pin every derived timestamp (ISO-8601).",
  },
];

const HELP_COMMANDS: readonly CommandHelp[] = [
  {
    name: "status",
    summary: "Config, ledger and source-freshness snapshot",
    usage: "status [flags]",
    detail: [
      "Reads the config, the append-only ledger and the three signal artifacts (graph feed,",
      "clipboard wagers, pending capture). A missing file is reported as exists:false, never as",
      "zero events. `safety.liveExecution` is always false in v1.",
    ],
    options: [],
    examples: [
      "bun run autobet status --json",
      "bun run autobet status -j -r /tmp/autobet-root",
    ],
  },
  {
    name: "signals",
    summary: "Derived watchlist signals with per-signal gate verdicts",
    usage:
      "signals [--limit N] [--min-confidence 0..100] [--include-rejected] [flags]",
    detail: [
      "Derives watchlist signals with lib/watchlist_signal_engine.ts and prints the closed gate",
      "verdict for each: enabled, league, fixture provenance, freshness, confidence, distinct",
      "accounts, one-sided share, reference price, stake and caps, duplicate intent.",
      "Ineligible signals are hidden by default; --include-rejected shows them with failed ids.",
    ],
    options: [
      {
        flags: "-l, --limit <N>",
        description: "Maximum signals to print (1-200, default 50).",
      },
      {
        flags: "-m, --min-confidence <0..100>",
        description:
          "Pre-filter below this engine confidence (0-100, default 0); the config `minConfidence` gate still applies.",
      },
      {
        flags: "-i, --include-rejected",
        description: "Also print ineligible signals with their failed checks.",
      },
    ],
    examples: [
      "bun run autobet signals --json",
      "bun run autobet signals -i -m 60 -l 20",
      "bun run autobet signals --include-rejected --json",
    ],
  },
  {
    name: "candidates",
    summary: "Accounts in the captures that are not on the watchlist",
    usage: "candidates [--limit N] [--min-risk-usd 0..] [flags]",
    detail: [
      "Read-only discovery pass over the same three artifacts as `signals`: every login the",
      "watchlist registry does not cover, with the risk and latest bet time the captures show.",
      "Advisory only — it never queues, approves, fills or settles, and the signal engine still",
      "ignores these logins for derivation until an operator promotes the account.",
    ],
    options: [
      {
        flags: "-l, --limit <N>",
        description: "Maximum candidates to print (1-200, default 50).",
      },
      {
        flags: "--min-risk-usd <amount>",
        description:
          "Drop accounts whose summed capture risk is below this many dollars (default 0).",
      },
    ],
    examples: [
      "bun run autobet candidates --json",
      "bun run autobet candidates --min-risk-usd 100 -l 20",
    ],
  },
  {
    name: "accounts",
    summary: "Manage the operator watchlist overlay (list/add/remove)",
    usage:
      "accounts list | accounts add <login> --agent <id> [--category <cat>] [--archetype <text>] [--note <text>] [--actor <name>] | accounts remove <login> [--actor <name>]",
    detail: [
      "The built-in watchlist registry is code; this command maintains the untracked operator",
      "overlay (config/watchlist-accounts.json) that `signals`, `plan` and `enqueue` merge on top",
      "of it. Adding an account only makes its captured wagers eligible for the normal gates — it",
      "does not approve, fill or place anything. Built-in accounts are read-only here.",
      "Categories: POLY_ONCHAIN_CTF_WHALE, POLY_PARLAY_SYNDICATE, SUBNET_BRIDGED_SHARP,",
      "SIX_GATE_BET1_DISCOVERY, INTERNAL_F402_SHARP (default), FUNDING_DISTRIBUTOR_ROOT.",
    ],
    arguments: [
      {
        flags: "<subcommand>",
        description: "One of list, add or remove.",
      },
      {
        flags: "<login>",
        description:
          "Fantasy402 customer login, e.g. BRT104 or player_BRT104 (max 32 chars).",
      },
    ],
    options: [
      {
        flags: "--agent <agentId>",
        description:
          "Owning Fantasy402 sub-agent; required for add so the account keeps its 4-part identity.",
      },
      {
        flags: "--category <category>",
        description:
          "Source category that drives confidence weight (default INTERNAL_F402_SHARP).",
      },
      {
        flags: "--archetype <text>",
        description: "Free-text description shown in the signal account table.",
      },
      {
        flags: "--note <text>",
        description: "Free-text operator note (max 500 chars).",
      },
      {
        flags: "--actor <name>",
        description: "Who records the change (default: operator).",
      },
    ],
    examples: [
      "bun run autobet accounts list --json",
      "bun run autobet accounts add BRT104 --agent JACESFACES --actor operator --json",
      "bun run autobet accounts add player_DAN700 --agent DANHR --category INTERNAL_F402_SHARP --note 'top live risk' --json",
      "bun run autobet accounts remove BRT104 --actor operator --json",
    ],
  },
  {
    name: "plan",
    summary:
      "Dry run of enqueue: what would be queued, why the rest are skipped",
    usage: "plan [flags]",
    detail: [
      "Runs the same planner as `enqueue` but writes nothing. Lists the intents that would be",
      "queued, every skipped signal with reasons, and the desk-day/per-league cap usage, so the",
      "two commands cannot disagree.",
    ],
    options: [],
    examples: ["bun run autobet plan --json"],
  },
  {
    name: "enqueue",
    summary: "Append paper intents for eligible, non-duplicate signals",
    usage: "enqueue [--actor <name>] [flags]",
    detail: [
      "Appends one intent_created event per eligible, non-duplicate signal, bounded by the",
      "desk-day and per-league stake caps. Re-running is idempotent (the second run creates 0",
      "intents). It never approves or executes; it holds the cross-process ledger lock while it",
      "reads, plans and appends.",
    ],
    options: [
      {
        flags: "-a, --actor <name>",
        description: "Who records the enqueue (default: operator).",
      },
    ],
    examples: [
      "bun run autobet enqueue --actor operator --json",
      "bun run autobet enqueue -a cron --json --root /tmp/autobet-root",
    ],
  },
  {
    name: "list",
    summary: "Derived intents from the ledger, optionally by status",
    usage: "list [--status <status>] [--limit N] [flags]",
    detail: [
      "Folds the append-only ledger into intents in creation order. Expiry is derived at read",
      "time, so a past-due queued/approved intent reads as `expired` and can no longer be",
      "approved or executed.",
    ],
    options: [
      {
        flags: "-s, --status <status>",
        description:
          "Filter: queued, approved, filled, settled, rejected, expired.",
      },
      {
        flags: "-l, --limit <N>",
        description: "Maximum intents to print (1-500, default 100).",
      },
    ],
    examples: [
      "bun run autobet list --status queued --json",
      "bun run autobet list -s approved -l 20",
    ],
  },
  {
    name: "approve",
    summary: "Record a human approval: queued -> approved",
    usage: "approve <intentId> --actor <name> [--note <text>] [flags]",
    detail: [
      "Records an operator's approve decision on ONE queued paper intent and appends",
      "intent_approved under the ledger lock. Approval is a human decision and only records the",
      "decision given; execution is a separate confirm-gated step and approving never fills.",
    ],
    arguments: [
      { flags: "<intentId>", description: "Ledger intent id (wa-<uuid>)." },
    ],
    options: [
      {
        flags: "-a, --actor <name>",
        description: "Who recorded the decision (required).",
      },
      {
        flags: "-o, --note <text>",
        description: "Optional note stored with the approval event.",
      },
    ],
    examples: [
      'bun run autobet approve wa-<uuid> --actor operator --note "approved on desk"',
      "bun run autobet approve wa-<uuid> -a operator -o desk-check --json",
    ],
  },
  {
    name: "reject",
    summary: "Record a rejection with a reason; releases the reserved stake",
    usage: "reject <intentId> --actor <name> --reason <text> [flags]",
    detail: [
      "Rejects ONE queued or approved intent (reject requires a reason); the stake it reserved",
      "is released from the desk-day caps. Settled, rejected and expired intents are terminal",
      "and immutable.",
    ],
    arguments: [
      { flags: "<intentId>", description: "Ledger intent id (wa-<uuid>)." },
    ],
    options: [
      {
        flags: "-a, --actor <name>",
        description: "Who recorded the rejection (required).",
      },
      {
        flags: "-R, --reason <text>",
        description: "Why the intent was rejected (required, non-empty).",
      },
    ],
    examples: [
      'bun run autobet reject wa-<uuid> --actor operator --reason "stale signal"',
      'bun run autobet reject wa-<uuid> -a operator -R "dup syndicate" --json',
    ],
  },
  {
    name: "execute",
    summary: "Paper-fill one approved intent: approved -> filled",
    usage: "execute <intentId> [--venue paper] [flags]",
    detail: [
      "Paper-fills ONE approved, unexpired intent using paperSlippageBps and the watched",
      'accounts\' implied price (referenceSource "watchlist_signal.fairProb", not a market',
      "quote), and records paper P&L. The venue is pinned to paper: any other value is refused",
      "with live_disabled (exit 3) before any state is read. No live order path exists.",
    ],
    arguments: [
      {
        flags: "<intentId>",
        description: "Ledger intent id (wa-<uuid>) of an approved intent.",
      },
    ],
    options: [
      {
        flags: "-v, --venue <venue>",
        description: "Only `paper` is accepted (default: paper).",
      },
    ],
    examples: [
      "bun run autobet execute wa-<uuid> --json",
      "bun run autobet execute wa-<uuid> -v paper",
    ],
  },
  {
    name: "settle",
    summary: "Record won|lost|void for a filled intent and fold paper P&L",
    usage: "settle <intentId> --result <won|lost|void> [flags]",
    detail: [
      "Records the result of ONE paper-filled intent and folds it into the ledger summary",
      "(staked/settled stake, profit and ROI). Settlement moves no real money; it appends a",
      "settlement event to the local paper ledger.",
    ],
    arguments: [
      {
        flags: "<intentId>",
        description: "Ledger intent id (wa-<uuid>) of a filled intent.",
      },
    ],
    options: [
      {
        flags: "-e, --result <won|lost|void>",
        description: "Paper result to record (required).",
      },
    ],
    examples: [
      "bun run autobet settle wa-<uuid> --result won --json",
      "bun run autobet settle wa-<uuid> -e lost",
    ],
  },
  {
    name: "journal",
    summary: "Append-only ledger events (tail) plus the folded paper summary",
    usage: "journal [--limit N] [flags]",
    detail: [
      "Prints the tail of the raw append-only JSONL ledger and the folded paper summary. A",
      "malformed, unknown or transition-illegal line fails with ledger_corrupt and its 1-based",
      "line number; it is never skipped or repaired.",
    ],
    options: [
      {
        flags: "-l, --limit <N>",
        description: "Maximum recent events to print (1-500, default 100).",
      },
    ],
    examples: [
      "bun run autobet journal --json",
      "bun run autobet journal -l 20",
    ],
  },
  {
    name: "watch",
    summary: "Automation loop: enqueue cycle every interval; never executes",
    usage: "watch [--interval-seconds N] [flags]",
    detail: [
      "Runs one enqueue cycle per interval, printing one JSON line per cycle. It only queues",
      "intents for operator approval and NEVER approves or executes. SIGINT/SIGTERM stop the",
      "loop at the next tick boundary. For cron, prefer the one-shot `enqueue` command instead.",
    ],
    options: [
      {
        flags: "-i, --interval-seconds <N>",
        description: "Seconds between cycles (integer >= 30, default 60).",
      },
    ],
    examples: [
      "bun run autobet watch --interval-seconds 60 --json",
      "bun run autobet watch -i 300 --root /tmp/autobet-root",
    ],
  },
];

function formatHelpRows(rows: readonly HelpRow[]): string {
  const width = rows.reduce((max, row) => Math.max(max, row.flags.length), 0);
  return rows
    .map((row) => `  ${row.flags.padEnd(width)}  ${row.description}`)
    .join("\n");
}

function printRootHelp(): void {
  const nameWidth = HELP_COMMANDS.reduce(
    (max, command) => Math.max(max, command.name.length),
    0,
  );
  const commandTable = HELP_COMMANDS.map(
    (command) => `  ${command.name.padEnd(nameWidth)}  ${command.summary}`,
  ).join("\n");
  process.stdout
    .write(`watchlist autobet — paper-only bet intents over desk watchlist signals

Usage: bun run autobet <command> [flags] [args]

Commands:
${commandTable}

  <command> --help     Print detailed help for one command.

Safety: paper mode only. There is no live order path. \`enqueue\` only queues intents for
operator approval; \`execute\` fills the paper adapter only; read commands never write.

Global flags:
${formatHelpRows(HELP_GLOBAL_OPTIONS)}

Exit codes:
  0  ok
  1  error (config_missing, config_invalid, ledger_corrupt, ledger_locked, usage of a bad path, ...)
  2  usage_error (unknown command/flag, missing or invalid value)
  3  refusal (invalid_transition, intent_expired, live_disabled)

Examples:
  bun run autobet status --json
  bun run autobet signals --include-rejected --json
  bun run autobet enqueue --actor operator --json
  bun run autobet approve wa-<uuid> --actor operator --note "approved on desk"
  bun run autobet execute wa-<uuid> --json
  bun run autobet settle wa-<uuid> --result won --json
  bun run autobet watch --interval-seconds 60 --json   # queues only; never executes
`);
}

function printCommandHelp(command: CommandHelp): void {
  const lines: readonly string[] = [
    `Usage: bun run autobet ${command.usage}`,
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
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** `--help` prints the root table, or the named command's detailed page. */
function printHelp(commandName: string | undefined): void {
  if (commandName === undefined) {
    printRootHelp();
    return;
  }
  const command = HELP_COMMANDS.find((entry) => entry.name === commandName);
  if (command === undefined) {
    printRootHelp();
    return;
  }
  printCommandHelp(command);
}

async function main(): Promise<number> {
  const globalResult = parseGlobalArgs(process.argv.slice(2));
  if (!globalResult.ok) {
    emitFailure("unknown", globalResult.error);
    return globalResult.error.exitCode;
  }
  const global = globalResult.value;
  if (global.help) {
    printHelp(global.command);
    return EXIT_OK;
  }
  if (global.command === undefined || global.command.trim() === "") {
    emitFailure(
      "unknown",
      new AutobetError(
        "usage_error",
        "missing command; run `bun run autobet --help`",
      ),
    );
    return EXIT_USAGE;
  }
  const context: CliContext = {
    root: global.root,
    configRelPath: global.configRelPath,
    json: global.json,
    now: global.now,
    nowFixed: global.nowFixed,
  };
  try {
    return await dispatch(global.command, global.commandArgs, context);
  } catch (error) {
    const autobetError = toAutobetError(error);
    emitFailure(global.command, autobetError);
    return autobetError.exitCode;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
