/**
 * @file src/config/wagerTiers.types.ts
 * @description Types for declarative wager tier & surveillance configuration (schema v3).
 */

export type WagerTierKey =
  "ORIGINATOR_HIGH_RISK" | "STEAM_MOVE" | "LATENCY_ARB" | "BASELINE";

export type DeprecatedTierKey =
  "CRITICAL" | "STEAM" | "LATENCY" | "RECREATIONAL";

export interface Tier {
  label: string;
  badge: string;
  priority: number;
  fg: string;
  bg: string;
  border: string;
  minScore: number;
  maxScore?: number;
  action: string;
  reviewSlaSeconds: number;
  cooldownSeconds: number;
  maxStakeUsd: number;
  auditLevel: string;
  channels: string[];
  aggregateChannel?: string;
  aggregateWindowSeconds?: number;
  aggregateMinCount?: number;
  autoActionNotifyThreshold?: number;
  tags: string[];
  /** Backward compatibility property */
  alertTelegram?: boolean;
}

export type WagerTiersMap = Record<string, Tier> & {
  ORIGINATOR_HIGH_RISK: Tier;
  STEAM_MOVE: Tier;
  LATENCY_ARB: Tier;
  BASELINE: Tier;
  CRITICAL: Tier;
  STEAM: Tier;
  LATENCY: Tier;
  RECREATIONAL: Tier;
};

export interface MetaConfig {
  schema_version?: number;
  name: string;
  owner: string;
  channel: string;
  oncall: string;
  validation: {
    enforceMonotonicScores: boolean;
    rejectUnknownTiers: boolean;
    failClosedOnInvalid: boolean;
  };
  taxonomy: {
    customerSharpnessSource: string;
    customerRiskSource: string;
    wagerTierDimension: string;
    compositionRule: string;
    severityOrder: string[];
  };
  deprecatedKeys?: Record<string, string>;
}

export interface SurfaceConfig {
  panel: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  danger?: string;
  warn?: string;
  ok?: string;
  typography?: {
    fontFamily: string;
    monoFamily: string;
    scale: number;
  };
}

export interface SurveillanceScoringConfig {
  weightsOriginator: number;
  weightsSteam: number;
  weightsLatency: number;
  weightsHistorical: number;
  decayHalfLifeHours: number;
}

export interface SurveillanceConfig {
  highRiskThresholdUsd: number;
  clvAlertThresholdCents: number;
  steamTimeWindowSeconds: number;
  inplayDelaySeconds: number;
  velocityWindowSeconds?: number;
  velocityBurstCount?: number;
  maxWagerPerTicketUsd?: number;
  maxWagerPerMinuteUsd?: number;
  correlationWindowSeconds?: number;
  staleLineSeconds?: number;
  minSampleSizeForClv?: number;
  scoring?: SurveillanceScoringConfig;
}

export interface NotificationChannelConfig {
  enabled: boolean;
  endpoint: string;
  parseMode?: string;
  signingSecret?: string;
  severityMap?: string;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
}

export interface OverridesConfig {
  enabled: boolean;
  maxTtlSeconds: number;
  requireReason: boolean;
  requireOperatorId: boolean;
  requireTicketRef?: boolean;
  auditSink?: string;
  whitelist: string[];
}

export interface RateLimitConfig {
  burst: number;
  perSeconds: number;
}

export interface AuditConfig {
  sink: string;
  filePath: string;
  sampleRate: number;
  redactPII: boolean;
}

export interface WagerTiersConfig {
  schema?: string;
  version?: string;
  environment?: string;
  updatedAt?: string | Date;
  timezone?: string;
  meta: MetaConfig;
  surface: SurfaceConfig;
  tiers: WagerTiersMap;
  surveillance: SurveillanceConfig;
  notifications?: Record<string, NotificationChannelConfig>;
  overrides?: OverridesConfig;
  features?: Record<string, boolean>;
  rateLimits?: Record<string, RateLimitConfig>;
  audit?: AuditConfig;
}
