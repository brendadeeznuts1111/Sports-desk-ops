#!/usr/bin/env bun
/**
 * Sort all wagers by state, day, event, player, or agent for a date range.
 *
 * Reads the retained GSLive bet-report export (CSV). All column positions,
 * group dimensions, state ordering, output layout, and defaults come from
 * `config/wagers.json`. The pure pipeline lives in `lib/wagers_report.ts`.
 *
 * "Wager legs" = number of rows sharing the same Bet Group (parlay legs).
 * "Wager number" = the Ticket column.
 *
 * Usage:
 *   bun run scripts/wagers_by_state_last14.ts [--help|-h]
 *   bun run scripts/wagers_by_state_last14.ts --from=M/D/YYYY --to=M/D/YYYY
 *   bun run scripts/wagers_by_state_last14.ts --from=M/D/YYYY --to=M/D/YYYY --state=cancel
 *   bun run scripts/wagers_by_state_last14.ts --from=M/D/YYYY --to=M/D/YYYY --group-by=day
 *   bun run scripts/wagers_by_state_last14.ts --from=M/D/YYYY --to=M/D/YYYY --group-by=event --format=csv
 *   bun run scripts/wagers_by_state_last14.ts --from=M/D/YYYY --to=M/D/YYYY --nlegs=2
 *   bun run scripts/wagers_by_state_last14.ts --from=M/D/YYYY --to=M/D/YYYY --wager-number 1069664168
 *   bun run scripts/wagers_by_state_last14.ts --csv /path/to/bet-report.csv --days 14
 */

import {
  parseWagersFromCsvRows,
  computeGroupSizes,
  parseFilters,
  parseFormat,
  parseGroupBy,
  parseTopArg,
  takeTop,
  groupValue,
  bucketBy,
  parseOutArg,
  splitOutput,
  filterLabels,
  formatElapsed,
  applyFilters,
  sortGroups,
  renderReport,
  parseDateArg,
  reportConfig,
  type WagersConfig,
} from "../lib/wagers_report.ts";

import {
  assertBunFloor,
  writeTextFileIfChanged,
} from "../lib/manager_fetch.ts";
import type { GroupKey, ReportFormat } from "../types/wagers";

/** Minimal RFC-4180 CSV parser (quoted fields, embedded commas/newlines). */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") {
        row.push(cur);
        cur = "";
      } else if (ch === "\n") {
        row.push(cur.replace(/\r$/, ""));
        rows.push(row);
        row = [];
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `Usage: bun run scripts/wagers_by_state_last14.ts [--help|-h] [--from=M/D/YYYY] [--to=M/D/YYYY] [--days=N] [--state=X] [--nlegs=N] [--wager-number N] [--csv=PATH] [--format=table|json|csv|summary|inspect|columns|grid] [--out=PATH] [--group-by=state|day|event|player|agent] [--top=N]

Sort all wagers by state, day, event, player, or agent — data-driven (config/wagers.json).

"Wager legs" = number of rows sharing the same Bet Group (parlay legs).
"Wager number" = the Ticket column.

Options:
  --from=M/D/YYYY   Start date (inclusive)
  --to=M/D/YYYY     End date (inclusive)
  --days=N          Last N days (default from config)
  --state=X         Filter to one state (from config state list)
  --nlegs=N         Filter to N-leg parlay groups
  --wager-number N  Filter to a specific Ticket/wager number
  --csv=PATH        Custom CSV path (default from config)
  --format=F        Output format: table (default), json, csv, summary, inspect, columns, or grid
  --out=PATH        Write the stdout document to PATH as well
  --group-by=G      Dimension: state (default), day, event, player, agent
  --top=N           Show only the first N groups (after sorting)

Exit codes:
  0  success
  1  invalid args, config error, or file read error`,
    );
    return;
  }

  // ---- Load config (single source of truth) ----
  assertBunFloor("wagers-by-state");
  const t0 = Bun.nanoseconds();
  let cfg: WagersConfig;
  try {
    cfg = await reportConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`wagers-by-state: ${message}`);
    process.exit(1);
    return;
  }

  const csvArg = args.find((a) => a.startsWith("--csv="));
  const fromArg = args.find((a) => a.startsWith("--from="));
  const toArg = args.find((a) => a.startsWith("--to="));
  const daysArg = args.find((a) => a.startsWith("--days="));
  const csvPath = csvArg ? csvArg.slice("--csv=".length) : cfg.default.csvPath;
  const defaultDays = cfg.default.days;

  const filters = parseFilters(args, cfg);
  let format: ReportFormat;
  let group: GroupKey;
  let top: number | undefined;
  try {
    format = parseFormat(args, cfg);
    group = parseGroupBy(args, cfg);
    top = parseTopArg(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`wagers-by-state: ${message}`);
    process.exit(1);
    return;
  }
  const groupLabel = cfg.groups[group].label;

  let from: Date | null = null;
  let to: Date | null = null;
  let label = "";

  if (fromArg && toArg) {
    from = parseDateArg(fromArg.slice("--from=".length));
    to = parseDateArg(toArg.slice("--to=".length));
    if (!from || !to) {
      console.error(
        "wagers-by-state: invalid --from/--to date (use M/D/YYYY or YYYY-MM-DD)",
      );
      process.exit(1);
    }
    label = `${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`;
  } else if (daysArg) {
    const days = Number(daysArg.slice("--days=".length));
    if (!days || days < 1) {
      console.error(
        `wagers-by-state: invalid --days value: ${daysArg.slice("--days=".length)}`,
      );
      process.exit(1);
    }
    to = new Date();
    from = new Date(to);
    from.setDate(from.getDate() - days);
    label = `last ${days} days (${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)})`;
  } else {
    to = new Date();
    from = new Date(to);
    from.setDate(from.getDate() - defaultDays);
    label = `last ${defaultDays} days (${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)})`;
  }

  // ---- Read + parse CSV ----
  const text = await Bun.file(csvPath).text();
  const rows = parseCSV(text.replace(/^\uFEFF/, ""));
  const [, ...data] = rows; // skip header

  const fromDay = new Date(from);
  fromDay.setHours(0, 0, 0, 0);
  const toDay = new Date(to);
  toDay.setHours(23, 59, 59, 999);

  const { wagers, shortRow, unparseableTime } = parseWagersFromCsvRows(
    data,
    cfg,
    fromDay,
    toDay,
  );

  // ---- Group sizes (legs) ----
  const groupSize = computeGroupSizes(wagers);

  // ---- Apply filters ----
  const filtered = applyFilters(wagers, groupSize, filters);

  // ---- Bucket + sort (dimension from config) ----
  const buckets = bucketBy(filtered, groupSize, (w) => groupValue(w, group));
  const sorted = takeTop(sortGroups([...buckets.values()], cfg, group), top);

  // ---- Render ----
  const activeLabels = filterLabels(cfg, filters);
  const filterTxt = activeLabels.length ? ` (${activeLabels.join(", ")})` : "";
  const outPath = parseOutArg(args);

  const title = `Wagers by ${groupLabel} — ${label}${filterTxt}`;
  const docLines = renderReport(sorted, cfg, format, group);
  const metaLines = [
    ...(shortRow > 0
      ? [`⚠️  ${shortRow} row(s) were too short and were skipped.`]
      : []),
    ...(unparseableTime > 0
      ? [
          `⚠️  ${unparseableTime} wager(s) had an unparseable Bet Time and were skipped.`,
        ]
      : []),
    `Source: ${csvPath}`,
    `Total rows scanned: ${data.length}`,
    `Wagers in window: ${wagers.length}`,
    `After filters: ${filtered.length}`,
    `Computed in ${formatElapsed(t0, Bun.nanoseconds())}`,
  ];

  const { stdout, stderr } = splitOutput(format, title, docLines, metaLines);
  for (const line of stdout) console.log(line);
  for (const line of stderr) console.error(line);

  if (outPath) {
    const wrote = await writeTextFileIfChanged(
      outPath,
      `${stdout.join("\n")}\n`,
    );
    console.error(wrote ? `wrote ${outPath}` : `${outPath} unchanged`);
  }
}

void (async () => {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`wagers-by-state: ${message}`);
    process.exit(1);
  }
})();
