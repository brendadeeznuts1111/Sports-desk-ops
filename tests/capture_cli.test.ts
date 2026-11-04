import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateLiveGate,
  parseArgs,
  runCli,
  type CliDeps,
  type LiveAuthConfig,
  type LiveAuthSession,
} from "../scripts/evidence_capture.ts";
import {
  AllowlistError,
  assertReadOnly,
  normalizeOperationName,
  parseOpsArgument,
  READ_ONLY_OPS,
} from "../scripts/capture/allowlist.ts";
import {
  assertCaptureManifest,
  buildCaptureRecord,
  CaptureStore,
  loadCaptureStore,
} from "../scripts/capture/recorder.ts";
import { SessionError } from "../scripts/capture/session.ts";
import type {
  CaptureRecord,
  Env,
  HttpTransport,
  RawHttpRequest,
} from "../scripts/capture/types.ts";

const ROOT = join(import.meta.dir, "..");
const OPENAPI_PATH = join(ROOT, "docs", "openapi.json");

/**
 * Build a credential-bearing URL at runtime so the repository credential
 * scanner never sees a committed `scheme://user:pass@` literal.
 */
function credentialUrl(
  scheme: string,
  credentials: string,
  rest: string,
): string {
  return `${scheme}://${credentials}@${rest}`;
}

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function baseEnv(overrides: Record<string, string | undefined> = {}): Env {
  const env: Env = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value !== undefined && !key.startsWith("F402_")) env[key] = value;
  }
  // The repo `.env` is auto-loaded by `bun run` and would otherwise fill the
  // real capture-gate credentials into refusal tests. Pin the gate keys to an
  // explicit empty value so a child cannot inherit live credentials unless a
  // test opts in through `overrides`.
  for (const key of [
    "F402_LIVE_CAPTURE",
    "F402_BASE_URL",
    "F402_AGENT_ID",
    "F402_PASSWORD",
    "F402_OFFLINE_ONLY",
  ]) {
    env[key] = "";
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCliProcess(
  args: readonly string[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<SpawnResult> {
  const env = baseEnv(envOverrides);
  const stringEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) stringEnv[key] = value;
  }
  const proc = Bun.spawn({
    cmd: ["bun", "run", "scripts/evidence_capture.ts", ...args],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: stringEnv,
  });
  const stdout = await proc.stdout.text();
  const stderr = await proc.stderr.text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
  const lines = stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  expect(lines).toHaveLength(1);
  const parsed: unknown = JSON.parse(lines[0] ?? "");
  if (!isRecordValue(parsed)) {
    throw new Error("expected a JSON object on stdout");
  }
  return parsed;
}

describe("argument parsing and allowlist", () => {
  test("defaults to an offline mock run writing nothing", () => {
    const parsed = parseArgs([]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.mode).toBe("mock");
    expect(parsed.options.opsArg).toBe("all");
    expect(parsed.options.dryRun).toBe(false);
    expect(parsed.options.json).toBe(false);
    expect(parsed.options.timeoutMs).toBe(20_000);
  });

  test("accepts --flag value and --flag=value forms", () => {
    const parsed = parseArgs([
      "--mode=live",
      "--ops",
      "getWebLog",
      "--out=/tmp/x",
      "--timeout-ms",
      "1500",
      "--dry-run",
      "--json",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.mode).toBe("live");
    expect(parsed.options.opsArg).toBe("getWebLog");
    expect(parsed.options.out).toBe("/tmp/x");
    expect(parsed.options.timeoutMs).toBe(1500);
    expect(parsed.options.dryRun).toBe(true);
    expect(parsed.options.json).toBe(true);
  });

  test("rejects unknown flags, bad modes and bad values", () => {
    expect(parseArgs(["--mode", "production"]).ok).toBe(false);
    expect(parseArgs(["--nope"]).ok).toBe(false);
    expect(parseArgs(["positional"]).ok).toBe(false);
    expect(parseArgs(["--timeout-ms", "0"]).ok).toBe(false);
    expect(parseArgs(["--out"]).ok).toBe(false);
    expect(parseArgs(["--proxy", "socks5://x:1"]).ok).toBe(false);
  });

  test("only the eight allowlisted read ops are accepted", () => {
    expect(parseOpsArgument("all")).toEqual([...READ_ONLY_OPS]);
    expect(parseOpsArgument(undefined)).toEqual([...READ_ONLY_OPS]);
    expect(parseOpsArgument("getWebLog,getPending")).toEqual([
      "getWebLog",
      "getPending",
    ]);
    expect(parseOpsArgument("/cloud/api/Manager/getWebLog")).toEqual([
      "getWebLog",
    ]);
    expect(parseOpsArgument("postCloudApiManagerGetBetTicker")).toEqual([
      "getBetTicker",
    ]);
  });

  test("mutations and unknown operations are refused by name", () => {
    for (const mutation of [
      "updateByColumn",
      "vigSetupInsert",
      "createPlayer",
      "adjustBalance",
      "deleteWager",
      "deleteSportsVigSetup",
      "updateCustomerNotes",
      "gameAdmin",
    ]) {
      expect(() => assertReadOnly(mutation)).toThrow(AllowlistError);
      expect(() => parseOpsArgument(mutation)).toThrow(AllowlistError);
    }
    expect(() => assertReadOnly("getSomethingUndocumented")).toThrow(
      AllowlistError,
    );
    expect(normalizeOperationName("/cloud/api/Manager/updateByColumn")).toBe(
      "updateByColumn",
    );
  });
});

describe("live gate", () => {
  test("is disabled without the opt-in flag and credentials", () => {
    const gate = evaluateLiveGate({});
    expect(gate.enabled).toBe(false);
    expect(gate.missing).toContain("F402_LIVE_CAPTURE=1");
    expect(gate.missing).toContain("F402_BASE_URL");
    expect(gate.missing).toContain("F402_AGENT_ID");
    expect(gate.missing).toContain("F402_PASSWORD");
  });

  test("is enabled only with the full env and refuses offline-only processes", () => {
    const full: Env = {
      F402_LIVE_CAPTURE: "1",
      F402_BASE_URL: "https://portal.example",
      F402_AGENT_ID: "AGENT-X",
      F402_PASSWORD: "secret",
    };
    expect(evaluateLiveGate(full).enabled).toBe(true);
    expect(
      evaluateLiveGate({ ...full, F402_OFFLINE_ONLY: "1" }).reason,
    ).toContain("F402_OFFLINE_ONLY");
  });
});

describe("CLI — mock end to end", () => {
  test("writes a valid store + manifest and never leaks fixture secrets", async () => {
    const out = join(tempDir("capture-mock-"), "store");
    const result = await runCliProcess([
      "--mode",
      "mock",
      "--out",
      out,
      "--json",
    ]);
    expect(result.code).toBe(0);
    const payload = parseJsonOutput(result.stdout);
    expect(payload["mode"]).toBe("mock");
    expect(payload["dryRun"]).toBe(false);
    expect(payload["outDir"]).toBe(out);
    expect(typeof payload["manifestHash"]).toBe("string");

    const counts = payload["counts"];
    if (!isRecordValue(counts)) {
      throw new Error("expected counts object");
    }
    expect(counts["total"]).toBe(READ_ONLY_OPS.length);

    const store = await loadCaptureStore(out);
    expect(store.captures).toHaveLength(READ_ONLY_OPS.length);
    expect(store.manifest.counts.mock).toBe(READ_ONLY_OPS.length);
    expect(store.manifest.counts.withResponse).toBe(READ_ONLY_OPS.length - 1);
    expect(store.manifest.counts.withoutResponse).toBe(1);
    // Every responding mock fixture is a non-empty 200, so the strict view
    // agrees with withResponse minus the response-less fixture.
    expect(store.manifest.counts.withSuccessResponse).toBe(
      READ_ONLY_OPS.length - 1,
    );
    expect(store.manifest.counts.withErrorResponse).toBe(0);
    expect(store.manifest.counts.emptyResponse).toBe(0);
    expect(store.manifest.counts.clean).toBe(READ_ONLY_OPS.length);
    for (const capture of store.captures) {
      expect(capture.record.mode).toBe("mock");
      expect(capture.record.redaction.clean).toBe(true);
      expect(capture.record.provenance.auth).toBe("none");
    }

    const missingResponse = store.captures.find(
      (capture) => capture.record.response === null,
    );
    expect(missingResponse?.record.operation.path).toBe(
      "/cloud/api/Manager/getCustomerNotes",
    );

    const webLog = store.captures.find((capture) =>
      capture.record.operation.path.endsWith("/getWebLog"),
    );
    expect(webLog).toBeDefined();
    if (webLog === undefined) return;
    const recordText = await Bun.file(
      join(out, ...webLog.entry.file.split("/")),
    ).text();
    for (const secret of [
      "fixture-not-a-real-token",
      "fixture-cookie-not-real",
      "DEMO-AGENT",
      "4821",
      "7730",
      "203.0.113.9",
      "198.51.100.7",
      "2026-10-28T12:04:11Z",
    ]) {
      expect(recordText).not.toContain(secret);
    }
    expect(webLog.record.request.headers["authorization"]).toBe("<redacted>");
    expect(webLog.record.request.headers["cookie"]).toBe("<redacted>");
    expect(webLog.record.request.headers["accept"]).toBe("application/json");
  }, 20_000);

  test("dry-run writes nothing and reports the plan", async () => {
    const parent = tempDir("capture-dry-");
    const out = join(parent, "store");
    const result = await runCliProcess([
      "--mode",
      "mock",
      "--dry-run",
      "--out",
      out,
      "--json",
    ]);
    expect(result.code).toBe(0);
    const payload = parseJsonOutput(result.stdout);
    expect(payload["dryRun"]).toBe(true);
    expect(payload["writes"]).toBe(false);
    expect(payload["targetHost"]).toBe("mock.invalid");
    expect(existsSync(out)).toBe(false);
    const ops = payload["ops"];
    expect(Array.isArray(ops)).toBe(true);
    if (!Array.isArray(ops)) return;
    expect(ops).toHaveLength(READ_ONLY_OPS.length);
    const first = ops[0];
    if (!isRecordValue(first)) return;
    expect(first["op"]).toBe("getWebLog");
  }, 20_000);

  test("is deterministic across runs", async () => {
    const outA = join(tempDir("capture-det-a-"), "store");
    const outB = join(tempDir("capture-det-b-"), "store");
    const runA = await runCliProcess([
      "--mode",
      "mock",
      "--out",
      outA,
      "--json",
    ]);
    const runB = await runCliProcess([
      "--mode",
      "mock",
      "--out",
      outB,
      "--json",
    ]);
    expect(runA.code).toBe(0);
    expect(runB.code).toBe(0);
    const storeA = await loadCaptureStore(outA);
    const storeB = await loadCaptureStore(outB);
    expect(storeA.manifest.captures.map((entry) => entry.captureHash)).toEqual(
      storeB.manifest.captures.map((entry) => entry.captureHash),
    );
    expect(storeA.manifest.generatedAt).toBe(storeB.manifest.generatedAt);
  }, 30_000);

  test("--ops subsets the run", async () => {
    const out = join(tempDir("capture-subset-"), "store");
    const result = await runCliProcess([
      "--mode",
      "mock",
      "--ops",
      "getWebLog",
      "--out",
      out,
      "--json",
    ]);
    expect(result.code).toBe(0);
    const store = await loadCaptureStore(out);
    expect(store.captures).toHaveLength(1);
    expect(store.captures[0]?.record.operation.path).toBe(
      "/cloud/api/Manager/getWebLog",
    );
  }, 20_000);
});

describe("CLI — refusals", () => {
  test("live mode exits 2 without the env gate and names only env var names", async () => {
    const out = join(tempDir("capture-live-refuse-"), "store");
    const result = await runCliProcess([
      "--mode",
      "live",
      "--out",
      out,
      "--json",
    ]);
    expect(result.code).toBe(2);
    const payload = parseJsonOutput(result.stdout);
    expect(payload["ok"]).toBe(false);
    const error = payload["error"];
    if (!isRecordValue(error)) return;
    expect(error["code"]).toBe("LIVE_GATE");
    const message = String(error["message"]);
    expect(message).toContain("F402_LIVE_CAPTURE");
    expect(message).toContain("F402_BASE_URL");
    expect(existsSync(out)).toBe(false);
  }, 20_000);

  test("live mode exits 2 with partial credentials", async () => {
    const result = await runCliProcess(
      ["--mode", "live", "--dry-run", "--json"],
      {
        F402_LIVE_CAPTURE: "1",
        F402_BASE_URL: "https://portal.example",
        F402_AGENT_ID: "AGENT-X",
      },
    );
    expect(result.code).toBe(2);
    const payload = parseJsonOutput(result.stdout);
    const error = payload["error"];
    if (!isRecordValue(error)) return;
    expect(error["missing"]).toEqual(["F402_PASSWORD"]);
  }, 20_000);

  test("mutation operations exit 2 before any work", async () => {
    const out = join(tempDir("capture-mut-"), "store");
    const result = await runCliProcess([
      "--mode",
      "mock",
      "--ops",
      "updateByColumn",
      "--out",
      out,
      "--json",
    ]);
    expect(result.code).toBe(2);
    const payload = parseJsonOutput(result.stdout);
    expect(payload["ok"]).toBe(false);
    const error = payload["error"];
    if (!isRecordValue(error)) return;
    expect(error["code"]).toBe("OFF_ALLOWLIST");
    expect(existsSync(out)).toBe(false);
  }, 20_000);

  test("unknown operations exit 2", async () => {
    const result = await runCliProcess([
      "--mode",
      "mock",
      "--ops",
      "getSomethingUndocumented",
      "--json",
    ]);
    expect(result.code).toBe(2);
  }, 20_000);

  test("--help exits 0 with examples", async () => {
    const result = await runCliProcess(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Examples:");
    expect(result.stdout).toContain("--mode mock --out /tmp/cap-test");
  }, 20_000);
});

describe("CLI — live dry-run (no browser, no network)", () => {
  test("plans live ops with the --proxy override and writes nothing", async () => {
    const parent = tempDir("capture-live-dry-spawn-");
    const out = join(parent, "store");
    const result = await runCliProcess(
      [
        "--mode",
        "live",
        "--dry-run",
        "--ops",
        "getWebLog",
        "--proxy",
        "http://127.0.0.1:9",
        "--out",
        out,
        "--json",
      ],
      {
        F402_LIVE_CAPTURE: "1",
        F402_BASE_URL: "https://portal.invalid",
        F402_AGENT_ID: "AGENT-X",
        F402_PASSWORD: "secret-password",
      },
    );
    expect(result.code).toBe(0);
    const payload = parseJsonOutput(result.stdout);
    expect(payload["dryRun"]).toBe(true);
    expect(payload["writes"]).toBe(false);
    expect(payload["targetHost"]).toBe("portal.invalid");
    const proxy = payload["proxy"];
    if (!isRecordValue(proxy)) return;
    expect(proxy["present"]).toBe(true);
    expect(proxy["http"]).toBe("http://127.0.0.1:9");
    const ops = payload["ops"];
    if (!Array.isArray(ops)) return;
    expect(ops).toHaveLength(1);
    expect(existsSync(out)).toBe(false);
    for (const leaked of ["secret-password", "AGENT-X"]) {
      expect(result.stdout).not.toContain(leaked);
      expect(result.stderr).not.toContain(leaked);
    }
  }, 20_000);
});

describe("CLI — live pipeline with injected browser/transport (no network)", () => {
  interface FakeLiveState {
    requests: RawHttpRequest[];
    authConfigs: LiveAuthConfig[];
    closed: number;
  }

  function makeDeps(env: Env, state: FakeLiveState): Partial<CliDeps> {
    const transport: HttpTransport = {
      kind: "live",
      fetch: async (request: RawHttpRequest) => {
        state.requests.push(request);
        const body = JSON.stringify({
          INFO: true,
          Player: {
            customerID: "4821",
            ipAddress: "203.0.113.9",
            Login: "DEMO101",
            Status: "Active",
          },
        });
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          contentType: "application/json",
          bytes: new TextEncoder().encode(body),
        };
      },
      close: async () => {
        state.closed += 1;
      },
    };
    return {
      env,
      now: () => new Date("2026-10-30T12:00:00.000Z"),
      stdout: () => {},
      stderr: () => {},
      createAuthSession: async (
        config: LiveAuthConfig,
      ): Promise<LiveAuthSession> => {
        state.authConfigs.push(config);
        return {
          cookieHeader: "session=SECRET-COOKIE; csrftoken=SECRET-CSRF",
          cookieNames: ["csrftoken", "session"],
          close: async () => {},
        };
      },
      createTransport: () => transport,
      loadOpenApi: async () => await Bun.file(OPENAPI_PATH).json(),
    };
  }

  test("captures mode:live records offline with redacted headers and value-free bodies", async () => {
    const out = join(tempDir("capture-live-di-"), "store");
    const state: FakeLiveState = { requests: [], authConfigs: [], closed: 0 };
    const env = baseEnv({
      F402_LIVE_CAPTURE: "1",
      F402_BASE_URL: "https://portal.invalid",
      F402_AGENT_ID: "AGENT-X",
      F402_PASSWORD: "secret-password",
    });
    const code = await runCli(
      [
        "--mode",
        "live",
        "--ops",
        "getWebLog,getInfoPlayer",
        "--out",
        out,
        "--json",
      ],
      makeDeps(env, state),
    );
    expect(code).toBe(0);
    expect(state.authConfigs).toHaveLength(1);
    expect(state.closed).toBe(1);

    // The cookie is handed to the transport in memory only.
    expect(state.requests).toHaveLength(2);
    for (const request of state.requests) {
      expect(request.headers?.["cookie"]).toBe(
        "session=SECRET-COOKIE; csrftoken=SECRET-CSRF",
      );
      expect(request.retryable).toBe(true);
    }
    const webLogRequest = state.requests.find((request) =>
      request.url.endsWith("/getWebLog"),
    );
    expect(webLogRequest).toBeDefined();
    if (webLogRequest === undefined) return;
    expect(webLogRequest.body).toContain("type=B");
    expect(webLogRequest.body).toContain("agentID=AGENT-X");

    const store = await loadCaptureStore(out);
    expect(store.captures).toHaveLength(2);
    expect(store.manifest.counts.live).toBe(2);
    expect(store.manifest.counts.clean).toBe(2);
    for (const capture of store.captures) {
      expect(capture.record.mode).toBe("live");
      expect(capture.record.provenance.auth).toBe("cookie");
      expect(capture.record.provenance.portalHost).toBe("portal.invalid");
      expect(capture.record.response?.status).toBe(200);
      expect(capture.record.request.headers["cookie"]).toBe("<redacted>");
      const text = await Bun.file(
        join(out, ...capture.entry.file.split("/")),
      ).text();
      for (const secret of [
        "SECRET-COOKIE",
        "SECRET-CSRF",
        "secret-password",
        "AGENT-X",
        "4821",
        "203.0.113.9",
        "DEMO101",
      ]) {
        expect(text).not.toContain(secret);
      }
    }
  }, 20_000);

  test("live dry-run plans without auth, transport or writes", async () => {
    const parent = tempDir("capture-live-dry-");
    const out = join(parent, "store");
    const state: FakeLiveState = { requests: [], authConfigs: [], closed: 0 };
    const env = baseEnv({
      F402_LIVE_CAPTURE: "1",
      F402_BASE_URL: "https://portal.invalid",
      F402_AGENT_ID: "AGENT-X",
      F402_PASSWORD: "secret-password",
    });
    const code = await runCli(
      [
        "--mode",
        "live",
        "--dry-run",
        "--ops",
        "getWebLog",
        "--out",
        out,
        "--json",
      ],
      makeDeps(env, state),
    );
    expect(code).toBe(0);
    expect(state.requests).toHaveLength(0);
    expect(state.authConfigs).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
  }, 20_000);

  test("live pipeline error is redacted and exits 1", async () => {
    const out = join(tempDir("capture-live-err-"), "store");
    const env = baseEnv({
      F402_LIVE_CAPTURE: "1",
      F402_BASE_URL: "https://portal.invalid",
      F402_AGENT_ID: "AGENT-X",
      F402_PASSWORD: "secret-password",
    });
    const stderrLines: string[] = [];
    const deps = makeDeps(env, { requests: [], authConfigs: [], closed: 0 });
    deps.createTransport = () => ({
      kind: "live",
      fetch: async () => {
        throw new Error(
          `boom ${credentialUrl("https", "user:hunter2", "portal.invalid/api?token=SECRET")} Bearer abcdefghijkl`,
        );
      },
      close: async () => {},
    });
    deps.stderr = (line: string) => {
      stderrLines.push(line);
    };
    const code = await runCli(
      ["--mode", "live", "--ops", "getWebLog", "--out", out],
      deps,
    );
    expect(code).toBe(1);
    const output = stderrLines.join("\n");
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("SECRET");
    expect(output).not.toContain("abcdefghijkl");
    expect(output).toContain("portal.invalid");
  }, 20_000);

  test("a failing live request is recorded as response:null instead of discarding the run", async () => {
    const out = join(tempDir("capture-live-partial-"), "store");
    const env = baseEnv({
      F402_LIVE_CAPTURE: "1",
      F402_BASE_URL: "https://portal.invalid",
      F402_AGENT_ID: "AGENT-X",
      F402_PASSWORD: "secret-password",
    });
    const stderrLines: string[] = [];
    let calls = 0;
    const deps = makeDeps(env, { requests: [], authConfigs: [], closed: 0 });
    deps.stderr = (line: string) => {
      stderrLines.push(line);
    };
    deps.createTransport = () => ({
      kind: "live",
      fetch: async () => {
        calls += 1;
        if (calls === 2) {
          throw new SessionError(
            "network",
            "request failed for https://portal.invalid/cloud/api/Manager/getInfoPlayer?token=SECRET123: boom",
          );
        }
        const bytes = new TextEncoder().encode(
          JSON.stringify({ INFO: true, Player: { customerID: "4821" } }),
        );
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          contentType: "application/json",
          bytes,
        };
      },
      close: async () => {},
    });
    const code = await runCli(
      ["--mode", "live", "--ops", "getWebLog,getInfoPlayer", "--out", out],
      deps,
    );
    expect(code).toBe(0);
    const store = await loadCaptureStore(out);
    expect(store.captures).toHaveLength(2);
    expect(store.manifest.counts.withResponse).toBe(1);
    expect(store.manifest.counts.withoutResponse).toBe(1);
    expect(store.manifest.counts.withSuccessResponse).toBe(1);
    expect(store.manifest.counts.withErrorResponse).toBe(0);
    expect(store.manifest.counts.emptyResponse).toBe(0);
    const failed = store.captures.find(
      (capture) => capture.record.response === null,
    );
    expect(failed?.record.operation.path).toBe(
      "/cloud/api/Manager/getInfoPlayer",
    );
    const output = stderrLines.join("\n");
    expect(output).toContain("response:null");
    expect(output).not.toContain("SECRET123");
  }, 20_000);
});

describe("manifest response accounting", () => {
  function captureRecord(input: {
    path: string;
    status: number | null;
    body?: string;
  }): CaptureRecord {
    return buildCaptureRecord({
      mode: "live",
      capturedAt: "2026-10-31T00:00:00.000Z",
      operation: { path: input.path, method: "POST" },
      request: {
        url: `https://portal.invalid${input.path}`,
        method: "POST",
        headers: {},
        contentType: "application/x-www-form-urlencoded",
        body: "operation=fixture&RRO=1",
      },
      response:
        input.status === null
          ? null
          : {
              status: input.status,
              headers: { "content-type": "application/json" },
              contentType: "application/json",
              bytes: new TextEncoder().encode(input.body ?? ""),
            },
      provenance: {
        portalHost: "portal.invalid",
        proxy: "none",
        auth: "cookie",
        bunVersion: "1.4.4",
      },
    });
  }

  test("counts 2xx, error, empty-body and missing responses separately", async () => {
    const out = join(tempDir("capture-counts-"), "store");
    const store = new CaptureStore({
      root: out,
      now: () => new Date("2026-10-31T00:00:00.000Z"),
    });
    for (const record of [
      captureRecord({
        path: "/cloud/api/Manager/getWebLog",
        status: 200,
        body: JSON.stringify({ INFO: true }),
      }),
      captureRecord({
        path: "/cloud/api/Manager/getPending",
        status: 500,
        body: JSON.stringify({ error: "boom" }),
      }),
      captureRecord({
        path: "/cloud/api/Manager/getInfoPlayer",
        status: 200,
        body: "",
      }),
      captureRecord({
        path: "/cloud/api/Manager/getCustomerNotes",
        status: null,
      }),
    ]) {
      await store.write(record);
    }

    const manifest = await store.finalize();
    expect(manifest.counts).toMatchObject({
      total: 4,
      withResponse: 3,
      withoutResponse: 1,
      withSuccessResponse: 2,
      withErrorResponse: 1,
      emptyResponse: 1,
    });
    // withResponse keeps its old "any HTTP response" meaning, 500 included.
    expect(manifest.counts.withResponse).toBe(3);

    // The empty body is an independent axis: the empty 200 is counted in both
    // withSuccessResponse and emptyResponse.
    const loaded = await loadCaptureStore(out);
    expect(loaded.manifest.counts).toEqual(manifest.counts);
    const empty = loaded.captures.find(
      (capture) => capture.entry.responseBytes === 0,
    );
    expect(empty?.record.response?.status).toBe(200);
    expect(empty?.record.operation.path).toBe(
      "/cloud/api/Manager/getInfoPlayer",
    );
  });

  test("rejects a manifest whose strict counts do not partition withResponse", async () => {
    const out = join(tempDir("capture-counts-invalid-"), "store");
    const store = new CaptureStore({ root: out });
    await store.write(
      captureRecord({
        path: "/cloud/api/Manager/getWebLog",
        status: 200,
        body: JSON.stringify({ INFO: true }),
      }),
    );
    const manifest = await store.finalize();
    const broken = JSON.parse(JSON.stringify(manifest)) as {
      counts: Record<string, number>;
    };
    broken.counts["withSuccessResponse"] = 0;
    expect(() => assertCaptureManifest(broken)).toThrow(/counts\.withResponse/);

    const emptyTooHigh = JSON.parse(JSON.stringify(manifest)) as {
      counts: Record<string, number>;
    };
    emptyTooHigh.counts["emptyResponse"] = 2;
    expect(() => assertCaptureManifest(emptyTooHigh)).toThrow(
      /counts\.emptyResponse/,
    );
  });
});
