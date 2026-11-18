/**
 * @file tests/bun_test_api.test.ts
 * @description Measured `bun:test` surface for the pinned runtime.
 *
 * The live reference (`/reference/bun/test`) documents functions, interfaces, types and
 * variables; this file checks the runtime half we can observe: module exports, the `test` and
 * `describe` statics, hooks, spies, system time, and the one documented-but-absent pair.
 * Types are covered by `packages/bun-types/test.d.ts` and `expectTypeOf` elsewhere.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  jest,
  mock,
  onTestFinished,
  setSystemTime,
  spyOn,
  test,
  vi,
} from "bun:test";
import * as bunTest from "bun:test";

// @bun-behavior: bun-test-api

const lifecycle: string[] = [];

beforeAll(() => {
  lifecycle.push("beforeAll");
});

beforeEach(() => {
  lifecycle.push("beforeEach");
});

afterAll(() => {
  lifecycle.push("afterAll");
});

describe("bun:test exports", () => {
  test("exports the documented functions", () => {
    const module = bunTest as unknown as Record<string, unknown>;
    for (const name of [
      "describe",
      "test",
      "it",
      "expect",
      "expectTypeOf",
      "beforeAll",
      "afterAll",
      "beforeEach",
      "afterEach",
      "onTestFinished",
      "setDefaultTimeout",
      "setSystemTime",
      "spyOn",
      "mock",
    ]) {
      expect(typeof module[name], name).toBe("function");
    }
    for (const name of ["test", "describe", "it", "expect"]) {
      expect(module[name], name).toBeDefined();
    }
    expect(typeof expectTypeOf).toBe("function");
    expect(typeof mock).toBe("function");
    expect(typeof jest).toBe("object");
    expect(typeof vi).toBe("object");
    expect(typeof it).toBe("function");
  });

  test("does not expose aroundAll or aroundEach on this pin", () => {
    // The live reference lists both; the pinned 1.4.4 runtime does not ship them.
    const module = bunTest as unknown as Record<string, unknown>;
    expect(module.aroundAll).toBeUndefined();
    expect(module.aroundEach).toBeUndefined();
  });
});

describe("bun:test statics", () => {
  test("test and describe expose the table and filter statics", () => {
    for (const name of [
      "each",
      "skipIf",
      "todo",
      "failing",
      "serial",
      "only",
      "skip",
      "if",
    ]) {
      expect(
        typeof (test as unknown as Record<string, unknown>)[name],
        name,
      ).toBe("function");
    }
    for (const name of ["each", "skipIf", "only", "skip"]) {
      expect(
        typeof (describe as unknown as Record<string, unknown>)[name],
        name,
      ).toBe("function");
    }
    for (const name of [
      "extend",
      "assertions",
      "hasAssertions",
      "any",
      "anything",
      "closeTo",
    ]) {
      expect(
        typeof (expect as unknown as Record<string, unknown>)[name],
        name,
      ).toBe("function");
    }
  });
});

describe.each([
  [1, 1, 2],
  [2, 3, 5],
] as const)("describe.each add(%i, %i)", (a, b, sum) => {
  test(`returns ${sum}`, () => {
    expect(a + b).toBe(sum);
  });
});

test.each([
  ["a", 1],
  ["bb", 2],
] as const)("test.each length of %s is %i", (value, length) => {
  expect(value.length).toBe(length);
});

describe("bun:test hooks and controls", () => {
  test("setSystemTime pins and restores Date.now", () => {
    const real = Date.now();
    try {
      setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
      expect(Date.now()).toBe(1_577_836_800_000);
    } finally {
      setSystemTime();
    }
    expect(Math.abs(Date.now() - real)).toBeLessThan(5_000);
  });

  test("spyOn replaces and restores a method", () => {
    const target = { value: () => 1 };
    const spy = spyOn(target, "value").mockReturnValue(2);
    expect(target.value()).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(target.value()).toBe(1);
  });

  const finished: string[] = [];
  test("onTestFinished runs after the test body", () => {
    onTestFinished(() => {
      finished.push("ran");
    });
    expect(finished).toEqual([]);
  });

  test("the onTestFinished callback from the previous test ran", () => {
    expect(finished).toEqual(["ran"]);
  });

  test.skipIf(true)("a skipped case does not run", () => {
    throw new Error("test.skipIf(true) must not execute its body");
  });

  test.skipIf(false)("a false condition runs", () => {
    expect(true).toBe(true);
  });

  test.todo("a todo case is not an assertion");
});
