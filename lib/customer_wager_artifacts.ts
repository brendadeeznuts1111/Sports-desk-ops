/**
 * @file lib/customer_wager_artifacts.ts
 * @description Load the per-customer wager evidence this desk already keeps on disk.
 *
 * Why this exists: a customer review used to mean hunting across five artifacts with different
 * shapes — the pending capture, the ticker capture, two graded-wager exports, the users report,
 * the agent roster and the suspected-bot ledger. Finding the customer and joining those shapes was
 * most of the work; the analysis was the easy part. This module is the join, once.
 *
 * CONTRACTS THIS MODULE DOES NOT BREAK:
 * - A missing artifact is `exists: false` with null counts, never a zero-row observation.
 * - An unparseable artifact keeps `exists: true` and says so; it is not emptied into "no rows".
 * - `AmountWon` on a graded row is PROFIT, not the return. `AmountWagered + AmountWon` is the
 *   return on a winner (measured against `ToWinAmount`, which equals `AmountWon` on every
 *   winning row in the 2026-11 graded exports). Every net in the review is `profit - lost`.
 * - Graded rows are de-duplicated by ticket+wager before they reach the analysis: the two
 *   default exports overlap (graded-today starts 2026-09-09, graded-oct-window ends
 *   2026-10-03), so the same wager can appear in both files.
 */

import { resolve } from "node:path";
import { summarizeCardCorpus, type CardCorpus } from "./wager_card.ts";
import { ticketWriterDisposition } from "./live_writer_policy.ts";
import { WIRE_MONEY_PER_USD, usdFromWireCents } from "./wire_money.ts";

type JsonRow = Record<string, unknown>;

const asRow = (value: unknown): JsonRow | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRow)
    : null;

const rowsOf = (value: unknown): readonly JsonRow[] =>
  Array.isArray(value)
    ? value.filter((row): row is JsonRow => asRow(row) !== null)
    : [];

const text = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const singleLine = (value: unknown): string | null => {
  const raw = text(value);
  return raw === null ? null : raw.replace(/\s+/g, " ").trim();
};

const num = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * F402 wire money is CENTS, in both serializations that reach this module:
 * - numeric: the Pending capture writes `wagered: 2000` for $20.00, and `lib/fraud_logs.ts`
 *   reads it as `stakeCents`; `scripts/build_live_bets.ts` prints the same total with a `¢`.
 * - string: the graded and deleted-wager exports write `AmountWagered: "200.0"` for $2.00, and
 *   `scripts/capture/capture_deleted_wagers_45d.ts` divides that exact field shape by 100.
 *
 * A string amount is therefore NOT dollars here, even though
 * `lib/f402_pending_rollup.ts#toCents` parses the portal's dollar strings — that reader serves a
 * different input family. Other repo consumers read this field the same way: `stakeCents =
 * Number(rec.AmountWagered)` in `scripts/batch_rank_all_players.ts` and
 * `(Number(b.AmountWagered) || 0) / 100` in `scripts/gslive_all_states_suspect_cron.ts`. If a
 * future capture changes the unit, this constant and its tests are the one place to change. Evidence for the scale, measured 2026-11-16 on the graded exports:
 * the largest single wager is 8,625,000 at a -575 line (=$86,250, not $8.6M), the smallest is 20
 * (=$0.20 on a 10-cent-base exacta), the 2026-11-13 platform day is 194,535,967 (=$1.9M, not
 * $19.4M), and the suspected-bot bundle's `totalWageredCents` of 51,375 for TTN97 equals the
 * graded sum read as cents. Reading these as dollars overstates every figure by 100x.
 */
export { WIRE_MONEY_PER_USD };

/** Wire cents -> USD. Missing money reads as 0, matching the capture's own zero for a blank. */
const usdFromWire = (value: unknown): number =>
  usdFromWireCents(num(value) ?? 0);

/** Column names that may arrive padded in a fixed-width export (`"TTN97     "`). */
const customerIdOf = (row: JsonRow): string | null => {
  const raw =
    text(row.CustomerID) ??
    text(row.customerID) ??
    text(row.customerId) ??
    text(row.customer_id) ??
    text(row.Login) ??
    text(row.login) ??
    // The users report keys the customer as partnerUserId; the wager exports use CustomerID.
    text(row.partnerUserId);
  if (raw === null) return null;
  return normalizeCustomerId(raw);
};

/**
 * One spelling of a customer login. The portal accepts `player_TTN97`; the exports pad with
 * spaces; the roster trims. A review must not miss a row because of any of those.
 */
export function normalizeCustomerId(input: string): string {
  return input
    .trim()
    .replace(/^player[_-]/i, "")
    .trim()
    .toUpperCase();
}

/** Every artifact this review can read, in the order the loader reports them. */
export const REVIEW_ARTIFACT_IDS = [
  "pending",
  "ticker",
  "graded_today",
  "graded_oct",
  "users_report",
  "roster",
  "ledger",
  "book",
] as const;

export type ReviewArtifactId = (typeof REVIEW_ARTIFACT_IDS)[number];

export interface ArtifactFile {
  readonly id: ReviewArtifactId;
  readonly label: string;
  readonly path: string;
  readonly exists: boolean;
  readonly bytes: number | null;
  readonly mtimeIso: string | null;
  readonly ageMinutes: number | null;
  /** Rows the file carries for ANY customer; null when the file is missing or unparseable. */
  readonly records: number | null;
  readonly note: string | null;
}

export interface ReviewArtifactPaths {
  readonly pending: string;
  readonly ticker: string;
  readonly gradedToday: string;
  readonly gradedOctWindow: string;
  /** Every `Scratch/gslive-reports-<date>/users-report-<start>-<end>.json`, newest first. */
  readonly usersReports: readonly string[];
  readonly roster: string;
  readonly ledger: string;
  readonly book: string;
}

export interface ReviewPathOverrides {
  readonly pending?: string;
  readonly ticker?: string;
  readonly gradedToday?: string;
  readonly gradedOctWindow?: string;
  readonly usersReport?: string | null;
  readonly roster?: string;
  readonly ledger?: string;
  readonly book?: string;
}

const USERS_REPORT_GLOB = "Scratch/gslive-reports-*/users-report-*.json";

/**
 * Every users-report export under the checkout, newest first. It is a list, not one file: the
 * newest export does not necessarily carry the customer (measured 2026-11-16 — the newest of
 * three exports under Scratch/gslive-reports-2026-11-08 applies to a different window and omits
 * TTN97, while the 16:07 export carries the account). Choosing only the newest silently erased
 * the identity and the baseline-stake row.
 */
export async function listUsersReportPaths(
  root: string,
): Promise<readonly string[]> {
  const glob = new Bun.Glob(USERS_REPORT_GLOB);
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for await (const relative of glob.scan({ cwd: root, absolute: true })) {
    try {
      const stat = await Bun.file(relative).stat();
      candidates.push({ path: relative, mtimeMs: stat.mtimeMs });
    } catch {
      // A file that vanished between scan and stat is simply not a candidate.
    }
  }
  candidates.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path),
  );
  return candidates.map((candidate) => candidate.path);
}

export async function resolveReviewArtifactPaths(
  root: string,
  overrides: ReviewPathOverrides = {},
): Promise<ReviewArtifactPaths> {
  const usersReports =
    overrides.usersReport === null
      ? []
      : overrides.usersReport === undefined
        ? await listUsersReportPaths(root)
        : [overrides.usersReport];
  return {
    pending: resolve(root, overrides.pending ?? "data/live-bets.json"),
    ticker: resolve(root, overrides.ticker ?? "data/live-wagers.json"),
    gradedToday: resolve(
      root,
      overrides.gradedToday ?? "Scratch/graded/graded-today.json",
    ),
    gradedOctWindow: resolve(
      root,
      overrides.gradedOctWindow ?? "Scratch/graded/graded-oct-window.json",
    ),
    usersReports,
    roster: resolve(
      root,
      overrides.roster ?? "Scratch/raw-f402-list-agents.json",
    ),
    ledger: resolve(
      root,
      overrides.ledger ?? "Scratch/f402-suspected-bots-raw-ledger-bundle.json",
    ),
    book: resolve(root, overrides.book ?? "enriched_customers_full.json"),
  };
}

interface ReadArtifactResult {
  readonly file: ArtifactFile;
  readonly value: unknown;
}

async function readArtifact(
  id: ReviewArtifactId,
  label: string,
  path: string,
  nowMs: number,
): Promise<ReadArtifactResult> {
  const bunFile = Bun.file(path);
  if (!(await bunFile.exists())) {
    return {
      value: null,
      file: {
        id,
        label,
        path,
        exists: false,
        bytes: null,
        mtimeIso: null,
        ageMinutes: null,
        records: null,
        note: null,
      },
    };
  }
  const stat = await bunFile.stat();
  const mtimeMs = stat.mtimeMs;
  const base = {
    id,
    label,
    path,
    exists: true,
    bytes: stat.size,
    mtimeIso: new Date(mtimeMs).toISOString(),
    ageMinutes: Math.max(0, (nowMs - mtimeMs) / 60_000),
  } as const;
  try {
    const value: unknown = JSON.parse(await bunFile.text());
    return { value, file: { ...base, records: null, note: null } };
  } catch {
    return {
      value: null,
      file: {
        ...base,
        records: null,
        note: "unparseable JSON: kept as exists:true with unknown rows, not zero rows",
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Normalized rows                                                            */
/* -------------------------------------------------------------------------- */

/** American odds from a trailing price on the selection text ("Ben Kohles +3300"). */
export function americanOddsFromText(selection: string): number | null {
  const match = selection.match(/([+-]\d{2,6})\s*$/);
  if (match === null) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * American odds implied by the risk/win amounts. The portal writes `ToWinAmount` from the price,
 * so this recovers the quoted number when the selection text carries only the team name.
 */
export function americanOddsFromAmounts(
  riskUsd: number,
  toWinUsd: number,
): number | null {
  if (riskUsd <= 0 || toWinUsd <= 0) return null;
  if (toWinUsd >= riskUsd) return Math.round((toWinUsd / riskUsd) * 100);
  return -Math.round((riskUsd / toWinUsd) * 100);
}

/** Implied probability of American odds; null when the price is absent or nonsensical. */
export function impliedProbability(american: number | null): number | null {
  if (american === null) return null;
  if (american > 0) return 100 / (american + 100);
  if (american < 0) return -american / (-american + 100);
  return null;
}

export interface PendingWagerRow {
  readonly customerId: string;
  readonly ticket: string;
  readonly wagerNumber: string;
  readonly placedAt: string;
  readonly sport: string;
  readonly subSport: string;
  readonly period: string;
  readonly selection: string;
  readonly description: string;
  readonly priceAmerican: number | null;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  readonly agent: string;
  readonly status: string;
  readonly picks: number;
}

/** `data/live-bets.json` — the Pending capture. One row per ticket leg. */
export function pendingWagerRows(value: unknown): readonly PendingWagerRow[] {
  const doc = asRow(value);
  const games = doc === null ? rowsOf(value) : rowsOf(doc["games"]);
  const rows: PendingWagerRow[] = [];
  for (const row of games) {
    const customerId = customerIdOf(row);
    const sel = singleLine(row.chosenTeam) ?? singleLine(row.description);
    if (customerId === null || sel === null) continue;
    const riskUsd = usdFromWire(row.wagered);
    const toWinUsd = usdFromWire(row.toWin);
    const agent = asRow(row.agent);
    rows.push({
      customerId,
      ticket: text(row.ticketNumber) ?? "",
      wagerNumber: text(row.wagerNumber) ?? "",
      placedAt: text(row.acceptedAt) ?? "",
      sport: text(row.sport) ?? "",
      subSport: text(row.subSport) ?? "",
      period: text(row.period) ?? "",
      selection: sel,
      description: singleLine(row.description) ?? "",
      priceAmerican:
        americanOddsFromText(sel) ?? americanOddsFromAmounts(riskUsd, toWinUsd),
      riskUsd,
      toWinUsd,
      agent: text(agent?.key) ?? "",
      status: text(row.status) ?? "",
      picks: num(row.picks) ?? 1,
    });
  }
  return rows;
}

/** Capture-level facts a per-customer row cannot answer: total exposure and stamp. */
export interface PendingCaptureTotals {
  readonly rows: number;
  readonly customers: number;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  readonly capturedAt: string | null;
  /** Rows whose GameDateTime equals AcceptedAt: the capture carries accept time in both fields. */
  readonly acceptEqualsGame: number;
}

export function pendingCaptureTotals(value: unknown): PendingCaptureTotals {
  const doc = asRow(value);
  const games = doc === null ? rowsOf(value) : rowsOf(doc["games"]);
  const customers = new Set<string>();
  let riskUsd = 0;
  let toWinUsd = 0;
  let acceptEqualsGame = 0;
  for (const row of games) {
    const customerId = customerIdOf(row);
    if (customerId !== null) customers.add(customerId);
    riskUsd += usdFromWire(row.wagered);
    toWinUsd += usdFromWire(row.toWin);
    const accepted = text(row.acceptedAt);
    const game = text(row.gameDateTime);
    if (accepted !== null && game !== null && accepted === game) {
      acceptEqualsGame += 1;
    }
  }
  const capturedAt =
    doc === null
      ? null
      : (text(doc["capturedAt"]) ?? text(doc["observedAt"]) ?? null);
  return {
    rows: games.length,
    customers: customers.size,
    riskUsd,
    toWinUsd,
    capturedAt,
    acceptEqualsGame,
  };
}

export interface TickerWagerRow {
  readonly customerId: string;
  readonly agent: string;
  readonly wagerType: string;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  readonly wagerNumber: string;
  readonly placedAt: string;
  readonly description: string;
  readonly writer: string;
}

/** `data/live-wagers.json` — the ticker capture. Same snapshot as Pending, different projection. */
export function tickerWagerRows(value: unknown): readonly TickerWagerRow[] {
  const doc = asRow(value);
  const list =
    doc === null
      ? rowsOf(value)
      : rowsOf(doc["LIST"]).length > 0
        ? rowsOf(doc["LIST"])
        : rowsOf(doc["wagers"]);
  const rows: TickerWagerRow[] = [];
  for (const row of list) {
    const customerId = customerIdOf(row);
    if (customerId === null) continue;
    // The review surface must use the same writer policy as the profile build:
    // ALERT mirrors and blocked rows are not book positions.
    if (ticketWriterDisposition(row.TicketWriter) !== "book") continue;
    rows.push({
      customerId,
      agent: text(row.AgentID) ?? text(row.AgentLogin) ?? "",
      wagerType: text(row.WagerType) ?? "",
      riskUsd: usdFromWire(row.AmountWagered),
      toWinUsd: usdFromWire(row.ToWinAmount),
      wagerNumber: String(num(row.WagerNumber) ?? ""),
      placedAt: text(row.InsertDateTime) ?? "",
      description: singleLine(row.ShortDesc) ?? "",
      writer: text(row.TicketWriter) ?? "",
    });
  }
  return rows;
}

export interface GradedWagerRow {
  readonly customerId: string;
  readonly ticket: string;
  readonly wagerNumber: string;
  readonly placedAt: string;
  readonly picks: number;
  readonly wagerType: string;
  readonly status: string;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  /** Profit on a winner. Equal to `ToWinAmount`; the stake is returned separately. */
  readonly profitUsd: number;
  readonly lostUsd: number;
  readonly refundedUsd: number;
  readonly freePlay: boolean;
  readonly credit: boolean;
  readonly writer: string;
  readonly parlayName: string;
  readonly description: string;
  /** Source file the row came from, so a duplicated window is visible. */
  readonly source: string;
}

/** One graded-wager JSON export (the manager writes an array of raw wire rows). */
export function gradedWagerRows(
  value: unknown,
  source: string,
): readonly GradedWagerRow[] {
  const rows = rowsOf(value);
  const out: GradedWagerRow[] = [];
  for (const row of rows) {
    const customerId = customerIdOf(row);
    if (customerId === null) continue;
    out.push({
      customerId,
      ticket: text(row.TicketNumber) ?? "",
      wagerNumber: text(row.WagerNumber) ?? "",
      placedAt: text(row.AcceptedDateTime) ?? "",
      picks: num(row.TotalPicks) ?? 0,
      wagerType: text(row.WagerType) ?? "",
      status: text(row.WagerStatus) ?? "",
      riskUsd: usdFromWire(row.AmountWagered),
      toWinUsd: usdFromWire(row.ToWinAmount),
      profitUsd: usdFromWire(row.AmountWon),
      lostUsd: usdFromWire(row.AmountLost),
      refundedUsd: usdFromWire(row.AmountRefunded),
      freePlay: text(row.FreePlayFlag) === "Y",
      credit: text(row.CreditAcctFlag) === "Y",
      writer: text(row.TicketWriter) ?? "",
      parlayName: text(row.ParlayName) ?? "",
      description: singleLine(row.Description) ?? "",
      source,
    });
  }
  return out;
}

export interface UsersReportRow {
  readonly customerId: string;
  readonly userId: string;
  readonly groupName: string;
  readonly agent: string;
  readonly suspectedBot: boolean | null;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  readonly profitUsd: number;
  readonly betUsd: number;
  readonly wagerCount: number;
  readonly legCount: number;
}

/** A `Scratch/gslive-reports-<date>/users-report-<start>-<end>.json` export (reportType 2). */
export function usersReportRows(value: unknown): readonly UsersReportRow[] {
  const rows = rowsOf(value);
  const out: UsersReportRow[] = [];
  for (const row of rows) {
    const customerId = customerIdOf(row);
    if (customerId === null) continue;
    const suspected = row["isSuspectedBot"];
    out.push({
      customerId,
      userId: text(row["userId"]) ?? "",
      groupName: text(row["groupName"]) ?? "",
      agent: text(row["agent"]) ?? "",
      suspectedBot: typeof suspected === "boolean" ? suspected : null,
      riskUsd: num(row["risk"]) ?? 0,
      toWinUsd: num(row["toWin"]) ?? 0,
      profitUsd: num(row["profit"]) ?? 0,
      betUsd: num(row["bet"]) ?? 0,
      wagerCount: num(row["wagerCount"]) ?? 0,
      legCount: num(row["legCount"]) ?? 0,
    });
  }
  return out;
}

export interface RosterPlayerRow {
  readonly customerId: string;
  readonly agent: string;
}

/** `Scratch/raw-f402-list-agents.json` — the agent roster (`PLAYERS[]`). */
export function rosterPlayerRows(value: unknown): readonly RosterPlayerRow[] {
  const doc = asRow(value);
  const players = doc === null ? rowsOf(value) : rowsOf(doc["PLAYERS"]);
  const out: RosterPlayerRow[] = [];
  for (const row of players) {
    const customerId = customerIdOf(row);
    if (customerId === null) continue;
    out.push({ customerId, agent: text(row["Agent"]) ?? "" });
  }
  return out;
}

export interface LedgerTenureTotals {
  readonly totalTickets: number | null;
  readonly preWindowTickets: number | null;
  readonly inWindowTickets: number | null;
  readonly wageredUsd: number | null;
  readonly netUsd: number | null;
  readonly firstAcceptedDateTime: string | null;
  readonly lastAcceptedDateTime: string | null;
  readonly writers: readonly string[];
}

/**
 * The suspected-bot bundle's `customerLedgerTenure` block, cross-checked against the parsed
 * exports. Field names end in `Cents` but the values equal the dollar sums of the graded exports
 * (measured 2026-11-16 on TTN97: 51,375 and -6,490); the review labels them USD rather than
 * silently dividing by 100.
 */
export function ledgerTenure(
  value: unknown,
  customerId: string,
): LedgerTenureTotals | null {
  const doc = asRow(value);
  if (doc === null) return null;
  const tenure = asRow(doc["customerLedgerTenure"]);
  if (tenure === null) return null;
  let entry = asRow(tenure[customerId]);
  if (entry === null) {
    for (const [key, candidate] of Object.entries(tenure)) {
      if (normalizeCustomerId(key) !== customerId) continue;
      entry = asRow(candidate);
      if (entry !== null) break;
    }
  }
  if (entry === null) return null;
  const writers = Array.isArray(entry["writers"])
    ? entry["writers"].filter((w): w is string => typeof w === "string")
    : [];
  return {
    totalTickets: num(entry["totalTickets"]),
    preWindowTickets: num(entry["preWindowTickets"]),
    inWindowTickets: num(entry["inWindowTickets"]),
    wageredUsd: usdFromWire(entry["totalWageredCents"]),
    netUsd: usdFromWire(entry["totalNetCents"]),
    firstAcceptedDateTime: text(entry["firstAcceptedDateTime"]),
    lastAcceptedDateTime: text(entry["lastAcceptedDateTime"]),
    writers,
  };
}

export interface LedgerTenurePopulationRow {
  readonly tickets: number;
  readonly wageredUsd: number;
  readonly netUsd: number;
}

/**
 * The whole `customerLedgerTenure` block, as a comparison population. Percentiles computed from it
 * describe the ledger-tenure population, not the platform: the block is whatever the bundle builder
 * carried (6,998 accounts on the 2026-11-16 artifact), and the review labels it that way.
 */
export function ledgerTenurePopulation(
  value: unknown,
): readonly LedgerTenurePopulationRow[] | null {
  const doc = asRow(value);
  if (doc === null) return null;
  const tenure = asRow(doc["customerLedgerTenure"]);
  if (tenure === null) return null;
  const out: LedgerTenurePopulationRow[] = [];
  for (const entry of Object.values(tenure)) {
    const row = asRow(entry);
    if (row === null) continue;
    const wagered = num(row["totalWageredCents"]);
    const net = num(row["totalNetCents"]);
    const tickets = num(row["totalTickets"]);
    if (wagered === null || net === null || tickets === null) continue;
    out.push({
      tickets,
      wageredUsd: wagered / WIRE_MONEY_PER_USD,
      netUsd: net / WIRE_MONEY_PER_USD,
    });
  }
  return out;
}

export interface PlatformDayContext {
  /** The customer's graded activity days; the context is computed on exactly those days. */
  readonly days: readonly string[];
  readonly rows: number;
  readonly customers: number;
  readonly multiLegSharePct: number | null;
  readonly medianStakeUsd: number | null;
  readonly p90StakeUsd: number | null;
  readonly largestMultiLegTicket: {
    readonly customerId: string;
    readonly ticket: string;
    readonly wagers: number;
    readonly picks: number;
    readonly riskUsd: number;
  } | null;
  readonly note: string;
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
};

/** Platform context on the customer's active days, from the recent graded export. */
export function platformDayContext(
  rows: readonly GradedWagerRow[],
  days: readonly string[],
): PlatformDayContext | null {
  if (days.length === 0) return null;
  const daySet = new Set(days);
  const windowRows = rows.filter((row) =>
    daySet.has(row.placedAt.slice(0, 10)),
  );
  if (windowRows.length === 0) return null;
  const customers = new Set(windowRows.map((row) => row.customerId));
  let multiLeg = 0;
  const stakes: number[] = [];
  const tickets = new Map<string, GradedWagerRow[]>();
  for (const row of windowRows) {
    if (row.picks >= 2) multiLeg += 1;
    stakes.push(row.riskUsd);
    if (row.ticket !== "") {
      const key = `${row.customerId}|${row.ticket}`;
      const list = tickets.get(key);
      if (list === undefined) tickets.set(key, [row]);
      else list.push(row);
    }
  }
  let largest: PlatformDayContext["largestMultiLegTicket"] = null;
  for (const [key, list] of tickets) {
    const maxPicks = Math.max(...list.map((row) => row.picks));
    if (maxPicks < 2) continue;
    if (largest !== null && list.length <= largest.wagers) continue;
    const [customerId = "", ticket = ""] = key.split("|");
    largest = {
      customerId,
      ticket,
      wagers: list.length,
      picks: maxPicks,
      riskUsd: list.reduce((total, row) => total + row.riskUsd, 0),
    };
  }
  const sortedStakes = [...stakes].sort((a, b) => a - b);
  const observedDays = [
    ...new Set(windowRows.map((row) => row.placedAt.slice(0, 10))),
  ]
    .filter((day) => day !== "")
    .sort();
  return {
    days: observedDays,
    rows: windowRows.length,
    customers: customers.size,
    multiLegSharePct:
      windowRows.length > 0
        ? Math.round((multiLeg / windowRows.length) * 10000) / 100
        : null,
    medianStakeUsd: median(stakes),
    p90StakeUsd:
      sortedStakes[
        Math.min(sortedStakes.length - 1, Math.floor(0.9 * sortedStakes.length))
      ] ?? null,
    largestMultiLegTicket: largest,
    note:
      "Computed from the recent graded export on the customer's own activity days; the older " +
      "window is excluded so the comparison is not stretched across months.",
  };
}

export interface BookPresence {
  readonly totalCustomers: number;
  readonly found: boolean;
}

/** `enriched_customers_full.json` — presence only. The book is a fixture cohort on this desk. */
export function bookPresence(value: unknown, customerId: string): BookPresence {
  const rows = rowsOf(value);
  let found = false;
  for (const row of rows) {
    const id = customerIdOf(row);
    if (id === customerId) {
      found = true;
      break;
    }
  }
  return { totalCustomers: rows.length, found };
}

/* -------------------------------------------------------------------------- */
/* Load                                                                       */
/* -------------------------------------------------------------------------- */

export interface LoadedCustomerWagerArtifacts {
  readonly customerId: string;
  readonly generatedAt: string;
  readonly sources: readonly ArtifactFile[];
  readonly matched: Readonly<Record<ReviewArtifactId, number>>;
  readonly pending: readonly PendingWagerRow[];
  readonly pendingCapture: PendingCaptureTotals;
  readonly ticker: readonly TickerWagerRow[];
  readonly graded: readonly GradedWagerRow[];
  readonly users: readonly UsersReportRow[];
  readonly roster: readonly RosterPlayerRow[];
  readonly ledger: LedgerTenureTotals | null;
  readonly ledgerPopulation: readonly LedgerTenurePopulationRow[] | null;
  readonly platform: PlatformDayContext | null;
  readonly cardCorpus: CardCorpus;
  readonly book: BookPresence | null;
}

export interface LoadCustomerWagerArtifactsOptions {
  readonly customerId: string;
  /** Checkout root the default paths are relative to. */
  readonly root: string;
  readonly nowMs?: number;
  readonly overrides?: ReviewPathOverrides;
}

export interface DuplicateGradedRow {
  readonly key: string;
  readonly keptFrom: string;
  readonly droppedFrom: string;
}

/** De-duplicate overlapping graded exports by ticket+wager; first file wins. */
export function dedupeGradedRows(rows: readonly GradedWagerRow[]): {
  readonly rows: readonly GradedWagerRow[];
  readonly duplicates: readonly DuplicateGradedRow[];
} {
  const seen = new Map<string, GradedWagerRow>();
  const duplicates: DuplicateGradedRow[] = [];
  for (const row of rows) {
    const key = `${row.ticket}-${row.wagerNumber}`;
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, row);
      continue;
    }
    duplicates.push({
      key,
      keptFrom: existing.source,
      droppedFrom: row.source,
    });
  }
  return { rows: [...seen.values()], duplicates };
}

export async function loadCustomerWagerArtifacts(
  options: LoadCustomerWagerArtifactsOptions,
): Promise<LoadedCustomerWagerArtifacts> {
  const customerId = normalizeCustomerId(options.customerId);
  const nowMs = options.nowMs ?? Date.now();
  const root = options.root;
  const paths = await resolveReviewArtifactPaths(root, options.overrides ?? {});

  const usersReadsPromise = Promise.all(
    paths.usersReports.map((path) =>
      readArtifact("users_report", "Users report export", path, nowMs),
    ),
  );

  const [
    pendingFile,
    tickerFile,
    gradedTodayFile,
    gradedOctFile,
    rosterFile,
    ledgerFile,
    bookFile,
    usersReads,
  ] = await Promise.all([
    readArtifact("pending", "F402 live Pending capture", paths.pending, nowMs),
    readArtifact("ticker", "F402 live ticker capture", paths.ticker, nowMs),
    readArtifact(
      "graded_today",
      "Graded wagers export",
      paths.gradedToday,
      nowMs,
    ),
    readArtifact(
      "graded_oct",
      "Graded wagers export (older window)",
      paths.gradedOctWindow,
      nowMs,
    ),
    readArtifact("roster", "Agent roster", paths.roster, nowMs),
    readArtifact("ledger", "Suspected-bot ledger bundle", paths.ledger, nowMs),
    readArtifact("book", "Enriched customer book", paths.book, nowMs),
    usersReadsPromise,
  ]);

  const pendingAll = pendingWagerRows(pendingFile.value);
  const pendingCapture = pendingCaptureTotals(pendingFile.value);
  const pending = pendingAll.filter((row) => row.customerId === customerId);

  const tickerAll = tickerWagerRows(tickerFile.value);
  const ticker = tickerAll.filter((row) => row.customerId === customerId);

  const gradedAll: GradedWagerRow[] = [];
  const gradedTodayRows = gradedWagerRows(
    gradedTodayFile.value,
    gradedTodayFile.file.path,
  );
  const gradedOctRows = gradedWagerRows(
    gradedOctFile.value,
    gradedOctFile.file.path,
  );
  gradedAll.push(...gradedTodayRows, ...gradedOctRows);
  const deduped = dedupeGradedRows(
    gradedAll.filter((row) => row.customerId === customerId),
  );
  const graded = [...deduped.rows].sort((a, b) =>
    a.placedAt.localeCompare(b.placedAt),
  );

  const usersRowsByPath = new Map<string, readonly UsersReportRow[]>();
  for (const read of usersReads) {
    usersRowsByPath.set(read.file.path, usersReportRows(read.value));
  }
  const usersMatchedFiles = usersReads
    .filter((read) =>
      (usersRowsByPath.get(read.file.path) ?? []).some(
        (row) => row.customerId === customerId,
      ),
    )
    .map((read) => read.file.path);
  // Newest export that actually carries the customer. Newest overall is a fallback only so the
  // source list can show what was scanned when nobody carries the login.
  const usersChosen =
    usersReads.find((read) => usersMatchedFiles.includes(read.file.path)) ??
    usersReads[0] ??
    null;
  const usersAll =
    usersChosen === null
      ? []
      : (usersRowsByPath.get(usersChosen.file.path) ?? []);
  const users = usersAll.filter((row) => row.customerId === customerId);
  const usersTotalRecords = [...usersRowsByPath.values()].reduce(
    (total, rows) => total + rows.length,
    0,
  );
  const usersSource: ArtifactFile =
    usersChosen === null
      ? {
          id: "users_report",
          label: "Users report export",
          path: "",
          exists: false,
          bytes: null,
          mtimeIso: null,
          ageMinutes: null,
          records: null,
          note: "no Scratch/gslive-reports-*/users-report-*.json found",
        }
      : {
          ...usersChosen.file,
          records: usersTotalRecords,
          note:
            `scanned ${usersReads.length} export(s); customer present in ` +
            `${usersMatchedFiles.length}` +
            (usersMatchedFiles.length === 0
              ? ""
              : ` (${usersMatchedFiles
                  .map((path) => path.slice(path.lastIndexOf("/") + 1))
                  .join(", ")})`),
        };

  const rosterAll = rosterPlayerRows(rosterFile.value);
  const roster = rosterAll.filter((row) => row.customerId === customerId);

  const ledger = ledgerTenure(ledgerFile.value, customerId);
  const ledgerPopulation = ledgerTenurePopulation(ledgerFile.value);
  const activeDays = [
    ...new Set(graded.map((row) => row.placedAt.slice(0, 10))),
  ]
    .filter((day) => day !== "")
    .sort();
  const platform = platformDayContext(gradedTodayRows, activeDays);
  const cardCorpus = summarizeCardCorpus(gradedTodayRows);
  const book = bookFile.file.exists
    ? bookPresence(bookFile.value, customerId)
    : null;

  const files = [
    pendingFile.file,
    tickerFile.file,
    gradedTodayFile.file,
    gradedOctFile.file,
    usersSource,
    rosterFile.file,
    ledgerFile.file,
    bookFile.file,
  ];
  const recordsByFile = new Map<string, number>([
    [pendingFile.file.id, pendingAll.length],
    [tickerFile.file.id, tickerAll.length],
    [gradedTodayFile.file.id, gradedTodayRows.length],
    [gradedOctFile.file.id, gradedOctRows.length],
    [usersSource.id, usersTotalRecords],
    [rosterFile.file.id, rosterAll.length],
    [ledgerFile.file.id, ledgerFile.file.exists ? 1 : 0],
    [
      bookFile.file.id,
      bookFile.file.exists ? rowsOf(bookFile.value).length : 0,
    ],
  ]);
  const matchedByFile: Record<ReviewArtifactId, number> = {
    pending: pending.length,
    ticker: ticker.length,
    graded_today: gradedTodayRows.filter((r) => r.customerId === customerId)
      .length,
    graded_oct: gradedOctRows.filter((r) => r.customerId === customerId).length,
    users_report: users.length,
    roster: roster.length,
    ledger: ledger === null ? 0 : 1,
    book: book !== null && book.found ? 1 : 0,
  };

  const sources = files.map((file) => ({
    ...file,
    records: recordsByFile.get(file.id) ?? file.records,
    note:
      file.id === "graded_oct" && deduped.duplicates.length > 0
        ? `${deduped.duplicates.length} rows duplicated across graded exports were dropped`
        : file.note,
  }));

  return {
    customerId,
    generatedAt: new Date(nowMs).toISOString(),
    sources,
    matched: matchedByFile,
    pending,
    pendingCapture,
    ticker,
    graded,
    users,
    roster,
    ledger,
    ledgerPopulation,
    platform,
    cardCorpus,
    book,
  };
}
