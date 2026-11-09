/**
 * @file settlement_outcomes.ts
 * @description Export normalized wager outcomes from the settlement lifecycle store for the
 * alert-performance join.
 *
 * The settlement store (`wager_settlement_observations`, see
 * `lib/fantasy402_settlement_ingest.ts`) is append-only; the latest observation per ticket wins.
 * Each exported row is `{customerId, wagerNumber, outcome, netUsd, source}` — exactly what
 * `lib/alert_performance.ts` consumes. Ticket ids are `LOGIN|wagerNumber`.
 *
 * The store's schema evolved: older files predate `run_at`, `outcome` and the money columns (the
 * ingest code ALTERs those in). This exporter therefore inspects
 * `PRAGMA table_info(wager_settlement_observations)` and adapts the SELECT instead of assuming
 * the current shape, so a legacy store still exports: observation time falls back to
 * `valid_time` and missing money columns read as NULL.
 *
 * MISSING honesty: an absent file is `db_missing`, a present file without the table is
 * `schema_missing`, and the exporter never opens the database writable — a missing store is never
 * created as a silent empty outcome set.
 */

import { existsSync } from "node:fs";

import type { Database } from "bun:sqlite";

import type { AlertPerformanceOutcome } from "./alert_performance.ts";
import { openSportsdeskSqliteReadonly } from "./sportsdesk_sqlite.ts";

const TABLE = "wager_settlement_observations";

/** Columns the net math reads; absent in legacy stores, so selected as NULL. */
const OPTIONAL_COLUMNS = [
  "risk_cents",
  "to_win_cents",
  "amount_cents",
  "amount_refunded_cents",
] as const;

export type SettlementOutcomeExportReason =
  "db_missing" | "schema_missing" | "read_failed";

export interface SettlementOutcomeWindow {
  /** Earliest observation instant among the exported rows; null when none were exported. */
  readonly from: string | null;
  /** Latest observation instant among the exported rows; null when none were exported. */
  readonly to: string | null;
}

export interface SettlementOutcomeExport {
  readonly ok: boolean;
  /** Present when `ok` is false: db_missing / schema_missing / read_failed. */
  readonly reason: SettlementOutcomeExportReason | null;
  readonly rows: readonly AlertPerformanceOutcome[];
  /** Distinct ticket ids observed (exported + skipped), as before. */
  readonly tickets: number;
  readonly skipped: number;
  readonly dbPath: string;
  /**
   * Freshest observation instant in the store — max `run_at` (fallback `valid_time`) over every
   * observation row, including skipped ones, because it reports store freshness rather than the
   * exported subset. Null when the table is empty or unreadable.
   */
  readonly asOf: string | null;
  /**
   * Observation-time span of the exported rows. This is the observation axis (the one used to
   * choose the latest row), not `valid_time`, so it matches what `asOf` measures.
   */
  readonly outcomeWindow: SettlementOutcomeWindow;
}

interface ObservationRow {
  readonly id: number | bigint;
  readonly observed_at: string | null;
  readonly ticket_id: string | null;
  readonly outcome: string | null;
  readonly risk_cents: number | bigint | null;
  readonly to_win_cents: number | bigint | null;
  readonly amount_cents: number | bigint | null;
  readonly amount_refunded_cents: number | bigint | null;
}

interface TableInfoRow {
  readonly name: string;
}

function emptyResult(
  dbPath: string,
  reason: SettlementOutcomeExportReason | null,
): SettlementOutcomeExport {
  return {
    ok: false,
    reason,
    rows: [],
    tickets: 0,
    skipped: 0,
    dbPath,
    asOf: null,
    outcomeWindow: { from: null, to: null },
  };
}

function toOutcome(
  raw: string | null,
): "win" | "loss" | "push" | "void" | null {
  if (raw === null) return null;
  const value = raw.trim().toUpperCase();
  if (value === "W" || value === "WIN") return "win";
  if (value === "L" || value === "LOSS") return "loss";
  if (value === "P" || value === "PUSH") return "push";
  if (value === "V" || value === "VOID") return "void";
  return null;
}

function cents(value: number | bigint | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const amount = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount) / 100;
}

function instantMs(value: string | null): number | null {
  if (value === null || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Later of two raw observation stamps; parseable beats unparseable, then lexical order. */
function laterInstant(a: string | null, b: string | null): string | null {
  if (b === null || b === "") return a;
  if (a === null || a === "") return b;
  const aMs = instantMs(a);
  const bMs = instantMs(b);
  if (aMs !== null && bMs !== null) return bMs > aMs ? b : a;
  if (aMs !== null) return a;
  if (bMs !== null) return b;
  return b > a ? b : a;
}

/** Earlier of two raw observation stamps; parseable beats unparseable, then lexical order. */
function earlierInstant(a: string | null, b: string | null): string | null {
  if (b === null || b === "") return a;
  if (a === null || a === "") return b;
  const aMs = instantMs(a);
  const bMs = instantMs(b);
  if (aMs !== null && bMs !== null) return aMs < bMs ? a : b;
  if (aMs !== null) return a;
  if (bMs !== null) return b;
  return a < b ? a : b;
}

function selectColumn(
  columns: ReadonlySet<string>,
  name: string,
  alias: string,
): string {
  return columns.has(name) ? `${name} AS ${alias}` : `NULL AS ${alias}`;
}

/** Effective observation-time expression: `run_at`, falling back to `valid_time` per row. */
function observationTimeExpression(columns: ReadonlySet<string>): string {
  const hasRunAt = columns.has("run_at");
  const hasValidTime = columns.has("valid_time");
  if (hasRunAt && hasValidTime) {
    return "COALESCE(NULLIF(run_at, ''), valid_time)";
  }
  if (hasRunAt) return "NULLIF(run_at, '')";
  return "valid_time";
}

function rowTimestamp(row: ObservationRow): string | null {
  return typeof row.observed_at === "string" ? row.observed_at : null;
}

/**
 * Read the latest settlement outcome per ticket. The store is opened read-only after an explicit
 * existence check, so a missing path is reported as `db_missing` and never created.
 */
export function exportSettlementOutcomes(
  dbPath: string,
): SettlementOutcomeExport {
  if (!existsSync(dbPath)) {
    // Opening a missing path would CREATE an empty SQLite file, turning MISSING into a silent
    // empty outcome set. Refuse instead.
    return emptyResult(dbPath, "db_missing");
  }

  let db: Database | null = null;
  try {
    db = openSportsdeskSqliteReadonly(dbPath);

    const tableInfo = db
      .query(`PRAGMA table_info(${TABLE})`)
      .all() as TableInfoRow[];
    const columns = new Set(
      tableInfo
        .map((column) => column.name)
        .filter((name): name is string => typeof name === "string")
        .map((name) => name.toLowerCase()),
    );
    if (columns.size === 0) return emptyResult(dbPath, "schema_missing");

    const hasTimeColumn = columns.has("run_at") || columns.has("valid_time");
    if (!columns.has("ticket_id") || !hasTimeColumn) {
      return emptyResult(dbPath, "schema_missing");
    }

    // A migrated legacy store may carry only `result` (WIN/LOSS) or only `outcome`; requiring at
    // least one avoids reporting a silent empty export as success.
    const outcomeExpression =
      columns.has("outcome") && columns.has("result")
        ? "COALESCE(NULLIF(outcome, ''), result)"
        : columns.has("outcome")
          ? "outcome"
          : columns.has("result")
            ? "result"
            : null;
    if (outcomeExpression === null)
      return emptyResult(dbPath, "schema_missing");

    const idColumn = columns.has("id") ? "id" : "rowid";
    const selectList = [
      `${idColumn} AS id`,
      `${observationTimeExpression(columns)} AS observed_at`,
      "ticket_id AS ticket_id",
      `${outcomeExpression} AS outcome`,
      ...OPTIONAL_COLUMNS.map((name) => selectColumn(columns, name, name)),
    ].join(", ");
    const result = db
      .query(
        `SELECT ${selectList}
         FROM ${TABLE}
         ORDER BY observed_at ASC, id ASC`,
      )
      .all() as ObservationRow[];

    // Order in JS by parsed instant: run_at is stored verbatim and mixed UTC offsets sort
    // incorrectly as text. Unparseable stamps fall back to lexical order, then id.
    const ordered = [...result].sort((a, b) => {
      const aMs = instantMs(rowTimestamp(a));
      const bMs = instantMs(rowTimestamp(b));
      if (aMs !== null && bMs !== null && aMs !== bMs) return aMs - bMs;
      if (aMs !== null && bMs === null) return -1;
      if (aMs === null && bMs !== null) return 1;
      const aStamp = rowTimestamp(a) ?? "";
      const bStamp = rowTimestamp(b) ?? "";
      if (aStamp !== bStamp) return aStamp < bStamp ? -1 : 1;
      return Number(a.id) - Number(b.id);
    });

    // Latest OBSERVATION per ticket (effective observation time, then id), not latest valid_time:
    // valid_time is the game/settlement clock and can move backwards relative to observation.
    const latest = new Map<string, ObservationRow>();
    let skipped = 0;
    let asOf: string | null = null;
    for (const row of ordered) {
      asOf = laterInstant(asOf, rowTimestamp(row));
      const ticketId =
        typeof row.ticket_id === "string" ? row.ticket_id.trim() : "";
      if (ticketId === "") {
        // A NULL/blank ticket id cannot be deduped; count it as skipped instead of collapsing
        // every such row into one map entry.
        skipped += 1;
        continue;
      }
      latest.set(ticketId, row);
    }

    const rows: AlertPerformanceOutcome[] = [];
    let windowFrom: string | null = null;
    let windowTo: string | null = null;
    for (const [ticketId, row] of latest.entries()) {
      const outcome = toOutcome(row.outcome);
      const separator = ticketId.lastIndexOf("|");
      const login = separator === -1 ? "" : ticketId.slice(0, separator).trim();
      const wagerNumber =
        separator === -1 ? "" : ticketId.slice(separator + 1).trim();
      if (outcome === null || login === "" || wagerNumber === "") {
        skipped += 1;
        continue;
      }
      const risk = cents(row.risk_cents);
      const toWin = cents(row.to_win_cents);
      const amount = cents(row.amount_cents);
      // Guard the sign: a WIN can never export a negative/zero net, and a LOSS never a
      // positive one. Anomalous money rows fall back to the other field or null (never inverted).
      const refunded = cents(row.amount_refunded_cents);
      const winNet = [amount, toWin].find(
        (value) => value !== null && value > 0,
      );
      const netUsd =
        outcome === "win"
          ? (winNet ?? null)
          : outcome === "loss"
            ? risk === null || risk <= 0
              ? null
              : -risk
            : refunded !== null && risk !== null
              ? Math.round((refunded - risk) * 100) / 100
              : 0;
      rows.push({
        customerId: login.toUpperCase(),
        wagerNumber,
        outcome,
        netUsd,
        source: "settlement_store",
      });
      const observedAt = rowTimestamp(row);
      windowFrom = earlierInstant(windowFrom, observedAt);
      windowTo = laterInstant(windowTo, observedAt);
    }

    return {
      ok: true,
      reason: null,
      rows,
      tickets: latest.size,
      skipped,
      dbPath,
      asOf,
      outcomeWindow: { from: windowFrom, to: windowTo },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return emptyResult(
      dbPath,
      message.includes("no such table") ? "schema_missing" : "read_failed",
    );
  } finally {
    db?.close();
  }
}

/** JSONL payload for `alert-log --performance --outcomes`. */
export function settlementOutcomesJsonl(
  rows: readonly AlertPerformanceOutcome[],
): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}
