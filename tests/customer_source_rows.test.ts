import { describe, expect, test } from "bun:test";

import {
  customerRowFromHarvestedProfile,
  customerRowFromLiveWagers,
  liveWagerCustomerId,
  liveWagerRows,
} from "../lib/customer_source_rows.ts";
import { summarizeTickets } from "../lib/customer_profile.ts";

// Shape of the open-wager capture written tonight: a `LIST` envelope, untrimmed logins, dollar
// amounts and a ticket writer, no lifetime aggregates.
const CAPTURE = {
  schemaVersion: 1,
  source: "gslive",
  observedAt: "2026-11-15T06:00:00.000Z",
  partial: false,
  LIST: [
    {
      WagerNumber: 700001,
      AgentID: "AG1",
      CustomerID: "WC8036  ",
      Login: "WC8036",
      AmountWagered: 250,
      ToWinAmount: 200,
      TicketWriter: "Internet",
      ShortDesc: "LAL -4.5",
      InsertDateTime: "2026-11-15T05:59:00.000Z",
    },
    {
      WagerNumber: 700002,
      AgentID: "AG1",
      CustomerID: "WC8036  ",
      AmountWagered: 100,
      ToWinAmount: 90,
      TicketWriter: "Phone",
      ShortDesc: "BOS/LAL o221.5",
      InsertDateTime: "2026-11-15T05:58:00.000Z",
    },
    {
      WagerNumber: 700003,
      AgentID: "AG2",
      CustomerID: "FREDOVIP",
      AmountWagered: 50,
      ToWinAmount: 45,
      ShortDesc: "NYJ +6.5",
    },
  ],
};

// Shape of reports/harvested-live-profiles.json: model-derived fields flagged as such, a null CLV
// when nothing was measured, and sample wagers with a stake and a net but no win amount.
const HARVESTED = {
  id: "ABC700_0",
  canonicalId: "ABC700",
  agentId: "BIGDAD",
  masterAgent: "MASTER1",
  score: 88.4,
  dodSharpScore: 91.2,
  dodClvBps: null,
  holdPct: -3.2,
  ltvUsd: 84738,
  recommendedLimitUsd: 12000,
  sampleWagers: [
    {
      sport: "NBA",
      market: "SPREAD",
      line: "LAL -4.5",
      stakeUsd: 500,
      netUsd: 450,
      time: "2026-11-14T02:00:00.000Z",
    },
    {
      sport: "NFL",
      market: "TOTAL",
      line: "o44.5",
      stakeUsd: 300,
      netUsd: -300,
      time: null,
    },
  ],
};

describe("liveWagerRows", () => {
  test("reads the capture's LIST envelope", () => {
    expect(liveWagerRows(CAPTURE)).toHaveLength(3);
  });

  test("reads a bare array and the older wagers envelope", () => {
    expect(liveWagerRows([{ CustomerID: "A" }])).toHaveLength(1);
    expect(liveWagerRows({ wagers: [{ CustomerID: "A" }] })).toHaveLength(1);
  });

  test("an unrecognized document is empty, not a guessed shape", () => {
    expect(liveWagerRows({ rows: [{ CustomerID: "A" }] })).toEqual([]);
    expect(liveWagerRows(null)).toEqual([]);
  });

  test("matches a login after trimming the capture's padding and ignoring case", () => {
    const [first] = liveWagerRows(CAPTURE);
    expect(liveWagerCustomerId(first!)).toBe("WC8036");
  });
});

describe("customerRowFromLiveWagers", () => {
  test("maps identity and the pending sample without inventing lifetime aggregates", () => {
    const row = customerRowFromLiveWagers(" wc8036 ", liveWagerRows(CAPTURE));
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.customer_id).toBe("WC8036");
    expect(row.provenance).toBe("live-wagers");
    expect(row.agent_id).toBe("AG1");
    expect(row).not.toHaveProperty("lifetime_volume_usd");
    expect(row).not.toHaveProperty("lifetime_net_usd");
    expect(row.recent_tickets).toHaveLength(2);
    expect(row.recent_tickets?.[0]).toEqual({
      wager_number: 700001,
      risk_usd: 250,
      win_usd: 200,
      selection: "LAL -4.5",
      channel: "Internet",
      placed_at: "2026-11-15T05:59:00.000Z",
    });
  });

  test("an idle capture is not a customer record", () => {
    expect(
      customerRowFromLiveWagers("NOPE", liveWagerRows(CAPTURE)),
    ).toBeNull();
    expect(customerRowFromLiveWagers("  ", liveWagerRows(CAPTURE))).toBeNull();
  });
});

describe("customerRowFromHarvestedProfile", () => {
  test("carries measured fields and omits an unmeasured CLV", () => {
    const row = customerRowFromHarvestedProfile(HARVESTED);
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.customer_id).toBe("ABC700_0");
    expect(row.provenance).toBe("harvested-live-profiles");
    expect(row.agent_id).toBe("BIGDAD");
    expect(row.master_agent).toBe("MASTER1");
    expect(row.lifetime_net_usd).toBe(84738);
    expect(row.hold_pct).toBe(-3.2);
    // dodClvBps is null (never measured) and must not become 0.
    expect(row).not.toHaveProperty("clv_bps");
    expect(row.sharp_score).toBe(91.2);
    // The harvester publishes no lifetime volume, so the 10x-of-net guess is gone.
    expect(row).not.toHaveProperty("lifetime_volume_usd");
  });

  test("labels sample wagers from their net instead of a fixed result", () => {
    const row = customerRowFromHarvestedProfile(HARVESTED);
    expect(row?.recent_tickets?.[0]).toEqual({
      league: "NBA",
      market: "SPREAD",
      selection: "LAL -4.5",
      risk_usd: 500,
      net_usd: 450,
      result: "WIN",
      placed_at: "2026-11-14T02:00:00.000Z",
    });
    expect(row?.recent_tickets?.[1]?.result).toBe("LOSS");
    // No ticket id and no win amount exist in the source: they stay absent.
    expect(row?.recent_tickets?.[0]).not.toHaveProperty("wager_number");
    expect(row?.recent_tickets?.[0]).not.toHaveProperty("win_usd");
  });

  test("a measured CLV is carried through", () => {
    const row = customerRowFromHarvestedProfile({
      ...HARVESTED,
      dodClvBps: 999,
    });
    expect(row?.clv_bps).toBe(999);
  });

  test("a profile without an id is not a customer record", () => {
    expect(customerRowFromHarvestedProfile({ ltvUsd: 1 })).toBeNull();
  });
});

describe("summarizeTickets with open tickets", () => {
  test("an unsettled ticket does not count as a settled non-win", () => {
    const summary = summarizeTickets([
      { risk_usd: 100, win_usd: 90, result: "WIN", net_usd: 90 },
      { risk_usd: 50, result: "LOSS", net_usd: -50 },
      { risk_usd: 25, result: "PENDING", net_usd: 0 },
    ]);
    expect(summary.n).toBe(3);
    expect(summary.voids).toBe(0);
    // Two settled outcomes — the open ticket is not counted as a settled non-win.
    expect(summary.winRate).toBe(0.5);
  });
});
