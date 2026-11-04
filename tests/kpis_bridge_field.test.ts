/**
 * `/api/kpis` carries the last bridge rollup cycle so the dashboard's Review Queue can render it
 * without another route. The state file is the same one the reporting scheduler writes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readBridgeRollupState,
  startServer,
} from "../services/sportsdesk_webview_server.ts";

const env = Bun.env as unknown as Record<string, string | undefined>;
const saved = Bun.env.BRIDGE_ROLLUP_STATE_PATH;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(env, name);
  else Reflect.set(env, name, value);
}

const STATE = {
  updatedAt: "2026-11-04T06:00:00.000Z",
  jobs: [
    { id: "bridge3a", label: "Bet ticker", ok: true, durationMs: 120 },
    {
      id: "bridge3b",
      label: "Pending",
      ok: false,
      durationMs: 300,
      error: "missing credentials: F402_TOKEN_FILE",
    },
  ],
  alerts: [
    {
      id: "job:bridge3b:fail",
      severity: "critical",
      title: "bridge3b failed",
      detail: "missing credentials: F402_TOKEN_FILE",
    },
  ],
};

describe("bridge rollup state", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "kpis-bridge-"));
  });

  afterAll(async () => {
    setEnv("BRIDGE_ROLLUP_STATE_PATH", saved);
    await rm(dir, { recursive: true, force: true });
  });

  test("reads the scheduler's state file", async () => {
    const path = join(dir, "state.json");
    await writeFile(path, JSON.stringify(STATE));
    setEnv("BRIDGE_ROLLUP_STATE_PATH", path);
    expect(await readBridgeRollupState()).toEqual(STATE);
  });

  test("an absent file is an explicit empty state, not a throw", async () => {
    setEnv("BRIDGE_ROLLUP_STATE_PATH", join(dir, "absent.json"));
    expect(await readBridgeRollupState()).toEqual({
      updatedAt: null,
      jobs: [],
      alerts: [],
    });
  });

  test("malformed JSON degrades to the same empty state", async () => {
    const path = join(dir, "broken.json");
    await writeFile(path, "{not json");
    setEnv("BRIDGE_ROLLUP_STATE_PATH", path);
    expect(await readBridgeRollupState()).toEqual({
      updatedAt: null,
      jobs: [],
      alerts: [],
    });
  });
});

describe("/api/kpis bridge field", () => {
  let dir: string;
  let server: ReturnType<typeof startServer>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "kpis-bridge-http-"));
    const path = join(dir, "state.json");
    await writeFile(path, JSON.stringify(STATE));
    setEnv("BRIDGE_ROLLUP_STATE_PATH", path);
    server = startServer({ port: 0, hostname: "127.0.0.1" });
  });

  afterAll(async () => {
    server?.stop(true);
    setEnv("BRIDGE_ROLLUP_STATE_PATH", saved);
    await rm(dir, { recursive: true, force: true });
  });

  test("the KPI payload carries the cycle verbatim", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/kpis`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      bridge?: unknown;
      weblog?: unknown;
    };
    expect(body.bridge).toEqual(STATE);
    expect(body.weblog).toBeDefined();
  });
});
