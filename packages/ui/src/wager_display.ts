/**
 * @file wager_display.ts
 * @description One way to render a wager's selection, line and price.
 *
 * Hydrated F402 rows can carry the whole short description in both `selection`
 * and `lineDisplay` (ticket 769158444: both are `Steelers (Live) +27½ +100`).
 * Concatenating them prints the pick twice, so every renderer goes through this
 * formatter instead of composing the strings itself.
 */

/** The three fields needed to render a pick; structural so any wager row fits. */
import { sanitizeCaptureText } from "./capture_text.ts";

export interface WagerSelectionParts {
  readonly selection: string;
  readonly lineDisplay: string;
  readonly oddsAmerican: string;
}

export interface WagerSelectionOptions {
  /** Append `(odds)`; defaults to true. */
  readonly includeOdds?: boolean | undefined;
}

function collapse(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * True when `lineDisplay` is already visible inside `selection`, compared on
 * collapsed lower-case text at whole-token boundaries — so `Over 47.5` does not
 * swallow a numeric line of `7`.
 */
export function selectionIncludesLine(
  selection: string,
  lineDisplay: string,
): boolean {
  const line = collapse(lineDisplay).toLowerCase();
  if (line.length === 0) return true;
  const pick = collapse(selection).toLowerCase();
  if (pick.length === 0) return false;
  if (pick === line) return true;
  return pick.startsWith(`${line} `) || pick.endsWith(` ${line}`);
}

/**
 * `selection [line] (odds)` with the line printed only once and no dangling
 * separators. Empty input degrades to `—`, never to an empty cell.
 */
export function formatWagerSelection(
  wager: WagerSelectionParts,
  options: WagerSelectionOptions = {},
): string {
  const selection = collapse(sanitizeCaptureText(wager.selection));
  const line = collapse(sanitizeCaptureText(wager.lineDisplay));
  const odds = collapse(sanitizeCaptureText(wager.oddsAmerican));

  const parts: string[] = [];
  if (selection.length > 0) parts.push(selection);
  if (line.length > 0 && !selectionIncludesLine(selection, line)) {
    parts.push(line);
  }

  const base = parts.length > 0 ? parts.join(" ") : "—";
  if (options.includeOdds === false || odds.length === 0) return base;
  return `${base} (${odds})`;
}
