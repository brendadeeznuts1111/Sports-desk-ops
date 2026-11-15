/**
 * @file packages/contracts/src/markdown_telemetry.ts
 * @description Browser-safe UTF-8, non-ASCII glyph, and Markdown section telemetry helpers.
 */

const utf8Encoder = new TextEncoder();

export interface MarkdownSectionHeading {
  readonly index: number;
  readonly text: string;
  readonly id: string | null;
}

export interface MarkdownBriefTelemetry {
  readonly title: string | null;
  readonly sections: readonly MarkdownSectionHeading[];
  readonly hasHeadingIds: boolean;
  readonly tableCount: number;
  readonly lineCount: number;
  readonly markdownBytes: number;
  readonly htmlBytes: number;
  readonly nonAsciiChars: number;
}

/** Counts non-ASCII Unicode codepoints, treating surrogate pairs (e.g. emoji) as single glyphs. */
export function countNonAsciiChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) {
      count += 1;
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          i += 1;
        }
      }
    }
  }
  return count;
}

export function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

/** Extracts title, level-2 section outline + HTML ids, table count, UTF-8 sizes, and non-ASCII glyph count. */
export function extractMarkdownTelemetry(
  markdown: string,
  html: string,
  overrides?: {
    readonly markdownBytes?: number;
    readonly htmlBytes?: number;
    readonly nonAsciiChars?: number;
  },
): MarkdownBriefTelemetry {
  const lines = markdown.length === 0 ? [] : markdown.split(/\r?\n/);
  let title: string | null = null;
  const h2Ids: Array<string | null> = [];
  for (const match of html.matchAll(/<h2\b([^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    const idMatch = /\bid=["']([^"']+)["']/i.exec(attrs);
    h2Ids.push(idMatch?.[1] ?? null);
  }

  const sections: MarkdownSectionHeading[] = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (title === null && trimmed.startsWith("# ")) {
      title = trimmed.slice(2).trim();
      continue;
    }
    if (trimmed.startsWith("## ")) {
      const index = sections.length;
      sections.push({
        index,
        text: trimmed.slice(3).trim(),
        id: h2Ids[index] ?? null,
      });
    }
  }

  const tableMatches = html.match(/<table\b/gi);
  return {
    title,
    sections,
    hasHeadingIds: sections.some((section) => section.id !== null),
    tableCount: tableMatches ? tableMatches.length : 0,
    lineCount: lines.length,
    markdownBytes: overrides?.markdownBytes ?? utf8ByteLength(markdown),
    htmlBytes: overrides?.htmlBytes ?? utf8ByteLength(html),
    nonAsciiChars: overrides?.nonAsciiChars ?? countNonAsciiChars(markdown),
  };
}
