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
    // Reading `.only` throws when CI is truthy (CI=true/1) so a CI run cannot accidentally
    // skip tests; CI=false, CI=0 and unset expose the filter again (measured on 1.4.4).
    const ciGuard = Bun.env.CI === "true" || Bun.env.CI === "1";
    const staticType = (target: unknown, name: string): string => {
      try {
        return typeof (target as Record<string, unknown>)[name];
      } catch (error) {
        return `throws: ${(error as Error).message}`;
      }
    };

    for (const name of [
      "each",
      "skipIf",
      "todo",
      "failing",
      "serial",
      "skip",
      "if",
    ]) {
      expect(staticType(test, name), name).toBe("function");
    }
    for (const [target, label] of [
      [test, "test"],
      [describe, "describe"],
    ] as const) {
      const only = staticType(target, "only");
      if (ciGuard) {
        expect(only, label).toContain("disabled in CI environments");
      } else {
        expect(only, label).toBe("function");
      }
    }
    for (const name of ["each", "skipIf", "skip"]) {
      expect(staticType(describe, name), name).toBe("function");
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
  test("onTestFinished runs after the test body in registration order", () => {
    onTestFinished(() => {
      finished.push("first");
    });
    onTestFinished(() => {
      finished.push("second");
    });
    expect(finished).toEqual([]);
  });

  test("the onTestFinished callbacks from the previous test ran in order", () => {
    expect(finished).toEqual(["first", "second"]);
  });

  test.skipIf(true)("a skipped case does not run", () => {
    throw new Error("test.skipIf(true) must not execute its body");
  });

  test.skipIf(false)("a false condition runs", () => {
    expect(true).toBe(true);
  });

  test.todo("a todo case is not an assertion");
});

describe("bun:test advanced cases", () => {
  test.failing("test.failing accepts an expected failure", () => {
    throw new Error("this failure is the expected outcome");
  });

  test.serial("test.serial runs a case", () => {
    expect(true).toBe(true);
  });

  test.if(true)("test.if(true) runs a case", () => {
    expect(true).toBe(true);
  });

  test("jest.fn records calls and return values", () => {
    const double = jest.fn((value: number) => value * 2);
    expect(double(2)).toBe(4);
    expect(double).toHaveBeenCalledWith(2);
    expect(double).toHaveBeenCalledTimes(1);
  });

  test("asymmetric matchers compare values", () => {
    expect({ value: 3 }).toEqual({ value: expect.any(Number) });
    expect({ value: 3 }).toEqual({ value: expect.anything() });
    expect({ value: 0.1 + 0.2 }).toEqual({
      value: expect.closeTo(0.3, 5),
    });
  });

  test("expectTypeOf is a compile-time assertion", () => {
    expectTypeOf(1).toBeNumber();
    expectTypeOf<string>().toBeString();
  });

  test("mock exposes module and restore", () => {
    expect(typeof mock.module).toBe("function");
    expect(typeof mock.restore).toBe("function");
  });
});
