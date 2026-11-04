#!/usr/bin/env bun
/**
 * @file scripts/artifacts_cron.ts
 * @description In-process and OS-level (`launchd` / `crontab` / Task Scheduler) scheduler for
 *              artifact regeneration (the P2.3 host).
 *
 * Default mode is `--offline`, which requires the cached CFB event index and the bridge capture.
 * `--mode live` fetches. Each run appends one JSON line to the journal; `--history` reads it back
 * with `Bun.JSONL.parseChunk`, which tolerates a partially written final line (even on line 1).
 *
 * Helpers: `lib/bun_cron.ts`. Canonical `Bun.cron` contract (`https://bun.com/docs/runtime/cron`):
 * - `Bun.cron.parse(expression, relativeDate?, { tz })` returns the next `Date` or `null` (if no
 *   match within 8 years).
 * - `Bun.cron(schedule, handler, { tz })` runs in-process with a no-overlap guarantee (computes the
 *   next fire only after the returned Promise settles) and returns a `Disposable` `CronJob` handle
 *   (`.cron`, `.stop()`, `.ref()`, `.unref()`, `[Symbol.dispose]()`).
 * - `await Bun.cron(path, schedule, title)` registers an OS-level background job that survives
 *   reboots (`~/Library/LaunchAgents/bun.cron.<title>.plist` on macOS) and invokes this module's
 *   default `scheduled(controller: Bun.CronController)` export. `await Bun.cron.remove(title)`
 *   unregisters it.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import {
  formatCronScheduleLine,
  installOsCronJob,
  isBunOsCronInvocation,
  previewCronSchedule,
  removeOsCronJob,
  startInProcessCron,
  wireInProcessCronLifecycle,
} from "../lib/bun_cron.ts";
import {
  formatRun,
  parseCronJournal,
  type CronRun,
} from "../lib/cron_journal.ts";

export const OS_CRON_TITLE = "sportsdesk-artifacts";
const DEFAULT_JOURNAL = "scratch/artifacts-cron.jsonl";

const VALUE_FLAGS = [
  "--schedule",
  "--tz",
  "--mode",
  "--journal",
  "--history",
  "--title",
] as const;

const HELP = `
artifacts:cron — rebuild the value artifacts on a schedule (in-process or OS-level)

Options:
  --schedule <expr>   Cron expression or nickname (@daily, @hourly, ...; default: ARTIFACTS_CRON or "0 6 * * *")
  --tz <iana>         IANA timezone for schedule evaluation (default: ARTIFACTS_CRON_TZ or local system timezone)
  --mode <m>          offline (default) or live
  --journal <path>    Run journal (default: scratch/artifacts-cron.jsonl)
  --history <n>       Print the last n runs and exit
  --print-schedule    Show the next fire time and exit
  --run-once          Rebuild now, then exit
  --install-os        Register an OS-level job (launchd/crontab) that survives reboots
  --remove-os         Remove the registered OS-level job
  --title <name>      OS job identifier (default: ${OS_CRON_TITLE})
  -h, --help          This text

Examples:
  bun run artifacts:cron --print-schedule
  bun run artifacts:cron --print-schedule --tz America/Chicago
  bun run artifacts:cron --run-once
  bun run artifacts:cron --install-os --schedule "0 6 * * *"
  bun run artifacts:cron --remove-os
  bun run artifacts:cron --history 20
  ARTIFACTS_CRON="0 */6 * * *" bun run artifacts:cron

A run is: generate_value_artifacts [--offline] → artifacts_lock --update. It never deploys.
`.trim();

export async function runArtifactRebuild(
  runMode: "offline" | "live" = "offline",
): Promise<CronRun> {
  const started = Date.now();
  const valueArgs = ["run", "scripts/generate_value_artifacts.ts"];
  if (runMode === "offline") valueArgs.push("--offline");

  const value = Bun.spawnSync(["bun", ...valueArgs], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const valueExitCode = value.exitCode ?? 1;
  let ok = valueExitCode === 0;
  let exitCode = valueExitCode;
  if (valueExitCode === 0) {
    const lock = Bun.spawnSync(
      ["bun", "run", "scripts/artifacts_lock.ts", "--update"],
      {
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const lockExitCode = lock.exitCode ?? 1;
    if (lockExitCode !== 0) {
      ok = false;
      exitCode = lockExitCode;
      return {
        at: new Date().toISOString(),
        ok,
        exitCode,
        durationMs: Date.now() - started,
        mode: runMode,
      };
    }
  }
  return {
    at: new Date().toISOString(),
    ok,
    exitCode,
    durationMs: Date.now() - started,
    mode: runMode,
  };
}

export async function recordCronRun(
  run: CronRun,
  journalPath: string = DEFAULT_JOURNAL,
): Promise<void> {
  await mkdir(dirname(journalPath), { recursive: true });
  await appendFile(journalPath, `${JSON.stringify(run)}\n`, "utf8");
  console.error(`artifacts:cron: ${formatRun(run)}`);
}

/**
 * Cloudflare Workers-compatible `scheduled(controller)` handler invoked when `Bun.cron` runs this
 * module as an OS-level scheduled job (`launchd` on macOS, `crontab` on Linux, Task Scheduler on Windows).
 */
export default {
  async scheduled(controller: Bun.CronController): Promise<void> {
    const modeEnv = Bun.env.ARTIFACTS_CRON_MODE === "live" ? "live" : "offline";
    const journalPath = Bun.env.ARTIFACTS_CRON_JOURNAL ?? DEFAULT_JOURNAL;
    console.error(
      JSON.stringify({
        signal: "ARTIFACTS_CRON_OS_FIRE",
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
        mode: modeEnv,
      }),
    );
    const run = await runArtifactRebuild(modeEnv);
    await recordCronRun(run, journalPath);
  },
};

if (import.meta.main && !isBunOsCronInvocation(process.argv)) {
  const parsed = parseCliArgs(process.argv.slice(2), {
    valueFlags: VALUE_FLAGS,
  });
  if (wantsHelp(parsed)) {
    printHelp(HELP);
    process.exit(0);
  }

  const schedule = flagValue(
    parsed,
    "--schedule",
    Bun.env.ARTIFACTS_CRON ?? "0 6 * * *",
  );
  const tz = flagValue(parsed, "--tz", Bun.env.ARTIFACTS_CRON_TZ ?? "");
  const mode = flagValue(parsed, "--mode", "offline");
  const journal = flagValue(parsed, "--journal", DEFAULT_JOURNAL);
  const historyArg = flagValue(parsed, "--history", "");
  const title = flagValue(parsed, "--title", OS_CRON_TITLE);

  if (hasFlag(parsed, "--remove-os")) {
    await removeOsCronJob(title);
    console.error(`artifacts:cron: removed OS-level job "${title}"`);
    process.exit(0);
  }

  if (mode !== "offline" && mode !== "live") {
    console.error(`artifacts:cron: --mode must be offline|live (got ${mode}).`);
    console.error("  bun run artifacts:cron --mode live");
    process.exit(2);
  }

  let preview: ReturnType<typeof previewCronSchedule>;
  try {
    const previewOpts: { tz?: string } = {};
    if (tz !== "") previewOpts.tz = tz;
    preview = previewCronSchedule(schedule, previewOpts);
  } catch {
    console.error(
      `artifacts:cron: invalid schedule "${schedule}"${tz ? ` (tz=${tz})` : ""}.`,
    );
    console.error('  bun run artifacts:cron --schedule "0 6 * * *"');
    process.exit(2);
  }
  const nextFire = preview.next;

  if (hasFlag(parsed, "--install-os")) {
    // The typed OS-level overload `Bun.cron(path, schedule, title)` carries no timezone
    // option, so an OS job always runs in the system timezone. `--tz` only affects the
    // next-fire preview above; installing while `--tz` is set would claim a fire time the
    // installed job will not honor.
    if (tz !== "") {
      console.error(
        `artifacts:cron: refusing to install OS-level job "${title}": --tz ${tz} is only supported for the next-fire preview, and the OS-level cron API cannot pin a timezone.`,
      );
      console.error(
        '  bun run artifacts:cron --install-os --schedule "0 6 * * *"',
      );
      process.exit(2);
    }
    await installOsCronJob({
      workerImportMetaUrl: import.meta.url,
      schedule,
      title,
    });
    console.error(
      `artifacts:cron: installed OS-level job "${title}" · ${formatCronScheduleLine(preview)}`,
    );
    process.exit(0);
  }

  if (hasFlag(parsed, "--print-schedule")) {
    console.log(`schedule: ${schedule}${tz ? ` (${tz})` : ""}`);
    console.log(
      `next fire: ${nextFire.toISOString()} (${nextFire.toString()})`,
    );
    console.log(`mode: ${mode} · journal: ${journal}`);
    process.exit(0);
  }

  if (historyArg !== "") {
    const limit = Math.max(1, Number(historyArg) || 10);
    const file = Bun.file(journal);
    if (!(await file.exists())) {
      console.error(`artifacts:cron: no journal at ${journal}.`);
      console.error("  bun run artifacts:cron --run-once");
      process.exit(2);
    }
    const runs = parseCronJournal(await file.bytes());
    if (runs.length === 0)
      console.error(`artifacts:cron: journal ${journal} has no complete runs`);
    for (const run of runs.slice(-limit)) console.log(formatRun(run));
    process.exit(0);
  }

  if (hasFlag(parsed, "--run-once")) {
    await recordCronRun(await runArtifactRebuild(mode), journal);
    process.exit(0);
  }

  const job = startInProcessCron(
    schedule,
    async () => {
      await recordCronRun(await runArtifactRebuild(mode), journal);
    },
    tz !== "" ? { tz } : undefined,
  );
  wireInProcessCronLifecycle(job);

  console.error(
    `artifacts:cron: ${formatCronScheduleLine({ ...preview, schedule: job.cron })} · journal ${journal}`,
  );
}
