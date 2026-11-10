/**
 * @file live_bets.v2.ts
 * @description Explicit source and fallback contract for `GET /api/v2/live-bets` and
 * `resolveLiveBets`. Replaces implicit `"auto"` fallback resolution with named sources and
 * surfaced warnings.
 */

import type { WagerTypeLabel } from "../../lib/game_admin.ts";
import type {
  AgentScope,
  LiveBetGame,
  LiveBetsSummary,
} from "../../lib/live_bets.ts";
import type { summarizeScoreboard, WagerScore } from "../../lib/scoreboard.ts";
import type {
  LIVE_FILTER,
  SportCategory,
  SportCategorySummary,
} from "../../lib/sport_taxonomy.ts";

export const LIVE_BETS_SOURCES = ["db", "file", "fixture", "none"] as const;

/** Explicit v2 data source — `"auto"` is intentionally excluded. */
export type LiveBetsSource = (typeof LIVE_BETS_SOURCES)[number];

export const LIVE_BETS_FALLBACKS = ["strict", "sample"] as const;

export type LiveBetsFallback = (typeof LIVE_BETS_FALLBACKS)[number];

export function isLiveBetsSource(value: unknown): value is LiveBetsSource {
  return (
    typeof value === "string" &&
    (LIVE_BETS_SOURCES as readonly string[]).includes(value)
  );
}

export function isLiveBetsFallback(value: unknown): value is LiveBetsFallback {
  return (
    typeof value === "string" &&
    (LIVE_BETS_FALLBACKS as readonly string[]).includes(value)
  );
}

export interface LiveBetsProvenance {
  readonly path: string | null;
  readonly hash: string | null;
  readonly generatedAt: string;
}

export interface LiveBetsV2Request {
  readonly source: LiveBetsSource;
  readonly fallback: LiveBetsFallback;
  readonly path?: string | undefined;
}

export interface LiveBetsV2Game extends LiveBetGame {
  readonly position: WagerTypeLabel;
  readonly category: SportCategory;
  readonly scoreboard: WagerScore | null;
}

export interface LiveBetsV2Scoreboard {
  readonly source: string;
  readonly observedAt: string | null;
  readonly summary: ReturnType<typeof summarizeScoreboard>;
}

export interface LiveBetsV2Sports {
  readonly categories: readonly SportCategorySummary[];
  readonly all: readonly SportCategory[];
  readonly liveFilter: typeof LIVE_FILTER;
}

export interface LiveBetsV2Response {
  readonly apiVersion: "2";
  readonly dataSource: LiveBetsSource;
  readonly fallbackUsed: boolean;
  readonly provenance: LiveBetsProvenance;
  readonly games: readonly LiveBetsV2Game[];
  readonly warnings: readonly string[];
  readonly agents: AgentScope;
  readonly pendingCount: number;
  readonly summary: LiveBetsSummary;
  readonly scoreboard: LiveBetsV2Scoreboard | null;
  readonly sports: LiveBetsV2Sports;
}
