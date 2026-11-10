/**
 * @file tests/audit_log.test.ts
 * @description Unit tests for append-only JSONL audit logging, data redaction, category tracking,
 * lifecycle rotation, retention pruning, and POSIX permissions.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  auditAuth,
  auditConfig,
  auditPty,
  auditWager,
  ensureAuditDir,
  getActiveAuditFilePath,
  getAuditDirectory,
  getAuditFilePath,
  getMaxFileBytes,
  getRetentionDays,
  PIPE_BUF_LIMIT,
  pruneOldAuditLogs,
  readAuditEntries,
  sanitizeAuditData,
  writeAuditEntry,
  type AuditEntry,
} from "../lib/audit_log.ts";
import { executeTerminalQuery } from "../lib/terminal_emulator.ts";
import { loadTomlConfig } from "../lib/wager_config.ts";
import { handleLogout } from "../lib/http_auth.ts";

const TEST_AUDIT_DIR = "scratch/test_audit";

describe("JSONL Audit Logger (lib/audit_log.ts)", () => {
  const originalEnvDir = process.env.SPORTSDESK_AUDIT_DIR;
  const originalMaxBytes = process.env.SPORTSDESK_AUDIT_MAX_BYTES;
  const originalRetention = process.env.SPORTSDESK_AUDIT_RETENTION_DAYS;

  beforeEach(() => {
    (process.env as Record<string, string | undefined>).SPORTSDESK_AUDIT_DIR =
      TEST_AUDIT_DIR;
    delete (process.env as Record<string, string | undefined>)
      .SPORTSDESK_AUDIT_MAX_BYTES;
    delete (process.env as Record<string, string | undefined>)
      .SPORTSDESK_AUDIT_RETENTION_DAYS;

    if (existsSync(TEST_AUDIT_DIR)) {
      rmSync(TEST_AUDIT_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (originalEnvDir !== undefined) {
      (process.env as Record<string, string | undefined>).SPORTSDESK_AUDIT_DIR =
        originalEnvDir;
    } else {
      delete (process.env as Record<string, string | undefined>)
        .SPORTSDESK_AUDIT_DIR;
    }
    if (originalMaxBytes !== undefined) {
      (
        process.env as Record<string, string | undefined>
      ).SPORTSDESK_AUDIT_MAX_BYTES = originalMaxBytes;
    } else {
      delete (process.env as Record<string, string | undefined>)
        .SPORTSDESK_AUDIT_MAX_BYTES;
    }
    if (originalRetention !== undefined) {
      (
        process.env as Record<string, string | undefined>
      ).SPORTSDESK_AUDIT_RETENTION_DAYS = originalRetention;
    } else {
      delete (process.env as Record<string, string | undefined>)
        .SPORTSDESK_AUDIT_RETENTION_DAYS;
    }

    if (existsSync(TEST_AUDIT_DIR)) {
      rmSync(TEST_AUDIT_DIR, { recursive: true, force: true });
    }
  });

  it("resolves audit directory and tunables from environment variables", () => {
    expect(getAuditDirectory()).toBe(TEST_AUDIT_DIR);
    expect(getMaxFileBytes()).toBe(50 * 1024 * 1024);
    expect(getRetentionDays()).toBe(90);

    (
      process.env as Record<string, string | undefined>
    ).SPORTSDESK_AUDIT_MAX_BYTES = "10485760";
    (
      process.env as Record<string, string | undefined>
    ).SPORTSDESK_AUDIT_RETENTION_DAYS = "30";

    expect(getMaxFileBytes()).toBe(10485760);
    expect(getRetentionDays()).toBe(30);

    const path = getAuditFilePath(new Date("2026-11-09T12:00:00Z"));
    expect(path).toBe(join(TEST_AUDIT_DIR, "audit-2026-11-09.jsonl"));
  });

  it("enforces private file and directory permissions (0700 dir, 0600 file)", () => {
    ensureAuditDir();
    const dirStats = statSync(TEST_AUDIT_DIR);
    // On POSIX systems, verify permission mask: owner rwx only (0700)
    expect(dirStats.mode & 0o777).toBe(0o700);

    writeAuditEntry({
      ts: new Date().toISOString(),
      category: "config",
      action: "permissions_test",
      success: true,
    });

    const activeFile = getActiveAuditFilePath();
    expect(existsSync(activeFile)).toBe(true);
    const fileStats = statSync(activeFile);
    // Owner rw only (0600)
    expect(fileStats.mode & 0o777).toBe(0o600);
  });

  it("redacts sensitive fields (passwords, tokens, cookies, auth)", () => {
    const sensitive = {
      username: "admin_ops",
      password: "SuperSecretPassword123!",
      token: "sd_token_abc123xyz",
      rawToken: "raw_value",
      cookie: "sd_session=abc",
      nested: {
        authorization: "Bearer secret-token",
        secret: "hmac-key",
        normalField: "public-value",
      },
      list: [{ password: "123" }, { name: "safe" }],
    };

    const sanitized = sanitizeAuditData(sensitive) as {
      username: string;
      password: string;
      token: string;
      rawToken: string;
      cookie: string;
      nested: {
        authorization: string;
        secret: string;
        normalField: string;
      };
      list: Array<{ password?: string; name?: string }>;
    };
    expect(sanitized.username).toBe("admin_ops");
    expect(sanitized.password).toBe("[REDACTED]");
    expect(sanitized.token).toBe("[REDACTED]");
    expect(sanitized.rawToken).toBe("[REDACTED]");
    expect(sanitized.cookie).toBe("[REDACTED]");
    expect(sanitized.nested.authorization).toBe("[REDACTED]");
    expect(sanitized.nested.secret).toBe("[REDACTED]");
    expect(sanitized.nested.normalField).toBe("public-value");
    expect(sanitized.list[0]?.password).toBe("[REDACTED]");
    expect(sanitized.list[1]?.name).toBe("safe");
  });

  it("writes and reads audit log entries in JSONL format", () => {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      category: "auth",
      action: "login_success",
      success: true,
      actor: { username: "operator_jane", operatorId: 42, ip: "127.0.0.1" },
      target: "operator_jane",
      details: { role: "operator" },
    };

    writeAuditEntry(entry);

    const entries = readAuditEntries();
    expect(entries.length).toBe(1);
    const first = entries[0]!;
    expect(first.action).toBe("login_success");
    expect(first.actor?.username).toBe("operator_jane");
    expect(first.actor?.operatorId).toBe(42);
    expect(first.details?.role).toBe("operator");
  });

  it("appends multiple entries sequentially and filters by category/limit", () => {
    auditAuth({
      action: "login_failed",
      success: false,
      username: "attacker",
      ip: "10.0.0.1",
      reason: "invalid_credentials",
    });

    auditPty({
      command: "profile GP301",
      exitCode: 0,
      durationMs: 15,
      operatorId: 1,
    });

    auditWager({
      action: "surveillance_alert",
      customerId: "GP301",
      ticketId: "W-109281",
      amount: 5500,
      tier: "CRITICAL",
    });

    auditConfig({
      action: "config_load",
      configPath: "config/wager_tiers.toml",
    });

    const all = readAuditEntries();
    expect(all.length).toBe(4);

    const ptyOnly = readAuditEntries({ category: "pty" });
    expect(ptyOnly.length).toBe(1);
    expect(ptyOnly[0]!.target).toBe("profile GP301");

    const wagerOnly = readAuditEntries({ category: "wager" });
    expect(wagerOnly.length).toBe(1);
    expect(wagerOnly[0]!.details?.tier).toBe("CRITICAL");

    const limited = readAuditEntries({ limit: 2 });
    expect(limited.length).toBe(2);
    expect(limited[0]!.category).toBe("wager");
    expect(limited[1]!.category).toBe("config");
  });

  it("rotates log file when size exceeds MAX_FILE_BYTES", () => {
    // Set max bytes to 150 to trigger rotation after a 200-byte entry
    (
      process.env as Record<string, string | undefined>
    ).SPORTSDESK_AUDIT_MAX_BYTES = "150";

    // First entry fills initial file (>150 bytes)
    writeAuditEntry({
      ts: new Date().toISOString(),
      category: "auth",
      action: "batch_1",
      success: true,
      details: {
        note: "first entry with sufficient padding to exceed the 150-byte threshold for testing rotation",
      },
    });

    const basePath = getAuditFilePath(new Date());
    expect(existsSync(basePath)).toBe(true);
    expect(statSync(basePath).size).toBeGreaterThanOrEqual(150);

    // Next active target is now .1.jsonl
    const nextFile = getActiveAuditFilePath();
    expect(nextFile.endsWith(".1.jsonl")).toBe(true);

    // Second entry writes directly to rotated .1.jsonl
    writeAuditEntry({
      ts: new Date().toISOString(),
      category: "auth",
      action: "batch_2",
      success: true,
      details: { note: "second entry written to rotated segment" },
    });

    const files = readdirSync(TEST_AUDIT_DIR);
    expect(files.some((f) => f.endsWith(".1.jsonl"))).toBe(true);

    // readAuditEntries stitches both segments seamlessly
    const all = readAuditEntries();
    expect(all.length).toBe(2);
    expect(all[0]!.action).toBe("batch_1");
    expect(all[1]!.action).toBe("batch_2");
  });

  it("prunes audit logs older than retention days", () => {
    ensureAuditDir();

    // Create an old log file (from 120 days ago)
    const oldDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    const oldFilePath = getAuditFilePath(oldDate);
    writeFileSync(
      oldFilePath,
      JSON.stringify({ ts: oldDate.toISOString(), action: "ancient" }) + "\n",
    );

    // Create a recent log file (today)
    writeAuditEntry({
      ts: new Date().toISOString(),
      category: "config",
      action: "recent",
      success: true,
    });

    expect(existsSync(oldFilePath)).toBe(true);

    // Prune with 90-day retention
    const pruned = pruneOldAuditLogs(90);
    expect(pruned).toBe(1);
    expect(existsSync(oldFilePath)).toBe(false);

    // Today's log is preserved
    const recentEntries = readAuditEntries();
    expect(recentEntries.length).toBe(1);
    expect(recentEntries[0]!.action).toBe("recent");
  });

  it("guarantees entries never exceed PIPE_BUF limit (4096 bytes) and truncates oversized fields", () => {
    const hugePayload = "A".repeat(10_000);

    writeAuditEntry({
      ts: new Date().toISOString(),
      category: "wager",
      action: "large_payload_test",
      success: true,
      target: hugePayload,
      details: { note: hugePayload },
    });

    const entries = readAuditEntries();
    expect(entries.length).toBe(1);
    const entry = entries[0]!;

    expect(typeof entry.target).toBe("string");
    expect(entry.target!.endsWith("…[truncated]")).toBe(true);

    const activeFile = getActiveAuditFilePath();
    const rawLine = readFileSync(activeFile, "utf8").trim();
    const byteLength = Buffer.byteLength(rawLine, "utf8");
    expect(byteLength).toBeLessThan(PIPE_BUF_LIMIT);
  });

  it("automatically emits audit log on executeTerminalQuery", async () => {
    const res = await executeTerminalQuery("clear");
    expect(res.command).toBe("clear");

    const ptyEntries = readAuditEntries({ category: "pty" });
    expect(ptyEntries.length).toBeGreaterThanOrEqual(1);
    const last = ptyEntries[ptyEntries.length - 1]!;
    expect(last.target).toBe("clear");
    expect(last.success).toBe(true);
  });

  it("automatically emits audit log on loadTomlConfig", async () => {
    const config = await loadTomlConfig("config/wager_tiers.toml");
    expect(config.tiers.CRITICAL).toBeDefined();

    const configEntries = readAuditEntries({ category: "config" });
    expect(configEntries.length).toBeGreaterThanOrEqual(1);
    const last = configEntries[configEntries.length - 1]!;
    expect(last.action).toBe("config_load");
    expect(last.target).toBe("config/wager_tiers.toml");
    expect(last.details?.tiersCount).toBe(4);
  });

  it("automatically emits audit log on handleLogout", async () => {
    let revokedToken = "";
    const mockRevoke = async (t: string) => {
      revokedToken = t;
    };
    const req = new Request("http://localhost:4022/api/auth/logout", {
      method: "POST",
      headers: { cookie: "sd_session=test-token-to-revoke" },
    });
    const res = await handleLogout(req, mockRevoke);
    expect(res.status).toBe(204);
    expect(revokedToken).toBe("test-token-to-revoke");

    const authEntries = readAuditEntries({ category: "auth" });
    expect(authEntries.length).toBeGreaterThanOrEqual(1);
    const last = authEntries[authEntries.length - 1]!;
    expect(last.action).toBe("logout");
    expect(last.success).toBe(true);
  });
});
