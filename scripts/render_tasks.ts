#!/usr/bin/env bun
/**
 * @file scripts/render_tasks.ts
 * @description Render `docs/REMAINING_TASKS.md` with Bun's native Markdown renderer.
 *
 * For reading in a terminal, prefer the zero-code loader:
 *   bun ./docs/REMAINING_TASKS.md
 * It renders ANSI without booting the JS VM and honours NO_COLOR/FORCE_COLOR/COLUMNS. The CLI
 * (Rust) and Bun.markdown.ansi() (JS) are separate implementations; do not assume byte parity.
 *
 * This script exists for the HTML artifact and the checkbox gate:
 *   bun run tasks:render --format html --out scratch/remaining-tasks.html
 *   bun run tasks:render --format iframe --out scratch/remaining-tasks.iframe.html
 *   bun run tasks:render --no-color --columns 0
 *   bun run tasks:render --color --columns 100
 *
 * `Bun.markdown.ansi` takes an ANSI theme only (no parser options); parser options go to `html()`.
 *
 * `srcdoc` is decoded once by the HTML parser before its contents are parsed, so escaping only `"`
 * turns the `&lt;img …&gt;` that `noHtml*` produced back into live markup. Always escape `&` first.
 */

const IFRAME_TITLE = "Remaining tasks — SportsDesk ops";

/**
 * Escape HTML for an iframe `srcdoc` attribute.
 *
 * Order matters. The attribute value is entity-decoded before it is parsed as a document, so the
 * `&lt;` sequences that `noHtmlBlocks`/`noHtmlSpans` emit would be decoded back to `<` and become
 * live markup. Escaping `&` first keeps one decode level in place; escaping only `"` does not.
 */
function escapeSrcdoc(html: string): string {
  return html.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function iframeEmbed(html: string): string {
  return `<iframe title="${IFRAME_TITLE}" sandbox srcdoc="${escapeSrcdoc(html)}" style="width:100%;height:80vh;border:0"></iframe>`;
}

const MAX_BYTES = 1_000_000;

const PARSER_OPTIONS = {
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: true,
  // GFM tag filter is defense in depth, not a sanitizer: it escapes a specific tag list but
  // leaves event-handler attributes alone. Raw HTML is disabled below for this trusted doc.
  tagFilter: true,
  noHtmlBlocks: true,
  noHtmlSpans: true,
  // Both fields are required by the type; `true` would also autolink headings.
  headings: { autolink: false, ids: true },
  // Stable HTML for artifact diffs.
  collapseWhitespace: true,
} as const;

function flag(
  args: readonly string[],
  names: readonly string[],
  fallback: string,
): string {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index !== -1 && index + 1 < args.length) return args[index + 1]!;
  }
  return fallback;
}

const args = process.argv.slice(2);
const source = flag(args, ["--source"], "docs/REMAINING_TASKS.md");
const format = flag(args, ["--format"], "ansi");
const outPath = flag(args, ["--out"], "");
const columnsFlag = flag(args, ["--columns"], "");
const noColor = args.includes("--no-color");
const wantColor = args.includes("--color");

if (format !== "ansi" && format !== "html" && format !== "iframe") {
  console.error(`tasks: unknown format "${format}" (ansi|html|iframe)`);
  process.exit(2);
}
if (typeof Bun.markdown?.html !== "function") {
  console.error(
    "tasks: Bun.markdown is unavailable (API is unstable; check the Bun version)",
  );
  process.exit(2);
}

const buffer = await Bun.file(source).arrayBuffer();
if (buffer.byteLength > MAX_BYTES) {
  console.error(
    `tasks: ${source} is ${buffer.byteLength} bytes (limit ${MAX_BYTES}); refusing to parse`,
  );
  process.exit(2);
}
const markdown = new TextDecoder().decode(buffer);

const mdOpen = (markdown.match(/^- \[ \]/gm) ?? []).length;
const mdDone = (markdown.match(/^- \[x\]/gim) ?? []).length;

// The gate runs on HTML regardless of the requested output: CSS/marker changes in ANSI cannot
// hide a task-count drift.
// trusted-markdown: docs/REMAINING_TASKS.md from the repo, counted here and never injected.
const html = Bun.markdown.html(buffer, PARSER_OPTIONS);
const htmlOpen = (html.match(/type="checkbox"(?![^>]*checked)/g) ?? []).length;
const htmlDone = (html.match(/type="checkbox"[^>]*checked/g) ?? []).length;

if (mdOpen !== htmlOpen || mdDone !== htmlDone) {
  console.error(
    `checkbox drift: md ${mdOpen}/${mdDone} vs html ${htmlOpen}/${htmlDone}`,
  );
  process.exit(1);
}

const outIsTTY = process.stdout.isTTY === true;
const forceColor = Bun.env.FORCE_COLOR;
const forcedColor =
  forceColor === "1" ||
  forceColor === "true" ||
  forceColor === "2" ||
  forceColor === "3"
    ? true
    : forceColor === "0"
      ? false
      : undefined;
const color =
  forcedColor ??
  ("NO_COLOR" in Bun.env
    ? false
    : wantColor || (outPath === "" && outIsTTY && Bun.enableANSIColors));
const columns =
  columnsFlag !== ""
    ? Math.max(0, Number(columnsFlag))
    : outIsTTY
      ? (process.stdout.columns ?? 80)
      : 0;

const rendered =
  format === "iframe"
    ? iframeEmbed(html)
    : format === "html"
      ? html
      : (() => {
          if (typeof Bun.markdown.ansi !== "function") {
            console.error("tasks: Bun.markdown.ansi is unavailable");
            process.exit(2);
          }
          const light = Bun.env.COLORFGBG?.endsWith(";15");
          return Bun.markdown.ansi(buffer, {
            colors: !noColor && color,
            columns,
            hyperlinks: outIsTTY,
            kittyGraphics: false,
            ...(light === undefined ? {} : { light }),
          });
        })();

if (outPath !== "") {
  await Bun.write(outPath, rendered);
  console.error(`render: ${format} -> ${outPath} (${rendered.length} bytes)`);
} else {
  process.stdout.write(rendered);
  console.error(`render: ${format} (${rendered.length} bytes)`);
}

const pad = (label: string, width: number): string =>
  label + " ".repeat(Math.max(0, width - Bun.stringWidth(label)));
const summary = `${pad("open", 5)} ${mdOpen}   ${pad("done", 5)} ${mdDone}   (${mdOpen + mdDone} checkboxes)`;
console.error(Bun.wrapAnsi(summary, columns || 80));
