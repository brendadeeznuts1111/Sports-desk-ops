import { describe, expect, test } from "bun:test";
import {
  buildFillExpression,
  escapeForExpression,
  formatConsoleEntry,
  waitForLoadState,
  WebViewError,
  type LoadState,
} from "./webview.ts";

/**
 * Pure-helper tests for the WebView wrapper: no browser is launched, so these
 * run on any platform. The live viewport/CDP paths are covered by the
 * darwin-only `tests/bun_webview_screenshot.test.ts` and manual capture runs.
 */

describe("formatConsoleEntry", () => {
  test("maps warn and warning console types to warn", () => {
    for (const type of ["warning", "warn", "WARN", " Warning "]) {
      const line = formatConsoleEntry(type, ["careful"]);
      expect(line.level).toBe("warn");
      expect(line.text).toBe("careful");
    }
  });

  test("maps error to error", () => {
    expect(formatConsoleEntry("error", ["boom"]).level).toBe("error");
    expect(formatConsoleEntry("ERROR", ["boom"]).level).toBe("error");
  });

  test("maps info (and anything unrecognised) to log", () => {
    for (const type of ["info", "log", "debug", ""]) {
      expect(formatConsoleEntry(type, ["note"]).level).toBe("log");
    }
  });

  test("joins arguments, collapses whitespace and redacts credentials", () => {
    const line = formatConsoleEntry("warning", [
      "auth",
      { token: 1 },
      "Bearer abcdefghijklmnop",
    ]);
    expect(line.text.startsWith("auth ")).toBe(true);
    expect(line.text).not.toContain("\n");
    expect(line.text).not.toContain("abcdefghijklmnop");
    expect(line.text).toContain("<redacted:bearer>");
  });
});

describe("escapeForExpression", () => {
  test("JSON-encodes quotes, newlines and backslashes", () => {
    const values = [
      'he said "hi"',
      "line1\nline2\r\t",
      "back\\slash",
      "</script><!--",
      "'; alert(1); //",
      "`${process.exit(1)}`",
    ];
    for (const value of values) {
      const encoded = escapeForExpression(value);
      expect(JSON.parse(encoded)).toBe(value);
      // A raw newline would end the expression's line; JSON escapes it as \\n.
      expect(encoded).not.toContain("\n");
      expect(encoded).not.toContain("\r");
    }
  });
});

describe("buildFillExpression", () => {
  const QUERY = "document.querySelector(";
  const TAIL = "); if (el === null";

  /** Extract the JSON literal passed to `document.querySelector(...)`. */
  const selectorLiteral = (expression: string): string => {
    const start = expression.indexOf(QUERY);
    expect(start).toBeGreaterThan(-1);
    const rest = expression.slice(start + QUERY.length);
    const end = rest.indexOf(TAIL);
    expect(end).toBeGreaterThan(-1);
    return rest.slice(0, end);
  };

  test("encodes a plain selector", () => {
    const expression = buildFillExpression("input[name=email]");
    expect(selectorLiteral(expression)).toBe('"input[name=email]"');
    expect(expression).toContain('el.value = ""');
  });

  test("a selector containing a quote cannot break out of the expression", () => {
    const selector = `input[placeholder="x'); window.pwned = 1; //"]`;
    const expression = buildFillExpression(selector);
    const literal = selectorLiteral(expression);

    // The literal parses back to exactly the selector: nothing escaped the string.
    expect(JSON.parse(literal)).toBe(selector);
    // The hostile payload appears exactly once, inside that literal.
    expect(expression.split("window.pwned").length - 1).toBe(1);
    expect(literal).toContain("window.pwned");
    // Both call sites (clear/focus here, click/type by the caller) stay intact.
    expect(expression.split(QUERY).length - 1).toBe(1);
    expect(expression.endsWith("return true; })()")).toBe(true);
  });

  test("encodes a backslash/quote selector without changing its value", () => {
    const selector = `a[title='back\\slash "quoted"']`;
    expect(JSON.parse(selectorLiteral(buildFillExpression(selector)))).toBe(
      selector,
    );
  });
});

describe("waitForLoadState", () => {
  /** Deterministic clock: `sleep` advances fake time instead of waiting. */
  const fakeClock = (): {
    slept: number[];
    sleep: (ms: number) => Promise<void>;
    now: () => number;
  } => {
    let time = 0;
    const slept: number[] = [];
    return {
      slept,
      sleep: async (ms: number) => {
        slept.push(ms);
        time += ms;
      },
      now: () => time,
    };
  };

  const loading = (overrides: Partial<LoadState> = {}): LoadState => ({
    url: "https://portal.example/",
    title: "",
    loading: true,
    lastNavigatedUrl: null,
    ...overrides,
  });

  test("resolves once the document has loaded and the URL is http(s)", async () => {
    const clock = fakeClock();
    let calls = 0;
    const read = (): LoadState => {
      calls += 1;
      return calls === 1
        ? loading()
        : loading({ title: "Portal", loading: false });
    };

    const settled = await waitForLoadState(
      read,
      { timeoutMs: 1_000, pollMs: 100 },
      clock.sleep,
      clock.now,
    );

    expect(settled).toEqual({
      url: "https://portal.example/",
      title: "Portal",
    });
    expect(calls).toBe(2);
    expect(clock.slept).toEqual([100]);
  });

  test("throws load-timeout when the page never settles", async () => {
    const clock = fakeClock();
    const error = await waitForLoadState(
      () => loading(),
      { timeoutMs: 250, pollMs: 100 },
      clock.sleep,
      clock.now,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WebViewError);
    if (!(error instanceof WebViewError)) return;
    expect(error.code).toBe("load-timeout");
    expect(error.message).toContain("still loading");
    expect(clock.now()).toBeGreaterThanOrEqual(250);
  });

  test("opaque about:blank settles with allowOpaqueUrl even when view.title is empty (WebKit)", async () => {
    const clock = fakeClock();
    const settled = await waitForLoadState(
      () => loading({ url: "about:blank", title: "", loading: false }),
      { allowOpaqueUrl: true },
      clock.sleep,
      clock.now,
    );

    expect(settled).toEqual({ url: "about:blank", title: "" });
  });

  test("about:blank does not settle without allowOpaqueUrl", async () => {
    const clock = fakeClock();
    const error = await waitForLoadState(
      () => loading({ url: "about:blank", title: "Portal", loading: false }),
      { timeoutMs: 200, pollMs: 50 },
      clock.sleep,
      clock.now,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WebViewError);
  });

  test("requireUrlChangeFrom keeps waiting while the URL is unchanged", async () => {
    const clock = fakeClock();
    let calls = 0;
    const read = (): LoadState => {
      calls += 1;
      return calls === 1
        ? loading({ url: "https://portal.example/login", loading: false })
        : loading({
            url: "https://portal.example/dashboard",
            title: "Dashboard",
            loading: false,
          });
    };

    const settled = await waitForLoadState(
      read,
      { requireUrlChangeFrom: "https://portal.example/login" },
      clock.sleep,
      clock.now,
    );

    expect(settled.url).toBe("https://portal.example/dashboard");
    expect(calls).toBe(2);
  });
});
