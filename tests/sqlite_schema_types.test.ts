import type { Cents } from "../design/domain-branded-types.ts";
import type { Assert, Equal } from "../lib/assert.ts";
import type { IsoTime, JsonText, Sha256Hex } from "../lib/brand.ts";
import type { ParseKeyRole } from "../lib/key_role.ts";
import type {
  ColumnName,
  Insert,
  PkColumn,
  Row,
} from "../lib/sqlite_schema_derive.ts";
import type { AssertSsotClean } from "../lib/sqlite_schema_ssot.ts";
import type { ColumnValueType } from "../lib/sqlite_schema_types.ts";
import type { Millis } from "../lib/units.ts";

type _ssotClean = AssertSsotClean;

type _pk = Assert<Equal<PkColumn<"match_evaluations">, "id">>;

type _runAt = Assert<Equal<Row<"match_evaluations">["run_at"], IsoTime>>;

type _valid = Assert<
  Equal<Row<"match_evaluations">["valid_time"], IsoTime | null>
>;

type _timeDiffMs = Assert<
  Equal<Row<"match_evaluations">["time_diff_ms"], Millis>
>;

type _comboWireJson = Assert<
  Equal<Row<"combo_legs">["wire_json"], JsonText | null>
>;

type _comboInsertWireJson = Assert<
  Equal<Insert<"combo_legs">["wire_json"], JsonText | null | undefined>
>;

type _nullableSha256 = Assert<
  Equal<ColumnValueType<"text_sha256", "YES">, Sha256Hex | null>
>;

type _wsoAmountCents = Assert<
  Equal<Row<"wager_settlement_observations">["amount_cents"], Cents | null>
>;

type _candTimeDiff = Assert<
  Equal<Row<"candidate_tickets">["time_diff"], Millis>
>;

type _ingPrice = Assert<Equal<Row<"ingestion_trades">["price"], Cents>>;

type _ingLatency = Assert<
  Equal<Row<"ingestion_trades">["latency_ms"], Millis | null>
>;

type _noRunAt = Assert<
  Equal<ColumnName<"candidate_tickets"> & "run_at", never>
>;

type _idxName = Assert<
  Equal<
    ParseKeyRole<"IDX:idx_match_eval_run_at">,
    { readonly type: "index"; readonly name: "idx_match_eval_run_at" }
  >
>;
