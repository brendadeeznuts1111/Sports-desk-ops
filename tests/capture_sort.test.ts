import { describe, expect, test } from "bun:test";

import { detectHtmlSort } from "../cli/info.ts";

describe("HTML table sort detection", () => {
  test("aria-sort marks client order", () => {
    expect(
      detectHtmlSort(
        '<table><tr><th aria-sort="ascending">Time</th></tr></table>',
      ),
    ).toBe("client");
  });

  test("DataTables sorting_asc/desc marks client order", () => {
    expect(
      detectHtmlSort('<table><th class="sorting_desc">Risk</th></table>'),
    ).toBe("client");
  });

  test("a plain table is treated as server order", () => {
    expect(detectHtmlSort("<table><thead><th>Time</th></thead></table>")).toBe(
      "server",
    );
  });

  test("no table is unknown", () => {
    expect(detectHtmlSort("<body></body>")).toBe("unknown");
  });
});
