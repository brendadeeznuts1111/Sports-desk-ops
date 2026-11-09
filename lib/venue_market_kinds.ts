/**
 * @file venue_market_kinds.ts
 * @description One place that answers "what kind of market is this?" for each venue's raw
 * vocabulary, plus the combo eligibility policy over the canonical kinds.
 *
 * Measured 2026-11-09, because the naive assumption — that each venue names its market kind —
 * does not hold:
 *  - Polymarket Gamma: `sports_market_type` was absent on 40/40 top-volume open events. The
 *    field survives only inside combo-leg payloads, as moneyline / spreads / totals / team_total.
 *  - Kalshi: `market_type` is always "binary". The kind is implicit in the series ticker
 *    (4,157 sports series observed; KXNBAPRA is a PRA prop, KXNBAGAME is a game winner).
 *  - GSLive / betticker (F402): the ticket carries a product code (S/M/L/E/T/P/G) and the leg
 *    carries a picker label; the label, not the code, names the market kind.
 *
 * Every rule is explicit and returns "unknown" when the evidence does not decide. A guessed
 * kind is worse than an unknown here: eligibility gates combo membership, so a guess would
 * silently add or drop legs.
 */

import { classifyMarketLabel } from "./market_type_registry.ts";
import type { MarketKind } from "./leg_taxonomy.ts";

export type Venue = "polymarket" | "kalshi" | "f402";

/** Canonical kinds a combo leg may be made of. Was the literal {"moneyline","spreads","totals"}. */
export const ELIGIBLE_LEG_KINDS: readonly MarketKind[] = [
  "moneyline",
  "spread",
  "total",
];

const KIND_BY_NAME: Readonly<Record<string, MarketKind>> = {
  moneyline: "moneyline",
  "money line": "moneyline",
  spread: "spread",
  spreads: "spread",
  total: "total",
  totals: "total",
  "over/under": "total",
  overunder: "total",
  team_total: "team_total",
  "team total": "team_total",
  teamtotals: "team_total",
  "team totals": "team_total",
  player_prop: "player_prop",
  "player prop": "player_prop",
  player_props: "player_prop",
  "player props": "player_prop",
  prop: "prop",
  props: "prop",
  teaser: "teaser",
};

/** Canonical kind for a venue's own type token; `unknown` when the token means nothing to us. */
export function kindFromTypeName(raw: string | null | undefined): MarketKind {
  const key = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (key === "") return "unknown";
  return KIND_BY_NAME[key] ?? "unknown";
}

/** `classifyMarketLabel` returns registry ids; keep only ids that are canonical kinds. */
function kindOfLabel(raw: string | null | undefined): MarketKind {
  const id = classifyMarketLabel(raw);
  return id !== null && id in KIND_BY_NAME ? (id as MarketKind) : "unknown";
}

/**
 * Polymarket. The combo payload carries `sports_market_type`; Gamma events do not (measured
 * above). When the field is absent, fall back to the picker label, never to the title prose.
 */
export function kindFromPolymarketMarket(
  market: Record<string, unknown> | null | undefined,
): MarketKind {
  if (market === null || market === undefined) return "unknown";
  const raw =
    (typeof market.sports_market_type === "string" &&
      market.sports_market_type) ||
    (typeof market.sportsMarketType === "string" && market.sportsMarketType) ||
    "";
  const fromType = kindFromTypeName(raw);
  if (fromType !== "unknown") return fromType;
  const label =
    typeof market.groupItemTitle === "string" ? market.groupItemTitle : "";
  return kindOfLabel(label);
}

/** Polymarket leg object: a `market`/`markets` child plus the leg's own type fields. */
export function kindFromPolymarketLeg(leg: unknown): MarketKind {
  const record =
    typeof leg === "object" && leg !== null
      ? (leg as Record<string, unknown>)
      : {};
  const nested = record.market;
  if (typeof nested === "object" && nested !== null) {
    const kind = kindFromPolymarketMarket(nested as Record<string, unknown>);
    if (kind !== "unknown") return kind;
  }
  return kindFromPolymarketMarket(record);
}

/** Prop suffixes are matched on the token after the league prefix, never as a substring:
 * `KXNBAEAST` ends in "AST" but is a conference market, and a bare "K" token (strikeouts)
 * would otherwise match every Kalshi ticker because they all start with "KX". */
const KALSHI_PROP_TOKENS = [
  "PRA",
  "PTS",
  "REB",
  "AST",
  "3PT",
  "STL",
  "BLK",
  "SOG",
  "K",
  "PROP",
  "PROPS",
];

function isKalshiPropTicker(ticker: string): boolean {
  const tail = ticker
    .replace(/^KX/, "")
    .replace(
      /^(NCAAF|NCAAB|WNBA|NBA|NFL|MLB|NHL|ATP|WTA|UFC|EPL|SOCCER|PGA|NASCAR)/,
      "",
    );
  const head = (tail.split(/[-_]/)[0] ?? "").replace(/\d+$/, "");
  return KALSHI_PROP_TOKENS.includes(head);
}

/**
 * Kalshi. `market_type` is always "binary"; the series ticker is the only signal. Rules are
 * ordered so a prop token wins over a bare league prefix (KXNBAPRA is not a title market).
 */
export function kindFromKalshiSeries(ticker: string): MarketKind {
  const t = ticker.trim().toUpperCase();
  if (t === "") return "unknown";
  if (t.includes("TEAMTOTAL") || t.includes("TEAM-TOTAL")) return "team_total";
  if (isKalshiPropTicker(t)) return "player_prop";
  if (t.includes("SPREAD") || t.includes("HANDICAP")) return "spread";
  if (t.includes("TOTAL")) return "total";
  if (t.includes("GAME")) return "moneyline";
  // Championship / award series are single-outcome markets (KXNBA, KXNFL, ...), i.e. moneyline.
  if (/^KX(NBA|NFL|MLB|NHL|NCAAF|NCAAB)$/.test(t)) return "moneyline";
  return "unknown";
}

/**
 * F402 / GSLive. The ticket's `WagerType` is a product, not a market kind: `S` (Straight) says
 * nothing about whether the pick is a spread or a total. Prefer the picker label; fall back to
 * the codes whose name *is* a kind.
 */
export function kindFromF402WagerType(
  code: string | null | undefined,
): MarketKind {
  switch ((code ?? "").trim().toUpperCase()) {
    case "M":
      return "moneyline";
    case "L":
      return "total";
    case "E":
      return "team_total";
    case "T":
      return "teaser";
    default:
      return "unknown";
  }
}

export function kindFromF402Row(row: {
  readonly WagerType?: string;
  readonly SubSport?: string;
  readonly subSport?: string;
}): MarketKind {
  const fromLabel = kindOfLabel(row.SubSport ?? row.subSport);
  if (fromLabel !== "unknown") return fromLabel;
  return kindFromF402WagerType(row.WagerType);
}

/** Dispatch on venue for callers that hold a raw token rather than a venue-specific object. */
export function kindFromVenue(venue: Venue, raw: string): MarketKind {
  switch (venue) {
    case "polymarket":
      return kindFromTypeName(raw);
    case "kalshi":
      return kindFromKalshiSeries(raw);
    case "f402":
      return kindFromF402Row({ WagerType: raw });
  }
}

/** The combo eligibility policy, over canonical kinds. */
export function isEligibleLegKind(kind: MarketKind): boolean {
  return ELIGIBLE_LEG_KINDS.includes(kind);
}
