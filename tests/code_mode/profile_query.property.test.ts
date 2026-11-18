import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  getProfileTool,
  isToolError,
  queryProfilesTool,
} from "../../lib/profile_query_tools.ts";
import { MAX_LIMIT, assertMatchesOracle } from "./oracle.ts";

const NUM_RUNS = (() => {
  const raw = Number(process.env.FAST_CHECK_NUM_RUNS);
  return Number.isInteger(raw) && raw > 0 ? raw : 100;
})();

const seed = Number(process.env.FAST_CHECK_SEED);
if (process.env.FAST_CHECK_SEED !== undefined && Number.isInteger(seed)) {
  fc.configureGlobal({ seed });
}

const fieldArbitrary = fc.oneof(
  fc.constantFrom("clv", "vol", "sharp"),
  fc.string(),
  fc.constantFrom(
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "",
    " ",
  ),
);

const limitArbitrary = fc.oneof(
  fc.constantFrom(
    Number.NaN,
    Infinity,
    -Infinity,
    -0,
    0,
    1,
    1.5,
    -1,
    MAX_LIMIT - 1,
    MAX_LIMIT,
    MAX_LIMIT + 1,
  ),
  fc.integer({ min: -10_000, max: 10_000 }),
  fc.double(),
);

const includeArbitrary = fc.oneof(
  fc.boolean(),
  fc.constant(true),
  fc.anything(),
  fc.constant(Symbol("truthy")),
);

const runQuery = async (args: unknown): Promise<unknown> => {
  try {
    return await queryProfilesTool.execute(args);
  } catch (error) {
    return error;
  }
};

describe("query_profiles property oracle", () => {
  test("arbitrary arguments satisfy the frozen oracle", async () => {
    await fc.assert(
      fc.asyncProperty(
        fieldArbitrary,
        limitArbitrary,
        includeArbitrary,
        async (field, limit, includeSentinels) => {
          const args = { field, limit, includeSentinels };
          assertMatchesOracle(await runQuery(args), args);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("an omitted limit equals the default limit and ignores unrelated keys", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("clv", "vol", "sharp"),
        async (field) => {
          const base = await queryProfilesTool.execute({ field });
          const explicit = await queryProfilesTool.execute({
            field,
            limit: MAX_LIMIT,
          });
          const extras = await queryProfilesTool.execute({
            field,
            ignored: { nested: [1, 2, 3] },
            includeSentinels: false,
          });
          expect(explicit).toEqual(base);
          expect(extras).toEqual(base);
          expect(isToolError(base)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("sentinel rows appear only for includeSentinels === true", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("clv", "vol", "sharp"),
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.object(),
          fc.array(fc.anything()),
          fc.boolean(),
        ),
        async (field, includeSentinels) => {
          const result = await queryProfilesTool.execute({
            field,
            includeSentinels,
          });
          const expected = includeSentinels === true;
          expect(result.rows.some((row) => row.sentinel)).toBe(expected);
          expect(result.rows.every((row) => Number.isFinite(row.value))).toBe(
            true,
          );
          expect(result.rows.every((row) => Array.isArray(row.flags))).toBe(
            true,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("query_profiles metamorphic properties", () => {
  const field = fc.constantFrom("clv", "vol", "sharp");

  test("a smaller limit is an exact prefix of a larger one", async () => {
    await fc.assert(
      fc.asyncProperty(
        field,
        fc.integer({ min: 1, max: MAX_LIMIT + 1 }),
        fc.integer({ min: 1, max: MAX_LIMIT + 1 }),
        fc.boolean(),
        async (fieldName, left, right, includeSentinels) => {
          const small = Math.min(left, right);
          const big = Math.max(left, right);
          const a = await queryProfilesTool.execute({
            field: fieldName,
            limit: small,
            includeSentinels,
          });
          const b = await queryProfilesTool.execute({
            field: fieldName,
            limit: big,
            includeSentinels,
          });
          expect(a.rows).toEqual(b.rows.slice(0, a.rows.length));
          expect(a.truncated).toBe(small > MAX_LIMIT);
          expect(b.truncated).toBe(big > MAX_LIMIT);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("default rows are the sentinel-free subsequence of includeSentinels rows", async () => {
    await fc.assert(
      fc.asyncProperty(field, async (fieldName) => {
        const base = await queryProfilesTool.execute({
          field: fieldName,
          limit: MAX_LIMIT,
        });
        const all = await queryProfilesTool.execute({
          field: fieldName,
          limit: MAX_LIMIT,
          includeSentinels: true,
        });
        expect(base.rows).toEqual(all.rows.filter((row) => !row.sentinel));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("repeated queries are deterministic and flags track get_profile", async () => {
    await fc.assert(
      fc.asyncProperty(
        field,
        fc.integer({ min: 1, max: MAX_LIMIT }),
        fc.boolean(),
        async (fieldName, limit, includeSentinels) => {
          const args = { field: fieldName, limit, includeSentinels };
          const first = await queryProfilesTool.execute(args);
          const second = await queryProfilesTool.execute(args);
          expect(second).toEqual(first);
          for (const row of first.rows) {
            const profile = await getProfileTool.execute({ id: row.id });
            expect([...row.flags]).toEqual([...profile.flags]);
            expect(profile.id).toBe(row.id);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
