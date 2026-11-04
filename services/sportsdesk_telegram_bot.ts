#!/usr/bin/env bun
/**
 * @file sportsdesk_telegram_bot.ts
 * @description Telegram Bot & Mini App Integration with Real-Time Watch List Alerts & Scheduled Reporting (Bun v1.4+).
 *
 * Capabilities:
 *  1. Telegram Bot API Client with dual-mode execution (Live Bot API & Offline Simulation).
 *  2. Real-Time Watch List Alert Engine: triggers immediate high-priority alerts when monitored
 *     sharp accounts (RF2003, BGD101, GP300, AT10359, ABC700, etc.) or high-stake wagers hit the book.
 *  3. Telegram Mini App (TMA) Extension: attaches inline WebApp buttons to launch the live
 *     interactive dashboard directly within Telegram, with query-parameter deep linking.
 *  4. Scheduled Reporting Engine: automated cron/interval reporting for Morning Risk Briefing,
 *     Midday Steam Pulse, and Evening Settlement Recaps.
 *  5. Interactive Chat Commands: /start, /miniapp, /report, /forensics, /watchlist, /check <ID>, /alert_test.
 */

import crypto from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface WatchListAccount {
  readonly customerId: string;
  readonly agentId: string;
  readonly masterAgentId: string;
  readonly archetype: string;
  readonly recentNetUSD: number;
  readonly lifetimeNetUSD: number;
  readonly sportsHandleUSD: number;
  readonly ticketsCount: number;
  readonly riskTier:
    | "CRITICAL_WHALE"
    | "EXECUTION_SNIPER"
    | "STEAM_CHASER"
    | "CHRONIC_SHARP"
    | "HIT_AND_RUN_DORMANT";
  readonly recommendedAction: string;
}

export interface WagerAlertPayload {
  readonly customerId: string;
  readonly agentId: string;
  readonly masterAgentId: string;
  readonly wagerNumber: number;
  readonly riskUSD: number;
  readonly toWinUSD: number;
  readonly odds: string;
  readonly marketDescription: string;
  readonly wagerType: string;
  readonly acceptedAt: string;
  readonly watchAccount?: WatchListAccount;
}

export interface TelegramInlineKeyboardButton {
  readonly text: string;
  readonly url?: string;
  readonly callback_data?: string;
  readonly web_app?: { readonly url: string };
}
export interface TelegramSendMessageOptions {
  readonly parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
  readonly disable_web_page_preview?: boolean;
  readonly reply_markup?: {
    readonly inline_keyboard?: readonly (readonly TelegramInlineKeyboardButton[])[];
  };
}

export interface ScheduledReportTask {
  readonly id: string;
  readonly name: string;
  readonly cronExpression: string; // e.g. "08:00", "13:00", "23:00", "*/10 * * * *"
  readonly reportType:
    | "MORNING_BRIEFING"
    | "MIDDAY_STEAM"
    | "EVENING_SETTLEMENT"
    | "TEN_MINUTE_POSITIONS_PULSE"
    | "BRIDGE_ROLLUP_DIGEST";
  readonly description: string;
}

export const REPORT_TYPES = [
  "MORNING_BRIEFING",
  "MIDDAY_STEAM",
  "EVENING_SETTLEMENT",
  "TEN_MINUTE_POSITIONS_PULSE",
  "BRIDGE_ROLLUP_DIGEST",
] as const satisfies readonly ScheduledReportTask["reportType"][];

export type ReportGenerator = (type: ScheduledReportTask["reportType"]) => {
  readonly contentHtml: string;
};

interface TelegramApiResult<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
  readonly error_code?: number;
}

interface TelegramChat {
  readonly id: number;
  readonly type: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly message_id: number;
    readonly chat: TelegramChat;
    readonly text?: string;
  };
  readonly callback_query?: {
    readonly id: string;
    readonly data?: string;
    readonly from: { readonly id: number; readonly username?: string };
    readonly message?: { readonly chat: TelegramChat };
  };
}

export interface TelegramBotStatus {
  readonly tokenConfigured: boolean;
  readonly bot: { readonly username: string } | null;
  readonly defaultChatConfigured: boolean;
  readonly mode: "live" | "simulation";
  readonly modeReason: string;
  readonly authorizedChatCount: number;
  readonly inbound: "webhook" | "polling" | "none";
  readonly webhook: {
    readonly url: string;
    readonly configuredUrl: string;
    readonly secretConfigured: boolean;
    readonly pendingUpdates: number;
    readonly lastError: string | null;
  } | null;
  readonly error: string | null;
}

export interface TelegramActivityEntry {
  readonly at: string;
  readonly direction: "in" | "out";
  readonly chatId: string;
  readonly summary: string;
  readonly outcome:
    "sent" | "simulated" | "failed" | "received" | "unauthorized";
  readonly detail?: string;
}

const ACTIVITY_MAX_BYTES = 512 * 1024;
const ACTIVITY_KEEP_LINES = 1_000;

function plainPreview(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/━+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export class SportsDeskTelegramService {
  private readonly botToken: string;
  private readonly defaultChatId: string;
  private readonly miniappBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly isLiveMode: boolean;
  private readonly authorizedChatIds: ReadonlySet<string>;
  private readonly webhookUrl: string;
  private readonly webhookSecret: string;
  private readonly watchListMap: Map<string, WatchListAccount> = new Map();
  private readonly scheduledReports: ScheduledReportTask[] = [];
  private readonly fetchSession: Bun.FetchSession;
  private reportGenerator: ReportGenerator | null = null;
  private pollingAbort: AbortController | null = null;
  private readonly activityLogPath: string | null;

  /**
   * `activityLogPath` is shared by the polling daemon and the web server (separate processes),
   * so the dashboard feed shows both; `null` disables it (the default under `bun test`).
   */
  constructor(options?: {
    botToken?: string;
    chatId?: string;
    miniappUrl?: string;
    apiBaseUrl?: string;
    activityLogPath?: string | null;
  }) {
    this.activityLogPath =
      options?.activityLogPath !== undefined
        ? options.activityLogPath
        : process.env.TELEGRAM_ACTIVITY_LOG ||
          (process.env.NODE_ENV === "test"
            ? null
            : resolve(import.meta.dir, "../reports/telegram-activity.jsonl"));
    this.apiBaseUrl = options?.apiBaseUrl ?? "https://api.telegram.org";
    this.botToken = options?.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
    this.defaultChatId = options?.chatId ?? process.env.TELEGRAM_CHAT_ID ?? "";
    this.miniappBaseUrl = (
      options?.miniappUrl ??
      process.env.TELEGRAM_MINIAPP_URL ??
      "http://localhost:4020"
    ).replace(/\/+$/, "");
    this.isLiveMode = Boolean(
      this.botToken &&
      this.botToken.trim().length > 0 &&
      this.defaultChatId.trim().length > 0,
    );
    this.authorizedChatIds = new Set(
      [
        this.defaultChatId,
        ...(process.env.TELEGRAM_ADMIN_CHAT_IDS ?? "").split(","),
      ]
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    );
    this.webhookUrl = process.env.TELEGRAM_WEBHOOK_URL ?? "";
    this.webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

    this.fetchSession = new Bun.FetchSession({
      tls: {
        rejectUnauthorized: true,
      },
    });

    if (this.isLiveMode && typeof fetch.preconnect === "function") {
      try {
        fetch.preconnect(this.apiBaseUrl);
      } catch {
        // Non-blocking preconnect failure
      }
    }

    this.initWatchListRegistry();
    this.initScheduleDefinitions();
  }

  private initWatchListRegistry(): void {
    // 1. Whale
    this.watchListMap.set("RF2003", {
      customerId: "RF2003",
      agentId: "FAKEMONEY",
      masterAgentId: "BILLY666",
      archetype: "Whale Volatility Concentration",
      recentNetUSD: 25000.0,
      lifetimeNetUSD: -1006530.0,
      sportsHandleUSD: 940000.0,
      ticketsCount: 47,
      riskTier: "CRITICAL_WHALE",
      recommendedAction:
        "Cap max single bet to $5,000.00 / require split approvals",
    });

    // 2. Execution Snipers
    const snipers = [
      {
        id: "BGD101",
        agent: "BIGDAD",
        won: 40000.0,
        handle: 40000.0,
        tix: 2,
        lt: -177400.0,
      },
      {
        id: "MJ102",
        agent: "MJ2026",
        won: 30000.0,
        handle: 20000.0,
        tix: 1,
        lt: 24000.0,
      },
      {
        id: "GX195",
        agent: "GOLD22",
        won: 10000.0,
        handle: 10000.0,
        tix: 1,
        lt: 4403.0,
      },
      {
        id: "PEY101",
        agent: "MACHR",
        won: 10000.0,
        handle: 10000.0,
        tix: 1,
        lt: -102666.0,
      },
      {
        id: "MJ101",
        agent: "MJ2026",
        won: 10000.0,
        handle: 10000.0,
        tix: 1,
        lt: -77115.0,
      },
      {
        id: "TEX500",
        agent: "TEXANS",
        won: 8000.0,
        handle: 8000.0,
        tix: 2,
        lt: -7860.0,
      },
      {
        id: "AL1279",
        agent: "AA2300C",
        won: 6600.0,
        handle: 6000.0,
        tix: 2,
        lt: -125484.0,
      },
      {
        id: "BB5127",
        agent: "ATEAM",
        won: 5000.0,
        handle: 15000.0,
        tix: 3,
        lt: -1750.0,
      },
      {
        id: "19902",
        agent: "RALPHAH",
        won: 5000.0,
        handle: 5000.0,
        tix: 1,
        lt: 30650.0,
      },
    ];
    for (const s of snipers) {
      this.watchListMap.set(s.id, {
        customerId: s.id,
        agentId: s.agent,
        masterAgentId: "BILLY666",
        archetype: "Execution Sniper (100% Win Rate)",
        recentNetUSD: s.won,
        lifetimeNetUSD: s.lt,
        sportsHandleUSD: s.handle,
        ticketsCount: s.tix,
        riskTier: "EXECUTION_SNIPER",
        recommendedAction: "Slash single-wager limit to $1,000.00 immediately",
      });
    }

    // 3. Steam Chasers & Originators
    const steam = [
      {
        id: "GP300",
        agent: "GPRO50RSK",
        won: 33858.0,
        handle: 46140.0,
        tix: 22,
        lt: -1519.0,
      },
      {
        id: "AT10359",
        agent: "ATEAM",
        won: 19024.0,
        handle: 26500.0,
        tix: 21,
        lt: 45525.0,
      },
      {
        id: "BCC1530",
        agent: "SPEN",
        won: 10514.0,
        handle: 19722.0,
        tix: 31,
        lt: 3401.0,
      },
      {
        id: "AT811",
        agent: "ATEAM",
        won: 3967.0,
        handle: 5990.0,
        tix: 30,
        lt: 7854.0,
      },
      {
        id: "AYM59007",
        agent: "AYMAN",
        won: 3001.0,
        handle: 8925.0,
        tix: 24,
        lt: 2130.0,
      },
    ];
    for (const st of steam) {
      this.watchListMap.set(st.id, {
        customerId: st.id,
        agentId: st.agent,
        masterAgentId: "BILLY666",
        archetype: "High-Frequency Steam / Line Chaser",
        recentNetUSD: st.won,
        lifetimeNetUSD: st.lt,
        sportsHandleUSD: st.handle,
        ticketsCount: st.tix,
        riskTier: "STEAM_CHASER",
        recommendedAction:
          "Apply 6-second dynamic delay gate & shade juice to -115",
      });
    }

    // 4. Chronic Lifetime Sharps
    const chronic = [
      {
        id: "ABC700",
        agent: "JUICEPLUS",
        won: -4000.0,
        handle: 42000.0,
        tix: 5,
        lt: 200050.0,
      },
      {
        id: "DAN245",
        agent: "DAN318",
        won: 14000.0,
        handle: 14000.0,
        tix: 7,
        lt: 16049.0,
      },
      {
        id: "LG237",
        agent: "ROBERTL",
        won: 2500.0,
        handle: 2500.0,
        tix: 1,
        lt: 38550.0,
      },
      {
        id: "MM1012",
        agent: "MOOSEM",
        won: 2000.0,
        handle: 2000.0,
        tix: 2,
        lt: 10659.0,
      },
      {
        id: "MM1023",
        agent: "MOOSEM",
        won: 1900.0,
        handle: 6000.0,
        tix: 3,
        lt: 14000.0,
      },
    ];
    for (const c of chronic) {
      this.watchListMap.set(c.id, {
        customerId: c.id,
        agentId: c.agent,
        masterAgentId: "BILLY666",
        archetype: "Chronic Lifetime Extractor Sharp",
        recentNetUSD: c.won,
        lifetimeNetUSD: c.lt,
        sportsHandleUSD: c.handle,
        ticketsCount: c.tix,
        riskTier: "CHRONIC_SHARP",
        recommendedAction:
          "Shift to +15c/+20c vig model (-120/-110) or restrict markets",
      });
    }

    // 5. Matched Polymarket CTF Parlay Wallets (Baylor Tout Cluster, Key-7 Teasers, Props & Cross-Sport)
    const polyParlayWallets = [
      {
        id: "0x3aF8c9104E2b78a142dE90B218a91D89D",
        agent: "CUB22HR",
        arch: "Polymarket Baylor Tout Burst (Lead Wallet #1)",
        won: 4850.0,
        handle: 4200.0,
        tix: 3,
        lt: 19400.0,
        tier: "EXECUTION_SNIPER" as const,
        action: "Auto-trim SGP limit & freeze Total 48 middle window",
      },
      {
        id: "0x7bE21d08F449C0213A8E100c9f2A41c12",
        agent: "CUB22HR",
        arch: "Polymarket Baylor Tout Burst (Syndicate #2)",
        won: 3200.0,
        handle: 3100.0,
        tix: 2,
        lt: 11200.0,
        tier: "STEAM_CHASER" as const,
        action: "Auto-trim SGP limit & freeze Total 48 middle window",
      },
      {
        id: "0x9cD44e12A8b7F30192c44d8E11a08B3e7",
        agent: "BILLY666",
        arch: "Polymarket Baylor Tout Burst (3rd Wallet Trigger)",
        won: 2950.0,
        handle: 2800.0,
        tix: 2,
        lt: 8900.0,
        tier: "STEAM_CHASER" as const,
        action: "Trigger DEDUP-then-LEAD burst lock (42.0m window)",
      },
      {
        id: "0x1fA98b34C7d2E60154a91B2c33d09F4a1",
        agent: "CUB22HR",
        arch: "Polymarket Baylor Tout Burst (Syndicate #4)",
        won: 2400.0,
        handle: 2500.0,
        tix: 2,
        lt: 6400.0,
        tier: "STEAM_CHASER" as const,
        action: "Apply 6-second dynamic delay gate & shade SGP +20c",
      },
      {
        id: "0x5eB67c89D1a4F20387b12C4d55e10A8c9",
        agent: "MAX92",
        arch: "Polymarket Baylor Tout Burst (Syndicate #5)",
        won: 2100.0,
        handle: 2200.0,
        tix: 2,
        lt: 5100.0,
        tier: "STEAM_CHASER" as const,
        action: "Apply 6-second dynamic delay gate & shade SGP +20c",
      },
      {
        id: "0x8dC12f45E6b9A10476c23D5e66f21B7d4",
        agent: "BILLY666",
        arch: "Polymarket Baylor Tout Burst (Syndicate #6)",
        won: 1850.0,
        handle: 1900.0,
        tix: 2,
        lt: 4300.0,
        tier: "STEAM_CHASER" as const,
        action: "Apply 6-second dynamic delay gate & shade SGP +20c",
      },
      {
        id: "0x4aE39d78F2c1B50891d34E6f77a32C6e0",
        agent: "CUB22HR",
        arch: "Polymarket Baylor Tout Burst (Syndicate #7)",
        won: 1650.0,
        handle: 1700.0,
        tix: 1,
        lt: 3800.0,
        tier: "STEAM_CHASER" as const,
        action: "Apply 6-second dynamic delay gate & shade SGP +20c",
      },
      {
        id: "0x2cB81a90D4e7F31265e45F7a88b43D9f2",
        agent: "BILLY666",
        arch: "Polymarket Key-7 Teaser / Middle Extractor",
        won: 6400.0,
        handle: 8500.0,
        tix: 8,
        lt: 34200.0,
        tier: "CRITICAL_WHALE" as const,
        action: "Block Key 3/7 crossings & reprice 6pt teaser to -135",
      },
      {
        id: "0x6fD92b01E5f8A42376f56A8b99c54E1a5",
        agent: "BILLY666",
        arch: "Polymarket Key-7 Teaser / Middle Extractor",
        won: 5100.0,
        handle: 7000.0,
        tix: 7,
        lt: 28900.0,
        tier: "CHRONIC_SHARP" as const,
        action: "Block Key 3/7 crossings & reprice 6pt teaser to -135",
      },
      {
        id: "0x0aE03c12F6a9B53487a67B9c00d65F2b8",
        agent: "ATEAM",
        arch: "Polymarket Key-7 Teaser / Middle Extractor",
        won: 3800.0,
        handle: 5500.0,
        tix: 6,
        lt: 19500.0,
        tier: "CHRONIC_SHARP" as const,
        action: "Block Key 3/7 crossings & reprice 6pt teaser to -135",
      },
      {
        id: "0x9bF14d23A7b0C64598b78C0d11e76A3c1",
        agent: "DAN318",
        arch: "Polymarket Key-7 Teaser / Middle Extractor",
        won: 2900.0,
        handle: 4000.0,
        tix: 4,
        lt: 14100.0,
        tier: "CHRONIC_SHARP" as const,
        action: "Block Key 3/7 crossings & reprice 6pt teaser to -135",
      },
      {
        id: "0x3dA25e34B8c1D75609c89D1e22f87B4d6",
        agent: "GPRO50RSK",
        arch: "Polymarket Prop Stack (Dak Pass Yds + TDs)",
        won: 2750.0,
        handle: 3500.0,
        tix: 3,
        lt: 12400.0,
        tier: "EXECUTION_SNIPER" as const,
        action: "Apply correlated SGP tax (+25c) on QB passing stacks",
      },
      {
        id: "0x7eB36f45C9d2E86710d90E2f33a98C5e9",
        agent: "GPRO50RSK",
        arch: "Polymarket Prop Stack (Dak Pass Yds + TDs)",
        won: 1950.0,
        handle: 2750.0,
        tix: 3,
        lt: 8600.0,
        tier: "EXECUTION_SNIPER" as const,
        action: "Apply correlated SGP tax (+25c) on QB passing stacks",
      },
      {
        id: "0x1cC47a56D0e3F97821e01F3a44b09D6f3",
        agent: "SPEN",
        arch: "Polymarket Prop Stack (Dak Pass Yds + TDs)",
        won: 1400.0,
        handle: 2000.0,
        tix: 2,
        lt: 5900.0,
        tier: "STEAM_CHASER" as const,
        action: "Apply correlated SGP tax (+25c) on QB passing stacks",
      },
      {
        id: "0x5fD58b67E1f4A08932f12A4b55c10E7a7",
        agent: "FAKEMONEY",
        arch: "Polymarket Cross-Sport CTF Arbitrage (NFL+NBA)",
        won: 3100.0,
        handle: 4500.0,
        tix: 4,
        lt: 16800.0,
        tier: "CHRONIC_SHARP" as const,
        action: "Monitor cross-market point-buy EV (>80 bps threshold)",
      },
    ];

    for (const pw of polyParlayWallets) {
      this.watchListMap.set(pw.id, {
        customerId: pw.id,
        agentId: pw.agent,
        masterAgentId: "BILLY666",
        archetype: pw.arch,
        recentNetUSD: pw.won,
        lifetimeNetUSD: pw.lt,
        sportsHandleUSD: pw.handle,
        ticketsCount: pw.tix,
        riskTier: pw.tier,
        recommendedAction: pw.action,
      });
    }

    // 6. On-Chain CTF Whale Wallets & Fixtures (from combo_logs.json & layoff_risk_cli.ts)
    const onChainCtfWhales = [
      {
        id: "0x3af8392189d021cfa82",
        agent: "CUB22HR",
        arch: "Polymarket Proxy Attribution (CB112_1 Key-7 Patriots)",
        won: 5400.0,
        handle: 6500.0,
        tix: 5,
        lt: 22100.0,
        tier: "EXECUTION_SNIPER" as const,
        action: "Bridge to CB112_1; block Key-7 layoff arbitrage",
      },
      {
        id: "0x3af8771189d099bf71",
        agent: "BILLY666",
        arch: "Polymarket Proxy Attribution (RF2003 Baylor Total 48)",
        won: 12400.0,
        handle: 18400.0,
        tix: 14,
        lt: 68500.0,
        tier: "CRITICAL_WHALE" as const,
        action: "Bridge to RF2003; auto-freeze Baylor Total 48 middle",
      },
      {
        id: "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
        agent: "BIGDAD",
        arch: "On-Chain CTF Whale #1 (64 Positions / CFB+NBA)",
        won: 16376.78,
        handle: 31290.02,
        tix: 68,
        lt: 84200.0,
        tier: "CRITICAL_WHALE" as const,
        action: "Cross-venue layoff alert; scale RFQ hedge 4x on BGD101",
      },
      {
        id: "0x07db5765beba17be154cbfbd6324a15f3c81fa4f",
        agent: "MJ2026",
        arch: "On-Chain CTF Whale #2 (37 Positions / NBA Key-3 SGP)",
        won: 11240.5,
        handle: 26435.66,
        tix: 37,
        lt: 61800.0,
        tier: "CRITICAL_WHALE" as const,
        action: "Bridge to MJ102/EJ8834; block NBA -2.5/-3.5 Key-3 middle",
      },
      {
        id: "0x120640a1deffe6b53e291eba74acf1dbe8274528",
        agent: "GPRO50RSK",
        arch: "On-Chain CTF Whale #3 (54 Positions / NBA Celtics Key-6)",
        won: 8920.0,
        handle: 18880.32,
        tix: 54,
        lt: 44500.0,
        tier: "STEAM_CHASER" as const,
        action: "Bridge to GP300; apply 6s delay & +20c NBA SGP tax",
      },
      {
        id: "0x53224176b413f20ac63d61f1a0e19002ffb38acb",
        agent: "ATEAM",
        arch: "On-Chain CTF Whale #4 (34 Positions / NBA Nuggets Total)",
        won: 6410.0,
        handle: 13098.64,
        tix: 35,
        lt: 31900.0,
        tier: "STEAM_CHASER" as const,
        action: "Bridge to AT10359; shade NBA totals +15c",
      },
      {
        id: "0x22e29a644a9d14564967b3f9f50346b7ad425c32",
        agent: "JUICEPLUS",
        arch: "On-Chain CTF Sharp #5 (32 Positions / NBA+CFB Parlays)",
        won: 5120.0,
        handle: 11201.98,
        tix: 32,
        lt: 27400.0,
        tier: "CHRONIC_SHARP" as const,
        action: "Bridge to ABC700/DA4401; restrict alternate lines",
      },
      {
        id: "0x231699490d08919d8f1d3f0b90fd2a677e3e9819",
        agent: "DAN318",
        arch: "On-Chain CTF Sharp #6 (9 Positions / High-Ticket CFB+NBA)",
        won: 4380.0,
        handle: 9153.19,
        tix: 9,
        lt: 21800.0,
        tier: "EXECUTION_SNIPER" as const,
        action: "Bridge to DAN245/FL3301; cap parlay max payout $5k",
      },
      {
        id: "0x50cc8708aff3791f2d6125645c82bda532baa534",
        agent: "MJ2026",
        arch: "On-Chain CTF Sniper #7 (4 Positions / $2k Avg NBA SGP)",
        won: 3950.0,
        handle: 8118.2,
        tix: 4,
        lt: 19200.0,
        tier: "EXECUTION_SNIPER" as const,
        action: "Slash single-wager limit to $1,000.00 immediately",
      },
      {
        id: "0xaa7789219c17e180dcb5933099c90d885f1d15a5",
        agent: "JUICEPLUS",
        arch: "On-Chain CTF Sniper #8 (Single $8.1k Whale Combo)",
        won: 4100.0,
        handle: 8107.34,
        tix: 2,
        lt: 16500.0,
        tier: "CRITICAL_WHALE" as const,
        action: "Require manual desk approval on all CTF combos >$2,500",
      },
      {
        id: "0x7a0da16a1205ee51a56fa862e8baa61e350eff14",
        agent: "SPEN",
        arch: "On-Chain CTF Chaser #9 (26 Positions / Multi-Sport)",
        won: 3290.0,
        handle: 7570.74,
        tix: 26,
        lt: 14800.0,
        tier: "STEAM_CHASER" as const,
        action: "Bridge to BCC1530/CM5510; enforce 6s dynamic delay",
      },
      {
        id: "0x1eb93479b3425ad57aef1442be4624a27880f884",
        agent: "SHARP66",
        arch: "On-Chain CTF Sharp #10 (16 Positions / NBA 1H/FG Arb)",
        won: 2150.0,
        handle: 4526.87,
        tix: 16,
        lt: 11400.0,
        tier: "CHRONIC_SHARP" as const,
        action: "Bridge to DN2019; monitor NBA period derivative arbs",
      },
    ];

    for (const cw of onChainCtfWhales) {
      this.watchListMap.set(cw.id, {
        customerId: cw.id,
        agentId: cw.agent,
        masterAgentId: "BILLY666",
        archetype: cw.arch,
        recentNetUSD: cw.won,
        lifetimeNetUSD: cw.lt,
        sportsHandleUSD: cw.handle,
        ticketsCount: cw.tix,
        riskTier: cw.tier,
        recommendedAction: cw.action,
      });
    }

    // 7. Discovered Internal /24 Subnet Cluster Partners & Unlisted High-CLV Sharps (from enriched_customers_full.json)
    const subnetClusterSharps = [
      {
        id: "EJ8834",
        agent: "MJ2026",
        arch: "Subnet 104.28.34.0/24 Twin (w/ MJ102) • Sharp 89.2",
        won: 15000.0,
        handle: 15000.0,
        tix: 4,
        lt: 48500.0,
        tier: "EXECUTION_SNIPER" as const,
      },
      {
        id: "DA4401",
        agent: "JUICEPLUS",
        arch: "High-CLV Extractor (+270 bps) • Sharp 87.1",
        won: 12000.0,
        handle: 15000.0,
        tix: 5,
        lt: 52400.0,
        tier: "CHRONIC_SHARP" as const,
      },
      {
        id: "BR7711",
        agent: "MACHR",
        arch: "Subnet 104.28.18.0/24 Twin (w/ PEY101) • Sharp 86.0",
        won: 10000.0,
        handle: 10000.0,
        tix: 2,
        lt: 31200.0,
        tier: "EXECUTION_SNIPER" as const,
      },
      {
        id: "CW9012",
        agent: "GOLD22",
        arch: "Subnet 104.28.22.0/24 Twin (w/ GX195) • Sharp 85.2",
        won: 10000.0,
        handle: 10000.0,
        tix: 2,
        lt: 29800.0,
        tier: "EXECUTION_SNIPER" as const,
      },
      {
        id: "DN2019",
        agent: "SHARP66",
        arch: "Multi-Sport NBA/CFB Sharp (+255 bps) • Sharp 84.8",
        won: 9000.0,
        handle: 12000.0,
        tix: 6,
        lt: 41000.0,
        tier: "CHRONIC_SHARP" as const,
      },
      {
        id: "HB7720",
        agent: "APEX99",
        arch: "Steam Originator (+245 bps) • Sharp 83.7",
        won: 5800.0,
        handle: 12000.0,
        tix: 8,
        lt: 24500.0,
        tier: "STEAM_CHASER" as const,
      },
      {
        id: "FL3301",
        agent: "DAN318",
        arch: "Subnet 104.28.38.0/24 Twin (w/ DAN245) • Sharp 82.4",
        won: 6000.0,
        handle: 10000.0,
        tix: 5,
        lt: 22900.0,
        tier: "CHRONIC_SHARP" as const,
      },
      {
        id: "AK1092",
        agent: "GPRO50RSK",
        arch: "GPRO50RSK Downline Steam Partner • Sharp 78.4",
        won: 14000.0,
        handle: 18000.0,
        tix: 11,
        lt: 36400.0,
        tier: "STEAM_CHASER" as const,
      },
      {
        id: "DF8821",
        agent: "TEXANS",
        arch: "Subnet 172.56.33.0/24 Twin (w/ TEX500) • Sharp 77.2",
        won: 7900.0,
        handle: 11000.0,
        tix: 6,
        lt: 19800.0,
        tier: "STEAM_CHASER" as const,
      },
      {
        id: "BL4402",
        agent: "ATEAM",
        arch: "ATEAM Syndicate Downline (+195 bps) • Sharp 76.5",
        won: 9200.0,
        handle: 14000.0,
        tix: 9,
        lt: 27100.0,
        tier: "STEAM_CHASER" as const,
      },
      {
        id: "CM5510",
        agent: "SPEN",
        arch: "SPEN Syndicate Downline (+180 bps) • Sharp 75.0",
        won: 6400.0,
        handle: 12000.0,
        tix: 8,
        lt: 18300.0,
        tier: "STEAM_CHASER" as const,
      },
      {
        id: "AC9901",
        agent: "ATEAM",
        arch: "ATEAM Late-Steam Chaser (+160 bps) • Sharp 72.1",
        won: 6200.0,
        handle: 8000.0,
        tix: 5,
        lt: 15400.0,
        tier: "STEAM_CHASER" as const,
      },
      {
        id: "CHURN_049",
        agent: "SOUTHSHORE",
        arch: "Cross-Branch Subnet 192.168.9.0/24 Bridge (w/ LAKERS)",
        won: -1100.0,
        handle: 8200.0,
        tix: 6,
        lt: 11200.0,
        tier: "HIT_AND_RUN_DORMANT" as const,
      },
      {
        id: "CHURN_059",
        agent: "LAKERS",
        arch: "Cross-Branch Subnet 192.168.9.0/24 Bridge (NBA 1H/1Q)",
        won: -1055.0,
        handle: 8082.0,
        tix: 7,
        lt: 14500.0,
        tier: "HIT_AND_RUN_DORMANT" as const,
      },
      {
        id: "CHURN_050",
        agent: "SHELBY101",
        arch: "Cross-Branch Subnet 192.168.0.0/24 Bridge (w/ KOBE24)",
        won: -980.0,
        handle: 6400.0,
        tix: 5,
        lt: 9800.0,
        tier: "HIT_AND_RUN_DORMANT" as const,
      },
      {
        id: "CHURN_060",
        agent: "KOBE24",
        arch: "Cross-Branch Subnet 192.168.0.0/24 Bridge (NBA Props)",
        won: -1091.0,
        handle: 6360.0,
        tix: 5,
        lt: 12100.0,
        tier: "HIT_AND_RUN_DORMANT" as const,
      },
    ];

    for (const sc of subnetClusterSharps) {
      this.watchListMap.set(sc.id, {
        customerId: sc.id,
        agentId: sc.agent,
        masterAgentId: "BILLY666",
        archetype: sc.arch,
        recentNetUSD: sc.won,
        lifetimeNetUSD: sc.lt,
        sportsHandleUSD: sc.handle,
        ticketsCount: sc.tix,
        riskTier: sc.tier,
        recommendedAction:
          sc.tier === "EXECUTION_SNIPER"
            ? "Link to /24 subnet twin; slash limit to $1,000 & enforce 6s delay"
            : sc.tier === "HIT_AND_RUN_DORMANT"
              ? "Audit cross-branch IP bridge (BEARD_BRIDGE); block shared device"
              : "Apply +15c/+20c vig shading & group into syndicate cluster exposure",
      });
    }
  }

  private initScheduleDefinitions(): void {
    this.scheduledReports.push(
      {
        id: "rep_morning_0800",
        name: "Morning Risk Briefing",
        cronExpression: "08:00 EDT",
        reportType: "MORNING_BRIEFING",
        description:
          "Overnight risk exposure, dormant re-activations, top 5 toxic branches, and daily game slate.",
      },
      {
        id: "rep_midday_1300",
        name: "Midday Steam & Volatility Pulse",
        cronExpression: "13:00 EDT",
        reportType: "MIDDAY_STEAM",
        description:
          "Line movement alerts, steam originations from GP300/AT10359, and in-play ticket velocity.",
      },
      {
        id: "rep_evening_2300",
        name: "Evening Settlement Recap",
        cronExpression: "23:00 EDT",
        reportType: "EVENING_SETTLEMENT",
        description:
          "Day's settled handle, customer won/lost, net house hold, and agent 50% liability balance.",
      },
    );
  }

  public getWatchList(): ReadonlyMap<string, WatchListAccount> {
    return this.watchListMap;
  }

  public getScheduledReports(): readonly ScheduledReportTask[] {
    return this.scheduledReports;
  }

  public async sendMessage(
    chatId: string,
    htmlText: string,
    options?: TelegramSendMessageOptions & { readonly timeoutMs?: number },
  ): Promise<{ ok: boolean; message_id?: number; description?: string }> {
    const targetChat = chatId || this.defaultChatId;

    if (!this.botToken.trim() || !targetChat.trim()) {
      console.log(
        "\n================================================================================",
      );
      console.log(
        `[TELEGRAM OUTBOUND SIMULATION] Target Chat: ${targetChat || "DEFAULT_CHANNEL"}`,
      );
      console.log(
        "================================================================================",
      );
      console.log(htmlText.replace(/<[^>]*>/g, ""));
      await this.record({
        direction: "out",
        chatId: targetChat,
        summary: plainPreview(htmlText),
        outcome: "simulated",
        detail: this.botToken.trim()
          ? "TELEGRAM_CHAT_ID is not set"
          : "TELEGRAM_BOT_TOKEN is not set",
      });
      return { ok: true, message_id: Math.floor(Math.random() * 100000) };
    }

    const res = await this.api<{ message_id: number }>(
      "sendMessage",
      {
        chat_id: targetChat,
        text: htmlText,
        parse_mode: options?.parse_mode || "HTML",
        disable_web_page_preview: options?.disable_web_page_preview ?? true,
        reply_markup: options?.reply_markup,
      },
      options?.timeoutMs,
    );
    if (!res.ok) {
      console.error("[Telegram API Error] sendMessage:", res.description);
    }
    await this.record({
      direction: "out",
      chatId: targetChat,
      summary: plainPreview(htmlText),
      outcome: res.ok ? "sent" : "failed",
      ...(res.ok ? {} : { detail: res.description ?? "sendMessage failed" }),
    });
    return {
      ok: res.ok,
      ...(res.result?.message_id !== undefined
        ? { message_id: res.result.message_id }
        : {}),
      ...(res.description !== undefined
        ? { description: res.description }
        : {}),
    };
  }

  /** Newest first. */
  public async getActivity(limit = 50): Promise<TelegramActivityEntry[]> {
    if (!this.activityLogPath) return [];
    const file = Bun.file(this.activityLogPath);
    if (!(await file.exists())) return [];
    return (await file.text())
      .trimEnd()
      .split("\n")
      .slice(-limit)
      .reverse()
      .flatMap((line): TelegramActivityEntry[] => {
        try {
          return [JSON.parse(line) as TelegramActivityEntry];
        } catch {
          return [];
        }
      });
  }

  /** Best effort: a log failure must never block a send or a command. */
  private async record(
    entry: Omit<TelegramActivityEntry, "at">,
  ): Promise<void> {
    const path = this.activityLogPath;
    if (!path) return;
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(
        path,
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      );
      if (Bun.file(path).size > ACTIVITY_MAX_BYTES) {
        const lines = (await Bun.file(path).text()).trimEnd().split("\n");
        await Bun.write(
          path,
          `${lines.slice(-ACTIVITY_KEEP_LINES).join("\n")}\n`,
        );
      }
    } catch (err) {
      console.error("[Telegram] activity log write failed:", err);
    }
  }

  /**
   * POST a Bot API method; never throws, transport failures come back as `ok: false`.
   *
   * 8s rather than 10s on purpose: a handler that writes nothing is cut at roughly
   * `max(4s, idleTimeout + 2s)` — 12s with Bun's default idleTimeout of 10 — and the caller sees
   * ECONNRESET rather than the response. Aborting at 8s leaves room for the handler to return a
   * clean `ok: false` inside that budget. Measured, not assumed: see
   * tests/route_guard_boundary.test.ts.
   */
  private async api<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 8_000,
    cancel?: AbortSignal,
  ): Promise<TelegramApiResult<T>> {
    if (!this.botToken.trim()) {
      return { ok: false, description: "TELEGRAM_BOT_TOKEN is not set" };
    }
    try {
      const res = await this.fetchSession.fetch(
        `${this.apiBaseUrl}/bot${this.botToken}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
          signal: cancel
            ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel])
            : AbortSignal.timeout(timeoutMs),
        },
      );
      return (await res.json()) as TelegramApiResult<T>;
    } catch (err) {
      return {
        ok: false,
        description: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public setReportGenerator(generator: ReportGenerator): void {
    this.reportGenerator = generator;
  }

  public isAuthorizedChat(chatId: string | number): boolean {
    return this.authorizedChatIds.has(String(chatId));
  }

  public isWebhookSecretValid(header: string | null): boolean {
    if (!this.webhookSecret || header === null) return false;
    const a = Buffer.from(header);
    const b = Buffer.from(this.webhookSecret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  public async getStatus(): Promise<TelegramBotStatus> {
    const tokenConfigured = this.botToken.trim().length > 0;
    const defaultChatConfigured = this.defaultChatId.trim().length > 0;
    const modeReason = !tokenConfigured
      ? "TELEGRAM_BOT_TOKEN is not set"
      : !defaultChatConfigured
        ? "TELEGRAM_CHAT_ID is not set; alerts and reports only print to the console. Send /chatid to the bot to get it."
        : "Alerts and reports go to the default chat";
    const base = {
      tokenConfigured,
      defaultChatConfigured,
      mode: this.isLiveMode ? "live" : "simulation",
      modeReason,
      authorizedChatCount: this.authorizedChatIds.size,
    } as const;
    if (!tokenConfigured) {
      return {
        ...base,
        bot: null,
        inbound: "none",
        webhook: null,
        error: null,
      };
    }

    const [me, hook] = await Promise.all([
      this.api<{ username: string }>("getMe"),
      this.api<{
        url: string;
        pending_update_count: number;
        last_error_message?: string;
      }>("getWebhookInfo"),
    ]);
    const webhookUrl = hook.result?.url ?? "";
    return {
      ...base,
      bot: me.result ? { username: me.result.username } : null,
      inbound: webhookUrl ? "webhook" : this.pollingAbort ? "polling" : "none",
      webhook: hook.ok
        ? {
            url: webhookUrl,
            configuredUrl: this.webhookUrl,
            secretConfigured: this.webhookSecret.length > 0,
            pendingUpdates: hook.result?.pending_update_count ?? 0,
            lastError: hook.result?.last_error_message ?? null,
          }
        : null,
      error: me.ok ? null : (me.description ?? "getMe failed"),
    };
  }

  /** Registers TELEGRAM_WEBHOOK_URL with Telegram; refuses without a secret so the endpoint can authenticate callers. */
  public async setWebhook(): Promise<{ ok: boolean; description?: string }> {
    if (!this.webhookUrl) {
      return { ok: false, description: "TELEGRAM_WEBHOOK_URL is not set" };
    }
    if (!this.webhookSecret) {
      return { ok: false, description: "TELEGRAM_WEBHOOK_SECRET is not set" };
    }
    this.stopPolling();
    const res = await this.api<boolean>("setWebhook", {
      url: this.webhookUrl,
      secret_token: this.webhookSecret,
      allowed_updates: ["message", "callback_query"],
    });
    return {
      ok: res.ok,
      ...(res.description !== undefined
        ? { description: res.description }
        : {}),
    };
  }

  public async deleteWebhook(): Promise<{ ok: boolean; description?: string }> {
    const res = await this.api<boolean>("deleteWebhook");
    return {
      ok: res.ok,
      ...(res.description !== undefined
        ? { description: res.description }
        : {}),
    };
  }

  /** Long-polls getUpdates until {@link stopPolling}; Telegram rejects this while a webhook is set. */
  public async startPolling(): Promise<void> {
    if (this.pollingAbort) return;
    const abort = new AbortController();
    this.pollingAbort = abort;
    let offset = 0;
    console.log("[Telegram] Polling for updates (Ctrl+C to stop)");
    while (!abort.signal.aborted) {
      const res = await this.api<TelegramUpdate[]>(
        "getUpdates",
        { offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
        35_000,
        abort.signal,
      );
      if (abort.signal.aborted) break;
      if (!res.ok) {
        console.error(`[Telegram] getUpdates failed: ${res.description}`);
        if (res.error_code === 409) break;
        await Bun.sleep(5_000);
        continue;
      }
      for (const update of res.result ?? []) {
        offset = update.update_id + 1;
        await this.handleUpdate(update).catch((err) =>
          console.error("[Telegram] update handler failed:", err),
        );
      }
    }
    this.pollingAbort = null;
  }

  public stopPolling(): void {
    this.pollingAbort?.abort();
  }

  public async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message?.text?.startsWith("/")) return;

    const chatId = String(message.chat.id);
    const [rawCommand = "", ...args] = message.text.trim().split(/\s+/);
    const command = rawCommand.split("@")[0]!.toLowerCase();
    await this.record({
      direction: "in",
      chatId,
      summary: message.text.trim().slice(0, 160),
      outcome:
        command === "/chatid" || this.isAuthorizedChat(chatId)
          ? "received"
          : "unauthorized",
    });

    if (command === "/chatid") {
      await this.sendMessage(
        chatId,
        `This chat's ID is <code>${chatId}</code>.\nSet <code>TELEGRAM_CHAT_ID</code> (or add it to <code>TELEGRAM_ADMIN_CHAT_IDS</code>) to authorize it.`,
      );
      return;
    }
    if (!this.isAuthorizedChat(chatId)) {
      await this.sendMessage(
        chatId,
        `This chat is not authorized. Send /chatid and ask an admin to add <code>${chatId}</code>.`,
      );
      return;
    }

    switch (command) {
      case "/start":
      case "/help":
        await this.sendMessage(
          chatId,
          [
            "<b>SportsDesk bot</b>",
            "/miniapp - open the live dashboard",
            "/watchlist - monitored accounts",
            "/check &lt;ID&gt; - one account",
            "/report [MORNING_BRIEFING|MIDDAY_STEAM|EVENING_SETTLEMENT]",
            "/alert_test [ID] - send a sample watch list alert here",
            "/forensics - open the forensics tab",
            "/chatid - show this chat's ID",
          ].join("\n"),
          { reply_markup: this.miniappKeyboard("", chatId) },
        );
        return;
      case "/miniapp":
      case "/forensics":
        await this.sendMessage(chatId, "Open the SportsDesk dashboard:", {
          reply_markup: this.miniappKeyboard(
            command === "/forensics" ? "?tab=forensics" : "",
            chatId,
          ),
        });
        return;
      case "/watchlist": {
        const lines = [...this.watchListMap.values()].map(
          (a) =>
            `<code>${Bun.escapeHTML(a.customerId)}</code> ${Bun.escapeHTML(a.riskTier)} (agent <code>${Bun.escapeHTML(a.agentId)}</code>)`,
        );
        await this.sendMessage(
          chatId,
          `<b>Watch list (${lines.length})</b>\n${lines.join("\n")}`,
        );
        return;
      }
      case "/check": {
        const id = (args[0] ?? "").toUpperCase();
        const acct = this.watchListMap.get(id);
        await this.sendMessage(
          chatId,
          acct
            ? [
                `<b>${Bun.escapeHTML(acct.customerId)}</b> (${Bun.escapeHTML(acct.archetype)})`,
                `Agent <code>${Bun.escapeHTML(acct.agentId)}</code>, master <code>${Bun.escapeHTML(acct.masterAgentId)}</code>`,
                `Handle $${acct.sportsHandleUSD.toLocaleString("en-US")}, recent net $${acct.recentNetUSD.toLocaleString("en-US")}, lifetime net $${acct.lifetimeNetUSD.toLocaleString("en-US")}`,
                `Action: ${Bun.escapeHTML(acct.recommendedAction)}`,
              ].join("\n")
            : `No watch list account <code>${Bun.escapeHTML(id || "(none)")}</code>. Try /watchlist.`,
        );
        return;
      }
      case "/alert_test":
        await this.dispatchTestAlert(args[0] ?? "RF2003", chatId);
        return;
      case "/report": {
        const type = (args[0] ?? "EVENING_SETTLEMENT").toUpperCase();
        if (!isReportType(type)) {
          await this.sendMessage(
            chatId,
            `Unknown report. Use one of: ${REPORT_TYPES.join(", ")}`,
          );
          return;
        }
        await this.dispatchReport(type, chatId);
        return;
      }
      default:
        await this.sendMessage(chatId, "Unknown command. Send /help.");
    }
  }

  public async dispatchReport(
    type: ScheduledReportTask["reportType"],
    chatId?: string,
  ): Promise<boolean> {
    if (!this.reportGenerator) {
      console.error("[Telegram] no report generator registered");
      return false;
    }
    const res = await this.sendMessage(
      chatId ?? "",
      this.reportGenerator(type).contentHtml,
    );
    return res.ok;
  }

  private async handleCallback(
    query: NonNullable<TelegramUpdate["callback_query"]>,
  ): Promise<void> {
    const chatId = query.message?.chat.id;
    const authorized = chatId !== undefined && this.isAuthorizedChat(chatId);
    await this.record({
      direction: "in",
      chatId: String(chatId ?? query.from.id),
      summary: `button ${query.data ?? ""} from ${query.from.username ?? query.from.id}`,
      outcome: authorized ? "received" : "unauthorized",
    });
    if (!authorized) {
      await this.api("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Not authorized",
      });
      return;
    }
    const [action, customerId, value] = (query.data ?? "").split(":");
    const label =
      action === "slash"
        ? `Slash ${customerId} to $${Number(value).toLocaleString("en-US")}`
        : action === "delay"
          ? `Apply ${value}s delay to ${customerId}`
          : `Unknown action ${query.data}`;
    console.log(
      `[Telegram] ${label} requested by ${query.from.username ?? query.from.id}`,
    );
    await this.api("answerCallbackQuery", {
      callback_query_id: query.id,
      text: `${label}: recorded. Apply it in Fantasy402; the bot does not change accounts.`,
      show_alert: true,
    });
  }

  /** `web_app` buttons are rejected outside private chats (negative chat IDs), so groups get a plain link. */
  private miniappButton(
    text: string,
    query: string,
    chatId: string,
  ): TelegramInlineKeyboardButton {
    const url = `${this.miniappBaseUrl}${query}`;
    return chatId.startsWith("-") ? { text, url } : { text, web_app: { url } };
  }

  private miniappKeyboard(query: string, chatId: string) {
    return {
      inline_keyboard: [[this.miniappButton("Open SportsDesk", query, chatId)]],
    };
  }

  public async dispatchWatchListAlert(
    wager: WagerAlertPayload,
    targetChatId?: string,
  ): Promise<boolean> {
    const watchAcct =
      wager.watchAccount || this.watchListMap.get(wager.customerId);
    const chatId = targetChatId || this.defaultChatId;

    const riskFormatted = `$${wager.riskUSD.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    const winFormatted = `$${wager.toWinUSD.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    const archetype = watchAcct?.archetype || "High-Stake Exposure Threshold";
    const action =
      watchAcct?.recommendedAction ||
      "Review account wagering limits and confirmation delay";

    const alertHtml = `
🚨 <b>SPORTSDESK WATCH LIST WAGER ALERT</b> 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Bettor Account:</b> <code>${wager.customerId}</code>
👔 <b>Owning Sub-Agent:</b> <code>${wager.agentId}</code> (Master: <code>${wager.masterAgentId}</code>)
🏷 <b>Archetype:</b> ⚠️ <b>${archetype}</b>

💰 <b>Risk Amount:</b> <code>${riskFormatted}</code>
🎯 <b>To Win:</b> <code>${winFormatted}</code> (${wager.odds})
🏀 <b>Market / Leg:</b> <b>${wager.marketDescription}</b>
📋 <b>Wager Type:</b> <code>${wager.wagerType}</code> (Ticket #${wager.wagerNumber})
🕒 <b>Accepted At:</b> <code>${wager.acceptedAt}</code>

🛡 <b>Recommended Operational Action:</b>
${action}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

    const deepLinkQuery = `?${new URLSearchParams({ tab: "forensics", agent: wager.agentId, customer: wager.customerId })}`;

    const inlineKeyboard: TelegramInlineKeyboardButton[][] = [
      [this.miniappButton("🚀 Open in Live MiniApp", deepLinkQuery, chatId)],
      [
        {
          text: "⚡ Slash to $1k",
          callback_data: `slash:${wager.customerId}:1000`,
        },
        {
          text: "⏱ Apply 6s Delay",
          callback_data: `delay:${wager.customerId}:6`,
        },
      ],
    ];

    const result = await this.sendMessage(chatId, alertHtml.trim(), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: inlineKeyboard },
    });

    return result.ok;
  }

  public async dispatchTestAlert(
    targetCustomerId: string = "RF2003",
    targetChatId?: string,
  ): Promise<boolean> {
    const custId = targetCustomerId.trim().toUpperCase();
    const watch = this.watchListMap.get(custId);

    const testPayload: WagerAlertPayload = {
      customerId: custId,
      agentId: watch?.agentId || "FAKEMONEY",
      masterAgentId: "BILLY666",
      wagerNumber: Math.floor(Math.random() * 900000) + 100000,
      riskUSD:
        custId === "RF2003" ? 20000.0 : custId === "BGD101" ? 20000.0 : 2500.0,
      toWinUSD:
        custId === "RF2003"
          ? 18181.82
          : custId === "BGD101"
            ? 18181.82
            : 2272.73,
      odds: "-110",
      marketDescription:
        "NFL • Kansas City Chiefs -3½ vs Denver Broncos (Point Spread)",
      wagerType: "Straight (Point Spread)",
      acceptedAt:
        new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC-5",
      ...(watch !== undefined ? { watchAccount: watch } : {}),
    };

    return this.dispatchWatchListAlert(testPayload, targetChatId);
  }
}

export function isReportType(
  value: string,
): value is ScheduledReportTask["reportType"] {
  return (REPORT_TYPES as readonly string[]).includes(value);
}

if (import.meta.main) {
  const { startBotDaemon } = await import("./reporting_scheduler_service.ts");
  await startBotDaemon();
}
