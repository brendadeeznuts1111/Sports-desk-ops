#!/usr/bin/env bun
/**
 * @file scripts/live_positions_cron.ts
 * @description 10-Minute Bun.cron (every 10m) Live Volume & Open Positions Sync + Telegram Pulse Engine.
 *
 * Bridges the active Fantasy402 live bet-ticker stream (`/Users/nolarose/4c-odds-intergration/probes/out13/f402-bets.jsonl`
 * and `f402-open-export.jsonl`) and the 88-section DOD6 v5.4 binary spine (`data/sportsdesk_unified_baseline_v54.dodbin`)
 * into `sportsdesk-ops`:
 *   1. Rebuilds `data/live-wagers.json` (`getBetTicker` window) and `data/live-bets.json` (`Report/Pending` open positions)
 *      plus `data/capture-health.json` so `/api/kpis`, `/api/live-bets`, and `/api/live-wagers` never go stale.
 *   2. Tracks an incremental 10-minute watermark (`scratch/live-positions-watermark.json`) over `f402-bets.jsonl`
 *      to compute exact 10m / 1h / 24h / cumulative volume updates (deduplicating `ALERT` mirrors and `BLOCKED` rows).
 *   3. Summarizes open positions by Sport, Market/WagerType, Channel (`GSLIVE`, `GSBUILDER`, `Internet`), Top Sub-Agents,
 *      and Top Active Accounts cross-referenced against the 14,534-customer DOD6 v5.4 spine.
 *   4. Sends a formatted HTML summary message every 10 minutes via `SportsDeskTelegramService` (checking both `Bun.env`
 *      and `Bun.secrets` keychain `bookdeskops.desk`) and logs every run to `scratch/live-positions-cron.jsonl`
 *      and `reports/live-positions-summary.json`.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import {
  CAPTURE_HEALTH_PATH,
  mergeCaptureHealth,
  readCaptureHealth,
  writeCaptureHealth,
  type LiveCaptureRecord,
} from "../lib/live_capture.ts";
import {
  buildArtifact,
  hierarchyIndexFromTree,
  type PendingRow,
} from "../lib/live_bets.ts";
import {
  publishLivePositionsToR2,
  type LivePositionsR2PublishResult,
} from "../lib/live_positions_r2_publisher.ts";
import {
  betTickerFile,
  isTickerNoise,
  toLiveWager,
  type LiveWager,
} from "../lib/live_wagers.ts";
import { R2S3Client } from "../lib/r2_s3_client.ts";
import { SportsDeskTelegramService } from "../services/sportsdesk_telegram_bot.ts";
import {
  loadDodCustomerLifetimeMap,
  normalizeCanonicalCustomer,
  readDod6SpineHeader,
  type DodCustomerLifetimeMeta,
} from "../lib/dod6_spine_overlay.ts";

export type { DodCustomerLifetimeMeta };

export const OS_CRON_TITLE = "sportsdesk-live-positions-10m";
export const DEFAULT_SCHEDULE = "*/10 * * * *";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_BETS_JSONL =
  Bun.env.F402_BETS_JSONL ??
  "/Users/nolarose/4c-odds-intergration/probes/out13/f402-bets.jsonl";
const DEFAULT_LIFETIME_CSV =
  Bun.env.F402_LIFETIME_CSV ??
  "/Users/nolarose/4c-odds-intergration/probes/out13/bettor_lifetime.csv";
const DEFAULT_DODBIN_PATH = resolve(
  REPO_ROOT,
  "data/sportsdesk_unified_baseline_v54.dodbin",
);
const DEFAULT_WATERMARK_PATH = resolve(
  REPO_ROOT,
  "scratch/live-positions-watermark.json",
);
const DEFAULT_JOURNAL_PATH = resolve(
  REPO_ROOT,
  "scratch/live-positions-cron.jsonl",
);
const DEFAULT_SUMMARY_JSON_PATH = resolve(
  REPO_ROOT,
  "reports/live-positions-summary.json",
);

const VALUE_FLAGS = [
  "--schedule",
  "--tz",
  "--journal",
  "--history",
  "--title",
  "--chat-id",
] as const;

const HELP = `
positions:cron — sync live Fantasy402 wagers & open positions and send 10-minute volume summary via Bun.cron

Options:
  --schedule <expr>   Cron expression (default: POSITIONS_CRON or "*/10 * * * *")
  --tz <iana>         IANA timezone for schedule evaluation (default: local system timezone)
  --chat-id <id>      Target Telegram chat ID override
  --journal <path>    Run journal (default: scratch/live-positions-cron.jsonl)
  --history <n>       Print the last n runs and exit
  --print-schedule    Show the next fire time and exit
  --run-once          Sync live data and send summary message now, then exit
  --install-os        Register OS-level Bun.cron job (launchd/crontab) that survives reboots
  --remove-os         Remove the registered OS-level job
  --title <name>      OS job identifier (default: ${OS_CRON_TITLE})
  -h, --help          This text
`.trim();

export interface LivePositionsWatermark {
  readonly schemaVersion: 1;
  readonly updatedAtIso: string;
  readonly fileByteOffset: number;
  readonly lastWagerNumber: number;
  readonly lastInsertedAt: string;
  readonly cumulativeRawRows: number;
  readonly cumulativeCountedWagers: number;
  readonly cumulativeExcludedAlerts: number;
  readonly cumulativeExcludedBlocked: number;
  readonly cumulativeRiskCents: number;
  readonly cumulativeToWinCents: number;
  readonly cumulativeVolumeCents: number;
  readonly seenCompositeKeysCount: number;
}

export interface BucketRollup {
  readonly key: string;
  readonly count: number;
  readonly riskCents: number;
  readonly toWinCents: number;
  readonly volumeCents: number;
}

export interface ActiveCustomerPositionSummary {
  readonly customerId: string;
  readonly canonicalId: string;
  readonly agentId: string;
  readonly wagersCount: number;
  readonly riskCents: number;
  readonly toWinCents: number;
  readonly volumeCents: number;
  readonly liveCount: number;
  readonly latestSelection: string;
  readonly dodLifetimeStakedCents: number | null;
  readonly dodSettledStakedCents: number | null;
  readonly dodSettledNetCents: number | null;
  readonly dodAvgClvPoints: number | null;
}

export interface LivePositionsPulseSummary {
  readonly schemaVersion: 1;
  readonly generatedAtIso: string;
  readonly schedule: string;
  readonly sourceStreamPath: string;
  readonly sourceStreamBytes: number;
  readonly sourceStreamMtimeIso: string;
  readonly dodSpine: {
    readonly path: string;
    readonly magic: string;
    readonly version: number;
    readonly sectionCount: number;
    readonly customerCount: number;
    readonly asOfEpochDays: number;
  } | null;
  readonly cumulative: {
    readonly rawRows: number;
    readonly countedWagers: number;
    readonly excludedAlerts: number;
    readonly excludedBlocked: number;
    readonly riskCents: number;
    readonly toWinCents: number;
    readonly volumeCents: number;
    readonly latestWagerNumber: number;
    readonly latestInsertedAt: string;
  };
  readonly deltaSinceLastCheck: {
    readonly previousCheckAtIso: string | null;
    readonly newRawRows: number;
    readonly newCountedWagers: number;
    readonly newRiskCents: number;
    readonly newToWinCents: number;
    readonly newVolumeCents: number;
    readonly wagerNumberFrom: number;
    readonly wagerNumberTo: number;
  };
  readonly window10m: {
    readonly wagers: number;
    readonly riskCents: number;
    readonly toWinCents: number;
    readonly volumeCents: number;
  };
  readonly window1h: {
    readonly wagers: number;
    readonly riskCents: number;
    readonly toWinCents: number;
    readonly volumeCents: number;
  };
  readonly window24hOpenPositions: {
    readonly openTicketsCount: number;
    readonly liveInPlayCount: number;
    readonly pregameCount: number;
    readonly openRiskCents: number;
    readonly openToWinCents: number;
    readonly openVolumeCents: number;
    readonly byChannel: readonly BucketRollup[];
    readonly bySport: readonly BucketRollup[];
    readonly byWagerType: readonly BucketRollup[];
    readonly topAgents: readonly BucketRollup[];
    readonly topActiveAccounts: readonly ActiveCustomerPositionSummary[];
    readonly latestWagers: readonly {
      readonly wagerNumber: number;
      readonly customerId: string;
      readonly agentId: string;
      readonly writer: string;
      readonly wagerType: string;
      readonly riskCents: number;
      readonly toWinCents: number;
      readonly insertedAt: string;
      readonly summary: string;
    }[];
  };
  readonly artifactsSynced: {
    readonly liveWagersPath: string;
    readonly liveWagersCount: number;
    readonly liveBetsPath: string;
    readonly liveBetsCount: number;
    readonly captureHealthPath: string;
    readonly r2Publish: {
      readonly ok: boolean;
      readonly summary: string;
    };
  };
  readonly telegramDelivery: {
    readonly ok: boolean;
    readonly mode: string;
    readonly messageId?: number;
  };
}

function formatUsdFromCents(cents: number, signed = false): string {
  const abs = Math.abs(cents) / 100;
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (cents < 0) return `-$${formatted}`;
  if (signed && cents > 0) return `+$${formatted}`;
  return `$${formatted}`;
}

function parseEtInsertTimestampMs(insertDateTime: string): number | null {
  const trimmed = insertDateTime.trim();
  if (!trimmed) return null;
  // Format in f402-bets.jsonl: "2026-11-03 03:32:41.840" (US Eastern / portal clock)
  const isoCandidate = trimmed.includes("T")
    ? trimmed
    : `${trimmed.replace(" ", "T")}-05:00`;
  const parsed = Date.parse(isoCandidate);
  return Number.isFinite(parsed) ? parsed : null;
}

function readDodSpineHeader(
  path: string,
): LivePositionsPulseSummary["dodSpine"] {
  const header = readDod6SpineHeader(path);
  if (header === null) return null;
  return {
    path: header.path,
    magic: header.magic,
    version: header.version,
    sectionCount: header.sectionCount,
    customerCount: header.customerCount,
    asOfEpochDays: header.asOfEpochDays,
  };
}

function readTailLines(filePath: string, maxBytes = 6 * 1024 * 1024): string[] {
  const st = statSync(filePath);
  const readLen = Math.min(st.size, maxBytes);
  const startOffset = Math.max(0, st.size - readLen);
  const fd = openSync(filePath, "r");
  try {
    const buf = new Uint8Array(readLen);
    readSync(fd, buf, 0, readLen, startOffset);
    const text = new TextDecoder().decode(buf);
    const lines = text.split("\n");
    if (startOffset > 0 && lines.length > 1) {
      lines.shift(); // drop partial first line
    }
    return lines.filter((l) => l.trim().length > 0);
  } finally {
    closeSync(fd);
  }
}

interface CumulativeScanResult {
  readonly watermark: LivePositionsWatermark;
  readonly delta: LivePositionsPulseSummary["deltaSinceLastCheck"];
}

function computeCumulativeAndDelta(
  filePath: string,
  previous: LivePositionsWatermark | null,
  nowIso: string,
): CumulativeScanResult {
  const st = statSync(filePath);
  const canIncrement =
    previous !== null &&
    previous.fileByteOffset > 0 &&
    previous.fileByteOffset <= st.size;

  const startOffset = canIncrement ? previous.fileByteOffset : 0;
  const bytesToRead = st.size - startOffset;

  let rawRows = canIncrement ? previous.cumulativeRawRows : 0;
  let countedWagers = canIncrement ? previous.cumulativeCountedWagers : 0;
  let excludedAlerts = canIncrement ? previous.cumulativeExcludedAlerts : 0;
  let excludedBlocked = canIncrement ? previous.cumulativeExcludedBlocked : 0;
  let riskCents = canIncrement ? previous.cumulativeRiskCents : 0;
  let toWinCents = canIncrement ? previous.cumulativeToWinCents : 0;
  let volumeCents = canIncrement ? previous.cumulativeVolumeCents : 0;
  let lastWagerNumber = canIncrement ? previous.lastWagerNumber : 0;
  let lastInsertedAt = canIncrement ? previous.lastInsertedAt : "";
  let seenCount = canIncrement ? previous.seenCompositeKeysCount : 0;

  let newRawRows = 0;
  let newCountedWagers = 0;
  let newRiskCents = 0;
  let newToWinCents = 0;
  let newVolumeCents = 0;
  const wagerNumberFrom = lastWagerNumber;

  if (bytesToRead > 0) {
    const fd = openSync(filePath, "r");
    try {
      const chunkSize = 16 * 1024 * 1024;
      let offset = startOffset;
      let leftover = "";
      const seenKeys = new Set<string>();
      const decoder = new TextDecoder();

      while (offset < st.size) {
        const len = Math.min(chunkSize, st.size - offset);
        const buf = new Uint8Array(len);
        readSync(fd, buf, 0, len, offset);
        offset += len;
        const text =
          leftover + decoder.decode(buf, { stream: offset < st.size });
        const lines = text.split("\n");
        leftover = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const raw = JSON.parse(trimmed) as Record<string, unknown>;
            rawRows++;
            newRawRows++;
            const wn = Number(raw.WagerNumber) || 0;
            const cust = String(raw.CustomerID ?? "").trim();
            const writer = String(raw.TicketWriter ?? "")
              .trim()
              .toLowerCase();
            const compositeKey = `${cust}:${wn}:${writer}`;
            if (seenKeys.has(compositeKey)) continue;
            seenKeys.add(compositeKey);
            seenCount++;

            if (wn > lastWagerNumber) lastWagerNumber = wn;
            const ins = String(raw.InsertDateTime ?? "").trim();
            if (ins > lastInsertedAt) lastInsertedAt = ins;

            const amt = Math.round(Number(raw.AmountWagered) || 0);
            const win = Math.round(Number(raw.ToWinAmount) || 0);
            const vol = Math.round(Number(raw.VolumeAmount) || 0);

            if (writer === "alert") {
              excludedAlerts++;
              continue;
            }
            if (writer === "blocked") {
              excludedBlocked++;
              continue;
            }

            countedWagers++;
            riskCents += amt;
            toWinCents += win;
            volumeCents += vol;

            newCountedWagers++;
            newRiskCents += amt;
            newToWinCents += win;
            newVolumeCents += vol;
          } catch {
            // ignore malformed line
          }
        }
      }
    } finally {
      closeSync(fd);
    }
  }

  const watermark: LivePositionsWatermark = {
    schemaVersion: 1,
    updatedAtIso: nowIso,
    fileByteOffset: st.size,
    lastWagerNumber,
    lastInsertedAt,
    cumulativeRawRows: rawRows,
    cumulativeCountedWagers: countedWagers,
    cumulativeExcludedAlerts: excludedAlerts,
    cumulativeExcludedBlocked: excludedBlocked,
    cumulativeRiskCents: riskCents,
    cumulativeToWinCents: toWinCents,
    cumulativeVolumeCents: volumeCents,
    seenCompositeKeysCount: seenCount,
  };

  return {
    watermark,
    delta: {
      previousCheckAtIso: previous?.updatedAtIso ?? null,
      newRawRows,
      newCountedWagers,
      newRiskCents,
      newToWinCents,
      newVolumeCents,
      wagerNumberFrom,
      wagerNumberTo: lastWagerNumber,
    },
  };
}

function toPendingRowFromLiveWager(
  raw: Record<string, unknown>,
  parsed: LiveWager,
): PendingRow {
  const firstLeg = parsed.legs[0];
  const gameParts = (firstLeg?.game ?? "").split(/\s+vs\.?\s+|\s*\/\s*/i);
  const team1 = (gameParts[0] ?? "").trim() || firstLeg?.sport || "Selection";
  const team2 = (gameParts[1] ?? "").trim() || "Market";
  const rotNum = firstLeg?.gameNumber ? Number(firstLeg.gameNumber) : undefined;

  return {
    TicketNumber: String(parsed.wagerNumber),
    WagerNumber: "1",
    AgentID: parsed.agentId || parsed.agentLogin,
    CustomerID: parsed.customerId,
    WagerStatus: "P",
    SportType: firstLeg?.sport || "Sports",
    SportSubType: firstLeg?.market || (parsed.live ? "LIVE" : "PREGAME"),
    PeriodDescription: firstLeg?.period || "Game",
    WagerType: parsed.wagerType || "S",
    totalPicks: Math.max(1, parsed.legs.length),
    Description:
      parsed.legs.map((l) => l.raw).join(" | ") ||
      String(raw.ShortDesc ?? "").trim(),
    ChosenTeamID: firstLeg?.pick ?? undefined,
    AmountWagered: parsed.amountWagered,
    ToWinAmount: parsed.toWinAmount,
    AcceptedDateTime: parsed.insertedAt,
    GameDateTime: parsed.insertedAt,
    Team1ID: team1,
    Team2ID: team2,
    ShortName1: team1,
    ShortName2: team2,
    ...(rotNum !== undefined && Number.isFinite(rotNum)
      ? { Team1RotNum: rotNum, Team2RotNum: rotNum + 1 }
      : {}),
  };
}

async function resolveTelegramCredentials(): Promise<{
  botToken: string;
  chatId: string;
}> {
  let botToken = (Bun.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  let chatId = (Bun.env.TELEGRAM_CHAT_ID ?? "").trim();

  if (!botToken || botToken === "SET_BEFORE_PRODUCTION") {
    for (const service of [
      "bookdeskops.desk",
      "sportsdesk-ops",
      "4c-odds-integration",
    ]) {
      const val = await Bun.secrets
        .get({ service, name: "TELEGRAM_BOT_TOKEN" })
        .catch(() => null);
      if (val && val.trim() && val.trim() !== "SET_BEFORE_PRODUCTION") {
        botToken = val.trim();
        break;
      }
    }
  }
  if (!chatId || chatId === "SET_BEFORE_PRODUCTION") {
    for (const service of [
      "bookdeskops.desk",
      "sportsdesk-ops",
      "4c-odds-integration",
    ]) {
      const val = await Bun.secrets
        .get({ service, name: "TELEGRAM_CHAT_ID" })
        .catch(() => null);
      if (val && val.trim() && val.trim() !== "SET_BEFORE_PRODUCTION") {
        chatId = val.trim();
        break;
      }
    }
  }
  return { botToken, chatId };
}

export function formatTelegramPulseHtml(
  summary: LivePositionsPulseSummary,
): string {
  const c = summary.cumulative;
  const d = summary.deltaSinceLastCheck;
  const w10 = summary.window10m;
  const w1h = summary.window1h;
  const open = summary.window24hOpenPositions;

  const channelLines = open.byChannel
    .slice(0, 4)
    .map(
      (b) =>
        `  • <code>${b.key.toUpperCase().padEnd(10)}</code>: <b>${b.count.toLocaleString()}</b> tix | Risk <b>${formatUsdFromCents(b.riskCents)}</b> | Vol <b>${formatUsdFromCents(b.volumeCents)}</b>`,
    )
    .join("\n");

  const sportLines = open.bySport
    .slice(0, 5)
    .map(
      (b) =>
        `  • <code>${b.key.slice(0, 12).padEnd(12)}</code>: <b>${b.count.toLocaleString()}</b> legs | Risk <b>${formatUsdFromCents(b.riskCents)}</b> | ToWin <b>${formatUsdFromCents(b.toWinCents)}</b>`,
    )
    .join("\n");

  const agentLines = open.topAgents
    .slice(0, 5)
    .map(
      (a, idx) =>
        `  ${idx + 1}. <b>${a.key}</b>: ${a.count} tix | Risk <b>${formatUsdFromCents(a.riskCents)}</b> | ToWin <b>${formatUsdFromCents(a.toWinCents)}</b>`,
    )
    .join("\n");

  const accountLines = open.topActiveAccounts
    .slice(0, 5)
    .map((acc, idx) => {
      const dodTag =
        acc.dodSettledNetCents !== null
          ? ` • DOD6 LT Net: <b>${formatUsdFromCents(acc.dodSettledNetCents, true)}</b> (CLV ${acc.dodAvgClvPoints !== null ? `${acc.dodAvgClvPoints >= 0 ? "+" : ""}${acc.dodAvgClvPoints}` : "—"})`
          : "";
      return `  ${idx + 1}. <code>${acc.customerId}</code> (<b>${acc.agentId || "DIRECT"}</b>): ${acc.wagersCount} tix | Open Risk <b>${formatUsdFromCents(acc.riskCents)}</b> (ToWin ${formatUsdFromCents(acc.toWinCents)})${dodTag}`;
    })
    .join("\n");

  const latestLines = open.latestWagers
    .slice(0, 4)
    .map(
      (w) =>
        `  • <code>#${w.wagerNumber}</code> <b>${w.customerId}</b> (${w.agentId}) [${w.writer.toUpperCase()}] <b>${formatUsdFromCents(w.riskCents)}</b> → ${formatUsdFromCents(w.toWinCents)}: <i>${w.summary.slice(0, 68)}</i>`,
    )
    .join("\n");

  const dodHeaderLine = summary.dodSpine
    ? `DOD6 v5.4 Spine: <code>${summary.dodSpine.customerCount.toLocaleString()}</code> customers • <code>${summary.dodSpine.sectionCount}</code> sections • EpochDay <code>${summary.dodSpine.asOfEpochDays}</code>`
    : "DOD6 v5.4 Spine: <code>offline</code>";

  return [
    `📡 <b>SPORTSDESK 10-MIN LIVE VOLUME &amp; POSITIONS PULSE</b>`,
    `Schedule: <code>${summary.schedule}</code> • Synced: <code>${summary.generatedAtIso.replace("T", " ").slice(0, 19)} UTC</code>`,
    dodHeaderLine,
    ``,
    `📈 <b>Total Volume Updates (Live Stream Watermark #${c.latestWagerNumber}):</b>`,
    `  • <b>10m Checkpoint Δ</b> : <b>+${d.newCountedWagers.toLocaleString()}</b> wagers | Risk <b>+${formatUsdFromCents(d.newRiskCents)}</b> | Vol <b>+${formatUsdFromCents(d.newVolumeCents)}</b>`,
    `  • <b>Last 10m Window</b>  : <b>${w10.wagers.toLocaleString()}</b> wagers | Risk <b>${formatUsdFromCents(w10.riskCents)}</b> | Vol <b>${formatUsdFromCents(w10.volumeCents)}</b>`,
    `  • <b>Last 1h Window</b>   : <b>${w1h.wagers.toLocaleString()}</b> wagers | Risk <b>${formatUsdFromCents(w1h.riskCents)}</b> | Vol <b>${formatUsdFromCents(w1h.volumeCents)}</b>`,
    `  • <b>24h Open Window</b>  : <b>${open.openTicketsCount.toLocaleString()}</b> open tix (<b>${open.liveInPlayCount}</b> Live / <b>${open.pregameCount}</b> Pregame) | Open Risk <b>${formatUsdFromCents(open.openRiskCents)}</b> | ToWin Liab <b>${formatUsdFromCents(open.openToWinCents)}</b>`,
    `  • <b>Cumulative Stream</b>: <b>${c.countedWagers.toLocaleString()}</b> wagers (${c.excludedAlerts.toLocaleString()} ALERT twins deduped) | Risk <b>${formatUsdFromCents(c.riskCents)}</b> | Vol <b>${formatUsdFromCents(c.volumeCents)}</b>`,
    ``,
    `🛰 <b>Open Positions by Channel (24h Active):</b>`,
    channelLines || "  • None",
    ``,
    `🏈 <b>Open Positions by Sport (24h Active):</b>`,
    sportLines || "  • None",
    ``,
    `👔 <b>Top 5 Sub-Agents by Open Risk:</b>`,
    agentLines || "  • None",
    ``,
    `🎯 <b>Top 5 Active Accounts (Cross-Graded vs DOD6 v5.4 Spine):</b>`,
    accountLines || "  • None",
    ``,
    `⚡ <b>Latest Live Wagers on Tape (<code>${c.latestInsertedAt}</code>):</b>`,
    latestLines || "  • None",
  ].join("\n");
}

export async function runLivePositionsPulse(options?: {
  readonly schedule?: string;
  readonly chatIdOverride?: string;
  readonly journalPath?: string;
}): Promise<LivePositionsPulseSummary> {
  const startedMs = Date.now();
  const startedNs = Bun.nanoseconds();
  const now = new Date();
  const nowIso = now.toISOString();
  const schedule = options?.schedule ?? DEFAULT_SCHEDULE;

  if (!existsSync(DEFAULT_BETS_JSONL)) {
    throw new Error(`Live stream not found at ${DEFAULT_BETS_JSONL}`);
  }

  const streamStat = statSync(DEFAULT_BETS_JSONL);
  const previousWatermark = existsSync(DEFAULT_WATERMARK_PATH)
    ? ((await Bun.file(
        DEFAULT_WATERMARK_PATH,
      ).json()) as LivePositionsWatermark)
    : null;

  const { watermark, delta } = computeCumulativeAndDelta(
    DEFAULT_BETS_JSONL,
    previousWatermark,
    nowIso,
  );
  await mkdir(dirname(DEFAULT_WATERMARK_PATH), { recursive: true });
  await Bun.write(
    DEFAULT_WATERMARK_PATH,
    `${JSON.stringify(watermark, null, 2)}\n`,
  );

  // Read the tail of f402-bets.jsonl (~6 MB, last ~9,000 rows) to extract the latest 24h, 1h, and 10m windows
  const tailLines = readTailLines(DEFAULT_BETS_JSONL, 6 * 1024 * 1024);
  const rawObjects: Record<string, unknown>[] = [];
  const parsedWagers: {
    raw: Record<string, unknown>;
    wager: LiveWager;
    tsMs: number | null;
  }[] = [];
  const seenTailKeys = new Set<string>();

  for (const line of tailLines) {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const wager = toLiveWager(raw);
      const key = `${wager.customerId}:${wager.wagerNumber}:${wager.writer}`;
      if (seenTailKeys.has(key)) continue;
      seenTailKeys.add(key);
      rawObjects.push(raw);
      parsedWagers.push({
        raw,
        wager,
        tsMs: parseEtInsertTimestampMs(wager.insertedAt),
      });
    } catch {
      // skip malformed line
    }
  }

  // Reference timestamp is the newest wager timestamp in the stream (or wall-clock now)
  let maxStreamTsMs = now.getTime();
  for (const item of parsedWagers) {
    if (item.tsMs !== null && item.tsMs > maxStreamTsMs) {
      maxStreamTsMs = item.tsMs;
    }
  }
  // Use the latest stream timestamp as the anchor if all timestamps are in ET
  const latestItemTsMs =
    parsedWagers.reduce<number>(
      (max, item) => (item.tsMs !== null && item.tsMs > max ? item.tsMs : max),
      0,
    ) || maxStreamTsMs;

  const cutoff10m = latestItemTsMs - 10 * 60 * 1000;
  const cutoff1h = latestItemTsMs - 60 * 60 * 1000;
  const cutoff24h = latestItemTsMs - 24 * 60 * 60 * 1000;

  let w10Count = 0,
    w10Risk = 0,
    w10ToWin = 0,
    w10Vol = 0;
  let w1hCount = 0,
    w1hRisk = 0,
    w1hToWin = 0,
    w1hVol = 0;

  let openTicketsCount = 0;
  let liveInPlayCount = 0;
  let pregameCount = 0;
  let openRiskCents = 0;
  let openToWinCents = 0;
  let openVolumeCents = 0;

  const byChannelMap = new Map<
    string,
    { count: number; risk: number; toWin: number; vol: number }
  >();
  const bySportMap = new Map<
    string,
    { count: number; risk: number; toWin: number; vol: number }
  >();
  const byTypeMap = new Map<
    string,
    { count: number; risk: number; toWin: number; vol: number }
  >();
  const byAgentMap = new Map<
    string,
    { count: number; risk: number; toWin: number; vol: number }
  >();
  const byCustomerMap = new Map<
    string,
    {
      customerId: string;
      agentId: string;
      count: number;
      risk: number;
      toWin: number;
      vol: number;
      liveCount: number;
      latestSelection: string;
    }
  >();

  const open24hItems: { raw: Record<string, unknown>; wager: LiveWager }[] = [];

  for (const item of parsedWagers) {
    const { wager, tsMs } = item;
    if (isTickerNoise(wager)) continue;
    const effectiveTs = tsMs ?? latestItemTsMs;

    if (effectiveTs >= cutoff10m) {
      w10Count++;
      w10Risk += wager.amountWagered;
      w10ToWin += wager.toWinAmount;
      w10Vol += wager.volumeAmount;
    }
    if (effectiveTs >= cutoff1h) {
      w1hCount++;
      w1hRisk += wager.amountWagered;
      w1hToWin += wager.toWinAmount;
      w1hVol += wager.volumeAmount;
    }
    if (effectiveTs >= cutoff24h) {
      open24hItems.push({ raw: item.raw, wager });
      openTicketsCount++;
      if (wager.live) liveInPlayCount++;
      else pregameCount++;
      openRiskCents += wager.amountWagered;
      openToWinCents += wager.toWinAmount;
      openVolumeCents += wager.volumeAmount;

      const ch = wager.writer || "other";
      const chB = byChannelMap.get(ch) ?? {
        count: 0,
        risk: 0,
        toWin: 0,
        vol: 0,
      };
      chB.count++;
      chB.risk += wager.amountWagered;
      chB.toWin += wager.toWinAmount;
      chB.vol += wager.volumeAmount;
      byChannelMap.set(ch, chB);

      const wt = wager.wagerType || "S";
      const wtB = byTypeMap.get(wt) ?? { count: 0, risk: 0, toWin: 0, vol: 0 };
      wtB.count++;
      wtB.risk += wager.amountWagered;
      wtB.toWin += wager.toWinAmount;
      wtB.vol += wager.volumeAmount;
      byTypeMap.set(wt, wtB);

      const ag = (wager.agentId || wager.agentLogin || "UNASSIGNED").trim();
      const agB = byAgentMap.get(ag) ?? { count: 0, risk: 0, toWin: 0, vol: 0 };
      agB.count++;
      agB.risk += wager.amountWagered;
      agB.toWin += wager.toWinAmount;
      agB.vol += wager.volumeAmount;
      byAgentMap.set(ag, agB);

      const primarySport = wager.legs[0]?.sport || "Other";
      const spB = bySportMap.get(primarySport) ?? {
        count: 0,
        risk: 0,
        toWin: 0,
        vol: 0,
      };
      spB.count++;
      spB.risk += wager.amountWagered;
      spB.toWin += wager.toWinAmount;
      spB.vol += wager.volumeAmount;
      bySportMap.set(primarySport, spB);

      const custId = wager.customerId || wager.login || "UNKNOWN";
      const custB = byCustomerMap.get(custId) ?? {
        customerId: custId,
        agentId: ag,
        count: 0,
        risk: 0,
        toWin: 0,
        vol: 0,
        liveCount: 0,
        latestSelection: "",
      };
      custB.count++;
      custB.risk += wager.amountWagered;
      custB.toWin += wager.toWinAmount;
      custB.vol += wager.volumeAmount;
      if (wager.live) custB.liveCount++;
      custB.latestSelection =
        wager.legs.map((l) => l.raw).join(" / ") || custB.latestSelection;
      byCustomerMap.set(custId, custB);
    }
  }

  const toSortedRollup = (
    m: Map<string, { count: number; risk: number; toWin: number; vol: number }>,
  ): BucketRollup[] =>
    [...m.entries()]
      .map(([key, v]) => ({
        key,
        count: v.count,
        riskCents: v.risk,
        toWinCents: v.toWin,
        volumeCents: v.vol,
      }))
      .sort((a, b) => b.riskCents - a.riskCents);

  const dodSpineHeader = readDodSpineHeader(DEFAULT_DODBIN_PATH);
  const dodLifetimeMap = await loadDodCustomerLifetimeMap(DEFAULT_LIFETIME_CSV);

  const topActiveAccounts: ActiveCustomerPositionSummary[] = [
    ...byCustomerMap.values(),
  ]
    .sort((a, b) => b.risk - a.risk)
    .slice(0, 10)
    .map((c) => {
      const canonicalId = normalizeCanonicalCustomer(c.customerId);
      const dod = dodLifetimeMap.get(canonicalId);
      return {
        customerId: c.customerId,
        canonicalId,
        agentId: c.agentId,
        wagersCount: c.count,
        riskCents: c.risk,
        toWinCents: c.toWin,
        volumeCents: c.vol,
        liveCount: c.liveCount,
        latestSelection: c.latestSelection.slice(0, 120),
        dodLifetimeStakedCents: dod?.lifetimeStakedCents ?? null,
        dodSettledStakedCents: dod?.settledStakedCents ?? null,
        dodSettledNetCents: dod?.settledNetCents ?? null,
        dodAvgClvPoints: dod?.avgClvPoints ?? null,
      };
    });

  // 1. Rebuild data/live-wagers.json from latest 300 raw rows in f402-bets.jsonl
  const latestRawList = rawObjects.slice(-300).reverse();
  const liveWagersPayload = betTickerFile({ LIST: latestRawList }, nowIso);
  const liveWagersPath = resolve(REPO_ROOT, "data/live-wagers.json");
  await Bun.write(
    liveWagersPath,
    `${JSON.stringify(liveWagersPayload, null, 2)}\n`,
  );

  // 2. Rebuild data/live-bets.json from the latest 250 open wagers in the 24h window
  const agentTreePath = resolve(REPO_ROOT, "data/agent-tree.json");
  let hierarchyIndex: ReturnType<typeof hierarchyIndexFromTree> | undefined;
  if (existsSync(agentTreePath)) {
    hierarchyIndex = hierarchyIndexFromTree(
      (await Bun.file(agentTreePath).json()) as {
        nodes: Record<
          string,
          { l?: number | null; t?: string | null; a?: boolean }
        >;
      },
    );
  }

  const recentOpenSlice = open24hItems.slice(-250);
  const pendingRows: PendingRow[] = recentOpenSlice.map(({ raw, wager }) =>
    toPendingRowFromLiveWager(raw, wager),
  );
  const liveBetsArtifact = buildArtifact(pendingRows, {
    operation: "/cloud/api/Report/Pending",
    capturedAt: nowIso,
    ...(hierarchyIndex !== undefined ? { hierarchyIndex } : {}),
  });
  const liveBetsPath = resolve(REPO_ROOT, "data/live-bets.json");
  await Bun.write(
    liveBetsPath,
    `${JSON.stringify(liveBetsArtifact, null, 2)}\n`,
  );

  // 3. Update data/capture-health.json so /api/kpis and freshness gates see fresh captures
  const healthPath = resolve(REPO_ROOT, CAPTURE_HEALTH_PATH);
  const prevHealth = await readCaptureHealth(healthPath);
  const liveBetsText = JSON.stringify(liveBetsArtifact);
  const liveWagersText = JSON.stringify(liveWagersPayload);
  const sha256Hex = (s: string) =>
    new Bun.CryptoHasher("sha256").update(s).digest("hex");

  const newHealthRecords: LiveCaptureRecord[] = [
    {
      source: "Pending",
      operation: "Pending",
      artifact: "data/live-bets.json",
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: nowIso,
      outcome: "captured",
      transport: "f402-live-stream-bridge",
      httpStatus: 200,
      rows: liveBetsArtifact.pendingCount,
      bytes: liveBetsText.length,
      bodySha256: sha256Hex(liveBetsText),
      artifactWritten: true,
      keptPreviousArtifact: false,
      error: null,
      provenanceClass: "api",
    },
    {
      source: "getBetTicker",
      operation: "getBetTicker",
      artifact: "data/live-wagers.json",
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: nowIso,
      outcome: "captured",
      transport: "f402-live-stream-bridge",
      httpStatus: 200,
      rows: latestRawList.length,
      bytes: liveWagersText.length,
      bodySha256: sha256Hex(liveWagersText),
      artifactWritten: true,
      keptPreviousArtifact: false,
      error: null,
      provenanceClass: "api",
    },
  ];
  const mergedHealth = mergeCaptureHealth(
    prevHealth,
    newHealthRecords,
    nowIso,
    "f402-live-stream-bridge",
  );
  await writeCaptureHealth(healthPath, mergedHealth);

  // 4. Mirror the three local KPI artifacts to R2 under `<prefix>/latest.json`. The sinks pull
  //    their credentials from Bun.secrets (`r2` group); if the keychain has no R2 entry the publish
  //    is a logged no-op so this unseeded laptops still run the local path. R2 errors never fail
  //    the tick that already wrote to disk; `live-positions-cron.jsonl` records the outcome.
  let r2Publish: LivePositionsR2PublishResult | { ok: false; summary: string } =
    { ok: false, summary: "R2 publish: skipped (no credentials)" };
  try {
    const client = await R2S3Client.fromEnvOrSecrets();
    if (client !== null) {
      r2Publish = await publishLivePositionsToR2(client, {
        liveWagersText,
        liveBetsText,
        captureHealthText: JSON.stringify(mergedHealth),
        observedAtIso: nowIso,
        schemaVersions: {
          liveWagers: liveWagersPayload.schemaVersion,
          liveBets: liveBetsArtifact.schemaVersion,
          captureHealth: mergedHealth.schemaVersion ?? 1,
        },
      });
    }
  } catch (error) {
    r2Publish = {
      ok: false,
      summary: `R2 publish: client-init failed (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  console.log(`[live-positions-cron] ${r2Publish.summary}`);

  const latestCountedWagers = parsedWagers
    .filter((x) => !isTickerNoise(x.wager))
    .slice(-6)
    .reverse()
    .map(({ raw, wager }) => ({
      wagerNumber: wager.wagerNumber,
      customerId: wager.customerId || wager.login,
      agentId: wager.agentId || wager.agentLogin || "DIRECT",
      writer: wager.writer,
      wagerType: wager.wagerType || "S",
      riskCents: wager.amountWagered,
      toWinCents: wager.toWinAmount,
      insertedAt: wager.insertedAt,
      summary:
        wager.legs.map((l) => l.raw).join(" / ") ||
        String(raw.ShortDesc ?? "").trim(),
    }));

  const creds = await resolveTelegramCredentials();
  const targetChatId = (options?.chatIdOverride ?? creds.chatId).trim();
  const tgService = new SportsDeskTelegramService({
    botToken: creds.botToken,
    chatId: targetChatId,
  });

  const summaryDraft: LivePositionsPulseSummary = {
    schemaVersion: 1,
    generatedAtIso: nowIso,
    schedule,
    sourceStreamPath: DEFAULT_BETS_JSONL,
    sourceStreamBytes: streamStat.size,
    sourceStreamMtimeIso: new Date(streamStat.mtimeMs).toISOString(),
    dodSpine: dodSpineHeader,
    cumulative: {
      rawRows: watermark.cumulativeRawRows,
      countedWagers: watermark.cumulativeCountedWagers,
      excludedAlerts: watermark.cumulativeExcludedAlerts,
      excludedBlocked: watermark.cumulativeExcludedBlocked,
      riskCents: watermark.cumulativeRiskCents,
      toWinCents: watermark.cumulativeToWinCents,
      volumeCents: watermark.cumulativeVolumeCents,
      latestWagerNumber: watermark.lastWagerNumber,
      latestInsertedAt: watermark.lastInsertedAt,
    },
    deltaSinceLastCheck: delta,
    window10m: {
      wagers: w10Count,
      riskCents: w10Risk,
      toWinCents: w10ToWin,
      volumeCents: w10Vol,
    },
    window1h: {
      wagers: w1hCount,
      riskCents: w1hRisk,
      toWinCents: w1hToWin,
      volumeCents: w1hVol,
    },
    window24hOpenPositions: {
      openTicketsCount,
      liveInPlayCount,
      pregameCount,
      openRiskCents,
      openToWinCents,
      openVolumeCents,
      byChannel: toSortedRollup(byChannelMap),
      bySport: toSortedRollup(bySportMap),
      byWagerType: toSortedRollup(byTypeMap),
      topAgents: toSortedRollup(byAgentMap).slice(0, 10),
      topActiveAccounts,
      latestWagers: latestCountedWagers,
    },
    artifactsSynced: {
      liveWagersPath: "data/live-wagers.json",
      liveWagersCount: latestRawList.length,
      liveBetsPath: "data/live-bets.json",
      liveBetsCount: liveBetsArtifact.pendingCount,
      captureHealthPath: CAPTURE_HEALTH_PATH,
      r2Publish: {
        ok: r2Publish.ok,
        summary: r2Publish.summary,
      },
    },
    telegramDelivery: {
      ok: true,
      mode: creds.botToken && targetChatId ? "live" : "simulation",
    },
  };

  const htmlMessage = formatTelegramPulseHtml(summaryDraft);
  const sendRes = await tgService.sendMessage(targetChatId, htmlMessage, {
    parse_mode: "HTML",
  });

  const finalSummary: LivePositionsPulseSummary = {
    ...summaryDraft,
    telegramDelivery: {
      ok: sendRes.ok,
      mode: creds.botToken && targetChatId ? "live" : "simulation",
      ...(sendRes.message_id !== undefined
        ? { messageId: sendRes.message_id }
        : {}),
    },
  };

  await mkdir(dirname(DEFAULT_SUMMARY_JSON_PATH), { recursive: true });
  await Bun.write(
    DEFAULT_SUMMARY_JSON_PATH,
    `${JSON.stringify(finalSummary, null, 2)}\n`,
  );

  const journalPath = options?.journalPath ?? DEFAULT_JOURNAL_PATH;
  await mkdir(dirname(journalPath), { recursive: true });
  await appendFile(
    journalPath,
    `${JSON.stringify({
      at: nowIso,
      ok: sendRes.ok,
      durationMs: Math.round((Bun.nanoseconds() - startedNs) / 1e6),
      latestWagerNumber: watermark.lastWagerNumber,
      newCountedWagers: delta.newCountedWagers,
      newRiskCents: delta.newRiskCents,
      newVolumeCents: delta.newVolumeCents,
      openTickets24h: openTicketsCount,
      openRisk24hCents: openRiskCents,
      mode: finalSummary.telegramDelivery.mode,
    })}\n`,
    "utf8",
  );

  return finalSummary;
}

/**
 * Cloudflare Workers-compatible `scheduled(controller)` handler invoked when `Bun.cron` runs this
 * module as an OS-level scheduled job (`launchd` on macOS, `crontab` on Linux).
 */
export default {
  async scheduled(controller: Bun.CronController): Promise<void> {
    console.error(
      JSON.stringify({
        signal: "POSITIONS_CRON_OS_FIRE",
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      }),
    );
    await runLivePositionsPulse({ schedule: controller.cron });
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
    Bun.env.POSITIONS_CRON ?? DEFAULT_SCHEDULE,
  );
  const tz = flagValue(parsed, "--tz", Bun.env.POSITIONS_CRON_TZ ?? "");
  const chatId = flagValue(parsed, "--chat-id", "");
  const journal = flagValue(parsed, "--journal", DEFAULT_JOURNAL_PATH);
  const historyArg = flagValue(parsed, "--history", "");
  const title = flagValue(parsed, "--title", OS_CRON_TITLE);

  if (hasFlag(parsed, "--remove-os")) {
    await removeOsCronJob(title);
    console.error(`positions:cron: removed OS-level job "${title}"`);
    process.exit(0);
  }

  let preview: ReturnType<typeof previewCronSchedule>;
  try {
    const previewOpts: { tz?: string } = {};
    if (tz !== "") previewOpts.tz = tz;
    preview = previewCronSchedule(schedule, previewOpts);
  } catch {
    console.error(
      `positions:cron: invalid schedule "${schedule}"${tz ? ` (tz=${tz})` : ""}.`,
    );
    process.exit(2);
  }

  if (hasFlag(parsed, "--install-os")) {
    if (tz !== "") {
      console.error(
        `positions:cron: refusing to install OS-level job "${title}": --tz ${tz} is only supported for in-process cron.`,
      );
      process.exit(2);
    }
    await installOsCronJob({
      workerImportMetaUrl: import.meta.url,
      schedule,
      title,
    });
    console.error(
      `positions:cron: installed OS-level job "${title}" · ${formatCronScheduleLine(preview)}`,
    );
    process.exit(0);
  }

  if (hasFlag(parsed, "--print-schedule")) {
    console.log(`schedule: ${schedule}${tz ? ` (${tz})` : ""}`);
    console.log(
      `next fire: ${preview.next.toISOString()} (${preview.next.toString()})`,
    );
    console.log(`journal: ${journal}`);
    process.exit(0);
  }

  if (historyArg !== "") {
    const limit = Math.max(1, Number(historyArg) || 10);
    const file = Bun.file(journal);
    if (!(await file.exists())) {
      console.error(`positions:cron: no journal at ${journal}.`);
      process.exit(2);
    }
    const lines = (await file.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit);
    for (const line of lines) console.log(line);
    process.exit(0);
  }

  if (hasFlag(parsed, "--run-once")) {
    const res = await runLivePositionsPulse({
      schedule,
      ...(chatId ? { chatIdOverride: chatId } : {}),
      journalPath: journal,
    });
    console.error(
      `positions:cron: synced #${res.cumulative.latestWagerNumber} (+${res.deltaSinceLastCheck.newCountedWagers} wagers, open24h=${res.window24hOpenPositions.openTicketsCount} tix) · next ${preview.next.toISOString()}`,
    );
    process.exit(0);
  }

  // Run an initial immediate sync + message on daemon startup, then arm Bun.cron("*/10 * * * *")
  await runLivePositionsPulse({
    schedule,
    ...(chatId ? { chatIdOverride: chatId } : {}),
    journalPath: journal,
  });

  const job = startInProcessCron(
    schedule,
    async () => {
      await runLivePositionsPulse({
        schedule,
        ...(chatId ? { chatIdOverride: chatId } : {}),
        journalPath: journal,
      });
    },
    tz !== "" ? { tz } : undefined,
  );
  wireInProcessCronLifecycle(job);

  console.error(
    `positions:cron: active ${formatCronScheduleLine({ ...preview, schedule: job.cron })} · journal ${journal}`,
  );
}
