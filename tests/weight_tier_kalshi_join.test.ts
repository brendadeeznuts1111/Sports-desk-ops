import { describe, expect, test } from "bun:test";

import { KalshiClient } from "../lib/kalshi_client.ts";
import type { F402TickerRow } from "../lib/f402_ingest.ts";
import {
  joinKalshiForStreamEmissions,
  watchlistSignalFromF402TickerRow,
} from "../lib/weight_tier_kalshi_join.ts";
import { planStreamSignalForRow } from "../lib/weight_tier_stream_signals.ts";
import { kalshiFixtureFetch } from "./fixtures/kalshi/fixture_fetch.ts";

const NOW = 1_790_000_000_000;

function nbaSpreadRow(): F402TickerRow {
  return {
    login: "GX195",
    customerId: "GX195",
    agentId: "GOLD22",
    agentLogin: "GOLD22",
    ticketWriter: "Internet",
    wagerNumber: "9001",
    ticketNumber: "",
    wagerType: "S",
    shortDesc:
      "S.\r\nBasketball - Atlanta Hawks vs Washington Wizards / Game / Point spread / Atlanta Hawks -4.5 -110",
    insertedAt: "2026-11-04T18:00:00.000Z",
    vip: "",
    amountWagered: 3500,
    toWinAmount: 3182,
    volumeAmount: 3500,
  };
}

describe("watchlistSignalFromF402TickerRow", () => {
  test("maps spread row to NFL/NBA league and fairProb from price", () => {
    const signal = watchlistSignalFromF402TickerRow(
      nbaSpreadRow(),
      "tier1_apex_spread_ml",
      new Date(NOW),
    );
    expect(signal).not.toBeNull();
    expect(signal!.league).toBe("NBA");
    expect(signal!.marketKind).toBe("spread");
    expect(signal!.fairProb).not.toBeNull();
    expect(signal!.provenance.fixture).toBe(false);
  });
});

describe("joinKalshiForStreamEmissions", () => {
  test("joins tier emission with fixture Kalshi transport", async () => {
    const row = nbaSpreadRow();
    const emission = planStreamSignalForRow(row, { resolveMarkets: true });
    expect(emission).not.toBeNull();
    const client = new KalshiClient({
      fetchImpl: kalshiFixtureFetch().fetch,
      now: () => NOW,
    });
    const joined = await joinKalshiForStreamEmissions(
      [{ emission: emission!, row }],
      { client },
    );
    expect(joined.length).toBe(1);
    expect(joined[0]!.kalshiJoin.seriesTicker).toBe("KXNBASPREAD");
    expect(["no_market", "no_fair_price", "actionable"]).toContain(
      joined[0]!.kalshiJoin.verdict,
    );
  });
});
