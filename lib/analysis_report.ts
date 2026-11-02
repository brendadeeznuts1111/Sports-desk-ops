/**
 * @file analysis_report.ts
 * @description A stored Customer Performance (report `CP`) result, and the arithmetic that must
 * hold between its rows and its totals.
 *
 * The portal prints this table as:
 *   Customer · Accounts · Count · Risk · To Win · Volume Amount · Amount Lost · Amount Won ·
 *   Net · Hold
 *
 * Two things this module takes seriously:
 *  - **Totals are recomputed, never trusted.** The portal's Hold column is `-Risk / Net`,
 *    which is inverted relative to the usual hold definition; every pasted row confirms it. The paste's footer is stored for comparison, but
 *    `recomputeTotals` derives the figures from the rows so a transcription slip shows up as a
 *    mismatch instead of being served as fact.
 *  - **Duplicate rows are excluded, explicitly.** The portal rendered one wager twice (once
 *    under the customer login, once under the agent login). A row marked `duplicateOf` is kept
 *    for display and left out of every total, which is how the footer's own numbers add up.
 */

export type AnalysisReportKind = "CP" | "CPS" | "CPV" | "G";

export interface AnalysisRow {
  readonly customer: string;
  /** Agent login the row was nested under, when the portal showed one. */
  readonly agentLogin: string | null;
  readonly accounts: number;
  readonly wagers: number;
  /** Integer cents. */
  readonly risk: number;
  readonly toWin: number;
  readonly volume: number;
  readonly amountLost: number;
  readonly amountWon: number;
  readonly net: number;
  readonly holdPercent: number;
  /** Set when the portal printed the same wager twice; excluded from totals. */
  readonly duplicateOf: string | null;
}

export interface AnalysisTotals {
  accounts: number;
  wagers: number;
  risk: number;
  toWin: number;
  volume: number;
  amountLost: number;
  amountWon: number;
  net: number;
  holdPercent: number;
}

export interface AnalysisReport {
  readonly schemaVersion: 1;
  readonly report: AnalysisReportKind;
  readonly source: string;
  readonly observedAt: string | null;
  readonly context: Readonly<Record<string, string>>;
  readonly notes?: readonly string[];
  readonly rows: readonly AnalysisRow[];
  readonly totals: AnalysisTotals;
}

export function readAnalysisReport(payload: unknown): AnalysisReport | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Partial<AnalysisReport>;
  if (typeof record.report !== "string") return null;
  if (!Array.isArray(record.rows) || record.rows.length === 0) return null;
  if (typeof record.totals !== "object" || record.totals === null) return null;
  return {
    schemaVersion: 1,
    report: record.report as AnalysisReportKind,
    source: typeof record.source === "string" ? record.source : "",
    observedAt:
      typeof record.observedAt === "string" ? record.observedAt : null,
    context: (record.context ?? {}) as Record<string, string>,
    ...(Array.isArray(record.notes) ? { notes: record.notes.map(String) } : {}),
    rows: record.rows as AnalysisRow[],
    totals: record.totals as AnalysisTotals,
  };
}

/** Rows that count toward the totals: everything not marked as a duplicate. */
export function countedRows(report: AnalysisReport): AnalysisRow[] {
  return report.rows.filter((row) => row.duplicateOf === null);
}

export function recomputeTotals(report: AnalysisReport): AnalysisTotals {
  const rows = countedRows(report);
  const sum = (pick: (row: AnalysisRow) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);

  const risk = sum((row) => row.risk);
  const net = sum((row) => row.net);

  return {
    accounts: sum((row) => row.accounts),
    wagers: sum((row) => row.wagers),
    risk,
    toWin: sum((row) => row.toWin),
    volume: sum((row) => row.volume),
    amountLost: sum((row) => row.amountLost),
    amountWon: sum((row) => row.amountWon),
    net,
    // The portal's Hold column is -Risk / Net, not the usual Net / Risk: every row checks out
    // (500 / 1326.47 = 37.69%, 15000 / 23945.44 = 62.64%). Guard the divide on a flat book.
    holdPercent: net === 0 ? 0 : Number((-(risk / net) * 100).toFixed(2)),
  };
}

export interface TotalsDiscrepancy {
  readonly field: keyof AnalysisTotals;
  readonly stated: number;
  readonly recomputed: number;
}

/**
 * Compares the stored footer against the recomputed totals.
 *
 * Returns discrepancies rather than throwing: a paste can be right in spirit and wrong in a
 * digit, and the caller decides whether to serve it. An empty array means the footer is
 * arithmetically consistent with the rows.
 */
export function compareTotals(report: AnalysisReport): TotalsDiscrepancy[] {
  const recomputed = recomputeTotals(report);
  const fields = Object.keys(recomputed) as Array<keyof AnalysisTotals>;
  const out: TotalsDiscrepancy[] = [];

  for (const field of fields) {
    const stated = report.totals[field];
    const derived = recomputed[field];
    // Hold is rounded to two decimals by the portal, so allow that rounding.
    const tolerance = field === "holdPercent" ? 0.02 : 0;
    if (Math.abs(stated - derived) > tolerance) {
      out.push({ field, stated, recomputed: derived });
    }
  }
  return out;
}

/** True when the stored report describes the selection being asked for. */
export function matchesSelection(
  report: AnalysisReport,
  selection: {
    readonly report: string;
    readonly agent: string;
    readonly sport: string;
    readonly week: string;
    readonly activity: string;
  },
): boolean {
  if (report.report !== selection.report) return false;
  const context = report.context;

  const sameText = (key: string, wanted: string): boolean => {
    const have = (context[key] ?? "").trim();
    const want = wanted.trim();
    // An empty request means "unfiltered", which only satisfies an unfiltered context.
    if (want === "" || want === "all") return have === "" || have === "all";
    return have.toLowerCase() === want.toLowerCase();
  };

  return (
    sameText("agent", selection.agent) &&
    sameText("sport", selection.sport) &&
    (selection.week === "" || context.week === selection.week) &&
    (selection.activity === "" || context.activity === selection.activity)
  );
}
