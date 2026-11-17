/**
 * @file packages/contracts/src/dashboard_hydration.ts
 * @description Browser-safe contracts for dashboard feed provenance, `/api/wagers` & `/api/customers`
 * hydration payloads, and WebSocket topic frame parsing.
 */

import type { WagerTier } from "./wager_tokens.ts";

export const DASHBOARD_WS_TOPICS = [
  "dashboard",
  "live-bets",
  "syndicate-alerts",
  "tiers-updated",
  "proxy-conduits",
  "terminal-logs",
] as const;

export type DashboardWsTopic = (typeof DASHBOARD_WS_TOPICS)[number];

export type DashboardFeedProvenanceKind =
  | "live"
  | "capture"
  | "fixture"
  | "fallback"
  | "showcase"
  | "pending"
  | "unavailable";

export interface DashboardSourceProvenance {
  readonly kind: DashboardFeedProvenanceKind;
  readonly label: string;
  readonly sourcePath: string | null;
  readonly observedAt: string;
}

export interface HydratedWagerRow {
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
  /** Real CLV in cents, or null when no closing-line comparison exists. */
  readonly clvCents: number | null;
  readonly alertTier: WagerTier;
  readonly alertBadge: string;
  readonly operatorDirective: string;
  readonly maxRecommendedStake: number;
  readonly autoExecute: false;
}

/** Validated `config/slab.toml` summary; read-only and path-free. */
export interface SlabPolicySummary {
  readonly schema: string;
  readonly version: string;
  readonly window_bytes: number;
  readonly unsafe_allowed: boolean;
  readonly sentinels: {
    readonly null_clv: number;
    readonly null_customer_handle32: number;
    readonly null_bridge_channel_word32: number;
  };
}

export interface WagersWireViolation {
  readonly field: string;
  readonly kind: "type" | "nullable";
  readonly count: number;
  /** Up to three rendered values, so the violation is actionable without the row. */
  readonly examples: readonly string[];
}

/**
 * Result of checking raw `getBetTicker` rows against the capture-owned wire
 * shape (type + nullability only). `enum_source` travels with it: when the
 * registry says `observed`, an enum difference is a sample boundary and is
 * never counted as a violation.
 */
export interface WagersWireContractSummary {
  readonly ok: boolean;
  readonly registry: string;
  readonly capture: string;
  readonly capture_sha256: string;
  readonly enum_source: string;
  readonly fields_checked: readonly string[];
  /** Rows actually checked (total minus sentinel-noise rows). */
  readonly rows: number;
  /** Rows the host excluded as sentinel noise; surfaced so the exclusion is visible. */
  readonly skipped_rows: number;
  readonly violations: readonly WagersWireViolation[];
  /** Set when the registry/capture could not be read; `ok` is false then. */
  readonly error?: string;
}

export interface LiveWagersApiResponse {
  readonly wagers: ReadonlyArray<HydratedWagerRow | Record<string, unknown>>;
  readonly totalRiskUsd: number;
  readonly totalToWinUsd: number;
  readonly criticalSteamCount: number;
  readonly autoExecute: false;
  readonly timestamp: string;
  readonly provenance: DashboardSourceProvenance;
  /**
   * Wagers-tab policy identity read from `packages/ui/src/config/wagers.toml`
   * at request time. Optional: a host without the UI package serves the feed
   * unstamped. Probe with `jq -r .policy_version`.
   */
  readonly policy_version?: string;
  readonly policy_schema?: string;
  /** Raw-row conformance against `schema/wagers_field_contract.json`, when a host checks it. */
  readonly wire_contract?: WagersWireContractSummary;
  /** Slab policy when the host exposes it. */
  readonly slab_policy?: SlabPolicySummary;
}

export interface CustomersCohortsSummary {
  readonly backtestCount: number;
  readonly keyNumberSharpsCount: number;
  readonly hookSyndicateCount: number;
  readonly fixtureCount: number;
  readonly fullBookSpecCount: number;
  readonly uniqueSurveillanceCount: number;
}

export interface CustomersApiResponse {
  readonly cohorts: CustomersCohortsSummary;
  readonly backtestTop: ReadonlyArray<Record<string, unknown>>;
  /** Full backtest-cohort list (backtestTop is the leaderboard's first 20). */
  readonly backtestAll: ReadonlyArray<Record<string, unknown>>;
  readonly fixtures: ReadonlyArray<Record<string, unknown>>;
  readonly provenance: DashboardSourceProvenance;
}

export type DashboardWsEventName =
  | "reload"
  | "dashboard-updated"
  | "wagers-updated"
  | "tiers-updated"
  | "alerts-updated"
  | "automations-updated";

export interface DashboardWsEventFrame {
  readonly type: "topic-event";
  readonly topic: DashboardWsTopic;
  readonly event: DashboardWsEventName;
  readonly timestamp: string;
}

export type TierStyleMap = Readonly<
  Record<
    string,
    {
      readonly fg: string;
      readonly bg: string;
      readonly border: string;
    }
  >
>;

export type ParsedDashboardWsAction =
  | { readonly kind: "reload" }
  | { readonly kind: "dashboard-updated" }
  | { readonly kind: "wagers-updated" }
  | {
      readonly kind: "tiers-updated";
      readonly tiers?: TierStyleMap | undefined;
    }
  | { readonly kind: "alerts-updated" }
  | { readonly kind: "automations-updated" }
  | { readonly kind: "ack"; readonly ackType: string }
  | { readonly kind: "ignore" };

function parseTierStyleMap(raw: unknown): TierStyleMap | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, { fg: string; bg: string; border: string }> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val !== "object" || val === null) continue;
    const rec = val as Record<string, unknown>;
    if (
      typeof rec.fg === "string" &&
      typeof rec.bg === "string" &&
      typeof rec.border === "string"
    ) {
      out[key] = { fg: rec.fg, bg: rec.bg, border: rec.border };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse plain-string and structured JSON WebSocket frames from `/ws`. */
export function parseDashboardWsSignal(raw: string): ParsedDashboardWsAction {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "ignore" };

  if (trimmed === "reload") return { kind: "reload" };
  if (trimmed === "dashboard-updated") return { kind: "dashboard-updated" };
  if (trimmed === "wagers-updated" || trimmed === "live-bets") {
    return { kind: "wagers-updated" };
  }
  if (trimmed === "tiers-updated") return { kind: "tiers-updated" };
  if (trimmed === "alerts-updated" || trimmed === "syndicate-alerts") {
    return { kind: "alerts-updated" };
  }
  if (trimmed === "automations-updated") {
    return { kind: "automations-updated" };
  }

  if (!trimmed.startsWith("{")) {
    return { kind: "ignore" };
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const type = typeof parsed.type === "string" ? parsed.type : undefined;

    if (
      type === "subscribed" ||
      type === "subscribed-many" ||
      type === "unsubscribed" ||
      type === "subscriptions"
    ) {
      return { kind: "ack", ackType: type };
    }

    if (type === "tiers-updated") {
      return {
        kind: "tiers-updated",
        tiers: parseTierStyleMap(parsed.tiers),
      };
    }

    if (type === "topic-event") {
      const event = typeof parsed.event === "string" ? parsed.event : "";
      const topic = typeof parsed.topic === "string" ? parsed.topic : "";
      if (event === "reload") return { kind: "reload" };
      if (event === "dashboard-updated") return { kind: "dashboard-updated" };
      if (event === "wagers-updated" || topic === "live-bets") {
        return { kind: "wagers-updated" };
      }
      if (event === "tiers-updated" || topic === "tiers-updated") {
        return {
          kind: "tiers-updated",
          tiers: parseTierStyleMap(parsed.tiers),
        };
      }
      if (event === "alerts-updated" || topic === "syndicate-alerts") {
        return { kind: "alerts-updated" };
      }
      if (event === "automations-updated") {
        return { kind: "automations-updated" };
      }
      return { kind: "ignore" };
    }

    const tiers = parseTierStyleMap(parsed.tiers);
    if (tiers) {
      return { kind: "tiers-updated", tiers };
    }
    return { kind: "ignore" };
  } catch {
    // signal-honesty: intentional-ignore-malformed-ws-frame
    return { kind: "ignore" };
  }
}

export type R2SinkState = "fresh" | "stale" | "missing" | "error";

export interface BetTickerChannelBucket {
  readonly writer: string;
  readonly count: number;
  readonly wageredCents: number;
  readonly volumeCents: number;
  readonly toWinCents: number;
  readonly isSentinelNoise: boolean;
}

export interface BetTickerTypeBucket {
  readonly wagerType: string;
  readonly label: string;
  readonly count: number;
  readonly wageredCents: number;
  readonly volumeCents: number;
  readonly toWinCents: number;
}

export interface BetTickerTicketRow {
  readonly wagerNumber: number;
  readonly ticketId: string;
  readonly customerId: string;
  readonly agentId: string;
  readonly masterAgent: string;
  readonly ticketWriter: string;
  readonly writer: string;
  readonly wagerType: string;
  readonly wagerTypeLabel: string;
  readonly amountWageredCents: number;
  readonly volumeAmountCents: number;
  readonly toWinAmountCents: number;
  readonly volumeDiffers: boolean;
  readonly isSentinelNoise: boolean;
  readonly vip: boolean;
  readonly live: boolean;
  readonly insertedAt: string | null;
  readonly legCount: number;
  readonly shortDesc: string;
  readonly sport: string;
  readonly selection: string;
  readonly alertFlags: readonly string[];
}

export interface BetTickerBridge3aSnapshot {
  readonly available: boolean;
  readonly publicUrl: string;
  readonly state: R2SinkState;
  readonly lastModified: string | null;
  readonly ageSeconds: number | null;
  readonly generatedAt: string | null;
  readonly deskDate: string | null;
  readonly deskHour: number | null;
  readonly watermark: string | null;
  readonly rowCount: number;
  readonly ticketCount: number;
  readonly legCount: number;
  readonly alertTwinCount: number;
  readonly orphanCount: number;
  readonly byChannel: Readonly<
    Record<
      string,
      {
        readonly tickets: number;
        readonly legs: number;
        readonly volumeCents: number;
      }
    >
  >;
  readonly byWagerType: Readonly<
    Record<
      string,
      {
        readonly tickets: number;
        readonly legs: number;
        readonly wageredCents: number;
      }
    >
  >;
  readonly error?: string | undefined;
}

export interface BetTickerPendingGamesSummary {
  readonly available: boolean;
  readonly gameCount: number;
  readonly pendingCount: number;
  readonly totalWageredCents: number;
  readonly totalToWinCents: number;
  readonly capturedAt: string | null;
  readonly dataSource: string | null;
  readonly sourcePath: string | null;
}

export interface BetTickerCaptureHealthSummary {
  readonly available: boolean;
  readonly status: string | null;
  readonly capturedAt: string | null;
  readonly ageSeconds: number | null;
  readonly rowCount: number | null;
  readonly sourcePath: string | null;
}

export interface BetTickerApiResponse {
  readonly schemaVersion: 1;
  readonly observedAt: string;
  readonly autoExecute: false;
  readonly provenance: DashboardSourceProvenance;
  readonly localFeed: {
    readonly rawRowCount: number;
    readonly actionableTicketCount: number;
    readonly sentinelNoiseCount: number;
    readonly totalWageredCents: number;
    readonly totalVolumeCents: number;
    readonly totalToWinCents: number;
    readonly volumeDiffersCount: number;
    readonly vipCount: number;
    readonly liveCount: number;
    readonly flagCount: number;
    readonly byRule: Readonly<Record<string, number>>;
    readonly byWriter: readonly BetTickerChannelBucket[];
    readonly byWagerType: readonly BetTickerTypeBucket[];
    readonly tickets: readonly BetTickerTicketRow[];
  };
  readonly bridge3aR2: BetTickerBridge3aSnapshot;
  readonly pendingGames: BetTickerPendingGamesSummary;
  readonly captureHealth: BetTickerCaptureHealthSummary;
}

export type Daemon4020State = "online" | "degraded" | "offline";

export interface Daemon4020Status {
  /** True when :4020 answered /health (2xx or SportsDesk 503 auth-down). */
  readonly online: boolean;
  /** Granular reachability + /health state (`online` | `degraded` | `offline`). */
  readonly state?: Daemon4020State | undefined;
  readonly operationalStatus?: "ok" | "degraded" | "down" | undefined;
  readonly url: string;
  readonly status: number | null;
  readonly latencyMs: number | null;
  readonly checkedAt: string;
  readonly reason?: string | undefined;
}

/** Resolve unified daemon reachability state from structured status fields or legacy flags. */
export function resolveDaemon4020State(
  daemon: Daemon4020Status | null | undefined,
): Daemon4020State | "probing" {
  if (!daemon) return "probing";
  if (daemon.state) return daemon.state;
  if (!daemon.online) return "offline";
  if (
    daemon.status === 503 ||
    daemon.operationalStatus === "down" ||
    daemon.operationalStatus === "degraded"
  ) {
    return "degraded";
  }
  return "online";
}

export interface R2SinkRollupMetric {
  readonly label: string;
  readonly value: string;
}

export type R2SinkBlockerClass =
  | "f402_auth_expired"
  | "gslive_auth_expired"
  | "sanitization_guard"
  | "upstream_capture_stale"
  | "missing_artifact"
  | "network_or_http"
  | "sla_lag";

export interface R2SinkDiagnostic {
  readonly blockerClass: R2SinkBlockerClass;
  readonly headline: string;
  readonly detail: string;
  readonly failedJobIds: readonly string[];
  readonly suggestedCommand: string;
}

export interface R2SinkDetail {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly publicUrl: string;
  readonly resolvedRollupKey: string | null;
  readonly resolvedRollupUrl: string | null;
  readonly slaSeconds: number;
  readonly state: R2SinkState;
  readonly stale: boolean;
  readonly lastModified: string | null;
  readonly ageSeconds: number | null;
  readonly dataAgeSeconds: number | null;
  readonly dataStale: boolean;
  readonly contentLength: number | null;
  readonly sha256: string | null;
  readonly reason: string | null;
  readonly remediationCommand: string;
  readonly bridgeJobIds?: readonly string[] | undefined;
  readonly diagnostic?: R2SinkDiagnostic | undefined;
  readonly metrics: readonly R2SinkRollupMetric[];
}

export type TicketVerificationMode =
  "live" | "fixture" | "dry-run" | "unmeasured";

export interface TicketVerificationSummary {
  readonly schemaVersion: 1;
  readonly available: boolean;
  readonly mode: TicketVerificationMode;
  readonly verifiedAt: string | null;
  readonly sourcePath: string | null;
  readonly totalRows: number;
  readonly actionableTickets: number;
  readonly sentinelNoiseCount: number;
  readonly volumeMismatchCount: number;
  readonly totalWageredCents: number;
  readonly totalVolumeCents: number;
  readonly totalToWinCents: number;
  readonly canaryPassed: boolean;
  readonly clientSealed: boolean;
  readonly f402Status: "ok" | "skipped" | "error";
  readonly r2Status: "ok" | "skipped" | "error";
  readonly r2PublishedKey: string | null;
  readonly error: string | null;
  readonly remediation: string | null;
}

export interface BridgeJobStatusSummary {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly error?: string | undefined;
}

export interface AutomationScheduleSummary {
  readonly id: string;
  readonly name: string;
  readonly scheduleTime: string;
  readonly tz: string;
  readonly reportType: string;
  readonly owner: "daemon" | "bot";
  readonly enabled: boolean;
  readonly gateReady: boolean;
  readonly missingRequirements: readonly string[];
  readonly lastTriggeredAt: string | null;
}

export interface AutomationsSnapshot {
  readonly observedAt: string;
  readonly bridgeRollupUpdatedAt: string | null;
  readonly bridgeJobs: readonly BridgeJobStatusSummary[];
  readonly schedules: readonly AutomationScheduleSummary[];
  readonly ticketVerification: TicketVerificationSummary | null;
}

export interface R2PipelineApiResponse {
  readonly schemaVersion: 1;
  readonly bucketPublicBase: string;
  readonly observedAt: string;
  readonly overallStatus: "fresh" | "stale" | "degraded";
  readonly freshCount: number;
  readonly totalCount: number;
  readonly staleKeys: readonly string[];
  readonly dataStaleKeys: readonly string[];
  readonly sinks: readonly R2SinkDetail[];
  readonly daemon4020: Daemon4020Status;
  readonly automations?: AutomationsSnapshot | undefined;
}

export interface AgentDetailApiResponse {
  readonly schemaVersion: 1;
  readonly agentId: string;
  readonly found: boolean;
  readonly masterAgent: string | null;
  readonly level: number | null;
  readonly agentType: string | null;
  readonly childAgents: readonly string[];
  readonly conduit30d: {
    readonly handleUsd: number;
    readonly wagers: number;
    readonly customers: number;
    readonly topCustomer: string | null;
    readonly concentrationPct: number;
    readonly isProxyConduit: boolean;
  } | null;
  readonly customers: ReadonlyArray<{
    readonly id: string;
    readonly tier: string;
    readonly score: number;
    readonly recommendedLimitUsd: number;
    readonly holdPct: number;
  }>;
  readonly recentWagers: ReadonlyArray<{
    readonly ticketId: string;
    readonly customerId: string;
    readonly sport: string;
    readonly betType: string;
    readonly selection: string;
    readonly riskUsd: number;
    readonly toWinUsd: number;
    readonly writer: string;
    readonly alertTier: WagerTier;
    readonly timestamp: string;
  }>;
  readonly observedAt: string;
  readonly autoExecute: false;
}
