#!/usr/bin/env bun
/**
 * Persist schema JSON + binary manifest (postschema hook / CI).
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildSqliteSchemaReport,
  defaultSchemaReportProvenance,
  schemaRegistrySourceUrl,
  sqliteDatabaseFileUrl,
} from "../lib/schema_report.ts";
import {
  assertManifestRoundTrip,
  decodeManifest,
  encodeManifest,
  reportToJsonWithBinary,
} from "../lib/schema_binary.ts";
import {
  assertManifestMatchesLiveDb,
  prodDumpParityOptionsFromEnv,
  runManifestDumpParityFile,
} from "../lib/schema_manifest_db_parity.ts";
import { emitSnapshot } from "../lib/sqlite_schema_snapshot.ts";
import {
  assertSchemaReportValid,
  validateSchemaReport,
} from "../lib/schema_validate.ts";
import { schemaStrictEnabled } from "../lib/schema_runtime_flags.ts";

const outJson =
  Bun.env.SPORTSDESK_SCHEMA_SNAPSHOT_JSON?.trim() ??
  resolve(import.meta.dir, "../reports/schema.snapshot.json");

const outBin =
  Bun.env.SPORTSDESK_SCHEMA_SNAPSHOT_BIN?.trim() ??
  resolve(import.meta.dir, "../reports/schema.manifest.bin");

const defaultProdDump = resolve(
  import.meta.dir,
  "../tests/fixtures/prod-schema.json",
);

const prodDumpPath = Bun.env.SPORTSDESK_SCHEMA_DUMP?.trim() ?? defaultProdDump;

function logCaTrustSource(): void {
  if (Bun.env.SPORTSDESK_SCHEMA_CA !== "system") return;
  const platform =
    process.platform === "darwin"
      ? "macOS keychain"
      : process.platform === "win32"
        ? "Windows cert store"
        : "system trust store";
  console.error(`[CA] using system trust store (${platform}, --use-system-ca)`);
}

async function main(): Promise<number> {
  logCaTrustSource();
  const dbEnv = Bun.env.SPORTSDESK_SCHEMA_DB?.trim();
  const report = buildSqliteSchemaReport(
    undefined,
    defaultSchemaReportProvenance({
      sourceUrl: schemaRegistrySourceUrl(),
      manifestUrl: outBin,
      ...(dbEnv ? { databaseUrl: sqliteDatabaseFileUrl(resolve(dbEnv)) } : {}),
    }),
  );
  const issues = validateSchemaReport(report);
  if (schemaStrictEnabled()) {
    assertSchemaReportValid(report);
  } else if (issues.length > 0) {
    console.warn(
      `schema snapshot: ${issues.length} validation issue(s) (set SCHEMA_STRICT:true to fail)`,
    );
  }

  mkdirSync(dirname(outJson), { recursive: true });
  mkdirSync(dirname(outBin), { recursive: true });

  const payload = reportToJsonWithBinary(report);
  await Bun.write(outJson, JSON.stringify(payload, null, 2));
  await emitSnapshot(report, pathToFileURL(outBin));

  const manifestBytes = await Bun.file(outBin).bytes();
  assertManifestRoundTrip(manifestBytes, report);

  const decoded = decodeManifest(manifestBytes);
  const parityOpts = prodDumpParityOptionsFromEnv();

  const skipDumpParity = Bun.env.SPORTSDESK_SCHEMA_SKIP_DUMP_PARITY === "1";
  if (!skipDumpParity && (await Bun.file(prodDumpPath).exists())) {
    const parityExit = await runManifestDumpParityFile(
      prodDumpPath,
      decoded,
      parityOpts,
    );
    if (parityExit !== 0) return parityExit;
  }

  const liveParity = Bun.env.SPORTSDESK_SCHEMA_PARITY_LIVE === "1" && dbEnv;
  if (liveParity) {
    const dbPath = resolve(dbEnv);
    if (await Bun.file(dbPath).exists()) {
      assertManifestMatchesLiveDb(dbPath, decoded, parityOpts);
    }
  }

  if (Bun.env.SPORTSDESK_SCHEMA_SNAPSHOT_QUIET !== "1") {
    console.log(`schema snapshot: ${outJson}`);
    console.log(
      `schema manifest: ${outBin} (${encodeManifest(report).byteLength} bytes)`,
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
