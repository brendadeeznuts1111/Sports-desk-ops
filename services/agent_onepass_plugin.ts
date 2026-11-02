#!/usr/bin/env bun
/**
 * @file agent_onepass_plugin.ts
 * @description Standalone OnePass Plugin for Sportsbook Agents (Bun v1.4+).
 *
 * Implements:
 *  1. Single-pass (O(1)) streaming wager ingestion and risk aggregation grouped by owning AgentId.
 *  2. Real-time agent portfolio scorecard: active vs. dormant bettors, weekly volume, gross hold,
 *     and the agent's 50% shared liability balance.
 *  3. Portfolio Churn Hazard Index: volume-weighted churn probability across the agent's downline.
 *  4. Direct Agent Churn Alerts: routes precursor warnings directly to the owning sub-agent
 *     with immediate dollar exposure calculations and intervention playbooks.
 */

// Brand engine SSOT: lib/brand.ts (a local declaration makes brands module-private).
import type { Brand } from "../lib/brand.ts";
export type { Brand };

export type Cents = Brand<number, "Cents">;
export type CustomerId = Brand<string, "CustomerId">;
export type AgentId = Brand<string, "AgentId">;
export type EpochMs = Brand<number, "EpochMs">;

export type ChurnClassificationMode =
  | "BEATEN_PRICE_EXIT"
  | "FRICTION_EXIT"
  | "VOID_HEAVY_DISGUST"
  | "SHARED_IP_CLUSTER_CHURN"
  | "ACTIVE_RETAINED";

export interface ReconstructedTicketSummary {
  readonly ticketId: string;
  readonly customerId: CustomerId;
  readonly volumeCents: Cents | null;
  readonly wagerNumber: number;
}

export interface AgentPortfolioRiskSnapshot {
  readonly agentId: AgentId;
  readonly masterAgentId: AgentId;
  readonly activeBettorCount: number;
  readonly dormantBettorCount: number;
  readonly atRiskBettorCount: number;
  readonly totalWeeklyVolumeCents: Cents;
  readonly projectedGrossHoldCents: Cents;
  readonly agentLiabilityShareCents: Cents; // 50% split with house
  readonly portfolioChurnHazardIndex: number; // 0.00 to 1.00
  readonly topChurnExposureMode: ChurnClassificationMode;
}

export interface AgentOnePassAlertNotification {
  readonly agentId: AgentId;
  readonly bettorId: CustomerId;
  readonly churnMode: ChurnClassificationMode;
  readonly riskScore: number;
  readonly weeklyVolumeCents: Cents;
  readonly agentWeeklyHoldAtRiskCents: Cents; // 50% share of preserved hold
  readonly rootCauseExplanation: string;
  readonly operationalPlaybook: string;
  readonly timestampEpochMs: EpochMs;
}

export class AgentOnePassPlugin {
  private readonly agentPortfolios: Map<
    AgentId,
    {
      masterAgentId: AgentId;
      activeBettors: Set<CustomerId>;
      dormantBettors: Set<CustomerId>;
      bettorVolumeMap: Map<CustomerId, Cents>;
      bettorRiskMap: Map<CustomerId, number>;
      bettorModeMap: Map<CustomerId, ChurnClassificationMode>;
      totalVolumeCents: number;
      totalGrossHoldCents: number;
    }
  > = new Map();

  private readonly alertSubscribers: ((
    alert: AgentOnePassAlertNotification,
  ) => void)[] = [];
  private readonly liabilityShareRatio: number;

  constructor(liabilityShareRatio: number = 0.5) {
    this.liabilityShareRatio = liabilityShareRatio;
  }

  public registerAlertCallback(
    callback: (alert: AgentOnePassAlertNotification) => void,
  ): void {
    this.alertSubscribers.push(callback);
  }

  public ingestWagerTickOnePass(
    ticket: ReconstructedTicketSummary,
    agentId: AgentId,
    masterAgentId: AgentId = "BILLY666" as AgentId,
  ): void {
    let portfolio = this.agentPortfolios.get(agentId);
    if (!portfolio) {
      portfolio = {
        masterAgentId,
        activeBettors: new Set(),
        dormantBettors: new Set(),
        bettorVolumeMap: new Map(),
        bettorRiskMap: new Map(),
        bettorModeMap: new Map(),
        totalVolumeCents: 0,
        totalGrossHoldCents: 0,
      };
      this.agentPortfolios.set(agentId, portfolio);
    }

    portfolio.activeBettors.add(ticket.customerId);
    portfolio.dormantBettors.delete(ticket.customerId);

    const stakeCents = ticket.volumeCents ?? 0;
    portfolio.totalVolumeCents += stakeCents;
    portfolio.totalGrossHoldCents += Math.round(stakeCents * 0.082);

    const currentBettorVol =
      portfolio.bettorVolumeMap.get(ticket.customerId) ?? (0 as Cents);
    portfolio.bettorVolumeMap.set(
      ticket.customerId,
      (currentBettorVol + stakeCents) as Cents,
    );
  }

  public updateBettorChurnStateOnePass(
    agentId: AgentId,
    customerId: CustomerId,
    riskScore: number,
    mode: ChurnClassificationMode,
    weeklyVolumeCents: Cents,
    rootCause: string,
    playbook: string,
  ): void {
    let portfolio = this.agentPortfolios.get(agentId);
    if (!portfolio) {
      portfolio = {
        masterAgentId: "BILLY666" as AgentId,
        activeBettors: new Set([customerId]),
        dormantBettors: new Set(),
        bettorVolumeMap: new Map([[customerId, weeklyVolumeCents]]),
        bettorRiskMap: new Map(),
        bettorModeMap: new Map(),
        totalVolumeCents: weeklyVolumeCents,
        totalGrossHoldCents: Math.round(weeklyVolumeCents * 0.082),
      };
      this.agentPortfolios.set(agentId, portfolio);
    }

    portfolio.bettorRiskMap.set(customerId, riskScore);
    portfolio.bettorModeMap.set(customerId, mode);

    if (riskScore >= 0.65) {
      const weeklyHoldAtRisk = Math.round(
        weeklyVolumeCents * 0.085 * this.liabilityShareRatio,
      ) as Cents;
      const alert: AgentOnePassAlertNotification = {
        agentId,
        bettorId: customerId,
        churnMode: mode,
        riskScore: Number(riskScore.toFixed(3)),
        weeklyVolumeCents,
        agentWeeklyHoldAtRiskCents: weeklyHoldAtRisk,
        rootCauseExplanation: rootCause,
        operationalPlaybook: playbook,
        timestampEpochMs: Date.now() as EpochMs,
      };

      for (const subscriber of this.alertSubscribers) {
        subscriber(alert);
      }
    }
  }

  public generateAgentPortfolioScorecard(): AgentPortfolioRiskSnapshot[] {
    const snapshots: AgentPortfolioRiskSnapshot[] = [];

    for (const [agentId, portfolio] of this.agentPortfolios.entries()) {
      let weightedRiskSum = 0;
      let totalBettorVol = 0;
      let atRiskCount = 0;
      const modeFrequencies: Record<string, number> = {};

      for (const bettorId of portfolio.activeBettors) {
        const risk = portfolio.bettorRiskMap.get(bettorId) ?? 0.1;
        const vol = portfolio.bettorVolumeMap.get(bettorId) ?? 10000;
        const mode = portfolio.bettorModeMap.get(bettorId) ?? "ACTIVE_RETAINED";

        weightedRiskSum += risk * vol;
        totalBettorVol += vol;

        if (risk >= 0.65) {
          atRiskCount++;
          modeFrequencies[mode] = (modeFrequencies[mode] || 0) + 1;
        }
      }

      const hazardIndex =
        totalBettorVol > 0
          ? Number((weightedRiskSum / totalBettorVol).toFixed(3))
          : 0;
      let topMode: ChurnClassificationMode = "ACTIVE_RETAINED";
      let maxCount = 0;
      for (const [m, count] of Object.entries(modeFrequencies)) {
        if (count > maxCount) {
          maxCount = count;
          topMode = m as ChurnClassificationMode;
        }
      }

      const volCents = Math.round(portfolio.totalVolumeCents) as Cents;
      const grossHoldCents = Math.round(portfolio.totalGrossHoldCents) as Cents;
      const agentLiabilityCents = Math.round(
        portfolio.totalGrossHoldCents * this.liabilityShareRatio,
      ) as Cents;

      snapshots.push({
        agentId,
        masterAgentId: portfolio.masterAgentId,
        activeBettorCount: portfolio.activeBettors.size,
        dormantBettorCount: portfolio.dormantBettors.size,
        atRiskBettorCount: atRiskCount,
        totalWeeklyVolumeCents: volCents,
        projectedGrossHoldCents: grossHoldCents,
        agentLiabilityShareCents: agentLiabilityCents,
        portfolioChurnHazardIndex: hazardIndex,
        topChurnExposureMode: topMode,
      });
    }

    return snapshots;
  }
}
