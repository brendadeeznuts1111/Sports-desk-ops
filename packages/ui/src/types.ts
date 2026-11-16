import type {
  AgentDetailApiResponse,
  AutomationScheduleSummary,
  AutomationsSnapshot,
  BetTickerApiResponse,
  BetTickerBridge3aSnapshot,
  BetTickerChannelBucket,
  BetTickerTicketRow,
  BetTickerTypeBucket,
  BridgeJobStatusSummary,
  CustomersApiResponse,
  CustomersCohortsSummary,
  Daemon4020State,
  Daemon4020Status,
  DashboardFeedProvenanceKind,
  DashboardSourceProvenance,
  DashboardWsTopic,
  LiveWagersApiResponse,
  R2PipelineApiResponse,
  R2SinkDetail,
  SlabPolicySummary,
  TicketVerificationMode,
  TicketVerificationSummary,
  WagerChannel,
  WagerTier,
  WagersWireContractSummary,
} from "@sportsdesk-ops/contracts";

export type {
  AgentDetailApiResponse,
  AutomationScheduleSummary,
  AutomationsSnapshot,
  BetTickerApiResponse,
  BetTickerBridge3aSnapshot,
  BetTickerChannelBucket,
  BetTickerTicketRow,
  BetTickerTypeBucket,
  BridgeJobStatusSummary,
  CustomersApiResponse,
  CustomersCohortsSummary,
  Daemon4020State,
  Daemon4020Status,
  DashboardFeedProvenanceKind,
  DashboardSourceProvenance,
  DashboardWsTopic,
  LiveWagersApiResponse,
  R2PipelineApiResponse,
  R2SinkDetail,
  SlabPolicySummary,
  TicketVerificationMode,
  TicketVerificationSummary,
  WagersWireContractSummary,
};

export interface DashboardData {
  readonly markdown: string;
  readonly html: string;
  readonly renderDurationMs?: number;
  readonly markdownBytes?: number;
  readonly htmlBytes?: number;
  readonly nonAsciiChars?: number;
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
    readonly errors?: number;
    readonly totalCount?: number;
  };
  readonly hosts?: readonly {
    readonly hostname: string;
    readonly port?: number;
    readonly serviceName?: string;
  }[];
  readonly coreHosts?: readonly {
    readonly hostname: string;
    readonly port?: number;
    readonly serviceName?: string;
  }[];
  readonly updatedAt?: string;
  readonly generatedAt?: string;
}

export interface CustomerPortalReconciliation {
  readonly creditLimitUsd: number;
  readonly currentBalanceUsd: number;
  readonly pendingWagerBalanceUsd: number;
  readonly pendingWagerCount: number;
  readonly availableBalanceUsd: number;
  readonly creditEquationBalanced: boolean;
  readonly carryOverUsd: number;
  readonly previousBalanceUsd: number;
  readonly carryOverParityMatched: boolean;
  readonly carryOverWindow: string;
  readonly postCarryOverWindow: string;
  readonly postCarryOverNetUsd: number;
  readonly net31dUsd: number;
  readonly activeDays31d: number;
  readonly winDays31d: number;
  readonly lossDays31d: number;
  readonly wagerLimitUsd: number;
  readonly settleFigureUsd: number;
  readonly confirmationDelaySec: number;
  readonly wiseLineMovementWeight: number;
  readonly inetTarget: string;
  readonly assignedParlayName: string;
  readonly postureFlags: readonly string[];
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
  readonly portalReconciliation?: CustomerPortalReconciliation | undefined;
  /** Fields the customer book did not carry; set by profile_rows, never guessed. */
  readonly unknown?: readonly string[] | undefined;
  /** Where the row came from; every row the Profiles tab shows is cohort data, not a live book fetch. */
  readonly source?:
    "book" | "fixture" | "backtest" | "rankings" | "live-open" | undefined;
  /** Human tier label when the API carried one (30d rankings). */
  readonly tierLabel?: string | undefined;
  /** Open risk in USD when synthesized from the live wager tape (`?matrix=1` overlay). */
  readonly openRiskUsd?: number | undefined;
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
  readonly ticketWriter?: string | undefined;
  /** Channel family derived from `ticketWriter` (shared vocabulary with ingest). */
  readonly writer?: WagerChannel | undefined;
  readonly sport: string;
  /** League / sub-sport when the source carries it; null when unknown. */
  readonly subSport?: string | null | undefined;
  readonly betType: string;
  readonly event: string;
  readonly selection: string;
  readonly lineDisplay: string;
  readonly oddsAmerican: string;
  readonly riskUsd: number;
  readonly volumeUsd?: number | undefined;
  readonly toWinUsd: number;
  /** Real CLV in cents, or null when no closing-line comparison exists. */
  readonly clvCents: number | null;
  readonly vip?: boolean | undefined;
  readonly alertTier: WagerTier;
  readonly alertBadge: string;
  readonly operatorDirective: string;
  readonly maxRecommendedStake: number;
  readonly autoExecute: false;
}

export interface DashboardAlertRecord {
  readonly deliveryId: string;
  readonly wagerId: string;
  readonly tier: WagerTier;
  readonly status: "queued" | "delivered" | "dead" | "acknowledged";
  readonly payload: {
    readonly customerId: string;
    readonly sport?: string | undefined;
    readonly event?: string | undefined;
    readonly selection?: string | undefined;
    readonly oddsAmerican?: string | undefined;
    readonly amountUsd?: number | undefined;
    readonly clvCents?: number | undefined;
    readonly directive?: string | undefined;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempts?: number | undefined;
  readonly finalError?: string | undefined;
  readonly retriedFrom?: string | undefined;
  readonly acknowledgedBy?: string | undefined;
  readonly acknowledgedNotes?: string | undefined;
  readonly messageId?: number | undefined;
}

export interface HealthData {
  readonly status: "ok" | "warning" | "degraded" | "healthy" | "down";
  readonly operationalStatus?: "ok" | "degraded" | "down" | undefined;
  readonly dataStatus?: "ok" | "stale" | undefined;
  readonly httpStatus?: number | undefined;
  readonly uptimeSeconds: number;
  readonly alerts?:
    | {
        readonly status: "ok" | "warning" | "degraded";
        readonly queued: number;
        readonly delivered: number;
        readonly dead: number;
        readonly backlog: number;
        readonly acknowledged?: number | undefined;
      }
    | undefined;
  readonly degradedReasons?:
    | readonly {
        readonly message: string;
        readonly kind: string;
        readonly severity: string;
        readonly action?: string | undefined;
      }[]
    | undefined;
}

export interface ShiftSummaryData {
  readonly date: string;
  readonly operatorId: string;
  readonly totalAlerts: number;
  readonly deliveredAlerts: number;
  readonly failedAttempts: number;
  readonly deadLetterAlerts: number;
  readonly acknowledgedAlerts: number;
  readonly terminalCommandsCount: number;
  readonly loginEventsCount: number;
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

/**
 * Canonical ordered registry of top-level SportsDesk Dashboard tab identifiers.
 * Single source of truth for URL `?tab=` routing, `dashboard.toml` `panels.default_tab`,
 * keyboard shortcuts, and legacy route aliases.
 */
export const DASHBOARD_TAB_IDS = [
  "customers",
  "shadow",
  "surveillance",
  "terminal",
  "rankings",
  "wagers",
  "bet-ticker",
  "r2",
  "alerts",
] as const;

export type DashboardTabId = (typeof DASHBOARD_TAB_IDS)[number];

export interface DashboardTabSpec {
  readonly id: DashboardTabId;
  readonly label: string;
  readonly icon: string;
  readonly shortcut: string;
  readonly description: string;
  readonly aliases: readonly string[];
}

export const DASHBOARD_TAB_SPECS: Readonly<
  Record<DashboardTabId, DashboardTabSpec>
> = {
  customers: {
    id: "customers",
    label: "Profiles",
    icon: "👥",
    shortcut: "Ctrl+1",
    description: "Sharp originator profiling, sizing Gini & Bayesian skill",
    aliases: ["profiles", "bettors", "customer"],
  },
  surveillance: {
    id: "surveillance",
    label: "Telemetry",
    icon: "📊",
    shortcut: "Ctrl+2",
    description: "Bun.dns cache telemetry, dispatch thresholds & risk brief",
    aliases: ["telemetry", "dns", "overview"],
  },
  terminal: {
    id: "terminal",
    label: "Terminal (PTY)",
    icon: "💻",
    shortcut: "Ctrl+3",
    description: "Native Bun.Terminal interactive operator PTY engine",
    aliases: ["pty", "cli", "console"],
  },
  rankings: {
    id: "rankings",
    label: "Downlines",
    icon: "🏆",
    shortcut: "Ctrl+4",
    description: "30-day sub-agent handle rankings & proxy conduit trees",
    aliases: ["downlines", "agents", "conduits"],
  },
  wagers: {
    id: "wagers",
    label: "Live Wagers",
    icon: "⚡",
    shortcut: "Ctrl+5",
    description: "Real-time incoming wager tape, CLV ramp & slice leaders",
    aliases: ["live-wagers", "tape"],
  },
  "bet-ticker": {
    id: "bet-ticker",
    label: "Bet Ticker",
    icon: "🎟️",
    shortcut: "Ctrl+6",
    description: "Portal bet-ticker wire stream & R2 capture snapshots",
    aliases: ["ticker", "bet_ticker"],
  },
  shadow: {
    id: "shadow",
    label: "Shadow Pricing",
    icon: "⚖️",
    shortcut: "Ctrl+7",
    description: "Counterfactual shadow pricing & slice hold-floor cube",
    aliases: ["shadow-pricing", "slices", "hold-floors"],
  },
  r2: {
    id: "r2",
    label: "R2 Pipeline",
    icon: "☁️",
    shortcut: "Ctrl+8",
    description: "Multi-sink Cloudflare R2 artifact freshness & Last-Modified",
    aliases: ["r2-pipeline", "pipeline", "storage"],
  },
  alerts: {
    id: "alerts",
    label: "DLQ & Alerts",
    icon: "🚨",
    shortcut: "Ctrl+9",
    description: "Operator alert delivery queue, dead-letter retry & acks",
    aliases: ["dlq", "notifications"],
  },
};

const DASHBOARD_TAB_ID_SET: ReadonlySet<string> = new Set(DASHBOARD_TAB_IDS);

const LEGACY_TAB_ALIAS_MAP: Readonly<Record<string, DashboardTabId>> =
  Object.freeze(
    Object.fromEntries(
      DASHBOARD_TAB_IDS.flatMap((id) =>
        DASHBOARD_TAB_SPECS[id].aliases.map((alias) => [alias, id] as const),
      ),
    ),
  );

export function isDashboardTabId(value: unknown): value is DashboardTabId {
  return typeof value === "string" && DASHBOARD_TAB_ID_SET.has(value);
}

/**
 * Resolves a raw `?tab=`, hash slug, or legacy alias to a canonical `DashboardTabId`,
 * falling back to `fallback` (`"customers"` by default) when empty or unknown.
 */
export function resolveDashboardTabId(
  raw: unknown,
  fallback: DashboardTabId = "customers",
): DashboardTabId {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw
    .trim()
    .replace(/^[#/]+/, "")
    .toLowerCase();
  if (!cleaned) return fallback;
  if (isDashboardTabId(cleaned)) return cleaned;
  return LEGACY_TAB_ALIAS_MAP[cleaned] ?? fallback;
}

export const RANKINGS_FILTERS = ["ALL", "CONDUITS", "TIER3", "WHALES"] as const;
export type RankingsFilter = (typeof RANKINGS_FILTERS)[number];

export const TERMINAL_CATEGORIES = [
  "ALL",
  "SHARPS",
  "DOWNLINES",
  "RISK",
  "NET",
] as const;
export type TerminalCategory = (typeof TERMINAL_CATEGORIES)[number];

export const ALERT_FILTERS = [
  "ALL",
  "DEAD",
  "QUEUED",
  "DELIVERED",
  "ACKNOWLEDGED",
] as const;
export type AlertFilter = (typeof ALERT_FILTERS)[number];

export const CUSTOMER_SORT_KEYS = [
  "id",
  "score",
  "gini",
  "var95Usd",
  "holdPct",
] as const;
export type CustomerSortKey = (typeof CUSTOMER_SORT_KEYS)[number];

export const WAGER_SORT_FIELDS = [
  "timestamp",
  "riskUsd",
  "toWinUsd",
  "clvCents",
  "alertTier",
] as const;
export type WagerSortField = (typeof WAGER_SORT_FIELDS)[number];

const WAGER_SORT_FIELD_SET: ReadonlySet<string> = new Set(WAGER_SORT_FIELDS);

export function isWagerSortField(value: unknown): value is WagerSortField {
  return typeof value === "string" && WAGER_SORT_FIELD_SET.has(value);
}

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
  /**
   * True for the seeded welcome buffer, which never executed. A real run can
   * legitimately report `durationMs: 0` (sub-millisecond command), so run
   * statistics must not infer "did not execute" from the duration.
   */
  readonly synthetic?: boolean;
}

export interface TierSwatchStyle {
  readonly fg: string;
  readonly bg: string;
  readonly border: string;
}

export type TierStyleConfig = Readonly<Record<string, TierSwatchStyle>>;
