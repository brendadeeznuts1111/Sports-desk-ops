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
 * The element symbol follows the installed React: `Bun.markdown.react()` emits React 19 elements
 * unless `reactVersion` says otherwise, and React 18's renderer throws "Objects are not valid as a
 * React child" on them. `installedReactVersion()` reads the major from the installed package, so the
 * renderer, the pin and this switch cannot disagree. The version is set after the caller's parser
 * options so they cannot override it.
 */
import { renderToString } from "react-dom/server";
import type { Brand } from "./brand.ts";
import { installedReactVersion } from "./react_element_version.ts";

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
  const element = Bun.markdown.react(source, undefined, {
    ...parserOptions,
    reactVersion: installedReactVersion(),
  });
  return renderedHtml(renderToString(element));
}
