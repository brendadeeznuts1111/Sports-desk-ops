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

export type PaceVersion = "0.4.x" | "1.x" | "unknown";

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
export function inspectPace(html: string): PaceState {
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
}

/** Parse `--require-confidence`/`--capture-info` confidence names. */
export function parseConfidenceArg(value: string): Confidence | null {
  const normalized = value.trim().toLowerCase();
  return (CONFIDENCE_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as Confidence)
    : null;
}

/** Combine status, Pace and amount signals into one pipeline verdict. */
export function assessConfidence(info: CaptureInfo): Confidence {
  if (info.format === "json") {
    if (info.statusOk !== true) return "none";
    return info.hasAmounts ? "high" : "medium";
  }
  if (info.pace?.verdict === "mid-load") return "low";
  return "medium";
}

export function confidenceReason(info: CaptureInfo): string {
  if (info.format === "json") {
    if (info.statusOk !== true) return "JSON status is missing or ≠ 1";
    return info.hasAmounts
      ? "JSON, status=1, amounts present"
      : "JSON, status=1, but no amounts (display-scaled HTML in JSON wrapper?)";
  }
  if (info.pace?.verdict === "mid-load") {
    return info.pace.cause === "ajaxComplete-restart"
      ? `HTML, Pace mid-load (${info.pace.runningTokens} ajaxComplete restarts)`
      : "HTML, Pace mid-load (initial load)";
  }
  if (info.pace?.verdict === "complete") return "HTML, Pace complete";
  return "HTML, Pace state unknown";
}
