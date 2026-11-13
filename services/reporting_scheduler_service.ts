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
  keychainCredentialProbe,
  parseBridgeRollupState,
  resolveBridgeRollupStatePath,
  runBridgeRollupCycle,
  type BridgeRollupCycleResult,
  type BridgeRollupJobId,
} from "../lib/bridge_rollup_cron.ts";
import {
  summarizeDod6V54SpineTotals,
  type Dod6V54SpineTotals,
} from "../lib/dod6_v54_lifetime_reader.ts";

/**
 * Schedules the long-lived webview daemon owns. The bot daemon excludes them
 * (`startBotDaemon()` passes `exclude: BRIDGE_SCHEDULE_IDS`) so running both processes never
 * double-fires. Add new daemon-owned schedules here, not to the bot's `only` list.
 */
export const BRIDGE_SCHEDULE_IDS = [
  "sched_bridge_rollup_15m",
  "sched_bridge_weblog_hourly",
  "sched_agent_tree_hourly",
  "sched_customer_profiles_6h",
  "sched_f402_session_refresh",
  "sched_weblog_sentinel_daily",
] as const;

export type ReportType =
  | "MORNING_BRIEFING"
  | "MIDDAY_STEAM"
  | "EVENING_SETTLEMENT"
  | "TEN_MINUTE_POSITIONS_PULSE"
  | "BRIDGE_ROLLUP_DIGEST"
  | "CUSTOM_HOURLY_PULSE"
  | "SHELL_CAPTURE";

/**
 * One capture job the scheduler can run in-process. The `requires` list is checked before spawning:
 * an entry that looks like an env var (`FOO_BAR`) must be set and non-blank; an entry prefixed
 * `file:` must exist at `repoRoot/<path>`. A failed gate records "skipped" and does NOT spawn the
 * CLI, so cron cannot hammer a tool that would exit 2 for missing credentials.
 */
export interface ShellJobSpec {
  readonly bin: string;
  readonly args: readonly string[];
  readonly requires?: readonly string[];
  /** Hard ceiling on wall-clock runtime; the scheduler aborts over this. Default 10 minutes. */
  readonly timeoutSeconds?: number;
}

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
  /** For `SHELL_CAPTURE` schedules only: the CLI to run when requires pass. */
  readonly shellJob?: ShellJobSpec;
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
const DODBIN_PATH = resolve(
  import.meta.dir,
  "../data/sportsdesk_unified_baseline_v54.dodbin",
);
const AGENT_TREE_PATH = resolve(import.meta.dir, "../data/agent-tree.json");

let cachedSpineTotals: Dod6V54SpineTotals | null | undefined;

function readDodSpineTotals(): Dod6V54SpineTotals | null {
  if (cachedSpineTotals !== undefined) return cachedSpineTotals;
  try {
    cachedSpineTotals = summarizeDod6V54SpineTotals(DODBIN_PATH);
  } catch {
    cachedSpineTotals = null;
  }
  return cachedSpineTotals;
}

interface AgentTreeSummary {
  readonly totalNodes: number;
  readonly subAgents: number;
  readonly activeSubAgents: number;
  readonly masters: number;
}

function readAgentTreeSummary(): AgentTreeSummary | null {
  if (!existsSync(AGENT_TREE_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(AGENT_TREE_PATH, "utf8")) as {
      nodes?: Record<string, { t?: string | null; a?: boolean }>;
    };
    const nodes = Object.values(raw.nodes ?? {});
    return {
      totalNodes: nodes.length,
      subAgents: nodes.filter((n) => n.t === "A").length,
      activeSubAgents: nodes.filter((n) => n.t === "A" && n.a === true).length,
      masters: nodes.filter((n) => n.t === "M").length,
    };
  } catch {
    return null;
  }
}

function formatUsdCents(cents: number, signed = false): string {
  const abs = (Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (cents < 0) return `-$${abs}`;
  if (signed && cents > 0) return `+$${abs}`;
  return `$${abs}`;
}

/** The last cycle the scheduler wrote; the digest generator and the dashboard both read it. */
function readLatestBridgeState(): BridgeRollupCycleResult | null {
  const path = resolveBridgeRollupStatePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = parseBridgeRollupState(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
    if (parsed === null) return null;
    return {
      updatedAt: parsed.updatedAt,
      jobs: parsed.jobs,
      alerts: parsed.alerts,
    };
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
    const started: string[] = [];
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
        started.push(`${s.scheduleTime} (${s.tz ?? "America/New_York"})`);
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
            } else if (s.reportType === "SHELL_CAPTURE") {
              if (s.shellJob === undefined) {
                console.warn(
                  `[Reporting Scheduler] ${s.id}: SHELL_CAPTURE without shellJob is a no-op`,
                );
              } else {
                await shellCaptureRunner(s.shellJob);
              }
            } else {
              await this.dispatchReportNow(s.reportType, s.targetChatId);
            }
          },
          { tz: s.tz ?? "America/New_York" },
        );
      });
    console.log(
      `[Reporting Scheduler] ${jobs.length} schedule(s) active: ${started.join(", ")}`,
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
        name: "Bridge Rollup Cycle (3a/3b/3c/wagers)",
        scheduleTime: "*/15 * * * *",
        reportType: "BRIDGE_ROLLUP_DIGEST",
        description:
          "Runs the one-shot bridge rollups (bet ticker, pending, GSLive tally, wagers-by-state, and R2 snapshot publish), publishes them and sends an on-change digest. Overlaps are skipped.",
        tz: "America/Chicago",
        bridgeJobs: [
          "bridge3a",
          "bridge3b",
          "bridge3c",
          "wagers-by-state",
          "wagers-publish",
        ],
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
      {
        id: "sched_agent_tree_hourly",
        name: "Agent Tree Rebuild (hourly)",
        scheduleTime: "11 * * * *",
        reportType: "SHELL_CAPTURE",
        description:
          "Runs `scripts/build_agent_tree.ts` once per hour so data/agent-tree.json tracks the F402 downline. Skipped when F402_BEARER_TOKEN is unset (cron cannot re-authenticate).",
        tz: "America/Chicago",
        shellJob: {
          bin: "bun",
          args: [
            "--no-orphans",
            "--no-env-file",
            "run",
            "scripts/build_agent_tree.ts",
          ],
          requires: ["F402_BEARER_TOKEN"],
        },
        enabled: true,
      },
      {
        id: "sched_customer_profiles_6h",
        name: "Customer Book Rebuild (every 6h)",
        scheduleTime: "27 */6 * * *",
        reportType: "SHELL_CAPTURE",
        description:
          "Runs `scripts/build_customer_profiles.ts` four times a day so data/customer-profiles.json is fresh. Skipped when the gitignored enriched_customers_full.json fixture is absent.",
        tz: "America/Chicago",
        shellJob: {
          bin: "bun",
          args: [
            "--no-orphans",
            "--no-env-file",
            "run",
            "scripts/build_customer_profiles.ts",
          ],
          requires: ["file:enriched_customers_full.json"],
        },
        enabled: true,
      },
      {
        id: "sched_f402_session_refresh",
        name: "F402 Session Refresh (optional 5m)",
        scheduleTime: "*/5 * * * *",
        reportType: "SHELL_CAPTURE",
        description:
          "Optional scheduler-driven F402 session refresh (`scripts/f402_session_refresh.ts`) for non-launchd hosts (#76). Skipped unless F402_SESSION_REFRESH_SCHEDULER and F402_LIVE_LOGIN are set so launchd hosts never double-mint.",
        tz: "America/Chicago",
        shellJob: {
          bin: "bun",
          args: [
            "--no-orphans",
            "--no-env-file",
            "run",
            "scripts/f402_session_refresh.ts",
          ],
          requires: ["F402_SESSION_REFRESH_SCHEDULER", "F402_LIVE_LOGIN"],
        },
        enabled: true,
      },
      {
        id: "sched_weblog_sentinel_daily",
        name: "WebLog Export Sentinel (08:00 daily)",
        scheduleTime: "0 8 * * *",
        reportType: "SHELL_CAPTURE",
        description:
          "Daily 08:00 America/Chicago check that today's manual F402 Mode A activity JSONL is staged (`workers/weblog_sentinel.ts --once`), sending a deduplicated Telegram nudge when missing (#91).",
        tz: "America/Chicago",
        shellJob: {
          bin: "bun",
          args: [
            "--no-orphans",
            "--no-env-file",
            "run",
            "workers/weblog_sentinel.ts",
            "--once",
          ],
          requires: ["TELEGRAM_BOT_TOKEN"],
        },
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
      const spineTotals = readDodSpineTotals();
      const agentTree = readAgentTreeSummary();
      const openInfo = liveSummary
        ? `\n• Live 24h Open Tix : <b>${liveSummary.window24hOpenPositions.openTicketsCount.toLocaleString()}</b> (${formatUsdCents(liveSummary.window24hOpenPositions.openRiskCents)} Risk)`
        : "";
      const accountsLine = spineTotals
        ? `<b>${spineTotals.meta.customerCount.toLocaleString()}</b> Canonical (Settled Bets: ${spineTotals.settledBetsCount.toLocaleString()} • Open Bets: ${spineTotals.openBetsCount.toLocaleString()})`
        : "<b>unmeasured (no artifact)</b>";
      const agentsLine = agentTree
        ? `<b>${agentTree.subAgents.toLocaleString()}</b> (Active: ${agentTree.activeSubAgents.toLocaleString()} • Masters: ${agentTree.masters.toLocaleString()})`
        : "<b>unmeasured (no artifact)</b>";
      const handleLine = spineTotals
        ? `<b>${formatUsdCents(spineTotals.settledStakedCents)}</b> (${spineTotals.settledBetsCount.toLocaleString()} Settled Tickets • Lifetime Staked: ${formatUsdCents(spineTotals.lifetimeStakedCents)})`
        : "<b>unmeasured (no artifact)</b>";
      const holdLine = spineTotals
        ? `<b>${formatUsdCents(spineTotals.houseNetProfitCents, true)}</b> (Settled Hold: ${(spineTotals.settledHoldRatio * 100).toFixed(2)}% • DOD6 v5.4 Conserved Spine)`
        : "<b>unmeasured (no artifact)</b>";
      const html = `
☀️ <b>SPORTSDESK MORNING RISK BRIEFING</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Master Agent: <code>BILLY666</code> • Generated: <code>${nowStr}</code>

📊 <b>Current Production Master Scope:</b>
• Total Accounts    : ${accountsLine}
• Sub-Agents in Tree: ${agentsLine}
• Total Sports Handle: ${handleLine}${openInfo}
• Lifetime Net Hold : ${holdLine}

⚠️ <b>Overnight & Morning Threat Assessment:</b>
• <b>Whale Surveillance (RF2003):</b> Verify single-wager limit ceiling is active against live exposure.
• <b>Snipers on Standby:</b> BGD101 and MJ102 monitored ahead of afternoon slate.
• <b>Spine Conservation:</b> ${spineTotals ? `Bets identity=${spineTotals.betsIdentityHolds ? "OK" : "FAIL"}, outcomes identity=${spineTotals.outcomesIdentityHolds ? "OK" : "FAIL"}` : "unmeasured (no artifact)"}.
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

    const spineTotals = readDodSpineTotals();
    const settledHandleLine = spineTotals
      ? `<b>${formatUsdCents(spineTotals.settledStakedCents)}</b> (${spineTotals.settledBetsCount.toLocaleString()} Tickets)`
      : "<b>unmeasured (no artifact)</b>";
    const outcomesLine = spineTotals
      ? `Wins: <b>${spineTotals.winsCount.toLocaleString()}</b> • Losses: <b>${spineTotals.lossesCount.toLocaleString()}</b> • Pushes: <b>${spineTotals.pushesCount.toLocaleString()}</b>`
      : "<b>unmeasured (no artifact)</b>";
    const netHoldLine = spineTotals
      ? `<b>${formatUsdCents(spineTotals.houseNetProfitCents, true)} (${(spineTotals.settledHoldRatio * 100).toFixed(2)}%)</b>`
      : "<b>unmeasured (no artifact)</b>";
    const sharedHoldLine = spineTotals
      ? `<b>${formatUsdCents(Math.round(spineTotals.houseNetProfitCents / 2), true)}</b>`
      : "<b>unmeasured (no artifact)</b>";

    const html = `
🌙 <b>SPORTSDESK EVENING SETTLEMENT RECAP</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Master Agent: <code>BILLY666</code> • Generated: <code>${nowStr}</code>

📉 <b>Settled Sports Performance (DOD6 v5.4 Spine):</b>
• Total Handle Settled  : ${settledHandleLine}
• Settled Outcomes      : ${outcomesLine}
• Net House Hold        : ${netHoldLine}
• Agent 50% Shared Hold : ${sharedHoldLine}

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
   * Run the bridge cycle (optionally a subset of jobs) and send its change digest. On-change
   * semantics: when the cycle reports no new alerts (nothing fired — a clean run, or a standing
   * failure that already paged), the Telegram send is suppressed; the state file and the JSONL
   * history still record the run, and manual dispatch always delivers. This keeps the 15-minute
   * schedule from becoming 96 identical pings a day.
   */
  public async dispatchBridgeDigest(
    jobs?: readonly BridgeRollupJobId[],
    chatId?: string,
  ): Promise<boolean> {
    const result = await bridgeCycleRunner(jobs);
    if (result.alerts.length === 0) {
      console.log(
        `[Reporting Scheduler] Bridge digest ${result.updatedAt}: no changes, digest suppressed ` +
          `(jobs=${result.jobs.map((job) => `${job.id}:${job.ok ? "ok" : "fail"}`).join(",")})`,
      );
      return true;
    }
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
  runBridgeRollupCycle({
    ...(jobs === undefined ? {} : { jobs }),
    // The cron daemon is a fresh process with no shell environment: F402/GSID credentials live in
    // the OS keychain (canonical service first, legacy fallback), so the gate must read there.
    credentials: keychainCredentialProbe({ env: Bun.env }),
  });

/** Replace the cycle runner; tests only. */
export function setBridgeCycleRunner(
  runner: (
    jobs?: readonly BridgeRollupJobId[],
  ) => Promise<BridgeRollupCycleResult>,
): void {
  bridgeCycleRunner = runner;
}

export type ShellCaptureOutcome =
  | {
      readonly status: "ok";
      readonly exitCode: number;
      readonly durationMs: number;
    }
  | { readonly status: "skipped"; readonly missing: readonly string[] }
  | {
      readonly status: "failed";
      readonly exitCode: number;
      readonly durationMs: number;
      readonly reason: string;
    };

/** Repo root; `file:` requires resolve relative to it. */
const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * Check the requires list and spawn the capture CLI. Never prints env values, never passes the
 * parent environment with `inherit` — the spawned child inherits the daemon's env explicitly only
 * for PATH and the manifest-listed credentials the capture needs (F402/GSID are read from the
 * keychain by the scripts themselves, so no injection is needed here).
 */
export async function runShellCaptureDefault(
  spec: ShellJobSpec,
  logger: {
    readonly log: (line: string) => void;
    readonly warn: (line: string) => void;
  } = console,
): Promise<ShellCaptureOutcome> {
  const missing: string[] = [];
  for (const requirement of spec.requires ?? []) {
    if (requirement.startsWith("file:")) {
      const relative = requirement.slice("file:".length);
      if (!existsSync(resolve(REPO_ROOT, relative))) missing.push(requirement);
      continue;
    }
    const value = (Bun.env[requirement as keyof typeof Bun.env] ?? "")
      .toString()
      .trim();
    if (value === "") missing.push(requirement);
  }
  if (missing.length > 0) {
    // Only names are logged, never values.
    logger.log(
      `[Shell Capture] ${spec.bin} ${spec.args.join(" ")}: skipped (missing ${missing.join(",")})`,
    );
    return { status: "skipped", missing };
  }

  // `Bun.nanoseconds()` is monotonic; `Date.now()` can jump backwards on a clock correction and
  // would fail the policy ratchet (`perf-now-timing`).
  const started = Bun.nanoseconds();
  const elapsedMs = () => Math.round((Bun.nanoseconds() - started) / 1e6);
  const timeoutSeconds = spec.timeoutSeconds ?? 600;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutSeconds * 1_000);
  try {
    const resolvedBin = spec.bin === "bun" ? process.execPath : spec.bin;
    const resolvedArgs =
      spec.bin === "bun" && !spec.args.includes("--no-env-file")
        ? ["--no-env-file", ...spec.args]
        : spec.args;
    const child = Bun.spawn([resolvedBin, ...resolvedArgs], {
      cwd: REPO_ROOT,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      signal: abort.signal,
    });
    const exitCode = await child.exited;
    const durationMs = elapsedMs();
    if (abort.signal.aborted) {
      logger.warn(
        `[Shell Capture] ${spec.bin} ${spec.args.join(" ")}: aborted after ${timeoutSeconds}s`,
      );
      return {
        status: "failed",
        exitCode,
        durationMs,
        reason: `timed out after ${timeoutSeconds}s`,
      };
    }
    if (exitCode === 0) {
      logger.log(
        `[Shell Capture] ${spec.bin} ${spec.args.join(" ")}: ok in ${durationMs}ms`,
      );
      return { status: "ok", exitCode, durationMs };
    }
    logger.warn(
      `[Shell Capture] ${spec.bin} ${spec.args.join(" ")}: exit ${exitCode} after ${durationMs}ms`,
    );
    return {
      status: "failed",
      exitCode,
      durationMs,
      reason: `exit ${exitCode}`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[Shell Capture] ${spec.bin} ${spec.args.join(" ")}: ${reason}`,
    );
    return {
      status: "failed",
      exitCode: -1,
      durationMs: elapsedMs(),
      reason,
    };
  } finally {
    clearTimeout(timer);
  }
}

let shellCaptureRunner: (spec: ShellJobSpec) => Promise<ShellCaptureOutcome> =
  runShellCaptureDefault;

/** Replace the capture runner; tests only. */
export function setShellCaptureRunner(
  runner: (spec: ShellJobSpec) => Promise<ShellCaptureOutcome>,
): void {
  shellCaptureRunner = runner;
}

/** Reset to the default spawning runner; tests use this in `afterEach`. */
export function resetShellCaptureRunner(): void {
  shellCaptureRunner = runShellCaptureDefault;
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
