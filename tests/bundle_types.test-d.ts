// AUTO-GENERATED from types/features.ts — do not edit.
// Run `bun run gen:features` to regenerate.
import { feature } from "bun:bundle";
import { describe, expectTypeOf, test } from "bun:test";

describe("bun:bundle Registry augmentation", () => {
  test("valid feature flags are narrowed to boolean", () => {
    // NOTE: feature() must appear directly in an if condition or ternary
    // (Bun transpiler AST constraint). Wrap in a ternary when passing to
    // expectTypeOf() so the call site is statically analyzable.
    expectTypeOf(feature("DEBUG") ? true : false).toEqualTypeOf<boolean>();
    expectTypeOf(feature("PROD") ? true : false).toEqualTypeOf<boolean>();
    expectTypeOf(feature("TEST") ? true : false).toEqualTypeOf<boolean>();
    expectTypeOf(feature("ANALYTICS") ? true : false).toEqualTypeOf<boolean>();
    expectTypeOf(
      feature("EXPERIMENTAL") ? true : false,
    ).toEqualTypeOf<boolean>();
    if (feature("DEBUG")) {
    }
    if (feature("PROD")) {
    }
    if (feature("TEST")) {
    }
    if (feature("ANALYTICS")) {
    }
    if (feature("EXPERIMENTAL")) {
    }
  });

  test("invalid feature flags produce compile-time type errors", () => {
    // @ts-expect-error - "DBUG" is a typo, not in Registry["features"]
    if (feature("DBUG")) {
    }

    // @ts-expect-error - "UNKNOWN" is not in Registry["features"]
    if (feature("UNKNOWN")) {
    }
  });
});
