import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildCustomerProfiles,
  placementOf,
  summarizeTickets,
  type CustomerRow,
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

/**
 * The committed book is gitignored (customer data stays local), so this asserts only when it is
 * present — and then against the numbers measured on 2026-11-02.
 */
const bookPath = join(import.meta.dir, "..", "enriched_customers_full.json");
const book = (await Bun.file(bookPath)
  .json()
  .catch(() => null)) as CustomerRow[] | null;

describe.skipIf(book === null)("the local customer book", () => {
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
});
