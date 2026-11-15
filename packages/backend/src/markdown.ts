/**
 * @file packages/backend/src/markdown.ts
 * @description Stat-cached Markdown -> HTML renderer for repo-owned `dashboard.md`.
 */

import { countNonAsciiChars } from "@sportsdesk-ops/contracts";
import { statStamp } from "./cache.ts";

export const DASHBOARD_MARKDOWN_OPTIONS = {
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: true,
  tagFilter: true,
  noHtmlBlocks: true,
  noHtmlSpans: true,
  headings: { autolink: true, ids: true },
  collapseWhitespace: true,
} as const satisfies Bun.markdown.Options;

export interface RenderedDashboardMarkdown {
  readonly stamp: string;
  readonly markdown: string;
  readonly html: string;
  readonly renderDurationMs: number;
  readonly markdownBytes: number;
  readonly htmlBytes: number;
  readonly nonAsciiChars: number;
}

/** Caches parsed `dashboard.md` + `Bun.markdown.html()` output keyed by mtime+size stamp. */
export class DashboardMarkdownCache {
  private readonly markdownPath: string;
  private cached: RenderedDashboardMarkdown | null = null;

  constructor(markdownPath: string) {
    this.markdownPath = markdownPath;
  }

  async load(): Promise<RenderedDashboardMarkdown | null> {
    const stamp = await statStamp(this.markdownPath);
    if (stamp === null) {
      this.cached = null;
      return null;
    }

    if (this.cached === null || this.cached.stamp !== stamp) {
      const markdown = await Bun.file(this.markdownPath).text();
      const startedNs = Bun.nanoseconds();
      // trusted-markdown: local repo-owned dashboard.md rendered for operator dev server
      const html = Bun.markdown.html(markdown, DASHBOARD_MARKDOWN_OPTIONS);
      const renderDurationMs =
        Math.round(((Bun.nanoseconds() - startedNs) / 1_000_000) * 1000) / 1000;
      this.cached = {
        stamp,
        markdown,
        html,
        renderDurationMs,
        markdownBytes: Buffer.byteLength(markdown, "utf8"),
        htmlBytes: Buffer.byteLength(html, "utf8"),
        nonAsciiChars: countNonAsciiChars(markdown),
      };
    }

    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }
}
