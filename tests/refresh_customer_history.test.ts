import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCustomerHistoryConfiguration,
  refreshCustomerHistory,
} from "../scripts/refresh_customer_history.ts";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
test("configuration requires explicit absolute paths and rejects overwriting source exports", () => {
  expect(() => parseCustomerHistoryConfiguration({})).toThrow();
  expect(() =>
    parseCustomerHistoryConfiguration({
      SPORTSDESK_CUSTOMER_HISTORY_PROJECTOR:
        "./scripts/project_customer_history.ts",
      SPORTSDESK_CUSTOMER_HISTORY_SOURCES: '["/tmp/graded.json"]',
      SPORTSDESK_CUSTOMER_HISTORY_JSON: "/tmp/history.json",
    }),
  ).toThrow();
  expect(() =>
    parseCustomerHistoryConfiguration({
      SPORTSDESK_CUSTOMER_HISTORY_PROJECTOR:
        "/dashboard/scripts/project_customer_history.ts",
      SPORTSDESK_CUSTOMER_HISTORY_SOURCES: '["/tmp/graded.json"]',
      SPORTSDESK_CUSTOMER_HISTORY_JSON: "/tmp/graded.json",
    }),
  ).toThrow();
});
test("scheduled wrapper isolates credentials, records attempts, skips overlap and preserves last good output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "customer-history-refresh-"));
  directories.push(directory);
  const projector = join(directory, "scripts/project_customer_history.ts"),
    output = join(directory, "history.json");
  await mkdir(join(directory, "scripts"));
  await Bun.write(
    projector,
    `if(Bun.env.GSID || Bun.env.F402_BEARER_TOKEN) process.exit(2); console.log(JSON.stringify({status:"unchanged",generatedAt:"2026-11-10T00:00:00.000Z"}));`,
  );
  await Bun.write(output, "last good projection");
  const env = {
    PATH: Bun.env.PATH,
    HOME: Bun.env.HOME,
    GSID: "must-not-reach-child",
    F402_BEARER_TOKEN: "must-not-reach-child",
    SPORTSDESK_CUSTOMER_HISTORY_PROJECTOR: projector,
    SPORTSDESK_CUSTOMER_HISTORY_SOURCES: JSON.stringify([
      join(directory, "graded.json"),
    ]),
    SPORTSDESK_CUSTOMER_HISTORY_JSON: output,
  };
  expect((await refreshCustomerHistory(env)).status).toBe("unchanged");
  const receipt = await Bun.file(`${output}.status.json`).json();
  expect(receipt.status).toBe("unchanged");
  expect(receipt.upstreamCapturePerformed).toBe(false);
  expect((await stat(`${output}.status.json`)).mode & 0o777).toBe(0o600);
  await Bun.write(`${output}.refresh-lock`, "held");
  expect((await refreshCustomerHistory(env)).status).toBe("overlap-skipped");
  await rm(`${output}.refresh-lock`);
  await Bun.write(projector, "process.exit(1)");
  await expect(refreshCustomerHistory(env)).rejects.toThrow("refresh failed");
  expect((await Bun.file(`${output}.status.json`).json()).status).toBe(
    "failed",
  );
  expect(await Bun.file(output).text()).toBe("last good projection");
  expect(await Bun.file(`${output}.refresh-lock`).exists()).toBe(false);
});
