/**
 * @file lib/audit_log.ts
 * @description Append-only structured JSONL audit logger with lifecycle rotation, retention pruning,
 * strict POSIX file permissions (0700/0600), and POSIX PIPE_BUF atomic write safety.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

export type AuditCategory =
  | "auth"
  | "pty"
  | "wager"
  | "config"
  | "alert_queued"
  | "alert_delivered"
  | "alert_delivery_failed"
  | "alert_dead"
  | "alert_acknowledged"
  | "alert_retried";

export interface AuditActor {
  operatorId?: number | undefined;
  username?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface AuditEntry {
  ts: string;
  category: AuditCategory;
  action: string;
  success: boolean;
  actor?: AuditActor | undefined;
  target?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

// ── Tunables & Invariants ───────────────────────────────────────────────────
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_RETENTION_DAYS = 90; // 90 days
export const MAX_FIELD_BYTES = 1024; // 1 KB max per individual string field
export const PIPE_BUF_LIMIT = 4096; // Linux POSIX pipe buffer for atomic append

const SENSITIVE_KEY_PATTERN =
  /pass|token|secret|key|auth|bearer|cookie|credential/i;

/**
 * Parses an environment integer with an explicit floor and fallback.
 * Prevents NaN, negative numbers, or sub-minimum loops from bypassing bounds.
 */
export function parsePositiveInt(
  v: string | undefined,
  fallback: number,
  min: number,
): number {
  if (v === undefined || v === null || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= min ? n : fallback;
}

/**
 * Returns the configured audit log directory (default: "audit").
 */
export function getAuditDirectory(): string {
  return process.env.SPORTSDESK_AUDIT_DIR || "audit";
}

/**
 * Returns the maximum file size before rotating (default: 50MB, floor: 1MB or 100B in test).
 */
export function getMaxFileBytes(): number {
  const minFloor = process.env.NODE_ENV === "test" ? 100 : 1024 * 1024;
  return parsePositiveInt(
    process.env.SPORTSDESK_AUDIT_MAX_BYTES,
    DEFAULT_MAX_FILE_BYTES,
    minFloor,
  );
}

/**
 * Returns the retention window in days (default: 90 days, floor: 1 day).
 */
export function getRetentionDays(): number {
  return parsePositiveInt(
    process.env.SPORTSDESK_AUDIT_RETENTION_DAYS,
    DEFAULT_RETENTION_DAYS,
    1,
  );
}

/**
 * Ensures the audit directory exists with strict private permissions (0700).
 * Prevents unauthorized local processes from listing or reading audit records.
 */
export function ensureAuditDir(): string {
  const dir = getAuditDirectory();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(dir, 0o700);
  } catch (err) {
    if (process.env.DEBUG_TRACE === "1") {
      console.warn("[audit] chmod dir failed:", err);
    }
  }
  return dir;
}

/**
 * Truncates an oversized string field to stay strictly within POSIX write budgets.
 */
export function truncateField(
  val: unknown,
  maxBytes = MAX_FIELD_BYTES,
): unknown {
  if (typeof val !== "string") return val;
  const buf = Buffer.from(val, "utf8");
  if (buf.byteLength <= maxBytes) return val;
  return buf.subarray(0, maxBytes).toString("utf8") + "…[truncated]";
}

/**
 * Deeply sanitizes an object to redact sensitive keys and truncate long fields.
 */
export function sanitizeAuditData<T>(val: T, maxBytes = MAX_FIELD_BYTES): T {
  if (val === null || val === undefined) return val;
  if (typeof val === "string")
    return truncateField(val, maxBytes) as unknown as T;
  if (typeof val !== "object") return val;

  if (Array.isArray(val)) {
    return val.map((item) => sanitizeAuditData(item, maxBytes)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null) {
      out[k] = sanitizeAuditData(v, maxBytes);
    } else {
      out[k] = truncateField(v, maxBytes);
    }
  }
  return out as T;
}

/**
 * Resolves the path to the daily audit JSONL file with optional rotation index.
 */
export function getAuditFilePath(date = new Date(), index = 0): string {
  const dir = getAuditDirectory();
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const suffix = index > 0 ? `.${index}` : "";
  return join(dir, `audit-${yyyy}-${mm}-${dd}${suffix}.jsonl`);
}

/**
 * Finds the currently active daily log file, rotating to an indexed file (.1, .2)
 * if the current file exceeds the configured maximum size.
 */
export function getActiveAuditFilePath(date = new Date()): string {
  ensureAuditDir();
  const maxBytes = getMaxFileBytes();
  let index = 0;

  while (true) {
    const filePath = getAuditFilePath(date, index);
    if (!existsSync(filePath)) {
      return filePath;
    }
    try {
      const stats = statSync(filePath);
      if (stats.size < maxBytes) {
        return filePath;
      }
    } catch {
      return filePath;
    }
    index++;
  }
}

/**
 * Prunes audit log files older than the configured retention period.
 * Returns the number of unlinked files.
 */
export function pruneOldAuditLogs(retentionDays = getRetentionDays()): number {
  const dir = getAuditDirectory();
  if (!existsSync(dir)) return 0;

  const now = Date.now();
  const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;
  let prunedCount = 0;

  const files = readdirSync(dir);
  for (const file of files) {
    const match = /^audit-(\d{4})-(\d{2})-(\d{2})(?:\.\d+)?\.jsonl$/.exec(file);
    if (!match) continue;

    const [, yStr, mStr, dStr] = match;
    const fileTime = Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr));
    if (now - fileTime > cutoffMs) {
      try {
        unlinkSync(join(dir, file));
        prunedCount++;
      } catch {
        // Ignore deletion errors on locked files
      }
    }
  }

  return prunedCount;
}

/**
 * Appends a structured record atomically to the active audit log file.
 * Thread/process safe via POSIX O_APPEND, restricted permissions (0600),
 * and strict truncation to stay under PIPE_BUF (4096 bytes).
 */
export function writeAuditEntry(entry: AuditEntry): void {
  ensureAuditDir();

  const sanitizedDetails = entry.details
    ? sanitizeAuditData(entry.details, MAX_FIELD_BYTES)
    : undefined;

  const sanitizedTarget = entry.target
    ? (truncateField(entry.target, MAX_FIELD_BYTES) as string)
    : undefined;

  const record: AuditEntry = {
    ...entry,
    target: sanitizedTarget,
    details: sanitizedDetails,
  };

  let line = JSON.stringify(record) + "\n";

  // Invariant: single write must never exceed PIPE_BUF to prevent interleave
  if (Buffer.byteLength(line, "utf8") >= PIPE_BUF_LIMIT) {
    record.details = { _truncated: "entry_exceeded_pipe_buf" };
    line = JSON.stringify(record) + "\n";
  }

  const filePath = getActiveAuditFilePath(new Date(entry.ts));
  const isNew = !existsSync(filePath);

  appendFileSync(filePath, line, { encoding: "utf8", mode: 0o600 });
  if (isNew) {
    try {
      chmodSync(filePath, 0o600);
    } catch (err) {
      if (process.env.DEBUG_TRACE === "1") {
        console.warn("[audit] chmod file failed:", err);
      }
    }
  }
}

/**
 * Audits an authentication lifecycle event (login attempt, success, failure, logout, rotation).
 */
export function auditAuth(opts: {
  action:
    | "login_success"
    | "login_failed"
    | "logout"
    | "session_rotate"
    | "session_revoke_all"
    | string;
  success: boolean;
  username?: string | undefined;
  operatorId?: number | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
  reason?: string | undefined;
  details?: Record<string, unknown> | undefined;
}): void {
  writeAuditEntry({
    ts: new Date().toISOString(),
    category: "auth",
    action: opts.action,
    success: opts.success,
    actor: {
      operatorId: opts.operatorId,
      username: opts.username,
      ip: opts.ip,
      userAgent: opts.userAgent,
    },
    target:
      opts.username ?? (opts.operatorId ? `op_${opts.operatorId}` : undefined),
    details: {
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...opts.details,
    },
  });
}

/**
 * Audits a command executed via the Bun.Terminal PTY emulator.
 */
export function auditPty(opts: {
  command: string;
  exitCode: number;
  durationMs: number;
  operatorId?: number | undefined;
  username?: string | undefined;
  cwd?: string | undefined;
  details?: Record<string, unknown> | undefined;
}): void {
  writeAuditEntry({
    ts: new Date().toISOString(),
    category: "pty",
    action: "pty_command",
    success: opts.exitCode === 0,
    actor: {
      operatorId: opts.operatorId,
      username: opts.username,
    },
    target: opts.command,
    details: {
      exitCode: opts.exitCode,
      durationMs: opts.durationMs,
      cwd: opts.cwd,
      ...opts.details,
    },
  });
}

/**
 * Audits a wager event, profiling lookup, or surveillance alert trigger.
 * Serves as the primary audit hook for risk classifications and the alert delivery producer.
 */
export function auditWager(opts: {
  action: string;
  customerId: string;
  ticketId?: string | undefined;
  amount?: number | undefined;
  tier?: string | undefined;
  success?: boolean | undefined;
  actor?: AuditActor | undefined;
  details?: Record<string, unknown> | undefined;
}): void {
  writeAuditEntry({
    ts: new Date().toISOString(),
    category: "wager",
    action: opts.action,
    success: opts.success ?? true,
    actor: opts.actor,
    target: opts.customerId,
    details: {
      ticketId: opts.ticketId,
      amount: opts.amount,
      tier: opts.tier,
      ...opts.details,
    },
  });
}

/**
 * Audits configuration loading and parameter changes.
 */
export function auditConfig(opts: {
  action: "config_load" | "config_change" | string;
  configPath: string;
  success?: boolean | undefined;
  actor?: AuditActor | undefined;
  details?: Record<string, unknown> | undefined;
}): void {
  writeAuditEntry({
    ts: new Date().toISOString(),
    category: "config",
    action: opts.action,
    success: opts.success ?? true,
    actor: opts.actor,
    target: opts.configPath,
    details: opts.details,
  });
}

/**
 * Reads and parses entries across all rotated log files for a given date.
 */
export function readAuditEntries(opts?: {
  date?: Date | undefined;
  limit?: number | undefined;
  category?: AuditCategory | undefined;
}): AuditEntry[] {
  const dir = getAuditDirectory();
  if (!existsSync(dir)) return [];

  const targetDate = opts?.date ?? new Date();
  const yyyy = targetDate.getUTCFullYear();
  const mm = String(targetDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(targetDate.getUTCDate()).padStart(2, "0");
  const prefix = `audit-${yyyy}-${mm}-${dd}`;

  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"))
    .sort((a, b) => {
      // Sort: audit-YYYY-MM-DD.jsonl first, then .1, .2, etc.
      const idxA =
        a === `${prefix}.jsonl`
          ? 0
          : Number(a.slice(prefix.length + 1, -6)) || 0;
      const idxB =
        b === `${prefix}.jsonl`
          ? 0
          : Number(b.slice(prefix.length + 1, -6)) || 0;
      return idxA - idxB;
    });

  const entries: AuditEntry[] = [];

  for (const file of files) {
    const fullPath = join(dir, file);
    try {
      const content = readFileSync(fullPath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as AuditEntry;
          if (opts?.category && entry.category !== opts.category) continue;
          entries.push(entry);
        } catch {
          // Ignore truncated lines if any
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  if (opts?.limit && entries.length > opts.limit) {
    return entries.slice(-opts.limit);
  }
  return entries;
}
