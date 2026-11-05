/**
 * @file lib/telegram_alert_sender.ts
 * @description Deduped Telegram delivery for incoming-bet flag findings.
 *
 * Contract: `Scratch/bet-flags/BUILD-CONTRACT.md` (section "lib/telegram_alert_sender.ts").
 *
 * - Credentials: `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` from the environment first, then
 *   `Bun.secrets` services `bookdeskops.desk`, `sportsdesk-ops`, `4c-odds-integration` (the same
 *   order `scripts/live_positions_cron.ts` uses). No new env names.
 * - Dedupe: `Scratch/watchlist-autobet/alert-state.json` (gitignored), schemaVersion 1, atomic
 *   tmp+rename write, 7-day TTL. A corrupt state file fails open (reset to empty) rather than
 *   dropping every alert; the reset itself is not a delivery outcome, so it never appears as a
 *   fabricated "sent" row.
 * - Batching: findings are packed greedily into at most `maxMessages` Telegram messages
 *   (default 1). Findings that cannot fit the message budget are reported as `rate_limited`
 *   (the closest contract outcome for "the cap prevented sending"), never silently dropped.
 * - Dry run: never resolves the keychain, never constructs a live sender, never calls Telegram,
 *   and never advances the dedupe ledger. It still READS the ledger, so a finding a real run
 *   already delivered is reported `deduped` (an honest preview), but repeated dry runs keep
 *   reporting the same findings as `simulated` and can never consume a real run's dedupe window.
 *
 * The sender is read-only over the desk's data; its one write is the dedupe state file.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { SportsDeskTelegramService } from "../services/sportsdesk_telegram_bot.ts";
import { FLAG_SEVERITIES } from "./bet_flags.ts";
import type { BetFlagFinding, FlagSeverity } from "./bet_flags.ts";
import {
  appendAlertAuditRows,
  messageDigest,
  type TelegramAlertAuditRow,
} from "./telegram_alert_audit.ts";

/* -------------------------------------------------------------------------- */
/* Public shapes (frozen by the build contract)                                */
/* -------------------------------------------------------------------------- */

export interface AlertDelivery {
  readonly dedupeKey: string;
  readonly ruleId: string;
  readonly severity: FlagSeverity;
  readonly outcome:
    "sent" | "simulated" | "deduped" | "rate_limited" | "failed";
  readonly chatId: string | null;
  readonly messageId?: number;
  readonly detail?: string;
}

export interface AlertRunSummary {
  readonly scannedFindings: number;
  readonly sent: number;
  readonly simulated: number;
  readonly deduped: number;
  readonly rateLimited: number;
  readonly failed: number;
}

export interface DeliverFlagAlertsOptions {
  /** When set, every delivery outcome is appended to the structured alert audit under this root. */
  readonly audit?: {
    readonly root: string;
    /** Operator label for the target chat (e.g. "deskbotops"); recorded on each audit row. */
    readonly chatLabel?: string;
  };
  readonly dryRun?: boolean;
  readonly chatId?: string;
  readonly statePath?: string;
  readonly minSeverity?: FlagSeverity;
  readonly maxMessages?: number;
  readonly now?: Date;
  readonly credentials?: { readonly botToken: string; readonly chatId: string };
  /**
   * Test seam: replace the `SportsDeskTelegramService.sendMessage` call so the live (non-dry-run)
   * code path can be exercised offline. Production never passes it.
   */
  readonly sendMessage?: FlagMessageSender;
}

/** What a live send needs to return (mirrors `SportsDeskTelegramService.sendMessage`). */
export type FlagMessageSender = (
  chatId: string,
  html: string,
) => Promise<{ ok: boolean; message_id?: number; description?: string }>;

export interface AlertRunResult {
  readonly ok: boolean;
  readonly deliveries: AlertDelivery[];
  readonly summary: AlertRunSummary;
  readonly reason?: string;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const ALERT_STATE_REL_PATH =
  "Scratch/watchlist-autobet/alert-state.json" as const;
export const ALERT_STATE_SCHEMA_VERSION = 1 as const;
/** A dedupe key suppresses a repeat alert for this long. */
export const ALERT_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Telegram's hard `sendMessage` text limit. */
export const TELEGRAM_TEXT_LIMIT = 4096;
/** Per-message character budget; leaves headroom below the hard limit. */
export const ALERT_MESSAGE_CHAR_BUDGET = 3800;
/** Placeholders that mean "not configured"; treated as absent, never as a secret. */
const UNCONFIGURED_VALUES: ReadonlySet<string> = new Set([
  "SET_BEFORE_PRODUCTION",
  "CHANGEME",
  "TODO",
]);
const TELEGRAM_SECRET_SERVICES: readonly string[] = [
  "bookdeskops.desk",
  "sportsdesk-ops",
  "4c-odds-integration",
];
const SEND_TIMEOUT_MS = 10_000;

/* -------------------------------------------------------------------------- */
/* Credentials                                                                 */
/* -------------------------------------------------------------------------- */

function cleanCredential(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return UNCONFIGURED_VALUES.has(trimmed) ? "" : trimmed;
}

async function keychainSecret(name: string): Promise<string> {
  for (const service of TELEGRAM_SECRET_SERVICES) {
    try {
      const raw = await Bun.secrets.get({ service, name });
      const cleaned = cleanCredential(raw ?? undefined);
      if (cleaned !== "") return cleaned;
    } catch {
      // A missing/locked keychain entry is "not configured here", not a crash at the CLI edge.
    }
  }
  return "";
}

/**
 * Environment first (fully configured env wins without touching the keychain), then the three
 * documented `Bun.secrets` services. `source` names where the values actually came from;
 * `"none"` means at least one of the pair is still missing.
 */
export async function resolveTelegramCredentials(
  env?: NodeJS.ProcessEnv,
): Promise<{
  botToken: string;
  chatId: string;
  source: "env" | "keychain" | "none";
}> {
  const effectiveEnv = env ?? process.env;
  let botToken = cleanCredential(effectiveEnv.TELEGRAM_BOT_TOKEN);
  let chatId = cleanCredential(effectiveEnv.TELEGRAM_CHAT_ID);
  if (botToken !== "" && chatId !== "") {
    return { botToken, chatId, source: "env" };
  }
  let usedKeychain = false;
  if (botToken === "") {
    botToken = await keychainSecret("TELEGRAM_BOT_TOKEN");
    usedKeychain = botToken !== "";
  }
  if (chatId === "") {
    chatId = await keychainSecret("TELEGRAM_CHAT_ID");
    usedKeychain = usedKeychain || chatId !== "";
  }
  if (botToken === "" || chatId === "") {
    return { botToken, chatId, source: "none" };
  }
  return { botToken, chatId, source: usedKeychain ? "keychain" : "env" };
}

/* -------------------------------------------------------------------------- */
/* Rendering (Telegram HTML parse mode)                                        */
/* -------------------------------------------------------------------------- */

/** Telegram HTML parse mode: only `& < >` must be escaped; everything else is data. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function usd(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

function odds(value: number | null): string {
  if (value === null) return "—";
  return value > 0 ? `+${value}` : `${value}`;
}

function severityRank(severity: FlagSeverity): number {
  return FLAG_SEVERITIES.indexOf(severity);
}

function meetsMinimum(
  severity: FlagSeverity,
  minimum: FlagSeverity | undefined,
): boolean {
  if (minimum === undefined) return true;
  return severityRank(severity) >= severityRank(minimum);
}

function renderFinding(finding: BetFlagFinding): string {
  const bet = finding.bet;
  const lines: string[] = [
    `[${finding.severity.toUpperCase()}] <b>${escapeHtml(clip(finding.ruleTitle, 120))}</b> <code>${escapeHtml(finding.ruleId)}</code>`,
    `customer <code>${escapeHtml(clip(bet.customerId, 40))}</code> · agent <code>${escapeHtml(clip(bet.agentId, 40))}</code> · ${escapeHtml(bet.channel)}`,
    `bet <code>${escapeHtml(clip(bet.betKey, 80))}</code> · stake ${usd(bet.stakeUsd)} · odds ${odds(bet.americanOdds)}${bet.isLive ? " · LIVE" : ""}`,
    `selection ${escapeHtml(clip(bet.selection, 80))}`,
    `matched ${escapeHtml(finding.matchedAt)}`,
  ];
  return lines.join("\n");
}

/** One Telegram-HTML message for a batch of findings. User-controlled text is escaped. */
export function renderAlertMessage(
  findings: readonly BetFlagFinding[],
): string {
  const header = `<b>SportsDesk bet flags</b> — ${findings.length} finding${findings.length === 1 ? "" : "s"}`;
  if (findings.length === 0) return header;
  return [header, "", ...findings.map(renderFinding)].join("\n\n");
}

function clampMessage(html: string): string {
  if (html.length <= TELEGRAM_TEXT_LIMIT) return html;
  const suffix = "\n…";
  return `${html.slice(0, TELEGRAM_TEXT_LIMIT - suffix.length)}${suffix}`;
}

/* -------------------------------------------------------------------------- */
/* Dedupe state                                                                */
/* -------------------------------------------------------------------------- */

interface AlertStateEntry {
  readonly ruleId: string;
  readonly severity: FlagSeverity;
  readonly deliveredAt: string;
}

interface AlertStateFile {
  readonly schemaVersion: 1;
  readonly deliveries: Record<string, AlertStateEntry>;
}

interface LoadedAlertState {
  readonly entries: Map<string, AlertStateEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSeverity(value: unknown): value is FlagSeverity {
  return (
    typeof value === "string" &&
    (FLAG_SEVERITIES as readonly string[]).includes(value)
  );
}

/** Read + validate + prune (7-day TTL). A missing file is an empty state, never an error. */
async function loadAlertState(
  statePath: string,
  now: Date,
): Promise<LoadedAlertState> {
  let text: string;
  try {
    text = await readFile(statePath, "utf8");
  } catch {
    // The file is either absent (normal first run) or unreadable. Both fail open to an empty
    // state: refusing every alert because one file cannot be read loses more than it saves.
    return { entries: new Map() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { entries: new Map() };
  }
  if (
    !isRecord(parsed) ||
    parsed["schemaVersion"] !== ALERT_STATE_SCHEMA_VERSION ||
    !isRecord(parsed["deliveries"])
  ) {
    return { entries: new Map() };
  }
  const entries = new Map<string, AlertStateEntry>();
  const cutoff = now.getTime() - ALERT_DEDUPE_TTL_MS;
  for (const [key, rawEntry] of Object.entries(parsed["deliveries"])) {
    if (!isRecord(rawEntry)) continue;
    const deliveredAt = rawEntry["deliveredAt"];
    const ruleId = rawEntry["ruleId"];
    const severity = rawEntry["severity"];
    if (
      typeof deliveredAt !== "string" ||
      typeof ruleId !== "string" ||
      !isSeverity(severity)
    ) {
      continue;
    }
    const at = Date.parse(deliveredAt);
    if (!Number.isFinite(at) || at < cutoff) continue;
    entries.set(key, { ruleId, severity, deliveredAt });
  }
  return { entries };
}

/** Atomic tmp+rename so a crash mid-write cannot leave a half-parsed dedupe ledger. */
async function saveAlertState(
  statePath: string,
  entries: ReadonlyMap<string, AlertStateEntry>,
): Promise<void> {
  const deliveries: Record<string, AlertStateEntry> = {};
  for (const [key, entry] of entries) deliveries[key] = entry;
  const state: AlertStateFile = {
    schemaVersion: ALERT_STATE_SCHEMA_VERSION,
    deliveries,
  };
  await mkdir(dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmpPath, statePath);
}

/* -------------------------------------------------------------------------- */
/* Delivery                                                                   */
/* -------------------------------------------------------------------------- */

interface MessageBatch {
  readonly findings: BetFlagFinding[];
}

/** Greedy pack into messages under the Telegram budget, then cut at `maxMessages`. */
function batchFindings(
  findings: readonly BetFlagFinding[],
  maxMessages: number,
): { batches: MessageBatch[]; overflow: BetFlagFinding[] } {
  const batches: MessageBatch[] = [];
  let current: BetFlagFinding[] = [];
  for (const finding of findings) {
    if (current.length === 0) {
      current = [finding];
      continue;
    }
    const candidate = [...current, finding];
    if (renderAlertMessage(candidate).length > ALERT_MESSAGE_CHAR_BUDGET) {
      batches.push({ findings: current });
      current = [finding];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push({ findings: current });
  const kept = batches.slice(0, maxMessages);
  const overflow = batches
    .slice(maxMessages)
    .flatMap((batch) => batch.findings);
  return { batches: kept, overflow };
}

function isRateLimitDescription(description: string | undefined): boolean {
  if (description === undefined) return false;
  return /too many requests|retry.?after|\b429\b/i.test(description);
}

function countOutcome(
  deliveries: readonly AlertDelivery[],
  outcome: AlertDelivery["outcome"],
): number {
  return deliveries.filter((delivery) => delivery.outcome === outcome).length;
}

/**
 * Deliver flag findings to Telegram with a 7-day dedupe ledger.
 *
 * Contract edge cases:
 * - `dryRun` never resolves credentials, constructs a sender, or calls Telegram.
 * - Findings below `minSeverity` (default: everything) get no delivery row at all.
 * - Missing credentials on a live run: `ok:false`, `reason:"telegram_credentials_missing"`,
 *   every eligible finding `failed`; the dedupe ledger is not advanced.
 * - A `429`/retry-after failure stops the remaining batches as `rate_limited`.
 */
export async function deliverFlagAlerts(
  findings: readonly BetFlagFinding[],
  options: DeliverFlagAlertsOptions = {},
): Promise<AlertRunResult> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const minSeverity = options.minSeverity;
  const maxMessages = Math.max(1, Math.floor(options.maxMessages ?? 1));
  const statePath = options.statePath ?? ALERT_STATE_REL_PATH;
  const deliveries: AlertDelivery[] = [];
  const digests = new Map<string, { chars: number; sha256: string }>();
  const track = async (): Promise<void> => {
    if (options.audit === undefined || deliveries.length === 0) return;
    const atIso = now.toISOString();
    const rows: TelegramAlertAuditRow[] = deliveries.map((delivery) => {
      const digest = digests.get(delivery.dedupeKey);
      return {
        schemaVersion: 1,
        atIso,
        source: "flag-alert",
        chatId: delivery.chatId,
        chatLabel: options.audit?.chatLabel ?? null,
        status: delivery.outcome,
        ruleId: delivery.ruleId,
        severity: delivery.severity,
        dedupeKey: delivery.dedupeKey,
        ...(delivery.messageId === undefined
          ? {}
          : { messageId: delivery.messageId }),
        ...(digest === undefined
          ? {}
          : { messageChars: digest.chars, messageSha256: digest.sha256 }),
        ...(delivery.detail === undefined ? {} : { detail: delivery.detail }),
      };
    });
    await appendAlertAuditRows(options.audit.root, rows);
  };

  const eligible = findings.filter((finding) =>
    meetsMinimum(finding.severity, minSeverity),
  );

  if (eligible.length === 0) {
    const summary = summarize(findings.length, deliveries);
    return { ok: true, deliveries, summary };
  }

  const loadedState = await loadAlertState(statePath, now);
  const state = loadedState.entries;
  const pending: BetFlagFinding[] = [];
  for (const finding of eligible) {
    if (state.has(finding.dedupeKey)) {
      deliveries.push({
        dedupeKey: finding.dedupeKey,
        ruleId: finding.ruleId,
        severity: finding.severity,
        outcome: "deduped",
        chatId: null,
        detail: `already delivered at ${state.get(finding.dedupeKey)?.deliveredAt ?? "unknown"}`,
      });
      continue;
    }
    pending.push(finding);
  }

  let targetChatId: string | null = options.chatId ?? null;
  let botToken = options.credentials?.botToken ?? "";
  if (!dryRun) {
    if (options.credentials !== undefined) {
      botToken = options.credentials.botToken;
      targetChatId = options.chatId ?? options.credentials.chatId;
    } else {
      const resolved = await resolveTelegramCredentials();
      botToken = resolved.botToken;
      targetChatId = options.chatId ?? (resolved.chatId || null);
    }
    if (!botToken || targetChatId === null || targetChatId === "") {
      for (const finding of pending) {
        deliveries.push({
          dedupeKey: finding.dedupeKey,
          ruleId: finding.ruleId,
          severity: finding.severity,
          outcome: "failed",
          chatId: targetChatId === "" ? null : targetChatId,
          detail: "telegram_credentials_missing",
        });
      }
      await track();
      return {
        ok: false,
        deliveries,
        summary: summarize(findings.length, deliveries),
        reason: "telegram_credentials_missing",
      };
    }
  }

  const { batches, overflow } = batchFindings(pending, maxMessages);
  let stoppedByRateLimit = false;
  let dirty = false;

  let sendMessage: FlagMessageSender | null = null;
  if (!dryRun) {
    if (options.sendMessage !== undefined) {
      sendMessage = options.sendMessage;
    } else {
      const service = new SportsDeskTelegramService({
        botToken,
        chatId: targetChatId ?? "",
        // The sender owns exactly one write (the dedupe ledger); no reports/ activity write.
        activityLogPath: null,
      });
      sendMessage = (chatId, html) =>
        service.sendMessage(chatId, html, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
          timeoutMs: SEND_TIMEOUT_MS,
        });
    }
  }
  const liveChatId = targetChatId ?? "";
  if (!dryRun && liveChatId === "") {
    throw new Error("internal: live alert delivery requires a chat id");
  }

  let processedBatches = 0;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    if (stoppedByRateLimit) break;
    const batch = batches[batchIndex];
    if (batch === undefined) continue;
    processedBatches = batchIndex + 1;
    const html = clampMessage(renderAlertMessage(batch.findings));
    const digest = await messageDigest(html);
    for (const finding of batch.findings) {
      digests.set(finding.dedupeKey, digest);
    }
    if (dryRun) {
      for (const finding of batch.findings) {
        deliveries.push({
          dedupeKey: finding.dedupeKey,
          ruleId: finding.ruleId,
          severity: finding.severity,
          outcome: "simulated",
          chatId: targetChatId,
          detail: "dry_run",
        });
      }
      continue;
    }
    if (sendMessage === null) {
      throw new Error("internal: non-dry delivery without a sender");
    }
    const result = await sendMessage(liveChatId, html);
    if (result.ok) {
      for (const finding of batch.findings) {
        deliveries.push({
          dedupeKey: finding.dedupeKey,
          ruleId: finding.ruleId,
          severity: finding.severity,
          outcome: "sent",
          chatId: targetChatId,
          ...(result.message_id === undefined
            ? {}
            : { messageId: result.message_id }),
        });
        state.set(finding.dedupeKey, {
          ruleId: finding.ruleId,
          severity: finding.severity,
          deliveredAt: now.toISOString(),
        });
        dirty = true;
      }
      continue;
    }
    const rateLimited = isRateLimitDescription(result.description);
    for (const finding of batch.findings) {
      deliveries.push({
        dedupeKey: finding.dedupeKey,
        ruleId: finding.ruleId,
        severity: finding.severity,
        outcome: rateLimited ? "rate_limited" : "failed",
        chatId: targetChatId,
        detail: result.description ?? "telegram_send_failed",
      });
    }
    stoppedByRateLimit = rateLimited;
  }

  // A 429 stops the remaining batches; those findings and anything the message budget could not
  // carry are explicitly `rate_limited`, never silently dropped from the delivery ledger.
  const unprocessed = batches
    .slice(processedBatches)
    .flatMap((batch) => batch.findings);
  for (const finding of [...unprocessed, ...overflow]) {
    deliveries.push({
      dedupeKey: finding.dedupeKey,
      ruleId: finding.ruleId,
      severity: finding.severity,
      outcome: "rate_limited",
      chatId: targetChatId,
      detail: stoppedByRateLimit
        ? "telegram_rate_limited"
        : `max_messages_exceeded:${maxMessages}`,
    });
  }

  if (dirty) await saveAlertState(statePath, state);

  await track();
  const summary = summarize(findings.length, deliveries);
  const reason = summary.failed > 0 ? "telegram_send_failed" : undefined;
  return {
    ok: summary.failed === 0,
    deliveries,
    summary,
    ...(reason === undefined ? {} : { reason }),
  };
}

function summarize(
  scannedFindings: number,
  deliveries: readonly AlertDelivery[],
): AlertRunSummary {
  return {
    scannedFindings,
    sent: countOutcome(deliveries, "sent"),
    simulated: countOutcome(deliveries, "simulated"),
    deduped: countOutcome(deliveries, "deduped"),
    rateLimited: countOutcome(deliveries, "rate_limited"),
    failed: countOutcome(deliveries, "failed"),
  };
}
