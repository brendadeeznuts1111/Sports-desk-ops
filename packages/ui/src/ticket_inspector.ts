/**
 * Pure helpers for the Live Wagers Ticket Inspector (taxonomy, price math, PTY, deep links).
 */

import {
  WAGER_CHANNEL_LABELS,
  type WagerChannel,
  wagerChannelOf,
} from "@sportsdesk-ops/contracts";
import type { DashboardAlertRecord, LiveWager } from "./types.ts";
import { formatWagerSelection } from "./wager_display.ts";

export const DEFAULT_BOOKDESKOPS_SERVE_LOCAL = "http://127.0.0.1:8787" as const;

export const BOOKDESKOPS_CUSTOMER_WEBLOG_PATH =
  "/_dev/serve-local/customer-weblogs" as const;

export type TicketInspectorRegime = "pregame" | "live_in_play";

export type TicketShadowTaxonomy = {
  readonly sport: string;
  readonly subSport: string;
  readonly regime: TicketInspectorRegime;
};

const SUBSPORT_TO_SHADOW: Readonly<Record<string, string>> = {
  NFL: "NFL",
  CFB: "NCAAF",
  NCAAF: "NCAAF",
  NBA: "NBA",
  NCAAB: "NCAAB",
  CBB: "NCAAB",
  WNBA: "WNBA",
  NHL: "NHL",
  MLB: "MLB",
  NFL_LIVE: "NFL_Live",
  NBA_LIVE: "NBA_Live",
  NHL_LIVE: "NHL_Live",
  MLB_LIVE: "MLB_Live",
};

const SHADOW_SUB_TO_SPORT: Readonly<Record<string, string>> = {
  NFL: "Football",
  NCAAF: "Football",
  NFL_Live: "LIVE",
  NCAAF_Live: "LIVE",
  NBA: "Basketball",
  NCAAB: "Basketball",
  WNBA: "Basketball",
  NBA_Live: "LIVE",
  NHL: "Hockey",
  Hockey_Alter: "Hockey",
  NHL_Live: "LIVE",
  MLB: "Baseball",
  Baseball_Series: "Baseball",
  MLB_Live: "LIVE",
  Soccer_Top: "Soccer",
  Tennis_Tour: "Other",
  Combat_Golf: "Other",
  Other_General: "Other",
};

export function wagerChannelLabel(wager: LiveWager): string {
  const channel: WagerChannel =
    wager.writer ?? wagerChannelOf(wager.ticketWriter);
  const label = WAGER_CHANNEL_LABELS[channel] ?? channel;
  if (channel === "gslive") {
    return `🔴 ${label}`;
  }
  if (channel === "gsbuilder") {
    return `🧩 ${label}`;
  }
  if (channel === "internet") {
    return `🌐 ${label}`;
  }
  if (wager.ticketWriter?.trim() !== "") {
    return wager.ticketWriter!.trim();
  }
  return label;
}

export function inferTicketInspectorRegime(
  wager: LiveWager,
): TicketInspectorRegime {
  const channel = wager.writer ?? wagerChannelOf(wager.ticketWriter);
  if (channel === "gslive") {
    return "live_in_play";
  }
  const sport = `${wager.sport} ${wager.subSport ?? ""}`.toUpperCase();
  if (sport.includes("LIVE")) {
    return "live_in_play";
  }
  return "pregame";
}

export function mapWagerToShadowTaxonomy(
  wager: LiveWager,
): TicketShadowTaxonomy | null {
  const rawSub = (wager.subSport ?? wager.sport).trim().toUpperCase();
  if (rawSub === "") {
    return null;
  }
  const subSport = SUBSPORT_TO_SHADOW[rawSub] ?? rawSub;
  const sport =
    SHADOW_SUB_TO_SPORT[subSport] ??
    (wager.sport.toLowerCase() === "football"
      ? "Football"
      : wager.sport.toLowerCase() === "basketball"
        ? "Basketball"
        : wager.sport.toLowerCase() === "hockey"
          ? "Hockey"
          : wager.sport.toLowerCase() === "baseball"
            ? "Baseball"
            : "Other");
  return {
    sport,
    subSport,
    regime: inferTicketInspectorRegime(wager),
  };
}

export function inferPeriodHintFromWager(wager: LiveWager): string | null {
  const blob =
    `${wager.selection} ${wager.lineDisplay} ${wager.event}`.toLowerCase();
  if (/\b1h\b|1st half|first half/.test(blob)) {
    return "1h";
  }
  if (/\b2h\b|2nd half|second half/.test(blob)) {
    return "2h";
  }
  if (/\b1q\b|1st quarter/.test(blob)) {
    return "1q";
  }
  if (/\bf5\b|first 5/.test(blob)) {
    return "f5";
  }
  if (wager.betType.toLowerCase().includes("parlay")) {
    return null;
  }
  return taxRegimePeriodDefault(inferTicketInspectorRegime(wager));
}

function taxRegimePeriodDefault(regime: TicketInspectorRegime): string | null {
  return regime === "live_in_play" ? "game" : null;
}

export function buildShadowSliceHrefFromWager(
  wager: LiveWager,
  origin = "",
): string | null {
  const tax = mapWagerToShadowTaxonomy(wager);
  if (tax === null) {
    return null;
  }
  const base = origin === "" ? "/" : origin.replace(/\/$/, "") + "/";
  const url = new URL(base, "http://local");
  url.searchParams.set("tab", "shadow");
  url.searchParams.set("sport", tax.sport);
  url.searchParams.set("subSport", tax.subSport);
  const market = inferMarketKindFromBetType(wager.betType);
  if (market !== "other") {
    url.searchParams.set("market", market);
  }
  const period =
    inferPeriodHintFromWager(wager) ?? taxRegimePeriodDefault(tax.regime);
  if (period !== null) {
    url.searchParams.set("period", period);
  }
  return `${url.pathname}${url.search}`;
}

export function normalizeTicketIdParam(ticketId: string): string {
  return ticketId.trim().replace(/^#/, "");
}

export function wagerMatchesTicketParam(
  wager: LiveWager,
  ticketParam: string,
): boolean {
  const want = normalizeTicketIdParam(ticketParam);
  const have = normalizeTicketIdParam(wager.ticketId);
  return have === want;
}

export function findWagerByTicketParam(
  wagers: readonly LiveWager[],
  ticketParam: string,
): LiveWager | null {
  const trimmed = ticketParam.trim();
  if (trimmed === "") {
    return null;
  }
  return wagers.find((w) => wagerMatchesTicketParam(w, trimmed)) ?? null;
}

export function buildTicketInspectorPageUrl(
  ticketId: string,
  origin = "",
): string {
  const base = origin === "" ? "/" : origin.replace(/\/$/, "") + "/";
  const url = new URL(base, "http://local");
  url.searchParams.set("tab", "wagers");
  url.searchParams.set("ticket", normalizeTicketIdParam(ticketId));
  return `${url.pathname}${url.search}`;
}

interface TicketInspectorWindowLike {
  readonly location: { readonly href: string };
  readonly history: {
    replaceState(data: unknown, unused: string, url: string): void;
  };
}

function getTicketInspectorWindow(): TicketInspectorWindowLike | undefined {
  return (globalThis as { readonly window?: TicketInspectorWindowLike }).window;
}

export function syncTicketInspectorToLocation(ticketId: string): void {
  const win = getTicketInspectorWindow();
  if (!win) {
    return;
  }
  const url = new URL(win.location.href);
  url.searchParams.set("tab", "wagers");
  url.searchParams.set("ticket", normalizeTicketIdParam(ticketId));
  win.history.replaceState({}, "", url.toString());
}

export function buildBookdeskopsWeblogTraceHref(
  wager: LiveWager,
  origin: string = DEFAULT_BOOKDESKOPS_SERVE_LOCAL,
): string {
  const u = new URL(
    BOOKDESKOPS_CUSTOMER_WEBLOG_PATH,
    origin.replace(/\/$/, ""),
  );
  u.searchParams.set("login", wager.customerId);
  u.searchParams.set("days", "14");
  u.searchParams.set("deep", "1");
  u.searchParams.set("manager", "auto");
  u.searchParams.set("traceTicket", normalizeTicketIdParam(wager.ticketId));
  return u.href;
}

export function buildAlertsTabTicketHref(ticketId: string): string {
  const url = new URL("/", "http://local");
  url.searchParams.set("tab", "alerts");
  url.searchParams.set("ticket", normalizeTicketIdParam(ticketId));
  return `${url.pathname}${url.search}`;
}

export function capUtilizationPct(
  riskUsd: number,
  maxRecommendedStake: number,
): number | null {
  if (maxRecommendedStake <= 0) {
    return null;
  }
  return Number(((riskUsd / maxRecommendedStake) * 100).toFixed(1));
}

export function payoutMultiple(
  riskUsd: number,
  toWinUsd: number,
): number | null {
  if (riskUsd <= 0) {
    return null;
  }
  return Number((toWinUsd / riskUsd).toFixed(2));
}

export function findAlertForWager(
  alerts: readonly DashboardAlertRecord[],
  wager: LiveWager,
): DashboardAlertRecord | null {
  const id = normalizeTicketIdParam(wager.ticketId);
  return (
    alerts.find(
      (a) =>
        normalizeTicketIdParam(a.wagerId) === id ||
        a.wagerId === wager.ticketId,
    ) ?? null
  );
}

export function formatOperatorBrief(wager: LiveWager): string {
  const tax = mapWagerToShadowTaxonomy(wager);
  const lines = [
    `Ticket ${wager.ticketId} · ${wager.customerId} · ${wager.alertTier}`,
    `${wager.event} — ${formatWagerSelection(wager)}`,
    `Risk $${wager.riskUsd.toLocaleString()} / win $${wager.toWinUsd.toLocaleString()} · CLV ${
      wager.clvCents === null ? "—" : `${wager.clvCents}¢`
    }`,
    `Directive: ${wager.operatorDirective} · cap $${wager.maxRecommendedStake.toLocaleString()}`,
    `Channel: ${wagerChannelLabel(wager)} · regime ${inferTicketInspectorRegime(wager)}`,
    tax
      ? `Shadow slice: ${tax.sport} → ${tax.subSport} · market ${inferMarketKindFromBetType(wager.betType)}`
      : "Shadow slice: unmapped",
    "autoExecute: false",
  ];
  return lines.join("\n");
}

export function ticketPtyFindSportCommand(
  subSport: string | null | undefined,
): string {
  const key = (subSport ?? "").trim().toLowerCase();
  if (key === "") {
    return "find -s nfl";
  }
  return `find -s ${key}`;
}

export function americanOddsImpliedProbability(
  oddsAmerican: string,
): number | null {
  const trimmed = oddsAmerican.trim().replace(/,/g, "");
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n === 0) {
    return null;
  }
  if (n > 0) {
    return 100 / (n + 100);
  }
  return -n / (-n + 100);
}

/** Book hold % on this ticket's quoted prices (risk vs to-win), not slice hold. */
export function ticketQuotedHoldPct(
  riskUsd: number,
  toWinUsd: number,
): number | null {
  if (riskUsd <= 0 || toWinUsd <= 0) {
    return null;
  }
  const payout = riskUsd + toWinUsd;
  return Number((((payout - toWinUsd) / payout) * 100).toFixed(2));
}

export function formatImpliedProbability(oddsAmerican: string): string {
  const p = americanOddsImpliedProbability(oddsAmerican);
  if (p === null) {
    return "—";
  }
  return `${(p * 100).toFixed(1)}%`;
}

export function ticketPtyProfileCommand(customerId: string): string {
  return `profile ${customerId} --radar`;
}

export function ticketPtyWagersCommand(customerId: string): string {
  return `profile ${customerId} --wagers`;
}

export function ticketPtyFindCommand(customerId: string): string {
  return `find ${customerId}`;
}

export function inferMarketKindFromBetType(betType: string): string {
  const t = betType.toLowerCase();
  if (t.includes("total")) {
    return "total";
  }
  if (t.includes("spread") || t.includes("handicap")) {
    return "spread";
  }
  if (t.includes("money") || t === "ml") {
    return "moneyline";
  }
  if (t.includes("prop")) {
    return "player_prop";
  }
  return "other";
}
