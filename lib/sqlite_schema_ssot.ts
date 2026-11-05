/**
 * Compile-time SSOT column/index specs — invariants fail `tsc` when structure drifts.
 */

import { sqlDomain, sqlIndex, sqlTable } from "./brand.ts";
import type { Assert } from "./assert.ts";
import type { TableInvariants } from "./invariants.ts";

export const SSOT = {
  match_evaluations: {
    table: sqlTable("match_evaluations"),
    domain: sqlDomain("candidate overlay audit"),
    appendOnly: "yes" as const,
    columns: {
      id: { kind: "integer_pk", nullable: "NO" },
      run_id: { kind: "text", nullable: "NO" },
      run_at: { kind: "text_iso_time", nullable: "NO" },
      valid_time: { kind: "text_iso_time", nullable: "YES" },
      policy_sha256: { kind: "text_sha256", nullable: "NO" },
      ticker_sha256: { kind: "text_sha256", nullable: "NO" },
      pending_sha256: { kind: "text_sha256", nullable: "NO" },
      state: { kind: "text_enum", nullable: "NO" },
      reject_reason: { kind: "text", nullable: "YES" },
      review_flag: { kind: "text", nullable: "YES" },
      time_diff_ms: { kind: "real", nullable: "NO" },
      evaluation_json: { kind: "text_json", nullable: "NO" },
      evaluation_json_sha256: { kind: "text_sha256", nullable: "NO" },
      replay_input_json: { kind: "text_json", nullable: "NO" },
    },
    indexes: {
      idx_match_eval_run_at: {
        name: sqlIndex("idx_match_eval_run_at"),
        columns: ["run_at"],
      },
      idx_match_eval_valid_time: {
        name: sqlIndex("idx_match_eval_valid_time"),
        columns: ["valid_time"],
      },
      idx_match_eval_policy: {
        name: sqlIndex("idx_match_eval_policy"),
        columns: ["policy_sha256"],
      },
      idx_match_eval_pair_policy: {
        name: sqlIndex("idx_match_eval_pair_policy"),
        columns: ["ticker_sha256", "pending_sha256", "policy_sha256", "run_at"],
      },
    },
  },

  wager_settlement_observations: {
    table: sqlTable("wager_settlement_observations"),
    domain: sqlDomain("Manager/getHistory lifecycle"),
    appendOnly: "yes" as const,
    columns: {
      id: { kind: "integer_pk", nullable: "NO" },
      run_id: { kind: "text", nullable: "NO" },
      run_at: { kind: "text_iso_time", nullable: "NO" },
      valid_time: { kind: "text_iso_time", nullable: "NO" },
      ticket_id: { kind: "text", nullable: "NO" },
      wager_status: { kind: "text_enum", nullable: "NO" },
      source_feed: { kind: "text_enum", nullable: "NO" },
      leg_number: { kind: "integer", nullable: "YES" },
      result: { kind: "text", nullable: "YES" },
      amount_cents: { kind: "integer", nullable: "YES" },
      payload_json: { kind: "text_json", nullable: "NO" },
      payload_sha256: { kind: "text_sha256", nullable: "NO" },
    },
    indexes: {
      idx_wso_ticket: {
        name: sqlIndex("idx_wso_ticket"),
        columns: ["ticket_id"],
      },
      idx_wso_valid_time: {
        name: sqlIndex("idx_wso_valid_time"),
        columns: ["valid_time"],
      },
      idx_wso_run_at: {
        name: sqlIndex("idx_wso_run_at"),
        columns: ["run_at"],
      },
    },
  },

  combo_legs: {
    table: sqlTable("combo_legs"),
    domain: sqlDomain("cross-venue canonical combo index"),
    appendOnly: "yes" as const,
    columns: {
      id: { kind: "integer_pk", nullable: "NO" },
      run_id: { kind: "text", nullable: "NO" },
      run_at: { kind: "text_iso_time", nullable: "NO" },
      canonical_combo_id: { kind: "text", nullable: "NO" },
      venue: { kind: "text_enum", nullable: "NO" },
      venue_ref: { kind: "text", nullable: "NO" },
      valid_time: { kind: "text_iso_time", nullable: "NO" },
      leg_index: { kind: "integer", nullable: "NO" },
      leg_json: { kind: "text_json", nullable: "NO" },
      wire_json: { kind: "text_json", nullable: "YES" },
    },
    indexes: {
      idx_combo_legs_combo_venue: {
        name: sqlIndex("idx_combo_legs_combo_venue"),
        columns: ["canonical_combo_id", "venue", "valid_time"],
      },
      idx_combo_legs_valid_time: {
        name: sqlIndex("idx_combo_legs_valid_time"),
        columns: ["valid_time"],
      },
    },
  },

  candidate_tickets: {
    table: sqlTable("candidate_tickets"),
    domain: sqlDomain("GATEWAY candidate enrich unit store"),
    appendOnly: "yes" as const,
    pkPolicy: "optional" as const,
    columns: {
      match_key: { kind: "text", nullable: "NO" },
      candidate_status: { kind: "text_enum", nullable: "NO" },
      reject_reason: { kind: "text", nullable: "YES" },
      time_diff: { kind: "real", nullable: "NO" },
      policy_sha256: { kind: "text_sha256", nullable: "NO" },
      participant_1_code: { kind: "text", nullable: "YES" },
      participant_2_code: { kind: "text", nullable: "YES" },
      raw_json: { kind: "text_json", nullable: "NO" },
    },
    indexes: {},
  },

  ingestion_trades: {
    table: sqlTable("ingestion_trades"),
    domain: sqlDomain("Plane 3 bitemporal replay WAL"),
    appendOnly: "no" as const,
    columns: {
      rowid: { kind: "integer_pk", nullable: "NO" },
      id: { kind: "integer", nullable: "NO" },
      channel_id: { kind: "text", nullable: "NO" },
      channel_status: { kind: "text_enum", nullable: "NO" },
      valid_from: { kind: "integer", nullable: "NO" },
      valid_to: { kind: "integer", nullable: "YES" },
      tx_from: { kind: "integer", nullable: "NO" },
      tx_to: { kind: "integer", nullable: "YES" },
      price: { kind: "integer", nullable: "NO" },
      link_id: { kind: "text", nullable: "YES" },
      xml_hash: { kind: "text_sha256", nullable: "NO" },
      latency_ms: { kind: "integer", nullable: "YES" },
    },
    indexes: {
      one_open_tx_per_lane_id: {
        name: sqlIndex("one_open_tx_per_lane_id"),
        columns: ["channel_id", "id"],
        partial: "tx_to IS NULL",
      },
    },
  },
} as const;

export type SsotTableName = keyof typeof SSOT;

type SsotColumns<T extends SsotTableName> = (typeof SSOT)[T]["columns"];
type SsotIndexes<T extends SsotTableName> = (typeof SSOT)[T]["indexes"];
type SsotPkPolicy<T extends SsotTableName> = (typeof SSOT)[T] extends {
  readonly pkPolicy: "optional";
}
  ? "optional"
  : "required";

type SsotInvariant<T extends SsotTableName> = TableInvariants<
  SsotColumns<T>,
  SsotIndexes<T>,
  SsotPkPolicy<T>
>;

type InvariantFailed<T extends SsotTableName> = [SsotInvariant<T>] extends [
  never,
]
  ? never
  : SsotInvariant<T> extends { readonly __error: infer E extends string }
    ? { readonly table: T; readonly error: E }
    : never;

/** Compile error surface when SSOT structure is invalid. */
export type SsotInvariantFailures = {
  [T in SsotTableName]: InvariantFailed<T>;
}[SsotTableName];

type SsotIsClean = [SsotInvariantFailures] extends [never] ? true : false;

export type AssertSsotClean = Assert<SsotIsClean>;
