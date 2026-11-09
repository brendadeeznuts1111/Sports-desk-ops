import { describe, expect, it } from "bun:test";
import { CustomerObservations } from "../lib/customer_profile.ts";
import {
  batchRateCustomers,
  formatCustomerRatingMarkdown,
  rateCustomerFromObservations,
  rateCustomerFromTickets,
  rateIncomingWager,
  renderCustomerRatingAnsi,
} from "../lib/customer_rating.ts";
import type { EnrichedTicketMaster } from "../lib/f402_figure_date_enricher.ts";
import type {
  FootballKeyNumberDisciplineSignature,
  InPlayActivitySignature,
  NormalizedObservationTicket,
  PreMoveBettingSignature,
} from "../lib/signatures/types.ts";
import {
  DARK_ANSI_THEME,
  MONOCHROME_ANSI_THEME,
} from "../lib/canonical_osc8_links.ts";

describe("Customer Rating Engine", () => {
  it("rates an elite key-number buyer with high score and CRITICAL alert", () => {
    const keySig: FootballKeyNumberDisciplineSignature = {
      kind: "football_key_number_discipline",
      onKey: 45,
      totalSpread: 100,
      onKeyRate: 0.45,
      onKey3: 25,
      onKey7: 20,
      boughtKeyCount: 30,
      atKeyCount: 15,
      distinctWagers: 40,
    };

    const obs = new CustomerObservations(
      "GP301",
      100,
      500000,
      45000,
      [keySig],
      "2026-10-01",
      "2026-11-09",
    );

    const rating = rateCustomerFromObservations(obs);

    expect(rating.customerId).toBe("GP301");
    expect(rating.score).toBeGreaterThanOrEqual(7.0);
    expect(["SHARP", "ELITE_SHARP"]).toContain(rating.tier);
    expect(["HIGH", "CRITICAL"]).toContain(rating.riskLevel);
    expect(rating.primaryArchetype).toBe("key_number_buyer");
    expect(rating.recommendedAction).toBe("ALERT_OPERATOR");
    expect(rating.autoExecute).toBe(false);
    expect(rating.componentScores.keyNumberScore).toBeGreaterThanOrEqual(7.0);
  });

  it("rates an early line mover / steam chaser", () => {
    const steamSig: PreMoveBettingSignature = {
      kind: "pre_move_betting",
      moveCount: 40,
      totalCount: 80,
      moveRate: 0.5,
      avgPriceVsCloseCents: 15,
      liveCount: 5,
      pregameCount: 35,
      distinctWagers: 35,
    };

    const obs = new CustomerObservations(
      "ST100",
      80,
      300000,
      25000,
      [steamSig],
      "2026-10-01",
      "2026-11-09",
    );

    const rating = rateCustomerFromObservations(obs);
    expect(rating.customerId).toBe("ST100");
    expect(rating.primaryArchetype).toBe("early_line_mover");
    expect(rating.componentScores.steamLatencyScore).toBeGreaterThanOrEqual(
      6.0,
    );
  });

  it("rates an in-play execution specialist", () => {
    const inPlaySig: InPlayActivitySignature = {
      kind: "in_play_activity",
      liveCount: 85,
      totalCount: 100,
      liveRate: 0.85,
      liveRiskUsd: 150000,
      totalRiskUsd: 180000,
      dominance: "dominant_in_play",
      distinctWagers: 60,
    };

    const obs = new CustomerObservations(
      "LIVE99",
      100,
      180000,
      12000,
      [inPlaySig],
      "2026-10-01",
      "2026-11-09",
    );

    const rating = rateCustomerFromObservations(obs);
    expect(rating.primaryArchetype).toBe("in_play_specialist");
    expect(rating.componentScores.timingDisciplineScore).toBeGreaterThanOrEqual(
      8.0,
    );
  });

  it("rates a recreational / square customer with negative edge and zero signatures", () => {
    const obs = new CustomerObservations(
      "SQUARE1",
      50,
      5000,
      -2500, // Losing player
      [],
      "2026-10-01",
      "2026-11-09",
    );

    const rating = rateCustomerFromObservations(obs);
    expect(["RECREATIONAL", "SQUARE"]).toContain(rating.tier);
    expect(rating.recommendedAction).toBe("ACCEPT");
    expect(rating.autoExecute).toBe(false);
  });

  it("rateIncomingWager triggers CRITICAL on key-number buys by sharp customers", () => {
    const keySig: FootballKeyNumberDisciplineSignature = {
      kind: "football_key_number_discipline",
      onKey: 40,
      totalSpread: 80,
      onKeyRate: 0.5,
      onKey3: 20,
      onKey7: 20,
      distinctWagers: 30,
    };

    const obs = new CustomerObservations(
      "GP301",
      80,
      200000,
      30000,
      [keySig],
      "2026-10-01",
      "2026-11-09",
    );
    const rating = rateCustomerFromObservations(obs);

    const ticket: EnrichedTicketMaster = {
      TicketNumber: "T-99901",
      WagerNumber: "W-99901",
      CustomerID: "GP301",
      AgentID: "AG1",
      placedAt: "2026-11-09T15:00:00.000Z",
      sportType: "Football",
      sportSubType: "NFL Football",
      periodDescription: "Game",
      marketKind: "spread",
      shortDesc: "Bought 0.5 pts: Dallas Cowboys -3 (-120)",
      ticketWriter: "web",
      amountWageredUsd: 5500,
      toWinAmountUsd: 5000,
      origSpread: -2.5,
      adjSpread: -3.0,
      buyPoints: 0.5,
      finalMoney: -120,
    };

    const ratedWager = rateIncomingWager(ticket, rating);

    expect(ratedWager.type).toBe("RATED_INCOMING_WAGER");
    expect(ratedWager.customerId).toBe("GP301");
    expect(ratedWager.touchesKey).toBe(true);
    expect(ratedWager.touchedKeys).toContain(3);
    expect(ratedWager.level).toBe("CRITICAL");
    expect(ratedWager.flags).toContain("HIGH_STAKE");
    expect(ratedWager.autoExecute).toBe(false);
  });

  it("normalizes sub-accounts across _0 suffixes during rating", () => {
    const tickets: NormalizedObservationTicket[] = [
      {
        ticketNumber: "T-1",
        wagerGroupKey: "G-1",
        customerId: "BK119_0",
        agentId: "AG2",
        placedAtYmd: "2026-11-08",
        sport: "Football",
        competitionFamily: "NFL",
        canonicalPeriod: "game",
        marketKind: "spread",
        side: "home",
        origSpread: -3.5,
        adjSpread: -3.0,
        buyPoints: 0.5,
        touchedKeyNumber: 3,
        priceVsCloseCents: 15,
        movedInFavor: true,
        riskUsd: 1100,
        netUsd: 1000,
      },
      {
        ticketNumber: "T-2",
        wagerGroupKey: "G-2",
        customerId: "BK119",
        agentId: "AG2",
        placedAtYmd: "2026-11-08",
        sport: "Football",
        competitionFamily: "NFL",
        canonicalPeriod: "game",
        marketKind: "spread",
        side: "away",
        origSpread: -7.5,
        adjSpread: -7.0,
        buyPoints: 0.5,
        touchedKeyNumber: 7,
        priceVsCloseCents: 20,
        movedInFavor: true,
        riskUsd: 2200,
        netUsd: 2000,
      },
    ];

    const rating = rateCustomerFromTickets("BK119_0", tickets);
    expect(rating.customerId).toBe("BK119");
    expect(rating.sampleSize).toBe(2);
    expect(rating.totalRiskUsd).toBe(3300);
    expect(rating.netUsd).toBe(3000);
  });

  it("batchRateCustomers ranks leaderboards descending by Sharpness Score", () => {
    const tickets: NormalizedObservationTicket[] = [
      {
        ticketNumber: "T-1",
        wagerGroupKey: "G-1",
        customerId: "SHARP_A",
        agentId: "AG1",
        placedAtYmd: "2026-11-08",
        sport: "Football",
        competitionFamily: "NFL",
        canonicalPeriod: "game",
        marketKind: "spread",
        side: "home",
        origSpread: -3.5,
        adjSpread: -3.0,
        buyPoints: 0.5,
        touchedKeyNumber: 3,
        priceVsCloseCents: 25,
        movedInFavor: true,
        riskUsd: 5000,
        netUsd: 4500,
      },
      {
        ticketNumber: "T-2",
        wagerGroupKey: "G-2",
        customerId: "SQUARE_B",
        agentId: "AG1",
        placedAtYmd: "2026-11-08",
        sport: "Football",
        competitionFamily: "NFL",
        canonicalPeriod: "game",
        marketKind: "spread",
        side: "away",
        origSpread: -10,
        adjSpread: -10,
        buyPoints: 0,
        touchedKeyNumber: 10,
        priceVsCloseCents: -15,
        movedInFavor: false,
        riskUsd: 50,
        netUsd: -55,
      },
    ];

    const leaderboard = batchRateCustomers(tickets);
    expect(leaderboard.length).toBe(2);
    expect(leaderboard[0]!.score).toBeGreaterThan(leaderboard[1]!.score);
  });

  it("formats CustomerRating and RatedIncomingWager with [Bun.inspect.custom] and AnsiTheme", () => {
    const obs = new CustomerObservations(
      "RF2003",
      20,
      40000,
      3500,
      [],
      "2026-10-01",
      "2026-11-09",
    );
    const rating = rateCustomerFromObservations(obs);

    const inspectStr = Bun.inspect(rating, { colors: true, depth: 1 });
    expect(inspectStr).toContain("RF2003");
    expect(inspectStr).toContain("score=");

    const markdown = formatCustomerRatingMarkdown(rating);
    expect(markdown).toContain("RF2003");
    expect(markdown).toContain("Tier");

    const renderedAnsiDark = renderCustomerRatingAnsi(rating, DARK_ANSI_THEME);
    expect(renderedAnsiDark.length).toBeGreaterThan(0);

    const renderedAnsiMono = renderCustomerRatingAnsi(
      rating,
      MONOCHROME_ANSI_THEME,
    );
    expect(renderedAnsiMono.length).toBeGreaterThan(0);
  });
});
