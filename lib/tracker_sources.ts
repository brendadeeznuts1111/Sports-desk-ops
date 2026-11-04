/**
 * Where the tracker page gets its data, and what it says when a source is not there.
 *
 * Four sources, each optional on a given host: a task file (`scratch/dashboard/tasks.json`, local
 * and gitignored), `gh` for pull requests and main CI, `git ls-files` plus the repository text for
 * mentions, and the secret manifest status. The production VPS has none of the first three, so
 * there the page says "not available on this host" instead of showing an empty table that looks
 * like "no work".
 *
 * Reads only. Secret values are never put into state: `manifestStatus` reports a source per name.
 */
import path from "node:path";
import { z } from "zod";

import { describeSource, manifestStatus } from "./secret_env.ts";
import { SECRET_MANIFEST } from "./secret_manifest.ts";
import {
  TASK_STATUSES,
  type Section,
  type TrackerMentions,
  type TrackerPr,
  type TrackerSecret,
  type TrackerState,
  type TrackerTask,
} from "./tracker_dashboard.ts";

export interface RunResult {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

export type Runner = (
  cmd: readonly string[],
  cwd: string,
) => Promise<RunResult>;

export interface TrackerSources {
  readonly root: string;
  readonly run: Runner;
  readonly now: () => Date;
  /** `null` when the file is absent. */
  readonly readTasksFile: () => Promise<string | null>;
  readonly readFile: (relative: string) => Promise<string | null>;
  readonly secretStatus: typeof manifestStatus;
}

export const defaultRunner: Runner = async (cmd, cwd) => {
  try {
    const child = Bun.spawn([...cmd], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const [out, err, code] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    return { ok: code === 0, out, err };
  } catch (error) {
    // Bun.spawn throws when the binary does not exist (no gh or no git on this host).
    return {
      ok: false,
      out: "",
      err: error instanceof Error ? error.message : String(error),
    };
  }
};

export function defaultSources(root: string): TrackerSources {
  return {
    root,
    run: defaultRunner,
    now: () => new Date(),
    readTasksFile: async () => {
      const file = Bun.file(path.join(root, "scratch/dashboard/tasks.json"));
      return (await file.exists()) ? file.text() : null;
    },
    readFile: async (relative) => {
      const file = Bun.file(path.join(root, relative));
      return (await file.exists()) ? file.text() : null;
    },
    secretStatus: manifestStatus,
  };
}

const TaskFile = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    status: z.enum(TASK_STATUSES),
    blockedBy: z.string(),
    next: z.string(),
  }),
);

export async function loadTasks(
  sources: TrackerSources,
): Promise<Section<TrackerTask>> {
  const text = await sources.readTasksFile();
  if (text === null) {
    return {
      kind: "unavailable",
      reason: "no task file (scratch/dashboard/tasks.json)",
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "unavailable", reason: "the task file is not valid JSON" };
  }
  const parsed = TaskFile.safeParse(json);
  return parsed.success
    ? { kind: "rows", rows: parsed.data }
    : {
        kind: "unavailable",
        reason: "the task file does not match the task shape",
      };
}

const PrList = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    state: z.string(),
    headRefName: z.string(),
    baseRefName: z.string(),
    url: z.string(),
    statusCheckRollup: z
      .array(
        z.object({
          conclusion: z.string().nullish(),
          status: z.string().nullish(),
        }),
      )
      .nullish(),
  }),
);

type Check = {
  conclusion?: string | null | undefined;
  status?: string | null | undefined;
};

export function ciOf(
  checks: readonly Check[] | null | undefined,
): TrackerPr["ci"] {
  if (checks === null || checks === undefined || checks.length === 0)
    return "none";
  if (checks.some((c) => c.status != null && c.status !== "COMPLETED"))
    return "running";
  const bad = checks.some(
    (c) => !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion ?? ""),
  );
  return bad ? "fail" : "pass";
}

function prState(raw: string): TrackerPr["state"] {
  const state = raw.toLowerCase();
  return state === "open" || state === "merged" ? state : "closed";
}

export async function loadPullRequests(
  sources: TrackerSources,
): Promise<Section<TrackerPr>> {
  const result = await sources.run(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      "40",
      "--json",
      "number,title,state,headRefName,baseRefName,url,statusCheckRollup",
    ],
    sources.root,
  );
  if (!result.ok) {
    return {
      kind: "unavailable",
      reason: `gh: ${result.err.trim().slice(0, 200) || "failed"}`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(result.out);
  } catch {
    return {
      kind: "unavailable",
      reason: "gh returned something that is not JSON",
    };
  }
  const parsed = PrList.safeParse(json);
  if (!parsed.success) {
    return {
      kind: "unavailable",
      reason: "gh output did not match the expected shape",
    };
  }
  return {
    kind: "rows",
    rows: parsed.data.map((p) => ({
      number: p.number,
      title: p.title,
      state: prState(p.state),
      head: p.headRefName,
      base: p.baseRefName,
      url: p.url,
      ci: ciOf(p.statusCheckRollup),
    })),
  };
}

const RunList = z.array(
  z.object({
    conclusion: z.string().nullish(),
    status: z.string(),
    headSha: z.string(),
  }),
);

export async function loadMainCi(
  sources: TrackerSources,
): Promise<string | null> {
  const result = await sources.run(
    [
      "gh",
      "run",
      "list",
      "--branch",
      "main",
      "--limit",
      "1",
      "--json",
      "conclusion,status,headSha",
    ],
    sources.root,
  );
  if (!result.ok) return null;
  try {
    const [run] = RunList.parse(JSON.parse(result.out));
    if (run === undefined) return "no runs";
    const verdict =
      run.status === "completed" ? (run.conclusion ?? "completed") : run.status;
    return `${verdict} @ ${run.headSha.slice(0, 7)}`;
  } catch {
    return null;
  }
}

/** The files that define a name are not uses of it; counting them would put every name at 1+. */
const MENTION_SKIP: ReadonlySet<string> = new Set([
  "lib/secret_manifest.ts",
  "lib/secret_audit.ts",
  "scripts/audit_secrets.ts",
  "tests/secret_manifest.test.ts",
]);

function isTestPath(file: string): boolean {
  return (
    /(^|\/)(tests?|fixtures)\//.test(file) || /\.test\.[cm]?[jt]s$/.test(file)
  );
}

function countWord(text: string, name: string): number {
  return text.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
}

/** Word matches of each manifest name in tracked code, or `null` when git cannot list files. */
export async function countMentions(
  sources: TrackerSources,
): Promise<ReadonlyMap<string, TrackerMentions> | null> {
  const listed = await sources.run(
    ["git", "ls-files", "*.ts", "*.js", "*.mjs"],
    sources.root,
  );
  if (!listed.ok) return null;
  const tally = new Map<
    string,
    { total: number; files: number; tests: number }
  >();
  for (const secret of SECRET_MANIFEST) {
    tally.set(secret.envName, { total: 0, files: 0, tests: 0 });
  }
  for (const file of listed.out.split("\n")) {
    if (file === "" || MENTION_SKIP.has(file)) continue;
    const text = await sources.readFile(file);
    if (text === null) continue;
    for (const secret of SECRET_MANIFEST) {
      const entry = tally.get(secret.envName);
      if (entry === undefined) continue;
      const n = countWord(text, secret.envName);
      if (n === 0) continue;
      entry.total += n;
      entry.files += 1;
      if (isTestPath(file)) entry.tests += n;
    }
  }
  return tally;
}

export async function loadSecrets(
  sources: TrackerSources,
): Promise<Section<TrackerSecret>> {
  let rows;
  try {
    rows = await sources.secretStatus();
  } catch (error) {
    // The keychain is not reachable from every host (a headless Linux box has no secret service).
    return {
      kind: "unavailable",
      reason: `secret status: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}`,
    };
  }
  const mentions = await countMentions(sources);
  return {
    kind: "rows",
    rows: rows.map((row) => ({
      name: row.name,
      groups: row.groups,
      injectable: row.injectable,
      source: describeSource(row.source),
      mentions: mentions?.get(row.name) ?? null,
    })),
  };
}

export async function loadTrackerState(
  sources: TrackerSources = defaultSources(path.resolve(import.meta.dir, "..")),
): Promise<TrackerState> {
  const [tasks, prs, secrets, mainCi] = await Promise.all([
    loadTasks(sources),
    loadPullRequests(sources),
    loadSecrets(sources),
    loadMainCi(sources),
  ]);
  return {
    generatedAt: sources.now().toISOString(),
    mainCi,
    tasks,
    prs,
    secrets,
  };
}

const CACHE_MS = 60_000;
let cached:
  { at: number; root: string; state: Promise<TrackerState> } | undefined;

/**
 * One state per minute per root. `gh`, `git ls-files` and a keychain sweep are too slow to run
 * on every request, and a page refresh does not need them fresher than that.
 */
export function loadTrackerStateCached(root: string): Promise<TrackerState> {
  const now = Date.now();
  if (
    cached !== undefined &&
    cached.root === root &&
    now - cached.at < CACHE_MS
  ) {
    return cached.state;
  }
  const state = loadTrackerState(defaultSources(root));
  cached = { at: now, root, state };
  // A rejected load must not stay cached for a minute.
  state.catch(() => {
    if (cached?.state === state) cached = undefined;
  });
  return state;
}
