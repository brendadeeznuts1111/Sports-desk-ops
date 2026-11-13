/**
 * @file packages/backend/src/markdown.ts
 * @description Stat-cached Markdown -> HTML renderer for repo-owned `dashboard.md`.
 */

import { statStamp } from "./cache.ts";

export interface RenderedDashboardMarkdown {
  readonly stamp: string;
  readonly markdown: string;
  readonly html: string;
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
      // trusted-markdown: local repo-owned dashboard.md rendered for operator dev server
      const html = Bun.markdown.html(markdown);
      this.cached = { stamp, markdown, html };
    }

    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }
}
