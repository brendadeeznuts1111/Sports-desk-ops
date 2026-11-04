/**
 * Append-only Manager/getHistory + getGrading observations (wager lifecycle slice).
 */

import type { Database } from "bun:sqlite";
import { z } from "zod";
import { openSportsdeskSqlite, sqlInt } from "./sportsdesk_sqlite.ts";
import {
  auditRunAt,
  type AuditRunId,
  type IsoDateTimeUtc,
} from "./audit_run_id.ts";
import { canonicalJsonString } from "./match_evaluation_canonical.ts";
import { sha256HexOfBytes } from "../services/sportsdesk_ingestion_feed_provenance.ts";
/** Same semantics as candidate verify/replay store invariant exit (5). */
export const SETTLEMENT_EXIT_STORE_INVARIANT = 5;

export type SettlementFeed = "getHistory" | "getGrading";

/**
 * Two independent axes, deliberately not one scalar:
 *
 * - outcome:   W win, L loss, P push, V void (no action)
 * - lifecycle: P pending, S settled, C cancelled
 *
 * They are separate because the same ticket is often both (`S` + `L`), and
 * because `P` means *pending* in one vocabulary and *push* in the other. A
 * single character cannot carry both, and picking one silently drops a fact.
 */
export type WagerOutcome = "W" | "L" | "P" | "V";
export type WagerLifecycle = "P" | "S" | "C";
/** Where the row was written: the GSLIVE writer emits a sparse row shape. */
export type WagerWriterSource = "internet" | "gslive" | "unknown";

/**
 * Wire vocabulary, per axis. Bare letters stay in the vocabulary the Manager
 * feeds use: `W`/`L` are outcomes, `P`/`S`/`C` are lifecycle. A push must
 * arrive spelled `PUSH`, otherwise bare `P` is read as pending.
 */
const OUTCOME_WORDS: Readonly<Record<string, WagerOutcome>> = {
  W: "W",
  WIN: "W",
  WON: "W",
  WINNER: "W",
  L: "L",
  LOSS: "L",
  LOST: "L",
  LOSER: "L",
  PUSH: "P",
  VOID: "V",
  V: "V",
  NOACTION: "V",
};

const LIFECYCLE_WORDS: Readonly<Record<string, WagerLifecycle>> = {
  P: "P",
  PENDING: "P",
  OPEN: "P",
  UNRESOLVED: "P",
  S: "S",
  SETTLED: "S",
  GRADED: "S",
  CLOSED: "S",
  C: "C",
  CANCELLED: "C",
  CANCELED: "C",
  VOIDED: "C",
};

/** `null` = the wire said something this axis does not recognise. */
export function normalizeOutcome(raw: unknown): WagerOutcome | null {
  if (typeof raw !== "string") return null;
  return OUTCOME_WORDS[raw.trim().toUpperCase()] ?? null;
}

export function normalizeLifecycle(raw: unknown): WagerLifecycle | null {
  if (typeof raw !== "string") return null;
  return LIFECYCLE_WORDS[raw.trim().toUpperCase()] ?? null;
}

function writerSource(
  placedOn: string | null | undefined,
  ticketWriter: string | null | undefined,
): WagerWriterSource {
  const writer = `${placedOn ?? ""} ${ticketWriter ?? ""}`.toUpperCase();
  if (writer.includes("GSLIVE")) return "gslive";
  if (writer.includes("INTERNET")) return "internet";
  return "unknown";
}

const blankToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;

/**
 * Boundary schema for Manager history rows.
 *
 * The write side is parsed once here; callers get a typed object or `null`.
 * Unknown wire keys stay in `raw`, which is what gets hashed and stored, so
 * nothing is lost by not modelling a field yet.
 */
const historyRowSchema = z.object({
  Login: z.string().nullish(),
  CustomerID: z.string().nullish(),
  WagerNumber: z.number(),
  WagerStatus: z.preprocess(blankToNull, z.string().nullish()),
  Result: z.preprocess(blankToNull, z.string().nullish()),
  SettlementDateTime: z.preprocess(blankToNull, z.string().nullish()),
  GameDateTime: z.preprocess(blankToNull, z.string().nullish()),
  AcceptedDateTime: z.preprocess(blankToNull, z.string().nullish()),
  InsertDateTime: z.preprocess(blankToNull, z.string().nullish()),
  PlacedOn: z.preprocess(blankToNull, z.string().nullish()),
  TicketWriter: z.preprocess(blankToNull, z.string().nullish()),
  Amount: z.number().nullish(),
  Risk: z.number().nullish(),
  ToWin: z.number().nullish(),
  /** `null` means the writer omitted it; `0` means the writer asserted zero. */
  AmountRefunded: z.number().nullish(),
  ItemNumber: z.number().nullish(),
  PlayNumber: z.number().nullish(),
});

const gradingLegSchema = z.object({
  CustomerID: z.string(),
  WagerNumber: z.number(),
  LegNumber: z.number().nullish(),
  Amount: z.number().nullish(),
  SettlementDateTime: z.preprocess(blankToNull, z.string().nullish()),
  Result: z.preprocess(blankToNull, z.string().nullish()),
});

export type HistoryRowInput = z.input<typeof historyRowSchema>;

/** GSLIVE writes `1900-01-01` where a game date is absent. Not a real date. */
function isPlaceholderDate(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().startsWith("1900-01-01");
}

export type NormalizedSettlementObservation = {
  ticketId: string;
  login: string;
  wagerNumber: number;
  outcome: WagerOutcome | null;
  lifecycle: WagerLifecycle | null;
  source: WagerWriterSource;
  validTime: string;
  sourceFeed: SettlementFeed;
  legNumber: number | null;
  result: string | null;
  amountCents: number | null;
  riskCents: number | null;
  toWinCents: number | null;
  /** `null` = omitted by the writer; `0` = explicit zero. Never coerced. */
  amountRefundedCents: number | null;
  raw: Record<string, unknown>;
  payloadSha256: string;
};

export function fantasy402TicketId(login: string, wagerNumber: number): string {
  return `${login.trim().toUpperCase()}|${wagerNumber}`;
}

function hashRawPayload(raw: Record<string, unknown>): string {
  return sha256HexOfBytes(new TextEncoder().encode(canonicalJsonString(raw)));
}

function parseIsoTime(label: string, value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/** The subset `extractValidTimeFromHistoryRow` reads; callers may pass a raw row. */
export type HistoryTimeFields = {
  SettlementDateTime?: string | null | undefined;
  GameDateTime?: string | null | undefined;
  AcceptedDateTime?: string | null | undefined;
  InsertDateTime?: string | null | undefined;
  PlacedOn?: string | null | undefined;
  TicketWriter?: string | null | undefined;
};

export function extractValidTimeFromHistoryRow(row: HistoryTimeFields): string {
  const gameDate =
    row.PlacedOn?.toUpperCase().includes("GSLIVE") === true ||
    row.TicketWriter?.toUpperCase().includes("GSLIVE") === true
      ? isPlaceholderDate(row.GameDateTime)
        ? null
        : row.GameDateTime
      : row.GameDateTime;
  return (
    parseIsoTime("SettlementDateTime", row.SettlementDateTime) ??
    parseIsoTime("GameDateTime", gameDate) ??
    parseIsoTime("AcceptedDateTime", row.AcceptedDateTime) ??
    parseIsoTime("InsertDateTime", row.InsertDateTime) ??
    new Date(0).toISOString()
  );
}

export function normalizeHistoryWagerRow(
  input: unknown,
  sourceFeed: SettlementFeed = "getHistory",
): NormalizedSettlementObservation | null {
  const parsed = historyRowSchema.safeParse(input);
  if (!parsed.success) return null;
  const row = parsed.data;

  const loginRaw = row.Login ?? row.CustomerID;
  if (typeof loginRaw !== "string" || loginRaw.trim() === "") return null;

  const login = loginRaw.trim();
  const source = writerSource(row.PlacedOn, row.TicketWriter);
  const validTime = extractValidTimeFromHistoryRow(row);
  const raw = input as Record<string, unknown>;

  return {
    ticketId: fantasy402TicketId(login, row.WagerNumber),
    login,
    wagerNumber: row.WagerNumber,
    outcome: normalizeOutcome(row.WagerStatus),
    lifecycle: normalizeLifecycle(row.WagerStatus),
    source,
    validTime,
    sourceFeed,
    legNumber: row.ItemNumber ?? row.PlayNumber ?? null,
    result:
      row.Result === null || row.Result === undefined
        ? null
        : row.Result.trim().toUpperCase(),
    amountCents:
      row.Amount === null || row.Amount === undefined
        ? null
        : Math.round(row.Amount),
    riskCents:
      row.Risk === null || row.Risk === undefined ? null : Math.round(row.Risk),
    toWinCents:
      row.ToWin === null || row.ToWin === undefined
        ? null
        : Math.round(row.ToWin),
    // Deliberately not coerced: `null` (writer omitted) and `0` (writer asserted
    // zero) are different facts, and the GSLIVE writer emits both.
    amountRefundedCents:
      row.AmountRefunded === null || row.AmountRefunded === undefined
        ? null
        : Math.round(row.AmountRefunded),
    raw,
    payloadSha256: hashRawPayload(raw),
  };
}

export function normalizeGradingLegRow(
  input: unknown,
): NormalizedSettlementObservation | null {
  const parsed = gradingLegSchema.safeParse(input);
  if (!parsed.success) return null;
  const row = parsed.data;

  const login = row.CustomerID.trim();
  if (login === "") return null;
  const validTime =
    parseIsoTime("SettlementDateTime", row.SettlementDateTime) ??
    new Date(0).toISOString();
  const result =
    row.Result === null || row.Result === undefined
      ? null
      : row.Result.trim().toUpperCase();
  const raw = input as Record<string, unknown>;

  return {
    ticketId: fantasy402TicketId(login, row.WagerNumber),
    login,
    wagerNumber: row.WagerNumber,
    // The grading feed is settled by definition; the outcome is a separate fact.
    outcome: normalizeOutcome(result),
    lifecycle: "S",
    source: "unknown",
    validTime,
    sourceFeed: "getGrading",
    legNumber: row.LegNumber ?? null,
    result,
    amountCents:
      row.Amount === null || row.Amount === undefined
        ? null
        : Math.round(row.Amount),
    riskCents: null,
    toWinCents: null,
    amountRefundedCents: null,
    raw,
    payloadSha256: hashRawPayload(raw),
  };
}

export type SettlementPollBatch = {
  feed: SettlementFeed;
  polledAt: string;
  rows: Record<string, unknown>[];
};

export function normalizeSettlementBatch(
  batch: SettlementPollBatch,
): NormalizedSettlementObservation[] {
  const out: NormalizedSettlementObservation[] = [];
  for (const row of batch.rows) {
    const obs =
      batch.feed === "getGrading"
        ? normalizeGradingLegRow(row)
        : normalizeHistoryWagerRow(row, batch.feed);
    if (obs) out.push(obs);
  }
  return out;
}

export type SettlementInsert = {
  observation: NormalizedSettlementObservation;
  runId: AuditRunId;
  runAt: IsoDateTimeUtc;
};

/**
 * Append-only lifecycle observations. payload_json is RAW wire row (not normalized).
 */
export function createWagerSettlementStore(
  db: Database = openSportsdeskSqlite(":memory:"),
): WagerSettlementStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wager_settlement_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      valid_time TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      wager_status TEXT NOT NULL,
      outcome TEXT,
      lifecycle TEXT,
      source TEXT NOT NULL,
      source_feed TEXT NOT NULL,
      leg_number INTEGER,
      result TEXT,
      amount_cents INTEGER,
      risk_cents INTEGER,
      to_win_cents INTEGER,
      amount_refunded_cents INTEGER,
      payload_json TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wso_ticket ON wager_settlement_observations(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_wso_valid_time ON wager_settlement_observations(valid_time);
    CREATE INDEX IF NOT EXISTS idx_wso_run_at ON wager_settlement_observations(run_at);
  `);
  // Tables created before the outcome/lifecycle split lack these columns.
  for (const column of [
    "outcome TEXT",
    "lifecycle TEXT",
    "source TEXT",
    "risk_cents INTEGER",
    "to_win_cents INTEGER",
    "amount_refunded_cents INTEGER",
  ]) {
    const name = column.split(" ")[0]!;
    const exists = db
      .query(
        `SELECT COUNT(*) AS n FROM pragma_table_info('wager_settlement_observations') WHERE name = ?1`,
      )
      .get(name) as { n: number | bigint };
    if (sqlInt(exists.n) === 0) {
      db.exec(`ALTER TABLE wager_settlement_observations ADD COLUMN ${column}`);
    }
  }
  return new WagerSettlementStore(db);
}

export class WagerSettlementStore {
  constructor(private readonly db: Database) {}

  insertObservation(row: SettlementInsert): void {
    const { observation, runId, runAt } = row;
    const payloadJson = canonicalJsonString(observation.raw);
    // Legacy composite column kept for older readers/indexes; the two axes are
    // authoritative. Read `outcome` / `lifecycle` from here on.
    const legacyStatus =
      observation.lifecycle ?? observation.outcome ?? "unknown";
    this.db
      .query(
        `INSERT INTO wager_settlement_observations (
          run_id, run_at, valid_time, ticket_id, wager_status,
          outcome, lifecycle, source, source_feed,
          leg_number, result, amount_cents, risk_cents, to_win_cents,
          amount_refunded_cents, payload_json, payload_sha256
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
      )
      .run(
        runId,
        runAt,
        observation.validTime,
        observation.ticketId,
        legacyStatus,
        observation.outcome,
        observation.lifecycle,
        observation.source,
        observation.sourceFeed,
        observation.legNumber,
        observation.result,
        observation.amountCents,
        observation.riskCents,
        observation.toWinCents,
        observation.amountRefundedCents,
        payloadJson,
        observation.payloadSha256,
      );
  }

  ingestBatch(batch: SettlementPollBatch, runId: AuditRunId): number {
    const runAt = auditRunAt(batch.polledAt);
    let n = 0;
    for (const observation of normalizeSettlementBatch(batch)) {
      this.insertObservation({ observation, runId, runAt });
      n += 1;
    }
    return n;
  }

  countObservations(): number {
    const row = this.db
      .query(`SELECT COUNT(*) AS n FROM wager_settlement_observations`)
      .get() as { n: number | bigint };
    return sqlInt(row.n);
  }

  countByStatus(wagerStatus: string): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM wager_settlement_observations WHERE wager_status = ?1`,
      )
      .get(wagerStatus) as { n: number | bigint };
    return sqlInt(row.n);
  }

  countByLifecycle(lifecycle: WagerLifecycle): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM wager_settlement_observations WHERE lifecycle = ?1`,
      )
      .get(lifecycle) as { n: number | bigint };
    return sqlInt(row.n);
  }

  countByOutcome(outcome: WagerOutcome): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM wager_settlement_observations WHERE outcome = ?1`,
      )
      .get(outcome) as { n: number | bigint };
    return sqlInt(row.n);
  }

  findPayloadDrift(): SettlementPayloadDriftRow[] {
    return this.db
      .query(
        `SELECT ticket_id, valid_time, outcome, lifecycle, source_feed,
                COUNT(DISTINCT payload_sha256) AS distinct_payloads
         FROM wager_settlement_observations
         GROUP BY ticket_id, valid_time, outcome, lifecycle, source_feed
         HAVING COUNT(DISTINCT payload_sha256) > 1`,
      )
      .all() as SettlementPayloadDriftRow[];
  }

  findValidTimeFork(): SettlementValidTimeForkRow[] {
    return this.db
      .query(
        `SELECT ticket_id, lifecycle,
                COUNT(DISTINCT valid_time) AS distinct_valid_times
         FROM wager_settlement_observations
         WHERE lifecycle IN ('S', 'C')
         GROUP BY ticket_id, lifecycle
         HAVING COUNT(DISTINCT valid_time) > 1`,
      )
      .all() as SettlementValidTimeForkRow[];
  }

  runStoreInvariants(): SettlementInvariantReport {
    const payloadDrift = this.findPayloadDrift();
    const validTimeFork = this.findValidTimeFork();
    return {
      ok: payloadDrift.length === 0 && validTimeFork.length === 0,
      payloadDrift,
      validTimeFork,
    };
  }

  /** Win/loss denominator: settled tickets with a WIN/LOSS outcome. */
  summarizeOutcomeRates(): {
    settled: number;
    canceled: number;
    wins: number;
    losses: number;
  } {
    const settled = this.db
      .query(
        `SELECT COUNT(*) AS n FROM wager_settlement_observations
           WHERE lifecycle = 'S' OR outcome IS NOT NULL`,
      )
      .get() as { n: number | bigint };
    const canceled = this.countByLifecycle("C");
    const wins = this.db
      .query(
        `SELECT COUNT(*) AS n FROM wager_settlement_observations
           WHERE outcome = 'W' OR result = 'WIN'`,
      )
      .get() as { n: number | bigint };
    const losses = this.db
      .query(
        `SELECT COUNT(*) AS n FROM wager_settlement_observations
           WHERE outcome = 'L' OR result = 'LOSS'`,
      )
      .get() as { n: number | bigint };
    return {
      settled: sqlInt(settled.n),
      canceled,
      wins: sqlInt(wins.n),
      losses: sqlInt(losses.n),
    };
  }
}

export type SettlementPayloadDriftRow = {
  ticket_id: string;
  valid_time: string;
  outcome: string | null;
  lifecycle: string | null;
  source_feed: string;
  distinct_payloads: number;
};

export type SettlementValidTimeForkRow = {
  ticket_id: string;
  lifecycle: string;
  distinct_valid_times: number;
};

export type SettlementInvariantReport = {
  ok: boolean;
  payloadDrift: SettlementPayloadDriftRow[];
  validTimeFork: SettlementValidTimeForkRow[];
};

export function resolveHistoryPollUrl(baseUrl?: string): string {
  const base =
    baseUrl?.replace(/\/$/, "") ??
    Bun.env.SPORTSDESK_PORTAL_HTTP_BASE?.replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "SPORTSDESK_PORTAL_HTTP_BASE is required for live getHistory poll",
    );
  }
  return `${base}/cloud/api/Manager/getHistory`;
}

export async function pollManagerGetHistory(options?: {
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<{ polledAt: string; rows: Record<string, unknown>[] }> {
  const url = resolveHistoryPollUrl(options?.baseUrl);
  const res = await fetch(url, {
    method: "POST",
    proxy: false,
    signal: AbortSignal.timeout(options?.timeoutMs ?? 60_000),
  });
  if (!res.ok) {
    throw new Error(`getHistory poll failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as unknown;
  const polledAt = new Date().toISOString();
  if (Array.isArray(body)) {
    return { polledAt, rows: body as Record<string, unknown>[] };
  }
  if (
    body &&
    typeof body === "object" &&
    Array.isArray((body as { data?: unknown }).data)
  ) {
    return {
      polledAt,
      rows: (body as { data: Record<string, unknown>[] }).data,
    };
  }
  throw new Error("getHistory response is not an array or { data: [] }");
}
