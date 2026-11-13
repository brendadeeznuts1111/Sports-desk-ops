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
  readonly clvCents: number;
  readonly alertTier: WagerTier;
  readonly alertBadge: string;
  readonly operatorDirective: string;
  readonly maxRecommendedStake: number;
  readonly autoExecute: false;
}

export interface LiveWagersApiResponse {
  readonly wagers: ReadonlyArray<HydratedWagerRow | Record<string, unknown>>;
  readonly totalRiskUsd: number;
  readonly totalToWinUsd: number;
  readonly criticalSteamCount: number;
  readonly autoExecute: false;
  readonly timestamp: string;
  readonly provenance: DashboardSourceProvenance;
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
  readonly fixtures: ReadonlyArray<Record<string, unknown>>;
  readonly provenance: DashboardSourceProvenance;
}

export type DashboardWsEventName =
  | "reload"
  | "dashboard-updated"
  | "wagers-updated"
  | "tiers-updated"
  | "alerts-updated";

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
