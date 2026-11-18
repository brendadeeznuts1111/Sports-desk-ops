import { describe, expect, test } from "bun:test";
import {
  americanOddsImpliedProbability,
  buildBookdeskopsWeblogTraceHref,
  buildShadowSliceHrefFromWager,
  buildTicketInspectorPageUrl,
  capUtilizationPct,
  findWagerByTicketParam,
  formatOperatorBrief,
  mapWagerToShadowTaxonomy,
  payoutMultiple,
  ticketQuotedHoldPct,
  wagerMatchesTicketParam,
} from "../packages/ui/src/ticket_inspector.ts";
import { FIXTURE_LIVE_WAGERS } from "./fixtures/dashboard_ui_fixtures.ts";

describe("ticket inspector helpers", () => {
  const nfl = FIXTURE_LIVE_WAGERS[0]!;

  test("maps NFL wager to Football / NFL shadow taxonomy", () => {
    const tax = mapWagerToShadowTaxonomy(nfl);
    expect(tax?.sport).toBe("Football");
    expect(tax?.subSport).toBe("NFL");
    expect(tax?.regime).toBe("live_in_play");
  });

  test("buildShadowSliceHrefFromWager deep links shadow tab", () => {
    const href = buildShadowSliceHrefFromWager(nfl);
    expect(href).toContain("tab=shadow");
    expect(href).toContain("subSport=NFL");
    expect(href).toContain("sport=Football");
    expect(href).toContain("market=");
  });

  test("wager ticket param normalization and lookup", () => {
    expect(wagerMatchesTicketParam(nfl, "W-109281")).toBe(true);
    expect(wagerMatchesTicketParam(nfl, "#W-109281")).toBe(true);
    expect(
      findWagerByTicketParam(FIXTURE_LIVE_WAGERS, "W-109281")?.ticketId,
    ).toBe("W-109281");
  });

  test("buildTicketInspectorPageUrl and bookdeskops trace", () => {
    expect(buildTicketInspectorPageUrl("#W-109281")).toContain("tab=wagers");
    expect(buildTicketInspectorPageUrl("#W-109281")).toContain(
      "ticket=W-109281",
    );
    const trace = buildBookdeskopsWeblogTraceHref(nfl);
    expect(trace).toContain("customer-weblogs");
    expect(trace).toContain("traceTicket=W-109281");
    expect(trace).toContain("login=GP301");
  });

  test("cap utilization, payout multiple, operator brief", () => {
    expect(
      capUtilizationPct(nfl.riskUsd, nfl.maxRecommendedStake),
    ).toBeGreaterThan(0);
    expect(payoutMultiple(nfl.riskUsd, nfl.toWinUsd)).toBeCloseTo(0.91, 2);
    expect(formatOperatorBrief(nfl)).toContain("autoExecute: false");
    expect(formatOperatorBrief(nfl)).toContain("GP301");
  });

  test("american odds implied probability for -110", () => {
    const p = americanOddsImpliedProbability("-110");
    expect(p).not.toBeNull();
    expect(p!).toBeCloseTo(0.5238, 3);
  });

  test("ticketQuotedHoldPct from risk and to-win", () => {
    expect(ticketQuotedHoldPct(5500, 5000)).toBeCloseTo(52.38, 1);
  });
});
