/**
 * @file tests/bun_semver_wildcards.test.ts
 * @description Contract for `Bun.semver.satisfies` on wildcard ranges and the 2^64 ceiling.
 *
 * Re-measures the table in `docs/bun-upstream-reference.md` ("`Bun.semver.satisfies` —
 * wildcards and the 2^64 ceiling"). The behaviour is deliberately narrower than node-semver:
 * no options object, an unparseable range behaves like `*`, and a numeric part above 2^64-1
 * only poisons the range when it appears before a wildcard.
 */

import { describe, expect, test } from "bun:test";

const satisfies = Bun.semver.satisfies;
/** First value that does not fit in a u64. */
const OVERFLOW = (2n ** 64n).toString();

// @bun-behavior: semver-wildcards

describe("Bun.semver.satisfies wildcard contract", () => {
  test("wildcards fill the missing parts", () => {
    expect(satisfies("1.0.0", "1.0.x")).toBe(true);
    expect(satisfies("1.0.0", "1.x.x")).toBe(true);
    expect(satisfies("1.0.0", "x.x.x")).toBe(true);
    expect(satisfies("1.0.0", "*")).toBe(true);
  });

  test("a range with no parseable part behaves like *", () => {
    expect(satisfies("1.0.0", "")).toBe(true);
    expect(satisfies("1.0.0", "not-a-range")).toBe(true);
  });

  test("a number above 2^64-1 before a wildcard is unsatisfiable", () => {
    expect(satisfies("1.0.0", `${OVERFLOW}.x`)).toBe(false);
    expect(satisfies("1.0.0", OVERFLOW)).toBe(false);
    expect(satisfies("1.0.0", `>${OVERFLOW}`)).toBe(false);
  });

  test("a number after a wildcard is not compared", () => {
    expect(satisfies("1.0.0", `1.x.${OVERFLOW}`)).toBe(true);
    expect(satisfies("1.0.0", `x.${OVERFLOW}`)).toBe(true);
  });

  test("non-ASCII input returns false", () => {
    expect(satisfies("1.0.0", "1.0.0-é")).toBe(false);
  });

  test("prereleases need a prerelease range and options are inert", () => {
    expect(satisfies("1.0.0-beta.1", "^1.0.0")).toBe(false);
    expect(satisfies("1.0.0-beta.1", "^1.0.0-beta.0")).toBe(true);

    // A third argument is not part of the API; node-semver's includePrerelease cannot help.
    const withOptions = Reflect.apply(Bun.semver.satisfies, Bun.semver, [
      "1.0.0-beta.1",
      "^1.0.0",
      { includePrerelease: true },
    ]) as boolean;
    expect(withOptions).toBe(false);
  });
});
