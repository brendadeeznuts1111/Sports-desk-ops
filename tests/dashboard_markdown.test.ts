import { describe, expect, test } from "bun:test";
import {
  buildDashboardMarkdown,
  markdownCell,
  markdownTable,
  type DashboardSnapshot,
} from "../lib/dashboard_markdown.ts";
import {
  dashboardHeadingSlug,
  renderDashboardAnsi,
  renderDashboardHtml,
} from "../lib/dashboard_render.ts";

const snapshot: DashboardSnapshot = {
  generatedAt: "2026-11-04T18:00:00.000Z",
  source: "http://127.0.0.1:4020",
  sections: [
    {
      id: "admin",
      title: "Telegram & Bot Activity",
      group: "admin",
      state: "locked",
      provenance: "source: /api/telegram/status",
      body: ["> LOCKED. Set `SPORTSDESK_ADMIN_TOKEN`."],
    },
    {
      id: "headline",
      title: "Headline",
      group: "headline",
      state: "measured",
      provenance: "source: /api/kpis",
      body: markdownTable(
        ["Metric", "Value"],
        [
          ["Open wagers", "250"],
          ["A | B", "line\nbreak"],
        ],
      ),
    },
    {
      id: "live-wagers",
      title: "Live Wagers — Bet Ticker",
      group: "markets",
      state: "measured",
      body: ["> showing 25 of 300"],
    },
  ],
};

describe("dashboard Markdown", () => {
  test("orders sections operationally, regardless of snapshot order", () => {
    const markdown = buildDashboardMarkdown(snapshot);
    const headline = markdown.indexOf("## Headline");
    const wagers = markdown.indexOf("## Live Wagers");
    const admin = markdown.indexOf("## Telegram & Bot Activity");
    expect(headline).toBeGreaterThan(-1);
    expect(wagers).toBeGreaterThan(headline);
    expect(admin).toBeGreaterThan(wagers);
  });

  test("every section is an H2 with a status line", () => {
    const markdown = buildDashboardMarkdown(snapshot);
    expect(markdown.match(/^## /gm)).toHaveLength(3);
    expect(markdown).toContain("**Status:** MEASURED");
    expect(markdown).toContain("**Status:** LOCKED");
    expect(markdown).toContain("> source: /api/kpis");
  });

  test("table cells escape pipes and collapse newlines", () => {
    expect(markdownCell("a | b\nc")).toBe("a \\| b c");
    const table = markdownTable(["A"], [["x|y"]]).join("\n");
    expect(table).toContain("x\\|y");
  });

  test("HTML rendering uses the same Markdown, with a TOC and GFM table", () => {
    const html = renderDashboardHtml(snapshot);
    expect(html).toContain("SportsDesk &amp; Fantasy402 Dashboard</h1>");
    expect(html).toContain('<h2 id="headline">Headline</h2>');
    expect(html).toContain("<table>");
    expect(html).toContain('href="#headline"');
    expect(html.indexOf('href="#headline"')).toBeLessThan(
      html.indexOf('href="#live-wagers-bet-ticker"'),
    );
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("## Headline");
  });

  test("ANSI rendering is the same document without Markdown syntax", () => {
    const ansi = renderDashboardAnsi(snapshot, { colors: false, columns: 0 });
    expect(ansi).toContain("SportsDesk & Fantasy402 Dashboard");
    expect(ansi).toContain("Headline");
    expect(ansi).toContain("MEASURED");
    expect(ansi).toContain("Open wagers");
    expect(ansi).not.toContain("## Headline");
    expect(ansi).not.toContain("**Status:**");
  });

  test("heading slugs match Bun's generated ids", () => {
    for (const title of [
      "Headline",
      "Live Wagers — Bet Ticker",
      "High-Exposure Accounts — Watch List",
      "Telegram & Bot Activity",
    ]) {
      const generated = Bun.markdown.html(`## ${title}`, {
        headings: { ids: true },
      });
      const id = /id="([^"]+)"/.exec(generated)?.[1];
      expect(id).toBeString();
      if (id === undefined) throw new Error(`no heading id for ${title}`);
      expect(dashboardHeadingSlug(title)).toBe(id);
    }
  });
});
