import { describe, expect, test } from "bun:test";
import { useColor } from "../lib/ansi_color.ts";
import { formatManagerProbeTable } from "../lib/gslive_manager_endpoints.ts";

describe("useColor", () => {
  test("disables ANSI when stdout is not a TTY even if Bun.enableANSIColors is true", () => {
    expect(useColor({ isTTY: false, enableANSIColors: true, env: {} })).toBe(
      false,
    );
  });

  test("enables ANSI when stdout is a TTY and Bun.enableANSIColors is true", () => {
    expect(useColor({ isTTY: true, enableANSIColors: true, env: {} })).toBe(
      true,
    );
    expect(useColor({ isTTY: true, enableANSIColors: false, env: {} })).toBe(
      false,
    );
  });

  test("honors FORCE_COLOR precedence over NO_COLOR and non-TTY", () => {
    expect(
      useColor({
        isTTY: false,
        enableANSIColors: false,
        env: { FORCE_COLOR: "1", NO_COLOR: "1" },
      }),
    ).toBe(true);
    expect(
      useColor({
        isTTY: true,
        enableANSIColors: true,
        env: { FORCE_COLOR: "0" },
      }),
    ).toBe(false);
  });

  test("disables ANSI when NO_COLOR is present in env", () => {
    expect(
      useColor({
        isTTY: true,
        enableANSIColors: true,
        env: { NO_COLOR: "1" },
      }),
    ).toBe(false);
    expect(
      useColor({
        isTTY: true,
        enableANSIColors: true,
        env: { NO_COLOR: "" },
      }),
    ).toBe(false);
  });

  test("honors wantColor when neither FORCE_COLOR nor NO_COLOR disables it", () => {
    expect(
      useColor({
        isTTY: false,
        enableANSIColors: false,
        env: {},
        wantColor: true,
      }),
    ).toBe(true);
    expect(
      useColor({
        isTTY: false,
        enableANSIColors: false,
        env: { NO_COLOR: "1" },
        wantColor: true,
      }),
    ).toBe(false);
  });
});

describe("piped stdout ANSI gating", () => {
  const cleanEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (
        v !== undefined &&
        k !== "NO_COLOR" &&
        k !== "FORCE_COLOR" &&
        k !== "CLICOLOR" &&
        k !== "CLICOLOR_FORCE"
      ) {
        env[k] = v;
      }
    }
    return env;
  };

  test("piped formatManagerProbeTable emits no ANSI escapes by default, enables with FORCE_COLOR=1, and suppresses with NO_COLOR=1", () => {
    const script = [
      'import { formatManagerProbeTable } from "./lib/gslive_manager_endpoints.ts";',
      'const out = formatManagerProbeTable([{ kind: "live-data", url: "https://example.test", status: "ok", httpStatus: 200, latencyMs: 12, count: 1 }]);',
      "process.stdout.write(out);",
    ].join("\n");

    const base = Bun.spawnSync(["bun", "-e", script], {
      env: cleanEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(base.exitCode).toBe(0);
    expect(base.stdout.toString()).not.toContain("\x1b[");
    expect(base.stderr.toString()).not.toContain("\x1b[");

    const forced = Bun.spawnSync(["bun", "-e", script], {
      env: { ...cleanEnv(), FORCE_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout.toString()).toContain("\x1b[");

    const noColor = Bun.spawnSync(["bun", "-e", script], {
      env: { ...cleanEnv(), NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(noColor.exitCode).toBe(0);
    expect(noColor.stdout.toString()).not.toContain("\x1b[");
    expect(noColor.stderr.toString()).not.toContain("\x1b[");
  });

  test("formatManagerProbeTable respects explicit colors=false and colors=true overrides", () => {
    const probes = [
      {
        kind: "live-data" as const,
        url: "https://example.test",
        status: "ok" as const,
        httpStatus: 200,
        latencyMs: 12,
        count: 1,
        checkedAt: "2026-11-17T00:00:00Z",
        error: null,
      },
    ];
    expect(formatManagerProbeTable(probes, false)).not.toContain("\x1b[");
    expect(formatManagerProbeTable(probes, true)).toContain("\x1b[");
  });
});
