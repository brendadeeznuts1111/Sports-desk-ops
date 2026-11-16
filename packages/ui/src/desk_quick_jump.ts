/**
 * Cross-desk quick-jump: shadow slice from URL ↔ live wager tape correlation.
 */

import type {
  MarketCode,
  PeriodCode,
  RegimeCode,
  SportCode,
  SubSportCode,
} from "@sportsdesk-ops/contracts/shadow-pricing";
import {
  DEFAULT_BOOKDESKOPS_SERVE_LOCAL,
  inferMarketKindFromBetType,
  inferPeriodHintFromWager,
  inferTicketInspectorRegime,
  mapWagerToShadowTaxonomy,
} from "./ticket_inspector.ts";
import type { LiveWager } from "./types.ts";

export const SHADOW_SLICE_URL_EVENT = "sportsdesk:shadow-slice-url" as const;

export type ActiveShadowSlice = {
  readonly sport: SportCode | "ALL";
  readonly subSport: SubSportCode | "ALL";
  readonly period: PeriodCode | "ALL";
  readonly market: MarketCode | "ALL";
  readonly regime: RegimeCode | "ALL";
};

export const EMPTY_SHADOW_SLICE: ActiveShadowSlice = {
  sport: "ALL",
  subSport: "ALL",
  period: "ALL",
  market: "ALL",
  regime: "ALL",
};

const SPORT_CODES = new Set<string>([
  "Football",
  "Basketball",
  "Hockey",
  "Baseball",
  "Soccer",
  "LIVE",
  "Other",
]);

const REGIME_CODES = new Set<string>(["pregame", "live_in_play"]);

function readFilter<T extends string>(
  raw: string | null,
  allowed: ReadonlySet<string>,
  fallback: T | "ALL",
): T | "ALL" {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "" || trimmed.toUpperCase() === "ALL") {
    return fallback;
  }
  if (!allowed.has(trimmed)) {
    return fallback;
  }
  return trimmed as T;
}

/** Parse shadow taxonomy query params (authoritative catalog codes). */
export function parseActiveShadowSlice(search: string): ActiveShadowSlice {
  const params = new URLSearchParams(search);
  return {
    sport: readFilter(params.get("sport"), SPORT_CODES, "ALL"),
    subSport: readFilter(
      params.get("subSport"),
      new Set([
        "NFL",
        "NCAAF",
        "NBA",
        "NCAAB",
        "WNBA",
        "NHL",
        "Hockey_Alter",
        "MLB",
        "Baseball_Series",
        "Soccer_Top",
        "NFL_Live",
        "NCAAF_Live",
        "NBA_Live",
        "NHL_Live",
        "MLB_Live",
        "Tennis_Tour",
        "Combat_Golf",
        "Other_General",
      ]),
      "ALL",
    ),
    period: readFilter(
      params.get("period"),
      new Set([
        "game",
        "1h",
        "2h",
        "1q",
        "2q",
        "3q",
        "4q",
        "p1",
        "p2",
        "p3",
        "reg",
        "f5",
        "inning",
        "set",
        "round",
      ]),
      "ALL",
    ),
    market: readFilter(
      params.get("market"),
      new Set([
        "spread",
        "total",
        "moneyline",
        "team_total",
        "player_prop",
        "other",
      ]),
      "ALL",
    ),
    regime: readFilter(params.get("regime"), REGIME_CODES, "ALL"),
  };
}

export function shadowSliceHasTapeFocus(slice: ActiveShadowSlice): boolean {
  return (
    slice.subSport !== "ALL" ||
    slice.sport !== "ALL" ||
    slice.period !== "ALL" ||
    slice.market !== "ALL" ||
    slice.regime !== "ALL"
  );
}

export function formatShadowSliceRibbonLabel(slice: ActiveShadowSlice): string {
  const parts: string[] = [];
  if (slice.subSport !== "ALL") {
    parts.push(slice.subSport);
  } else if (slice.sport !== "ALL") {
    parts.push(slice.sport);
  }
  if (slice.period !== "ALL") {
    parts.push(slice.period.toUpperCase());
  }
  if (slice.regime !== "ALL") {
    parts.push(slice.regime === "pregame" ? "Pregame" : "In-play");
  }
  if (slice.market !== "ALL") {
    parts.push(slice.market);
  }
  return parts.length > 0 ? parts.join(" · ") : "Full tape";
}

export function wagerMatchesShadowSlice(
  wager: LiveWager,
  slice: ActiveShadowSlice,
): boolean {
  if (!shadowSliceHasTapeFocus(slice)) {
    return true;
  }
  const tax = mapWagerToShadowTaxonomy(wager);
  if (slice.subSport !== "ALL") {
    const sub = tax?.subSport ?? (wager.subSport ?? wager.sport).toUpperCase();
    if (sub.toUpperCase() !== slice.subSport.toUpperCase()) {
      return false;
    }
  } else if (slice.sport !== "ALL") {
    const sport =
      tax?.sport ??
      (wager.sport.toLowerCase() === "football"
        ? "Football"
        : wager.sport.toLowerCase() === "basketball"
          ? "Basketball"
          : wager.sport);
    if (sport !== slice.sport) {
      return false;
    }
  }
  if (slice.regime !== "ALL") {
    const regime = inferTicketInspectorRegime(wager);
    if (regime !== slice.regime) {
      return false;
    }
  }
  if (slice.period !== "ALL") {
    const period = inferPeriodHintFromWager(wager);
    if (period !== slice.period) {
      return false;
    }
  }
  if (slice.market !== "ALL") {
    const market = inferMarketKindFromBetType(wager.betType);
    if (market !== slice.market) {
      return false;
    }
  }
  return true;
}

export function summarizeSliceWagers(
  wagers: readonly LiveWager[],
  slice: ActiveShadowSlice,
): {
  readonly riskUsd: number;
  readonly count: number;
  readonly criticalOrSteam: number;
} {
  const matched = wagers.filter((w) => wagerMatchesShadowSlice(w, slice));
  return {
    riskUsd: matched.reduce((s, w) => s + w.riskUsd, 0),
    count: matched.length,
    criticalOrSteam: matched.filter(
      (w) => w.alertTier === "CRITICAL" || w.alertTier === "STEAM",
    ).length,
  };
}

export function sportFilterForSlice(slice: ActiveShadowSlice): string {
  if (slice.subSport !== "ALL") {
    return slice.subSport;
  }
  if (slice.sport !== "ALL") {
    return slice.sport;
  }
  return "ALL";
}

export function wagerSearchHintForSlice(slice: ActiveShadowSlice): string {
  if (slice.period !== "ALL") {
    return slice.period;
  }
  return "";
}

export function buildDashboardShadowSliceUrl(
  slice: ActiveShadowSlice,
  options?: { readonly matrix?: boolean | undefined },
): string {
  const url = new URL("/", "http://local");
  url.searchParams.set("tab", "shadow");
  if (options?.matrix === true) {
    url.searchParams.set("matrix", "1");
  }
  if (slice.sport !== "ALL") {
    url.searchParams.set("sport", slice.sport);
  }
  if (slice.subSport !== "ALL") {
    url.searchParams.set("subSport", slice.subSport);
  }
  if (slice.period !== "ALL") {
    url.searchParams.set("period", slice.period);
  }
  if (slice.market !== "ALL") {
    url.searchParams.set("market", slice.market);
  }
  if (slice.regime !== "ALL") {
    url.searchParams.set("regime", slice.regime);
  }
  return `${url.pathname}${url.search}`;
}

export const NFL_1H_PREGAME_SLICE: ActiveShadowSlice = {
  sport: "Football",
  subSport: "NFL",
  period: "1h",
  market: "ALL",
  regime: "pregame",
};

interface QuickJumpWindowLike {
  readonly location: { readonly href: string; readonly search: string };
  readonly history: {
    replaceState(data: unknown, unused: string, url: string): void;
  };
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  dispatchEvent(event: Event): boolean;
}

function getQuickJumpWindow(): QuickJumpWindowLike | undefined {
  return (globalThis as { readonly window?: QuickJumpWindowLike }).window;
}

export function applyShadowSliceToLocation(
  slice: ActiveShadowSlice,
  options?: { readonly matrix?: boolean | undefined },
): void {
  const win = getQuickJumpWindow();
  if (!win) {
    return;
  }
  const url = new URL(win.location.href);
  url.searchParams.set("tab", "shadow");
  if (options?.matrix === true) {
    url.searchParams.set("matrix", "1");
  } else {
    url.searchParams.delete("matrix");
  }
  for (const [key, value] of [
    ["sport", slice.sport],
    ["subSport", slice.subSport],
    ["period", slice.period],
    ["market", slice.market],
    ["regime", slice.regime],
  ] as const) {
    if (value === "ALL") {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  }
  win.history.replaceState({}, "", url.toString());
  notifyShadowSliceUrlChanged();
}

export function buildBookdeskopsTokensDeskHref(
  slice?: ActiveShadowSlice,
  origin: string = DEFAULT_BOOKDESKOPS_SERVE_LOCAL,
): string {
  const u = new URL("/_dev/serve-local/tokens", origin.replace(/\/$/, ""));
  for (const [key, val] of [
    ["sport", slice?.sport],
    ["subSport", slice?.subSport],
    ["period", slice?.period],
    ["market", slice?.market],
    ["regime", slice?.regime],
  ] as const) {
    if (val !== undefined && val !== "ALL") {
      u.searchParams.set(key, val);
    }
  }
  u.hash = "compile-time";
  return u.href;
}

// `useSyncExternalStore` requires a referentially stable snapshot: rebuilding
// the object on every call makes React re-render until it aborts with
// "Maximum update depth exceeded". Cache by search string so the object only
// changes when the URL slice actually changes.
let cachedShadowSliceSearch: string | null = null;
let cachedShadowSlice: ActiveShadowSlice = EMPTY_SHADOW_SLICE;

export function getShadowSliceSnapshot(): ActiveShadowSlice {
  const win = getQuickJumpWindow();
  if (!win) {
    return EMPTY_SHADOW_SLICE;
  }
  const search = win.location.search;
  if (search !== cachedShadowSliceSearch) {
    cachedShadowSliceSearch = search;
    cachedShadowSlice = parseActiveShadowSlice(search);
  }
  return cachedShadowSlice;
}

export function subscribeShadowSliceUrl(onStoreChange: () => void): () => void {
  const win = getQuickJumpWindow();
  if (!win) {
    return () => {};
  }
  const bump = () => onStoreChange();
  win.addEventListener(SHADOW_SLICE_URL_EVENT, bump);
  win.addEventListener("popstate", bump);
  return () => {
    win.removeEventListener(SHADOW_SLICE_URL_EVENT, bump);
    win.removeEventListener("popstate", bump);
  };
}

export function notifyShadowSliceUrlChanged(): void {
  const win = getQuickJumpWindow();
  if (!win) {
    return;
  }
  win.dispatchEvent(new Event(SHADOW_SLICE_URL_EVENT));
}
