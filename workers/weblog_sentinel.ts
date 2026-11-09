#!/usr/bin/env bun
/**
 * Daily reminder when today's F402 weblog JSONL is not staged (manual export).
 *
 *   bun run weblog:sentinel --once --dry-run
 *   bun run weblog:sentinel --install-os --schedule "0 8 * * *"
 */
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import {
  bunCronLaunchAgentPlistPath,
  bunCronMacLogPaths,
  formatCronScheduleLine,
  installOsCronJob,
  isBunOsCronInvocation,
  previewCronSchedule,
  removeOsCronJob,
} from "../lib/bun_cron.ts";
import { runWeblogSentinelTick } from "../lib/weblog_sentinel.ts";

const OS_CRON_TITLE = "sportsdesk-weblog-sentinel";
const DEFAULT_SCHEDULE = "0 8 * * *";

const HELP = `
weblog:sentinel — Telegram nudge when today's F402 weblog JSONL is missing

Usage:
  bun run weblog:sentinel [flags]

Flags:
  --once              Run one check (manual or test)
  --dry-run           Print the message; do not call Telegram
  --install-os        Register OS-level Bun.cron (default 08:00 local)
  --remove-os         Unregister the OS-level job
  --schedule <cron>   Cron expression (default: ${DEFAULT_SCHEDULE})
  -h, --help          This text

Env:
  WEBLOG_SENTINEL_STATE_PATH  Dedupe state (default scratch/weblog-sentinel-state.json)
  F402_WEBLOG_OPERATOR_DEFAULT is probed for MM-DD-YYYY.jsonl alongside repo out/f402/weblog/

OS title: ${OS_CRON_TITLE}

Examples:
  bun run weblog:sentinel --once --dry-run
  bun run weblog:sentinel --install-os --schedule "0 8 * * *"
`.trim();

export default {
  async scheduled(controller: Bun.CronController): Promise<void> {
    console.error(
      JSON.stringify({
        signal: "WEBLOG_SENTINEL_OS_FIRE",
        type: controller.type,
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      }),
    );
    const result = await runWeblogSentinelTick();
    console.error(`[weblog-sentinel] ${JSON.stringify(result)}`);
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
    console.error(`weblog:sentinel: removed OS job "${OS_CRON_TITLE}"`);
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
      `weblog:sentinel: installed OS job "${OS_CRON_TITLE}" (re-install overwrites schedule)`,
    );
    console.error(formatCronScheduleLine(preview));
    console.error(`plist: ${bunCronLaunchAgentPlistPath(OS_CRON_TITLE)}`);
    console.error(`logs:  ${logs.stdout}`);
    console.error(`       ${logs.stderr}`);
    return;
  }

  const result = await runWeblogSentinelTick({
    dryRun: hasFlag(parsed, "--dry-run"),
  });
  console.error(`[weblog-sentinel] ${JSON.stringify(result)}`);
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
    console.error("weblog:sentinel: pass --once, --install-os, or --remove-os");
    printHelp(HELP);
    process.exit(2);
  }
  await runCli();
}
