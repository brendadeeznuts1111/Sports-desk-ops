import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../services/sportsdesk_webview_server.ts";

const TMP = mkdtempSync(join(tmpdir(), "flags-api-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function writeCapture(): void {
  const periods = ["1st Quarter", "2nd Quarter", "3rd Quarter", "4th Quarter"];
  const rows = periods.map((period, index) => ({
    WagerNumber: 910000001 + index,
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
  writeFileSync(
    join(TMP, "live-wagers.json"),
    JSON.stringify({
      status: 1,
      accountInfo: { Language: "ENGLISH" },
      LIST: rows,
    }),
  );
}

describe("GET /api/flags", () => {
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    writeCapture();
    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
      wagerListDir: TMP,
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  test("runs deterministic rules over the raw capture", async () => {
    const res = await fetch(`${server.url}api/flags`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      wagerCount: number;
      totalFlags: number;
      byRule: Record<string, number>;
      flags: Array<{
        rule: string;
        severity: string;
        wagerNumbers: string[];
      }>;
    };
    expect(body.success).toBe(true);
    expect(body.wagerCount).toBe(4);
    expect(body.totalFlags).toBe(1);
    expect(body.byRule.period_correlation).toBe(1);
    expect(body.flags[0]?.rule).toBe("period_correlation");
    expect(body.flags[0]?.wagerNumbers).toEqual([
      "910000001",
      "910000002",
      "910000003",
      "910000004",
    ]);
  });

  test("never exposes customer or agent identifiers", async () => {
    const text = await (await fetch(`${server.url}api/flags`)).text();
    expect(text).not.toContain("RULECUST");
    expect(text).not.toContain("RULEAGENT");
    expect(text).not.toContain("CustomerID");
    expect(text).not.toContain("Login");
  });
});
