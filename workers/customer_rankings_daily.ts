#!/usr/bin/env bun
/**
 * Daily OS-level `Bun.cron` worker for rebuilding the 6,228-customer decision rankings
 * and updating `packages/ui/src/data/rankings-summary.json` when staged inputs change.
 *
 *   bun run rankings:daily --once --dry-run
 *   bun run rankings:daily --once
 *   bun run rankings:daily --install-os --schedule "15 3 * * *"
 *   bun run rankings:daily --remove-os
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
import { runCustomerRankingsDailyTick } from "../lib/customer_rankings_daily.ts";

const OS_CRON_TITLE = "sportsdesk-customer-rankings";
const DEFAULT_SCHEDULE = "15 3 * * *";

const HELP = `
rankings:daily — Rebuild 6,228-customer decision rankings & UI summary projection

Usage:
  bun run rankings:daily [flags]

Flags:
  --once              Run one check/refresh cycle
  --force             Rebuild even when input mtime+size stamp is unchanged
  --dry-run           Verify staged inputs without spawning generator or writing files
  --install-os        Register persistent OS-level Bun.cron (default 03:15 local)
  --remove-os         Unregister the OS-level job
  --schedule <cron>   Cron expression (default: ${DEFAULT_SCHEDULE})
  -h, --help          This text

Env:
  CUSTOMER_RANKINGS_DAILY_STATE_PATH  Default scratch/customer-rankings-daily-state.json

OS title: ${OS_CRON_TITLE}

Examples:
  bun run rankings:daily --once --dry-run
  bun run rankings:daily --once --force
  bun run rankings:daily --install-os --schedule "15 3 * * *"
`.trim();

export default {
  async scheduled(controller: Bun.CronController): Promise<void> {
    console.error(
      JSON.stringify({
        signal: "CUSTOMER_RANKINGS_DAILY_OS_FIRE",
        type: controller.type,
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      }),
    );
    const result = await runCustomerRankingsDailyTick();
    console.error(`[rankings-daily] ${JSON.stringify(result)}`);
    if (!result.ok) process.exit(1);
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
    console.error(`rankings:daily: removed OS job "${OS_CRON_TITLE}"`);
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
      `rankings:daily: installed OS job "${OS_CRON_TITLE}" (re-install overwrites schedule)`,
    );
    console.error(formatCronScheduleLine(preview));
    console.error(`plist: ${bunCronLaunchAgentPlistPath(OS_CRON_TITLE)}`);
    console.error(`logs:  ${logs.stdout}`);
    console.error(`       ${logs.stderr}`);
    return;
  }

  const result = await runCustomerRankingsDailyTick({
    dryRun: hasFlag(parsed, "--dry-run"),
    force: hasFlag(parsed, "--force"),
  });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exit(1);
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
    console.error("rankings:daily: pass --once, --install-os, or --remove-os");
    printHelp(HELP);
    process.exit(2);
  }
  await runCli();
}
