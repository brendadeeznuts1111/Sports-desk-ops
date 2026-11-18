#!/usr/bin/env bun
/**
 * @file f402_session_watch.ts
 * @description Independent silence watchdog for the F402 refresh journal (#310). The refresher
 * writes one line per 5-minute tick; a missing line means the agent is not running, and the
 * token-window alert cannot catch that (it only fires on a mint, so silence reads as health).
 * This runner reads the journal mtime and its last few ticks and pages Telegram when the agent
 * is missing, silent, or failing. It shares no process with the refresher, so a dead agent
 * cannot silence its own alarm.
 *
 * Exit codes: 0 healthy (or --dry-run), 1 alert detected and sent, 2 could not alert (no
 * Telegram credentials or a send failure; the alert is still printed to stderr).
 */

import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_WATCH_MAX_AGE_MINUTES,
  evaluateSessionWatch,
} from "../lib/f402_session_watch.ts";
import { resolveTelegramCredentials } from "../lib/telegram_alert_sender.ts";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_JOURNAL = join(ROOT, "scratch", "f402-session-refresh.jsonl");
const DEFAULT_RECENT = 6;
const EXIT = { ok: 0, alert: 1, error: 2 } as const;

interface Options {
  readonly journalPath: string;
  readonly maxAgeMinutes: number;
  readonly recent: number;
  readonly dryRun: boolean;
  readonly json: boolean;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseOptions(env: NodeJS.ProcessEnv = Bun.env): Options {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      journal: { type: "string" },
      "max-age-min": { type: "string" },
      recent: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  return {
    journalPath:
      values.journal?.trim() ||
      env.F402_REFRESH_JOURNAL?.trim() ||
      DEFAULT_JOURNAL,
    maxAgeMinutes: positiveNumber(
      values["max-age-min"] ?? env.F402_WATCH_MAX_AGE_MIN,
      DEFAULT_WATCH_MAX_AGE_MINUTES,
    ),
    recent: Math.max(
      3,
      Math.floor(positiveNumber(values.recent, DEFAULT_RECENT)),
    ),
    dryRun: values["dry-run"] ?? false,
    json: values.json ?? false,
  };
}

async function readJournal(
  path: string,
  recent: number,
): Promise<{ mtimeMs: number | null; lines: string[] }> {
  let mtimeMs: number | null = null;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { mtimeMs: null, lines: [] };
  }
  let text = "";
  try {
    text = await Bun.file(path).text();
  } catch {
    text = "";
  }
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return { mtimeMs, lines: lines.slice(-recent) };
}

/** POST one plain-text message to Telegram. Never throws; the caller classifies the result. */
async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
      },
    );
    const body = (await response.json()) as {
      ok?: boolean;
      description?: string;
    };
    if (response.ok && body.ok === true) return { ok: true, detail: "sent" };
    return {
      ok: false,
      detail: `http ${response.status}${body.description === undefined ? "" : `: ${body.description}`}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<number> {
  const options = parseOptions();
  const journal = await readJournal(options.journalPath, options.recent);
  const verdict = evaluateSessionWatch(
    {
      nowMs: Date.now(),
      journalPath: options.journalPath,
      journalMtimeMs: journal.mtimeMs,
      recentLines: journal.lines,
    },
    { maxAgeMinutes: options.maxAgeMinutes },
  );

  if (options.json) console.log(JSON.stringify(verdict, null, 2));
  else console.log(verdict.message);

  if (verdict.status === "ok") return EXIT.ok;
  if (options.dryRun) return EXIT.ok;

  const credentials = await resolveTelegramCredentials();
  if (credentials.source === "none") {
    console.error(
      "f402_session_watch: alert detected but TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are unavailable",
    );
    return EXIT.error;
  }
  const sent = await sendTelegram(
    credentials.botToken,
    credentials.chatId,
    verdict.message,
  );
  if (!sent.ok) {
    console.error(`f402_session_watch: Telegram send failed (${sent.detail})`);
    return EXIT.error;
  }
  console.log(`f402_session_watch: alert sent via ${credentials.source}`);
  return EXIT.alert;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      `f402_session_watch: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(EXIT.error);
  });
