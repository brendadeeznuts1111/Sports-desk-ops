/**
 * Credential-gated SHELL_CAPTURE schedules. The webview daemon arms two of them so the KPI cards
 * that the 15-minute bridge cycle does not rebuild (`data/agent-tree.json`, `data/customer-profiles.json`)
 * still turn over; these tests drive the scheduler with an injected capture runner so nothing is
 * spawned.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  BRIDGE_SCHEDULE_IDS,
  ReportingSchedulerService,
  resetShellCaptureRunner,
  runShellCaptureDefault,
  type ShellCaptureOutcome,
  type ShellJobSpec,
} from "../services/reporting_scheduler_service.ts";
import type { SportsDeskTelegramService } from "../services/sportsdesk_telegram_bot.ts";

function fakeTelegram(): SportsDeskTelegramService {
  return {
    setReportGenerator: () => {},
    sendMessage: async () => ({ ok: true, delivered: true, error: undefined }),
  } as unknown as SportsDeskTelegramService;
}

const env = Bun.env as unknown as Record<string, string | undefined>;
const SAVED: Record<string, string | undefined> = {};
const TOUCHED = ["F402_BEARER_TOKEN"] as const;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(env, name);
  else Reflect.set(env, name, value);
}

beforeEach(() => {
  for (const name of TOUCHED)
    SAVED[name] = Bun.env[name as keyof typeof Bun.env];
});

afterEach(() => {
  for (const name of TOUCHED) setEnv(name, SAVED[name]);
  resetShellCaptureRunner();
});

/**
 * Fire the SHELL_CAPTURE dispatcher the same way the cron tick does, without arming `Bun.cron`.
 * The dispatcher only forwards to `shellCaptureRunner` (and skips when `shellJob` is absent), so an
 * injected recording runner captures exactly what the cron tick would call.
 */
async function fireSchedule(
  scheduler: ReportingSchedulerService,
  id: string,
  runner: (spec: ShellJobSpec) => Promise<ShellCaptureOutcome>,
): Promise<void> {
  const def = scheduler.getSchedules().find((s) => s.id === id);
  if (def === undefined) throw new Error(`no schedule ${id}`);
  if (def.reportType !== "SHELL_CAPTURE")
    throw new Error(`${id} is not SHELL_CAPTURE`);
  if (def.shellJob === undefined) throw new Error(`${id} has no shellJob`);
  await runner(def.shellJob);
}

describe("SHELL_CAPTURE schedule definitions", () => {
  test("both new ids are owned by the webview daemon", () => {
    expect(BRIDGE_SCHEDULE_IDS).toContain("sched_agent_tree_hourly");
    expect(BRIDGE_SCHEDULE_IDS).toContain("sched_customer_profiles_6h");
    expect(BRIDGE_SCHEDULE_IDS).toContain("sched_f402_session_refresh");
    expect(BRIDGE_SCHEDULE_IDS).toContain("sched_weblog_sentinel_daily");
  });

  test("session-refresh (#76) and weblog-sentinel (#91) are gated on opt-in env vars", () => {
    const scheduler = new ReportingSchedulerService(fakeTelegram());
    const refresh = scheduler
      .getSchedules()
      .find((s) => s.id === "sched_f402_session_refresh");
    expect(refresh?.reportType).toBe("SHELL_CAPTURE");
    expect(refresh?.scheduleTime).toBe("*/5 * * * *");
    expect(refresh?.tz).toBe("America/Chicago");
    expect(refresh?.shellJob?.args).toEqual([
      "--no-orphans",
      "--no-env-file",
      "run",
      "scripts/f402_session_refresh.ts",
    ]);
    expect(refresh?.shellJob?.requires).toEqual([
      "F402_SESSION_REFRESH_SCHEDULER",
      "F402_LIVE_LOGIN",
    ]);

    const sentinel = scheduler
      .getSchedules()
      .find((s) => s.id === "sched_weblog_sentinel_daily");
    expect(sentinel?.reportType).toBe("SHELL_CAPTURE");
    expect(sentinel?.scheduleTime).toBe("0 8 * * *");
    expect(sentinel?.tz).toBe("America/Chicago");
    expect(sentinel?.shellJob?.args).toEqual([
      "--no-orphans",
      "--no-env-file",
      "run",
      "workers/weblog_sentinel.ts",
      "--once",
    ]);
    expect(sentinel?.shellJob?.requires).toEqual(["TELEGRAM_BOT_TOKEN"]);
  });

  test("agent-tree runs on the desk clock at :11 and gates on F402_BEARER_TOKEN", () => {
    const scheduler = new ReportingSchedulerService(fakeTelegram());
    const def = scheduler
      .getSchedules()
      .find((s) => s.id === "sched_agent_tree_hourly");
    expect(def?.reportType).toBe("SHELL_CAPTURE");
    expect(def?.scheduleTime).toBe("11 * * * *");
    expect(def?.tz).toBe("America/Chicago");
    expect(def?.shellJob?.bin).toBe("bun");
    expect(def?.shellJob?.args).toEqual([
      "--no-orphans",
      "--no-env-file",
      "run",
      "scripts/build_agent_tree.ts",
    ]);
    expect(def?.shellJob?.requires).toEqual(["F402_BEARER_TOKEN"]);
    expect(def?.enabled).toBe(true);
  });

  test("customer-profiles runs every 6h at :27 and gates on the enriched fixture file", () => {
    const scheduler = new ReportingSchedulerService(fakeTelegram());
    const def = scheduler
      .getSchedules()
      .find((s) => s.id === "sched_customer_profiles_6h");
    expect(def?.reportType).toBe("SHELL_CAPTURE");
    expect(def?.scheduleTime).toBe("27 */6 * * *");
    expect(def?.tz).toBe("America/Chicago");
    expect(def?.shellJob?.args).toEqual([
      "--no-orphans",
      "--no-env-file",
      "run",
      "scripts/build_customer_profiles.ts",
    ]);
    expect(def?.shellJob?.requires).toEqual([
      "file:enriched_customers_full.json",
    ]);
  });

  test("the bot daemon's exclude list covers every daemon-owned id so there is no double-fire", () => {
    const scheduler = new ReportingSchedulerService(fakeTelegram());
    const botOwned = scheduler
      .getSchedules()
      .filter((s) => !(BRIDGE_SCHEDULE_IDS as readonly string[]).includes(s.id))
      .map((s) => s.id);
    // The bot owns the four legacy reports, not the daemon-owned ids.
    expect(new Set(botOwned)).toEqual(
      new Set([
        "sched_10m_positions_pulse",
        "sched_morning_briefing",
        "sched_midday_pulse",
        "sched_evening_settlement",
      ]),
    );
  });
});

describe("shell capture dispatch", () => {
  test("fireSchedule invokes the injected runner with the schedule's own shellJob argv", async () => {
    setEnv("F402_BEARER_TOKEN", "jwt-token-value");
    const scheduler = new ReportingSchedulerService(fakeTelegram());
    const calls: ShellJobSpec[] = [];
    const injected = async (
      spec: ShellJobSpec,
    ): Promise<ShellCaptureOutcome> => {
      calls.push(spec);
      return { status: "ok", exitCode: 0, durationMs: 1 };
    };
    await fireSchedule(scheduler, "sched_agent_tree_hourly", injected);
    await fireSchedule(scheduler, "sched_customer_profiles_6h", injected);
    expect(calls.map((c) => c.args)).toEqual([
      ["--no-orphans", "--no-env-file", "run", "scripts/build_agent_tree.ts"],
      [
        "--no-orphans",
        "--no-env-file",
        "run",
        "scripts/build_customer_profiles.ts",
      ],
    ]);
  });

  test("agent-tree is skipped when F402_BEARER_TOKEN is unset (no spawn)", async () => {
    setEnv("F402_BEARER_TOKEN", undefined);
    const outcome = await runShellCaptureDefault(
      {
        bin: "bun",
        args: ["run", "build:agent-tree"],
        requires: ["F402_BEARER_TOKEN"],
      },
      quietLogger(),
    );
    expect(outcome).toEqual({
      status: "skipped",
      missing: ["F402_BEARER_TOKEN"],
    });
  });

  test("customer-profiles is skipped when the required file is absent (no spawn)", async () => {
    const outcome = await runShellCaptureDefault(
      {
        bin: "bun",
        args: ["run", "customers:profiles"],
        requires: ["file:definitely-absent-fixture.json"],
      },
      quietLogger(),
    );
    expect(outcome).toEqual({
      status: "skipped",
      missing: ["file:definitely-absent-fixture.json"],
    });
  });

  test("a blank env value counts as missing", async () => {
    setEnv("F402_BEARER_TOKEN", "   ");
    const outcome = await runShellCaptureDefault(
      {
        bin: "bun",
        args: ["run", "build:agent-tree"],
        requires: ["F402_BEARER_TOKEN"],
      },
      quietLogger(),
    );
    expect(outcome.status).toBe("skipped");
  });

  test("the skip log line names the missing requirement and never a value", async () => {
    setEnv("F402_BEARER_TOKEN", "jwt-should-never-be-printed");
    const lines: string[] = [];
    const outcome = await runShellCaptureDefault(
      {
        bin: "bun",
        args: ["run", "build:agent-tree"],
        requires: ["F402_BEARER_TOKEN", "F402_NOT_SET_ANYWHERE"],
      },
      {
        log: (line) => lines.push(line),
        warn: (line) => lines.push(line),
      },
    );
    expect(outcome.status).toBe("skipped");
    const joined = lines.join("\n");
    expect(joined).toContain("F402_NOT_SET_ANYWHERE");
    expect(joined).toContain("skipped");
    expect(joined).not.toContain("jwt-should-never-be-printed");
  });

  test("a satisfied gate spawns the CLI and the ok exit is reported", async () => {
    const outcome = await runShellCaptureDefault(
      { bin: "bun", args: ["-e", "process.exit(0)"] },
      quietLogger(),
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.exitCode).toBe(0);
  });

  test("bun specs receive --no-env-file automatically before child args", async () => {
    const outcome = await runShellCaptureDefault(
      {
        bin: "bun",
        args: [
          "-e",
          "if (!process.execArgv.includes('--no-env-file')) process.exit(9); process.exit(0);",
        ],
      },
      quietLogger(),
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.exitCode).toBe(0);
  });

  test("a non-zero exit is reported as failed with the exit code", async () => {
    const outcome = await runShellCaptureDefault(
      { bin: "bun", args: ["-e", "process.exit(7)"] },
      quietLogger(),
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.exitCode).toBe(7);
  });

  test("the runner aborts a capture that outruns the timeout", async () => {
    const outcome = await runShellCaptureDefault(
      {
        bin: "bun",
        args: ["-e", "await Bun.sleep(5000)"],
        timeoutSeconds: 1,
      },
      quietLogger(),
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("timed out");
    }
  }, 10_000);
});

function quietLogger() {
  return { log: () => {}, warn: () => {} };
}
