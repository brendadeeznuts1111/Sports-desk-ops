/**
 * @file tests/syndicate_burst_guard.test.ts
 * @description Unit tests for syndicate steam burst detection, quarantine directives, and safety invariants.
 */

import { describe, expect, it } from "bun:test";
import {
  computeCohesionScore,
  evaluateWagersForBursts,
  SyndicateBurstGuardArena,
  type RawWagerInput,
} from "../lib/syndicate_burst_guard.ts";

describe("SyndicateBurstGuardArena", () => {
  it("enforces autoExecute: false across all emitted quarantine directives", () => {
    const wagers: RawWagerInput[] = [
      {
        login: "BOT_A",
        agentId: "AGENT_X",
        amountWageredCents: 150000,
        toWinCents: 136360,
        insertDateTimeIso: "2026-11-09T18:00:10Z",
        wagerType: "S",
        gameId: "GAME_101",
        selection: "CHIEFS -3.5",
        sport: "FOOTBALL",
        period: "FULL",
        isAlert: true,
      },
      {
        login: "BOT_B",
        agentId: "AGENT_Y",
        amountWageredCents: 150000,
        toWinCents: 136360,
        insertDateTimeIso: "2026-11-09T18:00:25Z",
        wagerType: "S",
        gameId: "GAME_101",
        selection: "CHIEFS -3.5",
        sport: "FOOTBALL",
        period: "FULL",
        isAlert: true,
      },
      {
        login: "BOT_C",
        agentId: "AGENT_Z",
        amountWageredCents: 150000,
        toWinCents: 136360,
        insertDateTimeIso: "2026-11-09T18:00:40Z",
        wagerType: "S",
        gameId: "GAME_101",
        selection: "CHIEFS -3.5",
        sport: "FOOTBALL",
        period: "FULL",
        isAlert: true,
      },
    ];

    const report = evaluateWagersForBursts(wagers, {
      windowSeconds: 120,
      minDistinctLogins: 3,
      minWagers: 3,
      cohesionThreshold: 0.6,
    });

    expect(report.activeBurstsDetected).toBe(1);
    expect(report.quarantineDirectivesIssued).toBe(1);

    const directive = report.directives[0]!;
    expect(directive.autoExecute).toBe(false);
    expect(directive.status).toBe("ACTIVE_QUARANTINE");
    expect(directive.recommendedAction).toBe("HOLD_FOR_MANUAL_REVIEW");
    expect(directive.burst.wagerCount).toBe(3);
    expect(directive.burst.distinctLogins).toContain("BOT_A");
    expect(directive.burst.distinctLogins).toContain("BOT_B");
    expect(directive.burst.distinctLogins).toContain("BOT_C");
    expect(directive.burst.totalHandleUsd).toBe(4500);
  });

  it("does not trigger quarantine for single bettor placing multiple bets (no multi-account collusion)", () => {
    const wagers: RawWagerInput[] = [
      {
        login: "SOLO_WHALE",
        agentId: "AGENT_X",
        amountWageredCents: 500000,
        toWinCents: 454500,
        insertDateTimeIso: "2026-11-09T18:00:10Z",
        wagerType: "S",
        gameId: "GAME_200",
        selection: "LAKERS -5.5",
        sport: "BASKETBALL",
        period: "FULL",
      },
      {
        login: "SOLO_WHALE",
        agentId: "AGENT_X",
        amountWageredCents: 500000,
        toWinCents: 454500,
        insertDateTimeIso: "2026-11-09T18:00:20Z",
        wagerType: "S",
        gameId: "GAME_200",
        selection: "LAKERS -5.5",
        sport: "BASKETBALL",
        period: "FULL",
      },
      {
        login: "SOLO_WHALE",
        agentId: "AGENT_X",
        amountWageredCents: 500000,
        toWinCents: 454500,
        insertDateTimeIso: "2026-11-09T18:00:30Z",
        wagerType: "S",
        gameId: "GAME_200",
        selection: "LAKERS -5.5",
        sport: "BASKETBALL",
        period: "FULL",
      },
    ];

    const report = evaluateWagersForBursts(wagers, {
      minDistinctLogins: 3,
    });

    expect(report.activeBurstsDetected).toBe(0);
    expect(report.quarantineDirectivesIssued).toBe(0);
  });

  it("does not trigger quarantine when wagers are widely spaced outside the window", () => {
    const wagers: RawWagerInput[] = [
      {
        login: "USER_1",
        agentId: "AGENT_A",
        amountWageredCents: 200000,
        toWinCents: 180000,
        insertDateTimeIso: "2026-11-09T12:00:00Z",
        wagerType: "S",
        gameId: "GAME_300",
        selection: "CELTICS -4.0",
        sport: "BASKETBALL",
      },
      {
        login: "USER_2",
        agentId: "AGENT_B",
        amountWageredCents: 200000,
        toWinCents: 180000,
        insertDateTimeIso: "2026-11-09T12:30:00Z", // 30 minutes later
        wagerType: "S",
        gameId: "GAME_300",
        selection: "CELTICS -4.0",
        sport: "BASKETBALL",
      },
      {
        login: "USER_3",
        agentId: "AGENT_C",
        amountWageredCents: 200000,
        toWinCents: 180000,
        insertDateTimeIso: "2026-11-09T13:00:00Z", // 60 minutes later
        wagerType: "S",
        gameId: "GAME_300",
        selection: "CELTICS -4.0",
        sport: "BASKETBALL",
      },
    ];

    const report = evaluateWagersForBursts(wagers, { windowSeconds: 120 });
    expect(report.activeBurstsDetected).toBe(0);
  });

  it("triggers PERIOD_HALFTIME_EXPLOIT when burst targets halftime lines", () => {
    const wagers: RawWagerInput[] = [
      {
        login: "SHARP_1",
        agentId: "SUB_1",
        amountWageredCents: 250000,
        toWinCents: 227000,
        insertDateTimeIso: "2026-11-09T19:30:05Z",
        wagerType: "S",
        gameId: "GAME_400",
        selection: "2H EAGLES -2.5",
        sport: "FOOTBALL",
        period: "HALF",
        isAlert: true,
      },
      {
        login: "SHARP_2",
        agentId: "SUB_2",
        amountWageredCents: 250000,
        toWinCents: 227000,
        insertDateTimeIso: "2026-11-09T19:30:15Z",
        wagerType: "S",
        gameId: "GAME_400",
        selection: "2H EAGLES -2.5",
        sport: "FOOTBALL",
        period: "HALF",
        isAlert: true,
      },
      {
        login: "SHARP_3",
        agentId: "SUB_3",
        amountWageredCents: 250000,
        toWinCents: 227000,
        insertDateTimeIso: "2026-11-09T19:30:22Z",
        wagerType: "S",
        gameId: "GAME_400",
        selection: "2H EAGLES -2.5",
        sport: "FOOTBALL",
        period: "HALF",
        isAlert: true,
      },
    ];

    const report = evaluateWagersForBursts(wagers, {
      windowSeconds: 120,
      cohesionThreshold: 0.6,
    });

    expect(report.activeBurstsDetected).toBe(1);
    const directive = report.directives[0]!;
    expect(directive.trigger).toBe("PERIOD_HALFTIME_EXPLOIT");
    expect(directive.recommendedDelaySeconds).toBe(5.0);
    expect(directive.recommendedLineShadeCents).toBe(25);
    expect(directive.autoExecute).toBe(false);
  });

  it("computeCohesionScore assigns high scores to rapid, flat-stake, multi-login bursts", () => {
    const burstWagers: RawWagerInput[] = [
      {
        login: "ACC1",
        agentId: "A",
        amountWageredCents: 200000,
        toWinCents: 180000,
        insertDateTimeIso: "2026-11-09T10:00:01Z",
        wagerType: "S",
        gameId: "G1",
        selection: "S1",
        sport: "FOOTBALL",
        isAlert: true,
      },
      {
        login: "ACC2",
        agentId: "B",
        amountWageredCents: 200000,
        toWinCents: 180000,
        insertDateTimeIso: "2026-11-09T10:00:05Z",
        wagerType: "S",
        gameId: "G1",
        selection: "S1",
        sport: "FOOTBALL",
        isAlert: true,
      },
      {
        login: "ACC3",
        agentId: "C",
        amountWageredCents: 200000,
        toWinCents: 180000,
        insertDateTimeIso: "2026-11-09T10:00:09Z",
        wagerType: "S",
        gameId: "G1",
        selection: "S1",
        sport: "FOOTBALL",
        isAlert: true,
      },
    ];

    const score = computeCohesionScore(burstWagers, 8, 120);
    expect(score).toBeGreaterThan(0.75);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("formats SyndicateBurstGuardArena cleanly via [Bun.inspect.custom]", () => {
    const arena = new SyndicateBurstGuardArena({ windowSeconds: 180 });
    const formatted = Bun.inspect(arena);
    expect(formatted).toContain("SyndicateBurstGuardArena");
    expect(formatted).toContain("180s");
    expect(formatted).toContain("autoExecute: false");
  });
});
