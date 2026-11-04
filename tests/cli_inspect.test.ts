import { describe, expect, test } from "bun:test";

import { cliInspectOptions, inspectReport } from "../lib/cli_inspect.ts";

const ANSI = "\x1b[";

describe("cliInspectOptions", () => {
  test("sets every Bun.inspect option", () => {
    expect(Object.keys(cliInspectOptions({ isTTY: false }, {})).sort()).toEqual(
      ["colors", "compact", "depth", "sorted"],
    );
  });

  test("colours a terminal only", () => {
    expect(cliInspectOptions({ isTTY: true }, {}).colors).toBe(true);
    expect(cliInspectOptions({ isTTY: false }, {}).colors).toBe(false);
    expect(cliInspectOptions({}, {}).colors).toBe(false);
  });

  test("NO_COLOR turns colour off on a terminal; an empty NO_COLOR does not", () => {
    expect(cliInspectOptions({ isTTY: true }, { NO_COLOR: "1" }).colors).toBe(
      false,
    );
    expect(cliInspectOptions({ isTTY: true }, { NO_COLOR: "" }).colors).toBe(
      true,
    );
  });
});

describe("inspectReport", () => {
  const report = { b: 1, a: { nested: { deeper: ["x"] } }, note: null };

  test("keeps the report's key order and prints one key per line", () => {
    const text = inspectReport(report, cliInspectOptions({ isTTY: false }, {}));
    expect(text.indexOf("b: 1")).toBeLessThan(text.indexOf("a: {"));
    expect(text.split("\n").length).toBeGreaterThan(3);
    expect(text).toContain('deeper: [ "x" ]');
    expect(text).not.toContain(ANSI);
  });

  test("colours when the options say so", () => {
    expect(
      inspectReport(report, cliInspectOptions({ isTTY: true }, {})),
    ).toContain(ANSI);
  });
});
