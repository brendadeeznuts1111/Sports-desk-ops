#!/usr/bin/env bun
/**
 * Fail when registry baseline `tables` ≠ committed prod-schema.json (after sync semantics).
 *
 * Preserves allowlist + captured_at like schema:sync-prod-dump, compares tables only.
 */

import { resolve } from "node:path";
import { compareFixtureTablesToRegistry } from "../lib/schema_fixture_drift.ts";
import { parseProdSchemaDump } from "../lib/schema_prod_dump.ts";

const defaultFixture = resolve(
  import.meta.dir,
  "../tests/fixtures/prod-schema.json",
);

async function main(): Promise<number> {
  const fixturePath = process.argv[2]?.trim()
    ? resolve(process.argv[2]!)
    : defaultFixture;

  const existing = parseProdSchemaDump(await Bun.file(fixturePath).json());
  const drift = compareFixtureTablesToRegistry(existing);

  if (drift.equal) {
    console.log(`schema:check-fixture-drift: ok ${fixturePath}`);
    return 0;
  }

  console.error(
    "schema:check-fixture-drift: registry tables differ from committed prod-schema.json",
  );
  console.error(
    "  Run: bun run schema:sync-prod-dump && git add tests/fixtures/prod-schema.json",
  );
  console.error(`  Fixture: ${fixturePath}`);
  return 1;
}

if (import.meta.main) {
  process.exit(await main());
}
