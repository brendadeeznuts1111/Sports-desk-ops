/**
 * @file tests/markdown_table_shape.test.ts
 * @description Every tracked markdown table must render with the same number of
 * cells in each body row as in its header.
 *
 * GFM splits a table cell on `|`, including inside a code span. So a cell like
 *
 *     | `LOGIN | WAGERNUMBER` |
 *
 * silently becomes two cells and the row drifts out of alignment — the document
 * still renders, it just renders wrong, padded to column widths that no longer
 * describe the content. `\|` is the escape. This is the same escape class that
 * `bun fmt` preserves for CSS selectors (`x \|b` must not collapse to `x\|b`,
 * a namespace selector); see the Bun v1.4.4 release notes.
 *
 * Three rows in this repo had already drifted before this gate existed
 * (`docs/runbooks/bun-pm-policy.md`, `docs/design/stream_map.md`,
 * `docs/analysis/defense-measurement-2026-11-03/…`) and were repaired with it.
 *
 * Scope is tracked, shipped documentation. `Scratch/`, `dist/` and `reports/`
 * are working material and are not gated.
 */

import { describe, expect, test } from "bun:test";

const SKIP_PREFIXES = ["Scratch/", "dist/", "reports/"];

function trackedMarkdown(): string[] {
  const proc = Bun.spawnSync(["git", "ls-files", "-z", "*.md"], {
    cwd: `${import.meta.dir}/..`,
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `git ls-files failed (${proc.exitCode}): ${proc.stderr.toString()}`,
    );
  }
  return proc.stdout
    .toString()
    .split("\0")
    .filter((path) => path.length > 0)
    .filter((path) => !SKIP_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

/** Header/body cell counts per table, in document order. */
function tableShapes(
  markdown: string,
): Array<{ header: number; rows: number[] }> {
  const html = Bun.markdown.html(markdown);
  const shapes: Array<{ header: number; rows: number[] }> = [];
  for (const table of html.matchAll(/<table>[\s\S]*?<\/table>/g)) {
    const header = (table[0].match(/<th[\s>]/g) ?? []).length;
    const rows = [...table[0].matchAll(/<tr>[\s\S]*?<\/tr>/g)]
      .filter((tr) => !/<th[\s>]/.test(tr[0]))
      .map((tr) => (tr[0].match(/<td[\s>]/g) ?? []).length);
    shapes.push({ header, rows });
  }
  return shapes;
}

describe("markdown table shape", () => {
  test("a raw pipe inside a code span loses the cell; the escape keeps it", () => {
    // The failure this gate exists to catch, pinned directly. Note that the
    // overflow cell is *dropped*, not flagged, so a cell-count check alone
    // cannot see it — the content assertion below is what distinguishes them.
    const raw = Bun.markdown.html(
      "| a | b |\n| --- | --- |\n| `x | y` | z |\n",
    );
    expect(raw.includes("x | y")).toBe(false);
    // The split leaves the backticks as literal text — visible corruption.
    expect(raw.includes("`x")).toBe(true);

    const escaped = Bun.markdown.html(
      "| a | b |\n| --- | --- |\n| `x \\| y` | z |\n",
    );
    expect(escaped.includes("<code>x | y</code>")).toBe(true);
  });

  test("no tracked table row puts an unescaped pipe inside a code span", async () => {
    const files = trackedMarkdown();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    let rows = 0;

    for (const file of files) {
      const markdown = await Bun.file(`${import.meta.dir}/../${file}`).text();
      const lines = markdown.split("\n");
      for (const [index, line] of lines.entries()) {
        if (!/^\s*\|/.test(line)) continue;
        rows++;
        for (const span of line.matchAll(/`[^`\n]*`/g)) {
          if (/(?<!\\)\|/.test(span[0].slice(1, -1))) {
            offenders.push(`${file}:${index + 1}  ${span[0]}`);
            break;
          }
        }
      }
    }

    expect(rows).toBeGreaterThan(1000);
    expect(offenders).toEqual([]);
  });

  test("every tracked table row has a header's cell count", async () => {
    const files = trackedMarkdown();
    expect(files.length).toBeGreaterThan(0);

    const ragged: string[] = [];
    let tables = 0;
    let rows = 0;

    for (const file of files) {
      const markdown = await Bun.file(`${import.meta.dir}/../${file}`).text();
      if (!markdown.includes("|")) continue;
      const shapes = tableShapes(markdown);
      tables += shapes.length;
      for (const [index, shape] of shapes.entries()) {
        for (const [offset, cells] of shape.rows.entries()) {
          rows++;
          if (cells !== shape.header) {
            ragged.push(
              `${file}: table ${index + 1} row ${offset + 1} has ${cells} cells, header has ${shape.header}`,
            );
          }
        }
      }
    }

    // Zero-data guard: a scan that found nothing must not pass as clean.
    expect(tables).toBeGreaterThan(100);
    expect(rows).toBeGreaterThan(1000);
    expect(ragged).toEqual([]);
  });
});
