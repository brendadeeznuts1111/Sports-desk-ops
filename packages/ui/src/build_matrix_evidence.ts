/**
 * @file build_matrix_evidence.ts
 * @description Plain-text evidence for the DCE build matrix: one line per target
 * and a Markdown table, so a probe result can be pasted into a PR, an issue or the
 * evidence ledger with the numbers copied rather than re-typed.
 *
 * The drawer renders its own display formatting; this module is the copy path and
 * is deliberately independent of React so the wording is unit-tested.
 */

import { FEATURES } from "@sportsdesk-ops/contracts";
import type { BuildMatrixRow } from "./types.ts";

/** Retained-branch probes carried by every matrix row. */
export const MATRIX_BRANCHES = ["PROD", "DEBUG", "EXPERIMENTAL"] as const;
export type MatrixBranch = (typeof MATRIX_BRANCHES)[number];

const REGISTERED_FEATURES: ReadonlySet<string> = new Set(FEATURES);

export interface MatrixEvidenceMeta {
  /** Runtime target the page actually serves. */
  readonly target?: string | undefined;
  readonly generatedAt?: string | null | undefined;
  readonly compiledMs?: number | null | undefined;
}

function branchKey(
  branch: MatrixBranch,
): "hasProdSentinel" | "hasDebugSentinel" | "hasExperimentalSentinel" {
  if (branch === "PROD") return "hasProdSentinel";
  if (branch === "DEBUG") return "hasDebugSentinel";
  return "hasExperimentalSentinel";
}

/** `kept` / `pruned` for one branch probe. */
export function branchState(
  row: BuildMatrixRow,
  branch: MatrixBranch,
): "kept" | "pruned" {
  return row[branchKey(branch)] ? "kept" : "pruned";
}

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatDelta(
  bytes: number,
  baselineBytes: number | null,
): { readonly text: string; readonly kb: string } {
  if (baselineBytes === null || baselineBytes <= 0) {
    return { text: "n/a", kb: "n/a" };
  }
  const diff = bytes - baselineBytes;
  if (diff === 0) return { text: "baseline", kb: "baseline" };
  const pct = ((diff / baselineBytes) * 100).toFixed(1);
  const sign = diff > 0 ? "+" : "";
  return {
    text: `${diff}B (${sign}${pct}%)`,
    kb: `${sign}${formatKb(diff)} (${sign}${pct}%)`,
  };
}

function formatFlags(features: readonly string[]): string {
  if (features.length === 0) return "none";
  return features
    .map((flag) =>
      REGISTERED_FEATURES.has(flag) ? flag : `${flag}(unregistered)`,
    )
    .join(", ");
}

/**
 * One self-contained line per target: exact byte counts plus branch retention, so
 * a quoted number can be traced back to the probe that produced it.
 */
export function formatMatrixRowEvidence(
  row: BuildMatrixRow,
  devBaselineBytes: number | null,
): string {
  const branches = MATRIX_BRANCHES.map(
    (branch) => `${branch}=${branchState(row, branch)}`,
  ).join(", ");
  return [
    row.target,
    `flags=${formatFlags(row.features)}`,
    `js=${row.totalJsBytes}B`,
    `css=${row.totalCssBytes}B`,
    `total=${row.totalJsBytes + row.totalCssBytes}B`,
    `deltaVsDev=${formatDelta(row.totalJsBytes, devBaselineBytes).text}`,
    `branches: ${branches}`,
  ].join(" · ");
}

function metaLine(meta: MatrixEvidenceMeta | undefined): string {
  const parts = ["DCE matrix"];
  if (meta?.target !== undefined && meta.target.length > 0) {
    parts.push(`runtime target=${meta.target}`);
  }
  if (meta?.generatedAt !== null && meta?.generatedAt !== undefined) {
    parts.push(`probe=${meta.generatedAt}`);
  }
  if (meta?.compiledMs !== null && meta?.compiledMs !== undefined) {
    parts.push(`compiled=${Math.round(meta.compiledMs)}ms`);
  }
  return parts.join(" · ");
}

/**
 * The whole probe as a Markdown table: header/meta line, table, one row per target.
 * Empty input returns an explicit note rather than an empty table.
 */
export function formatMatrixEvidenceTable(
  rows: readonly BuildMatrixRow[],
  devBaselineBytes: number | null,
  meta?: MatrixEvidenceMeta,
): string {
  if (rows.length === 0) {
    return `${metaLine(meta)}\n\n(no target rows in the probe)`;
  }
  const header = [
    "target",
    "flags",
    "JS",
    "CSS",
    "total",
    "Δ vs dev",
    ...MATRIX_BRANCHES,
  ];
  const divider = [
    "---",
    "---",
    "---:",
    "---:",
    "---:",
    "---:",
    ...MATRIX_BRANCHES.map(() => "---"),
  ];
  const body = rows.map((row) => [
    row.target,
    formatFlags(row.features),
    formatKb(row.totalJsBytes),
    formatKb(row.totalCssBytes),
    formatKb(row.totalJsBytes + row.totalCssBytes),
    formatDelta(row.totalJsBytes, devBaselineBytes).kb,
    ...MATRIX_BRANCHES.map((branch) => branchState(row, branch)),
  ]);
  return [
    metaLine(meta),
    "",
    `| ${header.join(" | ")} |`,
    `| ${divider.join(" | ")} |`,
    ...body.map((cells) => `| ${cells.join(" | ")} |`),
  ].join("\n");
}
