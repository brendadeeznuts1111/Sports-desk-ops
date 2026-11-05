import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  assessConfidence,
  confidenceReason,
  inspectPace,
} from "../cli/info.ts";
import { parseArgs } from "../cli/main.ts";

const HTML_FIXTURE = join(import.meta.dir, "fixtures/bet-ticker.html");

describe("capture confidence", () => {
  test("HTML mid-load with ajaxComplete cause is low confidence", async () => {
    const html = await Bun.file(HTML_FIXTURE).text();
    const pace = inspectPace(html);
    expect(pace.cause).toBe("ajaxComplete-restart");
    expect(pace.runningTokens).toBeGreaterThan(50);
    expect(pace.version).toBe("0.4.x");
    expect(pace.verdict).toBe("mid-load");
    expect(
      assessConfidence({
        format: "html",
        statusOk: null,
        hasAmounts: false,
        pace,
      }),
    ).toBe("low");
    expect(
      confidenceReason({
        format: "html",
        statusOk: null,
        hasAmounts: false,
        pace,
      }),
    ).toContain("ajaxComplete restarts");
  });

  test("synthetic initial-load has one token and no restart cause", () => {
    const html = `<body class="pace-running"><div class="pace pace-active"><div class="pace-progress" data-progress="02"></div></div></body>`;
    const pace = inspectPace(html);
    expect(pace.runningTokens).toBe(1);
    expect(pace.cause).toBe("initial-load");
    expect(pace.verdict).toBe("mid-load");
  });

  test("JSON status=1 and amounts is high; missing status is none", () => {
    expect(
      assessConfidence({ format: "json", statusOk: true, hasAmounts: true }),
    ).toBe("high");
    expect(
      assessConfidence({ format: "json", statusOk: true, hasAmounts: false }),
    ).toBe("medium");
    expect(
      assessConfidence({ format: "json", statusOk: null, hasAmounts: true }),
    ).toBe("none");
    expect(
      confidenceReason({ format: "json", statusOk: null, hasAmounts: true }),
    ).toContain("status is missing");
  });

  test("HTML complete is medium", async () => {
    const html = await Bun.file(HTML_FIXTURE).text();
    const pace = {
      ...inspectPace(html),
      verdict: "complete" as const,
      cause: "unknown" as const,
    };
    expect(
      assessConfidence({
        format: "html",
        statusOk: null,
        hasAmounts: false,
        pace,
      }),
    ).toBe("medium");
  });

  test("--require-confidence parses and rejects unknown names", () => {
    const flags = parseArgs([
      "--analyze",
      "--require-confidence=medium",
      "--file=x.html",
    ]);
    expect(flags.requireConfidence).toBe("medium");
    expect(flags.analyze).toBe(true);
    expect(flags.file).toBe("x.html");
    expect(() => parseArgs(["--require-confidence=bogus"])).toThrow();
  });

  test("--lang and --currency-scale validation", () => {
    expect(parseArgs(["--lang=keys", "767465404"]).lang).toBe("keys");
    expect(parseArgs(["--lang=SPANISH", "767465404"]).lang).toBe("SPANISH");
    expect(() => parseArgs(["--lang=KLINGON", "767465404"])).toThrow();
    expect(
      parseArgs(["--currency-scale=0.01", "767465404"]).currencyScale,
    ).toBe(0.01);
    expect(() => parseArgs(["--currency-scale=0"])).toThrow();
  });
});
