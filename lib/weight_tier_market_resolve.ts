/**
 * Offline Kalshi series resolution for bet-ticker rows (no network).
 */
import type { F402TickerRow } from "./f402_ingest.ts";
import { parseShortDesc } from "./live_wagers.ts";
import { seriesTickerFor } from "./kalshi_signal_join.ts";
import type { League } from "./watchlist_signal_engine.ts";
import { parseWagerShortDesc } from "./watchlist_signal_engine.ts";
import { rotationKeyFromTickerShortDesc } from "./weight_tier_signal_enrichment.ts";

const SPORT_NAME_TO_LEAGUE: Readonly<Record<string, League>> = {
  FOOTBALL: "NFL",
  BASKETBALL: "NBA",
  HOCKEY: "NHL",
  BASEBALL: "MLB",
  SOCCER: "EPL",
};

export type MarketResolveStatus =
  | "resolved_series"
  | "unparsed_short_desc"
  | "no_kalshi_series";

export interface TickerMarketResolve {
  readonly status: MarketResolveStatus;
  readonly league: League | null;
  readonly marketKind: string | null;
  readonly rotationKey: string;
  readonly kalshiSeriesTicker: string | null;
  readonly polymarketGammaHint: string | null;
}

const WAGER_TYPE_TO_KIND: Readonly<Record<string, string>> = {
  S: "spread",
  M: "moneyline",
  L: "total",
};

export function resolveTickerMarketOffline(row: F402TickerRow): TickerMarketResolve {
  const rotationKey = rotationKeyFromTickerShortDesc(row.shortDesc);
  let parsed = parseWagerShortDesc(row.shortDesc);
  if (parsed === null) {
    const wagerType = row.wagerType.trim().toUpperCase();
    const kind = WAGER_TYPE_TO_KIND[wagerType] ?? null;
    const leg = parseShortDesc(row.shortDesc).legs[0];
    const league =
      leg === undefined
        ? null
        : (SPORT_NAME_TO_LEAGUE[leg.sport.trim().toUpperCase()] ?? "UNKNOWN");
    if (kind !== null && league !== null && league !== "UNKNOWN") {
      parsed = {
        league,
        marketKind: kind,
        teams: [],
        sideTeam: null,
        line: null,
        overUnder: null,
        raw: row.shortDesc,
      };
    } else {
      return {
        status: "unparsed_short_desc",
        league,
        marketKind: kind,
        rotationKey,
        kalshiSeriesTicker: null,
        polymarketGammaHint: null,
      };
    }
  }

  const series = seriesTickerFor({
    league: parsed.league,
    marketKind: parsed.marketKind,
  });
  const status: MarketResolveStatus =
    series === null ? "no_kalshi_series" : "resolved_series";

  const polymarketGammaHint =
    parsed.league !== "UNKNOWN"
      ? `${parsed.league}:${parsed.marketKind}:${parsed.teams.join("_")}`
      : null;

  return {
    status,
    league: parsed.league,
    marketKind: parsed.marketKind,
    rotationKey,
    kalshiSeriesTicker: series,
    polymarketGammaHint,
  };
}

export function applyMarketResolveToWireDraft(
  wireDraft: Record<string, unknown>,
  resolve: TickerMarketResolve,
  venue: "polymarket" | "kalshi",
): Record<string, unknown> {
  if (venue === "kalshi" && resolve.kalshiSeriesTicker !== null) {
    return {
      ...wireDraft,
      ticker: `<${resolve.kalshiSeriesTicker}-EVENT-MKT>`,
      _resolve: {
        status: resolve.status,
        seriesTicker: resolve.kalshiSeriesTicker,
        rotationKey: resolve.rotationKey,
      },
    };
  }
  if (venue === "polymarket" && resolve.polymarketGammaHint !== null) {
    return {
      ...wireDraft,
      _resolve: {
        status: resolve.status,
        gammaSearchHint: resolve.polymarketGammaHint,
        rotationKey: resolve.rotationKey,
      },
    };
  }
  return wireDraft;
}
