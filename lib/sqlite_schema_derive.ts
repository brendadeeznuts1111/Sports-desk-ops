import type { SSOT, SsotTableName } from "./sqlite_schema_ssot.ts";
import type {
  ColumnUnitOverride,
  ColumnValueType,
  Nullable,
} from "./sqlite_schema_types.ts";
import type { SqliteStorageKind } from "./sqlite_schema_registry.ts";

export type TableName = SsotTableName;
export type TableDef<T extends TableName> = (typeof SSOT)[T];
export type ColumnsOf<T extends TableName> = TableDef<T>["columns"];
export type ColumnName<T extends TableName> = keyof ColumnsOf<T> & string;

type ColumnDef<
  T extends TableName,
  C extends ColumnName<T>,
> = ColumnsOf<T>[C] extends {
  kind: infer K extends SqliteStorageKind;
  nullable: infer N extends Nullable;
}
  ? { kind: K; nullable: N }
  : never;

type ApplyUnitOverride<Base, Override> = [Override] extends [never]
  ? Base
  : null extends Base
    ? Override | null
    : Override;

type ColValueOf<T extends TableName, C extends ColumnName<T>> =
  ColumnDef<T, C> extends {
    kind: infer K extends SqliteStorageKind;
    nullable: infer N extends Nullable;
  }
    ? ApplyUnitOverride<ColumnValueType<K, N>, ColumnUnitOverride<T, C>>
    : never;

export type Row<T extends TableName> = {
  readonly [C in ColumnName<T>]: ColValueOf<T, C>;
};

export type Insert<T extends TableName> = {
  readonly [
    C in ColumnName<T> as ColumnDef<T, C> extends { kind: "integer_pk" }
      ? never
      : C
  ]: ColumnDef<T, C> extends { nullable: "YES" }
    ? ColValueOf<T, C> | undefined
    : ColValueOf<T, C>;
} & { readonly id?: number; readonly rowid?: number };

export type Update<T extends TableName> = {
  readonly [C in ColumnName<T>]?: ColValueOf<T, C>;
};

export type PkColumn<T extends TableName> = {
  [C in ColumnName<T>]: ColumnDef<T, C> extends { kind: "integer_pk" }
    ? C
    : never;
}[ColumnName<T>];

export type PkValue<T extends TableName> = Row<T>[PkColumn<T>];

export type IndexColumnsOf<
  T extends TableName,
  I extends keyof TableDef<T>["indexes"],
> = TableDef<T>["indexes"][I] extends {
  columns: readonly (infer C extends string)[];
}
  ? C
  : never;
