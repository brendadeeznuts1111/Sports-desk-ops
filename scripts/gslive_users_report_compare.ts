#!/usr/bin/env bun
/**
 * Compare a provenance-stamped redacted GSLive `users-report` capture against `getBetReport`
 * ticket aggregates.
 *
 * Read-only. The capture must carry its own provenance (capture kind, capturedAt, raw response
 * digest) and be recent; a bare or stale report is refused rather than silently reused. Comparison
 * output is candidate evidence from a second encoding in the same book, never external settlement
 * truth.
 *
 * Exit codes: 0 ok; 4 invalid/unverified artifact; 5 scope mismatch; 6 stale report; 7 no join.
 *
 * Usage:
 *   bun run compare:gslive-users-report \
 *     --report Scratch/security/review-captures/users-report-1793163600-1793771999.redacted.json \
 *     --corpus Scratch/security/corpus/gslive-betreport-all-2026-11-03.json
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  UsersReportError,
  aggregateCorpusTickets,
  compareUsersReportToCorpus,
  readUsersReportArtifact,
} from "../lib/gslive_users_report.ts";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_CORPUS =
  "Scratch/security/corpus/gslive-betreport-all-2026-11-03.json";
const DEFAULT_MAX_AGE_MINUTES = 24 * 60;

function usage(): string {
  return [
    "compare:gslive-users-report — users-report vs getBetReport per-account aggregates",
    "",
    "Options:",
    "  --report <path>        Redacted users-report capture (required)",
    `  --corpus <path>        getBetReport corpus (default ${DEFAULT_CORPUS})`,
    "  --max-age-minutes <n>  Refuse a report older than this (default 1440)",
    "  --allow-stale          Compare a stale artifact anyway (status stays stale)",
    "  --allow-scope-mismatch Compare even when the report window differs from the corpus window",
    "  --json                 Accepted for consistency; output is always one JSON object",
    "  -h, --help             This text",
    "",
    "Exit codes: 0 ok; 4 invalid/unverified artifact; 5 scope mismatch; 6 stale report; 7 no join.",
  ].join("\n");
}

interface Args {
  report: string;
  corpus: string;
  maxAgeMinutes: number;
  allowStale: boolean;
  allowScopeMismatch: boolean;
}

function parseArgs(argv: readonly string[]): Args | "help" {
  let report: string | null = null;
  let corpus = DEFAULT_CORPUS;
  let maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES;
  let allowStale = false;
  let allowScopeMismatch = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-h" || token === "--help") return "help";
    if (token === "--allow-stale") {
      allowStale = true;
      continue;
    }
    if (token === "--allow-scope-mismatch") {
      allowScopeMismatch = true;
      continue;
    }
    if (token === "--json") continue;
    const value = argv[index + 1];
    if (value === undefined) {
      throw new UsersReportError(
        "invalid_response",
        `${token} requires a value`,
      );
    }
    index += 1;
    if (token === "--report") report = value;
    else if (token === "--corpus") corpus = value;
    else if (token === "--max-age-minutes") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new UsersReportError(
          "invalid_response",
          "--max-age-minutes must be a positive number",
        );
      }
      maxAgeMinutes = parsed;
    } else {
      throw new UsersReportError(
        "invalid_response",
        `unknown flag ${token}\n${usage()}`,
      );
    }
  }
  if (report === null) {
    throw new UsersReportError(
      "invalid_response",
      `--report is required\n${usage()}`,
    );
  }
  return { report, corpus, maxAgeMinutes, allowStale, allowScopeMismatch };
}

function emit(result: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function duplicateIdRows(
  rows: readonly Readonly<Record<string, number | boolean | null | string>>[],
  idColumn: string,
): number {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const cell = row[idColumn];
    if (cell === undefined) continue;
    const key = String(cell);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let duplicates = 0;
  for (const count of seen.values()) {
    if (count > 1) duplicates += count - 1;
  }
  return duplicates;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    console.log(usage());
    return 0;
  }
  const reportPath = resolve(ROOT, parsed.report);
  const corpusPath = resolve(ROOT, parsed.corpus);
  const inputs = { report: parsed.report, corpus: parsed.corpus };
  if (!existsSync(reportPath)) {
    emit({
      inputs,
      status: "invalid_artifact",
      message: `report artifact not found: ${parsed.report}`,
    });
    process.stderr.write(
      `invalid_artifact: report not found ${parsed.report}\n`,
    );
    return 4;
  }
  if (!existsSync(corpusPath)) {
    emit({
      inputs,
      status: "invalid_input",
      message: `corpus not found: ${parsed.corpus}`,
    });
    process.stderr.write(`invalid_input: corpus not found ${parsed.corpus}\n`);
    return 4;
  }
  let assessment;
  try {
    assessment = readUsersReportArtifact(
      (await Bun.file(reportPath).json()) as unknown,
      { maxAgeMinutes: parsed.maxAgeMinutes },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ inputs, status: "invalid_artifact", message });
    process.stderr.write(`invalid_artifact: ${message}\n`);
    return 4;
  }
  const { artifact } = assessment;
  const provenance = {
    capturedAt: artifact.capturedAt,
    ageMinutes:
      assessment.ageMinutes === null
        ? null
        : Number(assessment.ageMinutes.toFixed(1)),
    maxAgeMinutes: parsed.maxAgeMinutes,
    rawSha256: artifact.rawSha256,
    sessionSource: artifact.sessionSource,
    envelope: artifact.envelope,
    reportKind: "users-report",
  };
  if (assessment.status === "stale" && !parsed.allowStale) {
    emit({
      inputs,
      status: "stale_report",
      provenance,
      reasons: assessment.reasons,
    });
    process.stderr.write(
      `stale_report: ${assessment.reasons.join("; ")} (use --allow-stale to compare anyway)\n`,
    );
    return 6;
  }
  const corpus = (await Bun.file(corpusPath).json()) as {
    from?: unknown;
    to?: unknown;
    r?: { bets?: unknown };
  };
  const bets = Array.isArray(corpus.r?.bets) ? corpus.r.bets : [];
  if (bets.length === 0) {
    emit({
      inputs,
      status: "invalid_input",
      provenance,
      message: `corpus has no r.bets rows: ${parsed.corpus}`,
    });
    process.stderr.write(
      `invalid_input: corpus has no rows ${parsed.corpus}\n`,
    );
    return 4;
  }
  const corpusFrom = typeof corpus.from === "number" ? corpus.from : null;
  const corpusTo = typeof corpus.to === "number" ? corpus.to : null;
  const scopeMatch =
    corpusFrom !== null &&
    corpusTo !== null &&
    artifact.fromEpochSec === corpusFrom &&
    artifact.toEpochSec === corpusTo;
  const scope = {
    match: scopeMatch,
    report: { from: artifact.fromEpochSec, to: artifact.toEpochSec },
    corpus: { from: corpusFrom, to: corpusTo },
    note: scopeMatch
      ? "same window; per-account deltas are comparable"
      : "window mismatch or unknown; per-account deltas are not comparable",
  };
  if (!scopeMatch && !parsed.allowScopeMismatch) {
    emit({ inputs, status: "scope_mismatch", provenance, scope });
    process.stderr.write(
      "scope_mismatch: report window differs from corpus window (use --allow-scope-mismatch to inspect the shape anyway)\n",
    );
    return 5;
  }
  const corpusAggregates = aggregateCorpusTickets(bets);
  const corpusTickets = [...corpusAggregates.byUserId.values()].reduce(
    (sum, account) => sum + account.tickets,
    0,
  );
  let comparison;
  try {
    comparison = compareUsersReportToCorpus(artifact.report, corpusAggregates);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({
      inputs,
      status: "no_join",
      provenance,
      scope,
      reportRows: artifact.report.rowCount,
      corpusTickets,
      message,
    });
    process.stderr.write(`no_join: ${message}\n`);
    return 7;
  }
  emit({
    inputs,
    status: "ok",
    provenance,
    scope,
    reportRows: artifact.report.rowCount,
    reportColumns: artifact.report.columns,
    numericColumns: artifact.report.numericColumns,
    stringColumns: artifact.report.stringColumns,
    corpusTickets,
    join: {
      idColumn: comparison.idColumn,
      idKind: comparison.idKind,
      matchedIds: comparison.overlap,
      unmatchedReportIds: Math.max(
        0,
        artifact.report.rowCount - comparison.overlap,
      ),
      duplicateIdRows: duplicateIdRows(
        artifact.report.rows,
        comparison.idColumn,
      ),
    },
    candidates: comparison.candidates,
    note: comparison.note,
  });
  return 0;
}

try {
  process.exit(await main());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof UsersReportError ? error.code : "error";
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(4);
}
