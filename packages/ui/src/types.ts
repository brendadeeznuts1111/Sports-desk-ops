import type {
  CustomersApiResponse,
  CustomersCohortsSummary,
  DashboardFeedProvenanceKind,
  DashboardSourceProvenance,
  DashboardWsTopic,
  LiveWagersApiResponse,
  WagerTier,
} from "@sportsdesk-ops/contracts";

export type {
  CustomersApiResponse,
  CustomersCohortsSummary,
  DashboardFeedProvenanceKind,
  DashboardSourceProvenance,
  DashboardWsTopic,
  LiveWagersApiResponse,
};

export interface DashboardData {
  readonly markdown: string;
  readonly html: string;
  readonly updatedAt: string;
}

export interface DnsData {
  readonly success?: boolean;
  readonly telemetry: {
    readonly size: number;
    readonly hitRatePercent: number;
    readonly cacheHitsCompleted: number;
    readonly cacheHitsInflight: number;
    readonly cacheMisses: number;
    readonly defaultTtlSeconds: number;
  };
  readonly hosts?: readonly {
    readonly hostname: string;
    readonly serviceName?: string;
  }[];
  readonly coreHosts?: readonly {
    readonly hostname: string;
    readonly port?: number;
    readonly serviceName?: string;
  }[];
}

export interface ShowcaseCustomer {
  readonly id: string;
  readonly name: string;
  readonly agentId: string;
  readonly masterAgent: string;
  readonly tier:
    | "TIER_1_ELITE_ORIGINATOR"
    | "TIER_2_STEAM_SYNDICATE"
    | "TIER_3_SHARP_DISCIPLINED"
    | "TIER_4_SEMI_SHARP"
    | "TIER_5_RECREATIONAL";
  readonly score: number;
  readonly clvScore: number;
  readonly skillScore: number;
  readonly sizingScore: number;
  readonly sigScore: number;
  readonly timingScore: number;
  readonly sizingStrategy: string;
  readonly gini: number;
  readonly meanStake: number;
  readonly specialization: string;
  readonly timingArchetype: string;
  readonly correlatedRisk: "NONE" | "MODERATE" | "HIGH" | "CRITICAL";
  readonly correlatedExploitRate: number;
  readonly syndicateRisk: "LOW" | "ELEVATED" | "HIGH";
  readonly syndicateProb: number;
  readonly subAccountIndex: number | null;
  readonly var95Usd: number;
  readonly cvar95Usd: number;
  readonly holdPct: number;
  readonly ltvUsd: number;
  readonly recommendedLimitUsd: number;
  readonly inPlayDelaySec: number;
  readonly lineShadeCents: number;
  readonly shadowCopyMultiplier: number;
  readonly action: string;
  readonly ipAddress: string;
}

export interface RankedPlayer30d {
  readonly rank: number;
  readonly id: string;
  readonly agentId: string;
  readonly masterAgent: string;
  readonly handleUsd: number;
  readonly wagers: number;
  readonly gini: number;
  readonly alertRate: number;
  readonly score: number;
  readonly tier: string;
  readonly tierLabel: string;
  readonly dominantSport: string;
  readonly isProxy: boolean;
  readonly limitUsd: number;
}

export interface ProxyConduit30d {
  readonly agentId: string;
  readonly masterAgent: string;
  readonly handleUsd: number;
  readonly wagers: number;
  readonly topCust: string;
  readonly concPct: number;
}

export interface LiveWager {
  readonly ticketId: string;
  readonly timestamp: string;
  readonly customerId: string;
  readonly agentId: string;
  readonly masterAgent: string;
  readonly sport: string;
  readonly betType: string;
  readonly event: string;
  readonly selection: string;
  readonly lineDisplay: string;
  readonly oddsAmerican: string;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  readonly clvCents: number;
  readonly alertTier: WagerTier;
  readonly alertBadge: string;
  readonly operatorDirective: string;
  readonly maxRecommendedStake: number;
  readonly autoExecute: false;
}

export interface DashboardAlertRecord {
  deliveryId: string;
  wagerId: string;
  tier: WagerTier;
  status: "queued" | "delivered" | "dead" | "acknowledged";
  payload: {
    customerId: string;
    sport?: string;
    event?: string;
    selection?: string;
    oddsAmerican?: string;
    amountUsd?: number;
    clvCents?: number;
    directive?: string;
  };
  createdAt: string;
  updatedAt: string;
  attempts?: number;
  finalError?: string;
  retriedFrom?: string;
  acknowledgedBy?: string;
  acknowledgedNotes?: string;
  messageId?: number;
}

export interface HealthData {
  status: "ok" | "warning" | "degraded";
  uptimeSeconds: number;
  alerts?: {
    status: "ok" | "warning" | "degraded";
    queued: number;
    delivered: number;
    dead: number;
    backlog: number;
    acknowledged?: number;
  };
}

export interface ShiftSummaryData {
  date: string;
  operatorId: string;
  totalAlerts: number;
  deliveredAlerts: number;
  failedAttempts: number;
  deadLetterAlerts: number;
  acknowledgedAlerts: number;
  terminalCommandsCount: number;
  loginEventsCount: number;
}

export interface BuildMatrixRow {
  readonly target: string;
  readonly features: readonly string[];
  readonly totalJsBytes: number;
  readonly totalCssBytes: number;
  readonly hasDebugSentinel: boolean;
  readonly hasExperimentalSentinel: boolean;
  readonly hasProdSentinel: boolean;
}

export type DashboardTabId =
  | "surveillance"
  | "customers"
  | "terminal"
  | "rankings"
  | "wagers"
  | "alerts"
  | "shadow";

export type RankingsFilter = "ALL" | "CONDUITS" | "TIER3" | "WHALES";
export type TerminalCategory = "ALL" | "SHARPS" | "DOWNLINES" | "RISK" | "NET";
export type AlertFilter =
  "ALL" | "DEAD" | "QUEUED" | "DELIVERED" | "ACKNOWLEDGED";
export type CustomerSortKey = "id" | "score" | "gini" | "var95Usd" | "holdPct";
export type WagerSortField =
  "timestamp" | "riskUsd" | "toWinUsd" | "clvCents" | "alertTier";

export interface AlertToastState {
  readonly message: string;
  readonly type: "success" | "error" | "info";
}

export interface TerminalHistoryEntry {
  readonly command: string;
  readonly stdout: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timestamp: number;
}

export type TierStyleConfig = Record<
  string,
  { fg: string; bg: string; border: string }
>;
