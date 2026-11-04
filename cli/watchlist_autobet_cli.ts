#!/usr/bin/env bun
/**
 * Watchlist autobet CLI — paper-only bet intents over the desk's own watchlist signals.
 *
 * Safety boundary: this CLI never places a live order. `execute` only fills the paper adapter;
 * any other venue is refused with `live_disabled` (exit 3). Intents must be approved by an
 * operator before a paper fill, and the append-only ledger records every transition.
 *
 * Contract:
 * - one command per invocation: status | signals | plan | enqueue | list | approve | reject |
 *   execute | settle | journal | watch
 * - global flags anywhere on the line: --root <path>, --config <path>, --json, --now <iso>, -h
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

const EXIT_OK = 0;
const EXIT_USAGE = 2;

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
  return value === undefined || value === "" || value.startsWith("--");
}

/**
 * Global flags may appear before or after the subcommand, mixed with command flags (the DSH
 * plugin appends `--json` last). They are extracted from the whole line; everything else is
 * handed to the command parser, whose closed flag specs reject unknown flags.
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
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "-h" || token === "--help") {
      help = true;
      continue;
    }
    const equalsIndex = token.startsWith("--") ? token.indexOf("=") : -1;
    const flagName = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    if (
      flagName === "--root" ||
      flagName === "--config" ||
      flagName === "--now"
    ) {
      let value = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
      if (value === undefined) {
        const next = argv[index + 1];
        if (isMissingValue(next)) {
          return {
            ok: false,
            json,
            error: new AutobetError(
              "usage_error",
              `missing value for ${flagName}`,
            ),
          };
        }
        value = next as string;
        index += 1;
      }
      if (flagName === "--root") {
        root = resolve(value);
      } else if (flagName === "--config") {
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
    const equalsIndex = token.startsWith("--") ? token.indexOf("=") : -1;
    const flagName = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    if (flagName.startsWith("-")) {
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
        usageError(command, `unknown flag ${flagName}`);
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

  return emitSuccess(context, "signals", {
    sources: snapshot.sources.map(sourceJson),
    counts: {
      total: evaluations.length,
      eligible: eligible.length,
      rejected: evaluations.length - eligible.length,
    },
    signals: visible.slice(0, limit),
  });
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
      usageError(command, "unknown command; run --help");
  }
}

function printRootHelp(): void {
  process.stdout
    .write(`watchlist autobet — paper-only bet intents from desk watchlist signals

SAFETY: paper mode only. There is no live order path. Intents are queued for operator
approval; execute fills the paper adapter only and records referenceSource
"watchlist_signal.fairProb" (the watched accounts' implied price, not a market quote).

Commands:
  status                          Config, ledger and source-freshness snapshot
  signals [--limit N] [--min-confidence 0..100] [--include-rejected]
                                  Derived signals with their gate verdicts
  plan                            Dry run of enqueue (no writes)
  enqueue [--actor <name>]        Append intent_created for eligible signals
  list [--status <status>] [--limit N]
                                  Derived intents from the ledger
  approve <intentId> --actor <name> [--note <text>]
                                  queued -> approved (human decision)
  reject <intentId> --actor <name> --reason <text>
                                  queued/approved -> rejected
  execute <intentId> [--venue paper]
                                  approved -> filled (paper adapter only)
  settle <intentId> --result won|lost|void
                                  filled -> settled, paper P&L
  journal [--limit N]             Ledger events (tail) plus the paper summary
  watch [--interval-seconds N>=30]
                                  Enqueue loop; one JSON line per cycle; never executes

Global flags (accepted before or after the command):
  --root <path>      Repo root for artifacts/config/ledger (default: cwd)
  --config <path>    Config path relative to --root (default: config/watchlist-autobet.json)
  --json             Exactly one JSON object on stdout (plugin mode)
  --now <iso>        Testing clock; pins every derived timestamp
  -h, --help         This help

Examples:
  bun run autobet status --json
  bun run autobet signals --include-rejected --json
  bun run autobet enqueue --actor operator --json
  bun run autobet approve wa-<uuid> --actor operator --note "approved on desk"
  bun run autobet execute wa-<uuid> --venue paper --json
  bun run autobet settle wa-<uuid> --result won --json
  bun run autobet enqueue --json --root /tmp/autobet-e2e   # cron-friendly one-shot

Exit codes: 0 ok · 2 usage · 3 refusal (invalid_transition/intent_expired/live_disabled) · 1 other
`);
}

async function main(): Promise<number> {
  const globalResult = parseGlobalArgs(process.argv.slice(2));
  if (!globalResult.ok) {
    emitFailure("unknown", globalResult.error);
    return globalResult.error.exitCode;
  }
  const global = globalResult.value;
  if (global.help) {
    printRootHelp();
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
