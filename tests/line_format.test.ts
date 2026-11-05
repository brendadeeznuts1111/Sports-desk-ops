import { describe, expect, test } from "bun:test";

import {
  formatPoints,
  formatSpread,
  formatTotal,
  formatTotalPart,
} from "../cli/line.ts";

describe("line formatting", () => {
  test("formatSpread uses the chosen side, not the home side", () => {
    expect(formatSpread(-4.25, -110, "NE", "NE")).toBe("-4½,-4 -110");
    expect(formatSpread(-4.25, -110, "BUF", "NE")).toBe("4½,+4 -110");
    expect(formatSpread(-3, -105, "NE", "NE")).toBe("-3 -105");
    expect(formatSpread(-3, -105, "BUF", "NE")).toBe("+3 -105");
  });

  test("formatTotal never puts a leading plus on the total", () => {
    expect(formatTotal(219.5, -115, "Ov")).toBe("Ov 219½ -115");
    expect(formatTotal(3.25, -110, "Un")).toBe("Un 3,3½ -110");
    expect(formatTotal(0, -110, "Ov")).toBe("Ov PK -110");
  });

  test("formatTotalPart and formatPoints differ only by sign", () => {
    expect(formatTotalPart(4.5)).toBe("4½");
    expect(formatPoints(4.5)).toBe("+4½");
    expect(formatTotalPart(-4.5)).toBe("-4½");
    expect(formatPoints(-4.5)).toBe("-4½");
    expect(formatTotalPart(0)).toBe("PK");
    expect(formatPoints(0)).toBe("PK");
  });
});
