import { describe, expect, test } from "bun:test";

import type { F402ProbeFetch } from "../lib/f402_ingest.ts";
import {
  F402_TICKER_URL,
  fetchLiveBetTicker,
  isLiveTickerSource,
  type LiveTickerDiagnostic,
  type LiveTickerFetchResult,
} from "../lib/f402_live_ticker.ts";
import type { F402Session } from "../lib/f402_session.ts";

const FIXED_NOW = new Date("2026-11-05T02:40:00.000Z");
const OBSERVED_AT = FIXED_NOW.toISOString();

const SECRET_COOKIE = "F402SESSION=SECRET_COOKIE_VALUE";
const SECRET_TOKEN = "Bearer SECRET_TOKEN_VALUE";

const SESSION: F402Session = {
  cookieHeader: SECRET_COOKIE,
  cookieNames: ["F402SESSION"],
  authorizationHeader: SECRET_TOKEN,
  obtainedAtIso: "2026-11-04T20:00:00.000Z",
  expiresAtIso: "2026-11-05T20:00:00.000Z",
};

/** No ambient env may leak into a unit test: every call passes this seam explicitly. */
const EMPTY_ENV: Readonly<Record<string, string | undefined>> = {};

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch seam that records its calls and answers with one Response. */
function recordingFetch(
  response: Response | (() => Response),
  calls: FetchCall[],
): F402ProbeFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return typeof response === "function" ? response() : response;
  };
}

/** Every non-ok variant carries what the assertions below read; `ok` does not. */
type LiveTickerFailureDiagnostic = Exclude<
  LiveTickerDiagnostic,
  { code: "ok" }
>;

function failureDiagnostic(
  result: LiveTickerFetchResult,
): LiveTickerFailureDiagnostic {
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

const TICKER_ROW = {
  WagerNumber: 767463594,
  AgentID: "SPEN",
  CustomerID: "BCC1413",
  Login: "bcc1413",
  TicketWriter: "GSLIVE",
};

/** The object rows the wire LIST carries; non-object entries are dropped by the row filter. */
const LIVE_ROWS: readonly Record<string, unknown>[] = [TICKER_ROW];
const NON_ROW_LIST_ENTRIES: readonly unknown[] = ["junk"];
const WIRE_LIST: readonly unknown[] = [...LIVE_ROWS, ...NON_ROW_LIST_ENTRIES];

describe("fetchLiveBetTicker (injected fetch, offline)", () => {
  test("POSTs the captured getBetTicker body and returns the raw LIST rows", async () => {
    const calls: FetchCall[] = [];
    const result = await fetchLiveBetTicker({
      agentId: "SPEN",
      now: FIXED_NOW,
      session: SESSION,
      env: EMPTY_ENV,
      fetchImpl: recordingFetch(jsonResponse({ LIST: WIRE_LIST }), calls),
    });

    expect(result.ok).toBe(true);
    expect(result.agentId).toBe("SPEN");
    expect(result.observedAt).toBe(OBSERVED_AT);
    expect(result.rows).toHaveLength(LIVE_ROWS.length);
    // Raw wire row: no widening, no field renaming.
    expect(result.rows[0]).toEqual(TICKER_ROW);
    expect(result.rawRowCount).toBe(WIRE_LIST.length);
    expect(result.transport).toBe("injected-fetch");
    expect(result.diagnostic).toEqual({
      code: "ok",
      transport: "injected-fetch",
      httpStatus: 200,
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(F402_TICKER_URL);
    expect(call?.url).toBe(
      "https://fantasy402.com/cloud/api/Manager/getBetTicker",
    );
    expect(call?.init.method).toBe("POST");
    const body = new URLSearchParams(String(call?.init.body));
    expect(body.get("agentID")).toBe("SPEN");
    expect(body.get("agentOwner")).toBe("SPEN");
    expect(body.get("wagerNumber")).toBe("0");
    expect(body.get("operation")).toBe("getBetTicker");
    expect(body.get("RRO")).toBe("1");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["accept"]).toBe("application/json");
    expect(headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(headers["content-type"]).toBe(
      "application/x-www-form-urlencoded; charset=UTF-8",
    );
    // The injected fetch has no replay transport behind it, so the caller's session supplies the
    // same cookie/authorization headers the real probe sends.
    expect(headers["cookie"]).toBe(SECRET_COOKIE);
    expect(headers["authorization"]).toBe(SECRET_TOKEN);

    // No session value may appear anywhere in the result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET_COOKIE_VALUE");
    expect(serialized).not.toContain("SECRET_TOKEN_VALUE");
  });

  test("accepts the probe's data/rows envelopes as well as LIST", async () => {
    for (const payload of [
      { data: LIVE_ROWS },
      { rows: [...LIVE_ROWS, ...NON_ROW_LIST_ENTRIES] },
      [...LIVE_ROWS],
    ]) {
      const result = await fetchLiveBetTicker({
        agentId: "SPEN",
        session: null,
        env: EMPTY_ENV,
        fetchImpl: recordingFetch(jsonResponse(payload), []),
      });
      expect(result.ok).toBe(true);
      expect(result.rows).toHaveLength(LIVE_ROWS.length);
    }
  });

  test("resolves the agent from the injected env seam", async () => {
    const calls: FetchCall[] = [];
    const result = await fetchLiveBetTicker({
      session: SESSION,
      env: { F402_AGENT_ID: "  ENVAGENT  " },
      fetchImpl: recordingFetch(jsonResponse({ LIST: [] }), calls),
    });

    expect(result.ok).toBe(true);
    expect(result.agentId).toBe("ENVAGENT");
    const body = new URLSearchParams(String(calls[0]?.init.body));
    expect(body.get("agentID")).toBe("ENVAGENT");
    expect(body.get("agentOwner")).toBe("ENVAGENT");
  });

  test("reports 401/403 as unauthorized with the session:login hint", async () => {
    for (const status of [401, 403]) {
      const result = await fetchLiveBetTicker({
        agentId: "SPEN",
        session: SESSION,
        env: EMPTY_ENV,
        fetchImpl: recordingFetch(new Response("denied", { status }), []),
      });

      expect(result.ok).toBe(false);
      expect(result.rows).toEqual([]);
      expect(result.rawRowCount).toBe(0);
      const diagnostic = failureDiagnostic(result);
      expect(diagnostic).toMatchObject({
        code: "unauthorized",
        httpStatus: status,
      });
      expect(diagnostic.message).toContain("bun run session:login");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("SECRET_COOKIE_VALUE");
      expect(serialized).not.toContain("SECRET_TOKEN_VALUE");
    }
  });

  test("reports other statuses as http_error", async () => {
    const result = await fetchLiveBetTicker({
      agentId: "SPEN",
      session: SESSION,
      env: EMPTY_ENV,
      fetchImpl: recordingFetch(new Response("boom", { status: 500 }), []),
    });

    expect(result.ok).toBe(false);
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic).toMatchObject({ code: "http_error", httpStatus: 500 });
    expect(diagnostic.message).toBe("getBetTicker returned HTTP 500.");
  });

  test("reports a non-JSON body as parse_error (login page or error envelope)", async () => {
    const result = await fetchLiveBetTicker({
      agentId: "SPEN",
      session: SESSION,
      env: EMPTY_ENV,
      fetchImpl: recordingFetch(
        new Response("<html>login</html>", { status: 200 }),
        [],
      ),
    });

    expect(result.ok).toBe(false);
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic.code).toBe("parse_error");
    expect(diagnostic.message).toBe(
      "getBetTicker response body is not JSON (a login page or an error envelope was returned instead of the ticker).",
    );
  });

  test("reports a JSON body without a LIST array as parse_error", async () => {
    const result = await fetchLiveBetTicker({
      agentId: "SPEN",
      session: SESSION,
      env: EMPTY_ENV,
      fetchImpl: recordingFetch(jsonResponse({ ok: true }), []),
    });

    expect(result.ok).toBe(false);
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic.code).toBe("parse_error");
    expect(diagnostic.message).toBe(
      "getBetTicker response JSON has no LIST array; the ticker wire shape may have changed.",
    );
  });

  test("reports a timed-out request with the resolved timeout", async () => {
    const timeoutMs = 25;
    const result = await fetchLiveBetTicker({
      agentId: "SPEN",
      timeoutMs,
      session: SESSION,
      env: EMPTY_ENV,
      fetchImpl: async () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        throw error;
      },
    });

    expect(result.ok).toBe(false);
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic).toMatchObject({ code: "http_error", httpStatus: 0 });
    expect(diagnostic.message).toBe(
      `getBetTicker request timed out after ${timeoutMs} ms.`,
    );
  });

  test("reports any other thrown error without leaking the session", async () => {
    const result = await fetchLiveBetTicker({
      agentId: "SPEN",
      session: SESSION,
      env: EMPTY_ENV,
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });

    expect(result.ok).toBe(false);
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic).toMatchObject({ code: "http_error", httpStatus: 0 });
    expect(diagnostic.message).toBe(
      "getBetTicker request failed: connection refused",
    );
  });

  test("refuses with agent_required and never calls fetch when no agent resolves", async () => {
    const calls: FetchCall[] = [];
    const result = await fetchLiveBetTicker({
      session: SESSION,
      env: EMPTY_ENV,
      fetchImpl: recordingFetch(jsonResponse({ LIST: [] }), calls),
    });

    expect(result.ok).toBe(false);
    expect(result.agentId).toBeNull();
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic).toMatchObject({ code: "agent_required" });
    expect(diagnostic.message).toContain("F402_AGENT_ID");
    expect(calls).toHaveLength(0);
  });

  test("reads the keychain fallback through the injected secrets seam", async () => {
    const calls: FetchCall[] = [];
    let secretReads = 0;
    const result = await fetchLiveBetTicker({
      session: SESSION,
      env: EMPTY_ENV,
      secrets: async () => {
        secretReads += 1;
        return "  KEYCHAIN-AGENT  ";
      },
      fetchImpl: recordingFetch(jsonResponse({ LIST: [] }), calls),
    });

    expect(result.ok).toBe(true);
    expect(result.agentId).toBe("KEYCHAIN-AGENT");
    expect(secretReads).toBe(1);
    const body = new URLSearchParams(String(calls[0]?.init.body));
    expect(body.get("agentID")).toBe("KEYCHAIN-AGENT");
  });

  test("treats an absent or threw keychain secret as a normal agent_required", async () => {
    for (const secrets of [
      async () => null,
      async () => "",
      async (): Promise<string | null> => {
        throw new Error("keychain locked");
      },
    ]) {
      const result = await fetchLiveBetTicker({
        session: SESSION,
        env: EMPTY_ENV,
        secrets,
        fetchImpl: recordingFetch(jsonResponse({ LIST: [] }), []),
      });
      expect(result.ok).toBe(false);
      expect(failureDiagnostic(result).code).toBe("agent_required");
    }
  });

  test("refuses with transport_unavailable before resolving the agent", async () => {
    // env {} + session null: readF402Session() is never consulted because the seam is explicit.
    const result = await fetchLiveBetTicker({
      session: null,
      env: EMPTY_ENV,
    });

    expect(result.ok).toBe(false);
    expect(result.rows).toEqual([]);
    expect(result.agentId).toBeNull();
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic).toMatchObject({ code: "transport_unavailable" });
    if (diagnostic.code !== "transport_unavailable") {
      throw new Error(`expected transport_unavailable, got ${diagnostic.code}`);
    }
    expect(diagnostic.message).toContain("No F402 replay transport");
    expect(diagnostic.hint).toContain("bun run session:login");
    expect(diagnostic.hint).toContain("F402_SESSION_FILE");
    expect(diagnostic.hint).toContain("F402_REPLAY_PROXY_URL");
  });

  test("keeps transport-before-agent diagnostic precedence", async () => {
    // No transport AND no agent: the transport refusal wins, exactly as fetchIncomingBets did.
    const result = await fetchLiveBetTicker({ session: null, env: EMPTY_ENV });

    expect(failureDiagnostic(result).code).toBe("transport_unavailable");
  });
});

describe("isLiveTickerSource", () => {
  test("recognises the live: provenance prefix", () => {
    expect(
      isLiveTickerSource(
        "live:/cloud/api/Manager/getBetTicker@2026-11-05T02:40:00.000Z",
      ),
    ).toBe(true);
    expect(isLiveTickerSource("  live:anything  ")).toBe(true);
  });

  test("does not mistake a capture or an unlabelled source for a live read", () => {
    expect(
      isLiveTickerSource(
        "capture:/cloud/api/Manager/getBetTicker@2026-11-05T02:40:00.000Z",
      ),
    ).toBe(false);
    expect(isLiveTickerSource("unlabelled")).toBe(false);
    expect(isLiveTickerSource("")).toBe(false);
  });
});
