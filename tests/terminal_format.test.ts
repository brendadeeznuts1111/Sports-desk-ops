import { describe, expect, test } from "bun:test";

import {
  AMBIGUOUS_IS_NARROW,
  clipDisplay,
  displayWidth,
  padDisplay,
  stripDisplayAnsi,
  wrapDisplay,
} from "../lib/terminal_format.ts";
import { padDisplay as padDisplayFromInspect } from "../lib/cli_inspect.ts";

/**
 * These pin the difference between a UTF-16 length and a terminal column, because the tables
 * that call these helpers align by the latter. Measured on 1.4.4: the bold run below is 17 code
 * units and 9 columns, and a regex restricted to SGR leaves an OSC 8 hyperlink untouched.
 */

const BOLD = "\x1b[1mTRACKTHIS\x1b[0m";
const OSC8 = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";

describe("displayWidth", () => {
  test("counts columns, not code units", () => {
    expect(BOLD.length).toBe(17);
    expect(displayWidth(BOLD)).toBe(9);
    expect(displayWidth("漢字")).toBe(4);
    expect(displayWidth("🎰 win")).toBe(6);
  });

  test("agrees with the shared ambiguous-width rule", () => {
    expect(AMBIGUOUS_IS_NARROW).toBe(true);
    expect(displayWidth("abc")).toBe(
      Bun.stringWidth("abc", { ambiguousIsNarrow: true }),
    );
  });
});

describe("stripDisplayAnsi", () => {
  test("removes OSC 8 hyperlinks and non-SGR CSI, not just SGR", () => {
    expect(stripDisplayAnsi(OSC8)).toBe("link");
    expect(stripDisplayAnsi("\x1b[2Kabc")).toBe("abc");
    // The previous local regex left both of these in the capture.
    // eslint-disable-next-line no-control-regex -- the escape is the input under test
    expect(OSC8.replace(/\x1b\[[0-9;]*m/g, "")).not.toBe("link");
  });
});

describe("padDisplay", () => {
  test("pads by columns on either side", () => {
    expect(padDisplay("ab", 5)).toBe("ab   ");
    expect(padDisplay("ab", 5, "right")).toBe("   ab");
    expect(displayWidth(padDisplay(BOLD, 12))).toBe(12);
    expect(displayWidth(padDisplay(BOLD, 12, "right"))).toBe(12);
  });

  test("never truncates an over-wide value", () => {
    expect(padDisplay("abcdef", 3)).toBe("abcdef");
    expect(padDisplay("漢字", 2)).toBe("漢字");
  });

  test("cli_inspect still exports the same helper", () => {
    expect(padDisplayFromInspect).toBe(padDisplay);
  });
});

describe("clipDisplay", () => {
  test("leaves a fitting value untouched", () => {
    expect(clipDisplay("abc", 3)).toBe("abc");
    expect(clipDisplay("abc", 10)).toBe("abc");
  });

  test("clips to the column budget with one ellipsis column", () => {
    expect(clipDisplay("TRACKTHIS", 5)).toBe("TRAC…");
    expect(displayWidth(clipDisplay("TRACKTHIS", 5))).toBe(5);
    expect(clipDisplay("abc", 1)).toBe("…");
    expect(clipDisplay("abc", 0)).toBe("");
  });

  test("never splits an escape sequence and measures the visible text", () => {
    const clipped = clipDisplay(BOLD, 5);
    expect(displayWidth(clipped)).toBe(5);
    expect(stripDisplayAnsi(clipped)).toBe("TRAC…");
    // The active style is closed at the cut rather than left open.
    expect(clipped).toContain("\x1b[22m");
  });

  test("stops before a wide character that would overflow", () => {
    const clipped = clipDisplay("a漢bcdef", 5);
    expect(displayWidth(clipped)).toBeLessThanOrEqual(5);
    expect(stripDisplayAnsi(clipped)).toBe("a漢b…");
  });
});

describe("wrapDisplay", () => {
  test("a fitting string comes back as one unchanged row", () => {
    const rows = wrapDisplay("abc", 10);
    expect(rows).toEqual(["abc"]);
    expect(rows[0]).toBe("abc");
  });

  test("wraps prose at word boundaries", () => {
    expect(wrapDisplay("The quick brown fox", 10)).toEqual([
      "The quick",
      "brown fox",
    ]);
  });

  test("hard-breaks an unbroken token instead of overflowing", () => {
    const rows = wrapDisplay("x".repeat(25), 10, { wordWrap: false });
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(10);
  });

  test("keeps ANSI state valid on every row", () => {
    const rows = wrapDisplay(BOLD, 5, { wordWrap: false });
    expect(rows).toHaveLength(2);
    // Each row renders on its own: style opened and closed again.
    expect(stripDisplayAnsi(rows[0] ?? "")).toBe("TRACK");
    expect(stripDisplayAnsi(rows[1] ?? "")).toBe("THIS");
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(5);
  });

  test("a column of 0 still yields one row rather than throwing", () => {
    expect(wrapDisplay("abc", 0)).toEqual(["abc"]);
  });
});
