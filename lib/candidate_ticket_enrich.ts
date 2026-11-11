/**
 * Overlay ↔ pending candidate ticket enrichment (GATEWAY / pending lane).
 */

import type { Database } from "bun:sqlite";
import { openSportsdeskSqlite } from "./sportsdesk_sqlite.ts";
import type { Sha256Hex } from "../design/domain-branded-types.ts";
import { jsonText } from "./brand.ts";
import type { Insert, Row } from "./sqlite_schema_derive.ts";
import {
  assertSqliteStoreMatchesRegistry,
  CANDIDATE_TICKETS_SCHEMA,
  renderCreateTableDdl,
} from "./sqlite_schema_registry.ts";
import { ms } from "./units.ts";
import { sha256HexOfBytes } from "../services/sportsdesk_ingestion_feed_provenance.ts";

export type MatchPolicyMode = "exact" | "candidate-review" | "reject";
export type CandidateTicketsSsotRow = Row<"candidate_tickets">;
export type CandidateTicketsSsotInsert = Insert<"candidate_tickets">;

export type MatchPolicy = {
  ms: number;
  mode: MatchPolicyMode;
};

export const DEFAULT_MATCH_POLICY: MatchPolicy = { ms: 10, mode: "exact" };

export type CandidateTicketRaw = Record<string, unknown> & {
  ShortName1?: string;
  ShortName2?: string;
};

export type CandidateOverlay = {
  matchKey: string;
  timeDiff: number;
};

export type CandidatePending = {
  matchKey: string;
  raw: CandidateTicketRaw;
};

export type CandidateRejectReason = "TIME_DIFF_EXCEEDED" | "MATCH_KEY_MISMATCH";

export type EnrichedCandidateRow = {
  matchKey: string;
  candidateStatus: "accepted" | "rejected";
  rejectReason?: CandidateRejectReason;
  /** Set when mode is candidate-review and |timeDiff| > ms — still accepted downstream. */
  reviewFlag?: CandidateRejectReason;
  timeDiff: number;
  policySha256: Sha256Hex;
  participant_1_code: string | null;
  participant_2_code: string | null;
  raw: CandidateTicketRaw;
};

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  });
}

export function hashPolicy(policy: MatchPolicy): Sha256Hex {
  const bytes = new TextEncoder().encode(stableStringify(policy));
  return sha256HexOfBytes(bytes);
}

function trimCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

export function enrich(
  overlay: CandidateOverlay,
  pending: CandidatePending,
  policy: MatchPolicy = DEFAULT_MATCH_POLICY,
): EnrichedCandidateRow {
  const policySha256 = hashPolicy(policy);
  const participant_1_code = trimCode(pending.raw.ShortName1);
  const participant_2_code = trimCode(pending.raw.ShortName2);

  const base: EnrichedCandidateRow = {
    matchKey: pending.matchKey,
    candidateStatus: "accepted",
    timeDiff: overlay.timeDiff,
    policySha256,
    participant_1_code,
    participant_2_code,
    raw: pending.raw,
  };

  if (overlay.matchKey !== pending.matchKey) {
    return {
      ...base,
      candidateStatus: "rejected",
      rejectReason: "MATCH_KEY_MISMATCH",
    };
  }

  const abs = Math.abs(overlay.timeDiff);
  const timeExceeded = abs > policy.ms;

  if (timeExceeded) {
    if (policy.mode === "candidate-review") {
      return {
        ...base,
        candidateStatus: "accepted",
        reviewFlag: "TIME_DIFF_EXCEEDED",
      };
    }
    if (policy.mode === "exact" || policy.mode === "reject") {
      return {
        ...base,
        candidateStatus: "rejected",
        rejectReason: "TIME_DIFF_EXCEEDED",
      };
    }
  }

  return base;
}

export function createCandidateTicketStore(
  db: Database = openSportsdeskSqlite(":memory:"),
): CandidateTicketStore {
  db.exec(renderCreateTableDdl(CANDIDATE_TICKETS_SCHEMA));
  assertSqliteStoreMatchesRegistry(db, CANDIDATE_TICKETS_SCHEMA);
  return new CandidateTicketStore(db);
}

export class CandidateTicketStore {
  constructor(private readonly db: Database) {}

  write(row: EnrichedCandidateRow): void {
    const insertRow: CandidateTicketsSsotInsert = {
      match_key: row.matchKey,
      candidate_status: row.candidateStatus,
      reject_reason: row.rejectReason ?? null,
      time_diff: ms(row.timeDiff),
      policy_sha256: row.policySha256,
      participant_1_code: row.participant_1_code,
      participant_2_code: row.participant_2_code,
      raw_json: jsonText(JSON.stringify(row.raw)),
    };
    this.db
      .query(
        `INSERT INTO candidate_tickets (
          match_key, candidate_status, reject_reason, time_diff,
          policy_sha256, participant_1_code, participant_2_code, raw_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .run(
        insertRow.match_key,
        insertRow.candidate_status,
        insertRow.reject_reason ?? null,
        insertRow.time_diff,
        insertRow.policy_sha256,
        insertRow.participant_1_code ?? null,
        insertRow.participant_2_code ?? null,
        insertRow.raw_json,
      );
  }

  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
  ): T[] {
    return this.db.query(sql).all() as T[];
  }
}
