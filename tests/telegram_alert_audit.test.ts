import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALERT_AUDIT_REL_PATH,
  TELEGRAM_ACTIVITY_REL_PATH,
  appendAlertAuditRows,
  messageDigest,
  readAlertAudit,
  readTelegramActivityLog,
  summarizeAlertAudit,
  type TelegramAlertAuditRow,
} from "../lib/telegram_alert_audit.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "telegram-alert-audit-"));
  roots.push(root);
  return root;
}

function row(
  overrides: Partial<TelegramAlertAuditRow> = {},
): TelegramAlertAuditRow {
  return {
    schemaVersion: 1,
    atIso: "2026-11-05T07:00:00.000Z",
    source: "flag-alert",
    chatId: "42",
    chatLabel: "deskbotops",
    status: "sent",
    ruleId: "stake_over_100",
    severity: "high",
    dedupeKey: "stake_over_100:BET-0001",
    messageId: 77,
    messageChars: 120,
    messageSha256: "a".repeat(64),
    ...overrides,
  };
}

describe("telegram alert audit", () => {
  test("missing ledger reads as empty", async () => {
    const root = await makeRoot();
    expect(await readAlertAudit(root)).toEqual([]);
  });

  test("appends rows and filters by status, since and limit", async () => {
    const root = await makeRoot();
    await appendAlertAuditRows(root, [
      row({ atIso: "2026-11-05T07:00:00.000Z", status: "sent" }),
      row({
        atIso: "2026-11-05T08:00:00.000Z",
        status: "simulated",
        chatId: null,
      }),
      row({ atIso: "2026-11-05T09:00:00.000Z", status: "failed" }),
    ]);

    const all = await readAlertAudit(root);
    expect(all).toHaveLength(3);
    // Newest first.
    expect(all[0]?.status).toBe("failed");

    const since = await readAlertAudit(root, {
      since: "2026-11-05T08:30:00.000Z",
    });
    expect(since).toHaveLength(1);
    expect(since[0]?.status).toBe("failed");

    const statuses = await readAlertAudit(root, { status: ["sent", "failed"] });
    expect(statuses.map((entry) => entry.status).sort()).toEqual([
      "failed",
      "sent",
    ]);

    const limited = await readAlertAudit(root, { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  test("malformed lines are skipped, not fatal", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "Scratch/watchlist-autobet"), { recursive: true });
    await writeFile(
      join(root, ALERT_AUDIT_REL_PATH),
      `${JSON.stringify(row())}\nnot json\n{"schemaVersion":9}\n`,
    );
    expect(await readAlertAudit(root)).toHaveLength(1);
  });

  test("summary counts statuses and chats", async () => {
    const _root = await makeRoot();
    const summary = summarizeAlertAudit([
      row({ status: "sent" }),
      row({ status: "sent", chatId: "99", chatLabel: null }),
      row({ status: "simulated" }),
      row({ status: "deduped", chatId: null, chatLabel: null }),
    ]);
    expect(summary.total).toBe(4);
    expect(summary.byStatus.sent).toBe(2);
    expect(summary.byStatus.simulated).toBe(1);
    expect(summary.byStatus.deduped).toBe(1);
    expect(summary.chats).toEqual(["99", "deskbotops"].sort());
  });

  test("activity log outbound rows become audit rows; other directions are skipped", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "reports"), { recursive: true });
    await writeFile(
      join(root, TELEGRAM_ACTIVITY_REL_PATH),
      `${JSON.stringify({
        at: "2026-11-05T07:00:00.000Z",
        direction: "out",
        chatId: "",
        summary: "pulse message",
        outcome: "simulated",
        detail: "TELEGRAM_BOT_TOKEN is not set",
      })}\n${JSON.stringify({
        at: "2026-11-05T07:01:00.000Z",
        direction: "in",
        chatId: "42",
        summary: "command",
        outcome: "ok",
      })}\n`,
    );
    const rows = await readTelegramActivityLog(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("telegram-activity");
    expect(rows[0]?.status).toBe("simulated");
    expect(rows[0]?.chatId).toBeNull();
  });

  test("message digest is a stable hash plus length, no text", async () => {
    const digest = await messageDigest("<b>Alert</b> body");
    expect(digest.chars).toBe(17);
    expect(digest.sha256).toHaveLength(64);
    expect(await messageDigest("<b>Alert</b> body")).toEqual(digest);
  });
});
