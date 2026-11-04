#!/usr/bin/env bun
/**
 * dump_lag ≈ commit_time(fixture) − captured_at (observation time in JSON).
 *
 *   bun run schema:dump-lag
 *   bun run schema:dump-lag -- tests/fixtures/prod-schema.json
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { parseProdSchemaDump } from "../lib/schema_prod_dump.ts";

async function main(): Promise<number> {
  const pathArg = process.argv[2]?.trim();
  const dumpPath = resolve(
    import.meta.dir,
    pathArg ?? "../tests/fixtures/prod-schema.json",
  );
  const dump = parseProdSchemaDump(await Bun.file(dumpPath).json());
  let commitIso: string;
  try {
    commitIso = execSync(`git log -1 --format=%aI -- "${dumpPath}"`, {
      encoding: "utf8",
    }).trim();
  } catch {
    console.error(`schema:dump-lag: no git history for ${dumpPath}`);
    return 1;
  }
  const capturedMs = Date.parse(dump.captured_at);
  const commitMs = Date.parse(commitIso);
  if (Number.isNaN(capturedMs) || Number.isNaN(commitMs)) {
    console.error("schema:dump-lag: invalid captured_at or commit date");
    return 1;
  }
  const lagMs = commitMs - capturedMs;
  const lagDays = lagMs / (86400 * 1000);
  console.log(
    JSON.stringify(
      {
        dump_path: dumpPath,
        captured_at: dump.captured_at,
        last_commit_at: commitIso,
        dump_lag_ms: lagMs,
        dump_lag_days: Math.round(lagDays * 100) / 100,
        source: dump.source,
      },
      null,
      2,
    ),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
