import { describe, expect, test } from "bun:test";
import {
  backtestRowsToProfiles,
  bookRowsToProfiles,
  mergeProfileRows,
  selectProfileRows,
} from "../packages/ui/src/profile_rows.ts";

const row = {
  customer_id: "SYNTH_SYN_01",
  agent_id: "SYNTH_AGENT_01",
  master_agent: "SYNTH_MASTER_01",
  context_type: "STEAM_CHASER",
  wager_limit_usd: 15000,
  delay_seconds: 0,
  ip_subnet: "203.0.113.0/24",
  lifetime_net_usd: -75000,
  hold_pct: -15,
  clv_bps: 40,
  sharp_score: 81.5,
  recent_tickets: [
    { league: "CFB", market: "SPREAD", risk_usd: 4000 },
    { league: "CFB", market: "SPREAD", risk_usd: 4000 },
    { league: "NFL", market: "TOTAL", risk_usd: 2000 },
  ],
};

describe("bookRowsToProfiles", () => {
  const [profile] = bookRowsToProfiles([row]);

  test("uses the book identity, not the sample id", () => {
    expect(profile?.id).toBe("SYNTH_SYN_01");
    expect(profile?.agentId).toBe("SYNTH_AGENT_01");
    expect(profile?.masterAgent).toBe("SYNTH_MASTER_01");
  });

  test("derives the score, CLV and tier from the book", () => {
    expect(profile?.score).toBeCloseTo(8.15, 5);
    expect(profile?.clvScore).toBeCloseTo(0.4, 5);
    expect(profile?.tier).toBe("TIER_2_STEAM_SYNDICATE");
    expect(profile?.action).toBe("ALERT_OPERATOR");
  });

  test("derives sizing from the ticket spread", () => {
    expect(profile?.meanStake).toBeCloseTo(3333.333, 2);
    expect(profile?.sizingStrategy).toBe("PROPORTIONAL_KELLY");
    expect(profile?.gini).toBeGreaterThan(0);
  });

  test("specialization comes from the most common league and market", () => {
    expect(profile?.specialization).toBe("CFB SPREAD");
  });

  test("carries the book's limits and net", () => {
    expect(profile?.recommendedLimitUsd).toBe(15000);
    expect(profile?.ltvUsd).toBe(-75000);
    expect(profile?.holdPct).toBe(-15);
  });

  test("sharp_score is a 0-100 value divided by ten", () => {
    // Assert the unit so a row that is already 0-10 cannot silently be divided twice.
    expect(bookRowsToProfiles([row])[0]?.score).toBe(8.15);
  });

  test("empty tickets mark sizing, Gini, VaR and specialization unknown", () => {
    const [empty] = bookRowsToProfiles([{ ...row, recent_tickets: [] }]);
    expect(empty?.meanStake).toBe(0);
    expect(empty?.unknown).toContain("meanStake");
    expect(empty?.unknown).toContain("sizing");
    expect(empty?.unknown).toContain("gini");
    expect(empty?.unknown).toContain("var95");
    expect(empty?.specialization).toBe("STEAM_CHASER");
  });

  test("a missing sharp_score does not produce NaN", () => {
    const bare = { ...row, sharp_score: undefined, recent_tickets: [] };
    const [profile] = bookRowsToProfiles([bare]);
    expect(Number.isNaN(profile?.score)).toBe(false);
    expect(profile?.score).toBe(0);
    expect(profile?.unknown).toContain("sharpness");
  });

  test("a measured zero score is not marked unknown", () => {
    const [zero] = bookRowsToProfiles([{ ...row, sharp_score: 0 }]);
    expect(zero?.score).toBe(0);
    expect(zero?.unknown).not.toContain("sharpness");
  });

  test("a single ticket is its own most common league and market", () => {
    const [single] = bookRowsToProfiles([
      {
        ...row,
        recent_tickets: [{ league: "NBA", market: "TOTAL", risk_usd: 100 }],
      },
    ]);
    expect(single?.specialization).toBe("NBA TOTAL");
    expect(single?.unknown).toContain("gini");
    expect(single?.unknown).toContain("var95");
    expect(single?.unknown).toContain("sizing");
    expect(single?.unknown).not.toContain("meanStake");
    expect(single?.meanStake).toBe(100);
    expect(single?.var95Usd).toBe(0);
    expect(single?.cvar95Usd).toBe(0);
    expect(single?.sizingScore).toBe(0);
    expect(single?.sizingStrategy).toBe("PENDING_TICKETS");
    expect(single?.gini).toBe(0);
  });

  test("zero-risk tickets, single tickets, and missing delay_seconds stay signal-honest", () => {
    const [noTix, zeroTix, oneTix, timedZero] = bookRowsToProfiles([
      { customer_id: "no-tix", sharp_score: 60, recent_tickets: [] },
      {
        customer_id: "zero-tix",
        sharp_score: 60,
        recent_tickets: [{ risk_usd: 0 }, { risk_usd: 0 }],
      },
      {
        customer_id: "one-tix",
        sharp_score: 60,
        recent_tickets: [{ risk_usd: 5 }],
      },
      {
        customer_id: "timed-zero",
        sharp_score: 60,
        delay_seconds: 0,
        recent_tickets: [],
      },
    ]);

    expect(noTix?.sizingScore).toBe(0);
    expect(noTix?.sizingStrategy).toBe("PENDING_TICKETS");
    expect(noTix?.unknown).toContain("delay");

    expect(zeroTix?.meanStake).toBe(0);
    expect(zeroTix?.var95Usd).toBe(0);
    expect(zeroTix?.gini).toBe(0);
    expect(zeroTix?.sizingScore).toBe(0);
    expect(zeroTix?.sizingStrategy).toBe("PENDING_TICKETS");
    expect(zeroTix?.unknown).toEqual(
      expect.arrayContaining(["meanStake", "sizing", "gini", "var95", "delay"]),
    );

    expect(oneTix?.meanStake).toBe(5);
    expect(oneTix?.var95Usd).toBe(0);
    expect(oneTix?.cvar95Usd).toBe(0);
    expect(oneTix?.gini).toBe(0);
    expect(oneTix?.sizingScore).toBe(0);
    expect(oneTix?.sizingStrategy).toBe("PENDING_TICKETS");
    expect(oneTix?.unknown).not.toContain("meanStake");
    expect(oneTix?.unknown).toEqual(
      expect.arrayContaining(["sizing", "gini", "var95", "delay"]),
    );

    expect(timedZero?.timingScore).toBe(0);
    expect(timedZero?.inPlayDelaySec).toBe(0);
    expect(timedZero?.unknown).not.toContain("delay");
  });

  test("a tie keeps the first-seen league", () => {
    const [tie] = bookRowsToProfiles([
      {
        ...row,
        recent_tickets: [
          { league: "CFB", market: "SPREAD", risk_usd: 100 },
          { league: "NFL", market: "TOTAL", risk_usd: 100 },
        ],
      },
    ]);
    expect(tie?.specialization).toBe("CFB SPREAD");
  });

  test("a real-shaped row with unread fields still projects", () => {
    // The abstraction claim: extra fields the mapper does not know are ignored, not fatal.
    const [extra] = bookRowsToProfiles([
      {
        ...row,
        syndicate_probability: 0.42,
        tier: "TIER_1_ELITE_ORIGINATOR",
        notes: "operator",
      },
    ]);
    expect(extra?.id).toBe("SYNTH_SYN_01");
    // A source tier now wins over the derivation; the other unread fields are ignored.
    expect(extra?.tier).toBe("TIER_1_ELITE_ORIGINATOR");
  });

  test("marks fields the book does not carry as none, not a guess", () => {
    expect(profile?.syndicateRisk).toBe("LOW");
    expect(profile?.syndicateProb).toBe(0);
    expect(profile?.correlatedRisk).toBe("NONE");
    expect(profile?.lineShadeCents).toBe(0);
  });
});

describe("selectProfileRows", () => {
  const payload = (
    kind: string,
    book: unknown[] | undefined,
    fixtures: unknown[],
  ) => ({
    book: book as never,
    fixtures: fixtures as never,
    provenance: { kind },
  });

  test("a capture with zero rows stays empty instead of falling back to fixtures", () => {
    expect(
      selectProfileRows(payload("capture", [], [{ customer_id: "SYNTH_X" }])),
    ).toEqual([]);
  });

  test("a capture reads book even when fixtures are present", () => {
    const rows = selectProfileRows(
      payload(
        "capture",
        [{ customer_id: "ML284" }],
        [{ customer_id: "SYNTH_X" }],
      ),
    );
    expect(rows.map((r) => r.id)).toEqual(["ML284"]);
  });

  test("a fixture reads fixtures even when a book is present", () => {
    const rows = selectProfileRows(
      payload(
        "fixture",
        [{ customer_id: "ML284" }],
        [{ customer_id: "SYNTH_X" }],
      ),
    );
    expect(rows.map((r) => r.id)).toEqual(["SYNTH_X"]);
  });

  test("live behaves like capture", () => {
    const rows = selectProfileRows(
      payload("live", [{ customer_id: "HT5009" }], []),
    );
    expect(rows.map((r) => r.id)).toEqual(["HT5009"]);
  });
});

describe("source tier", () => {
  test("wins over the score derivation", () => {
    const [row] = bookRowsToProfiles([
      {
        customer_id: "C1",
        sharp_score: 81.5,
        tier: "TIER_3_SHARP_DISCIPLINED",
      },
    ]);
    expect(row?.tier).toBe("TIER_3_SHARP_DISCIPLINED");
    expect(row?.score).toBe(8.15);
  });

  test("is case-insensitive and falls back on an unknown value", () => {
    const [lower] = bookRowsToProfiles([
      { customer_id: "C1", sharp_score: 81.5, tier: "tier_2_steam_syndicate" },
    ]);
    expect(lower?.tier).toBe("TIER_2_STEAM_SYNDICATE");
    const [bogus] = bookRowsToProfiles([
      { customer_id: "C2", sharp_score: 81.5, tier: "GOLD" },
    ]);
    expect(bogus?.tier).toBe("TIER_2_STEAM_SYNDICATE");
  });
});

describe("backtestRowsToProfiles", () => {
  const backtestRow = {
    customerId: "MJ102",
    agentId: "MJ2026",
    masterAgent: "BILLY666",
    contextType: "EXECUTION_SNIPER",
    ipSubnet: "104.28.34.0/24",
    avgClvBps: 295,
    sharpScore: 91.4,
    totalParlayTickets: 62,
    totalParlayHandleUsd: 310000,
    dominantComboFamily: "NBA_ALT_SPREAD_5000_SUBSET",
  };

  const [profile] = backtestRowsToProfiles([backtestRow]);

  test("derives score, CLV and mean stake from the parlay cohort fields", () => {
    expect(profile?.id).toBe("MJ102");
    expect(profile?.source).toBe("backtest");
    expect(profile?.score).toBe(9.14);
    expect(profile?.clvScore).toBe(2.95);
    expect(profile?.meanStake).toBe(5000);
    expect(profile?.specialization).toBe("NBA_ALT_SPREAD_5000_SUBSET");
    expect(profile?.timingArchetype).toBe("EXECUTION_SNIPER");
  });

  test("lists everything it could not measure instead of rendering zeros", () => {
    expect(profile?.unknown).toEqual(
      expect.arrayContaining([
        "syndicate",
        "correlation",
        "gini",
        "sizing",
        "var95",
        "holdPct",
        "ltv",
        "limit",
        "delay",
        "tickets",
      ]),
    );
  });

  test("marks an unmeasurable sharpness instead of treating it as zero", () => {
    const [bare] = backtestRowsToProfiles([{ customerId: "NO_STATS" }]);
    expect(bare?.score).toBe(0);
    expect(bare?.unknown).toContain("sharpness");
  });
});

describe("mergeProfileRows", () => {
  const [bookRow] = bookRowsToProfiles([row], "fixture");
  const [backtestRow] = backtestRowsToProfiles([
    { customerId: "SYNTH_SYN_01", sharpScore: 40 },
  ]);

  test("dedupes by customer ID and lets the richer first group win", () => {
    const merged = mergeProfileRows(
      bookRow ? [bookRow] : [],
      backtestRow ? [backtestRow] : [],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe("fixture");
    expect(merged[0]?.score).toBe(8.15);
  });

  test("is case-insensitive on the join key", () => {
    const [lower] = backtestRowsToProfiles([{ customerId: "synth_syn_01" }]);
    const merged = mergeProfileRows(
      bookRow ? [bookRow] : [],
      lower ? [lower] : [],
    );
    expect(merged).toHaveLength(1);
  });
});
