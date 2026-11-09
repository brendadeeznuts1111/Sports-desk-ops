/**
 * Live-first `/api/live-bets*` and the `/api/kpis` pending block.
 *
 * Every live read goes through an injected fetch and an injected clock, and every artifact the
 * fallback, persistence and health paths touch lives under a per-test temp dir. No test here can
 * reach fantasy402.com, the replay transport, the real session file or the gitignored `data/`
 * artifacts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { F402ProbeFetch } from "../lib/f402_ingest.ts";
import { STALE_AFTER_SECONDS } from "../lib/desk_kpis.ts";
import { REPORT_PENDING_OPERATION } from "../lib/f402_live_pending.ts";
import { buildArtifact, readPendingRows } from "../lib/live_bets.ts";
import { BET_TICKER_OPERATION } from "../lib/live_wagers.ts";
import { startServer } from "../services/sportsdesk_webview_server.ts";

const OBSERVED_AT = "2026-11-08T12:00:00.000Z";
const FALLBACK_AT = "2026-11-07T06:00:00.000Z";

/** Two raw `Report/Pending` legs: enough for the parser, no credentials or PII keys. */
const LIVE_ROWS: readonly Record<string, unknown>[] = [
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

/** The captured-shape row the fallback artifact carries; its ticket is recognisable as a file. */
const FALLBACK_ROWS: readonly Record<string, unknown>[] = [
  {
    TicketNumber: "T7001",
    WagerNumber: 1,
    AgentID: "AG1",
    AmountWagered: 500,
    ToWinAmount: 450,
    SportType: "Football",
    SportSubType: "NFL",
    Team1ID: "Bears",
    Team2ID: "Packers",
  },
];

/** The explicit live customer scope the Pending fan-out reads. */
const LIVE_CUSTOMERS = ["H1716"];

/** The two-customer scope of the partial-read test; one of them fails upstream. */
const PARTIAL_CUSTOMERS = ["GOOD", "BAD"];
const FAILING_CUSTOMERS = ["BAD"];

/**
 * Module-private server defaults these tests pin: the Pending live-read TTL the server reports
 * and the ticker TTL the injected live-ticker env carries.
 */
const LIVE_PENDING_DEFAULT_TTL_MS = 60_000;
const LIVE_TICKER_TTL_MS = 60_000;

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
  customersAttempted: number;
  customersFailed: number;
  ttlMs: number;
}

interface SummaryBody {
  totalGames: number;
  totalPending: number;
  dataSource: string;
  capturedAt: string | null;
}

interface FreshnessBody {
  asOf: string;
  asOfFrom: string;
  ageSeconds: number;
  stale: boolean;
}

interface LiveBetsBody {
  success?: boolean;
  error?: string;
  summary?: SummaryBody;
  games?: Array<{ ticketNumber: string }>;
  pendingCount?: number;
  freshness?: FreshnessBody;
  live?: LiveStatusBody;
}

interface LiveBetsSummaryBody {
  success?: boolean;
  summary?: SummaryBody;
  generatedAt?: string;
  freshness?: FreshnessBody;
  live?: LiveStatusBody;
}

interface KpisBody {
  success: boolean;
  kpis: {
    pending: { provenance: { source: string; basis: string } } | null;
  };
  live?: LiveStatusBody;
  livePending?: LiveStatusBody;
}

interface CaptureHealthBody {
  sources: Record<
    string,
    {
      operation: string;
      artifact: string;
      rows: number;
      transport: string;
      artifactWritten: boolean;
    }
  >;
}

interface CountingFetch {
  readonly fetchImpl: F402ProbeFetch;
  readonly calls: () => number;
}

const running: Array<ReturnType<typeof startServer>> = [];
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const server of running) server.stop(true);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** `{Pending: rows}` is the live body shape; a capture file stores the built artifact instead. */
function pendingBody(rows: readonly Record<string, unknown>[]): Response {
  return Response.json({ Pending: rows });
}

/**
 * An injected Pending fetch that counts calls and tells the customers apart by the form body the
 * core module posts (`customerID=<id>`). Returns a `Response`, never the network.
 */
function stubPendingFetch(
  respond: (customer: string | null, call: number) => Response,
): CountingFetch {
  let count = 0;
  return {
    calls: () => count,
    fetchImpl: async (_input, init) => {
      count += 1;
      const body = typeof init.body === "string" ? init.body : "";
      const raw = /(?:^|&)customerID=([^&]*)/.exec(body)?.[1];
      const customer = raw === undefined ? null : decodeURIComponent(raw);
      return respond(customer, count);
    },
  };
}

/** Writes a capture-shaped live-bets artifact the fallback can serve. */
async function writeCaptureArtifact(
  path: string,
  rows: readonly Record<string, unknown>[],
  capturedAt: string,
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const artifact = buildArtifact(readPendingRows({ Pending: rows }), {
    operation: REPORT_PENDING_OPERATION,
    capturedAt,
  });
  await Bun.write(path, JSON.stringify(artifact));
}

interface LivePendingServerOptions {
  readonly dir: string;
  readonly fetch: F402ProbeFetch;
  readonly now: () => Date;
  readonly customers?: readonly string[];
  readonly ttlMs?: number;
  readonly liveBetsPath?: string;
  readonly persistence?: {
    readonly enabled?: boolean;
    readonly rootDir?: string;
    readonly throttleMs?: number;
  };
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly liveTickerFetch?: F402ProbeFetch;
}

function startLivePendingServer(
  options: LivePendingServerOptions,
): ReturnType<typeof startServer> {
  const server = startServer({
    port: 0,
    hostname: "127.0.0.1",
    development: false,
    liveBetsPath: options.liveBetsPath ?? join(options.dir, "live-bets.json"),
    ...(options.liveTickerFetch === undefined
      ? {}
      : {
          liveTicker: {
            enabled: true,
            fetch: options.liveTickerFetch,
            session: null,
            now: options.now,
            env: {
              NODE_ENV: "test",
              F402_AGENT_ID: "TESTAGENT",
              SPORTSDESK_LIVE_TICKER_TTL_MS: String(LIVE_TICKER_TTL_MS),
            },
          },
        }),
    livePending: {
      enabled: true,
      fetch: options.fetch,
      // No real session file: the injected fetch carries no credentials, and nothing can leak.
      session: null,
      now: options.now,
      ...(options.customers === undefined
        ? {}
        : { customers: options.customers }),
      env: {
        NODE_ENV: "test",
        SPORTSDESK_LIVE_PENDING_TTL_MS: String(
          options.ttlMs ?? LIVE_PENDING_DEFAULT_TTL_MS,
        ),
        ...options.env,
      },
      ...(options.persistence === undefined
        ? {}
        : { persistence: options.persistence }),
    },
  });
  running.push(server);
  return server;
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as T };
}

describe("GET /api/live-bets live-first", () => {
  let server: ReturnType<typeof startServer>;
  let stub: CountingFetch;
  let clockMs: number;
  let observedAt: string;

  beforeAll(async () => {
    const dir = tempDir("live-pending-ok-");
    // A capture exists, so "live wins" is actually tested: live must outrank the file.
    await writeCaptureArtifact(
      join(dir, "live-bets.json"),
      FALLBACK_ROWS,
      FALLBACK_AT,
    );
    clockMs = Date.parse(OBSERVED_AT);
    observedAt = new Date(clockMs).toISOString();
    stub = stubPendingFetch(() => pendingBody(LIVE_ROWS));
    server = startLivePendingServer({
      dir,
      fetch: stub.fetchImpl,
      now: () => new Date(clockMs),
      customers: LIVE_CUSTOMERS,
    });
  });

  test("serves the live book with live provenance and the exact status object", async () => {
    const { status, body } = await getJson<LiveBetsBody>(
      `${server.url}api/live-bets`,
    );
    expect(status).toBe(200);
    expect(body.summary?.dataSource).toBe(
      `live:${REPORT_PENDING_OPERATION}@${observedAt}`,
    );
    expect(body.summary?.capturedAt).toBe(observedAt);
    expect(body.pendingCount).toBe(LIVE_ROWS.length);
    expect(body.games?.map((game) => game.ticketNumber)).toEqual(
      LIVE_ROWS.map((row) => String(row.TicketNumber)),
    );
    // The exact status object the dashboard renders; a field change must fail this test.
    expect(body.live).toEqual({
      mode: "auto",
      status: "live",
      ok: true,
      fetchedAt: observedAt,
      servedFromCache: false,
      transport: "injected-fetch",
      diagnostic: null,
      customersAttempted: LIVE_CUSTOMERS.length,
      customersFailed: 0,
      ttlMs: LIVE_PENDING_DEFAULT_TTL_MS,
    });
    // Staleness is the server's own budget; the server's injected clock dates this read, so a
    // live observation at the clock instant is exactly fresh.
    expect(body.freshness?.asOf).toBe(observedAt);
    expect(body.freshness?.asOfFrom).toBe("artifact");
    expect(body.freshness?.ageSeconds).toBe(0);
    expect(body.freshness?.stale).toBe(false);
    expect(stub.calls()).toBe(LIVE_CUSTOMERS.length);
  });

  test("a second poll inside the TTL reuses the read instead of POSTing again", async () => {
    const before = stub.calls();
    const { status, body } = await getJson<LiveBetsBody>(
      `${server.url}api/live-bets`,
    );
    expect(status).toBe(200);
    expect(stub.calls()).toBe(before);
    expect(body.live?.servedFromCache).toBe(true);
    expect(body.live?.status).toBe("live");
    expect(body.summary?.dataSource.startsWith("live:")).toBe(true);
  });

  test("?source=live serves the live book explicitly", async () => {
    const { status, body } = await getJson<LiveBetsBody>(
      `${server.url}api/live-bets?source=live`,
    );
    expect(status).toBe(200);
    expect(body.live?.mode).toBe("live");
    expect(body.live?.status).toBe("live");
    expect(body.summary?.dataSource.startsWith("live:")).toBe(true);
  });

  test("the summary route carries the same live status and totals", async () => {
    const { status, body } = await getJson<LiveBetsSummaryBody>(
      `${server.url}api/live-bets/summary`,
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.summary?.dataSource.startsWith("live:")).toBe(true);
    expect(body.summary?.totalPending).toBe(LIVE_ROWS.length);
    expect(body.live?.status).toBe("live");
    expect(body.live?.ok).toBe(true);

    // The cached body's version includes the live status, so a repeat ETag can 304.
    const etagRes = await fetch(`${server.url}api/live-bets/summary`);
    const etag = etagRes.headers.get("etag");
    expect(etag).toBeString();
    const cachedRes = await fetch(`${server.url}api/live-bets/summary`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(cachedRes.status).toBe(304);
  });

  test("a cache entry older than the TTL is refetched with a new observedAt", async () => {
    const before = stub.calls();
    // The version the cached body carried: the live status is part of the ETag, so the next
    // observation (or cache state) must not reuse it.
    const staleEtag = (
      await fetch(`${server.url}api/live-bets/summary`)
    ).headers.get("etag");
    clockMs += LIVE_PENDING_DEFAULT_TTL_MS + 1;
    const { body } = await getJson<LiveBetsBody>(`${server.url}api/live-bets`);
    expect(stub.calls()).toBe(before + LIVE_CUSTOMERS.length);
    expect(body.live?.servedFromCache).toBe(false);
    expect(body.live?.fetchedAt).toBe(new Date(clockMs).toISOString());
    const freshEtag = (
      await fetch(`${server.url}api/live-bets/summary`)
    ).headers.get("etag");
    expect(freshEtag).not.toBe(staleEtag);
  });
});

describe("GET /api/live-bets with a partial customer scope", () => {
  let server: ReturnType<typeof startServer>;
  let stub: CountingFetch;

  beforeAll(() => {
    const dir = tempDir("live-pending-partial-");
    stub = stubPendingFetch((customer) =>
      FAILING_CUSTOMERS.includes(customer ?? "")
        ? new Response("boom", { status: 500 })
        : pendingBody(LIVE_ROWS),
    );
    server = startLivePendingServer({
      dir,
      fetch: stub.fetchImpl,
      now: () => new Date(OBSERVED_AT),
      customers: PARTIAL_CUSTOMERS,
    });
  });

  test("serves the rows one customer returned and counts the failed one", async () => {
    const { status, body } = await getJson<LiveBetsBody>(
      `${server.url}api/live-bets`,
    );
    expect(status).toBe(200);
    expect(body.live?.status).toBe("live");
    expect(body.live?.ok).toBe(true);
    expect(body.live?.customersAttempted).toBe(PARTIAL_CUSTOMERS.length);
    expect(body.live?.customersFailed).toBe(FAILING_CUSTOMERS.length);
    expect(body.pendingCount).toBe(LIVE_ROWS.length);
    expect(body.summary?.dataSource.startsWith("live:")).toBe(true);
  });
});

describe("GET /api/live-bets with an unavailable live read", () => {
  let server: ReturnType<typeof startServer>;
  let stub: CountingFetch;

  beforeAll(async () => {
    const dir = tempDir("live-pending-401-");
    await writeCaptureArtifact(
      join(dir, "live-bets.json"),
      FALLBACK_ROWS,
      FALLBACK_AT,
    );
    stub = stubPendingFetch(() => new Response("denied", { status: 401 }));
    server = startLivePendingServer({
      dir,
      fetch: stub.fetchImpl,
      now: () => new Date(OBSERVED_AT),
      customers: LIVE_CUSTOMERS,
    });
  });

  test("falls back to the capture artifact with the live diagnostic, never a 500", async () => {
    const { status, body } = await getJson<LiveBetsBody>(
      `${server.url}api/live-bets`,
    );
    expect(status).toBe(200);
    // The fallback keeps the artifact's own provenance: a capture is never relabelled live.
    expect(body.summary?.dataSource.startsWith("capture:")).toBe(true);
    expect(body.summary?.capturedAt).toBe(FALLBACK_AT);
    expect(body.games?.map((game) => game.ticketNumber)).toEqual(
      FALLBACK_ROWS.map((row) => String(row.TicketNumber)),
    );
    expect(body.live?.status).toBe("unavailable");
    expect(body.live?.ok).toBe(false);
    expect(body.live?.diagnostic?.code).toBe("unauthorized");
    expect(body.live?.diagnostic?.httpStatus).toBe(401);
    expect(body.live?.diagnostic?.message ?? "").toContain("session:login");
    // The fallback is dated from the artifact, and its age is judged against the server budget.
    const fallbackAge = Math.max(
      0,
      Math.floor((Date.parse(OBSERVED_AT) - Date.parse(FALLBACK_AT)) / 1000),
    );
    expect(body.freshness?.asOf).toBe(FALLBACK_AT);
    expect(body.freshness?.asOfFrom).toBe("artifact");
    expect(body.freshness?.ageSeconds).toBe(fallbackAge);
    expect(body.freshness?.stale).toBe(
      fallbackAge > STALE_AFTER_SECONDS.liveBets,
    );
    expect(stub.calls()).toBe(LIVE_CUSTOMERS.length);
  });

  test("the failed read is cached too, so a poll pair POSTs once", async () => {
    const before = stub.calls();
    const { body } = await getJson<LiveBetsBody>(`${server.url}api/live-bets`);
    expect(stub.calls()).toBe(before);
    expect(body.live?.servedFromCache).toBe(true);
    expect(body.live?.diagnostic?.code).toBe("unauthorized");
  });

  test("?source=live answers 503 with the diagnostic instead of a capture", async () => {
    const { status, body } = await getJson<LiveBetsBody>(
      `${server.url}api/live-bets?source=live`,
    );
    expect(status).toBe(503);
    expect(body.success).toBe(false);
    expect(body.error).toBe("live Report/Pending unavailable");
    expect(body.live?.mode).toBe("live");
    expect(body.live?.status).toBe("unavailable");
    expect(body.summary).toBeUndefined();
  });

  test("?source=file makes no live call and keeps the capture provenance", async () => {
    const before = stub.calls();
    const { status, body } = await getJson<LiveBetsBody>(
      `${server.url}api/live-bets?source=file`,
    );
    expect(status).toBe(200);
    expect(stub.calls()).toBe(before);
    expect(body.live?.mode).toBe("file");
    expect(body.live?.status).toBe("disabled");
    expect(body.summary?.dataSource.startsWith("capture:")).toBe(true);
  });

  test("an unknown source is a 400, not a silent fallback", async () => {
    const { status, body } = await getJson<LiveBetsBody>(
      `${server.url}api/live-bets?source=network`,
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "source must be auto, live or file",
    });
  });
});

describe("persistence of a fresh live Pending read", () => {
  let root: string;
  let stub: CountingFetch;
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    const dir = tempDir("live-pending-persist-");
    root = join(dir, "persist");
    stub = stubPendingFetch(() => pendingBody(LIVE_ROWS));
    server = startLivePendingServer({
      dir,
      fetch: stub.fetchImpl,
      now: () => new Date(OBSERVED_AT),
      customers: LIVE_CUSTOMERS,
      persistence: { enabled: true, rootDir: root, throttleMs: 0 },
    });
  });

  test("writes the live-bets artifact and its capture-health record", async () => {
    const { status } = await getJson<LiveBetsBody>(
      `${server.url}api/live-bets`,
    );
    expect(status).toBe(200);

    const artifact = (await Bun.file(
      join(root, "data/live-bets.json"),
    ).json()) as {
      dataSource: string;
      operation: string;
      pendingCount: number;
      capturedAt: string;
    };
    expect(artifact.dataSource).toBe(
      `live:${REPORT_PENDING_OPERATION}@${OBSERVED_AT}`,
    );
    expect(artifact.operation).toBe(REPORT_PENDING_OPERATION);
    expect(artifact.capturedAt).toBe(OBSERVED_AT);
    expect(artifact.pendingCount).toBe(LIVE_ROWS.length);

    const health = (await Bun.file(
      join(root, "data/capture-health.json"),
    ).json()) as CaptureHealthBody;
    const pending = Object.values(health.sources).find(
      (record) => record.operation === REPORT_PENDING_OPERATION,
    );
    expect(pending).toBeDefined();
    expect(pending?.artifact).toBe("data/live-bets.json");
    expect(pending?.rows).toBe(LIVE_ROWS.length);
    expect(pending?.transport).toBe("injected-fetch");
    expect(pending?.artifactWritten).toBe(true);
  });
});

describe("persistence throttling of an unchanged live read", () => {
  let root: string;
  let stub: CountingFetch;
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    const dir = tempDir("live-pending-throttle-");
    root = join(dir, "persist");
    stub = stubPendingFetch(() => pendingBody(LIVE_ROWS));
    server = startLivePendingServer({
      dir,
      fetch: stub.fetchImpl,
      now: () => new Date(OBSERVED_AT),
      customers: LIVE_CUSTOMERS,
      // A TTL of 0 forces a fresh read per request; the persistence throttle still applies.
      ttlMs: 0,
      persistence: { enabled: true, rootDir: root, throttleMs: 600_000 },
    });
  });

  test("a second fresh read with identical bytes does not rewrite the artifact", async () => {
    const artifactPath = join(root, "data/live-bets.json");
    await getJson<LiveBetsBody>(`${server.url}api/live-bets`);
    expect(stub.calls()).toBe(LIVE_CUSTOMERS.length);
    const written = await Bun.file(artifactPath).text();
    expect(JSON.parse(written).dataSource.startsWith("live:")).toBe(true);

    // A rewrite would replace this sentinel; the throttled path must leave it alone.
    await Bun.write(artifactPath, "SENTINEL");
    const before = stub.calls();
    const { body } = await getJson<LiveBetsBody>(`${server.url}api/live-bets`);
    // TTL=0 forces one fresh read per request; each read POSTs once per customer.
    expect(stub.calls()).toBe(before + LIVE_CUSTOMERS.length);
    expect(body.live?.servedFromCache).toBe(false);
    expect(await Bun.file(artifactPath).text()).toBe("SENTINEL");
  });
});

describe("persistence of a fresh live ticker read", () => {
  test("writes data/live-wagers.json and its capture-health record", async () => {
    const dir = tempDir("live-ticker-persist-");
    const root = join(dir, "persist");
    const tickerRows = [
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
    const tickerStub = stubPendingFetch(() =>
      Response.json({ LIST: tickerRows }),
    );
    const server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
      wagerListDir: dir,
      liveTicker: {
        enabled: true,
        fetch: tickerStub.fetchImpl,
        session: null,
        agentId: "TESTAGENT",
        now: () => new Date(OBSERVED_AT),
        env: {
          NODE_ENV: "test",
          F402_AGENT_ID: "TESTAGENT",
          SPORTSDESK_LIVE_TICKER_TTL_MS: "60000",
        },
      },
      // Persistence is shared by both live artifacts; the Pending read itself stays off here.
      livePending: {
        enabled: false,
        now: () => new Date(OBSERVED_AT),
        persistence: { enabled: true, rootDir: root, throttleMs: 0 },
        env: { NODE_ENV: "test" },
      },
    });
    running.push(server);
    const { status } = await getJson<LiveBetsBody>(
      `${server.url}api/live-wagers`,
    );
    expect(status).toBe(200);

    const artifact = (await Bun.file(
      join(root, "data/live-wagers.json"),
    ).json()) as {
      source: string;
      observedAt: string;
      LIST: unknown[];
    };
    expect(artifact.source).toBe(`live:${BET_TICKER_OPERATION}@${OBSERVED_AT}`);
    expect(artifact.observedAt).toBe(OBSERVED_AT);
    expect(artifact.LIST.length).toBe(tickerRows.length);

    const health = (await Bun.file(
      join(root, "data/capture-health.json"),
    ).json()) as CaptureHealthBody;
    const ticker = Object.values(health.sources).find(
      (record) => record.operation === BET_TICKER_OPERATION,
    );
    expect(ticker?.artifact).toBe("data/live-wagers.json");
    expect(ticker?.rows).toBe(tickerRows.length);
    expect(ticker?.artifactWritten).toBe(true);
  });
});

describe("live Pending with no customer scope", () => {
  test("reports no_customer_scope and sends no Report/Pending request", async () => {
    const dir = tempDir("live-pending-noscope-");
    const stub = stubPendingFetch(() => pendingBody(LIVE_ROWS));
    // No explicit customers and no live ticker (NODE_ENV=test default) means nothing names a
    // customer, so the core module must refuse before it opens a connection.
    const server = startLivePendingServer({
      dir,
      fetch: stub.fetchImpl,
      now: () => new Date(OBSERVED_AT),
    });
    const { status, body } = await getJson<LiveBetsBody>(
      `${server.url}api/live-bets`,
    );
    expect(status).toBe(200);
    expect(body.live?.status).toBe("unavailable");
    expect(body.live?.ok).toBe(false);
    expect(body.live?.diagnostic?.code).toBe("no_customer_scope");
    expect(body.live?.customersAttempted).toBe(0);
    expect(stub.calls()).toBe(0);
  });
});

describe("GET /api/kpis live Pending provenance", () => {
  let server: ReturnType<typeof startServer>;
  let stub: CountingFetch;

  beforeAll(() => {
    const dir = tempDir("live-pending-kpis-");
    stub = stubPendingFetch(() => pendingBody(LIVE_ROWS));
    server = startLivePendingServer({
      dir,
      fetch: stub.fetchImpl,
      now: () => new Date(OBSERVED_AT),
      customers: LIVE_CUSTOMERS,
    });
  });

  test("derives the pending block from the live read and carries livePending", async () => {
    const before = stub.calls();
    const { status, body } = await getJson<KpisBody>(`${server.url}api/kpis`);
    expect(status).toBe(200);
    expect(stub.calls()).toBe(before + LIVE_CUSTOMERS.length);
    expect(body.kpis.pending?.provenance.source).toBe(
      `live:${REPORT_PENDING_OPERATION}@${OBSERVED_AT}`,
    );
    expect(body.livePending).toEqual({
      mode: "auto",
      status: "live",
      ok: true,
      fetchedAt: OBSERVED_AT,
      servedFromCache: false,
      transport: "injected-fetch",
      diagnostic: null,
      customersAttempted: LIVE_CUSTOMERS.length,
      customersFailed: 0,
      ttlMs: LIVE_PENDING_DEFAULT_TTL_MS,
    });
    // The top-level `live` is still the ticker, which is disabled in this server.
    expect(body.live?.status).toBe("disabled");
  });

  test("/api/kpis shares the pending TTL cache", async () => {
    const before = stub.calls();
    const { body } = await getJson<KpisBody>(`${server.url}api/kpis`);
    expect(stub.calls()).toBe(before);
    expect(body.livePending?.servedFromCache).toBe(true);
    expect(body.livePending?.status).toBe("live");
  });
});

describe("live Pending env gates", () => {
  test("NODE_ENV=test disables live by default and never calls the fetch", async () => {
    const dir = tempDir("live-pending-env-off-");
    const stub = stubPendingFetch(() => pendingBody(LIVE_ROWS));
    const server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
      liveBetsPath: join(dir, "live-bets.json"),
      livePending: {
        fetch: stub.fetchImpl,
        session: null,
        customers: LIVE_CUSTOMERS,
        env: { NODE_ENV: "test" },
        now: () => new Date(OBSERVED_AT),
      },
    });
    running.push(server);
    const { status, body } = await getJson<LiveBetsBody>(
      `${server.url}api/live-bets`,
    );
    expect(status).toBe(200);
    expect(body.live?.status).toBe("disabled");
    expect(body.live?.ok).toBe(false);
    expect(body.live?.ttlMs).toBe(LIVE_PENDING_DEFAULT_TTL_MS);
    expect(stub.calls()).toBe(0);
  });

  test("SPORTSDESK_LIVE_PENDING=1 enables live without the explicit option", async () => {
    const dir = tempDir("live-pending-env-on-");
    const stub = stubPendingFetch(() => pendingBody(LIVE_ROWS));
    const server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
      liveBetsPath: join(dir, "live-bets.json"),
      livePending: {
        fetch: stub.fetchImpl,
        session: null,
        customers: LIVE_CUSTOMERS,
        env: {
          NODE_ENV: "production",
          SPORTSDESK_LIVE_PENDING: "1",
          SPORTSDESK_LIVE_PENDING_TTL_MS: String(LIVE_PENDING_DEFAULT_TTL_MS),
        },
        now: () => new Date(OBSERVED_AT),
      },
    });
    running.push(server);
    const { status, body } = await getJson<LiveBetsBody>(
      `${server.url}api/live-bets`,
    );
    expect(status).toBe(200);
    expect(body.live?.status).toBe("live");
    expect(body.summary?.dataSource.startsWith("live:")).toBe(true);
    expect(stub.calls()).toBe(LIVE_CUSTOMERS.length);
  });
});

describe("live Pending customer scope from the ticker cache", () => {
  test("derives the fan-out customers from a successful live ticker read", async () => {
    const dir = tempDir("live-pending-scope-");
    const scopeTickerRows = [
      { WagerNumber: 1, CustomerID: "H1716", AmountWagered: 100 },
      { WagerNumber: 2, CustomerID: "CC364", AmountWagered: 200 },
    ];
    const tickerStub = stubPendingFetch(() =>
      Response.json({ LIST: scopeTickerRows }),
    );
    const pendingStub = stubPendingFetch((customer) =>
      pendingBody([
        {
          ...LIVE_ROWS[0],
          customerID: customer ?? "H1716",
        },
      ]),
    );
    const server = startLivePendingServer({
      dir,
      fetch: pendingStub.fetchImpl,
      liveTickerFetch: tickerStub.fetchImpl,
      now: () => new Date(OBSERVED_AT),
    });
    const { status, body } = await getJson<LiveBetsBody>(
      `${server.url}api/live-bets`,
    );
    expect(status).toBe(200);
    expect(body.live?.status).toBe("live");
    expect(body.live?.customersAttempted).toBe(scopeTickerRows.length);
    expect(body.live?.customersFailed).toBe(0);
    expect(pendingStub.calls()).toBe(scopeTickerRows.length);
    // One ticker POST for the scope, not one per pending route.
    expect(tickerStub.calls()).toBe(1);
  });
});

describe("an injected-fetch persistence default cannot write the repo artifacts", () => {
  // Regression: 2026-11-08, a probe server built with an injected fetch and persistence enabled
  // but no rootDir overwrote the gitignored data/live-bets.json and data/capture-health.json with
  // a fixed-clock `live:…` payload. A test/development seam must never touch the repo data.
  const repoData = join(import.meta.dir, "..", "data");

  async function sha256OrNull(path: string): Promise<string | null> {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  }

  test("persistence with an injected fetch and no rootDir leaves data/ unchanged", async () => {
    const artifacts = ["live-bets.json", "capture-health.json"] as const;
    const before = new Map<string, string | null>();
    for (const name of artifacts) {
      before.set(name, await sha256OrNull(join(repoData, name)));
    }

    const dir = tempDir("live-pending-guard-");
    const stub = stubPendingFetch(() => pendingBody(LIVE_ROWS));
    const server = startLivePendingServer({
      dir,
      fetch: stub.fetchImpl,
      now: () => new Date(OBSERVED_AT),
      customers: LIVE_CUSTOMERS,
      // The misuse: enabled, but no rootDir and no SPORTSDESK_LIVE_PERSIST_ROOT.
      persistence: { enabled: true, throttleMs: 0 },
    });

    const { status } = await getJson<LiveBetsBody>(
      `${server.url}api/live-bets`,
    );
    expect(status).toBe(200);

    for (const name of artifacts) {
      const current = (await sha256OrNull(join(repoData, name))) ?? "";
      expect(current).toBe(before.get(name) ?? "");
    }
  });
});
