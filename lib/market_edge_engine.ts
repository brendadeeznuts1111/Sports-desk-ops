/**
 * @file lib/market_edge_engine.ts
 * @description Market Edge & Book Leakage Analytics Engine.
 *
 * Slices and aggregates wager telemetry across four core dimensions:
 *   1. Sport (Football, Basketball, Baseball, Hockey, Soccer, etc.)
 *   2. Sub-Sport / League (NFL, CFB, NBA, CBB, NHL, MLB, EPL, etc.)
 *   3. Portal Period (0: Game, 1: 1st Half, 2: 2nd Half, 3-6: Quarters)
 *   4. Market Type (Spread, Moneyline, Total, Derivative Points Line, Puck Line, Props)
 *
 * Computes critical bookmaker vs. bettor edge indicators:
 *   - Bettor Win Rate % (Wins / (Wins + Losses) * 100) vs. standard -110 breakeven (52.38%)
 *   - Desk Hold % (Desk Net PnL / Risk Dollars * 100) — negative hold indicates cash leaks
 *   - Late Steam Skew % (proportion of bets with >= 25s latency)
 *   - Point-Buy Frequency & Vulnerabilities (key numbers 3 & 7)
 *   - Edge Status Classification (CRITICAL_LEAK, PLAYER_EDGE, NEUTRAL, BOOK_EDGE, HIGH_MARGIN)
 */

import * as readline from "node:readline";
import { Readable } from "node:stream";
import type { Cents } from "../design/domain-branded-types.ts";
import { parseAsCents } from "../design/domain-branded-types.ts";
import {
  PORTAL_PERIOD_LABELS,
  classifyPortalPeriod,
  isDerivativePointsLineWager,
} from "./portal_period_taxonomy.ts";
import { sportCategoryFor } from "./sport_taxonomy.ts";
import { parseBuyPointsFromDesc } from "./f402_figure_date_enricher.ts";
import { parseShortDesc } from "./live_wagers.ts";

export type EdgeSortCriteria =
  | "leak" // Lowest Desk Hold % first (biggest leaks / highest player expectation)
  | "hold" // Highest Desk Hold % first (most profitable book markets)
  | "edge" // Highest Bettor Win Rate % first
  | "volume" // Highest Risk Volume first
  | "wagers" // Highest Wager Count first
  | "steam"; // Highest Late Steam % first

export type EdgeStatusLevel =
  | "CRITICAL_LEAK"
  | "PLAYER_EDGE"
  | "NEUTRAL"
  | "BOOK_EDGE"
  | "HIGH_MARGIN"
  | "INSUFFICIENT_SAMPLE";

export interface MarketEdgeRow {
  readonly sport: string;
  readonly subSport: string;
  readonly period: number;
  readonly periodLabel: string;
  readonly marketType: string;
  readonly marketLabel: string;
  readonly totalWagers: number;
  readonly settledWagers: number;
  readonly totalRiskCents: Cents;
  readonly totalRiskDollars: number;
  readonly deskPnlCents: Cents;
  readonly deskPnlDollars: number;
  readonly wins: number;
  readonly losses: number;
  readonly pushes: number;
  readonly pending: number;
  readonly bettorWinRatePct: number;
  readonly deskHoldPct: number;
  readonly lateSteamCount: number;
  readonly lateSteamPct: number;
  readonly buyPointsWagers: number;
  readonly totalPointsBought: number;
  readonly edgeStatus: EdgeStatusLevel;
  readonly statusSymbol: string;
}

export interface MarketEdgeReport {
  readonly universe: {
    readonly totalWagers: number;
    readonly totalSettled: number;
    readonly totalPending: number;
    readonly totalRiskDollars: number;
    readonly totalDeskPnlDollars: number;
    readonly overallHoldPct: number;
    readonly criticalLeakCount: number;
    readonly playerEdgeCount: number;
    readonly bookEdgeCount: number;
  };
  readonly rows: readonly MarketEdgeRow[];
  readonly durationMs?: number | undefined;
  readonly throughputRowsPerSec?: number | undefined;
}

export interface EdgeFilterOptions {
  readonly sort?: EdgeSortCriteria | undefined;
  readonly sport?: string | null | undefined;
  readonly subSport?: string | null | undefined;
  readonly period?: number | null | undefined;
  readonly market?: string | null | undefined;
  readonly minWagers?: number | undefined;
  readonly top?: number | undefined;
  readonly compact?: boolean | undefined;
  readonly ranked?: boolean | undefined;
  readonly columns?: readonly string[] | undefined;
}

export type InputFileSource = string | File | Blob;

/**
 * Classifies an incoming wager record into its canonical market type.
 */
export function classifyMarketType(record: {
  readonly ShortDesc?: unknown;
  readonly shortDesc?: unknown;
  readonly Description?: unknown;
  readonly description?: unknown;
  readonly WagerType?: unknown;
  readonly wagerType?: unknown;
  readonly MarketType?: unknown;
  readonly marketType?: unknown;
  readonly market?: unknown;
}): { marketType: string; marketLabel: string } {
  const desc = String(
    record.ShortDesc ??
      record.shortDesc ??
      record.Description ??
      record.description ??
      "",
  );
  const wt = String(record.WagerType ?? record.wagerType ?? "").trim();
  const mk = String(
    record.MarketType ?? record.marketType ?? record.market ?? "",
  ).toLowerCase();

  // 1. Derivative Points Line (Type E or explicit derivative text)
  if (isDerivativePointsLineWager({ ShortDesc: desc, WagerType: wt })) {
    return {
      marketType: "derivative_points",
      marketLabel: "Derivative Points Line",
    };
  }

  // 2. Direct market field check
  if (mk.includes("puck")) {
    return { marketType: "puck_line", marketLabel: "Puck Line" };
  }
  if (mk.includes("run")) {
    return { marketType: "run_line", marketLabel: "Run Line" };
  }
  if (mk.includes("money") || mk === "ml") {
    return { marketType: "moneyline", marketLabel: "Moneyline" };
  }
  if (mk.includes("spread")) {
    return { marketType: "spread", marketLabel: "Spread" };
  }
  if (mk.includes("total")) {
    return { marketType: "total", marketLabel: "Total" };
  }

  // 3. Text pattern inference
  if (
    /puck\s*line/i.test(desc) ||
    (/hockey|nhl/i.test(desc) && /[+-]1\.5/i.test(desc))
  ) {
    return { marketType: "puck_line", marketLabel: "Puck Line" };
  }
  if (
    /run\s*line/i.test(desc) ||
    (/baseball|mlb/i.test(desc) && /[+-]1\.5/i.test(desc))
  ) {
    return { marketType: "run_line", marketLabel: "Run Line" };
  }
  if (
    /Winner\s*\(2\s*way\)|Money\s*Line|\bML\b/i.test(desc) ||
    wt === "M" ||
    mk.includes("winner")
  ) {
    return { marketType: "moneyline", marketLabel: "Moneyline" };
  }
  if (/Pass\s*Yds|Rush\s*Yds|Reb|Pts|Player\s*Prop|Strikeouts/i.test(desc)) {
    return { marketType: "prop", marketLabel: "Player Prop" };
  }
  if (
    /\bTotal(\s*Points)?\b|\bOver\b|\bUnder\b|\b[OU]\s*\d/i.test(desc) ||
    mk.includes("total")
  ) {
    return { marketType: "total", marketLabel: "Total" };
  }
  if (
    /[+-]\d+(\.5)?\s*(-|\+)\d+/i.test(desc) ||
    /Point\s*spread/i.test(desc) ||
    mk.includes("spread")
  ) {
    return { marketType: "spread", marketLabel: "Spread" };
  }

  return { marketType: "other", marketLabel: "General / Other" };
}

/**
 * Computes the edge status and visual symbol given win rate and desk hold.
 */
export function computeEdgeStatus(
  winRatePct: number,
  deskHoldPct: number,
  settledCount: number,
  minWagers: number,
): { edgeStatus: EdgeStatusLevel; statusSymbol: string } {
  if (settledCount < minWagers) {
    return {
      edgeStatus: "INSUFFICIENT_SAMPLE",
      statusSymbol: "⏳ LOW SAMPLE",
    };
  }

  // Critical leak: Desk losing heavily (<= -5% hold) or players hitting >= 57%
  if (deskHoldPct <= -5.0 || winRatePct >= 57.0) {
    return {
      edgeStatus: "CRITICAL_LEAK",
      statusSymbol: "🚨 CRITICAL LEAK",
    };
  }

  // Player edge: Negative desk hold or players winning >= 53.5%
  if (deskHoldPct < 0.0 || winRatePct >= 53.5) {
    return {
      edgeStatus: "PLAYER_EDGE",
      statusSymbol: "⚠️ PLAYER EDGE",
    };
  }

  // High margin: Desk printing money (>= 10% hold)
  if (deskHoldPct >= 10.0) {
    return {
      edgeStatus: "HIGH_MARGIN",
      statusSymbol: "💰 HIGH MARGIN",
    };
  }

  // Book edge: Healthy recreational hold (>= 4.5% hold)
  if (deskHoldPct >= 4.5) {
    return {
      edgeStatus: "BOOK_EDGE",
      statusSymbol: "✅ BOOK EDGE",
    };
  }

  // Balanced / neutral
  return {
    edgeStatus: "NEUTRAL",
    statusSymbol: "⚖️ NEUTRAL",
  };
}

interface MutableAccumulator {
  sport: string;
  subSport: string;
  period: number;
  periodLabel: string;
  marketType: string;
  marketLabel: string;
  totalWagers: number;
  settledWagers: number;
  totalRiskCents: number;
  deskPnlCents: number;
  wins: number;
  losses: number;
  pushes: number;
  pending: number;
  lateSteamCount: number;
  buyPointsWagers: number;
  totalPointsBought: number;
}

/**
 * Normalizes a raw record into uniform telemetry fields.
 */
function extractRecordTelemetry(raw: Record<string, unknown>): {
  sport: string;
  subSport: string;
  period: number;
  periodLabel: string;
  marketType: string;
  marketLabel: string;
  riskDollars: number;
  deskPnlDollars: number;
  outcome: "W" | "L" | "P" | "PENDING";
  isSettled: boolean;
  isLateSteam: boolean;
  buyPoints: number;
} {
  const desc = String(
    raw.ShortDesc ?? raw.shortDesc ?? raw.Description ?? raw.description ?? "",
  );
  let parsedDescLeg: ReturnType<typeof parseShortDesc>["legs"][0] | undefined;
  if (desc) {
    const parsed = parseShortDesc(desc);
    if (parsed.legs.length > 0) {
      parsedDescLeg = parsed.legs[0];
    }
  }

  const rawSport = String(
    raw.SportType ??
      raw.sportType ??
      raw.Sport ??
      raw.sport ??
      parsedDescLeg?.sport ??
      "Unknown",
  );
  const rawSubSport = String(
    raw.SportSubType ?? raw.sportSubType ?? raw.subSport ?? raw.SubSport ?? "",
  ).trim();

  const sport = sportCategoryFor({
    sportType: rawSport,
    sportSubType: rawSubSport,
    sport:
      raw.sport ?? raw.Sport ?? (rawSport !== "Unknown" ? rawSport : undefined),
  });
  const subSport =
    rawSubSport ||
    (sport === "Football"
      ? "NFL"
      : sport === "Basketball"
        ? "NBA"
        : sport === "Hockey"
          ? "NHL"
          : sport === "Baseball"
            ? "MLB"
            : sport === "Tennis"
              ? "ATP"
              : sport === "Soccer"
                ? "SOC"
                : "GEN");

  // Period classification
  const wagerTypeStr =
    raw.WagerType !== undefined
      ? String(raw.WagerType)
      : raw.wagerType !== undefined
        ? String(raw.wagerType)
        : undefined;
  const periodStr =
    raw.Period !== undefined
      ? String(raw.Period)
      : raw.period !== undefined
        ? String(raw.period)
        : raw.PeriodDescription !== undefined
          ? String(raw.PeriodDescription)
          : raw.periodDescription !== undefined
            ? String(raw.periodDescription)
            : parsedDescLeg?.period;
  const periodDescStr =
    raw.PeriodDescription !== undefined
      ? String(raw.PeriodDescription)
      : raw.periodDescription !== undefined
        ? String(raw.periodDescription)
        : undefined;

  const portalInput: Record<string, unknown> = { ShortDesc: desc };
  if (wagerTypeStr !== undefined) portalInput.WagerType = wagerTypeStr;
  if (periodStr !== undefined) portalInput.Period = periodStr;
  if (periodDescStr !== undefined)
    portalInput.PeriodDescription = periodDescStr;

  const pInfo = classifyPortalPeriod(portalInput);

  const explicitPeriodNum =
    raw.PeriodNumber !== undefined
      ? Number(raw.PeriodNumber)
      : raw.periodNumber !== undefined
        ? Number(raw.periodNumber)
        : raw.portalPeriod !== undefined
          ? Number(raw.portalPeriod)
          : undefined;

  const period =
    explicitPeriodNum !== undefined &&
    explicitPeriodNum >= 0 &&
    explicitPeriodNum <= 6
      ? explicitPeriodNum
      : (pInfo.portalPeriod ?? 0);

  const periodLabel =
    PORTAL_PERIOD_LABELS[period as keyof typeof PORTAL_PERIOD_LABELS] ??
    pInfo.portalLabel ??
    "Game";

  const { marketType, marketLabel } = classifyMarketType({
    ShortDesc: desc,
    WagerType: raw.WagerType ?? raw.wagerType,
    MarketType: raw.MarketType ?? raw.marketType,
    market: raw.market ?? parsedDescLeg?.market,
  });

  // Risk calculation
  let riskDollars = 0;
  if (raw.risk !== undefined && raw.risk !== null) {
    riskDollars = Number(raw.risk);
  } else if (raw.Risk !== undefined && raw.Risk !== null) {
    riskDollars = Number(raw.Risk);
  } else if (raw.AmountWagered !== undefined && raw.AmountWagered !== null) {
    const rawAmt = Number(raw.AmountWagered);
    // If integer > 500 and looks like cents, or normal float
    riskDollars =
      rawAmt > 500 && Number.isInteger(rawAmt) ? rawAmt / 100 : rawAmt;
  } else if (raw.amountWagered !== undefined && raw.amountWagered !== null) {
    const rawAmt = Number(raw.amountWagered);
    riskDollars =
      rawAmt > 500 && Number.isInteger(rawAmt) ? rawAmt / 100 : rawAmt;
  } else if (raw.bet !== undefined && raw.bet !== null) {
    riskDollars = Number(raw.bet);
  } else if (raw.Bet !== undefined && raw.Bet !== null) {
    riskDollars = Number(raw.Bet);
  } else if (raw.Amount !== undefined && raw.Amount !== null) {
    riskDollars = Number(raw.Amount);
  } else if (raw.amount !== undefined && raw.amount !== null) {
    riskDollars = Number(raw.amount);
  }

  // Settlement outcome & desk PnL
  let outcome: "W" | "L" | "P" | "PENDING" = "PENDING";
  let isSettled = false;
  let deskPnlDollars = 0;

  // Enriched settlement sub-object check
  const settlement = raw.settlement as Record<string, unknown> | undefined;
  if (settlement && typeof settlement === "object") {
    const oc = String(settlement.outcome ?? "").toUpperCase();
    if (oc === "W" || oc === "WIN") outcome = "W";
    else if (oc === "L" || oc === "LOSS") outcome = "L";
    else if (oc === "P" || oc === "PUSH") outcome = "P";

    isSettled = settlement.isSettled === true || outcome !== "PENDING";
    if (isSettled) {
      // In enriched format: settlement.netPnlCents is player PnL
      const playerPnlCents = Number(settlement.netPnlCents ?? 0);
      deskPnlDollars = -(playerPnlCents / 100);
    }
  } else if (raw.result !== undefined && raw.result !== null) {
    const resNum = Number(raw.result);
    isSettled = true;
    if (resNum > 0) {
      outcome = "W";
      deskPnlDollars = -resNum;
    } else if (resNum < 0) {
      outcome = "L";
      deskPnlDollars = Math.abs(resNum);
    } else {
      outcome = "P";
      deskPnlDollars = 0;
    }
  } else {
    // Flat wire fields check
    const rawOc = String(
      raw.Outcome ?? raw.outcome ?? raw.WagerStatus ?? raw.wagerStatus ?? "",
    ).toUpperCase();
    if (rawOc === "W" || rawOc === "WIN") outcome = "W";
    else if (rawOc === "L" || rawOc === "LOSS") outcome = "L";
    else if (rawOc === "P" || rawOc === "PUSH") outcome = "P";

    isSettled = outcome === "W" || outcome === "L" || outcome === "P";

    if (isSettled) {
      if (raw.AmountWon !== undefined && raw.AmountLost !== undefined) {
        // Desk Net PnL = Player AmountLost - Player AmountWon
        deskPnlDollars = Number(raw.AmountLost) - Number(raw.AmountWon);
      } else if (outcome === "W") {
        const toWin = Number(
          raw.ToWinAmount ?? raw.toWinAmount ?? riskDollars * 0.909,
        );
        deskPnlDollars = -toWin;
      } else if (outcome === "L") {
        deskPnlDollars = riskDollars;
      } else {
        deskPnlDollars = 0;
      }
    }
  }

  const isLateSteam =
    raw.isLateSteam === true || Number(raw.latencySeconds ?? 0) >= 25;
  const buyPoints =
    typeof raw.buyPoints === "number"
      ? raw.buyPoints
      : parseBuyPointsFromDesc(desc);

  return {
    sport,
    subSport,
    period,
    periodLabel,
    marketType,
    marketLabel,
    riskDollars,
    deskPnlDollars,
    outcome,
    isSettled,
    isLateSteam,
    buyPoints,
  };
}

/**
 * Aggregates a stream or collection of wagers into structured MarketEdgeRows.
 */
export function aggregateMarketEdges(
  records: Iterable<Record<string, unknown>>,
  options: EdgeFilterOptions = {},
): MarketEdgeReport {
  const minWagers = options.minWagers ?? 10;
  const map = new Map<string, MutableAccumulator>();

  let totalWagers = 0;
  let totalSettled = 0;
  let totalPending = 0;
  let totalRiskDollars = 0;
  let totalDeskPnlDollars = 0;

  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const t = extractRecordTelemetry(raw);

    // Apply sport / subsport / period / market filters
    if (
      options.sport &&
      t.sport.toLowerCase() !== options.sport.toLowerCase()
    ) {
      continue;
    }
    if (
      options.subSport &&
      t.subSport.toLowerCase() !== options.subSport.toLowerCase()
    ) {
      continue;
    }
    if (
      options.period !== undefined &&
      options.period !== null &&
      options.period !== -1 &&
      t.period !== options.period
    ) {
      continue;
    }
    if (
      options.market &&
      !t.marketType.toLowerCase().includes(options.market.toLowerCase()) &&
      !t.marketLabel.toLowerCase().includes(options.market.toLowerCase())
    ) {
      continue;
    }

    totalWagers++;
    totalRiskDollars += t.riskDollars;
    if (t.isSettled) {
      totalSettled++;
      totalDeskPnlDollars += t.deskPnlDollars;
    } else {
      totalPending++;
    }

    const groupKey = `${t.sport}|${t.subSport}|${t.period}|${t.marketType}`;
    let acc = map.get(groupKey);
    if (!acc) {
      acc = {
        sport: t.sport,
        subSport: t.subSport,
        period: t.period,
        periodLabel: t.periodLabel,
        marketType: t.marketType,
        marketLabel: t.marketLabel,
        totalWagers: 0,
        settledWagers: 0,
        totalRiskCents: 0,
        deskPnlCents: 0,
        wins: 0,
        losses: 0,
        pushes: 0,
        pending: 0,
        lateSteamCount: 0,
        buyPointsWagers: 0,
        totalPointsBought: 0,
      };
      map.set(groupKey, acc);
    }

    acc.totalWagers++;
    acc.totalRiskCents += Math.round(t.riskDollars * 100);

    if (t.isSettled) {
      acc.settledWagers++;
      acc.deskPnlCents += Math.round(t.deskPnlDollars * 100);
      if (t.outcome === "W") acc.wins++;
      else if (t.outcome === "L") acc.losses++;
      else if (t.outcome === "P") acc.pushes++;
    } else {
      acc.pending++;
    }

    if (t.isLateSteam) acc.lateSteamCount++;
    if (t.buyPoints > 0) {
      acc.buyPointsWagers++;
      acc.totalPointsBought += t.buyPoints;
    }
  }

  let criticalLeakCount = 0;
  let playerEdgeCount = 0;
  let bookEdgeCount = 0;

  const rows: MarketEdgeRow[] = [];

  for (const acc of map.values()) {
    const riskDollars = acc.totalRiskCents / 100;
    const deskPnlDollars = acc.deskPnlCents / 100;
    const decisiveSettled = acc.wins + acc.losses;

    const bettorWinRatePct =
      decisiveSettled > 0 ? (acc.wins / decisiveSettled) * 100 : 0;
    const deskHoldPct =
      riskDollars > 0 ? (deskPnlDollars / riskDollars) * 100 : 0;
    const lateSteamPct =
      acc.totalWagers > 0 ? (acc.lateSteamCount / acc.totalWagers) * 100 : 0;

    const { edgeStatus, statusSymbol } = computeEdgeStatus(
      bettorWinRatePct,
      deskHoldPct,
      acc.settledWagers,
      minWagers,
    );

    if (edgeStatus === "CRITICAL_LEAK") criticalLeakCount++;
    else if (edgeStatus === "PLAYER_EDGE") playerEdgeCount++;
    else if (edgeStatus === "BOOK_EDGE" || edgeStatus === "HIGH_MARGIN") {
      bookEdgeCount++;
    }

    rows.push({
      sport: acc.sport,
      subSport: acc.subSport,
      period: acc.period,
      periodLabel: acc.periodLabel,
      marketType: acc.marketType,
      marketLabel: acc.marketLabel,
      totalWagers: acc.totalWagers,
      settledWagers: acc.settledWagers,
      totalRiskCents: parseAsCents(acc.totalRiskCents, true),
      totalRiskDollars: Math.round(riskDollars * 100) / 100,
      deskPnlCents: parseAsCents(acc.deskPnlCents, true),
      deskPnlDollars: Math.round(deskPnlDollars * 100) / 100,
      wins: acc.wins,
      losses: acc.losses,
      pushes: acc.pushes,
      pending: acc.pending,
      bettorWinRatePct: Math.round(bettorWinRatePct * 100) / 100,
      deskHoldPct: Math.round(deskHoldPct * 100) / 100,
      lateSteamCount: acc.lateSteamCount,
      lateSteamPct: Math.round(lateSteamPct * 100) / 100,
      buyPointsWagers: acc.buyPointsWagers,
      totalPointsBought: acc.totalPointsBought,
      edgeStatus,
      statusSymbol,
    });
  }

  // Sort rows based on criteria
  const sort = options.sort ?? "leak";
  rows.sort((a, b) => {
    switch (sort) {
      case "leak":
        // Lowest Desk Hold % first (biggest leaks / highest negative margin)
        return a.deskHoldPct - b.deskHoldPct;
      case "hold":
        // Highest Desk Hold % first (most profitable markets)
        return b.deskHoldPct - a.deskHoldPct;
      case "edge":
        // Highest Bettor Win Rate % first
        return b.bettorWinRatePct - a.bettorWinRatePct;
      case "volume":
        // Highest Risk Volume first
        return b.totalRiskDollars - a.totalRiskDollars;
      case "wagers":
        // Highest Wager Count first
        return b.totalWagers - a.totalWagers;
      case "steam":
        // Highest Late Steam % first
        return b.lateSteamPct - a.lateSteamPct;
      default:
        return a.deskHoldPct - b.deskHoldPct;
    }
  });

  const topRows = options.top !== undefined ? rows.slice(0, options.top) : rows;

  const overallHoldPct =
    totalRiskDollars > 0
      ? Math.round((totalDeskPnlDollars / totalRiskDollars) * 10000) / 100
      : 0;

  return {
    universe: {
      totalWagers,
      totalSettled,
      totalPending,
      totalRiskDollars: Math.round(totalRiskDollars * 100) / 100,
      totalDeskPnlDollars: Math.round(totalDeskPnlDollars * 100) / 100,
      overallHoldPct,
      criticalLeakCount,
      playerEdgeCount,
      bookEdgeCount,
    },
    rows: topRows,
  };
}

/**
 * Streams input lines from file or memory and computes the MarketEdgeReport.
 */
export async function streamAndAggregateMarketEdges(
  source: InputFileSource,
  options: EdgeFilterOptions = {},
): Promise<MarketEdgeReport> {
  const startNs =
    typeof Bun !== "undefined" && typeof Bun.nanoseconds === "function"
      ? Bun.nanoseconds()
      : 0;

  const records: Record<string, unknown>[] = [];
  const file: Blob = typeof source === "string" ? Bun.file(source) : source;

  if (
    typeof source === "string" &&
    source !== "-" &&
    !(await Bun.file(source).exists())
  ) {
    throw new Error(`Input file not found: ${source}`);
  }

  if (typeof source !== "string" || source !== "-") {
    try {
      const fileWithJson = file as Blob & { json?: () => Promise<unknown> };
      const parsed: unknown =
        typeof fileWithJson.json === "function"
          ? await fileWithJson.json()
          : JSON.parse(await file.text());

      if (Array.isArray(parsed)) {
        records.push(...(parsed as Record<string, unknown>[]));
      } else if (parsed && typeof parsed === "object") {
        const p = parsed as Record<string, unknown>;
        if (Array.isArray(p.wagers)) {
          records.push(...(p.wagers as Record<string, unknown>[]));
        } else if (Array.isArray(p.rows)) {
          records.push(...(p.rows as Record<string, unknown>[]));
        } else if (Array.isArray(p.bets)) {
          records.push(...(p.bets as Record<string, unknown>[]));
        } else if (
          p.r &&
          typeof p.r === "object" &&
          Array.isArray((p.r as Record<string, unknown>).bets)
        ) {
          records.push(
            ...((p.r as Record<string, unknown>).bets as Record<
              string,
              unknown
            >[]),
          );
        } else if (p.LIST) {
          if (Array.isArray(p.LIST)) {
            records.push(...(p.LIST as Record<string, unknown>[]));
          } else if (typeof p.LIST === "object") {
            const listObj = p.LIST as Record<string, unknown>;
            if (Array.isArray(listObj.INFO)) {
              records.push(...(listObj.INFO as Record<string, unknown>[]));
            } else {
              records.push(
                ...(Object.values(listObj) as Record<string, unknown>[]),
              );
            }
          }
        } else if (
          p.TicketNumber !== undefined ||
          p.ticketNumber !== undefined ||
          p.WagerNumber !== undefined ||
          p.wagerNumber !== undefined
        ) {
          records.push(p);
        }
      }
    } catch {
      // Not a single JSON document, fall through to line-by-line streaming
    }
  }

  if (records.length === 0) {
    const stream =
      typeof source === "string" && source === "-"
        ? process.stdin
        : file.stream();

    const rl = readline.createInterface({
      input:
        typeof source === "string" && source === "-"
          ? process.stdin
          : Readable.fromWeb(
              stream as unknown as Parameters<typeof Readable.fromWeb>[0],
            ),
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          records.push(JSON.parse(trimmed));
        } catch {
          // Skip malformed lines
        }
      }
    } finally {
      rl.close();
    }
  }

  const report = aggregateMarketEdges(records, options);

  const durationMs =
    typeof Bun !== "undefined" && typeof Bun.nanoseconds === "function"
      ? Number(Bun.nanoseconds() - startNs) / 1_000_000
      : 0;
  const throughputRowsPerSec =
    durationMs > 0
      ? Math.round((records.length / durationMs) * 1000)
      : undefined;

  return {
    universe: report.universe,
    rows: report.rows,
    durationMs,
    throughputRowsPerSec,
  };
}

export const MARKET_EDGE_TABLE_COLUMNS = [
  "Sport",
  "Sub",
  "Period",
  "Market",
  "Wagers",
  "Risk",
  "WinRate",
  "DeskHold",
  "SteamPct",
  "Status",
] as const;

export type MarketEdgeTableColumn = (typeof MARKET_EDGE_TABLE_COLUMNS)[number];

export interface MarketEdgeTableOptions {
  readonly colors?: boolean | undefined;
  readonly maxArrayLength?: number | undefined;
  readonly compact?: boolean | number | undefined;
  readonly ranked?: boolean | undefined;
  readonly columns?: readonly string[] | undefined;
}

/**
 * Formats a MarketEdgeReport into a terminal presentation leveraging Bun.inspect.table,
 * Bun.inspect options (colors, maxArrayLength, compact), and native Bun utilities
 * (Bun.color, Bun.enableANSIColors, Bun.stripANSI, Bun.stringWidth).
 */
export function formatMarketEdgeTable(
  report: MarketEdgeReport,
  options: MarketEdgeTableOptions = {},
): string {
  const useColors =
    options.colors ??
    (typeof Bun !== "undefined" ? Bun.enableANSIColors : false);

  const colorOf = (
    name: "red" | "green" | "yellow" | "cyan" | "magenta" | "gray",
  ): string => {
    if (!useColors) return "";
    const native =
      typeof Bun !== "undefined" && typeof Bun.color === "function"
        ? Bun.color(name, "ansi")
        : "";
    if (native) return native;
    switch (name) {
      case "red":
        return "\u001b[31m";
      case "green":
        return "\u001b[32m";
      case "yellow":
        return "\u001b[33m";
      case "cyan":
        return "\u001b[36m";
      case "gray":
        return "\u001b[90m";
      case "magenta":
        return "\u001b[35m";
    }
  };

  const bold = (s: string) => (useColors ? `\u001b[1m${s}\u001b[22m` : s);
  const dim = (s: string) => (useColors ? `\u001b[2m${s}\u001b[22m` : s);
  const red = (s: string) =>
    useColors ? `${colorOf("red")}${s}\u001b[39m` : s;
  const green = (s: string) =>
    useColors ? `${colorOf("green")}${s}\u001b[39m` : s;
  const yellow = (s: string) =>
    useColors ? `${colorOf("yellow")}${s}\u001b[39m` : s;
  const cyan = (s: string) =>
    useColors ? `${colorOf("cyan")}${s}\u001b[39m` : s;

  const clean = (s: string) =>
    !useColors &&
    typeof Bun !== "undefined" &&
    typeof Bun.stripANSI === "function"
      ? Bun.stripANSI(s)
      : s;

  const u = report.universe;
  const isCompact = options.compact === true || options.compact === 1;

  let header = "";
  if (isCompact) {
    const pnlSign = u.totalDeskPnlDollars >= 0 ? "+" : "";
    const pnlStr = `${pnlSign}$${u.totalDeskPnlDollars.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    const holdStr = `${u.overallHoldPct >= 0 ? "+" : ""}${u.overallHoldPct.toFixed(2)}% Hold`;
    const leakStr =
      u.criticalLeakCount > 0
        ? red(bold(`${u.criticalLeakCount} LEAKS`))
        : green("0 leaks");
    header = clean(
      `${bold("=== Fantasy402 Edge Matrix")} | Wagers: ${bold(u.totalWagers.toLocaleString())} | Risk: $${bold(u.totalRiskDollars.toLocaleString("en-US", { minimumFractionDigits: 2 }))} | PnL: ${u.totalDeskPnlDollars >= 0 ? green(pnlStr) : red(pnlStr)} (${u.totalDeskPnlDollars >= 0 ? green(holdStr) : red(holdStr)}) | ${leakStr} ===`,
    );
  } else {
    const pnlColor = u.totalDeskPnlDollars >= 0 ? green : red;
    const pnlSign = u.totalDeskPnlDollars >= 0 ? "+" : "";

    header = clean(
      [
        bold("=== Fantasy402 Market Edge & Leakage Matrix ==="),
        `Total Wagers     : ${bold(u.totalWagers.toLocaleString())} (${u.totalSettled.toLocaleString()} settled, ${u.totalPending.toLocaleString()} pending)`,
        `Risk Monitored   : $${bold(u.totalRiskDollars.toLocaleString("en-US", { minimumFractionDigits: 2 }))}`,
        `Desk Net PnL     : ${pnlColor(`${pnlSign}$${u.totalDeskPnlDollars.toLocaleString("en-US", { minimumFractionDigits: 2 })}`)} (${pnlColor(`${u.overallHoldPct >= 0 ? "+" : ""}${u.overallHoldPct.toFixed(2)}% Hold`)})`,
        `Active Leaks     : ${u.criticalLeakCount > 0 ? red(bold(`${u.criticalLeakCount} CRITICAL`)) : green("0 critical")}, ${u.playerEdgeCount > 0 ? yellow(`${u.playerEdgeCount} player edge`) : "0 player edge"}`,
        ...(report.throughputRowsPerSec !== undefined
          ? [
              `Throughput       : ${cyan(report.throughputRowsPerSec.toLocaleString())} wagers/sec (${report.durationMs?.toFixed(1) ?? "0"}ms total)`,
            ]
          : []),
      ].join("\n"),
    );
  }

  // Handle maxArrayLength slicing
  const maxRows =
    options.maxArrayLength !== undefined && options.maxArrayLength > 0
      ? options.maxArrayLength
      : report.rows.length;
  const slicedRows = report.rows.slice(0, maxRows);

  if (slicedRows.length === 0) {
    return `${header}\n\nNo market cohorts matched the specified criteria.`;
  }

  const isRanked = options.ranked !== false;
  const selectedColumns =
    options.columns && options.columns.length > 0
      ? options.columns
      : (MARKET_EDGE_TABLE_COLUMNS as readonly string[]);

  const tableData: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < slicedRows.length; i++) {
    const r = slicedRows[i]!;
    const holdStr = `${r.deskHoldPct >= 0 ? "+" : ""}${r.deskHoldPct.toFixed(2)}%`;
    let coloredHold = holdStr;
    if (useColors) {
      if (r.deskHoldPct <= -5.0) {
        coloredHold = red(bold(holdStr));
      } else if (r.deskHoldPct < 0) {
        coloredHold = red(holdStr);
      } else if (r.deskHoldPct >= 15.0) {
        coloredHold = green(bold(holdStr));
      } else if (r.deskHoldPct > 0) {
        coloredHold = green(holdStr);
      }
    }

    let coloredWinRate =
      r.settledWagers > 0 ? `${r.bettorWinRatePct.toFixed(1)}%` : dim("—");
    if (useColors && r.settledWagers > 0) {
      if (r.bettorWinRatePct >= 57.0) {
        coloredWinRate = red(bold(coloredWinRate));
      } else if (r.bettorWinRatePct >= 53.5) {
        coloredWinRate = yellow(coloredWinRate);
      } else if (r.bettorWinRatePct <= 45.0) {
        coloredWinRate = green(coloredWinRate);
      }
    }

    const rowObj: Record<string, unknown> = {
      Sport: r.sport,
      Sub: r.subSport,
      Period: r.periodLabel,
      Market: r.marketLabel,
      Wagers: r.totalWagers,
      Risk: `$${r.totalRiskDollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      WinRate: clean(coloredWinRate),
      DeskHold: clean(coloredHold),
      SteamPct: `${r.lateSteamPct.toFixed(1)}%`,
      Status: r.statusSymbol,
    };

    const rowKey = isRanked ? `#${i + 1}` : String(i);
    tableData[rowKey] = rowObj;
  }

  let tableBlock = "";
  if (typeof Bun !== "undefined" && typeof Bun.inspect.table === "function") {
    tableBlock = Bun.inspect.table(tableData, selectedColumns as string[], {
      colors: useColors,
    });
  } else {
    tableBlock = JSON.stringify(tableData, null, 2);
  }

  let truncationNote = "";
  if (report.rows.length > slicedRows.length) {
    const remaining = report.rows.length - slicedRows.length;
    truncationNote = `\n${dim(`... and ${remaining} more cohorts (use --top or maxArrayLength to view more)`)}`;
  }

  return `${header}\n${tableBlock}${truncationNote}`;
}

/**
 * Inspection class providing human-friendly terminal formatting via [Bun.inspect.custom].
 */
export class MarketEdgeInspection {
  readonly report: MarketEdgeReport;
  readonly options: EdgeFilterOptions;

  constructor(report: MarketEdgeReport, options: EdgeFilterOptions = {}) {
    this.report = report;
    this.options = options;
  }

  [Bun.inspect.custom](
    _depth: number,
    opts: Parameters<typeof Bun.inspect>[1] & {
      readonly maxArrayLength?: number | undefined;
    } = {},
  ): string {
    const colors =
      opts?.colors ??
      (typeof Bun !== "undefined" ? Bun.enableANSIColors : false);
    const maxArrayLength =
      typeof opts?.maxArrayLength === "number"
        ? opts.maxArrayLength
        : this.options.top;
    const compact = Boolean(opts?.compact ?? this.options.compact);
    const ranked = this.options.ranked !== false;
    const columns = this.options.columns;

    return formatMarketEdgeTable(this.report, {
      colors,
      maxArrayLength,
      compact,
      ranked,
      columns,
    });
  }

  toJSON() {
    return {
      universe: this.report.universe,
      rows: this.report.rows,
    };
  }
}
