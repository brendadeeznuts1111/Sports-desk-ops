import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import {
  buildRegistryBaselineProdDump,
  parseProdSchemaDump,
} from "../lib/schema_prod_dump.ts";

const dumpScript = resolve(import.meta.dir, "../scripts/schema_dump_prod.ts");
const repoRoot = resolve(import.meta.dir, "..");

async function runDumpScript(args: string[]): Promise<number> {
  const proc = Bun.spawn(["bun", "run", dumpScript, ...args], {
    cwd: repoRoot,
    stderr: "pipe",
    stdout: "pipe",
    env: { ...Bun.env, SPORTSDESK_SCHEMA_DB: "" },
  });
  return proc.exited;
}

describe("schema dump captured_at discipline", () => {
  test("schema:sync-prod-dump preserves captured_at", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-cap-"));
    const out = join(dir, "prod-schema.json");
    const initial = buildRegistryBaselineProdDump();
    initial.captured_at = "2020-01-01T00:00:00.000Z";
    await Bun.write(out, `${JSON.stringify(initial, null, 2)}\n`);

    expect(await runDumpScript(["--from-registry", `--out=${out}`])).toBe(0);

    const after = parseProdSchemaDump(await Bun.file(out).json());
    expect(after.captured_at).toBe("2020-01-01T00:00:00.000Z");
  });

  test("schema:dump-prod refreshes captured_at on prod capture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-cap-prod-"));
    const out = join(dir, "prod-schema.json");
    const dbPath = join(dir, "mini.sqlite");

    const db = new Database(dbPath);
    db.exec(
      `CREATE TABLE ingestion_trades (id INTEGER PRIMARY KEY, qty INTEGER, note TEXT);`,
    );
    db.close();

    const initial = buildRegistryBaselineProdDump();
    initial.captured_at = "2020-01-01T00:00:00.000Z";
    initial.tables = {
      ingestion_trades: [
        { name: "id", type: "INTEGER", notnull: 0, pk: 1, hidden: 0 },
        { name: "qty", type: "INTEGER", notnull: 0, pk: 0, hidden: 0 },
        { name: "note", type: "TEXT", notnull: 0, pk: 0, hidden: 0 },
      ],
    };
    await Bun.write(out, `${JSON.stringify(initial, null, 2)}\n`);

    expect(await runDumpScript([dbPath, `--out=${out}`])).toBe(0);

    const after = parseProdSchemaDump(await Bun.file(out).json());
    expect(after.captured_at).not.toBe("2020-01-01T00:00:00.000Z");
  });
});
