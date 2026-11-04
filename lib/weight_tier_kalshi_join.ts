/**
 * Read-only Kalshi join for weight-tier stream-signals (public GET only, no orders).
 */
import type { F402TickerRow } from "./f402_ingest.ts";
import type { KalshiClient } from "./kalshi_client.ts";
import {
  joinWatchlistSignals,
  type JoinConfig,
  type KalshiJoin,
} from "./kalshi_signal_join.ts";
import type { StreamSignalEmission } from "./weight_tier_stream_signals.ts";
import type { WeightTierId } from "./weight_tier_stream_signals.ts";
import {
  americanToImpliedProbability,
  parseWagerShortDesc,
  type League,
  type WatchlistSignal,
} from "./watchlist_signal_engine.ts";
import { resolveTickerMarketOffline } from "./weight_tier_market_resolve.ts";

const STREAM_SIGNAL_STALE_SECONDS = 300;

function parseAmericanFromShortDesc(shortDesc: string): number | null {
  const matches = [...shortDesc.matchAll(/([+-]\d{3,4})\b/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]?.[1];
  if (last === undefined) return null;
  const value = Number(last);
  return Number.isFinite(value) ? value : null;
}

function ageSecondsFromIso(iso: string, now: Date): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return STREAM_SIGNAL_STALE_SECONDS + 1;
  return Math.max(0, Math.floor((now.getTime() - ms) / 1000));
}

/**
 * Build a watchlist-shaped signal from a raw bet-ticker row for Kalshi join.
 * Returns `null` when the short description does not yield a league + market kind.
 */
export function watchlistSignalFromF402TickerRow(
  row: F402TickerRow,
  tier: WeightTierId,
  now: Date = new Date(),
): WatchlistSignal | null {
  const parsed = parseWagerShortDesc(row.shortDesc);
  const offline = resolveTickerMarketOffline(row);
  const league: League | null =
    parsed?.league ?? offline.league ?? null;
  const marketKind =
    parsed?.marketKind ?? offline.marketKind ?? null;
  if (
    league === null ||
    league === "UNKNOWN" ||
    marketKind === null ||
    marketKind === ""
  ) {
    return null;
  }

  const teams = parsed?.teams ?? [];
  const sideTeam = parsed?.sideTeam ?? null;
  const line = parsed?.line ?? null;
  const overUnder = parsed?.overUnder ?? null;
  const american = parseAmericanFromShortDesc(row.shortDesc);
  const asOf = row.insertedAt.trim() !== "" ? row.insertedAt : now.toISOString();
  const ageSeconds = ageSecondsFromIso(asOf, now);

  const id = [
    "stream",
    league,
    marketKind,
    row.wagerNumber,
    row.login.trim().toUpperCase(),
  ].join(":");

  return {
    id,
    league,
    marketKind,
    teams,
    sideTeam,
    line,
    overUnder,
    accounts: [
      {
        login: row.login.trim().toUpperCase(),
        agentId: row.agentId.trim(),
        archetype: tier,
        sourceCategory: "INTERNAL_F402_SHARP",
        riskUsd:
          row.amountWagered !== null && Number.isFinite(row.amountWagered)
            ? Math.max(0, row.amountWagered)
            : 0,
        source: "f402_getBetTicker/stream-signals",
      },
    ],
    distinctAccounts: 1,
    riskUsd:
      row.amountWagered !== null && Number.isFinite(row.amountWagered)
        ? Math.max(0, row.amountWagered)
        : 0,
    oneSidedShare: 1,
    fairProb: americanToImpliedProbability(american),
    confidence: 30,
    provenance: {
      dataMode: "LIVE",
      asOf,
      ageSeconds,
      stale: ageSeconds > STREAM_SIGNAL_STALE_SECONDS,
      fixture: false,
      sources: ["f402_getBetTicker/stream-signals"],
    },
  };
}

export interface StreamSignalKalshiJoinResult {
  readonly emission: StreamSignalEmission;
  readonly kalshiJoin: KalshiJoin;
}

export async function joinKalshiForStreamEmissions(
  pairs: readonly {
    readonly emission: StreamSignalEmission;
    readonly row: F402TickerRow;
  }[],
  options: {
    readonly client: KalshiClient;
    readonly config?: JoinConfig;
  },
): Promise<readonly StreamSignalKalshiJoinResult[]> {
  const prepared: {
    readonly emission: StreamSignalEmission;
    readonly signal: WatchlistSignal;
  }[] = [];
  for (const pair of pairs) {
    const signal = watchlistSignalFromF402TickerRow(
      pair.row,
      pair.emission.tier,
    );
    if (signal === null) continue;
    prepared.push({ emission: pair.emission, signal });
  }
  if (prepared.length === 0) return [];

  const joined = await joinWatchlistSignals(
    prepared.map((entry) => entry.signal),
    {
      client: options.client,
      config: options.config,
    },
  );

  return prepared.map((entry, index) => ({
    emission: entry.emission,
    kalshiJoin: joined[index]!.kalshi,
  }));
}

export type StreamSignalEmissionWithKalshi = StreamSignalEmission & {
  readonly kalshiJoin: KalshiJoin;
};

export function withKalshiJoin(
  emission: StreamSignalEmission,
  kalshiJoin: KalshiJoin,
): StreamSignalEmissionWithKalshi {
  return { ...emission, kalshiJoin };
}
