/**
 * Shared, data-driven wager report pipeline.
 *
 * Pure functions: parse → group → filter → bucket → sort → render.
 * All layout, state ordering, and column config comes from
 * `config/wagers.json` via `lib/wagers_config.ts`. Neither the CSV
 * script nor the live API script hardcodes column indices, state names,
 * or table widths.
 */

import { loadConfig, type WagersConfig } from "./wagers_config.ts";
import type {
  FilterValues,
  GroupKey,
  ReportFormat,
  RenderResult,
  StateBucket,
  WagerRow,
} from "../types/wagers";

export type { WagersConfig };

/** ------------------------------------------------------------------ */
/* Config                                                               */
/** ------------------------------------------------------------------ */

let _cfg: WagersConfig | null = null;

export async function reportConfig(
  path = "config/wagers.json",
): Promise<WagersConfig> {
  if (!_cfg) _cfg = await loadConfig(path);
  return _cfg;
}

export function resetReportConfig(): void {
  _cfg = null;
}

/** ------------------------------------------------------------------ */
/* Parsing                                                              */
/** ------------------------------------------------------------------ */

/** Parse "HH:MM:SS M/D/YYYY" → Date using config regex pattern. */
export function makeBetTimeParser(
  cfg: WagersConfig,
): (text: string) => Date | null {
  const re = new RegExp(cfg.dateFormats.betTime);
  return (text: string): Date | null => {
    const m = text.match(re);
    if (!m) return null;
    const [, hh, mm, ss, mo, dd, yyyy] = m;
    return new Date(
      Number(yyyy),
      Number(mo) - 1,
      Number(dd),
      Number(hh),
      Number(mm),
      Number(ss),
    );
  };
}

/** Parse a CLI date arg (M/D/YYYY or YYYY-MM-DD) → Date at midnight. */
export function parseDateArg(text: string): Date | null {
  const m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mo, dd, yyyy] = m;
    return new Date(Number(yyyy), Number(mo) - 1, Number(dd));
  }
  const m2 = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) {
    const [, yyyy, mo, dd] = m2;
    return new Date(Number(yyyy), Number(mo) - 1, Number(dd));
  }
  return null;
}

/** Parse raw CSV string rows into WagerRow[] using config column map. */
export function parseWagersFromCsvRows(
  rows: string[][],
  cfg: WagersConfig,
  fromDay: Date,
  toDay: Date,
): {
  wagers: WagerRow[];
  shortRow: number;
  unparseableTime: number;
} {
  const columns = cfg.columns;
  const parseBetTime = makeBetTimeParser(cfg);
  const wagers: WagerRow[] = [];
  let shortRow = 0;
  let unparseableTime = 0;

  const maxIdx = Math.max(
    columns.ticket,
    columns.betGroup,
    columns.state,
    columns.risk,
    columns.toWin,
    columns.result,
    columns.betTime,
    columns.player,
    columns.agent,
    columns.eventDetails,
  );

  for (const r of rows) {
    if (!r || r.length <= maxIdx) {
      shortRow++;
      continue;
    }

    const betTimeRaw = r[columns.betTime] ?? "";
    const d = parseBetTime(betTimeRaw);
    if (!d) {
      unparseableTime++;
      continue;
    }
    if (d < fromDay || d > toDay) continue;

    wagers.push({
      ticket: (r[columns.ticket] ?? "").trim(),
      betGroup: (r[columns.betGroup] ?? "").trim(),
      state: (r[columns.state] ?? "").trim(),
      risk: Number(r[columns.risk] ?? "0") || 0,
      toWin: Number(r[columns.toWin] ?? "0") || 0,
      result: Number(r[columns.result] ?? "0") || 0,
      betTime: d,
      player: (r[columns.player] ?? "").trim(),
      agent: (r[columns.agent] ?? "").trim(),
      event: (r[columns.eventDetails] ?? "").trim(),
    });
  }

  return { wagers, shortRow, unparseableTime };
}

/** Parse API bet objects into WagerRow[]. */
export function parseWagersFromBets(
  bets: Array<Record<string, unknown>>,
  cfg: WagersConfig,
  fromDay: Date,
  toDay: Date,
): { wagers: WagerRow[]; unparseableTime: number } {
  const parseBetTime = makeBetTimeParser(cfg);
  const wagers: WagerRow[] = [];
  let unparseableTime = 0;

  for (const b of bets) {
    const state = (b.State ?? "unknown").toString().trim() || "unknown";
    const d = parseBetTime((b.BetTime ?? "").toString());
    if (!d) {
      unparseableTime++;
      continue;
    }
    if (d < fromDay || d > toDay) continue;

    wagers.push({
      ticket: (b.Ticket ?? "").toString().trim(),
      betGroup: (b.BetGroup ?? "").toString().trim(),
      state,
      risk: Number(b.Risk ?? "0") || 0,
      toWin: Number(b.ToWin ?? "0") || 0,
      result: Number(b.Result ?? "0") || 0,
      betTime: d,
      player: (b.Player ?? "").toString().trim(),
      agent: (b.Agent ?? "").toString().trim(),
      event: (b.EventDetails ?? "").toString().trim(),
    });
  }

  return { wagers, unparseableTime };
}

/** ------------------------------------------------------------------ */
/* Grouping                                                             */
/** ------------------------------------------------------------------ */

/** Bet-group → leg count map. */
export function computeGroupSizes(wagers: WagerRow[]): Map<string, number> {
  const groupSize = new Map<string, number>();
  for (const w of wagers) {
    if (w.betGroup) {
      groupSize.set(w.betGroup, (groupSize.get(w.betGroup) ?? 0) + 1);
    }
  }
  return groupSize;
}

/** ------------------------------------------------------------------ */
/* Filtering                                                            */
/** ------------------------------------------------------------------ */

/** Find a CLI arg by its config-declared flag (`--x` or `--x=value`). */
function findArg(args: string[], flag: string): string | undefined {
  return args.find((a) => a === flag || a.startsWith(`${flag}=`));
}

/** Take a value from `--flag=value` or the following positional. */
function takeValue(args: string[], found: string): string | undefined {
  if (found.includes("=")) return found.split("=")[1]?.trim() || undefined;
  return args[args.indexOf(found) + 1]?.trim() || undefined;
}

/**
 * Parse filter values generically from `cfg.filters`: each entry declares
 * its CLI flag and value type, so adding a filter is a config edit.
 */
export function parseFilters(args: string[], cfg: WagersConfig): FilterValues {
  const out: FilterValues = {
    stateFilter: undefined,
    wagerNumberFilter: undefined,
    legsFilter: undefined,
  };
  for (const def of Object.values(cfg.filters)) {
    const found = findArg(args, def.arg);
    if (!found) continue;
    const raw = takeValue(args, found);
    if (raw === undefined || raw === "") continue;
    if (def.field === "legsFilter") {
      const n = Number(raw);
      if (Number.isFinite(n)) out.legsFilter = n;
    } else {
      out[def.field] = raw;
    }
  }
  return out;
}

/** Human-readable active-filter labels, derived from config filter keys. */
export function filterLabels(
  cfg: WagersConfig,
  filters: FilterValues,
): string[] {
  const labels: string[] = [];
  for (const [key, def] of Object.entries(cfg.filters)) {
    const value =
      def.field === "stateFilter"
        ? filters.stateFilter
        : def.field === "wagerNumberFilter"
          ? filters.wagerNumberFilter
          : filters.legsFilter;
    if (
      value !== undefined &&
      !(typeof value === "number" && !Number.isFinite(value))
    ) {
      labels.push(`${key}=${value}`);
    }
  }
  return labels;
}

/** Parse `--format=X`, validated against `cfg.output.formats`. */
export function parseFormat(args: string[], cfg: WagersConfig): ReportFormat {
  const found = findArg(args, "--format");
  const raw = found ? takeValue(args, found) : undefined;
  const fallback = cfg.default.format;
  if (!raw) return fallback;
  const fmt = raw.toLowerCase();
  if (
    (fmt === "table" ||
      fmt === "json" ||
      fmt === "csv" ||
      fmt === "summary" ||
      fmt === "inspect" ||
      fmt === "columns" ||
      fmt === "grid") &&
    (cfg.output.formats as string[]).includes(fmt)
  ) {
    return fmt;
  }
  throw new Error(
    `invalid --format "${raw}" (allowed: ${cfg.output.formats.join(", ")})`,
  );
}

export function applyFilters(
  wagers: WagerRow[],
  groupSize: Map<string, number>,
  filters: FilterValues,
): WagerRow[] {
  let filtered = wagers;
  if (filters.stateFilter) {
    filtered = filtered.filter((w) => w.state === filters.stateFilter);
  }
  if (filters.wagerNumberFilter) {
    filtered = filtered.filter((w) => w.ticket === filters.wagerNumberFilter);
  }
  if (filters.legsFilter && Number.isFinite(filters.legsFilter)) {
    filtered = filtered.filter(
      (w) => (groupSize.get(w.betGroup) ?? 1) === filters.legsFilter,
    );
  }
  return filtered;
}

/** ------------------------------------------------------------------ */
/* Group summaries (REPL-friendly display model)                       */
/** ------------------------------------------------------------------ */

/**
 * Display model for one grouped bucket. The custom inspect follows the
 * Node-compatible contract: `Bun.inspect.custom` (identical symbol to
 * `util.inspect.custom`) is called as `(depth, options, inspect), so
 * `console.log`, `Bun.inspect`, and Node's `util.inspect` all print the
 * one-line form, nested or not. `toJSON` keeps machine output clean.
 */
export class GroupSummary {
  constructor(
    public group: string,
    public label: string,
    public risk: number,
    public legs: number,
    public count = 0,
    public toWin = 0,
    public result = 0,
  ) {}

  [Bun.inspect.custom](
    _depth: number,
    options: { colors?: boolean } = {},
  ): string {
    const line = `${this.label.padEnd(20)} risk=$${this.risk.toString().padStart(7)} legs=${this.legs}`;
    return options?.colors === true ? `\u001b[1m${line}\u001b[22m` : line;
  }

  toJSON() {
    return {
      group: this.group,
      label: this.label,
      risk: this.risk,
      legs: this.legs,
      count: this.count,
      toWin: this.toWin,
      result: this.result,
    };
  }
}

/** Wrap sorted buckets as display summaries, preserving order. */
export function summarizeGroups(
  sorted: StateBucket[],
  group: GroupKey,
): GroupSummary[] {
  return sorted.map(
    (b) =>
      new GroupSummary(
        group,
        b.state,
        b.riskDollars,
        b.legsTotal,
        b.count,
        b.toWinDollars,
        b.resultDollars,
      ),
  );
}

/** Take the first N buckets (undefined, non-positive, or NaN = all). */
export function takeTop(
  sorted: StateBucket[],
  n: number | undefined,
): StateBucket[] {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return sorted;
  return sorted.slice(0, Math.floor(n));
}

/** Parse `--top=N` (or `--top N`); undefined means no limit. */
export function parseTopArg(args: string[]): number | undefined {
  const found = findArg(args, "--top");
  if (!found) return undefined;
  const raw = takeValue(args, found);
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** ------------------------------------------------------------------ */
/* Grouping, bucketing, sorting                                        */
/** ------------------------------------------------------------------ */

/** Parse `--group-by=X`, validated against `cfg.groups`. */
export function parseGroupBy(args: string[], cfg: WagersConfig): GroupKey {
  const found = findArg(args, "--group-by");
  const raw = found ? takeValue(args, found) : undefined;
  if (!raw) return cfg.default.groupBy;
  const key = raw.toLowerCase();
  if (
    (key === "state" ||
      key === "day" ||
      key === "event" ||
      key === "player" ||
      key === "agent") &&
    key in cfg.groups
  ) {
    return key;
  }
  throw new Error(
    `invalid --group-by "${raw}" (allowed: ${Object.keys(cfg.groups).join(", ")})`,
  );
}

/** Group value for one row under the given dimension (data-driven). */
export function groupValue(row: WagerRow, group: GroupKey): string {
  switch (group) {
    case "day": {
      // Local calendar day — matches the window filter (local midnights)
      // and the export's Bet Time (Day) columns. toISOString would be UTC
      // and push evening bets onto the next day.
      const y = row.betTime.getFullYear();
      const m = String(row.betTime.getMonth() + 1).padStart(2, "0");
      const d = String(row.betTime.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    case "event":
      return row.event || "(unknown event)";
    case "player":
      return row.player || "(unknown player)";
    case "agent":
      return row.agent || "(unknown agent)";
    case "state":
    default:
      return row.state || "(unknown state)";
  }
}

/** Bucket rows by a key function; legs counted over the full window. */
export function bucketBy(
  filtered: WagerRow[],
  groupSize: Map<string, number>,
  keyOf: (w: WagerRow) => string,
): Map<string, StateBucket> {
  const buckets = new Map<string, StateBucket>();
  for (const w of filtered) {
    const key = keyOf(w);
    const legs = groupSize.get(w.betGroup) ?? 1;
    const b = buckets.get(key) ?? {
      state: key,
      count: 0,
      riskDollars: 0,
      toWinDollars: 0,
      resultDollars: 0,
      legsTotal: 0,
    };
    b.count++;
    b.riskDollars = Math.round((b.riskDollars + w.risk) * 100) / 100;
    b.toWinDollars = Math.round((b.toWinDollars + w.toWin) * 100) / 100;
    b.resultDollars = Math.round((b.resultDollars + w.result) * 100) / 100;
    b.legsTotal += legs;
    buckets.set(key, b);
  }
  return buckets;
}

export function bucketByState(
  filtered: WagerRow[],
  groupSize: Map<string, number>,
): Map<string, StateBucket> {
  return bucketBy(filtered, groupSize, (w) => w.state);
}

export function sortBuckets(
  buckets: StateBucket[],
  cfg: WagersConfig,
): StateBucket[] {
  return sortGroups(buckets, cfg, "state");
}

/** Sort buckets per the group's configured strategy. */
export function sortGroups(
  buckets: StateBucket[],
  cfg: WagersConfig,
  group: GroupKey,
): StateBucket[] {
  const strategy = cfg.groups[group].sort;
  return [...buckets].sort((a, b) => {
    switch (strategy) {
      case "key-asc":
        return a.state.localeCompare(b.state);
      case "risk-desc":
        return b.riskDollars - a.riskDollars || b.count - a.count;
      case "count-desc":
        return b.count - a.count || b.riskDollars - a.riskDollars;
      case "config-order":
      default: {
        const defs = cfg.states;
        const aDef = defs[a.state];
        const bDef = defs[b.state];
        const aOrder = aDef ? aDef.sortOrder : Number.MAX_SAFE_INTEGER;
        const bOrder = bDef ? bDef.sortOrder : Number.MAX_SAFE_INTEGER;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return b.count - a.count;
      }
    }
  });
}

/** ------------------------------------------------------------------ */
/* Formatting                                                           */
/** ------------------------------------------------------------------ */

export function usd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents);
}

/** ------------------------------------------------------------------ */
/* Output rendering (data-driven columns)                               */
/** ------------------------------------------------------------------ */

/** Sum bucket rows into a TOTAL bucket (single implementation). */
export function sumGrand(sorted: StateBucket[]): StateBucket {
  const grand: StateBucket = {
    state: "TOTAL",
    count: 0,
    riskDollars: 0,
    toWinDollars: 0,
    resultDollars: 0,
    legsTotal: 0,
  };
  for (const b of sorted) {
    grand.count += b.count;
    grand.legsTotal += b.legsTotal;
    grand.riskDollars =
      Math.round((grand.riskDollars + b.riskDollars) * 100) / 100;
    grand.toWinDollars =
      Math.round((grand.toWinDollars + b.toWinDollars) * 100) / 100;
    grand.resultDollars =
      Math.round((grand.resultDollars + b.resultDollars) * 100) / 100;
  }
  return grand;
}

/**
 * Human elapsed time between two `Bun.nanoseconds()` readings.
 * Pure (clock passed in) so tests never sleep: 12ms, 1.42s, …
 */
export function formatElapsed(startNs: number, endNs: number): string {
  const ms = Math.max(0, (endNs - startNs) / 1e6);
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(2) : Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function renderTable(
  sorted: StateBucket[],
  cfg: WagersConfig,
  groupLabel = "State",
): RenderResult {
  const output = cfg.output;
  const unknownStateLabel = cfg.output.unknownStateLabel;
  const lines: string[] = [];

  // Resolve dynamic column widths in terminal columns (ANSI/emoji-safe).
  const colWidths: Record<string, number> = {};
  for (const col of output.columns) {
    colWidths[col.key] = col.width;
  }

  const maxStateLen = Math.max(
    ...sorted.map((b) => Bun.stringWidth(b.state)),
    Bun.stringWidth(unknownStateLabel),
    Bun.stringWidth(groupLabel),
  );
  colWidths.state = Math.max(colWidths.state ?? 0, maxStateLen);

  for (const col of output.columns) {
    if (col.key === "state") continue;
    const headerLen = Bun.stringWidth(col.label);
    let maxValLen = 0;
    for (const b of sorted) {
      const val =
        col.key === "count"
          ? String(b.count)
          : col.key === "legs"
            ? String(b.legsTotal)
            : col.key === "riskDollars"
              ? usd(b.riskDollars).replace(/[$,]/g, "")
              : col.key === "toWinDollars"
                ? usd(b.toWinDollars).replace(/[$,]/g, "")
                : col.key === "resultDollars"
                  ? usd(b.resultDollars).replace(/[$,]/g, "")
                  : "";
      maxValLen = Math.max(maxValLen, Bun.stringWidth(val));
    }
    colWidths[col.key] = Math.max(col.width, headerLen, maxValLen);
  }

  const buildRow = (values: Record<string, string>): string => {
    const cells = output.columns.map((col) => {
      const val = values[col.key] ?? "";
      return padDisplay(val, colWidths[col.key] ?? 0, col.align);
    });
    return ` ${cells.join(" │ ")}`;
  };

  const headerValues: Record<string, string> = {};
  for (const col of output.columns) {
    headerValues[col.key] = col.key === "state" ? groupLabel : col.label;
  }
  lines.push(buildRow(headerValues));

  const sepCells = output.columns.map((col) =>
    "─".repeat(colWidths[col.key] ?? 0),
  );
  lines.push(sepCells.join("┼"));

  const grand = sumGrand(sorted);

  for (const b of sorted) {
    const values: Record<string, string> = {
      state: b.state,
      count: String(b.count),
      legs: String(b.legsTotal),
      riskDollars: usd(b.riskDollars),
      toWinDollars: usd(b.toWinDollars),
      resultDollars: usd(b.resultDollars),
    };
    lines.push(buildRow(values));
  }

  const grandValues: Record<string, string> = {
    state: grand.state,
    count: String(grand.count),
    legs: String(grand.legsTotal),
    riskDollars: usd(grand.riskDollars),
    toWinDollars: usd(grand.toWinDollars),
    resultDollars: usd(grand.resultDollars),
  };
  lines.push(sepCells.join("┼"));
  lines.push(buildRow(grandValues));

  return { lines, grand };
}

/** Pad to a display width using terminal column count (ANSI/emoji-safe). */
export function padDisplay(
  text: string,
  width: number,
  align: "left" | "right",
): string {
  const pad = Math.max(0, width - Bun.stringWidth(text));
  return align === "right"
    ? `${" ".repeat(pad)}${text}`
    : `${text}${" ".repeat(pad)}`;
}
/** Box-drawing grid via Bun's native table printer (colors on TTY). */
export function renderGrid(
  sorted: StateBucket[],
  grand: StateBucket,
  cfg: WagersConfig,
  groupLabel = "State",
): string {
  const labels = cfg.output.columns.map((c) =>
    c.key === "state" ? groupLabel : c.label,
  );
  const toRow = (b: StateBucket): Record<string, string | number> => {
    const row: Record<string, string | number> = {};
    for (const col of cfg.output.columns) {
      const label = col.key === "state" ? groupLabel : col.label;
      switch (col.key) {
        case "state":
          row[label] = b.state;
          break;
        case "count":
          row[label] = b.count;
          break;
        case "legs":
          row[label] = b.legsTotal;
          break;
        case "riskDollars":
          row[label] = b.riskDollars;
          break;
        case "toWinDollars":
          row[label] = b.toWinDollars;
          break;
        case "resultDollars":
          row[label] = b.resultDollars;
          break;
        default:
          row[label] = "";
      }
    }
    return row;
  };
  const rows = [...sorted.map(toRow), toRow({ ...grand })];
  return Bun.inspect.table(
    rows,
    labels,
    // Native gate: colors only when Bun has ANSI enabled for this output.
    { colors: Bun.enableANSIColors },
  );
}

/** Machine-readable JSON: bucket rows + TOTAL, using config column keys. */
export function renderJson(sorted: StateBucket[], grand: StateBucket): string {
  return JSON.stringify({ rows: sorted, total: grand }, null, 2);
}

/** CSV export: header from config column labels, rows in config column order. */
export function renderCsv(
  sorted: StateBucket[],
  grand: StateBucket,
  cfg: WagersConfig,
  groupLabel = "State",
): string {
  const delim = cfg.output.csvDelimiter;
  const esc = (v: string | number): string => {
    const s = String(v);
    if (s.includes(delim) || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const cellFor = (b: StateBucket, key: string): string | number => {
    switch (key) {
      case "state":
        return b.state;
      case "count":
        return b.count;
      case "legs":
        return b.legsTotal;
      case "riskDollars":
        return b.riskDollars.toFixed(2);
      case "toWinDollars":
        return b.toWinDollars.toFixed(2);
      case "resultDollars":
        return b.resultDollars.toFixed(2);
      default:
        return "";
    }
  };
  const header = cfg.output.columns
    .map((c) => esc(c.key === "state" ? groupLabel : c.label))
    .join(delim);
  const rows = sorted.map((b) =>
    cfg.output.columns.map((c) => esc(cellFor(b, c.key))).join(delim),
  );
  const total = cfg.output.columns
    .map((c) => esc(cellFor(grand, c.key)))
    .join(delim);
  return [header, ...rows, total].join("\n");
}

/**
 * Dispatch to the requested format. Table returns display lines;
 * json/csv return a single document string.
 */
export function renderReport(
  sorted: StateBucket[],
  cfg: WagersConfig,
  format: ReportFormat,
  group: GroupKey = "state",
): string[] {
  const grand = sumGrand(sorted);
  const groupLabel = cfg.groups[group].label;
  if (format === "json") return [renderJson(sorted, grand)];
  if (format === "csv") return [renderCsv(sorted, grand, cfg, groupLabel)];
  if (format === "summary")
    return summarizeGroups(sorted, group).map((s) => Bun.inspect(s));
  if (format === "inspect")
    return [Bun.inspect(summarizeGroups(sorted, group))];
  if (format === "columns") return [Bun.inspect(toColumnar(sorted))];
  if (format === "grid")
    return [renderGrid(sorted, grand, cfg, groupLabel).trimEnd()];
  return renderTable(sorted, cfg, groupLabel).lines;
}

/**
 * Route output so machine formats stay parseable: tables print
 * everything to stdout, while json/csv documents go to stdout alone
 * and titles, warnings, and provenance go to stderr.
 */
export function splitOutput(
  format: ReportFormat,
  title: string,
  docLines: string[],
  metaLines: string[],
): { stdout: string[]; stderr: string[] } {
  if (
    format === "table" ||
    format === "summary" ||
    format === "inspect" ||
    format === "columns" ||
    format === "grid"
  ) {
    return {
      stdout: [title, "", ...docLines, "", ...metaLines].filter(
        (l, i, arr) => !(l === "" && (i === 0 || arr[i - 1] === "")),
      ),
      stderr: [],
    };
  }
  return {
    stdout: docLines,
    stderr: [title, ...metaLines.filter((l) => l !== "")],
  };
}

/** Parse `--out=PATH` (or `--out PATH`); undefined means stdout only. */
export function parseOutArg(args: string[]): string | undefined {
  const found = findArg(args, "--out");
  if (!found) return undefined;
  return takeValue(args, found);
}

/**
 * Columnar numeric view: one typed array per metric, groups as labels.
 * Counts and legs are exact integers (Uint32); money is dollars as
 * Float64 (cents survive the round-trip). `Bun.inspect` renders these
 * compactly: `Float64Array(2) [ 1.5, 28868.41 ]`.
 */
export interface WagerColumns {
  readonly groups: string[];
  readonly count: Uint32Array;
  readonly legs: Uint32Array;
  readonly risk: Float64Array;
  readonly toWin: Float64Array;
  readonly result: Float64Array;
}

export function toColumnar(sorted: StateBucket[]): WagerColumns {
  const n = sorted.length;
  const groups: string[] = [];
  const count = new Uint32Array(n);
  const legs = new Uint32Array(n);
  const risk = new Float64Array(n);
  const toWin = new Float64Array(n);
  const result = new Float64Array(n);
  let i = 0;
  for (const b of sorted) {
    groups.push(b.state);
    count[i] = b.count;
    legs[i] = b.legsTotal;
    risk[i] = b.riskDollars;
    toWin[i] = b.toWinDollars;
    result[i] = b.resultDollars;
    i++;
  }
  return { groups, count, legs, risk, toWin, result };
}

/** ------------------------------------------------------------------ */
/* Live request body (data-driven)                                      */
/** ------------------------------------------------------------------ */

export interface BetReportBody {
  action: string;
  partnerUserId: string;
  agent: string;
  eventId: string;
  freeBetId: string;
  state: string;
  sId: string;
  minVolume: string;
  maxTimeUntilScore: string;
  mId: string;
  from: number;
  fromTime: number;
  to: number;
  toTime: number;
  betId: string;
  betGroupId: string;
  group: null;
  dateFilterBy: string;
  partnerIds: string;
  period: null;
}

/** Build the getBetReport POST body from `cfg.live` + epoch window. */
export function buildBetReportBody(
  cfg: WagersConfig,
  fromEpoch: number,
  toEpoch: number,
): BetReportBody {
  return {
    action: cfg.live.action,
    partnerUserId: "",
    agent: "",
    eventId: "",
    freeBetId: "",
    state: "",
    sId: "",
    minVolume: "0",
    maxTimeUntilScore: "0",
    mId: "",
    from: fromEpoch,
    fromTime: cfg.live.fromTime,
    to: toEpoch,
    toTime: cfg.live.toTime,
    betId: "",
    betGroupId: "",
    group: null,
    dateFilterBy: cfg.live.dateFilterBy,
    partnerIds: "",
    period: null,
  };
}
