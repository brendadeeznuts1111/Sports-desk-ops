import { describe, expect, test } from "bun:test";
import {
  formatBuyHandleSharePct,
  formatLegsSettledOpen,
} from "../packages/ui/src/shadow_pricing/shared.tsx";

describe("shadow_pricing shared formatters", () => {
  test("formatBuyHandleSharePct uses handle denominator", () => {
    expect(formatBuyHandleSharePct(25_000, 100_000)).toBe("25.0%");
    expect(formatBuyHandleSharePct(0, 100_000)).toBe("0.0%");
  });

  test("formatLegsSettledOpen splits open legs", () => {
    const row = formatLegsSettledOpen(120, 95);
    expect(row.total).toBe("120");
    expect(row.settled).toBe("95");
    expect(row.open).toBe("25");
  });
});
