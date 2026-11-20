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
  CustomerRatingApiPayload,
  CustomerRatingApiResponse,
  CustomersApiResponse,
  CustomersCohortsSummary,
  Daemon4020State,
  Daemon4020Status,
  DashboardFeedProvenanceKind,
  DashboardSourceProvenance,
  DashboardWsTopic,
  LiveWagersApiResponse,
  LiveWagersClvSummary,
  R2PipelineApiResponse,
  R2PipelineHistoryApiResponse,
  R2SinkDetail,
  R2SinkHistory,
  R2SinkHistorySample,
  R2SinkSlaStatus,
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
  CustomerRatingApiPayload,
  CustomerRatingApiResponse,
  CustomersApiResponse,
  CustomersCohortsSummary,
  Daemon4020State,
  Daemon4020Status,
  DashboardFeedProvenanceKind,
  DashboardSourceProvenance,
  DashboardWsTopic,
  LiveWagersApiResponse,
  LiveWagersClvSummary,
  R2PipelineApiResponse,
  R2PipelineHistoryApiResponse,
  R2SinkDetail,
  R2SinkHistory,
  R2SinkHistorySample,
  R2SinkSlaStatus,
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
  /** Measured CLV in basis points when present on book, rankings, live-open, or backtest rows. */
  readonly clvBps?: number | null | undefined;
  /** Number of CLV-matched legs behind `clvBps` (from DOD6 spine). */
  readonly clvLegs?: number | undefined;
  /** Open risk in USD when active on the live wager tape. */
  readonly openRiskUsd?: number | undefined;
  /** True when the row came from synthetic demo data (`SYNTH_*`). */
  readonly synthetic?: boolean | undefined;
  /** Latest wager timestamp (`YYYY-MM-DD HH:MM:SS...` or `YYYY-MM-DD`). */
  readonly lastWagerAt?: string | undefined;
  /** Measured wager count when supplied (30d rankings or backtest). */
  readonly totalWagers?: number | undefined;
  /** Rolling 30-day handle in USD (kept separate from lifetime volume). */
  readonly handle30dUsd?: number | undefined;
  /** Formula-computed behavioral signals from 30d JSONL stream + DOD6 spine. */
  readonly keyNumberBuys30d?: number | undefined;
  readonly halfPointBuys30d?: number | undefined;
  readonly halfPointBuyRatePct?: number | undefined;
  readonly seatCount?: number | undefined;
  readonly isKeyNumberBuyer?: boolean | undefined;
  readonly isHalfPointHookBuyer?: boolean | undefined;
  readonly isMultiSeatCluster?: boolean | undefined;
  readonly isProxyConduit?: boolean | undefined;
  readonly sharpCandidateGatePassed?: boolean | undefined;
}

export interface LiveBetsV2SummarySnapshot {
  readonly dataSource: string;
  readonly fallbackUsed: boolean;
  readonly totalGames: number;
  readonly totalPending: number;
  readonly totalWageredCents: number;
  readonly totalToWinCents: number;
  readonly capturedAt: string | null;
  readonly generatedAt: string | null;
}

export interface RankedPlayerScoreComponents {
  readonly clv: number;
  readonly volume: number;
  readonly sizing: number;
  readonly timing: number;
  readonly combo: number;
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
  readonly lastWagerAt?: string | undefined;
  readonly clvBps?: number | null | undefined;
  readonly clvLegs?: number | undefined;
  readonly dodSharpScore?: number | null | undefined;
  readonly lifetimeNetUsd?: number | null | undefined;
  readonly sharpCandidateGatePassed?: boolean | undefined;
  readonly scoreComponents?: RankedPlayerScoreComponents | undefined;
  readonly keyNumberBuys30d?: number | undefined;
  readonly halfPointBuys30d?: number | undefined;
  readonly halfPointBuyRatePct?: number | undefined;
  readonly seatCount?: number | undefined;
  readonly isKeyNumberBuyer?: boolean | undefined;
  readonly isHalfPointHookBuyer?: boolean | undefined;
  readonly isMultiSeatCluster?: boolean | undefined;
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
  /** Customer book-level CLV in basis points (distinct from ticket-level clvCents). */
  readonly customerClvBps?: number | null | undefined;
  /** Customer composite sharp score from book/cohort lookup (0-100). */
  readonly customerSharpScore?: number | null | undefined;
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
  readonly schemaVersion?: number | undefined;
  readonly status: "ok" | "warning" | "degraded" | "healthy" | "down";
  readonly operationalStatus?: "ok" | "degraded" | "down" | undefined;
  readonly dataStatus?: "ok" | "stale" | undefined;
  readonly httpStatus?: number | undefined;
  readonly uptimeSeconds: number;
  readonly build?:
    | {
        readonly bunVersion: string;
        readonly expectedBunVersion: string;
        readonly bunVersionDrift: boolean;
      }
    | undefined;
  readonly runtime?:
    | {
        readonly uptimeSeconds: number;
        readonly rssBytes: number;
        readonly heapUsedBytes: number;
      }
    | undefined;
  readonly server?:
    | {
        readonly port: number | undefined;
        readonly pendingRequests: number;
        readonly pendingWebSockets: number;
        readonly wsBackpressureBytes: number;
      }
    | undefined;
  readonly dependencies?:
    | {
        readonly db: { readonly status: "ok" | "unconfigured" | "error" };
        readonly r2: {
          readonly status: "ok" | "degraded" | "error";
          readonly lastSnapshotAgeMs: number | null;
        };
      }
    | undefined;
  readonly sessions?:
    | {
        readonly active: number;
        readonly purged: number;
      }
    | undefined;
  readonly alerts?:
    | {
        readonly status: "ok" | "warning" | "degraded" | "down";
        readonly queued: number;
        readonly delivered: number;
        readonly dead: number;
        readonly backlog: number;
        readonly acknowledged?: number | undefined;
        readonly oldestQueuedAgeMs?: number | undefined;
        readonly lastDeliveryAt?: string | null | undefined;
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
  readonly gzipJsBytes?: number | undefined;
  readonly inputFileCount?: number | null | undefined;
  readonly bundleHash8?: string | undefined;
  readonly hasDebugSentinel: boolean;
  readonly hasExperimentalSentinel: boolean;
  readonly hasProdSentinel: boolean;
  readonly hasTestSentinel?: boolean | undefined;
  readonly hasAnalyticsSentinel?: boolean | undefined;
}

export interface StaticDirectoryProbeSummary {
  readonly wildcardPath: string;
  readonly dir: string;
  readonly caseInsensitiveHostFs: boolean;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly files: readonly {
    readonly relativePath: string;
    readonly urlPath: string;
    readonly bytes: number;
    readonly contentType: string;
    readonly lastModifiedIso: string | null;
  }[];
  readonly liveCheck: {
    readonly origin: string;
    readonly elapsedMs: number;
    readonly allPassed: boolean;
    readonly etag: string | null;
    readonly contentRange: string | null;
    readonly checks: readonly {
      readonly name: string;
      readonly requestPath: string;
      readonly expectedStatus: number;
      readonly status: number | null;
      readonly ok: boolean;
      readonly detail: string;
    }[];
  } | null;
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
  "assets",
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
    label: "Risk Overview",
    icon: "📊",
    shortcut: "Ctrl+2",
    description:
      "Risk overview, dispatch thresholds, Bun.dns cache telemetry & risk brief",
    aliases: ["risk-overview", "risk", "telemetry", "dns", "overview"],
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
  assets: {
    id: "assets",
    label: "Bun Assets",
    icon: "🖼️",
    shortcut: "Ctrl+0",
    description: "Bun.Image asset attributes for the served dashboard images",
    aliases: ["images", "image-assets", "bun-assets", "image-metadata"],
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
  "clvBps",
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

export type CustomerAccountScope =
  | "ALL_REAL"
  | "ACTIVE_7D"
  | "LIVE_OPEN"
  | "WITH_CLV"
  | "CURATED"
  | "ALL_WITH_SYNTHETIC";

export interface CustomerScopeCounts {
  readonly allReal: number;
  readonly active7d: number;
  readonly liveOpen: number;
  readonly withClv: number;
  readonly curated: number;
  readonly synthetic: number;
}

export type Billy666BranchFilter =
  "ALL" | "NOLAWOLF" | "BILLY667" | "RTEST5" | "SAINTS2009" | "OTHER";

export interface Billy666BranchCounts {
  readonly all: number;
  readonly NOLAWOLF: number;
  readonly BILLY667: number;
  readonly RTEST5: number;
  readonly SAINTS2009: number;
  readonly OTHER: number;
}
