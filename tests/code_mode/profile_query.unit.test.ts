import { describe, expect, test } from "bun:test";

import {
  MAX_LIMIT,
  ToolError,
  getProfileTool,
  getSummaryTool,
  isProfileSentinel,
  isToolError,
  parseProfileSnapshot,
  queryProfilesTool,
} from "../../lib/profile_query_tools.ts";
import {
  EXPECTED_PROFILE_COUNT,
  EXPECTED_SENTINEL_IDS,
  MAX_LIMIT as ORACLE_MAX_LIMIT,
  firstRegularProfile,
  assertMatchesOracle,
  oracleGetProfile,
  oracleSummary,
  snapshotProfiles,
} from "./oracle.ts";

const SAMPLE_ID = firstRegularProfile().id;

const execute = async (args: unknown): Promise<unknown> => {
  try {
    return await queryProfilesTool.execute(args);
  } catch (error) {
    return error;
  }
};

describe("snapshot and contract constants", () => {
  test("the frozen snapshot has 31 profiles and 4 sentinels", () => {
    expect(snapshotProfiles()).toHaveLength(EXPECTED_PROFILE_COUNT);
    const sentinels = snapshotProfiles()
      .filter((profile) => profile.id.startsWith("SYNTH_"))
      .map((profile) => profile.id)
      .sort();
    expect(sentinels).toEqual([...EXPECTED_SENTINEL_IDS]);
    expect(MAX_LIMIT).toBe(ORACLE_MAX_LIMIT);
  });
});

describe("query_profiles row contract", () => {
  test("the default query returns every non-sentinel row exactly once", async () => {
    const result = await queryProfilesTool.execute({ field: "clv" });
    expect(result.rows).toHaveLength(
      EXPECTED_PROFILE_COUNT - EXPECTED_SENTINEL_IDS.length,
    );
    expect(new Set(result.rows.map((row) => row.id)).size).toBe(
      result.rows.length,
    );
    expect(result.rows.every((row) => !row.sentinel)).toBe(true);
    expect(result.truncated).toBe(false);
    assertMatchesOracle(result, { field: "clv" });
  });

  test("includeSentinels === true adds exactly the sentinel rows", async () => {
    const result = await queryProfilesTool.execute({
      field: "vol",
      includeSentinels: true,
    });
    expect(result.rows).toHaveLength(EXPECTED_PROFILE_COUNT);
    expect(
      result.rows
        .filter((row) => row.sentinel)
        .map((row) => row.id)
        .sort(),
    ).toEqual([...EXPECTED_SENTINEL_IDS]);
    assertMatchesOracle(result, { field: "vol", includeSentinels: true });
  });

  test("every row carries flags from its profile and a boolean sentinel", async () => {
    const result = await queryProfilesTool.execute({
      field: "sharp",
      includeSentinels: true,
    });
    for (const row of result.rows) {
      expect(Array.isArray(row.flags)).toBe(true);
      expect(row.flags.every((flag) => typeof flag === "string")).toBe(true);
      expect(typeof row.sentinel).toBe("boolean");
      const profile = await getProfileTool.execute({ id: row.id });
      expect([...row.flags]).toEqual([...profile.flags]);
      expect(Number.isFinite(row.value)).toBe(true);
    }
  });

  test("rows sort descending by the requested field", async () => {
    for (const field of ["clv", "vol", "sharp"] as const) {
      const result = await queryProfilesTool.execute({
        field,
        includeSentinels: true,
      });
      for (let index = 1; index < result.rows.length; index += 1) {
        expect(result.rows[index - 1]!.value).toBeGreaterThanOrEqual(
          result.rows[index]!.value,
        );
      }
    }
  });

  test("truthy non-booleans do not opt into sentinels", async () => {
    for (const includeSentinels of [
      "yes",
      1,
      {},
      [],
      "true",
      0n,
      Symbol("s"),
    ]) {
      const result = await queryProfilesTool.execute({
        field: "clv",
        includeSentinels,
      });
      expect(result.rows.some((row) => row.sentinel)).toBe(false);
      assertMatchesOracle(result, { field: "clv", includeSentinels });
    }
  });
});

describe("limit clamping and truncation", () => {
  test("limit below MAX_LIMIT truncates rows without flagging truncated", async () => {
    const result = await queryProfilesTool.execute({ field: "clv", limit: 3 });
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(false);
    assertMatchesOracle(result, { field: "clv", limit: 3 });
  });

  test("MAX_LIMIT and MAX_LIMIT+1 differ only in truncated", async () => {
    const atLimit = await queryProfilesTool.execute({
      field: "clv",
      limit: MAX_LIMIT,
    });
    const overLimit = await queryProfilesTool.execute({
      field: "clv",
      limit: MAX_LIMIT + 1,
    });
    expect(overLimit.rows).toEqual(atLimit.rows);
    expect(atLimit.truncated).toBe(false);
    expect(overLimit.truncated).toBe(true);
    assertMatchesOracle(overLimit, { field: "clv", limit: MAX_LIMIT + 1 });
  });

  test("invalid limits are ToolErrors, never coerced", async () => {
    for (const limit of [
      0,
      -1,
      -0,
      1.5,
      Number.NaN,
      Infinity,
      -Infinity,
      "5",
      null,
    ]) {
      const outcome = await execute({ field: "clv", limit });
      expect(isToolError(outcome)).toBe(true);
    }
  });

  test("a huge valid limit is clamped to MAX_LIMIT", async () => {
    const result = await queryProfilesTool.execute({
      field: "clv",
      limit: 1e9,
    });
    expect(result.rows.length).toBeLessThanOrEqual(MAX_LIMIT);
    expect(result.truncated).toBe(true);
  });
});

describe("field validation", () => {
  test("non-contract field names never leak through the prototype chain", async () => {
    for (const field of [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
      "",
      " ",
      "CLV",
      "vol ",
      "net",
    ]) {
      const outcome = await execute({ field });
      expect(isToolError(outcome)).toBe(true);
    }
  });

  test("non-object arguments are ToolErrors", async () => {
    for (const args of [undefined, null, [], "", 42, "vol"]) {
      expect(isToolError(await execute(args))).toBe(true);
    }
  });
});

describe("get_profile and get_profile_summary", () => {
  test("get_profile returns the frozen record and rejects unknown ids", async () => {
    const profile = await getProfileTool.execute({ id: " " + SAMPLE_ID + " " });
    expect(profile.id).toBe(SAMPLE_ID);
    expect(oracleGetProfile(SAMPLE_ID)).toMatchObject(profile);
    await expect(getProfileTool.execute({ id: "NOPE" })).rejects.toThrow(
      /unknown id/,
    );
    await expect(getProfileTool.execute({ id: "  " })).rejects.toThrow(
      /id required/,
    );
  });

  test("returned records are frozen and cannot corrupt the snapshot", async () => {
    const first = await getProfileTool.execute({ id: SAMPLE_ID });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.flags)).toBe(true);
    const second = await getProfileTool.execute({ id: SAMPLE_ID });
    expect(second).toEqual(first);
  });

  test("summary equals the oracle's non-sentinel totals", async () => {
    const summary = await getSummaryTool.execute({});
    expect(summary).toEqual(oracleSummary());
    expect(Number.isFinite(summary.deltaVol)).toBe(true);
    expect(Number.isFinite(summary.deltaNet)).toBe(true);
  });
});

describe("error surface", () => {
  test("isToolError recognizes class and structural errors only", () => {
    expect(isToolError(new ToolError("x"))).toBe(true);
    expect(isToolError({ toolError: true })).toBe(true);
    expect(isToolError({ toolError: false })).toBe(false);
    expect(isToolError(new Error("x"))).toBe(false);
    expect(isToolError(null)).toBe(false);
    expect(isToolError(undefined)).toBe(false);
    expect(isToolError("toolError")).toBe(false);
    expect(isToolError(42)).toBe(false);
  });

  test("limit rejections name the positive-integer rule", async () => {
    await expect(
      queryProfilesTool.execute({ field: "clv", limit: 1.5 }),
    ).rejects.toThrow(/limit must be a positive integer/);
    await expect(
      queryProfilesTool.execute({ field: "clv", limit: Number.NaN }),
    ).rejects.toThrow(/limit must be a positive integer/);
  });

  test("get_profile rejects non-object or blank arguments", async () => {
    for (const args of [
      [],
      42,
      SAMPLE_ID,
      null,
      {},
      { id: 5 },
      { id: "" },
      { id: "   " },
    ]) {
      await expect(getProfileTool.execute(args)).rejects.toThrow(/id required/);
    }
  });

  test("get_profile_summary rejects non-object arguments but accepts absent ones", async () => {
    for (const args of [[], 42, "x", true]) {
      await expect(getSummaryTool.execute(args)).rejects.toThrow(
        /args must be an object/,
      );
    }
    expect(await getSummaryTool.execute(undefined)).toEqual(oracleSummary());
    expect(await getSummaryTool.execute(null)).toEqual(oracleSummary());
  });
});

describe("flag and sentinel semantics", () => {
  const oracleProfile = (id: string) => {
    const result = oracleGetProfile(id);
    if ("error" in result) throw new Error(`oracle has no profile ${id}`);
    return result;
  };

  test("row flags equal the snapshot's flags, not a filtered or empty copy", async () => {
    const expected = oracleProfile(SAMPLE_ID).flags;
    expect(expected.length).toBeGreaterThan(0);
    const profile = await getProfileTool.execute({ id: SAMPLE_ID });
    expect([...profile.flags]).toEqual([...expected]);
    const result = await queryProfilesTool.execute({
      field: "clv",
      includeSentinels: true,
    });
    const row = result.rows.find((entry) => entry.id === SAMPLE_ID);
    expect(row?.flags).toEqual([...expected]);
  });

  test("sentinel state comes from the profile id, not its sort value", () => {
    const sentinel = snapshotProfiles().find((profile) =>
      profile.id.startsWith("SYNTH_"),
    );
    const regular = snapshotProfiles().find(
      (profile) => !profile.id.startsWith("SYNTH_"),
    );
    expect(sentinel).toBeDefined();
    expect(regular).toBeDefined();
    if (sentinel === undefined || regular === undefined) return;
    expect(isProfileSentinel(sentinel)).toBe(true);
    expect(isProfileSentinel(regular)).toBe(false);
  });

  test("equal sort values break ties by ascending id", async () => {
    const result = await queryProfilesTool.execute({
      field: "vol",
      limit: MAX_LIMIT,
      includeSentinels: true,
    });
    const zeros = result.rows
      .filter((row) => row.value === 0)
      .map((row) => row.id);
    expect(zeros.length).toBeGreaterThan(1);
    expect(zeros).toEqual([...zeros].sort());
  });
});

describe("sentinel semantics are state, not value", () => {
  test("a real profile carrying sentinel values is not a sentinel row", () => {
    const parsed = parseProfileSnapshot({
      schemaVersion: 1,
      profiles: [
        { id: "REAL1", vol: 1, clv: -2_147_483_648, sharp: -1, flags: [] },
      ],
    });
    const profile = parsed[0];
    expect(profile).toBeDefined();
    if (profile === undefined) return;
    expect(isProfileSentinel(profile)).toBe(false);
  });
});

describe("get_profile argument hardening", () => {
  test("reads id once and ignores an inherited id", async () => {
    let reads = 0;
    const args = {
      get id() {
        reads += 1;
        return reads === 1 ? SAMPLE_ID : 42;
      },
    };
    const profile = await getProfileTool.execute(args);
    expect(reads).toBe(1);
    expect(profile.id).toBe(SAMPLE_ID);

    const inherited = Object.create({ id: SAMPLE_ID }) as Record<
      string,
      unknown
    >;
    await expect(getProfileTool.execute(inherited)).rejects.toThrow(
      /id required/,
    );
  });
});
