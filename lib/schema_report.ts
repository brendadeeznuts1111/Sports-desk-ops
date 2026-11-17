/**
 * Bun.inspect.table schema report — summary / columns / keys rows.
 */

import { isoTime, type IsoTime } from "./brand.ts";
import {
  asDatabaseURL,
  asFileURL,
  asManifestURL,
  defaultDocsBaseUrl,
  type DatabaseURL,
  type FileURL,
  type HttpsURLAt,
  type ManifestURL,
} from "./urls.ts";
import type {
  SchemaColumnRow,
  SchemaKeyRow,
  SchemaSummaryRow,
  SqliteTableDef,
} from "./sqlite_schema_registry.ts";
import {
  flattenSchemaColumns,
  flattenSchemaKeys,
  flattenSchemaSummary,
  getTableSchema,
  SPORTSDESK_SQLITE_TABLES,
} from "./sqlite_schema_registry.ts";
import { parseSsotTableName, type SsotTableName } from "./ssot_table_name.ts";
import { inspectColumns, inspectKeys, inspectSummary } from "./inspect.ts";

export type TableSummary = SchemaSummaryRow;
export type ColumnRow = SchemaColumnRow;
export type KeyRow = SchemaKeyRow;

export type SchemaReportProvenance = {
  databaseUrl: DatabaseURL;
  sourceUrl: FileURL;
  manifestUrl?: ManifestURL;
  docsBaseUrl?: HttpsURLAt<"sportsdesk.internal">;
  generatedAt: IsoTime;
};

export function schemaRegistrySourceUrl(): FileURL {
  return asFileURL(
    new URL("./sqlite_schema_registry.ts", import.meta.url) as URL & {
      protocol: "file:";
    },
  );
}

/** Parse URL strings; absolute/relative filesystem paths become `file:` URLs. */
export function schemaReportUrl(value: URL | string): URL {
  if (value instanceof URL) return value;
  try {
    return new URL(value);
  } catch {
    return Bun.pathToFileURL(value);
  }
}

export function defaultSchemaReportProvenance(overrides?: {
  databaseUrl?: URL | string;
  sourceUrl?: URL | string;
  manifestUrl?: URL | string | null;
  generatedAt?: string;
}): SchemaReportProvenance {
  const databaseUrl =
    overrides?.databaseUrl !== undefined
      ? asDatabaseURL(overrides.databaseUrl)
      : asDatabaseURL("sqlite:///:memory:");
  const sourceUrl =
    overrides?.sourceUrl !== undefined
      ? asFileURL(
          schemaReportUrl(overrides.sourceUrl) as URL & { protocol: "file:" },
        )
      : schemaRegistrySourceUrl();

  const base: SchemaReportProvenance = {
    databaseUrl,
    sourceUrl,
    docsBaseUrl: defaultDocsBaseUrl(),
    generatedAt: isoTime(overrides?.generatedAt ?? new Date().toISOString()),
  };

  if (overrides?.manifestUrl === null || overrides?.manifestUrl === undefined) {
    return base;
  }
  return {
    ...base,
    manifestUrl: asManifestURL(schemaReportUrl(overrides.manifestUrl)),
  };
}

/** file:// URL for a local SQLite path (pathname / searchParams without re-parsing). */
export function sqliteDatabaseFileUrl(dbPath: string): FileURL {
  return asFileURL(Bun.pathToFileURL(dbPath) as URL & { protocol: "file:" });
}

export class SqliteSchemaReport {
  readonly databaseUrl: DatabaseURL;
  readonly sourceUrl: FileURL;
  readonly manifestUrl?: ManifestURL;
  readonly docsBaseUrl: HttpsURLAt<"sportsdesk.internal">;
  readonly generatedAt: IsoTime;

  constructor(
    public summary: TableSummary[],
    public columns: ColumnRow[],
    public keys: KeyRow[],
    provenance: SchemaReportProvenance = defaultSchemaReportProvenance(),
  ) {
    this.databaseUrl = provenance.databaseUrl;
    this.sourceUrl = provenance.sourceUrl;
    this.docsBaseUrl = provenance.docsBaseUrl ?? defaultDocsBaseUrl();
    this.generatedAt = provenance.generatedAt;
    if (provenance.manifestUrl !== undefined) {
      this.manifestUrl = provenance.manifestUrl;
    }
  }

  toJSON(): {
    summary: Array<Omit<TableSummary, "docsUrl"> & { docsUrl: string }>;
    columns: ColumnRow[];
    keys: KeyRow[];
    provenance: {
      databaseUrl: string;
      sourceUrl: string;
      manifestUrl?: string;
      generatedAt: string;
    };
  } {
    return {
      summary: this.summary.map((t) => ({
        table: t.table,
        domain: t.domain,
        columns: t.columns,
        keys: t.keys,
        appendOnly: t.appendOnly,
        docsUrl: t.docsUrl.href,
      })),
      columns: this.columns,
      keys: this.keys,
      provenance: {
        databaseUrl: this.databaseUrl.href,
        sourceUrl: this.sourceUrl.href,
        ...(this.manifestUrl !== undefined
          ? { manifestUrl: this.manifestUrl.href }
          : {}),
        generatedAt: this.generatedAt,
      },
    };
  }

  [Bun.inspect.custom]() {
    const footer = [
      `database  ${this.databaseUrl.href}`,
      `source    ${this.sourceUrl.href}`,
      this.manifestUrl ? `manifest  ${this.manifestUrl.href}` : null,
      `generated ${this.generatedAt}`,
    ]
      .filter(Boolean)
      .join("\n");

    const keysBlock =
      this.keys.length > 0
        ? "\nkeys:\n" + inspectKeys(this.keys)
        : "\nkeys:\n(none)";

    return [
      inspectSummary(this.summary),
      "\ncolumns:\n" + inspectColumns(this.columns),
      keysBlock,
      "\n" + footer,
    ].join("\n");
  }
}

export function buildSqliteSchemaReport(
  tables?: readonly SqliteTableDef[],
  provenance?: SchemaReportProvenance,
): SqliteSchemaReport {
  const defs = tables ?? SPORTSDESK_SQLITE_TABLES;
  return new SqliteSchemaReport(
    flattenSchemaSummary(defs),
    flattenSchemaColumns(defs),
    flattenSchemaKeys(defs),
    provenance ?? defaultSchemaReportProvenance(),
  );
}

export function buildSqliteSchemaReportForTable(
  tableName: string,
  provenance?: SchemaReportProvenance,
): SqliteSchemaReport | null {
  const parsed = parseSsotTableName(tableName);
  if (!parsed) return null;
  return buildSqliteSchemaReportForSsotTable(parsed, provenance);
}

export function buildSqliteSchemaReportForSsotTable(
  tableName: SsotTableName,
  provenance?: SchemaReportProvenance,
): SqliteSchemaReport {
  const def = getTableSchema(tableName);
  if (!def) {
    throw new Error(`registry missing SSOT table: ${tableName}`);
  }
  return buildSqliteSchemaReport([def], provenance);
}

export function listRegisteredTableNames(): string[] {
  return SPORTSDESK_SQLITE_TABLES.map((t) => t.name);
}
