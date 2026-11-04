/**
 * Compare decoded manifest to a versioned prod schema dump (PRAGMA xinfo shape).
 *
 * Parity asserts manifest ↔ committed dump. It does not assert dump ↔ live prod.
 * The latter requires schema:parity-live against a current DB and is not a CI gate.
 */

import type { DecodedManifestTable } from "./schema_binary.ts";
import {
  affinityMismatchMessage,
  manifestKindAffinityCompatible,
} from "./schema_sqlite_affinity.ts";
import type {
  ProdSchemaDump,
  ProdSchemaDumpColumn,
} from "./schema_prod_dump.ts";
import {
  SQLITE_INTERNAL_TABLES,
  allowlistRotWarnings,
  captureProdSchemaFromDb,
  parseProdSchemaDump,
  prodDumpAllowlistedTableNames,
  staleAllowlistWarnings,
} from "./schema_prod_dump.ts";

export { captureProdSchemaFromDb };

/** Structural manifest ↔ dump drift (columns, types, prod-only tables). */
export const SCHEMA_DUMP_PARITY_STRUCTURAL_EXIT = 2;
/** Policy drift (expired allowlist under strict mode). */
export const SCHEMA_DUMP_PARITY_POLICY_EXIT = 3;

/** @deprecated use ManifestDumpParityFailedError */
export const SCHEMA_DUMP_PARITY_STALE_ALLOWLIST_EXIT =
  SCHEMA_DUMP_PARITY_POLICY_EXIT;

export type ParityDiagnosticSeverity = 0 | 2 | 3;

export type ParityDiagnostic = {
  severity: ParityDiagnosticSeverity;
  message: string;
};

export class ManifestDumpParityFailedError extends Error {
  readonly exitCode: number;
  readonly diagnostics: readonly ParityDiagnostic[];

  constructor(diagnostics: readonly ParityDiagnostic[], exitCode: number) {
    super(
      [...diagnostics]
        .sort(
          (a, b) =>
            b.severity - a.severity || a.message.localeCompare(b.message),
        )
        .map((d) => d.message)
        .join("\n"),
    );
    this.name = "ManifestDumpParityFailedError";
    this.diagnostics = diagnostics;
    this.exitCode = exitCode;
  }
}

/** @deprecated use ManifestDumpParityFailedError */
export class SchemaDumpStaleAllowlistError extends ManifestDumpParityFailedError {
  constructor(message: string) {
    super([{ severity: 3, message }], SCHEMA_DUMP_PARITY_POLICY_EXIT);
    this.name = "SchemaDumpStaleAllowlistError";
  }
}

export type ManifestDumpParityOptions = {
  strictProdOnlyTables?: boolean;
  strictStaleAllowlist?: boolean;
  allowlistBypass?: boolean;
};

const defaultOptions: Required<ManifestDumpParityOptions> = {
  strictProdOnlyTables: true,
  strictStaleAllowlist: true,
  allowlistBypass: false,
};

function shouldCompareNullability(
  kind: DecodedManifestTable["columns"][number]["kind"],
  row: ProdSchemaDumpColumn,
): boolean {
  if (kind === "integer_pk" && row.notnull === 0) {
    return false;
  }
  return true;
}

function nullabilityDriftMessage(
  table: string,
  column: string,
  manifestNullable: boolean,
  row: ProdSchemaDumpColumn,
): string | null {
  const dbNullable = row.notnull === 0;
  if (manifestNullable === dbNullable) return null;
  if (!manifestNullable && dbNullable) {
    return `nullability drift ${table}.${column}: manifest NOT NULL, dump nullable (notnull=0)`;
  }
  return `nullability drift ${table}.${column}: manifest nullable, dump NOT NULL (notnull=1)`;
}

export function logAllowlistBypassIfEnabled(
  opts: ManifestDumpParityOptions,
): void {
  if (!opts.allowlistBypass) return;
  console.error(
    "[BYPASS] prod-only table detection disabled (SPORTSDESK_SCHEMA_DUMP_ALLOWLIST_BYPASS=1)",
  );
}

export function assertAllowlistBypassNotInCi(
  opts: ManifestDumpParityOptions,
): void {
  if (Bun.env.CI !== "true") return;
  if (!opts.allowlistBypass) return;
  throw new Error(
    "SPORTSDESK_SCHEMA_DUMP_ALLOWLIST_BYPASS=1 is forbidden in CI",
  );
}

export function collectManifestDumpParityDiagnostics(
  dump: ProdSchemaDump,
  manifest: readonly DecodedManifestTable[],
  options: ManifestDumpParityOptions = {},
): ParityDiagnostic[] {
  const opts = { ...defaultOptions, ...options };
  const parsed = parseProdSchemaDump(dump);
  const diagnostics: ParityDiagnostic[] = [];

  const manifestTableNames = new Set(manifest.map((t) => t.table));

  for (const line of allowlistRotWarnings(parsed, manifestTableNames)) {
    diagnostics.push({ severity: 0, message: line });
  }

  for (const line of staleAllowlistWarnings(parsed)) {
    diagnostics.push({
      severity: opts.strictStaleAllowlist ? 3 : 0,
      message: line,
    });
  }

  const allowlisted = opts.allowlistBypass
    ? new Set<string>()
    : prodDumpAllowlistedTableNames(parsed);

  if (opts.strictProdOnlyTables && !opts.allowlistBypass) {
    for (const prodTable of Object.keys(parsed.tables)) {
      if (manifestTableNames.has(prodTable)) continue;
      if (SQLITE_INTERNAL_TABLES.has(prodTable)) continue;
      if (allowlisted.has(prodTable)) continue;
      diagnostics.push({
        severity: 2,
        message: `prod-only table: ${prodTable} (hotfix table, or missing from registry)`,
      });
    }
  }

  for (const table of manifest) {
    const live = parsed.tables[table.table];
    if (!live?.length) {
      diagnostics.push({
        severity: 2,
        message: `manifest table missing in dump: ${table.table}`,
      });
      continue;
    }

    const liveByName = new Map(live.map((c) => [c.name, c]));
    const manifestNames = new Set(table.columns.map((c) => c.column));

    for (const col of table.columns) {
      const row = liveByName.get(col.column);
      if (!row) {
        diagnostics.push({
          severity: 2,
          message: `column ${table.table}.${col.column} in manifest but not in dump`,
        });
        continue;
      }
      if (!manifestKindAffinityCompatible(col.kind, row.type)) {
        diagnostics.push({
          severity: 2,
          message: affinityMismatchMessage(
            table.table,
            col.column,
            col.kind,
            row.type,
          ),
        });
      }
      if (shouldCompareNullability(col.kind, row)) {
        const msg = nullabilityDriftMessage(
          table.table,
          col.column,
          col.nullable,
          row,
        );
        if (msg) diagnostics.push({ severity: 2, message: msg });
      }
    }

    for (const row of live) {
      if (!manifestNames.has(row.name)) {
        diagnostics.push({
          severity: 2,
          message: `column ${table.table}.${row.name} in dump but not in manifest`,
        });
      }
    }
  }

  return diagnostics;
}

export function exitCodeFromParityDiagnostics(
  diagnostics: readonly ParityDiagnostic[],
): number {
  let code = 0;
  for (const d of diagnostics) {
    if (d.severity > code) code = d.severity;
  }
  return code;
}

export function emitParityDiagnostics(
  diagnostics: readonly ParityDiagnostic[],
): void {
  const sorted = [...diagnostics].sort(
    (a, b) => b.severity - a.severity || a.message.localeCompare(b.message),
  );
  for (const d of sorted) {
    if (d.severity >= 2) console.error(d.message);
    else console.warn(d.message);
  }
}

function finalizeManifestDumpParity(
  dump: ProdSchemaDump,
  manifest: readonly DecodedManifestTable[],
  options: ManifestDumpParityOptions,
): number {
  const opts = { ...defaultOptions, ...options };
  assertAllowlistBypassNotInCi(opts);
  logAllowlistBypassIfEnabled(opts);
  const diagnostics = collectManifestDumpParityDiagnostics(
    dump,
    manifest,
    opts,
  );
  emitParityDiagnostics(diagnostics);
  const exitCode = exitCodeFromParityDiagnostics(diagnostics);
  if (exitCode !== 0) {
    throw new ManifestDumpParityFailedError(diagnostics, exitCode);
  }
  return 0;
}

export function assertManifestMatchesDump(
  dump: ProdSchemaDump,
  manifest: readonly DecodedManifestTable[],
  options: ManifestDumpParityOptions = {},
): void {
  finalizeManifestDumpParity(dump, manifest, options);
}

export function runManifestDumpParity(
  dump: ProdSchemaDump,
  manifest: readonly DecodedManifestTable[],
  options: ManifestDumpParityOptions = {},
): number {
  try {
    return finalizeManifestDumpParity(dump, manifest, options);
  } catch (e) {
    if (e instanceof ManifestDumpParityFailedError) return e.exitCode;
    throw e;
  }
}

export async function runManifestDumpParityFile(
  dumpPath: string,
  manifest: readonly DecodedManifestTable[],
  options?: ManifestDumpParityOptions,
): Promise<number> {
  const text = await Bun.file(dumpPath).text();
  const dump = parseProdSchemaDump(JSON.parse(text));
  return runManifestDumpParity(dump, manifest, options);
}

export async function assertManifestMatchesDumpFile(
  dumpPath: string,
  manifest: readonly DecodedManifestTable[],
  options?: ManifestDumpParityOptions,
): Promise<void> {
  await runManifestDumpParityFile(dumpPath, manifest, options);
}

export function prodDumpParityOptionsFromEnv(): ManifestDumpParityOptions {
  const strictTables = Bun.env.SPORTSDESK_SCHEMA_DUMP_STRICT_TABLES !== "0";
  return {
    strictProdOnlyTables: strictTables,
    strictStaleAllowlist: strictTables,
    allowlistBypass: Bun.env.SPORTSDESK_SCHEMA_DUMP_ALLOWLIST_BYPASS === "1",
  };
}

export function assertManifestMatchesLiveDb(
  dbPath: string,
  manifest: readonly DecodedManifestTable[],
  options?: ManifestDumpParityOptions,
): void {
  const dump = captureProdSchemaFromDb(dbPath, `live:${dbPath}`);
  assertManifestMatchesDump(dump, manifest, options);
}
