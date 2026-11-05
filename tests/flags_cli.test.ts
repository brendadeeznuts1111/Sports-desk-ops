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
});
