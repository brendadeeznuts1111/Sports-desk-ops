#!/usr/bin/env bun
/**
 * @file scripts/migrate.ts
 * @description Idempotent PostgreSQL migration runner with schema_migrations ledger.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "../lib/db.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

const main = async (): Promise<void> => {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const applied = new Set(
    (
      await sql<{ filename: string }[]>`SELECT filename FROM schema_migrations`
    ).map((r) => r.filename),
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    console.log("[migrate] no .sql files in", MIGRATIONS_DIR);
    return;
  }

  let ran = 0;
  for (const f of files) {
    if (applied.has(f)) {
      console.log(`[migrate] skip  ${f} (already applied)`);
      continue;
    }
    const body = await Bun.file(join(MIGRATIONS_DIR, f)).text();
    console.log(`[migrate] apply ${f}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${f})`;
    });
    ran += 1;
  }
  console.log(`[migrate] done — ${ran} applied, ${files.length - ran} skipped`);

  await sql.close();
};

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
