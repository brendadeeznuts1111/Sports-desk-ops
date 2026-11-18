import { describe, expect, test } from "bun:test";
import {
  DOC_MARKDOWN_PARSE_OPTIONS,
  extractDocMembersFromMarkdown,
} from "./diff-bun-docs-vs-types.ts";

describe("diff-bun-docs-vs-types markdown AST extraction", () => {
  test("DOC_MARKDOWN_PARSE_OPTIONS conforms to Bun.markdown.Options", () => {
    expect(DOC_MARKDOWN_PARSE_OPTIONS.noHtmlBlocks).toBe(true);
    expect(DOC_MARKDOWN_PARSE_OPTIONS.noHtmlSpans).toBe(true);
    expect(DOC_MARKDOWN_PARSE_OPTIONS.tables).toBe(true);

    // Verify partial object forms allowed by @types/bun for autolinks and headings
    const partialOptions = {
      autolinks: { url: true, email: true },
      headings: { ids: true },
    } satisfies Bun.markdown.Options;
    expect(partialOptions.autolinks).toEqual({ url: true, email: true });
    expect(partialOptions.headings).toEqual({ ids: true });
  });

  test("extracts members from code blocks, codespans, tables, headings, and MDX tabs while ignoring prose", () => {
    const md = [
      "# Image & S3 API",
      "## Metadata",
      "### img.crop(10, 10)",
      "## `file.exists()`",
      "",
      "Unbackticked prose mentioning file.fakeProseCall() and filenames like `image.png` or `file.txt` must not match.",
      "",
      "| Member | Return |",
      "| --- | --- |",
      "| `s3file.presign()` | string |",
      "| `img.width` | number |",
      "",
      "<Tabs>",
      '<Tab title="TypeScript">',
      "```ts",
      "const img = Bun.Image.from(bytes);",
      "await img.resize(120, 80);",
      "metadata();",
      "```",
      "Also call `s3File.stat()` or `img.encode({ format: 'webp' })` and `file.json()`.",
      "</Tab>",
      "</Tabs>",
    ].join("\n");

    const members = extractDocMembersFromMarkdown(md, [
      /\b(?:metadata|placeholder)\(\)/g,
    ]);

    expect([...members].sort()).toEqual([
      "crop",
      "encode",
      "exists",
      "from",
      "json",
      "metadata",
      "presign",
      "resize",
      "stat",
      "width",
    ]);
  });
});
