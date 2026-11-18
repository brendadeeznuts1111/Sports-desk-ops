/**
 * @file lib/customer_wager_review.ts
 * @description Turn one customer's wager evidence into a review an operator can act on.
 *
 * The question this answers: "what has this account done, what is open, and what should I look at"
 * — without hand-joining the pending capture, the graded exports and the users report.
 *
 * SIGNAL HONESTY RULES BAKED INTO THE OUTPUT:
 * - Findings are measurements with evidence, not verdicts. There is no risk score and no
 *   `sharp`/`bot` label; the caller decides. Severity describes how much attention a measurement
 *   deserves, not a probability of wrongdoing.
 * - A settled win contributes `AmountWon` as PROFIT. `AmountLost` is the stake. Net is
 *   `profit - lost`, and the free-play share is reported separately because a lost free play is
 *   not lost cash.
 * - The single-market scenario is only emitted when every open row is in ONE market AND every
 *   open row is single-pick. Even then it carries its assumption in the `note`, because
 *   "at most one selection wins" is a property of the market, not something this module can prove
 *   from an arbitrary capture.
 * - The burst rule reports at least how many selections won (`minWinningLegs`), derived from the
 *   largest winning combination; it never claims to reconstruct every leg.
 */

import type {
  ArtifactFile,
  GradedWagerRow,
  LedgerTenureTotals,
  LoadedCustomerWagerArtifacts,
  PendingWagerRow,
  PlatformDayContext,
} from "./customer_wager_artifacts.ts";
import {
  reconstructWagerCard,
  type CardCorpus,
  type ReconstructedCard,
} from "./wager_card.ts";

export const CUSTOMER_WAGER_REVIEW_SCHEMA_VERSION = 1 as const;

/** A ticket with at least this many wagers inside the span is treated as a generated card. */
export const ROUND_ROBIN_MIN_WAGERS = 10;
/** All the wagers must land inside this window for the burst to be one card, not a session. */
export const ROUND_ROBIN_MAX_SPAN_MS = 5_000;
/** A single wager this many times the baseline average is an escalation worth naming. */
export const STAKE_ESCALATION_MIN_FACTOR = 10;
/** Same selection re-bet at a price this many American points away is a reprice. */
export const REPRICE_MIN_DELTA_POINTS = 100;
/** A free play at or above this decimal price is a lottery ticket rather than a conversion. */
export const FREE_PLAY_LONGSHOT_MIN_DECIMAL = 10;

type Money = number;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const usd = (value: number): string =>
  `${value < 0 ? "-" : ""}$${Math.abs(round2(value)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const pct = (part: number, whole: number): number | null =>
  whole > 0 ? round2((part / whole) * 100) : null;

/** Desk timestamps are `YYYY-MM-DD HH:MM:SS.mmm` with no zone. Differences stay correct. */
export function parseDeskTimestamp(value: string): number | null {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/,
  );
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = match[7] === undefined ? 0 : Number(match[7].padEnd(3, "0"));
  if (
    ![year, month, day, hour, minute, second, millis].every(Number.isFinite)
  ) {
    return null;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, millis);
}

/** "Ben Kohles +3300" -> "Ben Kohles"; a trailing price is a quote, not part of the selection. */
export function selectionName(selection: string): string {
  return selection.replace(/\s*[+-]\d{2,6}\s*$/, "").trim();
}

export function decimalOdds(riskUsd: Money, toWinUsd: Money): number | null {
  if (riskUsd <= 0 || toWinUsd < 0) return null;
  return round2(1 + toWinUsd / riskUsd);
}

export interface ReviewSource extends ArtifactFile {
  readonly matchedRows: number;
  readonly found: boolean;
}

export interface ReviewIdentity {
  readonly customerId: string;
  readonly agent: string | null;
  readonly userIds: readonly string[];
  readonly groups: readonly string[];
  readonly suspectedBot: boolean | null;
  readonly freePlayWagers: number;
  readonly creditAccount: boolean | null;
  readonly writers: readonly string[];
}

export interface PendingWagerView {
  readonly ticket: string;
  readonly wagerNumber: string;
  readonly placedAt: string;
  readonly sport: string;
  readonly subSport: string;
  readonly period: string;
  readonly selection: string;
  readonly priceAmerican: number | null;
  readonly impliedProbability: number | null;
  readonly riskUsd: Money;
  readonly toWinUsd: Money;
}

export interface PendingOutcome {
  readonly selection: string;
  readonly tickets: number;
  readonly riskUsd: Money;
  /** Stake + profit returned if this selection wins. */
  readonly returnUsd: Money;
  /** Return minus the risk on EVERY open ticket in the market. */
  readonly netUsd: Money;
}

export interface PendingMarketScenario {
  readonly marketKey: string;
  readonly sport: string;
  readonly subSport: string;
  readonly period: string;
  readonly rows: number;
  readonly riskUsd: Money;
  readonly toWinUsd: Money;
  readonly outcomes: readonly PendingOutcome[];
  readonly bestNetUsd: Money;
  readonly worstNetUsd: Money;
  readonly note: string;
}

export interface PendingSummary {
  readonly rows: number;
  readonly tickets: number;
  readonly riskUsd: Money;
  readonly toWinUsd: Money;
  readonly impliedProbabilitySum: number | null;
  readonly capture: {
    readonly path: string;
    readonly capturedAt: string | null;
    readonly ageMinutes: number | null;
    readonly rows: number;
    readonly customers: number;
    readonly riskUsd: Money;
    readonly toWinUsd: Money;
    readonly acceptEqualsGame: number;
  };
  readonly share: {
    readonly riskPct: number | null;
    readonly toWinPct: number | null;
  };
  readonly singleMarket: PendingMarketScenario | null;
  readonly wagers: readonly PendingWagerView[];
}

export interface StructureBucket {
  readonly label: string;
  readonly picks: number;
  readonly wagers: number;
  readonly riskUsd: Money;
  readonly profitUsd: Money;
  readonly lostUsd: Money;
  readonly netUsd: Money;
  readonly wins: number;
  readonly losses: number;
  readonly roiPct: number | null;
}

export interface SettledTicket {
  readonly ticket: string;
  readonly placedAt: string;
  readonly wagers: number;
  readonly picks: readonly number[];
  readonly riskUsd: Money;
  readonly netUsd: Money;
  readonly freePlayWagers: number;
  readonly parlayName: string | null;
}

export interface SettledConcentration {
  /** The denominator every sharePct in this block is taken over. */
  readonly denominatorUsd: number;
  readonly denominatorBasis: "settled_handle";
  readonly activeDays: number;
  readonly topDay: {
    readonly date: string;
    readonly riskUsd: number;
    readonly sharePct: number | null;
    readonly shareOf: "settled_handle";
  } | null;
  readonly topTicket: {
    readonly ticket: string;
    readonly placedAt: string;
    readonly riskUsd: number;
    readonly sharePct: number | null;
    readonly shareOf: "settled_handle";
  } | null;
  readonly note: string;
}

export interface SettledSummary {
  readonly rows: number;
  readonly tickets: number;
  readonly firstPlacedAt: string | null;
  readonly lastPlacedAt: string | null;
  readonly riskUsd: Money;
  readonly profitUsd: Money;
  readonly lostUsd: Money;
  readonly refundedUsd: Money;
  readonly netUsd: Money;
  readonly roiPct: number | null;
  readonly freePlayRiskUsd: Money;
  readonly cashRiskUsd: Money;
  readonly cashNetUsd: Money;
  readonly cashRoiPct: number | null;
  readonly wins: number;
  readonly losses: number;
  readonly other: number;
  readonly winRatePct: number | null;
  readonly byStructure: readonly StructureBucket[];
  readonly byTicket: readonly SettledTicket[];
  readonly concentration: SettledConcentration;
}

export type FindingSeverity = "info" | "low" | "medium" | "high";

export interface ReviewFinding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly detail: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface LedgerCheck extends LedgerTenureTotals {
  readonly matchesSettled: boolean;
  readonly note: string | null;
}

export interface WinExpectation {
  readonly settledWagers: number;
  readonly pricedWagers: number;
  /** Sum of the book's implied win probability per settled wager. */
  readonly expectedWins: number;
  readonly actualWins: number;
  readonly delta: number;
  readonly note: string;
}

export interface PeerStat {
  readonly value: number;
  readonly percentile: number | null;
  readonly median: number;
  readonly p90: number;
  readonly population: number;
}

export interface PeerComparison {
  readonly tickets: PeerStat;
  readonly handleUsd: PeerStat;
  readonly netUsd: PeerStat;
  readonly population: number;
  readonly note: string;
}

export interface CustomerWagerReview {
  readonly schemaVersion: typeof CUSTOMER_WAGER_REVIEW_SCHEMA_VERSION;
  readonly customerId: string;
  readonly found: boolean;
  readonly generatedAt: string;
  readonly identity: ReviewIdentity;
  readonly sources: readonly ReviewSource[];
  readonly pending: PendingSummary;
  readonly settled: SettledSummary;
  readonly expectation: WinExpectation;
  readonly cards: readonly ReconstructedCard[];
  readonly peers: PeerComparison | null;
  readonly platform: PlatformDayContext | null;
  readonly cardNorms: CardCorpus;
  readonly ledger: LedgerCheck | null;
  readonly findings: readonly ReviewFinding[];
  readonly limitations: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Settled                                                                    */
/* -------------------------------------------------------------------------- */

function structureLabel(picks: number): string {
  if (picks <= 0) return "unknown";
  return picks === 1 ? "single" : `${picks}-leg`;
}

function summarizeSettled(rows: readonly GradedWagerRow[]): SettledSummary {
  const ordered = [...rows].sort((a, b) =>
    a.placedAt.localeCompare(b.placedAt),
  );
  let riskUsd = 0;
  let profitUsd = 0;
  let lostUsd = 0;
  let refundedUsd = 0;
  let freePlayRiskUsd = 0;
  let freePlayLostUsd = 0;
  let wins = 0;
  let losses = 0;
  const tickets = new Set<string>();
  const buckets = new Map<number, GradedWagerRow[]>();
  const byTicket = new Map<string, GradedWagerRow[]>();

  for (const row of ordered) {
    riskUsd += row.riskUsd;
    profitUsd += row.profitUsd;
    lostUsd += row.lostUsd;
    refundedUsd += row.refundedUsd;
    if (row.freePlay) {
      freePlayRiskUsd += row.riskUsd;
      freePlayLostUsd += row.lostUsd;
    }
    if (row.status === "W") wins += 1;
    else if (row.status === "L") losses += 1;
    if (row.ticket !== "") tickets.add(row.ticket);
    const picks = row.picks;
    const bucket = buckets.get(picks);
    if (bucket === undefined) buckets.set(picks, [row]);
    else bucket.push(row);
    if (row.ticket !== "") {
      const ticket = byTicket.get(row.ticket);
      if (ticket === undefined) byTicket.set(row.ticket, [row]);
      else ticket.push(row);
    }
  }

  const netUsd = profitUsd - lostUsd;
  const cashRiskUsd = riskUsd - freePlayRiskUsd;
  const cashLostUsd = lostUsd - freePlayLostUsd;
  const cashNetUsd = profitUsd - cashLostUsd;

  const byStructure: StructureBucket[] = [];
  for (const picks of [...buckets.keys()].sort((a, b) => a - b)) {
    const bucket = buckets.get(picks) ?? [];
    let bRisk = 0;
    let bProfit = 0;
    let bLost = 0;
    let bWins = 0;
    let bLosses = 0;
    for (const row of bucket) {
      bRisk += row.riskUsd;
      bProfit += row.profitUsd;
      bLost += row.lostUsd;
      if (row.status === "W") bWins += 1;
      else if (row.status === "L") bLosses += 1;
    }
    byStructure.push({
      label: structureLabel(picks),
      picks,
      wagers: bucket.length,
      riskUsd: round2(bRisk),
      profitUsd: round2(bProfit),
      lostUsd: round2(bLost),
      netUsd: round2(bProfit - bLost),
      wins: bWins,
      losses: bLosses,
      roiPct: pct(bProfit - bLost, bRisk),
    });
  }

  const settledTickets: SettledTicket[] = [];
  for (const [ticket, bucket] of byTicket) {
    let tRisk = 0;
    let tProfit = 0;
    let tLost = 0;
    let free = 0;
    const picks: number[] = [];
    for (const row of bucket) {
      tRisk += row.riskUsd;
      tProfit += row.profitUsd;
      tLost += row.lostUsd;
      if (row.freePlay) free += 1;
      if (!picks.includes(row.picks)) picks.push(row.picks);
    }
    picks.sort((a, b) => a - b);
    settledTickets.push({
      ticket,
      placedAt: bucket[0]?.placedAt ?? "",
      wagers: bucket.length,
      picks,
      riskUsd: round2(tRisk),
      netUsd: round2(tProfit - tLost),
      freePlayWagers: free,
      parlayName:
        bucket.find((row) => row.parlayName !== "")?.parlayName ?? null,
    });
  }
  settledTickets.sort((a, b) => a.placedAt.localeCompare(b.placedAt));

  const firstPlacedAt = ordered[0]?.placedAt ?? null;
  const lastPlacedAt = ordered[ordered.length - 1]?.placedAt ?? null;

  const byDay = new Map<string, number>();
  for (const row of ordered) {
    const day = row.placedAt.slice(0, 10);
    if (day === "") continue;
    byDay.set(day, (byDay.get(day) ?? 0) + row.riskUsd);
  }
  let topDay: { date: string; riskUsd: number } | null = null;
  for (const [date, dayRisk] of byDay) {
    if (topDay === null || dayRisk > topDay.riskUsd)
      topDay = { date, riskUsd: dayRisk };
  }
  const topTicketRow = settledTickets.reduce<SettledTicket | null>(
    (best, ticket) =>
      best === null || ticket.riskUsd > best.riskUsd ? ticket : best,
    null,
  );
  const concentration: SettledConcentration = {
    denominatorUsd: round2(riskUsd),
    denominatorBasis: "settled_handle",
    activeDays: byDay.size,
    topDay:
      topDay === null
        ? null
        : {
            date: topDay.date,
            riskUsd: round2(topDay.riskUsd),
            sharePct: pct(topDay.riskUsd, riskUsd),
            shareOf: "settled_handle",
          },
    topTicket:
      topTicketRow === null
        ? null
        : {
            ticket: topTicketRow.ticket,
            placedAt: topTicketRow.placedAt,
            riskUsd: topTicketRow.riskUsd,
            sharePct: pct(topTicketRow.riskUsd, riskUsd),
            shareOf: "settled_handle",
          },
    note:
      `sharePct is this value over the ${"$"}${round2(riskUsd).toLocaleString("en-US")} settled ` +
      "handle (denominatorUsd), not lifetime volume: the exports cover only the observed window. " +
      "topDay and topTicket are different quantities on that one denominator; neither expresses a " +
      "multi-day slate, and a slate that straddles two days must be computed separately.",
  };

  return {
    rows: ordered.length,
    tickets: tickets.size,
    firstPlacedAt,
    lastPlacedAt,
    riskUsd: round2(riskUsd),
    profitUsd: round2(profitUsd),
    lostUsd: round2(lostUsd),
    refundedUsd: round2(refundedUsd),
    netUsd: round2(netUsd),
    roiPct: pct(netUsd, riskUsd),
    freePlayRiskUsd: round2(freePlayRiskUsd),
    cashRiskUsd: round2(cashRiskUsd),
    cashNetUsd: round2(cashNetUsd),
    cashRoiPct: pct(cashNetUsd, cashRiskUsd),
    wins,
    losses,
    other: ordered.length - wins - losses,
    winRatePct:
      wins + losses > 0 ? round2((wins / (wins + losses)) * 100) : null,
    byStructure,
    byTicket: settledTickets,
    concentration,
  };
}

/* -------------------------------------------------------------------------- */
/* Pending                                                                    */
/* -------------------------------------------------------------------------- */

interface PendingMarketGroup {
  readonly key: string;
  readonly sport: string;
  readonly subSport: string;
  readonly period: string;
  readonly rows: readonly PendingWagerRow[];
}

function marketKey(row: PendingWagerRow): string {
  return `${row.sport}|${row.subSport}|${row.period}`;
}

function groupPending(rows: readonly PendingWagerRow[]): PendingMarketGroup[] {
  const groups = new Map<string, PendingWagerRow[]>();
  for (const row of rows) {
    const key = marketKey(row);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    sport: group[0]?.sport ?? "",
    subSport: group[0]?.subSport ?? "",
    period: group[0]?.period ?? "",
    rows: group,
  }));
}

function summarizePending(
  rows: readonly PendingWagerRow[],
  capture: LoadedCustomerWagerArtifacts["pendingCapture"],
  capturePath: string,
  nowMs: number,
): PendingSummary {
  const ordered = [...rows].sort((a, b) =>
    a.placedAt.localeCompare(b.placedAt),
  );
  let riskUsd = 0;
  let toWinUsd = 0;
  let implied = 0;
  let impliedKnown = 0;
  const tickets = new Set<string>();
  for (const row of ordered) {
    riskUsd += row.riskUsd;
    toWinUsd += row.toWinUsd;
    if (row.ticket !== "") tickets.add(row.ticket);
  }
  // Implied probability lives on the view rows; sum from the derived values so the two agree.
  const wagers: PendingWagerView[] = ordered.map((row) => {
    const impliedProbability = impliedFromAmerican(row.priceAmerican);
    if (impliedProbability !== null) {
      implied += impliedProbability;
      impliedKnown += 1;
    }
    return {
      ticket: row.ticket,
      wagerNumber: row.wagerNumber,
      placedAt: row.placedAt,
      sport: row.sport,
      subSport: row.subSport,
      period: row.period,
      selection: row.selection,
      priceAmerican: row.priceAmerican,
      impliedProbability,
      riskUsd: row.riskUsd,
      toWinUsd: row.toWinUsd,
    };
  });

  const groups = groupPending(ordered);
  const only = groups.length === 1 ? groups[0] : undefined;
  const single =
    only !== undefined &&
    ordered.length > 1 &&
    ordered.every((row) => row.picks <= 1)
      ? buildMarketScenario(only)
      : null;

  const capturedMs =
    capture.capturedAt === null ? null : Date.parse(capture.capturedAt);
  const ageMinutes =
    capturedMs === null || !Number.isFinite(capturedMs)
      ? null
      : Math.max(0, (nowMs - capturedMs) / 60_000);

  return {
    rows: ordered.length,
    tickets: tickets.size,
    riskUsd: round2(riskUsd),
    toWinUsd: round2(toWinUsd),
    impliedProbabilitySum:
      impliedKnown === 0 ? null : Math.round(implied * 10_000) / 10_000,
    capture: {
      path: capturePath,
      capturedAt: capture.capturedAt,
      ageMinutes: ageMinutes === null ? null : round2(ageMinutes),
      rows: capture.rows,
      customers: capture.customers,
      riskUsd: round2(capture.riskUsd),
      toWinUsd: round2(capture.toWinUsd),
      acceptEqualsGame: capture.acceptEqualsGame,
    },
    share: {
      riskPct: pct(riskUsd, capture.riskUsd),
      toWinPct: pct(toWinUsd, capture.toWinUsd),
    },
    singleMarket: single,
    wagers,
  };
}

/** Local alias so the pending view can derive implied probability without a second import. */
function impliedFromAmerican(american: number | null): number | null {
  if (american === null) return null;
  const probability =
    american > 0
      ? 100 / (american + 100)
      : american < 0
        ? -american / (-american + 100)
        : null;
  return probability === null
    ? null
    : Math.round(probability * 1_000_000) / 1_000_000;
}

function buildMarketScenario(group: PendingMarketGroup): PendingMarketScenario {
  const totalRisk = group.rows.reduce((total, row) => total + row.riskUsd, 0);
  const bySelection = new Map<string, PendingWagerRow[]>();
  for (const row of group.rows) {
    const name = selectionName(row.selection);
    const list = bySelection.get(name);
    if (list === undefined) bySelection.set(name, [row]);
    else list.push(row);
  }
  const outcomes: PendingOutcome[] = [];
  for (const [name, list] of bySelection) {
    let risk = 0;
    let ret = 0;
    for (const row of list) {
      risk += row.riskUsd;
      ret += row.riskUsd + row.toWinUsd;
    }
    outcomes.push({
      selection: name,
      tickets: list.length,
      riskUsd: round2(risk),
      returnUsd: round2(ret),
      netUsd: round2(ret - totalRisk),
    });
  }
  outcomes.sort(
    (a, b) => b.netUsd - a.netUsd || a.selection.localeCompare(b.selection),
  );
  return {
    marketKey: group.key,
    sport: group.sport,
    subSport: group.subSport,
    period: group.period,
    rows: group.rows.length,
    riskUsd: round2(totalRisk),
    toWinUsd: round2(
      group.rows.reduce((total, row) => total + row.toWinUsd, 0),
    ),
    outcomes,
    bestNetUsd: outcomes[0]?.netUsd ?? round2(-totalRisk),
    worstNetUsd: round2(-totalRisk),
    note:
      "Assumes at most one selection wins in this market. Every open row is single-pick and in " +
      "the same sport/subSport/period; the capture does not carry the event name or start time.",
  };
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

interface TicketBurst {
  readonly ticket: string;
  readonly rows: readonly GradedWagerRow[];
  readonly spanMs: number;
  readonly picks: readonly number[];
  readonly riskUsd: Money;
  readonly netUsd: Money;
  readonly minWinningLegs: number;
  readonly maxWagerNumber: number;
}

function findBursts(rows: readonly GradedWagerRow[]): TicketBurst[] {
  const byTicket = new Map<string, GradedWagerRow[]>();
  for (const row of rows) {
    if (row.ticket === "") continue;
    const list = byTicket.get(row.ticket);
    if (list === undefined) byTicket.set(row.ticket, [row]);
    else list.push(row);
  }
  const bursts: TicketBurst[] = [];
  for (const [ticket, group] of byTicket) {
    if (group.length < ROUND_ROBIN_MIN_WAGERS) continue;
    const times: number[] = [];
    for (const row of group) {
      const parsed = parseDeskTimestamp(row.placedAt);
      if (parsed !== null) times.push(parsed);
    }
    if (times.length < 2) continue;
    const spanMs = Math.max(...times) - Math.min(...times);
    if (spanMs > ROUND_ROBIN_MAX_SPAN_MS) continue;
    const picks = [...new Set(group.map((row) => row.picks))].sort(
      (a, b) => a - b,
    );
    let riskUsd = 0;
    let profitUsd = 0;
    let lostUsd = 0;
    let minWinningLegs = 0;
    let maxWagerNumber = 0;
    for (const row of group) {
      riskUsd += row.riskUsd;
      profitUsd += row.profitUsd;
      lostUsd += row.lostUsd;
      if (row.status === "W" && row.picks > minWinningLegs) {
        minWinningLegs = row.picks;
      }
      const n = Number(row.wagerNumber);
      if (Number.isFinite(n) && n > maxWagerNumber) maxWagerNumber = n;
    }
    bursts.push({
      ticket,
      rows: group,
      spanMs,
      picks,
      riskUsd: round2(riskUsd),
      netUsd: round2(profitUsd - lostUsd),
      minWinningLegs,
      maxWagerNumber,
    });
  }
  return bursts.sort((a, b) => b.riskUsd - a.riskUsd);
}

function uniqueUsersRows(
  rows: LoadedCustomerWagerArtifacts["users"],
): LoadedCustomerWagerArtifacts["users"] {
  const seen = new Set<string>();
  const out: LoadedCustomerWagerArtifacts["users"][number][] = [];
  for (const row of rows) {
    const key = `${row.userId}|${row.groupName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * The users report (`getReportPlayerAnalysis`) is the one source whose money is DOLLARS — its
 * `risk`/`toWin` values are display dollars, unlike the wire captures' cents. The baseline is
 * therefore used as-is; every graded/pending figure reaching this function is already USD.
 */
function findStakeEscalation(
  users: LoadedCustomerWagerArtifacts["users"],
  graded: readonly GradedWagerRow[],
  pending: readonly PendingWagerRow[],
): ReviewFinding | null {
  const rows = uniqueUsersRows(users);
  if (rows.length === 0) return null;
  let wagers = 0;
  let risk = 0;
  for (const row of rows) {
    wagers += row.wagerCount;
    risk += row.riskUsd;
  }
  if (wagers <= 0 || risk <= 0) return null;
  const baseline = risk / wagers;

  interface Peak {
    readonly riskUsd: number;
    readonly placedAt: string;
    readonly source: string;
  }
  let wagerPeak: Peak | null = null;
  const tickets = new Map<
    string,
    { riskUsd: number; placedAt: string; source: string }
  >();
  for (const row of graded) {
    if (wagerPeak === null || row.riskUsd > wagerPeak.riskUsd) {
      wagerPeak = {
        riskUsd: row.riskUsd,
        placedAt: row.placedAt,
        source: "graded",
      };
    }
    if (row.ticket === "") continue;
    const key = `graded:${row.ticket}`;
    const ticket = tickets.get(key) ?? {
      riskUsd: 0,
      placedAt: row.placedAt,
      source: "graded",
    };
    ticket.riskUsd += row.riskUsd;
    if (row.placedAt < ticket.placedAt) ticket.placedAt = row.placedAt;
    tickets.set(key, ticket);
  }
  for (const row of pending) {
    if (wagerPeak === null || row.riskUsd > wagerPeak.riskUsd) {
      wagerPeak = {
        riskUsd: row.riskUsd,
        placedAt: row.placedAt,
        source: "pending",
      };
    }
    if (row.ticket === "") continue;
    const key = `pending:${row.ticket}`;
    const ticket = tickets.get(key) ?? {
      riskUsd: 0,
      placedAt: row.placedAt,
      source: "pending",
    };
    ticket.riskUsd += row.riskUsd;
    if (row.placedAt < ticket.placedAt) ticket.placedAt = row.placedAt;
    tickets.set(key, ticket);
  }
  let ticketPeak: Peak | null = null;
  for (const ticket of tickets.values()) {
    if (ticketPeak === null || ticket.riskUsd > ticketPeak.riskUsd) {
      ticketPeak = {
        riskUsd: ticket.riskUsd,
        placedAt: ticket.placedAt,
        source: ticket.source,
      };
    }
  }
  if (wagerPeak === null || wagerPeak.riskUsd <= 0 || baseline <= 0)
    return null;
  const wagerFactor = wagerPeak.riskUsd / baseline;
  const ticketFactor = ticketPeak === null ? 0 : ticketPeak.riskUsd / baseline;
  const factor = Math.max(wagerFactor, ticketFactor);
  if (factor < STAKE_ESCALATION_MIN_FACTOR) return null;
  const ticketClause =
    ticketPeak === null
      ? ""
      : `; largest single ticket ${usd(ticketPeak.riskUsd)} at ${ticketPeak.placedAt} ` +
        `(${Math.round(ticketFactor)}x)`;
  return {
    id: "stake_escalation",
    severity: factor >= 100 ? "high" : "medium",
    title: "Stake stepped up beyond the report-window baseline",
    detail:
      `Baseline ${usd(baseline)} per wager across ${wagers} wager(s) in the users-report window; ` +
      `largest single wager ${usd(wagerPeak.riskUsd)} at ${wagerPeak.placedAt} ` +
      `(${Math.round(wagerFactor)}x)${ticketClause}. Wager and ticket are different units ` +
      "(a round-robin ticket is one purchase made of many wagers); both factors are reported. " +
      "The baseline window and the graded window are different sources, so this measures a " +
      "change in observed stake, not a proven change in the account holder.",
    evidence: {
      baselineAvgUsd: round2(baseline),
      baselineWagers: wagers,
      baselineRiskUsd: round2(risk),
      peakWagerUsd: round2(wagerPeak.riskUsd),
      peakWagerAt: wagerPeak.placedAt,
      wagerFactor: Math.round(wagerFactor * 100) / 100,
      peakTicketUsd: ticketPeak === null ? null : round2(ticketPeak.riskUsd),
      peakTicketAt: ticketPeak?.placedAt ?? null,
      ticketFactor: Math.round(ticketFactor * 100) / 100,
      peakSource: wagerPeak.source,
      factor: Math.round(factor * 100) / 100,
    },
  };
}

function findReprice(
  pending: readonly PendingWagerRow[],
): ReviewFinding | null {
  const byName = new Map<string, PendingWagerRow[]>();
  for (const row of pending) {
    if (row.priceAmerican === null) continue;
    const name = selectionName(row.selection);
    const list = byName.get(name);
    if (list === undefined) byName.set(name, [row]);
    else list.push(row);
  }
  let best: {
    name: string;
    rows: PendingWagerRow[];
    min: number;
    max: number;
  } | null = null;
  for (const [name, rows] of byName) {
    if (rows.length < 2) continue;
    const prices = rows
      .map((row) => row.priceAmerican)
      .filter((price): price is number => price !== null);
    if (prices.length < 2) continue;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    if (max - min < REPRICE_MIN_DELTA_POINTS) continue;
    if (best === null || max - min > best.max - best.min) {
      best = { name, rows, min, max };
    }
  }
  if (best === null) return null;
  const ordered = [...best.rows].sort((a, b) =>
    a.placedAt.localeCompare(b.placedAt),
  );
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) return null;
  return {
    id: "same_selection_reprice",
    severity: "low",
    title: "The same selection is open at two materially different prices",
    detail:
      `${best.name} was taken at ${formatAmerican(best.min)} and later at ${formatAmerican(best.max)} ` +
      `(${best.max - best.min} American points apart) on ${best.rows.length} tickets between ` +
      `${first.placedAt} and ${last.placedAt}. Check the line history: an early or stale number ` +
      "is a different question from a genuine in-play move.",
    evidence: {
      selection: best.name,
      tickets: best.rows.length,
      firstPrice: best.min,
      lastPrice: best.max,
      deltaPoints: best.max - best.min,
      firstPlacedAt: first.placedAt,
      lastPlacedAt: last.placedAt,
    },
  };
}

function truncateText(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

function formatAmerican(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function findFreePlayLongshots(
  graded: readonly GradedWagerRow[],
): ReviewFinding | null {
  const free = graded.filter((row) => row.freePlay);
  if (free.length === 0) return null;
  let risk = 0;
  let lost = 0;
  let bestDecimal: number | null = null;
  let bestRow: GradedWagerRow | null = null;
  for (const row of free) {
    risk += row.riskUsd;
    lost += row.lostUsd;
    const dec = decimalOdds(row.riskUsd, row.toWinUsd);
    if (dec !== null && (bestDecimal === null || dec > bestDecimal)) {
      bestDecimal = dec;
      bestRow = row;
    }
  }
  if (bestDecimal === null || bestDecimal < FREE_PLAY_LONGSHOT_MIN_DECIMAL) {
    return null;
  }
  return {
    id: "free_play_longshot",
    severity: "low",
    title: "Free plays are converted at long odds",
    detail:
      `${free.length} free-play wager(s) totalling ${usd(risk)} risk; the largest priced at ` +
      `${bestDecimal.toFixed(2)}:1` +
      (bestRow === null
        ? ""
        : ` (${truncateText(selectionName(bestRow.description), 60)}, ${bestRow.placedAt})`) +
      `. Lost free-play stake ${usd(lost)} is not lost cash, which is why the settled summary ` +
      "reports the cash-only line separately. Maximum-odds conversion is the expected play for a " +
      "bonus-maximising account; it is named here so it is not mistaken for cash wagering.",
    evidence: {
      freePlayWagers: free.length,
      freePlayRiskUsd: round2(risk),
      freePlayLostUsd: round2(lost),
      largestDecimalOdds: bestDecimal,
    },
  };
}

function findCombinationOnly(settled: SettledSummary): ReviewFinding | null {
  if (settled.rows < 5) return null;
  if (settled.byStructure.some((bucket) => bucket.picks <= 1)) return null;
  const minPicks = settled.byStructure.reduce(
    (min, bucket) => Math.min(min, bucket.picks),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(minPicks)) return null;
  return {
    id: "combination_only",
    severity: "info",
    title: "Every settled wager is multi-leg",
    detail:
      `${settled.rows} settled wager(s), none straight: the smallest structure is ${minPicks} legs. ` +
      "No win rate from this book can be read as selection skill alone; it is a parlay hit rate.",
    evidence: {
      settledWagers: settled.rows,
      minLegs: minPicks,
      structures: settled.byStructure.map((bucket) => bucket.label),
    },
  };
}

function findSingleMarket(pending: PendingSummary): ReviewFinding | null {
  const scenario = pending.singleMarket;
  if (scenario === null) return null;
  return {
    id: "pending_single_market",
    severity: "info",
    title: "All open risk sits in one market with mutually exclusive outcomes",
    detail:
      `${scenario.rows} open ticket(s) in ${scenario.sport} / ${scenario.subSport} / ` +
      `${scenario.period} — ${usd(scenario.riskUsd)} risk for ${usd(scenario.toWinUsd)} to win. ` +
      `At most one selection wins: best case ${usd(scenario.bestNetUsd)}, worst case ` +
      `${usd(scenario.worstNetUsd)}. A double stake on one selection pays both tickets together, ` +
      "which the outcome list reflects.",
    evidence: {
      marketKey: scenario.marketKey,
      rows: scenario.rows,
      riskUsd: scenario.riskUsd,
      toWinUsd: scenario.toWinUsd,
      bestNetUsd: scenario.bestNetUsd,
      worstNetUsd: scenario.worstNetUsd,
      outcomes: scenario.outcomes,
      assumption: scenario.note,
    },
  };
}

function findBurst(
  bursts: readonly TicketBurst[],
  cardByTicket: ReadonlyMap<string, ReconstructedCard>,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const burst of bursts) {
    const card = cardByTicket.get(burst.ticket);
    const solvedCard = card !== undefined && card.reason === null ? card : null;
    const lostDespite =
      burst.netUsd < 0 && burst.minWinningLegs >= 3
        ? ` At least ${burst.minWinningLegs} selections won (a ${burst.minWinningLegs}-leg ` +
          "combination cashed) and the ticket still lost."
        : "";
    const cardClause =
      solvedCard === null
        ? ""
        : ` The card reconstructs to ${solvedCard.slots} slots ` +
          `(${solvedCard.bookedSlots} booked, ${solvedCard.omittedSlots} omitted); the losing ` +
          `selections were ${solvedCard.losers.join(", ") || "none"}.`;
    findings.push({
      id: "round_robin_burst",
      severity: burst.riskUsd >= 10_000 ? "high" : "medium",
      title: "One ticket holds a generated combination card",
      detail:
        `${burst.rows.length} graded wagers on ticket ${burst.ticket} inside ` +
        `${burst.spanMs} ms, covering ${burst.picks.map((p) => `${p}-leg`).join(", ")} ` +
        `structures for ${usd(burst.riskUsd)} risk. Net ${usd(burst.netUsd)}.${lostDespite}` +
        `${cardClause} ` +
        (solvedCard === null
          ? "A burst this tight is consistent with a round-robin/parlay-card product or a " +
            "scripted client; the capture cannot distinguish them."
          : "The slot space is the complete combination set of its selections, which is the " +
            "book's round-robin card product rather than a sequence of independent client orders."),
      evidence: {
        ticket: burst.ticket,
        wagers: burst.rows.length,
        spanMs: burst.spanMs,
        picks: burst.picks,
        riskUsd: burst.riskUsd,
        netUsd: burst.netUsd,
        minWinningLegs: burst.minWinningLegs,
        maxWagerNumber: burst.maxWagerNumber,
        ...(solvedCard === null
          ? {}
          : {
              cardSlots: solvedCard.slots,
              cardBookedSlots: solvedCard.bookedSlots,
              cardOmittedSlots: solvedCard.omittedSlots,
              cardWinners: solvedCard.winners,
              cardLosers: solvedCard.losers,
              cardCounterfactualNetUsd: solvedCard.counterfactualNetUsd,
            }),
      },
    });
  }
  return findings;
}

/* -------------------------------------------------------------------------- */
/* Expectation, cards, peers                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sum of the book's implied win probability over the settled wagers. It is an expectation under
 * the book's own prices, not an independent forecast: the margin is inside every probability.
 */
function summarizeExpectation(rows: readonly GradedWagerRow[]): WinExpectation {
  let expected = 0;
  let priced = 0;
  for (const row of rows) {
    if (row.riskUsd <= 0 || row.toWinUsd <= 0) continue;
    expected += row.riskUsd / (row.riskUsd + row.toWinUsd);
    priced += 1;
  }
  const actualWins = rows.filter((row) => row.status === "W").length;
  return {
    settledWagers: rows.length,
    pricedWagers: priced,
    expectedWins: round2(expected),
    actualWins,
    delta: round2(actualWins - expected),
    note:
      "expectedWins is the sum of each ticket's implied win probability (risk / (risk + toWin)) " +
      "at the book's own prices. It is the book-implied model, not a forecast, and it carries the " +
      "margin; a delta near zero means the settled record is unremarkable, not that skill is absent.",
  };
}

function peerStat(
  values: readonly number[],
  value: number,
  digits: number,
): PeerStat {
  const sorted = [...values].sort((a, b) => a - b);
  const below = sorted.filter((candidate) => candidate < value).length;
  const factor = 10 ** digits;
  return {
    value: Math.round(value * factor) / factor,
    percentile:
      sorted.length === 0
        ? null
        : Math.round((below / sorted.length) * 10000) / 100,
    median:
      Math.round(
        ((sorted[Math.floor(sorted.length / 2)] ?? 0) as number) * factor,
      ) / factor,
    p90:
      Math.round(
        (sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))] ??
          0) * factor,
      ) / factor,
    population: sorted.length,
  };
}

function summarizePeers(
  population: LoadedCustomerWagerArtifacts["ledgerPopulation"],
  settled: SettledSummary,
): PeerComparison | null {
  if (population === null || population.length === 0) return null;
  const tickets = population.map((row) => row.tickets);
  const handle = population.map((row) => row.wageredUsd);
  const net = population.map((row) => row.netUsd);
  return {
    tickets: peerStat(tickets, settled.rows, 0),
    handleUsd: peerStat(handle, settled.riskUsd, 2),
    netUsd: peerStat(net, settled.netUsd, 2),
    population: population.length,
    note:
      "Percentile = share of the ledger-tenure population strictly below this value. The " +
      "population is the bundle's customerLedgerTenure block (wire cents converted to USD), not " +
      "the platform's full customer base.",
  };
}

/* -------------------------------------------------------------------------- */
/* Build                                                                      */
/* -------------------------------------------------------------------------- */

export function buildCustomerWagerReview(
  loaded: LoadedCustomerWagerArtifacts,
): CustomerWagerReview {
  const nowMs = Date.parse(loaded.generatedAt);
  const settled = summarizeSettled(loaded.graded);
  const pendingPath =
    loaded.sources.find((source) => source.id === "pending")?.path ?? "";
  const pending = summarizePending(
    loaded.pending,
    loaded.pendingCapture,
    pendingPath,
    Number.isFinite(nowMs) ? nowMs : Date.now(),
  );

  const users = uniqueUsersRows(loaded.users);
  const agent =
    loaded.roster.find((row) => row.agent !== "")?.agent ??
    users.find((row) => row.agent !== "")?.agent ??
    loaded.pending.find((row) => row.agent !== "")?.agent ??
    null;
  const suspected =
    users.find((row) => row.suspectedBot !== null)?.suspectedBot ?? null;
  const writers = [
    ...new Set(
      loaded.graded.map((row) => row.writer).filter((writer) => writer !== ""),
    ),
  ];
  const freePlayWagers = loaded.graded.filter((row) => row.freePlay).length;
  const creditAccount = loaded.graded.some((row) => row.credit)
    ? true
    : loaded.graded.length > 0
      ? false
      : null;

  const sources: ReviewSource[] = loaded.sources.map((file) => {
    const matchedRows = loaded.matched[file.id] ?? 0;
    return { ...file, matchedRows, found: matchedRows > 0 };
  });

  const found =
    loaded.pending.length +
      loaded.ticker.length +
      loaded.graded.length +
      loaded.users.length >
    0;

  const bursts = findBursts(loaded.graded);
  const cards = bursts
    .map((burst) => reconstructWagerCard(burst.rows))
    .filter((card): card is ReconstructedCard => card !== null);
  const cardByTicket = new Map(cards.map((card) => [card.ticket, card]));
  const expectation = summarizeExpectation(loaded.graded);
  const peers = summarizePeers(loaded.ledgerPopulation, settled);
  const findings: ReviewFinding[] = [];
  const escalation = findStakeEscalation(
    loaded.users,
    loaded.graded,
    loaded.pending,
  );
  if (escalation !== null) findings.push(escalation);
  findings.push(...findBurst(bursts, cardByTicket));
  const reprice = findReprice(loaded.pending);
  if (reprice !== null) findings.push(reprice);
  const singleMarket = findSingleMarket(pending);
  if (singleMarket !== null) findings.push(singleMarket);
  const freePlay = findFreePlayLongshots(loaded.graded);
  if (freePlay !== null) findings.push(freePlay);
  const combinationOnly = findCombinationOnly(settled);
  if (combinationOnly !== null) findings.push(combinationOnly);

  findings.sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.id.localeCompare(b.id),
  );

  const limitations: string[] = [];
  const capture = pending.capture;
  if (capture.ageMinutes !== null && capture.ageMinutes > 60) {
    limitations.push(
      `The pending capture is ${Math.round(capture.ageMinutes)} minute(s) old at review time; ` +
        "it is a snapshot, not a live feed.",
    );
  }
  if (capture.rows > 0 && capture.acceptEqualsGame === capture.rows) {
    limitations.push(
      `The capture writes the accept time into GameDateTime on all ${capture.rows} row(s); ` +
        "event start and event name are not captured.",
    );
  }
  if (loaded.ticker.length > 0 && loaded.pending.length > 0) {
    const pendingTickets = new Set(loaded.pending.map((row) => row.ticket));
    const sameCapture = loaded.ticker.every((row) =>
      pendingTickets.has(row.wagerNumber),
    );
    if (sameCapture) {
      limitations.push(
        "The ticker rows are the same capture as Pending (same ticket numbers); they are not " +
          "independent confirmation.",
      );
    }
  }
  if (settled.lastPlacedAt !== null) {
    limitations.push(
      `Graded rows end at ${settled.lastPlacedAt}; settlement after that time is not observed.`,
    );
  }
  limitations.push(
    "No closing-line source is read, so CLV and a sharp/soft verdict cannot be computed here.",
  );
  if (loaded.book !== null && !loaded.book.found) {
    limitations.push(
      `The enriched customer book (${loaded.book.totalCustomers} customers) does not carry this ` +
        "customer, so book-derived CLV, sharp score and churn are unavailable.",
    );
  }
  for (const burst of bursts) {
    const card = cardByTicket.get(burst.ticket);
    if (card !== undefined && card.reason === null) {
      const coverage = card.coverage;
      limitations.push(
        `Ticket ${burst.ticket} reconstructs to ${card.slots} slots; ${card.omittedSlots} were ` +
          "not booked" +
          (coverage === null
            ? ""
            : ` (all-winner booking ${coverage.allWinnerBookingRatePct ?? "—"}% vs has-loser ` +
              `${coverage.hasLoserBookingRatePct ?? "—"}%)`) +
          ". Omitted slots are priced in the card block at the median stake for their size; they " +
          "were not observed.",
      );
    } else {
      const missing = burst.maxWagerNumber - burst.rows.length;
      if (missing > 0) {
        limitations.push(
          `${missing} wager number(s) on ticket ${burst.ticket} (highest ${burst.maxWagerNumber}) ` +
            "are absent from the graded export; the card is not fully observed.",
        );
      }
    }
  }

  const norms = loaded.cardCorpus;
  if (
    norms.candidateTickets > 0 &&
    (norms.refused > 0 || norms.unparseable > 0 || norms.truncated)
  ) {
    limitations.push(
      `Card booking norms cover ${norms.solved} of ${norms.candidateTickets} candidate tickets ` +
        `(${norms.refused} refused, ${norms.unparseable} unparseable` +
        (norms.truncated ? ", corpus truncated at the group cap" : "") +
        "); the rates describe the reconstructable subsample, not every card.",
    );
  }

  const ledger = loaded.ledger;
  const ledgerCheck: LedgerCheck | null =
    ledger === null
      ? null
      : {
          ...ledger,
          matchesSettled:
            ledger.totalTickets === settled.rows &&
            ledger.wageredUsd === settled.riskUsd &&
            ledger.netUsd === settled.netUsd,
          note:
            "The bundle's fields are wire cents, converted to USD (÷100) so they compare with " +
            "the parsed exports, which are the same cents (measured 2026-11-16).",
        };
  if (ledgerCheck !== null && !ledgerCheck.matchesSettled) {
    limitations.push(
      "The ledger-tenure totals disagree with the parsed graded exports; reconcile before " +
        "quoting either number.",
    );
  }

  return {
    schemaVersion: CUSTOMER_WAGER_REVIEW_SCHEMA_VERSION,
    customerId: loaded.customerId,
    found,
    generatedAt: loaded.generatedAt,
    identity: {
      customerId: loaded.customerId,
      agent,
      userIds: [
        ...new Set(users.map((row) => row.userId).filter((id) => id !== "")),
      ],
      groups: [
        ...new Set(users.map((row) => row.groupName).filter((g) => g !== "")),
      ],
      suspectedBot: suspected,
      freePlayWagers,
      creditAccount,
      writers,
    },
    sources,
    pending,
    settled,
    expectation,
    cards,
    peers,
    platform: loaded.platform,
    cardNorms: loaded.cardCorpus,
    ledger: ledgerCheck,
    findings,
    limitations,
  };
}

function severityRank(severity: FindingSeverity): number {
  switch (severity) {
    case "info":
      return 0;
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
  }
}
