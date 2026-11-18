import { describe, expect, test } from "bun:test";
import { afterAll } from "bun:test";
import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSRuntime,
} from "quickjs-emscripten";

import { toGuest } from "../../lib/quickjs_code_mode.ts";

const QuickJS = await getQuickJS();
const runtime: QuickJSRuntime = QuickJS.newRuntime();
const ctx: QuickJSContext = runtime.newContext();

afterAll(() => {
  ctx.dispose();
  runtime.dispose();
});

const roundTrip = (value: unknown): { value: unknown; owned: boolean } => {
  const guest = toGuest(ctx, value);
  try {
    return { value: ctx.dump(guest.handle), owned: guest.owned };
  } finally {
    if (guest.owned) guest.handle.dispose();
  }
};

describe("host -> guest marshalling", () => {
  test("static values are not owned by the caller", () => {
    expect(roundTrip(null)).toEqual({ value: null, owned: false });
    expect(roundTrip(undefined)).toEqual({ value: undefined, owned: false });
    expect(roundTrip(true)).toEqual({ value: true, owned: false });
    expect(roundTrip(false)).toEqual({ value: false, owned: false });
  });

  test("allocated primitives are owned and round-trip", () => {
    expect(roundTrip(0)).toEqual({ value: 0, owned: true });
    expect(roundTrip(-1.5)).toEqual({ value: -1.5, owned: true });
    expect(roundTrip(Number.MAX_SAFE_INTEGER)).toEqual({
      value: Number.MAX_SAFE_INTEGER,
      owned: true,
    });
    expect(roundTrip("")).toEqual({ value: "", owned: true });
    expect(roundTrip("λ")).toEqual({ value: "λ", owned: true });
  });

  test("arrays and nested objects round-trip with ownership", () => {
    expect(roundTrip([])).toEqual({ value: [], owned: true });
    expect(roundTrip([1, "a", true, null])).toEqual({
      value: [1, "a", true, null],
      owned: true,
    });
    expect(roundTrip({ a: 1, b: { c: "x", d: [false, null] }, e: [] })).toEqual(
      {
        value: { a: 1, b: { c: "x", d: [false, null] }, e: [] },
        owned: true,
      },
    );
  });

  test("values that cannot be marshalled are rejected", () => {
    expect(() => toGuest(ctx, () => 1)).toThrow(/cannot marshal function/);
    expect(() => toGuest(ctx, Symbol("s"))).toThrow(/cannot marshal symbol/);
    expect(() => toGuest(ctx, 1n)).toThrow(/cannot marshal bigint/);
  });
});
