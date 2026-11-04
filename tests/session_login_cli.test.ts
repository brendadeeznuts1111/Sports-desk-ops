import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFromAuth, writeF402Session } from "../lib/f402_session.ts";

/**
 * `session:login` is the bridge between a WebView sign-in and the replay transport: the profile
 * directory holds the cookies, but `createF402ReplayTransport` never reads it, so the cookies have
 * to land in the 0600 session file. These tests cover the two paths that need no portal:
 * `--status` with and without a session, and `login` refusing to run without its gate.
 */

const dir = mkdtempSync(join(tmpdir(), "session-cli-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const script = join(import.meta.dir, "../scripts/session_login.ts");

function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", script, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      // Start every case from an empty auth environment.
      ...env,
    },
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

const sessionPath = join(dir, "session.json");
writeF402Session(
  sessionFromAuth({
    cookieHeader: "agent=abc; cf_clearance=def",
    cookieNames: ["agent", "cf_clearance"],
    authorizationHeader: "Bearer test",
  }),
  { path: sessionPath },
);

describe("session:status", () => {
  test("reports a missing session and exits non-zero", () => {
    const result = run(["--status", "--json"], {
      F402_SESSION_FILE: join(dir, "absent.json"),
    });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.session).toBe("no cached session");
    expect(report.transport).toContain("anonymous");
  });

  test("reports names and expiry, never the cookie value", () => {
    const result = run(["--status", "--json"], {
      F402_SESSION_FILE: sessionPath,
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.cookieNames).toEqual(["agent", "cf_clearance"]);
    expect(report.transport).toBe("session-file");
    // The cookie header itself must not appear anywhere in the output.
    expect(result.out).not.toContain("abc");
    expect(result.out).not.toContain("def");
  });

  test("without --json prints the same report through Bun.inspect, uncoloured off a terminal", () => {
    const result = run(["--status"], { F402_SESSION_FILE: sessionPath });
    expect(result.code).toBe(0);
    expect(result.out).toContain('transport: "session-file"');
    expect(result.out).toContain('cookieNames: [ "agent", "cf_clearance" ]');
    expect(result.out).not.toContain("\x1b[");
    expect(result.out).not.toContain("abc");
    expect(result.out).not.toContain("def");
  });

  test("calls out a profile that the transport cannot use", () => {
    const result = run(["--status", "--json"], {
      F402_SESSION_FILE: join(dir, "absent.json"),
      F402_WEBVIEW_PROFILE: join(dir, "profile"),
    });
    const report = JSON.parse(result.out);
    expect(report.profileNote).toContain("does not read it");
  });

  test("a proxy counts as configured even without a session", () => {
    const result = run(["--status", "--json"], {
      F402_SESSION_FILE: join(dir, "absent.json"),
      F402_REPLAY_PROXY_URL: "http://127.0.0.1:9999",
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).transport).toContain("proxy");
  });
});

describe("session:login", () => {
  test("refuses to start without F402_LIVE_LOGIN=1, and says what to set", () => {
    const result = run([], { F402_SESSION_FILE: join(dir, "absent.json") });
    expect(result.code).toBe(2);
    expect(result.err).toContain("F402_LIVE_LOGIN=1");
    expect(result.err).toContain("F402_AGENT_ID");
  });

  test("refuses to start without credentials once the gate is open", () => {
    const result = run([], {
      F402_LIVE_LOGIN: "1",
      F402_SESSION_FILE: join(dir, "absent.json"),
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("F402_AGENT_ID and F402_PASSWORD");
  });
});
