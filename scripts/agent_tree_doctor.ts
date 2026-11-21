#!/usr/bin/env bun
/**
 * @file scripts/agent_tree_doctor.ts
 * @description Answers "is the agent tree stale, and would the hourly rebuild corrupt it?" from
 * the artifacts on disk rather than from their mtimes.
 *
 * `data/agent-tree.json` is a reduction of `scratch/agent-graph.json`, which is itself built from
 * `scratch/raw-f402-list-agents.json`. The graph build records the envelope's sha256 in
 * `scratch/agent-graph.manifest.json`, so a graph that lags the envelope already on disk is
 * visible without a network call — an age check cannot tell that apart from a quiet capture
 * window. The scheduled argv is read from `ReportingSchedulerService.defaultSchedules()` (the same
 * spec the daemon arms): the committed pair only reproduces under a `--hierarchy` run, so an argv
 * without it would silently drop every `AgentType` and empty the index.
 *
 *   bun run agent-tree:doctor                  human report; exit 1 on any FAIL
 *   bun run agent-tree:doctor --json           machine-readable checks
 *   bun run agent-tree:doctor --rebuild-check
  bun run agent-tree:doctor --offline      (worktree or daemon down)  also run the scheduled argv into a temp directory
 *                                              and diff the result against the committed pair
 *
 * Read-only: it never writes a repository artifact. `--rebuild-check` writes only inside a temp
 * directory it removes afterwards.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readHierarchyRows } from "../lib/live_bets.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  readonly id: string;
  readonly status: CheckStatus;
  readonly title: string;
  readonly detail?: string;
  readonly fix?: string;
}

/** One armable schedule as the scheduler declares it. */
export interface ScheduledJob {
  readonly id: string;
  readonly bin: string;
  readonly args: readonly string[];
  readonly requires: readonly string[];
}

export interface DoctorOptions {
  /** Scheduled rebuild to judge; defaults to the scheduler spec's own entry. */
  readonly scheduledJob?: ScheduledJob | null;
  /** Injected scheduler read for tests, replacing the service import. */
  readonly loadSchedule?: () => Promise<ScheduledJob | null>;
  /** Live `/api/status` payload for the run-state check; `null` means "do not probe". */
  readonly readStatus?: () => Promise<unknown | null>;
  /** Run the scheduled argv into a temp directory and diff it against the committed pair. */
  readonly rebuildCheck?: boolean;
  /** Injected rebuild for tests: writes the two artifacts and returns their paths. */
  readonly runBuild?: (
    argv: readonly string[],
    dir: string,
  ) => Promise<{ tree: string; index: string } | null>;
}

const ROOT = path.resolve(import.meta.dirname, "..");
const ENVELOPE = "scratch/raw-f402-list-agents.json";
const GRAPH = "scratch/agent-graph.json";
const GRAPH_MANIFEST = "scratch/agent-graph.manifest.json";
const TREE = "data/agent-tree.json";
const INDEX = "data/agent-index.json";
const SCHEDULE_ID = "sched_agent_tree_hourly";
const BUILD_SCRIPT = "scripts/build_agent_tree.ts";
const HIERARCHY_FLAG = "--hierarchy";
const HIERARCHY_ARGS = [HIERARCHY_FLAG, ENVELOPE];

async function readJson(target: string): Promise<unknown | null> {
  try {
    return (await Bun.file(target).json()) as unknown;
  } catch {
    return null;
  }
}

/** sha256 of a file on disk, as the manifest records it. */
export async function sha256Hex(target: string): Promise<string | null> {
  try {
    const bytes = await Bun.file(target).arrayBuffer();
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One schedule row from `/api/status` (`telegram.schedules`), or `null`. */
function findScheduleEntry(
  status: unknown,
  id: string,
): Record<string, unknown> | null {
  const schedules = record(record(status)?.["telegram"])?.["schedules"];
  if (!Array.isArray(schedules)) return null;
  for (const candidate of schedules) {
    const row = record(candidate);
    if (row !== null && row["id"] === id) return row;
  }
  return null;
}

function short(sha: string | null): string {
  return sha === null ? "unreadable" : sha.slice(0, 8);
}

/** Node keys of an `agent-tree` payload. Dot suffixes are the unlevelled raw form, kept visible. */
function treeKeys(payload: unknown): string[] {
  const nodes = record(record(payload)?.["nodes"]);
  return nodes === null ? [] : Object.keys(nodes);
}

function indexKeys(payload: unknown): string[] {
  const agents = record(record(payload)?.["agents"]);
  return agents === null ? [] : Object.keys(agents);
}

/**
 * The scheduler's own `sched_agent_tree_hourly` entry, or `null` when the spec no longer
 * declares (or no longer shell-runs) it. Imported lazily so the pure checks stay cheap.
 */
export async function scheduledAgentTreeJob(): Promise<ScheduledJob | null> {
  const { ReportingSchedulerService } =
    await import("../services/reporting_scheduler_service.ts");
  const entry = ReportingSchedulerService.defaultSchedules().find(
    (schedule) => schedule.id === SCHEDULE_ID,
  );
  const job = entry?.shellJob;
  if (entry === undefined || job === undefined) return null;
  const requires = (job.requires ?? []).filter(
    (name): name is string => typeof name === "string",
  );
  return { id: SCHEDULE_ID, bin: job.bin, args: [...job.args], requires };
}

/** Why the index can legitimately hold more keys than the tree: overflow rows the graph skipped. */
function overflowCount(manifest: unknown): number | null {
  return count(record(manifest)?.["skippedOverflowCount"]);
}

/** Tree `collisions` is a count in the committed file and a list in older builds. */
function collisionsOf(payload: unknown): number | null {
  const value = record(payload)?.["collisions"];
  if (Array.isArray(value)) return value.length;
  return count(value);
}

function treeNodeCount(payload: unknown): number {
  return treeKeys(payload).length;
}

function agentCountOf(payload: unknown): number | null {
  return count(record(payload)?.["agentCount"]);
}

/** True when the schedule's argv can reproduce the committed pair (it needs `--hierarchy`). */
export function argvHasHierarchy(argv: readonly string[]): boolean {
  return argv.includes(HIERARCHY_FLAG);
}

async function runRebuild(
  job: ScheduledJob,
  root: string,
  dir: string,
): Promise<{ tree: string; index: string } | null> {
  const treeOut = path.join(dir, "agent-tree.json");
  const indexOut = path.join(dir, "agent-index.json");
  const argv = [...job.args, "--out", treeOut, "--index-out", indexOut];
  try {
    const proc = Bun.spawnSync({
      cmd: [job.bin, ...argv],
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    if (proc.exitCode !== 0) return null;
  } catch {
    return null;
  }
  const [treeThere, indexThere] = await Promise.all([
    Bun.file(treeOut).exists(),
    Bun.file(indexOut).exists(),
  ]);
  if (!treeThere || !indexThere) return null;
  return { tree: treeOut, index: indexOut };
}

/**
 * Measure the chain under `root`. Every check catches its own failure, so a missing input cannot
 * blank the rest of the report.
 */
export async function runDoctor(
  root = ROOT,
  options: DoctorOptions = {},
): Promise<Check[]> {
  const checks: Check[] = [];
  const at = (relative: string): string => path.join(root, relative);

  const envelope = await readJson(at(ENVELOPE));
  const envelopeRows =
    envelope === null ? null : readHierarchyRows(envelope).length;
  const envelopeSha = await sha256Hex(at(ENVELOPE));
  checks.push(
    envelopeSha === null
      ? {
          id: "envelope",
          status: "fail",
          title: `${ENVELOPE} is missing`,
          detail:
            "no hierarchy capture is on disk, so nothing can rebuild the tree",
          fix: "bun run graph:agent   (writes the envelope and the graph)",
        }
      : {
          id: "envelope",
          status: "ok",
          title: `${ENVELOPE} present`,
          detail: `${envelopeRows ?? "?"} rows · sha256 ${short(envelopeSha)}`,
        },
  );

  const manifest = await readJson(at(GRAPH_MANIFEST));
  const manifestRecord = record(manifest);
  const manifestSha = text(manifestRecord?.["envelopeSha256"]);
  const builtAt = text(manifestRecord?.["builtAt"]);
  const graphNodeCount = count(manifestRecord?.["nodeCount"]);
  const skippedOverflow = overflowCount(manifest);
  const graphExists = await Bun.file(at(GRAPH)).exists();

  checks.push(
    manifestRecord === null || !graphExists
      ? {
          id: "graph-manifest",
          status: "fail",
          title: `${GRAPH} or ${GRAPH_MANIFEST} is missing`,
          detail: "no graph build is on disk to compare against the envelope",
          fix: "bun run graph:agent",
        }
      : {
          id: "graph-manifest",
          status: "ok",
          title: "graph build manifest present",
          detail: `${graphNodeCount ?? "?"} nodes · built ${builtAt ?? "unknown"} · from envelope ${short(manifestSha)}`,
        },
  );

  if (envelopeSha !== null && manifestSha !== null) {
    const fresh = envelopeSha === manifestSha;
    checks.push({
      id: "graph-envelope-sha",
      status: fresh ? "ok" : "fail",
      title: fresh
        ? "graph was built from the envelope on disk"
        : "graph is one capture behind: the envelope was replaced after the build",
      detail: fresh
        ? `sha256 ${short(envelopeSha)} matches the manifest`
        : `manifest expects ${short(manifestSha)}, disk is ${short(envelopeSha)} — the tree is a reduction of the older capture`,
      ...(fresh
        ? {}
        : {
            fix: `bun run graph:agent && bun run build:agent-tree ${HIERARCHY_FLAG} ${ENVELOPE}`,
          }),
    });
  }

  const tree = await readJson(at(TREE));
  const treeNodes = treeNodeCount(tree);
  const treeAgents = agentCountOf(tree);
  const rootsField = record(tree)?.["roots"];
  const treeRoots = Array.isArray(rootsField) ? rootsField.length : null;
  const collisions = collisionsOf(tree);
  checks.push(
    tree === null
      ? {
          id: "tree",
          status: "fail",
          title: `${TREE} is missing or unparseable`,
          detail:
            "the portal hierarchy view and /api/analysis agentKnown read this file",
          fix: `bun run build:agent-tree ${HIERARCHY_FLAG} ${ENVELOPE}`,
        }
      : {
          id: "tree",
          status:
            treeAgents === null || treeAgents === treeNodes ? "ok" : "fail",
          title:
            treeAgents === null || treeAgents === treeNodes
              ? `${TREE} is self-consistent`
              : `${TREE} agentCount disagrees with its node map`,
          detail: `${treeNodes} node(s) · agentCount ${treeAgents ?? "missing"} · ${treeRoots ?? "?"} root(s) · ${
            collisions ?? "?"
          } collision(s) · source ${text(record(tree)?.["source"]) ?? "unrecorded"}`,
          ...(treeAgents === null || treeAgents === treeNodes
            ? {}
            : {
                fix: `bun run build:agent-tree ${HIERARCHY_FLAG} ${ENVELOPE}`,
              }),
        },
  );

  const index = await readJson(at(INDEX));
  const indexAgents = agentCountOf(index);
  const indexNodeCount = indexKeys(index).length;
  checks.push(
    index === null
      ? {
          id: "index",
          status: "fail",
          title: `${INDEX} is missing or unparseable`,
          detail:
            "identity/level lookups fall back to login guesses without it",
          fix: `bun run build:agent-tree ${HIERARCHY_FLAG} ${ENVELOPE}`,
        }
      : {
          id: "index",
          status:
            indexAgents === null || indexAgents === indexNodeCount
              ? "ok"
              : "fail",
          title:
            indexAgents === null || indexAgents === indexNodeCount
              ? `${INDEX} is self-consistent`
              : `${INDEX} agentCount disagrees with its agent map`,
          detail: `${indexNodeCount} agent(s) · agentCount ${indexAgents ?? "missing"}`,
          ...(indexAgents === null || indexAgents === indexNodeCount
            ? {}
            : {
                fix: `bun run build:agent-tree ${HIERARCHY_FLAG} ${ENVELOPE}`,
              }),
        },
  );

  if (tree !== null && index !== null) {
    const treeSet = new Set(treeKeys(tree));
    const indexSet = new Set(indexKeys(index));
    const uncovered = [...treeSet].filter((key) => !indexSet.has(key));
    const overflow = [...indexSet].filter((key) => !treeSet.has(key));
    checks.push({
      id: "tree-covered-by-index",
      status: uncovered.length === 0 ? "ok" : "fail",
      title:
        uncovered.length === 0
          ? "every tree node resolves in the index"
          : `${uncovered.length} tree node(s) have no index entry`,
      detail:
        uncovered.length === 0
          ? `${treeSet.size} tree key(s) covered · ${overflow.length} overflow key(s) legitimately absent from the tree`
          : `missing: ${uncovered.slice(0, 5).join(", ")}${uncovered.length > 5 ? " …" : ""}`,
      ...(uncovered.length === 0
        ? {}
        : { fix: `bun run build:agent-tree ${HIERARCHY_FLAG} ${ENVELOPE}` }),
    });

    if (skippedOverflow !== null) {
      const agrees = overflow.length === skippedOverflow;
      checks.push({
        id: "overflow-invariant",
        status: agrees ? "ok" : "warn",
        title: agrees
          ? "index overflow matches the graph build's skipped rows"
          : "index overflow disagrees with the graph build's skipped rows",
        detail: `manifest skipped ${skippedOverflow} · index holds ${overflow.length} key(s) with no tree node`,
        ...(agrees
          ? {}
          : {
              fix: `bun run build:agent-tree ${HIERARCHY_FLAG} ${ENVELOPE}   (rebuild both from one capture)`,
            }),
      });
    }
  }

  let job: ScheduledJob | null = null;
  let scheduleError: string | null = null;
  if (options.scheduledJob !== undefined) {
    job = options.scheduledJob;
  } else {
    try {
      job = await (options.loadSchedule ?? scheduledAgentTreeJob)();
    } catch (error) {
      // A scheduler module that cannot be imported or evaluated is an unverified cadence, not a
      // crash: the rest of the report is still about the artifacts on disk.
      scheduleError = error instanceof Error ? error.message : String(error);
    }
  }
  if (scheduleError !== null) {
    checks.push({
      id: "schedule",
      status: "warn",
      title: "the scheduler spec could not be read",
      detail: `${scheduleError} — nothing is claimed about the rebuild cadence`,
      fix: "bun check services/reporting_scheduler_service.ts",
    });
  } else if (job === null) {
    checks.push({
      id: "schedule",
      status: "fail",
      title: `the scheduler no longer declares ${SCHEDULE_ID}`,
      detail: "nothing rebuilds the tree on a cadence",
      fix: `restore the SHELL_CAPTURE entry, or run bun run build:agent-tree ${HIERARCHY_FLAG} ${ENVELOPE} by hand`,
    });
  } else {
    const targetsBuild = job.args.some((arg) => arg.endsWith(BUILD_SCRIPT));
    const hierarchy = argvHasHierarchy(job.args);
    const argv = [job.bin, ...job.args].join(" ");
    checks.push({
      id: "schedule-argv",
      status: targetsBuild && hierarchy ? "ok" : "fail",
      title: !targetsBuild
        ? `${SCHEDULE_ID} no longer runs ${BUILD_SCRIPT}`
        : hierarchy
          ? `${SCHEDULE_ID} reproduces the committed build`
          : `${SCHEDULE_ID} omits ${HIERARCHY_FLAG}: a run would drop every AgentType and empty the index`,
      detail: `argv: ${argv}`,
      ...(targetsBuild && hierarchy
        ? {}
        : {
            fix: targetsBuild
              ? `pass ${HIERARCHY_ARGS.join(" ")} in sched_agent_tree_hourly's shellJob.args`
              : `point sched_agent_tree_hourly's shellJob.args at ${BUILD_SCRIPT}`,
          }),
    });

    const envRequires = job.requires.filter(
      (name) => !name.startsWith("file:"),
    );
    const unmet = envRequires.filter(
      (name) => (Bun.env[name] ?? "").trim() === "",
    );
    checks.push({
      id: "schedule-requires",
      status: unmet.length === 0 ? "ok" : "warn",
      title:
        unmet.length === 0
          ? "the schedule's credential gate is satisfied here"
          : `${SCHEDULE_ID} is dropped at registration: ${unmet.join(", ")} unset`,
      detail:
        unmet.length === 0
          ? `requires: ${job.requires.join(", ")}`
          : `requires: ${job.requires.join(", ")} · unset in this process, so no timer is armed and the tree keeps its old bytes`,
      ...(unmet.length === 0
        ? {}
        : {
            fix: "restart the daemon with the credential, or re-gate the schedule on the scratch files it actually reads",
          }),
    });
  }

  if (options.readStatus !== undefined && job !== null) {
    const status = await options.readStatus();
    const entry = findScheduleEntry(status, SCHEDULE_ID);
    if (status === null) {
      checks.push({
        id: "schedule-run",
        status: "warn",
        title: "the daemon status could not be read",
        detail:
          "run state is unverified; pass --offline to skip this probe deliberately",
        fix: "curl -s http://127.0.0.1:4020/api/status   (is the desk serving?)",
      });
    } else if (entry === null) {
      checks.push({
        id: "schedule-run",
        status: "warn",
        title: `/api/status does not list ${SCHEDULE_ID}`,
        detail:
          "the running daemon predates this schedule, or publishes no schedules",
        fix: "restart the desk so /api/status reflects the current checkout",
      });
    } else {
      const run = record(entry["lastRun"]);
      if (run === null) {
        checks.push({
          id: "schedule-run",
          status: "warn",
          title: `${SCHEDULE_ID} has not run since the daemon started`,
          detail:
            "no lastRun in /api/status: the schedule never fired, so the artifact keeps its old bytes",
          fix: "check the daemon log for a registration/skip line, then restart with the credential",
        });
      } else {
        const status_ = text(run["status"]) ?? "unknown";
        const detail = text(run["detail"]);
        const at = text(run["at"]);
        const ageMinutes =
          at === null
            ? null
            : Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
        checks.push({
          id: "schedule-run",
          status:
            status_ === "failed"
              ? "fail"
              : status_ === "skipped"
                ? "warn"
                : "ok",
          title:
            status_ === "ok"
              ? `${SCHEDULE_ID} last ran ${ageMinutes ?? "?"} min ago`
              : status_ === "skipped"
                ? `${SCHEDULE_ID} skipped: ${detail ?? "unmet requirement"}`
                : `${SCHEDULE_ID} failed: ${detail ?? "unknown reason"}`,
          detail:
            at === null
              ? `status ${status_}`
              : `status ${status_} · ${ageMinutes ?? "?"} min ago · ${at}`,
          ...(status_ === "ok"
            ? {}
            : {
                fix:
                  status_ === "skipped"
                    ? "supply the requirement (see the schedule's `requires`), then restart the desk"
                    : "read the daemon log for the capture's stderr, then run the command by hand",
              }),
        });
      }
    }
  }

  if (options.rebuildCheck === true && job !== null) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agent-tree-doctor-"));
    try {
      const built =
        options.runBuild === undefined
          ? await runRebuild(job, root, dir)
          : await options.runBuild(job.args, dir);
      if (built === null) {
        checks.push({
          id: "rebuild",
          status: "warn",
          title: "scheduled rebuild could not be measured",
          detail:
            "the build did not produce both artifacts; nothing about reproduction is claimed",
          fix: `run it by hand: bun run build:agent-tree ${HIERARCHY_FLAG} ${ENVELOPE}`,
        });
      } else {
        const builtTree = await readJson(built.tree);
        const builtIndex = await readJson(built.index);
        const sameTree = tree !== null && Bun.deepEquals(tree, builtTree);
        const sameIndex = index !== null && Bun.deepEquals(index, builtIndex);
        const builtNodes = treeNodeCount(builtTree);
        const builtAgents = agentCountOf(builtIndex);
        checks.push({
          id: "rebuild",
          status: sameTree && sameIndex ? "ok" : "fail",
          title:
            sameTree && sameIndex
              ? "the scheduled argv reproduces the committed artifacts"
              : "the scheduled argv produces different artifacts",
          detail:
            sameTree && sameIndex
              ? `${builtNodes} node(s) · ${builtAgents ?? "?"} agent(s), identical to disk`
              : `rebuilt ${builtNodes} node(s) / ${builtAgents ?? "?"} agent(s) against committed ${treeNodes} / ${indexNodeCount}`,
          ...(sameTree && sameIndex
            ? {}
            : {
                fix: `bun run build:agent-tree ${HIERARCHY_FLAG} ${ENVELOPE}   (then diff data/agent-tree.json)`,
              }),
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return checks;
}

export function exitCode(checks: readonly Check[]): number {
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}

export function renderReport(checks: readonly Check[], root = ROOT): string {
  const count = (status: CheckStatus): number =>
    checks.filter((check) => check.status === status).length;
  const lines = [
    `agent-tree:doctor · ${root}`,
    `${checks.length} checks · ${count("ok")} ok · ${count("warn")} warn · ${count("fail")} fail`,
    "",
  ];
  const label: Record<CheckStatus, string> = {
    ok: "OK  ",
    warn: "WARN",
    fail: "FAIL",
  };
  for (const check of checks) {
    lines.push(`${label[check.status]} ${check.title}`);
    if (check.detail !== undefined && check.detail !== "") {
      lines.push(`     ${check.detail}`);
    }
    if (check.fix !== undefined && check.fix !== "" && check.status !== "ok") {
      lines.push(`     fix: ${check.fix}`);
    }
  }
  lines.push(
    "",
    count("fail") > 0
      ? "RESULT: FAIL — the tree cannot be trusted until the FAIL lines are cleared"
      : count("warn") > 0
        ? "RESULT: PASS (warnings are not verified)"
        : "RESULT: PASS — the chain is coherent",
  );
  return lines.join("\n");
}

const HELP = `agent-tree:doctor — is data/agent-tree.json stale, and would the hourly rebuild corrupt it?

Usage:
  bun run agent-tree:doctor [flags]

Flags:
  --repo <path>    checkout to inspect (default: this script's repository root); scratch/ is
                   per-checkout, so a worktree without it points here at the owning checkout
  --json           print {root, checks} as JSON instead of the human report
  --rebuild-check  run the scheduled argv into a temp directory and diff it against the
                   committed artifacts (writes only inside the temp directory)
  --offline        do not read http://127.0.0.1:4020/api/status for the schedule's run state
  --help, -h       print this help

Exit code:
  0  no FAIL checks (warnings may remain)
  1  at least one FAIL check
  2  a flag was rejected

Checks:
  envelope              scratch/raw-f402-list-agents.json rows + sha256
  graph-manifest        scratch/agent-graph.manifest.json build stamps
  graph-envelope-sha    the graph was built from the envelope now on disk
  tree / index          each payload is internally consistent
  tree-covered-by-index every tree node resolves in data/agent-index.json
  overflow-invariant    index-only keys equal the manifest's skippedOverflowCount
  schedule-argv         sched_agent_tree_hourly can reproduce the committed pair
  schedule-requires     the schedule's credential gate is satisfied in this process
  schedule-run          /api/status: did the schedule actually run, skip, or fail
  rebuild               (--rebuild-check) the scheduled argv reproduces the committed pair

Examples:
  bun run agent-tree:doctor
  bun run agent-tree:doctor --repo ../../
  bun run agent-tree:doctor --json
  bun run agent-tree:doctor --rebuild-check
  bun run agent-tree:doctor --offline      (worktree or daemon down)
  bun run agent-tree:doctor --json | jq '.checks[] | select(.status == "fail")'
`;

/** `--repo <path>` or `--repo=<path>`; the rest of the argv is validated against the closed set. */
export function parseRepoFlag(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--repo") {
      const value = argv[index + 1];
      return value === undefined || value.startsWith("-") ? "" : value;
    }
    if (arg.startsWith("--repo=")) return arg.slice("--repo=".length);
  }
  return null;
}

/** Live desk status for the run-state check; a stopped daemon is a warn, never a throw. */
async function readLiveStatus(): Promise<unknown | null> {
  try {
    const response = await fetch("http://127.0.0.1:4020/api/status", {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const known = new Set(["--json", "--rebuild-check", "--offline"]);
  const unknown: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--repo") {
      index += 1; // its value is a path, not a flag
      continue;
    }
    if (arg.startsWith("--repo=") || known.has(arg)) continue;
    unknown.push(arg);
  }
  if (unknown.length > 0) {
    console.error(`agent-tree:doctor: unknown flag "${unknown[0] ?? ""}"`);
    console.error("  bun run agent-tree:doctor --help");
    return 2;
  }

  const repo = parseRepoFlag(argv);
  if (repo === "") {
    console.error("agent-tree:doctor: --repo needs a path");
    console.error("  bun run agent-tree:doctor --repo <checkout>");
    return 2;
  }
  const root = repo === null ? ROOT : path.resolve(repo);
  const repoStat = await Bun.file(root)
    .stat()
    .catch(() => null);
  if (repoStat === null || !repoStat.isDirectory()) {
    console.error(`agent-tree:doctor: --repo "${root}" is not a directory`);
    console.error("  bun run agent-tree:doctor --repo <checkout>");
    return 2;
  }

  const checks = await runDoctor(root, {
    rebuildCheck: argv.includes("--rebuild-check"),
    ...(argv.includes("--offline")
      ? {}
      : { readStatus: () => readLiveStatus() }),
  });
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ root, checks }, null, 2));
  } else {
    console.log(renderReport(checks, root));
  }
  return exitCode(checks);
}

if (import.meta.main) {
  process.exit(await main());
}
