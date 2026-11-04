/** Sort all GSLive wagers (and their legs) by wager state, and emit the schema-v2 report.
 *
 *  Primary mode is LIVE: `POST https://plive.sportswidgets.pro/manager-tools/ajax.php`
 *  (`action: "getBetReport"`, `state:""` = All), then every wager ordered by canonical state,
 *  preserving the endpoint's own order inside a state. The session comes from the environment
 *  (SSOT `.env` mount); it is never a literal and never printed.
 *
 *  Fallback mode is offline: `--csv <bet-report.csv>` sorts a retained export, with its mtime
 *  carried as provenance. An export is not a live board and must be labelled as a snapshot.
 *
 *  Legs vs wagers: one CSV row (or one `ajax.php` row) is a LEG. A wager is a distinct `Ticket`,
 *  and a parlay repeats the same `Risk` on every leg — so `legs` and `wagers` are different
 *  columns. `wagerRisk` is wager-scoped (deduped by Ticket) and `wagerRiskAttributed` splits each
 *  ticket's risk across the leg states it touches, so the state column sums exactly to the
 *  totals. `legRisk`/`legToWin`/`legResult` are LEG-scoped diagnostics: a parlay's per-leg payout
 *  values are not a ticket total, so wager To Win / Result are deliberately absent.
 *
 *  Canonical order is the observed GSLive vocabulary (`pending` -> `cancel after confirmation`);
 *  states outside that set follow alphabetically so a new/renamed state is visible, not lost.
 *  Numeric state codes are mapped through the observed table (see `fetch-bet-tally.ts`) and every
 *  observed code is reported; unmapped codes stay visible as `(code N)` and count as unknown.
 *
 *  The contract this file produces is `scratch/wagers-by-state.schema.v2.json` (input to
 *  `dsh-plugin/index.js` `sportsdesk_wagers`). A missing artifact is MISSING, never zero states;
 *  an unknown `schemaVersion` is UNSUPPORTED, never best-effort parsed.
 *
 *  Usage:
 *    GSID=... bun run wagers:by-state --live --payload scratch/ajax-getBetReport-body.json    # verbatim body
 *    GSID=... bun run wagers:by-state --live --from 1793163600 --to 1793771999
 *    bun run wagers:by-state --live --dry-run            # payload only; no network, no secret
 *    GSID=... bun run wagers:by-state --live --bootstrap-session   # signin -> x-gs-session
 *    bun run wagers:by-state --csv <path/bet-report.csv> --json scratch/gslive-wagers-by-state.summary.json
 *
 *  Wager rows include customer logins, so outputs live in `scratch/` (gitignored).
 */

import { mkdir, rename } from "node:fs/promises";
import { parseGsliveTimestampMs } from "../lib/gslive_bet_event_log.ts";
import { parseArgs } from "node:util";

import { sessionFromGsliveProfile } from "../lib/gslive_session.ts";

import { z } from "zod";

import {
  AJAX_URL,
  bootstrapGanchrowSession,
  fetchBetReportRows,
  fetchBetReportRowsFromPayload,
  GSLIVE_NUMERIC_STATE_MAP,
  parseBetReportRequest,
  parseDateFilterBy,
  requireManagerSession,
  sessionGateFromEnv,
  stateLabel,
  type DateFilterBy,
} from "./fetch-bet-tally.ts";
import {
  JSONL,
  argv,
  env,
  file as bunFile,
  randomUUIDv7,
  stringWidth,
  wrapAnsi,
  write,
} from "bun";

/** Observed GSLive wager states, in report order. */
export const GSLIVE_STATE_ORDER = [
  "pending",
  "win",
  "lose",
  "push",
  "cashout",
  "half win",
  "half lose",
  "cancel",
  "cancel after confirmation",
] as const;

export const MISSING_STATE = "(missing)";

/** States whose money has settled. Cashout/cancel are excluded from the grade-lag sample. */
export const SETTLED_STATES: readonly string[] = [
  "win",
  "lose",
  "push",
  "half win",
  "half lose",
];

/** Contract money-scope line: tells the consumer which columns are wager-scoped. */
export const MONEY_SCOPE =
  "wager columns deduped/allocated by Ticket; leg columns are leg-scoped diagnostics";

/** Columns kept per leg. Deliberately excludes IP and free-text log/notes columns. */
export const WAGER_COLUMNS = [
  "State",
  "Bet Time",
  "Player",
  "Agent",
  "Ticket",
  "Id",
  "Bet Group",
  "Sport / League",
  "Event Details",
  "Market",
  "Period",
  "Side",
  "Type",
  "Risk",
  "To Win",
  "Result",
  "Bet price",
  "Grade Time",
] as const;

export type WagerColumn = (typeof WAGER_COLUMNS)[number];

/** Candidate wager id fields in a live `ajax.php` row (the export calls it `Ticket`). */
const TICKET_FIELD_CANDIDATES = [
  "Ticket",
  "ticket",
  "ticketNumber",
  "TicketNumber",
  "wagerId",
  "WagerId",
  "betGroupId",
  "BetGroupId",
] as const;

/** Candidate bet-time fields in a live `ajax.php` row. */
const TIME_FIELD_CANDIDATES = [
  "Bet Time",
  "BetTime",
  "betTime",
  "time",
  "Time",
  "placedAt",
  "wagerTime",
  "logTime",
  "date",
] as const;

const RISK_FIELD_CANDIDATES = ["Risk", "risk", "riskAmount", "amount"] as const;

/** Live response state fields: the observed request body uses lowercase, exports use `State`. */
const LIVE_STATE_FIELD_CANDIDATES = [
  "State",
  "state",
  "Status",
  "status",
  "betState",
  "BetState",
  "betStatus",
  "BetStatus",
] as const;

const TO_WIN_FIELD_CANDIDATES = [
  "To Win",
  "ToWin",
  "toWin",
  "toWinAmount",
  "payout",
] as const;

const RESULT_FIELD_CANDIDATES = ["Result", "result", "resultAmount"] as const;

const GRADE_FIELD_CANDIDATES = [
  "Grade Time",
  "GradeTime",
  "gradeTime",
  "gradedAt",
  "settledAt",
] as const;

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Money is aggregated in integer cents so the state allocation sums exactly. */
function toCents(value: number): number {
  return Math.round(value * 100);
}

function fromCents(cents: number): number {
  return cents / 100;
}

/** One leg, reduced to the fields the v2 report measures. */
export interface WagerLeg {
  /** Canonical state label; `(missing)` when the source cell is blank. */
  readonly state: string;
  /** Wager id (all legs of one parlay share it); null when the row has none. */
  readonly ticket: string | null;
  readonly risk: number;
  readonly toWin: number;
  readonly result: number;
  /** Epoch ms parsed from the bet time; null when unparseable. */
  readonly betTimeMs: number | null;
  /** Epoch ms parsed from `Grade Time`; null when unparseable or blank. */
  readonly gradeTimeMs: number | null;
  /** Raw numeric state code when the source used one (mapped or not); else null. */
  readonly numericCode: number | null;
}

export interface WagerRow extends WagerLeg {
  /** Leg id, when the source has one. */
  readonly legId: string;
  /** Raw `Bet Time` cell, preserved for the output even when it cannot be parsed. */
  readonly betTimeText: string;
  readonly cells: Readonly<Record<WagerColumn, string>>;
}

export interface StateAggregate {
  readonly state: string;
  /** Rows/legs in this state. */
  readonly legs: number;
  /** Distinct tickets with at least one leg in this state (a spanning wager counts in each). */
  readonly wagers: number;
  readonly legRisk: number;
  readonly legToWin: number;
  readonly legResult: number;
}

export interface WagerSummary {
  readonly legs: number;
  readonly wagers: number;
  /** Wagers whose legs do not all share one state. */
  readonly spanning: number;
}

export interface PendingAgeBuckets {
  readonly gt1h: number;
  readonly gt6h: number;
  readonly gt24h: number;
  readonly gt72h: number;
}

export interface GradeLagPercentiles {
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p99: number | null;
  /** Settled legs with both a Bet Time and a Grade Time (the percentile sample size). */
  readonly settledLegs: number;
}

/**
 * Provenance is a sum type: an offline snapshot has a file path/mtime and no request, a live read
 * has the request provenance and no file. The old bag-of-optionals admitted "offline-csv with a
 * URL" and "live-ajax.php without a capturedAt", which are not real states.
 */
export interface OfflineWagerSource {
  readonly kind: "offline-csv";
  readonly path: string;
  readonly mtime: string;
  readonly dateFilterBy: null;
}

export interface LiveWagerSource {
  readonly kind: "live-ajax.php";
  readonly path: null;
  readonly mtime: null;
  readonly dateFilterBy: DateFilterBy;
  readonly url: string;
  readonly action: "getBetReport";
  readonly stateFilter: "";
  readonly fromEpochSec: number;
  readonly toEpochSec: number;
  readonly capturedAt: string;
}

export type WagerReportSource = OfflineWagerSource | LiveWagerSource;

/** A live read's capture time; an offline snapshot has no capture, so "now" is the only clock. */
function captureTimeOf(source: WagerReportSource): string {
  return source.kind === "live-ajax.php"
    ? source.capturedAt
    : new Date().toISOString();
}

export interface WagerReportWindow {
  readonly observedStart: string | null;
  readonly observedEnd: string | null;
  readonly spanHours: number | null;
  readonly fromEpochSec: number | null;
  readonly toEpochSec: number | null;
  /** Wall-clock age of the observation at generation time (now - observedEnd). */
  readonly ageMinutes: number | null;
  /** Source-file mtime minus observedEnd: how complete the export was (offline only). */
  readonly snapshotLagMinutes: number | null;
}

export interface WagerReportIdentity {
  readonly ticketField: string | null;
  readonly coveragePct: number;
  readonly distinctWagers: number | null;
  readonly spanningWagers: number | null;
  readonly multiLegWagers: number | null;
}

export interface WagerReportTotals {
  readonly legs: number;
  readonly wagers: number | null;
  readonly spanning: number | null;
  readonly legRisk: number;
  readonly legToWin: number;
  readonly legResult: number;
  readonly wagerRisk: number | null;
}

export interface WagerStateRow {
  readonly state: string;
  readonly legs: number;
  readonly wagers: number | null;
  /** Ticket risk / state spread; the column sums exactly to totals.wagerRisk. */
  readonly wagerRiskAttributed: number | null;
  readonly legRisk: number;
  readonly legToWin: number;
  readonly legResult: number;
  /** Age at snapshot end for the pending legs in this state; null outside `pending`. */
  readonly pendingAgeMinutes: PendingAgeBuckets | null;
  /** Grade lag p50 for this state's settled legs; null when it has none. */
  readonly gradeLagMinutesP50: number | null;
}

export interface WagerReportQuality {
  readonly ticketCoveragePct: number;
  readonly unparsedBetTimes: number;
  readonly unknownStates: readonly string[];
  readonly numericStateCodes: readonly number[];
  readonly coherenceViolations: {
    readonly winResultNonPositive: number;
    readonly loseResultNonNegative: number;
  };
  readonly gradeLagMinutes: GradeLagPercentiles;
  readonly pendingAgeMinutes: PendingAgeBuckets;
}

/** The v2 artifact consumed by `dsh-plugin/index.js` `sportsdesk_wagers`. */
export interface WagerReport {
  readonly schemaVersion: 2;
  readonly source: WagerReportSource;
  readonly window: WagerReportWindow;
  readonly identity: WagerReportIdentity;
  readonly totals: WagerReportTotals;
  readonly states: readonly WagerStateRow[];
  readonly quality: WagerReportQuality;
  readonly moneyScope: string;
  readonly notes: readonly string[];
}

export interface AnalysisWindowFallback {
  readonly fromEpochSec: number | null;
  readonly toEpochSec: number | null;
}

export interface WagerAnalysisOptions {
  readonly source: WagerReportSource;
  /** Wall clock at generation time, so ageMinutes is measured, not asserted. */
  readonly nowMs: number;
  /** Pending-age anchor; null means the observed end (offline snapshot semantics). */
  readonly anchorMs?: number | null;
  readonly ticketField: string | null;
  readonly ticketCoveragePct: number;
  /** Request window for a live read; from/to only, never substituted for observed times. */
  readonly windowFallback?: AnalysisWindowFallback | null;
  readonly extraNotes?: readonly string[];
}

/**
 * RFC 4180 CSV parser: quoted fields, doubled quotes, embedded commas/newlines, CRLF, BOM.
 * Returns rows of raw cells; blank trailing lines are dropped.
 */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function headerIndex(header: readonly string[]): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  header.forEach((name, position) => {
    const clean = name.replace(/^\uFEFF/, "").trim();
    if (!index.has(clean)) index.set(clean, position);
  });
  return index;
}

/** Money cells are plain decimal strings in the export; strip separators/currency symbols. */
export function parseMoney(cell: string): number {
  const cleaned = cell.replace(/[^0-9.-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return 0;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : 0;
}

/** "20:50:49 10/24/2026" -> epoch ms in the local zone. Null when it does not match. */
export function parseBetTime(cell: string): number | null {
  const match = cell
    .trim()
    .match(/^(\d{1,2}):(\d{2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match === null) return null;
  const [
    ,
    hh = "0",
    mm = "0",
    ss = "0",
    month = "1",
    day = "1",
    year = "1970",
  ] = match;
  const pad = (value: string): string => value.padStart(2, "0");
  // The export carries desk wall time (US Pacific). Parse explicitly so the value does not
  // depend on the process TZ (bun test defaults to UTC; bun run is local).
  return parseGsliveTimestampMs(
    `${year}-${pad(month)}-${pad(day)}T${pad(hh)}:${pad(mm)}:${pad(ss)}`,
  );
}

/**
 * A raw state cell -> canonical label, mapping observed numeric codes. An unmapped code stays
 * visible as `(code N)`; a blank cell is labelled `(missing)`.
 */
export function resolveStateLabel(cell: string): {
  readonly state: string;
  readonly numericCode: number | null;
} {
  const trimmed = cell.trim();
  if (trimmed === "") return { state: MISSING_STATE, numericCode: null };
  if (/^-?\d+$/.test(trimmed)) {
    const code = Number(trimmed);
    return {
      state: GSLIVE_NUMERIC_STATE_MAP[code] ?? `(code ${code})`,
      numericCode: code,
    };
  }
  return { state: trimmed, numericCode: null };
}

/** Canonical position by label; a Map keeps the lookup total without casting a string. */
const CANONICAL_STATE_POSITION = new Map<string, number>(
  GSLIVE_STATE_ORDER.map((state, index) => [state, index]),
);

/**
 * Canonical rank: observed order first, then unknown states alphabetically, then rows with no
 * state at all (a blank cell is an absent state, not a new one).
 */
export function stateRank(state: string): number {
  if (state === MISSING_STATE) return GSLIVE_STATE_ORDER.length + 1;
  return CANONICAL_STATE_POSITION.get(state) ?? GSLIVE_STATE_ORDER.length;
}

function compareStates(left: string, right: string): number {
  const byRank = stateRank(left) - stateRank(right);
  return byRank !== 0 ? byRank : left.localeCompare(right);
}

/** One row straight from `ajax.php`, ordered only; the response's own keys are preserved. */
export interface LiveWager {
  readonly state: string;
  /** Wager id when the response carries a recognised ticket field, else null. */
  readonly ticket: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface LiveStateCount {
  readonly state: string;
  readonly legs: number;
  /** Distinct tickets when the response exposes a ticket field; null when it does not. */
  readonly wagers: number | null;
}

export interface LiveWagersResult {
  /** When the endpoint was read, so the ordering carries its own age. */
  readonly capturedAt: string;
  readonly fromEpochSec: number;
  readonly toEpochSec: number;
  readonly dateFilterBy: DateFilterBy;
  /** Wager-id field used to derive `wagers`; null when no candidate field was present. */
  readonly ticketField: string | null;
  readonly legs: number;
  readonly wagers: number | null;
  readonly spanning: number | null;
  readonly states: readonly LiveStateCount[];
  readonly legsOrdered: readonly LiveWager[];
}

const liveRowSchema = z.record(z.string(), z.unknown());

function liveObjects(rows: readonly unknown[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const parsed = liveRowSchema.safeParse(row);
    return parsed.success ? parsed.data : { value: row };
  });
}

function bestField(
  rows: readonly Record<string, unknown>[],
  candidates: readonly string[],
): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const field of candidates) {
    let score = 0;
    for (const row of rows) {
      if (row[field] !== undefined) score += 1;
    }
    if (score > bestScore) {
      best = field;
      bestScore = score;
    }
  }
  return best;
}

function ticketText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function liveNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return parseMoney(value);
  return 0;
}

/** Live bet/grade times: epoch seconds, epoch ms, the export's format, or an ISO string. */
export function parseLiveTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value >= 1e11 ? value : value * 1000;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const exportFormat = parseBetTime(trimmed);
  if (exportFormat !== null) return exportFormat;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return numeric > 0 ? (numeric >= 1e11 ? numeric : numeric * 1000) : null;
  }
  const iso = Date.parse(trimmed);
  return Number.isFinite(iso) ? iso : null;
}

function resolveLiveState(value: unknown): {
  readonly state: string;
  readonly numericCode: number | null;
} {
  if (value === undefined || value === null) {
    return { state: MISSING_STATE, numericCode: null };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return {
      state: GSLIVE_NUMERIC_STATE_MAP[value] ?? `(code ${value})`,
      numericCode: Number.isInteger(value) ? value : null,
    };
  }
  if (typeof value === "string") return resolveStateLabel(value);
  return { state: `(${typeof value})`, numericCode: null };
}

/** Attach the state label (and wager id when present) to each raw row. */
export function toLiveWagers(rows: readonly unknown[]): LiveWager[] {
  const objects = liveObjects(rows);
  const field = bestField(objects, LIVE_STATE_FIELD_CANDIDATES) ?? "state";
  const ticketField = bestField(objects, TICKET_FIELD_CANDIDATES);
  return objects.map((object) => ({
    state: stateLabel(object, field),
    ticket: ticketField === null ? null : ticketText(object[ticketField]),
    raw: object,
  }));
}

/**
 * Stable sort: canonical state order, unknown states alphabetically, missing last. The endpoint's
 * own ordering is preserved inside a state (JS sort is stable), which is usually newest-first.
 */
export function sortLiveWagersByState(
  wagers: readonly LiveWager[],
): LiveWager[] {
  return [...wagers].sort((left, right) => {
    const byRank = stateRank(left.state) - stateRank(right.state);
    if (byRank !== 0) return byRank;
    return left.state.localeCompare(right.state);
  });
}

export function countLiveStates(
  wagers: readonly LiveWager[],
): LiveStateCount[] {
  const counts = new Map<string, { legs: number; tickets: Set<string> }>();
  let ticketsResolved = false;
  for (const wager of wagers) {
    const entry = counts.get(wager.state) ?? {
      legs: 0,
      tickets: new Set<string>(),
    };
    entry.legs += 1;
    if (wager.ticket !== null) {
      entry.tickets.add(wager.ticket);
      ticketsResolved = true;
    }
    counts.set(wager.state, entry);
  }
  return [...counts.entries()]
    .map(([state, entry]) => ({
      state,
      legs: entry.legs,
      wagers: ticketsResolved ? entry.tickets.size : null,
    }))
    .sort((left, right) => {
      const byRank = stateRank(left.state) - stateRank(right.state);
      return byRank !== 0 ? byRank : left.state.localeCompare(right.state);
    });
}

/** Count distinct tickets and how many of them span more than one state. */
export function summarizeLiveWagers(wagers: readonly LiveWager[]): {
  readonly wagers: number | null;
  readonly spanning: number | null;
} {
  const statesByTicket = new Map<string, Set<string>>();
  for (const wager of wagers) {
    if (wager.ticket === null) continue;
    const states = statesByTicket.get(wager.ticket) ?? new Set<string>();
    states.add(wager.state);
    statesByTicket.set(wager.ticket, states);
  }
  if (statesByTicket.size === 0) return { wagers: null, spanning: null };
  let spanning = 0;
  for (const states of statesByTicket.values()) {
    if (states.size > 1) spanning += 1;
  }
  return { wagers: statesByTicket.size, spanning };
}

/** Legacy live renderer (legs/wagers only); the v2 report uses `formatWagerTable`. */
export function formatLiveCounts(counts: readonly LiveStateCount[]): string {
  const totalLegs = counts.reduce((sum, entry) => sum + entry.legs, 0);
  const width = Math.max(
    5,
    displayWidth("state"),
    ...counts.map((entry) => displayWidth(entry.state)),
  );
  const lines = [
    `legs = ${totalLegs}`,
    "",
    [
      padCell("state", width, "left"),
      padCell("legs", 6, "right"),
      padCell("wagers", 7, "right"),
      padCell("pct", 7, "right"),
    ].join(" "),
    "-".repeat(width + 24),
  ];
  for (const entry of counts) {
    const pct =
      totalLegs === 0
        ? "0.0%"
        : `${((entry.legs / totalLegs) * 100).toFixed(1)}%`;
    lines.push(
      [
        padCell(entry.state, width, "left"),
        padCell(String(entry.legs), 6, "right"),
        padCell(
          entry.wagers === null ? "n/a" : String(entry.wagers),
          7,
          "right",
        ),
        padCell(pct, 7, "right"),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

export interface CsvTicketProfile {
  /** Resolved header name; null when no ticket candidate column exists. */
  readonly ticketField: string | null;
  /** Share of legs carrying a non-empty ticket value, percent rounded to 0.1. */
  readonly coveragePct: number;
}

/**
 * Profile which header column is the wager id, by data coverage rather than by name alone.
 * Returns null when no candidate column exists; a column that exists but is empty keeps its
 * name and reports 0% coverage, which the quality block makes visible.
 */
export function profileCsvTicket(
  csvRows: readonly string[][],
): CsvTicketProfile {
  const header = csvRows[0];
  if (header === undefined) return { ticketField: null, coveragePct: 0 };
  const index = headerIndex(header);
  const present = TICKET_FIELD_CANDIDATES.filter((field) => index.has(field));
  if (present.length === 0) return { ticketField: null, coveragePct: 0 };
  const legs = Math.max(0, csvRows.length - 1);
  let bestField: string = present[0] ?? "Ticket";
  let bestCovered = -1;
  for (const field of present) {
    const position = index.get(field);
    let covered = 0;
    for (const cells of csvRows.slice(1)) {
      const value = position === undefined ? "" : (cells[position] ?? "");
      if (value.trim() !== "") covered += 1;
    }
    if (covered > bestCovered) {
      bestField = field;
      bestCovered = covered;
    }
  }
  return {
    ticketField: bestField,
    coveragePct: legs === 0 ? 0 : roundTo((100 * bestCovered) / legs, 1),
  };
}

export function toWagerRows(
  csvRows: readonly string[][],
  profile?: CsvTicketProfile,
): WagerRow[] {
  const header = csvRows[0];
  if (header === undefined) throw new Error("CSV has no header row");
  const index = headerIndex(header);
  const required = ["State", "Bet Time", "Risk", "To Win", "Result"] as const;
  for (const column of required) {
    if (!index.has(column)) {
      throw new Error(
        `CSV is missing required column ${JSON.stringify(column)}`,
      );
    }
  }
  const ticketProfile = profile ?? profileCsvTicket(csvRows);
  const ticketField = ticketProfile.ticketField;
  const cell = (cells: readonly string[], column: string): string => {
    const position = index.get(column);
    return position === undefined ? "" : (cells[position] ?? "").trim();
  };

  const rows: WagerRow[] = [];
  for (const cells of csvRows.slice(1)) {
    const resolved = resolveStateLabel(cell(cells, "State"));
    const betTimeText = cell(cells, "Bet Time");
    const ticketCell = ticketField === null ? "" : cell(cells, ticketField);
    // Written out rather than asserted: adding a WAGER_COLUMNS entry makes this fail to compile.
    const kept: Record<WagerColumn, string> = {
      State: cell(cells, "State"),
      "Bet Time": cell(cells, "Bet Time"),
      Player: cell(cells, "Player"),
      Agent: cell(cells, "Agent"),
      Ticket: cell(cells, "Ticket"),
      Id: cell(cells, "Id"),
      "Bet Group": cell(cells, "Bet Group"),
      "Sport / League": cell(cells, "Sport / League"),
      "Event Details": cell(cells, "Event Details"),
      Market: cell(cells, "Market"),
      Period: cell(cells, "Period"),
      Side: cell(cells, "Side"),
      Type: cell(cells, "Type"),
      Risk: cell(cells, "Risk"),
      "To Win": cell(cells, "To Win"),
      Result: cell(cells, "Result"),
      "Bet price": cell(cells, "Bet price"),
      "Grade Time": cell(cells, "Grade Time"),
    };
    if (ticketField !== null && ticketField !== "Ticket") {
      kept.Ticket = ticketCell;
    }
    rows.push({
      state: resolved.state,
      ticket: ticketCell === "" ? null : ticketCell,
      legId: cell(cells, "Id"),
      betTimeMs: parseBetTime(betTimeText),
      betTimeText,
      gradeTimeMs: parseBetTime(cell(cells, "Grade Time")),
      risk: parseMoney(cell(cells, "Risk")),
      toWin: parseMoney(cell(cells, "To Win")),
      result: parseMoney(cell(cells, "Result")),
      numericCode: resolved.numericCode,
      cells: kept,
    });
  }
  return rows;
}

/**
 * Sort by canonical state, then newest bet first. Unparseable bet times sort last within their
 * state; ties fall back to the raw text so the order is deterministic.
 */
export function sortWagersByState(rows: readonly WagerRow[]): WagerRow[] {
  return [...rows].sort((left, right) => {
    const byState = stateRank(left.state) - stateRank(right.state);
    if (byState !== 0) return byState;
    if (left.state !== right.state)
      return left.state.localeCompare(right.state);
    if (left.betTimeMs !== null && right.betTimeMs !== null) {
      if (left.betTimeMs !== right.betTimeMs)
        return right.betTimeMs - left.betTimeMs;
    } else if (left.betTimeMs !== null) {
      return -1;
    } else if (right.betTimeMs !== null) {
      return 1;
    }
    return left.betTimeText.localeCompare(right.betTimeText);
  });
}

export function aggregateByState(rows: readonly WagerRow[]): StateAggregate[] {
  const byState = new Map<
    string,
    {
      legs: number;
      tickets: Set<string>;
      legRisk: number;
      legToWin: number;
      legResult: number;
    }
  >();
  for (const row of rows) {
    const current = byState.get(row.state) ?? {
      legs: 0,
      tickets: new Set<string>(),
      legRisk: 0,
      legToWin: 0,
      legResult: 0,
    };
    current.legs += 1;
    if (row.ticket !== null) current.tickets.add(row.ticket);
    current.legRisk += row.risk;
    current.legToWin += row.toWin;
    current.legResult += row.result;
    byState.set(row.state, current);
  }
  return [...byState.entries()]
    .map(([state, entry]) => ({
      state,
      legs: entry.legs,
      wagers: entry.tickets.size,
      legRisk: entry.legRisk,
      legToWin: entry.legToWin,
      legResult: entry.legResult,
    }))
    .sort((left, right) => compareStates(left.state, right.state));
}

export function summarizeWagers(rows: readonly WagerRow[]): WagerSummary {
  const statesByTicket = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.ticket === null) continue;
    const states = statesByTicket.get(row.ticket) ?? new Set<string>();
    states.add(row.state);
    statesByTicket.set(row.ticket, states);
  }
  let spanning = 0;
  for (const states of statesByTicket.values()) {
    if (states.size > 1) spanning += 1;
  }
  return { legs: rows.length, wagers: statesByTicket.size, spanning };
}

/** Serialize the sorted legs back to CSV, quoting only cells that need it. */
export function toCsv(rows: readonly WagerRow[]): string {
  const quote = (cell: string): string =>
    /[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
  const header = WAGER_COLUMNS.map(quote).join(",");
  const lines = rows.map((row) =>
    WAGER_COLUMNS.map((column) => quote(row.cells[column])).join(","),
  );
  return `${[header, ...lines].join("\n")}\n`;
}

/** Legacy per-state table (leg-scoped money only); kept for the pre-v2 test surface. */
export function formatAggregates(
  aggregates: readonly StateAggregate[],
): string {
  const totalLegs = aggregates.reduce((sum, entry) => sum + entry.legs, 0);
  const width = Math.max(
    5,
    displayWidth("state"),
    ...aggregates.map((entry) => displayWidth(entry.state)),
  );
  const lines = [
    [
      padCell("state", width, "left"),
      padCell("legs", 6, "right"),
      padCell("wagers", 7, "right"),
      padCell("pct", 6, "right"),
      padCell("leg risk", 13, "right"),
      padCell("leg to win", 13, "right"),
      padCell("leg result", 13, "right"),
    ].join(" "),
    "-".repeat(width + 62),
  ];
  for (const entry of aggregates) {
    const pct =
      totalLegs === 0
        ? "0.0%"
        : `${((entry.legs / totalLegs) * 100).toFixed(1)}%`;
    lines.push(
      [
        padCell(entry.state, width, "left"),
        padCell(String(entry.legs), 6, "right"),
        padCell(String(entry.wagers), 7, "right"),
        padCell(pct, 6, "right"),
        padCell(entry.legRisk.toFixed(2), 13, "right"),
        padCell(entry.legToWin.toFixed(2), 13, "right"),
        padCell(entry.legResult.toFixed(2), 13, "right"),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

/** Legacy footer kept for the pre-v2 test surface; v2 uses `formatWagerQuality`. */
export function formatWagerSummary(
  aggregates: readonly StateAggregate[],
  summary: WagerSummary,
): string {
  const wagerColumnSum = aggregates.reduce(
    (sum, entry) => sum + entry.wagers,
    0,
  );
  return [
    `legs = ${summary.legs} (one row per leg)`,
    `distinct wagers (Ticket) = ${summary.wagers}`,
    `wagers spanning >1 state = ${summary.spanning} (counted under each state they touch, ` +
      `so the wagers column sums to ${wagerColumnSum}, not ${summary.wagers})`,
    "money columns are leg-scoped: a parlay repeats Risk on every leg, so leg risk is not stakes at risk",
  ].join("\n");
}

function percentileMinutes(
  lagsMs: readonly number[],
  percentile: number,
): number | null {
  if (lagsMs.length === 0) return null;
  const sorted = [...lagsMs].sort((left, right) => left - right);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  const value = sorted[index];
  return value === undefined ? null : Math.round(value / 60_000);
}

function buildAgeBuckets(agesMinutes: readonly number[]): PendingAgeBuckets {
  let gt1h = 0;
  let gt6h = 0;
  let gt24h = 0;
  let gt72h = 0;
  for (const age of agesMinutes) {
    if (!Number.isFinite(age)) continue;
    if (age > 60) gt1h += 1;
    if (age > 360) gt6h += 1;
    if (age > 1440) gt24h += 1;
    if (age > 4320) gt72h += 1;
  }
  return { gt1h, gt6h, gt24h, gt72h };
}

interface StateAccum {
  legs: number;
  readonly tickets: Set<string>;
  legRiskCents: number;
  legToWinCents: number;
  legResultCents: number;
  readonly pendingAgesMinutes: number[];
  readonly gradeLagsMs: number[];
}

interface TicketAccum {
  readonly states: Set<string>;
  legCount: number;
  riskCents: number;
  inconsistentRisk: boolean;
}

/**
 * The v2 measurement pass. Every number is derived from the legs here; nothing is checked in.
 * Times are measured against `nowMs` (age), the observed end (snapshot lag / pending age), and
 * the source mtime (snapshot completeness).
 */
export function analyzeLegs(
  legs: readonly WagerLeg[],
  options: WagerAnalysisOptions,
): WagerReport {
  const notes: string[] = [...(options.extraNotes ?? [])];

  const observedTimes: number[] = [];
  for (const leg of legs) {
    if (leg.betTimeMs !== null) observedTimes.push(leg.betTimeMs);
  }
  const observedStartMs =
    observedTimes.length === 0 ? null : Math.min(...observedTimes);
  const observedEndMs =
    observedTimes.length === 0 ? null : Math.max(...observedTimes);
  const spanHours =
    observedStartMs === null || observedEndMs === null
      ? null
      : roundTo((observedEndMs - observedStartMs) / 3_600_000, 1);
  const ageMinutes =
    observedEndMs === null
      ? null
      : Math.round((options.nowMs - observedEndMs) / 60_000);
  const mtimeMs =
    options.source.mtime === null ? null : Date.parse(options.source.mtime);
  const snapshotLagMinutes =
    observedEndMs === null || mtimeMs === null || !Number.isFinite(mtimeMs)
      ? null
      : Math.round((mtimeMs - observedEndMs) / 60_000);
  const fallback = options.windowFallback ?? null;
  const anchorMs = options.anchorMs ?? observedEndMs;

  const stateMap = new Map<string, StateAccum>();
  const tickets = new Map<string, TicketAccum>();
  const pendingAgesMinutes: number[] = [];
  const settledLagsMs: number[] = [];
  const numericCodes = new Set<number>();
  let unparsedBetTimes = 0;
  let settledLegsWithoutGrade = 0;
  let winResultNonPositive = 0;
  let loseResultNonNegative = 0;

  for (const leg of legs) {
    if (leg.betTimeMs === null) unparsedBetTimes += 1;
    if (leg.numericCode !== null) numericCodes.add(leg.numericCode);

    const state = stateMap.get(leg.state) ?? {
      legs: 0,
      tickets: new Set<string>(),
      legRiskCents: 0,
      legToWinCents: 0,
      legResultCents: 0,
      pendingAgesMinutes: [],
      gradeLagsMs: [],
    };
    state.legs += 1;
    state.legRiskCents += toCents(leg.risk);
    state.legToWinCents += toCents(leg.toWin);
    state.legResultCents += toCents(leg.result);

    if (leg.ticket !== null) {
      state.tickets.add(leg.ticket);
      const ticket = tickets.get(leg.ticket) ?? {
        states: new Set<string>(),
        legCount: 0,
        riskCents: toCents(leg.risk),
        inconsistentRisk: false,
      };
      ticket.states.add(leg.state);
      ticket.legCount += 1;
      if (ticket.riskCents !== toCents(leg.risk))
        ticket.inconsistentRisk = true;
      tickets.set(leg.ticket, ticket);
    }

    if (
      leg.state === "pending" &&
      leg.betTimeMs !== null &&
      anchorMs !== null
    ) {
      const age = (anchorMs - leg.betTimeMs) / 60_000;
      pendingAgesMinutes.push(age);
      state.pendingAgesMinutes.push(age);
    }

    if (SETTLED_STATES.includes(leg.state)) {
      if (leg.betTimeMs !== null && leg.gradeTimeMs !== null) {
        const lagMs = leg.gradeTimeMs - leg.betTimeMs;
        settledLagsMs.push(lagMs);
        state.gradeLagsMs.push(lagMs);
      } else {
        settledLegsWithoutGrade += 1;
      }
    }

    if (leg.state === "win" && leg.result <= 0) winResultNonPositive += 1;
    if (leg.state === "lose" && leg.result >= 0) loseResultNonNegative += 1;

    stateMap.set(leg.state, state);
  }

  // Allocate each ticket's risk across the states its legs touch, in integer cents, so the
  // per-state column sums exactly to totals.wagerRisk (a remainder cent goes to the earlier
  // state in canonical order).
  const attributedCents = new Map<string, number>();
  let wagerRiskCents = 0;
  let spanningWagers = 0;
  let multiLegWagers = 0;
  let inconsistentRiskWagers = 0;
  for (const ticket of tickets.values()) {
    wagerRiskCents += ticket.riskCents;
    if (ticket.states.size > 1) spanningWagers += 1;
    if (ticket.legCount > 1) multiLegWagers += 1;
    if (ticket.inconsistentRisk) inconsistentRiskWagers += 1;
    const orderedStates = [...ticket.states].sort(compareStates);
    if (orderedStates.length === 0) continue;
    const base = Math.trunc(ticket.riskCents / orderedStates.length);
    let remainder = ticket.riskCents - base * orderedStates.length;
    for (const state of orderedStates) {
      let cents = base;
      if (remainder !== 0) {
        const step = remainder > 0 ? 1 : -1;
        cents += step;
        remainder -= step;
      }
      attributedCents.set(state, (attributedCents.get(state) ?? 0) + cents);
    }
  }

  if (options.ticketField === null) {
    notes.push(
      "no ticket field with values was found; wagers/wagerRisk are null and leg counts are exact",
    );
  } else if (options.ticketCoveragePct < 100 && legs.length > 0) {
    notes.push(
      `ticket coverage is ${options.ticketCoveragePct}%; legs without a Ticket value are excluded ` +
        "from wager-scoped money and wager counts",
    );
  }
  if (fallback !== null && observedEndMs === null) {
    notes.push(
      "no leg carried a parseable bet time; window.fromEpochSec/toEpochSec are the request " +
        "window and the observed window is unknown",
    );
  }
  if (unparsedBetTimes > 0) {
    notes.push(
      `${unparsedBetTimes} legs have no parseable Bet Time; they are excluded from the observed ` +
        "window and pending-age counts",
    );
  }
  if (settledLegsWithoutGrade > 0) {
    notes.push(
      `${settledLegsWithoutGrade} settled legs have no parseable Grade Time; grade-lag ` +
        `percentiles cover ${settledLagsMs.length} settled legs`,
    );
  }
  if (inconsistentRiskWagers > 0) {
    notes.push(
      `${inconsistentRiskWagers} wagers repeat a different Risk per leg; wagerRisk uses the ` +
        "first leg's Risk for each of them",
    );
  }
  if (legs.length === 0) {
    notes.push(
      "no legs in this window: totals are measured zeros, not a missing artifact",
    );
  }

  const stateRows: WagerStateRow[] = [...stateMap.entries()]
    .map(([state, accum]) => ({
      state,
      legs: accum.legs,
      wagers: options.ticketField === null ? null : accum.tickets.size,
      wagerRiskAttributed:
        options.ticketField === null
          ? null
          : fromCents(attributedCents.get(state) ?? 0),
      legRisk: fromCents(accum.legRiskCents),
      legToWin: fromCents(accum.legToWinCents),
      legResult: fromCents(accum.legResultCents),
      pendingAgeMinutes:
        state === "pending" && accum.pendingAgesMinutes.length > 0
          ? buildAgeBuckets(accum.pendingAgesMinutes)
          : null,
      gradeLagMinutesP50: percentileMinutes(accum.gradeLagsMs, 50),
    }))
    .sort((left, right) => compareStates(left.state, right.state));

  let legRiskCents = 0;
  let legToWinCents = 0;
  let legResultCents = 0;
  for (const accum of stateMap.values()) {
    legRiskCents += accum.legRiskCents;
    legToWinCents += accum.legToWinCents;
    legResultCents += accum.legResultCents;
  }

  const unknownStates = [...stateMap.keys()]
    .filter(
      (state) =>
        state !== MISSING_STATE && !CANONICAL_STATE_POSITION.has(state),
    )
    .sort((left, right) => left.localeCompare(right));

  return {
    schemaVersion: 2,
    source: options.source,
    window: {
      observedStart:
        observedStartMs === null
          ? null
          : new Date(observedStartMs).toISOString(),
      observedEnd:
        observedEndMs === null ? null : new Date(observedEndMs).toISOString(),
      spanHours,
      fromEpochSec: fallback?.fromEpochSec ?? null,
      toEpochSec: fallback?.toEpochSec ?? null,
      ageMinutes,
      snapshotLagMinutes,
    },
    identity: {
      ticketField: options.ticketField,
      coveragePct: options.ticketCoveragePct,
      distinctWagers: options.ticketField === null ? null : tickets.size,
      spanningWagers: options.ticketField === null ? null : spanningWagers,
      multiLegWagers: options.ticketField === null ? null : multiLegWagers,
    },
    totals: {
      legs: legs.length,
      wagers: options.ticketField === null ? null : tickets.size,
      spanning: options.ticketField === null ? null : spanningWagers,
      legRisk: fromCents(legRiskCents),
      legToWin: fromCents(legToWinCents),
      legResult: fromCents(legResultCents),
      wagerRisk:
        options.ticketField === null ? null : fromCents(wagerRiskCents),
    },
    states: stateRows,
    quality: {
      ticketCoveragePct: options.ticketCoveragePct,
      unparsedBetTimes,
      unknownStates,
      numericStateCodes: [...numericCodes].sort((left, right) => left - right),
      coherenceViolations: {
        winResultNonPositive,
        loseResultNonNegative,
      },
      gradeLagMinutes: {
        p50: percentileMinutes(settledLagsMs, 50),
        p90: percentileMinutes(settledLagsMs, 90),
        p99: percentileMinutes(settledLagsMs, 99),
        settledLegs: settledLagsMs.length,
      },
      pendingAgeMinutes: buildAgeBuckets(pendingAgesMinutes),
    },
    moneyScope: MONEY_SCOPE,
    notes,
  };
}

/** Profile a live row set into v2 legs: state, ticket, money, bet/grade times, numeric codes. */
export interface LiveLegProfile {
  readonly legs: readonly WagerLeg[];
  readonly ticketField: string | null;
  readonly ticketCoveragePct: number;
  readonly betTimeField: string | null;
}

export function toLiveWagerLegs(wagers: readonly LiveWager[]): LiveLegProfile {
  const objects = wagers.map((wager) => {
    const parsed = liveRowSchema.safeParse(wager.raw);
    return parsed.success ? parsed.data : { value: wager.raw };
  });
  const stateField = bestField(objects, LIVE_STATE_FIELD_CANDIDATES) ?? "state";
  const ticketField = bestField(objects, TICKET_FIELD_CANDIDATES);
  let ticketValues = 0;
  for (const object of objects) {
    if (
      ticketText(ticketField === null ? undefined : object[ticketField]) !==
      null
    )
      ticketValues += 1;
  }

  let betTimeField: string | null = null;
  let bestTimeValues = 0;
  let bestTimes: (number | null)[] = objects.map(() => null);
  for (const field of TIME_FIELD_CANDIDATES) {
    const times = objects.map((object) => parseLiveTime(object[field]));
    const values = times.filter((time) => time !== null).length;
    if (values > bestTimeValues) {
      betTimeField = field;
      bestTimeValues = values;
      bestTimes = times;
    }
  }

  const riskField = bestField(objects, RISK_FIELD_CANDIDATES);
  const toWinField = bestField(objects, TO_WIN_FIELD_CANDIDATES);
  const resultField = bestField(objects, RESULT_FIELD_CANDIDATES);
  const gradeField = bestField(objects, GRADE_FIELD_CANDIDATES);

  const legs = objects.map((object, index) => {
    const resolved = resolveLiveState(object[stateField]);
    return {
      state: resolved.state,
      ticket: ticketField === null ? null : ticketText(object[ticketField]),
      risk: riskField === null ? 0 : liveNumber(object[riskField]),
      toWin: toWinField === null ? 0 : liveNumber(object[toWinField]),
      result: resultField === null ? 0 : liveNumber(object[resultField]),
      betTimeMs: bestTimes[index] ?? null,
      gradeTimeMs:
        gradeField === null ? null : parseLiveTime(object[gradeField]),
      numericCode: resolved.numericCode,
    };
  });

  return {
    legs,
    ticketField,
    ticketCoveragePct:
      objects.length === 0
        ? 0
        : roundTo((100 * ticketValues) / objects.length, 1),
    betTimeField,
  };
}

export interface LiveReportOptions {
  readonly fromEpochSec: number;
  readonly toEpochSec: number;
  readonly dateFilterBy: DateFilterBy;
  readonly capturedAt: string;
  readonly nowMs?: number;
  /** Endpoint that produced these rows; defaults to the public `ajax.php` URL. */
  readonly url?: string;
}

/** Build the same v2 report from a live `getBetReport` read. */
export function buildLiveWagerReport(
  wagers: readonly LiveWager[],
  options: LiveReportOptions,
): WagerReport {
  const profile = toLiveWagerLegs(wagers);
  const capturedMs = Date.parse(options.capturedAt);
  const nowMs =
    options.nowMs ?? (Number.isFinite(capturedMs) ? capturedMs : Date.now());
  const anchorMs = Number.isFinite(capturedMs) ? capturedMs : nowMs;
  const notes: string[] = [];
  if (profile.betTimeField === null && wagers.length > 0) {
    notes.push(
      "live rows expose no parseable bet-time field; the observed window is unknown and " +
        "window.fromEpochSec/toEpochSec are the request window",
    );
  }
  return analyzeLegs(profile.legs, {
    source: {
      kind: "live-ajax.php",
      path: null,
      mtime: null,
      dateFilterBy: options.dateFilterBy,
      url: options.url ?? AJAX_URL,
      action: "getBetReport",
      stateFilter: "",
      fromEpochSec: options.fromEpochSec,
      toEpochSec: options.toEpochSec,
      capturedAt: options.capturedAt,
    },
    nowMs,
    anchorMs,
    ticketField: profile.ticketField,
    ticketCoveragePct: profile.ticketCoveragePct,
    windowFallback: {
      fromEpochSec: options.fromEpochSec,
      toEpochSec: options.toEpochSec,
    },
    extraNotes: notes,
  });
}

function moneyCell(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

function countCell(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

/**
 * One width rule for both padding and wrapping: ambiguous-width Unicode counts as one column.
 * Stating it explicitly keeps `Bun.stringWidth` and `Bun.wrapAnsi` in agreement instead of
 * relying on two separate defaults.
 */
const AMBIGUOUS_IS_NARROW = true;

/** Display width in terminal columns (ANSI/emoji-safe), not UTF-16 units. */
function displayWidth(text: string): number {
  return stringWidth(text, { ambiguousIsNarrow: AMBIGUOUS_IS_NARROW });
}

function padCell(text: string, width: number, align: "left" | "right"): string {
  const pad = Math.max(0, width - displayWidth(text));
  return align === "right"
    ? `${" ".repeat(pad)}${text}`
    : `${text}${" ".repeat(pad)}`;
}

/** Prose cells (alert summaries, notes): wrap at word boundaries, breaking over-wide tokens. */
export function wrapProseCell(text: string, width: number): string[] {
  if (displayWidth(text) <= width) return [text];
  return wrapAnsi(text, width, {
    hard: true,
    wordWrap: true,
    trim: true,
    ambiguousIsNarrow: AMBIGUOUS_IS_NARROW,
  }).split("\n");
}

/** Unbroken tokens (source URLs, paths, ids): hard-break, never reword. */
export function wrapTokenCell(text: string, width: number): string[] {
  if (displayWidth(text) <= width) return [text];
  return wrapAnsi(text, width, {
    hard: true,
    wordWrap: false,
    trim: true,
    ambiguousIsNarrow: AMBIGUOUS_IS_NARROW,
  }).split("\n");
}

/**
 * Prose body width: the operator's `COLUMNS` when it is a sane terminal width, else 100.
 * Clamped so a tiny/huge environment value cannot make the report unreadable.
 */
export function reportColumns(): number {
  const raw = env.COLUMNS?.trim() ?? "";
  if (raw === "") return 100;
  const width = Number(raw);
  if (!Number.isFinite(width)) return 100;
  return Math.min(200, Math.max(40, Math.floor(width)));
}

/**
 * Wrap one already-rendered report line for a terminal: preserve its leading indent, wrap prose
 * at word boundaries, and hard-break any token that still exceeds the width (paths, URLs, ids).
 */
export function wrapReportLine(
  text: string,
  role: "prose" | "token" = "prose",
): string[] {
  const width = reportColumns();
  if (displayWidth(text) <= width) return [text];
  const indent = text.match(/^\s*/)?.[0] ?? "";
  const indentWidth = displayWidth(indent);
  const body = text.slice(indent.length);
  const bodyWidth = Math.max(1, width - indentWidth);
  const primitive = role === "token" ? wrapTokenCell : wrapProseCell;
  const rows = primitive(body, bodyWidth).flatMap((row) =>
    displayWidth(row) > bodyWidth ? wrapTokenCell(row, bodyWidth) : [row],
  );
  return rows.map((row, index) =>
    index === 0 ? indent + row : " ".repeat(indentWidth) + row,
  );
}

/** State column cap: short enums stay single-line; long names wrap as prose. */
const STATE_COLUMN_CAP = 24;

interface TableCell {
  readonly text: string;
  readonly width: number;
  readonly align: "left" | "right";
  readonly wrap?: "prose" | "token" | null;
}

/** One logical row → one or more physical lines; wrapped columns continue blank-padded. */
function renderRowCells(cells: TableCell[]): string[] {
  const wrapped = cells.map((cell) => {
    if (cell.wrap === "token") return wrapTokenCell(cell.text, cell.width);
    if (cell.wrap === "prose") return wrapProseCell(cell.text, cell.width);
    return [cell.text];
  });
  const height = Math.max(...wrapped.map((lines) => lines.length));
  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    out.push(
      cells
        .map((cell, ci) => {
          const text = wrapped[ci]?.[i] ?? "";
          const pad = Math.max(0, cell.width - stringWidth(text));
          return cell.align === "right"
            ? `${" ".repeat(pad)}${text}`
            : `${text}${" ".repeat(pad)}`;
        })
        .join(" "),
    );
  }
  return out;
}

/** ASCII table: legs + wagers + attributed wager risk + leg-scoped diagnostics. */
export function formatWagerTable(report: WagerReport): string {
  const totalLegs = report.totals.legs;
  const stateWidth = Math.min(
    STATE_COLUMN_CAP,
    Math.max(
      stringWidth("state", { ambiguousIsNarrow: AMBIGUOUS_IS_NARROW }),
      stringWidth("TOTAL", { ambiguousIsNarrow: AMBIGUOUS_IS_NARROW }),
      ...report.states.map((entry) =>
        stringWidth(entry.state, {
          ambiguousIsNarrow: AMBIGUOUS_IS_NARROW,
        }),
      ),
    ),
  );
  const headerCells: TableCell[] = [
    { text: "state", width: stateWidth, align: "left" },
    { text: "legs", width: 6, align: "right" },
    { text: "wagers", width: 7, align: "right" },
    { text: "legs%", width: 6, align: "right" },
    { text: "wager risk", width: 15, align: "right" },
    { text: "leg risk", width: 15, align: "right" },
    { text: "leg to win", width: 15, align: "right" },
    { text: "leg result", width: 15, align: "right" },
  ];
  const header = renderRowCells(headerCells)[0] ?? "";
  const lines = [
    header,
    "-".repeat(stringWidth(header, { ambiguousIsNarrow: AMBIGUOUS_IS_NARROW })),
  ];
  const pushEntry = (
    state: string,
    legs: number,
    wagers: number | null,
    pct: string,
    attributed: number | null,
    legRisk: number,
    legToWin: number,
    legResult: number,
  ): void => {
    for (const line of renderRowCells([
      { text: state, width: stateWidth, align: "left", wrap: "prose" },
      { text: String(legs), width: 6, align: "right" },
      { text: countCell(wagers), width: 7, align: "right" },
      { text: pct, width: 6, align: "right" },
      { text: moneyCell(attributed), width: 15, align: "right" },
      { text: legRisk.toFixed(2), width: 15, align: "right" },
      { text: legToWin.toFixed(2), width: 15, align: "right" },
      { text: legResult.toFixed(2), width: 15, align: "right" },
    ])) {
      lines.push(line);
    }
  };
  for (const entry of report.states) {
    const pct =
      totalLegs === 0
        ? "0.0%"
        : `${((entry.legs / totalLegs) * 100).toFixed(1)}%`;
    pushEntry(
      entry.state,
      entry.legs,
      entry.wagers,
      pct,
      entry.wagerRiskAttributed,
      entry.legRisk,
      entry.legToWin,
      entry.legResult,
    );
  }
  const wagerColumnSum = report.states.reduce(
    (sum, entry) => sum + (entry.wagers ?? 0),
    0,
  );
  const attributedSum = report.states.reduce(
    (sum, entry) => sum + (entry.wagerRiskAttributed ?? 0),
    0,
  );
  pushEntry(
    "TOTAL",
    report.totals.legs,
    report.totals.wagers === null ? null : wagerColumnSum,
    totalLegs === 0 ? "0.0%" : "100.0%",
    report.totals.wagerRisk === null ? null : attributedSum,
    report.totals.legRisk,
    report.totals.legToWin,
    report.totals.legResult,
  );
  return lines.join("\n");
}

/**
 * Computed quality footer: measured provenance, coverage, violations and lags. Nothing here is
 * hand-written prose about the source; every line reads a measured value off the report.
 */
export function formatWagerQuality(report: WagerReport): string {
  const lines: string[] = [];
  const indent = "  ";
  lines.push(`legs = ${report.totals.legs} (one row per leg)`);
  if (report.identity.ticketField === null) {
    lines.push(
      "distinct wagers = n/a (no ticket field with values; leg counts are exact)",
    );
  } else {
    lines.push(
      `distinct wagers (${report.identity.ticketField}) = ${
        report.identity.distinctWagers ?? "n/a"
      }; ticket coverage = ${report.identity.coveragePct}%`,
    );
    lines.push(
      `spanning >1 leg state = ${report.identity.spanningWagers ?? "n/a"}; ` +
        `multi-leg wagers = ${report.identity.multiLegWagers ?? "n/a"} ` +
        `(wagers column sums to ${report.states.reduce(
          (sum, entry) => sum + (entry.wagers ?? 0),
          0,
        )}, not ${report.identity.distinctWagers ?? "n/a"})`,
    );
  }
  if (report.totals.wagerRisk !== null) {
    lines.push(
      `wager risk (deduped by Ticket) = ${report.totals.wagerRisk.toFixed(2)}; ` +
        `leg risk sum = ${report.totals.legRisk.toFixed(2)}; delta = ` +
        `${(report.totals.legRisk - report.totals.wagerRisk).toFixed(2)} ` +
        "(parlay risk counted once per wager)",
    );
    const attributedSum = report.states.reduce(
      (sum, entry) => sum + (entry.wagerRiskAttributed ?? 0),
      0,
    );
    lines.push(
      `state wager-risk column sum = ${attributedSum.toFixed(2)} ` +
        `(allocated per leg state; totals.wagerRisk = ${report.totals.wagerRisk.toFixed(2)})`,
    );
  }
  if (
    report.window.observedStart !== null &&
    report.window.observedEnd !== null
  ) {
    lines.push(
      `observed window ${report.window.observedStart} .. ${report.window.observedEnd} ` +
        `(span ${report.window.spanHours ?? "n/a"}h)`,
    );
  } else {
    lines.push(
      "observed window = unknown (no parseable Bet Time in the source)",
    );
  }
  if (
    report.window.fromEpochSec !== null &&
    report.window.toEpochSec !== null
  ) {
    lines.push(
      `request window ${new Date(report.window.fromEpochSec * 1000).toISOString()} .. ` +
        `${new Date(report.window.toEpochSec * 1000).toISOString()}`,
    );
  }
  lines.push(
    report.window.ageMinutes === null
      ? "artifact age = unknown (no observed end)"
      : `artifact age = ${report.window.ageMinutes} min since observed end`,
  );
  if (report.window.snapshotLagMinutes !== null) {
    lines.push(
      `snapshot lag = ${report.window.snapshotLagMinutes} min ` +
        `(source mtime ${report.source.mtime ?? "n/a"})`,
    );
  }
  lines.push(
    `source = ${report.source.kind}${
      report.source.path === null ? "" : ` (${report.source.path})`
    }`,
  );
  const quality = report.quality;
  lines.push(
    `quality: unparsed Bet Time = ${quality.unparsedBetTimes}; ` +
      `unknown states = ${
        quality.unknownStates.length === 0
          ? "none"
          : quality.unknownStates.join(", ")
      }; numeric state codes = ${
        quality.numericStateCodes.length === 0
          ? "none"
          : quality.numericStateCodes
              .map(
                (code) =>
                  `${code}->${GSLIVE_NUMERIC_STATE_MAP[code] ?? "unmapped"}`,
              )
              .join(", ")
      }`,
  );
  lines.push(
    `${indent}coherence: win with result <= 0 = ` +
      `${quality.coherenceViolations.winResultNonPositive}; ` +
      `lose with result >= 0 = ${quality.coherenceViolations.loseResultNonNegative}`,
  );
  lines.push(
    quality.gradeLagMinutes.settledLegs === 0
      ? `${indent}grade lag = n/a (no settled leg has both Bet Time and Grade Time)`
      : `${indent}grade lag (settled legs = ${quality.gradeLagMinutes.settledLegs}): ` +
          `p50 = ${quality.gradeLagMinutes.p50 ?? "n/a"} min, ` +
          `p90 = ${quality.gradeLagMinutes.p90 ?? "n/a"} min, ` +
          `p99 = ${quality.gradeLagMinutes.p99 ?? "n/a"} min`,
  );
  const anchor =
    report.source.kind === "offline-csv" ? "observed end" : "capture time";
  const pending = quality.pendingAgeMinutes;
  lines.push(
    `${indent}pending age (anchor = ${anchor}): >1h = ${pending.gt1h}, ` +
      `>6h = ${pending.gt6h}, >24h = ${pending.gt24h}, >72h = ${pending.gt72h}`,
  );
  lines.push(`money scope: ${report.moneyScope}`);
  for (const note of report.notes) lines.push(`note: ${note}`);
  return lines
    .flatMap((line) =>
      wrapReportLine(
        line,
        line.startsWith("source = ") || line.startsWith("snapshot lag = ")
          ? "token"
          : "prose",
      ),
    )
    .join("\n");
}

export interface LiveSortOptions {
  readonly fromEpochSec: number;
  readonly toEpochSec: number;
  /** Cookie header built from the environment; never a pasted literal. */
  readonly cookieHeader: string;
  readonly sessionGate?: string;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
  readonly dateFilterBy?: DateFilterBy;
  /** A supplied manager body, sent verbatim (window/dateFilterBy then come from the body). */
  readonly payload?: unknown;
  /** Endpoint override for a local stand-in or proxy. Defaults to `AJAX_URL`. */
  readonly ajaxUrl?: string;
}

/** Read all wagers from `ajax.php` (`state:""`) and order their legs by wager state. */
export async function fetchWagersByStateLive(
  opts: LiveSortOptions,
): Promise<LiveWagersResult> {
  const supplied =
    opts.payload === undefined ? null : parseBetReportRequest(opts.payload);
  const fromEpochSec = supplied?.from ?? opts.fromEpochSec;
  const toEpochSec = supplied?.to ?? opts.toEpochSec;
  const dateFilterBy =
    supplied?.dateFilterBy ?? opts.dateFilterBy ?? "calcTime";
  const rows =
    supplied === null
      ? await fetchBetReportRows({
          fromEpochSec,
          toEpochSec,
          cookieHeader: opts.cookieHeader,
          sessionGate: opts.sessionGate ?? "",
          dateFilterBy,
          ...(opts.fetchImpl === undefined
            ? {}
            : { fetchImpl: opts.fetchImpl }),
          ...(opts.timeoutMs === undefined
            ? {}
            : { timeoutMs: opts.timeoutMs }),
          ...(opts.ajaxUrl === undefined ? {} : { url: opts.ajaxUrl }),
        })
      : await fetchBetReportRowsFromPayload({
          payload: supplied,
          cookieHeader: opts.cookieHeader,
          sessionGate: opts.sessionGate ?? "",
          ...(opts.fetchImpl === undefined
            ? {}
            : { fetchImpl: opts.fetchImpl }),
          ...(opts.timeoutMs === undefined
            ? {}
            : { timeoutMs: opts.timeoutMs }),
          ...(opts.ajaxUrl === undefined ? {} : { url: opts.ajaxUrl }),
        });
  const legsOrdered = sortLiveWagersByState(toLiveWagers(rows));
  const objects: Record<string, unknown>[] = [];
  for (const leg of legsOrdered) objects.push(leg.raw);
  const ticketField = bestField(objects, TICKET_FIELD_CANDIDATES);
  const summary = summarizeLiveWagers(legsOrdered);
  return {
    capturedAt: new Date().toISOString(),
    fromEpochSec,
    toEpochSec,
    dateFilterBy,
    ticketField,
    legs: legsOrdered.length,
    wagers: summary.wagers,
    spanning: summary.spanning,
    states: countLiveStates(legsOrdered),
    legsOrdered,
  };
}

/** Default artifact the plugin reads. Live and offline capture both write this path. */
export const WAGERS_ARTIFACT_PATH =
  "scratch/gslive-wagers-by-state.summary.json";
/** Run journal written by the automation next to the artifact. */
export const WAGERS_STATUS_PATH = "scratch/wagers-by-state.status.json";

/** One live read from `ajax.php` -> the same v2 report, with that endpoint as its source. */
export interface CaptureWagersOptions {
  readonly cookieHeader: string;
  readonly sessionGate?: string;
  readonly payload?: unknown;
  readonly fromEpochSec: number;
  readonly toEpochSec: number;
  readonly dateFilterBy: DateFilterBy;
  readonly timeoutMs?: number;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Endpoint override for a local stand-in or proxy. Defaults to `AJAX_URL`. */
  readonly ajaxUrl?: string;
}

export async function captureWagersReport(
  opts: CaptureWagersOptions,
): Promise<WagerReport> {
  return (await captureWagersSnapshot(opts)).report;
}

/**
 * Write JSON through a temp file + rename, so a crashed or killed run cannot leave a truncated
 * artifact that the plugin would read as valid.
 */
export async function writeTextAtomic(
  path: string,
  text: string,
): Promise<void> {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "." : path.slice(0, slash);
  await mkdir(dir, { recursive: true });
  // Bun.randomUUIDv7 is monotonic/sortable and avoids the Node crypto default.
  const tmp = `${path}.tmp-${randomUUIDv7()}`;
  await write(tmp, text);
  await rename(tmp, path);
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  await writeTextAtomic(path, JSON.stringify(value, null, 2));
}

const captureRunSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  ok: z.boolean(),
  sourceKind: z.literal("live-ajax.php"),
  ajaxUrl: z.string().nullable(),
  fromEpochSec: z.number().nullable(),
  toEpochSec: z.number().nullable(),
  dateFilterBy: z
    .union([z.literal("calcTime"), z.literal("betTime"), z.literal("logTime")])
    .nullable(),
  legs: z.number().nullable(),
  wagers: z.number().nullable(),
  states: z.number().nullable(),
  error: z.string().nullable(),
  alertCodes: z.array(z.string()).optional(),
});

const captureJournalSchema = z.object({
  schemaVersion: z.literal(1),
  runs: z.array(z.unknown()),
});

export interface CaptureRun {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly ok: boolean;
  readonly sourceKind: "live-ajax.php";
  readonly ajaxUrl: string | null;
  readonly fromEpochSec: number | null;
  readonly toEpochSec: number | null;
  readonly dateFilterBy: DateFilterBy | null;
  readonly legs: number | null;
  readonly wagers: number | null;
  readonly states: number | null;
  readonly error: string | null;
  /** Alert codes raised by this successful capture (compact journal form; absent on failure). */
  readonly alertCodes?: readonly string[] | undefined;
}

export interface CaptureJournal {
  readonly schemaVersion: 1;
  readonly runs: readonly CaptureRun[];
  readonly lastSuccess: CaptureRun | null;
  readonly lastFailure: CaptureRun | null;
}

/** Append a run to the journal (capped), keeping the last success and last failure. */
export async function recordCaptureRun(
  statusPath: string,
  run: CaptureRun,
  keepRuns = 20,
): Promise<CaptureJournal> {
  let previous: CaptureRun[] = [];
  try {
    const parsed = captureJournalSchema.safeParse(
      await bunFile(statusPath).json(),
    );
    if (parsed.success) {
      previous = parsed.data.runs
        .map((entry) => captureRunSchema.safeParse(entry))
        .flatMap((result) => (result.success ? [result.data] : []));
    }
  } catch {
    previous = [];
  }
  const runs = [...previous, run].slice(-Math.max(1, keepRuns));
  const lastSuccess = [...runs].reverse().find((entry) => entry.ok) ?? null;
  const lastFailure = [...runs].reverse().find((entry) => !entry.ok) ?? null;
  const journal: CaptureJournal = {
    schemaVersion: 1,
    runs,
    lastSuccess,
    lastFailure,
  };
  await writeJsonAtomic(statusPath, journal);
  return journal;
}

/* -------------------------------------------------------------------------------------------------
 * Capture automation: history, ticket-state delta and alerts
 * (`scratch/wagers-automation.schema.v1.json`, frozen contract shared with the plugin).
 *
 * The v2 artifact above is one snapshot. These documents are the series: a bounded JSONL history
 * (one line per successful capture), the ticket-state join key used to compute the next delta, and
 * the thresholded alert document. Every file is written atomically; a failed capture writes none.
 * The ticket-state document carries ticket ids and therefore lives only in `scratch/`; the history,
 * alerts and journal carry counts, deltas, timestamps and alert text only.
 * ---------------------------------------------------------------------------------------------- */

/** Frozen automation contract version (`scratch/wagers-automation.schema.v1.json`). */
export const WAGERS_AUTOMATION_SCHEMA_VERSION = 1;
/** One JSONL line per successful capture (bounded; rotated by atomic rewrite). */
export const WAGERS_HISTORY_PATH = "scratch/wagers-by-state.history.jsonl";
/** Cross-capture ticket -> state join key, computed against before replacement. */
export const WAGERS_TICKETS_PATH = "scratch/wagers-by-state.tickets.json";
/** Thresholded alert document; an empty `alerts` array is a measured value, not MISSING. */
export const WAGERS_ALERTS_PATH = "scratch/wagers-by-state.alerts.json";
export const DEFAULT_KEEP_HISTORY = 500;

/** Pending legs older than this many hours raise `pending_aging` (CLI: --pending-warn-hours). */
export const DEFAULT_PENDING_WARN_HOURS = 24;
/** A state metric must move at least this percent... (CLI: --spike-pct). */
export const DEFAULT_SPIKE_PCT = 25;
/** ...and by at least this absolute amount to raise `state_spike` (CLI: --spike-min). */
export const DEFAULT_SPIKE_MIN = 20;
/** Ticket churn fires above this percent of the previous wager count... */
export const DEFAULT_CHURN_PCT = 25;
/** ...once the previous book is at least this large (no churn noise on tiny samples). */
export const DEFAULT_CHURN_MIN = 20;
/** Expected capture cadence; `capture_stale` fires past a multiple of it (CLI: --cadence-minutes). */
export const DEFAULT_CADENCE_MINUTES = 30;
export const CAPTURE_STALE_CADENCE_MULTIPLIER = 2;

export const WAGERS_ALERT_CODES = [
  "capture_stale",
  "alert_read_error",
  "pending_aging",
  "unknown_state",
  "coherence_violation",
  "state_spike",
  "ticket_churn",
] as const;
export type WagersAlertCode = (typeof WAGERS_ALERT_CODES)[number];

export const WAGERS_ALERT_SEVERITIES = ["info", "warn", "critical"] as const;
export type WagersAlertSeverity = (typeof WAGERS_ALERT_SEVERITIES)[number];

export interface WagersAlert {
  readonly code: WagersAlertCode;
  readonly severity: WagersAlertSeverity;
  readonly summary: string;
  readonly detail: string;
}

export const wagersAlertSchema = z.object({
  code: z.enum([...WAGERS_ALERT_CODES]),
  severity: z.enum([...WAGERS_ALERT_SEVERITIES]),
  summary: z.string(),
  detail: z.string(),
});

export interface WagersHistoryTotals {
  readonly legs: number;
  readonly wagers: number | null;
  readonly spanning: number | null;
  readonly legRisk: number;
  readonly wagerRisk: number | null;
  readonly legToWin: number;
  readonly legResult: number;
}

export interface WagersHistoryState {
  readonly state: string;
  readonly legs: number;
  readonly wagers: number | null;
  readonly wagerRiskAttributed: number | null;
}

export interface WagersDeltaMigration {
  readonly from: string;
  readonly to: string;
  readonly tickets: number;
}

export interface WagersDeltaState {
  readonly state: string;
  readonly legs: number;
  readonly wagers: number;
  readonly wagerRisk: number;
}

export interface WagersHistoryDelta {
  readonly fromCapturedAt: string;
  readonly toCapturedAt: string;
  readonly newTickets: number;
  readonly goneTickets: number;
  readonly migrations: readonly WagersDeltaMigration[];
  readonly perState: readonly WagersDeltaState[];
}

export interface WagersHistoryLine {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly sourceKind: "live-ajax.php";
  readonly totals: WagersHistoryTotals;
  readonly states: readonly WagersHistoryState[];
  readonly delta: WagersHistoryDelta | null;
  readonly qualityFlags: readonly string[];
  readonly alerts: readonly WagersAlert[];
}

const wagersHistoryTotalsSchema = z.object({
  legs: z.number(),
  wagers: z.number().nullable(),
  spanning: z.number().nullable(),
  legRisk: z.number(),
  wagerRisk: z.number().nullable(),
  legToWin: z.number(),
  legResult: z.number(),
});

const wagersHistoryStateSchema = z.object({
  state: z.string(),
  legs: z.number(),
  wagers: z.number().nullable(),
  wagerRiskAttributed: z.number().nullable(),
});

const wagersDeltaMigrationSchema = z.object({
  from: z.string(),
  to: z.string(),
  tickets: z.number(),
});

const wagersDeltaStateSchema = z.object({
  state: z.string(),
  legs: z.number(),
  wagers: z.number(),
  wagerRisk: z.number(),
});

const wagersHistoryDeltaSchema = z.object({
  fromCapturedAt: z.string(),
  toCapturedAt: z.string(),
  newTickets: z.number(),
  goneTickets: z.number(),
  migrations: z.array(wagersDeltaMigrationSchema),
  perState: z.array(wagersDeltaStateSchema),
});

export const wagersHistoryLineSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.string(),
  sourceKind: z.literal("live-ajax.php"),
  totals: wagersHistoryTotalsSchema,
  states: z.array(wagersHistoryStateSchema),
  delta: wagersHistoryDeltaSchema.nullable(),
  qualityFlags: z.array(z.string()),
  alerts: z.array(wagersAlertSchema),
});

export interface WagersTicketsDoc {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly tickets: Readonly<Record<string, string>>;
}

export const wagersTicketsDocSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.string(),
  tickets: z.record(z.string(), z.string()),
});

/** Why the previous ticket-state document could not be used (counts only; no document text). */
export type WagersTicketsReadError = "parse_error" | "schema_mismatch";

export interface WagersTicketsRead {
  readonly path: string;
  readonly doc: WagersTicketsDoc | null;
  readonly missing: boolean;
  readonly error: WagersTicketsReadError | null;
}

export interface WagersAlertsDoc {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly sourceCapturedAt: string;
  readonly alerts: readonly WagersAlert[];
}

export const wagersAlertsDocSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  sourceCapturedAt: z.string(),
  alerts: z.array(wagersAlertSchema),
});

export interface WagersHistoryRead {
  readonly path: string;
  readonly lines: readonly WagersHistoryLine[];
  readonly missing: boolean;
  readonly unsupported: boolean;
  readonly invalidLines: number;
}

export interface WagersAlertsRead {
  readonly path: string;
  readonly doc: WagersAlertsDoc | null;
  readonly missing: boolean;
  readonly unsupported: boolean;
  readonly invalid: boolean;
}

export interface WagersAlertThresholds {
  readonly pendingWarnHours: number;
  readonly spikePct: number;
  readonly spikeMin: number;
  readonly cadenceMinutes: number;
  /** Optional overrides; the exported defaults apply when a caller omits them. */
  readonly churnPct?: number;
  readonly churnMin?: number;
}

export const DEFAULT_WAGERS_ALERT_THRESHOLDS: WagersAlertThresholds =
  Object.freeze({
    pendingWarnHours: DEFAULT_PENDING_WARN_HOURS,
    spikePct: DEFAULT_SPIKE_PCT,
    spikeMin: DEFAULT_SPIKE_MIN,
    cadenceMinutes: DEFAULT_CADENCE_MINUTES,
  });

/** Read the ticket-state join key. MISSING and unreadable are different states. */
export async function readWagersTickets(
  ticketsPath: string = WAGERS_TICKETS_PATH,
): Promise<WagersTicketsRead> {
  const file = bunFile(ticketsPath);
  if (!(await file.exists())) {
    return { path: ticketsPath, doc: null, missing: true, error: null };
  }
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    return {
      path: ticketsPath,
      doc: null,
      missing: false,
      error: "parse_error",
    };
  }
  const result = wagersTicketsDocSchema.safeParse(parsed);
  if (!result.success) {
    return {
      path: ticketsPath,
      doc: null,
      missing: false,
      error: "schema_mismatch",
    };
  }
  return { path: ticketsPath, doc: result.data, missing: false, error: null };
}

/** Read the alert document (MISSING / UNSUPPORTED / invalid are reported, never zeroed). */
export async function readWagersAlerts(
  alertsPath: string = WAGERS_ALERTS_PATH,
): Promise<WagersAlertsRead> {
  const file = bunFile(alertsPath);
  if (!(await file.exists())) {
    return {
      path: alertsPath,
      doc: null,
      missing: true,
      unsupported: false,
      invalid: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    return {
      path: alertsPath,
      doc: null,
      missing: false,
      unsupported: false,
      invalid: true,
    };
  }
  const version = z.object({ schemaVersion: z.number() }).safeParse(parsed);
  if (version.success && version.data.schemaVersion !== 1) {
    return {
      path: alertsPath,
      doc: null,
      missing: false,
      unsupported: true,
      invalid: false,
    };
  }
  const result = wagersAlertsDocSchema.safeParse(parsed);
  if (!result.success) {
    return {
      path: alertsPath,
      doc: null,
      missing: false,
      unsupported: false,
      invalid: true,
    };
  }
  return {
    path: alertsPath,
    doc: result.data,
    missing: false,
    unsupported: false,
    invalid: false,
  };
}

/**
 * Inputs `Bun.JSONL.parseChunk` accepts: a string, a plain `ArrayBuffer`, or any view over one.
 * A plain ArrayBuffer is enough — a Uint8Array is not required.
 */
export type JsonlChunkInput = string | ArrayBufferLike | ArrayBufferView;

/** Observable JSONL truncation: `done`/`read` say whether the tail was parsed. */
export interface JsonlChunkParse {
  readonly values: readonly unknown[];
  readonly done: boolean;
  readonly error: string | null;
  /** Bytes the parser did not consume (Bun 1.4.4 exposes `read`, not `buffer`). */
  readonly unreadBytes: number;
}

/** One chunk parse where an incomplete tail is data, not something to silently drop. */
function jsonlBytes(input: JsonlChunkInput): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(input);
}

/** Unparsed tail after `read`, dropping the one record-separator newline Bun leaves at `read`. */
function jsonlUnreadTail(bytes: Uint8Array, read: number): Uint8Array {
  let tail = bytes.subarray(read);
  if (tail.length > 0 && tail[0] === 0x0a) tail = tail.subarray(1);
  return tail;
}

export function parseJsonlChunkStrict(input: JsonlChunkInput): JsonlChunkParse {
  const bytes = jsonlBytes(input);
  const chunk = JSONL.parseChunk(bytes);
  return {
    values: chunk.values,
    done: chunk.done,
    error: chunk.error === null ? null : String(chunk.error),
    unreadBytes: chunk.done ? 0 : jsonlUnreadTail(bytes, chunk.read).length,
  };
}

export interface JsonlStreamParse {
  readonly values: readonly unknown[];
  readonly error: string | null;
  /** Partial final line that the parser could not consume; empty for a complete stream. */
  readonly unreadTail: Uint8Array;
}

/**
 * Stream JSONL without ever concatenating the whole window: each iteration parses
 * `carry + chunk` (carry is only the incomplete tail) and keeps the new tail for the next chunk.
 * `Bun.JSONL.parseChunk`'s zero-copy property is about parsing bytes; accumulation is our job, so
 * only complete values are retained.
 */
export async function parseJsonlChunks(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<JsonlStreamParse> {
  const values: unknown[] = [];
  let carry = new Uint8Array(0);
  for await (const chunk of chunks) {
    const window =
      carry.length === 0
        ? chunk
        : (() => {
            const joined = new Uint8Array(carry.length + chunk.length);
            joined.set(carry, 0);
            joined.set(chunk, carry.length);
            return joined;
          })();
    const parsed = JSONL.parseChunk(window);
    for (const value of parsed.values) values.push(value);
    if (parsed.error !== null) {
      return {
        values,
        error: String(parsed.error),
        unreadTail: new Uint8Array(jsonlUnreadTail(window, parsed.read)),
      };
    }
    carry = parsed.done
      ? new Uint8Array(0)
      : new Uint8Array(jsonlUnreadTail(window, parsed.read));
  }
  return { values, error: null, unreadTail: carry };
}

/**
 * Read the bounded JSONL history (latest `limit` lines). A missing file is MISSING (`missing`),
 * an unknown line `schemaVersion` is UNSUPPORTED, and malformed lines are counted, not returned.
 *
 * Truncation is observable and fatal: `Bun.JSONL.parseChunk` reports `done:false` plus unconsumed
 * bytes when the final line is incomplete, and that throws instead of silently returning a shorter
 * series. A malformed *complete* line still falls back to skip-and-count, so one bad line cannot
 * hide the lines behind it.
 */
export async function readWagersHistory(
  limit = 10,
  historyPath: string = WAGERS_HISTORY_PATH,
): Promise<WagersHistoryRead> {
  const file = bunFile(historyPath);
  if (!(await file.exists())) {
    return {
      path: historyPath,
      lines: [],
      missing: true,
      unsupported: false,
      invalidLines: 0,
    };
  }
  const requested = Number.isFinite(limit) ? Math.floor(limit) : 10;
  const safeLimit = Math.max(1, Math.min(100, requested));
  // Observable truncation: a complete buffer yields values directly; an incomplete tail throws;
  // a malformed complete line falls back to the tolerant pass so the rest stays readable.
  const streamed = await parseJsonlChunks(file.stream());
  const jsonValues: unknown[] = [];
  let invalidLines = 0;
  if (streamed.error === null && streamed.unreadTail.length === 0) {
    jsonValues.push(...streamed.values);
  } else {
    const tailText = new TextDecoder().decode(streamed.unreadTail);
    if (streamed.error === null && !tailText.includes("\n")) {
      throw new Error(
        `${historyPath} is truncated: the final JSONL line is incomplete (` +
          `${streamed.unreadTail.length} bytes unparsed)`,
      );
    }
    // A malformed but complete line (or a parser error): tolerate it and count it, so one bad
    // line cannot hide the lines behind it. This re-reads only on the error path.
    const text = await file.text();
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      try {
        jsonValues.push(JSON.parse(line));
      } catch {
        invalidLines += 1;
      }
    }
  }
  const lines: WagersHistoryLine[] = [];
  let unsupported = false;
  for (const json of jsonValues) {
    const version = z.object({ schemaVersion: z.number() }).safeParse(json);
    if (version.success && version.data.schemaVersion !== 1) {
      unsupported = true;
      continue;
    }
    const parsed = wagersHistoryLineSchema.safeParse(json);
    if (!parsed.success) {
      invalidLines += 1;
      continue;
    }
    lines.push(parsed.data);
  }
  if (unsupported) {
    return {
      path: historyPath,
      lines: [],
      missing: false,
      unsupported: true,
      invalidLines,
    };
  }
  return {
    path: historyPath,
    lines: lines.slice(-safeLimit),
    missing: false,
    unsupported: false,
    invalidLines,
  };
}

/** Captured-at of the artifact already on disk, before this run replaces it (stale detection). */
export async function readWagersArtifactCapturedAt(
  artifactPath: string,
): Promise<string | null> {
  const file = bunFile(artifactPath);
  if (!(await file.exists())) return null;
  try {
    const parsed = z
      .object({
        schemaVersion: z.literal(2),
        source: z.object({ capturedAt: z.string() }),
      })
      .safeParse(await file.json());
    return parsed.success ? parsed.data.source.capturedAt : null;
  } catch {
    return null;
  }
}

/** Append one history line, rotating atomically when the cap is exceeded (never on failure). */
export async function appendWagersHistory(
  historyPath: string,
  line: WagersHistoryLine,
  keepHistory: number = DEFAULT_KEEP_HISTORY,
): Promise<void> {
  const cap = Math.max(
    1,
    Number.isFinite(keepHistory)
      ? Math.floor(keepHistory)
      : DEFAULT_KEEP_HISTORY,
  );
  const file = bunFile(historyPath);
  const lines: string[] = [];
  if (await file.exists()) {
    for (const raw of (await file.text()).split("\n")) {
      const trimmed = raw.trim();
      if (trimmed !== "") lines.push(trimmed);
    }
  }
  lines.push(JSON.stringify(line));
  const kept = lines.length > cap ? lines.slice(-cap) : lines;
  await writeTextAtomic(historyPath, `${kept.join("\n")}\n`);
}

/**
 * Ticket -> state label. A ticket whose legs all share one state gets that state; a spanning
 * ticket gets its distinct states joined with `+` in canonical state order, so the join key never
 * invents a state it did not observe. Tickets without a ticket field are not representable.
 */
export function buildTicketStateMap(
  legs: readonly WagerLeg[],
): Readonly<Record<string, string>> {
  const statesByTicket = new Map<string, Set<string>>();
  for (const leg of legs) {
    if (leg.ticket === null) continue;
    const states = statesByTicket.get(leg.ticket);
    if (states === undefined) {
      statesByTicket.set(leg.ticket, new Set([leg.state]));
    } else {
      states.add(leg.state);
    }
  }
  const tickets: Record<string, string> = {};
  for (const [ticket, stateSet] of statesByTicket) {
    const states = [...stateSet];
    tickets[ticket] =
      states.length === 1
        ? (states[0] ?? MISSING_STATE)
        : states
            .sort((left, right) => stateRank(left) - stateRank(right))
            .join("+");
  }
  return tickets;
}

/** History projection of the report's per-state rows (same nullability as the v2 artifact). */
export function wagersHistoryStates(
  states: readonly WagerStateRow[],
): readonly WagersHistoryState[] {
  return states.map((state) => ({
    state: state.state,
    legs: state.legs,
    wagers: state.wagers,
    wagerRiskAttributed: state.wagerRiskAttributed,
  }));
}

/** Measured data-quality flags for the history line (empty array = all checks clear). */
export function wagersQualityFlags(report: WagerReport): readonly string[] {
  const flags: string[] = [];
  const quality = report.quality;
  if (quality.unknownStates.length > 0) flags.push("unknown_states");
  if (quality.unparsedBetTimes > 0) flags.push("unparsed_bet_times");
  if (quality.numericStateCodes.length > 0) flags.push("numeric_state_codes");
  if (
    quality.coherenceViolations.winResultNonPositive > 0 ||
    quality.coherenceViolations.loseResultNonNegative > 0
  ) {
    flags.push("coherence_violations");
  }
  if (report.identity.ticketField === null) flags.push("no_ticket_field");
  else if (report.identity.coveragePct < 100) {
    flags.push("ticket_coverage_incomplete");
  }
  return flags;
}

/** One history line for a successful capture. */
export function buildWagersHistoryLine(input: {
  readonly report: WagerReport;
  readonly delta: WagersHistoryDelta | null;
  readonly alerts: readonly WagersAlert[];
}): WagersHistoryLine {
  const capturedAt = captureTimeOf(input.report.source);
  return {
    schemaVersion: 1,
    capturedAt,
    sourceKind: "live-ajax.php",
    totals: {
      legs: input.report.totals.legs,
      wagers: input.report.totals.wagers,
      spanning: input.report.totals.spanning,
      legRisk: input.report.totals.legRisk,
      wagerRisk: input.report.totals.wagerRisk,
      legToWin: input.report.totals.legToWin,
      legResult: input.report.totals.legResult,
    },
    states: wagersHistoryStates(input.report.states),
    delta: input.delta,
    qualityFlags: wagersQualityFlags(input.report),
    alerts: input.alerts,
  };
}

/** One alerts document for a successful capture (empty `alerts` = measured "none"). */
export function buildWagersAlertsDoc(input: {
  readonly report: WagerReport;
  readonly alerts: readonly WagersAlert[];
}): WagersAlertsDoc {
  const capturedAt = captureTimeOf(input.report.source);
  return {
    schemaVersion: 1,
    generatedAt: capturedAt,
    sourceCapturedAt: capturedAt,
    alerts: input.alerts,
  };
}

export interface WagersDeltaInput {
  readonly previousTickets: Readonly<Record<string, string>>;
  readonly previousCapturedAt: string;
  readonly previousStates: readonly WagersHistoryState[];
  readonly currentTickets: Readonly<Record<string, string>>;
  readonly currentStates: readonly WagersHistoryState[];
  readonly toCapturedAt: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Ticket turnover + per-state movement against the previous capture (counts only). */
export function computeWagersDelta(
  input: WagersDeltaInput,
): WagersHistoryDelta {
  const previousIds = Object.keys(input.previousTickets);
  const currentIds = Object.keys(input.currentTickets);
  let newTickets = 0;
  for (const ticket of currentIds) {
    if (!(ticket in input.previousTickets)) newTickets += 1;
  }
  let goneTickets = 0;
  for (const ticket of previousIds) {
    if (!(ticket in input.currentTickets)) goneTickets += 1;
  }

  const migrationCounts = new Map<string, number>();
  for (const ticket of currentIds) {
    const before = input.previousTickets[ticket];
    const after = input.currentTickets[ticket];
    if (before === undefined || before === after) continue;
    const key = `${before}\u0000${after}`;
    migrationCounts.set(key, (migrationCounts.get(key) ?? 0) + 1);
  }
  const migrations: WagersDeltaMigration[] = [];
  for (const [key, tickets] of migrationCounts) {
    const [from, to] = key.split("\u0000");
    migrations.push({ from: from ?? "", to: to ?? "", tickets });
  }
  migrations.sort(
    (left, right) =>
      stateRank(left.from) - stateRank(right.from) ||
      stateRank(left.to) - stateRank(right.to),
  );

  const previousByState = new Map(
    input.previousStates.map((state) => [state.state, state]),
  );
  const currentByState = new Map(
    input.currentStates.map((state) => [state.state, state]),
  );
  const stateNames = [
    ...new Set([...previousByState.keys(), ...currentByState.keys()]),
  ].sort((left, right) => stateRank(left) - stateRank(right));
  const perState: WagersDeltaState[] = [];
  for (const state of stateNames) {
    const before = previousByState.get(state);
    const after = currentByState.get(state);
    const legs = (after?.legs ?? 0) - (before?.legs ?? 0);
    const wagers = (after?.wagers ?? 0) - (before?.wagers ?? 0);
    const wagerRisk = round2(
      (after?.wagerRiskAttributed ?? 0) - (before?.wagerRiskAttributed ?? 0),
    );
    if (legs === 0 && wagers === 0 && wagerRisk === 0) continue;
    perState.push({ state, legs, wagers, wagerRisk });
  }

  return {
    fromCapturedAt: input.previousCapturedAt,
    toCapturedAt: input.toCapturedAt,
    newTickets,
    goneTickets,
    migrations,
    perState,
  };
}

function signedNumber(value: number): string {
  const rounded = Number.isInteger(value) ? value : round2(value);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function signedPct(pct: number): string {
  const rounded = Math.round(pct * 10) / 10;
  return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
}

function formatAgeMinutes(minutes: number): number {
  return Math.round(minutes * 10) / 10;
}

interface PendingBucketSelection {
  readonly bucket: keyof PendingAgeBuckets;
  readonly hours: number;
}

/** The report measures 1h/6h/24h/72h buckets; the CLI threshold maps to the nearest one. */
function pendingBucketForHours(hours: number): PendingBucketSelection {
  if (hours <= 1) return { bucket: "gt1h", hours: 1 };
  if (hours <= 6) return { bucket: "gt6h", hours: 6 };
  if (hours <= 24) return { bucket: "gt24h", hours: 24 };
  return { bucket: "gt72h", hours: 72 };
}

export interface WagersAlertEvaluationInput {
  readonly report: WagerReport;
  readonly thresholds: WagersAlertThresholds;
  readonly delta: WagersHistoryDelta | null;
  readonly previousHistory: WagersHistoryLine | null;
  readonly previousTickets: WagersTicketsRead;
  readonly previousArtifactCapturedAt: string | null;
}

/**
 * Derive the deterministic alert set. Every alert reads a measured number off the report, the
 * delta or the previous documents; nothing here is a guess about what "should" have happened.
 */
export function deriveWagersAlerts(
  input: WagersAlertEvaluationInput,
): WagersAlert[] {
  const alerts: WagersAlert[] = [];
  const capturedAt = captureTimeOf(input.report.source);
  const capturedMs = Date.parse(capturedAt);

  if (input.previousTickets.error !== null) {
    alerts.push({
      code: "alert_read_error",
      severity: "warn",
      summary: "previous ticket-state document is unreadable",
      detail: `reason=${input.previousTickets.error}; delta=null; capture continued`,
    });
  }

  if (input.previousArtifactCapturedAt !== null) {
    const previousMs = Date.parse(input.previousArtifactCapturedAt);
    if (Number.isFinite(previousMs) && Number.isFinite(capturedMs)) {
      const ageMinutes = (capturedMs - previousMs) / 60_000;
      const staleAfter =
        input.thresholds.cadenceMinutes * CAPTURE_STALE_CADENCE_MULTIPLIER;
      if (ageMinutes > staleAfter) {
        alerts.push({
          code: "capture_stale",
          severity: "warn",
          summary: `previous artifact older than ${staleAfter} min`,
          detail:
            `age=${formatAgeMinutes(ageMinutes)}min; ` +
            `cadence=${input.thresholds.cadenceMinutes}min`,
        });
      }
    }
  }

  const buckets = input.report.quality.pendingAgeMinutes;
  const pending = pendingBucketForHours(input.thresholds.pendingWarnHours);
  const aged = buckets[pending.bucket];
  if (aged > 0) {
    alerts.push({
      code: "pending_aging",
      severity: buckets.gt72h > 0 ? "critical" : "warn",
      summary: `${aged} pending legs older than ${pending.hours}h`,
      detail:
        `gt1h=${buckets.gt1h}; gt6h=${buckets.gt6h}; ` +
        `gt24h=${buckets.gt24h}; gt72h=${buckets.gt72h}`,
    });
  }

  const unknownStates = input.report.quality.unknownStates;
  if (unknownStates.length > 0) {
    alerts.push({
      code: "unknown_state",
      severity: "warn",
      summary: `${unknownStates.length} unknown state label(s)`,
      detail: unknownStates.join(", ").slice(0, 200),
    });
  }

  const coherence = input.report.quality.coherenceViolations;
  const coherenceCount =
    coherence.winResultNonPositive + coherence.loseResultNonNegative;
  if (coherenceCount > 0) {
    alerts.push({
      code: "coherence_violation",
      severity: "warn",
      summary: `${coherenceCount} state/result coherence violation(s)`,
      detail:
        `win with result<=0=${coherence.winResultNonPositive}; ` +
        `lose with result>=0=${coherence.loseResultNonNegative}`,
    });
  }

  if (input.previousHistory !== null) {
    const previousByState = new Map(
      input.previousHistory.states.map((state) => [state.state, state]),
    );
    for (const current of wagersHistoryStates(input.report.states)) {
      const before = previousByState.get(current.state);
      if (before === undefined) continue;
      const spikes: { metric: string; moved: number; on: number }[] = [
        { metric: "legs", moved: current.legs - before.legs, on: before.legs },
      ];
      if (
        current.wagerRiskAttributed !== null &&
        before.wagerRiskAttributed !== null
      ) {
        spikes.push({
          metric: "wagerRisk",
          moved: round2(
            current.wagerRiskAttributed - before.wagerRiskAttributed,
          ),
          on: before.wagerRiskAttributed,
        });
      }
      for (const spike of spikes) {
        const pct =
          spike.on === 0
            ? spike.moved === 0
              ? 0
              : 100
            : (spike.moved / spike.on) * 100;
        if (
          Math.abs(spike.moved) >= input.thresholds.spikeMin &&
          Math.abs(pct) >= input.thresholds.spikePct
        ) {
          alerts.push({
            code: "state_spike",
            severity: "warn",
            summary: `${current.state} ${spike.metric} moved ${signedPct(pct)}`,
            detail: `${signedNumber(spike.moved)} on ${spike.on}`,
          });
        }
      }
    }
  }

  const previousWagers =
    input.previousHistory?.totals.wagers ??
    (input.previousTickets.doc === null
      ? null
      : Object.keys(input.previousTickets.doc.tickets).length);
  if (input.delta !== null && previousWagers !== null) {
    const churn = input.delta.newTickets + input.delta.goneTickets;
    const churnMin = input.thresholds.churnMin ?? DEFAULT_CHURN_MIN;
    const churnPct = input.thresholds.churnPct ?? DEFAULT_CHURN_PCT;
    if (
      previousWagers >= churnMin &&
      churn > (previousWagers * churnPct) / 100
    ) {
      alerts.push({
        code: "ticket_churn",
        severity: "warn",
        summary: `${churn} tickets churned`,
        detail:
          `new=${input.delta.newTickets}; gone=${input.delta.goneTickets}; ` +
          `previousWagers=${previousWagers}`,
      });
    }
  }

  const order = new Map<WagersAlertCode, number>(
    WAGERS_ALERT_CODES.map((code, index) => [code, index]),
  );
  return alerts.sort(
    (left, right) =>
      (order.get(left.code) ?? 99) - (order.get(right.code) ?? 99) ||
      left.summary.localeCompare(right.summary),
  );
}

/** True when any alert is `warn` or `critical` (what `--fail-on-alert` reacts to). */
export function hasBlockingAlert(alerts: readonly WagersAlert[]): boolean {
  return alerts.some(
    (alert) => alert.severity === "warn" || alert.severity === "critical",
  );
}

/** One `getBetReport` read -> both the v2 artifact and the leg rows history needs. */
export interface WagersCaptureSnapshot {
  readonly report: WagerReport;
  readonly legs: readonly WagerLeg[];
}

export async function captureWagersSnapshot(
  opts: CaptureWagersOptions,
): Promise<WagersCaptureSnapshot> {
  const live = await fetchWagersByStateLive({
    fromEpochSec: opts.fromEpochSec,
    toEpochSec: opts.toEpochSec,
    dateFilterBy: opts.dateFilterBy,
    cookieHeader: opts.cookieHeader,
    ...(opts.sessionGate === undefined
      ? {}
      : { sessionGate: opts.sessionGate }),
    ...(opts.payload === undefined ? {} : { payload: opts.payload }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    ...(opts.ajaxUrl === undefined ? {} : { ajaxUrl: opts.ajaxUrl }),
  });
  const report = buildLiveWagerReport(live.legsOrdered, {
    fromEpochSec: live.fromEpochSec,
    toEpochSec: live.toEpochSec,
    dateFilterBy: live.dateFilterBy,
    capturedAt: live.capturedAt,
    ...(opts.ajaxUrl === undefined ? {} : { url: opts.ajaxUrl }),
  });
  return { report, legs: toLiveWagerLegs(live.legsOrdered).legs };
}

async function main(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      live: { type: "boolean", default: false },
      csv: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      payload: { type: "string" },
      "date-filter-by": { type: "string", default: "calcTime" },
      timeout: { type: "string", default: "15000" },
      out: { type: "string" },
      json: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "bootstrap-session": { type: "boolean", default: false },
      "ajax-url": { type: "string" },
      "webview-profile": { type: "string" },
    },
  });

  const dateFilterBy = parseDateFilterBy(values["date-filter-by"]);

  if (values.live) {
    const payloadPath = values.payload?.trim() ?? "";
    const suppliedPayload =
      payloadPath === ""
        ? undefined
        : parseBetReportRequest(await bunFile(payloadPath).json());

    const nowSec = Math.floor(Date.now() / 1000);
    const fromEpochSec =
      suppliedPayload?.from ??
      (values.from === undefined ? nowSec - 604_800 : Number(values.from));
    const toEpochSec =
      suppliedPayload?.to ??
      (values.to === undefined ? nowSec : Number(values.to));
    const effectiveDateFilterBy = suppliedPayload?.dateFilterBy ?? dateFilterBy;
    if (!Number.isFinite(fromEpochSec) || !Number.isFinite(toEpochSec)) {
      throw new Error("--from and --to must be epoch seconds");
    }
    if (fromEpochSec > toEpochSec) throw new Error("--from must be <= --to");

    if (values["dry-run"]) {
      console.error(
        JSON.stringify(
          {
            url: values["ajax-url"]?.trim() || AJAX_URL,
            method: "POST",
            source: suppliedPayload === undefined ? "generated" : payloadPath,
            body: suppliedPayload ?? {
              action: "getBetReport",
              state: "",
              from: fromEpochSec,
              to: toEpochSec,
              fromTime: 0,
              toTime: 86399,
              dateFilterBy: effectiveDateFilterBy,
            },
          },
          null,
          2,
        ),
      );
      return;
    }

    const webviewProfile =
      values["webview-profile"]?.trim() ??
      (env.GSLIVE_WEBVIEW_PROFILE ?? "").trim();
    const session =
      webviewProfile === ""
        ? await requireManagerSession(env)
        : await sessionFromGsliveProfile({ profileDir: webviewProfile });
    const cookieHeader = session.cookieHeader;
    let sessionGate = sessionGateFromEnv(env);
    if (values["bootstrap-session"] && sessionGate === "") {
      sessionGate = await bootstrapGanchrowSession({ cookieHeader });
      console.log(
        "bootstrapped x-gs-session from POST /api/v3/manager-tools/signin/",
      );
    }

    const ajaxUrl = values["ajax-url"]?.trim() ?? "";
    const report = await captureWagersReport({
      fromEpochSec,
      toEpochSec,
      cookieHeader,
      sessionGate,
      dateFilterBy: effectiveDateFilterBy,
      timeoutMs: Number(values.timeout) || 15_000,
      ...(suppliedPayload === undefined ? {} : { payload: suppliedPayload }),
      ...(ajaxUrl === "" ? {} : { ajaxUrl }),
    });

    console.log(formatWagerTable(report));
    console.log(`\n${formatWagerQuality(report)}`);

    const out = values.out ?? WAGERS_ARTIFACT_PATH;
    if (out !== "-") {
      await writeJsonAtomic(out, report);
      console.log(
        `\nwrote ${out} (v2, ${report.totals.legs} legs, source live-ajax.php)`,
      );
    }
    return;
  }

  const csvPath = values.csv?.trim() ?? "";
  if (csvPath === "") {
    throw new Error(
      "choose a source: --live (ajax.php) or --csv <path/to/bet-report.csv> (offline export)",
    );
  }

  const file = bunFile(csvPath);
  const text = await file.text();
  const stat = await file.stat();
  const csvRows = parseCsv(text);
  const profile = profileCsvTicket(csvRows);
  const rows = sortWagersByState(toWagerRows(csvRows, profile));
  const report = analyzeLegs(rows, {
    source: {
      kind: "offline-csv",
      path: csvPath,
      mtime: stat.mtime.toISOString(),
      dateFilterBy: null,
    },
    nowMs: Date.now(),
    ticketField: profile.ticketField,
    ticketCoveragePct: profile.coveragePct,
  });

  console.log(formatWagerTable(report));
  console.log(`\n${formatWagerQuality(report)}`);

  const out = values.out ?? "scratch/gslive-wagers-by-state.csv";
  if (out !== "-") {
    await writeTextAtomic(out, toCsv(rows));
    console.log(`\nwrote ${out} (${rows.length} legs)`);
  }
  if (values.json !== undefined && values.json !== "-") {
    await writeJsonAtomic(values.json, report);
    console.log(`wrote ${values.json} (schemaVersion 2)`);
  }
}

if (import.meta.main) {
  try {
    await main(argv.slice(2));
  } catch (error) {
    console.error(
      `wagers-by-state: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
