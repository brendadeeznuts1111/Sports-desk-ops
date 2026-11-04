import { describe, expect, test } from "bun:test";

import type { F402TickerRow } from "../lib/f402_ingest.ts";
import {
  MiamiSyndicateClusterTracker,
  planStreamSignalForRow,
  resolveWeightTierForLogin,
} from "../lib/weight_tier_stream_signals.ts";

function row(
  partial: Partial<F402TickerRow> & Pick<F402TickerRow, "login">,
): F402TickerRow {
  return {
    customerId: partial.login,
    agentId: partial.agentId ?? "GOLD22",
    agentLogin: partial.agentLogin ?? partial.agentId ?? "GOLD22",
    ticketWriter: partial.ticketWriter ?? "Internet",
    wagerNumber: partial.wagerNumber ?? "900001",
    ticketNumber: "",
    wagerType: partial.wagerType ?? "S",
    shortDesc:
      partial.shortDesc ??
      "S.\r\nBasketball - Lakers vs Celtics / Game / Point spread / Lakers -2.5 -110",
    insertedAt: partial.insertedAt ?? "2026-11-04T12:00:00",
    vip: "",
    amountWagered: partial.amountWagered ?? 3500,
    toWinAmount: partial.toWinAmount ?? 3182,
    volumeAmount: partial.volumeAmount ?? 3500,
    login: partial.login,
  };
}

describe("weight tier registry", () => {
  test("resolves GX195 to tier 1", () => {
    expect(resolveWeightTierForLogin("gx195")?.id).toBe("tier1_apex_spread_ml");
  });

  test("unknown login yields null plan", () => {
    expect(planStreamSignalForRow(row({ login: "ZZ999" }))).toBeNull();
  });
});

describe("tier 1 apex originators", () => {
  test("WC8406 scout emits pre-shade internal step", () => {
    const emission = planStreamSignalForRow(
      row({ login: "WC8406", wagerType: "S" }),
    );
    expect(emission?.tier).toBe("tier1_apex_spread_ml");
    expect(emission?.internal[0]?.vigCurtainCents).toBe(10);
    expect(emission?.external).toHaveLength(0);
  });

  test("GX195 spread emits line step and dual-venue taker drafts", () => {
    const emission = planStreamSignalForRow(
      row({ login: "GX195", wagerType: "S" }),
    );
    expect(emission?.schemaVersion).toBe(2);
    expect(emission?.internal[0]?.stepPoints).toBe(1);
    expect(emission?.external.map((order) => order.venue).sort()).toEqual([
      "kalshi",
      "polymarket",
    ]);
    expect(emission?.external[0]?.wireDraft.orderType).toBe("FOK");
    expect(emission?.diagnostics.mechanisms.length).toBeGreaterThan(0);
  });

  test("GX195 totals are internal-hold only", () => {
    const emission = planStreamSignalForRow(
      row({ login: "GX195", wagerType: "L" }),
    );
    expect(emission?.external).toHaveLength(0);
    expect(emission?.internal[0]?.note).toContain("Hold");
  });
});

describe("tier 3 probe hammer", () => {
  test("AT811 $200 probe skews maker quotes", () => {
    const emission = planStreamSignalForRow(
      row({ login: "AT811", wagerType: "L", amountWagered: 200 }),
    );
    expect(emission?.external[0]?.role).toBe("maker");
  });

  test("BB5127 hammer triggers taker stage", () => {
    const emission = planStreamSignalForRow(
      row({ login: "BB5127", wagerType: "L", amountWagered: 1260 }),
    );
    expect(emission?.external[0]?.role).toBe("taker");
  });
});

describe("tier 5 miami syndicate cluster", () => {
  test("third wallet on same rotation bumps hedgeMultiplier to 3", () => {
    const tracker = new MiamiSyndicateClusterTracker(120_000);
    const at = "2026-11-04T18:00:00.000Z";
    planStreamSignalForRow(
      row({
        login: "MM800",
        shortDesc:
          "S.\r\nFootball - Chiefs vs Bills / Game / Point spread / Chiefs -3 -110",
      }),
      { emittedAt: at, clusterTracker: tracker },
    );
    planStreamSignalForRow(
      row({
        login: "CB112_1",
        wagerNumber: "900002",
        shortDesc:
          "S.\r\nFootball - Chiefs vs Bills / Game / Point spread / Chiefs -3 -110",
      }),
      { emittedAt: at, clusterTracker: tracker },
    );
    const third = planStreamSignalForRow(
      row({
        login: "SYN404",
        wagerNumber: "900003",
        shortDesc:
          "S.\r\nFootball - Chiefs vs Bills / Game / Point spread / Chiefs -3 -110",
      }),
      { emittedAt: at, clusterTracker: tracker },
    );
    expect(third?.external[0]?.hedgeMultiplier).toBe(3);
  });
});

describe("tier 6 CLV donors", () => {
  test("straight bets nudge line and VIP shield", () => {
    const emission = planStreamSignalForRow(
      row({ login: "ABN18", wagerType: "S" }),
    );
    expect(emission?.manager[0]?.column).toBe("confirmationDelaySeconds");
    expect(emission?.manager[0]?.value).toBe("0");
    expect(emission?.internal[0]?.stepPoints).toBe(0.5);
  });

  test("parlay action only updates VIP shield", () => {
    const emission = planStreamSignalForRow(
      row({ login: "BRT5600", wagerType: "P" }),
    );
    expect(emission?.internal).toHaveLength(0);
    expect(emission?.manager).toHaveLength(1);
  });
});
