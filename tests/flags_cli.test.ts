import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "cli/flags.ts");
const TMP = mkdtempSync(join(tmpdir(), "flags-cli-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

async function run(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout.text(),
    proc.stderr.text(),
  ]);
  return { code, stdout, stderr };
}

function capture(): string {
  const periods = ["1st Quarter", "2nd Quarter", "3rd Quarter", "4th Quarter"];
  const rows = periods.map((period, index) => ({
    WagerNumber: 900000001 + index,
    AgentID: "RULEAGENT",
    AgentLogin: "RULEAGENT",
    CustomerID: "RULECUST",
    Login: "RULECUST",
    WagerType: "S",
    AmountWagered: 100,
    ToWinAmount: 90,
    VolumeAmount: 100,
    TicketWriter: "Internet",
    InsertDateTime: `2026-11-04 21:${15 + index}:00.000`,
    ShortDesc: `S.G999999001\r\nBasketball - Lakers vs Kings / ${period} / Total / Over 55 -110&#x0D;\n`,
    VIP: "0",
  }));
  const path = join(TMP, "capture.json");
  writeFileSync(
    path,
    JSON.stringify({
      status: 1,
      accountInfo: { Language: "ENGLISH" },
      LIST: rows,
    }),
  );
  return path;
}

describe("flags CLI", () => {
  test("--rules lists every deterministic rule", async () => {
    const { code, stdout } = await run(["--rules"]);
    expect(code).toBe(0);
    for (const rule of [
      "period_correlation",
      "batch_replay",
      "clone_bet",
      "velocity_customer",
      "velocity_market",
      "period_order_anomaly",
      "past_post",
    ]) {
      expect(stdout).toContain(rule);
    }
  });

  test("period correlation fires and --strict exits 1", async () => {
    const path = capture();
    const json = await run(["--file", path, "--json"]);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      wagerCount: number;
      items: Array<{ rule: string; wagerNumbers: string[] }>;
    };
    expect(payload.wagerCount).toBe(4);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]?.rule).toBe("period_correlation");
    expect(payload.items[0]?.wagerNumbers).toEqual([
      "900000001",
      "900000002",
      "900000003",
      "900000004",
    ]);
    expect(json.stdout).not.toContain("RULECUST");
    expect(json.stdout).not.toContain("RULEAGENT");

    const strict = await run(["--file", path, "--strict"]);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("1 flag from 4 wagers");
  });

  test("a missing capture is a clean error", async () => {
    const missing = await run(["--file", join(TMP, "missing.json")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("not found");
    expect(missing.stderr).not.toContain("ENOENT");
  });

  test("--rule narrows the run and empty captures exit 0", async () => {
    const path = capture();
    const one = await run(["--file", path, "--rule=batch_replay"]);
    expect(one.code).toBe(0);
    expect(one.stdout).toBe("");
  });

  test("--review plans, --record stores and --review-report emits metadata", async () => {
    const path = capture();
    const db = join(TMP, "flags-review.sqlite");
    const runId = "cli-review-run";

    const planned = await run([
      "--file",
      path,
      "--review",
      "--db",
      db,
      "--run-id",
      runId,
      "--budget-minutes",
      "60",
      "--seed",
      "dx-2026-q4",
      "--json",
    ]);
    expect(planned.code).toBe(0);
    const plan = JSON.parse(planned.stdout) as {
      runId: string;
      flagCount: number;
      wagerCount: number;
      samples: Array<{ seq: number; rule: string }>;
      rules: Array<{
        rule: string;
        fired: number;
        selected: number;
        mode: string;
      }>;
    };
    expect(plan.runId).toBe(runId);
    expect(plan.flagCount).toBe(1);
    expect(plan.wagerCount).toBe(4);
    expect(plan.samples[0]).toMatchObject({
      seq: 0,
      rule: "period_correlation",
    });
    expect(plan.rules[0]).toMatchObject({
      rule: "period_correlation",
      fired: 1,
      selected: 1,
      mode: "census",
    });

    const recorded = await run([
      "--record",
      "--db",
      db,
      "--run-id",
      runId,
      "--seq",
      "0",
      "--verdict",
      "confirmed",
      "--reviewer",
      "analyst-a",
      "--notes",
      "checked the market",
    ]);
    expect(recorded.code).toBe(0);
    expect(recorded.stdout).toContain("recorded confirmed");

    const status = await run([
      "--review-status",
      "--db",
      db,
      "--run-id",
      runId,
      "--json",
    ]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      runId,
      sampled: 1,
      reviewed: 1,
      remaining: 0,
      doubleReviewPlanned: 1,
      doubleReviewCovered: 0,
      verdicts: { confirmed: 1, false_positive: 0, needs_more_info: 0 },
    });

    const exported = await run([
      "--review-export",
      "--db",
      db,
      "--run-id",
      runId,
      "--format",
      "csv",
    ]);
    expect(exported.code).toBe(0);
    expect(exported.stdout).toContain(
      "run_id,seq,rule,verdict,reviewer,reviewed_at,notes,wager_numbers",
    );
    expect(exported.stdout).toContain("checked the market");
    expect(exported.stdout).toContain("900000001");

    const reported = await run([
      "--review-report",
      "--db",
      db,
      "--run-id",
      runId,
      "--json",
    ]);
    expect(reported.code).toBe(0);
    const payload = JSON.parse(reported.stdout) as {
      kind: string;
      metricMetadata: {
        kind: string;
        definitions: Array<{
          name: string;
          evaluates?: string;
          notApplicableTo?: string;
          value?: Record<string, unknown>;
        }>;
      };
    };
    expect(payload.kind).toBe("flags-review-report");
    expect(payload.metricMetadata.kind).toBe("flags-metric-metadata");
    const precision = payload.metricMetadata.definitions.find(
      (definition) => definition.name === "rulePrecision",
    );
    expect(precision).toMatchObject({
      evaluates: "rule",
      notApplicableTo: "individual-flag",
    });
    expect(precision?.value?.["period_correlation"]).toMatchObject({
      state: "not_measured",
      blockedBy: "reviewedSampleSize",
      n: 1,
    });
  });

  test("--dir globs captures and --week keeps the last seven days", async () => {
    const dir = mkdtempSync(join(TMP, "dir-"));
    const write = (
      name: string,
      base: number,
      date: string,
      customer: string,
      event: string,
    ): void => {
      const periods = [
        "1st Quarter",
        "2nd Quarter",
        "3rd Quarter",
        "4th Quarter",
      ];
      const rows = periods.map((period, index) => ({
        WagerNumber: base + index,
        AgentID: "DIRAGENT",
        AgentLogin: "DIRAGENT",
        CustomerID: customer,
        Login: customer,
        WagerType: "S",
        AmountWagered: 100,
        ToWinAmount: 90,
        VolumeAmount: 100,
        TicketWriter: "Internet",
        InsertDateTime: `${date} 21:${15 + index}:00.000`,
        ShortDesc: `S.G999999001\r\nBasketball - ${event} / ${period} / Total / Over 55 -110&#x0D;\n`,
        VIP: "0",
      }));
      writeFileSync(
        join(dir, name),
        JSON.stringify({
          status: 1,
          accountInfo: { Language: "ENGLISH" },
          LIST: rows,
        }),
      );
    };
    write(
      "capture-2020.json",
      810000001,
      "2020-01-01",
      "OLDCUST",
      "Lakers vs Kings",
    );
    write(
      "capture-2026.json",
      820000001,
      "2026-11-04",
      "NEWCUST",
      "Celtics vs Heat",
    );
    // Not a capture: scanning every file and parsing it would fail here.
    writeFileSync(join(dir, "notes.txt"), "not a capture");

    const all = await run(["--dir", dir, "--json"]);
    expect(all.code).toBe(0);
    const allPayload = JSON.parse(all.stdout) as {
      wagerCount: number;
      items: unknown[];
    };
    expect(allPayload.wagerCount).toBe(8);
    expect(allPayload.items).toHaveLength(2);

    const week = await run(["--dir", dir, "--week", "--json"]);
    expect(week.code).toBe(0);
    const weekPayload = JSON.parse(week.stdout) as {
      wagerCount: number;
      items: unknown[];
    };
    expect(weekPayload.wagerCount).toBe(4);
    expect(weekPayload.items).toHaveLength(1);
  });
});
