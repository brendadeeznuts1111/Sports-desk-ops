import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import {
  BUN_CRON_V14_BLOG_LOCAL_TZ_SHIP_NOTE,
  BUN_CRON_V14_BLOG_LOCAL_TZ_URL,
  BUN_CRON_OS_REGISTER_EXAMPLE,
  BUN_CRON_OS_WORKER_SCHEDULED_EXAMPLE,
  BUN_CRON_PARSE_EXAMPLE,
  type CronScheduledWorkerExport,
  formatCronScheduleLine,
  isBunOsCronInvocation,
  osCronWorkerPath,
  parseCronSchedule,
  parseCronScheduleOrNull,
  previewCronSchedule,
  startInProcessCron,
} from "./bun_cron.ts";
import artifactsCron from "../scripts/artifacts_cron.ts";

describe("bun_cron", () => {
  test("isBunOsCronInvocation detects OS cron argv", () => {
    expect(isBunOsCronInvocation(["bun", "run", "worker.ts"])).toBe(false);
    expect(
      isBunOsCronInvocation([
        "bun",
        "run",
        "--cron-title=weekly-report",
        "--cron-period=0 6 * * *",
        "/abs/worker.ts",
      ]),
    ).toBe(true);
  });

  test("osCronWorkerPath resolves import.meta.url", () => {
    expect(osCronWorkerPath(import.meta.url)).toBe(
      fileURLToPath(import.meta.url),
    );
  });

  test("parseCronSchedule accepts @daily and named weekdays", () => {
    expect(parseCronSchedule("@daily") instanceof Date).toBe(true);
    expect(parseCronSchedule("30 2 * * MON") instanceof Date).toBe(true);
    expect(parseCronSchedule("0 9 * * MON-FRI") instanceof Date).toBe(true);
  });

  test("parseCronScheduleOrNull returns null for impossible calendar dates", () => {
    expect(parseCronScheduleOrNull("0 0 30 2 *")).toBe(null);
  });

  test("parseCronSchedule honors { tz }", () => {
    const from = Date.UTC(2026, 5, 1, 15, 30, 0);
    const utcMidnight = parseCronSchedule("0 0 * * *", { from, tz: "UTC" });
    const honoluluMidnight = parseCronSchedule("0 0 * * *", {
      from,
      tz: "Pacific/Honolulu",
    });
    expect(utcMidnight.getUTCHours()).toBe(0);
    expect(honoluluMidnight.getTime()).not.toBe(utcMidnight.getTime());
  });

  test("parseCronSchedule rejects from outside ECMAScript Date range", () => {
    expect(() => parseCronSchedule("* * * * *", { from: 8.64e15 + 1 })).toThrow(
      TypeError,
    );
  });

  test("previewCronSchedule and formatCronScheduleLine", () => {
    const preview = previewCronSchedule("0 6 * * *", { tz: "UTC" });
    expect(preview.tz).toBe("UTC");
    expect(formatCronScheduleLine(preview)).toContain('"0 6 * * *" (UTC)');
    expect(formatCronScheduleLine(preview)).toContain("next ");
  });

  test("startInProcessCron returns CronJob with schedule string", () => {
    const job = startInProcessCron("0 0 1 1 *", () => {});
    expect(job.cron).toBe("0 0 1 1 *");
    job.stop();
  });

  test("CronJob handle matches docs (cron, unref, stop, using dispose)", () => {
    const job = startInProcessCron("*/5 * * * *", async () => {});
    expect(job.cron).toBe("*/5 * * * *");
    expect(job.unref()).toBe(job);
    expect(job.stop()).toBe(job);

    {
      using scoped = startInProcessCron("0 0 1 1 *", () => {});
      expect(scoped.cron).toBe("0 0 1 1 *");
    }
  });

  test("startInProcessCron keepAlive false unrefs", () => {
    const job = startInProcessCron("*/5 * * * *", () => {}, {
      keepAlive: false,
    });
    expect(job.cron).toBe("*/5 * * * *");
    job.stop();
  });

  test("v1.4 blog local-tz ship note URL is pinned", () => {
    expect(BUN_CRON_V14_BLOG_LOCAL_TZ_URL).toContain(
      "https://bun.com/blog/bun-v1.4",
    );
    expect(BUN_CRON_V14_BLOG_LOCAL_TZ_URL).toContain("35122");
    expect(BUN_CRON_V14_BLOG_LOCAL_TZ_SHIP_NOTE).toContain("{ tz }");
    expect(BUN_CRON_V14_BLOG_LOCAL_TZ_SHIP_NOTE).toContain(
      "ECMAScript Date range",
    );
  });

  test("OS-level doc examples exported", () => {
    expect(BUN_CRON_OS_REGISTER_EXAMPLE).toContain("weekly-report");
    expect(BUN_CRON_PARSE_EXAMPLE).toContain("Bun.cron.parse");
    expect(BUN_CRON_OS_WORKER_SCHEDULED_EXAMPLE).toContain(
      "scheduled(controller)",
    );
  });

  test("parse quarter-hour cadence", () => {
    const next = parseCronScheduleOrNull("*/15 * * * *");
    expect(next instanceof Date).toBe(true);
  });

  test("artifacts_cron default export satisfies CronScheduledWorkerExport", () => {
    const worker = artifactsCron as CronScheduledWorkerExport;
    expect(typeof worker.scheduled).toBe("function");
  });
});
