/**
 * @file info.ts
 * @description Capture completeness signals: Pace state, confidence, and the reason string
 * shown by `--capture-info` / `--require-confidence`.
 *
 * Pace accumulates `pace-running` tokens when `Pace.restart()` runs repeatedly. The portal's
 * `manager.js` calls `Pace.restart()` from `$(document).ajaxComplete(...)`, and pace.js
 * `finish()` strips only one token (`String.replace`), so a long-running page carries one
 * `pace-running` per completed AJAX request while the active bar is mid-load.
 */
import type { OrderingReport } from "./analyze.ts";
import type { HtmlFilters } from "./html.ts";

export type PaceVersion = "0.4.x" | "1.x" | "unknown";

export type CapturePhase = "authenticated" | "login-form" | "unknown";

/** Whether the HTML table's row order is DataTables client order or server order. */
export type HtmlSort = "client" | "server" | "unknown";

/** Detect a client-side DataTables sort marker; a plain table is treated as server order. */
export function detectHtmlSort(html: string): HtmlSort {
  if (
    /<th\b[^>]*(?:aria-sort="(?:ascending|descending)"|class="[^"]*\bsorting_(?:asc|desc)\b)/i.test(
      html,
    )
  ) {
    return "client";
  }
  if (/<table\b/i.test(html)) return "server";
  return "unknown";
}

/** Login-form fingerprint only exists before `credentials()` wipes sessionStorage. */
export function detectPhase(html: string): CapturePhase {
  if (/<[^>]*data-security="form"/i.test(html)) return "login-form";
  if (/pace-active|data-action="get-bet-ticker"/.test(html)) {
    return "authenticated";
  }
  return "unknown";
}

export interface PaceState {
  readonly elementCount: number;
  readonly activeCount: number;
  readonly activeProgress: number | null;
  readonly doneTokens: number;
  readonly runningTokens: number;
  readonly verdict: "complete" | "mid-load" | "unknown";
  /** `ajaxComplete-restart` when more than one running token accumulated without a finish. */
  readonly cause: "ajaxComplete-restart" | "initial-load" | "unknown";
  /** Which Pace renderer produced the capture: 0.4.x styles `width`, 1.x styles `transform`. */
  readonly version: PaceVersion;
  /** Restarts attributable to the 5-minute `System/renewToken` interval, when span is known. */
  readonly refreshBaseline: number | null;
}

/** Fingerprint the Pace version from the progress element's inline style. */
export function detectPaceVersion(html: string): PaceVersion {
  const progress = /<div\b[^>]*class="[^"]*\bpace-progress\b[^"]*"[^>]*>/i.exec(
    html,
  );
  if (progress === null) return "unknown";
  const style = /style="([^"]*)"/i.exec(progress[0])?.[1] ?? "";
  if (/^\s*width\s*:/i.test(style)) return "0.4.x";
  if (/(?:^|;)\s*(?:-[a-z]+-)?transform\s*:/i.test(style)) return "1.x";
  return "unknown";
}

/** Parse the captured document's Pace DOM state. */
export function inspectPace(html: string, timeSpanMs = 0): PaceState {
  const version = detectPaceVersion(html);
  const paceEls = [
    ...html.matchAll(
      /<div\b[^>]*class="[^"]*\bpace\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    ),
  ];
  const active = paceEls.filter((match) =>
    /\bpace-active\b/.test(match[0].slice(0, match[0].indexOf(">") + 1)),
  );
  const progressMatch =
    active.length > 0
      ? /data-progress="(\d+)"/.exec(active[0]?.[1] ?? "")
      : null;
  const progress = progressMatch === null ? null : Number(progressMatch[1]);
  const activeProgress =
    progress !== null && Number.isFinite(progress) ? progress : null;

  const bodyMatch = /<body\b[^>]*class="([^"]*)"/i.exec(html);
  const bodyClasses = bodyMatch ? bodyMatch[1]!.split(/\s+/) : [];
  const doneTokens = bodyClasses.filter((name) => name === "pace-done").length;
  const runningTokens = bodyClasses.filter(
    (name) => name === "pace-running",
  ).length;

  const verdict: PaceState["verdict"] =
    active.length > 0 && activeProgress !== null && activeProgress < 99
      ? "mid-load"
      : doneTokens > 0
        ? "complete"
        : "unknown";

  // pace.js finish() replaces only the first `pace-running`; repeated restarts accumulate
  // tokens. One token without a finish is the initial load still in flight.
  const cause: PaceState["cause"] =
    runningTokens > 1 && doneTokens === 0
      ? "ajaxComplete-restart"
      : runningTokens === 1 && doneTokens === 0
        ? "initial-load"
        : "unknown";

  return {
    elementCount: paceEls.length,
    activeCount: active.length,
    activeProgress,
    doneTokens,
    runningTokens,
    verdict,
    cause,
    version,
    refreshBaseline: timeSpanMs > 0 ? Math.floor(timeSpanMs / 300_000) : null,
  };
}

export type Confidence = "none" | "low" | "medium" | "high";

export const CONFIDENCE_ORDER: Readonly<Record<Confidence, number>> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export const CONFIDENCE_LEVELS: readonly Confidence[] = [
  "none",
  "low",
  "medium",
  "high",
];

export interface CaptureInfo {
  readonly format: "json" | "html";
  /** JSON `status` is authoritative; `null` when the field is absent. */
  readonly statusOk: boolean | null;
  readonly hasAmounts: boolean;
  readonly pace?: PaceState;
  /** HTML phase; JSON captures do not carry a login form. */
  readonly phase?: CapturePhase;
  /** HTML table sort order; JSON captures do not carry a table. */
  readonly htmlSort?: HtmlSort;
  /** Active client-side table filters; HTML rows are a subset of the AJAX response. */
  readonly filters?: HtmlFilters;
  /** Wager-number/insert-time ordering report for JSON captures. */
  readonly ordering?: OrderingReport;
  /** JSON `accountInfo` presence; `null` when not applicable. */
  readonly hasAccountInfo?: boolean | null;
}

/** Human-readable active filter labels; empty when nothing is filtered. */
export function activeFilterLabels(filters: HtmlFilters | undefined): string[] {
  if (filters === undefined) return [];
  const active: string[] = [];
  if (filters.vipOnly) active.push("VIP only");
  if (filters.betsOver !== null) active.push(`Bets over ${filters.betsOver}`);
  if (filters.hiddenWagerTypes.length > 0) {
    active.push(`Hidden types: ${filters.hiddenWagerTypes.join(", ")}`);
  }
  return active;
}

/** Parse `--require-confidence`/`--capture-info` confidence names. */
export function parseConfidenceArg(value: string): Confidence | null {
  const normalized = value.trim().toLowerCase();
  return (CONFIDENCE_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as Confidence)
    : null;
}

/** Combine status, Pace and amount signals into one pipeline verdict.
 *
 * A low/zero Pace token count is not proof of a clean capture: Pace 1.x can set
 * `ignoreURLs` (for example `getBetTicker`), suppressing restarts without changing data.
 */
export function assessConfidence(info: CaptureInfo): Confidence {
  if (info.format === "json") {
    if (info.statusOk !== true) return "none";
    return info.hasAmounts ? "high" : "medium";
  }
  if (info.pace?.verdict === "mid-load") return "low";
  if (activeFilterLabels(info.filters).length > 0) return "low";
  return "medium";
}

export function confidenceReason(info: CaptureInfo): string {
  if (info.format === "json") {
    if (info.statusOk !== true) return "JSON status is missing or ≠ 1";
    return info.hasAmounts
      ? "JSON, status=1, amounts present"
      : "JSON, status=1, but no amounts (display-scaled HTML in JSON wrapper?)";
  }
  const filters = activeFilterLabels(info.filters);
  if (filters.length > 0) {
    return `HTML, active filters (${filters.join("; ")})`;
  }
  if (info.pace?.verdict === "mid-load") {
    return info.pace.cause === "ajaxComplete-restart"
      ? `HTML, Pace mid-load (${info.pace.runningTokens} ajaxComplete restarts)`
      : "HTML, Pace mid-load (initial load)";
  }
  if (info.pace?.verdict === "complete") return "HTML, Pace complete";
  return "HTML, Pace state unknown";
}

export interface ExternalDep {
  readonly origin: string;
  readonly kind: "iframe" | "script" | "stylesheet";
  readonly count: number;
}

/** Origins loaded by iframes, scripts and stylesheets, sorted by occurrence. */
export function externalDeps(html: string): ExternalDep[] {
  const by = new Map<
    string,
    { origin: string; kind: ExternalDep["kind"]; count: number }
  >();
  for (const match of html.matchAll(
    /<(iframe|script|link)\b[^>]*(?:src|href)="(https?:\/\/[^/"]+)/gi,
  )) {
    const tag = (match[1] ?? "").toLowerCase();
    if (tag !== "iframe" && tag !== "script" && tag !== "link") continue;
    const origin = match[2] ?? "";
    if (origin === "") continue;
    const kind: ExternalDep["kind"] = tag === "link" ? "stylesheet" : tag;
    const current = by.get(origin) ?? { origin, kind, count: 0 };
    current.count += 1;
    by.set(origin, current);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}
