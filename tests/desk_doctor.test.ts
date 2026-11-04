import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DESK_DOCTOR_HELP,
  deskDoctorExitCode,
  parseDeskDoctorArgs,
  renderDeskHealthReport,
} from "../scripts/desk_doctor.ts";
import {
  DESK_HEALTH_SCHEMA_VERSION,
  type DeskHealth,
  type DeskPanelHealth,
} from "../lib/desk_health.ts";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "desk_doctor.ts");

function mustParse(...argv: readonly string[]) {
  const parsed = parseDeskDoctorArgs(argv);
  if (!parsed.ok) throw new Error(`expected success, got: ${parsed.error}`);
  return parsed.value;
}

function mustFail(...argv: readonly string[]): string {
  const parsed = parseDeskDoctorArgs(argv);
  if (parsed.ok) throw new Error("expected a failure");
  return parsed.error;
}

function panel(overrides: Partial<DeskPanelHealth> = {}): DeskPanelHealth {
  return {
    id: "kpi.pending",
    label: "Open wagers (Pending)",
    endpoint: "/api/kpis",
    httpStatus: 200,
    basis: "capture",
    source: "capture:/cloud/api/Report/Pending@2026-11-04T19:50:00.009Z",
    asOf: "2026-11-04T19:50:00.009Z",
    ageSeconds: 600,
    stale: false,
    partial: false,
    state: "ok",
    issues: [],
    ...overrides,
  };
}

function health(overrides: Partial<DeskHealth> = {}): DeskHealth {
  return {
    schemaVersion: DESK_HEALTH_SCHEMA_VERSION,
    generatedAt: "2026-11-04T20:00:00.000Z",
    baseUrl: "http://127.0.0.1:4020",
    service: {
      reachable: true,
      httpStatus: 200,
      status: "healthy",
      pid: 4_242,
      uptimeSeconds: 1_234,
      runtime: "Bun v1.4.4 (arm64-darwin)",
    },
    panels: [panel()],
    issues: [],
    verdict: "ok",
    nextCommands: [],
    ...overrides,
  };
}

describe("desk:doctor CLI parsing", () => {
  test("defaults are a human report against loopback", () => {
    const invocation = mustParse();
    expect(invocation.baseUrl).toBe("http://127.0.0.1:4020");
    expect(invocation.json).toBe(false);
    expect(invocation.check).toBe(false);
    expect(invocation.strict).toBe(false);
    expect(invocation.maxAgeSeconds).toBeNull();
    expect(invocation.timeoutMs).toBe(4_000);
    expect(invocation.help).toBe(false);
  });

  test("--json, --check, --strict, --max-age and --timeout are modifiers", () => {
    const invocation = mustParse(
      "--json",
      "--check",
      "--strict",
      "--max-age",
      "3600",
      "--timeout",
      "1500",
      "--url",
      "http://127.0.0.1:4100/",
    );
    expect(invocation.json).toBe(true);
    expect(invocation.check).toBe(true);
    expect(invocation.strict).toBe(true);
    expect(invocation.maxAgeSeconds).toBe(3_600);
    expect(invocation.timeoutMs).toBe(1_500);
    expect(invocation.baseUrl).toBe("http://127.0.0.1:4100");
  });

  test("--help is recognised in both spellings", () => {
    expect(mustParse("--help").help).toBe(true);
    expect(mustParse("-h").help).toBe(true);
  });

  test("bad invocations fail with the next command, not a stack trace", () => {
    expect(mustFail("--bogus")).toContain("--bogus");
    expect(mustFail("extra")).toContain("no positional arguments");
    expect(mustFail("--url", "ftp://example.com")).toContain("http or https");
    expect(mustFail("--url", "not a url")).toContain("is not a URL");
    expect(mustFail("--max-age", "0")).toContain(
      "--max-age expects an integer 1..31536000",
    );
    expect(mustFail("--timeout", "10")).toContain(
      "--timeout expects an integer 100..30000",
    );
  });

  test("help documents the exit codes and the basis vocabulary", () => {
    expect(DESK_DOCTOR_HELP).toContain("Exit codes:");
    expect(DESK_DOCTOR_HELP).toContain("capture");
    expect(DESK_DOCTOR_HELP).toContain("fixture");
    expect(DESK_DOCTOR_HELP).toContain(
      `schemaVersion ${DESK_HEALTH_SCHEMA_VERSION}`,
    );
    expect(DESK_DOCTOR_HELP).toContain("bun run dashboard:view");
  });
});

describe("desk:doctor exit codes", () => {
  test("report mode fails only on FAIL", () => {
    expect(deskDoctorExitCode(health(), { check: false, strict: false })).toBe(
      0,
    );
    expect(
      deskDoctorExitCode(health({ verdict: "warn" }), {
        check: false,
        strict: false,
      }),
    ).toBe(0);
    expect(
      deskDoctorExitCode(health({ verdict: "fail" }), {
        check: false,
        strict: false,
      }),
    ).toBe(1);
  });

  test("--check is strict about errors and --strict about warnings", () => {
    const warn = health({ verdict: "warn" });
    const fail = health({ verdict: "fail" });
    expect(deskDoctorExitCode(warn, { check: true, strict: false })).toBe(0);
    expect(deskDoctorExitCode(warn, { check: true, strict: true })).toBe(1);
    expect(deskDoctorExitCode(fail, { check: true, strict: false })).toBe(1);
  });

  test("an unreachable service is exit 2, distinct from a failed check", () => {
    const unreachable = health({
      verdict: "fail",
      service: {
        reachable: false,
        httpStatus: null,
        status: null,
        pid: null,
        uptimeSeconds: null,
        runtime: null,
      },
    });
    expect(deskDoctorExitCode(unreachable, { check: true, strict: true })).toBe(
      2,
    );
  });
});

describe("desk:doctor human report", () => {
  test("renders the service line, panel table, issues and next commands", () => {
    const doc = health({
      verdict: "warn",
      issues: [
        {
          code: "fixture",
          severity: "warn",
          panel: "kpi.customerBook",
          message:
            "demo fixture, not a measurement: ./enriched_customers_full.json",
          nextCommand: "bun run capture:pending",
        },
      ],
      nextCommands: ["bun run capture:pending"],
    });
    const report = renderDeskHealthReport(doc);
    expect(report).toContain(
      "desk:doctor — data health for http://127.0.0.1:4020",
    );
    expect(report).toContain("pid 4242");
    expect(report).toContain("verdict: WARN");
    expect(report).toContain("PANEL");
    expect(report).toContain("Open wagers (Pending)");
    expect(report).toContain("capture");
    expect(report).toContain("10m");
    expect(report).toContain("fixture");
    expect(report).toContain("issues:");
    expect(report).toContain("warn  kpi.customerBook");
    expect(report).toContain("next commands:");
    expect(report).toContain("bun run capture:pending");
  });

  test("says 'issues: none' for a clean desk", () => {
    expect(renderDeskHealthReport(health())).toContain("issues: none");
    expect(renderDeskHealthReport(health())).toContain("verdict: OK");
  });

  test("an unreachable service renders UNREACHABLE, not a fake table", () => {
    const report = renderDeskHealthReport(
      health({
        panels: [],
        verdict: "fail",
        issues: [
          {
            code: "service-unreachable",
            severity: "error",
            panel: "service",
            message: "no desk service",
            nextCommand: "bun run serve",
          },
        ],
        nextCommands: ["bun run serve"],
        service: {
          reachable: false,
          httpStatus: null,
          status: null,
          pid: null,
          uptimeSeconds: null,
          runtime: null,
        },
      }),
    );
    expect(report).toContain("service: UNREACHABLE");
    expect(report).not.toContain("PANEL");
  });
});

describe("desk:doctor process contract", () => {
  test("--help exits 0 with usage on stdout", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, SCRIPT, "--help"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(exit).toBe(0);
    expect(stdout).toContain("desk:doctor — data health");
    expect(stdout).toContain("--check");
  }, 15_000);

  test("a bad flag exits 2 and explains the next command on stderr", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, SCRIPT, "--bogus"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exit).toBe(2);
    expect(stderr).toContain('unknown flag "--bogus"');
    expect(stderr).toContain("desk:doctor --help");
  }, 15_000);

  test("--json against a closed port exits 2 with a reachable:false document", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, SCRIPT, "--json", "--url", "http://127.0.0.1:1"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const doc = JSON.parse(stdout) as DeskHealth;
    expect(exit).toBe(2);
    expect(doc.schemaVersion).toBe(DESK_HEALTH_SCHEMA_VERSION);
    expect(doc.service.reachable).toBe(false);
    expect(doc.verdict).toBe("fail");
    expect(doc.issues[0]?.code).toBe("service-unreachable");
  }, 20_000);
});
