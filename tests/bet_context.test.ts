import { describe, expect, test } from "bun:test";
import { BET_CONTEXT_FIELDS, enrichIncomingBets } from "../lib/bet_context.ts";
import type { IncomingBetRecord } from "../lib/bet_flags.ts";

/**
 * Batch-context tests, crafted inputs only: `now` is always injected and every record's
 * `acceptedAt` is explicit, so nothing here depends on the wall clock or the network.
 */

const NOW = new Date("2026-11-05T02:40:00.000Z");

function isoBeforeNow(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

function bet(overrides: Partial<IncomingBetRecord> = {}): IncomingBetRecord {
  const base: IncomingBetRecord = {
    schemaVersion: 1,
    betKey: "T-1",
    ticketNumber: "",
    wagerNumber: "1",
    customerId: "CUST1",
    agentId: "AG1",
    agentLogin: "AG1",
    agentLevel: null,
    channel: "GSLIVE",
    wagerType: "S",
    wagerKind: "straight",
    sport: "Basketball",
    league: "",
    subSport: "Winner (2 way)",
    period: "Game",
    rotationNumber: null,
    selection: "Lakers -110",
    description: "Lakers -110",
    shortDescription: "Lakers -110",
    americanOdds: -110,
    impliedProb: 0.5238,
    line: null,
    stakeUsd: 100,
    toWinUsd: 91,
    volumeUsd: 100,
    riskUsd: 100,
    // v3 derived numeric fields for the fixture amounts (one leg, -110).
    stakeToWinRatio: 100 / 91,
    stakePerLeg: 100,
    oddsFromEven: 210,
    isLive: false,
    isVip: false,
    acceptedAt: isoBeforeNow(30),
    observedAt: NOW.toISOString(),
    ageSeconds: 30,
    source: "live-ticker",
    raw: {},
    eventLabel: "",
    eventKey: "",
    marketKey: "",
    marketType: "other",
    periodLabel: "",
    side: null,
    playerName: null,
    isPlayerProp: false,
    isAltLine: false,
    context: null,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      (base as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return base;
}

function contextOf(
  record: IncomingBetRecord,
): NonNullable<IncomingBetRecord["context"]> {
  if (record.context === null) throw new Error("record was not enriched");
  return record.context;
}

describe("BET_CONTEXT_FIELDS", () => {
  test("is the contracted field list in order", () => {
    expect(BET_CONTEXT_FIELDS).toEqual([
      "customerPriorBets",
      "customerPriorStakeUsd",
      "customerPriorStakeMedianUsd",
      "stakeVsPriorMedian",
      "customerBetsWindow",
      "customerStakeWindowUsd",
      "customerPeriodBetsWindow",
      "agentBetsWindow",
      "marketKey",
      "marketCrowdCustomers",
      "marketCrowdBets",
      "ticketLegs",
      "windowSeconds",
    ]);
  });
});

describe("enrichIncomingBets base behaviour", () => {
  test("returns [] for an empty batch", () => {
    expect(enrichIncomingBets([], { now: NOW })).toEqual([]);
  });

  test("sorts by acceptedAt then betKey and sets context on every record", () => {
    const records = [
      bet({ betKey: "T-C", acceptedAt: isoBeforeNow(10) }),
      bet({ betKey: "T-A", acceptedAt: isoBeforeNow(30) }),
      bet({ betKey: "T-B", acceptedAt: isoBeforeNow(20) }),
    ];
    const enriched = enrichIncomingBets(records, { now: NOW });
    expect(enriched.map((record) => record.betKey)).toEqual([
      "T-A",
      "T-B",
      "T-C",
    ]);
    for (const record of enriched) expect(record.context).not.toBeNull();
  });

  test("does not mutate the input records or their order", () => {
    const records = [
      bet({ betKey: "T-C", acceptedAt: isoBeforeNow(10) }),
      bet({ betKey: "T-A", acceptedAt: isoBeforeNow(30) }),
    ];
    const enriched = enrichIncomingBets(records, { now: NOW });
    expect(records[0]?.betKey).toBe("T-C");
    expect(records[0]?.context).toBeNull();
    expect(enriched[0]).not.toBe(records[1]);
    expect(enriched).toHaveLength(2);
  });
});

describe("customer prior baseline (strictly earlier rows)", () => {
  test("counts only earlier rows of the same customer, with stake median and ratio", () => {
    const records = [
      bet({ betKey: "T-1", stakeUsd: 100, acceptedAt: isoBeforeNow(300) }),
      bet({ betKey: "T-2", stakeUsd: 200, acceptedAt: isoBeforeNow(200) }),
      bet({ betKey: "T-3", stakeUsd: 400, acceptedAt: isoBeforeNow(100) }),
    ];
    const enriched = enrichIncomingBets(records, { now: NOW });
    const first = contextOf(enriched[0] as IncomingBetRecord);
    expect(first.customerPriorBets).toBe(0);
    expect(first.customerPriorStakeUsd).toBe(0);
    expect(first.customerPriorStakeMedianUsd).toBeNull();
    expect(first.stakeVsPriorMedian).toBeNull();

    const second = contextOf(enriched[1] as IncomingBetRecord);
    expect(second.customerPriorBets).toBe(1);
    expect(second.customerPriorStakeUsd).toBe(100);
    expect(second.customerPriorStakeMedianUsd).toBe(100);
    expect(second.stakeVsPriorMedian).toBe(2);

    const third = contextOf(enriched[2] as IncomingBetRecord);
    expect(third.customerPriorBets).toBe(2);
    expect(third.customerPriorStakeUsd).toBe(300);
    expect(third.customerPriorStakeMedianUsd).toBe(150);
    expect(third.stakeVsPriorMedian).toBeCloseTo(400 / 150, 6);
  });

  test("averages the middle pair for an even prior count", () => {
    const records = [
      bet({ betKey: "T-1", stakeUsd: 100, acceptedAt: isoBeforeNow(300) }),
      bet({ betKey: "T-2", stakeUsd: 200, acceptedAt: isoBeforeNow(200) }),
      bet({ betKey: "T-3", stakeUsd: 250, acceptedAt: isoBeforeNow(100) }),
    ];
    const enriched = enrichIncomingBets(records, { now: NOW });
    expect(
      contextOf(enriched[2] as IncomingBetRecord).customerPriorStakeMedianUsd,
    ).toBe(150);
  });

  test("an equal acceptedAt is broken by betKey, so the later key sees the earlier as prior", () => {
    const at = isoBeforeNow(100);
    const enriched = enrichIncomingBets(
      [
        bet({ betKey: "T-B", acceptedAt: at }),
        bet({ betKey: "T-A", acceptedAt: at }),
      ],
      { now: NOW },
    );
    expect(enriched.map((record) => record.betKey)).toEqual(["T-A", "T-B"]);
    expect(contextOf(enriched[0] as IncomingBetRecord).customerPriorBets).toBe(
      0,
    );
    expect(contextOf(enriched[1] as IncomingBetRecord).customerPriorBets).toBe(
      1,
    );
  });

  test("a row with no stake counts as a prior bet but adds no stake or median", () => {
    const records = [
      bet({ betKey: "T-1", stakeUsd: null, acceptedAt: isoBeforeNow(300) }),
      bet({ betKey: "T-2", stakeUsd: 500, acceptedAt: isoBeforeNow(200) }),
    ];
    const enriched = enrichIncomingBets(records, { now: NOW });
    const second = contextOf(enriched[1] as IncomingBetRecord);
    expect(second.customerPriorBets).toBe(1);
    expect(second.customerPriorStakeUsd).toBe(0);
    expect(second.customerPriorStakeMedianUsd).toBeNull();
    expect(second.stakeVsPriorMedian).toBeNull();
  });

  test("a zero prior median and a null current stake both yield null, never Infinity", () => {
    const zeroMedian = enrichIncomingBets(
      [
        bet({ betKey: "T-1", stakeUsd: 0, acceptedAt: isoBeforeNow(300) }),
        bet({ betKey: "T-2", stakeUsd: 0, acceptedAt: isoBeforeNow(200) }),
        bet({ betKey: "T-3", stakeUsd: 500, acceptedAt: isoBeforeNow(100) }),
      ],
      { now: NOW },
    );
    expect(
      contextOf(zeroMedian[2] as IncomingBetRecord).stakeVsPriorMedian,
    ).toBeNull();
    const nullStake = enrichIncomingBets(
      [
        bet({ betKey: "T-1", stakeUsd: 100, acceptedAt: isoBeforeNow(300) }),
        bet({ betKey: "T-2", stakeUsd: null, acceptedAt: isoBeforeNow(200) }),
      ],
      { now: NOW },
    );
    expect(
      contextOf(nullStake[1] as IncomingBetRecord).stakeVsPriorMedian,
    ).toBeNull();
  });

  test("a different customer's earlier bets never enter the prior baseline", () => {
    const enriched = enrichIncomingBets(
      [
        bet({
          betKey: "T-1",
          customerId: "OTHER",
          stakeUsd: 9999,
          acceptedAt: isoBeforeNow(300),
        }),
        bet({
          betKey: "T-2",
          customerId: "CUST1",
          acceptedAt: isoBeforeNow(200),
        }),
      ],
      { now: NOW },
    );
    const second = contextOf(enriched[1] as IncomingBetRecord);
    expect(second.customerPriorBets).toBe(0);
    expect(second.customerPriorStakeUsd).toBe(0);
  });
});

describe("window counts (anchored at now, inclusive)", () => {
  test("counts the whole window, current row included, and excludes older rows", () => {
    const records = [
      bet({ betKey: "T-1", stakeUsd: 100, acceptedAt: isoBeforeNow(240) }),
      bet({ betKey: "T-2", stakeUsd: 200, acceptedAt: isoBeforeNow(120) }),
      bet({ betKey: "T-3", stakeUsd: 400, acceptedAt: isoBeforeNow(400) }),
    ];
    const enriched = enrichIncomingBets(records, { now: NOW });
    const inWindow = contextOf(enriched[0] as IncomingBetRecord);
    expect(inWindow.customerBetsWindow).toBe(2);
    expect(inWindow.customerStakeWindowUsd).toBe(300);
    const outside = contextOf(enriched[2] as IncomingBetRecord);
    // The outside row is not counted; the two in-window rows still are.
    expect(outside.customerBetsWindow).toBe(2);
    expect(outside.customerStakeWindowUsd).toBe(300);
  });

  test("the boundary instant is inside the window, one millisecond earlier is not", () => {
    const boundary = new Date(NOW.getTime() - 300_000).toISOString();
    const justBefore = new Date(NOW.getTime() - 300_001).toISOString();
    const enriched = enrichIncomingBets(
      [
        bet({ betKey: "T-1", customerId: "CUST1", acceptedAt: boundary }),
        bet({ betKey: "T-2", customerId: "CUST2", acceptedAt: justBefore }),
      ],
      { now: NOW },
    );
    const one = contextOf(enriched[0] as IncomingBetRecord);
    const two = contextOf(enriched[1] as IncomingBetRecord);
    // `justBefore` is the earliest instant, so it sorts first and has no in-window company; the
    // boundary row is inside the window and sees only itself.
    expect(one.customerBetsWindow).toBe(0);
    expect(two.customerBetsWindow).toBe(1);
  });

  test("a custom windowSeconds is used and reported", () => {
    const records = [
      bet({ betKey: "T-1", acceptedAt: isoBeforeNow(45) }),
      bet({ betKey: "T-2", acceptedAt: isoBeforeNow(120) }),
    ];
    const short = enrichIncomingBets(records, {
      windowSeconds: 60,
      now: NOW,
    });
    expect(contextOf(short[0] as IncomingBetRecord).customerBetsWindow).toBe(1);
    expect(contextOf(short[1] as IncomingBetRecord).customerBetsWindow).toBe(1);
    expect(contextOf(short[0] as IncomingBetRecord).windowSeconds).toBe(60);
  });

  test("a future row is excluded from the window but still sorted", () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    const enriched = enrichIncomingBets(
      [
        bet({ betKey: "T-1", acceptedAt: isoBeforeNow(30) }),
        bet({ betKey: "T-2", acceptedAt: future }),
      ],
      { now: NOW },
    );
    expect(enriched.map((record) => record.betKey)).toEqual(["T-1", "T-2"]);
    expect(contextOf(enriched[1] as IncomingBetRecord).customerBetsWindow).toBe(
      1,
    );
  });

  test("an unparseable acceptedAt sorts after real instants and stays out of the window", () => {
    const enriched = enrichIncomingBets(
      [
        bet({ betKey: "T-BAD", acceptedAt: "not-a-time" }),
        bet({ betKey: "T-OK", acceptedAt: isoBeforeNow(30) }),
      ],
      { now: NOW },
    );
    expect(enriched.map((record) => record.betKey)).toEqual(["T-OK", "T-BAD"]);
    expect(contextOf(enriched[1] as IncomingBetRecord).customerBetsWindow).toBe(
      1,
    );
    // The bad row is still an earlier... no: it is later in the sort, so the OK row has no prior.
    expect(contextOf(enriched[0] as IncomingBetRecord).customerPriorBets).toBe(
      0,
    );
  });

  test("customerPeriodBetsWindow counts the same customer and the same period", () => {
    const records = [
      bet({
        betKey: "T-1",
        periodLabel: "1st Half",
        acceptedAt: isoBeforeNow(50),
      }),
      bet({
        betKey: "T-2",
        periodLabel: "1st Half",
        acceptedAt: isoBeforeNow(40),
      }),
      bet({ betKey: "T-3", periodLabel: "Game", acceptedAt: isoBeforeNow(30) }),
      bet({
        betKey: "T-4",
        customerId: "CUST2",
        periodLabel: "1st Half",
        acceptedAt: isoBeforeNow(20),
      }),
    ];
    const enriched = enrichIncomingBets(records, { now: NOW });
    const byKey = new Map(enriched.map((record) => [record.betKey, record]));
    expect(
      contextOf(byKey.get("T-1") as IncomingBetRecord).customerPeriodBetsWindow,
    ).toBe(2);
    expect(
      contextOf(byKey.get("T-3") as IncomingBetRecord).customerPeriodBetsWindow,
    ).toBe(1);
    expect(
      contextOf(byKey.get("T-4") as IncomingBetRecord).customerPeriodBetsWindow,
    ).toBe(1);
  });

  test("an empty periodLabel falls back to the legacy period field", () => {
    const records = [
      bet({
        betKey: "T-1",
        periodLabel: "",
        period: "Game",
        acceptedAt: isoBeforeNow(50),
      }),
      bet({
        betKey: "T-2",
        periodLabel: "",
        period: "Game",
        acceptedAt: isoBeforeNow(40),
      }),
    ];
    const enriched = enrichIncomingBets(records, { now: NOW });
    expect(
      contextOf(enriched[0] as IncomingBetRecord).customerPeriodBetsWindow,
    ).toBe(2);
  });

  test("agentBetsWindow counts the agent's window bets; an empty agent never groups", () => {
    const records = [
      bet({
        betKey: "T-1",
        customerId: "C1",
        agentId: "AG1",
        acceptedAt: isoBeforeNow(50),
      }),
      bet({
        betKey: "T-2",
        customerId: "C2",
        agentId: "AG1",
        acceptedAt: isoBeforeNow(40),
      }),
      bet({
        betKey: "T-3",
        customerId: "C3",
        agentId: "",
        acceptedAt: isoBeforeNow(30),
      }),
      bet({
        betKey: "T-4",
        customerId: "C4",
        agentId: "",
        acceptedAt: isoBeforeNow(20),
      }),
    ];
    const enriched = enrichIncomingBets(records, { now: NOW });
    const byKey = new Map(enriched.map((record) => [record.betKey, record]));
    expect(
      contextOf(byKey.get("T-1") as IncomingBetRecord).agentBetsWindow,
    ).toBe(2);
    expect(
      contextOf(byKey.get("T-3") as IncomingBetRecord).agentBetsWindow,
    ).toBe(0);
  });
});

describe("market crowd and ticket legs", () => {
  test("counts distinct customers and bets on the same marketKey in the window", () => {
    const records = [
      bet({
        betKey: "T-1",
        customerId: "C1",
        marketKey: "MKT-A",
        acceptedAt: isoBeforeNow(50),
      }),
      bet({
        betKey: "T-2",
        customerId: "C2",
        marketKey: "MKT-A",
        acceptedAt: isoBeforeNow(40),
      }),
      bet({
        betKey: "T-3",
        customerId: "C1",
        marketKey: "MKT-A",
        acceptedAt: isoBeforeNow(30),
      }),
      bet({
        betKey: "T-4",
        customerId: "C9",
        marketKey: "MKT-B",
        acceptedAt: isoBeforeNow(20),
      }),
    ];
    const enriched = enrichIncomingBets(records, { now: NOW });
    const byKey = new Map(enriched.map((record) => [record.betKey, record]));
    const a = contextOf(byKey.get("T-1") as IncomingBetRecord);
    expect(a.marketCrowdCustomers).toBe(2);
    expect(a.marketCrowdBets).toBe(3);
    expect(a.marketKey).toBe("MKT-A");
    const b = contextOf(byKey.get("T-4") as IncomingBetRecord);
    expect(b.marketCrowdCustomers).toBe(1);
    expect(b.marketCrowdBets).toBe(1);
  });

  test("an empty marketKey never looks like one crowd", () => {
    const records = [
      bet({ betKey: "T-1", marketKey: "", acceptedAt: isoBeforeNow(50) }),
      bet({ betKey: "T-2", marketKey: "", acceptedAt: isoBeforeNow(40) }),
    ];
    const enriched = enrichIncomingBets(records, { now: NOW });
    expect(
      contextOf(enriched[0] as IncomingBetRecord).marketCrowdCustomers,
    ).toBe(0);
    expect(contextOf(enriched[0] as IncomingBetRecord).marketCrowdBets).toBe(0);
  });

  test("ticketLegs counts batch rows sharing ticketNumber; a ticker row reads 1", () => {
    const pending = [
      bet({
        betKey: "900-1",
        ticketNumber: "900",
        wagerNumber: "1",
        source: "capture-bets",
        acceptedAt: isoBeforeNow(50),
      }),
      bet({
        betKey: "900-2",
        ticketNumber: "900",
        wagerNumber: "2",
        source: "capture-bets",
        acceptedAt: isoBeforeNow(50),
      }),
      bet({
        betKey: "900-3",
        ticketNumber: "900",
        wagerNumber: "3",
        source: "capture-bets",
        acceptedAt: isoBeforeNow(50),
      }),
      bet({ betKey: "T-9", ticketNumber: "", source: "live-ticker" }),
    ];
    const enriched = enrichIncomingBets(pending, { now: NOW });
    const byKey = new Map(enriched.map((record) => [record.betKey, record]));
    expect(contextOf(byKey.get("900-1") as IncomingBetRecord).ticketLegs).toBe(
      3,
    );
    expect(contextOf(byKey.get("T-9") as IncomingBetRecord).ticketLegs).toBe(1);
  });
});

describe("enrichIncomingBets option validation", () => {
  test("rejects invalid windowSeconds with an actionable TypeError", () => {
    expect(() => enrichIncomingBets([], { windowSeconds: 0 })).toThrow(
      TypeError,
    );
    expect(() => enrichIncomingBets([], { windowSeconds: 1.5 })).toThrow(
      "windowSeconds must be an integer between 1 and 86400",
    );
    expect(() => enrichIncomingBets([], { windowSeconds: 90_000 })).toThrow(
      TypeError,
    );
    expect(() => enrichIncomingBets([], { windowSeconds: Number.NaN })).toThrow(
      TypeError,
    );
  });

  test("defaults the window to 300 seconds", () => {
    const enriched = enrichIncomingBets([bet()], { now: NOW });
    expect(contextOf(enriched[0] as IncomingBetRecord).windowSeconds).toBe(300);
  });
});
