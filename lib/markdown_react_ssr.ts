/**
 * Server-render trusted Markdown through `Bun.markdown.react()`.
 *
 * `Bun.markdown.react()` returns a React element, so the server pipeline needs `react-dom/server`
 * to produce HTML. This helper is paired with the installed React 19 renderer.
 *
 * React 18 (or older) clients must render with React 18's `react-dom/server` **and** pass
 * `reactVersion: 18` to `Bun.markdown.react()` — React 19's renderer rejects the legacy element
 * symbol. This module deliberately does not expose that switch, because a mismatched renderer
 * throws "Objects are not valid as a React child" at runtime.
 *
 * The default parser options mirror the repo's docs preset (GFM + tagFilter + heading ids) and
 * disable raw HTML: these strings are repo-owned, but the helper is also the obvious sink for
 * future untrusted input.
 */
import { renderToString } from "react-dom/server";

export const MARKDOWN_REACT_OPTIONS = {
  tables: true,
  strikethrough: true,
  tasklists: true,
  tagFilter: true,
  autolinks: true,
  headings: { ids: true },
  noHtmlBlocks: true,
  noHtmlSpans: true,
} as const satisfies Bun.markdown.Options;

export interface MarkdownReactRenderOptions {
  /** Parser overrides; merged over {@link MARKDOWN_REACT_OPTIONS}. */
  readonly options?: Bun.markdown.Options;
}

export function renderMarkdownReactToHtml(
  markdown: string,
  options: MarkdownReactRenderOptions = {},
): string {
  const parserOptions: Bun.markdown.Options = {
    ...MARKDOWN_REACT_OPTIONS,
    ...options.options,
  };
  const element = Bun.markdown.react(markdown, undefined, parserOptions);
  return renderToString(element);
}
