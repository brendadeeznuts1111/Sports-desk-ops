/**
 * Render the shared dashboard Markdown for the two surfaces the desk actually uses: a browser page
 * (`Bun.markdown.html`) and a terminal (`Bun.markdown.ansi`).
 *
 * The HTML path uses the docs preset (GFM tables, no raw HTML) and wraps the fragment in a small
 * shell with a section index. The ANSI path leaves colours and width to the caller, so the same
 * snapshot works in a narrow terminal, a wide log, and a `--no-color` pipe.
 */
import { DOCS_RENDER_OPTIONS } from "./docs_render_cache.ts";
import {
  buildDashboardMarkdown,
  DASHBOARD_SECTION_ORDER,
  type DashboardSection,
  type DashboardSnapshot,
} from "./dashboard_markdown.ts";

/** Bun's heading-id slug for the section titles this module emits. */
export function dashboardHeadingSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** A full standalone HTML page; `--format html` writes this. */
export function renderDashboardHtml(snapshot: DashboardSnapshot): string {
  const markdown = buildDashboardMarkdown(snapshot);
  // trusted-markdown: the snapshot is built from loopback daemon APIs; raw HTML is disabled by the preset.
  const body = Bun.markdown.html(markdown, DOCS_RENDER_OPTIONS);
  const links = orderedSections(snapshot)
    .map(
      (section) =>
        `<a href="#${dashboardHeadingSlug(section.title)}">${Bun.escapeHTML(section.title)}</a>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SportsDesk &amp; Fantasy402 Dashboard</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #070b14;
        --card: #0d1527;
        --border: #1e293b;
        --text: #f1f5f9;
        --muted: #94a3b8;
        --accent: #38bdf8;
        --warn: #f59e0b;
        --bad: #ef4444;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .shell { max-width: 1280px; margin: 0 auto; padding: 24px; }
      nav.toc {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 14px;
        padding: 10px 14px;
        margin-bottom: 20px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--card);
        font-size: 12px;
      }
      nav.toc a { color: var(--accent); text-decoration: none; }
      nav.toc a:hover { text-decoration: underline; }
      h1 { letter-spacing: -0.03em; margin: 0 0 4px; }
      h2 {
        margin: 32px 0 10px;
        padding-bottom: 6px;
        border-bottom: 1px solid var(--border);
        font-size: 19px;
      }
      h3 { margin: 20px 0 8px; font-size: 15px; color: var(--muted); }
      p, li { color: var(--text); }
      blockquote {
        margin: 8px 0 12px;
        padding: 6px 12px;
        border-left: 3px solid var(--accent);
        color: var(--muted);
        background: color-mix(in srgb, var(--card) 70%, transparent);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        display: block;
        overflow-x: auto;
        font-size: 13px;
        margin: 8px 0 16px;
      }
      th, td { padding: 6px 9px; border: 1px solid var(--border); text-align: left; }
      th { background: var(--card); color: var(--muted); font-size: 11px; text-transform: uppercase; }
      tr:nth-child(even) td { background: color-mix(in srgb, var(--card) 40%, transparent); }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--warn); }
      strong { color: var(--text); }
      a { color: var(--accent); }
      hr { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }
      @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
    </style>
  </head>
  <body>
    <div class="shell">
      <nav class="toc" aria-label="Dashboard sections">${links}</nav>
      <main>${body}</main>
    </div>
  </body>
</html>
`;
}

export interface DashboardAnsiOptions {
  readonly colors?: boolean;
  readonly columns?: number;
  readonly light?: boolean;
}

/** The terminal view; `columns: 0` disables wrapping. */
export function renderDashboardAnsi(
  snapshot: DashboardSnapshot,
  options: DashboardAnsiOptions = {},
): string {
  const colors = options.colors ?? true;
  const columns = options.columns ?? 100;
  return Bun.markdown.ansi(buildDashboardMarkdown(snapshot), {
    colors,
    hyperlinks: colors,
    columns,
    ...(options.light === true ? { light: true } : {}),
  });
}

/** Exactly the sections in render order; exported for tests and callers that build a TOC. */
export function orderedSections(
  snapshot: DashboardSnapshot,
): readonly DashboardSection[] {
  const byId = new Map(
    snapshot.sections.map((section) => [section.id, section]),
  );
  const known = new Set<string>(DASHBOARD_SECTION_ORDER);
  return [
    ...DASHBOARD_SECTION_ORDER.flatMap((id) => {
      const section = byId.get(id);
      return section === undefined ? [] : [section];
    }),
    ...snapshot.sections.filter((section) => !known.has(section.id)),
  ];
}
