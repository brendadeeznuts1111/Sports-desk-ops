/**
 * @file lib/f402_report_html.ts
 * @description Identify which Fantasy402 manager report a markup page holds.
 *
 * The pending panel (`Report/Pending`) and the graded-wagers list wear the same
 * DataTables skin — same table classes, same `.choosen`/`.line-selected`
 * vocabulary — but different contracts. Routing by appearance misidentifies
 * them (a graded page fed to the pending parser dies on a missing `toWin`
 * cell). This module identifies by contract markers instead:
 *
 * - graded rows carry a net-amount cell (`.wager-status-W|L|X`) and no
 *   `to-win`/`total-risk`/`data-account` fields;
 * - pending rows carry separate `to-risk`/`to-win` cells, page totals
 *   (`[data-field="total-risk"]`) and account spans, and no wager-status cell.
 *
 * Pure string predicates: no framework, no parsing, safe to call before
 * choosing a parser.
 */

/** Which report contract a markup page holds, if either is recognizable. */
export type F402ReportKind = "graded" | "pending" | "unknown";

/** Graded net-amount cell, e.g. `<span class="wager-status-W">+$2,000</span>`. */
const GRADED_AMOUNT_CELL = /class="[^"]*\bwager-status-[WLX]\b[^"]*"/i;

/** Pending win cell, totals field, or account span — none exist on graded pages. */
const PENDING_WIN_CELL = /<td[^>]*class="[^"]*\bto-win\b[^"]*"/i;
const PENDING_TOTALS_FIELD = /data-field="total-risk"/;
const PENDING_ACCOUNT_SPAN = /data-account/;

/**
 * Identify the report contract of a markup page by its field markers.
 *
 * Graded is checked first: its net-amount cell exists nowhere on pending
 * pages, while pending markers are absent from graded pages, so the two
 * checks cannot both fire on the shapes seen to date. Anything else —
 * including an empty string — is `"unknown"`, never a guess.
 */
export function detectF402ReportHtml(html: string): F402ReportKind {
  if (GRADED_AMOUNT_CELL.test(html)) return "graded";
  if (
    PENDING_WIN_CELL.test(html) ||
    PENDING_TOTALS_FIELD.test(html) ||
    PENDING_ACCOUNT_SPAN.test(html)
  ) {
    return "pending";
  }
  return "unknown";
}

/** Raised when a page of one report reaches the other report's parser. */
export class F402ReportKindError extends Error {
  constructor(
    readonly expected: Exclude<F402ReportKind, "unknown">,
    readonly actual: F402ReportKind,
  ) {
    super(
      actual === "unknown"
        ? `not a recognizable ${expected} page (no ${expected} contract markers found)`
        : `looks like a ${actual} page, not a ${expected} page`,
    );
    this.name = "F402ReportKindError";
  }
}

/**
 * Guard a parser's entry point: return the html unchanged when it carries the
 * expected contract, otherwise throw a routing error that names the actual
 * shape (or its absence) instead of failing later on a missing field.
 */
export function requireF402ReportHtml(
  html: string,
  expected: Exclude<F402ReportKind, "unknown">,
): string {
  const actual = detectF402ReportHtml(html);
  if (actual !== expected) throw new F402ReportKindError(expected, actual);
  return html;
}
