/**
 * Candidate-evidence overlay evaluation — golden evaluation JSON (canonical bytes) + replayable match_evaluations.
 * For Bun.XML ingest drift pins see lib/bun_xml_golden_ast.ts (JSON5 AST fingerprints).
 *
 * Universe: pending-wager observations at poll time (Manager/getPending slice), not
 * full wager lifecycle. Policy replay proves matcher behavior on stored replay_input_json;
 * it does not imply completeness vs settled/canceled wagers — see fantasy402_wager_universe_scope.ts.
 */

import type { Database } from "bun:sqlite";
import { openSportsdeskSqlite } from "./sportsdesk_sqlite.ts";
import {
  enrich,
  hashPolicy,
  type CandidateRejectReason,
  type MatchPolicy,
  DEFAULT_MATCH_POLICY,
} from "./candidate_ticket_enrich.ts";
import { sha256HexOfBytes } from "../services/sportsdesk_ingestion_feed_provenance.ts";
import {
  canonicalJsonString,
  hashEvaluationResult,
  serializeMatchEvaluationResult,
} from "./match_evaluation_canonical.ts";
import type { Sha256Hex } from "./brand.ts";
import { isoTime, jsonText } from "./brand.ts";
import {
  auditRunAt,
  type AuditRunId,
  type IsoDateTimeUtc,
} from "./audit_run_id.ts";
import type { Insert, Row } from "./sqlite_schema_derive.ts";
import {
  assertSqliteStoreMatchesRegistry,
  MATCH_EVALUATIONS_SCHEMA,
  renderCreateTableDdl,
} from "./sqlite_schema_registry.ts";
import { ms } from "./units.ts";
import { percentile } from "./match_evaluation_percentile.ts";

export {
  canonicalJsonString,
  hashEvaluationResult,
  serializeMatchEvaluationResult,
} from "./match_evaluation_canonical.ts";

export const F402_DIRECTORY_EVIDENCE_NCAAF = "f402-directory-20261021-07";

export type MetadataFieldState =
  | { state: "absent" }
  | { state: "null" }
  | { state: "blank" }
  | { state: "value"; value: string };

export type TickerOverlayInput = {
  matchKey: string;
  timeDifferenceMs: number;
  payload: Record<string, unknown>;
};

export type PendingWagerInput = {
  matchKey: string;
  payload: Record<string, unknown>;
};

export type MatchEvaluationCandidate = {
  competitionFamily: string | null;
  directoryEvidenceId: string | null;
  nativeIdentityVerified: false;
  nativeEventId: null;
  shortDesc: MetadataFieldState;
  totalPointsOu: MetadataFieldState;
  participant_1_code: string | null;
};

export type RejectedCandidateRecord = {
  rejectReason: CandidateRejectReason;
  pendingSha256: Sha256Hex;
  tickerSha256: Sha256Hex;
  timeDifferenceMs: number;
};

export type MatchEvaluationResult = {
  policySha256: Sha256Hex;
  tickerSha256: Sha256Hex;
  pendingSha256: Sha256Hex;
  timeDifferenceMs: number;
  maxTimeDifferenceMs: number;
  candidateRows: number;
  unresolvedRows: number;
  rejectedCandidates: RejectedCandidateRecord[];
  reviewFlag?: CandidateRejectReason;
  candidate?: MatchEvaluationCandidate;
};

/**
 * Persisted verbatim in replay_input_json — RAW source capture (padded fields intact).
 * Not post-normalization; policy replay can exercise threshold and normalization changes.
 * `validTime` is market valid time (ISO-8601); required for `--since-axis valid_time`.
 */
export type MatchEvaluationReplayInput = {
  ticker: TickerOverlayInput;
  pending: PendingWagerInput;
  validTime?: string;
};

export type MatchEvaluationSinceAxis = "run_at" | "valid_time";

export class ValidTimeReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidTimeReplayError";
  }
}

export function hashCanonicalPayload(
  payload: Record<string, unknown>,
): Sha256Hex {
  return sha256HexOfBytes(
    new TextEncoder().encode(canonicalJsonString(payload)),
  );
}

export function serializeReplayInput(
  input: MatchEvaluationReplayInput,
): string {
  return canonicalJsonString(input);
}

/** Trim padded portal strings before directory / equality checks. */
export function normalizePaddedField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

export function metadataFieldState(
  raw: Record<string, unknown>,
  key: string,
): MetadataFieldState {
  if (!Object.prototype.hasOwnProperty.call(raw, key)) {
    return { state: "absent" };
  }
  const v = raw[key];
  if (v === null) return { state: "null" };
  if (typeof v === "string" && v.trim() === "") return { state: "blank" };
  if (typeof v === "string") return { state: "value", value: v };
  return { state: "null" };
}

export const F402_DIRECTORY_EVIDENCE_NFL = "f402-directory-20261021-nfl";
export const F402_DIRECTORY_EVIDENCE_NBA = "f402-directory-20261021-nba";
export const F402_DIRECTORY_EVIDENCE_NCAAB = "f402-directory-20261021-ncaab";
export const F402_DIRECTORY_EVIDENCE_WNBA = "f402-directory-20261021-wnba";
export const F402_DIRECTORY_EVIDENCE_NHL = "f402-directory-20261021-nhl";
export const F402_DIRECTORY_EVIDENCE_MLB = "f402-directory-20261021-mlb";
export const F402_DIRECTORY_EVIDENCE_ATP = "f402-directory-20261021-atp";
export const F402_DIRECTORY_EVIDENCE_WTA = "f402-directory-20261021-wta";
export const F402_DIRECTORY_EVIDENCE_UFC = "f402-directory-20261021-ufc";
export const F402_DIRECTORY_EVIDENCE_SOCCER = "f402-directory-20261021-soccer";

const NCAAF_SUBSPORTS = new Set([
  "college",
  "coll ext",
  "collalt",
  "ncaaf",
  "ncaaf future",
  "ncaaf futures",
  "ncaa sea win",
  "ncaa sea wins",
]);

const NFL_SUBSPORTS = new Set([
  "nfl",
  "nflplayoffs",
  "nfl playoffs",
  "nfl seas win",
  "nfl seas wins",
  "nflplrprop1",
  "nflgameprop",
  "nfl futures",
  "nfl props",
]);

const NBA_SUBSPORTS = new Set([
  "nba",
  "nba sea wins",
  "nbaplayerpro",
  "nbaplayerprops",
  "nba futures",
  "nba props",
]);

const NCAAB_SUBSPORTS = new Set([
  "ncaa",
  "ncaa extra",
  "ncaab",
  "wncaa",
  "wncaa live",
]);

const NHL_SUBSPORTS = new Set([
  "nhl",
  "nhl futures",
  "nhl props",
  "nhl seas win",
]);

const MLB_SUBSPORTS = new Set([
  "mlb",
  "mlb futures",
  "mlb series",
  "mlb props",
]);

const ATP_SUBSPORTS = new Set([
  "atp",
  "atp matchu",
  "atp matchups",
  "atp futures",
  "atp doubles",
]);

const WTA_SUBSPORTS = new Set([
  "wta",
  "wta matchu",
  "wta matchups",
  "wta futures",
  "wta doubles",
]);

const UFC_SUBSPORTS = new Set([
  "mma - ufc",
  "ufc",
  "mma",
  "mma live",
  "bellator",
  "pfl",
]);

export function competitionFamilyFromDirectory(
  sportType: string | null,
  sportSubType: string | null,
): { competitionFamily: string | null; directoryEvidenceId: string | null } {
  const st = sportType?.trim().toLowerCase() ?? "";
  const sst = sportSubType?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";

  if (st === "football" || st === "") {
    if (NCAAF_SUBSPORTS.has(sst)) {
      return {
        competitionFamily: "NCAAF",
        directoryEvidenceId: F402_DIRECTORY_EVIDENCE_NCAAF,
      };
    }
    if (NFL_SUBSPORTS.has(sst)) {
      return {
        competitionFamily: "NFL",
        directoryEvidenceId: F402_DIRECTORY_EVIDENCE_NFL,
      };
    }
  }

  if (st === "basketball" || st === "") {
    if (NBA_SUBSPORTS.has(sst)) {
      return {
        competitionFamily: "NBA",
        directoryEvidenceId: F402_DIRECTORY_EVIDENCE_NBA,
      };
    }
    if (sst === "wnba") {
      return {
        competitionFamily: "WNBA",
        directoryEvidenceId: F402_DIRECTORY_EVIDENCE_WNBA,
      };
    }
    if (st === "basketball" && NCAAB_SUBSPORTS.has(sst)) {
      return {
        competitionFamily: "NCAAB",
        directoryEvidenceId: F402_DIRECTORY_EVIDENCE_NCAAB,
      };
    }
  }

  if (st === "hockey" || st === "") {
    if (NHL_SUBSPORTS.has(sst)) {
      return {
        competitionFamily: "NHL",
        directoryEvidenceId: F402_DIRECTORY_EVIDENCE_NHL,
      };
    }
    if (st === "hockey" && (sst === "ncaa" || sst === "ncaa extra")) {
      return {
        competitionFamily: "NCAAH",
        directoryEvidenceId: "f402-directory-20261021-ncaah",
      };
    }
  }

  if (st === "baseball" || st === "") {
    if (MLB_SUBSPORTS.has(sst)) {
      return {
        competitionFamily: "MLB",
        directoryEvidenceId: F402_DIRECTORY_EVIDENCE_MLB,
      };
    }
  }

  if (st === "tennis" || st === "") {
    if (ATP_SUBSPORTS.has(sst)) {
      return {
        competitionFamily: "ATP",
        directoryEvidenceId: F402_DIRECTORY_EVIDENCE_ATP,
      };
    }
    if (WTA_SUBSPORTS.has(sst)) {
      return {
        competitionFamily: "WTA",
        directoryEvidenceId: F402_DIRECTORY_EVIDENCE_WTA,
      };
    }
  }

  if (st === "martial arts" || st === "") {
    if (UFC_SUBSPORTS.has(sst)) {
      return {
        competitionFamily: "UFC",
        directoryEvidenceId: F402_DIRECTORY_EVIDENCE_UFC,
      };
    }
  }

  if (st === "soccer" && sst.length > 0) {
    return {
      competitionFamily: "SOCCER",
      directoryEvidenceId: F402_DIRECTORY_EVIDENCE_SOCCER,
    };
  }

  return { competitionFamily: null, directoryEvidenceId: null };
}

export function evaluateCandidateOverlay(
  ticker: TickerOverlayInput,
  pending: PendingWagerInput,
  policy: MatchPolicy = DEFAULT_MATCH_POLICY,
): MatchEvaluationResult {
  const policySha256 = hashPolicy(policy);
  const tickerSha256 = hashCanonicalPayload(ticker.payload);
  const pendingSha256 = hashCanonicalPayload(pending.payload);

  const row = enrich(
    { matchKey: ticker.matchKey, timeDiff: ticker.timeDifferenceMs },
    { matchKey: pending.matchKey, raw: pending.payload },
    policy,
  );

  const base: MatchEvaluationResult = {
    policySha256,
    tickerSha256,
    pendingSha256,
    timeDifferenceMs: ticker.timeDifferenceMs,
    maxTimeDifferenceMs: policy.ms,
    candidateRows: 0,
    unresolvedRows: 0,
    rejectedCandidates: [],
  };

  if (row.candidateStatus === "rejected" && row.rejectReason) {
    return {
      ...base,
      unresolvedRows: 1,
      rejectedCandidates: [
        {
          rejectReason: row.rejectReason,
          pendingSha256,
          tickerSha256,
          timeDifferenceMs: ticker.timeDifferenceMs,
        },
      ],
    };
  }

  const reviewFlag = row.reviewFlag;

  const sportType = normalizePaddedField(pending.payload.SportType);
  const sportSubType = normalizePaddedField(pending.payload.SportSubType);
  const { competitionFamily, directoryEvidenceId } =
    competitionFamilyFromDirectory(sportType, sportSubType);

  const participantRaw = pending.payload.ShortName1;
  const participant_1_code =
    typeof participantRaw === "string" ? participantRaw.trim() : null;

  return {
    ...base,
    candidateRows: 1,
    ...(reviewFlag ? { reviewFlag } : {}),
    candidate: {
      competitionFamily,
      directoryEvidenceId,
      nativeIdentityVerified: false,
      nativeEventId: null,
      shortDesc: metadataFieldState(pending.payload, "ShortDesc"),
      totalPointsOu: metadataFieldState(pending.payload, "TotalPointsOU"),
      participant_1_code,
    },
  };
}

export type MatchEvaluationRowState = "candidate" | "unresolved";

export function evaluationStateFromResult(
  result: MatchEvaluationResult,
): MatchEvaluationRowState {
  return result.candidateRows === 1 ? "candidate" : "unresolved";
}

export type MatchEvaluationInsert = {
  result: MatchEvaluationResult;
  replayInput: MatchEvaluationReplayInput;
  runId: AuditRunId;
  runAt?: IsoDateTimeUtc;
};

/**
 * Append-only audit log — never upsert; replay uses MAX(run_at) per (pair, policy).
 *
 * review_flag contract: auto-accept ONLY rows with state='candidate' AND review_flag IS NULL.
 * Rows with review_flag IS NOT NULL are review-queue; do not promote without an explicit
 * human decision (record promoted_at on a downstream promotions table when added).
 *
 * replay_input_json: RAW ticker/pending payloads as captured at ingest (see MatchEvaluationReplayInput).
 */
export type MatchEvaluationsSsotRow = Row<"match_evaluations">;
export type MatchEvaluationsSsotInsert = Insert<"match_evaluations">;

export function createMatchEvaluationStore(
  db: Database = openSportsdeskSqlite(":memory:"),
): MatchEvaluationStore {
  db.exec(renderCreateTableDdl(MATCH_EVALUATIONS_SCHEMA));
  assertSqliteStoreMatchesRegistry(db, MATCH_EVALUATIONS_SCHEMA);
  return new MatchEvaluationStore(db);
}

export class MatchEvaluationStore {
  constructor(private readonly db: Database) {}

  insertEvaluation(row: MatchEvaluationInsert): void {
    const { result, replayInput, runId, runAt } = row;
    const evaluationJson = jsonText(serializeMatchEvaluationResult(result));
    const evaluationJsonSha256 = hashEvaluationResult(result);
    const state = evaluationStateFromResult(result);
    const rejectReason = result.rejectedCandidates[0]?.rejectReason ?? null;
    const insertRow: MatchEvaluationsSsotInsert = {
      run_id: runId,
      run_at: runAt ?? auditRunAt(),
      valid_time:
        replayInput.validTime !== undefined
          ? isoTime(replayInput.validTime)
          : null,
      policy_sha256: result.policySha256,
      ticker_sha256: result.tickerSha256,
      pending_sha256: result.pendingSha256,
      state,
      reject_reason: rejectReason,
      review_flag: result.reviewFlag ?? null,
      time_diff_ms: ms(result.timeDifferenceMs),
      evaluation_json: evaluationJson,
      evaluation_json_sha256: evaluationJsonSha256,
      replay_input_json: jsonText(serializeReplayInput(replayInput)),
    };
    this.db
      .query(
        `INSERT INTO match_evaluations (
          run_id, run_at, valid_time, policy_sha256, ticker_sha256, pending_sha256,
          state, reject_reason, review_flag, time_diff_ms,
          evaluation_json, evaluation_json_sha256, replay_input_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .run(
        insertRow.run_id,
        insertRow.run_at,
        insertRow.valid_time ?? null,
        insertRow.policy_sha256,
        insertRow.ticker_sha256,
        insertRow.pending_sha256,
        insertRow.state,
        insertRow.reject_reason ?? null,
        insertRow.review_flag ?? null,
        insertRow.time_diff_ms,
        insertRow.evaluation_json,
        insertRow.evaluation_json_sha256,
        insertRow.replay_input_json,
      );
  }

  countByPolicy(policySha256: string): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM match_evaluations WHERE policy_sha256 = ?1`,
      )
      .get(policySha256) as { n: number };
    return row.n;
  }

  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
  ): T[] {
    return this.db.query(sql).all() as T[];
  }

  countRowsMissingValidTime(policySha256: string): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM match_evaluations
         WHERE policy_sha256 = ?1 AND (valid_time IS NULL OR valid_time = '')`,
      )
      .get(policySha256) as { n: number };
    return row.n;
  }

  /** Non-empty rows mean same inputs+policy produced different canonical outputs (serializer drift). */
  findSerializerDrift(): SerializerDriftRow[] {
    return this.db
      .query(
        `SELECT ticker_sha256, pending_sha256, policy_sha256,
                COUNT(DISTINCT evaluation_json_sha256) AS distinct_outputs
         FROM match_evaluations
         GROUP BY ticker_sha256, pending_sha256, policy_sha256
         HAVING COUNT(DISTINCT evaluation_json_sha256) > 1`,
      )
      .all() as SerializerDriftRow[];
  }

  /** Same (ticker, pending) business key must not fork across distinct valid_time values. */
  findValidTimeFork(): ValidTimeForkRow[] {
    return this.db
      .query(
        `SELECT ticker_sha256, pending_sha256,
                COUNT(DISTINCT valid_time) AS distinct_valid_times
         FROM match_evaluations
         WHERE valid_time IS NOT NULL AND valid_time != ''
         GROUP BY ticker_sha256, pending_sha256
         HAVING COUNT(DISTINCT valid_time) > 1`,
      )
      .all() as ValidTimeForkRow[];
  }

  runStoreInvariants(): MatchEvaluationStoreInvariantReport {
    const serializerDrift = this.findSerializerDrift();
    const validTimeFork = this.findValidTimeFork();
    return {
      ok: serializerDrift.length === 0 && validTimeFork.length === 0,
      serializerDrift,
      validTimeFork,
    };
  }

  /**
   * Latest append-only row per (ticker, pending, policy).
   * `--since` / `--until` apply to run_at (evaluation tx time) or valid_time (market event time).
   */
  listLatestEvaluationsByPolicy(
    policySha256: string,
    opts?: {
      since?: string;
      until?: string;
      sinceAxis?: MatchEvaluationSinceAxis;
    },
  ): MatchEvaluationReplayRow[] {
    const axis = opts?.sinceAxis ?? "run_at";
    if (axis === "valid_time") {
      const missing = this.countRowsMissingValidTime(policySha256);
      if (missing > 0) {
        throw new ValidTimeReplayError(
          `valid_time axis requires validTime on every replay_input_json row for policy ${policySha256}; ${missing} row(s) missing valid_time (will not fall back to run_at)`,
        );
      }
    }

    const timeColumn = axis === "valid_time" ? "valid_time" : "run_at";
    let sql = `
      SELECT m.*
      FROM match_evaluations m
      INNER JOIN (
        SELECT ticker_sha256, pending_sha256, MAX(run_at) AS max_run_at
        FROM match_evaluations
        WHERE policy_sha256 = ?1
    `;
    const since = opts?.since;
    const until = opts?.until;
    if (since) {
      sql += ` AND ${timeColumn} >= ?2`;
    }
    if (until) {
      sql += ` AND ${timeColumn} <= ?${since ? 3 : 2}`;
    }
    sql += `
        GROUP BY ticker_sha256, pending_sha256
      ) latest
        ON m.ticker_sha256 = latest.ticker_sha256
       AND m.pending_sha256 = latest.pending_sha256
       AND m.run_at = latest.max_run_at
       AND m.policy_sha256 = ?1
    `;
    if (since && until) {
      return this.db
        .query(sql)
        .all(policySha256, since, until) as MatchEvaluationReplayRow[];
    }
    if (since) {
      return this.db
        .query(sql)
        .all(policySha256, since) as MatchEvaluationReplayRow[];
    }
    if (until) {
      return this.db
        .query(sql)
        .all(policySha256, until) as MatchEvaluationReplayRow[];
    }
    return this.db.query(sql).all(policySha256) as MatchEvaluationReplayRow[];
  }
}

export type SerializerDriftRow = {
  ticker_sha256: string;
  pending_sha256: string;
  policy_sha256: string;
  distinct_outputs: number;
};

export type ValidTimeForkRow = {
  ticker_sha256: string;
  pending_sha256: string;
  distinct_valid_times: number;
};

export type MatchEvaluationStoreInvariantReport = {
  ok: boolean;
  serializerDrift: SerializerDriftRow[];
  validTimeFork: ValidTimeForkRow[];
};

/** CI: store invariant failure (serializer drift or valid_time fork). Not policy flips. */
export const CANDIDATE_EXIT_STORE_INVARIANT = 5;

export function formatReplayBatchWindow(opts?: {
  since?: string;
  until?: string;
  sinceAxis?: MatchEvaluationSinceAxis;
}): string {
  const axis = opts?.sinceAxis ?? "run_at";
  const lo = opts?.since ?? "…";
  const hi = opts?.until ?? "…";
  return `${axis}:${lo}..${hi}`;
}

export type PolicyReplayLatencyStats = {
  batchWindow: string;
  sinceAxis: MatchEvaluationSinceAxis;
  sampleCount: number;
  absP90Ms: number;
  absP99Ms: number;
  absMaxMs: number;
  signedP50Ms: number;
  signedP90Ms: number;
  driftP90: boolean;
  driftMaxTail: boolean;
  driftAny: boolean;
};

export function describeSignedTimeDiffMs(ms: number): string {
  if (ms > 0) return `${ms}ms (ticker late)`;
  if (ms < 0) return `${ms}ms (pending late)`;
  return "0ms";
}

export function formatPolicyDriftWarnings(
  latency: PolicyReplayLatencyStats,
  policyMaxMs: number,
): string[] {
  const lines: string[] = [];
  const scope = `(batch: ${latency.batchWindow}, N=${latency.sampleCount}, p99=${latency.absP99Ms}ms, max=${latency.absMaxMs}ms)`;
  if (latency.driftP90) {
    lines.push(
      `[POLICY_DRIFT] p90=${latency.absP90Ms}ms > max=${policyMaxMs}ms ${scope}`,
    );
  }
  if (latency.driftMaxTail) {
    lines.push(
      `[POLICY_DRIFT] max-tail=${latency.absMaxMs}ms > ${policyMaxMs * 5}ms (5× max) ${scope}`,
    );
  }
  if (latency.driftAny) {
    lines.push(
      `[POLICY_DRIFT] signed p50: ${describeSignedTimeDiffMs(latency.signedP50Ms)}, signed p90: ${describeSignedTimeDiffMs(latency.signedP90Ms)}`,
    );
  }
  return lines;
}

export type MatchEvaluationReplayRow = {
  run_id: string;
  run_at: string;
  valid_time: string | null;
  policy_sha256: string;
  ticker_sha256: string;
  pending_sha256: string;
  state: MatchEvaluationRowState;
  reject_reason: string | null;
  review_flag: string | null;
  time_diff_ms: number;
  evaluation_json: string;
  evaluation_json_sha256: string;
  replay_input_json: string;
};

export type PolicyReplayDelta = {
  baselinePolicySha256: string;
  newPolicySha256: string;
  sinceAxis: MatchEvaluationSinceAxis;
  newlyAccepted: number;
  newlyRejected: number;
  unchanged: number;
  latency: PolicyReplayLatencyStats;
  flipped: Array<{
    tickerSha256: string;
    pendingSha256: string;
    baselineState: MatchEvaluationRowState;
    newState: MatchEvaluationRowState;
  }>;
};

export function replayPolicyDelta(
  store: MatchEvaluationStore,
  baselinePolicySha256: string,
  newPolicy: MatchPolicy,
  opts?: {
    since?: string;
    until?: string;
    sinceAxis?: MatchEvaluationSinceAxis;
  },
): PolicyReplayDelta {
  const sinceAxis = opts?.sinceAxis ?? "run_at";
  const windowOpts = {
    sinceAxis,
    ...(opts?.since !== undefined ? { since: opts.since } : {}),
    ...(opts?.until !== undefined ? { until: opts.until } : {}),
  };
  const rows = store.listLatestEvaluationsByPolicy(
    baselinePolicySha256,
    windowOpts,
  );
  const newPolicySha256 = hashPolicy(newPolicy);
  let newlyAccepted = 0;
  let newlyRejected = 0;
  let unchanged = 0;
  const flipped: PolicyReplayDelta["flipped"] = [];
  const timeDiffAbsMs: number[] = [];
  const timeDiffSignedMs: number[] = [];

  for (const row of rows) {
    const input = JSON.parse(
      row.replay_input_json,
    ) as MatchEvaluationReplayInput;
    const next = evaluateCandidateOverlay(
      input.ticker,
      input.pending,
      newPolicy,
    );
    timeDiffSignedMs.push(next.timeDifferenceMs);
    timeDiffAbsMs.push(Math.abs(next.timeDifferenceMs));
    const baselineState = row.state;
    const newState = evaluationStateFromResult(next);
    if (baselineState === newState) {
      unchanged += 1;
      continue;
    }
    if (baselineState === "unresolved" && newState === "candidate") {
      newlyAccepted += 1;
    } else if (baselineState === "candidate" && newState === "unresolved") {
      newlyRejected += 1;
    }
    flipped.push({
      tickerSha256: row.ticker_sha256,
      pendingSha256: row.pending_sha256,
      baselineState,
      newState,
    });
  }

  const absP90Ms = percentile(timeDiffAbsMs, 90);
  const absP99Ms = percentile(timeDiffAbsMs, 99);
  const absMaxMs = timeDiffAbsMs.length > 0 ? Math.max(...timeDiffAbsMs) : 0;
  const signedP50Ms = percentile(timeDiffSignedMs, 50);
  const signedP90Ms = percentile(timeDiffSignedMs, 90);
  const driftP90 = absP90Ms > newPolicy.ms;
  const driftMaxTail = absMaxMs > newPolicy.ms * 5;
  const latency: PolicyReplayLatencyStats = {
    batchWindow: formatReplayBatchWindow(windowOpts),
    sinceAxis,
    sampleCount: rows.length,
    absP90Ms,
    absP99Ms,
    absMaxMs,
    signedP50Ms,
    signedP90Ms,
    driftP90,
    driftMaxTail,
    driftAny: driftP90 || driftMaxTail,
  };

  return {
    baselinePolicySha256,
    newPolicySha256,
    sinceAxis,
    newlyAccepted,
    newlyRejected,
    unchanged,
    latency,
    flipped,
  };
}

/** Auto-accept query contract — use for downstream promotion, not bare state='candidate'. */
export const MATCH_EVALUATIONS_AUTO_ACCEPT_WHERE =
  "(state = 'candidate' AND review_flag IS NULL)";

export const MATCH_EVALUATIONS_REVIEW_QUEUE_WHERE = "(review_flag IS NOT NULL)";
