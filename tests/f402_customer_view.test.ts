import { describe, expect, test } from "bun:test";

import type { IncomingBetRecord } from "../lib/bet_flags.ts";
import {
  customerViewForBet,
  resolveCustomerView,
} from "../lib/f402_customer_view.ts";
import {
  addDaysYmd,
  computeDeskDayStartEpochSeconds,
} from "../lib/gslive_manager_deeplink_sidecar.ts";

const FIXED_TICK = 1793469958152;
const FIXED_DATE = "2026-11-03"; // CST, after the 2026 DST fall-back

function makeBet(
  overrides: Partial<IncomingBetRecord> = {},
): IncomingBetRecord {
  return {
    schemaVersion: 1,
    betKey: "767463594",
    ticketNumber: "",
    wagerNumber: "767463594",
    customerId: "CCC107",
    agentId: "SPEN",
    agentLogin: "SPEN",
    agentLevel: null,
    channel: "GSLIVE",
    wagerType: "S",
    wagerKind: "straight",
    sport: "Basketball",
    league: "NBA",
    subSport: "Winner (2 way)",
    period: "Game",
    rotationNumber: null,
    selection: "Phoenix Suns -132",
    description:
      "Basketball - Phoenix Suns vs Portland Trail Blazers / Game / Winner (2 way)",
    shortDescription:
      "Basketball - Phoenix Suns vs Portland Trail Blazers / Game / Winner (2 way)",
    americanOdds: -132,
    impliedProb: 0.5689,
    line: null,
    stakeUsd: 107,
    toWinUsd: 245.47,
    volumeUsd: 107,
    riskUsd: 107,
    // v3 derived numeric fields (one leg, -132), required by IncomingBetRecord.
    stakeToWinRatio: 107 / 245.47,
    stakePerLeg: 107,
    oddsFromEven: 232,
    isLive: false,
    isVip: false,
    acceptedAt: "2026-11-04T03:38:55.683Z",
    observedAt: "2026-11-05T02:40:00.004Z",
    ageSeconds: 60,
    source: "live-ticker",
    raw: { WagerNumber: 767463594 },
    // v2 depth fields (lib/bet_flags.ts); this fixture only exercises the link builder.
    eventLabel: "Phoenix Suns vs Portland Trail Blazers",
    eventKey: "basketball|phoenix suns vs portland trail blazers",
    marketKey:
      "basketball|phoenix suns vs portland trail blazers|moneyline|game|",
    marketType: "moneyline",
    periodLabel: "Game",
    side: "Phoenix Suns",
    playerName: null,
    isPlayerProp: false,
    isAltLine: false,
    context: null,
    ...overrides,
  };
}

function queryParam(url: string, name: string): string | null {
  const hashQuery = url.split("?")[1] ?? "";
  return new URLSearchParams(hashQuery).get(name);
}

describe("f402 customer view (read-only GSLive Manager links)", () => {
  test("builds the per-ticket bet-history link with partnerUserId, state and betId", () => {
    const result = resolveCustomerView({
      customerId: "ccc107",
      betIds: ["b767463594", "767463595", "767463594"],
      dateYmd: FIXED_DATE,
      state: "canceled",
      windowDays: 2,
      tickEpochMs: FIXED_TICK,
    });

    // Pinned literal: windows end on FIXED_DATE and start windowDays-1 desk days earlier (CST).
    expect(result.links.betHistoryUrl).toBe(
      "https://plive.sportswidgets.pro/manager-tools/#/events/bet-history" +
        "?minVolume=0&maxTimeUntilScore=0" +
        "&from=1793599200&to=1793685600&toTime=86399" +
        "&dateFilterBy=calcTime&t=1793469958152" +
        "&partnerUserId=CCC107&state=canceled" +
        "&betId=767463594%20767463595",
    );
    expect(result.links.betHistoryUrl).toContain("partnerUserId=CCC107");
    expect(result.links.betHistoryUrl).toContain("state=canceled");
    expect(result.links.betHistoryUrl).toContain("betId=767463594");
    expect(result.customerId).toBe("ccc107");
    expect(result.links.gsLivePlayerId).toBe("player_CCC107");
  });

  test("defaults to the all-states single-day window ending on the given desk day", () => {
    const result = resolveCustomerView({
      customerId: "AF12",
      dateYmd: FIXED_DATE,
      tickEpochMs: FIXED_TICK,
    });
    const url = result.links.betHistoryUrl;
    const dayStart = String(computeDeskDayStartEpochSeconds(FIXED_DATE));

    expect(queryParam(url, "from")).toBe(dayStart);
    expect(queryParam(url, "to")).toBe(dayStart);
    expect(queryParam(url, "toTime")).toBe("86399");
    expect(queryParam(url, "dateFilterBy")).toBe("calcTime");
    expect(queryParam(url, "t")).toBe(String(FIXED_TICK));
    expect(queryParam(url, "partnerUserId")).toBe("AF12");
    expect(queryParam(url, "state")).toBeNull();
    expect(queryParam(url, "betId")).toBeNull();
  });

  test("clamps windowDays into the SPA-supported 1..31 desk days", () => {
    const one = resolveCustomerView({
      customerId: "AF12",
      dateYmd: FIXED_DATE,
      windowDays: 0,
      tickEpochMs: FIXED_TICK,
    });
    expect(queryParam(one.links.betHistoryUrl, "from")).toBe(
      queryParam(one.links.betHistoryUrl, "to"),
    );

    const wide = resolveCustomerView({
      customerId: "AF12",
      dateYmd: FIXED_DATE,
      windowDays: 99,
      tickEpochMs: FIXED_TICK,
    });
    const wideFrom = Number(queryParam(wide.links.betHistoryUrl, "from"));
    const wideTo = Number(queryParam(wide.links.betHistoryUrl, "to"));
    expect(wideTo - wideFrom).toBe(
      computeDeskDayStartEpochSeconds(FIXED_DATE) -
        computeDeskDayStartEpochSeconds(addDaysYmd(FIXED_DATE, -30)),
    );
  });

  test("reused report links point at the customer report routes", () => {
    const result = resolveCustomerView({
      customerId: "CCC107",
      dateYmd: FIXED_DATE,
      windowDays: 7,
      tickEpochMs: FIXED_TICK,
    });

    expect(result.links.playerReportUrl).toStartWith(
      "https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true",
    );
    expect(result.links.playerReportUrl).toContain("text=player_CCC107");
    expect(result.links.playerReportUrl).toContain("partnerId=118");
    expect(result.links.playerReportUrl).toContain(
      "from=2026-10-28T05%3A00%3A00.000Z",
    );
    expect(result.links.openBetReportUrl).toStartWith(
      "https://plive.sportswidgets.pro/manager-tools/#/reports/open-bets?",
    );
    expect(result.links.openBetReportUrl).toContain("text=player_CCC107");
  });

  test("refuses an unknown state and a malformed desk day", () => {
    expect(() =>
      resolveCustomerView({
        customerId: "AF12",
        dateYmd: FIXED_DATE,
        state: "settled",
      }),
    ).toThrow(/state must be one of/);
    expect(() =>
      resolveCustomerView({ customerId: "AF12", dateYmd: "2026-13-01" }),
    ).toThrow(/real calendar day/);
    expect(() =>
      resolveCustomerView({ customerId: "AF12", dateYmd: "11/03/2026" }),
    ).toThrow(/YYYY-MM-DD/);
    expect(() => resolveCustomerView({ customerId: "  " })).toThrow(
      /customerId is required/,
    );
  });

  test("reports the missing customer read honestly instead of inventing one", () => {
    const result = resolveCustomerView({
      customerId: "AF12",
      dateYmd: FIXED_DATE,
      tickEpochMs: FIXED_TICK,
    });

    expect(result.ok).toBe(true);
    expect(result.read.available).toBe(false);
    expect(result.read.reason).toBe("customer_read_not_configured");
    expect(result.read.message).toContain("read-only link handoff");
    expect(result.read.message).toContain(
      "made no authenticated customer request",
    );
  });

  test("customerViewForBet scopes the link with the bet's customer and ticket key", () => {
    const result = customerViewForBet(makeBet(), {
      dateYmd: FIXED_DATE,
      windowDays: 1,
    });

    expect(result.customerId).toBe("CCC107");
    expect(result.links.betHistoryUrl).toContain("partnerUserId=CCC107");
    expect(result.links.betHistoryUrl).toContain("betId=767463594");
    expect(queryParam(result.links.betHistoryUrl, "from")).toBe(
      String(computeDeskDayStartEpochSeconds(FIXED_DATE)),
    );

    // A pending/game row carries ticketNumber instead of a ticker betKey; both are deduped.
    const ticketOnly = customerViewForBet(
      makeBet({ betKey: "767461552", ticketNumber: "767461552" }),
      { dateYmd: FIXED_DATE },
    );
    expect(ticketOnly.links.betHistoryUrl).toContain("betId=767461552");
    expect(ticketOnly.links.betHistoryUrl).not.toContain("%20767461552");

    // The CLI's locate --bet resolves state/tick itself and expects them honored.
    const filtered = customerViewForBet(makeBet(), {
      dateYmd: FIXED_DATE,
      state: "win",
      tickEpochMs: FIXED_TICK,
    });
    expect(queryParam(filtered.links.betHistoryUrl, "state")).toBe("win");
    expect(queryParam(filtered.links.betHistoryUrl, "t")).toBe(
      String(FIXED_TICK),
    );
  });

  test("no session secret or bearer value appears in the payload", () => {
    const secret = "session=super-secret-cookie-value";
    const result = resolveCustomerView({
      customerId: "AF12",
      dateYmd: FIXED_DATE,
      tickEpochMs: FIXED_TICK,
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("super-secret-cookie-value");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("cookie");
    expect(serialized).not.toContain("authorization");
  });
});
