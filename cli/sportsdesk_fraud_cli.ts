#!/usr/bin/env bun
/**
 * SportsDesk security/fraud CLI — the one implementation behind the `fraud_*` plugin tools.
 *
 * Contract: `Scratch/security/SECURITY-PLUGIN-CONTRACT.md` (rev 2).
 * - one command per invocation: status | bets | queue | ip-graph | weblog | patterns | explore |
 *   model | dossier | research; `model` subcommands are report (default) | fit | score <accountId>
 * - global flags anywhere: --root/-r, --json/-j, --now/-n, --help/-h; closed per-command flag
 *   specs (an unknown flag is a usage error, exit 2)
 * - `--json` stdout is exactly one object; diagnostics go to stderr
 * - exit codes: 0 ok, 2 usage_error, 3 refusal (source_missing / insufficient_corpus /
 *   model_missing / unknown_subject), 1 everything else
 *
 * Read-only, always: no network, no secrets/keychain, no artifact mutation. The single write is
 * `model fit --write` → `reports/security/fraud-model.json` (atomic tmp+rename, mode 0600).
 *
 * Honesty floor: every success payload carries `sources: FraudSourceState[]` (MISSING ≠ 0,
 * fixture ≠ observation) and a `timing` block with the measured wall time; every refusal carries
 * the measured source states in `error.details.sources`.
 */

import { join, resolve } from "node:path";

import {
  FRAUD_CONFIG_REL_PATH,
  FRAUD_MODEL_FIT_COMMAND,
  FRAUD_SCHEMA_VERSION,
  aggregateBets,
  compactSourceStates,
  filterBets,
  ipGraphSummary,
  listIpClusters,
  listPrefixClusters,
  loadFraudPerception,
  resolveDossierSubject,
  subjectBetAggregate,
  toBetRecord,
  type BetsFilters,
  type FraudCorpus,
  type FraudPerception,
  type FraudSourceState,
  type IpCluster,
} from "../lib/fraud_logs.ts";
import {
  FRAUD_CATEGORIES,
  FRAUD_SEVERITIES,
  filterFraudPatterns,
  findingsForSubject,
  runFraudPatterns,
  type FraudFinding,
  type FraudFindingCategory,
  type FraudPatternFilters,
  type FraudPatternResult,
  type FraudFindingSeverity,
} from "../lib/fraud_patterns.ts";
import {
  FRAUD_MODEL_REL_PATH,
  FraudModelError,
  extractFraudFeatures,
  fitFraudModel,
  fraudModelLimits,
  modelMissingRefusal,
  modelReportPayload,
  readFraudModel,
  scoreAccountWithModel,
  writeFraudModelArtifact,
  type FraudAccountScore,
  type FraudFeatureMatrix,
  type FraudFitOptions,
  type FraudModelArtifact,
  type FraudModelState,
  type FraudProxyLabel,
} from "../lib/fraud_model.ts";
import {
  buildFraudQueue,
  type FraudQueueModelSummary,
  type FraudQueueScore,
} from "../lib/fraud_queue.ts";
import { buildFraudExploration } from "../lib/fraud_explore.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_REFUSAL = 3;
const EXIT_ERROR = 1;

type RefusalCode =
  | "source_missing"
  | "insufficient_corpus"
  | "model_missing"
  | "unknown_subject";

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
/* Global args                                                                 */
/* -------------------------------------------------------------------------- */

interface CliContext {
  readonly root: string;
  readonly json: boolean;
  readonly now: Date;
  readonly nowFixed: boolean;
  readonly startedAt: number;
  perception: FraudPerception | null;
}

interface GlobalArgs {
  readonly root: string;
  readonly json: boolean;
  readonly now: Date;
  readonly nowFixed: boolean;
  readonly help: boolean;
  readonly command: string | undefined;
  readonly commandArgs: readonly string[];
}

type GlobalParseResult =
  | { readonly ok: true; readonly value: GlobalArgs }
  | { readonly ok: false; readonly error: CliError; readonly json: boolean };

function isMissingValue(value: string | undefined): boolean {
  return value === undefined || value === "" || value.startsWith("-");
}

/** Canonical long name for every global value flag; single-dash aliases share it. */
const GLOBAL_VALUE_FLAGS: Readonly<Record<string, "--root" | "--now">> = {
  "--root": "--root",
  "-r": "--root",
  "--now": "--now",
  "-n": "--now",
};

function parseGlobalArgs(argv: readonly string[]): GlobalParseResult {
  let root = process.cwd();
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
      } else {
        const parsed = new Date(value);
        if (!Number.isFinite(parsed.getTime())) {
          return {
            ok: false,
            json,
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
      json,
      now,
      nowFixed,
      help,
      command: rest[0],
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
  // Envelope fields win over payload fields: `command` is always the command NAME, never a
  // shell line or a payload value (the plugin routes on it).
  const body = {
    ...payload,
    success: true,
    schemaVersion: FRAUD_SCHEMA_VERSION,
    command,
    generatedAt: context.now.toISOString(),
    timing: {
      elapsedMs: Math.round(performance.now() - context.startedAt),
      corpusParseMs:
        context.perception?.timing.corpusParseMs === null ||
        context.perception === null
          ? null
          : Math.round(context.perception.timing.corpusParseMs ?? 0),
    },
  };
  process.stdout.write(
    context.json
      ? `${JSON.stringify(body)}\n`
      : `${JSON.stringify(body, null, 2)}\n`,
  );
  return EXIT_OK;
}

function emitFailure(command: string, error: CliError, json: boolean): number {
  const body = {
    success: false,
    schemaVersion: FRAUD_SCHEMA_VERSION,
    command,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  process.stdout.write(
    json ? `${JSON.stringify(body)}\n` : `${JSON.stringify(body, null, 2)}\n`,
  );
  process.stderr.write(`${error.code}: ${error.message}\n`);
  return error.exitCode;
}

/* -------------------------------------------------------------------------- */
/* Argument parsing (closed flag specs; unknown flag = usage_error)            */
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
  return `run \`bun run cli/sportsdesk_fraud_cli.ts ${command} --help\` for flags`;
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

function isoFlag(
  command: string,
  flags: CommandFlags,
  name: string,
): Date | null {
  const raw = flags.values.get(name);
  if (raw === undefined) return null;
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    usageError(command, `${name} must be an ISO-8601 timestamp, got "${raw}"`);
  }
  return parsed;
}

function booleanFlag(
  command: string,
  flags: CommandFlags,
  name: string,
  fallback: boolean,
): boolean {
  const raw = flags.values.get(name);
  if (raw === undefined) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  usageError(command, `${name} must be one of true, false, 1, 0`);
}

function isSeverity(value: string): value is FraudFindingSeverity {
  return (FRAUD_SEVERITIES as readonly string[]).includes(value);
}

function isCategory(value: string): value is FraudFindingCategory {
  return (FRAUD_CATEGORIES as readonly string[]).includes(value);
}

function isProxy(value: string): value is FraudProxyLabel {
  return (
    value === "desk_flag" ||
    value === "suspected_bot" ||
    value === "reversed_credit"
  );
}

/* -------------------------------------------------------------------------- */
/* Perception (loaded once per invocation)                                     */
/* -------------------------------------------------------------------------- */

async function perceptionOf(context: CliContext): Promise<FraudPerception> {
  if (context.perception !== null) return context.perception;
  const perception = await loadFraudPerception({
    root: context.root,
    now: context.now,
  });
  context.perception = perception;
  return perception;
}

function sourceStates(
  perception: FraudPerception,
): readonly FraudSourceState[] {
  return perception.sources;
}

function requireCorpus(
  perception: FraudPerception,
  command: string,
): FraudCorpus {
  if (perception.corpus === null) {
    throw new CliRefusal(
      "source_missing",
      `${command}: the GSLive getBetReport corpus is MISSING (not zero rows); corpus commands cannot run`,
      {
        source: "gslive_bet_report",
        sources: perception.sources,
      },
    );
  }
  return perception.corpus;
}

function toModelError(error: FraudModelError): never {
  if (error.code === "insufficient_corpus") {
    throw new CliRefusal("insufficient_corpus", error.message, error.details);
  }
  if (error.code === "unknown_subject") {
    throw new CliRefusal("unknown_subject", error.message, error.details);
  }
  // An unreadable fitted artifact is reported as not-fitted (`model_missing`), never as a
  // half-working model: the UI's Model tab keys off this refusal.
  if (
    error.code === "model_missing" ||
    error.code === "invalid_model_artifact"
  ) {
    throw new CliRefusal("model_missing", error.message, error.details);
  }
  throw new CliError(error.code, error.message, error.details, EXIT_ERROR);
}

function findingSubset(
  result: FraudPatternResult,
  ids: readonly string[],
): readonly FraudFinding[] {
  return result.findings.filter((finding) => ids.includes(finding.id));
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
  const perception = await perceptionOf(context);
  const model = await readFraudModel(context.root);
  const corpusSummary =
    perception.corpus === null
      ? null
      : {
          rows: perception.corpus.rows,
          accounts: perception.corpus.accounts,
          agents: perception.corpus.agents,
          ips: perception.corpus.ipIndex.distinctIps,
          window: perception.corpus.window,
          sha256: perception.corpus.sha256,
          malformed: perception.corpus.malformed,
          path: perception.corpus.source.path,
          parseMs: Math.round(perception.corpus.parseMs),
        };
  const corpusState = perception.sources.find(
    (source) => source.id === "gslive_bet_report",
  );
  const weblogsState = perception.sources.find(
    (source) => source.id === "gslive_weblogs",
  );
  const nextStep = ((): string => {
    if (perception.corpus === null) {
      return `restore the GSLive bet-report corpus (${corpusState?.reason ?? "source missing"}), then run \`bun run cli/sportsdesk_fraud_cli.ts model fit --json\``;
    }
    if (!model.state.present) {
      return `review the candidate model with \`bun run cli/sportsdesk_fraud_cli.ts model fit --json\`, then commit the artifact with \`${FRAUD_MODEL_FIT_COMMAND}\``;
    }
    return `model fitted at ${model.state.fittedAt ?? "unknown"}; inspect \`model report --json\` or \`patterns --json\``;
  })();
  const sources = sourceStates(perception);
  const provenanceCounts: Record<string, number> = {};
  for (const source of sources) {
    provenanceCounts[source.provenance] =
      (provenanceCounts[source.provenance] ?? 0) + 1;
  }
  const payload = {
    config: {
      path: perception.configPath,
      exists: perception.configExists,
      note: perception.configNote,
      schemaVersion: perception.config.schemaVersion,
    },
    corpus: corpusSummary,
    model: model.state,
    sources,
    dataHandling: {
      masking: {
        rawIpEmitted: false,
        maskedFields: ["ipMasked", "ipTag", "ipPrefix24"],
        policy:
          "raw ipAddress is masked at the parse boundary (lib/fraud_logs.ts maskIp); no raw IP is serialized",
        selfCheck: "no IPv4 literal in this payload",
      },
      integrity: {
        sources: sources.length,
        withSha256: sources
          .filter((source) => source.sha256 !== null)
          .map((source) => source.id),
        withoutSha256: sources
          .filter((source) => source.sha256 === null)
          .map((source) => source.id),
        fixtureSources: sources
          .filter((source) => source.provenance === "fixture")
          .map((source) => source.id),
        missingSources: sources
          .filter((source) => !source.exists)
          .map((source) => source.id),
        provenance: provenanceCounts,
      },
      auditability: {
        envelope: ["sources", "timing"],
        modelFitsExcludeFixtures: true,
        modelProxy: "weak-label desk_flag proxy, not a fraud probability",
      },
      limits: [
        "The self-check is a refused-payload guard, not a claim about upstream logs.",
        "A missing sha256 means the source could not be hashed (send a sidecar for large files).",
        "Fixture sources are labelled fixture and are never fitted.",
      ],
    },
    weblogs: {
      status: perception.weblogs.status,
      asOf: perception.weblogs.asOf,
      accounts: perception.weblogs.summary.accounts,
      stale: perception.weblogs.stale,
      command: perception.weblogs.command,
      ...(perception.weblogs.reason === undefined
        ? {}
        : { reason: perception.weblogs.reason }),
      expectedState: weblogsState?.state ?? null,
    },
    nextStep,
  };
  const serialized = JSON.stringify(payload);
  if (/(?:\d{1,3}\.){3}\d{1,3}/.test(serialized)) {
    throw new CliError(
      "data_handling_violation",
      "status: payload contains an IPv4 literal; refusing to print it",
      {},
      EXIT_ERROR,
    );
  }
  return emitSuccess(context, "status", payload);
}

/**
 * Ranked account triage queue. Deterministic and transparent: findings by severity, then the
 * fitted model's proxy score, then bet rows. The model is optional; without an artifact the queue
 * still ranks on findings/flags and reports the model as absent (never as zero scores).
 */
async function cmdQueue(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("queue", tokens, {
    valueFlags: ["--limit"],
    shortAliases: { "-l": "--limit" },
  });
  assertNoPositionals("queue", flags);
  const limit = integerFlag("queue", flags, "--limit", 25, 1, 100);
  const perception = await perceptionOf(context);
  const corpus = requireCorpus(perception, "queue");
  const patterns = runFraudPatterns(perception);
  const model = await readFraudModel(context.root);

  let scoreOf: ((accountId: string) => FraudQueueScore | null) | undefined;
  let modelSummary: FraudQueueModelSummary;
  if (model.artifact === null) {
    modelSummary = { present: false, reason: model.state.reason };
  } else {
    const artifact = model.artifact;
    const matrix = extractFraudFeatures(corpus.records, {
      featureIds: perception.config.features.map((feature) => feature.id),
      datacenterClasses: perception.config.detectors.datacenterClasses,
    });
    const cache = new Map<string, FraudQueueScore | null>();
    scoreOf = (accountId: string): FraudQueueScore | null => {
      const key = accountId.toUpperCase();
      if (cache.has(key)) return cache.get(key) ?? null;
      const score = scoreAccountWithModel(artifact, matrix, accountId);
      const value =
        score === null ? null : { score: score.score, band: score.band };
      cache.set(key, value);
      return value;
    };
    modelSummary = {
      present: true,
      fittedAt: artifact.fittedAt,
      proxy: artifact.proxy,
      corpusSha256: artifact.corpusSha256,
    };
  }

  const queue = buildFraudQueue({
    corpus,
    findings: patterns.findings,
    scoreOf,
    model: modelSummary,
    limit,
    insufficient: patterns.insufficient,
  });
  return emitSuccess(context, "queue", {
    ...queue,
    sources: sourceStates(perception),
  });
}

async function cmdBets(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("bets", tokens, {
    valueFlags: [
      "--agent",
      "--account",
      "--state",
      "--since",
      "--limit",
      "--include-bots",
    ],
    shortAliases: { "-a": "--agent", "-l": "--limit" },
  });
  assertNoPositionals("bets", flags);
  const limit = integerFlag("bets", flags, "--limit", 25, 1, 200);
  const stateRaw = flags.values.get("--state");
  const state =
    stateRaw === undefined
      ? null
      : ((): number => {
          const parsed = Number(stateRaw);
          if (!Number.isInteger(parsed)) {
            usageError("bets", "--state must be an integer state code");
          }
          return parsed;
        })();
  const filters: BetsFilters = {
    agent: flags.values.get("--agent") ?? null,
    account: flags.values.get("--account") ?? null,
    state,
    since: isoFlag("bets", flags, "--since"),
    includeBots: booleanFlag("bets", flags, "--include-bots", true),
  };
  const perception = await perceptionOf(context);
  const corpus = requireCorpus(perception, "bets");
  const filtered = filterBets(corpus.records, filters);
  const aggregate = aggregateBets(filtered);
  const sample = filtered.slice(0, limit).map(toBetRecord);
  return emitSuccess(context, "bets", {
    filters: {
      agent: filters.agent,
      account: filters.account,
      state: filters.state,
      since: filters.since === null ? null : filters.since.toISOString(),
      includeBots: filters.includeBots,
      limit,
    },
    aggregate,
    sample,
    sampleCount: sample.length,
    sources: sourceStates(perception),
  });
}

function clusterForAccount(
  corpus: FraudCorpus,
  accountId: string,
  limit: number,
): readonly IpCluster[] {
  const tags = corpus.ipIndex.byAccount.get(accountId) ?? new Set<string>();
  const clusters: IpCluster[] = [];
  for (const tag of tags) {
    const node = corpus.ipIndex.byIp.get(tag);
    if (node === undefined) continue;
    clusters.push({
      key: `ip:${tag}`,
      masked: node.masked,
      prefix24: node.prefix24,
      accounts: node.accounts.size,
      bets: node.bets,
      sampleAccounts: node.sampleAccounts.slice(0, 5),
      sharedIp: node.accounts.size >= 2,
      botRingRange: node.botRingRange,
      datacenterClass:
        node.ipClass === "OTHER" || node.ipClass === "UNKNOWN"
          ? null
          : node.ipClass,
    });
  }
  clusters.sort((a, b) => b.bets - a.bets || b.accounts - a.accounts);
  return clusters.slice(0, limit);
}

async function cmdIpGraph(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("ip-graph", tokens, {
    valueFlags: ["--min-accounts", "--limit", "--prefix24"],
    shortAliases: { "-l": "--limit" },
  });
  assertNoPositionals("ip-graph", flags);
  const minAccounts = integerFlag(
    "ip-graph",
    flags,
    "--min-accounts",
    2,
    1,
    1000,
  );
  const limit = integerFlag("ip-graph", flags, "--limit", 25, 1, 100);
  const prefix24Raw = flags.values.get("--prefix24");
  if (
    prefix24Raw !== undefined &&
    !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(prefix24Raw)
  ) {
    usageError("ip-graph", "--prefix24 must look like a.b.c");
  }
  const perception = await perceptionOf(context);
  const corpus = requireCorpus(perception, "ip-graph");
  const clusters =
    prefix24Raw === undefined
      ? listIpClusters(corpus, { minAccounts, limit })
      : listPrefixClusters(corpus, {
          minAccounts,
          limit,
          prefix24: prefix24Raw,
        });
  return emitSuccess(context, "ip-graph", {
    filters: { minAccounts, limit, prefix24: prefix24Raw ?? null },
    clusters,
    summary: ipGraphSummary(corpus, minAccounts),
    sources: sourceStates(perception),
  });
}

async function cmdWeblog(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("weblog", tokens);
  assertNoPositionals("weblog", flags);
  const perception = await perceptionOf(context);
  const patterns = runFraudPatterns(perception);
  const weblogFindingIds = [
    "EXECUTION_SNIPERS",
    "SNIPER_TWINS",
    "LINE_SHOPPERS",
    "BOT_RING_ACCOUNTS",
    "CROSS_OFFICE_BEARDS",
    "IP_CLASS_ANOMALY",
    "WEBLOG_GATE_FAIL",
  ];
  const posture = perception.weblogPosture;
  const rollupState = perception.sources.find(
    (source) => source.id === "f402_weblog_rollup",
  );
  return emitSuccess(context, "weblog", {
    posture,
    flags: findingSubset(patterns, weblogFindingIds),
    gates: posture?.gates ?? [],
    insufficientReason:
      posture === null
        ? (rollupState?.reason ??
          "no F402 WebLog rollup artifact: counts are unavailable (MISSING, not zero)")
        : null,
    weblogsActivity: {
      status: perception.weblogs.status,
      asOf: perception.weblogs.asOf,
      stale: perception.weblogs.stale,
      accounts: perception.weblogs.summary.accounts,
      bets: perception.weblogs.summary.bets,
      flagsByCode: perception.weblogs.summary.flagsByCode,
      reason: perception.weblogs.reason ?? null,
      command: perception.weblogs.command,
    },
    sources: sourceStates(perception),
  });
}

async function cmdPatterns(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("patterns", tokens, {
    valueFlags: ["--min-severity", "--category", "--agent", "--limit"],
    shortAliases: { "-l": "--limit" },
  });
  assertNoPositionals("patterns", flags);
  const minSeverityRaw = flags.values.get("--min-severity") ?? "info";
  if (!isSeverity(minSeverityRaw)) {
    usageError(
      "patterns",
      "--min-severity must be one of critical, high, medium, low, info",
    );
  }
  const categoryRaw = flags.values.get("--category");
  if (categoryRaw !== undefined && !isCategory(categoryRaw)) {
    usageError(
      "patterns",
      `--category must be one of ${FRAUD_CATEGORIES.join(", ")}`,
    );
  }
  const filters: FraudPatternFilters = {
    minSeverity: minSeverityRaw,
    category: categoryRaw ?? null,
    agent: flags.values.get("--agent") ?? null,
    limit: integerFlag("patterns", flags, "--limit", 100, 1, 200),
  };
  const perception = await perceptionOf(context);
  const result = runFraudPatterns(perception);
  const filtered = filterFraudPatterns(result, filters);
  return emitSuccess(context, "patterns", {
    filters,
    findings: filtered.findings,
    counts: filtered.counts,
    insufficient: filtered.insufficient,
    sources: sourceStates(perception),
  });
}

async function loadModelArtifact(context: CliContext): Promise<{
  artifact: FraudModelArtifact;
  state: FraudModelState;
}> {
  const result = await readFraudModel(context.root);
  if (result.artifact === null) {
    const refusal = modelMissingRefusal();
    throw new CliRefusal("model_missing", refusal.message, {
      ...refusal.details,
      reason: result.state.reason,
    });
  }
  return { artifact: result.artifact, state: result.state };
}

async function cmdModelReport(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("model", tokens, {
    switchFlags: ["--include-score-map"],
  });
  assertNoPositionals("model", flags);
  const includeScoreMap = flags.switches.has("--include-score-map");
  const { artifact, state } = await loadModelArtifact(context);
  const perception = await perceptionOf(context);
  return emitSuccess(context, "model", {
    action: "report",
    ...modelReportPayload(artifact, state, { includeScoreMap }),
    // Compact source projection keeps the report payload under the size budget; the full
    // forensic states (path/sha256/bytes/mtime) are always on `status`.
    sources: compactSourceStates(sourceStates(perception)),
  });
}

async function cmdModelFit(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("model", tokens, {
    valueFlags: ["--split", "--l2", "--epochs", "--proxy"],
    switchFlags: ["--write"],
  });
  assertNoPositionals("model", flags);
  const write = flags.switches.has("--write");
  const modelDefaults = (await perceptionOf(context)).config.model;
  const split = numberFlag(
    "model",
    flags,
    "--split",
    modelDefaults.split,
    0.5,
    0.9,
  );
  const l2 = numberFlag("model", flags, "--l2", modelDefaults.l2, 0, 1);
  const epochs = integerFlag(
    "model",
    flags,
    "--epochs",
    modelDefaults.epochs,
    100,
    5000,
  );
  const proxyRaw = flags.values.get("--proxy") ?? modelDefaults.proxy;
  if (!isProxy(proxyRaw)) {
    usageError(
      "model",
      "--proxy must be one of desk_flag, suspected_bot, reversed_credit",
    );
  }
  const perception = await perceptionOf(context);
  const corpus = requireCorpus(perception, "model");
  const options: Partial<FraudFitOptions> = {
    proxy: proxyRaw,
    split,
    l2,
    epochs,
  };
  let result;
  try {
    result = fitFraudModel({
      corpus,
      options,
      config: perception.config,
      now: context.now,
      sources: perception.sources,
    });
  } catch (error) {
    if (error instanceof FraudModelError) toModelError(error);
    throw error;
  }
  let writtenPath: string | null = null;
  if (write) {
    writtenPath = await writeFraudModelArtifact(context.root, result.artifact);
  }
  return emitSuccess(context, "model", {
    action: "fit",
    written: write,
    path: FRAUD_MODEL_REL_PATH,
    writtenPath,
    fitCommand: FRAUD_MODEL_FIT_COMMAND,
    note: write
      ? `artifact written atomically to ${FRAUD_MODEL_REL_PATH} (mode 0600)`
      : "DRY RUN: nothing was written. Re-run with `--write` only after an operator reviews these metrics.",
    extraction: result.extraction,
    summary: {
      proxy: result.artifact.proxy,
      rows: result.artifact.corpusRows,
      split: result.artifact.split,
      featureCount: result.artifact.spec.featureCount,
      aucRoc: result.artifact.metrics.aucRoc,
      averagePrecision: result.artifact.metrics.averagePrecision,
      prevalence: result.artifact.metrics.labelSupport.prevalence,
      labelSupport: result.artifact.metrics.labelSupport,
      epochsRun: result.artifact.spec.epochsRun,
      converged: result.artifact.spec.converged,
      stability: result.artifact.validation.stability,
      warnings: result.artifact.validation.warnings,
      topDrift: result.artifact.validation.drift.slice(0, 5),
    },
    artifact: result.artifact,
    sources: sourceStates(perception),
  });
}

async function cmdModelScore(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("model", tokens);
  const accountId = requireSinglePositional(
    "model score",
    flags,
    "<accountId>",
  );
  const { artifact } = await loadModelArtifact(context);
  const perception = await perceptionOf(context);
  const corpus = requireCorpus(perception, "model score");
  const matrix = extractFraudFeatures(corpus.records, {
    featureIds: perception.config.features.map((feature) => feature.id),
    datacenterClasses: perception.config.detectors.datacenterClasses,
  });
  const score = scoreAccountWithModel(artifact, matrix, accountId);
  if (score === null) {
    throw new CliRefusal(
      "unknown_subject",
      `model score: account "${accountId}" is not present in the corpus`,
      { accountId, corpusRows: corpus.rows, accounts: corpus.accounts },
    );
  }
  const patterns = runFraudPatterns(perception);
  return emitSuccess(context, "model", {
    action: "score",
    account: score,
    findings: findingsForSubject(patterns.findings, {
      kind: "account",
      id: accountId,
    }),
    provenance: {
      modelFittedAt: artifact.fittedAt,
      proxy: artifact.proxy,
      corpusSha256: artifact.corpusSha256,
      limits: fraudModelLimits(),
    },
    sources: sourceStates(perception),
  });
}

async function cmdModel(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const [subcommand, ...rest] = tokens;
  if (subcommand === undefined) {
    return cmdModelReport(tokens, context);
  }
  if (subcommand === "report") return cmdModelReport(rest, context);
  if (subcommand === "fit") return cmdModelFit(rest, context);
  if (subcommand === "score") return cmdModelScore(rest, context);
  if (subcommand.startsWith("-")) {
    // `model --split 0.8 --write` keeps report as the default action.
    return cmdModelReport(tokens, context);
  }
  usageError(
    "model",
    `unknown subcommand "${subcommand}" (expected report, fit, score)`,
  );
}

async function cmdDossier(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("dossier", tokens);
  const id = requireSinglePositional("dossier", flags, "<accountId|agentId>");
  const perception = await perceptionOf(context);
  if (perception.corpus === null && perception.agentIndex === null) {
    throw new CliRefusal(
      "source_missing",
      "dossier: neither the GSLive corpus nor the agent index is present; the subject cannot be resolved",
      { sources: perception.sources },
    );
  }
  const subject = resolveDossierSubject(perception, id);
  if (subject === null) {
    throw new CliRefusal(
      "unknown_subject",
      `dossier: "${id}" is not a known account or agent in the corpus/agent index`,
      {
        id,
        corpusPresent: perception.corpus !== null,
        agentIndexPresent: perception.agentIndex !== null,
        knownAccounts: perception.corpus?.accounts ?? null,
        knownAgents: perception.agentIndex?.agentCount ?? null,
      },
    );
  }
  const corpus = perception.corpus;
  const patterns = runFraudPatterns(perception);
  const subjectAgentId =
    subject.kind === "account"
      ? (corpus?.records.find(
          (record) => record.userId.toUpperCase() === subject.id.toUpperCase(),
        )?.agentId ?? null)
      : subject.id;
  const hierarchy = {
    ...(perception.agentIndex === null
      ? {
          agentId: subjectAgentId,
          parentAgent: null,
          level: null,
          agentType: null,
          rootAgent: null,
          chain: [],
        }
      : ((): Record<string, unknown> => {
          const chain: { id: string; level: number | null }[] = [];
          const seen = new Set<string>();
          let cursor = subjectAgentId;
          let rootAgent: string | null = null;
          while (cursor !== null && !seen.has(cursor)) {
            seen.add(cursor);
            const node = perception.agentIndex?.agents.get(cursor) ?? null;
            chain.push({ id: cursor, level: node?.level ?? null });
            rootAgent = cursor;
            cursor = node?.parent ?? null;
          }
          const node =
            subjectAgentId === null
              ? null
              : (perception.agentIndex?.agents.get(subjectAgentId) ?? null);
          return {
            agentId: subjectAgentId,
            parentAgent: node?.parent ?? null,
            level: node?.level ?? null,
            agentType: node?.type ?? null,
            rootAgent,
            chain,
          };
        })()),
  };
  const bets = corpus === null ? null : subjectBetAggregate(corpus, subject);
  const modelResult = await readFraudModel(context.root);
  const modelPayload: Record<string, unknown> =
    modelResult.artifact === null
      ? {
          present: false,
          score: null,
          band: null,
          contributions: [],
          reason: modelResult.state.reason,
          command: modelResult.state.command,
        }
      : ((): Record<string, unknown> => {
          const matrix = extractFraudFeatures(corpus?.records ?? [], {
            featureIds: perception.config.features.map((feature) => feature.id),
            datacenterClasses: perception.config.detectors.datacenterClasses,
          });
          if (subject.kind === "account") {
            const score = scoreAccountWithModel(
              modelResult.artifact,
              matrix,
              subject.id,
            );
            return score === null
              ? {
                  present: true,
                  score: null,
                  band: null,
                  contributions: [],
                  reason: "account not present in the extracted feature matrix",
                  command: null,
                }
              : {
                  present: true,
                  score: score.score,
                  band: score.band,
                  probabilityProxy: score.probability,
                  contributions: score.contributions,
                  reason: null,
                  command: null,
                };
          }
          const accountIds = new Set(
            (corpus?.records ?? [])
              .filter(
                (record) =>
                  record.agentId?.toUpperCase() === subject.id.toUpperCase(),
              )
              .map((record) => record.userId),
          );
          const scored = [...accountIds]
            .map((accountId) =>
              scoreAccountWithModel(
                modelResult.artifact as FraudModelArtifact,
                matrix,
                accountId,
              ),
            )
            .filter((score): score is FraudAccountScore => score !== null)
            .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
          const top = scored[0];
          return top === undefined
            ? {
                present: true,
                score: null,
                band: null,
                contributions: [],
                reason:
                  "no account under this agent appears in the feature matrix",
                command: null,
              }
            : {
                present: true,
                score: top.score,
                band: top.band,
                probabilityProxy: top.probability,
                contributions: top.contributions,
                reason:
                  "agent score = highest scored account under the agent (no separate agent-level model)",
                topAccount: {
                  accountId: top.accountId,
                  score: top.score,
                  band: top.band,
                },
                accountsScored: scored.length,
                command: null,
              };
        })();
  const clusters =
    corpus === null
      ? []
      : subject.kind === "account"
        ? clusterForAccount(corpus, subject.id, 10)
        : ((): readonly IpCluster[] => {
            const accountIds = new Set(
              corpus.records
                .filter(
                  (record) =>
                    record.agentId?.toUpperCase() === subject.id.toUpperCase(),
                )
                .map((record) => record.userId),
            );
            const seenTags = new Set<string>();
            for (const accountId of accountIds) {
              for (const tag of corpus.ipIndex.byAccount.get(accountId) ?? []) {
                seenTags.add(tag);
              }
            }
            const byTag = [...seenTags].flatMap((tag) => {
              const node = corpus.ipIndex.byIp.get(tag);
              if (node === undefined) return [];
              return [
                {
                  key: `ip:${tag}`,
                  masked: node.masked,
                  prefix24: node.prefix24,
                  accounts: node.accounts.size,
                  bets: node.bets,
                  sampleAccounts: node.sampleAccounts.slice(0, 5),
                  sharedIp: node.accounts.size >= 2,
                  botRingRange: node.botRingRange,
                  datacenterClass:
                    node.ipClass === "OTHER" || node.ipClass === "UNKNOWN"
                      ? null
                      : node.ipClass,
                } satisfies IpCluster,
              ];
            });
            byTag.sort((a, b) => b.accounts - a.accounts || b.bets - a.bets);
            return byTag.slice(0, 10);
          })();
  const evidence: { source: string; path: string; pointer: string }[] = [];
  const corpusState = perception.sources.find(
    (source) => source.id === "gslive_bet_report",
  );
  if (corpusState?.exists === true) {
    evidence.push({
      source: "gslive_bet_report",
      path: corpusState.path,
      pointer:
        subject.kind === "account"
          ? "r.bets[*].userID == subject"
          : "r.bets[*].agent == subject",
    });
  }
  const agentState = perception.sources.find(
    (source) => source.id === "agent_index",
  );
  if (agentState?.exists === true) {
    evidence.push({
      source: "agent_index",
      path: agentState.path,
      pointer: "agents[subject]",
    });
  }
  return emitSuccess(context, "dossier", {
    subject,
    hierarchy,
    bets,
    model: modelPayload,
    findings: findingsForSubject(patterns.findings, subject),
    ipClusters: clusters,
    evidence,
    sources: sourceStates(perception),
  });
}

async function cmdResearch(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("research", tokens);
  assertNoPositionals("research", flags);
  const perception = await perceptionOf(context);
  const loaded = await readResearchCatalog(context);
  const catalogLimits = ((): readonly string[] => {
    const record =
      loaded.catalog !== null &&
      typeof loaded.catalog === "object" &&
      !Array.isArray(loaded.catalog)
        ? (loaded.catalog as Record<string, unknown>)
        : null;
    const list = record?.["modelLimits"];
    return Array.isArray(list)
      ? list.filter((item): item is string => typeof item === "string")
      : fraudModelLimits();
  })();
  return emitSuccess(context, "research", {
    catalog: loaded.exists ? loaded.catalog : null,
    catalogPath: loaded.relative,
    catalogPresent: loaded.exists,
    catalogNote: loaded.note,
    modelLimits: catalogLimits,
    sources: sourceStates(perception),
  });
}

interface ResearchCatalogLoad {
  readonly catalog: unknown;
  readonly exists: boolean;
  readonly relative: string;
  readonly note: string;
}

/** Load the Lead-owned research catalog once; a missing catalog is a labelled state, not zero. */
async function readResearchCatalog(
  context: CliContext,
): Promise<ResearchCatalogLoad> {
  const relative = "config/fraud-research.json";
  const absolute = join(context.root, relative);
  try {
    const catalog = await Bun.file(absolute).json();
    return {
      catalog,
      exists: true,
      relative,
      note: "prior-art/terminology/threshold-provenance catalog (Lead-owned)",
    };
  } catch {
    return {
      catalog: null,
      exists: false,
      relative,
      note: `catalog is MISSING at ${relative} (Lead-owned); the built-in model limits are still reported from lib/fraud_model.ts`,
    };
  }
}

/**
 * Read-only pattern exploration: research-backlog field coverage plus descriptive account-level
 * candidates. It does not add or change frozen detectors, and nothing here is a finding.
 */
async function cmdExplore(
  tokens: readonly string[],
  context: CliContext,
): Promise<number> {
  const flags = parseCommandFlags("explore", tokens, {
    valueFlags: ["--limit"],
    shortAliases: { "-l": "--limit" },
  });
  assertNoPositionals("explore", flags);
  const limit = integerFlag("explore", flags, "--limit", 10, 1, 50);
  const perception = await perceptionOf(context);
  const corpus = requireCorpus(perception, "explore");
  const loaded = await readResearchCatalog(context);
  const patterns = runFraudPatterns(perception);
  const exploration = buildFraudExploration({
    corpus,
    catalog: loaded.catalog,
    frozenDetectorIds: patterns.findings.map((finding) => finding.id),
    limit,
  });
  return emitSuccess(context, "explore", {
    ...exploration,
    catalogPath: loaded.relative,
    catalogPresent: loaded.exists,
    sources: sourceStates(perception),
  });
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
    description:
      "Repo root for artifacts and the model artifact (default: cwd).",
  },
  {
    flags: "-n, --now <iso>",
    description: "Testing clock: pin every derived age/timestamp (ISO-8601).",
  },
];

const HELP_COMMANDS: readonly CommandHelp[] = [
  {
    name: "status",
    summary: "Source matrix, corpus summary, model state and next step",
    usage: "status [flags]",
    detail: [
      "Prints the measured state of all 11 security sources (exists/bytes/age/stale/",
      "provenance/sha256/state/note), the parsed corpus summary and the fitted-model state.",
      "A missing source is reported as MISSING with its reason, never as zero records.",
    ],
    options: [],
    examples: ["bun run cli/sportsdesk_fraud_cli.ts status --json"],
  },
  {
    name: "bets",
    summary:
      "Filtered, masked bet rows plus an aggregate (never all 24,778 rows)",
    usage:
      "bets [--agent <id>] [--account <id>] [--state <code>] [--since <iso>] [--limit N] [--include-bots <bool>] [flags]",
    detail: [
      "Normalizes getBetReport rows to the frozen BetRecord shape. IP addresses are masked",
      "(ipMasked/ipTag/ipPrefix24) at the parse boundary; a raw address is never emitted.",
      "The aggregate covers the filtered set; `sample` is capped by --limit.",
    ],
    options: [
      { flags: "--agent <id>", description: "Filter to one agent login." },
      {
        flags: "--account <id>",
        description: "Filter to one betReport userID.",
      },
      {
        flags: "--state <code>",
        description: "Filter to one raw wager state code.",
      },
      {
        flags: "--since <iso>",
        description: "Only rows placed at/after this timestamp.",
      },
      {
        flags: "-l, --limit <N>",
        description: "Sample rows to return (1-200, default 25).",
      },
      {
        flags: "--include-bots <bool>",
        description: "Include isSuspectedBot rows (true|false, default true).",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_fraud_cli.ts bets --json --limit 10",
      "bun run cli/sportsdesk_fraud_cli.ts bets --state 1 --include-bots false --json",
    ],
  },
  {
    name: "queue",
    summary:
      "Ranked account triage queue: findings by severity, then model score, then bets",
    usage: "queue [--limit N] [flags]",
    detail: [
      "Orders the accounts with at least one non-data-quality account finding or one",
      "suspected-bot / reversed-credit / manual-log / odds-drift row. Order is lexicographic:",
      "direct desk-flag rows, then critical/high/medium/low/info account-finding counts, then",
      "the fitted model's 0-100 proxy score (null last), then bet rows, then account id. No",
      "finding is converted to an invented point score and the model column is not a",
      "probability. Detectors are mostly book/agent-level aggregates, so account finding",
      "counts are usually 0; model-missing is reported as null scores, never as zeros.",
    ],
    options: [
      {
        flags: "-l, --limit <N>",
        description: "Rows to return (1-100, default 25).",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_fraud_cli.ts queue --json",
      "bun run cli/sportsdesk_fraud_cli.ts queue --limit 10 --json",
    ],
  },
  {
    name: "ip-graph",
    summary: "Masked IP clusters and account fan-out summary",
    usage: "ip-graph [--min-accounts N] [--limit N] [--prefix24 a.b.c] [flags]",
    detail: [
      "Groups rows by the stable ip:<sha256:8> tag (or by /24 with --prefix24) and reports",
      "distinct-account/bet counts. Clusters are masked; no raw address is emitted.",
    ],
    options: [
      {
        flags: "--min-accounts <N>",
        description:
          "Only clusters with at least N distinct accounts (default 2).",
      },
      {
        flags: "-l, --limit <N>",
        description: "Maximum clusters (1-100, default 25).",
      },
      {
        flags: "--prefix24 <a.b.c>",
        description: "Only clusters on this /24 prefix.",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_fraud_cli.ts ip-graph --json",
      "bun run cli/sportsdesk_fraud_cli.ts ip-graph --min-accounts 5 --limit 10 --json",
    ],
  },
  {
    name: "weblog",
    summary:
      "F402 WebLog rollup posture, detector flags, gates and GSLive activity",
    usage: "weblog [flags]",
    detail: [
      "Derives the zero-PII F402 WebLog posture from the newest valid rollup and runs the",
      "rollup detectors. The GSLive WebLog activity artifact is currently MISSING (session",
      "expired, HTTP 401): its six detectors report insufficientData, not zero.",
    ],
    options: [],
    examples: ["bun run cli/sportsdesk_fraud_cli.ts weblog --json"],
  },
  {
    name: "patterns",
    summary: "The frozen detector catalog as FraudFinding[] with counts",
    usage:
      "patterns [--min-severity critical|high|medium|low|info] [--category <category>] [--agent <id>] [--limit N] [flags]",
    detail: [
      "Runs every frozen detector id (11 bet-report, 7 WebLog-rollup, 6 GSLive-activity,",
      "6 F402-ticket, 4 data-quality) and reports severity/category counts. Findings with",
      "insufficientData say which source was missing; they are never a fabricated zero.",
    ],
    options: [
      {
        flags: "--min-severity <level>",
        description: "Inclusive minimum severity (default info).",
      },
      {
        flags: "--category <category>",
        description: `One of ${FRAUD_CATEGORIES.join(", ")}.`,
      },
      {
        flags: "--agent <id>",
        description: "Only findings about this agent login.",
      },
      {
        flags: "-l, --limit <N>",
        description: "Maximum findings (1-200, default 100).",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_fraud_cli.ts patterns --json",
      "bun run cli/sportsdesk_fraud_cli.ts patterns --min-severity high --json",
    ],
  },
  {
    name: "explore",
    summary:
      "Read-only pattern exploration: research-backlog field coverage + descriptive candidates",
    usage: "explore [--limit N] [flags]",
    detail: [
      "Maps config/fraud-research.json's proposed detectors to the raw fields this corpus",
      "actually carries (available/missing per field), then ranks three descriptive account",
      "candidates: low market-entropy specialisation, manual-log rows without an adminUser,",
      "and stake concentration. It adds no frozen detector and changes none.",
      "Every candidate is labelled exploratory and carries no threshold verdict. No account",
      "decision should cite it as evidence.",
    ],
    options: [
      {
        flags: "-l, --limit <N>",
        description: "Candidate rows per list (1-50, default 10).",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_fraud_cli.ts explore --json",
      "bun run cli/sportsdesk_fraud_cli.ts explore --limit 5 --json",
    ],
  },
  {
    name: "model",
    summary: "Weak-label model: report | fit [--write] | score <accountId>",
    usage:
      "model [report] [--include-score-map] | model fit [--write] [--split 0.5-0.9] [--l2 0-1] [--epochs 100-5000] [--proxy desk_flag|suspected_bot|reversed_credit] | model score <accountId>",
    detail: [
      "Transparent logistic ranker over getBetReport rows. It predicts a desk-flag PROXY,",
      "not fraud. History features use only strictly earlier logTime rows; fit is",
      "deterministic with a temporal split and reports AUC/AP/precision@1%/5%/Brier/",
      "calibration plus stability and drift. `fit` is a DRY RUN unless --write is passed;",
      "the only write in this plugin is reports/security/fraud-model.json (0600, atomic).",
    ],
    arguments: [
      {
        flags: "<accountId>",
        description: "score: betReport userID to score.",
      },
    ],
    options: [
      {
        flags: "--write",
        description: "Persist the fitted artifact (operator-gated).",
      },
      {
        flags: "--include-score-map",
        description:
          "report only: include the full 1001-point train-CDF quantile array (~19 KB). Without it the payload reports scoreMap as {size, quantileCount} only; the artifact always keeps the quantiles.",
      },
      {
        flags: "--split <0.5-0.9>",
        description: "Temporal train fraction (default 0.7).",
      },
      {
        flags: "--l2 <0-1>",
        description: "L2 regularization strength (default 0.01).",
      },
      {
        flags: "--epochs <100-5000>",
        description:
          "Full-batch gradient-descent epoch budget (default 4000; converges at ~1250 measured on the live corpus).",
      },
      {
        flags: "--proxy <label>",
        description:
          "Weak label: desk_flag (default), suspected_bot, reversed_credit.",
      },
    ],
    examples: [
      "bun run cli/sportsdesk_fraud_cli.ts model fit --json",
      "bun run cli/sportsdesk_fraud_cli.ts model fit --write --json",
      "bun run cli/sportsdesk_fraud_cli.ts model report --json",
      "bun run cli/sportsdesk_fraud_cli.ts model score 983516 --json",
    ],
  },
  {
    name: "dossier",
    summary:
      "One account/agent: hierarchy, bet aggregates, findings, score, masked IPs",
    usage: "dossier <accountId|agentId> [flags]",
    detail: [
      "Resolves an account (betReport userID) or agent login, then reports the agent-tree",
      "hierarchy, bet aggregates, detector findings, the model score (when fitted), the",
      "masked IP clusters and source freshness. An unknown id is a structured refusal",
      "(unknown_subject, exit 3).",
    ],
    arguments: [
      {
        flags: "<accountId|agentId>",
        description: "betReport userID or desk agent login.",
      },
    ],
    options: [],
    examples: [
      "bun run cli/sportsdesk_fraud_cli.ts dossier 983516 --json",
      "bun run cli/sportsdesk_fraud_cli.ts dossier MARCO1022 --json",
    ],
  },
  {
    name: "research",
    summary: "Prior-art catalog and the model's explicit limits list",
    usage: "research [flags]",
    detail: [
      "Returns the Lead-owned config/fraud-research.json catalog (present:false when absent)",
      "and the model limits every answer must carry. Read-only; no network.",
    ],
    options: [],
    examples: ["bun run cli/sportsdesk_fraud_cli.ts research --json"],
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
  const table = HELP_COMMANDS.map(
    (command) => `  ${command.name.padEnd(nameWidth)}  ${command.summary}`,
  ).join("\n");
  process.stdout
    .write(`SportsDesk security/fraud console — read-only surveillance + weak-label model

Usage: bun run cli/sportsdesk_fraud_cli.ts <command> [flags] [args]

Commands:
${table}

  <command> --help     Print detailed help for one command.

Honesty: MISSING is never reported as 0; fixture is labelled fixture; a model score is a
desk-flag PROXY rank, not a probability of fraud. Every success payload carries sources[] and
timing; every refusal carries error.code (exit 3) and the measured source states.

Global flags:
${formatHelpRows(HELP_GLOBAL_OPTIONS)}

Exit codes:
  0  ok
  2  usage_error (unknown command/flag, missing or invalid value)
  3  refusal (source_missing, insufficient_corpus, model_missing, unknown_subject)
  1  everything else

Read-only: no network, no secrets/keychain, no artifact mutation. The only write is
\`model fit --write\` → ${FRAUD_MODEL_REL_PATH} (atomic, 0600).

Examples:
  bun run cli/sportsdesk_fraud_cli.ts status --json
  bun run cli/sportsdesk_fraud_cli.ts patterns --json
  bun run cli/sportsdesk_fraud_cli.ts queue --limit 10 --json
  bun run cli/sportsdesk_fraud_cli.ts explore --json
  bun run cli/sportsdesk_fraud_cli.ts ip-graph --min-accounts 3 --json
  bun run cli/sportsdesk_fraud_cli.ts model fit --json
  bun run cli/sportsdesk_fraud_cli.ts dossier 983516 --json
`);
}

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
  const lines: string[] = [
    `Usage: bun run cli/sportsdesk_fraud_cli.ts ${command.usage}`,
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
    case "bets":
      return cmdBets(args, context);
    case "queue":
      return cmdQueue(args, context);
    case "ip-graph":
      return cmdIpGraph(args, context);
    case "weblog":
      return cmdWeblog(args, context);
    case "patterns":
      return cmdPatterns(args, context);
    case "explore":
      return cmdExplore(args, context);
    case "model":
      return cmdModel(args, context);
    case "dossier":
      return cmdDossier(args, context);
    case "research":
      return cmdResearch(args, context);
    default:
      usageError(
        command,
        "unknown command; run `bun run cli/sportsdesk_fraud_cli.ts --help` for the command table",
      );
  }
}

async function main(): Promise<number> {
  const startedAt = performance.now();
  const globalResult = parseGlobalArgs(process.argv.slice(2));
  if (!globalResult.ok) {
    return emitFailure("unknown", globalResult.error, globalResult.json);
  }
  const global = globalResult.value;
  if (global.help) {
    printHelp(global.command);
    return EXIT_OK;
  }
  if (global.command === undefined || global.command.trim() === "") {
    return emitFailure(
      "unknown",
      new CliError(
        "usage_error",
        "missing command; run `bun run cli/sportsdesk_fraud_cli.ts --help`",
        {},
        EXIT_USAGE,
      ),
      global.json,
    );
  }
  const context: CliContext = {
    root: global.root,
    json: global.json,
    now: global.now,
    nowFixed: global.nowFixed,
    startedAt,
    perception: null,
  };
  try {
    return await dispatch(global.command, global.commandArgs, context);
  } catch (error) {
    if (error instanceof CliError) {
      return emitFailure(global.command, error, global.json);
    }
    if (error instanceof FraudModelError) {
      const refusal = new CliError(
        error.code,
        error.message,
        error.details,
        EXIT_REFUSAL,
      );
      return emitFailure(global.command, refusal, global.json);
    }
    const message = error instanceof Error ? error.message : String(error);
    return emitFailure(
      global.command,
      new CliError("internal_error", message, {}, EXIT_ERROR),
      global.json,
    );
  } finally {
    // Kept for symmetry with the watchlist CLI: no process-level resources to release.
  }
}

if (import.meta.main) {
  process.exit(await main());
}

/* Re-exported for tests: the module is importable without running the CLI. */
export {
  FRAUD_CONFIG_REL_PATH,
  FRAUD_MODEL_REL_PATH,
  runFraudPatterns,
  extractFraudFeatures,
  filterFraudPatterns,
  type FraudPatternResult,
  type FraudPatternFilters,
  type FraudFeatureMatrix,
};
