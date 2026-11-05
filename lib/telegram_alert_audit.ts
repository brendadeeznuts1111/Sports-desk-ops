/**
 * @file telegram_alert_audit.ts
 * @description Structured audit of every alert delivered through the desk Telegram path.
 *
 * Why a separate ledger from the dedupe state: the dedupe state answers "was this finding already
 * sent?"; this ledger answers "what alerts reached which chat, when, and with what outcome?".
 * Rows carry the rule id, severity and dedupe key — never the message text — so customer
 * identifiers in an alert body cannot leak through the audit. A SHA-256 of the rendered message
 * plus its character count is enough to correlate a row with a delivery without storing it.
 *
 * Path: `Scratch/watchlist-autobet/telegram-alerts.jsonl` (gitignored).
 * The desk's existing bot activity log (`reports/telegram-activity.jsonl`) remains the source for
 * non-alert messages; `readTelegramActivityLog` exposes its outbound rows for reporting.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type AlertAuditStatus =
  "sent" | "simulated" | "failed" | "deduped" | "rate_limited";

export interface TelegramAlertAuditRow {
  readonly schemaVersion: 1;
  readonly atIso: string;
  readonly source: "flag-alert" | "telegram-activity";
  /** Chat the delivery targeted; null when no chat id could be resolved (simulated path). */
  readonly chatId: string | null;
  /** Operator label for the chat (`TELEGRAM_CHAT_LABEL`, e.g. "deskbotops"), when configured. */
  readonly chatLabel: string | null;
  readonly status: AlertAuditStatus;
  readonly ruleId?: string;
  readonly severity?: string;
  readonly dedupeKey?: string;
  readonly messageId?: number;
  readonly messageChars?: number;
  readonly messageSha256?: string;
  readonly detail?: string;
}

export const ALERT_AUDIT_REL_PATH =
  "Scratch/watchlist-autobet/telegram-alerts.jsonl" as const;
export const TELEGRAM_ACTIVITY_REL_PATH =
  "reports/telegram-activity.jsonl" as const;
export const ALERT_AUDIT_DEFAULT_LIMIT = 100;

export function resolveAlertAuditPath(root: string): string {
  return join(root, ALERT_AUDIT_REL_PATH);
}

export function resolveTelegramActivityPath(root: string): string {
  return join(root, TELEGRAM_ACTIVITY_REL_PATH);
}

/** Append rows atomically enough for an append-only JSONL ledger. */
export async function appendAlertAuditRows(
  root: string,
  rows: readonly TelegramAlertAuditRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  await mkdir(join(root, "Scratch/watchlist-autobet"), { recursive: true });
  await appendFile(
    resolveAlertAuditPath(root),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  return rows.length;
}

function isAuditRow(value: unknown): value is TelegramAlertAuditRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    row["schemaVersion"] === 1 &&
    typeof row["atIso"] === "string" &&
    (row["source"] === "flag-alert" || row["source"] === "telegram-activity") &&
    (row["chatId"] === null || typeof row["chatId"] === "string") &&
    (row["chatLabel"] === null || typeof row["chatLabel"] === "string") &&
    (row["status"] === "sent" ||
      row["status"] === "simulated" ||
      row["status"] === "failed" ||
      row["status"] === "deduped" ||
      row["status"] === "rate_limited")
  );
}

export interface ReadAlertAuditOptions {
  readonly since?: string;
  readonly status?: readonly AlertAuditStatus[];
  readonly limit?: number;
}

/** Read the structured audit, newest first. A missing ledger is empty, never an error. */
export async function readAlertAudit(
  root: string,
  options: ReadAlertAuditOptions = {},
): Promise<TelegramAlertAuditRow[]> {
  let text: string;
  try {
    text = await readFile(resolveAlertAuditPath(root), "utf8");
  } catch {
    return [];
  }
  const sinceMs =
    options.since === undefined ? null : Date.parse(options.since);
  const statuses =
    options.status === undefined ? null : new Set(options.status);
  const rows: TelegramAlertAuditRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isAuditRow(parsed)) continue;
      if (sinceMs !== null && !(Date.parse(parsed.atIso) >= sinceMs)) continue;
      if (statuses !== null && !statuses.has(parsed.status)) continue;
      rows.push(parsed);
    } catch {
      // Malformed lines are skipped; valid rows stay readable.
    }
  }
  rows.sort((a, b) => Date.parse(b.atIso) - Date.parse(a.atIso));
  const limit = options.limit ?? ALERT_AUDIT_DEFAULT_LIMIT;
  return rows.slice(0, Math.max(1, limit));
}

export interface TelegramActivityRow {
  readonly at: string;
  readonly direction: string;
  readonly chatId: string;
  readonly summary: string;
  readonly outcome: string;
  readonly detail?: string;
}

/** Outbound rows from the bot's own activity log, as audit rows (no rule identity). */
export async function readTelegramActivityLog(
  root: string,
): Promise<TelegramAlertAuditRow[]> {
  let text: string;
  try {
    text = await readFile(resolveTelegramActivityPath(root), "utf8");
  } catch {
    return [];
  }
  const rows: TelegramAlertAuditRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as TelegramActivityRow;
      if (parsed.direction !== "out") continue;
      const status: AlertAuditStatus =
        parsed.outcome === "sent"
          ? "sent"
          : parsed.outcome === "simulated"
            ? "simulated"
            : "failed";
      rows.push({
        schemaVersion: 1,
        atIso: parsed.at,
        source: "telegram-activity",
        chatId: parsed.chatId === "" ? null : parsed.chatId,
        chatLabel: null,
        status,
        messageChars: parsed.summary.length,
        ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
      });
    } catch {
      // Skip malformed activity rows.
    }
  }
  return rows;
}

export interface AlertAuditSummary {
  readonly total: number;
  readonly byStatus: Readonly<Record<AlertAuditStatus, number>>;
  readonly chats: readonly string[];
  readonly firstAtIso: string | null;
  readonly lastAtIso: string | null;
}

export function summarizeAlertAudit(
  rows: readonly TelegramAlertAuditRow[],
): AlertAuditSummary {
  const byStatus: Record<AlertAuditStatus, number> = {
    sent: 0,
    simulated: 0,
    failed: 0,
    deduped: 0,
    rate_limited: 0,
  };
  const chats = new Set<string>();
  let first: string | null = null;
  let last: string | null = null;
  for (const row of rows) {
    byStatus[row.status] += 1;
    const chat = row.chatLabel ?? row.chatId;
    if (chat !== null && chat !== "") chats.add(chat);
    if (first === null || Date.parse(row.atIso) < Date.parse(first)) {
      first = row.atIso;
    }
    if (last === null || Date.parse(row.atIso) > Date.parse(last)) {
      last = row.atIso;
    }
  }
  return {
    total: rows.length,
    byStatus,
    chats: [...chats].sort(),
    firstAtIso: first,
    lastAtIso: last,
  };
}

/** SHA-256 of the rendered message, so a row can be correlated without storing its text. */
export async function messageDigest(html: string): Promise<{
  chars: number;
  sha256: string;
}> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(html);
  return { chars: html.length, sha256: hasher.digest("hex") };
}
