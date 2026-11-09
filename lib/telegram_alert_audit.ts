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

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
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
  /** Alerted bettor and the bet dimensions, so alert-tied performance is answerable later. */
  readonly customerId?: string;
  /** Join keys back to the source bet/outcome store. */
  readonly betKey?: string;
  readonly ticketNumber?: string;
  readonly wagerNumber?: string;
  readonly sport?: string;
  readonly subSport?: string;
  readonly period?: string;
  readonly wagerType?: string;
  readonly marketType?: string;
  readonly line?: number | null;
  readonly side?: string | null;
  readonly stakeUsd?: number | null;
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
/** Retention: audit JSONL is capped so a long-running daemon cannot grow it unbounded. */
export const ALERT_AUDIT_MAX_BYTES = 5 * 1024 * 1024;
export const ALERT_AUDIT_KEEP_LINES = 5_000;

export interface AppendAlertAuditOptions {
  readonly maxBytes?: number;
  readonly keepLines?: number;
}

async function trimAuditIfNeeded(
  path: string,
  options: AppendAlertAuditOptions,
): Promise<void> {
  const maxBytes = options.maxBytes ?? ALERT_AUDIT_MAX_BYTES;
  try {
    const info = await stat(path);
    if (info.size <= maxBytes) return;
  } catch {
    return;
  }
  const lines = (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "");
  const keep = Math.max(1, options.keepLines ?? ALERT_AUDIT_KEEP_LINES);
  const tail = lines.slice(-keep);
  await Bun.write(path, `${tail.join("\n")}\n`);
}

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
  options: AppendAlertAuditOptions = {},
): Promise<number> {
  if (rows.length === 0) return 0;
  await mkdir(join(root, "Scratch/watchlist-autobet"), { recursive: true });
  const path = resolveAlertAuditPath(root);
  await trimAuditIfNeeded(path, options);
  await appendFile(
    path,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  return rows.length;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  );
}

/** Strip optional fields whose wire type is wrong, so a malformed line is skipped, not thrown. */
function sanitizeOptionalFields(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...row };
  for (const key of [
    "ruleId",
    "severity",
    "dedupeKey",
    "customerId",
    "betKey",
    "ticketNumber",
    "wagerNumber",
    "sport",
    "subSport",
    "period",
    "wagerType",
    "marketType",
    "messageSha256",
    "detail",
  ]) {
    if (!isOptionalString(out[key])) delete out[key];
  }
  for (const key of ["messageId", "messageChars", "stakeUsd"]) {
    if (!isOptionalNumber(out[key])) delete out[key];
  }
  for (const key of ["line"]) {
    if (
      out[key] !== undefined &&
      !(typeof out[key] === "number" && Number.isFinite(out[key]))
    ) {
      delete out[key];
    }
  }
  for (const key of ["side"]) {
    if (out[key] !== undefined && typeof out[key] !== "string") delete out[key];
  }
  return out;
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
      const sanitized = sanitizeOptionalFields(
        parsed as unknown as Record<string, unknown>,
      ) as unknown as TelegramAlertAuditRow;
      if (sinceMs !== null && !(Date.parse(sanitized.atIso) >= sinceMs))
        continue;
      if (statuses !== null && !statuses.has(sanitized.status)) continue;
      rows.push(sanitized);
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

/** Stable identity for backfilled activity rows so a re-run imports nothing twice. */
function auditRowKey(row: TelegramAlertAuditRow): string {
  return [
    row.atIso,
    row.source,
    row.chatId ?? "",
    row.chatLabel ?? "",
    row.status,
    row.ruleId ?? "",
    row.messageChars ?? "",
    row.detail ?? "",
  ].join("|");
}

/**
 * Import the bot's own outbound activity rows into the structured audit ledger. This is what
 * makes the audit cover messages that never went through the flag sender (pulses, reports,
 * staleness alerts). Existing rows are deduplicated by a stable key, so re-running is idempotent.
 */
export async function backfillAlertAuditFromActivity(
  root: string,
  options: { readonly since?: string; readonly maxBytes?: number } = {},
): Promise<{ imported: number; skipped: number; activityRows: number }> {
  const existing = await readAlertAudit(root, {
    limit: ALERT_AUDIT_DEFAULT_LIMIT,
  });
  // readAlertAudit applies a limit; read the full ledger directly for dedupe.
  let existingKeys = new Set(existing.map(auditRowKey));
  try {
    const text = await readFile(resolveAlertAuditPath(root), "utf8");
    existingKeys = new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => {
          try {
            const parsed: unknown = JSON.parse(line);
            return isAuditRow(parsed) ? auditRowKey(parsed) : null;
          } catch {
            return null;
          }
        })
        .filter((key): key is string => key !== null),
    );
  } catch {
    // Missing ledger: every activity row is new.
  }
  const activity = await readTelegramActivityLog(root);
  const sinceMs =
    options.since === undefined ? null : Date.parse(options.since);
  const rows: TelegramAlertAuditRow[] = [];
  let skipped = 0;
  for (const row of activity) {
    if (sinceMs !== null && !(Date.parse(row.atIso) >= sinceMs)) continue;
    const key = auditRowKey(row);
    if (existingKeys.has(key)) {
      skipped += 1;
      continue;
    }
    existingKeys.add(key);
    rows.push(row);
  }
  await appendAlertAuditRows(
    root,
    rows,
    options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes },
  );
  return { imported: rows.length, skipped, activityRows: activity.length };
}

export interface AlertAnalyticsBucket {
  readonly key: string;
  readonly total: number;
  readonly sent: number;
  readonly simulated: number;
  readonly failed: number;
  readonly deduped: number;
  readonly rateLimited: number;
}

function bucketOf(key: string): AlertAnalyticsBucket {
  return {
    key,
    total: 0,
    sent: 0,
    simulated: 0,
    failed: 0,
    deduped: 0,
    rateLimited: 0,
  };
}

function addToBucket(
  bucket: AlertAnalyticsBucket,
  row: TelegramAlertAuditRow,
): void {
  // Buckets are mutable during the rollup only; the returned view is frozen by the caller.
  (bucket as { total: number }).total += 1;
  const mutable = bucket as unknown as {
    sent: number;
    simulated: number;
    failed: number;
    deduped: number;
    rateLimited: number;
  };
  if (row.status === "sent") mutable.sent += 1;
  else if (row.status === "simulated") mutable.simulated += 1;
  else if (row.status === "failed") mutable.failed += 1;
  else if (row.status === "deduped") mutable.deduped += 1;
  else mutable.rateLimited += 1;
}

function rollup(
  rows: readonly TelegramAlertAuditRow[],
  keyFor: (row: TelegramAlertAuditRow) => string,
): AlertAnalyticsBucket[] {
  const buckets = new Map<string, AlertAnalyticsBucket>();
  for (const row of rows) {
    const key = keyFor(row);
    const bucket = buckets.get(key) ?? bucketOf(key);
    addToBucket(bucket, row);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Per-day delivery counts (UTC date of `atIso`). */
export function dailyAlertRollup(
  rows: readonly TelegramAlertAuditRow[],
): AlertAnalyticsBucket[] {
  return rollup(rows, (row) => row.atIso.slice(0, 10));
}

/** Per-chat delivery counts, labelled when a label was recorded. */
export function chatAlertRollup(
  rows: readonly TelegramAlertAuditRow[],
): AlertAnalyticsBucket[] {
  return rollup(rows, (row) => row.chatLabel ?? row.chatId ?? "unknown");
}

/** Per-severity counts for flag alerts (`telegram-activity` rows have no severity). */
export function severityAlertRollup(
  rows: readonly TelegramAlertAuditRow[],
): AlertAnalyticsBucket[] {
  return rollup(rows, (row) => row.severity ?? "(none)");
}

/** Per-rule counts for flag alerts (`telegram-activity` rows have no rule id). */
export function ruleAlertRollup(
  rows: readonly TelegramAlertAuditRow[],
): AlertAnalyticsBucket[] {
  return rollup(rows, (row) => row.ruleId ?? "(activity)");
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
