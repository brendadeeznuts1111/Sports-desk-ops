import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compareFixtureTablesToRegistry } from "../lib/schema_fixture_drift.ts";
import {
  parseProdSchemaDump,
  PROD_SCHEMA_DUMP_FORMAT_VERSION,
} from "../lib/schema_prod_dump.ts";

const repoRoot = resolve(import.meta.dir, "..");
const fixturePath = resolve(repoRoot, "tests/fixtures/prod-schema.json");
const driftScript = resolve(repoRoot, "scripts/schema_check_fixture_drift.ts");

describe("schema_fixture_drift", () => {
  test("committed prod-schema.json matches registry tables", () => {
    const existing = parseProdSchemaDump(
      JSON.parse(readFileSync(fixturePath, "utf8")),
    );
    expect(compareFixtureTablesToRegistry(existing).equal).toBe(true);
  });

  test("drift script exits 0 on committed fixture", async () => {
    const proc = Bun.spawn(["bun", "run", driftScript], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
  });

  test("drift script exits 1 when tables diverge from registry", async () => {
    const existing = parseProdSchemaDump(
      JSON.parse(readFileSync(fixturePath, "utf8")),
    );
    const dir = mkdtempSync(join(tmpdir(), "fixture-drift-"));
    const path = join(dir, "stale-fixture.json");
    const tables = { ...existing.tables };
    delete tables[Object.keys(tables)[0]!];
    writeFileSync(
      path,
      JSON.stringify({
        format_version: PROD_SCHEMA_DUMP_FORMAT_VERSION,
        captured_at: existing.captured_at,
        source: existing.source,
        tables,
        allowlist: existing.allowlist ?? {},
      }),
    );

    const proc = Bun.spawn(["bun", "run", driftScript, path], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(1);
    const err = await proc.stderr.text();
    expect(err).toMatch(/schema:sync-prod-dump/);
  });
});
