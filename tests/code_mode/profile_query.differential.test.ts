import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  MAX_LIMIT,
  queryProfiles,
  type ProfileField,
} from "../../lib/profile_query_tools.ts";
import { snapshotProfiles } from "./oracle.ts";

const NUM_RUNS = (() => {
  const raw = Number(process.env.FAST_CHECK_NUM_RUNS);
  return Number.isInteger(raw) && raw > 0 ? raw : 100;
})();

const seed = Number(process.env.FAST_CHECK_SEED);
if (process.env.FAST_CHECK_SEED !== undefined && Number.isInteger(seed)) {
  fc.configureGlobal({ seed });
}

/**
 * Independent engine: SQLite orders the same rows with its own COLLATE BINARY / REAL semantics.
 * Agreement across two implementations is stronger evidence than the JS oracle matching itself.
 */
const db = new Database(":memory:");
db.run(
  "CREATE TABLE profiles (id TEXT PRIMARY KEY, vol REAL, clv REAL, sharp REAL, flags TEXT, sentinel INTEGER)",
);
const insert = db.prepare(
  "INSERT INTO profiles (id, vol, clv, sharp, flags, sentinel) VALUES (?, ?, ?, ?, ?, ?)",
);
for (const profile of snapshotProfiles()) {
  insert.run(
    profile.id,
    profile.vol,
    profile.clv,
    profile.sharp,
    JSON.stringify(profile.flags),
    profile.id.startsWith("SYNTH_") ? 1 : 0,
  );
}

const FIELDS: readonly ProfileField[] = ["clv", "vol", "sharp"];
const SQL_FIELD: Readonly<Record<ProfileField, string>> = {
  clv: "clv",
  vol: "vol",
  sharp: "sharp",
};

afterAll(() => db.close());

describe("differential oracle: SQLite vs queryProfiles", () => {
  test("both engines agree for arbitrary valid requests", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FIELDS),
        fc.integer({ min: 1, max: MAX_LIMIT }),
        fc.boolean(),
        (field, limit, includeSentinels) => {
          const rows = db
            .query(
              `SELECT id, ${SQL_FIELD[field]} AS value, flags, sentinel
               FROM profiles
               WHERE (? = 1 OR sentinel = 0)
               ORDER BY value DESC, id ASC
               LIMIT ?`,
            )
            .all(includeSentinels ? 1 : 0, limit) as {
            id: string;
            value: number;
            flags: string;
            sentinel: number;
          }[];

          const result = queryProfiles({ field, limit, includeSentinels });
          expect(result.rows).toEqual(
            rows.map((row) => ({
              id: row.id,
              value: row.value,
              flags: JSON.parse(row.flags) as string[],
              sentinel: row.sentinel === 1,
            })),
          );
          expect(result.truncated).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("over-limit requests clamp to MAX_LIMIT in both engines", () => {
    const result = queryProfiles({ field: "vol", limit: MAX_LIMIT + 25 });
    const rows = db
      .query(
        "SELECT id FROM profiles WHERE sentinel = 0 ORDER BY vol DESC, id ASC LIMIT ?",
      )
      .all(MAX_LIMIT) as { id: string }[];
    expect(result.rows.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(result.truncated).toBe(true);
  });
});
