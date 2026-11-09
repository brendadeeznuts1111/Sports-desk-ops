import { describe, expect, test } from "bun:test";

import {
  parseF402TickerRow,
  probeF402BetTicker,
  type F402ProbeFetch,
} from "../lib/f402_ingest.ts";
import type { F402Session } from "../lib/f402_session.ts";

const SESSION: F402Session = {
  cookieHeader: "k=v",
  cookieNames: ["k"],
  obtainedAtIso: "2026-11-03T18:00:00.000Z",
  expiresAtIso: "2026-11-03T19:00:00.000Z",
};

function rawRow(wagerNumber: number): Record<string, unknown> {
  return {
    Login: "TESTLOGIN",
    CustomerID: "TESTCUST",
    AgentID: "TESTAGENT",
    AgentLogin: "TESTAGENTLOGIN",
    TicketWriter: "GSLIVE",
    WagerNumber: wagerNumber,
    WagerType: "S",
    ShortDesc: "Football - Team A vs Team B / Game / Winner / Team A -110",
    InsertDateTime: "2026-11-03T18:00:00.000Z",
    VIP: "0",
    AmountWagered: 3500,
    ToWinAmount: 3000,
    VolumeAmount: 2188,
  };
}

function fetchReturning(status: number, body: unknown): F402ProbeFetch {
  return async () => Response.json(body, { status });
}

describe("parseF402TickerRow", () => {
  test("maps the captured 13-field row without inventing a ticket number", () => {
    const row = parseF402TickerRow(rawRow(900001));
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.wagerNumber).toBe("900001");
    expect(row.ticketNumber).toBe("");
    expect(row.ticketWriter).toBe("GSLIVE");
    expect(row.amountWagered).toBe(3500);
    expect(row.toWinAmount).toBe(3000);
    expect(row.volumeAmount).toBe(2188);
    expect(row.shortDesc).toContain("Football");
  });

  test("falls through empty string PascalCase fields to populated camelCase aliases", () => {
    const mixed = {
      Login: "",
      login: "FALLBACK_LOGIN",
      CustomerID: "   ",
      customerId: "FALLBACK_CUST",
      ShortDesc: "",
      Description: "Basketball - Team X vs Team Y",
      AmountWagered: "",
      Risk: 1500,
      ToWinAmount: null,
      ToWin: "1200",
      VolumeAmount: 1500,
      WagerNumber: "888",
    };
    const row = parseF402TickerRow(mixed);
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.login).toBe("FALLBACK_LOGIN");
    expect(row.customerId).toBe("FALLBACK_CUST");
    expect(row.shortDesc).toBe("Basketball - Team X vs Team Y");
    expect(row.amountWagered).toBe(1500);
    expect(row.toWinAmount).toBe(1200);
    expect(row.volumeAmount).toBe(1500);
  });

  test("keeps TicketNumber when a future payload carries it", () => {
    const row = parseF402TickerRow({ ...rawRow(1), TicketNumber: "T-7" });
    expect(row?.ticketNumber).toBe("T-7");
  });

  test("rejects rows with no login or customer id", () => {
    expect(parseF402TickerRow({ WagerNumber: "1" })).toBeNull();
    expect(parseF402TickerRow(null)).toBeNull();
  });
});

describe("probeF402BetTicker", () => {
  test("normalizes the full list and honors maxTicks", async () => {
    const probe = await probeF402BetTicker(SESSION, {
      agentId: "AGENT1",
      maxTicks: 2,
      fetchImpl: fetchReturning(200, {
        LIST: [rawRow(1), rawRow(2), rawRow(3)],
      }),
    });
    expect(probe.error).toBeNull();
    expect(probe.rows).toBe(3);
    expect(probe.ticks).toHaveLength(2);
  });

  test("sends the paging cursor as wagerNumber", async () => {
    const forms: URLSearchParams[] = [];
    const fetchImpl: F402ProbeFetch = async (_input, init) => {
      forms.push(new URLSearchParams(String(init.body)));
      return Response.json({ LIST: [rawRow(5)] });
    };
    await probeF402BetTicker(SESSION, {
      agentId: "AGENT1",
      wagerNumber: "9000",
      fetchImpl,
    });
    expect(forms[0]?.get("wagerNumber")).toBe("9000");
    expect(forms[0]?.get("operation")).toBe("getBetTicker");
  });

  test("maps 401 to the unauthorized sentinel", async () => {
    const probe = await probeF402BetTicker(SESSION, {
      agentId: "AGENT1",
      fetchImpl: fetchReturning(401, { error: "no" }),
    });
    expect(probe.httpStatus).toBe(401);
    expect(probe.error).toBe("unauthorized");
    expect(probe.ticks).toEqual([]);
  });

  test("reports an unexpected body instead of inventing rows", async () => {
    const probe = await probeF402BetTicker(SESSION, {
      agentId: "AGENT1",
      fetchImpl: fetchReturning(200, { ok: true }),
    });
    expect(probe.error).toBe("unexpected body");
    expect(probe.rows).toBe(0);
  });
});
