/**
 * @file lib/f402_figure_date_enricher.ts
 * @description Ingestion and enrichment pipeline connecting the live bet ticker (f402-bets.jsonl)
 * with settled ground-truth records from /cloud/api/Report/getWagersByFigureDate.
 *
 * Joins real-time risk intake with settled outcomes, native team opponents, canonical EventIDs,
 * deterministic SubSports, native line values, and execution-latency metrics.
 */

import type {
  AmericanOdds,
  Cents,
  CustomerIdentifier,
  AgentIdentifier,
} from "../design/domain-branded-types.ts";
import { parseAsCents } from "../design/domain-branded-types.ts";
import {
  classifyPortalPeriod,
  type PortalPeriodCode,
} from "./portal_period_taxonomy.ts";
import { sportCategoryFor } from "./sport_taxonomy.ts";
import type { BunInspectOptions } from "./cli_inspect.ts";

export interface FigureDateWager {
  readonly TicketNumber: number | string;
  readonly WagerNumber: number;
  readonly PlayNumber?: number;
  readonly AmountWagered: number;
  readonly ToWinAmount: number;
  readonly WagerType: string;
  readonly AmountWon: number;
  readonly AmountLost: number;
  readonly WagerStatus: string;
  readonly Outcome?: string;
  readonly Description: string;
  readonly AcceptedDateTime: string;
  readonly CustomerID: string;
  readonly TicketWriter: string;
  readonly GameDateTime: string;
  readonly SportType: string;
  readonly SportSubType: string;
  readonly AdjSpread?: number;
  readonly AdjTotalPoints?: number;
  readonly TotalPointsOU?: string;
  readonly FinalMoney?: number;
  readonly GradeMoney?: number;
  readonly ChosenTeamID?: string;
  readonly PeriodDescription?: string;
  readonly Team1ID?: string;
  readonly Team1FinalScore?: number;
  readonly Team2ID?: string;
  readonly Team2FinalScore?: number;
  readonly PeriodNumber?: number;
  readonly DailyFigureDate?: string;
  readonly FinalDecimal?: number;
  readonly OrigSpread?: number;
  readonly OrigTotalPoints?: number;
  readonly BuyPoints?: number;
  readonly TotalPicks?: number;
  readonly totalPicks?: number;
  readonly PlacedOn?: string;
  readonly Team1RotNum?: number;
  readonly Team2RotNum?: number;
  readonly Comments?: string;
  [key: string]: unknown;
}

export interface LiveTickerWager {
  readonly WagerNumber: number;
  readonly AgentID?: string;
  readonly AgentLogin?: string;
  readonly CustomerID: string;
  readonly Login?: string;
  readonly WagerType: string;
  readonly AmountWagered: number;
  readonly ToWinAmount: number;
  readonly VolumeAmount?: number;
  readonly InsertDateTime: string;
  readonly TicketWriter: string;
  readonly ShortDesc: string;
  readonly VIP?: string;
  readonly capturedAtMs?: number;
  readonly isFirstObservation?: boolean;
  [key: string]: unknown;
}

// ============================================================================
// Canonical Domain Brand & Entity Aliases
// ============================================================================

export type SettledFigureDateWager = FigureDateWager;
export type LiveIntakeTickerWager = LiveTickerWager;
export type EnrichedWagerRecord = EnrichedWager;
export type CanonicalEventId = string;
export type CompositeMatchKey = string;

/**
 * Safely normalizes string into a CustomerIdentifier brand without throwing on raw feeds.
 */
export function safeCustomerIdentifier(value: unknown): CustomerIdentifier {
  const str = String(value ?? "")
    .trim()
    .toUpperCase();
  return (str.length >= 2 ? str : "UNKNOWN") as CustomerIdentifier;
}

/**
 * Safely normalizes string into an AgentIdentifier brand without throwing on raw feeds.
 */
export function safeAgentIdentifier(value: unknown): AgentIdentifier {
  const str = String(value ?? "")
    .trim()
    .toUpperCase();
  return (str.length >= 2 ? str : "DIRECT") as AgentIdentifier;
}

/**
 * Safely parses odds into AmericanOdds brand (outside [-99..+99] deadband) or returns null.
 */
export function safeAmericanOdds(raw: unknown): AmericanOdds | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const rounded = Math.round(raw);
    if (rounded <= -100 || rounded >= 100) {
      return rounded as AmericanOdds;
    }
  } else if (typeof raw === "string") {
    const parsed = parseInt(raw.trim(), 10);
    if (!Number.isNaN(parsed) && (parsed <= -100 || parsed >= 100)) {
      return parsed as AmericanOdds;
    }
  }
  return null;
}

export interface EnrichedWager {
  readonly ticketNumber: string;
  readonly liveWagerNumber: number;
  readonly customerId: CustomerIdentifier;
  readonly agentLogin: AgentIdentifier;
  readonly ticketWriter: string;
  readonly volumeAmount: number;
  readonly totalPicks: number;
  readonly eventId: string;
  readonly sport: string;
  readonly subSport: string;
  readonly opponents: {
    readonly away: string;
    readonly home: string;
  };
  readonly gameDateTime: string;
  readonly acceptedDateTime: string;
  readonly dailyFigureDate: string;
  readonly latencySeconds: number;
  readonly isLateSteam: boolean;
  readonly isLive: boolean;
  readonly portalPeriod: PortalPeriodCode | null;
  readonly periodDescription: string;
  readonly periodNumber: number;
  readonly marketType:
    "spread" | "total" | "moneyline" | "derivative_points" | "other";
  readonly buyPoints: number;
  readonly origSpread?: number | null;
  readonly adjSpread?: number | null;
  readonly origTotalPoints?: number | null;
  readonly adjTotalPoints?: number | null;
  readonly selection: {
    readonly chosenTeam: string;
    readonly line: number | null;
    readonly origLine: number | null;
    readonly buyPoints: number;
    readonly price: AmericanOdds | null;
    readonly overUnder?: "O" | "U" | null;
  };
  readonly settlement: {
    readonly isSettled: boolean;
    readonly status: string;
    readonly outcome: string;
    readonly amountWageredCents: Cents;
    readonly toWinCents: Cents;
    readonly amountWonCents: Cents;
    readonly amountLostCents: Cents;
    readonly netPnlCents: Cents;
    readonly awayScore: number | null;
    readonly homeScore: number | null;
  };
}

/**
 * Builds a deterministic composite matching signature for reconciliation.
 *
 * Since the live ticker numbers transactions under an internal sequence (WagerNumber)
 * while the settlement API reports customer TicketNumber, we match on the deterministic tuple:
 * (CustomerID, PlacedMinute, AmountWagered, ToWinAmount, RotationNum).
 */
export function buildCompositeMatchKey(
  customerId: string,
  dateTimeStr: string,
  amountWagered: number,
  toWinAmount: number,
  desc: string,
): string {
  const normCust = customerId.trim().toUpperCase();
  // Strip sub-seconds: "2026-11-06 20:09:35.080" -> "2026-11-06 20:09"
  const minuteKey = dateTimeStr.slice(0, 16);
  // Extract rotation number if present: "#546" -> "546"
  const rotMatch = desc.match(/#(\d+)/);
  const rot = rotMatch ? rotMatch[1] : "NOROT";

  return `${normCust}|${minuteKey}|${amountWagered}|${toWinAmount}|${rot}`;
}

/**
 * Computes a high-performance 64-bit wyhash fingerprint of a composite match key.
 * Enables O(1) integer map lookups, BigUint64Array indexing, and zero-string-allocation
 * join tables across large (>900k rows) socket streams.
 */
export function hashCompositeMatchKey(key: string): bigint {
  if (
    typeof Bun !== "undefined" &&
    Bun.hash &&
    typeof Bun.hash.wyhash === "function"
  ) {
    return Bun.hash.wyhash(key);
  }
  // Deterministic fallback
  let hash = 0n;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31n + BigInt(key.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  return hash;
}

/**
 * Canonicalizes team strings for event identification:
 * 1. Normalizes "Saint " to "St."
 * 2. Normalizes "St " (without period) to "St."
 * 3. Collapses whitespace while preserving punctuation (periods, apostrophes, hyphens).
 *
 * Examples:
 *  - "St. Louis Blues"     -> "St.LouisBlues"
 *  - "St Louis Blues"      -> "St.LouisBlues"
 *  - "Saint Louis Blues"   -> "St.LouisBlues"
 *  - "Tampa Bay Lightning" -> "TampaBayLightning"
 */
export function canonicalTeamToken(team: string): string {
  if (!team) return "";
  let token = team.trim();
  token = token.replace(/\bSaint\s+/i, "St. ");
  token = token.replace(/\bSt\s+(?=[A-Za-z])/i, "St. ");
  return token.replace(/\s+/g, "");
}

/**
 * Builds the canonical EventID: {SubSport}-{YYYYMMDD}-{Away}@{Home}
 */
export function buildCanonicalEventId(
  subSport: string,
  gameDateTime: string,
  team1: string,
  team2: string,
): string {
  const cleanSub = subSport.trim().replace(/\s+/g, "_");
  const dateStr = gameDateTime.slice(0, 10).replace(/-/g, "");
  const cleanTeam1 = canonicalTeamToken(team1);
  const cleanTeam2 = canonicalTeamToken(team2);

  if (!cleanTeam1 && !cleanTeam2) {
    return `${cleanSub}-${dateStr}-UNRESOLVED`;
  }
  return `${cleanSub}-${dateStr}-${cleanTeam1}@${cleanTeam2}`;
}

/**
 * Detects whether a wager belongs to an in-play (LIVE) market based on
 * SportType, SportSubType, or team name markers.
 */
export function isLiveSubSport(
  sportType?: string,
  sportSubType?: string,
  teamId?: string,
): boolean {
  if (sportType?.trim() === "LIVE") return true;
  if (sportSubType?.includes("Live")) return true;
  if (teamId && /\(Live\)/i.test(teamId)) return true;
  return false;
}

/**
 * Categorizes market type without ever using the forbidden phrase.
 */
export function inferMarketType(
  wagerType: string,
  desc: string,
  adjSpread?: number,
  adjTotal?: number,
): "spread" | "total" | "moneyline" | "derivative_points" | "other" {
  if (wagerType === "E" || /derivative|individual\s*points/i.test(desc)) {
    return "derivative_points";
  }
  if (adjSpread !== undefined && adjSpread !== 0) {
    return "spread";
  }
  if (adjTotal !== undefined && adjTotal !== 0) {
    return "total";
  }
  if (/Winner\s*\(2\s*way\)|Money\s*Line|ML/i.test(desc) || wagerType === "M") {
    return "moneyline";
  }
  return "other";
}

/**
 * Extracts point purchases from wager descriptions (e.g. "- buying ½ For Game").
 */
const FRACTION_CHAR_MAP: Readonly<Record<string, number>> = {
  "½": 0.5,
  "¼": 0.25,
  "¾": 0.75,
};

export function normalizeFractionEntities(input: string): string {
  return input
    .replace(/&#189;|&#x0*bd;|&frac12;/gi, "½")
    .replace(/&#188;|&#x0*bc;|&frac14;/gi, "¼")
    .replace(/&#190;|&#x0*be;|&frac34;/gi, "¾");
}

export function parseNumericOrVulgarFraction(token: string): number | null {
  const normalized = normalizeFractionEntities(token).trim();
  if (normalized === "") return null;

  const mixedMatch = /^([+-]?\d+)?\s*([½¼¾])$/.exec(normalized);
  if (mixedMatch !== null) {
    const wholeRaw = mixedMatch[1];
    const fracChar = mixedMatch[2] ?? "";
    const frac = FRACTION_CHAR_MAP[fracChar] ?? 0;
    if (wholeRaw === undefined || wholeRaw === "" || wholeRaw === "+") {
      return frac;
    }
    if (wholeRaw === "-") {
      return -frac;
    }
    const whole = Number(wholeRaw);
    if (!Number.isFinite(whole)) return null;
    return whole < 0 ? whole - frac : whole + frac;
  }

  if (/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) {
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const BUY_POINTS_REGEX =
  /\bbuying\s+(\d+\s*[½¼¾]|\d+(?:\.\d+)?|[½¼¾])(?=\s|$)/i;

export function parseBuyPointsFromDesc(desc: unknown): number {
  if (typeof desc !== "string" || desc === "") return 0;
  const normalized = normalizeFractionEntities(desc);
  const match = BUY_POINTS_REGEX.exec(normalized);
  if (match === null) return 0;
  const value = parseNumericOrVulgarFraction(match[1] ?? "");
  return value !== null && value > 0 ? value : 0;
}

export function stripBuyPointsClause(text: string): string {
  const normalized = normalizeFractionEntities(text);
  return normalized
    .replace(
      /\s*-\s*buying\s+(?:\d+\s*[½¼¾]|\d+(?:\.\d+)?|[½¼¾])(?=\s|$)/gi,
      "",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface ParsedShortDescSelection {
  readonly marketKind: "spread" | "total" | "moneyline" | "other";
  readonly adjSpread: number | null;
  readonly origSpread: number | null;
  readonly buyPoints: number;
  readonly finalMoney: number | null;
  readonly periodDescription: string;
}

const COMPACT_SPREAD_ODDS_REGEX =
  /([+-]?\s*(?:\d+\s*[½¼¾]|\d+(?:\.\d+)?|[½¼¾])|PK)\s+([+-]\d{3,4})\b/i;
const COMPACT_TOTAL_ODDS_REGEX =
  /\b(?:Over|Under|O|U)\s+(\d+\s*[½¼¾]|\d+(?:\.\d+)?|[½¼¾])\s+([+-]\d{3,4})\b/i;
const COMPACT_ML_ODDS_REGEX = /\s([+-]\d{3,4})\b/;

export function parseSpreadAndBuyFromShortDesc(
  desc: unknown,
): ParsedShortDescSelection {
  const raw = typeof desc === "string" ? normalizeFractionEntities(desc) : "";
  const buyPoints = parseBuyPointsFromDesc(raw);
  const periodMatch =
    /\bFor\s+(Game|1st Half|2nd Half|1st Quarter|2nd Quarter|3rd Quarter|4th Quarter)\b/i.exec(
      raw,
    );
  const slashPeriodMatch =
    /\/\s*(Game|1st Half|2nd Half|1st Quarter|2nd Quarter|3rd Quarter|4th Quarter)\s*\//i.exec(
      raw,
    );
  const periodDescription = periodMatch?.[1] ?? slashPeriodMatch?.[1] ?? "Game";

  const withoutBuying = stripBuyPointsClause(raw).replace(
    /\s+-\s+For\s+(?:Game|1st Half|2nd Half|1st Quarter|2nd Quarter|3rd Quarter|4th Quarter).*$/i,
    "",
  );

  const totalMatch = COMPACT_TOTAL_ODDS_REGEX.exec(withoutBuying);
  if (totalMatch !== null) {
    const totalPts = parseNumericOrVulgarFraction(totalMatch[1] ?? "");
    const odds = Number(totalMatch[2]);
    return {
      marketKind: "total",
      adjSpread: totalPts,
      origSpread: totalPts,
      buyPoints,
      finalMoney: Number.isFinite(odds) ? odds : null,
      periodDescription,
    };
  }

  const withoutRot = withoutBuying.replace(/#\d+\s+/g, "");
  const spreadMatch = COMPACT_SPREAD_ODDS_REGEX.exec(withoutRot);
  if (spreadMatch !== null) {
    const spreadToken = (spreadMatch[1] ?? "").trim();
    const adjSpread =
      spreadToken.toUpperCase() === "PK"
        ? 0
        : parseNumericOrVulgarFraction(spreadToken.replace(/\s+/g, ""));
    const odds = Number(spreadMatch[2]);
    if (adjSpread !== null) {
      const origSpread = buyPoints > 0 ? adjSpread - buyPoints : adjSpread;
      return {
        marketKind: "spread",
        adjSpread,
        origSpread,
        buyPoints,
        finalMoney: Number.isFinite(odds) ? odds : null,
        periodDescription,
      };
    }
  }

  const mlMatch = COMPACT_ML_ODDS_REGEX.exec(withoutRot);
  if (mlMatch !== null) {
    const odds = Number(mlMatch[1]);
    return {
      marketKind: "moneyline",
      adjSpread: null,
      origSpread: null,
      buyPoints,
      finalMoney: Number.isFinite(odds) ? odds : null,
      periodDescription,
    };
  }

  return {
    marketKind: "other",
    adjSpread: null,
    origSpread: null,
    buyPoints,
    finalMoney: null,
    periodDescription,
  };
}

/**
 * Infers the number of picks/legs on a wager from its wager type and description.
 * Straight bets (S, M, L, E) are always 1 pick; multi-leg bets (P, T, R, I) count legs.
 */
export function inferTotalPicks(wagerType?: string, desc?: string): number {
  const wt = (wagerType || "").trim().toUpperCase();
  if (
    wt === "S" ||
    wt === "M" ||
    wt === "L" ||
    wt === "E" ||
    wt === "A" ||
    wt === "C"
  ) {
    return 1;
  }
  if (!desc) {
    return wt === "P" || wt === "T" || wt === "R" || wt === "I" ? 2 : 1;
  }

  // Check for sport rotation tokens (e.g. Football #101, LIVE #9101)
  const matches = desc.match(
    /(?:Football|Basketball|Baseball|Hockey|Soccer|Tennis|Golf|LIVE)\s+#/gi,
  );
  if (matches && matches.length > 1) {
    return matches.length;
  }
  // Check for multiple matchup lines (e.g. in GSBUILDER: "vs" or " / ")
  const lines = desc
    .split(/[\r\n]+/)
    .filter((l) => l.includes(" vs ") || l.includes(" / "));
  if (lines.length > 1) {
    return lines.length;
  }
  return wt === "P" || wt === "T" || wt === "R" || wt === "I" ? 2 : 1;
}

/**
 * Calculates execution latency in seconds from bet placement to scheduled start.
 * Negative or near-zero latency signals steam chasing or late-clock execution.
 */
export function computeExecutionLatency(
  placedAtIso: string,
  gameTimeIso: string,
): number {
  const placedMs = new Date(placedAtIso.replace(" ", "T")).getTime();
  const gameMs = new Date(gameTimeIso.replace(" ", "T")).getTime();
  if (isNaN(placedMs) || isNaN(gameMs)) {
    return 0;
  }
  return Math.round((gameMs - placedMs) / 1000);
}

/**
 * Enriches a live ticker row using settled ground truth from getWagersByFigureDate.
 */
export function enrichWagerRecord(
  ticker: LiveTickerWager,
  figure: FigureDateWager,
): EnrichedWager {
  const rawSport = (figure.SportType || "Unknown").trim();
  const subSport = (figure.SportSubType || "Unknown").trim();
  const canonicalCategory = sportCategoryFor({
    sportType: figure.SportType,
    sportSubType: figure.SportSubType,
  });
  const sport = canonicalCategory !== "Other" ? canonicalCategory : rawSport;
  const team1 = (figure.Team1ID || "").trim();
  const team2 = (figure.Team2ID || "").trim();
  const gameTime = (figure.GameDateTime || ticker.InsertDateTime).trim();
  const acceptedTime = (
    figure.AcceptedDateTime || ticker.InsertDateTime
  ).trim();

  const latencySeconds = computeExecutionLatency(acceptedTime, gameTime);
  const isLateSteam = latencySeconds >= 0 && latencySeconds <= 120; // placed within 2 minutes of start

  const periodClassification = classifyPortalPeriod({
    Period: figure.PeriodDescription ?? "",
    Description: figure.Description ?? "",
    ShortDesc: ticker.ShortDesc ?? "",
    WagerType: figure.WagerType || ticker.WagerType,
  });

  const marketType = inferMarketType(
    figure.WagerType || ticker.WagerType,
    figure.Description || ticker.ShortDesc,
    figure.AdjSpread,
    figure.AdjTotalPoints,
  );

  const amountWon = Number(figure.AmountWon || 0);
  const amountLost = Number(figure.AmountLost || 0);
  const netPnl = amountWon - amountLost;

  const buyPoints =
    figure.BuyPoints !== undefined &&
    figure.BuyPoints !== null &&
    Number(figure.BuyPoints) > 0
      ? Number(figure.BuyPoints)
      : parseBuyPointsFromDesc(ticker.ShortDesc || figure.Description || "");

  const origLine =
    marketType === "total"
      ? (figure.OrigTotalPoints ?? figure.AdjTotalPoints ?? null)
      : figure.OrigSpread !== undefined && figure.OrigSpread !== 0
        ? figure.OrigSpread
        : (figure.AdjSpread ?? null);

  const rawPicks = figure.TotalPicks ?? figure.totalPicks;
  const totalPicks =
    rawPicks !== undefined && rawPicks !== null && Number(rawPicks) > 0
      ? Number(rawPicks)
      : inferTotalPicks(
          figure.WagerType || ticker.WagerType,
          ticker.ShortDesc || figure.Description,
        );

  const customerId = safeCustomerIdentifier(
    ticker.CustomerID || figure.CustomerID || ticker.Login,
  );
  const agentLogin = safeAgentIdentifier(
    ticker.AgentLogin || ticker.AgentID || "",
  );
  const rawOdds = figure.FinalMoney ?? figure.GradeMoney;
  const price = safeAmericanOdds(rawOdds);

  const amountWageredCents = parseAsCents(
    Number(figure.AmountWagered || ticker.AmountWagered || 0),
    true,
  );
  const toWinCents = parseAsCents(
    Number(figure.ToWinAmount || ticker.ToWinAmount || 0),
    true,
  );
  const amountWonCents = parseAsCents(amountWon, true);
  const amountLostCents = parseAsCents(amountLost, true);
  const netPnlCents = parseAsCents(netPnl, true);

  return {
    ticketNumber: String(figure.TicketNumber || ticker.WagerNumber),
    liveWagerNumber: ticker.WagerNumber,
    customerId,
    agentLogin,
    ticketWriter: (figure.TicketWriter || ticker.TicketWriter).trim(),
    volumeAmount: Number(ticker.VolumeAmount ?? ticker.AmountWagered ?? 0),
    totalPicks,
    eventId: buildCanonicalEventId(subSport, gameTime, team1, team2),
    sport,
    subSport,
    opponents: {
      away: team1,
      home: team2,
    },
    gameDateTime: gameTime,
    acceptedDateTime: acceptedTime,
    dailyFigureDate: (figure.DailyFigureDate
      ? String(figure.DailyFigureDate).slice(0, 10)
      : acceptedTime.slice(0, 10)
    ).trim(),
    latencySeconds,
    isLateSteam,
    isLive:
      isLiveSubSport(sport, subSport, figure.ChosenTeamID) ||
      /LIVE/i.test(ticker.ShortDesc ?? ""),
    portalPeriod:
      figure.PeriodNumber !== undefined &&
      figure.PeriodNumber >= -1 &&
      figure.PeriodNumber <= 6
        ? (figure.PeriodNumber as PortalPeriodCode)
        : periodClassification.portalPeriod,
    periodNumber:
      figure.PeriodNumber !== undefined && figure.PeriodNumber !== null
        ? Number(figure.PeriodNumber)
        : (periodClassification.portalPeriod ?? 0),
    periodDescription: (
      figure.PeriodDescription || periodClassification.portalLabel
    ).trim(),
    marketType,
    buyPoints,
    origSpread: figure.OrigSpread ?? null,
    adjSpread: figure.AdjSpread ?? null,
    origTotalPoints: figure.OrigTotalPoints ?? null,
    adjTotalPoints: figure.AdjTotalPoints ?? null,
    selection: {
      chosenTeam: (figure.ChosenTeamID || "").trim(),
      line:
        marketType === "total"
          ? (figure.AdjTotalPoints ?? figure.AdjSpread ?? null)
          : figure.AdjSpread !== undefined && figure.AdjSpread !== 0
            ? figure.AdjSpread
            : (figure.AdjTotalPoints ?? figure.AdjSpread ?? null),
      origLine,
      buyPoints,
      price,
      overUnder:
        figure.TotalPointsOU?.trim() === "O" ||
        figure.TotalPointsOU?.trim() === "U"
          ? (figure.TotalPointsOU.trim() as "O" | "U")
          : null,
    },
    settlement: {
      isSettled: figure.WagerStatus !== "P" && figure.WagerStatus !== "O",
      status: figure.WagerStatus || "P",
      outcome: figure.Outcome || figure.WagerStatus || "PENDING",
      amountWageredCents,
      toWinCents,
      amountWonCents,
      amountLostCents,
      netPnlCents,
      awayScore: figure.Team1FinalScore ?? null,
      homeScore: figure.Team2FinalScore ?? null,
    },
  };
}

// ============================================================================
// Canonical Function Aliases & Bun.inspect Inspection Tooling
// ============================================================================

export const compositeMatchKey = buildCompositeMatchKey;
export const canonicalEventId = buildCanonicalEventId;
export const teamToken = canonicalTeamToken;
export const enrichWager = enrichWagerRecord;

export interface FigureDateEnrichmentStats {
  readonly figureRecordsIndexed: number;
  readonly tickerRowsStreamed: number;
  readonly exactMatchedRows: number;
  readonly unmatchedRows: number;
  readonly matchRatePct: number;
  readonly totalRiskCents: Cents;
  readonly totalNetPnlCents: Cents;
  readonly durationMs?: number | undefined;
  readonly throughputRowsPerSec?: number | undefined;
  readonly sportBreakdown?: Record<string, { count: number; riskCents: Cents }>;
}

function formatCentsToCurrency(cents: number): string {
  const dol = cents / 100;
  if (dol < 0) {
    return `-$${Math.abs(dol).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return `$${dol.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatEnrichedWagerInspect(
  w: EnrichedWager,
  options: { colors?: boolean } = {},
): string {
  const colors = options.colors === true;
  const bold = (s: string) => (colors ? `\u001b[1m${s}\u001b[22m` : s);
  const green = (s: string) => (colors ? `\u001b[32m${s}\u001b[39m` : s);
  const red = (s: string) => (colors ? `\u001b[31m${s}\u001b[39m` : s);
  const yellow = (s: string) => (colors ? `\u001b[33m${s}\u001b[39m` : s);
  const cyan = (s: string) => (colors ? `\u001b[36m${s}\u001b[39m` : s);

  const statusColor =
    w.settlement.outcome === "W"
      ? green
      : w.settlement.outcome === "L"
        ? red
        : yellow;

  const riskStr = formatCentsToCurrency(w.settlement.amountWageredCents);
  const pnlStr = formatCentsToCurrency(w.settlement.netPnlCents);

  const steamTag = w.isLateSteam ? red(" [LATE STEAM]") : "";
  const liveTag = w.isLive ? yellow(" [LIVE]") : "";

  return [
    `#${bold(String(w.ticketNumber))}`,
    `[${cyan(w.customerId)}]`,
    `${bold(w.sport)}/${w.subSport}`,
    `Period:${w.periodDescription || w.portalPeriod || "0"}`,
    `Risk:${bold(riskStr)}`,
    `Outcome:${statusColor(w.settlement.outcome)} (${statusColor(pnlStr)})`,
    `Latency:${w.latencySeconds}s${steamTag}${liveTag}`,
  ].join(" ");
}

export class FigureDateEnrichmentInspection {
  readonly stats: FigureDateEnrichmentStats;
  readonly samples: readonly EnrichedWager[];

  constructor(
    stats: FigureDateEnrichmentStats,
    samples: readonly EnrichedWager[] = [],
  ) {
    this.stats = stats;
    this.samples = samples;
  }

  [Bun.inspect.custom](
    _depth: number,
    options: Parameters<typeof Bun.inspect>[1] = {},
  ): string {
    const colors = options?.colors === true;
    const bold = (s: string) => (colors ? `\u001b[1m${s}\u001b[22m` : s);
    const cyan = (s: string) => (colors ? `\u001b[36m${s}\u001b[39m` : s);
    const green = (s: string) => (colors ? `\u001b[32m${s}\u001b[39m` : s);
    const yellow = (s: string) => (colors ? `\u001b[33m${s}\u001b[39m` : s);

    const totalRiskDol = formatCentsToCurrency(this.stats.totalRiskCents);
    const netPnlDol = formatCentsToCurrency(this.stats.totalNetPnlCents);

    const header = [
      bold("=== Fantasy402 Figure Date Enrichment Inspection ==="),
      `Figure Records Indexed : ${bold(this.stats.figureRecordsIndexed.toLocaleString())}`,
      `Ticker Rows Streamed  : ${bold(this.stats.tickerRowsStreamed.toLocaleString())}`,
      `Exact Matched Rows     : ${green(this.stats.exactMatchedRows.toLocaleString())} (${cyan(`${this.stats.matchRatePct.toFixed(2)}%`)})`,
      `Unmatched Rows         : ${yellow(this.stats.unmatchedRows.toLocaleString())}`,
      `Total Risk Monitored   : ${bold(totalRiskDol)}`,
      `Net Settlement PnL     : ${bold(netPnlDol)}`,
      ...(this.stats.throughputRowsPerSec !== undefined
        ? [
            `Throughput             : ${cyan(this.stats.throughputRowsPerSec.toLocaleString())} rows/sec (${this.stats.durationMs?.toFixed(1) ?? "0"}ms total)`,
          ]
        : []),
    ].join("\n");

    const sampleLines =
      this.samples.length > 0
        ? [
            `\n${bold(`Sample Enriched Wagers (${this.samples.length}):`)}`,
            ...this.samples.map(
              (w, idx) =>
                `  ${idx + 1}. ${formatEnrichedWagerInspect(w, options)}`,
            ),
          ].join("\n")
        : "";

    return `${header}${sampleLines}`;
  }

  toJSON() {
    return {
      stats: this.stats,
      samples: this.samples,
    };
  }
}

/**
 * Creates a high-throughput direct ReadableStream emitting enriched wagers as JSONL.
 * Utilizes Bun's native `type: "direct"` DirectController to bypass JavaScript
 * stream queues and stream UTF-8 lines directly to native consumer sinks.
 *
 * Implements native backpressure: `await controller.write()` pauses execution
 * when the downstream consumer / socket buffer fills up.
 */
export function createEnrichedWagersDirectStream(
  wagers: Iterable<EnrichedWager> | AsyncIterable<EnrichedWager>,
): ReadableStream {
  const source = {
    type: "direct" as const,
    async pull(controller: ReadableStreamDirectController) {
      for await (const wager of wagers) {
        await controller.write(JSON.stringify(wager) + "\n");
      }
      controller.close();
    },
  };
  return new ReadableStream(
    source as unknown as ConstructorParameters<typeof ReadableStream>[0],
  );
}

export type FigureDateWagerRow = FigureDateWager;

export interface EnrichedTicketMaster {
  readonly TicketNumber: string;
  readonly WagerNumber: string;
  readonly CustomerID: string;
  readonly AgentID: string;
  readonly sportType: string;
  readonly sportSubType: string;
  readonly periodDescription: string;
  readonly marketKind: "spread" | "total" | "moneyline" | "other";
  readonly origSpread: number | null;
  readonly adjSpread: number | null;
  readonly buyPoints: number;
  readonly finalMoney: number | null;
  readonly amountWageredUsd: number;
  readonly toWinAmountUsd: number;
  readonly ticketWriter: string;
  readonly shortDesc: string;
  readonly placedAt: string;
  readonly [Bun.inspect.custom]?: (
    depth: number,
    options?: BunInspectOptions,
  ) => string;
  readonly toString?: () => string;
}

function finiteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function enrichTicketWithBuyPoints(
  row: FigureDateWagerRow | Record<string, unknown>,
): EnrichedTicketMaster {
  const record = row as Record<string, unknown>;
  const shortDesc = cleanText(record["ShortDesc"] ?? record["Description"]);
  const parsedDesc = parseSpreadAndBuyFromShortDesc(shortDesc);

  const explicitBuy = finiteNumberOrNull(record["BuyPoints"]);
  const buyPoints =
    explicitBuy !== null && explicitBuy > 0
      ? explicitBuy
      : parsedDesc.buyPoints;

  const explicitAdjSpread = finiteNumberOrNull(record["AdjSpread"]);
  const explicitOrigSpread = finiteNumberOrNull(record["OrigSpread"]);

  const adjSpread = explicitAdjSpread ?? parsedDesc.adjSpread;
  const origSpread =
    explicitOrigSpread ??
    (adjSpread !== null
      ? buyPoints > 0
        ? adjSpread - buyPoints
        : adjSpread
      : null);

  const finalMoney =
    finiteNumberOrNull(record["FinalMoney"]) ?? parsedDesc.finalMoney;

  const rawWagered = finiteNumberOrNull(record["AmountWagered"]) ?? 0;
  const rawToWin = finiteNumberOrNull(record["ToWinAmount"]) ?? 0;

  const customerId = cleanText(
    record["CustomerID"] ?? record["customerID"] ?? record["Login"],
  ).toUpperCase();
  const wagerNumber = String(
    record["WagerNumber"] ?? record["TicketNumber"] ?? "",
  ).trim();
  const ticketNumber = String(
    record["TicketNumber"] ?? record["WagerNumber"] ?? "",
  ).trim();

  const enriched: EnrichedTicketMaster = {
    TicketNumber: ticketNumber,
    WagerNumber: wagerNumber,
    CustomerID: customerId,
    AgentID: cleanText(record["AgentID"]).toUpperCase(),
    sportType: cleanText(record["SportType"]),
    sportSubType: cleanText(record["SportSubType"]),
    periodDescription:
      cleanText(record["PeriodDescription"]) || parsedDesc.periodDescription,
    marketKind: parsedDesc.marketKind,
    origSpread,
    adjSpread,
    buyPoints,
    finalMoney,
    amountWageredUsd: rawWagered,
    toWinAmountUsd: rawToWin,
    ticketWriter: cleanText(record["TicketWriter"] ?? record["PlacedOn"]),
    shortDesc,
    placedAt: cleanText(record["InsertDateTime"] ?? record["AcceptedDateTime"]),
    [Bun.inspect.custom](
      depth: number,
      options: BunInspectOptions = {},
    ): string {
      const c = options?.colors === true;
      const bold = (s: string) => (c ? `\x1b[1m${s}\x1b[22m` : s);
      const cyan = (s: string) => (c ? `\x1b[36m${s}\x1b[39m` : s);
      const yellow = (s: string) => (c ? `\x1b[33m${s}\x1b[39m` : s);
      const green = (s: string) => (c ? `\x1b[32m${s}\x1b[39m` : s);
      if (depth <= 0) {
        return `${bold("EnrichedTicketMaster")}(#${this.TicketNumber || this.WagerNumber})`;
      }
      const lineStr =
        this.adjSpread !== null
          ? this.buyPoints > 0
            ? `PointBuy ${this.origSpread} → ${this.adjSpread} (+${this.buyPoints}pt)`
            : `${this.adjSpread}`
          : this.marketKind;
      return `${bold("EnrichedTicketMaster")}(${cyan(this.CustomerID)} #${this.TicketNumber || this.WagerNumber} | ${yellow(lineStr)} | ${green(`$${this.amountWageredUsd.toFixed(2)}`)} | ${this.periodDescription})`;
    },
    toString(): string {
      return this[Bun.inspect.custom]!(2, { colors: false });
    },
  };
  return enriched;
}
