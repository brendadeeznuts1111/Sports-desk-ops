import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fetchIncomingBets,
  type IncomingBetsDiagnostic,
  type IncomingBetsResult,
} from "../lib/f402_incoming_bets.ts";
import type { F402ProbeFetch } from "../lib/f402_ingest.ts";
import type { F402Session } from "../lib/f402_session.ts";

const FIXED_NOW = new Date("2026-11-05T02:40:00.000Z");
const OBSERVED_AT = FIXED_NOW.toISOString();
const TICKER_URL = "https://fantasy402.com/cloud/api/Manager/getBetTicker";

const SECRET_COOKIE = "F402SESSION=SECRET_COOKIE_VALUE";
const SECRET_TOKEN = "Bearer SECRET_TOKEN_VALUE";

const SESSION: F402Session = {
  cookieHeader: SECRET_COOKIE,
  cookieNames: ["F402SESSION"],
  authorizationHeader: SECRET_TOKEN,
  obtainedAtIso: "2026-11-04T20:00:00.000Z",
  expiresAtIso: "2026-11-05T20:00:00.000Z",
};

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch seam that records its calls and always answers with one Response. */
function recordingFetch(
  response: Response | (() => Response),
  calls: FetchCall[],
): F402ProbeFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return typeof response === "function" ? response() : response;
  };
}

/** Every non-ok variant carries a `message`; `ok` does not. */
type IncomingBetsFailureDiagnostic = Exclude<
  IncomingBetsDiagnostic,
  { code: "ok" }
>;

/** Narrows a refusal so `.message`/`.hint` are type-safe in the assertions below. */
function failureDiagnostic(
  result: IncomingBetsResult,
): IncomingBetsFailureDiagnostic {
  if (result.diagnostic.code === "ok") {
    throw new Error("expected a failure diagnostic, got ok");
  }
  return result.diagnostic;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tickerRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    WagerNumber: 767463594,
    AgentID: "SPEN",
    CustomerID: "BCC1413",
    Login: "bcc1413",
    WagerType: "S",
    AmountWagered: 10700,
    InsertDateTime: "2026-11-04 21:38:55.683",
    ToWinAmount: 24547,
    TicketWriter: "GSLIVE",
    VolumeAmount: 10700,
    ShortDesc:
      "Basketball - Phoenix Suns vs Portland Trail Blazers / Game / Winner (2 way)",
    VIP: "0",
    AgentLogin: "SPEN",
    ...overrides,
  };
}

function pendingGame(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ticketNumber: "767461552",
    wagerNumber: "1",
    ticketKey: "767461552-1",
    agent: {
      key: "BASEBALL7",
      id: "BASEBALL7",
      level: null,
      agentType: null,
    },
    customerID: "JD18959",
    status: "P",
    sport: "Football",
    subSport: "Winner (2 way)",
    period: "Game",
    wagerType: "M",
    picks: 1,
    description:
      "Football - Massachusetts vs Ball State / Game / Winner (2 way) / Massachusetts +136",
    chosenTeam: "Massachusetts +136",
    wagered: 15000,
    toWin: 20400,
    gameDateTime: "2026-11-04 21:18:58.397",
    acceptedAt: "2026-11-04 21:18:58.397",
    team1: { name: "Massachusetts", shortName: "Massachusetts", score: 0 },
    team2: { name: "Ball State", shortName: "Ball State", score: 0 },
    ...overrides,
  };
}

const tempDirs: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "f402-incoming-bets-"));
  tempDirs.push(dir);
  return dir;
}

function writeWagerCapture(
  root: string,
  rows: readonly unknown[],
  observedAt = "2026-11-04T20:00:00.000Z",
): void {
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(
    join(root, "data/live-wagers.json"),
    JSON.stringify({ schemaVersion: 1, observedAt, LIST: rows }),
  );
}

function writePendingCapture(
  root: string,
  games: readonly unknown[],
  capturedAt = "2026-11-04T21:00:00.000Z",
): void {
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(
    join(root, "data/live-bets.json"),
    JSON.stringify({ schemaVersion: 1, capturedAt, games }),
  );
}

/** Bun's `Env` index signature is readonly in TS; tests still need to clear inherited config. */
const env = Bun.env as unknown as Record<string, string | undefined>;
const savedProxy = env["F402_REPLAY_PROXY_URL"];
const savedAgent = env["F402_AGENT_ID"];

beforeEach(() => {
  delete env["F402_REPLAY_PROXY_URL"];
  delete env["F402_AGENT_ID"];
});

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  if (savedProxy === undefined) delete env["F402_REPLAY_PROXY_URL"];
  else env["F402_REPLAY_PROXY_URL"] = savedProxy;
  if (savedAgent === undefined) delete env["F402_AGENT_ID"];
  else env["F402_AGENT_ID"] = savedAgent;
});

describe("fetchIncomingBets live path (injected session + fetch, offline)", () => {
  test("POSTs the captured getBetTicker body through the injected fetch and widens rows", async () => {
    const calls: FetchCall[] = [];
    const older = tickerRow({
      WagerNumber: 767463594,
      InsertDateTime: "2026-11-04 21:38:55.683",
    });
    const newer = tickerRow({
      WagerNumber: 767465000,
      Login: "bcc1413",
      InsertDateTime: "2026-11-04 22:10:00.000",
    });

    const result = await fetchIncomingBets({
      source: "live",
      agentId: "SPEN",
      limit: 10,
      now: FIXED_NOW,
      session: SESSION,
      fetchImpl: recordingFetch(jsonResponse({ LIST: [older, newer] }), calls),
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("live-ticker");
    expect(result.agentId).toBe("SPEN");
    expect(result.fetchedAt).toBe(OBSERVED_AT);
    expect(result.rows).toHaveLength(2);
    expect(result.diagnostic).toMatchObject({
      code: "ok",
      transport: "injected-fetch",
      httpStatus: 200,
    });

    // Widening (lib/bet_flags.ts) is what turns the wire row into the rule-facing record.
    expect(result.rows[0]?.customerId).toBe("BCC1413");
    expect(result.rows[0]?.schemaVersion).toBe(1);
    expect(result.rows[0]?.source).toBe("live-ticker");
    expect(result.rows[0]?.observedAt).toBe(OBSERVED_AT);
    expect(result.rows[0]?.raw).toMatchObject({ WagerNumber: 767465000 });
    // Newest first.
    expect(result.rows[0]?.raw).toMatchObject({ WagerNumber: 767465000 });
    expect(result.rows[1]?.raw).toMatchObject({ WagerNumber: 767463594 });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(TICKER_URL);
    expect(call?.init.method).toBe("POST");
    const body = String(call?.init.body);
    expect(body).toContain("operation=getBetTicker");
    expect(body).toContain("agentID=SPEN");
    expect(body).toContain("agentOwner=SPEN");
    expect(body).toContain("wagerNumber=0");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["cookie"]).toBe(SECRET_COOKIE);
    expect(headers["authorization"]).toBe(SECRET_TOKEN);
  });

  test("caps the widened rows to the requested limit, keeping the newest", async () => {
    const rows = [
      tickerRow({ WagerNumber: 1, InsertDateTime: "2026-11-04 20:00:00.000" }),
      tickerRow({ WagerNumber: 2, InsertDateTime: "2026-11-04 21:00:00.000" }),
      tickerRow({ WagerNumber: 3, InsertDateTime: "2026-11-04 22:00:00.000" }),
    ];
    const result = await fetchIncomingBets({
      source: "live",
      agentId: "SPEN",
      limit: 2,
      now: FIXED_NOW,
      session: SESSION,
      fetchImpl: recordingFetch(jsonResponse({ LIST: rows }), []),
    });

    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.raw).toMatchObject({ WagerNumber: 3 });
    expect(result.rows[1]?.raw).toMatchObject({ WagerNumber: 2 });
  });

  test("reports 401/403 as unauthorized without echoing the session", async () => {
    for (const status of [401, 403]) {
      const result = await fetchIncomingBets({
        source: "live",
        agentId: "SPEN",
        now: FIXED_NOW,
        session: SESSION,
        fetchImpl: recordingFetch(new Response("denied", { status }), []),
      });

      expect(result.ok).toBe(false);
      expect(result.rows).toEqual([]);
      expect(result.diagnostic).toMatchObject({
        code: "unauthorized",
        httpStatus: status,
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("SECRET_COOKIE_VALUE");
      expect(serialized).not.toContain("SECRET_TOKEN_VALUE");
      expect(serialized).not.toContain(SECRET_COOKIE);
      expect(serialized).not.toContain(SECRET_TOKEN);
    }
  });

  test("reports other statuses as http_error", async () => {
    const result = await fetchIncomingBets({
      source: "live",
      agentId: "SPEN",
      now: FIXED_NOW,
      session: SESSION,
      fetchImpl: recordingFetch(new Response("boom", { status: 500 }), []),
    });

    expect(result.ok).toBe(false);
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic).toMatchObject({
      code: "http_error",
      httpStatus: 500,
    });
    expect(diagnostic.message).toContain("HTTP 500");
  });

  test("reports non-JSON bodies and missing LIST arrays as parse_error", async () => {
    const nonJson = await fetchIncomingBets({
      source: "live",
      agentId: "SPEN",
      now: FIXED_NOW,
      session: SESSION,
      fetchImpl: recordingFetch(
        new Response("<html>login</html>", { status: 200 }),
        [],
      ),
    });
    expect(nonJson.ok).toBe(false);
    expect(failureDiagnostic(nonJson).code).toBe("parse_error");

    const noList = await fetchIncomingBets({
      source: "live",
      agentId: "SPEN",
      now: FIXED_NOW,
      session: SESSION,
      fetchImpl: recordingFetch(jsonResponse({ error: "nope" }), []),
    });
    expect(noList.ok).toBe(false);
    const noListDiagnostic = failureDiagnostic(noList);
    expect(noListDiagnostic.code).toBe("parse_error");
    expect(noListDiagnostic.message).toContain("LIST");
  });

  test("reports unrecognizable ticker rows as parse_error instead of an empty ok", async () => {
    const result = await fetchIncomingBets({
      source: "live",
      agentId: "SPEN",
      now: FIXED_NOW,
      session: SESSION,
      fetchImpl: recordingFetch(jsonResponse({ LIST: [{}, { nope: 1 }] }), []),
    });

    expect(result.ok).toBe(false);
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic).toMatchObject({ code: "parse_error" });
    expect(diagnostic.message).toContain("none matched");
    expect(result.rows).toEqual([]);
  });

  test("refuses a live read with no session and no proxy, with the three configuration hints", async () => {
    const result = await fetchIncomingBets({
      source: "live",
      agentId: "SPEN",
      now: FIXED_NOW,
      session: null,
    });

    expect(result.ok).toBe(false);
    expect(result.rows).toEqual([]);
    expect(result.source).toBe("live-ticker");
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic.code).toBe("transport_unavailable");
    if (diagnostic.code !== "transport_unavailable") {
      throw new Error(`expected transport_unavailable, got ${diagnostic.code}`);
    }
    expect(diagnostic.message).toContain("No F402 replay transport");
    expect(diagnostic.hint).toContain("bun run session:login");
    expect(diagnostic.hint).toContain("F402_SESSION_FILE");
    expect(diagnostic.hint).toContain("F402_REPLAY_PROXY_URL");
  });

  test("refuses a live read with no agent id and never calls fetch", async () => {
    const calls: FetchCall[] = [];
    const result = await fetchIncomingBets({
      source: "live",
      agentId: "",
      now: FIXED_NOW,
      session: SESSION,
      fetchImpl: recordingFetch(jsonResponse({ LIST: [] }), calls),
    });

    expect(result.ok).toBe(false);
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic).toMatchObject({ code: "agent_required" });
    expect(diagnostic.message).toContain("F402_AGENT_ID");
    expect(result.agentId).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("fetchIncomingBets capture fallback (source auto)", () => {
  test("falls back to the wager LIST and pending games when no transport exists", async () => {
    const root = makeRoot();
    writeWagerCapture(root, [
      tickerRow({ WagerNumber: 601, Login: "c001", CustomerID: "C001" }),
    ]);
    writePendingCapture(root, [pendingGame()]);

    const result = await fetchIncomingBets({
      source: "auto",
      agentId: "SPEN",
      now: FIXED_NOW,
      session: null,
      rootDir: root,
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("capture-wagers");
    expect(result.diagnostic).toMatchObject({
      code: "ok",
      transport: "capture-files",
    });
    expect(result.fetchedAt).toBe("2026-11-04T20:00:00.000Z");
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    const sources = new Set(result.rows.map((row) => row.source));
    expect(sources.has("capture-wagers")).toBe(true);
    expect(sources.has("capture-bets")).toBe(true);
  });

  test("names capture-bets when only the pending capture is readable", async () => {
    const root = makeRoot();
    writePendingCapture(root, [pendingGame()]);

    const result = await fetchIncomingBets({
      source: "auto",
      now: FIXED_NOW,
      session: null,
      rootDir: root,
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("capture-bets");
    expect(result.fetchedAt).toBe("2026-11-04T21:00:00.000Z");
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect(result.rows[0]?.source).toBe("capture-bets");
  });

  test("falls back to captures when the live read is unauthorized", async () => {
    const root = makeRoot();
    writeWagerCapture(root, [tickerRow()]);

    const result = await fetchIncomingBets({
      source: "auto",
      agentId: "SPEN",
      now: FIXED_NOW,
      session: SESSION,
      rootDir: root,
      fetchImpl: recordingFetch(new Response("denied", { status: 401 }), []),
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("capture-wagers");
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
  });

  test("reports captures_unavailable when auto has neither live input nor capture rows", async () => {
    const root = makeRoot();
    const result = await fetchIncomingBets({
      source: "auto",
      agentId: "SPEN",
      now: FIXED_NOW,
      session: null,
      rootDir: root,
    });

    expect(result.ok).toBe(false);
    expect(result.source).toBe("capture-wagers");
    expect(result.rows).toEqual([]);
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic.code).toBe("captures_unavailable");
    expect(diagnostic.message).toContain("data/live-wagers.json");
    expect(diagnostic.message).toContain("data/live-bets.json");
  });

  test("defaults source to auto and the limit to 100", async () => {
    const root = makeRoot();
    const rows = Array.from({ length: 3 }, (_, index) =>
      tickerRow({
        WagerNumber: 700 + index,
        InsertDateTime: `2026-11-04 2${index}:00:00.000`,
      }),
    );
    writeWagerCapture(root, rows);

    const result = await fetchIncomingBets({
      now: FIXED_NOW,
      session: null,
      rootDir: root,
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe("capture-wagers");
    expect(result.rows).toHaveLength(3);
  });
});
