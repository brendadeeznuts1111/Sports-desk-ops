import { describe, expect, test } from "bun:test";
import {
  detectF402ReportHtml,
  F402ReportKindError,
  requireF402ReportHtml,
} from "./f402_report_html.ts";

const gradedUrls = [
  "../tests/fixtures/f402-graded-wager-rows.html",
  "../tests/fixtures/f402-graded-wager-row-e-1072619695.html",
  "../tests/fixtures/f402-graded-wager-rows-g.html",
];
const pendingUrl = "../tests/fixtures/pending-panel-datatables-2026-11-03.html";

describe("detectF402ReportHtml", () => {
  test("identifies every graded fixture by its net-amount cell", async () => {
    for (const fixture of gradedUrls) {
      const html = await Bun.file(new URL(fixture, import.meta.url)).text();
      expect(detectF402ReportHtml(html)).toBe("graded");
    }
  });

  test("identifies the pending panel by its win cells and totals", async () => {
    const html = await Bun.file(new URL(pendingUrl, import.meta.url)).text();
    expect(detectF402ReportHtml(html)).toBe("pending");
  });

  test("refuses to guess on anything else", () => {
    expect(detectF402ReportHtml("")).toBe("unknown");
    expect(detectF402ReportHtml("<div>no table</div>")).toBe("unknown");
    expect(detectF402ReportHtml("<table><tbody></tbody></table>")).toBe(
      "unknown",
    );
  });
});

describe("requireF402ReportHtml", () => {
  test("passes matching pages through untouched", async () => {
    const graded = await Bun.file(
      new URL(gradedUrls[0]!, import.meta.url),
    ).text();
    expect(requireF402ReportHtml(graded, "graded")).toBe(graded);
    const pending = await Bun.file(new URL(pendingUrl, import.meta.url)).text();
    expect(requireF402ReportHtml(pending, "pending")).toBe(pending);
  });

  test("a graded page at the pending gate names the actual shape", async () => {
    const graded = await Bun.file(
      new URL(gradedUrls[0]!, import.meta.url),
    ).text();
    expect(() => requireF402ReportHtml(graded, "pending")).toThrow(
      F402ReportKindError,
    );
    expect(() => requireF402ReportHtml(graded, "pending")).toThrow(
      "looks like a graded page",
    );
  });

  test("a pending page at the graded gate names the actual shape", async () => {
    const pending = await Bun.file(new URL(pendingUrl, import.meta.url)).text();
    expect(() => requireF402ReportHtml(pending, "graded")).toThrow(
      "looks like a pending page",
    );
  });

  test("an unrecognizable page says so instead of failing on a field", () => {
    expect(() =>
      requireF402ReportHtml("<div>no table</div>", "graded"),
    ).toThrow("no graded contract markers found");
  });
});
