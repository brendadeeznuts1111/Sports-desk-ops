import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BRIDGE_ROLLUP_JOBS,
  formatBridgeDigestHtml,
  runBridgeRollupCycle,
  type BridgeAlert,
  type BridgeRollupCycleOptions,
  type BridgeRollupCycleResult,
  type BridgeRollupJobId,
  type BridgeSpawnResult,
} from "../lib/bridge_rollup_cron.ts";

type Artifacts = Partial<Record<BridgeRollupJobId, unknown>>;

const STATE_REL = join("scratch", "bridge-rollup-state.json");
const HISTORY_REL = join("scratch", "bridge-rollup-cron.jsonl");
const NOW = 1_760_000_000_000;

const ZERO_FLAGS = {
  executionSnipers: 0,
  sniperTwins: 0,
  crossOfficeBeards: 0,
  botRingAccounts: 0,
  lineShoppers: 0,
} as const;

function pendingArtifact(
  gateStatus: "pass" | "fail" = "pass",
): Record<string, unknown> {
  return {
    kind: "f402-pending",
    deskDate: "2026-11-03",
    generatedAt: "2026-11-03T12:00:00.000Z",
    gates: [
      { gate: 1, status: "pass" },
      { gate: 2, status: gateStatus },
      { gate: 8, status: "skipped" },
    ],
  };
}

function weblogArtifact(
  flags: Partial<Record<keyof typeof ZERO_FLAGS, number>> = {},
): Record<string, unknown> {
  return {
    kind: "f402-weblog",
    rows: { total: 100, parsed: 99, malformed: 1 },
    flags: { ...ZERO_FLAGS, ...flags },
    gates: [{ gate: "GATE-WL-02", status: "pass" }],
    capturedAt: "2026-11-03T12:00:00.000Z",
  };
}

const OK_SPAWN = async (): Promise<BridgeSpawnResult> => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
});

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bridge-rollup-cron-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Run one cycle against a temp root: fixed clock, no network/CLI spawn, artifacts from the
 * per-test map. All paths use the production defaults resolved against the temp root.
 */
function cycle(
  root: string,
  artifacts: Artifacts,
  overrides: Partial<BridgeRollupCycleOptions> = {},
  nowMs = NOW,
): Promise<BridgeRollupCycleResult> {
  return runBridgeRollupCycle({
    root,
    env: { GSID: "test-session", F402_AGENT_ID: "TESTAGENT" },
    now: () => nowMs,
    spawnJob: OK_SPAWN,
    readArtifact: async (job) => artifacts[job.id] ?? null,
    ...overrides,
  });
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function readHistory(path: string): BridgeRollupCycleResult[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as BridgeRollupCycleResult);
}

function alertsBySeverity(
  alerts: readonly BridgeAlert[],
  severity: BridgeAlert["severity"],
): readonly BridgeAlert[] {
  return alerts.filter((alert) => alert.severity === severity);
}

describe("bridge rollup cycle", () => {
  test("first cycle establishes the baseline and emits no alerts", async () => {
    const root = makeRoot();
    const artifacts: Artifacts = {
      bridge3b: pendingArtifact(),
      bridge3c: pendingArtifact(),
      weblog: weblogArtifact(),
    };

    const result = await cycle(root, artifacts);

    expect(result.alerts).toEqual([]);
    expect(result.jobs).toHaveLength(4);
    expect(result.jobs.every((job) => job.ok)).toBe(true);
    expect(result.updatedAt).toBe(new Date(NOW).toISOString());

    const state = readJson(join(root, STATE_REL));
    expect(state["updatedAt"]).toBe(result.updatedAt);
    expect(Object.keys(state["artifacts"] as object).sort()).toEqual([
      "bridge3b",
      "bridge3c",
      "weblog",
    ]);
    expect(
      (state["artifactStatus"] as Record<string, string>)["bridge3a"],
    ).toBe("missing");
    expect((state["artifactStatus"] as Record<string, string>)["weblog"]).toBe(
      "ok",
    );
    const weblogSnapshot = (
      state["artifacts"] as Record<string, Record<string, unknown>>
    )["weblog"];
    expect(weblogSnapshot?.["deskDate"]).toBeNull();
    expect(weblogSnapshot?.["capturedAt"]).toBe("2026-11-03T12:00:00.000Z");
    expect(weblogSnapshot?.["rows"]).toEqual({
      total: 100,
      parsed: 99,
      malformed: 1,
    });

    const history = readHistory(join(root, HISTORY_REL));
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(result);
  });

  test("an unchanged second cycle emits nothing", async () => {
    const root = makeRoot();
    const artifacts: Artifacts = {
      bridge3b: pendingArtifact(),
      weblog: weblogArtifact(),
    };

    await cycle(root, artifacts, {}, NOW);
    const second = await cycle(root, artifacts, {}, NOW + 60_000);

    expect(second.alerts).toEqual([]);
    expect(second.jobs.every((job) => job.ok)).toBe(true);
    expect(readHistory(join(root, HISTORY_REL))).toHaveLength(2);
  });

  test("a gate that turns fail raises one critical alert", async () => {
    const root = makeRoot();
    const artifacts: Artifacts = { bridge3b: pendingArtifact("pass") };
    const options = { jobs: ["bridge3b"] as const };

    await cycle(root, artifacts, { jobs: [...options.jobs] });
    artifacts.bridge3b = pendingArtifact("fail");
    const second = await cycle(root, artifacts, { jobs: [...options.jobs] });

    expect(second.jobs[0]?.ok).toBe(true);
    expect(second.alerts).toHaveLength(1);
    expect(second.alerts[0]).toMatchObject({
      id: "gate:bridge3b:GATE-02",
      severity: "critical",
    });
    expect(second.alerts[0]?.detail).toContain("pass -> fail");

    // A third identical cycle must not re-alert the same standing failure.
    const third = await cycle(root, artifacts, { jobs: [...options.jobs] });
    expect(third.alerts).toEqual([]);
  });

  test("a flag crossing a threshold or leaving zero raises a warn", async () => {
    const root = makeRoot();
    const artifacts: Artifacts = { weblog: weblogArtifact() };

    await cycle(root, artifacts, { jobs: ["weblog"] });
    artifacts.weblog = weblogArtifact({
      executionSnipers: 6_000,
      botRingAccounts: 5,
    });
    const second = await cycle(root, artifacts, { jobs: ["weblog"] });

    expect(alertsBySeverity(second.alerts, "critical")).toEqual([]);
    expect(second.alerts.map((alert) => alert.id)).toEqual([
      "flag:f402-weblog:executionSnipers",
      "flag:f402-weblog:botRingAccounts",
    ]);
    expect(second.alerts[0]?.severity).toBe("warn");
    expect(second.alerts[0]?.detail).toContain("threshold 5000");
    expect(second.alerts[1]?.detail).toContain("0 -> 5");

    const third = await cycle(root, artifacts, { jobs: ["weblog"] });
    expect(third.alerts).toEqual([]);
  });

  test("the flag threshold is env-overridable", async () => {
    const root = makeRoot();
    const artifacts: Artifacts = {
      weblog: weblogArtifact({ executionSnipers: 100 }),
    };
    const jobs = ["weblog"] as const;

    await cycle(root, artifacts, { jobs: [...jobs] });
    artifacts.weblog = weblogArtifact({ executionSnipers: 6_000 });
    const crossed = await cycle(root, artifacts, { jobs: [...jobs] });
    expect(crossed.alerts.map((alert) => alert.id)).toEqual([
      "flag:f402-weblog:executionSnipers",
    ]);

    artifacts.weblog = weblogArtifact({ executionSnipers: 7_000 });
    const overridden = await cycle(root, artifacts, {
      jobs: [...jobs],
      env: { BRIDGE_ROLLUP_FLAG_THRESHOLD_EXECUTION_SNIPERS: "10000" },
    });
    expect(overridden.alerts).toEqual([]);
  });

  test("a crashed job is recorded, alerts, then recovers", async () => {
    const root = makeRoot();
    const artifacts: Artifacts = { bridge3b: pendingArtifact() };
    const jobs = ["bridge3b"] as const;

    await cycle(root, artifacts, { jobs: [...jobs] });
    const failed = await cycle(root, artifacts, {
      jobs: [...jobs],
      spawnJob: async () => ({
        exitCode: 2,
        stdout: "",
        stderr: "[bridge3b] fetching pending rows\npending fetch failed: 401\n",
        timedOut: false,
      }),
    });

    expect(failed.jobs[0]?.ok).toBe(false);
    expect(failed.jobs[0]?.error).toBe("exit 2: pending fetch failed: 401");
    expect(failed.alerts).toHaveLength(1);
    expect(failed.alerts[0]).toMatchObject({
      id: "job:bridge3b:fail",
      severity: "critical",
    });

    const recovered = await cycle(root, artifacts, { jobs: [...jobs] });
    expect(recovered.jobs[0]?.ok).toBe(true);
    expect(recovered.alerts).toHaveLength(1);
    expect(recovered.alerts[0]).toMatchObject({
      id: "job:bridge3b:recover",
      severity: "info",
    });
  });

  test("a timeout is recorded as a job failure instead of throwing", async () => {
    const root = makeRoot();
    const artifacts: Artifacts = {};

    await cycle(root, artifacts, { jobs: ["bridge3a"] });
    const timedOut = await cycle(root, artifacts, {
      jobs: ["bridge3a"],
      spawnJob: async () => ({
        exitCode: 143,
        stdout: "",
        stderr: "SIGKILL\n",
        timedOut: true,
      }),
    });

    expect(timedOut.jobs[0]?.ok).toBe(false);
    expect(timedOut.jobs[0]?.error).toBe("timeout after 120000ms: SIGKILL");
    expect(timedOut.alerts.map((alert) => alert.id)).toEqual([
      "job:bridge3a:fail",
    ]);
  });

  test("a throwing spawn is recorded as a job failure", async () => {
    const root = makeRoot();
    const artifacts: Artifacts = {};

    await cycle(root, artifacts, { jobs: ["bridge3a"] });
    const thrown = await cycle(root, artifacts, {
      jobs: ["bridge3a"],
      spawnJob: async () => {
        throw new Error("bun not found");
      },
    });

    expect(thrown.jobs[0]?.ok).toBe(false);
    expect(thrown.jobs[0]?.error).toBe("spawn failed: bun not found");
    expect(thrown.alerts.map((alert) => alert.id)).toEqual([
      "job:bridge3a:fail",
    ]);
  });

  test("missing credentials skip the spawn without re-alerting every tick", async () => {
    const root = makeRoot();
    const artifacts: Artifacts = { weblog: weblogArtifact() };
    const spawned: BridgeRollupJobId[] = [];
    const spawnJob = async (job: {
      readonly id: BridgeRollupJobId;
    }): Promise<BridgeSpawnResult> => {
      spawned.push(job.id);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const jobsForCycle = [
      "bridge3a",
      "bridge3b",
      "bridge3c",
      "weblog",
    ] as const;

    const first = await cycle(root, artifacts, {
      jobs: jobsForCycle,
      env: {},
      spawnJob,
    });

    expect(spawned).toEqual(["weblog"]);
    expect(first.alerts).toEqual([]);
    const agentError = "missing credentials: F402_AGENT_ID";
    const pendingError =
      "missing credentials: F402_TOKEN_FILE, F402_BEARER_TOKEN, GSLIVE_SESSION_ID, GSID";
    const tallyError =
      "missing credentials: GSLIVE_SESSION_ID, GSID, GSID_COOKIE, GSLIVE_SESSION_FILE";
    expect(first.jobs.find((job) => job.id === "bridge3a")).toMatchObject({
      ok: false,
      durationMs: 0,
      error: agentError,
    });
    expect(first.jobs.find((job) => job.id === "bridge3b")).toMatchObject({
      ok: false,
      durationMs: 0,
      error: pendingError,
    });
    expect(first.jobs.find((job) => job.id === "bridge3c")).toMatchObject({
      ok: false,
      durationMs: 0,
      error: tallyError,
    });
    expect(first.jobs.find((job) => job.id === "weblog")?.ok).toBe(true);

    const second = await cycle(root, artifacts, {
      jobs: jobsForCycle,
      env: {},
      spawnJob,
    });
    expect(second.alerts).toEqual([]);
    expect(spawned).toEqual(["weblog", "weblog"]);

    const withGsid = await cycle(root, artifacts, {
      jobs: ["bridge3b"],
      env: { GSID: "test-session" },
      spawnJob,
    });
    expect(withGsid.jobs[0]?.ok).toBe(true);
    expect(spawned).toContain("bridge3b");

    const withAgent = await cycle(root, artifacts, {
      jobs: ["bridge3a"],
      env: { F402_AGENT_ID: "TESTAGENT" },
      spawnJob,
    });
    expect(withAgent.jobs[0]?.ok).toBe(true);
    expect(spawned).toContain("bridge3a");
  });

  test("a successful job with no parseable artifact raises one warn", async () => {
    const root = makeRoot();
    const artifacts: Artifacts = { bridge3b: pendingArtifact() };
    const jobs = ["bridge3b"] as const;

    await cycle(root, artifacts, { jobs: [...jobs] });
    const missing = await cycle(root, artifacts, {
      jobs: [...jobs],
      readArtifact: async () => null,
    });

    expect(missing.jobs[0]?.ok).toBe(true);
    expect(missing.alerts).toHaveLength(1);
    expect(missing.alerts[0]).toMatchObject({
      id: "artifact:bridge3b:unreadable",
      severity: "warn",
    });

    const stillMissing = await cycle(root, artifacts, {
      jobs: [...jobs],
      readArtifact: async () => null,
    });
    expect(stillMissing.alerts).toEqual([]);
  });

  test("reads the last balanced stdout JSON block", async () => {
    const root = makeRoot();
    const jobs = ["bridge3b"] as const;
    let stdout =
      '[bridge3b] rows=3\n{"noise":true}\n{"deskDate":"2026-11-03","gates":[{"gate":1,"status":"pass"}]}\n';

    const spawnJob = async (): Promise<BridgeSpawnResult> => ({
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
    });
    await runBridgeRollupCycle({
      root,
      jobs: [...jobs],
      env: { GSID: "test-session" },
      now: () => NOW,
      spawnJob,
    });
    stdout =
      '{"noise":true}\n[bridge3b] rows=3\n{\n  "deskDate": "2026-11-03",\n  "gates": [{"gate": 1, "status": "fail"}]\n}\n';
    const second = await runBridgeRollupCycle({
      root,
      jobs: [...jobs],
      env: { GSID: "test-session" },
      now: () => NOW + 60_000,
      spawnJob,
    });

    expect(second.alerts.map((alert) => alert.id)).toEqual([
      "gate:bridge3b:GATE-01",
    ]);
    const state = readJson(join(root, STATE_REL));
    const snapshot = (
      state["artifacts"] as Record<string, Record<string, unknown>>
    )["bridge3b"];
    expect(snapshot?.["deskDate"]).toBe("2026-11-03");
  });

  test("recovers 3b gates from its stderr summary when the receipt has none", async () => {
    const root = makeRoot();
    const jobs = ["bridge3b"] as const;
    let stderr = "[bridge3b] rows=3 GATE-01:pass GATE-02:pass GATE-08:skipped";
    const spawnJob = async (): Promise<BridgeSpawnResult> => ({
      exitCode: 0,
      stdout: '{"deskDate":"2026-11-03"}',
      stderr,
      timedOut: false,
    });

    await runBridgeRollupCycle({
      root,
      jobs: [...jobs],
      env: { GSID: "test-session" },
      now: () => NOW,
      spawnJob,
    });
    stderr = "[bridge3b] rows=3 GATE-01:fail GATE-02:pass GATE-08:skipped";
    const second = await runBridgeRollupCycle({
      root,
      jobs: [...jobs],
      env: { GSID: "test-session" },
      now: () => NOW + 60_000,
      spawnJob,
    });

    expect(second.alerts.map((alert) => alert.id)).toEqual([
      "gate:bridge3b:GATE-01",
    ]);
  });

  test("selects jobs in canonical order and substitutes {root} in argv", async () => {
    const root = makeRoot();
    const calls: { id: BridgeRollupJobId; argv: readonly string[] }[] = [];
    const artifacts: Artifacts = {
      bridge3c: pendingArtifact(),
      weblog: weblogArtifact(),
    };

    const result = await cycle(root, artifacts, {
      jobs: ["weblog", "bridge3c"],
      spawnJob: async (job, argv) => {
        calls.push({ id: job.id, argv });
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
    });

    expect(calls.map((call) => call.id)).toEqual(["bridge3c", "weblog"]);
    expect(result.jobs.map((job) => job.id)).toEqual(["bridge3c", "weblog"]);
    expect(calls[0]?.argv).toEqual([
      "bun",
      "--no-orphans",
      "--no-env-file",
      "run",
      "scripts/gslive_tally_bridge3c.ts",
      "--fetch-open",
      "--save-capture",
      join(root, "scratch", "bridge-rollup", "open-bets.json"),
      "--out",
      join(root, "scratch", "bridge-rollup", "bridge3c.json"),
    ]);
    expect(calls[1]?.argv).toEqual([
      "bun",
      "--no-orphans",
      "--no-env-file",
      "run",
      "scripts/f402_weblog_bridge.ts",
      "--out",
      join(root, "scratch", "bridge-rollup", "weblog.json"),
    ]);
    expect(BRIDGE_ROLLUP_JOBS.map((job) => job.id)).toEqual([
      "bridge3a",
      "bridge3b",
      "bridge3c",
      "weblog",
    ]);
  });

  test("declares the verified CLI flags and required env", () => {
    const byId = (id: BridgeRollupJobId) => {
      const job = BRIDGE_ROLLUP_JOBS.find((candidate) => candidate.id === id);
      if (job === undefined) throw new Error(`missing job ${id}`);
      return job;
    };

    expect(byId("bridge3a").args).toEqual([
      "bun",
      "--no-orphans",
      "--no-env-file",
      "run",
      "scripts/f402_bet_ticker_bridge3a.ts",
      "--once",
    ]);
    expect(byId("bridge3a").requiredEnv).toEqual(["F402_AGENT_ID"]);
    expect(byId("bridge3b").args).toEqual([
      "bun",
      "--no-orphans",
      "--no-env-file",
      "run",
      "scripts/f402_pending_bridge3b.ts",
    ]);
    expect(byId("bridge3b").requiredEnv).toEqual([
      "F402_TOKEN_FILE",
      "F402_BEARER_TOKEN",
      "GSLIVE_SESSION_ID",
      "GSID",
    ]);
    expect(byId("bridge3c").args).toEqual([
      "bun",
      "--no-orphans",
      "--no-env-file",
      "run",
      "scripts/gslive_tally_bridge3c.ts",
      "--fetch-open",
      "--save-capture",
      "{root}/scratch/bridge-rollup/open-bets.json",
      "--out",
      "{root}/scratch/bridge-rollup/bridge3c.json",
    ]);
    expect(byId("bridge3c").requiredEnv).toEqual([
      "GSLIVE_SESSION_ID",
      "GSID",
      "GSID_COOKIE",
      "GSLIVE_SESSION_FILE",
    ]);
    expect(byId("weblog").args).toEqual([
      "bun",
      "--no-orphans",
      "--no-env-file",
      "run",
      "scripts/f402_weblog_bridge.ts",
      "--out",
      "{root}/scratch/bridge-rollup/weblog.json",
    ]);
    expect(byId("weblog").requiredEnv).toEqual([]);
  });

  test("keeps the other schedule's alerts in state across subset cycles", async () => {
    const root = makeRoot();
    const artifacts: Artifacts = {
      bridge3b: pendingArtifact("fail"),
      weblog: weblogArtifact(),
    };

    // Hourly weblog schedule first: it establishes the weblog baseline.
    await cycle(root, artifacts, { jobs: ["weblog"] }, NOW);
    // 15-minute schedule's first bridge3b run: absent -> fail is a new regression.
    const firstBridge3b = await cycle(
      root,
      artifacts,
      { jobs: ["bridge3b"] },
      NOW + 60_000,
    );
    expect(firstBridge3b.alerts.map((alert) => alert.id)).toEqual([
      "gate:bridge3b:GATE-02",
    ]);
    const stateAfterFail = readJson(join(root, STATE_REL));
    expect(
      (stateAfterFail["alerts"] as { id: string }[]).map((alert) => alert.id),
    ).toEqual(["gate:bridge3b:GATE-02"]);

    // The hourly weblog tick returns no alerts, but must not erase bridge3b's standing alert.
    await cycle(root, artifacts, { jobs: ["weblog"] }, NOW + 120_000);
    const stateAfterWeblog = readJson(join(root, STATE_REL));
    expect(
      (stateAfterWeblog["alerts"] as { id: string }[]).map((alert) => alert.id),
    ).toEqual(["gate:bridge3b:GATE-02"]);

    // bridge3b recovers: the gate goes pass, so the carried alert clears on bridge3b's own tick
    // without touching anything weblog-owned.
    const recoveredArtifacts: Artifacts = {
      bridge3b: pendingArtifact("pass"),
      weblog: weblogArtifact(),
    };
    await cycle(
      root,
      recoveredArtifacts,
      { jobs: ["bridge3b"] },
      NOW + 180_000,
    );
    const stateAfterRecovery = readJson(join(root, STATE_REL));
    expect(stateAfterRecovery["alerts"]).toEqual([]);
  });

  test("keeps the other schedule's snapshot across subset cycles", async () => {
    const root = makeRoot();
    const artifacts: Artifacts = {
      bridge3b: pendingArtifact("fail"),
      weblog: weblogArtifact(),
    };

    // Hourly weblog schedule first: it establishes the weblog baseline.
    await cycle(root, artifacts, { jobs: ["weblog"] }, NOW);
    // 15-minute schedule's first bridge3b run: absent -> fail is a new regression.
    const firstBridge3b = await cycle(
      root,
      artifacts,
      { jobs: ["bridge3b"] },
      NOW + 60_000,
    );
    expect(firstBridge3b.alerts.map((alert) => alert.id)).toEqual([
      "gate:bridge3b:GATE-02",
    ]);
    // The hourly weblog tick must not forget bridge3b's failing gate...
    const weblogTick = await cycle(
      root,
      artifacts,
      { jobs: ["weblog"] },
      NOW + 120_000,
    );
    expect(weblogTick.alerts).toEqual([]);
    // ...so the next 15-minute tick does not re-alert the same standing failure.
    const secondBridge3b = await cycle(
      root,
      artifacts,
      { jobs: ["bridge3b"] },
      NOW + 180_000,
    );
    expect(secondBridge3b.alerts).toEqual([]);
  });

  test("rejects an unknown job id", async () => {
    await expect(
      runBridgeRollupCycle({
        root: makeRoot(),
        jobs: ["nope"] as unknown as BridgeRollupJobId[],
      }),
    ).rejects.toThrow("unknown bridge rollup job: nope");
  });

  test("writes state atomically and appends one history line per cycle", async () => {
    const root = makeRoot();
    const artifacts: Artifacts = { weblog: weblogArtifact() };

    await cycle(root, artifacts, { jobs: ["weblog"] }, NOW);
    await cycle(root, artifacts, { jobs: ["weblog"] }, NOW + 60_000);
    const last = await cycle(
      root,
      artifacts,
      { jobs: ["weblog"] },
      NOW + 120_000,
    );

    const state = readJson(join(root, STATE_REL));
    expect(state["updatedAt"]).toBe(new Date(NOW + 120_000).toISOString());
    expect(state["alerts"]).toEqual([]);

    const history = readHistory(join(root, HISTORY_REL));
    expect(history).toHaveLength(3);
    expect(history.map((entry) => entry.updatedAt)).toEqual([
      new Date(NOW).toISOString(),
      new Date(NOW + 60_000).toISOString(),
      last.updatedAt,
    ]);

    const scratchFiles = readdirSync(join(root, "scratch")).sort();
    expect(scratchFiles).toEqual([
      "bridge-rollup-cron.jsonl",
      "bridge-rollup-state.json",
    ]);
    expect(scratchFiles.some((name) => name.includes(".tmp-"))).toBe(false);
    expect(existsSync(join(root, STATE_REL))).toBe(true);
  });

  test("BRIDGE_ROLLUP_STATE_PATH redirects the state the scheduler reads", async () => {
    const root = makeRoot();
    const custom = join(root, "custom", "state.json");

    const result = await cycle(
      root,
      { weblog: weblogArtifact() },
      {
        jobs: ["weblog"],
        env: {
          GSID: "test-session",
          BRIDGE_ROLLUP_STATE_PATH: custom,
        },
      },
    );

    expect(existsSync(custom)).toBe(true);
    expect(existsSync(join(root, STATE_REL))).toBe(false);
    expect(readJson(custom)["updatedAt"]).toBe(result.updatedAt);
    expect(readHistory(join(root, HISTORY_REL))).toHaveLength(1);
  });
});

describe("bridge digest HTML", () => {
  const baseResult: BridgeRollupCycleResult = {
    updatedAt: "2026-11-03T12:00:00.000Z",
    jobs: [
      {
        id: "bridge3a",
        label: "Bet ticker poll (3a)",
        ok: true,
        durationMs: 12,
      },
      {
        id: "bridge3b",
        label: "Pending liability rollup (3b)",
        ok: false,
        durationMs: 40,
        error: "<boom> & co",
      },
    ],
    alerts: [
      {
        id: "gate:bridge3b:GATE-02",
        severity: "critical",
        title: "<GATE-02> & fail",
        detail: "pass < fail & why",
      },
    ],
  };

  test("lists failed jobs and escapes &, <, >", () => {
    const html = formatBridgeDigestHtml(baseResult);

    expect(html).toContain("<b>Bridge rollup</b>");
    expect(html).toContain("1/2 jobs ok");
    expect(html).toContain("FAIL <code>Pending liability rollup (3b)</code>");
    expect(html).toContain("&lt;boom&gt; &amp; co");
    expect(html).toContain("&lt;GATE-02&gt; &amp; fail");
    expect(html).toContain("pass &lt; fail &amp; why");
    expect(html).not.toContain("<boom>");
    expect(html).not.toContain("<GATE-02>");
    expect(html).not.toContain("<script");
  });

  test("quiet collapses a clean result to one all-quiet line", () => {
    const clean: BridgeRollupCycleResult = {
      updatedAt: baseResult.updatedAt,
      jobs: [baseResult.jobs[0]!],
      alerts: [],
    };

    expect(formatBridgeDigestHtml(clean, { quiet: true })).toContain(
      "all quiet",
    );
    expect(formatBridgeDigestHtml(clean, { quiet: true })).not.toContain(
      "FAIL",
    );
    expect(formatBridgeDigestHtml(clean)).toContain("1/1 jobs ok");
    expect(formatBridgeDigestHtml(clean)).not.toContain("all quiet");
  });

  test("quiet still names a failed job that has no alert yet", () => {
    const baselineFailure: BridgeRollupCycleResult = {
      updatedAt: baseResult.updatedAt,
      jobs: [baseResult.jobs[1]!],
      alerts: [],
    };
    const html = formatBridgeDigestHtml(baselineFailure, { quiet: true });

    expect(html).toContain("FAIL");
    expect(html).not.toContain("all quiet");
  });
});
