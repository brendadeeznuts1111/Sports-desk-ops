/**
 * @file live_bets.v2.ts
 * @description Explicit source, Signal Honesty basis, and branded boundary contract for
 * `GET /api/v2/live-bets` and `resolveLiveBets`. Replaces implicit `"auto"` fallback
 * resolution with named sources, canonical `live | capture | fixture` provenance basis,
 * and boundary-validated domain primitives.
 */

import {
  agentIdentifier,
  isAgentIdentifier,
  isIsoDateTimeUtc,
  isoDateTimeUtc,
  parseAsCents,
  sha256HexFromDigest,
  type AgentIdentifier,
  type Cents,
  type IsoDateTimeUtc,
  type Sha256Hex,
} from "../../design/domain-branded-types.ts";
import type { WagerTypeLabel } from "../../lib/game_admin.ts";
import type {
  AgentScope,
  TicketKey,
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

/** Canonical Signal Honesty provenance basis (`docs/architecture/signal-honesty.md`). */
export const SIGNAL_HONESTY_BASES = ["live", "capture", "fixture"] as const;
export type SignalHonestyBasis = (typeof SIGNAL_HONESTY_BASES)[number];
export type LiveBetsBasis = SignalHonestyBasis | "none";

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

export function isSignalHonestyBasis(
  value: unknown,
): value is SignalHonestyBasis {
  return (
    typeof value === "string" &&
    (SIGNAL_HONESTY_BASES as readonly string[]).includes(value)
  );
}

/**
 * Maps a v2 `LiveBetsSource` onto the canonical `docs/architecture/signal-honesty.md`
 * provenance `basis` (`"db" -> "live"`, `"file" -> "capture"`, `"fixture" -> "fixture"`, `"none" -> "none"`).
 */
export function liveBetsSourceToBasis(source: LiveBetsSource): LiveBetsBasis {
  switch (source) {
    case "db":
      return "live";
    case "file":
      return "capture";
    case "fixture":
      return "fixture";
    case "none":
      return "none";
  }
}

export interface LiveBetsProvenance {
  readonly basis?: LiveBetsBasis;
  readonly path: string | null;
  readonly hash: Sha256Hex | null;
  readonly generatedAt: IsoDateTimeUtc;
  readonly capturedAt?: IsoDateTimeUtc | null;
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

export interface ValidatedLiveBetGameExposure {
  readonly ticketKey: TicketKey;
  readonly category: SportCategory;
  readonly position: WagerTypeLabel;
  readonly wageredCents: Cents;
  readonly toWinCents: Cents;
  readonly picks: number;
  readonly agentId: AgentIdentifier | null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates raw wire JSON provenance into a branded `LiveBetsProvenance` while
 * remaining backward-compatible with older payloads that omit `basis` or `capturedAt`.
 */
export function parseLiveBetsProvenance(
  raw: unknown,
  fallbackSource: LiveBetsSource = "none",
): LiveBetsProvenance {
  if (!isObjectRecord(raw)) {
    throw new TypeError("LiveBetsProvenance must be a JSON object");
  }
  const path =
    raw["path"] === null || raw["path"] === undefined
      ? null
      : typeof raw["path"] === "string"
        ? raw["path"]
        : null;
  const hash =
    raw["hash"] === null || raw["hash"] === undefined
      ? null
      : typeof raw["hash"] === "string"
        ? sha256HexFromDigest(raw["hash"])
        : null;
  if (typeof raw["generatedAt"] !== "string") {
    throw new TypeError("LiveBetsProvenance.generatedAt must be an ISO string");
  }
  const generatedAt = isoDateTimeUtc(raw["generatedAt"]);
  const rawBasis = raw["basis"];
  const basis: LiveBetsBasis =
    rawBasis === "none" || isSignalHonestyBasis(rawBasis)
      ? rawBasis
      : liveBetsSourceToBasis(fallbackSource);
  const rawCapturedAt = raw["capturedAt"];
  const capturedAt =
    typeof rawCapturedAt === "string" && isIsoDateTimeUtc(rawCapturedAt)
      ? isoDateTimeUtc(rawCapturedAt)
      : null;

  return {
    basis,
    path,
    hash,
    generatedAt,
    capturedAt,
  };
}

/**
 * Projects a `LiveBetsV2Game` into unit-explicit `Cents` and `AgentIdentifier`
 * domain primitives for internal risk and exposure consumers.
 */
export function toValidatedLiveBetGameExposure(
  game: LiveBetsV2Game,
): ValidatedLiveBetGameExposure {
  const rawAgent = game.agent?.id ?? game.agent?.key ?? null;
  const agentId =
    rawAgent !== null && isAgentIdentifier(rawAgent)
      ? agentIdentifier(rawAgent)
      : null;
  return {
    ticketKey: game.ticketKey,
    category: game.category,
    position: game.position,
    wageredCents: parseAsCents(game.wagered, true),
    toWinCents: parseAsCents(game.toWin, true),
    picks: game.picks,
    agentId,
  };
}
