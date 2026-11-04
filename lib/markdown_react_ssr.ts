/**
 * Server-render trusted Markdown through `Bun.markdown.react()`.
 *
 * The two brands keep the pipeline directional: a `MarkdownText` goes in, a `RenderedHtml` comes
 * out. Passing rendered HTML back into a Markdown parser (or writing Markdown into an HTML sink)
 * is a type error instead of a silently mangled document.
 *
 * The parser has raw HTML disabled, so the output contains only renderer-emitted tags; the brand
 * describes provenance, not a claim that arbitrary HTML is safe.
 *
 * React 18 (or older) clients must render with React 18's `react-dom/server` **and** pass
 * `reactVersion: 18` to `Bun.markdown.react()` — React 19's renderer rejects the legacy element
 * symbol. This module is paired with the installed React 19 renderer and does not expose that
 * switch, because a mismatched renderer throws "Objects are not valid as a React child" at runtime.
 */
import { renderToString } from "react-dom/server";
import type { Brand } from "./brand.ts";

/** Markdown source that has not been rendered yet. */
export type MarkdownText = Brand<string, "MarkdownText">;
/** HTML produced by the Markdown renderer. */
export type RenderedHtml = Brand<string, "RenderedHtml">;

/** Mark any string as Markdown at a boundary (file read, request body, template). */
export function markdownText(value: string): MarkdownText {
  return value as MarkdownText;
}

/** Mark renderer output as HTML at the single construction site. */
export function renderedHtml(value: string): RenderedHtml {
  return value as RenderedHtml;
}

export const MARKDOWN_SSR_PARSER_OPTIONS = {
  tables: true,
  strikethrough: true,
  tasklists: true,
  tagFilter: true,
  autolinks: true,
  headings: { ids: true },
  noHtmlBlocks: true,
  noHtmlSpans: true,
} as const satisfies Bun.markdown.Options;

export interface MarkdownSsrOptions {
  /** Parser overrides; merged over {@link MARKDOWN_SSR_PARSER_OPTIONS}. */
  readonly parserOptions?: Bun.markdown.Options;
}

export function renderMarkdownSsr(
  source: MarkdownText,
  options: MarkdownSsrOptions = {},
): RenderedHtml {
  const parserOptions: Bun.markdown.Options = {
    ...MARKDOWN_SSR_PARSER_OPTIONS,
    ...options.parserOptions,
  };
  const element = Bun.markdown.react(source, undefined, parserOptions);
  return renderedHtml(renderToString(element));
}
