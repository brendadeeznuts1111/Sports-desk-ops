import { describe, expect, test } from "bun:test";

import { setTicketInternal } from "../lib/ticket_internal.ts";
import {
  batchReplay,
  cloneBet,
  oppositeSidesAcrossCustomers,
  oppositeSidesSameCustomer,
  pastPost,
  periodCorrelation,
  periodOrderAnomaly,
  velocityCustomer,
  velocityMarket,
  type RuleTicket,
} from "../cli/rules.ts";
import type { NormalizedTicketLeg } from "../lib/live_ticket_view.ts";

function leg(
  eventName: string,
  period: string,
  selection: string,
  price = "-110",
  market = "Total",
): NormalizedTicketLeg {
  return {
    index: 1,
    sport: "Basketball",
    eventName,
    period,
    market,
    selection,
    price,
    live: false,
    gameNumber: null,
  };
}

function ticket(
  overrides: Partial<RuleTicket> & {
    customer?: string;
    agent?: string;
  } = {},
): RuleTicket {
  const value: RuleTicket = {
    wagerNumber: overrides.wagerNumber ?? String(Math.random()),
    insertedAt: overrides.insertedAt ?? "2026-11-04T22:00:00",
    stake: overrides.stake ?? 100,
    toWin: overrides.toWin ?? 100,
    legs: overrides.legs ?? [],
    ticketWriter: overrides.ticketWriter ?? "Internet",
  };
  setTicketInternal(value, {
    customer: overrides.customer ?? "C",
    agent: overrides.agent ?? "A",
  });
  return value;
}

describe("period_correlation", () => {
  test("fires on four period totals from one customer", () => {
    const rows = ["1Q", "2Q", "3Q", "4Q"].map((period, index) =>
      ticket({
        wagerNumber: String(767465000 + index),
        insertedAt: `2026-11-04T21:${15 + index}:00`,
        customer: "MH521",
        legs: [leg("Lakers vs Kings", period, "Over 55")],
      }),
    );
    const hits = periodCorrelation(rows);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.evidence.periodCount).toBe(4);
  });

  test("silent with only two periods", () => {
    const rows = ["1Q", "2Q"].map((period) =>
      ticket({ legs: [leg("Lakers vs Kings", period, "Over 55")] }),
    );
    expect(periodCorrelation(rows)).toHaveLength(0);
  });
});

describe("batch_replay", () => {
  test("fires on a same-agent 4ms pair", () => {
    const rows = [
      ticket({ insertedAt: "2026-11-04T21:56:50.683", agent: "CRYPTO91" }),
      ticket({ insertedAt: "2026-11-04T21:56:50.687", agent: "CRYPTO91" }),
    ];
    const hits = batchReplay(rows);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.evidence.count).toBe(2);
  });

  test("silent across different agents", () => {
    const rows = [
      ticket({ insertedAt: "2026-11-04T21:56:50.683", agent: "A" }),
      ticket({ insertedAt: "2026-11-04T21:56:50.687", agent: "B" }),
    ];
    expect(batchReplay(rows)).toHaveLength(0);
  });
});

describe("clone_bet", () => {
  test("two identical tickets are a notice, three are a warning", () => {
    const legs = [leg("Lakers vs Kings", "Game", "Lakers", "-110", "Winner")];
    const two = [
      ticket({ insertedAt: "2026-11-04T22:00:00", legs }),
      ticket({ insertedAt: "2026-11-04T22:00:10", legs }),
    ];
    expect(cloneBet(two)[0]?.severity).toBe("notice");
    const three = [...two, ticket({ insertedAt: "2026-11-04T22:00:20", legs })];
    expect(cloneBet(three)[0]?.severity).toBe("warning");
  });
});

describe("velocity_customer", () => {
  test("ten wagers in five minutes fire notice", () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      ticket({
        customer: "C",
        insertedAt: new Date(
          Date.parse("2026-11-04T22:00:00Z") + index * 10_000,
        ).toISOString(),
      }),
    );
    const hits = velocityCustomer(rows);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe("notice");
  });
});

describe("velocity_market", () => {
  test("five customers on the same selection in 30s fire", () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      ticket({
        customer: `C${index}`,
        insertedAt: `2026-11-04T22:00:${String(index * 2).padStart(2, "0")}`,
        legs: [leg("Lakers vs Kings", "Game", "Over 55")],
      }),
    );
    const hits = velocityMarket(rows);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.evidence.distinctCustomers).toBe(5);
  });
});

describe("opposite sides", () => {
  const over = leg("Lakers vs Kings", "Game", "Over 55");
  const under = leg("Lakers vs Kings", "Game", "Under 55");

  test("same customer on both sides in one hour", () => {
    const rows = [
      ticket({
        customer: "C",
        insertedAt: "2026-11-04T22:00:00",
        legs: [over],
      }),
      ticket({
        customer: "C",
        insertedAt: "2026-11-04T22:10:00",
        legs: [under],
      }),
    ];
    expect(oppositeSidesSameCustomer(rows)).toHaveLength(1);
  });

  test("different customers on both sides within five minutes", () => {
    const rows = [
      ticket({
        customer: "C1",
        insertedAt: "2026-11-04T22:00:00",
        legs: [over],
      }),
      ticket({
        customer: "C2",
        insertedAt: "2026-11-04T22:01:00",
        legs: [under],
      }),
    ];
    expect(oppositeSidesAcrossCustomers(rows)).toHaveLength(1);
  });
});

describe("period_order_anomaly", () => {
  test("fires when a later period precedes an earlier one by ten minutes", () => {
    const rows = [
      ticket({
        customer: "C",
        insertedAt: "2026-11-04T21:00:00",
        legs: [leg("Lakers vs Kings", "3Q", "Over 55")],
      }),
      ticket({
        customer: "C",
        insertedAt: "2026-11-04T21:20:00",
        legs: [leg("Lakers vs Kings", "2Q", "Over 55")],
      }),
    ];
    expect(periodOrderAnomaly(rows)).toHaveLength(1);
  });
});

describe("past_post", () => {
  test("requires a schedule", () => {
    const rows = [
      ticket({
        insertedAt: "2026-11-04T22:05:00",
        legs: [leg("Lakers vs Kings", "Game", "Lakers", "-110", "Winner")],
      }),
    ];
    expect(pastPost(rows)).toHaveLength(0);
    const schedule = new Map([["kings vs lakers", "2026-11-04T22:00:00"]]);
    expect(pastPost(rows, { schedule })).toHaveLength(1);
  });
});
