#!/usr/bin/env bun
/**
 * @file reporting_scheduler_service.ts
 * @description Dedicated Scheduled Reporting Engine for SportsDesk & Fantasy402 (Bun v1.4+).
 *
 * Implements:
 *  1. Automated Cron/Interval Schedules for SportsDesk Master Book (Master: BILLY666):
 *     - Morning Risk Briefing (08:00 EDT): Overnight open exposure, whale watch (RF2003), sniper alerts.
 *     - Midday Steam & Volatility Pulse (13:00 EDT): Line moves, active steam originators (GP300, AT10359).
 *     - Evening Settlement Recap (23:00 EDT): Daily settled handle ($2.79M), net hold (-$63.5k), agent 50% shares.
 *  2. Report Generators with Markdown/HTML formatting and Telegram WebApp deep links.
 *  3. Cron Runner with native Bun interval monitoring, trigger history, and on-demand dispatch.
 */

import { startInProcessCron } from "../lib/bun_cron.ts";
import { SportsDeskTelegramService } from "./sportsdesk_telegram_bot.ts";

export type ReportType =
  | "MORNING_BRIEFING"
  | "MIDDAY_STEAM"
  | "EVENING_SETTLEMENT"
  | "CUSTOM_HOURLY_PULSE";

export interface ScheduleDefinition {
  readonly id: string;
  readonly name: string;
  readonly scheduleTime: string; // e.g. "08:00", "13:00", "23:00"
  readonly reportType: ReportType;
  readonly description: string;
  readonly targetChatId?: string;
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

export class ReportingSchedulerService {
  private readonly telegramService: SportsDeskTelegramService;
  private readonly schedules: Map<string, ScheduleDefinition> = new Map();
  private timer: any = null;

  constructor(telegramService?: SportsDeskTelegramService) {
    this.telegramService = telegramService || new SportsDeskTelegramService();
    this.telegramService.setReportGenerator((type) =>
      this.generateReport(type),
    );
    this.initDefaultSchedules();
  }

  /** Fires each enabled schedule at its `HH:MM` in America/New_York; returns a stop function. */
  public start(): () => void {
    const jobs = this.getSchedules()
      .filter((s) => s.enabled)
      .map((s) => {
        const [hour, minute] = s.scheduleTime.split(":").map(Number);
        return startInProcessCron(
          `${minute} ${hour} * * *`,
          async () => {
            s.lastTriggeredAt = new Date().toISOString();
            await this.dispatchReportNow(s.reportType, s.targetChatId);
          },
          { tz: "America/New_York" },
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

  private initDefaultSchedules(): void {
    const defaultList: ScheduleDefinition[] = [
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
          "Settled volume ($2.79M), customer payout/loss, net book hold (-$63.5k), and agent 50% liability shares.",
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

    if (type === "MORNING_BRIEFING") {
      const html = `
☀️ <b>SPORTSDESK MORNING RISK BRIEFING</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Master Agent: <code>BILLY666</code> • Generated: <code>${nowStr}</code>

📊 <b>Current Production Master Scope:</b>
• Total Accounts    : <b>9,435</b> (Active: 2,236 • Dormant: 7,191)
• Sub-Agents in Tree: <b>668</b> (Active Sports: 460)
• Total Sports Handle: <b>$2,786,199.00</b> (10,941 Settled Tickets)
• Lifetime Net Hold : <b>+$10,487,926.00</b> (Agent 50%: <b>+$5,243,963.00</b>)

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
}

/** Scheduled reports plus inbound commands; polls only when no webhook is registered. */
export async function startBotDaemon(): Promise<void> {
  const bot = new SportsDeskTelegramService();
  const scheduler = new ReportingSchedulerService(bot);
  const stopSchedules = scheduler.start();
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
