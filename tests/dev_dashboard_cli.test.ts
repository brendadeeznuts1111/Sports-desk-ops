import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  browserOpenCommandForPlatform,
  buildDashboardLaunchUrl,
  parseDevDashboardCliArgs,
  resolveExplicitDashboardTab,
} from "../lib/dev_dashboard_cli.ts";
import { readDashboardUrlState } from "../packages/ui/src/url_state.ts";

const ROOT = path.join(import.meta.dir, "..");

describe("dev_dashboard_cli · argument parsing & launch URLs", () => {
  test("parses ports, host, companion origin, tabs, matrix, and dev switches", () => {
    const def = parseDevDashboardCliArgs([], {
      PORT: "4024",
      SPORTSDESK_API_ORIGIN: "http://127.0.0.1:4090",
    });
    expect(def.ok).toBe(true);
    if (!def.ok) return;
    expect(def.flags.port).toBe(4024);
    expect(def.flags.hostname).toBe("127.0.0.1");
    expect(def.flags.companionOrigin).toBe("http://127.0.0.1:4090");
    expect(def.flags.tab).toBeNull();
    expect(def.flags.matrix).toBe(false);

    const parsed = parseDevDashboardCliArgs([
      "-p",
      "4055",
      "--host=0.0.0.0",
      "--companion=http://127.0.0.1:4021",
      "--tab",
      "risk-overview",
      "--matrix",
      "--open",
      "--no-hmr",
      "--no-watch",
      "--stateless",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.flags.port).toBe(4055);
    expect(parsed.flags.hostname).toBe("0.0.0.0");
    expect(parsed.flags.companionOrigin).toBe("http://127.0.0.1:4021");
    expect(parsed.flags.tab).toBe("surveillance");
    expect(parsed.flags.matrix).toBe(true);
    expect(parsed.flags.open).toBe(true);
    expect(parsed.flags.noHmr).toBe(true);
    expect(parsed.flags.noWatch).toBe(true);
    expect(parsed.flags.mcpStateless).toBe(true);
  });

  test("rejects invalid ports, unknown tabs, bad origins, and --open --api-only", () => {
    expect(parseDevDashboardCliArgs(["--port", "-1"]).ok).toBe(false);
    expect(parseDevDashboardCliArgs(["--port", "70000"]).ok).toBe(false);
    expect(parseDevDashboardCliArgs(["--host", "   "]).ok).toBe(false);
    expect(parseDevDashboardCliArgs(["--companion", "ftp://bad"]).ok).toBe(
      false,
    );
    expect(parseDevDashboardCliArgs(["--tab", "nonexistent"]).ok).toBe(false);
    expect(parseDevDashboardCliArgs(["--open", "--api-only"]).ok).toBe(false);
    expect(parseDevDashboardCliArgs(["--nope"]).ok).toBe(false);
  });

  test("resolves canonical tabs, section hashes, and aliases explicitly", () => {
    expect(resolveExplicitDashboardTab("risk-overview")).toBe("surveillance");
    expect(resolveExplicitDashboardTab("#risk-overview")).toBe("surveillance");
    expect(resolveExplicitDashboardTab("telemetry")).toBe("surveillance");
    expect(resolveExplicitDashboardTab("bettor-churn-simulation")).toBe(
      "customers",
    );
    expect(resolveExplicitDashboardTab("system-logs")).toBe("terminal");
    expect(resolveExplicitDashboardTab("downlines")).toBe("rankings");
    expect(resolveExplicitDashboardTab("bogus")).toBeNull();
  });

  test("buildDashboardLaunchUrl round-trips cleanly with readDashboardUrlState", () => {
    const riskMatrix = buildDashboardLaunchUrl("http://127.0.0.1:4024/", {
      tab: "surveillance",
      matrix: true,
    });
    expect(riskMatrix).toBe("http://127.0.0.1:4024/?matrix=1#risk-overview");
    const u1 = new URL(riskMatrix);
    expect(
      readDashboardUrlState(u1.search, u1.pathname, u1.hash),
    ).toMatchObject({
      tab: "surveillance",
      matrix: true,
    });

    const rankings = buildDashboardLaunchUrl("http://127.0.0.1:4024/", {
      tab: "rankings",
      matrix: true,
    });
    expect(rankings).toBe("http://127.0.0.1:4024/?tab=rankings&matrix=1");

    const customers = buildDashboardLaunchUrl("http://127.0.0.1:4024/", {
      tab: "customers",
      matrix: false,
    });
    expect(customers).toBe("http://127.0.0.1:4024/#bettor-churn-simulation");
  });

  test("browserOpenCommandForPlatform selects platform opener without shell interpolation", () => {
    expect(
      browserOpenCommandForPlatform("http://127.0.0.1:4024/", "darwin"),
    ).toEqual(["open", "http://127.0.0.1:4024/"]);
    expect(
      browserOpenCommandForPlatform("http://127.0.0.1:4024/", "linux"),
    ).toEqual(["xdg-open", "http://127.0.0.1:4024/"]);
    expect(
      browserOpenCommandForPlatform("http://127.0.0.1:4024/", "win32"),
    ).toEqual(["cmd", "/c", "start", "", "http://127.0.0.1:4024/"]);
  });
});

describe("dev_dashboard_cli · subprocess --help & --print-url", () => {
  test("scripts/dev_dashboard.ts --help and --print-url exit 0 cleanly", async () => {
    const helpProc = Bun.spawn(
      [process.execPath, "run", "scripts/dev_dashboard.ts", "--help"],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [helpOut, helpErr, helpCode] = await Promise.all([
      helpProc.stdout.text(),
      helpProc.stderr.text(),
      helpProc.exited,
    ]);
    expect(helpCode).toBe(0);
    expect(helpOut).toContain("Options:");
    expect(helpOut).toContain("--matrix");
    expect(helpErr.trim()).toBe("");

    const printProc = Bun.spawn(
      [
        process.execPath,
        "run",
        "scripts/dev_dashboard.ts",
        "--port",
        "4024",
        "--tab",
        "risk-overview",
        "--matrix",
        "--print-url",
      ],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [printOut, printErr, printCode] = await Promise.all([
      printProc.stdout.text(),
      printProc.stderr.text(),
      printProc.exited,
    ]);
    expect(printCode).toBe(0);
    expect(printOut.trim()).toBe(
      "http://127.0.0.1:4024/?matrix=1#risk-overview",
    );
    expect(printErr.trim()).toBe("");
  });

  test("cli/sportsdesk_cli.ts dev & health --help and --print-url exit 0", async () => {
    const devProc = Bun.spawn(
      [
        process.execPath,
        "run",
        "cli/sportsdesk_cli.ts",
        "dev",
        "--port",
        "4024",
        "--tab",
        "risk-overview",
        "--matrix",
        "--print-url",
      ],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [devOut, devErr, devCode] = await Promise.all([
      devProc.stdout.text(),
      devProc.stderr.text(),
      devProc.exited,
    ]);
    expect(devCode).toBe(0);
    expect(devOut.trim()).toBe("http://127.0.0.1:4024/?matrix=1#risk-overview");
    expect(devErr.trim()).toBe("");

    const healthHelp = Bun.spawn(
      [process.execPath, "run", "cli/sportsdesk_cli.ts", "health", "--help"],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [healthOut, healthErr, healthCode] = await Promise.all([
      healthHelp.stdout.text(),
      healthHelp.stderr.text(),
      healthHelp.exited,
    ]);
    expect(healthCode).toBe(0);
    expect(healthOut).toContain("--schedules");
    expect(healthErr.trim()).toBe("");
  });
});
