/**
 * Reminder sentinel when today's F402 activity weblog JSONL is not staged (manual export path).
 * Does not call Mode A fetch — Cloudflare blocks headless capture.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  defaultDeskDateYmd,
  defaultWeblogCapturePath,
  F402_WEBLOG_OPERATOR_DEFAULT,
} from "./f402_weblog_bridge_inputs.ts";
import { resolveTelegramCredentials } from "./telegram_alert_sender.ts";
import { SportsDeskTelegramService } from "../services/sportsdesk_telegram_bot.ts";

export const WEBLOG_SENTINEL_STATE_REL =
  "scratch/weblog-sentinel-state.json" as const;

export interface WeblogSentinelState {
  readonly schemaVersion: 1;
  /** Desk date (YYYY-MM-DD) we already paged for a missing corpus. */
  readonly lastMissingAlertDeskDate: string | null;
  readonly updatedAt: string;
}

export interface WeblogCorpusProbe {
  readonly deskDateYmd: string;
  readonly displayDate: string;
  readonly paths: readonly string[];
}

export interface WeblogSentinelTickResult {
  readonly deskDateYmd: string;
  readonly corpusPresent: boolean;
  readonly checkedPaths: readonly string[];
  readonly alerted: boolean;
  readonly skippedReason?:
    | "corpus-present"
    | "already-alerted"
    | "dry-run"
    | "telegram-unconfigured"
    | "send-failed";
}

export interface WeblogSentinelTickOptions {
  readonly root?: string;
  readonly now?: () => Date;
  readonly statePath?: string;
  readonly operatorDir?: string;
  readonly dryRun?: boolean;
  readonly exists?: (path: string) => boolean;
  readonly loadState?: () => Promise<WeblogSentinelState>;
  readonly saveState?: (state: WeblogSentinelState) => Promise<void>;
  readonly sendHtml?: (
    chatId: string,
    html: string,
  ) => Promise<{ ok: boolean; description?: string }>;
}

function defaultStatePath(): string {
  const fromEnv = (Bun.env.WEBLOG_SENTINEL_STATE_PATH ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  return resolve(import.meta.dirname, "../scratch/weblog-sentinel-state.json");
}

function defaultRoot(): string {
  return resolve(import.meta.dirname, "..");
}

function displayMmDdYyyy(deskDateYmd: string): string {
  const [year, month, day] = deskDateYmd.split("-");
  return `${month}-${day}-${year}`;
}

export function weblogCorpusProbeForDeskDate(
  root: string,
  deskDateYmd: string,
  operatorDir = F402_WEBLOG_OPERATOR_DEFAULT,
): WeblogCorpusProbe {
  const repoPath = resolve(root, defaultWeblogCapturePath(deskDateYmd));
  const fileName = repoPath.split("/").at(-1) ?? "";
  const operatorPath = join(operatorDir, fileName);
  return {
    deskDateYmd,
    displayDate: displayMmDdYyyy(deskDateYmd),
    paths: [repoPath, operatorPath],
  };
}

export function weblogCorpusPresentOnDisk(
  probe: WeblogCorpusProbe,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return probe.paths.some((path) => exists(path));
}

export async function loadWeblogSentinelState(
  path = defaultStatePath(),
): Promise<WeblogSentinelState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as WeblogSentinelState;
    if (parsed?.schemaVersion === 1) return parsed;
  } catch {
    /* first run */
  }
  return {
    schemaVersion: 1,
    lastMissingAlertDeskDate: null,
    updatedAt: new Date(0).toISOString(),
  };
}

export async function saveWeblogSentinelState(
  state: WeblogSentinelState,
  path = defaultStatePath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export function formatWeblogSentinelMessage(probe: WeblogCorpusProbe): string {
  const esc = (text: string) => Bun.escapeHTML(text);
  const paths = probe.paths.map((p) => `• ${esc(p)}`).join("\n");
  return [
    "⚠️ <b>Weblog export missing</b>",
    `No activity JSONL for desk date <code>${esc(probe.displayDate)}</code>.`,
    "",
    "Checked:",
    paths,
    "",
    "<b>Action:</b> Export Mode A activity from the F402 portal, save as",
    `<code>out/f402/weblog/${esc(probe.displayDate)}.jsonl</code>,`,
    "then <code>bun run weblog:rollup --from &lt;path&gt;</code>.",
    "(Headless <code>--fetch-mode A</code> is blocked by Cloudflare — manual export only.)",
  ].join("\n");
}

export async function runWeblogSentinelTick(
  options: WeblogSentinelTickOptions = {},
): Promise<WeblogSentinelTickResult> {
  const now = options.now ?? (() => new Date());
  const root = options.root ?? defaultRoot();
  const statePath = options.statePath ?? defaultStatePath();
  const exists = options.exists ?? existsSync;
  const deskDateYmd = defaultDeskDateYmd(now());
  const probe = weblogCorpusProbeForDeskDate(
    root,
    deskDateYmd,
    options.operatorDir,
  );
  const corpusPresent = weblogCorpusPresentOnDisk(probe, exists);

  const state =
    options.loadState === undefined
      ? await loadWeblogSentinelState(statePath)
      : await options.loadState();
  const save =
    options.saveState ?? ((s) => saveWeblogSentinelState(s, statePath));

  if (corpusPresent) {
    return {
      deskDateYmd,
      corpusPresent: true,
      checkedPaths: probe.paths,
      alerted: false,
      skippedReason: "corpus-present",
    };
  }

  if (state.lastMissingAlertDeskDate === deskDateYmd) {
    return {
      deskDateYmd,
      corpusPresent: false,
      checkedPaths: probe.paths,
      alerted: false,
      skippedReason: "already-alerted",
    };
  }

  const html = formatWeblogSentinelMessage(probe);

  if (options.dryRun === true) {
    console.error(`[weblog-sentinel] dry-run:\n${html}`);
    await save({
      schemaVersion: 1,
      lastMissingAlertDeskDate: deskDateYmd,
      updatedAt: now().toISOString(),
    });
    return {
      deskDateYmd,
      corpusPresent: false,
      checkedPaths: probe.paths,
      alerted: false,
      skippedReason: "dry-run",
    };
  }

  const creds = await resolveTelegramCredentials();
  const send =
    options.sendHtml ??
    (async (chatId, messageHtml) => {
      const bot = new SportsDeskTelegramService({
        botToken: creds.botToken,
        chatId: creds.chatId,
        activityLogPath: null,
      });
      return bot.sendMessage(chatId, messageHtml, { parse_mode: "HTML" });
    });

  if (options.sendHtml === undefined && creds.source === "none") {
    console.error(
      "[weblog-sentinel] Telegram not configured; missing corpus recorded without send",
    );
    await save({
      schemaVersion: 1,
      lastMissingAlertDeskDate: deskDateYmd,
      updatedAt: now().toISOString(),
    });
    return {
      deskDateYmd,
      corpusPresent: false,
      checkedPaths: probe.paths,
      alerted: false,
      skippedReason: "telegram-unconfigured",
    };
  }

  const chatId = creds.chatId !== "" ? creds.chatId : "injected";
  const sent = await send(chatId, html);
  await save({
    schemaVersion: 1,
    lastMissingAlertDeskDate: deskDateYmd,
    updatedAt: now().toISOString(),
  });

  const result: WeblogSentinelTickResult = {
    deskDateYmd,
    corpusPresent: false,
    checkedPaths: probe.paths,
    alerted: sent.ok === true,
  };
  if (sent.ok !== true) {
    return { ...result, skippedReason: "send-failed" };
  }
  return result;
}
