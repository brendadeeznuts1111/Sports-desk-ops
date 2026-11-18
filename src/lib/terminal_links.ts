/**
 * @file src/lib/terminal_links.ts
 * @description OSC-8 terminal hyperlink and escaped HTML anchor helpers backed by native `Bun.wrapAnsi`, `Bun.stringWidth`, `Bun.stripANSI`, and `Bun.escapeHTML`.
 */

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
  return Bun.wrapAnsi(linked, maxCols, {
    hard: true,
    wordWrap: true,
    trim: false,
  });
}

/** Return visible terminal cell width after stripping ANSI SGR colors and OSC-8 sequences. */
export function visibleLinkWidth(rendered: string): number {
  return Bun.stringWidth(Bun.stripANSI(rendered));
}

/** Render an HTML anchor safely escaping query/fragment characters via `Bun.escapeHTML`. */
export function htmlAnchorLink(url: URL, label: string): string {
  return `<a href="${Bun.escapeHTML(url.href)}">${Bun.escapeHTML(label)}</a>`;
}
