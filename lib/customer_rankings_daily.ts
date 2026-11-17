/**
 * Daily Customer Profiles & 6,228-Customer Decision Ranking refresher.
 *
 * Refreshes live harvested profiles + built customer profiles (when available) and
 * regenerates `scratch/f402-customer-decision-rankings.{json,md}` +
 * `packages/ui/src/data/rankings-summary.json` when input corpora changed or `--force` is set.
 * Designed for both OS-level `Bun.cron` (`workers/customer_rankings_daily.ts`) and in-daemon
 * `ReportingSchedulerService`.
 */
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const CUSTOMER_RANKINGS_DAILY_STATE_REL =
  "scratch/customer-rankings-daily-state.json" as const;

export const RANKING_INPUT_REL_PATHS = [
  "scratch/f402-player-analysis-all.json",
  "scratch/graded/graded-oct-window.json",
  "scratch/graded/graded-today.json",
] as const;

export const RANKING_OUTPUT_REL_PATHS = [
  "scratch/f402-customer-decision-rankings.json",
  "packages/ui/src/data/rankings-summary.json",
] as const;

export interface CustomerRankingsDailyState {
  readonly schemaVersion: 1;
  readonly lastSuccessInputStamp: string | null;
  readonly lastRanAt: string | null;
  readonly lastDurationMs: number | null;
}

export interface CustomerRankingsDailyTickResult {
  readonly ok: boolean;
  readonly ranAt: string;
  readonly inputStamp: string | null;
  readonly missingPaths: readonly string[];
  readonly refreshedRankings: boolean;
  readonly skippedReason?:
    "missing-inputs" | "unchanged-inputs" | "dry-run" | "generator-failed";
  readonly exitCode?: number;
  readonly error?: string;
}

export interface CustomerRankingsDailyTickOptions {
  readonly root?: string;
  readonly now?: () => Date;
  readonly statePath?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly exists?: (path: string) => boolean;
  readonly stat?: (path: string) => { size: number; mtimeMs: number } | null;
  readonly loadState?: () => Promise<CustomerRankingsDailyState>;
  readonly saveState?: (state: CustomerRankingsDailyState) => Promise<void>;
  readonly runGenerator?: (
    cwd: string,
  ) => Promise<{ readonly exitCode: number; readonly stderr?: string }>;
}

function defaultRoot(): string {
  return resolve(import.meta.dirname, "..");
}

function defaultStatePath(): string {
  const fromEnv = (Bun.env.CUSTOMER_RANKINGS_DAILY_STATE_PATH ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return resolve(
    import.meta.dirname,
    `../${CUSTOMER_RANKINGS_DAILY_STATE_REL}`,
  );
}

function defaultStat(path: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(path);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

export async function loadCustomerRankingsDailyState(
  path = defaultStatePath(),
): Promise<CustomerRankingsDailyState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as CustomerRankingsDailyState;
    if (parsed?.schemaVersion === 1) return parsed;
  } catch {
    /* first run */
  }
  return {
    schemaVersion: 1,
    lastSuccessInputStamp: null,
    lastRanAt: null,
    lastDurationMs: null,
  };
}

export async function saveCustomerRankingsDailyState(
  state: CustomerRankingsDailyState,
  path = defaultStatePath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export function computeRankingInputStamp(
  root: string,
  statFn: (
    path: string,
  ) => { size: number; mtimeMs: number } | null = defaultStat,
): {
  readonly inputStamp: string | null;
  readonly missingPaths: readonly string[];
} {
  const missingPaths: string[] = [];
  const parts: string[] = [];
  for (const rel of RANKING_INPUT_REL_PATHS) {
    const abs = resolve(root, rel);
    const st = statFn(abs);
    if (st === null) {
      missingPaths.push(rel);
      continue;
    }
    parts.push(`${rel}:${st.size}:${Math.trunc(st.mtimeMs)}`);
  }
  if (missingPaths.length > 0) {
    return { inputStamp: null, missingPaths };
  }
  return {
    inputStamp: Bun.hash(parts.join("|")).toString(16),
    missingPaths: [],
  };
}

async function defaultRunGenerator(
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stderr?: string }> {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      "--no-orphans",
      "--no-env-file",
      "run",
      "scripts/generate_customer_decision_rankings.ts",
      "--project-summary",
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  return {
    exitCode: proc.exitCode,
    stderr: proc.stderr.toString().trim(),
  };
}

export async function runCustomerRankingsDailyTick(
  options: CustomerRankingsDailyTickOptions = {},
): Promise<CustomerRankingsDailyTickResult> {
  const now = options.now ?? (() => new Date());
  const root = options.root ?? defaultRoot();
  const statePath = options.statePath ?? defaultStatePath();
  const exists = options.exists ?? existsSync;
  const statFn = options.stat ?? defaultStat;
  const ranAt = now().toISOString();

  const { inputStamp, missingPaths } = computeRankingInputStamp(root, statFn);
  if (inputStamp === null || missingPaths.length > 0) {
    return {
      ok: true,
      ranAt,
      inputStamp: null,
      missingPaths,
      refreshedRankings: false,
      skippedReason: "missing-inputs",
    };
  }

  const state =
    options.loadState === undefined
      ? await loadCustomerRankingsDailyState(statePath)
      : await options.loadState();
  const save =
    options.saveState ?? ((s) => saveCustomerRankingsDailyState(s, statePath));

  const outputsExist = RANKING_OUTPUT_REL_PATHS.every((rel) =>
    exists(resolve(root, rel)),
  );
  if (
    options.force !== true &&
    outputsExist &&
    state.lastSuccessInputStamp === inputStamp
  ) {
    return {
      ok: true,
      ranAt,
      inputStamp,
      missingPaths: [],
      refreshedRankings: false,
      skippedReason: "unchanged-inputs",
    };
  }

  if (options.dryRun === true) {
    return {
      ok: true,
      ranAt,
      inputStamp,
      missingPaths: [],
      refreshedRankings: false,
      skippedReason: "dry-run",
    };
  }

  const startedMs = performance.now();
  const runner = options.runGenerator ?? defaultRunGenerator;
  const outcome = await runner(root);
  const durationMs = Math.round(performance.now() - startedMs);

  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      ranAt,
      inputStamp,
      missingPaths: [],
      refreshedRankings: false,
      skippedReason: "generator-failed",
      exitCode: outcome.exitCode,
      ...(outcome.stderr ? { error: outcome.stderr } : {}),
    };
  }

  await save({
    schemaVersion: 1,
    lastSuccessInputStamp: inputStamp,
    lastRanAt: ranAt,
    lastDurationMs: durationMs,
  });

  return {
    ok: true,
    ranAt,
    inputStamp,
    missingPaths: [],
    refreshedRankings: true,
    exitCode: 0,
  };
}
