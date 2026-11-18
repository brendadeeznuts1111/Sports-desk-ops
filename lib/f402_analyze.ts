/**
 * Box-local analysis over a Fantasy402 puller directory: account linking
 * and change prediction. Summaries hash IPs and never print them raw.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "./f402_bet_ticker_delta.ts";
import { replaceIpsInText, textContainsIp } from "./f402_ip_text.ts";
import { F402_PULL_DEFAULT_OUT_DIR } from "./f402_readonly_puller.ts";
import {
  F402AnalyzeError,
  ingestPullDirectory,
  type PullProjection,
} from "./f402_analyze_ingest.ts";
import { linkAccounts, type LinkReport } from "./f402_analyze_link.ts";
import { predictAccounts, type PredictReport } from "./f402_analyze_predict.ts";
import {
  backtestPredict,
  type CalibrationReport,
} from "./f402_analyze_calibrate.ts";
import { reportJoinCoverage, type JoinCoverage } from "./f402_analyze_join.ts";
import { renderReviewMarkdown } from "./f402_analyze_report.ts";
import { type AnalyzeConfig } from "./f402_analyze_config.ts";
import {
  filterProjection,
  type AnalyzeFilters,
} from "./f402_analyze_filter.ts";
import {
  RING_DISCLAIMER,
  buildRings,
  type AccountRing,
} from "./f402_analyze_rings.ts";
import { buildAccountTimeline } from "./f402_analyze_timeline.ts";
import { explainAccount, type AccountExplain } from "./f402_analyze_explain.ts";
import { diffPulls, type PullDiff } from "./f402_analyze_diff.ts";
import { type AnalyzeFormat } from "./f402_analyze_format.ts";

export {
  F402AnalyzeError,
  ingestPullDirectory,
  parseTicketFromText,
  parseWeblogAction,
  parseWeblogTicket,
  signedAmountCents,
  TRAN_TYPE_SPECS,
  type PullProjection,
} from "./f402_analyze_ingest.ts";
export type { F402AnalyzeErrorCode } from "./f402_analyze_ingest.ts";
export {
  combineEvidenceScores,
  EDGE_SCORE_MIN,
  ipRarity,
  LINK_DISCLAIMER,
  linkAccounts,
} from "./f402_analyze_link.ts";
export type {
  AccountCluster,
  AccountEdge,
  LinkReport,
} from "./f402_analyze_link.ts";
export {
  predictAccount,
  predictAccounts,
  PREDICT_SIGNAL_WEIGHTS,
  SIGNALS_NEEDING_MULTIPLE_CENSUS_SNAPSHOTS,
  SUGGESTED_SNAPSHOT_CADENCE,
} from "./f402_analyze_predict.ts";
export type {
  AccountPrediction,
  PredictReport,
  PredictSignalName,
} from "./f402_analyze_predict.ts";

export const F402_ANALYZE_DEFAULT_IN_DIR = F402_PULL_DEFAULT_OUT_DIR;
export type F402AnalyzeCommand =
  | "link"
  | "predict"
  | "calibrate"
  | "report"
  | "rings"
  | "explain"
  | "diff"
  | "timeline";

export interface AnalyzeRunOptions {
  readonly outDir?: string;
  readonly nowMs?: number;
  readonly horizonDays?: number;
  readonly config?: AnalyzeConfig;
  readonly filters?: AnalyzeFilters;
  readonly format?: AnalyzeFormat;
  readonly account?: string;
  readonly otherDir?: string;
}

const IP_KEY = /^(?:ip|ipaddress|ip_address)$/i;

export function hashIp(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed === "") return "";
  return `ip:${sha256Hex(`f402-analyze-ip:${trimmed}`).slice(0, 16)}`;
}

function hashIpsInString(value: string): string {
  return replaceIpsInText(value, (match) => hashIp(match));
}

export function hashIpsDeep(value: unknown): unknown {
  if (typeof value === "string") return hashIpsInString(value);
  if (Array.isArray(value)) return value.map(hashIpsDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (IP_KEY.test(key) && typeof child === "string") {
        out[key] =
          child === "" || child.startsWith("ip:") ? child : hashIp(child);
        continue;
      }
      out[key] = hashIpsDeep(child);
    }
    return out;
  }
  return value;
}

function isUnhashedIpField(child: unknown): boolean {
  return typeof child === "string" && child !== "" && !child.startsWith("ip:");
}

/**
 * Final backstop, mirroring the puller's `containsRawIp`: any IPv4/IPv6 left
 * in text, or an IP-named field whose value is not an `ip:` hash, is raw.
 */
export function containsUnhashedIp(value: unknown): boolean {
  if (typeof value === "string") return textContainsIp(value);
  if (Array.isArray(value)) return value.some(containsUnhashedIp);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, child]) =>
        (IP_KEY.test(key) && isUnhashedIpField(child)) ||
        containsUnhashedIp(child),
    );
  }
  return false;
}

export function assertNoRawIp(value: unknown, operation: string): void {
  if (containsUnhashedIp(value)) {
    throw new F402AnalyzeError(
      "config",
      operation,
      "refusing to emit a summary that still contains a raw IP",
    );
  }
}

export function analysisOutDir(inDir: string, outDir?: string): string {
  return outDir !== undefined && outDir.trim() !== ""
    ? outDir
    : join(inDir, "analysis");
}

function writeSummary(path: string, value: unknown, operation: string): void {
  assertNoRawIp(value, operation);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function runLinkAnalysis(
  inDir: string,
  options: AnalyzeRunOptions = {},
): {
  readonly report: LinkReport;
  readonly outPath: string;
  readonly rings: readonly AccountRing[];
} {
  const projection = loadProjection(inDir, options.filters ?? {});
  const report = linkAccounts(projection, {
    hashIp,
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  const rings = buildRings(report.edges, {
    minEdgeScore:
      options.config?.thresholds.ringMinEdgeScore ??
      options.config?.thresholds.minEdgeScore ??
      0.2,
    projection,
  });
  const sanitized = hashIpsDeep(report) as LinkReport;
  const sanitizedRings = hashIpsDeep(rings) as AccountRing[];
  const outPath = join(
    analysisOutDir(inDir, options.outDir),
    "link-summary.json",
  );
  writeSummary(outPath, { ...sanitized, rings: sanitizedRings }, "link");
  const dir = analysisOutDir(inDir, options.outDir);
  writeSummary(
    join(dir, "rings-summary.json"),
    {
      disclaimer: RING_DISCLAIMER,
      rings: sanitizedRings,
    },
    "rings",
  );
  return { report: sanitized, outPath, rings: sanitizedRings };
}

export function runPredictAnalysis(
  inDir: string,
  options: AnalyzeRunOptions = {},
): { readonly report: PredictReport; readonly outPath: string } {
  const projection = loadProjection(inDir, options.filters ?? {});
  const report = predictAccounts(projection, {
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    ...(options.config === undefined
      ? {}
      : { weights: options.config.weights.predict }),
  });
  const sanitized = hashIpsDeep(report) as PredictReport;
  const outPath = join(
    analysisOutDir(inDir, options.outDir),
    "predict-summary.json",
  );
  writeSummary(outPath, sanitized, "predict");
  return { report: sanitized, outPath };
}

export function loadProjection(
  inDir: string,
  filters: AnalyzeFilters = {},
): PullProjection {
  return filterProjection(ingestPullDirectory(inDir), filters);
}

export { reportJoinCoverage, JOIN_ASSUMPTIONS } from "./f402_analyze_join.ts";
export type { JoinCoverage } from "./f402_analyze_join.ts";
export {
  backtestPredict,
  brierScore,
  calibrationTable,
} from "./f402_analyze_calibrate.ts";
export type { CalibrationReport } from "./f402_analyze_calibrate.ts";
export { renderReviewMarkdown } from "./f402_analyze_report.ts";

export function runCalibrateAnalysis(
  inDir: string,
  options: AnalyzeRunOptions = {},
): { readonly report: CalibrationReport; readonly outPath: string } {
  const projection = loadProjection(inDir, options.filters ?? {});
  const report = backtestPredict(projection, {
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    ...(options.horizonDays === undefined
      ? {}
      : { horizonDays: options.horizonDays }),
    ...(options.config === undefined
      ? {}
      : { weights: options.config.weights.predict }),
  });
  const sanitized = hashIpsDeep(report) as CalibrationReport;
  const outPath = join(
    analysisOutDir(inDir, options.outDir),
    "calibrate-summary.json",
  );
  writeSummary(outPath, sanitized, "calibrate");
  return { report: sanitized, outPath };
}

export function runReviewAnalysis(
  inDir: string,
  options: AnalyzeRunOptions = {},
): {
  readonly markdown: string;
  readonly outPath: string;
  readonly join: JoinCoverage;
} {
  const projection = loadProjection(inDir, options.filters ?? {});
  const link = hashIpsDeep(
    linkAccounts(projection, {
      hashIp,
      ...(options.config === undefined ? {} : { config: options.config }),
    }),
  ) as LinkReport;
  const predict = hashIpsDeep(
    predictAccounts(projection, {
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
      ...(options.config === undefined
        ? {}
        : { weights: options.config.weights.predict }),
    }),
  ) as PredictReport;
  const joinCoverage = reportJoinCoverage(projection).coverage;
  const calibration = backtestPredict(projection, {
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    ...(options.horizonDays === undefined
      ? {}
      : { horizonDays: options.horizonDays }),
  });
  const generatedAtIso = new Date(options.nowMs ?? Date.now()).toISOString();
  const markdown = renderReviewMarkdown({
    generatedAtIso,
    inDir,
    link,
    predict,
    join: joinCoverage,
    calibration,
  });
  const sanitized = String(hashIpsDeep(markdown));
  const dir = analysisOutDir(inDir, options.outDir);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, "review.md");
  writeSummary(
    join(dir, "review-summary.json"),
    { generatedAtIso, join: joinCoverage, outPath },
    "report",
  );
  assertNoRawIp(sanitized, "report");
  writeFileSync(
    outPath,
    sanitized.endsWith("\n") ? sanitized : `${sanitized}\n`,
    {
      mode: 0o600,
    },
  );
  return { markdown: sanitized, outPath, join: joinCoverage };
}

export {
  parseAnalyzeConfig,
  loadAnalyzeConfig,
  EMPTY_ANALYZE_CONFIG,
  type AnalyzeConfig,
} from "./f402_analyze_config.ts";
export {
  filterProjection,
  parseAccountList,
  parseMinStake,
  parseSportsList,
  type AnalyzeFilters,
} from "./f402_analyze_filter.ts";
export {
  buildRings,
  RING_DISCLAIMER,
  type AccountRing,
} from "./f402_analyze_rings.ts";
export {
  buildAccountTimeline,
  timelineForAccount,
  TIMELINE_DISCLAIMER,
} from "./f402_analyze_timeline.ts";
export { explainAccount, EXPLAIN_DISCLAIMER } from "./f402_analyze_explain.ts";
export {
  diffPulls,
  DIFF_DISCLAIMER,
  type PullDiff,
} from "./f402_analyze_diff.ts";
export {
  parseAnalyzeFormat,
  renderAnalyzeOutput,
  type AnalyzeFormat,
} from "./f402_analyze_format.ts";

export function runRingsAnalysis(
  inDir: string,
  options: AnalyzeRunOptions = {},
): { readonly rings: readonly AccountRing[]; readonly outPath: string } {
  const { rings } = runLinkAnalysis(inDir, options);
  const outPath = join(
    analysisOutDir(inDir, options.outDir),
    "rings-summary.json",
  );
  return { rings, outPath };
}

export function runTimelineAnalysis(
  inDir: string,
  options: AnalyzeRunOptions = {},
): ReturnType<typeof buildAccountTimeline> & { readonly outPath: string } {
  const projection = loadProjection(inDir, options.filters ?? {});
  const report = buildAccountTimeline(
    projection,
    options.filters?.accounts === undefined
      ? {}
      : { accounts: options.filters.accounts },
  );
  const sanitized = hashIpsDeep(report) as ReturnType<
    typeof buildAccountTimeline
  >;
  const outPath = join(
    analysisOutDir(inDir, options.outDir),
    "timeline-summary.json",
  );
  writeSummary(outPath, sanitized, "timeline");
  return { ...sanitized, outPath };
}

export function runExplainAnalysis(
  inDir: string,
  options: AnalyzeRunOptions,
): { readonly explain: AccountExplain; readonly outPath: string } {
  const account = options.account?.trim() ?? "";
  if (account === "") {
    throw new F402AnalyzeError("config", "explain", "missing --account");
  }
  const projection = loadProjection(inDir, options.filters ?? {});
  const { report, rings } = runLinkAnalysis(inDir, options);
  const predict = predictAccounts(projection, {
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    ...(options.config === undefined
      ? {}
      : { weights: options.config.weights.predict }),
  });
  const prediction =
    predict.accounts.find(
      (row) =>
        row.accountId === account ||
        row.login.toLowerCase() === account.toLowerCase(),
    ) ?? null;
  const explain = hashIpsDeep(
    explainAccount(projection, account, {
      link: report,
      rings,
      prediction,
    }),
  ) as AccountExplain;
  const outPath = join(
    analysisOutDir(inDir, options.outDir),
    `explain-${explain.accountId}.json`,
  );
  writeSummary(outPath, explain, "explain");
  return { explain, outPath };
}

export function runDiffAnalysis(
  leftDir: string,
  rightDir: string,
  options: AnalyzeRunOptions = {},
): { readonly diff: PullDiff; readonly outPath: string } {
  const left = loadProjection(leftDir, options.filters ?? {});
  const right = loadProjection(rightDir, options.filters ?? {});
  const diff = hashIpsDeep(diffPulls(left, right)) as PullDiff;
  const outPath = join(
    analysisOutDir(leftDir, options.outDir),
    "diff-summary.json",
  );
  writeSummary(outPath, diff, "diff");
  return { diff, outPath };
}
