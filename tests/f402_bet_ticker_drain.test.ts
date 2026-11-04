import { describe, expect, test } from "bun:test";

import { drainF402BetTicker } from "../lib/f402_bet_ticker_drain.ts";
import type { F402Probe, F402TickerRow } from "../lib/f402_ingest.ts";

function tick(wagerNumber: number, ticketWriter = "Internet"): F402TickerRow {
  return {
    login: "TESTLOGIN",
    customerId: "TESTCUST",
    agentId: "TESTAGENT",
    agentLogin: "TESTAGENTLOGIN",
    ticketWriter,
    wagerNumber: String(wagerNumber),
    ticketNumber: "",
    wagerType: "S",
    shortDesc: "Football - Team A vs Team B / Game / Winner / Team A -110",
    insertedAt: "2026-11-03T18:00:00.000Z",
    vip: "0",
    amountWagered: 100,
    toWinAmount: 90,
    volumeAmount: 100,
  };
}

function probe(
  ticks: readonly F402TickerRow[],
  options: { rows?: number; error?: string | null } = {},
): F402Probe {
  return {
    endpoint: "test://getBetTicker",
    httpStatus: 200,
    rows: options.rows ?? ticks.length,
    fields: [],
    ticks,
    durationMs: 0,
    fetchedAtIso: "2026-11-03T18:00:00.000Z",
    error: options.error ?? null,
  };
}

function range(from: number, to: number): F402TickerRow[] {
  const rows: F402TickerRow[] = [];
  for (let value = from; value <= to; value += 1) rows.push(tick(value));
  return rows;
}

describe("drainF402BetTicker", () => {
  test("settles a short page in one request", async () => {
    const result = await drainF402BetTicker({
      probe: async () => probe(range(1, 3)),
    });
    expect(result).toEqual({
      status: "ok",
      rows: [tick(1), tick(2), tick(3)],
      watermark: 3,
      pages: 1,
    });
  });

  test("drains a full page with the highest wager number as the next cursor", async () => {
    const cursors: string[] = [];
    const result = await drainF402BetTicker({
      probe: async (cursor) => {
        cursors.push(cursor);
        return cursor === "0" ? probe(range(1, 100)) : probe(range(101, 105));
      },
    });
    expect(cursors).toEqual(["0", "100"]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.pages).toBe(2);
    expect(result.watermark).toBe(105);
    expect(result.rows).toHaveLength(105);
  });

  test("a repeated full page settles instead of spinning", async () => {
    const result = await drainF402BetTicker({
      probe: async () => probe(range(1, 100)),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.pages).toBe(2);
    expect(result.rows).toHaveLength(100);
  });

  test("a page below the watermark is a regression", async () => {
    const result = await drainF402BetTicker({
      probe: async () => probe(range(1, 5)),
      watermark: 200,
    });
    expect(result).toEqual({
      status: "regression",
      watermark: 200,
      pageMax: 5,
      pages: 1,
    });
  });

  test("probe errors are returned for a fail-closed skip", async () => {
    const result = await drainF402BetTicker({
      probe: async () => probe([], { rows: 0, error: "timeout" }),
    });
    expect(result).toEqual({ status: "error", error: "timeout", pages: 1 });
  });

  test("every full page still progressing exhausts maxPages as unsettled", async () => {
    let page = 0;
    const result = await drainF402BetTicker({
      maxPages: 3,
      probe: async () => {
        page += 1;
        const start = (page - 1) * 100 + 1;
        return probe(range(start, start + 99));
      },
    });
    expect(result).toEqual({ status: "unsettled", pages: 3 });
  });

  test("an empty page is an empty result", async () => {
    const result = await drainF402BetTicker({
      probe: async () => probe([], { rows: 0 }),
    });
    expect(result).toEqual({ status: "empty", watermark: 0, pages: 1 });
  });

  test("keeps an ALERT row and its non-ALERT twin across pages", async () => {
    const alert = tick(5, "ALERT");
    const owner = tick(5, "GSLIVE");
    const result = await drainF402BetTicker({
      probe: async (cursor) =>
        cursor === "0"
          ? probe([alert, owner, ...range(1, 98)])
          : probe([], { rows: 0 }),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.rows).toHaveLength(100);
    expect(
      result.rows.filter(
        (row) =>
          row.wagerNumber === "5" &&
          (row.ticketWriter === "ALERT" || row.ticketWriter === "GSLIVE"),
      ),
    ).toHaveLength(2);
  });
});
