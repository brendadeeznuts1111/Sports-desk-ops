#!/usr/bin/env bun
/**
 * Capture PRAGMA table_xinfo snapshot from a SQLite file (explicit prod read).
 *
 *   bun run schema:dump-prod -- /path/to/prod.sqlite
 *   SPORTSDESK_SCHEMA_DB=/path/to/prod.sqlite bun run schema:dump-prod
 *
 * Re-dump preserves fixture allowlist; captured_at is always refreshed on prod capture.
 * schema:sync-prod-dump preserves both allowlist and captured_at from the existing file.
 */

import { resolve } from "node:path";
import {
  PROD_SCHEMA_DUMP_FORMAT_VERSION,
  allowlistRotWarnings,
  buildRegistryBaselineProdDump,
  captureProdSchemaFromDb,
  loadProdSchemaDump,
  type ProdSchemaDump,
} from "../lib/schema_prod_dump.ts";
import { listRegisteredTableNames } from "../lib/schema_report.ts";

const defaultOut = resolve(
  import.meta.dir,
  "../tests/fixtures/prod-schema.json",
);

async function readExistingDump(
  outPath: string,
): Promise<ProdSchemaDump | null> {
  if (!(await Bun.file(outPath).exists())) return null;
  try {
    return await loadProdSchemaDump(outPath);
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const fromRegistry = args.includes("--from-registry");
  const outArg = args
    .find((a) => a.startsWith("--out="))
    ?.slice("--out=".length);
  const outPath = outArg?.trim() ? resolve(outArg) : defaultOut;

  const dbPath =
    args.find((a) => !a.startsWith("-"))?.trim() ??
    Bun.env.SPORTSDESK_SCHEMA_DB?.trim();

  const existing = await readExistingDump(outPath);

  let dump: ProdSchemaDump;
  if (fromRegistry) {
    dump = buildRegistryBaselineProdDump();
    if (existing) {
      if (existing.allowlist !== undefined) {
        dump.allowlist = existing.allowlist;
      }
      dump.captured_at = existing.captured_at;
    }
  } else {
    if (!dbPath) {
      console.error(
        "schema:dump-prod: pass db path, set SPORTSDESK_SCHEMA_DB, or use --from-registry",
      );
      return 1;
    }
    dump = captureProdSchemaFromDb(
      resolve(dbPath),
      "prod-readonly",
      existing?.allowlist !== undefined
        ? { allowlist: existing.allowlist }
        : undefined,
    );
  }

  if (dump.format_version !== PROD_SCHEMA_DUMP_FORMAT_VERSION) {
    throw new Error("unexpected dump format_version");
  }

  const manifestTables = new Set(listRegisteredTableNames());
  for (const line of allowlistRotWarnings(dump, manifestTables)) {
    console.warn(line);
  }

  await Bun.write(outPath, `${JSON.stringify(dump, null, 2)}\n`);
  console.error(
    `prod schema dump: ${outPath} (${Object.keys(dump.tables).length} tables)`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
