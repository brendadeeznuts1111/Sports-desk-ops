import { describe, expect, test } from "bun:test";

import {
  CliInspectCard,
  type CliInspectContext,
  cliInspectOptions,
  inspectReport,
  isCliInspectable,
} from "../lib/cli_inspect.ts";

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

  test("large arrays are bounded in operator reports", () => {
    const text = inspectReport(
      { rows: Array.from({ length: 1000 }, (_, index) => index) },
      cliInspectOptions({ isTTY: false }, {}),
    );
    expect(text).toContain("... 900 more items");
    expect(text.length).toBeLessThan(1_000);
  });

  test("colours when the options say so", () => {
    expect(
      inspectReport(report, cliInspectOptions({ isTTY: true }, {})),
    ).toContain(ANSI);
  });
});

describe("CliInspectCard", () => {
  class Card extends CliInspectCard {
    readonly inspectLabel = "card(label)";
    inspectBody(options: CliInspectContext): string {
      return `card(body, colors=${options.colors})`;
    }
  }

  test("a full inspection renders the body; depth 0 renders the label", () => {
    const card = new Card();
    expect(Bun.inspect(card)).toBe("card(body, colors=false)");
    expect(Bun.inspect(card, { depth: 0 })).toBe("card(label)");
  });

  test("a nested card at depth 0 is a label, not a table dump", () => {
    const text = Bun.inspect({ report: new Card() }, { depth: 1 });
    expect(text).toContain("card(label)");
    expect(text).not.toContain("card(body");
  });

  test("the context is what Bun passes, not the caller's options", () => {
    // Measured on 1.4.4: `{ colors, depth, stylize }`. `sorted`/`compact` are inputs to
    // Bun.inspect and are never forwarded, so a card must not read them.
    let seen: Record<string, unknown> | null = null;
    class Recorder extends CliInspectCard {
      readonly inspectLabel = "recorder";
      inspectBody(options: CliInspectContext): string {
        seen = { ...options };
        return "recorded";
      }
    }
    Bun.inspect(new Recorder(), { depth: 4, sorted: true, compact: true });
    expect(seen).not.toBeNull();
    const keys = Object.keys(seen ?? {}).sort();
    expect(keys).toContain("colors");
    expect(keys).toContain("depth");
    expect(keys).not.toContain("sorted");
    expect(keys).not.toContain("compact");
  });
});

describe("isCliInspectable", () => {
  class Card extends CliInspectCard {
    readonly inspectLabel = "card";
    inspectBody(): string {
      return "card";
    }
  }

  test("recognises a custom-inspect target", () => {
    expect(isCliInspectable(new Card())).toBe(true);
  });

  test("rejects values that would dump their fields", () => {
    for (const value of [null, undefined, 1, "x", {}, [], () => "x"]) {
      expect(isCliInspectable(value)).toBe(false);
    }
  });

  test("a plain object carrying the hook counts, a class is not required", () => {
    const handRolled = {
      [Bun.inspect.custom]: () => "hand-rolled",
    };
    expect(isCliInspectable(handRolled)).toBe(true);
  });
});
