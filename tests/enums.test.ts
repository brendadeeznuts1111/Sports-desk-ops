import { describe, expect, test } from "bun:test";

import { wagerStatusLabel } from "../cli/enums.ts";

describe("wager status labels", () => {
  test("maps W/L/X and defaults to Pending", () => {
    expect(wagerStatusLabel("W")).toBe("Won");
    expect(wagerStatusLabel("L")).toBe("Lost");
    expect(wagerStatusLabel("X")).toBe("Cancelled/Pushed");
    expect(wagerStatusLabel("P")).toBe("Pending");
    expect(wagerStatusLabel(null)).toBe("Pending");
    expect(wagerStatusLabel("")).toBe("Pending");
  });

  test("falls back to the raw code for an unknown status", () => {
    expect(wagerStatusLabel("Z")).toBe("Z");
  });
});
