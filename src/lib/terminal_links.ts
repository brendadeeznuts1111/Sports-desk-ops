/**
 * @file src/lib/terminal_links.ts
 * @description OSC-8 terminal hyperlink and escaped HTML anchor helpers. Width, wrap, clip and pad
 * come from `lib/terminal_format.ts`, so a link cell is measured by the same rule as every other
 * table cell in the reports.
 */

import {
  clipDisplay,
  displayWidth,
  padDisplay,
  wrapDisplay,
} from "../../lib/terminal_format.ts";

/** Build an OSC-8 terminal hyperlink without mutating or slicing `url.href`. */
export function osc8Link(url: URL, label: string): string {
  // Never slice url.href; Bun.stringWidth(osc8Link(url, label)) === Bun.stringWidth(label)
  return `\u001b]8;;${url.href}\u0007${label}\u001b]8;;\u0007`;
}

/** Wrap a clickable OSC-8 link cell to `maxCols` while keeping OSC-8 sequences intact on every line. */
export function renderWrappedLinkCell(
  url: URL,
  label: string,
  maxCols: number,
): string {
  const linked = osc8Link(url, label);
  return wrapDisplay(linked, maxCols, {
    hard: true,
    wordWrap: true,
    trim: false,
  }).join("\n");
}

/** Visible terminal cell width; OSC-8 and SGR are zero-width to `Bun.stringWidth`. */
export function visibleLinkWidth(rendered: string): number {
  return displayWidth(rendered);
}

/** Clip or pad an ANSI/OSC-8 string to exactly `targetCols` visible columns. */
export function fitAnsiCols(text: string, targetCols: number): string {
  const target = Math.max(0, Math.floor(targetCols));
  if (target === 0) return "";
  const width = displayWidth(text);
  if (width === target) return text;
  if (width < target) return padDisplay(text, target);
  return clipDisplay(text, target);
}

/** Render an HTML anchor safely escaping query/fragment characters via `Bun.escapeHTML`. */
export function htmlAnchorLink(url: URL, label: string): string {
  return `<a href="${Bun.escapeHTML(url.href)}">${Bun.escapeHTML(label)}</a>`;
}
