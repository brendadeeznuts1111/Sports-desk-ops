import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("WebLog dashboard panel", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  test("renders the five-bridge status bar and Mode 6 panel", () => {
    for (const id of [
      "weblog-panel",
      "bridge-status",
      "bridge-1-status",
      "bridge-3a-status",
      "bridge-3b-status",
      "bridge-3c-status",
      "weblog-status",
      "wl-gates",
      "wl-matched",
      "wl-quantiles",
      "wl-flags",
      "wl-net-table",
    ])
      expect(html).toContain(`id="${id}"`);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('<th scope="col">Class</th>');
  });

  test("reads the rollup from the existing authed KPI route", () => {
    expect(html).toContain('authed("/api/kpis"');
    expect(html).not.toContain('fetch("/api/weblog');
    expect(html).not.toContain("/api/weblog/latest");
  });

  test("keeps all JS changes in the primary script block", () => {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const withPanel = blocks.filter((b) => b[1]?.includes("wl-net-table"));
    expect(withPanel).toHaveLength(1);
    expect(withPanel[0]?.[1]).toContain('document.getElementById("live-desk")');
  });
});
