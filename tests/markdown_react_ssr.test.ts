import { describe, expect, test } from "bun:test";
import {
  MARKDOWN_REACT_OPTIONS,
  renderMarkdownReactToHtml,
} from "../lib/markdown_react_ssr.ts";

/**
 * The SSR path is `Bun.markdown.react()` → `renderToString()`. These assertions keep the two
 * runtime contracts that matter here: React 19 element symbols (a React 18 renderer needs its own
 * `renderToString` and `reactVersion: 18`) and the repo's parser preset.
 */
describe("Bun.markdown.react SSR", () => {
  test("renders GFM with heading ids and strong emphasis", () => {
    const html = renderMarkdownReactToHtml("# Hello **world**");
    expect(html).toBe('<h1 id="hello-world">Hello <strong>world</strong></h1>');
  });

  test("autolinks are on by default and can be overridden", () => {
    expect(renderMarkdownReactToHtml("Visit www.example.com")).toContain(
      '<a href="www.example.com">',
    );
    expect(
      renderMarkdownReactToHtml("Visit www.example.com", {
        options: { autolinks: false },
      }),
    ).not.toContain("<a ");
  });

  test("raw HTML is escaped by default", () => {
    const html = renderMarkdownReactToHtml("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  test("the parser preset is the documented GFM shape", () => {
    expect(MARKDOWN_REACT_OPTIONS.tables).toBe(true);
    expect(MARKDOWN_REACT_OPTIONS.tagFilter).toBe(true);
    expect(MARKDOWN_REACT_OPTIONS.headings).toEqual({ ids: true });
    expect(MARKDOWN_REACT_OPTIONS.noHtmlBlocks).toBe(true);
    expect(MARKDOWN_REACT_OPTIONS.noHtmlSpans).toBe(true);
  });
});
