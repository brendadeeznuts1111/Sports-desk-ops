#!/usr/bin/env bun
/**
 * Typed SQLite schema report (util.parseArgs + Bun.inspect.custom).
 *
 * Bun 1.4.4: value flags use =; all flags before `run`; JSON redirect via naked CLI.
 * Runtime (flags go after `bun`, before `run`):
 *   bun --check sportsdesk_schema_cli.ts
 *   bun run --preload ./preload/schema-inspect.ts -   # stdin; __schemaReport + inspect.custom
 *   bun --preload ./preload/schema-inspect.ts -p 'console.log(__schemaReport)'
 *   bun run schema:inspect | schema:probe
 *   bun --prefer-offline run schema --json
 *   bun --watch --no-clear-screen run schema --table match_evaluations
 *   bun --define=SCHEMA_STRICT:true run schema --table match_evaluations
 *   bun run schema:strict | schema:strict:match_evaluations
 *   bun sportsdesk_schema_cli.ts --json > schema.snapshot.json
 *   bun run schema:json:file > schema.snapshot.json
 *   (--drop=console removes console.log too — do not use for JSON capture)
 *   bun --tsconfig-override tsconfig.json run sportsdesk_schema_cli.ts
 *   bun --env-file=.env.ci --env-file=.env.shared run schema --json
 *   bun --cwd /abs/path/to/sportsdesk-ops run schema
 *   bun --config ./bunfig.toml run schema
 *   bun --use-system-ca run serve   # webview/TLS in CI behind corporate CA (schema is file:// today)
 *   bun --console-depth 6 run schema --table match_evaluations
 *
 * SSOT load throws (sqlTable/sqlCol during import of sqlite_schema_ssot.ts):
 *   bun --inspect-brk=127.0.0.1:6499 sportsdesk_schema_cli.ts --table match_evaluations
 *   (break line 1, step into imports — or: bun run schema:debug:brk)
 */

import { Glob } from "bun";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildSqliteSchemaReport,
  buildSqliteSchemaReportForTable,
  defaultSchemaReportProvenance,
  listRegisteredTableNames,
  schemaRegistrySourceUrl,
  sqliteDatabaseFileUrl,
  SqliteSchemaReport,
} from "../lib/schema_report.ts";
import {
  isSqliteFileHeader,
  readDbHeaderBytes,
  reportToJsonWithBinary,
} from "../lib/schema_binary.ts";
import {
  emitSnapshot,
  schemaReportJsonDocument,
} from "../lib/sqlite_schema_snapshot.ts";
import {
  assertSchemaReportValid,
  validateSchemaReport,
} from "../lib/schema_validate.ts";
import {
  schemaBinaryManifestEnabled,
  schemaStrictEnabled,
} from "../lib/schema_runtime_flags.ts";
import { SPORTSDESK_SQLITE_TABLES } from "../lib/sqlite_schema_registry.ts";
import { schemaDatabaseUrlFromEnv } from "../lib/env.ts";
import { parseTableParamFromUrl } from "../lib/urls-query.ts";
import { asDatabaseURL } from "../lib/urls.ts";
import {
  formatSchemaError,
  maybeOpenSchemaError,
  registryFileUrl,
  ssotFileUrl,
} from "../lib/schema_cli_errors.ts";
import { SchemaUnknownTableError } from "../lib/schema_unknown_table_error.ts";
import { assertSsotRegistryInSync } from "../lib/ssot_registry_sync.ts";
import { parseSsotTableName } from "../lib/ssot_table_name.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    table: { type: "string" },
    json: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    migrations: { type: "boolean", default: false },
    db: { type: "string" },
    url: { type: "string" },
    "write-manifest": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
    open: { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});

function printHelp(): void {
  console.log(`SportsDesk SQLite schema registry

Usage:
  bun run schema              Full report (summary + columns + keys)
  bun run schema --table NAME Single table
  bun run schema --json       Machine-readable
  bun run schema --list       Table names (one per line)
  bun run schema --migrations List **/*.sql under ./migrations
  bun run schema --db ./lifecycle.sqlite   Verify SQLite magic header (binary read)
  bun run schema --write-manifest ./schema.manifest.bin
  bun run schema --open           Jump to SSOT/registry line on brand errors

Docs:
  docs/schema-dump-operations.md    dump-prod vs sync, captured_at, allowlist, parity scope
  docs/schema-sqlite-failure-mode-matrix.md   exit codes 2/3, strict SQLite, EOD WAL

Env:
  VISUAL / EDITOR                 Bun.openInEditor (falls back to vscode/cursor)
  SPORTSDESK_SCHEMA_DB              Default --db path; live parity when PARITY_LIVE=1
  SPORTSDESK_SCHEMA_DUMP            Committed prod-schema.json for snapshot parity
  SPORTSDESK_SCHEMA_SNAPSHOT_JSON   schema:snapshot JSON path
  SPORTSDESK_SCHEMA_SKIP_DUMP_PARITY=1   Skip manifest ↔ fixture gate
  SPORTSDESK_SCHEMA_DUMP_STRICT_TABLES=0 Relax prod-only + stale allowlist (local only)

Define (bun --define=K:V):
  SCHEMA_STRICT:true                Fail on registry integrity issues
  SCHEMA_BINARY_MANIFEST:false      Omit manifestBase64 from --json

Bun 1.4.4 rules:
  1. Value flags use = (--elide-lines=10, --env-file=.env.ci, --define=SCHEMA_STRICT:true)
  2. Every bun flag before run (including --filter); run --filter … does not filter workspaces
  3. Redirect JSON: naked CLI (bun sportsdesk_schema_cli.ts --json), not bun run schema --json
  4. --check typechecks then runs; typecheck-only → bun run schema:typecheck
  5. Ad-hoc report: lib/sportsdesk_sqlite_schema_report.ts or --preload schema-inspect.ts

Dump / snapshot:
  bun run schema:dump-prod -- /path/to/prod.sqlite
  bun run schema:sync-prod-dump
  bun run schema:snapshot
  bun run schema:gate              CI gate (snapshot + fixture drift + gauntlet + eod smoke)
  bun run schema:check-fixture-drift   registry tables vs committed prod-schema.json
  bun run schema:parity-gauntlet   drill exit 2 and combined exit 3
  bun run schema:dump-lag          commit_time − captured_at on fixture
  bun run eod:smoke                fixture JSONL + temp sqlite tar.gz
  bun run eod:archive -- --out=EOD.tar.gz audit.jsonl=./reports/ingestion-audit.jsonl

Docs index: docs/README.md

Recipes:
  bun run schema
  bun run schema --table match_evaluations
  bun sportsdesk_schema_cli.ts --json > schema.snapshot.json
  bun --watch --no-clear-screen run schema --table match_evaluations
  bun --check sportsdesk_schema_cli.ts
  bun run schema:typecheck
  bun --parallel --elide-lines=10 --if-present --filter 'sportsdesk-*' run schema
  bun --preload ./preload/schema-inspect.ts -p 'console.log(__schemaReport.summary.length)'
  bun --env-file=.env.ci --define=SCHEMA_STRICT:true run schema --table combo_legs
  bun --use-system-ca run schema:snapshot   # when HTTPS fetch + corporate CA

Tables: ${listRegisteredTableNames().join(", ")}
`);
}

async function listMigrationSqlFiles(): Promise<string[]> {
  const cwd = join(import.meta.dir, "../schema/migrations");
  const glob = new Glob("**/*.sql");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd, onlyFiles: true })) {
    files.push(file);
  }
  return files.sort();
}

async function main(): Promise<number> {
  if (values.help) {
    printHelp();
    return 0;
  }

  if (values.migrations) {
    const files = await listMigrationSqlFiles();
    if (values.json) {
      console.log(JSON.stringify({ migrations: files }, null, 2));
    } else if (files.length === 0) {
      console.log("(no .sql files under migrations/)");
    } else {
      console.log(files.join("\n"));
    }
    return 0;
  }

  if (values.list) {
    console.log(listRegisteredTableNames().join("\n"));
    return 0;
  }

  assertSsotRegistryInSync();

  const dbPathEarly = values.db ?? Bun.env.SPORTSDESK_SCHEMA_DB?.trim();
  const databaseFromUrl =
    values.url !== undefined ? asDatabaseURL(values.url) : undefined;
  const tableFromUrl =
    values.url !== undefined ? parseTableParamFromUrl(values.url) : undefined;
  const envDbUrl = schemaDatabaseUrlFromEnv();
  const manifestPathEarly = values["write-manifest"]?.trim();

  const provenance = defaultSchemaReportProvenance({
    sourceUrl: schemaRegistrySourceUrl(),
    ...(dbPathEarly
      ? { databaseUrl: sqliteDatabaseFileUrl(resolve(dbPathEarly)) }
      : databaseFromUrl !== undefined
        ? { databaseUrl: databaseFromUrl }
        : envDbUrl !== undefined
          ? { databaseUrl: envDbUrl }
          : {}),
    ...(manifestPathEarly
      ? { manifestUrl: sqliteDatabaseFileUrl(resolve(manifestPathEarly)) }
      : {}),
  });

  let report: SqliteSchemaReport;
  const tableRaw = values.table ?? tableFromUrl;
  const tableName = tableRaw ? parseSsotTableName(tableRaw) : undefined;
  if (tableRaw !== undefined && tableName === undefined) {
    const err = new SchemaUnknownTableError(tableRaw);
    await maybeOpenSchemaError(err, values.open ?? false, ssotFileUrl());
    console.error(formatSchemaError(err));
    return 1;
  }
  if (tableName) {
    const filtered = buildSqliteSchemaReportForTable(tableName, provenance);
    if (!filtered) {
      const err = new SchemaUnknownTableError(tableRaw!);
      await maybeOpenSchemaError(err, values.open ?? false, ssotFileUrl());
      console.error(formatSchemaError(err));
      return 1;
    }
    report = filtered;
  } else {
    report = buildSqliteSchemaReport(SPORTSDESK_SQLITE_TABLES, provenance);
  }

  const validationIssues = validateSchemaReport(report);
  if (schemaStrictEnabled()) {
    assertSchemaReportValid(report);
  } else if (validationIssues.length > 0 && !values.json) {
    console.warn(
      `schema: ${validationIssues.length} validation issue(s) (use --define SCHEMA_STRICT:true to fail)`,
    );
  }

  const dbPath = values.db ?? Bun.env.SPORTSDESK_SCHEMA_DB?.trim();

  let dbHeader: Uint8Array | undefined;
  if (dbPath) {
    dbHeader = await readDbHeaderBytes(dbPath);
    if (!isSqliteFileHeader(dbHeader)) {
      console.error(`not a SQLite file: ${dbPath}`);
      return 1;
    }
    if (!values.json && !values["write-manifest"]) {
      console.log(
        `sqlite ok: ${dbPath} (${dbHeader.byteLength} bytes read via Bun.file().bytes())`,
      );
    }
  }

  const defaultManifestUrl = pathToFileURL(
    resolve(import.meta.dir, "../schema/manifest.bin"),
  );
  const manifestOutUrl = manifestPathEarly
    ? sqliteDatabaseFileUrl(resolve(manifestPathEarly))
    : defaultManifestUrl;

  const shouldWriteManifest = Boolean(values["write-manifest"]) || values.json;

  if (shouldWriteManifest) {
    await emitSnapshot(report, manifestOutUrl);
    if (!values.json) {
      console.log(`wrote manifest → ${manifestOutUrl.href}`);
    }
  }

  if (values.json) {
    const dbExtra =
      dbPath && dbHeader
        ? {
            path: dbPath,
            headerBytes: dbHeader.byteLength,
            sqliteMagicOk: true as const,
          }
        : undefined;

    const doc = schemaReportJsonDocument(report, manifestOutUrl, {
      validationIssues,
      db: dbExtra,
    });
    const embedded = schemaBinaryManifestEnabled()
      ? reportToJsonWithBinary(report)
      : null;
    const body =
      embedded === null
        ? doc
        : {
            ...doc,
            manifestBase64: embedded.manifestBase64,
            manifestHex: embedded.manifestHex,
            manifestByteLength: embedded.manifestByteLength,
          };

    console.log(JSON.stringify(body, null, 2));
    return 0;
  }

  console.log(report);
  return 0;
}

async function runCli(): Promise<number> {
  try {
    return await main();
  } catch (err) {
    await maybeOpenSchemaError(err, values.open ?? false, registryFileUrl());
    if (err instanceof Error) {
      console.error(formatSchemaError(err));
    } else {
      console.error(formatSchemaError(new Error(String(err))));
    }
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await runCli());
}

export {
  SqliteSchemaReport,
  buildSqliteSchemaReport,
  listRegisteredTableNames,
};
