/**
 * @file examples/feature_flags/risk_engine.ts
 * @description SportsDesk risk evaluation engine demonstrating compile-time feature flags.
 *
 * Uses `feature()` from "bun:bundle" to conditionally compile:
 * - "DEBUG": Inlines verbose payload audits & diagnostic tracing
 * - "EXPERIMENTAL": Activates syndicate correlation heuristic
 * - "ANALYTICS": Emits telemetry performance metrics
 */

import { feature } from "bun:bundle";

export interface Wager {
  readonly ticketId: string;
  readonly customerLogin: string;
  readonly sport: string;
  readonly stake: number;
  readonly odds: number;
  readonly isLive: boolean;
}

export interface RiskAssessment {
  readonly ticketId: string;
  readonly riskScore: number;
  readonly action: "APPROVE" | "REVIEW" | "REJECT";
  readonly flags: readonly string[];
}

export function evaluateWagerRisk(wager: Wager): RiskAssessment {
  const flags: string[] = [];
  let riskScore = 0;

  // Base production scoring: high stake live bets
  if (wager.isLive && wager.stake > 1000) {
    riskScore += 40;
    flags.push("HIGH_STAKE_LIVE");
  }

  // Large payouts (> 10:1 odds with high stake)
  if (wager.odds > 10 && wager.stake > 500) {
    riskScore += 35;
    flags.push("HIGH_ODDS_EXPOSURE");
  }

  // --- Compile-Time Feature: EXPERIMENTAL (Syndicate correlation) ---
  if (feature("EXPERIMENTAL")) {
    // Advanced syndicate heuristic: flag coordinated rapid bets
    if (wager.customerLogin.startsWith("agent_syn_") || wager.stake >= 5000) {
      riskScore += 50;
      flags.push("EXPERIMENTAL_SYNDICATE_SUSPECT");
    }
  }

  // --- Compile-Time Feature: DEBUG (Diagnostics tracing) ---
  if (feature("DEBUG")) {
    console.log(
      `[DEBUG_TRACE] Wager ${wager.ticketId} evaluated for ${wager.customerLogin}: score=${riskScore}`,
    );
  }

  // --- Compile-Time Feature: ANALYTICS (Telemetry sink) ---
  if (feature("ANALYTICS")) {
    // In production privacy builds, this entire branch & string payload is eliminated
    recordTelemetryMetric("wager_evaluated", {
      sport: wager.sport,
      riskScore,
    });
  }

  const action =
    riskScore >= 70 ? "REJECT" : riskScore >= 35 ? "REVIEW" : "APPROVE";

  return {
    ticketId: wager.ticketId,
    riskScore,
    action,
    flags,
  };
}

function recordTelemetryMetric(
  name: string,
  data: Record<string, unknown>,
): void {
  // Mock telemetry hook
  if (feature("DEBUG")) {
    console.log(`[ANALYTICS_EMIT] ${name}:`, JSON.stringify(data));
  }
}
