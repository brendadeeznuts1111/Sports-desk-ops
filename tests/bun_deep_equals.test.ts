/**
 * @file tests/bun_deep_equals.test.ts
 * @description Native structural equality contract used by alert dedupe, hierarchy
 * change detection, schema binary round-trips and wager-config change audits.
 *
 * Strict mode is the difference between "same JSON value" and "same own-key shape":
 * `{}` vs `{ a: undefined }`, a hole vs an explicit `undefined`, and a class
 * instance vs a plain literal are unequal only in strict mode.
 */
import { describe, expect, test } from "bun:test";

class Foo {
  a = 1;
}

describe("Bun.deepEquals", () => {
  test("compares nested structures by value", () => {
    const a = { a: 1, b: 2, c: { d: 3 } };
    const b = { a: 1, b: 2, c: { d: 3 } };
    expect(Bun.deepEquals(a, b)).toBe(true);
    expect(Bun.deepEquals(a, { ...b, c: { d: 4 } })).toBe(false);
  });

  test("strict mode distinguishes an undefined property from an omitted one", () => {
    expect(Bun.deepEquals({}, { a: undefined }, true)).toBe(false);
    expect(Bun.deepEquals({}, { a: undefined }, false)).toBe(true);
  });

  test("an extra undefined own key is ignored loose and rejected strict", () => {
    const a = { entries: [1, 2] };
    const b = { entries: [1, 2], extra: undefined };
    expect(Bun.deepEquals(a, b)).toBe(true);
    expect(Bun.deepEquals(a, b, true)).toBe(false);
  });

  test("strict mode distinguishes undefined inside arrays", () => {
    expect(Bun.deepEquals(["asdf"], ["asdf", undefined], true)).toBe(false);
    expect(Bun.deepEquals(["asdf"], ["asdf", undefined], false)).toBe(true);
  });

  test("strict mode distinguishes a sparse array from explicit undefined", () => {
    const sparse: Array<number | undefined> = [];
    sparse[1] = 1; // length 2, index 0 is a hole — not an explicit undefined
    expect(Bun.deepEquals(sparse, [undefined, 1], true)).toBe(false);
    expect(Bun.deepEquals(sparse, [undefined, 1], false)).toBe(true);
  });

  test("expect.toEqual and expect.toStrictEqual mirror the two modes", () => {
    expect({}).toEqual({ a: undefined });
    expect({}).not.toStrictEqual({ a: undefined });

    const withUndefined: Array<string | undefined> = ["asdf", undefined];
    expect(["asdf"] as Array<string | undefined>).toEqual(withUndefined);
    expect(["asdf"]).not.toStrictEqual(withUndefined);

    const sparse: Array<number | undefined> = [];
    sparse[1] = 1;
    expect(sparse).toEqual([undefined, 1]);
    expect(sparse).not.toStrictEqual([undefined, 1]);

    expect(new Foo()).toEqual({ a: 1 });
    expect(new Foo()).not.toStrictEqual({ a: 1 });
    expect(new Foo()).toStrictEqual(Object.assign(new Foo(), { a: 1 }));
  });

  test("strict mode distinguishes a class instance from a plain literal", () => {
    expect(Bun.deepEquals(new Foo(), { a: 1 }, true)).toBe(false);
    expect(Bun.deepEquals(new Foo(), { a: 1 }, false)).toBe(true);
  });
});
