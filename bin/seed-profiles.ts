#!/usr/bin/env bun
/**
 * @file bin/seed-profiles.ts
 * @description Initialize the profile_themes schema and apply seed-profiles.sql.
 *
 * Usage: bun bin/seed-profiles.ts <path/to/profiles.sqlite>
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AutomatedDualTokenStore } from "../lib/token_automation.ts";
import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";

const target = process.argv[2];
if (!target) {
  console.error("usage: bun bin/seed-profiles.ts <path/to/profiles.sqlite>");
  process.exit(2);
}

const dbPath = resolve(target);
mkdirSync(dirname(dbPath), { recursive: true });

const initializer = new AutomatedDualTokenStore(dbPath, false);
initializer.close();

const db = openSportsdeskSqlite(dbPath);
try {
  const seedPath = resolve(import.meta.dir, "../seed-profiles.sql");
  db.run(await Bun.file(seedPath).text());
  const rows = db
    .query(
      "SELECT profile_id, color_int, color_hex, color_label FROM profile_themes ORDER BY profile_id",
    )
    .all() as Array<Record<string, string | number | bigint>>;
  console.log(
    JSON.stringify(
      {
        database: dbPath,
        count: rows.length,
        profiles: rows.map((row) => ({
          profile_id: String(row.profile_id),
          color_int: Number(row.color_int),
          color_hex: String(row.color_hex),
          color_label: String(row.color_label),
        })),
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
