import { describe, expect, test } from "bun:test";
import {
  CLASS_D_GSLIVE_GAP_HALT,
  GsliveGapHaltError,
  isPartner118HtmlLoginTrap,
  isGsliveGapHalt,
  validateBetGroupIdMonotonicity,
  assertGsliveReadOnlyBoundary,
} from "../scripts/gslive_tally_bridge3c.ts";

describe("GSLive Bridge 3c Architectural Boundary & Fail-Closed Halts", () => {
  test("GsliveGapHaltError has code CLASS_D_GSLIVE_GAP_HALT and exitCode 2", () => {
    const error = new GsliveGapHaltError("watermark drop detected");
    expect(error.code).toBe(CLASS_D_GSLIVE_GAP_HALT);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain("CLASS_D_GSLIVE_GAP_HALT");
    expect(isGsliveGapHalt(error)).toBe(true);
  });

  test("isPartner118HtmlLoginTrap detects HTML login traps and session expiry", () => {
    expect(
      isPartner118HtmlLoginTrap(
        new Error("an HTML login page means the session expired"),
      ),
    ).toBe(true);
    expect(
      isPartner118HtmlLoginTrap(new Error("HTTP 200 with text/html body")),
    ).toBe(true);
    expect(
      isPartner118HtmlLoginTrap(new Error("<!DOCTYPE html><html>login</html>")),
    ).toBe(true);
    expect(
      isPartner118HtmlLoginTrap(new Error("Connection reset by peer")),
    ).toBe(false);
  });

  test("validateBetGroupIdMonotonicity permits increasing or equal GIDs and throws on regression", () => {
    expect(() => validateBetGroupIdMonotonicity(100, 99)).not.toThrow();
    expect(() => validateBetGroupIdMonotonicity(100, 100)).not.toThrow();
    expect(() => validateBetGroupIdMonotonicity(90, 100)).toThrow(
      GsliveGapHaltError,
    );
  });

  test("assertGsliveReadOnlyBoundary enforces read-only state", () => {
    expect(() => assertGsliveReadOnlyBoundary()).not.toThrow();
  });
});
