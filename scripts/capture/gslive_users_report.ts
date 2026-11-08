#!/usr/bin/env bun
/**
 * Capture the GSLive Manager Tools `users-report` as a redacted, committed-safe artifact.
 *
 *   GET /manager-tools/reports/?from=<epochSec>&to=<epochSec>&partnerId=118&kind=users-report
 *
 * Session-gated and read-only: the cookie is resolved from the manager-session SSOT and never
 * printed; strings in the response (player logins/names) are hashed before writing, numeric cells
 * are kept for the per-account join, and only the raw response sha256 is recorded. A non-2xx
 * response, an error envelope, or a non-array body is a failed capture — never an empty report.
 *
 * Usage:
 *   bun run capture:gslive-users-report --from 1793163600 --to 1793771999
 *   bun run capture:gslive-users-report --from 1793163600 --to 1793771999 --dry-run
 */

import { chmod, mkdir, rename } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import {
  resolveManagerSession,
  sessionGateFromEnv,
} from "../../lib/manager_session.ts";
import { probeGsliveSession } from "../../lib/gslive_session_health.ts";
import {
  USERS_REPORT_KIND,
  UsersReportError,
  buildUsersReportUrl,
  captureUsersReport,
} from "../../lib/gslive_users_report.ts";

const ROOT = resolve(import.meta.dir, "../..");

function usage(): string {
  return [
    "capture:gslive-users-report — redacted GSLive per-player report capture",
    "",
    "Options:",
    "  --from <epochSec>   Window start (required)",
    "  --to <epochSec>     Window end (required)",
    "  --partner-id <n>    Partner id (default 118)",
    "  --out <path>        Artifact path (default Scratch/security/review-captures/users-report-<from>-<to>.redacted.json)",
    "  --allow-empty       Write a valid zero-row report instead of failing",
    "  --dry-run           Print the plan; no session read, no network, no writes",
    "  -h, --help          This text",
    "",
    "The session comes from the manager-session SSOT. The cookie is never printed.",
    "Preflight: the session is probed (cookie-only partnerConfig GET) before the report fetch.",
    "",
    "Exit codes: 0 ok; 3 AUTH_EXPIRED (reauthenticate, then rerun once); 4 invalid/refused report; 5 network/HTTP failure.",
    "Redaction: string cells become sha256:<16>; numeric/boolean cells are kept; the raw body is not stored (sha256 only).",
  ].join("\n");
}

interface Options {
  from: number | null;
  to: number | null;
  partnerId: number;
  out: string | null;
  allowEmpty: boolean;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Options | "help" {
  const options: Options = {
    from: null,
    to: null,
    partnerId: 118,
    out: null,
    allowEmpty: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-h" || token === "--help") return "help";
    if (token === "--allow-empty") {
      options.allowEmpty = true;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
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
      if (token === "--from") options.from = parsed;
      else options.to = parsed;
    } else if (token === "--partner-id") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new UsersReportError(
          "invalid_response",
          "--partner-id must be a positive integer",
        );
      }
      options.partnerId = parsed;
    } else if (token === "--out") {
      options.out = value;
    } else {
      throw new UsersReportError(
        "invalid_response",
        `unknown flag ${token}\n${usage()}`,
      );
    }
  }
  if (options.from === null || options.to === null) {
    throw new UsersReportError(
      "invalid_response",
      `--from and --to are required\n${usage()}`,
    );
  }
  return options;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    console.log(usage());
    return 0;
  }
  const out =
    parsed.out ??
    `Scratch/security/review-captures/users-report-${parsed.from}-${parsed.to}.redacted.json`;
  const url = buildUsersReportUrl({
    fromEpochSec: parsed.from!,
    toEpochSec: parsed.to!,
    partnerId: parsed.partnerId,
  });
  if (parsed.dryRun) {
    console.error(
      JSON.stringify(
        {
          method: "GET",
          url,
          kind: USERS_REPORT_KIND,
          partnerId: parsed.partnerId,
          out,
          redaction: "string cells -> sha256:<16>; raw body not stored",
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const session = await resolveManagerSession();
  if (session.source === "none") {
    throw new UsersReportError(
      "auth_expired",
      "AUTH_EXPIRED: no GSLive manager session. Provision it with `bun run secrets:gslive set` or the SSOT environment, then retry once; never paste a cookie.",
    );
  }
  // Preflight before the report fetch: distinguish expired auth from a report failure.
  const preflight = await probeGsliveSession(session.cookieHeader);
  if (preflight.status !== "ok") {
    throw new UsersReportError(
      "auth_expired",
      `AUTH_EXPIRED: session preflight ${preflight.status} — ${preflight.detail}`,
      {
        preflightStatus: preflight.status,
        httpStatus: preflight.httpStatus,
        cfMitigated: preflight.cfMitigated,
      },
    );
  }
  const capture = await captureUsersReport({
    fromEpochSec: parsed.from!,
    toEpochSec: parsed.to!,
    partnerId: parsed.partnerId,
    cookieHeader: session.cookieHeader,
    sessionSource: session.source,
    sessionGate: sessionGateFromEnv(Bun.env),
  });
  if (capture.report.rowCount === 0 && !parsed.allowEmpty) {
    throw new UsersReportError(
      "invalid_response",
      "users-report returned zero rows; refusing to write an empty control (use --allow-empty if the window is genuinely empty)",
    );
  }
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
  const outPath = resolve(ROOT, out);
  const relativeOut = relative(ROOT, outPath).split("\\").join("/");
  await mkdir(dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp-${process.pid}`;
  await Bun.write(tmpPath, `${JSON.stringify(artifact, null, 2)}\n`);
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, outPath);
  console.log(
    JSON.stringify(
      {
        captured: relativeOut,
        rowCount: capture.report.rowCount,
        columns: capture.report.columns,
        numericColumns: capture.report.numericColumns,
        stringColumns: capture.report.stringColumns,
        envelope: capture.envelope,
        rawSha256: capture.rawSha256,
        from: capture.fromEpochSec,
        to: capture.toEpochSec,
        partnerId: capture.partnerId,
        sessionSource: capture.sessionSource,
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
