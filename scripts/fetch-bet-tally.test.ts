import { describe, expect, test } from "bun:test";

import { z } from "zod";

import {
  ALL_STATES,
  bootstrapGanchrowSession,
  buildBetReportPayload,
  cookieHeaderFromEnv,
  extractBetRows,
  fetchBetReportRowsFromPayload,
  formatTally,
  GSID_SECRET,
  requireManagerSession,
  resolveManagerSession,
  GSLIVE_NUMERIC_STATE_MAP,
  parseBetReportRequest,
  runBetTally,
  selectStateField,
  sessionGateFromEnv,
  SIGNIN_URL,
  stateLabel,
  tallyRows,
  type BetTallyResult,
} from "./fetch-bet-tally.ts";

type FetchCall = { readonly url: string; readonly init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function htmlResponse(): Response {
  return new Response("<html><body>login</body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** A fetch stub that records calls and replies from a queue. */
function queuedFetch(responses: readonly Response[]): {
  readonly calls: FetchCall[];
  readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
} {
  const calls: FetchCall[] = [];
  let index = 0;
  return {
    calls,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      const response = responses[index];
      index += 1;
      if (response === undefined) {
        throw new Error(
          `unexpected fetch call #${index} (queue has ${responses.length})`,
        );
      }
      return response;
    },
  };
}

const WINDOW = {
  fromEpochSec: 1_793_163_600,
  toEpochSec: 1_793_771_999,
} as const;

describe("buildBetReportPayload", () => {
  test("sends state:'' for All and keeps group null so rows are bets, not grouped rows", () => {
    const payload = buildBetReportPayload(WINDOW);
    expect(payload.action).toBe("getBetReport");
    expect(payload.state).toBe(ALL_STATES);
    expect(payload.state).toBe("");
    expect(payload.group).toBeNull();
    expect(payload.period).toBeNull();
    expect(payload.dateFilterBy).toBe("calcTime");
    expect(payload.from).toBe(WINDOW.fromEpochSec);
    expect(payload.to).toBe(WINDOW.toEpochSec);
    expect(payload.fromTime).toBe(0);
    expect(payload.toTime).toBe(86399);
    expect(payload.betGroupId).toBe("");
    expect(payload.partnerIds).toBe("");
  });

  test("honors an explicit state filter and dateFilterBy", () => {
    const payload = buildBetReportPayload({
      ...WINDOW,
      state: "cancel",
      dateFilterBy: "betTime",
    });
    expect(payload.state).toBe("cancel");
    expect(payload.dateFilterBy).toBe("betTime");
  });
});

describe("cookieHeaderFromEnv", () => {
  test("fails closed with no GSID", () => {
    expect(cookieHeaderFromEnv({})).toBe("");
    expect(cookieHeaderFromEnv({ GSID: "   " })).toBe("");
  });

  test("builds the cookie from env only, with optional _ga", () => {
    expect(cookieHeaderFromEnv({ GSID: "fixture-session" })).toBe(
      "GSID=fixture-session",
    );
    expect(
      cookieHeaderFromEnv({ GSID: "fixture-session", GA: "GA1.1.1" }),
    ).toBe("GSID=fixture-session; _ga=GA1.1.1");
  });

  test("optional x-gs-session gate is separate from the cookie", () => {
    expect(sessionGateFromEnv({})).toBe("");
    expect(sessionGateFromEnv({ GS_SESSION: " gate " })).toBe("gate");
  });
});

describe("extractBetRows", () => {
  test("accepts a bare array and the known row envelopes", () => {
    expect(extractBetRows([{ state: "win" }])).toEqual([{ state: "win" }]);
    expect(extractBetRows({ bets: [{ state: "lose" }] })).toEqual([
      { state: "lose" },
    ]);
    expect(extractBetRows({ rows: [] })).toEqual([]);
    expect(extractBetRows({ data: [{ state: "push" }] })).toEqual([
      { state: "push" },
    ]);
  });

  test("throws on a shape that cannot be rows instead of reporting zero bets", () => {
    expect(() => extractBetRows(null)).toThrow(
      /unexpected getBetReport payload/,
    );
    expect(() => extractBetRows("html")).toThrow(
      /unexpected getBetReport payload/,
    );
    expect(() => extractBetRows({ error: "expired" })).toThrow(
      /object without an array under bets\/rows/,
    );
  });
});

describe("state labels", () => {
  test("selects the field the rows actually carry", () => {
    expect(selectStateField([{ status: "win" }, { status: "lose" }])).toBe(
      "status",
    );
    expect(selectStateField([{ state: "win" }, { state: "lose" }])).toBe(
      "state",
    );
    expect(selectStateField([{}, { state: "win" }])).toBe("state");
  });

  test("maps numeric codes and marks missing/empty cells", () => {
    expect(stateLabel({ state: 0 }, "state")).toBe("pending");
    expect(stateLabel({ state: 7 }, "state")).toBe("half win");
    expect(stateLabel({ state: 99 }, "state")).toBe("(code 99)");
    expect(stateLabel({ state: null }, "state")).toBe("(missing)");
    expect(stateLabel({ state: "  " }, "state")).toBe("(empty)");
    expect(stateLabel({ state: "cancel after confirmation" }, "state")).toBe(
      "cancel after confirmation",
    );
    expect(stateLabel("not-a-row", "state")).toBe("(non-object row)");
  });

  test("numeric map covers the observed vocabulary", () => {
    expect(Object.values(GSLIVE_NUMERIC_STATE_MAP)).toEqual([
      "pending",
      "win",
      "lose",
      "push",
      "cancel",
      "cancel after confirmation",
      "cashout",
      "half win",
      "half lose",
    ]);
  });
});

describe("tallyRows and formatTally", () => {
  test("counts states and percentages", () => {
    const tally = tallyRows([
      { state: "win" },
      { state: "win" },
      { state: "lose" },
      { state: "pending" },
    ]);
    expect(tally.field).toBe("state");
    expect(tally.total).toBe(4);
    expect(tally.counts).toEqual({ win: 2, lose: 1, pending: 1 });
    expect(tally.distinct).toBe(3);
    const table = formatTally(tally);
    expect(table).toContain("field = state   total = 4");
    expect(table).toContain("50.0%");
  });

  test("empty window renders no NaN", () => {
    const tally = tallyRows([]);
    expect(tally.total).toBe(0);
    const table = formatTally(tally);
    expect(table).toContain("total = 0");
    expect(table).not.toContain("NaN");
  });
});

describe("runBetTally", () => {
  const cookieHeader = "GSID=fixture-session";

  test("one bulk fetch when the payload already carries several states", async () => {
    const { calls, fetchImpl } = queuedFetch([
      jsonResponse({
        bets: [{ state: "win" }, { state: "lose" }, { state: "pending" }],
      }),
    ]);
    const result = await runBetTally({
      ...WINDOW,
      cookieHeader,
      fetchImpl,
      sessionGate: "gate-fixture",
    });

    expect(calls).toHaveLength(1);
    expect(result.total).toBe(3);
    expect(result.distinct).toBe(3);
    expect(result.perState).toBeNull();
    expect(result.filterIgnored).toBe(false);
    expect(result.dateFilterBy).toBe("calcTime");
    expect(Number.isNaN(Date.parse(result.capturedAt))).toBe(false);

    const sent = z
      .object({ state: z.string() })
      .parse(JSON.parse(String(calls[0]?.init.body)));
    expect(sent.state).toBe("");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("cookie")).toBe(cookieHeader);
    expect(headers.get("x-gs-session")).toBe("gate-fixture");
  });

  test("probes per-state when the bulk payload collapses to one state", async () => {
    const { calls, fetchImpl } = queuedFetch([
      jsonResponse({ bets: [{ state: "pending" }] }),
      jsonResponse({ bets: [{ state: "pending" }] }),
      jsonResponse({ bets: [{ state: "win" }, { state: "win" }] }),
      jsonResponse({ bets: [] }),
    ]);
    const result = await runBetTally({
      ...WINDOW,
      cookieHeader,
      fetchImpl,
      states: ["pending", "win", "lose"],
    });

    expect(result.defaultState).toBeNull();
    expect(result.filterIgnored).toBe(false);
    expect(result.perState).toEqual({ pending: 1, win: 2, lose: 0 });
    expect(calls).toHaveLength(4);
    const sentStates = calls.map(
      (call) =>
        z
          .object({ state: z.string() })
          .parse(JSON.parse(String(call.init.body))).state,
    );
    expect(sentStates).toEqual(["", "pending", "win", "lose"]);
  });

  test("flags a filter-ignoring server and names the likely default state", async () => {
    const identical = { bets: [{ state: "pending" }, { state: "pending" }] };
    const { fetchImpl } = queuedFetch([
      jsonResponse(identical),
      jsonResponse(identical),
      jsonResponse(identical),
    ]);
    const result: BetTallyResult = await runBetTally({
      ...WINDOW,
      cookieHeader,
      fetchImpl,
      states: ["pending", "win"],
    });

    expect(result.filterIgnored).toBe(true);
    expect(result.defaultState).toBe("pending");
    expect(result.warnings.join(" ")).toContain("ignoring the `state` field");
    expect(result.warnings.join(" ")).toContain(
      "treated as that state's filter",
    );
  });

  test("an empty window is reported as zero, not as a failed probe", async () => {
    const { calls, fetchImpl } = queuedFetch([jsonResponse({ bets: [] })]);
    const result = await runBetTally({
      ...WINDOW,
      cookieHeader,
      fetchImpl,
      states: [],
    });

    expect(calls).toHaveLength(1);
    expect(result.total).toBe(0);
    expect(result.perState).toBeNull();
    expect(result.filterIgnored).toBe(false);
  });

  test("a non-JSON login page fails closed without leaking the cookie", async () => {
    const { fetchImpl } = queuedFetch([htmlResponse()]);
    let message = "";
    try {
      await runBetTally({ ...WINDOW, cookieHeader, fetchImpl });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("HTTP 200");
    expect(message).toContain("login page");
    expect(message).not.toContain("fixture-session");
  });

  test("an HTTP error fails closed", async () => {
    const { fetchImpl } = queuedFetch([
      jsonResponse({ error: "expired" }, 401),
    ]);
    await expect(
      runBetTally({ ...WINDOW, cookieHeader, fetchImpl }),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe("supplied ajax.php payload", () => {
  const payload = {
    action: "getBetReport",
    state: "",
    from: 1792904400,
    to: 1793771999,
    fromTime: 0,
    toTime: 86399,
    group: null,
    dateFilterBy: "logTime",
    partnerUserId: "",
    period: null,
  } as const;

  test("accepts logTime and keeps extra keys", () => {
    const parsed = parseBetReportRequest(payload);
    expect(parsed.dateFilterBy).toBe("logTime");
    expect(parsed.from).toBe(1792904400);
    expect((parsed as Record<string, unknown>).partnerUserId).toBe("");
  });

  test("rejects a non-getBetReport body before any network call", () => {
    expect(() =>
      parseBetReportRequest({ action: "getInfoPlayer", from: 1, to: 2 }),
    ).toThrow(/invalid getBetReport payload/);
    expect(() =>
      parseBetReportRequest({ action: "getBetReport", to: 2 }),
    ).toThrow(/from/);
    expect(() =>
      parseBetReportRequest({
        action: "getBetReport",
        from: 1,
        to: 2,
        dateFilterBy: "nope",
      }),
    ).toThrow(/dateFilterBy/);
  });

  test("POSTs the supplied body verbatim and reads its rows", async () => {
    const calls: RequestInit[] = [];
    const rows = await fetchBetReportRowsFromPayload({
      payload,
      cookieHeader: "GSID=fixture-session",
      fetchImpl: async (_url, init) => {
        calls.push(init);
        return jsonResponse({ bets: [{ state: "win" }] });
      },
    });
    expect(rows).toEqual([{ state: "win" }]);
    expect(JSON.parse(String(calls[0]?.body))).toEqual(payload);
  });
});

describe("session bootstrap (x-gs-session)", () => {
  test("exchanges the cookie for ganchrowSessionId with checkSession:true", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const id = await bootstrapGanchrowSession({
      cookieHeader: "GSID=fixture-session",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({
          ganchrowSessionId: "ganchrow-fixture",
          adminUserName: "op",
        });
      },
    });
    expect(id).toBe("ganchrow-fixture");
    expect(calls[0]?.url).toBe(SIGNIN_URL);
    expect(String(calls[0]?.init.method)).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      checkSession: true,
    });
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("cookie")).toBe("GSID=fixture-session");
  });

  test("fails closed on an HTML login page or a missing id, without leaking the cookie", async () => {
    const htmlError = await bootstrapGanchrowSession({
      cookieHeader: "GSID=fixture-session",
      fetchImpl: async () => htmlResponse(),
    }).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    expect(htmlError).toContain("HTTP 200");
    expect(htmlError).not.toContain("fixture-session");

    await expect(
      bootstrapGanchrowSession({
        cookieHeader: "GSID=fixture-session",
        fetchImpl: async () => jsonResponse({ adminUserName: "op" }),
      }),
    ).rejects.toThrow(/no ganchrowSessionId/);
  });
});

describe("keychain-first manager session", () => {
  const reader = (value: string | null | Error) => ({
    async get() {
      if (value instanceof Error) throw value;
      return value;
    },
  });

  test("a stored keychain session wins over the environment", async () => {
    const session = await resolveManagerSession(
      { GSID: "env-session", GA: "GA1.1.1" },
      reader("keychain-session"),
    );
    expect(session.source).toBe("keychain");
    expect(session.cookieHeader).toBe("GSID=keychain-session; _ga=GA1.1.1");
  });

  test("missing or unreadable keychain falls back to GSID in the environment", async () => {
    expect(
      (await resolveManagerSession({ GSID: "env-session" }, reader(null)))
        .source,
    ).toBe("env");
    const thrown = await resolveManagerSession(
      { GSID: "env-session" },
      reader(new Error("keychain locked")),
    );
    expect(thrown.source).toBe("env");
    expect(thrown.cookieHeader).toBe("GSID=env-session");
  });

  test("no session anywhere reports none, and require fails closed", async () => {
    const none = await resolveManagerSession({}, reader(null));
    expect(none).toEqual({ cookieHeader: "", source: "none" });
    await expect(requireManagerSession({}, reader(null))).rejects.toThrow(
      /No manager session/,
    );
    expect(GSID_SECRET.service).toBe("com.bookdeskops.sportsdesk");
  });

  test("blank keychain values are ignored rather than sent as a session", async () => {
    const session = await resolveManagerSession(
      { GSID: "env-session" },
      reader("   "),
    );
    expect(session.source).toBe("env");
  });
});
