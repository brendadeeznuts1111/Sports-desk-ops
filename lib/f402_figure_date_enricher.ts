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
import {
  buildManagerWagersByFigureDatePayload,
  type ManagerWagersByFigureDatePayload,
} from "./f402_probe.ts";

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

// ============================================================================
// Pre/Post-Bet Line-Movement Window & Slice Customer P&L Leaderboard
// ============================================================================

export interface WagerLineWindow {
  readonly ticketNumber: string;
  readonly customerId: CustomerIdentifier;
  readonly eventId: string;
  readonly portalPeriod: PortalPeriodCode | null;
  readonly marketType: EnrichedWager["marketType"];
  readonly acceptedDateTime: string;
  readonly boardLineBefore: number | null;
  readonly boardLineAtBet: number | null;
  readonly ticketLineAtBet: number | null;
  readonly buyPoints: number;
  readonly boardLineAfter: number | null;
  readonly closingBoardLine: number | null;
  readonly priceBefore: AmericanOdds | null;
  readonly priceAtBet: AmericanOdds | null;
  readonly priceAfter: AmericanOdds | null;
  readonly closingPrice: AmericanOdds | null;
  /** Positive means the board line moved in the bettor's favor on the next distinct line observation. */
  readonly immediateLineMoveDelta: number | null;
  /** Positive means the bettor beat the closing (last observed) board line in the market group. */
  readonly closingLineMoveDelta: number | null;
  /** True when the wager preceded a favorable board move (>= 0.5 pt) or beat the closing line (>= 0.5 pt). */
  readonly beatLineMove: boolean;
  /** Number of wagers observed in the same (eventId, portalPeriod, marketType) market group. */
  readonly marketObservationCount: number;
  /** 1-based chronological sequence index within the market group. */
  readonly sequenceIndex: number;
}

function rawBoardLineOf(w: EnrichedWager): number | null {
  return w.selection.origLine ?? w.selection.line ?? null;
}

function projectBoardLineToTargetFrame(
  source: EnrichedWager,
  target: EnrichedWager,
): number | null {
  const rawSourceLine = rawBoardLineOf(source);
  if (rawSourceLine === null) return null;
  if (target.marketType === "total") {
    return rawSourceLine;
  }
  if (target.marketType === "spread") {
    const srcTeam = canonicalTeamToken(source.selection.chosenTeam);
    const tgtTeam = canonicalTeamToken(target.selection.chosenTeam);
    if (!srcTeam || !tgtTeam || srcTeam === tgtTeam) {
      return rawSourceLine;
    }
    return rawSourceLine === 0 ? 0 : -rawSourceLine;
  }
  return rawSourceLine;
}

function computeLineMoveAdvantage(
  wager: EnrichedWager,
  boardLineAtBet: number | null,
  referenceBoardLine: number | null,
): number | null {
  if (boardLineAtBet === null || referenceBoardLine === null) return null;
  if (wager.marketType === "spread") {
    // In the bettor's team spread convention (e.g. -3.5 -> -4.5 or +4.5 -> +3.5),
    // boardLineAtBet - referenceBoardLine > 0 means the market steamed toward the bettor's side.
    return Number((boardLineAtBet - referenceBoardLine).toFixed(2));
  }
  if (wager.marketType === "total") {
    if (wager.selection.overUnder === "U") {
      return Number((boardLineAtBet - referenceBoardLine).toFixed(2));
    }
    // Over (default): lower total at placement than reference total is positive CLV
    return Number((referenceBoardLine - boardLineAtBet).toFixed(2));
  }
  return null;
}

/**
 * Reconstructs the pre-bet, at-bet, post-bet, and closing board-line trajectory for each wager
 * by grouping wagers on `(eventId, portalPeriod, marketType)` ordered by `acceptedDateTime`.
 *
 * Uses `origLine ?? line` as the board line so point-buying (`buyPoints > 0`) is never
 * misclassified as a market line move.
 */
export function computeWagerLineWindows(
  wagers: readonly EnrichedWager[],
): Map<string, WagerLineWindow> {
  const groups = new Map<string, EnrichedWager[]>();

  for (const w of wagers) {
    if (
      !w.eventId ||
      w.eventId === "UNSETTLED" ||
      w.eventId.endsWith("-UNRESOLVED")
    ) {
      continue;
    }
    const periodKey = w.portalPeriod ?? w.periodNumber ?? 0;
    const groupKey = `${w.eventId}|${periodKey}|${w.marketType}`;
    let bucket = groups.get(groupKey);
    if (!bucket) {
      bucket = [];
      groups.set(groupKey, bucket);
    }
    bucket.push(w);
  }

  const out = new Map<string, WagerLineWindow>();

  for (const bucket of groups.values()) {
    const ordered = [...bucket].sort((a, b) => {
      const cmp = a.acceptedDateTime.localeCompare(b.acceptedDateTime);
      if (cmp !== 0) return cmp;
      return a.ticketNumber.localeCompare(b.ticketNumber);
    });

    const count = ordered.length;
    const lastWager = ordered[count - 1]!;

    for (let i = 0; i < count; i++) {
      const current = ordered[i]!;
      const boardLineAtBet = rawBoardLineOf(current);
      const ticketLineAtBet = current.selection.line;

      let prevWager: EnrichedWager | null = null;
      for (let p = i - 1; p >= 0; p--) {
        const cand = ordered[p]!;
        const projected = projectBoardLineToTargetFrame(cand, current);
        if (
          projected !== boardLineAtBet ||
          cand.selection.price !== current.selection.price
        ) {
          prevWager = cand;
          break;
        }
      }
      if (!prevWager && i > 0) {
        prevWager = ordered[i - 1]!;
      }

      let nextWager: EnrichedWager | null = null;
      for (let n = i + 1; n < count; n++) {
        const cand = ordered[n]!;
        const projected = projectBoardLineToTargetFrame(cand, current);
        if (
          projected !== boardLineAtBet ||
          cand.selection.price !== current.selection.price
        ) {
          nextWager = cand;
          break;
        }
      }
      if (!nextWager && i + 1 < count) {
        nextWager = ordered[i + 1]!;
      }

      const boardLineBefore = prevWager
        ? projectBoardLineToTargetFrame(prevWager, current)
        : null;
      const boardLineAfter = nextWager
        ? projectBoardLineToTargetFrame(nextWager, current)
        : null;
      const closingBoardLine = projectBoardLineToTargetFrame(
        lastWager,
        current,
      );

      const immediateLineMoveDelta = computeLineMoveAdvantage(
        current,
        boardLineAtBet,
        boardLineAfter,
      );
      const closingLineMoveDelta = computeLineMoveAdvantage(
        current,
        boardLineAtBet,
        closingBoardLine,
      );

      const beatLineMove =
        (immediateLineMoveDelta !== null && immediateLineMoveDelta >= 0.5) ||
        (closingLineMoveDelta !== null && closingLineMoveDelta >= 0.5);

      out.set(current.ticketNumber, {
        ticketNumber: current.ticketNumber,
        customerId: current.customerId,
        eventId: current.eventId,
        portalPeriod: current.portalPeriod,
        marketType: current.marketType,
        acceptedDateTime: current.acceptedDateTime,
        boardLineBefore,
        boardLineAtBet,
        ticketLineAtBet,
        buyPoints: current.buyPoints,
        boardLineAfter,
        closingBoardLine,
        priceBefore: prevWager ? prevWager.selection.price : null,
        priceAtBet: current.selection.price,
        priceAfter: nextWager ? nextWager.selection.price : null,
        closingPrice: lastWager.selection.price,
        immediateLineMoveDelta,
        closingLineMoveDelta,
        beatLineMove,
        marketObservationCount: count,
        sequenceIndex: i + 1,
      });
    }
  }

  return out;
}

export type WagerPeriodSliceToken =
  | PortalPeriodCode
  | "FG"
  | "GAME"
  | "1H"
  | "H1"
  | "2H"
  | "H2"
  | "1Q"
  | "Q1"
  | "2Q"
  | "Q2"
  | "3Q"
  | "Q3"
  | "4Q"
  | "Q4";

export interface WagerSliceFilter {
  readonly sport?: string;
  readonly subSport?: string;
  readonly portalPeriod?: WagerPeriodSliceToken;
  readonly isLive?: boolean;
  readonly gsLiveOnly?: boolean;
  readonly marketType?: EnrichedWager["marketType"];
  readonly customerId?: string;
  readonly agentLogin?: string;
}

function resolvePeriodTokenToCode(
  token: WagerPeriodSliceToken,
): PortalPeriodCode | null {
  if (typeof token === "number") return token;
  const up = token.trim().toUpperCase();
  if (up === "FG" || up === "GAME") return 0;
  if (up === "1H" || up === "H1") return 1;
  if (up === "2H" || up === "H2") return 2;
  if (up === "1Q" || up === "Q1") return 3;
  if (up === "2Q" || up === "Q2") return 4;
  if (up === "3Q" || up === "Q3") return 5;
  if (up === "4Q" || up === "Q4") return 6;
  return null;
}

export function isGsLiveTicketWriter(writer: string): boolean {
  return /EZL|LIVEBETTINGCWS|GSLIVE/i.test(writer);
}

/**
 * Evaluates whether an EnrichedWager matches a slice filter (e.g. College Basketball 1st Halves
 * `{ subSport: "NCAAB", portalPeriod: "1H" }` or Live NCAA Basketball `{ subSport: "NCAAB", isLive: true }`).
 */
export function matchesWagerSlice(
  wager: EnrichedWager,
  filter: WagerSliceFilter = {},
): boolean {
  if (filter.sport !== undefined && filter.sport.trim() !== "") {
    if (wager.sport.toUpperCase() !== filter.sport.trim().toUpperCase()) {
      return false;
    }
  }
  if (filter.subSport !== undefined && filter.subSport.trim() !== "") {
    const targetSub = filter.subSport.trim().toUpperCase();
    const wagerSub = wager.subSport.toUpperCase();
    const isCollegeBasketballAlias =
      (targetSub === "NCAAB" || targetSub === "CBB") &&
      (wagerSub.includes("NCAAB") ||
        wagerSub.includes("COLLEGE") ||
        wagerSub.includes("NCAA"));
    if (!wagerSub.includes(targetSub) && !isCollegeBasketballAlias) {
      return false;
    }
  }
  if (filter.portalPeriod !== undefined) {
    const targetCode = resolvePeriodTokenToCode(filter.portalPeriod);
    const wagerCode = wager.portalPeriod ?? wager.periodNumber;
    if (targetCode !== null && wagerCode !== targetCode) {
      return false;
    }
  }
  if (filter.isLive !== undefined && wager.isLive !== filter.isLive) {
    return false;
  }
  if (filter.gsLiveOnly === true) {
    if (!wager.isLive && !isGsLiveTicketWriter(wager.ticketWriter)) {
      return false;
    }
  }
  if (
    filter.marketType !== undefined &&
    wager.marketType !== filter.marketType
  ) {
    return false;
  }
  if (filter.customerId !== undefined && filter.customerId.trim() !== "") {
    if (
      wager.customerId.toUpperCase() !== filter.customerId.trim().toUpperCase()
    ) {
      return false;
    }
  }
  if (filter.agentLogin !== undefined && filter.agentLogin.trim() !== "") {
    if (
      wager.agentLogin.toUpperCase() !== filter.agentLogin.trim().toUpperCase()
    ) {
      return false;
    }
  }
  return true;
}

export interface CustomerSliceSummary {
  readonly rank: number;
  readonly customerId: CustomerIdentifier;
  readonly agentLogin: AgentIdentifier;
  readonly wagerCount: number;
  readonly settledCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly pushes: number;
  readonly winRatePct: number;
  readonly totalRiskCents: Cents;
  /** Positive when the customer is beating the house (amountWonCents - amountLostCents > 0). */
  readonly customerNetPnlCents: Cents;
  /** Book hold percentage (-customerNetPnlCents / totalRiskCents * 100); negative means the customer is beating the book. */
  readonly bookHoldPct: number;
  /** Customer ROI percentage (+customerNetPnlCents / totalRiskCents * 100). */
  readonly roiPct: number;
  readonly lateSteamCount: number;
  readonly pointBuyCount: number;
  readonly beatLineMoveCount: number;
  readonly avgClosingLineDelta: number | null;
}

/**
 * Filters enriched wagers by slice (e.g. NCAAB 1st Halves or Live GSLive NCAAB), reconstructs
 * pre/post-bet line windows across the corpus, and ranks customers by net P&L (who is beating the desk).
 */
export function rankCustomersBySlice(
  wagers: readonly EnrichedWager[],
  filter: WagerSliceFilter = {},
): CustomerSliceSummary[] {
  const lineWindows = computeWagerLineWindows(wagers);
  const matching = wagers.filter((w) => matchesWagerSlice(w, filter));

  interface MutableCustomerBucket {
    customerId: CustomerIdentifier;
    agentLogin: AgentIdentifier;
    wagerCount: number;
    settledCount: number;
    wins: number;
    losses: number;
    pushes: number;
    totalRiskCents: number;
    customerNetPnlCents: number;
    lateSteamCount: number;
    pointBuyCount: number;
    beatLineMoveCount: number;
    closingDeltaSum: number;
    closingDeltaCount: number;
  }

  const byCustomer = new Map<string, MutableCustomerBucket>();

  for (const w of matching) {
    let bucket = byCustomer.get(w.customerId);
    if (!bucket) {
      bucket = {
        customerId: w.customerId,
        agentLogin: w.agentLogin,
        wagerCount: 0,
        settledCount: 0,
        wins: 0,
        losses: 0,
        pushes: 0,
        totalRiskCents: 0,
        customerNetPnlCents: 0,
        lateSteamCount: 0,
        pointBuyCount: 0,
        beatLineMoveCount: 0,
        closingDeltaSum: 0,
        closingDeltaCount: 0,
      };
      byCustomer.set(w.customerId, bucket);
    }

    bucket.wagerCount++;
    bucket.totalRiskCents += Number(w.settlement.amountWageredCents);
    bucket.customerNetPnlCents += Number(w.settlement.netPnlCents);
    if (w.isLateSteam) bucket.lateSteamCount++;
    if (w.buyPoints > 0) bucket.pointBuyCount++;

    if (w.settlement.isSettled) {
      bucket.settledCount++;
      const out = w.settlement.outcome.toUpperCase();
      if (out === "W" || out === "WIN") {
        bucket.wins++;
      } else if (out === "L" || out === "LOSS") {
        bucket.losses++;
      } else {
        bucket.pushes++;
      }
    }

    const win = lineWindows.get(w.ticketNumber);
    if (win) {
      if (win.beatLineMove) bucket.beatLineMoveCount++;
      if (win.closingLineMoveDelta !== null) {
        bucket.closingDeltaSum += win.closingLineMoveDelta;
        bucket.closingDeltaCount++;
      }
    }
  }

  const sorted = [...byCustomer.values()].sort((a, b) => {
    if (b.customerNetPnlCents !== a.customerNetPnlCents) {
      return b.customerNetPnlCents - a.customerNetPnlCents;
    }
    if (b.totalRiskCents !== a.totalRiskCents) {
      return b.totalRiskCents - a.totalRiskCents;
    }
    return a.customerId.localeCompare(b.customerId);
  });

  return sorted.map((b, idx) => {
    const gradedDecisions = b.wins + b.losses;
    const winRatePct =
      gradedDecisions > 0
        ? Number(((b.wins / gradedDecisions) * 100).toFixed(2))
        : 0;
    const roiPct =
      b.totalRiskCents > 0
        ? Number(((b.customerNetPnlCents / b.totalRiskCents) * 100).toFixed(2))
        : 0;
    const bookHoldPct =
      b.totalRiskCents > 0
        ? Number(((-b.customerNetPnlCents / b.totalRiskCents) * 100).toFixed(2))
        : 0;
    const avgClosingLineDelta =
      b.closingDeltaCount > 0
        ? Number((b.closingDeltaSum / b.closingDeltaCount).toFixed(2))
        : null;

    return {
      rank: idx + 1,
      customerId: b.customerId,
      agentLogin: b.agentLogin,
      wagerCount: b.wagerCount,
      settledCount: b.settledCount,
      wins: b.wins,
      losses: b.losses,
      pushes: b.pushes,
      winRatePct,
      totalRiskCents: parseAsCents(b.totalRiskCents, true),
      customerNetPnlCents: parseAsCents(b.customerNetPnlCents, true),
      bookHoldPct,
      roiPct,
      lateSteamCount: b.lateSteamCount,
      pointBuyCount: b.pointBuyCount,
      beatLineMoveCount: b.beatLineMoveCount,
      avgClosingLineDelta,
    };
  });
}

// ============================================================================
// Manager `getPerformancePlayer` Daily P&L Series -> `figureDate` Drill-Down
// ============================================================================

export interface RawPerformancePlayerRow {
  readonly Date: string;
  readonly Won: number;
  readonly Lost: number;
  readonly [key: string]: unknown;
}

export interface ParsedPerformancePlayerDay {
  /** Raw portal label, e.g. `"11/12/2026 Thursday"`. */
  readonly rawDateLabel: string;
  /** Canonical `YYYY-MM-DD` figureDate for `/cloud/api/Report/getWagersByFigureDate`, e.g. `"2026-11-12"`. */
  readonly figureDate: string;
  /** Day-of-week label extracted from `Date`, e.g. `"Thursday"`. */
  readonly dayOfWeek: string;
  readonly wonCents: Cents;
  readonly lostCents: Cents;
  /** Customer net P&L in cents (`wonCents - lostCents`); positive means customer beat the house. */
  readonly customerNetCents: Cents;
  readonly wonUsd: number;
  readonly lostUsd: number;
  readonly customerNetUsd: number;
  readonly isActive: boolean;
}

export interface PerformancePlayerSummary {
  readonly totalDays: number;
  readonly activeDays: number;
  readonly winningDays: number;
  readonly losingDays: number;
  readonly breakEvenActiveDays: number;
  readonly dailyWinRatePct: number;
  readonly totalWonCents: Cents;
  readonly totalLostCents: Cents;
  readonly customerNetCents: Cents;
  readonly totalWonUsd: number;
  readonly totalLostUsd: number;
  readonly customerNetUsd: number;
  /** Active `YYYY-MM-DD` figureDates (newest first) ready for `getWagersByFigureDate` drill-down. */
  readonly activeFigureDates: readonly string[];
  readonly days: readonly ParsedPerformancePlayerDay[];
}

/**
 * Converts a `getPerformancePlayer` `Date` field (`"11/12/2026 Thursday"` or `"2026-11-12"`)
 * into `{ figureDate: "YYYY-MM-DD", dayOfWeek }`.
 */
export function parsePerformancePlayerDateLabel(rawDate: string): {
  readonly figureDate: string;
  readonly dayOfWeek: string;
} {
  const trimmed = rawDate.trim();
  const [dateToken = "", ...rest] = trimmed.split(/\s+/);
  const dayOfWeek = rest.join(" ").trim();
  const mdyMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dateToken);
  if (mdyMatch) {
    const mm = mdyMatch[1]!.padStart(2, "0");
    const dd = mdyMatch[2]!.padStart(2, "0");
    const yyyy = mdyMatch[3]!;
    return { figureDate: `${yyyy}-${mm}-${dd}`, dayOfWeek };
  }
  const isoMatch = /^(\d{4}-\d{2}-\d{2})/.exec(dateToken);
  if (isoMatch) {
    return { figureDate: isoMatch[1]!, dayOfWeek };
  }
  return { figureDate: dateToken, dayOfWeek };
}

/**
 * Summarizes the 31-day `/cloud/api/Manager/getPerformancePlayer` response array
 * (`[{ Date: "11/12/2026 Thursday", Won: 1500000, Lost: 1150000 }, ...]`) and extracts
 * active `figureDate` keys for `/cloud/api/Report/getWagersByFigureDate` ticket drill-down.
 */
export function summarizePerformancePlayer(
  rows: readonly RawPerformancePlayerRow[],
): PerformancePlayerSummary {
  const days: ParsedPerformancePlayerDay[] = [];
  let activeDays = 0;
  let winningDays = 0;
  let losingDays = 0;
  let breakEvenActiveDays = 0;
  let totalWonCents = 0;
  let totalLostCents = 0;
  const activeFigureDates: string[] = [];

  for (const row of rows) {
    const rawDateLabel = String(row.Date ?? "").trim();
    const { figureDate, dayOfWeek } =
      parsePerformancePlayerDateLabel(rawDateLabel);
    const won = Math.round(Number(row.Won ?? 0));
    const lost = Math.round(Number(row.Lost ?? 0));
    const net = won - lost;
    const isActive = won !== 0 || lost !== 0;

    totalWonCents += won;
    totalLostCents += lost;

    if (isActive) {
      activeDays++;
      if (figureDate) activeFigureDates.push(figureDate);
      if (net > 0) winningDays++;
      else if (net < 0) losingDays++;
      else breakEvenActiveDays++;
    }

    days.push({
      rawDateLabel,
      figureDate,
      dayOfWeek,
      wonCents: parseAsCents(won, true),
      lostCents: parseAsCents(lost, true),
      customerNetCents: parseAsCents(net, true),
      wonUsd: Number((won / 100).toFixed(2)),
      lostUsd: Number((lost / 100).toFixed(2)),
      customerNetUsd: Number((net / 100).toFixed(2)),
      isActive,
    });
  }

  const customerNetCents = totalWonCents - totalLostCents;
  const decidedDays = winningDays + losingDays;
  const dailyWinRatePct =
    decidedDays > 0
      ? Number(((winningDays / decidedDays) * 100).toFixed(2))
      : 0;

  return {
    totalDays: days.length,
    activeDays,
    winningDays,
    losingDays,
    breakEvenActiveDays,
    dailyWinRatePct,
    totalWonCents: parseAsCents(totalWonCents, true),
    totalLostCents: parseAsCents(totalLostCents, true),
    customerNetCents: parseAsCents(customerNetCents, true),
    totalWonUsd: Number((totalWonCents / 100).toFixed(2)),
    totalLostUsd: Number((totalLostCents / 100).toFixed(2)),
    customerNetUsd: Number((customerNetCents / 100).toFixed(2)),
    activeFigureDates,
    days,
  };
}

export interface ActiveFigureDateDrilldownInput {
  readonly agentID: string;
  readonly agentOwner?: string;
  readonly customerID: string;
  /** Portal query anchor date (`YYYY-MM-DD`, e.g. `"2026-11-13"`). Defaults to the newest row's `figureDate`. */
  readonly date?: string;
  readonly graded?: number;
  readonly sort?: number;
  readonly typeSort?: number;
  readonly week?: number;
  readonly RRO?: number;
}

/**
 * Given a 31-day `/cloud/api/Manager/getPerformancePlayer` array, emits the ordered
 * `/cloud/api/Report/getWagersByFigureDate` JSON request payloads (`ManagerWagersByFigureDatePayload[]`)
 * for every active `figureDate` (`Won > 0 || Lost > 0`), skipping zero-activity days.
 */
export function buildActiveFigureDateDrilldownPayloads(
  rows: readonly RawPerformancePlayerRow[],
  input: ActiveFigureDateDrilldownInput,
): readonly ManagerWagersByFigureDatePayload[] {
  const summary = summarizePerformancePlayer(rows);
  const defaultAnchorDate =
    input.date ??
    summary.days[0]?.figureDate ??
    summary.activeFigureDates[0] ??
    "1970-01-01";
  return summary.activeFigureDates.map((figureDate) =>
    buildManagerWagersByFigureDatePayload({
      agentID: input.agentID,
      agentOwner: input.agentOwner ?? input.agentID,
      customerID: input.customerID,
      date: defaultAnchorDate,
      figureDate,
      graded: input.graded ?? 0,
      sort: input.sort ?? 1,
      typeSort: input.typeSort ?? 2,
      week: input.week ?? 0,
      RRO: input.RRO ?? 1,
    }),
  );
}

export interface PerformanceCarryOverReconciliation {
  /** Target carryover in cents from `getInfoPlayer` (`INFO.data.CarryOverAmount`). */
  readonly targetCarryOverCents: Cents;
  readonly targetCarryOverUsd: number;
  /** True when `previousBalanceUsd` is omitted or `CarryOverAmount === Math.round(previousBalanceUsd * 100)`. */
  readonly previousBalanceParityMatched: boolean;
  /** `CarryOverAmount - Math.round(previousBalanceUsd * 100)` in cents (`0` when matched, `null` when `previousBalanceUsd` omitted). */
  readonly previousBalanceParityDeltaCents: number | null;
  /** True when a contiguous prefix from the oldest active figureDate sums to `targetCarryOverCents`. */
  readonly prefixSumMatched: boolean;
  /** True when BOTH `previousBalanceParityMatched` AND `prefixSumMatched` hold. */
  readonly matched: boolean;
  /** Oldest active figureDate in the carryover window (e.g. `"2026-11-01"`), or `null` if unmatched. */
  readonly windowStartFigureDate: string | null;
  /** Last active figureDate in the carryover window (e.g. `"2026-11-09"`), or `null` if unmatched. */
  readonly windowEndFigureDate: string | null;
  /** Active figureDates included in the carryover window (chronological order). */
  readonly carryOverFigureDates: readonly string[];
  /** Active figureDates after the carryover cutoff (e.g. current figure week `["2026-11-10", "2026-11-12"]`). */
  readonly postCarryOverFigureDates: readonly string[];
  /** Customer net P&L in cents accumulated after the carryover cutoff (`customerNetCents - targetCarryOverCents`). */
  readonly postCarryOverNetCents: Cents;
  readonly postCarryOverNetUsd: number;
}

/**
 * Reconciles a customer's `/cloud/api/Manager/getPerformancePlayer` daily P&L series against
 * `getInfoPlayer` `CarryOverAmount` (cents) and optional `thisWeek.PreviousBalance` (whole USD).
 *
 * Scans active days in chronological order (oldest -> newest) to locate the cutoff date where
 * cumulative customer net P&L equals `CarryOverAmount`, and verifies `CarryOverAmount === PreviousBalance * 100`
 * when `previousBalanceUsd` is provided.
 */
export function reconcilePerformanceWithCarryOver(
  rows: readonly RawPerformancePlayerRow[],
  carryOverAmountCents: number,
  previousBalanceUsd?: number | null,
): PerformanceCarryOverReconciliation {
  const summary = summarizePerformancePlayer(rows);
  const targetCents = Math.round(carryOverAmountCents);
  const previousBalanceParityDeltaCents =
    typeof previousBalanceUsd === "number" &&
    Number.isFinite(previousBalanceUsd)
      ? targetCents - Math.round(previousBalanceUsd * 100)
      : null;
  // Vacuously true when `previousBalanceUsd` is omitted (`undefined` / `null`): caller opted into prefix-sum check only.
  // Pass `previousBalanceUsd` explicitly to enforce the dual invariant (`CarryOverAmount === PreviousBalance * 100` AND prefix sum).
  const previousBalanceParityMatched =
    previousBalanceParityDeltaCents === null ||
    previousBalanceParityDeltaCents === 0;
  const activeChronological = [...summary.days]
    .filter((d) => d.isActive)
    .sort((a, b) => a.figureDate.localeCompare(b.figureDate));

  let runningNetCents = 0;
  let matchIndex = -1;
  for (let i = 0; i < activeChronological.length; i++) {
    runningNetCents += activeChronological[i]!.customerNetCents;
    if (runningNetCents === targetCents) {
      matchIndex = i;
      break;
    }
  }

  if (matchIndex === -1) {
    const postNet = summary.customerNetCents - targetCents;
    return {
      targetCarryOverCents: parseAsCents(targetCents, true),
      targetCarryOverUsd: Number((targetCents / 100).toFixed(2)),
      previousBalanceParityMatched,
      previousBalanceParityDeltaCents,
      prefixSumMatched: false,
      matched: false,
      windowStartFigureDate: null,
      windowEndFigureDate: null,
      carryOverFigureDates: [],
      postCarryOverFigureDates: activeChronological.map((d) => d.figureDate),
      postCarryOverNetCents: parseAsCents(postNet, true),
      postCarryOverNetUsd: Number((postNet / 100).toFixed(2)),
    };
  }

  const carryOverDays = activeChronological.slice(0, matchIndex + 1);
  const postDays = activeChronological.slice(matchIndex + 1);
  let postNetCents = 0;
  for (const d of postDays) {
    postNetCents += d.customerNetCents;
  }

  return {
    targetCarryOverCents: parseAsCents(targetCents, true),
    targetCarryOverUsd: Number((targetCents / 100).toFixed(2)),
    previousBalanceParityMatched,
    previousBalanceParityDeltaCents,
    prefixSumMatched: true,
    matched: previousBalanceParityMatched,
    windowStartFigureDate: carryOverDays[0]?.figureDate ?? null,
    windowEndFigureDate:
      carryOverDays[carryOverDays.length - 1]?.figureDate ?? null,
    carryOverFigureDates: carryOverDays.map((d) => d.figureDate),
    postCarryOverFigureDates: postDays.map((d) => d.figureDate),
    postCarryOverNetCents: parseAsCents(postNetCents, true),
    postCarryOverNetUsd: Number((postNetCents / 100).toFixed(2)),
  };
}
