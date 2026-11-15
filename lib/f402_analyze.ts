/**
 * Box-local analysis over a Fantasy402 puller directory: account linking
 * and change prediction. Summaries hash IPs and never print them raw.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "./f402_bet_ticker_delta.ts";
import { F402_PULL_DEFAULT_OUT_DIR } from "./f402_readonly_puller.ts";
import {
  F402AnalyzeError,
  ingestPullDirectory,
  type PullProjection,
} from "./f402_analyze_ingest.ts";
import { linkAccounts, type LinkReport } from "./f402_analyze_link.ts";
import { predictAccounts, type PredictReport } from "./f402_analyze_predict.ts";

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
export type F402AnalyzeCommand = "link" | "predict";

const IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;
const IPV6 = /\b(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b/;

export function hashIp(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed === "") return "";
  return `ip:${sha256Hex(`f402-analyze-ip:${trimmed}`).slice(0, 16)}`;
}

function hashIpsInString(value: string): string {
  return value
    .replace(IPV4, (match) => hashIp(match))
    .replace(IPV6, (match) =>
      match.includes("::") || match.includes(":") ? hashIp(match) : match,
    );
}

export function hashIpsDeep(value: unknown): unknown {
  if (typeof value === "string") return hashIpsInString(value);
  if (Array.isArray(value)) return value.map(hashIpsDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        /^(?:ip|ipaddress|ip_address)$/i.test(key) &&
        typeof child === "string"
      ) {
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

export function containsUnhashedIp(value: unknown): boolean {
  if (typeof value === "string") return IPV4.test(value);
  if (Array.isArray(value)) return value.some(containsUnhashedIp);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsUnhashedIp);
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
  options: { readonly outDir?: string } = {},
): { readonly report: LinkReport; readonly outPath: string } {
  const projection = ingestPullDirectory(inDir);
  const report = linkAccounts(projection, { hashIp });
  const sanitized = hashIpsDeep(report) as LinkReport;
  const outPath = join(
    analysisOutDir(inDir, options.outDir),
    "link-summary.json",
  );
  writeSummary(outPath, sanitized, "link");
  return { report: sanitized, outPath };
}

export function runPredictAnalysis(
  inDir: string,
  options: { readonly outDir?: string; readonly nowMs?: number } = {},
): { readonly report: PredictReport; readonly outPath: string } {
  const projection = ingestPullDirectory(inDir);
  const report = predictAccounts(
    projection,
    options.nowMs === undefined ? {} : { nowMs: options.nowMs },
  );
  const sanitized = hashIpsDeep(report) as PredictReport;
  const outPath = join(
    analysisOutDir(inDir, options.outDir),
    "predict-summary.json",
  );
  writeSummary(outPath, sanitized, "predict");
  return { report: sanitized, outPath };
}

export function loadProjection(inDir: string): PullProjection {
  return ingestPullDirectory(inDir);
}
