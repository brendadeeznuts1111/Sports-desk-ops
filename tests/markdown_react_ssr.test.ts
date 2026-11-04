import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import {
  MARKDOWN_SSR_PARSER_OPTIONS,
  markdownText,
  renderMarkdownSsr,
} from "../lib/markdown_react_ssr.ts";

/**
 * The SSR path is `Bun.markdown.react()` → `renderToString()`. These assertions keep the two
 * runtime contracts that matter here: React 18 element symbols (the pinned `react-dom@18` renderer
 * needs `reactVersion: 18`; React 19 elements make it throw) and the repo's parser preset.
 */
describe("Bun.markdown.react SSR", () => {
  test("renders GFM with heading ids and strong emphasis", () => {
    const html = renderMarkdownSsr(markdownText("# Hello **world**"));
    expect(String(html)).toBe(
      '<h1 id="hello-world">Hello <strong>world</strong></h1>',
    );
  });

  test("autolinks are on by default and can be overridden", () => {
    expect(
      String(renderMarkdownSsr(markdownText("Visit www.example.com"))),
    ).toContain('<a href="www.example.com">');
    expect(
      String(
        renderMarkdownSsr(markdownText("Visit www.example.com"), {
          parserOptions: { autolinks: false },
        }),
      ),
    ).not.toContain("<a ");
  });

  test("raw HTML is escaped by default", () => {
    const html = renderMarkdownSsr(markdownText("<script>alert(1)</script>"));
    expect(String(html)).toContain("&lt;script&gt;");
    expect(String(html)).not.toContain("<script>");
  });

  test("the renderer and the element symbol are the same React major", () => {
    // Bun's default element symbol is React 19's; the pinned react-dom@18 refuses it. This is the
    // mismatch that `renderMarkdownSsr` avoids by passing `reactVersion: 18`.
    const legacy = Bun.markdown.react("# x", undefined, { reactVersion: 18 });
    expect(String(renderToString(legacy))).toBe("<h1>x</h1>");
    const current = Bun.markdown.react("# x");
    expect(() => renderToString(current)).toThrow();
  });

  test("a caller cannot switch the React version through parser options", () => {
    const html = renderMarkdownSsr(markdownText("# x"), {
      parserOptions: { reactVersion: 19 } as Bun.markdown.Options,
    });
    expect(String(html)).toBe('<h1 id="x">x</h1>');
  });

  test("the parser preset is the documented GFM shape", () => {
    expect(MARKDOWN_SSR_PARSER_OPTIONS.tables).toBe(true);
    expect(MARKDOWN_SSR_PARSER_OPTIONS.tagFilter).toBe(true);
    expect(MARKDOWN_SSR_PARSER_OPTIONS.headings).toEqual({ ids: true });
    expect(MARKDOWN_SSR_PARSER_OPTIONS.noHtmlBlocks).toBe(true);
    expect(MARKDOWN_SSR_PARSER_OPTIONS.noHtmlSpans).toBe(true);
  });
});
