#!/usr/bin/env bun
/**
 * Compare a redacted GSLive `users-report` capture against `getBetReport` ticket aggregates.
 *
 * Read-only. The users-report capture is a second encoding in the same book, not external
 * settlement truth: the output ranks candidate metric columns and reports scope-match first.
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
  type RedactedUsersReport,
} from "../lib/gslive_users_report.ts";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_CORPUS =
  "Scratch/security/corpus/gslive-betreport-all-2026-11-03.json";

function usage(): string {
  return [
    "compare:gslive-users-report — users-report vs getBetReport per-account aggregates",
    "",
    "Options:",
    "  --report <path>   Redacted users-report capture (required)",
    "  --corpus <path>   getBetReport corpus (default Scratch/security/corpus/gslive-betreport-all-2026-11-03.json)",
    "  -h, --help        This text",
  ].join("\n");
}

interface Args {
  report: string;
  corpus: string;
}

function parseArgs(argv: readonly string[]): Args | "help" {
  let report: string | null = null;
  let corpus = DEFAULT_CORPUS;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-h" || token === "--help") return "help";
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`${token} requires a value`);
    }
    index += 1;
    if (token === "--report") report = value;
    else if (token === "--corpus") corpus = value;
    else throw new Error(`unknown flag ${token}\n${usage()}`);
  }
  if (report === null) throw new Error(`--report is required\n${usage()}`);
  return { report, corpus };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readReportArtifact(raw: unknown): {
  report: RedactedUsersReport;
  from: number | null;
  to: number | null;
} {
  const record = asRecord(raw);
  if (record === null) {
    throw new UsersReportError(
      "invalid_response",
      "report artifact is not a JSON object",
    );
  }
  const candidate = asRecord(record["report"]) ?? record;
  const rows = candidate["rows"];
  const columns = candidate["columns"];
  const numericColumns = candidate["numericColumns"];
  const stringColumns = candidate["stringColumns"];
  if (
    !Array.isArray(rows) ||
    !Array.isArray(columns) ||
    !Array.isArray(numericColumns) ||
    !Array.isArray(stringColumns)
  ) {
    throw new UsersReportError(
      "invalid_response",
      "report artifact is not a redacted users-report (expected rows/columns/numericColumns/stringColumns)",
    );
  }
  return {
    report: {
      rows: rows as RedactedUsersReport["rows"],
      columns: columns as string[],
      numericColumns: numericColumns as string[],
      stringColumns: stringColumns as string[],
      rowCount:
        typeof candidate["rowCount"] === "number"
          ? candidate["rowCount"]
          : rows.length,
    },
    from:
      typeof record["fromEpochSec"] === "number"
        ? record["fromEpochSec"]
        : null,
    to: typeof record["toEpochSec"] === "number" ? record["toEpochSec"] : null,
  };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    console.log(usage());
    return 0;
  }
  const reportPath = resolve(ROOT, parsed.report);
  const corpusPath = resolve(ROOT, parsed.corpus);
  if (!existsSync(reportPath)) {
    throw new UsersReportError(
      "invalid_response",
      `report artifact not found: ${parsed.report}`,
    );
  }
  if (!existsSync(corpusPath)) {
    throw new UsersReportError(
      "invalid_response",
      `corpus not found: ${parsed.corpus}`,
    );
  }
  const rawReport = (await Bun.file(reportPath).json()) as unknown;
  const artifact = readReportArtifact(rawReport);
  const corpus = (await Bun.file(corpusPath).json()) as {
    from?: unknown;
    to?: unknown;
    r?: { bets?: unknown };
  };
  const bets = Array.isArray(corpus.r?.bets) ? corpus.r.bets : [];
  if (bets.length === 0) {
    throw new UsersReportError(
      "invalid_response",
      `corpus has no r.bets rows: ${parsed.corpus}`,
    );
  }
  const corpusFrom = typeof corpus.from === "number" ? corpus.from : null;
  const corpusTo = typeof corpus.to === "number" ? corpus.to : null;
  const scopeMatch =
    artifact.from !== null &&
    artifact.to !== null &&
    corpusFrom !== null &&
    corpusTo !== null
      ? artifact.from === corpusFrom && artifact.to === corpusTo
      : null;
  const comparison = compareUsersReportToCorpus(
    artifact.report,
    aggregateCorpusTickets(bets),
  );
  console.log(
    JSON.stringify(
      {
        report: parsed.report,
        corpus: parsed.corpus,
        scope: {
          match: scopeMatch,
          report: { from: artifact.from, to: artifact.to },
          corpus: { from: corpusFrom, to: corpusTo },
          note:
            scopeMatch === true
              ? "same window; per-account deltas are comparable"
              : "window mismatch or unknown; treat the comparison as a shape check only",
        },
        comparison,
      },
      null,
      2,
    ),
  );
  return 0;
}

try {
  process.exit(await main());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof UsersReportError ? error.code : "error";
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}
