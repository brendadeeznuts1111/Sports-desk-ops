import { describe, expect, test } from "bun:test";

import { assertQueryInvariants, oracleQuery } from "./oracle.ts";

describe("oracle argument semantics", () => {
  test("reads field once", () => {
    let reads = 0;
    const args = {
      get field() {
        reads += 1;
        return reads === 1 ? "clv" : "bogus";
      },
    };
    const outcome = oracleQuery(args);
    expect(reads).toBe(1);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.field).toBe("clv");
    expect(outcome.result.rows.every((row) => Number.isFinite(row.value))).toBe(
      true,
    );
  });

  test("reads limit once and derives truncation from that read", () => {
    let reads = 0;
    const args = {
      field: "clv",
      get limit() {
        reads += 1;
        return reads === 1 ? 1 : 501;
      },
    };
    const outcome = oracleQuery(args);
    expect(reads).toBe(1);
    if (!outcome.ok) throw new Error("expected a valid query");
    expect(outcome.result.truncated).toBe(false);
    expect(outcome.result.rows).toHaveLength(1);
  });

  test("inherited properties are not arguments", () => {
    const inherited = Object.create({
      field: "clv",
      limit: 1,
      includeSentinels: true,
    }) as Record<string, unknown>;
    expect(oracleQuery(inherited).ok).toBe(false);

    const args = Object.assign(
      Object.create({ limit: 1, includeSentinels: true }),
      { field: "vol" },
    );
    const outcome = oracleQuery(args);
    if (!outcome.ok) throw new Error("expected a valid query");
    expect(outcome.result.rows.some((row) => row.sentinel)).toBe(false);
    expect(outcome.result.rows.length).toBeGreaterThan(1);
  });

  test("the invariant checker ignores inherited keys too", () => {
    const args = Object.create({ field: "clv" }) as Record<string, unknown>;
    const result = { field: "clv", truncated: false, rows: [] };
    expect(() => assertQueryInvariants(result, args)).toThrow(
      /echo the requested field/,
    );
  });
});
