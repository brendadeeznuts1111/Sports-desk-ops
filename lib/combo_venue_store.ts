/**
 * Append-only combo observations per venue (internal vs polymarket).
 */

import type { Database } from "bun:sqlite";
import { openSportsdeskSqlite } from "./sportsdesk_sqlite.ts";
import { type AuditRunId, type IsoDateTimeUtc } from "./audit_run_id.ts";
import { isoTime, jsonText, type IsoTime, type Sha256Hex } from "./brand.ts";
import type { ComboLegSemantic } from "./canonical_combo_index.ts";
import { serializeComboLegs } from "./canonical_combo_index.ts";
import { canonicalJsonString } from "./match_evaluation_canonical.ts";
import type { Insert, Row } from "./sqlite_schema_derive.ts";
import {
  assertSqliteStoreMatchesRegistry,
  COMBO_LEGS_SCHEMA,
  renderCreateTableDdl,
} from "./sqlite_schema_registry.ts";
import { sha256HexOfBytes } from "../services/sportsdesk_ingestion_feed_provenance.ts";

export type ComboVenue = "internal" | "polymarket";
export type ComboLegsSsotRow = Row<"combo_legs">;
export type ComboLegsSsotInsert = Insert<"combo_legs">;

export type ComboVenueObservationInsert = {
  canonicalComboId: string;
  venue: ComboVenue;
  venueRef: string;
  validTime: IsoDateTimeUtc | string;
  legs: ComboLegSemantic[];
  runId: AuditRunId;
  runAt: IsoDateTimeUtc;
  wireJson?: Record<string, unknown>;
};

export function createComboVenueStore(
  db: Database = openSportsdeskSqlite(":memory:"),
): ComboVenueStore {
  db.exec(renderCreateTableDdl(COMBO_LEGS_SCHEMA));
  assertSqliteStoreMatchesRegistry(db, COMBO_LEGS_SCHEMA);
  return new ComboVenueStore(db);
}

export class ComboVenueStore {
  constructor(private readonly db: Database) {}

  insertObservation(row: ComboVenueObservationInsert): void {
    const validTime = isoTime(row.validTime);
    const wireJson = row.wireJson
      ? jsonText(canonicalJsonString(row.wireJson))
      : null;
    row.legs.forEach((leg, legIndex) => {
      const insertRow: ComboLegsSsotInsert = {
        run_id: row.runId,
        run_at: row.runAt,
        canonical_combo_id: row.canonicalComboId,
        venue: row.venue,
        venue_ref: row.venueRef,
        valid_time: validTime,
        leg_index: legIndex,
        leg_json: jsonText(serializeComboLegs([leg])),
        wire_json: wireJson,
      };
      this.db
        .query(
          `INSERT INTO combo_legs (
            run_id, run_at, canonical_combo_id, venue, venue_ref,
            valid_time, leg_index, leg_json, wire_json
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .run(
          insertRow.run_id,
          insertRow.run_at,
          insertRow.canonical_combo_id,
          insertRow.venue,
          insertRow.venue_ref,
          insertRow.valid_time,
          insertRow.leg_index,
          insertRow.leg_json,
          insertRow.wire_json ?? null,
        );
    });
  }

  /** MIN(valid_time) per (canonical_combo_id, venue) — first-seen for lead-lag. */
  listFirstSeenByVenue(): ComboFirstSeenRow[] {
    const rows = this.db
      .query(
        `SELECT canonical_combo_id, venue,
                MIN(valid_time) AS first_valid_time,
                MIN(venue_ref) AS venue_ref
         FROM combo_legs
         GROUP BY canonical_combo_id, venue`,
      )
      .all() as Array<{
      canonical_combo_id: string;
      venue: ComboVenue;
      first_valid_time: string;
      venue_ref: string;
    }>;
    return rows.map((r) => ({
      canonical_combo_id: r.canonical_combo_id,
      venue: r.venue,
      first_valid_time: isoTime(r.first_valid_time),
      venue_ref: r.venue_ref,
    }));
  }

  countLegRows(): number {
    const row = this.db.query(`SELECT COUNT(*) AS n FROM combo_legs`).get() as {
      n: number;
    };
    return row.n;
  }
}

export type ComboFirstSeenRow = {
  canonical_combo_id: string;
  venue: ComboVenue;
  first_valid_time: IsoTime;
  venue_ref: string;
};

export function hashComboWire(raw: Record<string, unknown>): Sha256Hex {
  return sha256HexOfBytes(new TextEncoder().encode(canonicalJsonString(raw)));
}
