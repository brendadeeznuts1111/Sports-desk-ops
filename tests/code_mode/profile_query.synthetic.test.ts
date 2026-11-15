import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  MAX_LIMIT,
  ToolError,
  parseProfileSnapshot,
  querySnapshot,
  type ProfileField,
  type ProfileRecord,
} from "../../lib/profile_query_tools.ts";

const NUM_RUNS = (() => {
  const raw = Number(process.env.FAST_CHECK_NUM_RUNS);
  return Number.isInteger(raw) && raw > 0 ? raw : 100;
})();

const seed = Number(process.env.FAST_CHECK_SEED);
if (process.env.FAST_CHECK_SEED !== undefined && Number.isInteger(seed)) {
  fc.configureGlobal({ seed });
}

const FIELDS: readonly ProfileField[] = ["clv", "vol", "sharp"];
const isSentinel = (profile: ProfileRecord): boolean =>
  profile.id.startsWith("SYNTH_");

// JSON cannot round-trip -0; normalize it so the round-trip property tests the data model, not
// an IEEE-754 edge that the serialized format cannot represent.
const valueArbitrary = fc
  .oneof(
    fc.constantFrom(0, -1, 1, 2.5, -2.5),
    fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
  )
  .map((value) => (Object.is(value, -0) ? 0 : value));

const profileArbitrary: fc.Arbitrary<ProfileRecord> = fc
  .record({
    id: fc
      .tuple(fc.boolean(), fc.integer({ min: 0, max: 999 }))
      .map(([synthetic, n]) => `${synthetic ? "SYNTH_" : ""}P${n}`),
    vol: valueArbitrary,
    clv: valueArbitrary,
    sharp: valueArbitrary,
    flags: fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
  })
  .map((profile) =>
    Object.freeze({ ...profile, flags: Object.freeze([...profile.flags]) }),
  );

const snapshotArbitrary = fc.uniqueArray(profileArbitrary, {
  selector: (profile) => profile.id,
  maxLength: 40,
});

/** Straightforward model of the contract, written again over the generated snapshot. */
function reference(
  snapshot: readonly ProfileRecord[],
  field: ProfileField,
  includeSentinels: boolean,
  limit: number,
): readonly {
  id: string;
  value: number;
  flags: readonly string[];
  sentinel: boolean;
}[] {
  const rows = snapshot
    .filter((profile) => includeSentinels || !isSentinel(profile))
    .map((profile) => ({
      id: profile.id,
      value: profile[field],
      flags: [...profile.flags],
      sentinel: isSentinel(profile),
    }));
  rows.sort((left, right) => {
    if (left.value !== right.value) return right.value - left.value;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return rows.slice(0, Math.min(limit, MAX_LIMIT));
}

describe("querySnapshot over generated snapshots", () => {
  test("matches the reference model for arbitrary data", () => {
    fc.assert(
      fc.property(
        snapshotArbitrary,
        fc.constantFrom(...FIELDS),
        fc.integer({ min: 1, max: MAX_LIMIT + 1 }),
        fc.boolean(),
        (snapshot, field, limit, includeSentinels) => {
          const result = querySnapshot(snapshot, {
            field,
            limit,
            includeSentinels,
          });
          const expected = reference(snapshot, field, includeSentinels, limit);
          expect(result.field).toBe(field);
          expect(result.rows).toEqual(expected);
          expect(result.truncated).toBe(limit > MAX_LIMIT);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("never mutates the input snapshot and freezes its own result", () => {
    fc.assert(
      fc.property(snapshotArbitrary, (snapshot) => {
        const before = snapshot.map((profile) => ({
          ...profile,
          flags: [...profile.flags],
        }));
        const result = querySnapshot(snapshot, { field: "clv", limit: 10 });
        expect(snapshot).toEqual(before);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.rows)).toBe(true);
        for (const row of result.rows) expect(Object.isFrozen(row)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("empty and all-sentinel snapshots degrade honestly", () => {
    expect(querySnapshot([], { field: "sharp" })).toEqual({
      field: "sharp",
      rows: [],
      truncated: false,
    });
    const syntheticOnly = [
      { id: "SYNTH_A", vol: 1, clv: 2, sharp: 3, flags: [] },
    ] as const;
    expect(querySnapshot(syntheticOnly, { field: "vol" }).rows).toEqual([]);
    expect(
      querySnapshot(syntheticOnly, { field: "vol", includeSentinels: true })
        .rows,
    ).toHaveLength(1);
  });

  test("argument validation is independent of the snapshot", () => {
    const snapshot = [
      { id: "A", vol: 1, clv: 2, sharp: 3, flags: [] },
    ] as const;
    for (const field of ["__proto__", "constructor", "toString", "", " "]) {
      expect(() => querySnapshot(snapshot, { field })).toThrow(ToolError);
    }
    for (const limit of [0, -1, 1.5, Number.NaN, Infinity, "5"]) {
      expect(() => querySnapshot(snapshot, { field: "clv", limit })).toThrow(
        ToolError,
      );
    }
  });
});

describe("argument-object hardening", () => {
  const many = [
    { id: "A", vol: 1, clv: 2, sharp: 3, flags: [] },
    { id: "B", vol: 2, clv: 3, sharp: 4, flags: [] },
    { id: "SYNTH_C", vol: 3, clv: 4, sharp: 5, flags: [] },
  ] as const;

  test("each argument is read exactly once", () => {
    let fieldReads = 0;
    let limitReads = 0;
    let includeReads = 0;
    const args = {
      get field() {
        fieldReads += 1;
        return fieldReads === 1 ? "clv" : "bogus";
      },
      get limit() {
        limitReads += 1;
        return 2;
      },
      get includeSentinels() {
        includeReads += 1;
        return true;
      },
    };
    const result = querySnapshot(many, args);
    expect(fieldReads).toBe(1);
    expect(limitReads).toBe(1);
    expect(includeReads).toBe(1);
    expect(result.field).toBe("clv");
    expect(result.rows.every((row) => Number.isFinite(row.value))).toBe(true);
  });

  test("inherited properties are not arguments", () => {
    const inherited = Object.create({
      field: "clv",
      limit: 1,
      includeSentinels: true,
    }) as Record<string, unknown>;
    expect(() => querySnapshot(many, inherited)).toThrow(ToolError);

    const args = Object.assign(
      Object.create({ limit: 1, includeSentinels: true }),
      {
        field: "vol",
      },
    );
    const result = querySnapshot(many, args);
    // Inherited limit/includeSentinels are ignored: default limit, sentinels excluded.
    expect(result.rows.map((row) => row.id)).toEqual(["B", "A"]);
  });

  test("a null-prototype object with own properties is a valid argument bag", () => {
    const args = Object.assign(Object.create(null), { field: "clv", limit: 2 });
    expect(querySnapshot(many, args).rows).toHaveLength(2);
  });
});

describe("parser round-trip", () => {
  test("JSON serialize -> parse preserves query results for generated snapshots", () => {
    fc.assert(
      fc.property(
        snapshotArbitrary,
        fc.constantFrom(...FIELDS),
        fc.integer({ min: 1, max: MAX_LIMIT }),
        fc.boolean(),
        (snapshot, field, limit, includeSentinels) => {
          const document = {
            schemaVersion: 1,
            profiles: snapshot.map((profile) => ({
              ...profile,
              flags: [...profile.flags],
            })),
          };
          const reparsed = parseProfileSnapshot(
            JSON.parse(JSON.stringify(document)),
          );
          expect(
            querySnapshot(reparsed, { field, limit, includeSentinels }),
          ).toEqual(
            querySnapshot(snapshot, { field, limit, includeSentinels }),
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("row flag immutability", () => {
  test("row flags are frozen copies and cannot mutate the input snapshot", () => {
    const flags = ["a"];
    const snapshot = [{ id: "A", vol: 1, clv: 2, sharp: 3, flags }];
    const result = querySnapshot(snapshot, { field: "vol" });
    expect(Object.isFrozen(result.rows[0]?.flags)).toBe(true);
    expect(() =>
      Reflect.apply(Array.prototype.push, result.rows[0]?.flags, ["b"]),
    ).toThrow();
    expect(flags).toEqual(["a"]);
  });
});
