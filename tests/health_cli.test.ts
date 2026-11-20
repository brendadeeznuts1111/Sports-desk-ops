import { describe, expect, test } from "bun:test";
import {
  buildHealthJsonPayload,
  formatHealthReportAnsi,
  parseHealthCliArgs,
  probeSportsDeskHealth,
  runHealthCli,
} from "../lib/health_cli.ts";

function makeStructuredHealth(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    status: "ok",
    service: "sportsdesk-dev-dashboard",
    timestamp: "2026-11-20T18:00:00.000Z",
    build: {
      bunVersion: "1.4.4",
      expectedBunVersion: "1.4.4",
      bunVersionDrift: false,
    },
    runtime: {
      uptimeSeconds: 125,
      rssBytes: 64 * 1024 * 1024,
      heapUsedBytes: 24 * 1024 * 1024,
    },
    server: {
      port: 4024,
      pendingRequests: 1,
      pendingWebSockets: 2,
      wsBackpressureBytes: 512,
    },
    dependencies: {
      db: { status: "ok" },
      r2: { status: "ok", lastSnapshotAgeMs: 4200 },
    },
    sessions: {
      active: 3,
      purged: 1,
    },
    alerts: {
      status: "ok",
      queued: 1,
      delivered: 10,
      dead: 0,
      backlog: 1,
      acknowledged: 9,
      oldestQueuedAgeMs: 320,
      lastDeliveryAt: "2026-11-20T17:59:55.000Z",
    },
    daemon4020: {
      online: true,
      origin: "http://127.0.0.1:4020",
      httpStatus: 200,
      latencyMs: 6,
      status: "serving",
      operationalStatus: "ok",
      dataStatus: "live",
      version: { gitSha: "abc1234" },
      degradedReasons: [],
      error: null,
      sampledAt: "2026-11-20T17:59:59.000Z",
    },
    ...over,
  };
}

function makeStatusPayload(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: "serving",
    live: {
      ticker: { status: "live" },
      pending: { status: "live" },
      refresh: { ticks: 42, lastTickOk: true },
    },
    telegram: {
      status: {
        mode: "simulation",
        modeReason: "TELEGRAM_BOT_TOKEN is not set",
      },
      schedules: [
        {
          id: "sched_bridge_rollup_15m",
          name: "Bridge Rollup Cycle",
          scheduleTime: "*/15 * * * *",
          tz: "America/Chicago",
          reportType: "BRIDGE_ROLLUP_DIGEST",
          enabled: true,
        },
      ],
    },
    ...over,
  };
}

describe("health_cli · argument parsing", () => {
  test("parses defaults from env and supports long/short/inline flags", () => {
    const def = parseHealthCliArgs([], {
      PORT: "4024",
      SPORTSDESK_API_ORIGIN: "http://127.0.0.1:4099/ignored",
    });
    expect(def.ok).toBe(true);
    if (!def.ok) return;
    expect(def.flags.port).toBe(4024);
    expect(def.flags.daemonUrl).toBe("http://127.0.0.1:4099");
    expect(def.flags.hasExplicitDashboardTarget).toBe(false);

    const parsed = parseHealthCliArgs([
      "-p",
      "4030",
      "--url=https://desk.example.test:8443/app",
      "--daemon-url",
      "http://127.0.0.1:4029",
      "--status",
      "--alerts",
      "--schedules",
      "--strict",
      "--no-drift-fail",
      "--timeout-ms=3500",
      "-w",
      "--interval=2.5",
      "--json",
      "--no-color",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.flags.port).toBe(4030);
    expect(parsed.flags.url).toBe("https://desk.example.test:8443");
    expect(parsed.flags.daemonUrl).toBe("http://127.0.0.1:4029");
    expect(parsed.flags.status).toBe(true);
    expect(parsed.flags.alerts).toBe(true);
    expect(parsed.flags.schedules).toBe(true);
    expect(parsed.flags.strict).toBe(true);
    expect(parsed.flags.noDriftFail).toBe(true);
    expect(parsed.flags.timeoutMs).toBe(3500);
    expect(parsed.flags.watch).toBe(true);
    expect(parsed.flags.intervalSec).toBe(2.5);
    expect(parsed.flags.json).toBe(true);
    expect(parsed.flags.noColor).toBe(true);
    expect(parsed.flags.hasExplicitDashboardTarget).toBe(true);
    expect(parsed.flags.hasExplicitDaemonTarget).toBe(true);
  });

  test("rejects conflicting, out-of-range, or unknown flags", () => {
    expect(parseHealthCliArgs(["--daemon-only", "--dashboard-only"]).ok).toBe(
      false,
    );
    expect(parseHealthCliArgs(["--interval", "2"]).ok).toBe(false);
    expect(parseHealthCliArgs(["--port", "0"]).ok).toBe(false);
    expect(parseHealthCliArgs(["--port", "70000"]).ok).toBe(false);
    expect(parseHealthCliArgs(["--url", "ftp://example.com"]).ok).toBe(false);
    expect(parseHealthCliArgs(["--timeout-ms", "10"]).ok).toBe(false);
    expect(parseHealthCliArgs(["--unknown-flag"]).ok).toBe(false);
    expect(parseHealthCliArgs(["--port"]).ok).toBe(false);
  });
});

describe("health_cli · probing & formatting", () => {
  test("probes structured schemaVersion: 1 /health and /api/status cleanly", async () => {
    const parsed = parseHealthCliArgs([
      "--port",
      "4024",
      "--status",
      "--alerts",
      "--schedules",
      "--strict",
      "--no-color",
    ]);
    if (!parsed.ok) throw new Error(parsed.error);

    const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const target = String(input);
      if (target === "http://127.0.0.1:4024/health") {
        return Response.json(makeStructuredHealth());
      }
      if (target === "http://127.0.0.1:4020/health") {
        return Response.json({
          ok: true,
          status: "serving",
          operationalStatus: "ok",
          dataStatus: "live",
          version: { gitSha: "abc1234" },
        });
      }
      if (target === "http://127.0.0.1:4024/api/status") {
        return Response.json(makeStatusPayload());
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    const report = await probeSportsDeskHealth(parsed.flags, {
      fetchImpl: fakeFetch,
      now: () => new Date("2026-11-20T18:00:05.000Z"),
    });

    expect(report.overallStatus).toBe("ok");
    expect(report.bunVersionDrift).toBe(false);
    expect(report.exitCode).toBe(0);
    expect(report.dashboard?.structured?.server?.wsBackpressureBytes).toBe(512);
    expect(report.statusProbe?.ok).toBe(true);
    expect(report.statusProbe?.schedules).toHaveLength(1);

    const rendered = formatHealthReportAnsi(report, {
      color: false,
      alerts: true,
      schedules: true,
    });
    expect(rendered).toContain("wsBackpressure=512 B");
    expect(rendered).toContain("oldestQueuedAgeMs=320");
    expect(rendered).toContain("sched_bridge_rollup_15m");
    expect(rendered).not.toContain("\x1b[");

    const json = buildHealthJsonPayload(report);
    expect(json.schemaVersion).toBe(1);
    expect(Array.isArray(json.services)).toBe(true);
  });

  test("handles bunVersionDrift with --strict vs --no-drift-fail", async () => {
    const strictParsed = parseHealthCliArgs(["--strict", "--dashboard-only"]);
    const ignoreDriftParsed = parseHealthCliArgs([
      "--strict",
      "--no-drift-fail",
      "--dashboard-only",
    ]);
    if (!strictParsed.ok || !ignoreDriftParsed.ok) {
      throw new Error("expected valid flags");
    }

    const driftPayload = makeStructuredHealth({
      build: {
        bunVersion: "1.4.5",
        expectedBunVersion: "1.4.4",
        bunVersionDrift: true,
      },
    });

    const failReport = await probeSportsDeskHealth(strictParsed.flags, {
      localHealthPayload: driftPayload,
    });
    expect(failReport.overallStatus).toBe("ok");
    expect(failReport.bunVersionDrift).toBe(true);
    expect(failReport.exitCode).toBe(1);

    const passReport = await probeSportsDeskHealth(ignoreDriftParsed.flags, {
      localHealthPayload: driftPayload,
    });
    expect(passReport.exitCode).toBe(0);
  });

  test("treats fallback /api/status daemon4020Online=false as degraded status probe", async () => {
    const parsed = parseHealthCliArgs(["--port", "4024", "--status"]);
    if (!parsed.ok) throw new Error(parsed.error);

    const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const target = String(input);
      if (target === "http://127.0.0.1:4024/health") {
        return Response.json(makeStructuredHealth({ status: "degraded" }));
      }
      if (target === "http://127.0.0.1:4024/api/status") {
        return Response.json({
          ok: false,
          daemon4020Online: false,
          note: "Daemon :4020 offline",
        });
      }
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const report = await probeSportsDeskHealth(parsed.flags, {
      fetchImpl: fakeFetch,
    });
    expect(report.overallStatus).toBe("degraded");
    expect(report.daemon?.reachable).toBe(false);
    expect(report.statusProbe?.ok).toBe(false);
    expect(report.statusProbe?.error).toContain("Daemon :4020 offline");
    expect(report.exitCode).toBe(0);
  });

  test("runHealthCli supports --help, parse error exit 2, and --json output", async () => {
    const out: string[] = [];
    const err: string[] = [];

    const helpCode = await runHealthCli(["--help"], {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });
    expect(helpCode).toBe(0);
    expect(out.join("\n")).toContain("Options:");
    expect(out.join("\n")).toContain("Examples:");
    expect(err).toEqual([]);

    const badCode = await runHealthCli(["--bogus"], {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });
    expect(badCode).toBe(2);
    expect(err[0]).toContain("unknown argument");

    const jsonOut: string[] = [];
    const okCode = await runHealthCli(["--dashboard-only", "--json"], {
      stdout: (s) => jsonOut.push(s),
      localHealthPayload: () => makeStructuredHealth(),
    });
    expect(okCode).toBe(0);
    const parsedJson = JSON.parse(jsonOut.join("\n"));
    expect(parsedJson.schemaVersion).toBe(1);
    expect(parsedJson.overallStatus).toBe("ok");
  });
});
