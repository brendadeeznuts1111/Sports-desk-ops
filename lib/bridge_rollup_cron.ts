/**
 * @file bridge_rollup_cron.ts
 * @description One on-change-throttled cycle over the four Fantasy402 bridge rollups.
 *
 * The bridges are one-shot CLIs, not services. A scheduler calls
 * {@link runBridgeRollupCycle} and gets back {@link BridgeRollupCycleResult}: the per-job outcome
 * plus the alert set that changed since the previous cycle. Everything is sequential so two
 * bridges never drive the same capture at once, and a single failing bridge never throws the
 * cycle.
 *
 * **Artifacts.** bridge3c and weblog write a rollup JSON file (`--out`); bridge3a and bridge3b
 * print their JSON on stdout, so the reader takes the last balanced top-level `{…}` block and
 * ignores the surrounding log lines. bridge3b's final stdout block is a publish receipt
 * (`deskDate/provenance/ws/r2/publicStatus`) with no gates, so gates are recovered from the
 * `GATE-0N:status` summary on its stderr log when the artifact itself has none.
 *
 * **Digest.** The state file at `statePath` remembers the previous cycle (public result plus the
 * normalized artifact snapshots). Alerts are emitted ONLY when something changed:
 * - a gate that was pass/absent/skipped and is now `fail` → critical
 * - a flag crossing its threshold, or moving off zero → warn
 * - a job that was ok and is now failing → critical; a recovered job → info
 * - a job that succeeds but yields no parseable artifact → warn
 * The first cycle only establishes the baseline. Ids are stable, so a consumer can dedupe a
 * replayed digest.
 *
 * The file is pure orchestration: it never touches the network, spawns only through
 * `options.spawnJob`, reads only through `options.readArtifact`, and writes only `statePath` and
 * `historyPath` (atomic temp+rename for state, one JSON line per cycle for history).
 *
 * @see scripts/f402_bet_ticker_bridge3a.ts
 * @see scripts/f402_pending_bridge3b.ts
 * @see scripts/gslive_tally_bridge3c.ts
 * @see scripts/f402_weblog_bridge.ts
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export type BridgeRollupJobId = "bridge3a" | "bridge3b" | "bridge3c" | "weblog";

export interface BridgeRollupJobResult {
  readonly id: BridgeRollupJobId;
  readonly label: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly error?: string;
}

export interface BridgeAlert {
  /** Stable, dedupe-friendly key, e.g. `gate:f402-weblog:GATE-WL-02`. */
  readonly id: string;
  readonly severity: "info" | "warn" | "critical";
  readonly title: string;
  readonly detail: string;
}

export interface BridgeRollupCycleResult {
  readonly updatedAt: string;
  readonly jobs: readonly BridgeRollupJobResult[];
  readonly alerts: readonly BridgeAlert[];
}

export interface BridgeRollupJobSpec {
  readonly id: BridgeRollupJobId;
  readonly label: string;
  /** Full argv; any `{root}` token is replaced with the resolved cycle root. */
  readonly args: readonly string[];
  readonly timeoutMs: number;
  /**
   * Any-of credential names: the job runs when at least one is non-empty. An empty list means
   * the job needs no credentials. A missing set is recorded as `ok:false` WITHOUT spawning, so
   * a cron tick does not hammer a CLI that is guaranteed to fail.
   */
  readonly requiredEnv: readonly string[];
}

/** bridge3b (live fetch) and bridge3c (manager session) read the F402 session from env. */
const F402_CREDENTIAL_ENV = [
  "F402_TOKEN_FILE",
  "F402_BEARER_TOKEN",
  "GSID",
] as const;

export const BRIDGE_ROLLUP_JOBS: readonly BridgeRollupJobSpec[] = [
  {
    id: "bridge3a",
    label: "Bet ticker poll (3a)",
    // `--once` without `--from-body`/`--from-jsonl` requires an agent: with none the CLI calls
    // `usage("no agent…")` and exits 2. Required env makes cron skip cleanly instead of spawning
    // and alerting on a usage error. When the operator runs the long-lived `bridge3a:poll`
    // daemon this cron tick is redundant, but harmless.
    args: ["bun", "run", "scripts/f402_bet_ticker_bridge3a.ts", "--once"],
    timeoutMs: 120_000,
    requiredEnv: ["F402_AGENT_ID"],
  },
  {
    id: "bridge3b",
    label: "Pending liability rollup (3b)",
    // No --out: the CLI publishes to R2/WS and prints its receipt JSON on stdout.
    args: ["bun", "run", "scripts/f402_pending_bridge3b.ts"],
    timeoutMs: 120_000,
    requiredEnv: F402_CREDENTIAL_ENV,
  },
  {
    id: "bridge3c",
    label: "GSLive tally rollup (3c)",
    // Fetch the open-bet capture instead of reading the CLI's capital-S default
    // `Scratch/betReport-all.json` (a case-sensitive host only has lowercase `scratch/`).
    // manager_fetch reads Bun.env.GSID; gslive_auto_session reads GSLIVE_SESSION_FILE.
    args: [
      "bun",
      "run",
      "scripts/gslive_tally_bridge3c.ts",
      "--fetch-open",
      "--save-capture",
      "{root}/scratch/bridge-rollup/open-bets.json",
      "--out",
      "{root}/scratch/bridge-rollup/bridge3c.json",
    ],
    timeoutMs: 180_000,
    requiredEnv: ["GSID", "GSID_COOKIE", "GSLIVE_SESSION_FILE"],
  },
  {
    id: "weblog",
    label: "WebLog overlap bridge",
    // Its `--from` default is `out/f402/weblog/<date>.jsonl` relative to the CWD, which is the
    // corpus staging convention; a host without staged corpus records one clean job failure.
    args: [
      "bun",
      "run",
      "scripts/f402_weblog_bridge.ts",
      "--out",
      "{root}/scratch/bridge-rollup/weblog.json",
    ],
    timeoutMs: 180_000,
    requiredEnv: [],
  },
];

/** Alert-key segment per job; weblog keeps the key from the documented alert-id example. */
const BRIDGE_ALERT_KEYS: Readonly<Record<BridgeRollupJobId, string>> = {
  bridge3a: "bridge3a",
  bridge3b: "bridge3b",
  bridge3c: "bridge3c",
  weblog: "f402-weblog",
};

const JOB_IDS: readonly BridgeRollupJobId[] = [
  "bridge3a",
  "bridge3b",
  "bridge3c",
  "weblog",
];

const FLAG_NAMES = [
  "executionSnipers",
  "sniperTwins",
  "crossOfficeBeards",
  "botRingAccounts",
  "lineShoppers",
] as const;

export type BridgeFlagName = (typeof FLAG_NAMES)[number];

/**
 * Default spike thresholds. Only the two documented ones are set by default; the others are
 * configurable through `BRIDGE_ROLLUP_FLAG_THRESHOLD_<FLAG>` without inventing a number.
 */
const DEFAULT_FLAG_THRESHOLDS: Readonly<
  Partial<Record<BridgeFlagName, number>>
> = {
  executionSnipers: 5_000,
  botRingAccounts: 200,
};

const DEFAULT_STATE_PATH = "scratch/bridge-rollup-state.json";
const DEFAULT_HISTORY_PATH = "scratch/bridge-rollup-cron.jsonl";
const ERROR_TAIL_LIMIT = 240;

type BridgeArtifactStatus = "ok" | "missing";

type BridgeArtifactSource =
  | { readonly kind: "stdout" }
  | { readonly kind: "file"; readonly path: string };

const BRIDGE_ARTIFACTS: Readonly<
  Record<BridgeRollupJobId, BridgeArtifactSource>
> = {
  bridge3a: { kind: "stdout" },
  bridge3b: { kind: "stdout" },
  bridge3c: { kind: "file", path: "scratch/bridge-rollup/bridge3c.json" },
  weblog: { kind: "file", path: "scratch/bridge-rollup/weblog.json" },
};

export interface BridgeRollupJobContext extends BridgeRollupJobSpec {
  readonly root: string;
  readonly artifactPath?: string;
}

export interface BridgeRollupJobRun extends BridgeRollupJobContext {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface BridgeSpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface BridgeRollupCycleOptions {
  /** Subset to run, in the canonical job-table order. Default: all four. */
  readonly jobs?: readonly BridgeRollupJobId[];
  /** Repo root; also the cwd for spawned jobs. Default: the checkout containing `lib/`. */
  readonly root?: string;
  /**
   * Default `scratch/bridge-rollup-state.json`, resolved against `root`. When omitted, a
   * non-empty `BRIDGE_ROLLUP_STATE_PATH` in `env` wins so the reporting scheduler and the
   * dashboard read the same file the cycle writes.
   */
  readonly statePath?: string;
  /** Default `scratch/bridge-rollup-cron.jsonl`, resolved against `root`. */
  readonly historyPath?: string;
  readonly now?: () => number;
  /** Credential + threshold source. Default `Bun.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly spawnJob?: (
    job: BridgeRollupJobContext,
    argv: readonly string[],
  ) => Promise<BridgeSpawnResult>;
  readonly readArtifact?: (job: BridgeRollupJobRun) => Promise<unknown | null>;
}

interface BridgeGateSnapshot {
  readonly gate: string;
  readonly status: "pass" | "fail" | "skipped";
}

interface BridgeRowsSnapshot {
  readonly total: number | null;
  readonly parsed: number | null;
  readonly malformed: number | null;
}

interface BridgeArtifactSnapshot {
  readonly gates: readonly BridgeGateSnapshot[];
  readonly flags: Readonly<Partial<Record<BridgeFlagName, number>>>;
  readonly rows: BridgeRowsSnapshot | null;
  readonly capturedAt: string | null;
  readonly deskDate: string | null;
}

interface BridgeCycleState {
  readonly updatedAt: string;
  readonly jobs: readonly BridgeRollupJobResult[];
  readonly alerts: readonly BridgeAlert[];
  readonly artifacts: Readonly<
    Partial<Record<BridgeRollupJobId, BridgeArtifactSnapshot>>
  >;
  readonly artifactStatus: Readonly<
    Partial<Record<BridgeRollupJobId, BridgeArtifactStatus>>
  >;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJobId(value: unknown): value is BridgeRollupJobId {
  return (
    value === "bridge3a" ||
    value === "bridge3b" ||
    value === "bridge3c" ||
    value === "weblog"
  );
}

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return env[name];
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function clip(text: string, limit = ERROR_TAIL_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function describeError(error: unknown): string {
  return clip(error instanceof Error ? error.message : String(error));
}

function lastLogLine(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const line = lines.at(-1);
  return line === undefined ? null : clip(line);
}

function defaultRoot(): string {
  return resolve(import.meta.dirname, "..");
}

function resolveAgainst(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

function resolvePlaceholders(value: string, root: string): string {
  return value.replaceAll("{root}", root);
}

function resolveArgv(
  job: BridgeRollupJobSpec,
  root: string,
): readonly string[] {
  return job.args.map((arg) => resolvePlaceholders(arg, root));
}

function jobContext(
  job: BridgeRollupJobSpec,
  root: string,
): BridgeRollupJobContext {
  const source = BRIDGE_ARTIFACTS[job.id];
  return source.kind === "file"
    ? {
        ...job,
        root,
        artifactPath: resolveAgainst(root, source.path),
      }
    : { ...job, root };
}

function missingCredentials(
  job: BridgeRollupJobSpec,
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] | null {
  if (job.requiredEnv.length === 0) return null;
  const present = job.requiredEnv.some((name) => nonEmpty(envValue(env, name)));
  return present ? null : job.requiredEnv;
}

/** Last balanced top-level `{…}` block of a log+JSON stream, or `null`. */
function lastJsonObject(text: string): unknown | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let last: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) break;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        last = text.slice(start, index + 1);
        start = -1;
      }
    }
  }
  if (last === null) return null;
  try {
    return JSON.parse(last) as unknown;
  } catch {
    return null;
  }
}

/**
 * The slice of a spawned child this module uses. Declared structurally so the Bun shape catalog
 * still sees exactly one shape here (`Bun.spawn`); the child-process type is not a surface.
 */
type BridgeChildProcess = {
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  kill: (signal?: number | NodeJS.Signals) => void;
};

function defaultSpawnJob(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): NonNullable<BridgeRollupCycleOptions["spawnJob"]> {
  return async (job, argv) => {
    const childEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
      if (typeof value === "string") childEnv[name] = value;
    }
    let proc: BridgeChildProcess;
    try {
      proc = Bun.spawn([...argv], {
        cwd: root,
        env: childEnv,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `spawn failed: ${describeError(error)}`,
        timedOut: false,
      };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill(9);
      } catch {
        // The process may have exited between the timeout and the kill.
      }
    }, job.timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode: exitCode ?? -1, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timer);
    }
  };
}

function defaultReadArtifact(): NonNullable<
  BridgeRollupCycleOptions["readArtifact"]
> {
  return async (job) => {
    if (job.artifactPath === undefined) return lastJsonObject(job.stdout);
    try {
      return JSON.parse(readFileSync(job.artifactPath, "utf8")) as unknown;
    } catch {
      return null;
    }
  };
}

function normalizeGateName(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `GATE-${String(Math.trunc(value)).padStart(2, "0")}`;
  }
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

function normalizeGateStatus(value: unknown): BridgeGateSnapshot["status"] {
  // Unknown/future statuses are non-failures: a digest must not invent a regression.
  return value === "pass" || value === "fail" || value === "skipped"
    ? value
    : "skipped";
}

function normalizeGates(value: unknown): readonly BridgeGateSnapshot[] {
  if (!Array.isArray(value)) return [];
  const gates: BridgeGateSnapshot[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const gate = normalizeGateName(entry["gate"]);
    if (gate === null) continue;
    gates.push({ gate, status: normalizeGateStatus(entry["status"]) });
  }
  return gates;
}

function normalizeGatesFromLog(stderr: string): readonly BridgeGateSnapshot[] {
  const gates: BridgeGateSnapshot[] = [];
  const pattern =
    /(GATE-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*):(pass|fail|skipped)\b/g;
  for (const match of stderr.matchAll(pattern)) {
    const gate = match[1];
    const status = normalizeGateStatus(match[2]);
    if (gate !== undefined) gates.push({ gate, status });
  }
  return gates;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function normalizeFlags(
  value: unknown,
): Readonly<Partial<Record<BridgeFlagName, number>>> {
  if (!isRecord(value)) return {};
  const flags: Partial<Record<BridgeFlagName, number>> = {};
  for (const name of FLAG_NAMES) {
    const candidate = numberOrNull(value[name]);
    if (candidate !== null) flags[name] = candidate;
  }
  return flags;
}

function normalizeRows(
  raw: Record<string, unknown>,
): BridgeRowsSnapshot | null {
  const rows = raw["rows"];
  if (isRecord(rows)) {
    const total = numberOrNull(rows["total"]);
    const parsed = numberOrNull(rows["parsed"]);
    const malformed = numberOrNull(rows["malformed"]);
    if (total !== null || parsed !== null || malformed !== null) {
      return { total, parsed, malformed };
    }
  }
  const rowCount = numberOrNull(raw["rowCount"]);
  if (rowCount === null) return null;
  const malformed = numberOrNull(raw["malformedRowCount"]) ?? 0;
  return {
    total: rowCount,
    parsed: Math.max(0, rowCount - malformed),
    malformed,
  };
}

function normalizeArtifact(
  raw: unknown,
  stderr: string,
): BridgeArtifactSnapshot | null {
  if (!isRecord(raw)) return null;
  const artifactGates = normalizeGates(raw["gates"]);
  return {
    gates:
      artifactGates.length > 0 ? artifactGates : normalizeGatesFromLog(stderr),
    flags: normalizeFlags(raw["flags"]),
    rows: normalizeRows(raw),
    capturedAt:
      stringOrNull(raw["capturedAt"]) ?? stringOrNull(raw["generatedAt"]),
    deskDate: stringOrNull(raw["deskDate"]),
  };
}

function flagThreshold(
  flag: BridgeFlagName,
  env: Readonly<Record<string, string | undefined>>,
): number | null {
  const suffix = flag.replace(/([A-Z])/g, "_$1").toUpperCase();
  for (const envName of [
    `BRIDGE_ROLLUP_FLAG_THRESHOLD_${suffix}`,
    `BRIDGE_FLAG_THRESHOLD_${suffix}`,
  ]) {
    const raw = envValue(env, envName);
    if (raw !== undefined && raw.trim() !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return DEFAULT_FLAG_THRESHOLDS[flag] ?? null;
}

function parseState(raw: unknown): BridgeCycleState | null {
  if (!isRecord(raw)) return null;
  const updatedAt = raw["updatedAt"];
  const jobsInput = raw["jobs"];
  if (typeof updatedAt !== "string" || !Array.isArray(jobsInput)) return null;
  const jobs: BridgeRollupJobResult[] = [];
  for (const entry of jobsInput) {
    if (!isRecord(entry)) continue;
    const id = entry["id"];
    const label = entry["label"];
    const ok = entry["ok"];
    const durationMs = entry["durationMs"];
    if (
      !isJobId(id) ||
      typeof label !== "string" ||
      typeof ok !== "boolean" ||
      typeof durationMs !== "number"
    ) {
      continue;
    }
    const error = typeof entry["error"] === "string" ? entry["error"] : null;
    jobs.push(
      error === null
        ? { id, label, ok, durationMs }
        : { id, label, ok, durationMs, error },
    );
  }
  const artifactsInput = isRecord(raw["artifacts"]) ? raw["artifacts"] : {};
  const artifacts: Partial<Record<BridgeRollupJobId, BridgeArtifactSnapshot>> =
    {};
  for (const id of JOB_IDS) {
    const artifact = normalizeArtifact(artifactsInput[id], "");
    if (artifact !== null) artifacts[id] = artifact;
  }
  const statusInput = isRecord(raw["artifactStatus"])
    ? raw["artifactStatus"]
    : {};
  const artifactStatus: Partial<
    Record<BridgeRollupJobId, BridgeArtifactStatus>
  > = {};
  for (const id of JOB_IDS) {
    const status = statusInput[id];
    if (status === "ok" || status === "missing") artifactStatus[id] = status;
  }
  const alertsInput = Array.isArray(raw["alerts"]) ? raw["alerts"] : [];
  const alerts: BridgeAlert[] = [];
  for (const entry of alertsInput) {
    if (!isRecord(entry)) continue;
    const id = entry["id"];
    const severity = entry["severity"];
    const title = entry["title"];
    const detail = entry["detail"];
    if (
      typeof id !== "string" ||
      (severity !== "info" && severity !== "warn" && severity !== "critical") ||
      typeof title !== "string" ||
      typeof detail !== "string"
    ) {
      continue;
    }
    alerts.push({ id, severity, title, detail });
  }
  return { updatedAt, jobs, alerts, artifacts, artifactStatus };
}

function readState(path: string): BridgeCycleState | null {
  try {
    return parseState(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

let tempCounter = 0;

function writeStateAtomic(path: string, state: BridgeCycleState): void {
  mkdirSync(dirname(path), { recursive: true });
  tempCounter += 1;
  const temp = `${path}.tmp-${process.pid}-${tempCounter}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function appendHistory(path: string, result: BridgeRollupCycleResult): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(result)}\n`, "utf8");
}

function buildAlerts(params: {
  readonly previous: BridgeCycleState | null;
  readonly jobs: readonly BridgeRollupJobResult[];
  readonly artifacts: Readonly<
    Partial<Record<BridgeRollupJobId, BridgeArtifactSnapshot>>
  >;
  readonly artifactStatus: Readonly<
    Partial<Record<BridgeRollupJobId, BridgeArtifactStatus>>
  >;
  readonly env: Readonly<Record<string, string | undefined>>;
}): readonly BridgeAlert[] {
  const { previous } = params;
  if (previous === null) return [];
  const previousJobs = new Map(
    previous.jobs.map((job) => [job.id, job] as const),
  );
  const alerts: BridgeAlert[] = [];
  for (const job of params.jobs) {
    const key = BRIDGE_ALERT_KEYS[job.id];
    const previousJob = previousJobs.get(job.id);
    if (!job.ok && (previousJob === undefined || previousJob.ok)) {
      alerts.push({
        id: `job:${key}:fail`,
        severity: "critical",
        title: `${job.label} failed`,
        detail: job.error ?? "job exited non-zero",
      });
    } else if (job.ok && previousJob !== undefined && !previousJob.ok) {
      alerts.push({
        id: `job:${key}:recover`,
        severity: "info",
        title: `${job.label} recovered`,
        detail: `ok in ${job.durationMs} ms`,
      });
    }

    const status = params.artifactStatus[job.id] ?? "missing";
    const previousStatus = previous.artifactStatus[job.id] ?? "missing";
    const unreadable = job.ok && status !== "ok";
    const previouslyUnreadable =
      previousJob !== undefined && previousJob.ok && previousStatus !== "ok";
    if (unreadable && !previouslyUnreadable) {
      alerts.push({
        id: `artifact:${key}:unreadable`,
        severity: "warn",
        title: `${job.label} artifact missing`,
        detail: "job succeeded but produced no parseable artifact",
      });
    }

    const artifact = params.artifacts[job.id];
    if (artifact === undefined) continue;
    const previousArtifact = previous.artifacts[job.id];
    const previousGates = new Map(
      (previousArtifact?.gates ?? []).map((gate) => [gate.gate, gate.status]),
    );
    for (const gate of artifact.gates) {
      if (gate.status !== "fail") continue;
      const before = previousGates.get(gate.gate);
      if (before === "fail") continue;
      alerts.push({
        id: `gate:${key}:${gate.gate}`,
        severity: "critical",
        title: `${gate.gate} failing on ${job.label}`,
        detail:
          before === undefined
            ? "gate absent before, failing now"
            : `${before} -> fail`,
      });
    }
    for (const flag of FLAG_NAMES) {
      const current = artifact.flags[flag];
      if (current === undefined) continue;
      // No previous snapshot for this bridge means no baseline to compare against; the gates
      // rule still treats absent -> fail as a regression, but a flag must have a prior value.
      const before = previousArtifact?.flags[flag];
      if (before === undefined) continue;
      const threshold = flagThreshold(flag, params.env);
      const crossed =
        threshold !== null && current > threshold && before <= threshold;
      const fromZero = before === 0 && current > 0;
      if (!crossed && !fromZero) continue;
      const parts = [`${flag} ${before} -> ${current}`];
      if (threshold !== null) parts.push(`threshold ${threshold}`);
      alerts.push({
        id: `flag:${key}:${flag}`,
        severity: "warn",
        title: `${flag} spiked on ${job.label}`,
        detail: parts.join("; "),
      });
    }
  }
  const seen = new Set<string>();
  return alerts.filter((alert) => {
    if (seen.has(alert.id)) return false;
    seen.add(alert.id);
    return true;
  });
}

function selectJobs(
  requested: readonly BridgeRollupJobId[] | undefined,
): readonly BridgeRollupJobSpec[] {
  if (requested === undefined) return BRIDGE_ROLLUP_JOBS;
  const wanted = new Set<BridgeRollupJobId>();
  for (const id of requested) {
    if (!isJobId(id)) {
      throw new TypeError(`unknown bridge rollup job: ${String(id)}`);
    }
    wanted.add(id);
  }
  return BRIDGE_ROLLUP_JOBS.filter((job) => wanted.has(job.id));
}

function jobFailure(
  job: BridgeRollupJobSpec,
  result: BridgeSpawnResult,
): string | null {
  const tail = lastLogLine(result.stderr);
  if (result.timedOut) {
    return tail === null
      ? `timeout after ${job.timeoutMs}ms`
      : `timeout after ${job.timeoutMs}ms: ${tail}`;
  }
  if (result.exitCode !== 0) {
    return tail === null
      ? `exit ${result.exitCode}`
      : `exit ${result.exitCode}: ${tail}`;
  }
  return null;
}

export async function runBridgeRollupCycle(
  options: BridgeRollupCycleOptions = {},
): Promise<BridgeRollupCycleResult> {
  const env = options.env ?? Bun.env;
  const root = resolve(options.root ?? defaultRoot());
  const envStatePath = envValue(env, "BRIDGE_ROLLUP_STATE_PATH");
  const statePath = resolveAgainst(
    root,
    options.statePath ??
      (envStatePath !== undefined && envStatePath.trim() !== ""
        ? envStatePath.trim()
        : DEFAULT_STATE_PATH),
  );
  const historyPath = resolveAgainst(
    root,
    options.historyPath ?? DEFAULT_HISTORY_PATH,
  );
  const now = options.now ?? (() => Date.now());
  const spawnJob = options.spawnJob ?? defaultSpawnJob(root, env);
  const readArtifact = options.readArtifact ?? defaultReadArtifact();
  const selected = selectJobs(options.jobs);
  const previous = readState(statePath);

  const jobs: BridgeRollupJobResult[] = [];
  const artifacts: Partial<Record<BridgeRollupJobId, BridgeArtifactSnapshot>> =
    {};
  const artifactStatus: Partial<
    Record<BridgeRollupJobId, BridgeArtifactStatus>
  > = {};

  for (const job of selected) {
    const missing = missingCredentials(job, env);
    if (missing !== null) {
      jobs.push({
        id: job.id,
        label: job.label,
        ok: false,
        durationMs: 0,
        error: `missing credentials: ${missing.join(", ")}`,
      });
      artifactStatus[job.id] = "missing";
      continue;
    }

    const context = jobContext(job, root);
    const argv = resolveArgv(job, root);
    const startedAt = now();
    let spawnResult: BridgeSpawnResult;
    try {
      spawnResult = await spawnJob(context, argv);
    } catch (error) {
      jobs.push({
        id: job.id,
        label: job.label,
        ok: false,
        durationMs: Math.max(0, now() - startedAt),
        error: `spawn failed: ${describeError(error)}`,
      });
      artifactStatus[job.id] = "missing";
      continue;
    }
    const durationMs = Math.max(0, now() - startedAt);

    let raw: unknown = null;
    try {
      raw = await readArtifact({
        ...context,
        exitCode: spawnResult.exitCode,
        stdout: spawnResult.stdout,
        stderr: spawnResult.stderr,
        timedOut: spawnResult.timedOut,
      });
    } catch {
      raw = null;
    }
    const artifact = normalizeArtifact(raw, spawnResult.stderr);
    if (artifact !== null) artifacts[job.id] = artifact;
    artifactStatus[job.id] = artifact === null ? "missing" : "ok";

    const failure = jobFailure(job, spawnResult);
    jobs.push(
      failure === null
        ? { id: job.id, label: job.label, ok: true, durationMs }
        : {
            id: job.id,
            label: job.label,
            ok: false,
            durationMs,
            error: failure,
          },
    );
  }

  const updatedAt = new Date(now()).toISOString();
  const alerts = buildAlerts({
    previous,
    jobs,
    artifacts,
    artifactStatus,
    env,
  });
  const result: BridgeRollupCycleResult = { updatedAt, jobs, alerts };
  const nextState = mergeState(previous, {
    updatedAt,
    jobs,
    alerts,
    artifacts,
    artifactStatus,
  });
  writeStateAtomic(statePath, nextState);
  appendHistory(historyPath, result);
  return result;
}

/**
 * Keep the last known outcome for jobs this cycle did not run. The scheduler drives two
 * schedules over one state file (the 15-minute 3a/3b/3c cycle and the hourly weblog cycle), so a
 * subset cycle must not forget the other bridge's artifact/gate status — otherwise every
 * alternating tick would re-alert the same failure as "new".
 */
function mergeState(
  previous: BridgeCycleState | null,
  current: BridgeCycleState,
): BridgeCycleState {
  if (previous === null) return current;
  const selected = new Set(current.jobs.map((job) => job.id));
  const currentJobs = new Map(current.jobs.map((job) => [job.id, job]));
  const previousJobs = new Map(previous.jobs.map((job) => [job.id, job]));
  const jobs = JOB_IDS.flatMap((id) => {
    const job = currentJobs.get(id) ?? previousJobs.get(id);
    return job === undefined ? [] : [job];
  });
  const artifacts: Partial<Record<BridgeRollupJobId, BridgeArtifactSnapshot>> =
    { ...previous.artifacts };
  const artifactStatus: Partial<
    Record<BridgeRollupJobId, BridgeArtifactStatus>
  > = { ...previous.artifactStatus };
  for (const id of JOB_IDS) {
    if (!selected.has(id)) continue;
    delete artifacts[id];
    const artifact = current.artifacts[id];
    if (artifact !== undefined) artifacts[id] = artifact;
    const status = current.artifactStatus[id];
    if (status !== undefined) artifactStatus[id] = status;
    else delete artifactStatus[id];
  }
  return {
    updatedAt: current.updatedAt,
    jobs,
    alerts: current.alerts,
    artifacts,
    artifactStatus,
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Compact Telegram-safe digest (`<b>`/`<code>` only). Failed jobs are always named; alerts are
 * listed with their severity. With `{quiet:true}` a clean result collapses to one "all quiet"
 * line instead of the full status header.
 */
export function formatBridgeDigestHtml(
  result: BridgeRollupCycleResult,
  options: { readonly quiet?: boolean } = {},
): string {
  const failed = result.jobs.filter((job) => !job.ok);
  const jobCount = `${result.jobs.length - failed.length}/${result.jobs.length} jobs ok`;
  const header = `<b>Bridge rollup</b> <code>${escapeHtml(result.updatedAt)}</code>`;
  if (result.alerts.length === 0 && failed.length === 0) {
    return options.quiet === true
      ? `${header} - all quiet (${jobCount})`
      : `${header}\n${jobCount}`;
  }
  const lines = [header, jobCount];
  for (const job of failed) {
    const suffix =
      job.error === undefined ? "" : `: ${escapeHtml(clip(job.error))}`;
    lines.push(`FAIL <code>${escapeHtml(job.label)}</code>${suffix}`);
  }
  for (const alert of result.alerts) {
    lines.push(
      `[${alert.severity}] <b>${escapeHtml(alert.title)}</b> - ${escapeHtml(clip(alert.detail))}`,
    );
  }
  return lines.join("\n");
}
