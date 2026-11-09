/**
 * Live-first `/api/live-wagers` and `/api/kpis`.
 *
 * Every live read in this file goes through an injected fetch and an injected clock, so no test
 * can reach fantasy402.com, the replay transport or the real session file. The capture artifact
 * the fallback tests use is written into a temp dir, never the gitignored `data/` files.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { F402ProbeFetch } from "../lib/f402_ingest.ts";
import { startServer } from "../services/sportsdesk_webview_server.ts";

/** Two raw `getBetTicker` rows: enough for the parser, no ShortDesc needed. */
const LIVE_ROWS = [
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

/** The captured-shape artifact rows the fallback path serves. */
const CAPTURE_ROWS = [
  {
    WagerNumber: 900,
    TicketWriter: "GSLIVE",
    WagerType: "S",
    AmountWagered: 10,
    ToWinAmount: 9,
  },
];

/**
 * Module-private server TTLs these tests pin: the live-read TTL the helper injects and the
 * default a gate-disabled server reports with no env TTL.
 */
const LIVE_TICKER_TTL_MS = 60_000;
const LIVE_TICKER_DEFAULT_TTL_MS = 10_000;

interface LiveStatusBody {
  mode: "auto" | "live" | "file";
  status: "live" | "unavailable" | "disabled";
  ok: boolean;
  fetchedAt: string | null;
  servedFromCache: boolean;
  transport: string | null;
  diagnostic: {
    code: string;
    message?: string;
    hint?: string;
    httpStatus?: number;
  } | null;
  ttlMs: number;
}

interface LiveWagersBody {
  success?: boolean;
  error?: string;
  hint?: string;
  provenance?: {
    source: string;
    observedAt: string | null;
    partial: boolean;
  };
  freshness?: { stale: boolean };
  skipped?: Array<{ path: string; reason: string }>;
  wagers?: Array<{ wagerNumber: number }>;
  live?: LiveStatusBody;
}

interface KpisBody {
  success: boolean;
  live?: LiveStatusBody;
  kpis: { ticker: { provenance: { source: string } } | null };
}

interface CountingFetch {
  readonly fetchImpl: F402ProbeFetch;
  readonly calls: () => number;
}

/** An injected fetch that counts calls; the handler runs only when the read is not cached. */
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

/** The captured-shape artifact the fallback path serves from the temp dir. */
async function writeCapture(dir: string, observedAt: string): Promise<void> {
  await Bun.write(
    join(dir, "live-wagers.json"),
    JSON.stringify({
      schemaVersion: 1,
      source: `capture:/cloud/api/Manager/getBetTicker@${observedAt}`,
      observedAt,
      partial: false,
      LIST: CAPTURE_ROWS,
    }),
  );
}

function startLiveServer(options: {
  readonly dir: string;
  readonly fetch: F402ProbeFetch;
  readonly now: () => Date;
  readonly ttlMs?: number;
}): ReturnType<typeof startServer> {
  return startServer({
    port: 0,
    hostname: "127.0.0.1",
    development: false,
    wagerListDir: options.dir,
    liveTicker: {
      enabled: true,
      fetch: options.fetch,
      // No real session file: the injected fetch carries no credentials, and nothing can leak.
      session: null,
      agentId: "TESTAGENT",
      env: {
        NODE_ENV: "test",
        F402_AGENT_ID: "TESTAGENT",
        SPORTSDESK_LIVE_TICKER_TTL_MS: String(
          options.ttlMs ?? LIVE_TICKER_TTL_MS,
        ),
      },
      now: options.now,
    },
  });
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as T };
}

describe("GET /api/live-wagers live-first", () => {
  let dir: string;
  let server: ReturnType<typeof startServer>;
  let counted: CountingFetch;
  let clockMs: number;
  const now = () => new Date(clockMs);
  let observedAt: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "live-ticker-ok-"));
    clockMs = Date.now();
    observedAt = new Date(clockMs).toISOString();
    // A capture exists, so a bare "live wins" claim is actually tested: it must outrank a file.
    await writeCapture(dir, observedAt);
    counted = countingFetch(() =>
      Response.json({ status: 1, LIST: LIVE_ROWS }),
    );
    server = startLiveServer({ dir, fetch: counted.fetchImpl, now });
  });

  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("serves the live rows with live provenance, not stale", async () => {
    const { status, body } = await getJson<LiveWagersBody>(
      `${server.url}api/live-wagers`,
    );
    expect(status).toBe(200);
    expect(body.provenance?.source.startsWith("live:")).toBe(true);
    expect(body.provenance?.partial).toBe(false);
    expect(body.freshness?.stale).toBe(false);
    expect(body.wagers?.map((w) => w.wagerNumber)).toEqual(
      LIVE_ROWS.map((row) => row.WagerNumber),
    );
    expect(counted.calls()).toBe(1);

    // The exact status object the dashboard renders; a field change must fail this test.
    expect(body.live).toEqual({
      mode: "live",
      status: "live",
      ok: true,
      fetchedAt: observedAt,
      servedFromCache: false,
      transport: "injected-fetch",
      diagnostic: null,
      ttlMs: LIVE_TICKER_TTL_MS,
    });
  });

  test("a second poll inside the TTL reuses the cached read", async () => {
    const before = counted.calls();
    const { body } = await getJson<LiveWagersBody>(
      `${server.url}api/live-wagers`,
    );
    expect(counted.calls()).toBe(before);
    expect(body.live?.servedFromCache).toBe(true);
    expect(body.live?.status).toBe("live");
    expect(body.provenance?.source.startsWith("live:")).toBe(true);
  });

  test("the captured file is reported as older than the live read", async () => {
    const { body } = await getJson<LiveWagersBody>(
      `${server.url}api/live-wagers`,
    );
    expect(body.skipped).toEqual([
      { path: "data/live-wagers.json", reason: "older than live:getBetTicker" },
    ]);
  });

  test("?source=live serves the live list explicitly", async () => {
    const { status, body } = await getJson<LiveWagersBody>(
      `${server.url}api/live-wagers?source=live`,
    );
    expect(status).toBe(200);
    expect(body.live?.mode).toBe("live");
    expect(body.live?.status).toBe("live");
    expect(body.provenance?.source.startsWith("live:")).toBe(true);
  });

  test("?source=file skips the live read and keeps the capture provenance", async () => {
    const before = counted.calls();
    const { status, body } = await getJson<LiveWagersBody>(
      `${server.url}api/live-wagers?source=file`,
    );
    expect(status).toBe(200);
    expect(counted.calls()).toBe(before);
    expect(body.live?.status).toBe("disabled");
    expect(body.live?.ok).toBe(false);
    expect(body.provenance?.source.startsWith("capture:")).toBe(true);
    expect(body.wagers?.map((w) => w.wagerNumber)).toEqual(
      CAPTURE_ROWS.map((row) => row.WagerNumber),
    );
  });

  test("/api/kpis shares the live-first ticker and the TTL cache", async () => {
    // Warm the cache, whatever the test order: /api/kpis must then be a cache hit.
    await getJson<LiveWagersBody>(`${server.url}api/live-wagers`);
    const before = counted.calls();
    const { status, body } = await getJson<KpisBody>(`${server.url}api/kpis`);
    expect(status).toBe(200);
    expect(counted.calls()).toBe(before);
    expect(body.live?.status).toBe("live");
    expect(body.live?.ok).toBe(true);
    expect(body.live?.servedFromCache).toBe(true);
    expect(body.kpis.ticker?.provenance.source.startsWith("live:")).toBe(true);
  });

  test("a cache entry older than the TTL is refetched", async () => {
    const before = counted.calls();
    clockMs += LIVE_TICKER_TTL_MS + 1;
    const { body } = await getJson<LiveWagersBody>(
      `${server.url}api/live-wagers`,
    );
    expect(counted.calls()).toBe(before + 1);
    expect(body.live?.servedFromCache).toBe(false);
    expect(body.live?.fetchedAt).toBe(new Date(clockMs).toISOString());
  });
});

describe("GET /api/live-wagers with an unavailable live read", () => {
  let dir: string;
  let server: ReturnType<typeof startServer>;
  let counted: CountingFetch;
  let clockMs: number;
  const now = () => new Date(clockMs);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "live-ticker-401-"));
    clockMs = Date.now();
    await writeCapture(
      dir,
      new Date(clockMs - LIVE_TICKER_TTL_MS).toISOString(),
    );
    counted = countingFetch(() => new Response("denied", { status: 401 }));
    server = startLiveServer({ dir, fetch: counted.fetchImpl, now });
  });

  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("falls back to the capture with the live diagnostic, never a 500", async () => {
    const { status, body } = await getJson<LiveWagersBody>(
      `${server.url}api/live-wagers?source=auto`,
    );
    expect(status).toBe(200);
    expect(body.provenance?.source.startsWith("capture:")).toBe(true);
    expect(body.wagers?.map((w) => w.wagerNumber)).toEqual(
      CAPTURE_ROWS.map((row) => row.WagerNumber),
    );
    expect(body.live?.status).toBe("unavailable");
    expect(body.live?.ok).toBe(false);
    expect(body.live?.diagnostic?.code).toBe("unauthorized");
    expect(body.live?.diagnostic?.httpStatus).toBe(401);
    expect(body.live?.diagnostic?.message ?? "").toContain("session:login");
    expect(counted.calls()).toBe(1);
  });

  test("the failed read is cached too, so a poll pair POSTs once", async () => {
    await getJson<LiveWagersBody>(`${server.url}api/live-wagers?source=auto`);
    const before = counted.calls();
    const { body } = await getJson<LiveWagersBody>(
      `${server.url}api/live-wagers?source=auto`,
    );
    expect(counted.calls()).toBe(before);
    expect(body.live?.servedFromCache).toBe(true);
    expect(body.live?.diagnostic?.code).toBe("unauthorized");
  });

  test("?source=file makes no live call", async () => {
    const before = counted.calls();
    const { status, body } = await getJson<LiveWagersBody>(
      `${server.url}api/live-wagers?source=file`,
    );
    expect(status).toBe(200);
    expect(counted.calls()).toBe(before);
    expect(body.live?.status).toBe("disabled");
    expect(body.provenance?.source.startsWith("capture:")).toBe(true);
  });

  test("?source=live answers 503 with the diagnostic instead of a capture", async () => {
    const { status, body } = await getJson<LiveWagersBody>(
      `${server.url}api/live-wagers?source=live`,
    );
    expect(status).toBe(503);
    expect(body.success).toBe(false);
    expect(body.error).toBe("live getBetTicker unavailable");
    expect(body.live?.status).toBe("unavailable");
    expect(body.live?.ok).toBe(false);
    expect(body.live?.diagnostic?.code).toBe("unauthorized");
    expect(body.provenance).toBeUndefined();
  });

  test("an unknown source is a 400, not a silent fallback", async () => {
    const { status, body } = await getJson<LiveWagersBody>(
      `${server.url}api/live-wagers?source=network`,
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "source must be auto, live or file",
    });
  });
});

describe("GET /api/live-wagers with live unavailable and no capture", () => {
  let dir: string;
  let server: ReturnType<typeof startServer>;
  let counted: CountingFetch;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "live-ticker-empty-"));
    counted = countingFetch(() => new Response("denied", { status: 401 }));
    const clockMs = Date.now();
    server = startLiveServer({
      dir,
      fetch: counted.fetchImpl,
      now: () => new Date(clockMs),
    });
  });

  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the 404 names the live setup first and keeps the capture fallback", async () => {
    const { status, body } = await getJson<LiveWagersBody>(
      `${server.url}api/live-wagers?source=auto`,
    );
    expect(status).toBe(404);
    expect(body.error).toBe("no live wager list");
    expect(body.skipped).toEqual([]);
    expect(body.live?.status).toBe("unavailable");
    expect(body.live?.ok).toBe(false);
    // The primary fix is the live setup; the capture wording remains as the fallback.
    expect(body.hint).toContain("F402_AGENT_ID");
    expect(body.hint).toContain("bun run session:login");
    expect(body.hint).toContain("bun run capture:bet-ticker");
    expect(body.hint).toContain("data/live-wagers.json");
  });
});

describe("live-ticker env gates", () => {
  let dir: string;
  const servers: Array<ReturnType<typeof startServer>> = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "live-ticker-env-"));
    await writeCapture(dir, new Date().toISOString());
  });

  afterAll(() => {
    for (const started of servers) started.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("NODE_ENV=test disables live by default, with the 10s TTL still reported", async () => {
    const started = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
      wagerListDir: dir,
      liveTicker: { env: { NODE_ENV: "test" }, session: null },
    });
    servers.push(started);
    const { status, body } = await getJson<LiveWagersBody>(
      `${started.url}api/live-wagers?source=auto`,
    );
    expect(status).toBe(200);
    expect(body.live).toEqual({
      mode: "auto",
      status: "disabled",
      ok: false,
      fetchedAt: null,
      servedFromCache: false,
      transport: null,
      diagnostic: null,
      ttlMs: LIVE_TICKER_DEFAULT_TTL_MS,
    });
    expect(body.provenance?.source.startsWith("capture:")).toBe(true);
  });

  test("SPORTSDESK_LIVE_TICKER=1 enables live without an explicit option", async () => {
    const counted = countingFetch(() => Response.json({ LIST: LIVE_ROWS }));
    const started = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
      wagerListDir: dir,
      liveTicker: {
        fetch: counted.fetchImpl,
        session: null,
        env: {
          NODE_ENV: "production",
          SPORTSDESK_LIVE_TICKER: "1",
          F402_AGENT_ID: "TESTAGENT",
        },
        now: () => new Date(),
      },
    });
    servers.push(started);
    const { status, body } = await getJson<LiveWagersBody>(
      `${started.url}api/live-wagers`,
    );
    expect(status).toBe(200);
    expect(body.live?.status).toBe("live");
    expect(body.provenance?.source.startsWith("live:")).toBe(true);
    expect(counted.calls()).toBe(1);
  });

  test("SPORTSDESK_LIVE_TICKER_TTL_MS=0 disables the cache", async () => {
    const counted = countingFetch(() => Response.json({ LIST: LIVE_ROWS }));
    const started = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
      wagerListDir: dir,
      liveTicker: {
        fetch: counted.fetchImpl,
        session: null,
        env: {
          NODE_ENV: "test",
          SPORTSDESK_LIVE_TICKER: "1",
          SPORTSDESK_LIVE_TICKER_TTL_MS: "0",
          F402_AGENT_ID: "TESTAGENT",
        },
        now: () => new Date(),
      },
    });
    servers.push(started);
    const first = await getJson<LiveWagersBody>(
      `${started.url}api/live-wagers`,
    );
    // TTL 0 disables the cache: each poll is a fresh live read and POSTs once.
    expect(counted.calls()).toBe(1);
    const before = counted.calls();
    const second = await getJson<LiveWagersBody>(
      `${started.url}api/live-wagers`,
    );
    expect(counted.calls()).toBe(before + 1);
    expect(first.body.live?.ttlMs).toBe(0);
    expect(first.body.live?.servedFromCache).toBe(false);
    expect(second.body.live?.servedFromCache).toBe(false);
    expect(second.body.provenance?.source.startsWith("live:")).toBe(true);
  });
});
