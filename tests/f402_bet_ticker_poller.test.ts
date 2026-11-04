import { describe, expect, test } from "bun:test";

import {
  pollF402BetTickerOnce,
  type F402BetTickerPollState,
} from "../lib/f402_bet_ticker_poller.ts";
import type {
  F402BetTickerSink,
  F402BetTickerSinkResult,
} from "../lib/f402_bet_ticker_sink.ts";
import type { F402Probe, F402TickerRow } from "../lib/f402_ingest.ts";

const NOW = "2026-11-03T18:00:00.000Z";

function tick(wagerNumber: number): F402TickerRow {
  return {
    login: "TESTLOGIN",
    customerId: "TESTCUST",
    agentId: "TESTAGENT",
    agentLogin: "TESTAGENTLOGIN",
    ticketWriter: "Internet",
    wagerNumber: String(wagerNumber),
    ticketNumber: "",
    wagerType: "S",
    shortDesc: "Football - Team A vs Team B / Game / Winner / Team A -110",
    insertedAt: NOW,
    vip: "0",
    amountWagered: 100,
    toWinAmount: 90,
    volumeAmount: 100,
  };
}

function page(
  rows: readonly F402TickerRow[],
  error: string | null = null,
): F402Probe {
  return {
    endpoint: "test://getBetTicker",
    httpStatus: 200,
    rows: rows.length,
    fields: [],
    ticks: rows,
    durationMs: 0,
    fetchedAtIso: NOW,
    error,
  };
}

function queue(pages: readonly F402Probe[]): {
  readonly probe: (cursor: string) => Promise<F402Probe>;
  readonly cursors: string[];
} {
  let index = 0;
  const cursors: string[] = [];
  return {
    cursors,
    async probe(cursor) {
      cursors.push(cursor);
      const current = pages[Math.min(index, pages.length - 1)];
      index += 1;
      if (current === undefined) throw new Error("no page queued");
      return current;
    },
  };
}

function recorder(
  liveBetsResult: F402BetTickerSinkResult = { ok: true, published: 1 },
  r2Result: F402BetTickerSinkResult = { ok: true, url: "mem://latest.json" },
): {
  readonly sink: F402BetTickerSink;
  readonly liveBets: unknown[];
  readonly r2: unknown[];
} {
  const liveBets: unknown[] = [];
  const r2: unknown[] = [];
  return {
    liveBets,
    r2,
    sink: {
      async publishLiveBets(event) {
        liveBets.push(event);
        return liveBetsResult;
      },
      async publishR2(snapshot) {
        r2.push(snapshot);
        return r2Result;
      },
    },
  };
}

const COLD: F402BetTickerPollState = { watermark: 0, previousRows: [] };

describe("pollF402BetTickerOnce", () => {
  test("cold start establishes a baseline and writes only the snapshot", async () => {
    const { sink, liveBets, r2 } = recorder();
    const outcome = await pollF402BetTickerOnce({
      probe: queue([page([tick(1), tick(2)])]).probe,
      sink,
      state: COLD,
      now: () => NOW,
    });
    expect(outcome.status).toBe("baseline");
    expect(liveBets).toHaveLength(0);
    expect(r2).toHaveLength(1);
    if (outcome.status !== "baseline") return;
    expect(outcome.state.watermark).toBe(2);
    expect(outcome.state.previousRows).toHaveLength(2);
    expect(outcome.snapshot.rowCount).toBe(2);
  });

  test("the next poll publishes a delta and advances the watermark", async () => {
    const { sink, liveBets, r2 } = recorder();
    const outcome = await pollF402BetTickerOnce({
      probe: queue([page([tick(1), tick(2), tick(3)])]).probe,
      sink,
      state: { watermark: 2, previousRows: [tick(1), tick(2)] },
      now: () => NOW,
    });
    expect(outcome.status).toBe("published");
    expect(liveBets).toHaveLength(1);
    expect(r2).toHaveLength(1);
    if (outcome.status !== "published") return;
    expect(outcome.event.newTickets).toBe(1);
    expect(outcome.event.watermark).toBe("3");
    expect(outcome.state.watermark).toBe(3);
  });

  test("no row above the watermark is an idempotent no-op", async () => {
    const { sink, liveBets, r2 } = recorder();
    const state: F402BetTickerPollState = {
      watermark: 3,
      previousRows: [tick(1), tick(2), tick(3)],
    };
    const outcome = await pollF402BetTickerOnce({
      probe: queue([page([tick(1), tick(2), tick(3)])]).probe,
      sink,
      state,
      now: () => NOW,
    });
    expect(outcome.status).toBe("noop");
    expect(liveBets).toHaveLength(0);
    expect(r2).toHaveLength(0);
    expect(outcome.state.watermark).toBe(3);
  });

  test("an empty ticker is a no-op and clears the previous rows", async () => {
    const { sink } = recorder();
    const outcome = await pollF402BetTickerOnce({
      probe: queue([page([])]).probe,
      sink,
      state: { watermark: 3, previousRows: [tick(3)] },
      now: () => NOW,
    });
    expect(outcome.status).toBe("noop");
    expect(outcome.state.previousRows).toHaveLength(0);
  });

  test("a regression leaves the state untouched and publishes nothing", async () => {
    const { sink, liveBets, r2 } = recorder();
    const state: F402BetTickerPollState = {
      watermark: 10,
      previousRows: [tick(10)],
    };
    const outcome = await pollF402BetTickerOnce({
      probe: queue([page([tick(5)])]).probe,
      sink,
      state,
      now: () => NOW,
    });
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") return;
    expect(outcome.reason).toBe("regression");
    expect(outcome.state).toBe(state);
    expect(liveBets).toHaveLength(0);
    expect(r2).toHaveLength(0);
  });

  test("a probe error is a fail-closed skip", async () => {
    const { sink } = recorder();
    const outcome = await pollF402BetTickerOnce({
      probe: queue([page([], "unauthorized")]).probe,
      sink,
      state: COLD,
      now: () => NOW,
    });
    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") return;
    expect(outcome.reason).toBe("error");
    expect(outcome.error).toBe("unauthorized");
  });

  test("sink failures are reported but the processed poll advances the state", async () => {
    const { sink, liveBets } = recorder(
      { ok: false, error: "gateway down" },
      { ok: true, url: "mem://latest.json" },
    );
    const outcome = await pollF402BetTickerOnce({
      probe: queue([page([tick(1), tick(2), tick(3)])]).probe,
      sink,
      state: { watermark: 2, previousRows: [tick(1), tick(2)] },
      now: () => NOW,
    });
    expect(outcome.status).toBe("published");
    if (outcome.status !== "published") return;
    expect(outcome.liveBets.ok).toBe(false);
    expect(outcome.state.watermark).toBe(3);
    expect(liveBets).toHaveLength(1);
  });

  test("publishBaseline emits the cold-start delta when asked", async () => {
    const { sink, liveBets } = recorder();
    const outcome = await pollF402BetTickerOnce({
      probe: queue([page([tick(1)])]).probe,
      sink,
      state: COLD,
      now: () => NOW,
      publishBaseline: true,
    });
    expect(outcome.status).toBe("published");
    if (outcome.status !== "published") return;
    expect(outcome.event.newTickets).toBe(1);
    expect(liveBets).toHaveLength(1);
  });
});
