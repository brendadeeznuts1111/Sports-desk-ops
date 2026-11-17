/**
 * @file tests/cdn_rotation_tolerance.test.ts
 * @description The rule that decided whether the nightly pin gate fails (#267).
 *
 * The negative cases matter more than the positive one: this weakens a supply-chain gate, so the
 * only reason to accept it is that everything outside a narrow window still fails.
 */

import { describe, expect, test } from "bun:test";

import {
  ROTATING_VENDOR_ORIGINS,
  isToleratedVendorRotation,
} from "../lib/f402_cdn_pin.ts";

const MAPS = "https://maps.googleapis.com/maps/api/js?key=x";
const FIRST_PARTY = "https://www.fantasy402.com/app/manager.js";

describe("isToleratedVendorRotation", () => {
  test("allowlisted origin with unchanged length is tolerated", () => {
    expect(
      isToleratedVendorRotation({
        url: MAPS,
        pinnedBytes: 331_754,
        liveBytes: 331_754,
      }),
    ).toBe(true);
  });

  test("a length change on the allowlisted origin is still drift", () => {
    // A payload that changes size is a different asset, not a rebundle.
    expect(
      isToleratedVendorRotation({
        url: MAPS,
        pinnedBytes: 331_754,
        liveBytes: 331_800,
      }),
    ).toBe(false);
  });

  test("a first-party origin is never tolerated, even at identical length", () => {
    expect(
      isToleratedVendorRotation({
        url: FIRST_PARTY,
        pinnedBytes: 1_000,
        liveBytes: 1_000,
      }),
    ).toBe(false);
  });

  test("an unparseable URL is never tolerated", () => {
    expect(
      isToleratedVendorRotation({
        url: "not a url",
        pinnedBytes: 1,
        liveBytes: 1,
      }),
    ).toBe(false);
  });

  test("the allowlist is exactly one origin", () => {
    // Guard against a later convenience addition widening a supply-chain gate silently.
    expect([...ROTATING_VENDOR_ORIGINS]).toEqual([
      "https://maps.googleapis.com",
    ]);
  });
});
