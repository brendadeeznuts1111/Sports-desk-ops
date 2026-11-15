import { describe, expect, test } from "bun:test";

import { parseProfileSnapshot } from "../../lib/profile_query_tools.ts";

const profile = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: "P1",
  vol: 10,
  clv: 20,
  sharp: 30,
  flags: ["A"],
  ...overrides,
});

const snapshot = (profiles: unknown): unknown => ({
  schemaVersion: 1,
  profiles,
});

const failure = (raw: unknown): string => {
  try {
    parseProfileSnapshot(raw);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("parseProfileSnapshot did not throw");
};

describe("snapshot loader rejection paths", () => {
  test("rejects a document without a profiles array", () => {
    for (const raw of [undefined, null, 42, "x", {}, { profiles: "x" }, []]) {
      expect(failure(raw)).toContain("missing profiles array");
    }
  });

  test("rejects an unknown or missing schema version", () => {
    expect(failure({ profiles: [] })).toContain("unsupported schemaVersion");
    expect(failure({ schemaVersion: 2, profiles: [] })).toContain(
      "unsupported schemaVersion",
    );
    expect(failure({ schemaVersion: "1", profiles: [] })).toContain(
      "unsupported schemaVersion",
    );
  });

  test("rejects profiles without a usable id", () => {
    expect(failure(snapshot([null]))).toContain("profile #0 has no id");
    expect(failure(snapshot([{ id: 7 }]))).toContain("profile #0 has no id");
    expect(failure(snapshot([{ id: "" }]))).toContain("profile #0 has no id");
  });

  test("rejects ids with surrounding whitespace", () => {
    expect(failure(snapshot([profile({ id: " P1 " })]))).toContain(
      "profile #0 id has surrounding whitespace",
    );
    expect(failure(snapshot([profile({ id: "P1\n" })]))).toContain(
      "surrounding whitespace",
    );
  });

  test("rejects duplicate ids", () => {
    expect(failure(snapshot([profile(), profile({ id: "P1" })]))).toContain(
      "duplicate id P1",
    );
  });

  test("rejects non-finite numeric fields with the profile in the message", () => {
    expect(failure(snapshot([profile({ vol: "10" })]))).toContain(
      "profile snapshot: P1.vol is not a finite number",
    );
    expect(failure(snapshot([profile({ clv: Number.NaN })]))).toContain(
      "profile snapshot: P1.clv is not a finite number",
    );
    expect(failure(snapshot([profile({ sharp: Infinity })]))).toContain(
      "profile snapshot: P1.sharp is not a finite number",
    );
  });

  test("rejects non-string flags", () => {
    expect(failure(snapshot([profile({ flags: "A" })]))).toContain(
      "profile snapshot: P1.flags is not a string array",
    );
    expect(failure(snapshot([profile({ flags: [1] })]))).toContain(
      "profile snapshot: P1.flags is not a string array",
    );
  });
});

describe("snapshot loader success path", () => {
  test("freezes records and their flags", () => {
    const parsed = parseProfileSnapshot(
      snapshot([
        profile({ id: "A", flags: ["X", "Y"] }),
        profile({ id: "B", flags: [] }),
      ]),
    );
    expect(parsed).toHaveLength(2);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0])).toBe(true);
    expect(Object.isFrozen(parsed[0]?.flags)).toBe(true);
    expect(parsed[0]?.flags).toEqual(["X", "Y"]);
    expect(parsed[1]?.flags).toEqual([]);
  });
});
