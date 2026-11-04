/**
 * The bridge rollup schedules live in the existing ReportingSchedulerService, so the dashboard, the
 * Telegram digest and the cron tick all read one implementation. These tests drive the scheduler
 * with an injected cycle runner and a fake Telegram client: no CLI is spawned and no message is sent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BridgeRollupCycleResult,
  BridgeRollupJobId,
} from "../lib/bridge_rollup_cron.ts";
import {
  BRIDGE_SCHEDULE_IDS,
  ReportingSchedulerService,
  setBridgeCycleRunner,
} from "../services/reporting_scheduler_service.ts";
import type { SportsDeskTelegramService } from "../services/sportsdesk_telegram_bot.ts";

const RESULT: BridgeRollupCycleResult = {
  updatedAt: "2026-11-04T06:00:00.000Z",
  jobs: [
    {
      id: "bridge3a",
      label: "Bet ticker",
      ok: true,
      durationMs: 120,
    },
    {
      id: "bridge3b",
      label: "Pending",
      ok: false,
      durationMs: 300,
      error: "missing credentials: F402_TOKEN_FILE",
    },
  ],
  alerts: [
    {
      id: "job:bridge3b:fail",
      severity: "critical",
      title: "bridge3b failed",
      detail: "missing credentials: F402_TOKEN_FILE",
    },
  ],
};

interface SentMessage {
  readonly chatId: string;
  readonly html: string;
}

function fakeTelegram(): {
  service: SportsDeskTelegramService;
  sent: SentMessage[];
} {
  const sent: SentMessage[] = [];
  const service = {
    setReportGenerator: () => {},
    sendMessage: async (chatId: string, html: string) => {
      sent.push({ chatId, html });
      return { ok: true, delivered: true, error: undefined };
    },
  };
  return {
    service: service as unknown as SportsDeskTelegramService,
    sent,
  };
}

const env = process.env as unknown as Record<string, string | undefined>;
const savedStatePath = process.env.BRIDGE_ROLLUP_STATE_PATH;

afterEach(() => {
  // Leave a loud default behind: a later test that forgets to inject must not spawn the CLIs.
  setBridgeCycleRunner(async () => {
    throw new Error("bridge cycle runner not configured for this test");
  });
  setEnv("BRIDGE_ROLLUP_STATE_PATH", savedStatePath);
});

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(env, name);
  else Reflect.set(env, name, value);
}

describe("bridge schedules", () => {
  test("the 15-minute cycle and the hourly WebLog run on the desk clock", () => {
    const { service } = fakeTelegram();
    const scheduler = new ReportingSchedulerService(service);
    const schedules = scheduler.getSchedules();
    const cycle = schedules.find((s) => s.id === "sched_bridge_rollup_15m");
    const weblog = schedules.find((s) => s.id === "sched_bridge_weblog_hourly");

    expect(cycle).toBeDefined();
    expect(cycle?.reportType).toBe("BRIDGE_ROLLUP_DIGEST");
    expect(cycle?.scheduleTime).toBe("*/15 * * * *");
    expect(cycle?.tz).toBe("America/Chicago");
    expect(cycle?.bridgeJobs).toEqual(["bridge3a", "bridge3b", "bridge3c"]);
    expect(cycle?.enabled).toBe(true);

    expect(weblog?.tz).toBe("America/Chicago");
    expect(weblog?.scheduleTime).toBe("7 * * * *");
    expect(weblog?.bridgeJobs).toEqual(["weblog"]);
  });

  test("the daemon-owned ids resolve to exactly those two schedules", () => {
    const { service } = fakeTelegram();
    const scheduler = new ReportingSchedulerService(service);
    const owned = scheduler
      .getSchedules()
      .filter((s) => (BRIDGE_SCHEDULE_IDS as readonly string[]).includes(s.id))
      .map((s) => s.id);
    expect(new Set(owned)).toEqual(new Set(BRIDGE_SCHEDULE_IDS));
    expect(typeof scheduler.startBridgeSchedules).toBe("function");
  });

  test("the legacy schedules keep America/New_York (no timezone regression)", () => {
    const { service } = fakeTelegram();
    const scheduler = new ReportingSchedulerService(service);
    const morning = scheduler
      .getSchedules()
      .find((s) => s.id === "sched_morning_briefing");
    expect(morning?.tz).toBeUndefined();
  });
});

describe("bridge digest dispatch", () => {
  test("dispatchBridgeDigest sends the change digest and reports delivery", async () => {
    const { service, sent } = fakeTelegram();
    const seen: (readonly BridgeRollupJobId[] | undefined)[] = [];
    setBridgeCycleRunner(async (jobs) => {
      seen.push(jobs);
      return RESULT;
    });
    const scheduler = new ReportingSchedulerService(service);

    const ok = await scheduler.dispatchBridgeDigest(["weblog"], "chat-1");

    expect(ok).toBe(true);
    expect(seen).toEqual([["weblog"]]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe("chat-1");
    expect(sent[0]?.html).toContain("bridge3b failed");
    expect(sent[0]?.html).not.toContain("undefined");
  });

  test("manual dispatch sends the last state and never runs a cycle", async () => {
    const { service, sent } = fakeTelegram();
    let called = 0;
    setBridgeCycleRunner(async () => {
      called += 1;
      return RESULT;
    });
    const scheduler = new ReportingSchedulerService(service);

    await scheduler.dispatchReportNow("BRIDGE_ROLLUP_DIGEST");

    expect(called).toBe(0); // an HTTP click must not spawn the four CLIs
    expect(sent).toHaveLength(1);
  });

  test("a manual dispatch always delivers, even when the last recorded cycle was quiet", async () => {
    const { service, sent } = fakeTelegram();
    setBridgeCycleRunner(async () => ({
      updatedAt: "2026-11-04T06:15:00.000Z",
      jobs: [{ id: "weblog", label: "WebLog", ok: true, durationMs: 900 }],
      alerts: [],
    }));
    const scheduler = new ReportingSchedulerService(service);

    await scheduler.dispatchReportNow("BRIDGE_ROLLUP_DIGEST");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.html.length).toBeGreaterThan(0);
  });

  test("a scheduled cycle with no new alerts suppresses the Telegram send", async () => {
    const { service, sent } = fakeTelegram();
    setBridgeCycleRunner(async () => ({
      updatedAt: "2026-11-04T06:15:00.000Z",
      jobs: [{ id: "weblog", label: "WebLog", ok: true, durationMs: 900 }],
      alerts: [],
    }));
    const scheduler = new ReportingSchedulerService(service);

    const delivered = await scheduler.dispatchBridgeDigest(
      ["weblog"],
      "chat-1",
    );

    expect(delivered).toBe(true); // nothing to deliver is a successful no-op
    expect(sent).toHaveLength(0);
  });

  test("a scheduled cycle with a standing failure but no new change still suppresses", async () => {
    const { service, sent } = fakeTelegram();
    setBridgeCycleRunner(async () => ({
      updatedAt: "2026-11-04T06:15:00.000Z",
      jobs: [
        {
          id: "bridge3b",
          label: "Pending liability rollup (3b)",
          ok: false,
          durationMs: 0,
          error: "missing credentials: F402_BEARER_TOKEN",
        },
      ],
      alerts: [], // the failure already paged on the transition
    }));
    const scheduler = new ReportingSchedulerService(service);

    const delivered = await scheduler.dispatchBridgeDigest(
      ["bridge3b"],
      "chat-1",
    );

    expect(delivered).toBe(true);
    expect(sent).toHaveLength(0);
  });
});

describe("generateReport(BRIDGE_ROLLUP_DIGEST)", () => {
  let dir: string | undefined;

  test("reads the scheduler's last state file", async () => {
    dir = await mkdtemp(join(tmpdir(), "bridge-digest-"));
    const path = join(dir, "bridge-rollup-state.json");
    await writeFile(path, JSON.stringify(RESULT));
    setEnv("BRIDGE_ROLLUP_STATE_PATH", path);

    const { service } = fakeTelegram();
    const scheduler = new ReportingSchedulerService(service);
    const report = scheduler.generateReport("BRIDGE_ROLLUP_DIGEST");

    expect(report.title).toBe("Bridge Rollup Digest");
    expect(report.contentHtml).toContain("bridge3b failed");
    expect(report.targetMiniappTab).toBe("live");
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("says so when no cycle has run yet", () => {
    setEnv(
      "BRIDGE_ROLLUP_STATE_PATH",
      join(tmpdir(), "definitely-absent-state.json"),
    );
    const { service } = fakeTelegram();
    const scheduler = new ReportingSchedulerService(service);
    const report = scheduler.generateReport("BRIDGE_ROLLUP_DIGEST");
    expect(report.contentHtml).toContain("No rollup cycle recorded yet");
  });
});
