/**
 * @file analysis_filters.ts
 * @description The portal Analysis report's filter vocabulary, transcribed from the report's
 * own filter bar: report kind (CP/CPS/CPV/G), activity code, group mode, and week window.
 *
 * Provenance: portal markup for `report.js` (`#btnPerformance`, `data-list="activity"`,
 * `"group"`, `"week"`). The codes are the portal's; the *data* behind them comes from
 * `POST /cloud/api/Manager/getAgentPerformance`, whose request was observed on 2026-11-01
 * (`operation=getAgentPerformance`, `type=CP`/`CPS`) but whose response never was. So this module
 * can validate and describe a selection, and cannot produce a figure.
 */

export interface AnalysisOption {
  readonly value: string;
  readonly label: string;
}

/** `data-action="filter" data-value=…` on the report-kind dropdown. */
export const ANALYSIS_REPORTS = [
  { value: "CP", label: "Customer Performance" },
  { value: "CPS", label: "Sport Performance" },
  { value: "CPV", label: "Customer Volume" },
  { value: "G", label: "Graded Wagers" },
] as const satisfies readonly AnalysisOption[];

/** `data-list="activity"` options, including the disabled-in-portal ones that remain valid codes. */
export const ANALYSIS_ACTIVITIES = [
  { value: "-1", label: "All Action" },
  { value: "0", label: "Sports" },
  { value: "1", label: "LV Digital Casino" },
  { value: "5", label: "Poker" },
  { value: "2", label: "Racebook" },
  { value: "3", label: "Live Casino" },
  { value: "4", label: "Live Betting" },
  { value: "7", label: "Soccer 365" },
  { value: "8", label: "Flash Bet" },
  { value: "10", label: "Crash" },
  { value: "11", label: "Fantasy" },
  { value: "12", label: "AC Digital Casino" },
  { value: "14", label: "Bet Builder" },
  { value: "15", label: "Git Casino" },
] as const satisfies readonly AnalysisOption[];

/** `data-list="group"`: 1 groups by agent, 2 sorts the columns instead. */
export const ANALYSIS_GROUPS = [
  { value: "1", label: "Group Agent" },
  { value: "2", label: "Sorting Columns" },
] as const satisfies readonly AnalysisOption[];

/** `data-list="week"`; `-1` is today, `0` this week, `1` last week, `enter-dates` a range. */
export const ANALYSIS_WEEKS = [
  { value: "-1", label: "Today" },
  { value: "0", label: "This Week" },
  { value: "1", label: "Last Week" },
  { value: "enter-dates", label: "Entered Dates" },
] as const satisfies readonly AnalysisOption[];

export type AnalysisReport = (typeof ANALYSIS_REPORTS)[number]["value"];
export type AnalysisGroup = (typeof ANALYSIS_GROUPS)[number]["value"];

export interface AnalysisSelection {
  readonly report: AnalysisReport;
  readonly activity: string;
  readonly group: AnalysisGroup;
  readonly week: string;
  readonly agent: string;
}

export interface AnalysisParseResult {
  readonly ok: boolean;
  readonly selection?: AnalysisSelection;
  readonly errors: readonly string[];
}

function picks(options: readonly AnalysisOption[], fallback: string): string {
  return options.some((option) => option.value === fallback)
    ? fallback
    : (options[0]?.value ?? "");
}

/**
 * Parses and validates a selection. Unknown codes are rejected rather than coerced: the portal
 * accepts only the enumerated values, and quietly substituting one would change the report.
 */
export function parseAnalysisQuery(
  params: URLSearchParams,
): AnalysisParseResult {
  const errors: string[] = [];

  const report = params.get("report") ?? "CP";
  if (!ANALYSIS_REPORTS.some((option) => option.value === report)) {
    errors.push(
      `report must be one of ${ANALYSIS_REPORTS.map((o) => o.value).join(", ")}`,
    );
  }

  const activity = params.get("activity") ?? "-1";
  if (!ANALYSIS_ACTIVITIES.some((option) => option.value === activity)) {
    errors.push(
      `activity must be one of ${ANALYSIS_ACTIVITIES.map((o) => o.value).join(", ")}`,
    );
  }

  const group = params.get("group") ?? "1";
  if (!ANALYSIS_GROUPS.some((option) => option.value === group)) {
    errors.push(`group must be 1 or 2`);
  }

  const week = params.get("week") ?? "-1";
  if (!ANALYSIS_WEEKS.some((option) => option.value === week)) {
    errors.push(
      `week must be one of ${ANALYSIS_WEEKS.map((o) => o.value).join(", ")}`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    selection: {
      report: report as AnalysisReport,
      activity: picks(ANALYSIS_ACTIVITIES, activity),
      group: group as AnalysisGroup,
      week: picks(ANALYSIS_WEEKS, week),
      agent: (params.get("agent") ?? "").trim(),
    },
  };
}

/** Human-readable restatement of a selection, used in responses and the UI. */
export function describeSelection(selection: AnalysisSelection): string {
  const report =
    ANALYSIS_REPORTS.find((o) => o.value === selection.report)?.label ??
    selection.report;
  const activity =
    ANALYSIS_ACTIVITIES.find((o) => o.value === selection.activity)?.label ??
    selection.activity;
  const group =
    ANALYSIS_GROUPS.find((o) => o.value === selection.group)?.label ??
    selection.group;
  const week =
    ANALYSIS_WEEKS.find((o) => o.value === selection.week)?.label ??
    selection.week;

  return [
    report,
    activity,
    group,
    week,
    selection.agent === "" ? "all agents" : `agent ${selection.agent}`,
  ].join(" · ");
}

/** Why this endpoint cannot answer yet, stated once so responses and docs agree. */
export const ANALYSIS_REQUIRED_CAPTURE =
  "Capture the response of POST /cloud/api/Manager/getAgentPerformance per report kind. The request is already observed (2026-11-01, type=CP and type=CPS — tests/fixtures/f402-report-requests-observed-2026-11-01.json) and lib/f402_agent_performance_request.ts reproduces it byte for byte; only the response is missing, so no column set is documented. Report/getAnalysis on the launcher tile and Manager/getReportPlayerAnalysis are different calls, not this report.";
