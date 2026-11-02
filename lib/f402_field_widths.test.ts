import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CUSTOMER_ID_CANONICAL_WIDTH,
  LOG_WRITE_CUSTOMER_ID_WIDTH,
  SPORT_FIELD_WIDTH,
  TICKER_AGENT_ID_WIDTH,
  isPadded,
  padField,
} from "./f402_field_widths.ts";

describe("padField", () => {
  test("pads with spaces to the width, after trimming", () => {
    expect(padField("Football", 20)).toBe("Football".padEnd(20, " "));
    expect(padField("  Football  ", 20)).toBe("Football".padEnd(20, " "));
    expect(padField("Football", 20)).toHaveLength(20);
  });

  test("never truncates a value that already exceeds the width", () => {
    // Silent slices are how a longer login becomes a wrong identifier. Callers validate instead.
    const long = "A".repeat(30);
    expect(padField(long, 20)).toBe(long);
    expect(padField(long, 20)).toHaveLength(30);
  });

  test("a value exactly at the width is returned unchanged", () => {
    const exact = "A".repeat(20);
    expect(padField(exact, 20)).toBe(exact);
  });

  test("an empty value pads to all spaces, which is still a valid width", () => {
    expect(padField("", 10)).toBe(" ".repeat(10));
  });
});

describe("isPadded", () => {
  test("detects the portal's trailing padding", () => {
    expect(isPadded("BILLY666".padEnd(50, " "))).toBe(true);
    expect(isPadded("BILLY666")).toBe(false);
    expect(isPadded("on ")).toBe(true);
    expect(isPadded("off")).toBe(false);
  });
});

describe("the widths themselves", () => {
  test("carry the values this repo has measured", () => {
    // 20 is pinned by four observed sport paddings; 50 by the ticker config response.
    expect(SPORT_FIELD_WIDTH).toBe(20);
    expect(TICKER_AGENT_ID_WIDTH).toBe(50);
  });

  test("carry the two unconfirmed widths separately, so they can be revised alone", () => {
    // 11 is a spec claim for updateByColumn; 10 is the runbook's Log/write note, contradicted by the
    // 2026-11-01 observation. They are distinct constants on purpose: one being wrong must not
    // silently change the other.
    expect(CUSTOMER_ID_CANONICAL_WIDTH).toBe(11);
    expect(LOG_WRITE_CUSTOMER_ID_WIDTH).toBe(10);
    expect(CUSTOMER_ID_CANONICAL_WIDTH).not.toBe(LOG_WRITE_CUSTOMER_ID_WIDTH);
  });

  test("every width is a positive integer", () => {
    for (const width of [
      SPORT_FIELD_WIDTH,
      TICKER_AGENT_ID_WIDTH,
      CUSTOMER_ID_CANONICAL_WIDTH,
      LOG_WRITE_CUSTOMER_ID_WIDTH,
    ]) {
      expect(Number.isInteger(width)).toBe(true);
      expect(width).toBeGreaterThan(0);
    }
  });

  test("the module documents which widths are measured and which are claims", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "f402_field_widths.ts"),
      "utf8",
    );
    expect(source).toContain("Measured");
    expect(source).toContain("Claims");
    expect(source).toContain("Contradicted on");
  });
});
