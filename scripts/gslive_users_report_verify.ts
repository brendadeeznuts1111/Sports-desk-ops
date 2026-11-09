#!/usr/bin/env bun
/**
 * End-to-end capture→compare workflow for the GSLive `users-report` control.
 *
 * Strict sequence (the comparison is gated on a fresh, provenance-stamped capture):
 *   1. session preflight (cookie-only partnerConfig GET); AUTH_EXPIRED stops here;
 *   2. capture the report, redact identity, write the artifact;
 *   3. re-read the artifact and verify freshness/provenance;
 *   4. verify scope against the corpus window;
 *   5. compare per-account aggregates and emit one structured summary.
 *
 * Exit codes: 0 ok; 3 AUTH_EXPIRED; 4 invalid/refused report; 5 network/scope failure;
 * 6 stale report; 7 no join.
 *
 * Session preflight is the difference from running capture and compare separately: a stale
 * session stops before an artifact can be reused.
 */

import { chmod, mkdir, rename } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import {
  USERS_REPORT_CONTROL_REL_PATH,
  aggregateCorpusTickets,
  buildUsersReportControlArtifact,
  captureUsersReport,
  compareUsersReportToCorpus,
  readUsersReportArtifact,
  sha256FileHex,
  UsersReportError,
} from "../lib/gslive_users_report.ts";
import { probeGsliveSession } from "../lib/gslive_session_health.ts";
import {
  resolveManagerSession,
  sessionGateFromEnv,
} from "../lib/manager_session.ts";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_CORPUS =
  "Scratch/security/corpus/gslive-betreport-all-2026-11-03.json";

function usage(): string {
  return [
    "verify:gslive-users-report — preflight, capture, then compare (gated)",
    "",
    "Options:",
    "  --from <epochSec>      Window start (required)",
    "  --to <epochSec>        Window end (required)",
    "  --partner-id <n>       Partner id (default 118)",
    "  --out <path>           Artifact path (default Scratch/security/review-captures/users-report-<from>-<to>.redacted.json)",
    "  --corpus <path>        Corpus path (default Scratch/security/corpus/gslive-betreport-all-2026-11-03.json)",
    "  --max-age-minutes <n>  Freshness gate (default 1440)",
    "  --control-out <path>   Control artifact path (default reports/security/users-report-control.json)",
    "  --no-control           Do not write a control artifact",
    "  --dry-run              Print the plan; no session read, no network, no writes",
    "  -h, --help             This text",
  ].join("\n");
}

interface Args {
  from: number;
  to: number;
  partnerId: number;
  out: string;
  corpus: string;
  maxAgeMinutes: number;
  controlOut: string | null;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Args | "help" {
  let from: number | null = null;
  let to: number | null = null;
  let partnerId = 118;
  let out: string | null = null;
  let corpus = DEFAULT_CORPUS;
  let maxAgeMinutes = 24 * 60;
  let controlOut: string | null = USERS_REPORT_CONTROL_REL_PATH;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-h" || token === "--help") return "help";
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--no-control") {
      controlOut = null;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new UsersReportError(
        "invalid_response",
        `${token} requires a value`,
      );
    }
    index += 1;
    if (token === "--from" || token === "--to") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new UsersReportError(
          "invalid_response",
          `${token} must be a non-negative integer epoch second`,
        );
      }
      if (token === "--from") from = parsed;
      else to = parsed;
    } else if (token === "--partner-id") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new UsersReportError(
          "invalid_response",
          "--partner-id must be a positive integer",
        );
      }
      partnerId = parsed;
    } else if (token === "--out") out = value;
    else if (token === "--corpus") corpus = value;
    else if (token === "--control-out") controlOut = value;
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
  if (from === null || to === null) {
    throw new UsersReportError(
      "invalid_response",
      `--from and --to are required\n${usage()}`,
    );
  }
  return {
    from,
    to,
    partnerId,
    out:
      out ??
      `Scratch/security/review-captures/users-report-${from}-${to}.redacted.json`,
    corpus,
    maxAgeMinutes,
    controlOut,
    dryRun,
  };
}

function emit(result: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function writeControl(
  path: string,
  artifact: Readonly<Record<string, unknown>>,
): Promise<string> {
  const outPath = resolve(ROOT, path);
  await mkdir(dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp-${process.pid}`;
  await Bun.write(tmpPath, `${JSON.stringify(artifact, null, 2)}\n`);
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, outPath);
  return relative(ROOT, outPath).split("\\").join("/");
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
  if (parsed.dryRun) {
    emit({
      status: "dry_run",
      plan: {
        preflight: "probe session (cookie-only partnerConfig GET)",
        capture: {
          from: parsed.from,
          to: parsed.to,
          partnerId: parsed.partnerId,
          out: parsed.out,
        },
        compare: { corpus: parsed.corpus, maxAgeMinutes: parsed.maxAgeMinutes },
      },
      sequence: ["preflight", "capture", "freshness", "scope", "compare"],
    });
    return 0;
  }
  const session = await resolveManagerSession();
  if (session.source === "none") {
    emit({
      status: "auth_expired",
      message:
        "AUTH_EXPIRED: no GSLive manager session; provision it, then retry once",
    });
    process.stderr.write(
      "auth_expired: no GSLive manager session; provision it, then retry once\n",
    );
    return 3;
  }
  const preflight = await probeGsliveSession(session.cookieHeader);
  if (preflight.status !== "ok") {
    emit({
      status: "auth_expired",
      message: `AUTH_EXPIRED: session preflight ${preflight.status} — ${preflight.detail}`,
      preflight: {
        status: preflight.status,
        httpStatus: preflight.httpStatus,
        cfMitigated: preflight.cfMitigated,
      },
    });
    process.stderr.write(`auth_expired: preflight ${preflight.status}\n`);
    return 3;
  }
  const capture = await captureUsersReport({
    fromEpochSec: parsed.from,
    toEpochSec: parsed.to,
    partnerId: parsed.partnerId,
    cookieHeader: session.cookieHeader,
    sessionSource: session.source,
    sessionGate: sessionGateFromEnv(Bun.env),
  });
  const artifact = {
    schemaVersion: 1,
    kind: "gslive-users-report-capture",
    ...capture,
    request: { method: "GET", url: capture.url },
    preflight: {
      status: preflight.status,
      httpStatus: preflight.httpStatus,
      checkedAt: preflight.checkedAt,
      detail: preflight.detail,
    },
    redaction: {
      strings: "sha256:<16> prefix; raw identity strings are not stored",
      numbers: "kept",
      booleans: "kept",
      nested: "sha256 of JSON",
      rawBody: "not stored; rawSha256 records the digest",
    },
  };
  const outPath = resolve(ROOT, parsed.out);
  await mkdir(dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp-${process.pid}`;
  await Bun.write(tmpPath, `${JSON.stringify(artifact, null, 2)}\n`);
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, outPath);
  const relativeOut = relative(ROOT, outPath).split("\\").join("/");

  const assessment = readUsersReportArtifact(artifact, {
    maxAgeMinutes: parsed.maxAgeMinutes,
  });
  const provenance = {
    capturedAt: artifact.capturedAt,
    ageMinutes:
      assessment.ageMinutes === null
        ? null
        : Number(assessment.ageMinutes.toFixed(1)),
    rawSha256: artifact.rawSha256,
    sessionSource: artifact.sessionSource,
    envelope: artifact.envelope,
  };
  if (assessment.status !== "fresh") {
    emit({
      status: assessment.status,
      captured: relativeOut,
      provenance,
      reasons: assessment.reasons,
    });
    process.stderr.write(
      `${assessment.status}: ${assessment.reasons.join("; ")}\n`,
    );
    return assessment.status === "stale" ? 6 : 4;
  }
  const corpusPath = resolve(ROOT, parsed.corpus);
  const corpus = (await Bun.file(corpusPath).json()) as {
    from?: unknown;
    to?: unknown;
    r?: { bets?: unknown };
  };
  const bets = Array.isArray(corpus.r?.bets) ? corpus.r.bets : [];
  const corpusFrom = typeof corpus.from === "number" ? corpus.from : null;
  const corpusTo = typeof corpus.to === "number" ? corpus.to : null;
  const corpusSha256 = await sha256FileHex(corpusPath);
  const corpusAggregates = aggregateCorpusTickets(bets);
  const corpusTickets = [...corpusAggregates.byUserId.values()].reduce(
    (sum, account) => sum + account.tickets,
    0,
  );
  const scopeMatch =
    corpusFrom !== null &&
    corpusTo !== null &&
    artifact.fromEpochSec === corpusFrom &&
    artifact.toEpochSec === corpusTo;
  const controlCommon = {
    reportPath: parsed.out,
    capture: artifact,
    corpusPath: parsed.corpus,
    corpusSha256,
    corpusFrom,
    corpusTo,
    corpusTickets,
    scopeMatch,
  } as const;
  if (!scopeMatch) {
    const control =
      parsed.controlOut === null
        ? null
        : await writeControl(
            parsed.controlOut,
            buildUsersReportControlArtifact({
              ...controlCommon,
              status: "scope_mismatch",
              join: null,
              candidates: [],
              note: "report window differs from corpus window",
            }),
          );
    emit({
      status: "scope_mismatch",
      captured: relativeOut,
      provenance,
      scope: {
        report: { from: artifact.fromEpochSec, to: artifact.toEpochSec },
        corpus: { from: corpusFrom, to: corpusTo },
      },
      control,
    });
    process.stderr.write(
      "scope_mismatch: report window differs from corpus window\n",
    );
    return 5;
  }
  let comparison;
  try {
    comparison = compareUsersReportToCorpus(artifact.report, corpusAggregates);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const control =
      parsed.controlOut === null
        ? null
        : await writeControl(
            parsed.controlOut,
            buildUsersReportControlArtifact({
              ...controlCommon,
              status: "no_join",
              join: null,
              candidates: [],
              note: message,
            }),
          );
    emit({
      status: "no_join",
      captured: relativeOut,
      provenance,
      reportRows: artifact.report.rowCount,
      corpusTickets,
      control,
      message,
    });
    process.stderr.write(`no_join: ${message}\n`);
    return 7;
  }
  const join = {
    idColumn: comparison.idColumn,
    idKind: comparison.idKind,
    matchedIds: comparison.overlap,
    unmatchedReportIds: Math.max(
      0,
      artifact.report.rowCount - comparison.overlap,
    ),
    duplicateIdRows: duplicateIdRows(artifact.report.rows, comparison.idColumn),
  };
  const control =
    parsed.controlOut === null
      ? null
      : await writeControl(
          parsed.controlOut,
          buildUsersReportControlArtifact({
            ...controlCommon,
            status: "ok",
            join,
            candidates: comparison.candidates,
            note: comparison.note,
          }),
        );
  emit({
    status: "ok",
    captured: relativeOut,
    provenance,
    scope: {
      match: true,
      from: artifact.fromEpochSec,
      to: artifact.toEpochSec,
    },
    reportRows: artifact.report.rowCount,
    corpusTickets,
    join,
    candidates: comparison.candidates,
    note: comparison.note,
    control,
  });
  return 0;
}

try {
  process.exit(await main());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof UsersReportError ? error.code : "error";
  const exitCode =
    error instanceof UsersReportError
      ? error.code === "auth_expired"
        ? 3
        : error.code === "http_error"
          ? 5
          : 4
      : 1;
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(exitCode);
}
