import type { Cents } from "../design/domain-branded-types.ts";
import type { IsoTime, JsonText, Sha256Hex } from "./brand.ts";
import type { Millis } from "./units.ts";
import type { SqliteStorageKind } from "./sqlite_schema_registry.ts";

export type Nullable = "YES" | "NO";

export type ColumnValueType<
  K extends SqliteStorageKind,
  N extends Nullable,
> = K extends "integer_pk"
  ? number
  : K extends "integer"
    ? N extends "YES"
      ? number | null
      : number
    : K extends "real"
      ? N extends "YES"
        ? number | null
        : number
      : K extends "text_iso_time"
        ? N extends "YES"
          ? IsoTime | null
          : IsoTime
        : K extends "text_sha256"
          ? N extends "YES"
            ? Sha256Hex | null
            : Sha256Hex
          : K extends "text_json"
            ? N extends "YES"
              ? JsonText | null
              : JsonText
            : K extends "text_enum" | "text"
              ? N extends "YES"
                ? string | null
                : string
              : never;

export type StorageKindToValue<K extends SqliteStorageKind> = ColumnValueType<
  K,
  "NO"
>;

/** Per-column domain and phantom unit overrides across SSOT SQLite tables. */
export type ColumnUnitOverride<
  T extends string,
  C extends string,
> = T extends "match_evaluations"
  ? C extends "time_diff_ms"
    ? Millis
    : never
  : T extends "wager_settlement_observations"
    ? C extends "amount_cents"
      ? Cents
      : never
    : T extends "candidate_tickets"
      ? C extends "time_diff"
        ? Millis
        : never
      : T extends "ingestion_trades"
        ? C extends "price"
          ? Cents
          : C extends "latency_ms"
            ? Millis
            : never
        : never;
