/**
 * @file parse_graded_wagers_html.ts
 * @description Parse Fantasy402 manager graded-wagers DataTables markup into typed JSON.
 *
 * The graded panel is server-rendered markup, not JSON: each wager is a
 * `tr[data-ticket][data-type]` row (see `lib/f402_graded_wager_row.ts` for the
 * contract). This CLI reads one HTML page from a file path (or stdin with `-`
 * / no argument) and prints the validated rows.
 *
 * Usage:
 *   bun scripts/parse_graded_wagers_html.ts page.html
 *   cat page.html | bun scripts/parse_graded_wagers_html.ts
 *   bun scripts/parse_graded_wagers_html.ts - < page.html
 */

import { requireF402ReportHtml } from "../lib/f402_report_html.ts";
import { parseGradedWagerRows } from "../lib/f402_graded_wager_row.ts";

if (import.meta.main) {
  const [path] = Bun.argv.slice(2);
  const html =
    path === undefined || path === "-"
      ? await Bun.stdin.text()
      : await Bun.file(path).text();
  const rows = parseGradedWagerRows(requireF402ReportHtml(html, "graded"));
  console.log(JSON.stringify(rows, null, 2));
}
