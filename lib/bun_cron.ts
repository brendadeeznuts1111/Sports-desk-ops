/**
 * Bun 1.4 `Bun.cron` helpers — OS-level Workers shape vs in-process callbacks.
 *
 * **Platforms:** crontab (Linux), launchd (macOS), Task Scheduler (Windows).
 *
 * **Three entry points:**
 * - `await Bun.cron(path, schedule, title)` — OS job; see {@link BUN_CRON_OS_REGISTER_EXAMPLE}
 *   and {@link BUN_CRON_OS_WORKER_SCHEDULED_EXAMPLE}. Worker exports `default { scheduled }`
 *   (Cloudflare Cron Triggers: `controller.cron`, `controller.scheduledTime`, `controller.type`).
 *   Fleet: {@link installOsCronJob} / {@link removeOsCronJob}.
 * - `Bun.cron(schedule, handler, { tz? })` — in-process on the event loop; returns a
 *   `CronJob` (`job.cron`, `ref`/`unref`, `stop`, `[Symbol.dispose]`). Jobs never
 *   overlap (next fire after handler + Promise settle). CronJob handle: `.cron`, `.ref()` /
 *   `.unref()`, `.stop()`, `[Symbol.dispose]` — see {@link BUN_CRON_IN_PROCESS_HANDLE_EXAMPLE}.
 *   {@link startInProcessCron} returns the same handle; daemons use
 *   {@link wireInProcessCronLifecycle} (`ref` + SIGINT/SIGTERM).
 * - `Bun.cron.parse(expression, from?, { tz? })` — next matching `Date` ({@link BUN_CRON_PARSE_EXAMPLE});
 *   **system local wall clock by default** (not UTC unless `{ tz: "UTC" }`). `null` within 8y horizon;
 *   invalid `from` outside ECMAScript Date range throws `TypeError`.
 *
 * **Syntax:** standard 5-field cron, named days/months, nicknames (`@daily`, …). #26999
 *
 * **Ship note (Bun v1.4 blog):** {@link BUN_CRON_V14_BLOG_LOCAL_TZ_SHIP_NOTE} — {@link BUN_CRON_V14_BLOG_LOCAL_TZ_URL}
 *
 * @see https://bun.com/docs/runtime/cron
 * @see lib/bun_cron.test.ts
 * @see docs/runbooks/os_bun_cron_integration_guide.md
 */

import { fileURLToPath } from "node:url";
import { bunUrl, textFragment } from "./bun_urls.ts";

/** Verbatim v1.4 blog line; {@link BUN_CRON_V14_BLOG_LOCAL_TZ_URL} links to it. */
export const BUN_CRON_V14_BLOG_LOCAL_TZ_SHIP_NOTE =
  "Bun.cron schedules run in local time by default, with a new { tz } option for explicit timezones; parse() rejects from timestamps outside the ECMAScript Date range. #35122 #29282" as const;

/** Deep link — local time default, `{ tz }`, parse `from` range (#35122, #29282). */
export const BUN_CRON_V14_BLOG_LOCAL_TZ_URL = bunUrl(
  `/blog/bun-v1.4#bun-markdown${textFragment({ start: BUN_CRON_V14_BLOG_LOCAL_TZ_SHIP_NOTE })}`,
);

/** True when Bun invokes a worker via `bun run --cron-title=… --cron-period=…`. */
export function isBunOsCronInvocation(
  argv: readonly string[] = process.argv,
): boolean {
  return argv.some((arg) => arg.startsWith("--cron-"));
}

/** Absolute script path for `await Bun.cron(path, schedule, title)` (launchd/crontab). */
export function osCronWorkerPath(importMetaUrl: string): string {
  return fileURLToPath(importMetaUrl);
}

export type InProcessCronJob = {
  readonly cron: string;
  ref(): InProcessCronJob;
  unref(): InProcessCronJob;
  stop(): InProcessCronJob;
  [Symbol.dispose](): void;
};

/** Workers Cron Triggers export shape for OS-level jobs. */
export type CronScheduledWorker = {
  scheduled(controller: Bun.CronController): void | Promise<void>;
};

export interface CronSchedulePreview {
  readonly schedule: string;
  readonly tz: string | undefined;
  readonly next: Date;
}

export interface StartInProcessCronOptions {
  readonly tz?: string;
  /**
   * When `false`, calls `job.unref()` so a short-lived host process may exit without waiting
   * on the schedule. Default keeps the Bun default (`ref` — process stays alive).
   */
  readonly keepAlive?: boolean;
}

/** Verbatim Bun docs — {@link startInProcessCron} returns this same `CronJob` handle. */
export const BUN_CRON_IN_PROCESS_HANDLE_EXAMPLE =
  `using job = Bun.cron("*/5 * * * *", async () => {
  await cleanupTempFiles();
});
job.cron; // "*/5 * * * *"
job.unref(); // allow process exit
job.stop(); // cancel (or let \`using\` dispose)` as const;

/** Register launchd / crontab / Task Scheduler job (survives reboot). */
export const BUN_CRON_OS_REGISTER_EXAMPLE =
  `await Bun.cron("./worker.ts", "30 2 * * MON", "weekly-report");` as const;

/** Same \`title\` overwrites schedule in place — no duplicate OS job. */
export const BUN_CRON_OS_REREGISTER_EXAMPLE =
  `await Bun.cron("./worker.ts", "0 * * * *", "my-job"); // every hour
await Bun.cron("./worker.ts", "*/15 * * * *", "my-job"); // replaces: every 15 min` as const;

/** Next fire; local TZ by default — pass third arg `{ tz: "UTC" }` for UTC wall clock. */
export const BUN_CRON_PARSE_EXAMPLE =
  `const next = Bun.cron.parse("*/15 * * * *");` as const;

/** OS worker module — Bun invokes on schedule (async OK; waits before exit). */
export const BUN_CRON_OS_WORKER_SCHEDULED_EXAMPLE = `export default {
  scheduled(controller: Bun.CronController) {
    console.log(controller.cron); // "30 2 * * 1"
    console.log(controller.type); // "scheduled"
    console.log(controller.scheduledTime); // Date.now() at invocation
  },
};` as const;

/**
 * Tier-2 OS worker — ESM `import worker from "./worker.ts"` yields {@link CronScheduledWorker}
 * directly (not `{ default: … }` at runtime).
 */
export type CronScheduledWorkerExport = CronScheduledWorker;

/** Type-only shape for `export default { scheduled }` modules. */
export type CronScheduledWorkerModule = {
  default: CronScheduledWorker;
};

export function startInProcessCron(
  schedule: string,
  handler: () => void | Promise<void>,
  options?: StartInProcessCronOptions,
): InProcessCronJob {
  const tz = options?.tz?.trim();
  const job = (tz !== undefined && tz !== ""
    ? Bun.cron(schedule, handler, { tz })
    : Bun.cron(schedule, handler)) as unknown as InProcessCronJob;
  if (options?.keepAlive === false) {
    job.unref();
  }
  return job;
}

export function parseCronScheduleOrNull(
  schedule: string,
  options?: { readonly tz?: string; readonly from?: Date | number },
): Date | null {
  const tz = options?.tz?.trim();
  const from = options?.from ?? new Date();
  return tz !== undefined && tz !== ""
    ? Bun.cron.parse(schedule, from, { tz })
    : Bun.cron.parse(schedule, from);
}

/** Next fire time; throws if expression/`from` is invalid or parse returns null. */
export function parseCronSchedule(
  schedule: string,
  options?: { readonly tz?: string; readonly from?: Date | number },
): Date {
  const next = parseCronScheduleOrNull(schedule, options);
  if (next === null || !(next instanceof Date)) {
    throw new Error(`invalid cron schedule: ${JSON.stringify(schedule)}`);
  }
  return next;
}

export function previewCronSchedule(
  schedule: string,
  options?: { readonly tz?: string; readonly from?: Date | number },
): CronSchedulePreview {
  const tzRaw = options?.tz?.trim();
  const tz = tzRaw !== undefined && tzRaw !== "" ? tzRaw : undefined;
  const opts: { tz?: string; from?: Date | number } = {};
  if (tz !== undefined) opts.tz = tz;
  if (options?.from !== undefined) opts.from = options.from;
  const next = parseCronSchedule(schedule, opts);
  return { schedule, tz, next };
}

/** One-line operator hint: schedule, optional tz, next fire ISO time. */
export function formatCronScheduleLine(preview: CronSchedulePreview): string {
  const tzSuffix = preview.tz ? ` (${preview.tz})` : "";
  return `scheduled "${preview.schedule}"${tzSuffix} · next ${preview.next.toISOString()}`;
}

/**
 * OS-level registration. Refuses `{ tz }` — crontab/launchd/Task Scheduler have no IANA pin in
 * Bun's path overload (use in-process `startInProcessCron` for explicit zones).
 */
/** OS install — no `tz` field (illegal at type level; use in-process cron to pin IANA). */
export interface OsCronInstallOptions {
  readonly workerImportMetaUrl: string;
  readonly schedule: string;
  readonly title: string;
}

const OS_CRON_TITLE_PATTERN = /^[\w-]+$/;

/**
 * Register (or update) an OS-level job via `await Bun.cron(path, schedule, title)`.
 *
 * - `path`: absolute path to the worker module (`osCronWorkerPath`).
 * - `schedule`: five-field cron or nickname (`@daily`, …).
 * - `title`: unique id — **alphanumeric, hyphens, underscores only** (no dots).
 *
 * Re-registering with the **same title** overwrites the existing job in place (new schedule,
 * no duplicate launchd/crontab entry).
 */
export async function installOsCronJob(
  options: OsCronInstallOptions,
): Promise<void> {
  if (!OS_CRON_TITLE_PATTERN.test(options.title)) {
    throw new Error(
      `Cron title must contain only alphanumeric characters, hyphens, and underscores (got ${JSON.stringify(options.title)})`,
    );
  }
  await Bun.cron(
    osCronWorkerPath(options.workerImportMetaUrl),
    options.schedule,
    options.title,
  );
}

export async function removeOsCronJob(title: string): Promise<void> {
  await Bun.cron.remove(title);
}

/** macOS launchd plist path for an OS-level Bun.cron job (`title` = third arg to `Bun.cron`). */
export function bunCronLaunchAgentPlistPath(title: string): string {
  const home = (process.env.HOME ?? "").trim();
  if (home === "") {
    throw new Error("HOME is unset; cannot resolve LaunchAgents path");
  }
  return `${home}/Library/LaunchAgents/bun.cron.${title}.plist`;
}

/** macOS log paths Bun writes for OS-level cron jobs. */
export function bunCronMacLogPaths(title: string): {
  readonly stdout: string;
  readonly stderr: string;
} {
  return {
    stdout: `/tmp/bun.cron.${title}.stdout.log`,
    stderr: `/tmp/bun.cron.${title}.stderr.log`,
  };
}

/** Keep process alive; stop job and exit on SIGINT/SIGTERM (daemon CLIs). */
export function wireInProcessCronLifecycle(
  job: InProcessCronJob,
  options?: {
    readonly onShutdown?: (signal: NodeJS.Signals) => void;
    readonly exitCode?: number;
  },
): void {
  job.ref();
  const stop = (signal: NodeJS.Signals): void => {
    options?.onShutdown?.(signal);
    job.stop();
    process.exit(options?.exitCode ?? 0);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}
