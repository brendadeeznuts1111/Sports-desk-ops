import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutomatedDualTokenStore,
  MAX_PROFILE_THEMES,
  type ProfileId,
} from "../lib/token_automation.ts";
import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const expected = [
  ["desk-dev-local", 2278750, "#22c55e", "green-500"],
  ["desk-enam-01", 3718648, "#38bdf8", "sky-400"],
  ["desk-mut-prod", 15680580, "#ef4444", "red-500"],
  ["desk-research", 11032055, "#a855f7", "purple-500"],
  ["desk-staging", 16096779, "#f59e0b", "amber-500"],
];

describe("core profile seeds", () => {
  test("seeds exactly five profiles and is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-seed-"));
    dirs.push(dir);
    const dbPath = join(dir, "profiles.sqlite");
    const store = new AutomatedDualTokenStore(dbPath, false);
    store.close();

    const db = openSportsdeskSqlite(dbPath);
    try {
      const sql = await Bun.file("seed-profiles.sql").text();
      db.run(sql);
      db.run(sql);
      const rows = db
        .query(
          "SELECT profile_id, color_int, color_hex, color_label FROM profile_themes ORDER BY profile_id",
        )
        .all() as Array<Record<string, string | number | bigint>>;
      expect(
        rows.map((row) => [
          row.profile_id,
          Number(row.color_int),
          row.color_hex,
          row.color_label,
        ]),
      ).toEqual(expected);
    } finally {
      db.close();
    }
  });

  test("store API refuses a ninth profile but still updates existing ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-store-cap-"));
    dirs.push(dir);
    const store = new AutomatedDualTokenStore(
      join(dir, "profiles.sqlite"),
      false,
    );
    try {
      for (let index = 0; index < MAX_PROFILE_THEMES; index += 1) {
        store.upsertProfileTheme({
          profile_id: ("profile-" + index) as ProfileId,
          color_int: 0,
          color_css: "#000000",
          color_hex: "#000000",
          color_label: "x",
        });
      }
      expect(() =>
        store.upsertProfileTheme({
          profile_id: "profile-overflow" as ProfileId,
          color_int: 0,
          color_css: "#000000",
          color_hex: "#000000",
          color_label: "x",
        }),
      ).toThrow("ERR_TOKEN_PROFILE_LIMIT");
      expect(() =>
        store.upsertProfileTheme({
          profile_id: "profile-0" as ProfileId,
          color_int: 0,
          color_css: "#000000",
          color_hex: "#000000",
          color_label: "updated",
        }),
      ).not.toThrow();
    } finally {
      store.close();
    }
  });

  test("SQLite trigger caps the registry at eight profiles", () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-cap-"));
    dirs.push(dir);
    const dbPath = join(dir, "profiles.sqlite");
    const store = new AutomatedDualTokenStore(dbPath, false);
    store.close();
    const db = openSportsdeskSqlite(dbPath);
    try {
      const insert = db.query(
        "INSERT INTO profile_themes (profile_id, color_int, color_css, color_label, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
      );
      for (let index = 0; index < MAX_PROFILE_THEMES; index += 1) {
        insert.run("profile-" + index, index, "#000000", "x", 0);
      }
      expect(() =>
        insert.run("profile-overflow", 0, "#000000", "x", 0),
      ).toThrow("ERR_TOKEN_PROFILE_LIMIT");
    } finally {
      db.close();
    }
  });
});
