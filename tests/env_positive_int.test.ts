import { describe, expect, test } from "bun:test";
import { envPositiveInt, parsePositiveInt } from "../lib/env.ts";
import { AGENT_GRAPH_READY_EVAL } from "../lib/f402_agent_graph_capture_page.ts";

/**
 * Numeric environment boundaries.
 *
 * The pattern this replaces was `Number(Bun.env.X ?? 30000)`. For `X=abc` that yields NaN, and
 * the ready predicate `Date.now() > deadline` then never becomes true: the capture promise can
 * never reject, so it hangs until whatever outer timeout gives up. The same shape appeared at
 * nine call sites (viewport sizes, raster bounds, WebP quality, the graph view port).
 */

describe("parsePositiveInt", () => {
  test("absent or blank means the default, and is not a problem", () => {
    expect(parsePositiveInt(undefined, 30000)).toEqual({ value: 30000, problem: null });
    expect(parsePositiveInt("", 30000)).toEqual({ value: 30000, problem: null });
    expect(parsePositiveInt("   ", 30000)).toEqual({ value: 30000, problem: null });
  });

  test("a usable number is floored and accepted", () => {
    expect(parsePositiveInt("2500", 30000)).toEqual({ value: 2500, problem: null });
    expect(parsePositiveInt("1920.9", 1).value).toBe(1920);
    expect(parsePositiveInt(" 42 ", 1).value).toBe(42);
  });

  test("a malformed value falls back and says why", () => {
    for (const raw of ["abc", "NaN", "Infinity", "0", "-5"]) {
      const parsed = parsePositiveInt(raw, 30000, "F402_GRAPH_CAPTURE_TIMEOUT_MS");
      expect(parsed.value).toBe(30000);
      expect(parsed.problem).toContain("F402_GRAPH_CAPTURE_TIMEOUT_MS");
      expect(parsed.problem).toContain(raw);
    }
  });

  test("the fallback is still a finite number, so a deadline can expire", () => {
    const { value } = parsePositiveInt("abc", 30000);
    expect(Number.isFinite(value)).toBe(true);
    expect(Date.now() > Date.now() + value).toBe(false);
    expect(Date.now() > Date.now() - value).toBe(true);
  });
});

describe("envPositiveInt", () => {
  test("reads through the injected reader without touching the real environment", () => {
    const values: Record<string, string> = { F402_GRAPH_VIEWPORT_W: "1280" };
    expect(envPositiveInt("F402_GRAPH_VIEWPORT_W", 1920, (name) => values[name])).toBe(1280);
    expect(envPositiveInt("F402_GRAPH_VIEWPORT_H", 1080, (name) => values[name])).toBe(1080);
  });

  test("a malformed value cannot leak NaN into the caller", () => {
    const value = envPositiveInt("F402_GRAPH_VIEWPORT_H", 1080, () => "tall");
    expect(value).toBe(1080);
    expect(Number.isNaN(value)).toBe(false);
  });
});

describe("the capture page deadline", () => {
  test("the evaluated expression carries a number, never a raw env string", () => {
    // The value is interpolated into page-evaluated JS; `Number(Bun.env…)` used to sit inside it.
    expect(AGENT_GRAPH_READY_EVAL).not.toContain("Bun.env");
    const deadline = /const deadline = Date\.now\(\) \+ (\d+);/.exec(AGENT_GRAPH_READY_EVAL);
    expect(deadline).not.toBeNull();
    expect(Number(deadline?.[1])).toBeGreaterThan(0);
  });
});
