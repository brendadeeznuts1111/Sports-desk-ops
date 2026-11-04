#!/usr/bin/env bun
/**
 * @file reporting_scheduler_service.ts
 * @description Dedicated Scheduled Reporting Engine for SportsDesk & Fantasy402 (Bun v1.4+).
 *
 * Implements:
 *  1. Automated Cron/Interval Schedules for SportsDesk Master Book (Master: BILLY666):
 *     - 10-Minute Live Volume & Positions Pulse (every 10m): Syncs live Fantasy402 stream
 *       (`f402-bets.jsonl` + `f402-open-export.jsonl` + `DOD6` v5.4 spine) into `data/live-wagers.json`
 *       and `data/live-bets.json` and dispatches a live summary of total volume updates and open positions.
 *     - Morning Risk Briefing (08:00 EDT): Overnight open exposure, whale watch (RF2003), sniper alerts.
 *     - Midday Steam & Volatility Pulse (13:00 EDT): Line moves, active steam originators (GP300, AT10359).
 *     - Evening Settlement Recap (23:00 EDT): Daily settled handle, net hold, agent 50% shares.
 *  2. Report Generators with Markdown/HTML formatting and Telegram WebApp deep links.
 *  3. Cron Runner with native Bun.cron monitoring, trigger history, and on-demand dispatch.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startInProcessCron } from "../lib/bun_cron.ts";
import {
  formatTelegramPulseHtml,
  runLivePositionsPulse,
  type LivePositionsPulseSummary,
} from "../scripts/live_positions_cron.ts";
import { SportsDeskTelegramService } from "./sportsdesk_telegram_bot.ts";
import {
  formatBridgeDigestHtml,
  runBridgeRollupCycle,
  type BridgeRollupCycleResult,
  type BridgeRollupJobId,
} from "../lib/bridge_rollup_cron.ts";

/** The bridge schedules; the webview daemon owns them and the bot daemon must not duplicate them. */
export const BRIDGE_SCHEDULE_IDS = [
  "sched_bridge_rollup_15m",
  "sched_bridge_weblog_hourly",
] as const;

export type ReportType =
  | "MORNING_BRIEFING"
  | "MIDDAY_STEAM"
  | "EVENING_SETTLEMENT"
  | "TEN_MINUTE_POSITIONS_PULSE"
  | "BRIDGE_ROLLUP_DIGEST"
  | "CUSTOM_HOURLY_PULSE";

export interface ScheduleDefinition {
  readonly id: string;
  readonly name: string;
  readonly scheduleTime: string; // e.g. "08:00", "13:00", "23:00", or cron "*/10 * * * *"
  readonly reportType: ReportType;
  readonly description: string;
  readonly targetChatId?: string;
  /** Cron timezone; bridge schedules run on the desk clock (America/Chicago). */
  readonly tz?: string;
  /** Rollup jobs a bridge schedule runs; omitted means the whole cycle. */
  readonly bridgeJobs?: readonly BridgeRollupJobId[];
  enabled: boolean;
  lastTriggeredAt?: string;
}

export interface GeneratedReport {
  readonly reportType: ReportType;
  readonly title: string;
  readonly contentHtml: string;
  readonly generatedAt: string;
  readonly targetMiniappTab: string;
}

const SUMMARY_JSON_PATH = resolve(
  import.meta.dir,
  "../reports/live-positions-summary.json",
);

const BRIDGE_STATE_PATH = resolve(
  import.meta.dir,
  "../scratch/bridge-rollup-state.json",
);

/** The last cycle the scheduler wrote; the digest generator and the dashboard both read it. */
function readLatestBridgeState(): BridgeRollupCycleResult | null {
  const path = Bun.env.BRIDGE_ROLLUP_STATE_PATH?.trim() || BRIDGE_STATE_PATH;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BridgeRollupCycleResult;
  } catch {
    return null;
  }
}

function readLatestLiveSummary(): LivePositionsPulseSummary | null {
  if (!existsSync(SUMMARY_JSON_PATH)) return null;
  try {
    return JSON.parse(
      readFileSync(SUMMARY_JSON_PATH, "utf8"),
    ) as LivePositionsPulseSummary;
  } catch {
    return null;
  }
}

export class ReportingSchedulerService {
  private readonly telegramService: SportsDeskTelegramService;
  private readonly schedules: Map<string, ScheduleDefinition> = new Map();
  constructor(telegramService?: SportsDeskTelegramService) {
    this.telegramService = telegramService || new SportsDeskTelegramService();
    this.telegramService.setReportGenerator((type) =>
      this.generateReport(type),
    );
    this.initDefaultSchedules();
  }

  /**
   * Fires each enabled schedule (`HH:MM` or 5-field cron expression) in its own timezone (the
   * legacy reports keep America/New_York, the bridge schedules use America/Chicago); returns a
   * stop function. `only`/`exclude` let two processes split ownership instead of double-firing.
   */
  public start(
    options: {
      readonly only?: readonly string[];
      readonly exclude?: readonly string[];
    } = {},
  ): () => void {
    const only = options.only === undefined ? null : new Set(options.only);
    const exclude = new Set(options.exclude ?? []);
    const jobs = this.getSchedules()
      .filter((s) => s.enabled)
      .filter((s) => (only === null ? true : only.has(s.id)))
      .filter((s) => !exclude.has(s.id))
      .map((s) => {
        const cronExpr = s.scheduleTime.includes(" ")
          ? s.scheduleTime
          : (() => {
              const [hour, minute] = s.scheduleTime.split(":").map(Number);
              return `${minute} ${hour} * * *`;
            })();
        return startInProcessCron(
          cronExpr,
          async () => {
            s.lastTriggeredAt = new Date().toISOString();
            if (s.reportType === "TEN_MINUTE_POSITIONS_PULSE") {
              await runLivePositionsPulse({
                schedule: cronExpr,
                ...(s.targetChatId ? { chatIdOverride: s.targetChatId } : {}),
              });
            } else if (s.reportType === "BRIDGE_ROLLUP_DIGEST") {
              await this.dispatchBridgeDigest(s.bridgeJobs, s.targetChatId);
            } else {
              await this.dispatchReportNow(s.reportType, s.targetChatId);
            }
          },
          { tz: s.tz ?? "America/New_York" },
        );
      });
    console.log(
      `[Reporting Scheduler] ${jobs.length} schedules active (America/New_York): ${this.getSchedules()
        .filter((s) => s.enabled)
        .map((s) => s.scheduleTime)
        .join(", ")}`,
    );
    return () => {
      for (const job of jobs) job.stop();
    };
  }

  /** Start exactly the bridge schedules; the webview daemon owns them. */
  public startBridgeSchedules(): () => void {
    return this.start({ only: BRIDGE_SCHEDULE_IDS });
  }

  private initDefaultSchedules(): void {
    const defaultList: ScheduleDefinition[] = [
      {
        id: "sched_10m_positions_pulse",
        name: "10-Minute Live Volume & Positions Pulse",
        scheduleTime: "*/10 * * * *",
        reportType: "TEN_MINUTE_POSITIONS_PULSE",
        description:
          "Syncs live Fantasy402 stream into data/live-wagers.json and data/live-bets.json and sends 10-minute total volume delta & open positions summary.",
        enabled: true,
      },
      {
        id: "sched_morning_briefing",
        name: "Morning Risk Briefing",
        scheduleTime: "08:00",
        reportType: "MORNING_BRIEFING",
        description:
          "Overnight open pending exposure, whale concentration check, and sniper watch ahead of afternoon games.",
        enabled: true,
      },
      {
        id: "sched_midday_pulse",
        name: "Midday Steam & Volatility Pulse",
        scheduleTime: "13:00",
        reportType: "MIDDAY_STEAM",
        description:
          "Line movement alerts, steam originations from GP300 and AT10359, and in-play ticket velocity.",
        enabled: true,
      },
      {
        id: "sched_evening_settlement",
        name: "Evening Settlement Recap",
        scheduleTime: "23:00",
        reportType: "EVENING_SETTLEMENT",
        description:
          "Settled volume, customer payout/loss, net book hold, and agent 50% liability shares.",
        enabled: true,
      },
      {
        id: "sched_bridge_rollup_15m",
        name: "Bridge Rollup Cycle (3a/3b/3c)",
        scheduleTime: "*/15 * * * *",
        reportType: "BRIDGE_ROLLUP_DIGEST",
        description:
          "Runs the one-shot bridge rollups (bet ticker, pending, GSLive tally), publishes them and sends an on-change digest. Overlaps are skipped.",
        tz: "America/Chicago",
        bridgeJobs: ["bridge3a", "bridge3b", "bridge3c"],
        enabled: true,
      },
      {
        id: "sched_bridge_weblog_hourly",
        name: "Bridge WebLog Rollup (hourly)",
        scheduleTime: "7 * * * *",
        reportType: "BRIDGE_ROLLUP_DIGEST",
        description:
          "Runs the WebLog corpus rollup hourly at minute 7 and sends an on-change Mode 6 digest. Overlaps are skipped.",
        tz: "America/Chicago",
        bridgeJobs: ["weblog"],
        enabled: true,
      },
    ];

    for (const item of defaultList) {
      this.schedules.set(item.id, item);
    }
  }

  public getSchedules(): ScheduleDefinition[] {
    return Array.from(this.schedules.values());
  }

  public generateReport(type: ReportType): GeneratedReport {
    const nowStr =
      new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC-5";
    const liveSummary = readLatestLiveSummary();

    if (type === "TEN_MINUTE_POSITIONS_PULSE" && liveSummary !== null) {
      return {
        reportType: type,
        title: "10-Minute Live Volume & Positions Pulse",
        contentHtml: formatTelegramPulseHtml(liveSummary),
        generatedAt: nowStr,
        targetMiniappTab: "live",
      };
    }

    if (type === "BRIDGE_ROLLUP_DIGEST") {
      const latest = readLatestBridgeState();
      return {
        reportType: type,
        title: "Bridge Rollup Digest",
        contentHtml:
          latest === null
            ? "🛰️ <b>BRIDGE ROLLUP DIGEST</b>\n\nNo rollup cycle recorded yet. Run <code>bun run bridge3a:poll --once</code> or wait for the 15-minute cycle."
            : formatBridgeDigestHtml(latest, { quiet: true }),
        generatedAt: nowStr,
        targetMiniappTab: "live",
      };
    }

    if (type === "MORNING_BRIEFING") {
      const openInfo = liveSummary
        ? `\n• Live 24h Open Tix : <b>${liveSummary.window24hOpenPositions.openTicketsCount.toLocaleString()}</b> ($${(liveSummary.window24hOpenPositions.openRiskCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} Risk)`
        : "";
      const html = `
☀️ <b>SPORTSDESK MORNING RISK BRIEFING</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Master Agent: <code>BILLY666</code> • Generated: <code>${nowStr}</code>

📊 <b>Current Production Master Scope:</b>
• Total Accounts    : <b>14,534</b> Canonical (Active: 2,236 • Sub-Accounts Merged: 40)
• Sub-Agents in Tree: <b>668</b> (Active Sports: 460)
• Total Sports Handle: <b>$2,786,199.00</b> (10,941 Settled Tickets)${openInfo}
• Lifetime Net Hold : <b>+$35,697,418.60</b> (DOD6 v5.4 Conserved Spine)

⚠️ <b>Overnight & Morning Threat Assessment:</b>
• <b>Whale Surveillance (RF2003):</b> Account represents <b>33.7% of total book handle</b> ($940k). Verify single-wager limit ceiling is active.
• <b>Snipers on Standby:</b> BGD101 (+$40k win, 100% hit rate) and MJ102 (+$30k win, +150 ML) awaiting afternoon slate.
• <b>Chronic Bleed:</b> 148 sub-agents are running chronic net-negative lifetime balances.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
      return {
        reportType: type,
        title: "Morning Risk Briefing",
        contentHtml: html.trim(),
        generatedAt: nowStr,
        targetMiniappTab: "downline",
      };
    }

    if (type === "MIDDAY_STEAM") {
      const html = `
⚡ <b>SPORTSDESK MIDDAY STEAM & VOLATILITY PULSE</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Master Agent: <code>BILLY666</code> • Generated: <code>${nowStr}</code>

🎯 <b>Originators & Steam Chasers Active:</b>
• <b>GP300 (GPRO50RSK):</b> 22 tickets, $46.1k handle, <b>+$33,858 win</b> (Hold: -73.4%)
• <b>AT10359 (ATEAM):</b> 21 tickets, $26.5k handle, <b>+$19,024 win</b> (Hold: -71.8%)
• <b>BCC1530 (SPEN):</b> 31 tickets, $19.7k handle, <b>+$10,514 win</b> (Hold: -53.3%)
• <b>AT811 (ATEAM):</b> 30 tickets, $5.9k handle, <b>+$3,967 win</b> (Hold: -66.2%)

🛡 <b>Operational Directive:</b>
Enforce 6-second dynamic confirmation delay gate across live/in-play markets and moving numbers.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
      return {
        reportType: type,
        title: "Midday Steam & Volatility Pulse",
        contentHtml: html.trim(),
        generatedAt: nowStr,
        targetMiniappTab: "forensics",
      };
    }

    const html = `
🌙 <b>SPORTSDESK EVENING SETTLEMENT RECAP</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Master Agent: <code>BILLY666</code> • Generated: <code>${nowStr}</code>

📉 <b>Settled Sports Performance:</b>
• Total Handle Settled  : <b>$2,786,199.00</b> (10,941 Tickets)
• Customer Payouts Won  : <b>+$1,491,130.00</b>
• Customer Wagers Lost  : <b>-$1,554,517.00</b>
• Net House Hold        : <b style="color: #ef4444;">-$63,467.00 (DEFICIT: -2.28%)</b>
• Agent 50% Shared Hold : <b>-$31,733.50 (Fronted by Master)</b>

🚨 <b>Top 5 Sub-Agent House Losses:</b>
1. <b>BIGDAD</b>    : -$40,000.00 (BGD101 cashed 2 max wagers)
2. <b>GPRO50RSK</b> : -$29,303.00 (GP300 steam win +$33.9k)
3. <b>ATEAM</b>     : -$27,434.00 (AT10359 syndicate win +$19.0k)
4. <b>FAKEMONEY</b> : -$25,000.00 (RF2003 whale swing)
5. <b>DAN318</b>    : -$12,382.00 (DAN245 won +$14.0k)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
    return {
      reportType: type,
      title: "Evening Settlement Recap",
      contentHtml: html.trim(),
      generatedAt: nowStr,
      targetMiniappTab: "deciles",
    };
  }

  public async dispatchReportNow(
    type: ReportType,
    chatId?: string,
  ): Promise<boolean> {
    if (type === "BRIDGE_ROLLUP_DIGEST") {
      // Manual dispatch sends what the last scheduled cycle saw; it must not run a fresh cycle
      // inside an HTTP request (the rollups can take minutes). The cron branch runs the cycle.
      const rep = this.generateReport(type);
      const res = await this.telegramService.sendMessage(
        chatId || "",
        rep.contentHtml,
        { parse_mode: "HTML" },
      );
      return res.ok;
    }
    if (type === "TEN_MINUTE_POSITIONS_PULSE") {
      const summary = await runLivePositionsPulse({
        schedule: "*/10 * * * *",
        ...(chatId ? { chatIdOverride: chatId } : {}),
      });
      return summary.telegramDelivery.ok;
    }
    const rep = this.generateReport(type);
    console.log(
      `[Reporting Scheduler] Dispatching ${rep.title} to Telegram...`,
    );
    const res = await this.telegramService.sendMessage(
      chatId || "",
      rep.contentHtml,
      {
        parse_mode: "HTML",
      },
    );
    return res.ok;
  }

  /**
   * Run the bridge cycle (optionally a subset of jobs) and send its change digest. The quiet form
   * keeps a 15-minute schedule from paging when nothing moved.
   */
  public async dispatchBridgeDigest(
    jobs?: readonly BridgeRollupJobId[],
    chatId?: string,
  ): Promise<boolean> {
    const result = await bridgeCycleRunner(jobs);
    const res = await this.telegramService.sendMessage(
      chatId || "",
      formatBridgeDigestHtml(result, { quiet: true }),
      { parse_mode: "HTML" },
    );
    console.log(
      `[Reporting Scheduler] Bridge digest ${result.updatedAt}: ${result.alerts.length} alert(s), ` +
        `jobs=${result.jobs.map((job) => `${job.id}:${job.ok ? "ok" : "fail"}`).join(",")} delivery=${res.ok}`,
    );
    return res.ok;
  }
}

/** Indirection so tests can drive the scheduler without spawning the four CLIs. */
let bridgeCycleRunner: (
  jobs?: readonly BridgeRollupJobId[],
) => Promise<BridgeRollupCycleResult> = (jobs) =>
  runBridgeRollupCycle(jobs === undefined ? {} : { jobs });

/** Replace the cycle runner; tests only. */
export function setBridgeCycleRunner(
  runner: (
    jobs?: readonly BridgeRollupJobId[],
  ) => Promise<BridgeRollupCycleResult>,
): void {
  bridgeCycleRunner = runner;
}

/** Scheduled reports plus inbound commands; polls only when no webhook is registered. */
export async function startBotDaemon(): Promise<void> {
  const bot = new SportsDeskTelegramService();
  const scheduler = new ReportingSchedulerService(bot);
  // Bridge rollups are owned by the webview daemon (it is the long-lived process); starting them
  // here too would publish twice and send duplicate digests.
  const stopSchedules = scheduler.start({ exclude: BRIDGE_SCHEDULE_IDS });
  const shutdown = () => {
    stopSchedules();
    bot.stopPolling();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const status = await bot.getStatus();
  console.log(`[Telegram] ${status.mode}: ${status.modeReason}`);
  if (status.error) console.error(`[Telegram] ${status.error}`);
  if (status.webhook?.url) {
    console.log(
      `[Telegram] Webhook set to ${status.webhook.url}; updates arrive at the webview server, not here.`,
    );
    return;
  }
  if (status.tokenConfigured) await bot.startPolling();
}

if (import.meta.main) {
  await startBotDaemon();
}
