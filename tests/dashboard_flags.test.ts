import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../services/sportsdesk_webview_server.ts";

const ROOT = join(import.meta.dir, "..");
const TMP = mkdtempSync(join(tmpdir(), "dashboard-flags-"));

function writeCapture(): void {
  const periods = ["1st Quarter", "2nd Quarter", "3rd Quarter", "4th Quarter"];
  const rows = periods.map((period, index) => ({
    WagerNumber: 930000001 + index,
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

describe("dashboard anomaly signatures", () => {
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
    rmSync(TMP, { recursive: true, force: true });
  });

  test("renders the deterministic flags section from /api/live-wagers", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "scripts/dashboard_view.ts",
        "markdown",
        "--url",
        String(server.url),
        "--rows",
        "5",
      ],
      {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      proc.stdout.text(),
      proc.stderr.text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(err).toBe("");
    const start = out.indexOf("## Anomaly Signatures");
    expect(start).toBeGreaterThan(-1);
    const end = out.indexOf("\n## ", start + 1);
    const section = out.slice(start, end === -1 ? undefined : end);
    expect(section).toContain("period_correlation");
    expect(section).toContain("1 flags · 4 wagers");
    expect(section).toContain("930000001");
    expect(section).not.toContain("RULECUST");
    expect(section).not.toContain("RULEAGENT");
  });
});
