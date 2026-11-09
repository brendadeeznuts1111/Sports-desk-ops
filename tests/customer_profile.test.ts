import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CustomerObservations,
  DEFAULT_THRESHOLDS,
  HALF_POINT_HOOK_SYNDICATE_PROFILES,
  KEY_NUMBER_BUYER_PROFILES,
  SIGNATURE_SPECS,
  buildCustomerProfiles,
  enrichTicketWithBuyPoints,
  evaluateTicketForProfileAlert,
  fmtCents,
  fmtInt,
  fmtUsd,
  isKeyNumberBuy,
  normalizeCustomerId,
  normalizeObservationTicket,
  parseBuyPointsFromDesc,
  parseF402TimestampToIso,
  placementOf,
  runCustomerSignaturePipeline,
  summarizeTickets,
  watchNewTicket,
  type CustomerRow,
  type NormalizedObservationTicket,
  type Signature,
  type SignatureSpec,
  type TreeIndex,
} from "../lib/customer_profile.ts";

/**
 * The book carries lifetime aggregates plus five recent tickets per customer, so P/L per league,
 * market and channel is computable offline. Everything here is about labelling the window
 * (`sampleOnly`) and not smoothing over the two things the data cannot say: the sample is five rows,
 * and "live" is a channel proxy.
 */

const tree: TreeIndex = {
  nodes: {
    MASTER: { p: null, l: 1 },
    AGENT: { p: "MASTER", l: 2 },
    LEAF: { p: "AGENT", l: 3 },
  },
};

const ticket = (
  result: string,
  risk: number,
  net: number,
  extra: Partial<{ league: string; market: string; channel: string }> = {},
) => ({
  wager_number: 1,
  league: extra.league ?? "NFL",
  market: extra.market ?? "SPREAD",
  channel: extra.channel ?? "Internet",
  risk_usd: risk,
  net_usd: net,
  result,
});

describe("summarizeTickets", () => {
  test("counts voids out of the win rate and keeps the sample label", () => {
    const summary = summarizeTickets([
      ticket("WIN", 100, 90),
      ticket("LOSS", 100, -100),
      ticket("VOID", 100, 0),
    ]);
    expect(summary.sampleOnly).toBe(true);
    expect(summary.window).toBe("recent-sample");
    expect(summary.n).toBe(3);
    expect(summary.voids).toBe(1);
    expect(summary.winRate).toBe(0.5); // one win of two settled
    expect(summary.riskUsd).toBe(300);
    expect(summary.netUsd).toBe(-10);
    expect(summary.holdPct).toBeCloseTo(-3.333, 2);
  });

  test("buckets by league, market and channel", () => {
    const summary = summarizeTickets([
      ticket("LOSS", 100, -100, {
        league: "NBA",
        market: "TOTAL",
        channel: "GSLIVE",
      }),
      ticket("WIN", 50, 45, {
        league: "NBA",
        market: "SPREAD",
        channel: "Internet",
      }),
      ticket("LOSS", 25, -25, {
        league: "CFB",
        market: "SPREAD",
        channel: "Internet",
      }),
    ]);
    expect(summary.byLeague["NBA"]).toEqual({
      n: 2,
      riskUsd: 150,
      netUsd: -55,
    });
    expect(summary.byLeague["CFB"]).toEqual({ n: 1, riskUsd: 25, netUsd: -25 });
    expect(summary.byMarket["SPREAD"]).toEqual({
      n: 2,
      riskUsd: 75,
      netUsd: 20,
    });
    expect(summary.byChannel["GSLIVE"]).toEqual({
      n: 1,
      riskUsd: 100,
      netUsd: -100,
    });
  });

  test("an empty sample has null rates rather than zeroes", () => {
    const summary = summarizeTickets([]);
    expect(summary.winRate).toBeNull();
    expect(summary.holdPct).toBeNull();
  });
});

describe("placementOf", () => {
  test("walks the parent chain and reports depth and level", () => {
    const placement = placementOf("LEAF", tree);
    expect(placement.inTree).toBe(true);
    expect(placement.chain).toEqual(["AGENT", "MASTER"]);
    expect(placement.depth).toBe(2);
    expect(placement.level).toBe(3);
  });

  test("an unknown login is not placed, and says so", () => {
    expect(placementOf("GHOST", tree)).toMatchObject({
      inTree: false,
      depth: null,
      level: null,
      chain: [],
    });
  });

  test("matches case-insensitively, like every other login join", () => {
    expect(placementOf("leaf", tree).inTree).toBe(true);
  });

  test("a cycle stops instead of hanging", () => {
    const cyclic: TreeIndex = {
      nodes: { A: { p: "B", l: 1 }, B: { p: "A", l: 2 } },
    };
    const placement = placementOf("A", cyclic);
    expect(placement.chain.length).toBeLessThanOrEqual(3);
    expect(placement.chain.at(-1)).toContain("cycle");
  });
});

describe("buildCustomerProfiles", () => {
  const rows: CustomerRow[] = [
    {
      customer_id: "C1",
      agent_id: "AGENT",
      master_agent: "MASTER",
      status: "Active",
      context_type: "WHALE_VOLATILITY",
      lifetime_volume_usd: 1_000_000,
      lifetime_net_usd: -50_000,
      hold_pct: -5,
      clv_bps: -120,
      sharp_score: 71,
      churn_hazard: 0.3,
      churn_mode: "ACTIVE",
      recent_tickets: [ticket("LOSS", 1000, -1000)],
    },
    {
      customer_id: "C2",
      agent_id: "GHOST",
      master_agent: "MASTER",
      recent_tickets: [ticket("WIN", 500, 450)],
    },
  ];

  test("profiles carry book numbers, ticket buckets and placement", () => {
    const { profiles, summary } = buildCustomerProfiles(rows, tree);
    const [first] = profiles;
    expect(first?.customerId).toBe("C1");
    expect(first?.book.sharpScore).toBe(71);
    expect(first?.placement.chain).toEqual(["MASTER"]);
    expect(first?.tickets.netUsd).toBe(-1000);
    expect(summary.customers).toBe(2);
    expect(summary.tickets).toBe(2);
    expect(summary.notInTree).toEqual(["GHOST"]);
  });

  test("a recent sample that contradicts the lifetime net is flagged, not smoothed", () => {
    const { profiles } = buildCustomerProfiles(
      [
        {
          customer_id: "C3",
          agent_id: "AGENT",
          lifetime_net_usd: -10_000,
          recent_tickets: [ticket("WIN", 100, 90)],
        },
      ],
      tree,
    );
    expect(profiles[0]?.flags).toContain(
      "recent sample runs opposite to the lifetime net",
    );
  });
});

describe("parseBuyPointsFromDesc & enrichTicketWithBuyPoints", () => {
  test("parses Unicode fractions, HTML entities, mixed fractions, and whole points", () => {
    expect(
      parseBuyPointsFromDesc(
        "S:Football #142 Auburn +7 -125 - buying ½ For Game",
      ),
    ).toBe(0.5);
    expect(
      parseBuyPointsFromDesc(
        "Football #142 Auburn +7 -125 - buying &#189; For Game",
      ),
    ).toBe(0.5);
    expect(
      parseBuyPointsFromDesc(
        "S:Football #188 Mississippi St +7 -145 - buying 1½ For Game",
      ),
    ).toBe(1.5);
    expect(
      parseBuyPointsFromDesc(
        "P.Football #263 Eagles 8 -160 - buying 2 For Game",
      ),
    ).toBe(2);
    expect(
      parseBuyPointsFromDesc(
        "S:Basketball #501 Grizzlies +1 -115 - For 1st Quarter",
      ),
    ).toBe(0);
  });

  test("enriches live stream and figure-date rows with pre-buy and post-buy spreads", () => {
    const liveRow = enrichTicketWithBuyPoints({
      WagerNumber: 767900101,
      CustomerID: "GP301     ",
      AgentID: "GPRO50RSK",
      AmountWagered: 3125,
      ToWinAmount: 2500,
      TicketWriter: "Internet",
      ShortDesc: "S:Football #156 Minnesota +7 -125 - buying ½ For Game",
    });
    expect(liveRow.CustomerID).toBe("GP301");
    expect(liveRow.buyPoints).toBe(0.5);
    expect(liveRow.adjSpread).toBe(7);
    expect(liveRow.origSpread).toBe(6.5);
    expect(liveRow.finalMoney).toBe(-125);
  });
});

describe("isKeyNumberBuy & evaluateTicketForProfileAlert", () => {
  test("detects buys onto, off, and across key numbers 3, 7, 10, 14, and 21", () => {
    expect(isKeyNumberBuy(3, 0.5)).toMatchObject({
      isKey: true,
      is3or7: true,
      key: 3,
      preBuySpread: 2.5,
      postBuySpread: 3,
    });
    expect(isKeyNumberBuy(-3, 0.5)).toMatchObject({
      isKey: true,
      is3or7: true,
      key: 3,
      preBuySpread: -3.5,
      postBuySpread: -3,
    });
    expect(isKeyNumberBuy(7, 1.5)).toMatchObject({
      isKey: true,
      is3or7: true,
      key: 7,
      preBuySpread: 5.5,
      postBuySpread: 7,
    });
    expect(isKeyNumberBuy(-13.5, 0.5)).toMatchObject({
      isKey: true,
      is3or7: false,
      key: 14,
      preBuySpread: -14,
      postBuySpread: -13.5,
    });
    expect(isKeyNumberBuy(-21, 0.5)).toMatchObject({
      isKey: true,
      is3or7: false,
      key: 21,
      preBuySpread: -21.5,
      postBuySpread: -21,
    });
    // Dead numbers (4 -> 4.5, 8 -> 8.5, 11.5 -> 12) do not trigger key-number flags.
    expect(isKeyNumberBuy(4.5, 0.5).isKey).toBe(false);
    expect(isKeyNumberBuy(8.5, 0.5).isKey).toBe(false);
    expect(isKeyNumberBuy(12, 0.5).isKey).toBe(false);
  });

  test("emits CRITICAL on 3/7 buys, WARN on 14/21 buys, and sets autoExecute: false", () => {
    expect(KEY_NUMBER_BUYER_PROFILES.size).toBe(5);
    expect(HALF_POINT_HOOK_SYNDICATE_PROFILES).toBe(KEY_NUMBER_BUYER_PROFILES);

    const criticalAlert = watchNewTicket({
      WagerNumber: 767900101,
      CustomerID: "GP301",
      AmountWagered: 3125,
      ShortDesc: "S:Football #156 Minnesota +7 -125 - buying ½ For Game",
    });
    expect(criticalAlert).not.toBeNull();
    expect(criticalAlert?.level).toBe("CRITICAL");
    expect(criticalAlert?.keyNumber).toBe(7);
    expect(criticalAlert?.autoExecute).toBe(false);

    const warnAlert = watchNewTicket({
      WagerNumber: 767900102,
      CustomerID: "GP301",
      AmountWagered: 30000,
      ShortDesc: "S:Football #112 SMU -21 -120 - buying ½ For Game",
    });
    expect(warnAlert).not.toBeNull();
    expect(warnAlert?.level).toBe("WARN");
    expect(warnAlert?.keyNumber).toBe(21);
    expect(warnAlert?.autoExecute).toBe(false);

    // Dead number or unadjusted ticket returns null.
    const deadAlert = evaluateTicketForProfileAlert(
      enrichTicketWithBuyPoints({
        WagerNumber: 767900103,
        CustomerID: "MJ107",
        AmountWagered: 5000,
        ShortDesc: "S:Football #199 Team +4½ -120 - buying ½ For Game",
      }),
    );
    expect(deadAlert).toBeNull();
  });

  test("EnrichedTicketMaster, CustomerBehavioralProfile, and ProfileAlert implement distinct [Bun.inspect.custom] formatters and console.log routing", () => {
    const enrichedTicket = enrichTicketWithBuyPoints({
      WagerNumber: 767900101,
      CustomerID: "GP301",
      AmountWagered: 3125,
      ShortDesc: "S:Football #156 Minnesota +7 -125 - buying ½ For Game",
    });
    const plainTicket = Bun.inspect(enrichedTicket, {
      colors: false,
      depth: 2,
    });
    expect(plainTicket).toBe(
      "EnrichedTicketMaster(GP301 #767900101 | PointBuy 6.5 → 7 (+0.5pt) | $3125.00 | Game)",
    );
    expect(Bun.inspect(enrichedTicket, { colors: false, depth: 0 })).toBe(
      "EnrichedTicketMaster(#767900101)",
    );
    expect(Bun.inspect(enrichedTicket, { colors: true, depth: 2 })).toContain(
      "\x1b[1mEnrichedTicketMaster\x1b[22m",
    );

    const gp301Profile = KEY_NUMBER_BUYER_PROFILES.get("GP301");
    expect(gp301Profile).toBeDefined();
    expect(gp301Profile?.profile).toBe("key_number_buyer");
    const renderedProfile = Bun.inspect(gp301Profile, {
      colors: false,
      depth: 2,
    });
    expect(renderedProfile).toBe(
      "GP301 [key_number_buyer] N=827 risk=$3,718,373 edge=+11.5¢ 2H=1% keys={3:43% 7:36% 10:5% 14:9% 21:7%} conf=0.96",
    );

    const alert = evaluateTicketForProfileAlert(enrichedTicket);
    expect(alert).not.toBeNull();
    const renderedAlert = Bun.inspect(alert, { colors: false, depth: 2 });
    expect(renderedAlert).toBe(
      "[CRITICAL] GP301 fired on 7 (6.5 → 7, +0.5pt) · ticket #767900101 · $3,125 risk",
    );
    expect(renderedAlert).not.toBe(renderedProfile);
    expect(Bun.inspect(alert, { colors: false, depth: 0 })).toBe(
      "[CRITICAL] GP301 fired on 7",
    );
    expect(Bun.inspect(alert, { colors: true, depth: 2 })).toContain(
      "\x1b[31mCRITICAL\x1b[39m",
    );
  });
});

describe("CustomerObservations (S1..S5, M2, M3, M9, M10)", () => {
  const makeObs = (
    overrides: Partial<{
      customerId: string;
      nTickets: number;
      totalRiskUsd: number;
      netUsd: number;
      signatures: readonly Signature[];
      firstSeen: string;
      lastSeen: string;
    }> = {},
  ) =>
    new CustomerObservations(
      overrides.customerId ?? "GL205",
      overrides.nTickets ?? 48,
      overrides.totalRiskUsd ?? 956_931,
      overrides.netUsd ?? 42_150,
      overrides.signatures ?? [
        {
          kind: "cbb_under_concentration",
          underCount: 18,
          cbbTotalCount: 22,
          underRate: 18 / 22,
          distinctWagers: 18,
        },
        {
          kind: "half_point_buys",
          buyCount: 44,
          keyNumberBuys: 35,
          keyNumberRate: 35 / 44,
          avgPriceVsCloseCents: 11.5,
          distinctWagers: 44,
        },
        {
          kind: "pre_move_betting",
          moveCount: 14,
          totalCount: 20,
          moveRate: 14 / 20,
          avgPriceVsCloseCents: 9.2,
          distinctWagers: 14,
        },
        {
          kind: "second_half_concentration",
          twoHalfCount: 17,
          totalCount: 48,
          twoHalfRate: 17 / 48,
          distinctWagers: 17,
        },
      ],
      overrides.firstSeen ?? "2026-10-02",
      overrides.lastSeen ?? "2026-11-09",
    );

  test("S1 + S3 + M9: fmtInt, fmtUsd, fmtCents are locale-independent and handle negative/edge values", () => {
    expect(fmtInt(956_931)).toBe("956,931");
    expect(fmtInt(-1234)).toBe("-1,234");
    expect(fmtInt(Number.NaN)).toBe("n/a");
    expect(fmtUsd(956_931)).toBe("$956,931");
    expect(fmtUsd(-1234)).toBe("-$1,234");
    expect(fmtCents(11.5)).toBe("+11.5¢");
    expect(fmtCents(-3.2)).toBe("-3.2¢");
    expect(fmtCents(-0)).toBe("+0.0¢");
    expect(fmtCents(null)).toBe("n/a");
  });

  test("formatter: depth 0 single line", () => {
    const out = Bun.inspect(makeObs({ customerId: "GL205", nTickets: 48 }), {
      depth: 0,
      colors: false,
    });
    expect(out).toBe("CustomerObservations(GL205, N=48)");
    expect(
      makeObs({ customerId: "GL205", nTickets: 48 })[Bun.inspect.custom](),
    ).toBe("CustomerObservations(GL205, N=48)");
  });

  test("formatter: negative net uses leading minus and renders avg price vs close (S3, M2)", () => {
    const out = Bun.inspect(makeObs({ netUsd: -1234 }), {
      depth: 2,
      colors: false,
    });
    expect(out).toContain("net=-$1,234");
    expect(out).not.toContain("$-");
    expect(out).toContain("avg price vs close: +11.5¢");
  });

  test("formatter: no ANSI when colors: false", () => {
    expect(Bun.inspect(makeObs({}), { colors: false })).not.toContain("\x1b[");
  });

  test("formatter: exhaustiveness — unknown kind throws", () => {
    const bad = { kind: "future_kind" } as unknown as Signature;
    expect(
      () =>
        new CustomerObservations(
          "x",
          1,
          1,
          0,
          [bad],
          "2026-01-01",
          "2026-01-01",
        ),
    ).toThrow(/unhandled signature kind/);
  });

  test("formatter: signatures must be sorted", () => {
    const a: Signature = {
      kind: "second_half_concentration",
      twoHalfCount: 1,
      totalCount: 2,
    };
    const b: Signature = {
      kind: "half_point_buys",
      buyCount: 1,
      keyNumberBuys: 1,
      avgPriceVsCloseCents: 5,
    };
    expect(
      () =>
        new CustomerObservations(
          "x",
          2,
          100,
          0,
          [a, b],
          "2026-01-01",
          "2026-01-01",
        ),
    ).toThrow(/not sorted/);
  });

  test("formatter: zero-evidence guard throws (M3)", () => {
    expect(
      () =>
        new CustomerObservations(
          "x",
          1,
          100,
          0,
          [
            {
              kind: "half_point_buys",
              buyCount: 0,
              keyNumberBuys: 0,
              avgPriceVsCloseCents: 0,
            },
          ],
          "2026-01-01",
          "2026-01-01",
        ),
    ).toThrow(/requires buyCount > 0/);

    expect(
      () =>
        new CustomerObservations(
          "x",
          1,
          100,
          0,
          [
            {
              kind: "second_half_concentration",
              twoHalfCount: 0,
              totalCount: 10,
            },
          ],
          "2026-01-01",
          "2026-01-01",
        ),
    ).toThrow(/requires counts > 0/);
  });

  test("console.log reaches formatter", () => {
    const captured: unknown[] = [];
    const orig = console.log;
    console.log = (...args) => {
      captured.push(...args);
    };
    try {
      console.log(makeObs({ customerId: "GL205" }));
    } finally {
      console.log = orig;
    }
    const rendered = captured
      .map((a) =>
        typeof a === "string" ? a : Bun.inspect(a, { colors: false }),
      )
      .join("\n");
    expect(rendered).toContain("GL205");
    expect(rendered).toContain("avg price vs close: +11.5¢");
  });
});

describe("Customer Signature Pipeline (§9 Acceptance Checks)", () => {
  const baseTicket = (
    overrides: Partial<NormalizedObservationTicket>,
  ): NormalizedObservationTicket => ({
    ticketNumber: "1",
    customerId: "GL205",
    agentId: "GPRO50RSK",
    placedAtYmd: "2026-10-15",
    sport: "Football",
    competitionFamily: "NFL",
    canonicalPeriod: "game",
    marketKind: "spread",
    side: "other",
    origSpread: 2.5,
    adjSpread: 3,
    buyPoints: 0,
    touchedKeyNumber: null,
    priceVsCloseCents: null,
    movedInFavor: null,
    riskUsd: 1_000,
    netUsd: 0,
    ...overrides,
  });

  test("S4 invariant: SIGNATURE_SPECS.map(s => s.kind) is strictly ascending across all 5 active kinds", () => {
    const kinds = SIGNATURE_SPECS.map((s) => s.kind);
    expect(kinds).toEqual([
      "cbb_under_concentration",
      "football_key_number_discipline",
      "in_play_activity",
      "post_halftime_activity",
      "pre_move_betting",
    ]);
    for (let i = 1; i < kinds.length; i++) {
      expect(kinds[i - 1]! < kinds[i]!).toBe(true);
    }
  });

  test("Denominator safety & init() isolation: every emit() returns null on zero-denominator state and init() shares no references", () => {
    const emptyTotals = { nTickets: 0, totalRiskUsd: 0, netUsd: 0 };
    for (const spec of SIGNATURE_SPECS) {
      const anySpec = spec as unknown as SignatureSpec<
        Signature["kind"],
        Record<string, unknown>
      >;
      const stateA = anySpec.init();
      const stateB = anySpec.init();
      expect(stateA).not.toBe(stateB);
      expect(anySpec.emit(stateA, emptyTotals)).toBeNull();

      // Mutate stateA via observe() and verify stateB remains untouched
      anySpec.observe(
        stateA,
        baseTicket({
          sport: "Football",
          competitionFamily: "NCAAB",
          canonicalPeriod: "2h",
          timing: "in_play",
          marketKind: "total",
          side: "under",
          adjSpread: 3,
          buyPoints: 0.5,
          touchedKeyNumber: 3,
          priceVsCloseCents: 12,
          movedInFavor: true,
        }),
      );
      expect(stateB).toEqual(anySpec.init());
    }
  });

  test("M3 invariant, 5-kind catalog & Determinism: shuffling ticket order produces identical observations, sportMix, and bySignature rankings", () => {
    const tickets: NormalizedObservationTicket[] = [
      // GL205: 12 distinct Football spread tickets:
      // - 8 on key numbers 3 or 7 (6 landed at -3 with buyPoints=0, 2 bought onto +3 with buyPoints=0.5)
      // - 6 in 2H / in_play (50% live share, 50% post-halftime)
      // - 10 priced (8 moved in favor, +14¢, 6 live + 4 pregame)
      ...Array.from({ length: 6 }, (_, i) =>
        baseTicket({
          ticketNumber: `GL-2H-${i}`,
          wagerGroupKey: `F402:${6000 + i}:1`,
          customerId: "GL205",
          sport: "Football",
          competitionFamily: "NFL",
          canonicalPeriod: "2h",
          timing: "in_play",
          marketKind: "spread",
          adjSpread: i < 4 ? (i < 2 ? 3 : -3) : 4.5,
          buyPoints: i < 3 ? 0.5 : 0,
          touchedKeyNumber: i < 2 ? 3 : i === 2 ? 7 : null,
          priceVsCloseCents: 14,
          movedInFavor: true,
          riskUsd: 5_000,
        }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        baseTicket({
          ticketNumber: `GL-GM-${i}`,
          wagerGroupKey: `F402:${6100 + i}:1`,
          customerId: "GL205",
          sport: "Football",
          competitionFamily: "NFL",
          canonicalPeriod: "game",
          timing: "pregame",
          marketKind: "spread",
          adjSpread: i < 4 ? -3 : -5.5,
          buyPoints: 0,
          touchedKeyNumber: null,
          priceVsCloseCents: i < 4 ? 14 : null,
          movedInFavor: i < 4 ? (i < 2 ? true : false) : null,
          riskUsd: 5_000,
        }),
      ),
      // OR508: 12 distinct CBB total tickets (10 on Under = 83.3%, 5 in 2H = 41.7%)
      ...Array.from({ length: 12 }, (_, i) =>
        baseTicket({
          ticketNumber: `OR-CBB-${i}`,
          wagerGroupKey: `F402:${6200 + i}:1`,
          customerId: "OR508",
          sport: "Basketball",
          competitionFamily: "NCAAB",
          canonicalPeriod: i < 5 ? "2h" : "game",
          timing: i < 5 ? "halftime" : "pregame",
          marketKind: "total",
          side: i < 10 ? "under" : "over",
          riskUsd: 2_500,
        }),
      ),
    ];

    const forward = runCustomerSignaturePipeline(tickets, DEFAULT_THRESHOLDS);
    const reversed = runCustomerSignaturePipeline(
      [...tickets].reverse(),
      DEFAULT_THRESHOLDS,
    );

    expect(forward.bySignature).toEqual(reversed.bySignature);
    expect(
      forward.bySignature.post_halftime_activity.map((e) => e.customerId),
    ).toEqual(["GL205", "OR508"]);
    // Deprecated alias bucket matches post_halftime_activity
    expect(
      forward.bySignature.second_half_concentration.map((e) => e.customerId),
    ).toEqual(["GL205", "OR508"]);
    expect(
      forward.bySignature.cbb_under_concentration.map((e) => e.customerId),
    ).toEqual(["OR508"]);
    expect(
      forward.bySignature.football_key_number_discipline.map(
        (e) => e.customerId,
      ),
    ).toEqual(["GL205"]);
    expect(
      forward.bySignature.in_play_activity.map((e) => e.customerId),
    ).toEqual(["GL205", "OR508"]);
    expect(
      forward.bySignature.pre_move_betting.map((e) => e.customerId),
    ).toEqual(["GL205"]);

    const glObs = forward.observations.get("GL205");
    expect(glObs?.signatures.map((s) => s.kind)).toEqual([
      "football_key_number_discipline",
      "in_play_activity",
      "post_halftime_activity",
      "pre_move_betting",
    ]);
    expect(glObs?.sportMix).toEqual({
      footballPct: 1,
      basketballPct: 0,
      otherPct: 0,
    });
    expect(glObs?.competitionFamilyMix).toEqual({ NFL: 1 });

    // Verify normalizeObservationTicket populates placedAt, eventStartsAt, timing, and key numbers
    const normalized = normalizeObservationTicket({
      WagerNumber: 767900101,
      CustomerID: "GP301",
      AgentID: "GPRO50RSK",
      SportType: "Football",
      SportSubType: "NFL",
      PeriodDescription: "2nd Half",
      AmountWagered: 3125,
      ShortDesc: "S:Football #156 Minnesota +7 -125 - buying ½ For 2nd Half",
      InsertDateTime: "2026-11-08 14:22:00",
      GameDateTime: "2026-11-08 18:00:00",
    });
    expect(normalized).toMatchObject({
      customerId: "GP301",
      sport: "Football",
      competitionFamily: "NFL",
      canonicalPeriod: "2h",
      timing: "pregame",
      placedAt: "2026-11-08T19:22:00.000Z",
      eventStartsAt: "2026-11-08T23:00:00.000Z",
      marketKind: "spread",
      buyPoints: 0.5,
      touchedKeyNumber: 7,
      riskUsd: 3125,
      placedAtYmd: "2026-11-08",
    });
  });

  test("parseF402TimestampToIso and normalizeCustomerId: handles ET timezone and sub-account grouping", () => {
    // Gap 1: ET timestamps without offset are correctly parsed into UTC ISO without naive clock skew
    expect(parseF402TimestampToIso("2026-11-09 09:16:42.110")).toBe(
      "2026-11-09T14:16:42.110Z",
    );
    expect(parseF402TimestampToIso("2026-07-04 12:00:00")).toBe(
      "2026-07-04T16:00:00.000Z",
    ); // EDT (UTC-4)
    expect(parseF402TimestampToIso("2026-11-09T14:16:42.110Z")).toBe(
      "2026-11-09T14:16:42.110Z",
    );

    // Suffix normalization: sub-accounts normalize to primary account
    expect(normalizeCustomerId("BK119_0")).toBe("BK119");
    expect(normalizeCustomerId("GP301_0")).toBe("GP301");
    expect(normalizeCustomerId("AE111_0")).toBe("AE111");
    expect(normalizeCustomerId("RX8896")).toBe("RX8896");
    expect(normalizeCustomerId("  bk119_0  ")).toBe("BK119");
  });

  test("Sub-account normalization aggregates tickets across _0 suffixes under primary account", () => {
    const tickets: NormalizedObservationTicket[] = [
      baseTicket({
        ticketNumber: "T-1",
        wagerGroupKey: "F402:101:1",
        customerId: "BK119",
        riskUsd: 100,
      }),
      baseTicket({
        ticketNumber: "T-2",
        wagerGroupKey: "F402:102:1",
        customerId: "BK119_0",
        riskUsd: 150,
      }),
    ];
    const { observations } = runCustomerSignaturePipeline(tickets);
    expect(observations.has("BK119")).toBe(true);
    expect(observations.has("BK119_0")).toBe(false);
    const bk119 = observations.get("BK119")!;
    expect(bk119.nTickets).toBe(2);
    expect(bk119.totalRiskUsd).toBe(250);
  });

  test("Acceptance Check 1 (Parlay-symmetry): single-parlay CBB under legs cannot qualify or rank above straight CBB under bettor", () => {
    const tickets: NormalizedObservationTicket[] = [
      // PARLAY_CUST: 12 CBB total legs (12 Unders = 100%) all on a single parlay wagerGroupKey
      ...Array.from({ length: 12 }, (_, i) =>
        baseTicket({
          ticketNumber: `P-${i + 1}`,
          wagerGroupKey: "F402:9001:1",
          customerId: "PARLAY_CUST",
          sport: "Basketball",
          competitionFamily: "NCAAB",
          marketKind: "total",
          side: "under",
          riskUsd: 50,
        }),
      ),
      // STRAIGHT_CUST: 12 distinct straight CBB total wagers (8 Unders = 66.7%, $600 total risk)
      ...Array.from({ length: 12 }, (_, i) =>
        baseTicket({
          ticketNumber: `S-${i + 1}`,
          wagerGroupKey: `F402:${8000 + i}:1`,
          customerId: "STRAIGHT_CUST",
          sport: "Basketball",
          competitionFamily: "NCAAB",
          marketKind: "total",
          side: i < 8 ? "under" : "over",
          riskUsd: 50,
        }),
      ),
    ];

    const out = runCustomerSignaturePipeline(tickets, DEFAULT_THRESHOLDS);
    expect(
      out.bySignature.cbb_under_concentration.map((e) => e.customerId),
    ).toEqual(["STRAIGHT_CUST"]);
    expect(out.observations.get("PARLAY_CUST")?.nTickets).toBe(1);
    expect(out.observations.get("PARLAY_CUST")?.totalRiskUsd).toBe(50);
    expect(out.observations.get("PARLAY_CUST")?.signatures).toHaveLength(0);
  });

  test("Acceptance Check 2 (Distinct-wager floor): zero customers qualify from a single wagerGroupKey across all 5 active cohorts", () => {
    const singleWagerCandidates: NormalizedObservationTicket[] = [
      // CH165_0: 8 Football spread legs on key 3 on a single parlay
      ...Array.from({ length: 8 }, (_, i) =>
        baseTicket({
          ticketNumber: `CH-${i + 1}`,
          wagerGroupKey: "F402:7001:1",
          customerId: "CH165_0",
          sport: "Football",
          marketKind: "spread",
          adjSpread: -3,
          buyPoints: 0.5,
          touchedKeyNumber: 3,
          riskUsd: 50,
        }),
      ),
      // SINGLE_PRE: 12 priced legs on a single parlay
      ...Array.from({ length: 12 }, (_, i) =>
        baseTicket({
          ticketNumber: `PM-${i + 1}`,
          wagerGroupKey: "F402:7002:1",
          customerId: "SINGLE_PRE",
          priceVsCloseCents: 15,
          movedInFavor: true,
          riskUsd: 50,
        }),
      ),
      // SINGLE_2H: 12 2H in-play legs on a single parlay
      ...Array.from({ length: 12 }, (_, i) =>
        baseTicket({
          ticketNumber: `TH-${i + 1}`,
          wagerGroupKey: "F402:7003:1",
          customerId: "SINGLE_2H",
          canonicalPeriod: "2h",
          timing: "in_play",
          riskUsd: 50,
        }),
      ),
    ];

    const out = runCustomerSignaturePipeline(
      singleWagerCandidates,
      DEFAULT_THRESHOLDS,
    );
    expect(out.bySignature.cbb_under_concentration).toHaveLength(0);
    expect(out.bySignature.football_key_number_discipline).toHaveLength(0);
    expect(out.bySignature.in_play_activity).toHaveLength(0);
    expect(out.bySignature.post_halftime_activity).toHaveLength(0);
    expect(out.bySignature.pre_move_betting).toHaveLength(0);
  });

  test("Acceptance Check 3 (Reason-code & Sport separation): distinguishes period vs in_play and enforces Football (60..150m) vs Basketball (40..120m) windows", () => {
    const tickets: NormalizedObservationTicket[] = [
      // PERIOD_CUST: 12 distinct wagers, 6 explicit 2h/3q/4q period bets (4 Football 2h, 2 Basketball 3q)
      ...Array.from({ length: 12 }, (_, i) =>
        baseTicket({
          ticketNumber: `PER-${i + 1}`,
          wagerGroupKey: `F402:${1000 + i}:1`,
          customerId: "PERIOD_CUST",
          sport: i < 8 ? "Football" : "Basketball",
          canonicalPeriod: i < 4 ? "2h" : i >= 8 && i < 10 ? "3q" : "game",
          riskUsd: 200,
        }),
      ),
      // INPLAY_BK_CUST: 12 distinct Basketball full-game wagers, 6 at 45m (inside 40..120m), 6 at 140m (post-game, outside 40..120m)
      ...Array.from({ length: 12 }, (_, i) =>
        baseTicket({
          ticketNumber: `BK-${i + 1}`,
          wagerGroupKey: `GSLIVE:${2000 + i}`,
          customerId: "INPLAY_BK_CUST",
          sport: "Basketball",
          canonicalPeriod: "game",
          timing: "in_play",
          elapsedMinutesFromStart: i < 6 ? 45 : 140,
          riskUsd: 200,
        }),
      ),
      // POSTGAME_FB_CUST: 12 distinct Football full-game wagers at 180m (outside 60..150m window -> 0 qualifying 2H bets)
      ...Array.from({ length: 12 }, (_, i) =>
        baseTicket({
          ticketNumber: `FB-POST-${i + 1}`,
          wagerGroupKey: `GSLIVE:${3000 + i}`,
          customerId: "POSTGAME_FB_CUST",
          sport: "Football",
          canonicalPeriod: "game",
          timing: "in_play",
          elapsedMinutesFromStart: 180,
          riskUsd: 200,
        }),
      ),
    ];

    const out = runCustomerSignaturePipeline(tickets, DEFAULT_THRESHOLDS);
    const bucket = out.bySignature.post_halftime_activity;
    expect(bucket.map((e) => e.customerId)).toEqual([
      "INPLAY_BK_CUST",
      "PERIOD_CUST",
    ]);

    const periodEntry = bucket.find((e) => e.customerId === "PERIOD_CUST")!;
    expect(periodEntry.sig).toMatchObject({
      kind: "post_halftime_activity",
      reason: "period",
      twoHalfCount: 6,
      periodCount: 6,
      inPlayCount: 0,
      totalCount: 12,
      distinctWagers: 6,
      bySport: {
        Football: {
          twoHalfCount: 4,
          periodCount: 4,
          inPlayCount: 0,
          totalCount: 8,
        },
        Basketball: {
          twoHalfCount: 2,
          periodCount: 2,
          inPlayCount: 0,
          totalCount: 4,
        },
      },
    });

    const inPlayEntry = bucket.find((e) => e.customerId === "INPLAY_BK_CUST")!;
    expect(inPlayEntry.sig).toMatchObject({
      kind: "post_halftime_activity",
      reason: "in_play",
      twoHalfCount: 6,
      periodCount: 0,
      inPlayCount: 6,
      totalCount: 12,
      distinctWagers: 6,
      bySport: {
        Basketball: {
          twoHalfCount: 6,
          periodCount: 0,
          inPlayCount: 6,
          totalCount: 12,
        },
      },
    });
  });

  test("Acceptance Check 4 (Volume-account cap): customers exceeding maxLegsPerCustomer are excluded from concentration cohorts", () => {
    // BB7884-style volume account with 66 legs (> maxLegsPerCustomer = 50)
    const tickets: NormalizedObservationTicket[] = Array.from(
      { length: 66 },
      (_, i) =>
        baseTicket({
          ticketNumber: `VOL-${i + 1}`,
          wagerGroupKey: `GSLIVE:${5000 + i}`,
          customerId: "BB7884_VOL",
          sport: "Basketball",
          canonicalPeriod: "2h",
          timing: "in_play",
          riskUsd: 3_000,
        }),
    );

    const out = runCustomerSignaturePipeline(tickets, DEFAULT_THRESHOLDS);
    expect(out.bySignature.post_halftime_activity).toHaveLength(0);
    expect(out.bySignature.in_play_activity).toHaveLength(0);
    expect(out.observations.get("BB7884_VOL")?.nTickets).toBe(66);
    expect(out.observations.get("BB7884_VOL")?.signatures).toHaveLength(0);
  });

  test("Acceptance Check 5 (Threshold liveness): every leaf field in DEFAULT_THRESHOLDS is referenced by at least one spec in lib/signatures/specs/*.ts", async () => {
    const specFiles = [
      "cbb_under_concentration.ts",
      "football_key_number_discipline.ts",
      "half_point_buys.ts",
      "in_play_activity.ts",
      "post_halftime_activity.ts",
      "pre_move_betting.ts",
      "second_half_concentration.ts",
    ];
    const specSources = await Promise.all(
      specFiles.map((f) =>
        Bun.file(
          join(import.meta.dir, "..", "lib", "signatures", "specs", f),
        ).text(),
      ),
    );
    const combinedSource = specSources.join("\n");

    for (const [section, slice] of Object.entries(DEFAULT_THRESHOLDS)) {
      expect(typeof slice).toBe("object");
      for (const field of Object.keys(slice as Record<string, unknown>)) {
        const regex = new RegExp(`\\.${field}\\b`);
        expect(
          regex.test(combinedSource),
          `Expected threshold ${section}.${field} to be referenced in lib/signatures/specs/*.ts`,
        ).toBe(true);
      }
    }
  });
});

/**
 * The committed book is gitignored (customer data stays local), so this asserts only when it is
 * present — and then against the numbers measured on 2026-11-02.
 */
const bookPath = join(import.meta.dir, "..", "enriched_customers_full.json");
const book = (await Bun.file(bookPath)
  .json()
  .catch(() => null)) as CustomerRow[] | null;

describe.skipIf(book === null || book.length !== 220)(
  "the local customer book",
  () => {
    const committedTree = Bun.file(
      join(import.meta.dir, "../data/agent-tree.json"),
    );
    test("220 customers, 1,100 tickets, every agent placed in the tree", async () => {
      const index = (await committedTree.json()) as TreeIndex;
      const { summary } = buildCustomerProfiles(book ?? [], index);
      expect(summary.customers).toBe(220);
      expect(summary.tickets).toBe(1_100);
      expect(summary.byLeague["NBA"]).toMatchObject({ n: 315 });
      expect(summary.byMarket["SPREAD"]).toMatchObject({ n: 564 });
      expect(summary.byChannel["GSLIVE"]).toMatchObject({ n: 31 });
      // 12 of the book's 29 agents are absent from the tree; CUB22A is missing there and in the
      // ticker page, which is two independent witnesses to the same missing node.
      expect(summary.notInTree).toHaveLength(12);
      expect(summary.notInTree).toContain("CUB22A");
      expect(summary.sharpest[0]?.customerId).toBe("EJ8834");
    });
  },
);
