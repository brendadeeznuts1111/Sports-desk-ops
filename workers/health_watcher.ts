#!/usr/bin/env bun
/**
 * OS-level health transition watcher (Cloudflare Workers `scheduled()` shape).
 *
 * Register with Bun (launchd on macOS):
 *   await Bun.cron(path, schedule, title)
 *
 * This module exports `default { scheduled(controller) }`. Re-installing the same
 * `title` overwrites the schedule in place (no duplicate OS jobs).
 *
 *   bun run health:watcher --install-os --schedule "* * * * *"
 *   bun run health:watcher --once --dry-run
 *
 * @see https://bun.com/docs/runtime/cron
 * @see lib/bun_cron.ts (`installOsCronJob` / `removeOsCronJob`)
 */
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import {
  bunCronMacLogPaths,
  bunCronLaunchAgentPlistPath,
  formatCronScheduleLine,
  installOsCronJob,
  isBunOsCronInvocation,
  previewCronSchedule,
  removeOsCronJob,
} from "../lib/bun_cron.ts";
import {
  healthWatcherDeskUrl,
  runHealthWatcherTick,
} from "../lib/health_watcher.ts";

/** Bun allows only `[A-Za-z0-9_-]` in cron titles (no dots). */
const OS_CRON_TITLE = "sportsdesk-health-watcher";
const DEFAULT_SCHEDULE = "* * * * *";

const HELP = `
health:watcher — Telegram alerts on desk operationalStatus transitions

Usage:
  bun run health:watcher [flags]

Flags:
  --once              Run one poll (for tests or manual verification)
  --dry-run           Print the message; do not call Telegram
  --install-os        Register an OS-level Bun.cron job (survives reboot)
  --remove-os         Unregister the OS-level job
  --schedule <cron>   Cron expression (default: ${DEFAULT_SCHEDULE})
  -h, --help          This text

Env:
  DESK_HEALTH_URL     Default http://127.0.0.1:\${PORT}/health
  HEALTH_WATCHER_STATE_PATH  State file (default scratch/health-watcher-state.json)
  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (or keychain)

OS job (survives reboot). Same title overwrites schedule — no duplicate jobs:
  bun run health:watcher --install-os --schedule "0 * * * *"   # hourly
  bun run health:watcher --install-os --schedule "*/15 * * * *" # replaces → every 15m
  bun run health:watcher --remove-os

Title: sportsdesk-health-watcher (alphanumeric, hyphens, underscores only)

Equivalent to:
  await Bun.cron("<abs>/workers/health_watcher.ts", "* * * * *", "${OS_CRON_TITLE}");

macOS (Bun registers via launchd):
  Plist: ~/Library/LaunchAgents/bun.cron.${OS_CRON_TITLE}.plist
  List:  launchctl list | grep bun.cron
  Logs:  /tmp/bun.cron.${OS_CRON_TITLE}.stdout.log
         /tmp/bun.cron.${OS_CRON_TITLE}.stderr.log

Manual remove (if Bun.cron.remove fails):
  launchctl bootout gui/$(id -u)/bun.cron.${OS_CRON_TITLE}
  rm ~/Library/LaunchAgents/bun.cron.${OS_CRON_TITLE}.plist

Examples:
  bun run health:watcher --once --dry-run
`.trim();

export default {
  async scheduled(controller: Bun.CronController): Promise<void> {
    console.error(
      JSON.stringify({
        signal: "HEALTH_WATCHER_OS_FIRE",
        type: controller.type,
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
        deskUrl: healthWatcherDeskUrl(),
      }),
    );
    const result = await runHealthWatcherTick();
    console.error(`[health-watcher] ${JSON.stringify(result)}`);
  },
};

async function runCli(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2), {
    valueFlags: ["--schedule"],
  });
  if (wantsHelp(parsed)) {
    printHelp(HELP);
    process.exit(0);
  }

  const schedule = flagValue(parsed, "--schedule", DEFAULT_SCHEDULE).trim();

  if (hasFlag(parsed, "--remove-os")) {
    await removeOsCronJob(OS_CRON_TITLE);
    console.error(`health:watcher: removed OS job "${OS_CRON_TITLE}"`);
    return;
  }

  if (hasFlag(parsed, "--install-os")) {
    const preview = previewCronSchedule(schedule);
    await installOsCronJob({
      workerImportMetaUrl: import.meta.url,
      schedule,
      title: OS_CRON_TITLE,
    });
    const logs = bunCronMacLogPaths(OS_CRON_TITLE);
    console.error(
      `health:watcher: installed OS job "${OS_CRON_TITLE}" (re-install overwrites schedule)`,
    );
    console.error(formatCronScheduleLine(preview));
    console.error(`plist: ${bunCronLaunchAgentPlistPath(OS_CRON_TITLE)}`);
    console.error(`logs:  ${logs.stdout}`);
    console.error(`       ${logs.stderr}`);
    return;
  }

  const result = await runHealthWatcherTick({
    dryRun: hasFlag(parsed, "--dry-run"),
  });
  console.error(`[health-watcher] ${JSON.stringify(result)}`);
  if (result.skippedReason === "send-failed") process.exit(1);
}

if (import.meta.main && !isBunOsCronInvocation(process.argv)) {
  const parsed = parseCliArgs(process.argv.slice(2), {
    valueFlags: ["--schedule"],
  });
  if (
    !wantsHelp(parsed) &&
    !hasFlag(parsed, "--once") &&
    !hasFlag(parsed, "--install-os") &&
    !hasFlag(parsed, "--remove-os")
  ) {
    console.error("health:watcher: pass --once, --install-os, or --remove-os");
    printHelp(HELP);
    process.exit(2);
  }
  await runCli();
}
