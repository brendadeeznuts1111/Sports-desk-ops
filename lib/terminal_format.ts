/**
 * @file lib/terminal_format.ts
 * @description Terminal column arithmetic for CLI reports, on Bun's native text utilities.
 *
 * `String.prototype.length` is UTF-16 code units, not terminal columns. The box-drawing tables in
 * this repo align by columns, so they measure with `Bun.stringWidth` (ANSI, emoji and wide
 * characters aware), wrap with `Bun.wrapAnsi` (which closes and re-opens SGR around each break)
 * and strip with `Bun.stripANSI` (CSI **and** OSC), instead of a local regex.
 *
 * Measured on 1.4.4:
 * - `"\x1b[1mTRACKTHIS\x1b[0m"` is 17 code units, 9 columns.
 * - `Bun.stripANSI` on an OSC 8 hyperlink returns `link` (4 chars); `/\x1b\[[0-9;]*m/g` leaves all
 *   25, and it also leaves non-SGR CSI such as `\x1b[2K`.
 * - `Bun.wrapAnsi("\x1b[1mTRACKTHIS\x1b[0m", 5, { hard: true, wordWrap: false, trim: false })`
 *   answers `"\x1b[1mTRACK\x1b[22m\n\x1b[1mTHIS\x1b[0m"` — every row renders on its own.
 *
 * `ambiguousIsNarrow` is fixed here and passed to both `stringWidth` and `wrapAnsi`, because a
 * measurement and a wrap that disagree let a cell overflow the width it was padded to.
 */

/** Ambiguous-width characters count as one column, in measurement and wrapping alike. */
export const AMBIGUOUS_IS_NARROW = true as const;

export interface DisplayWidthOptions {
  readonly ambiguousIsNarrow?: boolean | undefined;
}

/** Display width in terminal columns (ANSI, emoji and wide characters aware). */
export function displayWidth(
  text: string,
  options: DisplayWidthOptions = {},
): number {
  return Bun.stringWidth(text, {
    ambiguousIsNarrow: options.ambiguousIsNarrow ?? AMBIGUOUS_IS_NARROW,
  });
}

/** Strip every ANSI sequence — CSI and OSC (hyperlinks included). */
export function stripDisplayAnsi(text: string): string {
  return Bun.stripANSI(text);
}

/**
 * Pad to `width` terminal columns. A string already wider is returned unchanged: padding never
 * truncates, because a truncated value in a report is worse than a misaligned cell.
 */
export function padDisplay(
  text: string,
  width: number,
  align: "left" | "right" | "center" = "left",
): string {
  const pad = Math.max(0, width - displayWidth(text));
  if (align === "right") return `${" ".repeat(pad)}${text}`;
  if (align === "center") {
    // An odd gap gives the extra column to the right, matching the markdown tables.
    const left = Math.floor(pad / 2);
    return `${" ".repeat(left)}${text}${" ".repeat(pad - left)}`;
  }
  return `${text}${" ".repeat(pad)}`;
}

export interface WrapDisplayOptions {
  /** Break words that exceed the width. Default `true`. */
  readonly hard?: boolean | undefined;
  /** Wrap at word boundaries. Default `true`. */
  readonly wordWrap?: boolean | undefined;
  /** Trim leading/trailing whitespace per row. Default `true`. */
  readonly trim?: boolean | undefined;
  readonly ambiguousIsNarrow?: boolean | undefined;
}

/**
 * Wrap to a column budget, keeping ANSI state valid on every row.
 *
 * `Bun.wrapAnsi` leaves a fitting string untouched, so only over-wide input pays for a wrap.
 */
export function wrapDisplay(
  text: string,
  width: number,
  options: WrapDisplayOptions = {},
): string[] {
  // A non-positive budget means "do not wrap" (the repo's `--columns=0` convention), not
  // "one column per character".
  if (width <= 0) return [text];
  const columns = Math.max(1, Math.floor(width));
  const ambiguousIsNarrow = options.ambiguousIsNarrow ?? AMBIGUOUS_IS_NARROW;
  if (displayWidth(text, { ambiguousIsNarrow }) <= columns) return [text];
  return Bun.wrapAnsi(text, columns, {
    hard: options.hard ?? true,
    wordWrap: options.wordWrap ?? true,
    trim: options.trim ?? true,
    ambiguousIsNarrow,
  }).split("\n");
}

/**
 * Clip to `width` columns with an ellipsis, never splitting an escape sequence.
 *
 * The clip runs through `Bun.wrapAnsi` with `wordWrap: false`, so a wide character or an SGR run
 * cannot be cut in half; `Bun.wrapAnsi` also closes the active style at the break.
 */
export function clipDisplay(
  text: string,
  width: number,
  ellipsis = "…",
): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  const ellipsisWidth = displayWidth(ellipsis);
  const budget = width - ellipsisWidth;
  if (budget < 1) return ellipsis.slice(0, width);
  const row =
    Bun.wrapAnsi(text, budget, {
      hard: true,
      wordWrap: false,
      trim: false,
      ambiguousIsNarrow: AMBIGUOUS_IS_NARROW,
    }).split("\n")[0] ?? "";
  return `${row}${ellipsis}`;
}
