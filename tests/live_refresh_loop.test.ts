/**
 * The daemon-side live refresh loop and the additive `live` block on `/api/status`.
 *
 * Every live read goes through an injected fetch and an injected clock; the loop's `lastTickAt`
 * comes from that clock, so the timestamps are deterministic. Persistence stays off (the
 * `NODE_ENV=test` default) and the Pending fallback artifact lives in a per-test temp dir, so no
 * suite here can rewrite the gitignored `data/` captures or reach fantasy402.com.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { F402ProbeFetch } from "../lib/f402_ingest.ts";
import { startServer } from "../services/sportsdesk_webview_server.ts";

const FIXED_NOW = new Date("2026-11-08T12:00:00.000Z");
const FIXED_AT = FIXED_NOW.toISOString();

/**
 * Module-private server config the injected seams below report back: the live-read TTLs, the
 * persistence throttle and the refresh interval default. Named so a changed default fails once.
 */
const LIVE_TICKER_TTL_MS = 60_000;
const LIVE_PENDING_TTL_MS = 60_000;
const LIVE_PERSIST_THROTTLE_MS = 60_000;
const LIVE_REFRESH_DEFAULT_MS = 60_000;

/** The explicit Pending customer scope; the fan-out POSTs once per entry. */
const PENDING_CUSTOMERS = ["H1716"];

/** Two raw `getBetTicker` rows: enough for the parser, no session or PII. */
const TICKER_ROWS: readonly Record<string, unknown>[] = [
  {
    WagerNumber: 1,
    TicketWriter: "GSLIVE",
    WagerType: "S",
    AmountWagered: 100,
    ToWinAmount: 90,
  },
  {
    WagerNumber: 2,
    TicketWriter: "Internet",
    WagerType: "P",
    AmountWagered: 50,
    ToWinAmount: 120,
  },
];

/** Two raw `Report/Pending` legs for the explicit `H1716` scope. */
const PENDING_ROWS: readonly Record<string, unknown>[] = [
  {
    TicketNumber: "T9001",
    WagerNumber: 1,
    AgentID: "AG1",
    AmountWagered: 1_000,
    ToWinAmount: 900,
    SportType: "Basketball",
    SportSubType: "NBA",
    Team1ID: "Lakers",
    Team2ID: "Celtics",
    customerID: "H1716",
  },
  {
    TicketNumber: "T9002",
    WagerNumber: 2,
    AgentID: "AG1",
    AmountWagered: 2_500,
    ToWinAmount: 3_000,
    SportType: "Basketball",
    SportSubType: "NBA",
    Team1ID: "Suns",
    Team2ID: "Nuggets",
    customerID: "H1716",
  },
];

interface LiveTickerStatusBody {
  mode: "auto" | "live" | "file";
  status: "live" | "unavailable" | "disabled";
  ok: boolean;
  fetchedAt: string | null;
  servedFromCache: boolean;
  transport: string | null;
  diagnostic: { code: string; message?: string } | null;
  ttlMs: number;
}

interface LivePendingStatusBody extends LiveTickerStatusBody {
  customersAttempted: number;
  customersFailed: number;
}

interface LiveRefreshBody {
  enabled: boolean;
  intervalMs: number;
  ticks: number;
  lastTickAt: string | null;
  lastTickOk: boolean | null;
  lastError: string | null;
}

interface StatusBody {
  ok: boolean;
  status: string;
  live?: {
    ticker: LiveTickerStatusBody | null;
    pending: LivePendingStatusBody | null;
    refresh: LiveRefreshBody;
    persistence: {
      enabled: boolean;
      artifactRoot: "repo" | "custom";
      throttleMs: number;
    };
  };
}

interface CountingFetch {
  readonly fetchImpl: F402ProbeFetch;
  readonly calls: () => number;
}

/** An injected fetch that counts calls; nothing here can reach the network. */
function countingFetch(handler: () => Response): CountingFetch {
  let count = 0;
  return {
    calls: () => count,
    fetchImpl: async () => {
      count += 1;
      return handler();
    },
  };
}

const servers: Array<ReturnType<typeof startServer>> = [];
const stops: Array<() => void> = [];
const dirs: string[] = [];
/** `SPORTSDESK_LIVE_REFRESH_MS` as it was before each test that mutates it. */
const savedEnv = new Map<string, string | undefined>();

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Assign through the env object; `Bun.env` properties are typed readonly. */
function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, Bun.env[key]);
  Reflect.set(Bun.env, key, value);
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) Reflect.deleteProperty(Bun.env, key);
    else Reflect.set(Bun.env, key, value);
  }
  savedEnv.clear();
});

afterAll(() => {
  for (const stop of stops) stop();
  for (const server of servers) server.stop(true);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const response = await fetch(url);
  return { status: response.status, body: (await response.json()) as T };
}

/** Poll a predicate until it holds; the loop ticks on its own timer. */
async function waitFor(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

interface LiveServerOptions {
  readonly dir: string;
  readonly tickerFetch: F402ProbeFetch;
  readonly pendingFetch: F402ProbeFetch;
  readonly gates?: boolean;
  readonly liveRefresh?: {
    readonly enabled?: boolean;
    readonly intervalMs?: number;
    readonly jitterMs?: number;
    readonly onStarted?: (stop: () => void) => void;
  };
}

/** A server whose live reads are injected, its fallback artifacts live in a temp dir. */
function startLiveServer(
  options: LiveServerOptions,
): ReturnType<typeof startServer> {
  const server = startServer({
    port: 0,
    hostname: "127.0.0.1",
    development: false,
    wagerListDir: join(options.dir, "wagers"),
    liveBetsPath: join(options.dir, "live-bets.json"),
    liveTicker: {
      enabled: options.gates ?? true,
      fetch: options.tickerFetch,
      // No real session file: the injected fetch carries no credentials, and nothing can leak.
      session: null,
      agentId: "TESTAGENT",
      now: () => FIXED_NOW,
      env: {
        NODE_ENV: "test",
        F402_AGENT_ID: "TESTAGENT",
        SPORTSDESK_LIVE_TICKER_TTL_MS: String(LIVE_TICKER_TTL_MS),
      },
    },
    livePending: {
      enabled: options.gates ?? true,
      fetch: options.pendingFetch,
      session: null,
      customers: PENDING_CUSTOMERS,
      now: () => FIXED_NOW,
      env: {
        NODE_ENV: "test",
        SPORTSDESK_LIVE_PENDING_TTL_MS: String(LIVE_PENDING_TTL_MS),
        SPORTSDESK_LIVE_PENDING_CUSTOMERS: PENDING_CUSTOMERS.join(","),
      },
    },
    ...(options.liveRefresh === undefined
      ? {}
      : { liveRefresh: options.liveRefresh }),
  });
  servers.push(server);
  return server;
}

function tickerStub(): CountingFetch {
  return countingFetch(() => Response.json({ status: 1, LIST: TICKER_ROWS }));
}

function pendingStub(): CountingFetch {
  return countingFetch(() => Response.json({ Pending: PENDING_ROWS }));
}

describe("the refresh loop is off unless asked for", () => {
  test("a programmatic server reports no loop and no live reads", async () => {
    const dir = tempDir("live-refresh-default-");
    // Gates resolve to the test default (off); /api/status must not warm them either.
    const server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
      wagerListDir: join(dir, "wagers"),
      liveBetsPath: join(dir, "live-bets.json"),
      liveTicker: { env: { NODE_ENV: "test" } },
      livePending: { env: { NODE_ENV: "test" } },
    });
    servers.push(server);

    const { status, body } = await getJson<StatusBody>(
      `${server.url}api/status`,
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("serving");
    expect(body.live?.refresh).toEqual({
      enabled: false,
      intervalMs: LIVE_REFRESH_DEFAULT_MS,
      ticks: 0,
      lastTickAt: null,
      lastTickOk: null,
      lastError: null,
    });
    expect(body.live?.ticker).toBeNull();
    expect(body.live?.pending).toBeNull();
    expect(body.live?.persistence).toEqual({
      enabled: false,
      artifactRoot: "repo",
      throttleMs: LIVE_PERSIST_THROTTLE_MS,
    });

    // A second status poll is still not a read: ticks stay at zero.
    const second = await getJson<StatusBody>(`${server.url}status.json`);
    expect(second.body.live?.refresh.ticks).toBe(0);
    expect(second.body.live?.ticker).toBeNull();
    expect(second.body.live?.pending).toBeNull();
  });

  test("a tick with both live gates disabled does nothing", async () => {
    const dir = tempDir("live-refresh-gated-");
    const ticker = tickerStub();
    const pending = pendingStub();
    const control: { stop: (() => void) | null } = { stop: null };
    const intervalMs = 10;
    const server = startLiveServer({
      dir,
      tickerFetch: ticker.fetchImpl,
      pendingFetch: pending.fetchImpl,
      gates: false,
      liveRefresh: {
        enabled: true,
        intervalMs,
        onStarted: (stop) => {
          control.stop = stop;
        },
      },
    });
    stops.push(() => control.stop?.());

    await Bun.sleep(50);
    const { body } = await getJson<StatusBody>(`${server.url}api/status`);
    expect(body.live?.refresh.enabled).toBe(true);
    expect(body.live?.refresh.ticks).toBe(0);
    expect(body.live?.ticker).toBeNull();
    expect(body.live?.pending).toBeNull();
    expect(ticker.calls()).toBe(0);
    expect(pending.calls()).toBe(0);
  });
});

describe("the enabled refresh loop", () => {
  test("force-reads both feeds, exposes live statuses, and stops cleanly", async () => {
    const dir = tempDir("live-refresh-on-");
    const ticker = tickerStub();
    const pending = pendingStub();
    const control: { stop: (() => void) | null } = { stop: null };
    const intervalMs = 15;
    const ticksToObserve = 2;
    const server = startLiveServer({
      dir,
      tickerFetch: ticker.fetchImpl,
      pendingFetch: pending.fetchImpl,
      liveRefresh: {
        enabled: true,
        intervalMs,
        onStarted: (stop) => {
          control.stop = stop;
        },
      },
    });
    stops.push(() => control.stop?.());
    expect(control.stop).not.toBeNull();

    await waitFor(async () => {
      const { body } = await getJson<StatusBody>(`${server.url}api/status`);
      return (body.live?.refresh.ticks ?? 0) >= ticksToObserve;
    }, `${ticksToObserve} refresh ticks`);

    const { body } = await getJson<StatusBody>(`${server.url}api/status`);
    // The live block is additive: it must never change the health derivation.
    expect(body.ok).toBe(true);
    expect(body.status).toBe("serving");

    expect(body.live?.refresh.enabled).toBe(true);
    expect(body.live?.refresh.intervalMs).toBe(intervalMs);
    expect(body.live?.refresh.lastTickOk).toBe(true);
    expect(body.live?.refresh.lastError).toBeNull();
    expect(body.live?.refresh.lastTickAt).toBe(FIXED_AT);

    // Both feeds were force-read, so neither status may claim a cached result.
    expect(body.live?.ticker).toMatchObject({
      mode: "auto",
      status: "live",
      ok: true,
      fetchedAt: FIXED_AT,
      servedFromCache: false,
      transport: "injected-fetch",
      ttlMs: LIVE_TICKER_TTL_MS,
    });
    expect(body.live?.pending).toMatchObject({
      mode: "auto",
      status: "live",
      ok: true,
      fetchedAt: FIXED_AT,
      servedFromCache: false,
      transport: "injected-fetch",
      customersAttempted: PENDING_CUSTOMERS.length,
      customersFailed: 0,
      ttlMs: LIVE_PENDING_TTL_MS,
    });
    // An injected fetch keeps persistence on the temp root, never the repo's data/.
    expect(body.live?.persistence).toEqual({
      enabled: false,
      artifactRoot: "custom",
      throttleMs: LIVE_PERSIST_THROTTLE_MS,
    });

    expect(ticker.calls()).toBeGreaterThanOrEqual(ticksToObserve);
    expect(pending.calls()).toBeGreaterThanOrEqual(ticksToObserve);

    control.stop?.();
    // Let a tick that was already in flight settle before taking the snapshot.
    await Bun.sleep(60);
    const settled = await getJson<StatusBody>(`${server.url}api/status`);
    const settledTicks = settled.body.live?.refresh.ticks ?? 0;
    const settledTickerCalls = ticker.calls();
    const settledPendingCalls = pending.calls();
    await Bun.sleep(60);
    const later = await getJson<StatusBody>(`${server.url}api/status`);
    expect(later.body.live?.refresh.ticks).toBe(settledTicks);
    expect(ticker.calls()).toBe(settledTickerCalls);
    expect(pending.calls()).toBe(settledPendingCalls);
  });

  test("a failed ticker read is telemetry only and does not skip the Pending read", async () => {
    const dir = tempDir("live-refresh-fail-");
    const ticker = countingFetch(() => new Response("denied", { status: 401 }));
    const pending = pendingStub();
    const control: { stop: (() => void) | null } = { stop: null };
    const intervalMs = 10;
    const server = startLiveServer({
      dir,
      tickerFetch: ticker.fetchImpl,
      pendingFetch: pending.fetchImpl,
      liveRefresh: {
        enabled: true,
        intervalMs,
        onStarted: (stop) => {
          control.stop = stop;
        },
      },
    });
    stops.push(() => control.stop?.());

    await waitFor(async () => {
      const { body } = await getJson<StatusBody>(`${server.url}api/status`);
      return (body.live?.refresh.ticks ?? 0) >= 1;
    }, "one refresh tick");

    const { body } = await getJson<StatusBody>(`${server.url}api/status`);
    expect(body.live?.refresh.lastTickOk).toBe(false);
    expect(body.live?.refresh.lastError).toContain("unauthorized");
    expect(body.live?.ticker).toMatchObject({
      status: "unavailable",
      ok: false,
    });
    // The tick does not stop at the failed ticker: the Pending book still refreshed.
    expect(body.live?.pending).toMatchObject({ status: "live", ok: true });
    expect(pending.calls()).toBeGreaterThanOrEqual(1);
  });
});

describe("option and env precedence", () => {
  test("SPORTSDESK_LIVE_REFRESH_MS=0 disables the daemon-style request", async () => {
    const dir = tempDir("live-refresh-env0-");
    setEnv("SPORTSDESK_LIVE_REFRESH_MS", "0");
    const ticker = tickerStub();
    const pending = pendingStub();
    const control: { started: boolean; stop: (() => void) | null } = {
      started: false,
      stop: null,
    };
    const server = startLiveServer({
      dir,
      tickerFetch: ticker.fetchImpl,
      pendingFetch: pending.fetchImpl,
      liveRefresh: {
        enabled: true,
        onStarted: (stop) => {
          control.started = true;
          control.stop = stop;
        },
      },
    });

    const { body } = await getJson<StatusBody>(`${server.url}api/status`);
    // The env value is the interval, and 0 is its off switch: `enabled: true` alone cannot
    // create a cadence, so the daemon's request stays off.
    expect(body.live?.refresh).toEqual({
      enabled: false,
      intervalMs: 0,
      ticks: 0,
      lastTickAt: null,
      lastTickOk: null,
      lastError: null,
    });
    expect(control.started).toBe(false);
    expect(control.stop).toBeNull();
    expect(ticker.calls()).toBe(0);
    expect(pending.calls()).toBe(0);
  });

  test("an explicit interval overrides the env off switch", async () => {
    const dir = tempDir("live-refresh-explicit-");
    setEnv("SPORTSDESK_LIVE_REFRESH_MS", "0");
    const ticker = tickerStub();
    const pending = pendingStub();
    const control: { stop: (() => void) | null } = { stop: null };
    const intervalMs = 10;
    const server = startLiveServer({
      dir,
      tickerFetch: ticker.fetchImpl,
      pendingFetch: pending.fetchImpl,
      liveRefresh: {
        enabled: true,
        intervalMs,
        onStarted: (stop) => {
          control.stop = stop;
        },
      },
    });
    stops.push(() => control.stop?.());

    const { body } = await getJson<StatusBody>(`${server.url}api/status`);
    expect(body.live?.refresh.enabled).toBe(true);
    expect(body.live?.refresh.intervalMs).toBe(intervalMs);
  });

  test("an explicit enabled: false wins over an env interval", async () => {
    const dir = tempDir("live-refresh-off-explicit-");
    const envIntervalMs = 9_000;
    setEnv("SPORTSDESK_LIVE_REFRESH_MS", String(envIntervalMs));
    const ticker = tickerStub();
    const pending = pendingStub();
    const server = startLiveServer({
      dir,
      tickerFetch: ticker.fetchImpl,
      pendingFetch: pending.fetchImpl,
      liveRefresh: { enabled: false },
    });

    const { body } = await getJson<StatusBody>(`${server.url}api/status`);
    expect(body.live?.refresh.enabled).toBe(false);
    expect(body.live?.refresh.intervalMs).toBe(envIntervalMs);
    expect(ticker.calls()).toBe(0);
    expect(pending.calls()).toBe(0);
  });

  test("the option opts in at the 60000 default when the env knob is unset", async () => {
    const dir = tempDir("live-refresh-default-interval-");
    const ticker = tickerStub();
    const pending = pendingStub();
    const control: { stop: (() => void) | null } = { stop: null };
    const server = startLiveServer({
      dir,
      tickerFetch: ticker.fetchImpl,
      pendingFetch: pending.fetchImpl,
      liveRefresh: {
        enabled: true,
        onStarted: (stop) => {
          control.stop = stop;
        },
      },
    });
    stops.push(() => control.stop?.());

    const { body } = await getJson<StatusBody>(`${server.url}api/status`);
    expect(body.live?.refresh).toMatchObject({
      enabled: true,
      intervalMs: LIVE_REFRESH_DEFAULT_MS,
      ticks: 0,
    });
    // The first tick waits one interval, so opting in does not read at boot.
    expect(ticker.calls()).toBe(0);
    expect(pending.calls()).toBe(0);
  });
});
